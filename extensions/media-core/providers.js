import { normalizeImageApiBase, normalizeVideoApiBase } from "./paths.js";
import {
  framesForDuration,
  getByPath,
  isUnsupportedImageParamError,
  pickFirst,
  sizeForResolution,
  supportsOpenAiImageExtras,
  fillTemplate,
} from "./utils.js";

const IMAGE_URL_PATHS = ["url", "b64_json"];
const VIDEO_URL_PATHS = [
  "metadata.url",
  "video.url",
  "video_url",
  "url",
  "output_url",
  "output.url",
  "result.url",
  "data.0.url",
];
const VIDEO_ID_PATHS = ["video_id", "id", "task_id"];

export const agnesImageProvider = {
  id: "agnes-image",
  kind: "image",
  resolveCreateUrl(apiBase) {
    return normalizeImageApiBase(apiBase);
  },
  buildCreateBody(params, config) {
    const model = params.model || config.model || "agnes-image-2.0-flash";
    const body = {
      model,
      prompt: params.prompt,
      size: params.size || "1024x1024",
      n: Number(params.n || 1),
    };
    if (supportsOpenAiImageExtras(model)) {
      if (params.quality) body.quality = params.quality;
      if (params.style) body.style = params.style;
    }
    return body;
  },
  parseCreateResponse(result) {
    if (result.data && Array.isArray(result.data)) {
      return { immediateItems: result.data };
    }
    throw new Error(result.error?.message || result.message || "No image data in response");
  },
  stripUnsupportedParams(body) {
    const next = { ...body };
    delete next.style;
    delete next.quality;
    return next;
  },
  isUnsupportedParamError: isUnsupportedImageParamError,
};

export const openaiImageProvider = {
  id: "openai-image",
  kind: "image",
  resolveCreateUrl(apiBase) {
    return normalizeImageApiBase(apiBase);
  },
  buildCreateBody(params, config) {
    const model = params.model || config.model || "dall-e-3";
    const body = {
      model,
      prompt: params.prompt,
      size: params.size || "1024x1024",
      n: Number(params.n || 1),
    };
    if (params.quality) body.quality = params.quality;
    if (params.style) body.style = params.style;
    return body;
  },
  parseCreateResponse(result) {
    if (result.data && Array.isArray(result.data)) {
      return { immediateItems: result.data };
    }
    throw new Error(result.error?.message || result.message || "No image data in response");
  },
  stripUnsupportedParams(body) {
    const next = { ...body };
    delete next.style;
    delete next.quality;
    return next;
  },
  isUnsupportedParamError: isUnsupportedImageParamError,
};

export const genericImageProvider = {
  ...openaiImageProvider,
  id: "generic-image",
};

export const gatewayImageProvider = {
  ...openaiImageProvider,
  id: "gateway-image",
};

export const agnesVideoProvider = {
  id: "agnes-video",
  kind: "video",
  resolveCreateUrl(apiBase) {
    return normalizeVideoApiBase(apiBase);
  },
  buildCreateBody(params, config) {
    const model = params.model || config.model || "agnes-video-v2.0";
    const frameRate = Math.min(60, Math.max(1, Number(params.fps) || 24));
    const { width, height } = sizeForResolution(params.resolution || "720p", params.aspect_ratio || "16:9");
    const body = {
      model,
      prompt: params.prompt,
      width,
      height,
      num_frames: framesForDuration(params.duration ?? 5, frameRate),
      frame_rate: frameRate,
    };
    if (params.image_url) body.image = params.image_url;
    return body;
  },
  parseCreateResponse(result) {
    const url = pickFirst(result, VIDEO_URL_PATHS);
    const taskId = pickFirst(result, VIDEO_ID_PATHS);
    const status = String(result.status || "").toLowerCase();
    if (url && !status && !taskId) return { immediateUrl: url };
    if (taskId || ["processing", "queued", "pending", "in_progress"].includes(status)) {
      return { taskId, pollContext: { model: result.model || null } };
    }
    if (url) return { immediateUrl: url };
    throw new Error(result.error?.message || "No video URL or task id in response");
  },
  resolvePollUrl(taskId, apiBase, pollContext = {}) {
    const base = String(apiBase || "").trim();
    try {
      const origin = new URL(base).origin;
      if (/agnes-ai\.com/i.test(origin)) {
        let url = `${origin}/agnesapi?video_id=${encodeURIComponent(taskId)}`;
        const modelName = pollContext.model;
        if (modelName) url += `&model_name=${encodeURIComponent(String(modelName).replace(/^.*\//, ""))}`;
        return url;
      }
    } catch (e) {}
    return `${base.replace(/\/$/, "")}/${taskId}`;
  },
};

export const openaiVideoProvider = {
  id: "openai-video",
  kind: "video",
  resolveCreateUrl(apiBase) {
    return normalizeVideoApiBase(apiBase);
  },
  buildCreateBody(params, config) {
    const model = params.model || config.model || "sora";
    const body = {
      model,
      prompt: params.prompt,
    };
    if (params.duration != null) body.seconds = Number(params.duration);
    if (params.resolution) body.size = params.resolution;
    if (params.image_url) body.image_url = params.image_url;
    return body;
  },
  parseCreateResponse(result) {
    const url = pickFirst(result, [...VIDEO_URL_PATHS, "output.url", "assets.0.url"]);
    const taskId = pickFirst(result, VIDEO_ID_PATHS);
    const status = String(result.status || "").toLowerCase();
    if (url && !taskId && !status) return { immediateUrl: url };
    if (taskId || status) return { taskId, pollContext: {} };
    if (url) return { immediateUrl: url };
    throw new Error(result.error?.message || "No video URL or task id in response");
  },
  resolvePollUrl(taskId, apiBase) {
    const base = normalizeVideoApiBase(apiBase).replace(/\/$/, "");
    return `${base}/${encodeURIComponent(taskId)}`;
  },
};

