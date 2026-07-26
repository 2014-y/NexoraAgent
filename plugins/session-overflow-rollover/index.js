/**
 * session-overflow-rollover
 *
 * 上下文溢出 / 自动压缩失败时：
 * 1) 拦截「请 /new」类恢复文案
 * 2) 归档旧会话（sessions.reset reason=new → *.reset.<ts>）
 * 3) 在新会话里重提上一问，让模型继续回答
 *
 * 另有两道前置防线（让用户永远看不到「开新会话」）：
 * a) 预防式换会话：回合结束后检查会话预算（remainingPromptBudgetTokens 等），
 *    吃紧就在空闲窗口静默归档换新，不等真正溢出
 * b) 模型话术拦截：模型在预算吃紧时自己劝用户「开新会话/新窗口」——按溢出横幅
 *    处理：拦下不发，自动归档换新并续答上一问
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const PLUGIN_ID = 'session-overflow-rollover';
const COOLDOWN_MS = 60_000;
/** 本会话近期已有用户可见回复时，禁止 silent-retry / rollover 再跑一整轮（防双倍烧 token）。
 *  窗口仅需覆盖「同一轮回复完成后尾随的溢出横幅」（几秒内）；过宽（原 120s）会把
 *  「刚回一条、随后新提问真正溢出」也误判为已投递而跳过恢复 → 对新问题静默。 */
const recentUserFacingDeliveryAt = new Map();
const DELIVERY_BLOCK_RESUME_MS = 10_000;
const TRIGGER_FILE = 'overflow-rollover.trigger.json';
/** 预防式换会话阈值：剩余提示预算低于 min(该值, 窗口的 20%) 即视为吃紧。
 *  取窗口 20% 是为了兼容本地小模型（8k 窗口不能套 24k 阈值，否则每轮都换）。 */
const PROACTIVE_REMAINING_TOKENS = Number(process.env.NEXORA_PROACTIVE_ROLLOVER_REMAINING || 24_000);
const PROACTIVE_MIN_COMPACTIONS = Number(process.env.NEXORA_PROACTIVE_ROLLOVER_COMPACTIONS || 2);
/** 回合结束后延迟触发，避开尾随的媒体投递；期间用户又发新消息则放弃等下个空闲窗口 */
const PROACTIVE_DELAY_MS = 8_000;
const ARCHIVE_NOTE_DIR_REL = path.join('workspace', 'compact-history');
const ACTIVE_CONTEXT_HEADING = '## Active session context';
const CONTINUITY_SUMMARY_MAX = 900;
const CONTINUITY_PROMPT_MAX = 700;
const RECENT_TURN_PAIRS = 6;
const ARCHIVE_TURN_PAIRS = 24;
const ARCHIVE_FILE_MAX_CHARS = 48_000;
const LAST_ARCHIVE_REL = path.join('workspace', 'memory', 'last-session-archive.md');
/** 无补发的换会话（预防式/应急）后，把延续上下文挂起；
 *  新会话第一轮经 before_prompt_build 注入 prompt 并随转录永久留在会话里。
 *  这保证群聊等不注入 MEMORY.md 的会话换新后也不失忆。 */
const PENDING_CONTINUITY_DIR_REL = 'overflow-rollover.pending';
const PENDING_CONTINUITY_TTL_MS = 48 * 60 * 60 * 1000;
const PENDING_INJECT_MAX_CHARS = 1200;

/** @type {Map<string, { text: string, at: number }>} */
const lastUserBySession = new Map();
/** 入站时缓存投递路由，补 sessions.json 缺 lastChannel/lastTo 的情况（dmScope=main） */
/** @type {Map<string, { channel: string, to: string, accountId: string, threadId: string, at: number }>} */
const lastDeliveryRouteBySession = new Map();
/** @type {Map<string, number>} */
const lastRolloverAt = new Map();
/** @type {Map<string, { resume: boolean }>} */
/** 进行中的 rollover：key → { resume }。resume=false（预防式）不会替用户补答，
 *  scheduleRollover 据此如实告知调用方「恢复是否有着落」 */
const inFlight = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const pendingScheduleTimers = new Map();
/** 主进程触发轮询定时器句柄；plugin shutdown 时 clearInterval，避免定时器泄漏 */
let pollTimer = null;
/** 上次清理过期 Map 条目的时间戳（节流：最多每 60s 清一次） */
let lastPruneAt = 0;
/** 无界 Map 的兜底上限；超过则强制清一次，防内存无限增长 */
const STATE_MAX_AGE_MS = 10 * 60_000;

function stateDir() {
  return (
    process.env.OPENCLAW_STATE_DIR ||
    path.join(
      process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(),
      '.openclaw'
    )
  );
}

function extractText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();
  if (typeof payload !== 'object') return '';
  const keys = [
    'content',
    'text',
    'body',
    'Body',
    'bodyForAgent',
    'BodyForAgent',
    'message',
    'rawBody',
    'RawBody',
    'commandBody',
  ];
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object') {
      if (typeof v.text === 'string' && v.text.trim()) return v.text.trim();
      if (typeof v.content === 'string' && v.content.trim()) return v.content.trim();
    }
  }
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function resolveSessionKey(event, ctx) {
  const cands = [
    ctx && ctx.sessionKey,
    ctx && ctx.session_key,
    event && event.sessionKey,
    event && event.session_key,
    event && event.key,
    ctx && ctx.key,
    event && event.to && event.to.sessionKey,
    event && event.payload && event.payload.sessionKey,
  ];
  for (const k of cands) {
    if (typeof k === 'string' && k.trim()) return k.trim();
  }
  return '';
}

function resolveSessionFile(event, ctx) {
  const cands = [
    ctx && ctx.sessionFile,
    event && event.sessionFile,
    event && event.session_file,
  ];
  for (const p of cands) {
    if (typeof p === 'string' && p && fs.existsSync(p)) return p;
  }
  const sessionId =
    (ctx && (ctx.sessionId || ctx.sessionID)) ||
    (event && (event.sessionId || event.sessionID)) ||
    '';
  if (!sessionId) return '';
  const direct = path.join(stateDir(), 'agents', 'main', 'sessions', `${sessionId}.jsonl`);
  return fs.existsSync(direct) ? direct : '';
}

function resolveSessionFileByKey(sessionKey) {
  try {
    if (!sessionKey) return '';
    const storePath = path.join(stateDir(), 'agents', 'main', 'sessions', 'sessions.json');
    if (!fs.existsSync(storePath)) return '';
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8').replace(/^\uFEFF/, ''));
    const entry = store && store[sessionKey];
    const sid = entry && entry.sessionId;
    if (!sid) return '';
    const file = path.join(stateDir(), 'agents', 'main', 'sessions', `${sid}.jsonl`);
    return fs.existsSync(file) ? file : '';
  } catch (_) {
    return '';
  }
}

/**
 * 是否 session-tool-heal 刚就地修复过该会话（近 N 秒内留有 .bak-toolheal-* 备份）。
 * 用于避免与 tool-heal 抢同一个「角色顺序/工具配对」错误：heal 已把会话修好，
 * 此时 rollover 再 reset 会白白丢弃刚修好的会话。真溢出场景 heal 不会产生该备份，故不影响溢出恢复。
 */
function healRecentlyRepaired(sessionKey, windowMs = 8000) {
  try {
    const file = resolveSessionFileByKey(sessionKey);
    if (!file) return false;
    const dir = path.dirname(file);
    const prefix = path.basename(file) + '.bak-toolheal-';
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix)) continue;
      try {
        if (now - fs.statSync(path.join(dir, name)).mtimeMs < windowMs) return true;
      } catch (_) {}
    }
  } catch (_) {}
  return false;
}

function normalizeDeliveryRoute(channel, to, accountId, threadId) {
  const ch = String(channel || '').trim();
  const dest = String(to || '').trim();
  if (!ch || !dest) return null;
  if (/^webchat$/i.test(ch)) return null;
  return {
    channel: ch,
    to: dest,
    accountId: accountId ? String(accountId).trim() : '',
    threadId: threadId != null && String(threadId).trim() ? String(threadId).trim() : '',
  };
}

