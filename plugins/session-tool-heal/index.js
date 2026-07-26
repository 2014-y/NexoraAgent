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

/** 网络 / 超时 / 限流等瞬时错误：不是 tool 配对损坏，绝不能拿它去改写会话文件（defect 3a） */
function looksLikeTransientError(text) {
  const t = String(text || '');
  if (!t) return false;
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|rate[\s-]?limit|rate-limited|too many requests|\b429\b|\b503\b|\b502\b|\b500\b|overloaded|temporarily/i.test(t);
}

/** 文件在 ~5s 内被写过：很可能正被另一个联系人的 active 会话写入，跳过修复以免损坏（defect 3b） */
function fileRecentlyWritten(file, ms = 5000) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < ms;
  } catch (_) {
    return false;
  }
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
      // (a) 只在 format/role 类错误时修复；网络/超时/限流等瞬时错误绝不动会话文件
      if (looksLikeTransientError(errText)) return;
      const formatErr =
        repair.looksLikeToolPairFormatError(errText) ||
        repair.looksLikeToolPairFormatError(JSON.stringify(event || {}));
      // 不再因「任何 success===false」就修复：仅 format/role 配对损坏才修，避免误改别的会话
      if (!formatErr) return;

      // (c) 已知 sessionId/文件时只修这一个文件，绝不回退到 mtime 全盘扫描（以免改到别人 active 会话）
      // 注意：这里文件身份是确定的(由 sessionId 解析)，不做 mtime<5s 跳过——
      // 刚失败的会话必然是几秒内刚写过的，若跳过就等于「该修的永远不修」，会话一直卡死。
      const knownFile = resolveSessionFile(ctx, event, { allowMtimeFallback: false });
      if (knownFile) {
        const r = repair.healSessionTranscriptFile(knownFile, fs);
        if (r.changed) {
          console.log(`[${PLUGIN_ID}] healed session (${via}): ${knownFile} (${r.before}->${r.after})`);
        }
        return;
      }

      // 无明确 session 文件：format 错误才允许 mtime 回退 / 全盘扫描
      const file = resolveSessionFile(ctx, event, { allowMtimeFallback: true });
      if (!file) {
        const summary = repair.healAllSessionTranscripts(resolveStateDir(), fs, path);
        if (summary.healed > 0) {
          console.log(`[${PLUGIN_ID}] healed ${summary.healed} session(s) via scan (${via})`);
        }
        return;
      }
      // (b) mtime 命中的文件若 <5s 前刚写过，很可能是另一联系人正在写入的 active 会话，跳过
      if (fileRecentlyWritten(file)) {
        console.log(`[${PLUGIN_ID}] skip heal (${via}): mtime file written <5s ago (likely active): ${file}`);
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
