/**
 * voice-bridge — 渠道 AI 最终回复 → Nexora 本机离线 TTS
 * 不拦截、不改写回复文本，渠道侧仍正常文字回传。
 *
 * 注意：不要 import 'openclaw/...' —— 网关 cwd 在 ~/.openclaw 时 ESM 解析不到该包，
 * 会导致插件静默加载失败。直接导出 OpenClaw 认可的插件对象即可。
 */

import http from 'node:http';

const PLUGIN_ID = 'voice-bridge';
const DEFAULT_PORT = 18791;
const MAX_LEN = 500;
const DEDUPE_MS = 12000;

function sanitize(text) {
  let s = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN) + '…';
  return s;
}

function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        return '';
      })
      .join('');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return '';
}

function extractLastAssistantText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    const text = extractAssistantText(msg.content);
    if (text && text.trim()) return text;
  }
  return '';
}

function shouldSkipText(text) {
  const s = String(text || '').trim();
  if (!s || s.length < 2) return true;
  if (s === 'HEARTBEAT_OK') return true;
  if (/^NO_REPLY$/i.test(s)) return true;
  return false;
}

function shouldSkipSession(sessionKey, ctx) {
  const key = String(sessionKey || (ctx && ctx.sessionKey) || '');
  if (/:cron:|:heartbeat/i.test(key)) return true;
  const trigger = String((ctx && (ctx.trigger || ctx.jobId)) || '');
  if (/cron|heartbeat/i.test(trigger)) return true;
  return false;
}

function postSpeak(port, text, meta) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      text,
      source: 'channel',
      channel: meta && meta.channel,
      sessionKey: meta && meta.sessionKey
    });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: port || DEFAULT_PORT,
        path: '/voice/speak',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 2500
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: raw }));
      }
    );
    req.on('error', (err) => resolve({ ok: false, error: err && err.message }));
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) {}
      resolve({ ok: false, error: 'timeout' });
    });
    req.write(body);
    req.end();
  });
}

function register(api) {
  const cfg = (api && (api.pluginConfig || api.config)) || {};
  const port = Number(cfg.httpPort) || DEFAULT_PORT;
  const log = (api && api.logger) || console;
  let lastSpoken = { text: '', at: 0 };

  const forward = async (rawText, meta) => {
    try {
      if (cfg.enabled === false) return;
      if (shouldSkipSession(meta && meta.sessionKey, meta && meta.ctx)) return;
      const text = sanitize(rawText);
      if (shouldSkipText(text)) return;
      const now = Date.now();
      if (text === lastSpoken.text && now - lastSpoken.at < DEDUPE_MS) return;
      lastSpoken = { text, at: now };
      const result = await postSpeak(port, text, meta);
      if (result.ok) {
        console.log(`[${PLUGIN_ID}] spoke (${meta && meta.via}): ${text.slice(0, 60)}`);
      } else {
        console.warn(
          `[${PLUGIN_ID}] speak failed (${meta && meta.via}): ${result.error || result.status || 'unknown'}`
        );
      }
    } catch (e) {
      console.warn(`[${PLUGIN_ID}] forward error: ${e && e.message ? e.message : e}`);
    }
  };

  console.log(`[${PLUGIN_ID}] loaded (port=${port})`);

  api.on('message_sent', async (event, ctx) => {
    if (!event || event.success === false) return;
    await forward(event.content, {
      via: 'message_sent',
      channel: ctx && (ctx.channelId || ctx.channel),
      sessionKey: (event && event.sessionKey) || (ctx && ctx.sessionKey),
      ctx
    });
  });

  api.on('agent_end', async (event, ctx) => {
    if (!event || event.success === false) return;
    const sessionKey = (ctx && ctx.sessionKey) || '';
    if (shouldSkipSession(sessionKey, ctx)) return;
    const channel = ctx && (ctx.channel || ctx.channelId || ctx.messageProvider);
    const text = extractLastAssistantText(event.messages);
    await forward(text, {
      via: 'agent_end',
      channel,
      sessionKey,
      ctx
    });
  });

  api.on('llm_output', async (event, ctx) => {
    if (!event) return;
    const sessionKey = (ctx && ctx.sessionKey) || (event && event.sessionId) || '';
    if (shouldSkipSession(sessionKey, ctx)) return;
    const texts = Array.isArray(event.assistantTexts) ? event.assistantTexts : [];
    const text = texts.filter((t) => typeof t === 'string' && t.trim()).join('\n');
    if (!text) return;
    await forward(text, {
      via: 'llm_output',
      channel: ctx && (ctx.channel || ctx.channelId || ctx.messageProvider),
      sessionKey,
      ctx
    });
  });
}

export default {
  id: PLUGIN_ID,
  name: 'Voice Bridge',
  description: '将渠道 AI 文字回复转发到 Nexora Agent 本机离线朗读（不改变渠道文字回传）',
  register
};