function rememberDeliveryRoute(sessionKey, event, ctx) {
  try {
    if (!sessionKey) return;
    const channel =
      (ctx && (ctx.channelId || ctx.channel || ctx.provider)) ||
      (event && (event.channelId || event.channel || event.provider)) ||
      (event && event.metadata && (event.metadata.channel || event.metadata.provider)) ||
      '';
    const to =
      (ctx && (ctx.to || ctx.peerId || ctx.from)) ||
      (event && (event.to || event.peerId || event.from)) ||
      (event && event.metadata && event.metadata.to) ||
      '';
    const accountId =
      (ctx && ctx.accountId) ||
      (event && event.accountId) ||
      (event && event.metadata && event.metadata.accountId) ||
      '';
    const threadId =
      (ctx && (ctx.threadId || ctx.thread_id)) ||
      (event && (event.threadId || event.thread_id)) ||
      '';
    const route = normalizeDeliveryRoute(channel, to, accountId, threadId);
    if (!route) return;
    lastDeliveryRouteBySession.set(sessionKey, { ...route, at: Date.now() });
  } catch (_) {}
}

/** 读取会话投递路由（微信默认落到 agent:main:main，仅 deliver:true 不够） */
function readSessionDeliveryRoute(sessionKey) {
  try {
    if (!sessionKey) return null;
    const storePath = path.join(stateDir(), 'agents', 'main', 'sessions', 'sessions.json');
    if (fs.existsSync(storePath)) {
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8').replace(/^\uFEFF/, ''));
      const entry = store && store[sessionKey];
      if (entry && typeof entry === 'object') {
        const channel =
          (entry.deliveryContext && entry.deliveryContext.channel) ||
          entry.lastChannel ||
          (entry.origin && (entry.origin.provider || entry.origin.channel)) ||
          '';
        const to =
          (entry.deliveryContext && entry.deliveryContext.to) ||
          entry.lastTo ||
          (entry.origin && entry.origin.to) ||
          '';
        const accountId =
          (entry.deliveryContext && entry.deliveryContext.accountId) ||
          entry.lastAccountId ||
          (entry.origin && entry.origin.accountId) ||
          '';
        const threadId =
          (entry.deliveryContext && entry.deliveryContext.threadId) ||
          entry.lastThreadId ||
          '';
        const fromStore = normalizeDeliveryRoute(channel, to, accountId, threadId);
        if (fromStore) return fromStore;
      }
    }
    // sessions.json 缺路由时，用入站缓存（否则 chat.send 只进内部 webchat，微信静默）
    const cached = lastDeliveryRouteBySession.get(sessionKey);
    if (cached && Date.now() - (cached.at || 0) < 30 * 60_000) {
      return normalizeDeliveryRoute(cached.channel, cached.to, cached.accountId, cached.threadId);
    }
    return null;
  } catch (_) {
    return null;
  }
}

/** 从 sessions.json 读会话预算/状态，供预防式换会话与话术拦截判断 */
function readSessionContextPressure(sessionKey) {
  try {
    if (!sessionKey) return null;
    const storePath = path.join(stateDir(), 'agents', 'main', 'sessions', 'sessions.json');
    if (!fs.existsSync(storePath)) return null;
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8').replace(/^﻿/, ''));
    const entry = store && store[sessionKey];
    if (!entry || typeof entry !== 'object') return null;
    const contextTokens = Number(entry.contextTokens) || 0;
    const totalTokens = Number(entry.totalTokens) || 0;
    let remaining = Number(entry.remainingPromptBudgetTokens);
    if (!Number.isFinite(remaining)) {
      remaining = contextTokens > 0 && totalTokens > 0 ? contextTokens - totalTokens : NaN;
    }
    return {
      status: String(entry.status || ''),
      updatedAt: Number(entry.updatedAt) || 0,
      contextTokens,
      totalTokens,
      remaining: Number.isFinite(remaining) ? remaining : null,
      overflowTokens: Number(entry.overflowTokens) || 0,
      compactionCount: Number(entry.compactionCount) || 0,
    };
  } catch (_) {
    return null;
  }
}

/** 返回吃紧原因字符串；不吃紧返回 '' */
function sessionUnderContextPressure(sessionKey) {
  const p = readSessionContextPressure(sessionKey);
  if (!p) return '';
  if (p.overflowTokens > 0) return `overflowTokens=${p.overflowTokens}`;
  // 压缩次数多但余量仍充足（>半窗）说明压缩在正常工作——别为此换会话白丢近期记忆
  if (
    p.compactionCount >= PROACTIVE_MIN_COMPACTIONS &&
    (p.remaining == null || p.contextTokens <= 0 || p.remaining <= p.contextTokens * 0.5)
  ) {
    return `compactionCount=${p.compactionCount}`;
  }
  if (p.remaining != null && p.contextTokens > 0) {
    const floor = Math.min(PROACTIVE_REMAINING_TOKENS, Math.floor(p.contextTokens * 0.2));
    if (p.remaining <= floor) return `remaining=${p.remaining}/${p.contextTokens}`;
  }
  return '';
}

/** 模型自己劝用户换会话的话术。仅配合 sessionUnderContextPressure 使用，
 *  避免误伤正常功能问答（如用户问「怎么新建会话」时的解释）。 */
function asksUserToStartNewSession(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 600) return false;
  return (
    /(请|麻烦|建议|需要|可以|得|要不?)[^\n。！？!?]{0,12}(重新|另|新)开[^\n。！？!?]{0,6}(会话|对话|聊天|窗口)/.test(t) ||
    /(新建|新开|另开|换个?|重开)[^\n。！？!?]{0,4}(会话|对话|聊天窗口|窗口)/.test(t) ||
    /开(一个|个)?新的?(会话|对话|聊天)(窗口)?/.test(t) ||
    /start (a )?new (chat|session|conversation)/i.test(t) ||
    /open (a )?new (chat|session|window)/i.test(t) ||
    /(发送|输入|使用)\s*\/new/i.test(t)
  );
}

function buildChatSendParams(sessionKey, message, deliveryRoute) {
  const params = {
    sessionKey,
    message,
    deliver: true,
    idempotencyKey: crypto.randomUUID(),
  };
  if (deliveryRoute && deliveryRoute.channel && deliveryRoute.to) {
    params.originatingChannel = deliveryRoute.channel;
    params.originatingTo = deliveryRoute.to;
    if (deliveryRoute.accountId) params.originatingAccountId = deliveryRoute.accountId;
    if (deliveryRoute.threadId) params.originatingThreadId = deliveryRoute.threadId;
  }
  return params;
}

function msgText(msg) {
  if (!msg) return '';
  const t = extractText(msg);
  return String(t || '').replace(/\s+/g, ' ').trim();
}

function isNoiseUserText(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.startsWith('/')) return true;
  if (/\[内部延续上下文\]/.test(t)) return true;
  if (isOverflowRecoveryText(t)) return true;
  if (isRateLimitBannerText(t)) return true;
  return false;
}

/** 剥掉嵌套的延续提示，只保留最内层真实用户问题 */
function unwrapUserQuestion(lastUserText) {
  let t = String(lastUserText || '').trim();
  for (let i = 0; i < 8; i++) {
    if (!/\[内部延续上下文\]/.test(t)) break;
    const m = t.match(/用户问题：\s*([\s\S]+)$/);
    if (!m || !String(m[1] || '').trim()) break;
    t = String(m[1]).trim();
  }
  return t;
}

/**
 * 从即将归档的 transcript 抽一段短摘要（不调大模型，溢出时 LLM 已不可用）。
 * 用于写入 MEMORY.md / 续问上下文，避免换新会话后完全失忆。
 */
function buildContinuitySummary(sessionFile, lastUserText, opts = {}) {
  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : CONTINUITY_SUMMARY_MAX;
  const maxPairs = Number(opts.maxPairs) > 0 ? Number(opts.maxPairs) : RECENT_TURN_PAIRS;
  const { facts, turns } = extractTranscriptTurns(sessionFile);
  const recent = turns.slice(-maxPairs);
  const parts = [];
  if (facts.length) {
    const uniq = [...new Set(facts)].slice(-5);
    parts.push('关键约定/身份: ' + uniq.join('；'));
  }
  if (recent.length) {
    parts.push(
      '近期对话:\n' +
        recent
          .map((t, i) => `${i + 1}. 用户: ${t.q}\n   助手: ${t.a}`)
          .join('\n')
    );
  }
  const last = String(lastUserText || '').trim();
  if (last && !isNoiseUserText(last)) {
    parts.push('待续问: ' + last.slice(0, 200));
  }

  let out = parts.join('\n').trim();
  if (!out) return '';
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…';
  return out;
}

