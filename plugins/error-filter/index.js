/**
 * error-filter — 拦截带 ⚠️ / 系统失败样式的外发回复，避免刷到 QQ/飞书/微信/桌面会话
 *
 * OpenClaw 2026.7+：用 { id, register } + message_sending 返回 { cancel: true }
 */

const PLUGIN_ID = 'error-filter';

/** 命中任一即拦截（会话可见文案） */
const BLOCK_SUBSTRINGS = [
  '⚠️',
  '🛠️',
  '✉️ Message:',
  'Exec failed',
  'tool failed',
  'TOOL_FAILED',
  'openclaw-screenshot-latest',
];

/** 正则补充（大小写不敏感） */
const BLOCK_REGEXES = [
  /^\s*⚠️/,
  /Message:\s*.+\s+failed/i,
  /Exec failed/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
];

function extractText(event) {
  if (!event) return '';
  if (typeof event.content === 'string') return event.content;
  if (typeof event.text === 'string') return event.text;
  if (Array.isArray(event.content)) {
    return event.content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p.text === 'string') return p.text;
        return '';
      })
      .join('\n');
  }
  if (event.payload && typeof event.payload.text === 'string') return event.payload.text;
  return '';
}

function stripMdNoise(line) {
  return String(line || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/^[*_`~>#\-\s]+/, '')
    .replace(/[*_`]+$/g, '')
    .trim();
}

/** 单行是否为模型回退提示（含 ↪️ / ↪ 等前缀变体） */
function isModelFallbackLine(line) {
  const l = stripMdNoise(line);
  if (!l) return false;
  // 例: ↪️ Model Fallback: gemini/claude-opus-4-6-thinking (selected ...; format)
  if (/Model\s*Fallback\s*(cleared)?\s*:/i.test(l)) return true;
  if (/^(?:↪️|↪|➡|→)\s*Model\s*Fallback\b/i.test(l)) return true;
  return false;
}

/**
 * OpenClaw 单独下发的模型回退提示（如 ↪️ Model Fallback: ...）
 * - 整段仅此内容 → 拦截
 * - 去掉 fallback 行后无实质内容 → 拦截
 */
function isModelFallbackNoticeOnly(text) {
  const raw = String(text || '').trim();
  if (!raw || !/Model\s*Fallback/i.test(raw)) return false;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  if (lines.every(isModelFallbackLine)) return true;
  const rest = lines.filter((l) => !isModelFallbackLine(l)).join('\n').trim();
  return rest.length === 0;
}

/** 是否整段（或去代码块后）只剩泄漏的工具调用 JSON */
function isLeakedToolJsonOnly(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/^\s*\{[\s\S]*"action"\s*:\s*"exec"[\s\S]*"action_input"[\s\S]*\}\s*$/.test(raw)) return true;
  if (/^\s*\{[\s\S]*"action"\s*:[\s\S]*"action_input"[\s\S]*\}\s*$/.test(raw)) return true;
  if (/^\s*\{[\s\S]*"name"\s*:[\s\S]*"arguments"[\s\S]*\}\s*$/.test(raw)) return true;
  // ```json { action... } ```
  const fence = raw.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)```$/i);
  if (fence) {
    const inner = fence[1].trim();
    if (/"action_input"/.test(inner) || (/"name"/.test(inner) && /"arguments"/.test(inner))) return true;
  }
  // 去掉所有工具 JSON / 代码块后几乎没剩正文
  const stripped = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\{\s*"action"\s*:[\s\S]*?"action_input"\s*:[\s\S]*?\}/g, '')
    .replace(/\{\s*"name"\s*:[\s\S]*?"arguments"\s*:[\s\S]*?\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/"action_input"\s*:|"command"\s*:\s*"screen-capture"/.test(raw) && stripped.length < 8) {
    return true;
  }
  return false;
}

function shouldBlockOutbound(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isModelFallbackNoticeOnly(raw)) return true;
  if (isLeakedToolJsonOnly(raw)) return true;
  for (const s of BLOCK_SUBSTRINGS) {
    if (raw.includes(s)) return true;
  }
  for (const re of BLOCK_REGEXES) {
    try {
      if (re.test(raw)) return true;
    } catch (_) {}
  }
  return false;
}

function register(api) {
  try {
    api.logger?.info?.(`[${PLUGIN_ID}] loaded — suppress ⚠️ / Model Fallback / system-failure outbound`);
  } catch (_) {}

  api.on('message_sending', async (event) => {
    try {
      const text = extractText(event);
      if (!shouldBlockOutbound(text)) return;
      const preview = text.replace(/\s+/g, ' ').slice(0, 100);
      try {
        api.logger?.info?.(`[${PLUGIN_ID}] cancelled outbound: ${preview}`);
      } catch (_) {}
      console.log(`[${PLUGIN_ID}] cancelled outbound: ${preview}`);
      return {
        cancel: true,
        cancelReason: 'error-filter:suppress-warning-banner',
      };
    } catch (e) {
      console.warn(`[${PLUGIN_ID}] message_sending hook error:`, e && e.message);
    }
  });
}

const pluginEntry = {
  id: PLUGIN_ID,
  name: 'Error Notification Filter',
  description: 'Suppresses ⚠️ / Model Fallback / system failure banners from being delivered to user chats',
  register,
};

export default pluginEntry;
export function activate(api) {
  return register(api);
}
