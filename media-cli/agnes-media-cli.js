/**
 * agnes-media-cli.js
 * 命令行工具：通过 agnes-ai API 生成图片和视频
 * 用法:
 *   node agnes-media-cli.js video --prompt "描述" [--duration 10] [--resolution 1080p] [--fps 24] [--aspect 16:9] [--model agnes-video-v2.0]
 *   node agnes-media-cli.js image --prompt "描述" [--model agnes-image-2.0-flash] [--size 1024x1024] [--quality standard] [--style vivid] [--count 1]
 */

const API_BASE = "https://apihub.agnes-ai.com/v1";
const SAVE_DIR = process.env.USERPROFILE + '/.openclaw/media-output';

const API_KEYS = [
  "sk-95sX8HnNOhh8FFfAm3ccOgGFg6MA8yf7zU5PEEQdGxSuKhQY",
  "sk-z2NHJlR99oODMYvS9C5u8qLMNf6hmc9vRm5JenvHHStTfxZn",
  "sk-ct7MSvbC8LqL1gGqJuoVCKgjtecXwbjIUZhXQ0gITEaksCS0",
  "sk-nZtkk9AAyZl3sbkv8Gw4R1R99NnkgUWhRGL4Cp0Dl7LSPsUu",
  "sk-Y6ORz4nnuXHUpwjdXv2WlmLMwCfPBMtmh69iuXxZkQtZazyV",
  "sk-GhS6TUB6W8LibJT5whDhbUvmYW3csM0HdGDdjotpgadQbd2F",
  "sk-HV5HINAfAhMJOnYxYp83ZXDLqeudt8ofLtdm9Bj5p9SUOUGh",
];

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";

// --- Helpers ---

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https:") ? https : http;
    const fileStream = fs.createWriteStream(destPath);
    transport.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(downloadFile(res.headers.location, destPath));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(fileStream);
      fileStream.on("finish", () => { fileStream.close(); resolve(); });
    }).on("error", reject);
  });
}

function apiPost(endpoint, body, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(API_BASE + endpoint);
    const transport = urlObj.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        Authorization: `Bearer ${apiKey}`,
      },
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (result.error) reject(new Error(`API Error: ${result.error.message}`));
          else resolve(result);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function apiGet(endpoint, apiKey) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(API_BASE + endpoint);
    const transport = urlObj.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (result.error && result.error.message) reject(new Error(`API Error: ${result.error.message}`));
          else resolve(result);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function apiGetRaw(urlStr, apiKey) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const transport = urlObj.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (result.error && result.error.message) reject(new Error(`API Error: ${result.error.message}`));
          else resolve(result);
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function apiWithRetry(endpoint, body, maxRetries = API_KEYS.length) {
  let lastErr = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return apiPost(endpoint, body, API_KEYS[i % API_KEYS.length]);
    } catch (e) {
      lastErr = e;
      console.error(`[retry] Key ${i + 1}/${maxRetries} failed: ${e.message}`);
    }
  }
  throw lastErr;
}

// --- Parse simple args ---

