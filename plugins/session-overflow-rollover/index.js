/**
 * session-overflow-rollover
 *
 * 上下文溢出 / 自动压缩失败时：
 * 1) 拦截「请 /new」类恢复文案
 * 2) 归档旧会话（sessions.reset reason=new → *.reset.<ts>）
 * 3) 在新会话里重提上一问，让模型继续回答
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const PLUGIN_ID = 'session-overflow-rollover';
const COOLDOWN_MS = 60_000;
/** 本会话近期已有用户可见回复时，禁止 silent-retry / rollover 再跑一整轮（防双倍烧 token） */
const recentUserFacingDeliveryAt = new Map();
const DELIVERY_BLOCK_RESUME_MS = 120_000;
const TRIGGER_FILE = 'overflow-rollover.trigger.json';
const ARCHIVE_NOTE_DIR_REL = path.join('workspace', 'compact-history');
const ACTIVE_CONTEXT_HEADING = '## Active session context';
const CONTINUITY_SUMMARY_MAX = 900;
const CONTINUITY_PROMPT_MAX = 700;
const RECENT_TURN_PAIRS = 6;
const ARCHIVE_TURN_PAIRS = 24;
const ARCHIVE_FILE_MAX_CHARS = 48_000;
const LAST_ARCHIVE_REL = path.join('workspace', 'memory', 'last-session-archive.md');

/** @type {Map<string, { text: string, at: number }>} */
const lastUserBySession = new Map();
/** @type {Map<string, number>} */
const lastRolloverAt = new Map();
/** @type {Set<string>} */
const inFlight = new Set();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const pendingScheduleTimers = new Map();

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