function extractTranscriptTurns(sessionFile) {
  const facts = [];
  const turns = [];
  let pendingUser = null;
  try {
    if (sessionFile && fs.existsSync(sessionFile)) {
      const lines = fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      for (const line of lines) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch (_) {
          continue;
        }
        const msg = obj && obj.message;
        if (!msg || !msg.role) continue;
        const text = msgText(msg);
        if (!text || text.length < 2) continue;
        if (msg.role === 'user') {
          if (isNoiseUserText(text)) continue;
          if (/^(我叫|我的名字|我是|你是谁|你叫什么|记住|偏好|不要|禁止|喜欢|不喜欢|以后请|请你记住)/.test(text)) {
            facts.push(text.slice(0, 120));
          }
          pendingUser = text.slice(0, 800);
        } else if (msg.role === 'assistant' && pendingUser) {
          if (isOverflowRecoveryText(text) || isRateLimitBannerText(text)) {
            pendingUser = null;
            continue;
          }
          turns.push({
            q: pendingUser,
            a: text.slice(0, 1200),
          });
          pendingUser = null;
        }
      }
    }
  } catch (_) {}
  return { facts, turns };
}

/**
 * 把旧会话写成 workspace 内可读 Markdown，新会话可用 read 工具按需打开。
 * 稳定路径：memory/last-session-archive.md
 */
function writeReadableSessionArchive(sessionFile, sessionKey, lastUserText) {
  try {
    const { facts, turns } = extractTranscriptTurns(sessionFile);
    if (!turns.length && !facts.length && !lastUserText) return '';

    const recent = turns.slice(-ARCHIVE_TURN_PAIRS);
    const stamp = new Date().toISOString();
    const stableRel = LAST_ARCHIVE_REL;
    const stableAbs = path.join(stateDir(), stableRel);
    const datedRel = path.join(
      'workspace',
      'memory',
      `session-archive-${stamp.replace(/[:.]/g, '-')}.md`
    );
    const datedAbs = path.join(stateDir(), datedRel);
    fs.mkdirSync(path.dirname(stableAbs), { recursive: true });

    const bodyParts = [
      `# 上一会话归档（可读）`,
      ``,
      `- 时间: ${stamp}`,
      `- sessionKey: ${sessionKey || ''}`,
      `- 说明: 上下文溢出后自动换新会话。新会话可 \`read\` 本文件召回细节；勿向用户提换会话/失忆。`,
      ``,
    ];
    if (facts.length) {
      bodyParts.push(`## 关键约定/身份`, ...[...new Set(facts)].slice(-8).map((f) => `- ${f}`), ``);
    }
    bodyParts.push(`## 对话摘录（最近 ${recent.length} 轮）`, ``);
    if (!recent.length) {
      bodyParts.push('(无完整问答轮次)', ``);
    } else {
      recent.forEach((t, i) => {
        bodyParts.push(`### ${i + 1}`);
        bodyParts.push(`**用户:** ${t.q}`);
        bodyParts.push(`**助手:** ${t.a}`);
        bodyParts.push(``);
      });
    }
    if (lastUserText) {
      bodyParts.push(`## 待续问`, ``, String(lastUserText).slice(0, 500), ``);
    }

    let body = bodyParts.join('\n');
    if (body.length > ARCHIVE_FILE_MAX_CHARS) {
      body = body.slice(0, ARCHIVE_FILE_MAX_CHARS - 20) + '\n\n…(归档已截断)\n';
    }
    fs.writeFileSync(stableAbs, body, 'utf8');
    try {
      fs.writeFileSync(datedAbs, body, 'utf8');
    } catch (_) {}

    // 相对 workspace 的路径，方便模型 read
    const workspaceRel = 'memory/last-session-archive.md';
    console.log(`[${PLUGIN_ID}] readable archive written: ${workspaceRel} (${body.length} chars)`);
    return workspaceRel;
  } catch (e) {
    console.warn(`[${PLUGIN_ID}] readable archive failed:`, e && e.message);
    return '';
  }
}

function pendingContinuityFile(sessionKey) {
  const safe = String(sessionKey || 'session').replace(/[^\w.-]+/g, '_').slice(0, 80);
  const digest = crypto.createHash('sha1').update(String(sessionKey || '')).digest('hex').slice(0, 8);
  return path.join(stateDir(), PENDING_CONTINUITY_DIR_REL, `${safe}-${digest}.json`);
}

/** 换会话但没有补发续聊 prompt 时调用：挂起延续上下文等下一条入站注入 */
function writePendingContinuity(sessionKey, continuity, lastUserText) {
  try {
    if (!sessionKey) return false;
    const summary = String((continuity && continuity.summary) || '').trim();
    const archivePath = String((continuity && continuity.archivePath) || '').trim();
    if (!summary && !archivePath) return false;
    const file = pendingContinuityFile(sessionKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        sessionKey,
        summary,
        archivePath,
        lastUserText: String(lastUserText || '').slice(0, 300),
        at: Date.now(),
      }),
      'utf8'
    );
    fs.renameSync(tmp, file);
    console.log(`[${PLUGIN_ID}] pending continuity saved key=${sessionKey} (${summary.length} chars)`);
    return true;
  } catch (e) {
    console.warn(`[${PLUGIN_ID}] pending continuity save failed:`, e && e.message);
    return false;
  }
}

