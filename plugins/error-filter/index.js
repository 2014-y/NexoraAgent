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
  'Model Fallback',
  'LLM request failed',
  'Connection failed, please check your network or proxy settings',
];

/** 同一 run 内第二次纯文本投递去重（message 工具 + 最终口述双发） */
const RUN_OUTBOUND_TTL_MS = 180_000;
/** @type {Map<string, { at: number, preview: string }>} */
const recentTextOutboundByRun = new Map();
/** 同会话近重复正文去重（跨 runId，防 silent-retry/rollover 第二轮）——窗口收紧，避免误杀正常连续回复 */
const SESSION_TEXT_DEDUP_TTL_MS = 15_000;
/** @type {Map<string, { at: number, fp: string, prefix: string }>} */
const recentTextOutboundBySession = new Map();
/** reply_payload 已放行的正文指纹 → 微信 message_sending 即使无 runId 也放行（120s） */
const CHANNEL_DELIVERY_APPROVE_TTL_MS = 120_000;
/** @type {Map<string, number>} */
const recentApprovedChannelDeliveryByFp = new Map();

/** 系统诊断硬特征：仅短消息或警告气泡拦截，避免误伤正常长回复 */
const DIAGNOSTIC_HARD_SUBSTRINGS = [
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
  '上下文过长',
  '上下文溢出',
  '自动压缩失败',
  '请使用 /new',
  '请使用/new',
];

/** 限流/过载类文案：短横幅才拦；长对话里提到「Rate Limit」作建议时放行 */
const RATE_LIMIT_BANNER_SUBSTRINGS = [
  'All models are temporarily rate-limited',
  'temporarily rate-limited',
  'The AI service is temporarily rate-limited',
  'The AI service is temporarily overloaded',
  'API rate limit reached',
  'Please try again in a few minutes.',
  'Rate-limited — ready in',
  '暂时限流',
  '所有模型暂时',
];

const BLOCK_REGEXES = [
  /Message:\s*.+\s+failed/i,
  /Exec failed/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /TOOL_FAILED/i,
];

const DIAGNOSTIC_HARD_REGEXES = [
  /Auto-compaction could not recover/i,
  /Context overflow:\s*prompt too large/i,
  /use \/compact,\s*or use \/new/i,
  /use \/new to start/i,
  /Message ordering conflict/i,
  /roles must alternate/i,
  /increase your compaction buffer/i,
  /(上下文|会话).*(过长|溢出|太大)/i,
  /自动压缩.*(失败|超时|无法)/i,
  /请使用\s*\/new/i,
];