function resolveSessionKeyWithFallback(event, ctx) {
  const direct = resolveSessionKey(event, ctx);
  if (direct) return direct;
  let best = '';
  let bestAt = 0;
  for (const [k, v] of lastUserBySession.entries()) {
    if (v && v.at > bestAt) {
      bestAt = v.at;
      best = k;
    }
  }
  return best;
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

/** 读取会话投递路由（微信默认落到 agent:main:main，仅 deliver:true 不够） */
function readSessionDeliveryRoute(sessionKey) {
  try {
    if (!sessionKey) return null;
    const storePath = path.join(stateDir(), 'agents', 'main', 'sessions', 'sessions.json');
    if (!fs.existsSync(storePath)) return null;
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8').replace(/^\uFEFF/, ''));
    const entry = store && store[sessionKey];
    if (!entry || typeof entry !== 'object') return null;
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
    if (!channel || !to) return null;
    if (/^webchat$/i.test(String(channel))) return null;
    return {
      channel: String(channel).trim(),
      to: String(to).trim(),
      accountId: accountId ? String(accountId).trim() : '',
      threadId: threadId != null && String(threadId).trim() ? String(threadId).trim() : '',
    };
  } catch (_) {
    return null;
  }
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
      if (rest.length > budget) rest = rest.slice(0, budget) + '\n\n<!-- truncated after rollover continuity upsert -->\n';
      next = head + rest;
    }
    fs.writeFileSync(file, next, 'utf8');
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

/**
 * OpenClaw 在溢出 / 压缩失败 / 角色奇偶冲突时都会吐出「use /new」类恢复文案。
 * 这些文案若只被 error-filter 静默拦截、却不归档换新，通讯渠道就会哑火。
 */
function isOverflowRecoveryText(text) {
  const t = String(text || '');
  if (!t) return false;
  return (
    /Auto-compaction could not recover/i.test(t) ||
    /auto-compaction could not recover/i.test(t) ||
    /auto-compaction failed/i.test(t) ||
    /Context overflow/i.test(t) ||
    /context[_\s-]?overflow/i.test(t) ||
    /Context is too large and auto-compaction/i.test(t) ||
    /Context limit exceeded/i.test(t) ||
    /prompt too large for the model/i.test(t) ||
    /Compaction timed out/i.test(t) ||
    /compaction timeout/i.test(t) ||
    /compaction[-_ ]?diag/i.test(t) ||
    /trigger\s*=\s*overflow/i.test(t) ||
    /diagId\s*=\s*ovf-/i.test(t) ||
    /\[agent\/embedded\].*(overflow|compaction)/i.test(t) ||
    /use \/compact/i.test(t) ||
    // 禁止裸匹配 "use /new"：助手闲聊提到 /new 会误触发 rollover
    /(?:⚠️|⚠|Context overflow|compaction|overflow|请(?:先)?使用)\s*[^\n]{0,80}\/new\b/i.test(t) ||
    /\/new to start/i.test(t) ||
    /Message ordering conflict/i.test(t) ||
    /roles must alternate/i.test(t) ||
    /incorrect role information/i.test(t) ||
    /Session history looks corrupted/i.test(t) ||
    /rejected the conversation state/i.test(t) ||
    /provider rejected the conversation state/i.test(t) ||
    /increase your compaction buffer/i.test(t) ||
    /reserveTokensFloor/i.test(t) ||
    /上下文过长|上下文溢出|自动压缩失败|请使用\s*\/new|角色(顺序|奇偶)|消息顺序冲突/i.test(t)
  );
}

function isRateLimitBannerText(text) {
  const t = String(text || '');
  if (!t) return false;
  if (isOverflowRecoveryText(t)) return false;
  return (
    /All models are temporarily rate-limited/i.test(t) ||
    /temporarily rate-limited/i.test(t) ||
    /API rate limit reached/i.test(t) ||
    /Rate-limited\s*[—\-]/i.test(t) ||
    /temporarily overloaded/i.test(t) ||
    /Please try again in a few minutes/i.test(t)
  );
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

async function performRollover(api, sessionKey, lastUserText, via) {
  if (!sessionKey) return false;
  if (inFlight.has(sessionKey)) return false;
  const now = Date.now();
  const prev = lastRolloverAt.get(sessionKey) || 0;
  if (now - prev < COOLDOWN_MS) {
    console.log(`[${PLUGIN_ID}] skip rollover (cooldown) key=${sessionKey} via=${via}`);
    return false;
  }

  // 已对用户发过实质内容：禁止 reset+resume（否则先清空会话再重跑 = 双倍 token）
  if (sessionRecentlyDelivered(sessionKey)) {
    lastRolloverAt.set(sessionKey, Date.now());
    console.log(
      `[${PLUGIN_ID}] skip rollover entirely (already delivered, no reset) key=${sessionKey} via=${via}`
    );
    return false;
  }

  inFlight.add(sessionKey);
  try {
    // 重置前：抽摘要 + 记下渠道投递路由（reset 会保留 lastChannel，但显式 originating 更稳）
    const deliveryRoute = readSessionDeliveryRoute(sessionKey);
    const continuity = persistContinuityBeforeReset(sessionKey, lastUserText);
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

    await gatewayRequest(api, 'sessions.reset', {
      key: sessionKey,
      reason: 'new',
    });

    const continueText = buildContinuePrompt(
      lastUserText,
      continuity.summary,
      continuity.archivePath
    );
    if (!continueText) {
      lastRolloverAt.set(sessionKey, Date.now());
      console.log(`[${PLUGIN_ID}] rollover archived without resume (empty last user) key=${sessionKey}`);
      return true;
    }

    // deliver:true + 显式 originating*：覆盖微信 dmScope=main（仅 deliver 会掉进内部通道）
    await gatewayRequest(api, 'chat.send', buildChatSendParams(sessionKey, continueText, deliveryRoute));

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
    try {
      filesystemEmergencyReset(sessionKey, lastUserText);
    } catch (_) {}
    return false;
  } finally {
    inFlight.delete(sessionKey);
  }
}

function filesystemEmergencyReset(sessionKey, lastUserText) {
  try {
    // 清空前尽量落盘延续摘要
    try {
      persistContinuityBeforeReset(sessionKey, lastUserText);
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
      try {
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
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

function scheduleRollover(api, sessionKey, lastUserText, via) {
  if (!sessionKey) return;
  if (sessionRecentlyDelivered(sessionKey)) {
    console.log(`[${PLUGIN_ID}] skip duplicate rollover schedule (already delivered) key=${sessionKey} via=${via}`);
    return;
  }
  const timerKey = `rollover:${sessionKey}`;
  if (pendingScheduleTimers.has(timerKey) || inFlight.has(sessionKey)) {
    console.log(`[${PLUGIN_ID}] skip duplicate rollover schedule key=${sessionKey} via=${via}`);
    return;
  }
  const timer = setTimeout(() => {
    pendingScheduleTimers.delete(timerKey);
    performRollover(api, sessionKey, lastUserText, via).catch(() => {});
  }, 80);
  pendingScheduleTimers.set(timerKey, timer);
}

async function performSilentRetry(api, sessionKey, lastUserText, via) {
  if (!sessionKey || !lastUserText) return false;
  // 永久关闭自动 silent-retry：限流横幅静默即可，禁止后台再跑一整轮 LLM（双回复主因之一）
  console.log(
    `[${PLUGIN_ID}] skip silent-retry (disabled to prevent double replies) key=${sessionKey} via=${via}`
  );
  return false;
}

function scheduleSilentRetry(api, sessionKey, lastUserText, via) {
  if (!sessionKey || !lastUserText) return;
  const timerKey = `silent:${sessionKey}`;
  // message_sending + reply_payload_sending 常成对触发；合并成一次 chat.send
  if (pendingScheduleTimers.has(timerKey) || inFlight.has(sessionKey)) {
    console.log(`[${PLUGIN_ID}] skip duplicate silent-retry schedule key=${sessionKey} via=${via}`);
    return;
  }
  const now = Date.now();
  const prev = lastRolloverAt.get(sessionKey) || 0;
  if (now - prev < COOLDOWN_MS) {
    console.log(`[${PLUGIN_ID}] skip silent-retry schedule (cooldown) key=${sessionKey} via=${via}`);
    return;
  }
  const timer = setTimeout(() => {
    pendingScheduleTimers.delete(timerKey);
    performSilentRetry(api, sessionKey, lastUserText, via).catch(() => {});
  }, 120);
  pendingScheduleTimers.set(timerKey, timer);
}

function resolveFreshestInteractiveSessionKey() {
  try {
    const store = path.join(stateDir(), 'agents', 'main', 'sessions', 'sessions.json');
    if (!fs.existsSync(store)) return '';
    const raw = JSON.parse(fs.readFileSync(store, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || typeof raw !== 'object') return '';
    let best = '';
    let bestAt = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (!k || /:cron:|:heartbeat:|:discord:channel:/i.test(k)) continue;
      const at = Number(v && (v.lastInteractionAt || v.updatedAt)) || 0;
      if (at >= bestAt) {
        bestAt = at;
        best = k;
      }
    }
    return best || 'agent:main:main';
  } catch (_) {
    return 'agent:main:main';
  }
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

function pollMainProcessTrigger(api) {
  try {
    const hit = consumeMainProcessTrigger();
    if (!hit) return;
    const key = hit.sessionKey || resolveFreshestInteractiveSessionKey() || resolveSessionKeyWithFallback({}, {});
    if (!key || /:cron:|:heartbeat:/i.test(key)) return;
    const lastUser = pickLastUserText(key, {}, {});
    console.log(`[${PLUGIN_ID}] main-process trigger key=${key} reason=${hit.reason}`);
    scheduleRollover(api, key, lastUser, 'main-log-trigger');
  } catch (e) {
    console.warn(`[${PLUGIN_ID}] trigger poll error:`, e && e.message);
  }
}

function register(api) {
  try {
    api.logger?.info?.(`[${PLUGIN_ID}] loaded`);
  } catch (_) {}
  console.log(`[${PLUGIN_ID}] loaded (overflow/ordering → archive+resume deliver; rate-limit → silent retry; log-bridge)`);

  // 主进程日志桥：compaction-diag 只出现在 stdout 时也能静默续聊
  try {
    setInterval(() => pollMainProcessTrigger(api), 1000);
  } catch (_) {}

  try {
    api.on('message_received', async (event, ctx) => {
      try {
        const key = resolveSessionKey(event, ctx);
        const text = extractText(event);
        if (key && text) rememberUserText(key, text);
      } catch (_) {}
    });
  } catch (_) {}

  try {
    api.on('before_dispatch', async (event, ctx) => {
      try {
        const key = resolveSessionKey(event, ctx);
        const text = extractText(event);
        if (key && text) rememberUserText(key, text);
      } catch (_) {}
    });
  } catch (_) {}

  api.on('agent_end', async (event, ctx) => {
    try {
      // 成功回合绝不因历史残留文案触发换新；失败且像溢出/角色冲突才 rollover
      if (event && event.success !== false) return;
      if (!looksLikeOverflowFailure(event, ctx)) return;
      const key = resolveSessionKeyWithFallback(event, ctx);
      if (!key) return;
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
        const key = resolveSessionKeyWithFallback(event, ctx);
        if (!key) return;
        if (sessionRecentlyDelivered(key)) {
          console.log(`[${PLUGIN_ID}] skip llm_output rollover (already delivered) key=${key}`);
          return;
        }
        const lastUser = pickLastUserText(key, event, ctx);
        scheduleRollover(api, key, lastUser, 'llm_output');
      } catch (_) {}
    });
  } catch (_) {}

  api.on('message_sending', async (event, ctx) => {
    try {
      const text = extractText(event);
      let key = resolveSessionKeyWithFallback(event, ctx);
      if (!key) key = resolveFreshestInteractiveSessionKey();
      if (key && text) markUserFacingDelivery(key, text);
      if (!isUserFacingSystemErrorText(text)) return;
      const lastUser = key ? pickLastUserText(key, event, ctx) : '';
      if (isOverflowRecoveryText(text)) {
        // 已有实质回复：只拦横幅，绝不 reset/重跑
        if (key && sessionRecentlyDelivered(key)) {
          console.log(`[${PLUGIN_ID}] cancel overflow banner only (already delivered) key=${key}`);
          return {
            cancel: true,
            cancelReason: 'session-overflow-rollover:suppress-overflow-banner-after-delivery',
          };
        }
        if (key) {
          scheduleRollover(api, key, lastUser, 'message_sending');
          console.log(`[${PLUGIN_ID}] cancel overflow/ordering recovery banner key=${key}`);
          return {
            cancel: true,
            cancelReason: 'session-overflow-rollover:auto-archive-and-resume',
          };
        }
        console.warn(`[${PLUGIN_ID}] overflow banner without sessionKey — not cancelling`);
        return;
      }
      // 限流/过载横幅：只对用户静默，不再后台重提原问题（防双回复烧 token）
      if (key) {
        console.log(`[${PLUGIN_ID}] cancel rate-limit banner key=${key} (no silent-retry)`);
        return {
          cancel: true,
          cancelReason: 'session-overflow-rollover:suppress-rate-limit-banner',
        };
      }
    } catch (e) {
      console.warn(`[${PLUGIN_ID}] message_sending error:`, e && e.message);
    }
  });

  try {
    api.on('reply_payload_sending', async (event, ctx) => {
      try {
        const text = extractText(event?.payload) || extractText(event);
        let key = resolveSessionKeyWithFallback(event, ctx);
        if (!key) key = resolveFreshestInteractiveSessionKey();
        if (key && text) markUserFacingDelivery(key, text);
        if (!isUserFacingSystemErrorText(text)) return;
        const lastUser = key ? pickLastUserText(key, event, ctx) : '';
        if (isOverflowRecoveryText(text)) {
          if (key && sessionRecentlyDelivered(key)) {
            return {
              cancel: true,
              cancelReason: 'session-overflow-rollover:suppress-overflow-banner-after-delivery',
            };
          }
          if (key) {
            scheduleRollover(api, key, lastUser, 'reply_payload_sending');
            return {
              cancel: true,
              cancelReason: 'session-overflow-rollover:auto-archive-and-resume',
            };
          }
          return;
        }
        if (key) {
          return {
            cancel: true,
            cancelReason: 'session-overflow-rollover:suppress-rate-limit-banner',
          };
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
};

export default pluginEntry;
export {
  isOverflowRecoveryText,
  looksLikeOverflowFailure,
  buildContinuitySummary,
  buildContinuePrompt,
  upsertActiveSessionContext,
  readSessionDeliveryRoute,
  buildChatSendParams,
  writeReadableSessionArchive,
};
export function activate(api) {
  return register(api);
}
