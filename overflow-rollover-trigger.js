'use strict';
/**
 * 主进程 ↔ session-overflow-rollover 桥：
 * Gateway 只打 compaction-diag 日志、插件钩子未带齐字段时，
 * 主进程写触发文件，插件轮询后执行 sessions.reset + chat.send。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRIGGER_NAME = 'overflow-rollover.trigger.json';
const COOLDOWN_MS = 20_000;
/** lastQueuedAt 的清理阈值：条目超过该年龄即视为过期可删（远大于 COOLDOWN，安全） */
const QUEUED_MAX_AGE_MS = 10 * COOLDOWN_MS;
/** lastQueuedAt 硬上限，超过就顺带清理，避免 Map 无界增长 */
const QUEUED_MAX_ENTRIES = 500;

/** @type {Map<string, number>} */
const lastQueuedAt = new Map();

function triggerPath(stateDir) {
  return path.join(String(stateDir || ''), TRIGGER_NAME);
}

/** 把 sessionKey 变成安全的文件名片段；异常字符太多则退化为哈希 */
function sanitizeKeyForFile(sessionKey) {
  const safe = String(sessionKey || '').replace(/[^\w.-]+/g, '_').slice(0, 80);
  if (safe && safe.replace(/_/g, '')) return safe;
  return crypto.createHash('sha1').update(String(sessionKey || '')).digest('hex').slice(0, 16);
}

/** 每会话独立的触发文件路径（defect 2：同秒多会话溢出时避免固定文件互相覆盖） */
function sessionTriggerPath(stateDir, sessionKey) {
  return path.join(String(stateDir || ''), `overflow-rollover.${sanitizeKeyForFile(sessionKey)}.trigger.json`);
}

/** 清理过期 / 超量的 lastQueuedAt 条目（defect 2：原实现从不清理，长期泄漏） */
function pruneQueuedMap(now) {
  if (lastQueuedAt.size < QUEUED_MAX_ENTRIES) {
    // 轻量：仅在偶发超过一半容量时才扫描，平时零开销
    if (lastQueuedAt.size < QUEUED_MAX_ENTRIES / 2) return;
  }
  for (const [k, t] of lastQueuedAt) {
    if (now - (Number(t) || 0) > QUEUED_MAX_AGE_MS) lastQueuedAt.delete(k);
  }
}

function isCompactionOverflowFailureLog(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/\[compaction-diag\].*outcome\s*=\s*failed/i.test(t)) return true;
  if (/compaction-diag/i.test(t) && /outcome\s*=\s*failed/i.test(t)) return true;
  // JSON 风格日志（"outcome":"failed"）不能漏
  if (/compaction/i.test(t) && /"outcome"\s*:\s*"failed"/i.test(t)) return true;
  if (/Auto-compaction could not recover/i.test(t)) return true;
  if (/auto-compaction failed/i.test(t)) return true;
  if (/Compaction timed out/i.test(t)) return true;
  if (/context overflow detected/i.test(t) && /attempt/i.test(t)) return true;
  // 与插件 looksLikeOverflowFailure 的特征集对齐（桥的存在意义就是兜插件漏检，集合不能更窄）
  if (/context_overflow|compaction_failure/i.test(t)) return true;
  if (/Context is too large/i.test(t)) return true;
  if (/prompt too large/i.test(t)) return true;
  if (/Context limit exceeded/i.test(t)) return true;
  if (/diagId\s*=\s*ovf-/i.test(t)) return true;
  if (/trigger\s*=\s*overflow/i.test(t)) return true;
  // 角色奇偶 / 会话状态损坏：OpenClaw 只会吐 /new 文案，必须同样触发静默换新
  if (/Message ordering conflict/i.test(t)) return true;
  if (/roles must alternate/i.test(t)) return true;
  if (/incorrect role information/i.test(t)) return true;
  if (/use \/new to start a fresh session/i.test(t)) return true;
  if (/rejected the conversation state/i.test(t)) return true;
  if (/Session history looks corrupted/i.test(t)) return true;
  return false;
}

