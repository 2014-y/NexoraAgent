/**
 * error-filter
 * Suppresses noisy system/tool failure messages before they are sent to chat.
 * Also repairs explicit pseudo media tool calls emitted as plain text by weak models.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const PLUGIN_ID = 'error-filter';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BLOCK_SUBSTRINGS = [
  'Exec failed',
  'tool failed',
  'TOOL_FAILED',
  'openclaw-screenshot-latest',
  'Message:',
  'Model Fallback',
];

/** 系统诊断硬特征：仅短消息或警告气泡拦截，避免误伤正常长回复 */
const DIAGNOSTIC_HARD_SUBSTRINGS = [
  'All models are temporarily rate-limited',
  'temporarily rate-limited',
  'The AI service is temporarily rate-limited',
  'The AI service is temporarily overloaded',
  'API rate limit reached',
  'Auto-compaction could not recover this turn',
  'auto-compaction could not recover this turn',
  'Auto-compaction failed',
  'Context overflow: prompt too large',
  'prompt too large for the model',
  'Compaction timed out',
  'compaction-diag',
  'trigger=overflow',
  '[agent/embedded]',
  'diagId=ovf-',
  'increase your compaction buffer',
  'reserveTokensFloor',
  'Preserving existing session mapping',
  'Context is too large and auto-compaction',
  'Message ordering conflict',
  'roles must alternate',
  'Please try again in a few minutes.',
  'Rate-limited — ready in',
  '暂时限流',
  '所有模型暂时',
  '上下文过长',
  '上下文溢出',
  '自动压缩失败',
  '请使用 /new',
  '请使用/new',
];

const BLOCK_REGEXES = [
  /Message:\s*.+\s+failed/i,
  /Exec failed/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /TOOL_FAILED/i,
];

const DIAGNOSTIC_HARD_REGEXES = [
  /^\s*⚠️?\s*All models are temporarily rate-limited/i,
  /^\s*⚠️?\s*Rate-limited/i,
  /^\s*⚠️?\s*API rate limit/i,
  /Auto-compaction could not recover/i,
  /Context overflow:\s*prompt too large/i,
  /use \/compact,\s*or use \/new/i,
  /use \/new to start/i,
  /Message ordering conflict/i,
  /roles must alternate/i,
  /increase your compaction buffer/i,
  /所有模型.*(限流|过载|繁忙)/i,
  /暂时(限流|过载|不可用)/i,
  /(上下文|会话).*(过长|溢出|太大)/i,
  /自动压缩.*(失败|超时|无法)/i,
  /请使用\s*\/new/i,
];

function extractText(event) {
  if (!event) return '';
  if (typeof event.content === 'string') return event.content;
  if (typeof event.text === 'string') return event.text;
  if (Array.isArray(event.content)) {
    return event.content.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p.text === 'string') return p.text;
      return '';
    }).join('\n');
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

function isModelFallbackLine(line) {
  const l = stripMdNoise(line);
  if (!l) return false;
  return /Model\s*Fallback\s*(cleared)?\s*:/i.test(l);
}

function isModelFallbackNoticeOnly(text) {
  const raw = String(text || '').trim();
  if (!raw || !/Model\s*Fallback/i.test(raw)) return false;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  if (lines.every(isModelFallbackLine)) return true;
  return lines.filter((l) => !isModelFallbackLine(l)).join('\n').trim().length === 0;
}