/** 取出并清除挂起的延续上下文（一次性；注入后即随转录成为会话历史） */
function consumePendingContinuity(sessionKey) {
  try {
    if (!sessionKey) return null;
    const file = pendingContinuityFile(sessionKey);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    try {
      fs.unlinkSync(file);
    } catch (_) {}
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (obj.at && Date.now() - Number(obj.at) > PENDING_CONTINUITY_TTL_MS) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

function buildPendingInjectionBlock(pending) {
  const summary = String((pending && pending.summary) || '').trim();
  const arch = String((pending && pending.archivePath) || '').trim() || 'memory/last-session-archive.md';
  let clipped = summary;
  if (clipped.length > PENDING_INJECT_MAX_CHARS) {
    clipped = clipped.slice(0, PENDING_INJECT_MAX_CHARS - 1) + '…';
  }
  return [
    '[会话延续上下文] 此前的长对话已自动归档，以下是要点回顾；回答需要更多历史细节时先 read `' +
      arch +
      '` 再作答。不要向用户提及换会话、归档或失忆，直接自然接续对话。',
    clipped || '(详见归档文件)',
  ].join('\n');
}

function workspaceMemoryPath() {
  return path.join(stateDir(), 'workspace', 'MEMORY.md');
}

function workspaceDailyMemoryPath(date = new Date()) {
  const ymd = date.toISOString().slice(0, 10);
  return path.join(stateDir(), 'workspace', 'memory', `${ymd}.md`);
}

/** 把 Active session context 插到 MEMORY.md 靠前位置，供新会话 bootstrap 注入 */
function upsertActiveSessionContext(summary, archivePath) {
  const body = String(summary || '').trim();
  if (!body && !archivePath) return false;
  try {
    const file = workspaceMemoryPath();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    let raw = '';
    try {
      if (fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8');
    } catch (_) {}
    if (!raw.trim()) raw = '# MEMORY.md\n\n';

    const archiveHint = archivePath
      ? `- 完整归档: \`${archivePath}\`（需要更多细节时用 read 工具读取，不要整文件贴进回复）\n`
      : '';
    const sectionBody =
      `- 更新: ${new Date().toISOString()}\n` +
      `- 说明: 上一会话因上下文过长已归档；续聊请优先参考本节；缺细节再 read 归档文件。勿向用户提及换会话或失忆。\n` +
      archiveHint +
      `${body || '(见归档文件)'}`;

    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const title = [];
    const sections = [];
    let cur = null;
    for (const line of lines) {
      if (/^#\s+/.test(line) && title.length === 0 && sections.length === 0 && !cur) {
        title.push(line);
        continue;
      }
      if (/^##\s+/.test(line)) {
        if (cur) sections.push(cur);
        cur = { heading: line.trim(), lines: [] };
        continue;
      }
      if (cur) cur.lines.push(line);
      else title.push(line);
    }
    if (cur) sections.push(cur);

    const kept = sections.filter(
      (s) => !/^##\s+Active session context\b/i.test(s.heading)
    );
    const active = {
      heading: ACTIVE_CONTEXT_HEADING,
      lines: sectionBody.split('\n'),
    };
    const ordered = [active, ...kept];

    let next = (title.join('\n').trim() || '# MEMORY.md') + '\n\n';
    next += ordered
      .map((s) => [s.heading, ...s.lines].join('\n').replace(/\n+$/, '') + '\n')
      .join('\n');

    const MAX_MEMORY = 2400; // 对齐 bootstrapMaxChars≈2500，避免 Active 段被截到中间丢失
    if (next.length > MAX_MEMORY) {
      let head = (title.join('\n').trim() || '# MEMORY.md') + '\n\n';
      head += [active.heading, ...active.lines].join('\n').replace(/\n+$/, '') + '\n\n';
      let rest = kept
        .map((s) => [s.heading, ...s.lines].join('\n').replace(/\n+$/, '') + '\n')
        .join('\n');
      const budget = Math.max(0, MAX_MEMORY - head.length - 40);
      if (rest.length > budget) {
        // 截断前先把完整内容归档：本处 2400 就截，而 memory-rotate 到 4500 才归档，
        // 中间这段若直接丢弃就是永久记忆丢失。归档到 workspace/memory 后再截。
        try {
          const memDir = path.join(stateDir(), 'workspace', 'memory');
          fs.mkdirSync(memDir, { recursive: true });
          const arch = path.join(memDir, `MEMORY-ROLLOVER-ARCHIVE-${Date.now()}.md`);
          fs.writeFileSync(arch, head + rest, 'utf8');
          rest = rest.slice(0, budget) + `\n\n<!-- 截断内容已归档至 ${arch} -->\n`;
        } catch (_) {
          rest = rest.slice(0, budget) + '\n\n<!-- truncated after rollover continuity upsert -->\n';
        }
      }
      next = head + rest;
    }
    // 原子写：MEMORY.md 是长期记忆的根，绝不能因写一半崩溃而损坏
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, file);
    console.log(`[${PLUGIN_ID}] upserted ${ACTIVE_CONTEXT_HEADING} (${body.length} chars, archive=${archivePath || 'none'})`);
    return true;
  } catch (e) {
    console.warn(`[${PLUGIN_ID}] MEMORY.md upsert failed:`, e && e.message);
    return false;
  }
}

function appendDailyContinuityNote(sessionKey, summary, lastUserText, archivePath) {
  try {
    const file = workspaceDailyMemoryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const block = [
      ``,
      `## Session rollover ${new Date().toISOString()}`,
      `- sessionKey: ${sessionKey || ''}`,
      archivePath ? `- archive: ${archivePath}` : '',
      ``,
      summary || '(无摘要)',
      ``,
      lastUserText ? `待续问: ${String(lastUserText).slice(0, 300)}` : '',
      ``,
    ]
      .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
      .join('\n');
    fs.appendFileSync(file, block, 'utf8');
    return file;
  } catch (e) {
    console.warn(`[${PLUGIN_ID}] daily continuity note failed:`, e && e.message);
    return '';
  }
}

function persistContinuityBeforeReset(sessionKey, lastUserText, sessionFile) {
  const file = sessionFile || resolveSessionFileByKey(sessionKey);
  const archivePath = writeReadableSessionArchive(file, sessionKey, lastUserText);
  const summary = buildContinuitySummary(file, lastUserText);
  if (!summary && !archivePath) {
    console.log(`[${PLUGIN_ID}] continuity summary empty key=${sessionKey}`);
    return { summary: '', memoryOk: false, daily: '', archivePath: '' };
  }
  const memoryOk = upsertActiveSessionContext(summary || '见 memory/last-session-archive.md', archivePath);
  const daily = appendDailyContinuityNote(sessionKey, summary, lastUserText, archivePath);
  return { summary, memoryOk, daily, sessionFile: file, archivePath };
}

function writeArchiveNote(sessionKey, lastUserText, continuitySummary, archivePath) {
  try {
    const dir = path.join(stateDir(), ARCHIVE_NOTE_DIR_REL);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeKey = String(sessionKey || 'session').replace(/[^\w.-]+/g, '_').slice(0, 80);
    const file = path.join(dir, `rollover_${safeKey}_${stamp}.md`);
    const body = [
      `# 会话自动归档`,
      ``,
      `- 时间: ${new Date().toISOString()}`,
      `- sessionKey: ${sessionKey}`,
      `- 原因: 上下文溢出 / 自动压缩失败 / 角色顺序冲突`,
      archivePath ? `- 可读归档: ${archivePath}` : '',
      ``,
      `## 延续摘要`,
      ``,
      continuitySummary || '(无)',
      ``,
      `## 待续问`,
      ``,
      lastUserText || '(无)',
      ``,
    ].join('\n');
    fs.writeFileSync(file, body, 'utf8');
    return file;
  } catch (_) {
    return '';
  }
}

function buildContinuePrompt(lastUserText, continuitySummary, archivePath) {
  const q = unwrapUserQuestion(lastUserText);
  if (!q || isNoiseUserText(q)) return '';
  const summary = String(continuitySummary || '').trim();
  const arch = String(archivePath || '').trim() || 'memory/last-session-archive.md';
  if (!summary && !archivePath) return q;
  let clipped = summary;
  if (clipped.length > CONTINUITY_PROMPT_MAX) clipped = clipped.slice(0, CONTINUITY_PROMPT_MAX - 1) + '…';
  return [
    '[内部延续上下文] 此前长对话已归档。短摘要如下；若回答需要更多历史细节，请先 read `' +
      arch +
      '` 再作答。不要提及换会话、归档或失忆。',
    clipped || '(详见归档文件)',
    '',
    '用户问题：',
    q,
  ].join('\n');
}

/** 角色口吻（讲 overflow 机制等）——禁止当系统恢复横幅 */
function looksLikeConversationalOutbound(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/(启禀|主子|小的|奴才|臣妾|回主|建议|推荐|方案|双剑)/.test(t)) return true;
  const cn = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return cn >= 48 && t.length >= 160;
}

/** 机器横幅硬特征：命中即恢复文案，无需其它佐证 */
function overflowHardMachineMatch(t) {
  return (
    /compaction[-_ ]?diag/i.test(t) ||
    /diagId\s*=\s*ovf-/i.test(t) ||
    /trigger\s*=\s*overflow/i.test(t) ||
    /\[agent\/embedded\].*(overflow|compaction)/i.test(t) ||
    /reserveTokensFloor/i.test(t) ||
    /Auto-compaction could not recover/i.test(t) ||
    /auto-compaction failed/i.test(t) ||
    /Context is too large and auto-compaction/i.test(t) ||
    /Context limit exceeded/i.test(t) ||
    /prompt too large for the model/i.test(t) ||
    /Compaction timed out/i.test(t) ||
    /compaction timeout/i.test(t) ||
    /Message ordering conflict/i.test(t) ||
    /roles must alternate/i.test(t) ||
    /incorrect role information/i.test(t) ||
    /Session history looks corrupted/i.test(t) ||
    /rejected the conversation state/i.test(t) ||
    /increase your compaction buffer/i.test(t)
  );
}

/** ⚠ 前缀 / 明确 /new /compact 指令——机器横幅标记，不受「角色口吻」豁免 */
function overflowMachineMarked(t) {
  return (
    /^\s*(?:⚠️|⚠)/.test(t) ||
    /use \/(new|compact)\b/i.test(t) ||
    /\/new to start/i.test(t) ||
    /请(?:先)?(?:使用|发送)\s*\/new\b/.test(t)
  );
}

/**
 * OpenClaw 在溢出 / 压缩失败 / 角色奇偶冲突时都会吐出「use /new」类恢复文案。
 * 这些文案若只被 error-filter 静默拦截、却不归档换新，通讯渠道就会哑火。
 * 注意：助手长文解释「上下文溢出机制」不得匹配。
 */
function isOverflowRecoveryText(text) {
  const t = String(text || '');
  if (!t) return false;

  if (overflowHardMachineMatch(t)) return true;

  const machineMarked = overflowMachineMarked(t);
  const softBanner =
    machineMarked ||
    /Context overflow/i.test(t) ||
    /context[_\s-]?overflow/i.test(t) ||
    // 禁止裸匹配 "use /new"：助手闲聊提到 /new 会误触发 rollover
    /(?:⚠️|⚠|Context overflow|compaction|overflow|请(?:先)?使用)\s*[^\n]{0,80}\/new\b/i.test(t) ||
    /上下文过长|上下文溢出|自动压缩失败|角色(顺序|奇偶)|消息顺序冲突/i.test(t);

  if (!softBanner) return false;
  // 长角色解释里夹带「上下文溢出」——不是恢复横幅。
  // 但带 ⚠/明确 /new 指令的机器横幅不享受豁免（否则夹个「建议」二字就漏拦）
  if (!machineMarked && looksLikeConversationalOutbound(t)) return false;
  return machineMarked || t.length <= 400;
}

/** 仅凭中文/软文案命中（无任何机器特征）：调用方需再用会话预算压力佐证，
 *  防止把正常聊天（如用户讨论「上下文溢出」概念）当横幅取消并重置会话 */
function isSoftOverflowBannerOnly(text) {
  const t = String(text || '');
  if (!t || !isOverflowRecoveryText(t)) return false;
  return !overflowHardMachineMatch(t) && !overflowMachineMarked(t);
}

const RATE_LIMIT_USER_NOTICE = '模型暂时繁忙或限流，请稍后再发一条。';
/** 溢出横幅出现但恢复排不上（冷却中等）时的替代提示——宁可提示也绝不静默 */
const OVERFLOW_RETRY_USER_NOTICE = '刚才的对话有点长，我整理了一下记忆，请把刚才的问题再发一遍～';
const NETWORK_FAILURE_USER_NOTICE =
  '模型服务暂时不可用（中转连接失败）。请稍后重试，或在设置里确认备用模型为公网通道。';

function isSubstituteUserNotice(text) {
  const raw = String(text || '').trim();
  return (
    raw === RATE_LIMIT_USER_NOTICE ||
    raw === NETWORK_FAILURE_USER_NOTICE ||
    raw === OVERFLOW_RETRY_USER_NOTICE
  );
}

function isRateLimitBannerText(text) {
  const t = String(text || '');
  if (!t) return false;
  if (t.trim() === RATE_LIMIT_USER_NOTICE) return false;
  if (isOverflowRecoveryText(t)) return false;
  const hit =
    /All models are temporarily rate-limited/i.test(t) ||
    /temporarily rate-limited/i.test(t) ||
    /API rate limit reached/i.test(t) ||
    /Rate-limited\s*[—\-]/i.test(t) ||
    /temporarily overloaded/i.test(t) ||
    (/Please try again in a few minutes/i.test(t) && t.length <= 280);
  if (!hit) return false;
  if (looksLikeConversationalOutbound(t)) return false;
  return true;
}

function isUserFacingSystemErrorText(text) {
  return isOverflowRecoveryText(text) || isRateLimitBannerText(text);
}

function looksLikeOverflowFailure(event, ctx) {
  // 只扫当前回合错误字段，禁止 JSON.stringify 整包 event/messages：
  // 历史里残留的 "use /new" / overflow 文案会让后续成功回合误触发 rollover → 问一句回两句。
  const parts = [];
  const push = (v) => {
    if (v == null) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(String(v));
      return;
    }
  };
  if (event) {
    for (const k of ['error', 'rawError', 'message', 'reason', 'detail', 'errorMessage', 'note', 'status', 'outcome']) {
      push(event[k]);
    }
    if (event.data && typeof event.data === 'object') {
      for (const k of ['error', 'rawError', 'message', 'kind', 'reason', 'outcome', 'trigger']) {
        push(event.data[k]);
      }
    }
    push(event.kind);
  }
  if (ctx) {
    push(ctx.error);
    push(ctx.reason);
    push(ctx.outcome);
  }
  const blob = parts.join('\n');
  if (!blob.trim()) return false;
  // 硬溢出/角色冲突特征（不要单靠 "use /new"：失败文案里偶尔夹带会误伤）
  if (/context_overflow|compaction_failure|compaction.?timeout|compaction[-_ ]?diag|overflow recovery|trigger\s*=\s*overflow|diagId\s*=\s*ovf-|Context overflow|Context is too large|prompt too large|Context limit exceeded|Auto-compaction could not recover|roles must alternate|Message ordering conflict|incorrect role information|rejected the conversation state|Session history looks corrupted/i.test(blob)) {
    return true;
  }
  if (event && event.success === false && /overflow|compaction|too large|precheck|roles must alternate|ordering conflict|role information/i.test(blob)) {
    return true;
  }
  return false;
}

