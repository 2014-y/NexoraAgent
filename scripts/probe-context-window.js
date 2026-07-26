'use strict';
/**
 * 上下文窗口实测校准（上游 /v1/models 不提供 context_length 时的替代方案）
 *
 * 原理（两法并用，不靠「问模型」——模型对自己的部署参数没有可靠认知）：
 *  1) 报错探测：发超过目标长度的请求；OpenAI 系网关拒绝时错误信息里通常带
 *     "maximum context length is N tokens"，从报错解析精确真值（被拒请求一般不计费）
 *  2) 标记回忆探测：在长填充文本【开头】埋随机标记让模型复述；上游静默截断（截头）
 *     时模型必然答不出 → 能答出才证明窗口真的 ≥ 该长度（此路径按输入计费！）
 *
 * 用法：
 *   node scripts/probe-context-window.js --provider agnes-ai --model agnes-2.0-flash
 *   node scripts/probe-context-window.js --provider agnes-ai --model agnes-2.0-flash --target 140000
 *   node scripts/probe-context-window.js ... --deep --yes   # 逐级探到 1M（会产生真实计费，必须 --yes）
 *
 * key 解析顺序：openclaw.json env.<PROVIDER>_API_KEY（如 AGNES_AI_API_KEY）→ provider.apiKey
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const args = process.argv.slice(2);
function argVal(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
}
const hasFlag = (name) => args.includes('--' + name);

const PROVIDER = argVal('provider', 'agnes-ai');
const MODEL = argVal('model', '');
const TARGET = Number(argVal('target', 140000)); // 默认探「是否 ≥ 131072 封顶值」
const DEEP_LEVELS = [140000, 210000, 270000, 530000, 1050000];
/** 粗略 token 估算：填充用英文单词 "probe "，约 1.25 token/词 */
const TOKENS_PER_FILLER_WORD = 1.25;

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR
    || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.openclaw');
}

function loadConfig() {
  const p = path.join(stateDir(), 'openclaw.json');
  return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
}

function resolveKey(cfg, providerId, prov) {
  const envName = providerId.toUpperCase().replace(/-/g, '_') + '_API_KEY';
  const fromEnvBlock = cfg.env && cfg.env[envName];
  return String(fromEnvBlock || prov.apiKey || process.env[envName] || '').trim();
}

function buildOversizedMessages(targetTokens) {
  const marker = 'MARKER-' + crypto.randomBytes(6).toString('hex');
  const fillerWords = Math.ceil(targetTokens / TOKENS_PER_FILLER_WORD);
  const filler = 'probe '.repeat(fillerWords);
  return {
    marker,
    messages: [
      {
        role: 'user',
        content:
          `记住这个标记：${marker}\n` +
          `下面是无意义的填充文本，请忽略其内容：\n${filler}\n` +
          `填充结束。现在请只回复最开头让你记住的那个标记（MARKER- 开头），不要任何其它文字。`,
      },
    ],
  };
}

function parseMaxFromError(text) {
  const t = String(text || '');
  const m =
    t.match(/maximum context length is[^\d]{0,10}(\d{4,9})/i) ||
    t.match(/context[_\s-]?(?:length|window)[^\d]{0,20}(\d{4,9})/i) ||
    t.match(/(\d{4,9})\s*tokens?[^\n]{0,40}(?:maximum|limit|exceed)/i);
  return m ? Number(m[1]) : null;
}

/** 不依赖全局 fetch（老 node 也能跑）：https/http 模块直发 */
function httpPostJson(urlStr, key, bodyObj) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return resolve({ status: 0, text: 'bad url: ' + urlStr });
    }
    const body = JSON.stringify(bodyObj);
    const mod = url.protocol === 'http:' ? require('http') : require('https');
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 120000,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode || 0, text: buf }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout(120s)')); });
    req.on('error', (e) => resolve({ status: 0, text: String((e && e.message) || e) }));
    req.write(body);
    req.end();
  });
}

