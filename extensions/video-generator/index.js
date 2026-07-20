/**
 * video-generator Skill
 * 通过 agnes-ai 视频 API 生成视频，支持完整参数控制和 key 轮询
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";

const API_BASE = "https://apihub.agnes-ai.com/v1/videos";
const STATE_DIR = process.env.OPENCLAW_STATE_DIR
  || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(), '.openclaw');
const SAVE_DIR = path.join(STATE_DIR, 'video-output');

// 7 API keys 轮询
const API_KEYS = [
  "sk-95sX8HnNOhh8FFfAm3ccOgGFg6MA8yf7zU5PEEQdGxSuKhQY", // agnes-ai-7
  "sk-z2NHJlR99oODMYvS9C5u8qLMNf6hmc9vRm5JenvHHStTfxZn", // agnes-ai-1
  "sk-ct7MSvbC8LqL1gGqJuoVCKgjtecXwbjIUZhXQ0gITEaksCS0", // agnes-ai-2
  "sk-nZtkk9AAyZl3sbkv8Gw4R1R99NnkgUWhRGL4Cp0Dl7LSPsUu", // agnes-ai-3
  "sk-Y6ORz4nnuXHUpwjdXv2WlmLMwCfPBMtmh69iuXxZkQtZazyV", // agnes-ai-4
  "sk-GhS6TUB6W8LibJT5whDhbUvmYW3csM0HdGDdjotpgadQbd2F", // agnes-ai-5
  "sk-HV5HINAfAhMJOnYxYp83ZXDLqeudt8ofLtdm9Bj5p9SUOUGh", // agnes-ai-6
];

let keyIndex = 0;

function nextApiKey() {
  const key = API_KEYS[keyIndex % API_KEYS.length];
  keyIndex++;
  return key;
}

export default function createPlugin(runtime) {
  return createSkill(runtime);
}

export function createSkill(runtime) {
  if (!fs.existsSync(SAVE_DIR)) {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
  }

  const defaultVideoModel = runtime?.config?.agents?.defaults?.videoGenerationModel?.primary || "agnes-video-v2.0";
  const userApiBase = runtime?.config?.videoGenerator?.apiBase || "https://apihub.agnes-ai.com/v1/videos";
  const userApiKey = runtime?.config?.videoGenerator?.apiKey;

  return {
    name: "video-generator",
    description: "Generate videos via agnes-ai with full parameter control",

    instruction: `当用户要求生成视频时使用此技能。支持以下参数控制：

- prompt (必填): 视频描述文本
- image_url (可选): 首帧图片 URL，用于图生视频
- model (默认 "agnes-video-v2.0"): 模型名称
- duration (默认 5): 视频时长（秒），支持 5-30
- resolution (默认 "720p"): 分辨率，可选 "480p"、"720p"、"1080p"
- fps (默认 24): 帧率，可选 15、24、30
- aspect_ratio (默认 "16:9"): 宽高比，可选 "16:9"、"9:16"、"1:1"、"4:3"
- output_dir (默认本地目录): 保存路径

API key 自动轮询 7 个密钥，失败自动切换下一个。

示例场景：
- "帮我生成一个10秒的海浪视频"
- "生成一个9:16竖版的猫咪视频"
- "把这个图片变成1080p的视频"`,

    async draw_video({
      prompt,
      image_url,
      model = defaultVideoModel,
      duration = 5,
      resolution = "720p",
      fps = 24,
      aspect_ratio = "16:9",
      output_dir,
    }) {
      const dir = output_dir || SAVE_DIR;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const filename = `video_${Date.now()}.mp4`;
      const filepath = path.join(dir, filename);

      const cleanModel = model.includes('/') ? model.split('/').pop() : model;
      const body = {
        model: cleanModel,
        prompt,
        duration: Number(duration),
        resolution,
        fps: Number(fps),
        aspect_ratio,
      };
      if (image_url) {
        body.image_url = image_url;
      }

      console.log(`[video-generator] Generating: ${prompt} | duration=${duration}s | ${resolution} | ${fps}fps | ${aspect_ratio}`);

      // 带 key 轮询的 API 调用
      const videoUrl = await callVideoAPIWithRetry(body, userApiBase, userApiKey);

      await downloadFile(videoUrl, filepath);

      console.log(`[video-generator] Video saved to: ${filepath}`);

      return {
        success: true,
        filepath,
        filename,
        prompt,
        duration: Number(duration),
        resolution,
        fps: Number(fps),
        aspect_ratio,
        model,
      };
    },
  };
}

/**
 * 带 key 轮询重试的 API 调用
 */
async function callVideoAPIWithRetry(body, apiBase, userApiKey) {
  let lastError = null;

  if (userApiKey) {
    try {
      return await callVideoAPI(body, userApiKey, apiBase);
    } catch (err) {
      lastError = err;
      console.warn(`[video-generator] User API Key failed, falling back to built-in keys...`);
    }
  }

  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const apiKey = API_KEYS[attempt % API_KEYS.length];
    try {
      return await callVideoAPI(body, apiKey, apiBase);
    } catch (err) {
      lastError = err;
      // [suppressed] key rotation failure
    }
  }

  throw new Error(`All API keys failed. Last error: ${lastError?.message}`);
}

/**
 * 调用 agnes-ai 视频生成 API
 */
function callVideoAPI(body, apiKey, apiBase) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(apiBase || API_BASE);

    const transport = urlObj.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let responseData = "";
        res.on("data", (chunk) => (responseData += chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(responseData);
            if (result.error) {
              reject(new Error(`API Error: ${result.error.message}`));
              return;
            }
            const videoUrl =
              result.video_url ||
              result.url ||
              result.output_url ||
              result.data?.url ||
              result.data?.video_url;
            if (!videoUrl) {
              reject(
                new Error(
                  `No video URL in response: ${JSON.stringify(result).substring(0, 500)}`
                )
              );
              return;
            }
            resolve(videoUrl);
          } catch (e) {
            reject(new Error(`Failed to parse API response: ${e.message}`));
          }
        });
      }
    );

    req.on("error", (e) => reject(e));
    req.write(data);
    req.end();
  });
}

/**
 * 下载远程文件到本地
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https:") ? https : http;
    const fileStream = fs.createWriteStream(destPath);

    transport
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(downloadFile(res.headers.location, destPath));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading video`));
          return;
        }

        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close();
          resolve();
        });
      })
      .on("error", reject);
  });
}