function markUserFacingDelivery(sessionKey, text) {
  const key = String(sessionKey || '').trim();
  const raw = String(text || '').trim();
  if (!key || !raw) return;
  if (isUserFacingSystemErrorText(raw)) return;
  // 限流/断连短提示不算「实质回复」，勿挡住后续 overflow rollover
  if (isSubstituteUserNotice(raw)) return;
  if (/^NO_REPLY$/i.test(raw)) return;
  if (raw.length < 8 && !/MEDIA\s*:/i.test(raw)) return;
  recentUserFacingDeliveryAt.set(key, Date.now());
}

function sessionRecentlyDelivered(sessionKey) {
  const key = String(sessionKey || '').trim();
  if (!key) return false;
  const at = recentUserFacingDeliveryAt.get(key) || 0;
  return at && Date.now() - at < DELIVERY_BLOCK_RESUME_MS;
}

function rememberUserText(sessionKey, text) {
  if (!sessionKey || !text) return;
  if (isNoiseUserText(text)) return;
  lastUserBySession.set(sessionKey, { text: unwrapUserQuestion(text), at: Date.now() });
}

function pickLastUserText(sessionKey, event, ctx) {
  const cached = lastUserBySession.get(sessionKey);
  if (cached && cached.text) return cached.text;
  const file = resolveSessionFile(event, ctx) || resolveSessionFileByKey(sessionKey);
  return readLastUserTextFromSessionFile(file);
}

function readLastUserTextFromSessionFile(sessionFile) {
  try {
    if (!sessionFile || !fs.existsSync(sessionFile)) return '';
    const lines = fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const msg = obj && obj.message;
        if (!msg || msg.role !== 'user') continue;
        const text = extractText(msg);
        if (text && !isNoiseUserText(text)) return unwrapUserQuestion(text);
      } catch (_) {}
    }
  } catch (_) {}
  return '';
}

async function gatewayRequest(api, method, params) {
  const gw = api && api.runtime && api.runtime.gateway;
  if (!gw || typeof gw.request !== 'function') {
    throw new Error('api.runtime.gateway.request unavailable');
  }
  return gw.request(method, params);
}

