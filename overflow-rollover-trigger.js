'use strict';
/**
 * 主进程 ↔ session-overflow-rollover 桥：
 * Gateway 只打 compaction-diag 日志、插件钩子未带齐字段时，
 * 主进程写触发文件，插件轮询后执行 sessions.reset + chat.send。
 */
const fs = require('fs');
const path = require('path');

const TRIGGER_NAME = 'overflow-rollover.trigger.json';
const COOLDOWN_MS = 20_000;

/** @type {Map<string, number>} */
const lastQueuedAt = new Map();

function triggerPath(stateDir) {
  return path.join(String(stateDir || ''), TRIGGER_NAME);
}

function isCompactionOverflowFailureLog(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/\[compaction-diag\].*outcome\s*=\s*failed/i.test(t)) return true;
  if (/compaction-diag/i.test(t) && /outcome\s*=\s*failed/i.test(t)) return true;
  if (/Auto-compaction could not recover/i.test(t)) return true;
  if (/Compaction timed out/i.test(t)) return true;
  if (/context overflow detected/i.test(t) && /attempt/i.test(t)) return true;
  // 角色奇偶 / 会话状态损坏：OpenClaw 只会吐 /new 文案，必须同样触发静默换新
  if (/Message ordering conflict/i.test(t)) return true;
  if (/roles must alternate/i.test(t)) return true;
  if (/incorrect role information/i.test(t)) return true;
  if (/use \/new to start a fresh session/i.test(t)) return true;
  if (/rejected the conversation state/i.test(t)) return true;
  if (/Session history looks corrupted/i.test(t)) return true;
  return false;
}

function parseSessionKeyFromLog(text) {
  const t = String(text || '');
  const m =
    t.match(/sessionKey=([^\s\]"'|,]+)/i) ||
    t.match(/session_key=([^\s\]"'|,]+)/i) ||
    t.match(/"sessionKey"\s*:\s*"([^"]+)"/i);
  if (m && m[1]) return m[1].trim();
  return '';
}

function shouldSkipSessionKey(sessionKey) {
  const k = String(sessionKey || '');
  if (!k) return true;
  // cron / 内部跑批不自动续聊，避免打扰主会话
  if (/:cron:|:heartbeat:|:discord:channel:/i.test(k)) return true;
  return false;
}

/**
 * 主进程：从 gateway 日志排队一次静默 rollover。
 * @returns {{ queued: boolean, sessionKey?: string, reason?: string }}
 */
function queueOverflowRolloverFromLog(stateDir, text) {
  if (!stateDir || !isCompactionOverflowFailureLog(text)) {
    return { queued: false };
  }
  let sessionKey = parseSessionKeyFromLog(text);
  if (shouldSkipSessionKey(sessionKey)) {
    // 日志没带 key 时交给插件用「最近用户会话」兜底
    if (!sessionKey) sessionKey = '';
    else return { queued: false, sessionKey, reason: 'skipped-session' };
  }

  const now = Date.now();
  const coolKey = sessionKey || '__default__';
  const prev = lastQueuedAt.get(coolKey) || 0;
  if (now - prev < COOLDOWN_MS) {
    return { queued: false, sessionKey, reason: 'cooldown' };
  }
  lastQueuedAt.set(coolKey, now);

  const payload = {
    v: 1,
    at: now,
    sessionKey: sessionKey || '',
    reason: /ordering|roles must alternate|conversation state/i.test(String(text || ''))
      ? 'ordering-or-state-failed'
      : 'compaction-diag-failed',
    preview: String(text || '').replace(/\s+/g, ' ').slice(0, 240),
  };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(triggerPath(stateDir), JSON.stringify(payload), 'utf8');
    return { queued: true, sessionKey: payload.sessionKey };
  } catch (e) {
    return { queued: false, sessionKey, reason: e && e.message ? e.message : 'write-failed' };
  }
}

/**
 * 插件：消费触发文件（读完即删）。
 * @returns {null | { sessionKey: string, at: number, reason: string }}
 */
function consumeOverflowRolloverTrigger(stateDir) {
  const file = triggerPath(stateDir);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    try {
      fs.unlinkSync(file);
    } catch (_) {}
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const at = Number(obj.at) || 0;
    if (at && Date.now() - at > 120_000) return null; // 过期触发丢弃
    return {
      sessionKey: typeof obj.sessionKey === 'string' ? obj.sessionKey : '',
      at,
      reason: typeof obj.reason === 'string' ? obj.reason : 'trigger',
    };
  } catch (_) {
    try {
      fs.unlinkSync(file);
    } catch (__) {}
    return null;
  }
}

module.exports = {
  TRIGGER_NAME,
  COOLDOWN_MS,
  triggerPath,
  isCompactionOverflowFailureLog,
  parseSessionKeyFromLog,
  queueOverflowRolloverFromLog,
  consumeOverflowRolloverTrigger,
};
