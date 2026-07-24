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

const BLOCK_REGEXES = [
  /Message:\s*.+\s+failed/i,
  /Exec failed/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /TOOL_FAILED/i,
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

function shouldBlockOutbound(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isModelFallbackNoticeOnly(raw)) return true;
  if (isLeakedToolJsonOnly(raw)) return true;
  if (/^\s*[!\[]?\s*(warning|error|failed)\b/i.test(raw)) return true;
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
  const latest = path.join(stateDir(), 'openclaw-screenshot-latest.png');
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolveCaptureScriptPath(), '-OutPath', filepath,
  ], { timeout: 30000, maxBuffer: 1024 * 1024 });
  if (!fs.existsSync(filepath)) throw new Error('screenshot file was not created');
  try { fs.copyFileSync(filepath, latest); } catch (_) {}
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

function extractDrawPicturePrompt(text) {
  const raw = String(text || '');
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
  if (/^MEDIA\s*:/i.test(raw)) return false;
  if (/\b(?:screen-capture|screenshot|capture-desktop)\b/i.test(raw)) return true;
  if (/\/exec\s+openclaw\s+(?:gateway\s+status\s+)?(?:screenshot|screen-capture)/i.test(raw)) return true;
  return false;
}

async function maybeRewritePseudoMedia(text) {
  const raw = String(text || '');
  if (!raw.trim() || /^MEDIA\s*:/i.test(raw.trim())) return null;

  const prompt = extractDrawPicturePrompt(raw);
  if (prompt) {
    const files = await runDrawPicture(prompt);
    return `${files.map((file) => `MEDIA:${unixPath(file)}`).join('\n')}\nImage generated.`;
  }

  if (looksLikePseudoScreenshot(raw)) {
    const file = await runScreenCapture();
    return `MEDIA:${unixPath(file)}\nScreenshot captured.`;
  }

  return null;
}

function register(api) {
  try {
    api.logger?.info?.(`[${PLUGIN_ID}] loaded: suppress warnings and repair pseudo media commands`);
  } catch (_) {}

  api.on('message_sending', async (event) => {
    try {
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