async function performRollover(api, sessionKey, lastUserText, via, opts = {}) {
  if (!sessionKey) return false;
  if (inFlight.has(sessionKey)) return false;
  const now = Date.now();
  const prev = lastRolloverAt.get(sessionKey) || 0;
  if (now - prev < COOLDOWN_MS) {
    console.log(`[${PLUGIN_ID}] skip rollover (cooldown) key=${sessionKey} via=${via}`);
    return false;
  }

  // 已对用户发过实质内容：禁止 reset+resume（否则先清空会话再重跑 = 双倍 token）
  // 预防式换会话（opts.ignoreDelivered）例外：它本来就挑在回复完成后的空闲窗口跑，且不重跑
  // 拦截型（opts.intercepted，调用方已取消了用户可见消息）也例外：调度时已做过投递窗检查，
  // 这 80ms 里若有尾随媒体投递把窗口标上，再跳过就等于把已取消的横幅永远吞掉
  // 注意：这里绝不能写 lastRolloverAt（冷却戳）——否则 10 秒投递窗后用户新问题真溢出时
  // 会被冷却挡掉恢复，出现「API 通但就是不回话」的静默（投递窗本身已足够防风暴）
  if (!opts.ignoreDelivered && !opts.intercepted && sessionRecentlyDelivered(sessionKey)) {
    console.log(
      `[${PLUGIN_ID}] skip rollover entirely (already delivered, no reset) key=${sessionKey} via=${via}`
    );
    return false;
  }

  // 与 session-tool-heal 协调：若它刚就地修好了这个会话（角色/工具配对错误），
  // 就别再 reset 把修好的会话清掉——预防式换会话(ignoreDelivered)除外，那是主动换新不是抢修。
  if (!opts.ignoreDelivered && healRecentlyRepaired(sessionKey)) {
    console.log(`[${PLUGIN_ID}] skip rollover (session-tool-heal just repaired in place) key=${sessionKey} via=${via}`);
    return false;
  }

  inFlight.set(sessionKey, { resume: !opts.noResume });
  let resetDone = false;
  let deliveryRoute = null;
  let continuity = { summary: '', archivePath: '' };
  try {
    // 重置前：抽摘要 + 记下渠道投递路由（reset 会保留 lastChannel，但显式 originating 更稳）
    deliveryRoute = readSessionDeliveryRoute(sessionKey);
    continuity = persistContinuityBeforeReset(sessionKey, lastUserText);
    const note = writeArchiveNote(
      sessionKey,
      lastUserText,
      continuity.summary,
      continuity.archivePath
    );
    console.log(
      `[${PLUGIN_ID}] rollover start via=${via} key=${sessionKey}` +
        (note ? ` note=${note}` : '') +
        ` lastUserChars=${(lastUserText || '').length}` +
        ` continuityChars=${(continuity.summary || '').length}` +
        ` memoryOk=${Boolean(continuity.memoryOk)}` +
        ` archive=${continuity.archivePath || 'none'}` +
        ` route=${deliveryRoute ? `${deliveryRoute.channel}->${deliveryRoute.to}` : 'none'}`
    );

    // 预防式（无待答问题）：reset 前最后一刻再确认会话空闲。
    // 定时器检查到这里之间用户可能刚发来消息——此时 reset 会打断进行中的回合导致不回话。
    if (opts.noResume) {
      const p = readSessionContextPressure(sessionKey);
      if (p && p.status && p.status !== 'done') {
        console.log(`[${PLUGIN_ID}] abort proactive rollover (turn in progress) key=${sessionKey}`);
        return false;
      }
    }

    await gatewayRequest(api, 'sessions.reset', {
      key: sessionKey,
      reason: 'new',
    });
    resetDone = true;

    const continueText = opts.noResume
      ? ''
      : buildContinuePrompt(lastUserText, continuity.summary, continuity.archivePath);
    if (!continueText) {
      lastRolloverAt.set(sessionKey, Date.now());
      // 没有补发续聊 prompt：挂起延续上下文，等该会话下一条消息时注入 prompt，
      // 保证换新会话后第一句回复就带着之前的上下文和待办
      writePendingContinuity(sessionKey, continuity, lastUserText);
      // 拦截型：调用方已取消了用户可见消息，但最后用户消息是噪音/已丢失导致无法续答——
      // 必须给用户一条提示收尾，绝不能静默
      if (opts.intercepted) {
        try {
          await gatewayRequest(
            api,
            'chat.send',
            buildChatSendParams(sessionKey, OVERFLOW_RETRY_USER_NOTICE, deliveryRoute)
          );
          console.log(`[${PLUGIN_ID}] sent retry notice (no resumable question) key=${sessionKey}`);
        } catch (eNotice) {
          console.error(`[${PLUGIN_ID}] retry notice send failed:`, eNotice && eNotice.message);
        }
      }
      console.log(`[${PLUGIN_ID}] rollover archived without resume (empty last user) key=${sessionKey}`);
      return true;
    }

    if (!deliveryRoute) {
      console.error(
        `[${PLUGIN_ID}] rollover WARNING: no originating route for key=${sessionKey} — ` +
          'chat.send may land on internal webchat (WeChat silent). Capture route on next inbound.'
      );
    }

    // deliver:true + 显式 originating*：覆盖微信 dmScope=main（仅 deliver 会掉进内部通道）
    // 失败重试一次（不带 originating*，路由字段异常时仍能走默认投递）；仍失败则抛给外层兜底
    try {
      await gatewayRequest(api, 'chat.send', buildChatSendParams(sessionKey, continueText, deliveryRoute));
    } catch (eSend) {
      console.warn(
        `[${PLUGIN_ID}] chat.send failed, retrying without originating route:`,
        eSend && eSend.message
      );
      await gatewayRequest(api, 'chat.send', buildChatSendParams(sessionKey, continueText, null));
    }

    lastRolloverAt.set(sessionKey, Date.now());
    console.log(
      `[${PLUGIN_ID}] rollover done key=${sessionKey} deliver=true` +
        ` continuity=${Boolean(continuity.summary)}` +
        ` explicitRoute=${Boolean(deliveryRoute)}`
    );
    try {
      api.logger?.info?.(`[${PLUGIN_ID}] archived & resumed with continuity: ${sessionKey}`);
    } catch (_) {}
    return true;
  } catch (e) {
    lastRolloverAt.delete(sessionKey);
    console.error(`[${PLUGIN_ID}] rollover failed:`, e && e.message ? e.message : e);
    if (!resetDone) {
      // reset 本身失败：会话还是旧的溢出状态，走文件系统应急清理
      try {
        filesystemEmergencyReset(sessionKey, lastUserText);
      } catch (_) {}
    } else {
      // reset 已成功、补发失败：新会话已就位，绝不能再清转录/重算归档
      //（重算会用空的新会话覆盖掉刚写好的归档）。挂起 reset 前算好的延续上下文，
      // 并尽力给用户一条提示——这一问绝不能静默丢失
      try {
        writePendingContinuity(sessionKey, continuity, lastUserText);
      } catch (_) {}
      try {
        await gatewayRequest(
          api,
          'chat.send',
          buildChatSendParams(sessionKey, OVERFLOW_RETRY_USER_NOTICE, deliveryRoute)
        );
        console.log(`[${PLUGIN_ID}] sent retry notice after resume failure key=${sessionKey}`);
      } catch (eNotice) {
        console.error(`[${PLUGIN_ID}] retry notice send failed:`, eNotice && eNotice.message);
      }
    }
    return false;
  } finally {
    inFlight.delete(sessionKey);
  }
}

