/**
 * session-tool-heal — 修复会话里断裂的 tool_call / tool_result 配对
 *
 * Gemini 严格要求 function response 紧跟 function call。会话压缩、中断、清洗
 * 都可能把配对弄断，导致整段对话连续 400「不回话」。本插件：
 * 1) 启动时扫描并修复 agents/<id>/sessions 下的 *.jsonl
 * 2) agent_end 失败且像 format/tool payload 时，立刻修复当前会话文件
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'session-tool-heal';
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveRepairMod() {
  const candidates = [
    process.env.OPENCLAW_STATE_DIR && path.join(process.env.OPENCLAW_STATE_DIR, 'tool-turn-repair.js'),
    path.join(__dirname, '..', '..', 'tool-turn-repair.js'),
    path.join(
      process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(),
      '.openclaw',
      'tool-turn-repair.js'
    ),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return require(p);
    } catch (_) {}
  }
  return null;
}

function resolveStateDir() {
  return (
    process.env.OPENCLAW_STATE_DIR ||
    path.join(
      process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(),
      '.openclaw'
    )
  );
}

function resolveSessionFile(ctx, event, { allowMtimeFallback = false } = {}) {
  if (ctx && typeof ctx.sessionFile === 'string' && ctx.sessionFile) return ctx.sessionFile;
  if (event && typeof event.sessionFile === 'string' && event.sessionFile) return event.sessionFile;
  const sessionId =
    (ctx && (ctx.sessionId || ctx.sessionID)) ||
    (event && (event.sessionId || event.sessionID)) ||
    '';
  const stateDir = resolveStateDir();
  const sessionsDir = path.join(stateDir, 'agents', 'main', 'sessions');
  if (sessionId) {
    const direct = path.join(sessionsDir, `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) return direct;
  }
  // 仅 format 类错误才允许「最近修改」回退，避免普通失败误修别的会话
  if (allowMtimeFallback && fs.existsSync(sessionsDir)) {
    try {
      const files = fs
        .readdirSync(sessionsDir)
        .filter((n) => /\.jsonl$/i.test(n) && !/bak/i.test(n))
        .map((n) => {
          const full = path.join(sessionsDir, n);
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch (_) {}
          return { full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (files[0]) return files[0].full;
    } catch (_) {}
  }
  return '';
}

function extractErrorText(event, ctx) {
  const parts = [];
  if (!event) return '';
  for (const k of ['error', 'rawError', 'message', 'reason', 'detail', 'errorMessage']) {
    if (event[k] != null) parts.push(String(event[k]));
  }
  if (event.data && typeof event.data === 'object') {
    for (const k of ['error', 'rawError', 'message']) {
      if (event.data[k] != null) parts.push(String(event.data[k]));
    }
  }
  if (ctx && ctx.error) parts.push(String(ctx.error));
  return parts.join('\n');
}

function register(api) {
  const repair = resolveRepairMod();
  if (!repair) {
    console.warn(`[${PLUGIN_ID}] tool-turn-repair.js not found — heal disabled`);
    return;
  }

  try {
    api.logger?.info?.(`[${PLUGIN_ID}] loaded`);
  } catch (_) {}
  console.log(`[${PLUGIN_ID}] loaded`);

  // 启动扫描
  try {
    const summary = repair.healAllSessionTranscripts(resolveStateDir(), fs, path);
    if (summary.healed > 0) {
      console.log(
        `[${PLUGIN_ID}] startup heal: scanned=${summary.scanned} healed=${summary.healed}`
      );
    }
  } catch (e) {
    console.warn(`[${PLUGIN_ID}] startup heal failed:`, e && e.message);
  }

  const healCurrent = (event, ctx, via) => {
    try {
      const errText = extractErrorText(event, ctx);
      const failed = event && event.success === false;
      const formatErr =
        repair.looksLikeToolPairFormatError(errText) ||
        repair.looksLikeToolPairFormatError(JSON.stringify(event || {}));

      // 有明确 session 文件时：失败即检查修复（clean 则 no-op）
      // 无文件时：仅 format 错误才允许 mtime/全盘扫描，避免误伤
      const knownFile = resolveSessionFile(ctx, event, { allowMtimeFallback: false });
      if (knownFile && (failed || formatErr)) {
        const r = repair.healSessionTranscriptFile(knownFile, fs);
        if (r.changed) {
          console.log(`[${PLUGIN_ID}] healed session (${via}): ${knownFile} (${r.before}->${r.after})`);
        }
        return;
      }

      if (!formatErr) return;

      const file = resolveSessionFile(ctx, event, { allowMtimeFallback: true });
      if (!file) {
        const summary = repair.healAllSessionTranscripts(resolveStateDir(), fs, path);
        if (summary.healed > 0) {
          console.log(`[${PLUGIN_ID}] healed ${summary.healed} session(s) via scan (${via})`);
        }
        return;
      }
      const r = repair.healSessionTranscriptFile(file, fs);
      if (r.changed) {
        console.log(`[${PLUGIN_ID}] healed session (${via}): ${file} (${r.before}->${r.after})`);
      }
    } catch (e) {
      console.warn(`[${PLUGIN_ID}] heal error:`, e && e.message);
    }
  };

  api.on('agent_end', async (event, ctx) => {
    healCurrent(event, ctx, 'agent_end');
  });

  // 有的运行时用 llm 错误事件
  try {
    api.on('llm_output', async (event, ctx) => {
      const errText = extractErrorText(event, ctx);
      if (repair.looksLikeToolPairFormatError(errText)) {
        healCurrent(event, ctx, 'llm_output');
      }
    });
  } catch (_) {}
}

const pluginEntry = {
  id: PLUGIN_ID,
  name: 'Session Tool Turn Heal',
  description:
    'Repairs broken tool_call/tool_result pairs in session transcripts so Gemini chats do not go mute mid-conversation',
  register,
};

export default pluginEntry;
export function activate(api) {
  return register(api);
}