const RATE_LIMIT_BANNER_REGEXES = [
  /^\s*⚠️?\s*All models are temporarily rate-limited/i,
  /^\s*⚠️?\s*Rate-limited/i,
  /^\s*⚠️?\s*API rate limit/i,
  /所有模型.*(限流|过载|繁忙)/i,
  /暂时(限流|过载|不可用)/i,
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

function looksLikeConversationalReply(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  // 角色口吻 / 明确建议结构（微信人格回复常见）
  if (/(启禀|主子|小的|奴才|臣妾|回主|建议|推荐|主用|备用|方案|双剑|我来帮|当然可以|以下是|已经帮你|完成了|代码如下|```|首先|步骤)/.test(raw)) {
    return true;
  }
  // 长 Markdown 结构（标题/列表）几乎不可能是系统横幅
  if (raw.length >= 220 && /(^|\n)\s*#{1,3}\s+|(^|\n)\s*[-*]\s+\*\*/m.test(raw)) return true;
  const cn = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cn >= 48 && raw.length >= 160) return true;
  return false;
}

/** 真·系统诊断横幅形态（短气泡 / 机器字段）；角色口吻解释一律不算 */
function isDiagnosticBannerShaped(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  // 机器可读诊断字段：一律当真横幅
  if (/compaction-diag|diagId\s*=\s*ovf-|trigger\s*=\s*overflow|\[agent\/embedded\]|reserveTokensFloor/i.test(raw)) {
    return true;
  }
  // 角色口吻（主子/启禀/建议…）：即使短文提到 overflow / failed 也不当系统横幅
  if (looksLikeConversationalReply(raw)) return false;
  if (/^\s*⚠️/.test(raw) && raw.length <= 400) return true;
  if (raw.length <= 280) return true;
  const cn = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cn < 24 && raw.length <= 600) return true;
  return false;
}

function isRateLimitBannerShaped(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/^\s*⚠️/.test(raw)) return true;
  // 短提示才像系统气泡；长文里夹一句 Rate Limit 不算
  if (raw.length <= 280) return true;
  // 几乎全是英文诊断句、中文很少
  const cn = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  return cn < 12;
}

function isSystemDiagnosticBannerOnly(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (looksLikeConversationalReply(raw)) return false;
  const stripped = raw.replace(/⚠️/g, '').replace(/\s+/g, ' ').trim();
  // 注意：不要用裸「所有模型」「rate limit」——正常建议文案也会提到
  const looksDiag =
    /temporarily rate-limited|API rate limit reached|Rate-limited — ready in|auto-compaction|compaction[-_ ]?diag|compaction timed|compaction timeout|context[_\s-]?overflow|prompt too large|reserveTokensFloor|try again (in|later|shortly)|\/compact|\/new to start|Message ordering conflict|roles must alternate|\[agent\/embedded\]|trigger\s*=\s*overflow|diagId\s*=\s*ovf-|runId\s*=|outcome\s*=\s*failed|所有模型.*(限流|过载|繁忙)|暂时限流|暂时过载|上下文过长|上下文溢出|自动压缩失败|请使用\s*\/new/i.test(
      stripped
    );
  if (!looksDiag) return false;
  // 长诊断行（compaction-diag）可超过 700 字；普通长回复已被 conversational 放行
  return true;
}

function hitAny(list, raw) {
  for (const s of list) {
    if (raw.includes(s)) return true;
  }
  return false;
}

function hitAnyRe(list, raw) {
  for (const re of list) {
    try { if (re.test(raw)) return true; } catch (_) {}
  }
  return false;
}

/** 模型/中转网络失败：改写为短中文，避免静默不回复 */
const NETWORK_FAILURE_USER_NOTICE =
  '模型服务暂时不可用（中转连接失败）。请稍后重试，或在设置里确认备用模型为公网通道。';
/** 限流/过载：改写为短中文，禁止纯 cancel 导致微信哑火 */
const RATE_LIMIT_USER_NOTICE = '模型暂时繁忙或限流，请稍后再发一条。';

function isUserFacingSubstituteNotice(text) {
  const raw = String(text || '').trim();
  return raw === NETWORK_FAILURE_USER_NOTICE || raw === RATE_LIMIT_USER_NOTICE;
}

function isNetworkFailureBanner(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  // 长对话里偶尔提到 connection 不改写
  if (looksLikeConversationalReply(raw) && raw.length >= 160) return false;
  if (/^LLM request failed\.?$/i.test(raw)) return true;
  if (/Connection failed.*network or proxy/i.test(raw)) return true;
  if (/LLM request failed:\s*network connection error/i.test(raw)) return true;
  if (/network connection error/i.test(raw) && raw.length <= 280) return true;
  if (/All models failed\s*\(/i.test(raw)) return true;
  if (/Embedded agent failed before reply/i.test(raw)) return true;
  if (/Something went wrong while processing your request/i.test(raw) && raw.length <= 280) return true;
  if (/FailoverError:\s*LLM request failed/i.test(raw)) return true;
  return false;
}

function isRateLimitBannerForRewrite(text) {
  const raw = String(text || '').trim();
  if (!raw || isUserFacingSubstituteNotice(raw)) return false;
  if (!(hitAny(RATE_LIMIT_BANNER_SUBSTRINGS, raw) || hitAnyRe(RATE_LIMIT_BANNER_REGEXES, raw))) {
    return false;
  }
  if (looksLikeConversationalReply(raw) && raw.length >= 160) return false;
  if (looksLikeConversationalReply(raw) && !isRateLimitBannerShaped(raw)) return false;
  return true;
}

function rewriteNetworkFailureOutbound(text) {
  const raw = String(text || '').trim();
  if (!raw || isUserFacingSubstituteNotice(raw)) return null;
  if (!isNetworkFailureBanner(raw)) return null;
  return NETWORK_FAILURE_USER_NOTICE;
}

/** 网络失败 / 限流横幅 → 短中文；其它诊断仍走 cancel */
function rewriteSilentFailureOutbound(text) {
  const net = rewriteNetworkFailureOutbound(text);
  if (net) return net;
  if (isRateLimitBannerForRewrite(text)) return RATE_LIMIT_USER_NOTICE;
  return null;
}

function shouldBlockOutbound(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  // 已改写的中文提示放行
  if (isUserFacingSubstituteNotice(raw)) return false;
  // 后台进程系统通知（⚠️ 🧰 Process: lucky-basil failed/exited）：内核对 exec 后台进程
  // 的异步提示，不是模型回复；普通用户看不懂且会误以为出故障——拦截。
  // 前缀锚定 + 表情符号双重特征，正常聊天文本不可能命中
  if (/^\s*(?:⚠️|⚠)?\s*🧰\s*Process:\s*\S+\s+(failed|exited|killed|stopped|timed out)/i.test(raw)) return true;
  if (/^\s*(?:⚠️|⚠)\s*🧰/.test(raw)) return true;
  // 网络失败横幅：仍视为「应拦截英文原样」；投递路径会改写为中文提示
  if (isNetworkFailureBanner(raw)) return true;
  if (isModelFallbackNoticeOnly(raw)) return true;
  if (isLeakedToolJsonOnly(raw)) return true;
  if (isSystemDiagnosticBannerOnly(raw)) return true;
  // 仅短横幅；长回复以 Failed/Error 开头不误杀
  if (/^\s*[!\[]?\s*(warning|error|failed)\b/i.test(raw) && isDiagnosticBannerShaped(raw)) {
    return true;
  }

  // 结构性诊断：短横幅/机器字段拦截；角色口吻技术解释放行（防误杀「讲 overflow」）
  if (hitAny(DIAGNOSTIC_HARD_SUBSTRINGS, raw) || hitAnyRe(DIAGNOSTIC_HARD_REGEXES, raw)) {
    if (looksLikeConversationalReply(raw) && !isDiagnosticBannerShaped(raw)) {
      return false;
    }
    return true;
  }

  // 限流/过载横幅：短气泡才拦；长对话建议里提到 Rate Limit / 限流 放行
  if (hitAny(RATE_LIMIT_BANNER_SUBSTRINGS, raw) || hitAnyRe(RATE_LIMIT_BANNER_REGEXES, raw)) {
    if (looksLikeConversationalReply(raw) && raw.length >= 160) return false;
    if (looksLikeConversationalReply(raw) && !isRateLimitBannerShaped(raw)) return false;
    return true;
  }

  // BLOCK 子串：角色文夹带 "LLM request failed" / "Model Fallback" 等放行
  if (hitAny(BLOCK_SUBSTRINGS, raw) || hitAnyRe(BLOCK_REGEXES, raw)) {
    if (looksLikeConversationalReply(raw) && !isDiagnosticBannerShaped(raw)) {
      return false;
    }
    return true;
  }
  return false;
}

/** 仅真实 runId/deliveryId；禁止退化成 peer（否则微信同联系人后续回复会被误杀） */
function resolveOutboundRunKey(event) {
  if (!event || typeof event !== 'object') return '';
  const meta = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const cands = [
    meta.runId,
    event.runId,
    event.run_id,
    meta.deliveryId,
    event.deliveryId,
  ];
  for (const k of cands) {
    if (typeof k === 'string' && k.trim()) return `run:${k.trim()}`;
  }
  return '';
}

function outboundHasMedia(event) {
  if (!event || typeof event !== 'object') return false;
  const meta = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  if (typeof event.mediaUrl === 'string' && event.mediaUrl.trim()) return true;
  if (Array.isArray(event.mediaUrls) && event.mediaUrls.length > 0) return true;
  if (Array.isArray(meta.mediaUrls) && meta.mediaUrls.length > 0) return true;
  if (typeof meta.mediaUrl === 'string' && meta.mediaUrl.trim()) return true;
  return false;
}

function pruneRecentOutbound(now = Date.now()) {
  for (const [k, v] of recentTextOutboundByRun) {
    if (!v || now - v.at > RUN_OUTBOUND_TTL_MS) recentTextOutboundByRun.delete(k);
  }
  for (const [k, v] of recentTextOutboundBySession) {
    if (!v || now - v.at > SESSION_TEXT_DEDUP_TTL_MS) recentTextOutboundBySession.delete(k);
  }
}

function textFingerprint(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 600);
}

function resolveSessionDedupeKey(event) {
  const sk = resolveSessionKeyFromEvent(event);
  if (sk) return `sess:${sk}`;
  const to = typeof event?.to === 'string' ? event.to.trim() : '';
  if (to) return `to:${to}`;
  return '';
}

function pruneApprovedChannelDelivery(now = Date.now()) {
  for (const [k, at] of recentApprovedChannelDeliveryByFp) {
    if (!at || now - at > CHANNEL_DELIVERY_APPROVE_TTL_MS) {
      recentApprovedChannelDeliveryByFp.delete(k);
    }
  }
}

/** reply_payload 放行后盖章，供无 runId 的微信二道门识别 */
function markApprovedForChannelDelivery(text) {
  const fp = textFingerprint(text);
  if (!fp || fp.length < 16) return;
  pruneApprovedChannelDelivery();
  recentApprovedChannelDeliveryByFp.set(fp, Date.now());
}

function isApprovedForChannelDelivery(text) {
  const fp = textFingerprint(text);
  if (!fp) return false;
  pruneApprovedChannelDelivery();
  const at = recentApprovedChannelDeliveryByFp.get(fp);
  return Boolean(at && Date.now() - at < CHANNEL_DELIVERY_APPROVE_TTL_MS);
}

/** reply_payload 是否已为本 run 记过纯文本（微信 message_sending 是第二道门，不得再 cancel） */
function runAlreadyRecordedTextOutbound(event) {
  const runKey = resolveOutboundRunKey(event);
  if (!runKey) return false;
  const prev = recentTextOutboundByRun.get(runKey);
  return Boolean(prev && Date.now() - prev.at < RUN_OUTBOUND_TTL_MS);
}

/** reply_payload 是否已为本 run 占过媒体坑 */
function runAlreadyClaimedMediaOutbound(event) {
  const runKey = resolveOutboundRunKey(event);
  if (!runKey) return false;
  const prev = recentMediaOutboundByRun.get(runKey);
  return Boolean(prev && prev.paths && prev.paths.size > 0);
}

/** 渠道层是否应视为「reply 已放行」 */
function isChannelDeliveryAlreadyApproved(event, text) {
  if (runAlreadyRecordedTextOutbound(event)) return true;
  if (isApprovedForChannelDelivery(text)) return true;
  return false;
}

/**
 * 同一轮已成功发出过纯文本后，再发一条纯文本 → 取消（防「问一句回两句」）。
 * 仅应在 reply_payload_sending 使用；message_sending 再用会掐死微信唯一投递。
 * 带媒体的投递放行；极短 ACK / NO_REPLY 不参与。
 * 注意：无 runId 时不做「整 peer 封禁」，只按正文指纹去重近似复读。
 */
function shouldCancelDuplicateRunOutbound(event, text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length < 8) return false;
  if (/^NO_REPLY$/i.test(raw)) return false;
  if (outboundHasMedia(event)) return false;
  if (extractMediaDirectiveUrls(raw).length > 0) return false;
  const now = Date.now();
  pruneRecentOutbound(now);

  const runKey = resolveOutboundRunKey(event);
  if (runKey) {
    const prev = recentTextOutboundByRun.get(runKey);
    // 同 run 第二次：仅「正文指纹完全相同」才拦（防「问一句回两句」的重复投递）。
    // 不再用前 160 字模糊匹配——那会把同一 run 里以相同开头起草的不同气泡误判为复读。
    if (prev && now - prev.at < RUN_OUTBOUND_TTL_MS) {
      const fp = textFingerprint(raw);
      const prevFp = String(prev.fp || textFingerprint(prev.preview || '') || '');
      if (fp && prevFp && fp === prevFp) return true;
    }
  }

  // 跨 run：仅取消「正文完全相同」且在短窗（15s）内的复读，避免误伤正常连续对话。
  // 去掉前 160 字近似匹配——它会把「模板开头相同、内容不同」的合法连续回复整条丢弃。
  const sessKey = resolveSessionDedupeKey(event);
  if (sessKey && raw.length >= 24) {
    const fp = textFingerprint(raw);
    const prev = recentTextOutboundBySession.get(sessKey);
    if (prev && now - prev.at < SESSION_TEXT_DEDUP_TTL_MS) {
      if (prev.fp === fp) return true;
    }
  }
  return false;
}

function rememberRunOutbound(event, text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length < 8) return;
  if (/^NO_REPLY$/i.test(raw)) return;
  if (outboundHasMedia(event)) return;
  if (extractMediaDirectiveUrls(raw).length > 0) return;
  const now = Date.now();
  pruneRecentOutbound(now);
  const runKey = resolveOutboundRunKey(event);
  if (runKey) {
    const fp = textFingerprint(raw);
    recentTextOutboundByRun.set(runKey, {
      at: now,
      fp,
      preview: raw.replace(/\s+/g, ' ').slice(0, 80),
    });
  }
  const sessKey = resolveSessionDedupeKey(event);
  if (sessKey && raw.length >= 24) {
    const fp = textFingerprint(raw);
    recentTextOutboundBySession.set(sessKey, {
      at: now,
      fp,
      prefix: fp.slice(0, 120),
    });
  }
  // 无论有无 runId：盖章给微信 message_sending 二道门
  markApprovedForChannelDelivery(raw);
}

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR
    || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(), '.openclaw');
}

/** 溢出/奇偶 /new 类横幅被拦截时，通知 session-overflow-rollover 归档续聊（防钩子短路哑火） */
function needsSessionRollover(text) {
  const t = String(text || '');
  if (!t) return false;
  // 角色口吻解释 overflow 机制：绝不触发 rollover
  if (looksLikeConversationalReply(t) && !isDiagnosticBannerShaped(t)) {
    return false;
  }
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

/** message_sending 事件本身不带 sessionKey（核心只放在 ctx 里）——两处都要查 */
function resolveSessionKeyFromHook(event, ctx) {
  const fromEvent = resolveSessionKeyFromEvent(event);
  if (fromEvent) return fromEvent;
  const k = ctx && (ctx.sessionKey || ctx.session_key);
  return typeof k === 'string' && k.trim() ? k.trim() : '';
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
    console.log(`[${PLUGIN_ID}] queued overflow-rollover trigger key=${sessionKey || '(none)'}`);
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
  if (process.platform === 'darwin') {
    await execFileAsync('screencapture', ['-x', filepath], { timeout: 30000, maxBuffer: 1024 * 1024 });
  } else if (process.platform !== 'win32') {
    throw new Error('screenshot not supported on this platform');
  } else {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolveCaptureScriptPath(), '-OutPath', filepath,
    ], { timeout: 30000, maxBuffer: 1024 * 1024 });
  }
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

/** 双 hook 可能对同一段伪指令各跑一次；按 prompt 指纹缓存，避免重复截图/生图 */
const _pseudoMediaSideEffectCache = new Map();
const _pseudoMediaInflight = new Map();
const PSEUDO_MEDIA_CACHE_TTL_MS = 5 * 60_000;
/** @type {Map<string, { at: number, paths: Set<string> }>} */
const recentMediaOutboundByRun = new Map();

function normalizePromptFingerprint(prompt) {
  return String(prompt || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 400);
}

function pseudoMediaCacheKey(text) {
  const raw = String(text || '').trim();
  const prompt = extractDrawPicturePrompt(raw);
  if (prompt) return `draw:${normalizePromptFingerprint(prompt)}`;
  if (looksLikePseudoScreenshot(raw) || looksLikeScreenshotRefusal(raw)) {
    return `shot:${raw.slice(0, 200)}`;
  }
  return `text:${raw.slice(0, 800)}`;
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

/** 清理过期条目：原先只有「同 key 再次命中」时才删，不同 prompt 的历史条目永不回收 → 长跑缓慢泄漏 */
function prunePseudoMediaCache(now = Date.now()) {
  for (const [k, v] of _pseudoMediaSideEffectCache) {
    if (!v || now - v.at > PSEUDO_MEDIA_CACHE_TTL_MS) _pseudoMediaSideEffectCache.delete(k);
  }
}

function setCachedPseudoMedia(text, kind, mediaUrls, replyText) {
  prunePseudoMediaCache();
  const entry = {
    at: Date.now(),
    kind,
    mediaUrls: Array.isArray(mediaUrls) ? mediaUrls : [],
    replyText: String(replyText || ''),
  };
  _pseudoMediaSideEffectCache.set(pseudoMediaCacheKey(text), entry);
  // 同时按 prompt 指纹再存一份，覆盖「同一 prompt、不同外层文案」
  const prompt = extractDrawPicturePrompt(text);
  if (prompt) {
    _pseudoMediaSideEffectCache.set(`draw:${normalizePromptFingerprint(prompt)}`, entry);
  }
}

function pruneRecentMediaOutbound(now = Date.now()) {
  for (const [k, v] of recentMediaOutboundByRun) {
    if (!v || now - v.at > RUN_OUTBOUND_TTL_MS) recentMediaOutboundByRun.delete(k);
  }
}

function collectOutboundMediaPaths(event, text) {
  const paths = [];
  const push = (p) => {
    const v = unixPath(String(p || '').trim());
    if (v) paths.push(v.toLowerCase());
  };
  if (event && typeof event === 'object') {
    const meta = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
    if (typeof event.mediaUrl === 'string') push(event.mediaUrl);
    if (Array.isArray(event.mediaUrls)) event.mediaUrls.forEach(push);
    if (typeof meta.mediaUrl === 'string') push(meta.mediaUrl);
    if (Array.isArray(meta.mediaUrls)) meta.mediaUrls.forEach(push);
    if (event.payload && typeof event.payload === 'object') {
      if (typeof event.payload.mediaUrl === 'string') push(event.payload.mediaUrl);
      if (Array.isArray(event.payload.mediaUrls)) event.payload.mediaUrls.forEach(push);
    }
  }
  for (const u of extractMediaDirectiveUrls(text)) push(u);
  return Array.from(new Set(paths));
}

/** 同 prompt 已投递过媒体后，短窗内禁止再发（防双 run / 双 hook） */
const recentPromptMediaDelivery = new Map();
const recentPathMediaDelivery = new Map();
/** 同会话短窗内只允许一次生图类媒体（覆盖 prompt 略有改写的二次 run） */
const recentSessionDrawDelivery = new Map();
/** 生图 API 进行中（与最终投递 claim 分离） */
const _drawInflightBySession = new Map();
const PROMPT_MEDIA_DELIVERY_TTL_MS = 120_000;
const SESSION_DRAW_COOLDOWN_MS = 75_000;

function prunePromptMediaDelivery(now = Date.now()) {
  for (const [k, v] of recentPromptMediaDelivery) {
    if (!v || now - v.at > PROMPT_MEDIA_DELIVERY_TTL_MS) recentPromptMediaDelivery.delete(k);
  }
  for (const [k, at] of recentPathMediaDelivery) {
    if (!at || now - at > PROMPT_MEDIA_DELIVERY_TTL_MS) recentPathMediaDelivery.delete(k);
  }
  for (const [k, at] of recentSessionDrawDelivery) {
    if (!at || now - at > SESSION_DRAW_COOLDOWN_MS) recentSessionDrawDelivery.delete(k);
  }
}

function looksLikeMediaStatusOnly(text) {
  const raw = String(text || '').trim();
  return /^Image generated\.?$/i.test(raw) || /^Screenshot captured\.?$/i.test(raw);
}

function isDrawLikeOutbound(text, promptHint = '', paths = []) {
  if (promptHint) return true;
  if (extractDrawPicturePrompt(text)) return true;
  if (looksLikeMediaStatusOnly(text) && /image generated/i.test(String(text || ''))) return true;
  return (paths || []).some((p) => /image-output|[/\\]img[_-]|draw/i.test(String(p || '')));
}

function sessionScopeFromEvent(event) {
  const sk = resolveSessionKeyFromEvent(event);
  if (sk) return sk;
  const to = typeof event?.to === 'string' ? event.to.trim() : '';
  if (to) return `to:${to}`;
  const meta = event?.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const channel = typeof meta.channel === 'string' ? meta.channel.trim() : '';
  if (channel) return `ch:${channel}`;
  return 'global';
}

function promptDeliveryKey(event, prompt) {
  const fp = normalizePromptFingerprint(prompt);
  if (!fp) return '';
  return `${sessionScopeFromEvent(event)}|draw:${fp}`;
}

/** 是否已占坑：同 run / 同 prompt / 同路径 / 生图进行中 */
function isMediaDeliveryClaimed(event, text, extraPaths = [], promptHint = '', opts = {}) {
  const ignoreInflight = Boolean(opts && opts.ignoreInflight);
  const now = Date.now();
  pruneRecentMediaOutbound(now);
  prunePromptMediaDelivery(now);
  const paths = [
    ...collectOutboundMediaPaths(event, text),
    ...(Array.isArray(extraPaths) ? extraPaths : []),
  ].map((p) => unixPath(String(p || '').trim()).toLowerCase()).filter(Boolean);

  const runKey = resolveOutboundRunKey(event);
  if (runKey) {
    const prev = recentMediaOutboundByRun.get(runKey);
    if (prev && prev.paths.size > 0) {
      if (paths.length > 0 || looksLikeMediaStatusOnly(text) || extractDrawPicturePrompt(text) || promptHint) {
        return true;
      }
    }
  }

  const prompt = String(promptHint || extractDrawPicturePrompt(text) || '').trim();
  if (prompt) {
    const pk = promptDeliveryKey(event, prompt);
    const hit = pk && recentPromptMediaDelivery.get(pk);
    if (hit && now - hit.at < PROMPT_MEDIA_DELIVERY_TTL_MS) return true;
  }

  if (isDrawLikeOutbound(text, prompt, paths)) {
    const sk = sessionScopeFromEvent(event);
    const at = sk && recentSessionDrawDelivery.get(sk);
    if (at && now - at < SESSION_DRAW_COOLDOWN_MS) return true;
    if (!ignoreInflight) {
      const inflight = sk && _drawInflightBySession.get(sk);
      if (inflight && now - inflight.at < SESSION_DRAW_COOLDOWN_MS) return true;
    }
  }

  for (const p of paths) {
    const at = recentPathMediaDelivery.get(p);
    if (at && now - at < PROMPT_MEDIA_DELIVERY_TTL_MS) return true;
  }
  return false;
}

function releaseSessionDrawReservation(event) {
  const sk = sessionScopeFromEvent(event);
  if (sk) _drawInflightBySession.delete(sk);
}

/**
 * 生图开始前占用「进行中」槽（与最终 claim 分离），避免双 hook 各跑一遍 API。
 * @returns {{ ok: true, reserved: boolean } | { ok: false, reason: string }}
 */
function reserveSessionDrawSlot(event, text, promptHint = '') {
  const prompt = String(promptHint || extractDrawPicturePrompt(text) || '').trim();
  if (!isDrawLikeOutbound(text, prompt, [])) return { ok: true, reserved: false };
  if (isMediaDeliveryClaimed(event, text, [], prompt)) {
    return { ok: false, reason: 'error-filter:suppress-duplicate-media' };
  }
  const sk = sessionScopeFromEvent(event);
  const now = Date.now();
  const inflight = sk && _drawInflightBySession.get(sk);
  if (inflight && now - inflight.at < SESSION_DRAW_COOLDOWN_MS) {
    return { ok: false, reason: 'error-filter:suppress-duplicate-media' };
  }
  if (sk) _drawInflightBySession.set(sk, { at: now, prompt });
  return { ok: true, reserved: true };
}

/**
 * 先占坐：同一时刻只有第一个 hook/run 能投递该媒体。
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function claimMediaDelivery(event, text, extraPaths = [], promptHint = '') {
  // ignoreInflight：本 hook 已 reserve，允许 finalize claim
  if (isMediaDeliveryClaimed(event, text, extraPaths, promptHint, { ignoreInflight: true })) {
    return { ok: false, reason: 'error-filter:suppress-duplicate-media' };
  }
  const now = Date.now();
  pruneRecentMediaOutbound(now);
  prunePromptMediaDelivery(now);
  const paths = Array.from(new Set([
    ...collectOutboundMediaPaths(event, text),
    ...(Array.isArray(extraPaths) ? extraPaths : []),
  ].map((p) => unixPath(String(p || '').trim()).toLowerCase()).filter(Boolean)));

  const runKey = resolveOutboundRunKey(event);
  if (runKey) {
    const entry = recentMediaOutboundByRun.get(runKey) || { at: now, paths: new Set() };
    for (const p of paths) entry.paths.add(p);
    if (entry.paths.size === 0) entry.paths.add('__media_slot__');
    entry.at = now;
    recentMediaOutboundByRun.set(runKey, entry);
  }

  const prompt = String(promptHint || extractDrawPicturePrompt(text) || '').trim();
  if (prompt) {
    const pk = promptDeliveryKey(event, prompt);
    if (pk) recentPromptMediaDelivery.set(pk, { at: now, paths });
  }
  if (isDrawLikeOutbound(text, prompt, paths)) {
    const sk = sessionScopeFromEvent(event);
    if (sk) {
      recentSessionDrawDelivery.set(sk, now);
      _drawInflightBySession.delete(sk);
    }
  }
  for (const p of paths) recentPathMediaDelivery.set(p, now);
  return { ok: true };
}

function payloadText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.text === 'string') return payload.text;
  return extractText({ content: payload.content });
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

  api.on('reply_payload_sending', async (event, ctx) => {
    try {
      const incoming = event?.payload && typeof event.payload === 'object' ? event.payload : {};
      const rawText = payloadText(incoming);
      const promptHint = extractDrawPicturePrompt(rawText);
      const incomingPaths = collectOutboundMediaPaths(
        { ...event, mediaUrl: incoming.mediaUrl, mediaUrls: incoming.mediaUrls },
        rawText
      );

      // 已投递过同 run / 同 prompt 媒体：直接取消，避免第二张图
      if (
        (promptHint || incomingPaths.length > 0 || outboundHasMedia(incoming) || outboundHasMedia(event))
        && isMediaDeliveryClaimed(event, rawText, incomingPaths, promptHint)
      ) {
        try { api.logger?.info?.(`[${PLUGIN_ID}] cancelled duplicate media payload`); } catch (_) {}
        console.log(`[${PLUGIN_ID}] cancelled duplicate media payload`);
        return { cancel: true, cancelReason: 'error-filter:suppress-duplicate-media' };
      }

      const reserve = reserveSessionDrawSlot(event, rawText, promptHint);
      if (!reserve.ok) {
        try { api.logger?.info?.(`[${PLUGIN_ID}] cancelled duplicate media reserve`); } catch (_) {}
        console.log(`[${PLUGIN_ID}] cancelled duplicate media reserve`);
        return { cancel: true, cancelReason: reserve.reason };
      }

      let payload = null;
      try {
        payload = await maybeBuildPseudoMediaPayload(incoming);
      } catch (err) {
        if (reserve.reserved) releaseSessionDrawReservation(event);
        throw err;
      }

      if (payload) {
        const paths = Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [];
        const claim = claimMediaDelivery(event, payloadText(payload) || rawText, paths, promptHint);
        if (!claim.ok) {
          if (reserve.reserved) releaseSessionDrawReservation(event);
          try { api.logger?.info?.(`[${PLUGIN_ID}] cancelled duplicate media after rewrite`); } catch (_) {}
          console.log(`[${PLUGIN_ID}] cancelled duplicate media after rewrite`);
          return { cancel: true, cancelReason: claim.reason };
        }
        try { api.logger?.info?.(`[${PLUGIN_ID}] rewrote pseudo media payload to mediaUrls`); } catch (_) {}
        return { payload, metadata: { nexoraPseudoMediaFixed: true } };
      }

      if (reserve.reserved) releaseSessionDrawReservation(event);

      // 原生已带媒体的 payload：占坑，后续 hook/run 不再发
      if (incomingPaths.length > 0 || outboundHasMedia(incoming) || outboundHasMedia(event)) {
        const claim = claimMediaDelivery(event, rawText, incomingPaths, promptHint);
        if (!claim.ok) {
          return { cancel: true, cancelReason: claim.reason };
        }
        return;
      }

      // 纯文本 payload：同会话近重复取消
      if (shouldCancelDuplicateRunOutbound(event, rawText)) {
        const preview = String(rawText || '').replace(/\s+/g, ' ').slice(0, 100);
        try { api.logger?.info?.(`[${PLUGIN_ID}] cancelled duplicate reply payload: ${preview}`); } catch (_) {}
        console.log(`[${PLUGIN_ID}] cancelled duplicate reply payload: ${preview}`);
        return { cancel: true, cancelReason: 'error-filter:suppress-duplicate-run-outbound' };
      }
      const silentRewrite = rewriteSilentFailureOutbound(rawText);
      if (silentRewrite) {
        try { api.logger?.info?.(`[${PLUGIN_ID}] rewrote silent-failure reply payload`); } catch (_) {}
        console.log(`[${PLUGIN_ID}] rewrote silent-failure reply payload`);
        rememberRunOutbound(event, silentRewrite);
        // reply_payload_sending 层只认 { payload }；{ content } 会被核心忽略（改写变空操作）
        return { payload: { ...(event && event.payload ? event.payload : {}), text: silentRewrite } };
      }
      if (rawText && !shouldBlockOutbound(rawText)) {
        rememberRunOutbound(event, rawText);
      } else if (shouldBlockOutbound(rawText)) {
        const preview = String(rawText || '').replace(/\s+/g, ' ').slice(0, 100);
        if (needsSessionRollover(rawText)) {
          // 溢出/奇偶横幅：只记信号、绝不在这里 cancel——本插件按字母序先注册，
          // cancel 会短路后面的 session-overflow-rollover 钩子，它才有完整的
          // 「取消必有下文（补答/提示/放行）」保障。触发文件仅作冗余信号。
          queueOverflowRolloverTrigger(resolveSessionKeyFromHook(event, ctx), preview);
          return;
        }
        return { cancel: true, cancelReason: 'error-filter:suppress-warning-banner' };
      }
    } catch (e) {
      console.warn(`[${PLUGIN_ID}] reply_payload_sending hook error:`, e && e.message);
    }
  });

  api.on('message_sending', async (event, ctx) => {
    try {
      // ── 微信投递二道门 ──
      // reply_payload_sending 已去重/占坑；此处再 cancel 会掐死渠道唯一发送 → 模型 200 但用户静默。
      // 本钩子只做：伪媒体修复、失败横幅改写/拦截；禁止 text/media 去重 cancel。

      if (event?.metadata?.nexoraPseudoMediaFixed) {
        const fixedText = extractText(event);
        const paths = collectOutboundMediaPaths(event, fixedText);
        if (paths.length > 0 || outboundHasMedia(event) || looksLikeMediaStatusOnly(fixedText)) {
          claimMediaDelivery(event, fixedText, paths, extractDrawPicturePrompt(fixedText));
        }
        return;
      }

      const text = extractText(event);
      const promptHint = extractDrawPicturePrompt(text);
      const existingPaths = collectOutboundMediaPaths(event, text);
      const alreadyText = isChannelDeliveryAlreadyApproved(event, text);
      const alreadyMedia = runAlreadyClaimedMediaOutbound(event);

      // reply 层已占媒体坑：本通道是投递本身，放行（勿 cancel）
      if (
        alreadyMedia
        && (existingPaths.length > 0 || outboundHasMedia(event) || looksLikeMediaStatusOnly(text) || promptHint)
      ) {
        try { api.logger?.info?.(`[${PLUGIN_ID}] channel-layer pass claimed media (delivery gate)`); } catch (_) {}
        console.log(`[${PLUGIN_ID}] channel-layer pass claimed media (delivery gate)`);
        return;
      }

      // reply 层已放行纯文本（含无 runId 指纹盖章）：仅处理失败横幅，不做去重 cancel
      if (alreadyText && !promptHint && existingPaths.length === 0 && !outboundHasMedia(event)) {
        const silentRewrite = rewriteSilentFailureOutbound(text);
        if (silentRewrite) {
          console.log(`[${PLUGIN_ID}] channel-layer rewrote silent-failure (post-approve)`);
          return { content: silentRewrite };
        }
        if (shouldBlockOutbound(text)) {
          const preview = text.replace(/\s+/g, ' ').slice(0, 100);
          if (needsSessionRollover(text)) {
            // 溢出横幅交给 session-overflow-rollover（在本钩子之后执行）处理；只记冗余信号
            console.log(`[${PLUGIN_ID}] pass overflow banner to rollover plugin (post-approve): ${preview}`);
            queueOverflowRolloverTrigger(resolveSessionKeyFromHook(event, ctx), preview);
            return;
          }
          console.log(`[${PLUGIN_ID}] channel-layer cancelled banner (post-approve): ${preview}`);
          return { cancel: true, cancelReason: 'error-filter:suppress-warning-banner' };
        }
        return;
      }

      // 以下：仅走 message_sending、未经 reply_payload 的路径（或伪媒体命令）
      if (
        (promptHint || existingPaths.length > 0 || outboundHasMedia(event) || looksLikeMediaStatusOnly(text))
        && isMediaDeliveryClaimed(event, text, existingPaths, promptHint)
      ) {
        // 已有实体媒体路径 → 渠道投递，放行；纯伪命令重复才 cancel
        if (existingPaths.length > 0 || outboundHasMedia(event)) {
          console.log(`[${PLUGIN_ID}] channel-layer pass media paths (claimed elsewhere)`);
          return;
        }
        const preview = String(text || '').replace(/\s+/g, ' ').slice(0, 100);
        try { api.logger?.info?.(`[${PLUGIN_ID}] cancelled duplicate media outbound: ${preview}`); } catch (_) {}
        console.log(`[${PLUGIN_ID}] cancelled duplicate media outbound: ${preview}`);
        return { cancel: true, cancelReason: 'error-filter:suppress-duplicate-media' };
      }

      const reserve = reserveSessionDrawSlot(event, text, promptHint);
      if (!reserve.ok) {
        if (alreadyMedia || existingPaths.length > 0 || outboundHasMedia(event)) {
          console.log(`[${PLUGIN_ID}] channel-layer pass after reserve deny (delivery gate)`);
          return;
        }
        try { api.logger?.info?.(`[${PLUGIN_ID}] cancelled duplicate media reserve`); } catch (_) {}
        console.log(`[${PLUGIN_ID}] cancelled duplicate media reserve`);
        return { cancel: true, cancelReason: reserve.reason };
      }

      let mediaRewrite = null;
      try {
        mediaRewrite = await maybeRewritePseudoMedia(text);
      } catch (err) {
        if (reserve.reserved) releaseSessionDrawReservation(event);
        throw err;
      }

      if (mediaRewrite) {
        const paths = extractMediaDirectiveUrls(mediaRewrite);
        const claim = claimMediaDelivery(event, mediaRewrite, paths, promptHint);
        if (!claim.ok) {
          if (reserve.reserved) releaseSessionDrawReservation(event);
          // 已有媒体坑：放行渠道发送，勿 cancel
          if (paths.length > 0 || alreadyMedia) {
            console.log(`[${PLUGIN_ID}] channel-layer pass MEDIA rewrite claim deny`);
            return { content: mediaRewrite, metadata: { nexoraPseudoMediaFixed: true } };
          }
          try { api.logger?.info?.(`[${PLUGIN_ID}] cancelled duplicate MEDIA rewrite`); } catch (_) {}
          console.log(`[${PLUGIN_ID}] cancelled duplicate MEDIA rewrite`);
          return { cancel: true, cancelReason: claim.reason };
        }
        try { api.logger?.info?.(`[${PLUGIN_ID}] rewrote pseudo media command to MEDIA reply`); } catch (_) {}
        return { content: mediaRewrite, metadata: { nexoraPseudoMediaFixed: true } };
      }

      if (reserve.reserved) releaseSessionDrawReservation(event);

      if (existingPaths.length > 0 || outboundHasMedia(event)) {
        const claim = claimMediaDelivery(event, text, existingPaths, promptHint);
        if (!claim.ok) {
          // 渠道投递已有媒体：放行
          console.log(`[${PLUGIN_ID}] channel-layer pass native media claim deny`);
          return;
        }
      }

      const silentRewrite = rewriteSilentFailureOutbound(text);
      if (silentRewrite) {
        try { api.logger?.info?.(`[${PLUGIN_ID}] rewrote silent-failure outbound`); } catch (_) {}
        console.log(`[${PLUGIN_ID}] rewrote silent-failure outbound`);
        rememberRunOutbound(event, silentRewrite);
        return { content: silentRewrite };
      }

      if (shouldBlockOutbound(text)) {
        const preview = text.replace(/\s+/g, ' ').slice(0, 100);
        if (needsSessionRollover(text)) {
          // 溢出横幅交给 session-overflow-rollover（在本钩子之后执行）处理；只记冗余信号
          console.log(`[${PLUGIN_ID}] pass overflow banner to rollover plugin: ${preview}`);
          queueOverflowRolloverTrigger(resolveSessionKeyFromHook(event, ctx), preview);
          return;
        }
        try { api.logger?.info?.(`[${PLUGIN_ID}] cancelled outbound: ${preview}`); } catch (_) {}
        console.log(`[${PLUGIN_ID}] cancelled outbound: ${preview}`);
        return { cancel: true, cancelReason: 'error-filter:suppress-warning-banner' };
      }

      // 渠道层：禁止 shouldCancelDuplicateRunOutbound cancel（防微信哑火）
      if (shouldCancelDuplicateRunOutbound(event, text)) {
        const preview = String(text || '').replace(/\s+/g, ' ').slice(0, 100);
        console.log(`[${PLUGIN_ID}] channel-layer skip duplicate cancel (delivery gate): ${preview}`);
        return;
      }

      rememberRunOutbound(event, text);
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

/** @internal smoke / regression tests */
export const __testables = {
  normalizePromptFingerprint,
  pseudoMediaCacheKey,
  isMediaDeliveryClaimed,
  claimMediaDelivery,
  reserveSessionDrawSlot,
  releaseSessionDrawReservation,
  extractDrawPicturePrompt,
  shouldBlockOutbound,
  isNetworkFailureBanner,
  rewriteNetworkFailureOutbound,
  rewriteSilentFailureOutbound,
  NETWORK_FAILURE_USER_NOTICE,
  RATE_LIMIT_USER_NOTICE,
  looksLikeConversationalReply,
  isDiagnosticBannerShaped,
  isSystemDiagnosticBannerOnly,
  needsSessionRollover,
  shouldCancelDuplicateRunOutbound,
  rememberRunOutbound,
  runAlreadyRecordedTextOutbound,
  runAlreadyClaimedMediaOutbound,
  resetMediaDedupeState() {
    recentMediaOutboundByRun.clear();
    recentPromptMediaDelivery.clear();
    recentPathMediaDelivery.clear();
    recentSessionDrawDelivery.clear();
    _drawInflightBySession.clear();
    _pseudoMediaSideEffectCache.clear();
    _pseudoMediaInflight.clear();
    recentTextOutboundByRun.clear();
    recentTextOutboundBySession.clear();
    recentApprovedChannelDeliveryByFp.clear();
  },
  isChannelDeliveryAlreadyApproved,
  markApprovedForChannelDelivery,
  isApprovedForChannelDelivery,
};