async function probeLevel(baseUrl, key, model, targetTokens) {
  const { marker, messages } = buildOversizedMessages(targetTokens);
  const t0 = Date.now();
  const res = await httpPostJson(
    String(baseUrl || '').replace(/\/$/, '') + '/chat/completions',
    key,
    { model, messages, max_tokens: 32, temperature: 0 }
  );
  const ms = Date.now() - t0;
  if (res.status === 0) return { level: targetTokens, outcome: 'network-error', detail: res.text };
  if (res.status >= 400) {
    const max = parseMaxFromError(res.text);
    if (max) return { level: targetTokens, outcome: 'rejected-with-limit', limit: max, ms };
    return { level: targetTokens, outcome: 'rejected', status: res.status, detail: res.text.slice(0, 300), ms };
  }
  let reply = '';
  try {
    const j = JSON.parse(res.text);
    reply = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
  } catch (e) {}
  const recalled = reply.includes(marker);
  return {
    level: targetTokens,
    outcome: recalled ? 'accepted-recalled' : 'accepted-truncated',
    reply: reply.slice(0, 120),
    ms,
  };
}

(async () => {
  const cfg = loadConfig();
  const prov = cfg.models && cfg.models.providers && cfg.models.providers[PROVIDER];
  if (!prov) {
    console.error(`provider "${PROVIDER}" 不在 openclaw.json models.providers 里`);
    process.exit(1);
  }
  const key = resolveKey(cfg, PROVIDER, prov);
  if (!key) {
    console.error('找不到 API key（env 块与 provider.apiKey 均为空）');
    process.exit(1);
  }
  const models = MODEL
    ? [MODEL]
    : (prov.models || []).filter((m) => m && m.id && !/image|video|audio|tts/i.test(m.id)).map((m) => m.id);
  if (!models.length) {
    console.error('没有可探测的文本模型');
    process.exit(1);
  }

  const levels = hasFlag('deep') ? DEEP_LEVELS : [TARGET];
  const maxLevel = Math.max(...levels);
  if (maxLevel > 150000 && !hasFlag('yes')) {
    console.error(
      `探测层级最高 ${maxLevel} tokens。若上游「接受并静默截断」，该请求会按输入 token 实际计费。\n` +
      `确认继续请加 --yes`
    );
    process.exit(1);
  }

  for (const model of models) {
    console.log(`\n=== ${PROVIDER}/${model} ===`);
    const declared = ((prov.models || []).find((m) => m && m.id === model) || {}).contextWindow;
    console.log(`本地声明 contextWindow: ${declared ?? '(未声明)'}`);
    for (const level of levels) {
      const r = await probeLevel(prov.baseUrl, key, model, level);
      if (r.outcome === 'rejected-with-limit') {
        console.log(`  探测 ${level}: 上游拒绝并声明上限 = ${r.limit} tokens ← 权威真值，照此配置`);
        break;
      } else if (r.outcome === 'accepted-recalled') {
        console.log(`  探测 ${level}: 接受且开头标记可回忆 → 真实窗口 ≥ ${level} (${r.ms}ms)`);
      } else if (r.outcome === 'accepted-truncated') {
        console.log(`  探测 ${level}: 接受但开头标记丢失 → 静默截断，真实有效窗口 < ${level}；声明值不可高于此`);
        break;
      } else if (r.outcome === 'rejected') {
        console.log(`  探测 ${level}: 拒绝(HTTP ${r.status})但未声明上限：${(r.detail || '').replace(/\s+/g, ' ')}`);
        break;
      } else {
        console.log(`  探测 ${level}: 网络错误 ${r.detail}`);
        break;
      }
    }
  }
  console.log(
    '\n提示：把测得的真值写进 openclaw.json 对应模型的 contextWindow；' +
    '超过 131072 时还需设置 NEXORA_CLOUD_CTX_CAP 放宽封顶（注意成本与压缩时长会随之上升）。'
  );
})();