function getArg(name, argv) {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

// --- Video ---

async function genVideo(argv) {
  const prompt = getArg("prompt", argv);
  if (!prompt) throw new Error("Missing --prompt");

  const duration = Number(getArg("duration", argv)) || 5;
  const resolution = getArg("resolution", argv) || "720p";
  const fps = Number(getArg("fps", argv)) || 24;
  const aspect_ratio = getArg("aspect", argv) || "16:9";
  const model = getArg("model", argv) || "agnes-video-v2.0";

  // Resolution to width/height mapping
  const resMap = { "480p": { w: 854, h: 480 }, "720p": { w: 1280, h: 720 }, "1080p": { w: 1920, h: 1080 } };
  const res = resMap[resolution] || resMap["720p"];

  // Aspect ratio to width/height adjustment
  const arMap = { "16:9": 16/9, "9:16": 9/16, "1:1": 1, "4:3": 4/3, "3:4": 3/4 };
  const targetAR = arMap[aspect_ratio] || 16/9;

  // Adjust width/height to match aspect ratio while keeping resolution class
  let width = res.w;
  let height = res.h;
  const currentAR = width / height;
  if (Math.abs(currentAR - targetAR) > 0.01) {
    if (targetAR > 1) {
      // Wider (16:9, 4:3): landscape orientation
      height = res.h;
      width = Math.round(height * targetAR);
    } else if (targetAR < 1) {
      // Taller (9:16, 3:4): portrait orientation - swap width/height
      width = res.h;
      height = res.w;
    }
    // targetAR === 1 (1:1): keep square-ish by using smaller dimension for both
    // The API will normalize anyway, so leaving as-is is fine
  }

  // Convert duration to num_frames: seconds = num_frames / frame_rate
  // num_frames = duration * fps, must satisfy 8n+1 and <= 441
  let numFrames = Math.round(duration * fps);
  // Round to nearest 8n+1 value
  numFrames = Math.max(1, numFrames - ((numFrames - 1) % 8));
  // Clamp to max
  numFrames = Math.min(numFrames, 441);
  // Ensure 8n+1
  if ((numFrames - 1) % 8 !== 0) numFrames -= ((numFrames - 1) % 8);
  numFrames = Math.max(numFrames, 1);

  ensureDir(SAVE_DIR);
  const ts = Date.now();
  const filename = `video_${ts}.mp4`;
  const filepath = path.join(SAVE_DIR, filename);

  console.error(`[video] prompt="${prompt}" duration=${duration}s (${numFrames} frames @ ${fps}fps) resolution=${resolution} aspect=${aspect_ratio} model=${model}`);
  if (duration > 18) {
    console.error(`[video] WARNING: Max supported duration is ~18s (441 frames @ 24fps). Clamped to ${numFrames/fps}s.`);
  }

  const result = await apiWithRetry("/videos", {
    model, prompt, height, width, num_frames: numFrames, frame_rate: fps,
  });

  // 异步任务模式：轮询 video_id
  if (result.status === "queued" || result.status === "processing" || result.status === "in_progress") {
    const videoId = result.video_id || result.id;
    if (!videoId) throw new Error("No video_id in response");
    console.error(`[video] Task queued: ${videoId}, polling...`);

    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((r) => setTimeout(r, 5000)); // 每5秒轮询
      try {
        // GET /agnesapi?video_id={video_id} 查询状态（官方推荐）
        const videoId = result.video_id || result.id;
        const pollUrl = `https://apihub.agnes-ai.com/agnesapi?video_id=${videoId}`;
        const pollResult = await apiGetRaw(pollUrl, API_KEYS[0]);
        console.error(`[video] Poll attempt ${attempt + 1}: status=${pollResult.status || "unknown"}`);
        if (pollResult.status === "completed") {
          const videoUrl = pollResult.url || pollResult.remixed_from_video_id;
          if (!videoUrl) throw new Error(`No video URL in completed response: ${JSON.stringify(pollResult).substring(0, 500)}`);
          await downloadFile(videoUrl, filepath);
          console.error(`[video] Saved: ${filepath}`);
          return { success: true, filepath, filename, prompt, duration: Number(duration), resolution, fps: Number(fps), aspect_ratio, model, num_frames: numFrames };
        }
        if (pollResult.status === "failed" || pollResult.status === "error") {
          throw new Error(`Video generation failed: ${pollResult.error || JSON.stringify(pollResult).substring(0, 200)}`);
        }
      } catch (e) {
        if (e.message.includes("No video URL") || e.message.includes("failed")) throw e;
        console.error(`[video] Poll error: ${e.message}`);
      }
    }
    throw new Error("Video generation timed out after 10 minutes");
  }

  // 同步模式（直接返回视频URL）
  const videoUrl = result.video_url || result.url || result.output_url || result.remixed_from_video_id;
  if (!videoUrl) throw new Error(`No video URL in response: ${JSON.stringify(result).substring(0, 500)}`);

  await downloadFile(videoUrl, filepath);
  console.error(`[video] Saved: ${filepath}`);

  return { success: true, filepath, filename, prompt, duration: Number(duration), resolution, fps: Number(fps), aspect_ratio, model, num_frames: numFrames };
}

// --- Image ---

async function genImage(argv) {
  const prompt = getArg("prompt", argv);
  if (!prompt) throw new Error("Missing --prompt");

  const model = getArg("model", argv) || "agnes-image-2.0-flash";
  const size = getArg("size", argv) || "1024x1024";
  const quality = getArg("quality", argv) || "standard";
  const count = Number(getArg("count", argv)) || 1;

  ensureDir(SAVE_DIR);
  const ts = Date.now();
  const results = [];

  console.error(`[image] prompt="${prompt}" model=${model} size=${size} quality=${quality} count=${count}`);

  const body = { model, prompt, size, n: Number(count) };
  if (quality) body.quality = quality;

  const result = await apiWithRetry("/images/generations", body);

  if (result.data) {
    for (let i = 0; i < result.data.length; i++) {
      const item = result.data[i];
      const filename = `image_${ts}_${i + 1}.png`;
      const filepath = path.join(SAVE_DIR, filename);

      if (item.url) {
        await downloadFile(item.url, filepath);
      } else if (item.b64_json) {
        fs.writeFileSync(filepath, item.b64_json, "base64");
      } else {
        console.error(`[image] No url or b64_json for item ${i}`);
        continue;
      }
      results.push({ filepath, filename, index: i + 1 });
      console.error(`[image] Saved: ${filepath}`);
    }
  }

  return { success: true, files: results, prompt, model, size, count: results.length };
}

// --- Main ---

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || !["video", "image"].includes(cmd)) {
    console.error("Usage: node agnes-media-cli.js video|image --prompt \"...\" [options]");
    console.error("  video options: --duration N --resolution 480p|720p|1080p --fps N --aspect 16:9|9:16|1:1|4:3 --model agnes-video-v2.0");
    console.error("  image options: --size 512x512|1024x1024|1024x1792|1792x1024 --quality standard|hd --style vivid|natural --count 1-4 --model agnes-image-2.0-flash|agnes-image-2.1-flash");
    process.exit(1);
  }

  try {
    let res;
    if (cmd === "video") {
      res = await genVideo(argv);
    } else {
      res = await genImage(argv);
    }
    console.log(JSON.stringify(res));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
    process.exit(1);
  }
}

main();