function isLeakedToolJsonOnly(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/^\s*\{[\s\S]*"action"\s*:[\s\S]*"action_input"[\s\S]*\}\s*$/.test(raw)) return true;
  if (/^\s*\{[\s\S]*"name"\s*:[\s\S]*"arguments"[\s\S]*\}\s*$/.test(raw)) return true;
  const fence = raw.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)```$/i);
  if (fence) {
    const inner = fence[1].trim();
    if (/"action_input"/.test(inner) || (/"name"/.test(inner) && /"arguments"/.test(inner))) return true;
  }
  const stripped = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\{\s*"action"\s*:[\s\S]*?"action_input"\s*:[\s\S]*?\}/g, '')
    .replace(/\{\s*"name"\s*:[\s\S]*?"arguments"\s*:[\s\S]*?\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /"action_input"\s*:|"command"\s*:\s*"screen-capture"/.test(raw) && stripped.length < 8;
}

function isSystemDiagnosticBannerOnly(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const stripped = raw.replace(/⚠️/g, '').replace(/\s+/g, ' ').trim();
  // 长诊断行（compaction-diag 常 >700 字）也必须拦
  const looksDiag =
    /rate[\s-]?limit|overloaded|auto-compaction|compaction[-_ ]?diag|compaction timed|compaction timeout|context[_\s-]?overflow|prompt too large|reserveTokensFloor|try again (in|later|shortly)|\/compact|\/new to start|Message ordering conflict|roles must alternate|\[agent\/embedded\]|trigger\s*=\s*overflow|diagId\s*=\s*ovf-|runId\s*=|outcome\s*=\s*failed|所有模型|暂时限流|暂时过载|上下文过长|上下文溢出|自动压缩失败|请使用\s*\/new/i.test(
      stripped
    );
  if (!looksDiag) return false;
  if (/(我来|好的|当然|以下是|已经帮你|完成了|代码如下|```|首先|步骤)/.test(stripped)) return false;
  return true;
}

function shouldBlockOutbound(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isModelFallbackNoticeOnly(raw)) return true;
  if (isLeakedToolJsonOnly(raw)) return true;
  if (isSystemDiagnosticBannerOnly(raw)) return true;
  if (/^\s*[!\[]?\s*(warning|error|failed)\b/i.test(raw)) return true;

  // 硬特征：不论长短一律拦截（避免超长 compaction-diag 漏网）
  for (const s of DIAGNOSTIC_HARD_SUBSTRINGS) {
    if (raw.includes(s)) return true;
  }
  for (const re of DIAGNOSTIC_HARD_REGEXES) {
    try { if (re.test(raw)) return true; } catch (_) {}
  }

  for (const s of BLOCK_SUBSTRINGS) {
    if (raw.includes(s)) return true;
  }
  for (const re of BLOCK_REGEXES) {
    try { if (re.test(raw)) return true; } catch (_) {}
  }
  return false;
}

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR
    || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(), '.openclaw');
}

/** 溢出/奇偶 /new 类横幅被拦截时，通知 session-overflow-rollover 归档续聊（防钩子短路哑火） */
function needsSessionRollover(text) {
  const t = String(text || '');
  if (!t) return false;
  return (
    /auto-compaction|context[_\s-]?overflow|prompt too large|compaction[-_ ]?diag|use \/compact|use \/new|\/new to start|Message ordering conflict|roles must alternate|incorrect role information|conversation state|reserveTokensFloor|上下文过长|上下文溢出|自动压缩失败|请使用\s*\/new/i.test(
      t
    )
  );
}

function resolveSessionKeyFromEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const cands = [
    event.sessionKey,
    event.session_key,
    event.key,
    event.to && event.to.sessionKey,
    event.payload && event.payload.sessionKey,
    event.metadata && event.metadata.sessionKey,
  ];
  for (const k of cands) {
    if (typeof k === 'string' && k.trim()) return k.trim();
  }
  return '';
}

function queueOverflowRolloverTrigger(sessionKey, preview) {
  try {
    const file = path.join(stateDir(), 'overflow-rollover.trigger.json');
    const payload = {
      v: 1,
      at: Date.now(),
      sessionKey: sessionKey || '',
      reason: 'error-filter-blocked-recovery-banner',
      preview: String(preview || '').replace(/\s+/g, ' ').slice(0, 240),
    };
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
    console.log(`[${PLUGIN_ID}] queued overflow-rollover trigger key=${sessionKey || '(freshest)'}`);
  } catch (e) {
    console.warn(`[${PLUGIN_ID}] queue rollover trigger failed:`, e && e.message);
  }
}

function unixPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function resolveCaptureScriptPath() {
  const candidates = [
    process.env.NEXORA_AGENT_RUNTIME_DIR && path.join(process.env.NEXORA_AGENT_RUNTIME_DIR, 'capture-desktop.ps1'),
    path.join(stateDir(), 'capture-desktop.ps1'),
    path.join(process.env.REAL_USER_HOME || '', '.openclaw', 'capture-desktop.ps1'),
    path.join(process.cwd(), 'capture-desktop.ps1'),
    path.join(__dirname, '..', '..', 'capture-desktop.ps1'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) return resolved;
    } catch (_) {}
  }
  throw new Error('capture-desktop.ps1 not found');
}

async function runScreenCapture() {
  const dir = path.join(stateDir(), 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  const filepath = path.join(dir, `openclaw-screenshot-${stamp}-${suffix}.png`);
  const latest = path.join(dir, 'openclaw-screenshot-latest.png');
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolveCaptureScriptPath(), '-OutPath', filepath,
  ], { timeout: 30000, maxBuffer: 1024 * 1024 });
  if (!fs.existsSync(filepath)) throw new Error('screenshot file was not created');
  try { fs.copyFileSync(filepath, latest); } catch (_) {}
  // 兼容旧路径（部分 UI 仍指向 state 根目录）
  try { fs.copyFileSync(filepath, path.join(stateDir(), 'openclaw-screenshot-latest.png')); } catch (_) {}
  return filepath;
}

function resolveMediaCliPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'media-cli', 'agnes-media-cli.js'),
    path.join(process.cwd(), 'media-cli', 'agnes-media-cli.js'),
    path.join(stateDir(), 'media-cli', 'agnes-media-cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) return resolved;
    } catch (_) {}
  }
  throw new Error('agnes-media-cli.js not found');
}

async function runDrawPicture(prompt) {
  const outputDir = path.join(stateDir(), 'image-output');
  fs.mkdirSync(outputDir, { recursive: true });
  const { stdout } = await execFileAsync(process.execPath, [
    resolveMediaCliPath(), 'image', '--prompt', prompt, '--output_dir', outputDir,
  ], { timeout: 240000, maxBuffer: 1024 * 1024 });
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  let result = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      result = JSON.parse(lines[i]);
      break;
    } catch (_) {}
  }
  const files = Array.isArray(result?.files) ? result.files.map((f) => f.filepath).filter(Boolean) : [];
  if (files.length === 0) throw new Error('image generator returned no files');
  return files;
}

function unescapeQuoted(value) {
  return String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .trim();
}

function extractJsonObjects(text) {
  const raw = String(text || '');
  const objects = [];
  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let quote = '';
    let escaped = false;
    for (let i = start; i < raw.length && i - start < 5000; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === quote) {
          inString = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      if (depth === 0) {
        objects.push(raw.slice(start, i + 1));
        break;
      }
    }
  }
  return objects;
}

/** 能力介绍/长文里提到工具名，不能当成“伪工具指令”去真执行 */
function looksLikeCapabilityProse(text) {
  const raw = String(text || '');
  if (raw.length > 280) return true;
  return /能做|能力|神通|介绍|以下几类|抓影之术|web_search|music_generate|draw_video/i.test(raw);
}

function extractPromptFromPseudoToolJson(text) {
  for (const candidate of extractJsonObjects(text)) {
    let obj;
    try {
      obj = JSON.parse(candidate);
    } catch (_) {
      continue;
    }
    const action = String(obj.action || obj.name || '').trim().toLowerCase();
    if (!['draw_picture', 'image', 'image_generate'].includes(action)) continue;
    const input = obj.action_input || obj.arguments || obj.input || obj;
    const prompt = input && (input.prompt || input.description || input.text);
    if (typeof prompt === 'string' && prompt.trim()) return prompt.trim();
  }
  return '';
}

