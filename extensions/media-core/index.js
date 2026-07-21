import fs from "node:fs";
import path from "node:path";
import { httpPostJson, downloadToFile } from "./media-http.js";
import { loadImageConfig, loadVideoConfig, resolveCustomProviderConfig } from "./config.js";
import { BUILTIN_API_KEYS } from "./keys.js";
import { cleanModelId, resolveStateDir } from "./paths.js";
import { defaultParsePollResponse, pollUntilDone } from "./poll.js";
import {
  IMAGE_PROVIDERS,
  VIDEO_PROVIDERS,
  buildCustomImageProvider,
  buildCustomVideoProvider,
} from "./providers.js";

function applyCustomProviderDefaults(config, kind) {
  const customDef = resolveCustomProviderConfig(config.provider, kind);
  if (!customDef) return config;
  const merged = { ...config };
  if (!merged.apiBase && customDef.apiBase) merged.apiBase = customDef.apiBase;
  if (!merged.model && customDef.model) merged.model = customDef.model;
  merged.providerOptions = {
    ...(customDef.providerOptions && typeof customDef.providerOptions === "object" ? customDef.providerOptions : {}),
    ...(merged.providerOptions || {}),
  };
  return merged;
}

function resolveProvider(kind, config) {
  const providerId = config.provider;

  if (providerId === "custom-image" || providerId === "custom-video") {
    const def = {
      id: providerId,
      apiBase: config.apiBase,
      providerOptions: config.providerOptions || {},
    };
    return kind === "image"
      ? buildCustomImageProvider(def)
      : buildCustomVideoProvider(def);
  }

  const customDef = resolveCustomProviderConfig(providerId, kind);
  if (customDef) {
    return kind === "image"
      ? buildCustomImageProvider({ ...customDef, id: providerId })
      : buildCustomVideoProvider({ ...customDef, id: providerId });
  }

  const registry = kind === "image" ? IMAGE_PROVIDERS : VIDEO_PROVIDERS;
  const provider = registry[providerId];
  if (!provider) {
    throw new Error(`Unknown ${kind} provider: ${providerId}`);
  }
  return provider;
}

const VIDEO_CREATE_TIMEOUT_MS = 300000;
const IMAGE_CREATE_TIMEOUT_MS = 180000;

function emitToolProgress(toolOpts, text, details = {}) {
  if (typeof toolOpts?.onUpdate !== "function") return;
  toolOpts.onUpdate({
    content: [{ type: "text", text }],
    details,
    progress: { text, visibility: "channel", privacy: "public", id: "draw-video-poll" },
  });
}

function isNetworkOrTimeoutError(err) {
  return /timeout|etimedout|econnreset|enotfound|econnrefused|ehostunreach|proxy|socket hang up|network/i.test(String(err?.message || ""));
}

function isAuthKeyError(err) {
  return /401|403|unauthorized|invalid.*key|api[_-]?key|permission|quota|rate.?limit/i.test(String(err?.message || ""));
}