function filesystemEmergencyReset(sessionKey, lastUserText) {
  try {
    // 清空前尽量落盘延续摘要，并挂起等下一条消息注入
    try {
      const continuity = persistContinuityBeforeReset(sessionKey, lastUserText);
      writePendingContinuity(sessionKey, continuity, lastUserText);
    } catch (_) {}
    const storePath = path.join(stateDir(), 'agents', 'main', 'sessions', 'sessions.json');
    if (!fs.existsSync(storePath)) return false;
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8').replace(/^\uFEFF/, ''));
    const entry = store && store[sessionKey];
    const sid = entry && entry.sessionId;
    if (!sid) return false;
    const file = path.join(stateDir(), 'agents', 'main', 'sessions', `${sid}.jsonl`);
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, `${file}.bak-emergency-${Date.now()}`);
      } catch (_) {}
      fs.writeFileSync(file, '', 'utf8');
    }
    if (entry && typeof entry === 'object') {
      for (const k of Object.keys(entry)) {
        if (/estimated|overflow|compaction|totalTokens|inputTokens|promptTokens|contextTokens/i.test(k)) {
          delete entry[k];
        }
      }
      // 原子写 sessions.json：先写同目录临时文件再 rename，避免崩溃时写坏整个会话库（defect 1c）
      try {
        const tmp = `${storePath}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
        fs.renameSync(tmp, storePath);
      } catch (_) {}
    }
    writeArchiveNote(sessionKey, lastUserText, '');
    console.log(`[${PLUGIN_ID}] filesystem emergency reset key=${sessionKey} sid=${sid}`);
    return true;
  } catch (e) {
    console.warn(`[${PLUGIN_ID}] filesystem emergency reset failed:`, e && e.message);
    return false;
  }
}

/**
 * 排一次 rollover。返回值 = 「恢复是否已排上/正在进行」。
 * 调用方要拦截用户可见消息时必须看返回值：false 表示不会有任何补救跑起来，
 * 此时绝不能把消息静默吞掉（否则就是「API 通但不回话」）。
 */
function scheduleRollover(api, sessionKey, lastUserText, via, opts = {}) {
  if (!sessionKey) return false;
  if (sessionRecentlyDelivered(sessionKey)) {
    console.log(`[${PLUGIN_ID}] skip duplicate rollover schedule (already delivered) key=${sessionKey} via=${via}`);
    return false;
  }
  const timerKey = `rollover:${sessionKey}`;
  if (pendingScheduleTimers.has(timerKey)) {
    // 已有带续答的恢复排队中——对调用方而言恢复是有着落的
    console.log(`[${PLUGIN_ID}] skip duplicate rollover schedule key=${sessionKey} via=${via}`);
    return true;
  }
  const running = inFlight.get(sessionKey);
  if (running) {
    // 只有「带续答」的在跑恢复才算有着落；正在跑的是预防式（无续答）时，
    // 它不会替用户补任何回答——如实返回 false，让调用方改写提示而不是取消消息
    console.log(
      `[${PLUGIN_ID}] rollover already in flight (resume=${Boolean(running.resume)}) key=${sessionKey} via=${via}`
    );
    return running.resume === true;
  }
  // 冷却期内 performRollover 必然跳过；提前如实告知调用方，别让它白白取消消息
  if (Date.now() - (lastRolloverAt.get(sessionKey) || 0) < COOLDOWN_MS) {
    console.log(`[${PLUGIN_ID}] rollover in cooldown, cannot schedule key=${sessionKey} via=${via}`);
    return false;
  }
  const timer = setTimeout(() => {
    pendingScheduleTimers.delete(timerKey);
    performRollover(api, sessionKey, lastUserText, via, {
      intercepted: opts.intercepted === true,
    }).catch(() => {});
  }, 80);
  pendingScheduleTimers.set(timerKey, timer);
  return true;
}

/**
 * 预防式换会话：成功回合结束后检查会话预算，吃紧则在空闲窗口静默归档换新。
 * 不重跑、不补发——用户完全无感，下一条消息自然落进带延续记忆的新会话。
 */
function maybeScheduleProactiveRollover(api, event, ctx) {
  try {
    // 该路径会触发 sessions.reset（清空会话）——只认真实 sessionKey，绝不用「最近会话」兜底，
    // 否则会误清另一个无辜联系人的上下文（defect 1a）
    const key = resolveSessionKey(event, ctx);
    if (!key || /:cron:|:heartbeat:/i.test(key)) return;
    const reason = sessionUnderContextPressure(key);
    if (!reason) return;
    const now = Date.now();
    if (now - (lastRolloverAt.get(key) || 0) < COOLDOWN_MS) return;
    const timerKey = `proactive:${key}`;
    if (pendingScheduleTimers.has(timerKey) || inFlight.has(key)) return;
    const scheduledAt = now;
    console.log(`[${PLUGIN_ID}] proactive rollover scheduled key=${key} (${reason})`);
    const timer = setTimeout(() => {
      pendingScheduleTimers.delete(timerKey);
      try {
        // 延迟窗口内又开始了新回合：放弃本次，等下一个空闲窗口再触发
        const p = readSessionContextPressure(key);
        if (p && p.status && p.status !== 'done') return;
        if (p && p.updatedAt && p.updatedAt > scheduledAt + 1500) return;
      } catch (_) {}
      performRollover(api, key, '', 'proactive-pressure', {
        ignoreDelivered: true,
        noResume: true,
      }).catch(() => {});
    }, PROACTIVE_DELAY_MS);
    pendingScheduleTimers.set(timerKey, timer);
  } catch (_) {}
}

function consumeMainProcessTrigger() {
  const file = path.join(stateDir(), TRIGGER_FILE);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    try {
      fs.unlinkSync(file);
    } catch (_) {}
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const at = Number(obj.at) || 0;
    if (at && Date.now() - at > 120_000) return null;
    return {
      sessionKey: typeof obj.sessionKey === 'string' ? obj.sessionKey.trim() : '',
      reason: typeof obj.reason === 'string' ? obj.reason : 'main-trigger',
    };
  } catch (_) {
    try {
      fs.unlinkSync(file);
    } catch (__) {}
    return null;
  }
}

/** 消费 per-session 触发文件（overflow-rollover.<key>.trigger.json）。
 *  producer 改为按会话写独立文件，避免两个会话同秒溢出时固定文件互相覆盖丢触发（defect 2）。 */
function consumePerSessionTriggers() {
  const out = [];
  try {
    const dir = stateDir();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      return out;
    }
    for (const n of names) {
      // 固定旧文件（overflow-rollover.trigger.json）由 consumeMainProcessTrigger 处理，这里排除
      if (n === TRIGGER_FILE) continue;
      if (!/^overflow-rollover\..+\.trigger\.json$/.test(n)) continue;
      const file = path.join(dir, n);
      try {
        const raw = fs.readFileSync(file, 'utf8');
        try {
          fs.unlinkSync(file);
        } catch (_) {}
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') continue;
        const at = Number(obj.at) || 0;
        if (at && Date.now() - at > 120_000) continue;
        out.push({
          sessionKey: typeof obj.sessionKey === 'string' ? obj.sessionKey.trim() : '',
          reason: typeof obj.reason === 'string' ? obj.reason : 'main-trigger',
        });
      } catch (_) {
        try {
          fs.unlinkSync(file);
        } catch (__) {}
      }
    }
  } catch (_) {}
  return out;
}

/** 轻量周期清理：丢弃 ~10 分钟前的 Map 条目，防止无界增长（defect 1d）。节流为最多每 60s 一次。 */
function pruneStaleState(now = Date.now()) {
  if (now - lastPruneAt < 60_000) return;
  lastPruneAt = now;
  try {
    for (const [k, v] of lastUserBySession) {
      if (!v || now - (v.at || 0) > STATE_MAX_AGE_MS) lastUserBySession.delete(k);
    }
    // 路由缓存必须活满 30 分钟（readSessionDeliveryRoute 的有效期）——
    // 10 分钟就清会让「用户闲置后溢出」的续答丢路由落到内部 webchat，微信端静默
    const ROUTE_TTL_MS = 30 * 60_000;
    for (const [k, v] of lastDeliveryRouteBySession) {
      if (!v || now - (v.at || 0) > ROUTE_TTL_MS) lastDeliveryRouteBySession.delete(k);
    }
    for (const [k, at] of lastRolloverAt) {
      if (now - (Number(at) || 0) > STATE_MAX_AGE_MS) lastRolloverAt.delete(k);
    }
    for (const [k, at] of recentUserFacingDeliveryAt) {
      if (now - (Number(at) || 0) > STATE_MAX_AGE_MS) recentUserFacingDeliveryAt.delete(k);
    }
  } catch (_) {}
}

function pollMainProcessTrigger(api) {
  try {
    pruneStaleState();
    const hits = [];
    const fixed = consumeMainProcessTrigger();
    if (fixed) hits.push(fixed);
    for (const h of consumePerSessionTriggers()) hits.push(h);
    for (const hit of hits) {
      // reset 路径：触发文件不带真实 sessionKey 时直接跳过，绝不用「最近会话」兜底清错人（defect 1a）
      const key = hit.sessionKey;
      if (!key || /:cron:|:heartbeat:/i.test(key)) {
        if (!key) console.warn(`[${PLUGIN_ID}] main-process trigger without sessionKey — skip (no fallback)`);
        continue;
      }
      const lastUser = pickLastUserText(key, {}, {});
      console.log(`[${PLUGIN_ID}] main-process trigger key=${key} reason=${hit.reason}`);
      scheduleRollover(api, key, lastUser, 'main-log-trigger');
    }
  } catch (e) {
    console.warn(`[${PLUGIN_ID}] trigger poll error:`, e && e.message);
  }
}

/** 清理轮询定时器与挂起的调度定时器（defect 1b：避免 setInterval 泄漏） */
function shutdownPlugin() {
  try {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch (_) {}
  try {
    for (const [k, t] of pendingScheduleTimers) {
      try {
        clearTimeout(t);
      } catch (_) {}
      pendingScheduleTimers.delete(k);
    }
  } catch (_) {}
}

function register(api) {
  try {
    api.logger?.info?.(`[${PLUGIN_ID}] loaded`);
  } catch (_) {}
  console.log(`[${PLUGIN_ID}] loaded (overflow/ordering → archive+resume deliver; rate-limit → user notice; log-bridge)`);

  // 主进程日志桥：compaction-diag 只出现在 stdout 时也能静默续聊
  // 存句柄，shutdown 时 clearInterval，避免定时器泄漏（defect 1b）
  try {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => pollMainProcessTrigger(api), 1000);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  } catch (_) {}

  // shutdown 钩子：清掉轮询定时器与所有挂起的调度定时器
  try {
    api.on('shutdown', () => shutdownPlugin());
  } catch (_) {}
  try {
    api.on('plugin_unload', () => shutdownPlugin());
  } catch (_) {}

  // 换会话后的第一轮：把挂起的延续上下文注入 prompt（随转录永久留在新会话历史里）
  try {
    api.on('before_prompt_build', async (event, ctx) => {
      try {
        const key = resolveSessionKey(event, ctx);
        if (!key) return;
        // 心跳/定时任务回合不消费：延续上下文要留给用户的下一条真实消息
        const trig = String((ctx && ctx.trigger) || (event && event.trigger) || '');
        if (/heartbeat|cron/i.test(trig)) return;
        const pending = consumePendingContinuity(key);
        if (!pending) return;
        console.log(`[${PLUGIN_ID}] inject pending continuity into new session key=${key}`);
        return { prependContext: buildPendingInjectionBlock(pending) };
      } catch (e) {
        console.warn(`[${PLUGIN_ID}] before_prompt_build error:`, e && e.message);
      }
    });
  } catch (_) {}

  try {
    api.on('message_received', async (event, ctx) => {
      try {
        const key = resolveSessionKey(event, ctx);
        const text = extractText(event);
        if (key && text) rememberUserText(key, text);
        if (key) rememberDeliveryRoute(key, event, ctx);
      } catch (_) {}
    });
  } catch (_) {}

  try {
    api.on('before_dispatch', async (event, ctx) => {
      try {
        const key = resolveSessionKey(event, ctx);
        const text = extractText(event);
        if (key && text) rememberUserText(key, text);
        if (key) rememberDeliveryRoute(key, event, ctx);
      } catch (_) {}
    });
  } catch (_) {}

  api.on('agent_end', async (event, ctx) => {
    try {
      // 成功回合绝不因历史残留文案触发换新；失败且像溢出/角色冲突才 rollover
      if (event && event.success !== false) {
        // 成功回合只做预算体检：吃紧就预防式换会话，绝不让用户撞上真溢出
        maybeScheduleProactiveRollover(api, event, ctx);
        return;
      }
      if (!looksLikeOverflowFailure(event, ctx)) return;
      // reset 路径：只认真实 sessionKey，禁止「最近会话」兜底以免清错人（defect 1a）
      const key = resolveSessionKey(event, ctx);
      if (!key) {
        console.warn(`[${PLUGIN_ID}] agent_end overflow without sessionKey — skip rollover (no fallback)`);
        return;
      }
      if (sessionRecentlyDelivered(key)) {
        console.log(`[${PLUGIN_ID}] skip agent_end rollover (already delivered) key=${key}`);
        return;
      }
      const lastUser = pickLastUserText(key, event, ctx);
      scheduleRollover(api, key, lastUser, 'agent_end');
    } catch (e) {
      console.warn(`[${PLUGIN_ID}] agent_end error:`, e && e.message);
    }
  });

  try {
    api.on('llm_output', async (event, ctx) => {
      try {
        // 只认「输出正文本身」是溢出恢复横幅；禁止扫 event 其它字段误触发
        const text = extractText(event) || extractText(event && event.payload);
        if (!isOverflowRecoveryText(text)) return;
        // reset 路径：只认真实 sessionKey，禁止「最近会话」兜底以免清错人（defect 1a）
        const key = resolveSessionKey(event, ctx);
        if (!key) return;
        if (sessionRecentlyDelivered(key)) {
          console.log(`[${PLUGIN_ID}] skip llm_output rollover (already delivered) key=${key}`);
          return;
        }
        const lastUser = pickLastUserText(key, event, ctx);
        // 该横幅稍后会被本插件的 message_sending 钩子取消——按拦截型对待，保证必有下文
        scheduleRollover(api, key, lastUser, 'llm_output', { intercepted: true });
      } catch (_) {}
    });
  } catch (_) {}

  api.on('message_sending', async (event, ctx) => {
    try {
      const text = extractText(event);
      // markUserFacingDelivery / scheduleRollover 都会按 key 操作会话，只认真实 sessionKey，
      // 绝不用「最近会话」兜底，否则可能标错/清错另一个联系人的会话（defect 1a）
      const key = resolveSessionKey(event, ctx);
      // 模型在预算吃紧时自己劝用户「开新会话」——按溢出横幅处理，不算实质回复
      const newSessionAsk =
        !isUserFacingSystemErrorText(text) &&
        asksUserToStartNewSession(text) &&
        Boolean(key) &&
        Boolean(sessionUnderContextPressure(key));
      if (key && text && !newSessionAsk) markUserFacingDelivery(key, text);
      if (!isUserFacingSystemErrorText(text) && !newSessionAsk) return;
      const lastUser = key ? pickLastUserText(key, event, ctx) : '';
      if (newSessionAsk) {
        // 只有恢复真的排上了才敢拦；排不上就放行原话——难看但绝不静默
        if (scheduleRollover(api, key, lastUser, 'message_sending:new-session-ask', { intercepted: true })) {
          console.log(`[${PLUGIN_ID}] cancel model new-session ask (context pressure) key=${key}`);
          return {
            cancel: true,
            cancelReason: 'session-overflow-rollover:suppress-new-session-ask',
          };
        }
        console.warn(`[${PLUGIN_ID}] new-session ask NOT cancelled (no recovery available) key=${key}`);
        return;
      }
      if (isOverflowRecoveryText(text)) {
        // 仅软文案命中且会话预算并不吃紧：大概率是正常聊天内容，放行（防误取消+误重置）
        if (isSoftOverflowBannerOnly(text) && !(key && sessionUnderContextPressure(key))) {
          console.log(`[${PLUGIN_ID}] soft banner without pressure — pass through key=${key || '(none)'}`);
          return;
        }
        // 已有实质回复：只拦横幅，绝不 reset/重跑
        if (key && sessionRecentlyDelivered(key)) {
          console.log(`[${PLUGIN_ID}] cancel overflow banner only (already delivered) key=${key}`);
          return {
            cancel: true,
            cancelReason: 'session-overflow-rollover:suppress-overflow-banner-after-delivery',
          };
        }
        if (key) {
          if (scheduleRollover(api, key, lastUser, 'message_sending', { intercepted: true })) {
            console.log(`[${PLUGIN_ID}] cancel overflow/ordering recovery banner key=${key}`);
            return {
              cancel: true,
              cancelReason: 'session-overflow-rollover:auto-archive-and-resume',
            };
          }
          // 恢复排不上（冷却/刚投递过）：不许静默吞横幅，改写成用户能行动的提示
          console.warn(`[${PLUGIN_ID}] overflow banner rewritten (no recovery available) key=${key}`);
          return { content: OVERFLOW_RETRY_USER_NOTICE };
        }
        console.warn(`[${PLUGIN_ID}] overflow banner without sessionKey — not cancelling`);
        return;
      }
      // 限流/过载横幅：改写短中文提示（禁止纯静默；也不再 silent-retry 烧 token）
      if (isRateLimitBannerText(text)) {
        console.log(`[${PLUGIN_ID}] rewrite rate-limit banner key=${key || '(none)'}`);
        return { content: RATE_LIMIT_USER_NOTICE };
      }
    } catch (e) {
      console.warn(`[${PLUGIN_ID}] message_sending error:`, e && e.message);
    }
  });

  try {
    api.on('reply_payload_sending', async (event, ctx) => {
      try {
        const text = extractText(event?.payload) || extractText(event);
        // 只认真实 sessionKey，绝不用「最近会话」兜底以免标错/清错会话（defect 1a）
        const key = resolveSessionKey(event, ctx);
        const newSessionAsk =
          !isUserFacingSystemErrorText(text) &&
          asksUserToStartNewSession(text) &&
          Boolean(key) &&
          Boolean(sessionUnderContextPressure(key));
        if (key && text && !newSessionAsk) markUserFacingDelivery(key, text);
        if (!isUserFacingSystemErrorText(text) && !newSessionAsk) return;
        const lastUser = key ? pickLastUserText(key, event, ctx) : '';
        if (newSessionAsk) {
          if (scheduleRollover(api, key, lastUser, 'reply_payload_sending:new-session-ask', { intercepted: true })) {
            console.log(`[${PLUGIN_ID}] cancel model new-session ask (context pressure) key=${key}`);
            return {
              cancel: true,
              cancelReason: 'session-overflow-rollover:suppress-new-session-ask',
            };
          }
          console.warn(`[${PLUGIN_ID}] new-session ask NOT cancelled (no recovery available) key=${key}`);
          return;
        }
        if (isOverflowRecoveryText(text)) {
          if (isSoftOverflowBannerOnly(text) && !(key && sessionUnderContextPressure(key))) {
            return;
          }
          if (key && sessionRecentlyDelivered(key)) {
            return {
              cancel: true,
              cancelReason: 'session-overflow-rollover:suppress-overflow-banner-after-delivery',
            };
          }
          if (key) {
            if (scheduleRollover(api, key, lastUser, 'reply_payload_sending', { intercepted: true })) {
              return {
                cancel: true,
                cancelReason: 'session-overflow-rollover:auto-archive-and-resume',
              };
            }
            console.warn(`[${PLUGIN_ID}] overflow banner rewritten (no recovery available) key=${key}`);
            // reply_payload_sending 层只认 { payload }；返回 { content } 是无效协议会被核心忽略
            return { payload: { ...(event && event.payload ? event.payload : {}), text: OVERFLOW_RETRY_USER_NOTICE } };
          }
          return;
        }
        if (isRateLimitBannerText(text)) {
          return { payload: { ...(event && event.payload ? event.payload : {}), text: RATE_LIMIT_USER_NOTICE } };
        }
      } catch (_) {}
    });
  } catch (_) {}
}

const pluginEntry = {
  id: PLUGIN_ID,
  name: 'Session Overflow Rollover',
  description:
    'On context overflow / ordering conflict: archive session, persist continuity into MEMORY.md, start fresh, and resume with context (deliver to channel)',
  register,
  onShutdown: shutdownPlugin,
  shutdown: shutdownPlugin,
};

export default pluginEntry;
export {
  isOverflowRecoveryText,
  looksLikeOverflowFailure,
  asksUserToStartNewSession,
  sessionUnderContextPressure,
  readSessionContextPressure,
  buildContinuitySummary,
  buildContinuePrompt,
  upsertActiveSessionContext,
  readSessionDeliveryRoute,
  buildChatSendParams,
  writeReadableSessionArchive,
  rememberDeliveryRoute,
  normalizeDeliveryRoute,
};
export function activate(api) {
  return register(api);
}