export const genericVideoProvider = {
  ...openaiVideoProvider,
  id: "generic-video",
  buildCreateBody(params, config) {
    const opts = config.providerOptions || {};
    if (opts.requestBody && typeof opts.requestBody === "object") {
      return { ...opts.requestBody, prompt: params.prompt, model: params.model || config.model };
    }
    return openaiVideoProvider.buildCreateBody(params, config);
  },
  resolvePollUrl(taskId, apiBase, pollContext = {}, config = {}) {
    const opts = config.providerOptions || {};
    if (opts.pollUrlTemplate) {
      return fillTemplate(opts.pollUrlTemplate, { id: taskId, taskId, apiBase, ...pollContext });
    }
    return openaiVideoProvider.resolvePollUrl(taskId, apiBase);
  },
};

export const gatewayVideoProvider = {
  ...genericVideoProvider,
  id: "gateway-video",
};

export function buildCustomImageProvider(def) {
  const opts = def.providerOptions || def;
  return {
    id: def.id || "custom-image",
    kind: "image",
    resolveCreateUrl(apiBase) {
      if (opts.createUrl) return fillTemplate(opts.createUrl, { apiBase });
      if (opts.createPath) return `${String(apiBase).replace(/\/$/, "")}${opts.createPath.startsWith("/") ? "" : "/"}${opts.createPath}`;
      return normalizeImageApiBase(def.apiBase || apiBase);
    },
    buildCreateBody(params, config) {
      if (opts.requestBody && typeof opts.requestBody === "object") {
        return { ...opts.requestBody, prompt: params.prompt, model: params.model || config.model };
      }
      const mapping = opts.requestMapping || {};
      const body = {};
      const src = { ...params, model: params.model || config.model };
      for (const [from, to] of Object.entries(mapping)) {
        if (src[from] !== undefined) body[to] = src[from];
      }
      if (!Object.keys(body).length) {
        return genericImageProvider.buildCreateBody(params, config);
      }
      return body;
    },
    parseCreateResponse(result) {
      const urlPath = opts.responseUrlPath;
      if (urlPath) {
        const url = getByPath(result, urlPath);
        if (url) return { immediateItems: [{ url }] };
      }
      const dataPath = opts.responseDataPath || "data";
      const data = getByPath(result, dataPath);
      if (Array.isArray(data)) return { immediateItems: data };
      return genericImageProvider.parseCreateResponse(result);
    },
    stripUnsupportedParams(body) {
      return body;
    },
    isUnsupportedParamError: () => false,
  };
}

export function buildCustomVideoProvider(def) {
  const opts = def.providerOptions || def;
  return {
    id: def.id || "custom-video",
    kind: "video",
    resolveCreateUrl(apiBase) {
      if (opts.createUrl) return fillTemplate(opts.createUrl, { apiBase });
      if (opts.createPath) return `${String(apiBase).replace(/\/$/, "")}${opts.createPath.startsWith("/") ? "" : "/"}${opts.createPath}`;
      return normalizeVideoApiBase(def.apiBase || apiBase);
    },
    buildCreateBody(params, config) {
      if (opts.requestBody && typeof opts.requestBody === "object") {
        return { ...opts.requestBody, prompt: params.prompt, model: params.model || config.model };
      }
      const mapping = opts.requestMapping || {};
      const body = {};
      const src = { ...params, model: params.model || config.model };
      for (const [from, to] of Object.entries(mapping)) {
        if (src[from] !== undefined) body[to] = src[from];
      }
      if (!Object.keys(body).length) {
        return genericVideoProvider.buildCreateBody(params, config);
      }
      return body;
    },
    parseCreateResponse(result) {
      const urlPaths = opts.responseUrlPaths || VIDEO_URL_PATHS;
      const idPaths = opts.responseIdPaths || VIDEO_ID_PATHS;
      const url = pickFirst(result, urlPaths);
      const taskId = pickFirst(result, idPaths);
      if (url && !taskId) return { immediateUrl: url };
      if (taskId) return { taskId, pollContext: opts.pollContext || {} };
      if (url) return { immediateUrl: url };
      throw new Error(getByPath(result, opts.errorPath || "error.message") || "No video URL or task id in response");
    },
    resolvePollUrl(taskId, apiBase, pollContext = {}) {
      if (opts.pollUrlTemplate) {
        return fillTemplate(opts.pollUrlTemplate, { id: taskId, taskId, apiBase, ...pollContext });
      }
      return `${String(apiBase).replace(/\/$/, "")}/${encodeURIComponent(taskId)}`;
    },
  };
}

export const IMAGE_PROVIDERS = {
  "agnes-image": agnesImageProvider,
  "openai-image": openaiImageProvider,
  "generic-image": genericImageProvider,
  "gateway-image": gatewayImageProvider,
  "custom-image": genericImageProvider,
};

export const VIDEO_PROVIDERS = {
  "agnes-video": agnesVideoProvider,
  "openai-video": openaiVideoProvider,
  "generic-video": genericVideoProvider,
  "gateway-video": gatewayVideoProvider,
  "custom-video": genericVideoProvider,
};