async function callCreateApi(url, body, apiKey, provider, toolOpts = {}, createTimeoutMs = IMAGE_CREATE_TIMEOUT_MS) {
  let payload = { ...body };
  let lastError = null;
  const start = Date.now();
  emitToolProgress(toolOpts, "正在提交视频任务…", { phase: "create" });
  const heartbeat = setInterval(() => {
    const sec = Math.floor((Date.now() - start) / 1000);
    emitToolProgress(toolOpts, `正在提交视频任务… ${sec}秒`, { phase: "create", elapsedSec: sec });
  }, 15000);

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { statusCode, text } = await httpPostJson(url, payload, apiKey, createTimeoutMs);
        let result;
        try {
          result = JSON.parse(text);
        } catch (e) {
          throw new Error(`Response parse error: ${e.message}`);
        }
        if (statusCode < 200 || statusCode >= 300) {
          const msg = result.error?.message || result.message || `HTTP ${statusCode}`;
          throw new Error(msg);
        }
        if (result.error?.message) throw new Error(result.error.message);
        return result;
      } catch (err) {
        lastError = err;
        if (
          attempt === 0
          && provider.isUnsupportedParamError
          && provider.isUnsupportedParamError(err)
          && provider.stripUnsupportedParams
          && (payload.style != null || payload.quality != null)
        ) {
          payload = provider.stripUnsupportedParams(payload);
          console.warn(`[media-core] Retry without style/quality: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  } finally {
    clearInterval(heartbeat);
  }
}

async function resolveVideoUrl(provider, createResult, apiKey, apiBase, config, requestBody = {}, toolOpts = {}) {
  const parsed = provider.parseCreateResponse(createResult);
  if (parsed.immediateUrl) return parsed.immediateUrl;

  if (parsed.taskId) {
    const pollContext = {
      ...(parsed.pollContext || {}),
      model: parsed.pollContext?.model || requestBody.model || config.model,
    };
    const pollUrl = provider.resolvePollUrl(parsed.taskId, apiBase, pollContext, config);
    const opts = config.providerOptions || {};
    toolOpts.onUpdate?.({
      content: [{ type: 'text', text: 'Video task submitted.' }],
      details: { phase: 'poll', taskId: parsed.taskId },
      progress: { text: '视频生成已提交，等待渲染…', visibility: 'channel', privacy: 'public', id: 'draw-video-poll' },
    });
    return pollUntilDone({
      pollUrl,
      apiKey,
      maxAttempts: Number(opts.pollMaxAttempts) || 120,
      intervalMs: Number(opts.pollIntervalMs) || 5000,
      logPrefix: `[${provider.id}]`,
      parseResponse: (result) => defaultParsePollResponse(result, opts),
      signal: toolOpts.signal,
      onUpdate: toolOpts.onUpdate,
    });
  }

  throw new Error("No video URL or task id in response");
}

export function runtimePrefs(runtime, kind) {
  if (!runtime || typeof runtime !== "object") return {};
  const out = {};
  if (kind === "image" && runtime.config?.imageGenerator) Object.assign(out, runtime.config.imageGenerator);
  if (kind === "video" && runtime.config?.videoGenerator) Object.assign(out, runtime.config.videoGenerator);
  if (kind === "video" && !out.model && runtime.config?.agents?.defaults?.videoGenerationModel?.primary) {
    out.model = runtime.config.agents.defaults.videoGenerationModel.primary;
  }
  if (!runtime.config && (runtime.apiBase || runtime.apiKey || runtime.provider)) Object.assign(out, runtime);
  return out;
}

async function callWithKeyRotation({ kind, config, invoke }) {
  const userKey = config.apiKey;
  const useBuiltinFallback = /agnes/i.test(config.provider || "");

  if (userKey) {
    try {
      return await invoke(userKey, config.apiBase);
    } catch (err) {
      console.warn(`[media-core] Custom API key failed: ${err.message}`);
      if (!useBuiltinFallback) throw err;
      if (isNetworkOrTimeoutError(err) && !isAuthKeyError(err)) throw err;
      console.warn(`[media-core] Falling back to built-in keys...`);
    }
  }

  if (!useBuiltinFallback) {
    throw new Error("API key required for this provider");
  }

  let lastError = null;
  const defaultBase = kind === "image"
    ? "https://apihub.agnes-ai.com/v1/images/generations"
    : "https://apihub.agnes-ai.com/v1/videos";

  for (let attempt = 0; attempt < BUILTIN_API_KEYS.length; attempt++) {
    const apiKey = BUILTIN_API_KEYS[attempt % BUILTIN_API_KEYS.length];
    try {
      return await invoke(apiKey, defaultBase);
    } catch (err) {
      lastError = err;
      if (isNetworkOrTimeoutError(err) && !isAuthKeyError(err)) break;
    }
  }

  throw new Error(`All ${kind} API keys failed. Last error: ${lastError?.message}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function downloadImageItem(item, filepath) {
  if (item.b64_json) {
    await fs.promises.writeFile(filepath, Buffer.from(item.b64_json, "base64"));
    return;
  }
  const url = item.url;
  if (!url) throw new Error("Image item has no url or b64_json");
  await downloadToFile(url, filepath, 300000);
}

/**
 * Generate images using configured provider.
 * @param {object} params - prompt, model, size, quality, style, n, output_dir
 * @param {object} runtimeOverlay - optional runtime config from OpenClaw plugin
 */
export async function generateImage(params = {}, runtimeOverlay = null) {
  const config = applyCustomProviderDefaults(loadImageConfig(runtimePrefs(runtimeOverlay, "image")), "image");
  const provider = resolveProvider("image", config);
  const model = cleanModelId(params.model || config.model || "agnes-image-2.0-flash");
  const dir = params.output_dir || path.join(resolveStateDir(), "image-output");
  ensureDir(dir);

  const body = provider.buildCreateBody({ ...params, model }, config);
  const timestamp = Date.now();
  const count = Number(params.n || 1);

  console.log(`[media-core] Image via ${provider.id}: ${params.prompt} | model=${model} | size=${body.size} | n=${body.n}`);

  const images = await callWithKeyRotation({
    kind: "image",
    config,
    invoke: async (apiKey, apiBase) => {
      const url = provider.resolveCreateUrl(apiBase);
      const result = await callCreateApi(url, body, apiKey, provider);
      const parsed = provider.parseCreateResponse(result);
      return parsed.immediateItems || [];
    },
  });

  const results = [];
  for (let i = 0; i < images.length; i++) {
    const filename = `image_${timestamp}_${i + 1}.png`;
    const filepath = path.join(dir, filename);
    await downloadImageItem(images[i], filepath);
    results.push({ filepath, filename, index: i + 1 });
  }

  console.log(`[media-core] Images saved to: ${dir}`);

  return {
    success: true,
    files: results,
    prompt: params.prompt,
    model,
    provider: provider.id,
    size: body.size,
    count: results.length,
  };
}

/**
 * Generate video using configured provider.
 */
export async function generateVideo(params = {}, runtimeOverlay = null, toolOpts = {}) {
  const config = loadVideoConfig(runtimePrefs(runtimeOverlay, "video"));
  const provider = resolveProvider("video", config);
  const model = cleanModelId(params.model || config.model || "agnes-video-v2.0");
  const dir = params.output_dir || path.join(resolveStateDir(), "video-output");
  ensureDir(dir);

  const body = provider.buildCreateBody({ ...params, model }, config);
  const filename = `video_${Date.now()}.mp4`;
  const filepath = path.join(dir, filename);

  console.log(
    `[media-core] Video via ${provider.id}: ${params.prompt} | model=${model}`
    + (body.width ? ` | ${body.width}x${body.height} frames=${body.num_frames} fps=${body.frame_rate}` : "")
  );

  emitToolProgress(toolOpts, "视频生成任务准备中…", { phase: "prepare" });

  const videoUrl = await callWithKeyRotation({
    kind: "video",
    config,
    invoke: async (apiKey, apiBase) => {
      const url = provider.resolveCreateUrl(apiBase);
      const result = await callCreateApi(url, body, apiKey, provider, toolOpts, VIDEO_CREATE_TIMEOUT_MS);
      return resolveVideoUrl(provider, result, apiKey, apiBase, config, body, toolOpts);
    },
  });

  await downloadToFile(videoUrl, filepath);

  console.log(`[media-core] Video saved to: ${filepath}`);

  return {
    success: true,
    filepath,
    filename,
    prompt: params.prompt,
    model,
    provider: provider.id,
    duration: Number(params.duration ?? 5),
    resolution: params.resolution || "720p",
    fps: Number(params.fps ?? 24),
    aspect_ratio: params.aspect_ratio || "16:9",
  };
}

export { loadImageConfig, loadVideoConfig, loadCustomProviderDefinitions } from "./config.js";
export { detectProvider, normalizeProviderId } from "./detect.js";
