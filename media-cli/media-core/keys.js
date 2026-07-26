/**
 * Agnes API 密钥加载器（内置回退轮换用）。
 *
 * 安全警告：历史上内联在源码中的 sk- 密钥已泄露（COMPROMISED），
 * 已移出源码，用户必须尽快在 agnes-ai 后台轮换/吊销这些密钥。
 *
 * 加载优先级：
 *   1) 环境变量 AGNES_API_KEYS（逗号分隔）或 AGNES_API_KEY（单个）
 *   2) ~/.openclaw/openclaw.json 的 models.providers.agnes-ai.apiKey
 *   3) 最后兜底：本地文件 media-cli/media-core/.agnes-keys.json（不应提交到版本库）
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAgnesApiKeys() {
  // 1) 环境变量优先
  const envList = process.env.AGNES_API_KEYS || process.env.AGNES_API_KEY;
  if (envList) {
    const keys = String(envList).split(",").map((s) => s.trim()).filter(Boolean);
    if (keys.length) return keys;
  }
  // 2) openclaw.json 配置
  try {
    const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const apiKey = cfg?.models?.providers?.["agnes-ai"]?.apiKey;
    if (Array.isArray(apiKey)) {
      const keys = apiKey.map((s) => String(s).trim()).filter(Boolean);
      if (keys.length) return keys;
    } else if (apiKey && String(apiKey).trim()) {
      return [String(apiKey).trim()];
    }
  } catch (e) {
    /* 忽略：配置文件不存在或无效 */
  }
  // 3) 本地兜底文件（这些密钥已泄露，仅作最后兜底）
  try {
    const filePath = path.join(__dirname, ".agnes-keys.json");
    const arr = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Array.isArray(arr)) {
      const keys = arr.map((s) => String(s).trim()).filter(Boolean);
      if (keys.length) return keys;
    }
  } catch (e) {
    /* 忽略：兜底文件不存在或无效 */
  }
  return [];
}

/** 内置 Agnes API 密钥（从环境/配置/本地兜底文件加载，非内联）。 */
export const BUILTIN_API_KEYS = loadAgnesApiKeys();

export const BUILTIN_KEY_MASK = "sk-builtin-agnes-key-mask";

export function isBuiltInApiKey(rawKey) {
  const key = String(rawKey || "").trim();
  return !key || key === BUILTIN_KEY_MASK || BUILTIN_API_KEYS.includes(key);
}
