/**
 * image-generator Skill
 * 通过 agnes-ai 图像 API 生成图片，支持完整参数控制和 key 轮询
 */

const API_BASE = "https://apihub.agnes-ai.com/v1/images/generations";
const SAVE_DIR = "process.env.USERPROFILE + '/.openclaw/$1-output'";

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

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";

export default function createSkill(runtime) {
  if (!fs.existsSync(SAVE_DIR)) {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
  }

  return {
    name: "image-generator",
    description: "Generate images via agnes-ai with full parameter control and key rotation",

    instruction: `当用户要求生成图片时使用此技能。支持以下参数控制：

- prompt (必填): 图片描述文本
- model (默认 "agnes-image-2.0-flash"): 模型名称，可选 "agnes-image-2.0-flash" 或 "agnes-image-2.1-flash"
- size (默认 "1024x1024"): 尺寸，可选 "512x512"、"1024x1024"、"1024x1792"、"1792x1024"
- quality (默认 "standard"): 质量，可选 "standard" 或 "hd"
- style (默认 "vivid"): 风格，可选 "vivid"（写实）或 "natural"（自然）
- n (默认 1): 生成数量，1-4
- output_dir (默认本地目录): 保存路径

API key 自动轮询 7 个密钥，失败自动切换下一个。

示例场景：
- "帮我画一只猫"
- "生成一张风景图，16:9 宽屏"
- "用 2.1 模型画一张高清照片"`,

    async image_generate({
      prompt,
      model = "agnes-image-2.0-flash",
      size = "1024x1024",
      quality = "standard",
      style = "vivid",
      n = 1,
      output_dir,
    }) {
      const dir = output_dir || SAVE_DIR;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const timestamp = Date.now();
      const results = [];

      const body = {
        model,
        prompt,
        size,
        n: Number(n),
      };
      if (quality) body.quality = quality;
      if (style) body.style = style;

      console.log(`[image-generator] Generating: ${prompt} | model=${model} | size=${size} | count=${n}`);

      // 调用 API（带 key 轮询）
      const images = await callImageAPIWithRetry(body, n);

      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const filename = `image_${timestamp}_${i + 1}.png`;
        const filepath = path.join(dir, filename);

        await downloadImage(img.url || img.b64_json, filepath, img.b64_json);

        results.push({
          filepath,
          filename,
          index: i + 1,
        });
      }

      console.log(`[image-generator] Images saved to: ${dir}`);

      return {
        success: true,
        files: results,
        prompt,
        model,
        size,
        count: results.length,
      };
    },
  };
}

/**
 * 带 key 轮询重试的 image API 调用
 */
async function callImageAPIWithRetry(body, count) {
  let lastError = null;

  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const apiKey = API_KEYS[attempt % API_KEYS.length];
    try {
      return await callImageAPI(body, apiKey, count);
    } catch (err) {
      lastError = err;
      console.warn(`[image-generator] Key ${attempt + 1}/${API_KEYS.length} failed: ${err.message}`);
    }
  }

  throw new Error(`All ${API_KEYS.length} API keys failed. Last error: ${lastError?.message}`);
}

/**
 * 调用 agnes-ai 图像生成 API
 */
function callImageAPI(body, apiKey, count) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(API_BASE);

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
            // 支持 url 或 b64_json 两种格式
            const images = [];
            if (result.data) {
              for (const item of result.data) {
                if (item.url) {
                  images.push({ url: item.url, b64_json: null });
                } else if (item.b64_json) {
                  images.push({ url: null, b64_json: item.b64_json });
                }
              }
            }
            if (images.length === 0) {
              reject(
                new Error(
                  `No images in response: ${JSON.stringify(result).substring(0, 500)}`
                )
              );
              return;
            }
            resolve(images);
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
 * 下载远程图片或解析 base64
 */
function downloadImage(url, destPath, b64Json) {
  return new Promise((resolve, reject) => {
    if (b64Json) {
      // base64 直接写入
      const fs = require("node:fs");
      fs.writeFileSync(destPath, b64Json, "base64");
      resolve();
      return;
    }

    const transport = url.startsWith("https:") ? https : http;
    const fileStream = fs.createWriteStream(destPath);

    transport
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(downloadImage(res.headers.location, destPath, null));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading image`));
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