/** 无 key 日志行的归因：3 分钟内最近活跃的用户会话（找不到就放弃，绝不猜默认会话） */
function resolveRecentInteractiveSessionKey(stateDir, maxAgeMs = 180_000) {
  try {
    const storePath = path.join(String(stateDir || ''), 'agents', 'main', 'sessions', 'sessions.json');
    if (!fs.existsSync(storePath)) return '';
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8').replace(/^﻿/, ''));
    if (!store || typeof store !== 'object') return '';
    let best = '';
    let bestAt = 0;
    for (const [k, v] of Object.entries(store)) {
      if (!k || /:cron:|:heartbeat:|:discord:channel:/i.test(k)) continue;
      const at = Number(v && (v.lastInteractionAt || v.updatedAt)) || 0;
      if (at > bestAt) {
        bestAt = at;
        best = k;
      }
    }
    if (!best || Date.now() - bestAt > maxAgeMs) return '';
    return best;
  } catch (_) {
    return '';
  }
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
 * 注意：text 应是「单行」日志——跨行传整个 chunk 会把别的会话行里的
 * sessionKey= 错配到失败行上（清错人的会话）。chunk 请走 queueOverflowRolloverFromLogChunk。
 * @returns {{ queued: boolean, sessionKey?: string, reason?: string }}
 */
function queueOverflowRolloverFromLog(stateDir, text) {
  if (!stateDir || !isCompactionOverflowFailureLog(text)) {
    return { queued: false };
  }
  let sessionKey = parseSessionKeyFromLog(text);
  if (sessionKey && shouldSkipSessionKey(sessionKey)) {
    return { queued: false, sessionKey, reason: 'skipped-session' };
  }
  if (!sessionKey) {
    // 失败行常不带 key（roles must alternate 等原生错误）。插件端会直接丢弃无 key 触发，
    // 所以必须在主进程归因；归因不到（3 分钟内无活跃用户会话）就放弃，绝不乱猜
    sessionKey = resolveRecentInteractiveSessionKey(stateDir);
    if (!sessionKey) return { queued: false, reason: 'no-session-key' };
  }

  const now = Date.now();
  pruneQueuedMap(now);
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
    const body = JSON.stringify(payload);
    // 兼容旧消费者：固定文件仍然写（consumeMainProcessTrigger / consumeOverflowRolloverTrigger 读它）
    fs.writeFileSync(triggerPath(stateDir), body, 'utf8');
    // defect 2：带 sessionKey 时再写一份 per-session 文件，避免同秒多会话溢出时固定文件被覆盖丢触发。
    // 插件侧 consumePerSessionTriggers 会扫描并逐个消费这些文件。
    if (payload.sessionKey) {
      try {
        fs.writeFileSync(sessionTriggerPath(stateDir, payload.sessionKey), body, 'utf8');
      } catch (_) {}
    }
    return { queued: true, sessionKey: payload.sessionKey };
  } catch (e) {
    return { queued: false, sessionKey, reason: e && e.message ? e.message : 'write-failed' };
  }
}

/** 每个 stateDir 一份未完行缓冲（gateway stdout 是流式 chunk，特征行可能被截断在两个 chunk 里） */
const carryTailByDir = new Map();
const CARRY_TAIL_MAX = 8192;

/**
 * 主进程推荐入口：喂原始 stdout/stderr chunk。
 * 内部按行缓冲后逐行匹配，避免跨 chunk 截断漏检与跨行 sessionKey 错配。
 */
function queueOverflowRolloverFromLogChunk(stateDir, chunk) {
  if (!stateDir || chunk == null) return { queued: false };
  const dirKey = String(stateDir);
  const combined = (carryTailByDir.get(dirKey) || '') + String(chunk);
  const parts = combined.split(/\r?\n/);
  const tail = parts.pop() || '';
  carryTailByDir.set(dirKey, tail.length > CARRY_TAIL_MAX ? tail.slice(-CARRY_TAIL_MAX) : tail);
  let result = { queued: false };
  for (const line of parts) {
    if (!line) continue;
    const r = queueOverflowRolloverFromLog(stateDir, line);
    if (r.queued) result = r;
  }
  return result;
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
  sessionTriggerPath,
  isCompactionOverflowFailureLog,
  parseSessionKeyFromLog,
  resolveRecentInteractiveSessionKey,
  queueOverflowRolloverFromLog,
  queueOverflowRolloverFromLogChunk,
  consumeOverflowRolloverTrigger,
};