function extractDrawPicturePrompt(text) {
  const raw = String(text || '').trim();
  if (!raw || looksLikeCapabilityProse(raw)) return '';
  // 整段几乎是伪工具调用，才提取；散文夹带 draw_picture / JSON 举例一律忽略
  const callAtStart = /^\s*draw_picture\s*\(/i.test(raw) || /\n\s*draw_picture\s*\(/i.test(raw);
  const mostlyJsonTool = (() => {
    const stripped = raw.replace(/^[\s`"'[(]+/, '').trim();
    if (!stripped.startsWith('{') || raw.length > 800) return false;
    if (!/"action"\s*:\s*"draw_picture"|"name"\s*:\s*"draw_picture"/i.test(raw)) return false;
    const outside = raw.replace(/\{[\s\S]*\}/, '').replace(/[\s`"'[\]]+/g, '');
    return outside.length < 24;
  })();
  if (!callAtStart && !mostlyJsonTool) return '';

  const jsonPrompt = extractPromptFromPseudoToolJson(raw);
  if (jsonPrompt) return jsonPrompt;
  const call = raw.match(/\bdraw_picture\s*\(([\s\S]{0,1200}?)\)/i);
  if (!call) return '';
  const args = call[1] || '';
  const named = args.match(/(?:prompt|description)\s*=\s*(["'])([\s\S]*?)\1/i);
  if (named) return unescapeQuoted(named[2]);
  const jsonLike = args.match(/\{[\s\S]*\}/);
  if (jsonLike) {
    try {
      const obj = JSON.parse(jsonLike[0]);
      if (typeof obj.prompt === 'string') return obj.prompt.trim();
      if (typeof obj.description === 'string') return obj.description.trim();
    } catch (_) {}
  }
  const positional = args.match(/^\s*(["'])([\s\S]*?)\1\s*$/);
  if (positional) return unescapeQuoted(positional[2]);
  return '';
}

function looksLikePseudoScreenshot(text) {
  const raw = String(text || '').trim();
  if (!raw || /^MEDIA\s*:/i.test(raw)) return false;
  if (looksLikeCapabilityProse(raw)) return false;
  if (/draw_picture/i.test(raw) && !/"command"\s*:\s*"(?:screen-capture|screenshot)"/i.test(raw)) return false;
  if (/^[\s`"'[{(]*screen-capture[\s`"'\])},;]*$/i.test(raw)) return true;
  if (/\/exec\s+openclaw\s+(?:gateway\s+status\s+)?(?:screenshot|screen-capture)/i.test(raw)) return true;
  if (/"command"\s*:\s*"(?:screen-capture|screenshot|capture-desktop)"/i.test(raw)) return true;
  if (/^(?:请)?(?:执行|运行)?\s*(?:screen-capture|screenshot|capture-desktop)\s*[。.!！]*$/i.test(raw)) return true;
  return false;
}

/** 弱模型拒绝对话时的典型话术 → 自动补截图（仅短拒绝，不碰能力介绍） */
function looksLikeScreenshotRefusal(text) {
  const raw = String(text || '');
  if (!raw.trim() || /^MEDIA\s*:/i.test(raw.trim())) return false;
  if (looksLikeCapabilityProse(raw)) return false;
  if (extractMediaDirectiveUrls(raw).length > 0) return false;
  const refuse =
    /无法.*(?:截|摄)|不能.*(?:截|摄)|没有.*权限|暂未修得|虚空摄影|传影显圣|切换.*(?:强力|更强).*模型|suggest(?:ing)? switching to a stronger model|cannot reliably use the real tool/i.test(
      raw
    );
  const aboutShot = /截图|截个图|截张图|截屏|screenshot|screen-capture/i.test(raw);
  return refuse && aboutShot;
}

/** 双 hook 可能对同一段伪指令各跑一次；短 TTL 缓存 + 进行中锁避免重复截图/生图 */
const _pseudoMediaSideEffectCache = new Map();
const _pseudoMediaInflight = new Map();
const PSEUDO_MEDIA_CACHE_TTL_MS = 12000;

function pseudoMediaCacheKey(text) {
  return String(text || '').trim().slice(0, 800);
}

function getCachedPseudoMedia(text) {
  const key = pseudoMediaCacheKey(text);
  const hit = _pseudoMediaSideEffectCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PSEUDO_MEDIA_CACHE_TTL_MS) {
    _pseudoMediaSideEffectCache.delete(key);
    return null;
  }
  return hit;
}

function setCachedPseudoMedia(text, kind, mediaUrls, replyText) {
  _pseudoMediaSideEffectCache.set(pseudoMediaCacheKey(text), {
    at: Date.now(),
    kind,
    mediaUrls: Array.isArray(mediaUrls) ? mediaUrls : [],
    replyText: String(replyText || ''),
  });
}

async function withPseudoMediaLock(text, worker) {
  const key = pseudoMediaCacheKey(text);
  const cached = getCachedPseudoMedia(text);
  if (cached) return cached;
  if (_pseudoMediaInflight.has(key)) return _pseudoMediaInflight.get(key);
  const pending = (async () => {
    try {
      return await worker();
    } finally {
      _pseudoMediaInflight.delete(key);
    }
  })();
  _pseudoMediaInflight.set(key, pending);
  return pending;
}

function extractMediaDirectiveUrls(text) {
  const raw = String(text || '');
  const urls = [];
  const re = /(?:^|\n)\s*MEDIA\s*:\s*([^\n]+)/gi;
  let match;
  while ((match = re.exec(raw))) {
    let value = String(match[1] || '').trim().replace(/^`|`$/g, '');
    const fileMatch = value.match(/^[A-Za-z]:[\\/].*?\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|webm|mp3|wav|m4a)\b/i)
      || value.match(/^\/.*?\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|webm|mp3|wav|m4a)\b/i);
    if (fileMatch) value = fileMatch[0];
    value = value.replace(/[),.;]+$/g, '');
    if (value) urls.push(unixPath(value));
  }
  return Array.from(new Set(urls));
}

/** 把「MEDIA:路径 状态句」拆成两行，避免 Control UI 把状态句拼进路径 */
function normalizeMediaDirectiveLines(text) {
  return String(text || '').replace(
    /(^|\n)([ \t]*MEDIA\s*:\s*)([A-Za-z]:[\\/][^\n]*?\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|webm|mp3|wav|m4a)|\/[^\n]*?\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|webm|mp3|wav|m4a))([ \t]+)([^\n]+)/gi,
    (_, lead, prefix, filePath, _sp, status) => `${lead}${prefix}${filePath}\n${String(status).trim()}`
  );
}

async function maybeRewritePseudoMedia(text) {
  const raw = normalizeMediaDirectiveLines(String(text || ''));
  if (!raw.trim()) return null;
  if (/^MEDIA\s*:/i.test(raw.trim()) && extractMediaDirectiveUrls(raw).length > 0) {
    // 已是 MEDIA 回复：只做换行规范化
    const normalized = normalizeMediaDirectiveLines(raw);
    return normalized !== String(text || '') ? normalized : null;
  }

  const cached = getCachedPseudoMedia(raw);
  if (cached && cached.replyText) return cached.replyText;

  const prompt = extractDrawPicturePrompt(raw);
  const needShot = !prompt && (looksLikePseudoScreenshot(raw) || looksLikeScreenshotRefusal(raw));
  if (!prompt && !needShot) return null;

  const result = await withPseudoMediaLock(raw, async () => {
    const again = getCachedPseudoMedia(raw);
    if (again) return again;
    if (prompt) {
      const files = await runDrawPicture(prompt);
      const mediaUrls = files.map(unixPath);
      const replyText = `${mediaUrls.map((u) => `MEDIA:${u}`).join('\n')}\nImage generated.`;
      setCachedPseudoMedia(raw, 'draw', mediaUrls, replyText);
      return getCachedPseudoMedia(raw);
    }
    const file = unixPath(await runScreenCapture());
    const replyText = `MEDIA:${file}\nScreenshot captured.`;
    setCachedPseudoMedia(raw, 'shot', [file], replyText);
    return getCachedPseudoMedia(raw);
  });
  return result && result.replyText ? result.replyText : null;
}

async function maybeBuildPseudoMediaPayload(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};
  const raw = normalizeMediaDirectiveLines(
    typeof base.text === 'string' ? base.text : extractText({ content: base.content })
  );
  if (!raw.trim()) return null;

  const directiveUrls = extractMediaDirectiveUrls(raw);
  if (directiveUrls.length > 0) {
    // 去掉 MEDIA 行，保留短状态句，避免通道/会话只剩路径文本
    const statusText = String(raw)
      .replace(/(?:^|\n)\s*MEDIA\s*:\s*[^\n]+/gi, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
    return { ...base, text: statusText, mediaUrl: directiveUrls[0], mediaUrls: directiveUrls };
  }

  const cached = getCachedPseudoMedia(raw);
  if (cached && cached.mediaUrls && cached.mediaUrls.length > 0) {
    const status = cached.kind === 'draw' ? 'Image generated.' : 'Screenshot captured.';
    return { ...base, text: status, mediaUrl: cached.mediaUrls[0], mediaUrls: cached.mediaUrls };
  }

  const prompt = extractDrawPicturePrompt(raw);
  const needShot = !prompt && (looksLikePseudoScreenshot(raw) || looksLikeScreenshotRefusal(raw));
  if (!prompt && !needShot) return null;

  const result = await withPseudoMediaLock(raw, async () => {
    const again = getCachedPseudoMedia(raw);
    if (again) return again;
    if (prompt) {
      const files = await runDrawPicture(prompt);
      const mediaUrls = files.map(unixPath);
      const replyText = `${mediaUrls.map((u) => `MEDIA:${u}`).join('\n')}\nImage generated.`;
      setCachedPseudoMedia(raw, 'draw', mediaUrls, replyText);
      return getCachedPseudoMedia(raw);
    }
    const file = unixPath(await runScreenCapture());
    const replyText = `MEDIA:${file}\nScreenshot captured.`;
    setCachedPseudoMedia(raw, 'shot', [file], replyText);
    return getCachedPseudoMedia(raw);
  });
  if (!result || !result.mediaUrls || result.mediaUrls.length === 0) return null;
  const status = result.kind === 'draw' ? 'Image generated.' : 'Screenshot captured.';
  return { ...base, text: status, mediaUrl: result.mediaUrls[0], mediaUrls: result.mediaUrls };
}

function register(api) {
  try {
    api.logger?.info?.(`[${PLUGIN_ID}] loaded: suppress warnings and repair pseudo media commands`);
  } catch (_) {}

  api.on('reply_payload_sending', async (event) => {
    try {
      const payload = await maybeBuildPseudoMediaPayload(event?.payload);
      if (!payload) return;
      try { api.logger?.info?.(`[${PLUGIN_ID}] rewrote pseudo media payload to mediaUrls`); } catch (_) {}
      return { payload, metadata: { nexoraPseudoMediaFixed: true } };
    } catch (e) {
      console.warn(`[${PLUGIN_ID}] reply_payload_sending hook error:`, e && e.message);
    }
  });

  api.on('message_sending', async (event) => {
    try {
      if (event?.metadata?.nexoraPseudoMediaFixed) return;
      const text = extractText(event);
      const mediaRewrite = await maybeRewritePseudoMedia(text);
      if (mediaRewrite) {
        try { api.logger?.info?.(`[${PLUGIN_ID}] rewrote pseudo media command to MEDIA reply`); } catch (_) {}
        return { content: mediaRewrite, metadata: { nexoraPseudoMediaFixed: true } };
      }

      if (!shouldBlockOutbound(text)) return;
      const preview = text.replace(/\s+/g, ' ').slice(0, 100);
      try { api.logger?.info?.(`[${PLUGIN_ID}] cancelled outbound: ${preview}`); } catch (_) {}
      console.log(`[${PLUGIN_ID}] cancelled outbound: ${preview}`);
      // 关键：拦 /new 类恢复文案时必须通知 rollover，否则通讯渠道只见静默不见续答
      if (needsSessionRollover(text)) {
        queueOverflowRolloverTrigger(resolveSessionKeyFromEvent(event), preview);
      }
      return { cancel: true, cancelReason: 'error-filter:suppress-warning-banner' };
    } catch (e) {
      console.warn(`[${PLUGIN_ID}] message_sending hook error:`, e && e.message);
    }
  });
}

const pluginEntry = {
  id: PLUGIN_ID,
  name: 'Error Notification Filter',
  description: 'Suppresses noisy error banners and repairs pseudo media tool-call text',
  register,
};

export default pluginEntry;
export function activate(api) {
  return register(api);
}
