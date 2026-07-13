'use strict';
/**
 * 回复延迟收紧：纠正会把每轮对话拖慢的默认值。
 * 特别针对：
 * - 微信 inbound.debounceMs 过大（用户感觉“发了很久没动静”）
 * - Ollama contextWindow / num_ctx 过大（本机模型首 token 极慢）
 * - bootstrap 注入过大（每次请求塞几十 KB 人设/记忆）
 * - 本地 maxTokens 过大（生成拖尾很长）
 */

const DEFAULTS = {
  weixinDebounceMs: 500,
  ollamaContextWindow: 8192,
  ollamaNumCtx: 8192,
  ollamaMaxTokens: 1024,
  bootstrapMaxChars: 8000,
  bootstrapTotalMaxChars: 24000,
  cloudContextWindowCap: 131072
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function ensureLatencySafeConfig(config, opts = {}) {
  if (!isObject(config)) return { config, changed: false, changes: [] };
  const changes = [];
  const cfg = config;
  const ollamaCtx = Number(opts.ollamaContextWindow) || DEFAULTS.ollamaContextWindow;
  const ollamaNumCtx = Number(opts.ollamaNumCtx) || DEFAULTS.ollamaNumCtx;
  const ollamaMaxTokens = Number(opts.ollamaMaxTokens) || DEFAULTS.ollamaMaxTokens;

  // 1) 微信防抖：默认 2000ms 体感很慢，收到消息先干等 2 秒
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels['openclaw-weixin']) cfg.channels['openclaw-weixin'] = {};
  const wx = cfg.channels['openclaw-weixin'];
  if (!wx.inbound) wx.inbound = {};
  const debounce = Number(wx.inbound.debounceMs);
  if (!Number.isFinite(debounce) || debounce > DEFAULTS.weixinDebounceMs) {
    const prev = wx.inbound.debounceMs;
    wx.inbound.debounceMs = DEFAULTS.weixinDebounceMs;
    changes.push(`weixin.debounceMs: ${prev ?? 'unset'} -> ${DEFAULTS.weixinDebounceMs}`);
  }

  // 2) agents bootstrap 注入裁剪
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};
  const ad = cfg.agents.defaults;
  if (!Number.isFinite(Number(ad.bootstrapMaxChars)) || Number(ad.bootstrapMaxChars) > DEFAULTS.bootstrapMaxChars) {
    const prev = ad.bootstrapMaxChars;
    ad.bootstrapMaxChars = DEFAULTS.bootstrapMaxChars;
    changes.push(`bootstrapMaxChars: ${prev ?? 'unset'} -> ${DEFAULTS.bootstrapMaxChars}`);
  }
  if (!Number.isFinite(Number(ad.bootstrapTotalMaxChars)) || Number(ad.bootstrapTotalMaxChars) > DEFAULTS.bootstrapTotalMaxChars) {
    const prev = ad.bootstrapTotalMaxChars;
    ad.bootstrapTotalMaxChars = DEFAULTS.bootstrapTotalMaxChars;
    changes.push(`bootstrapTotalMaxChars: ${prev ?? 'unset'} -> ${DEFAULTS.bootstrapTotalMaxChars}`);
  }

  // 关闭人工延迟（如果被打开会感觉「一句话都要等一下」）
  if (ad.humanDelay && ad.humanDelay.enabled) {
    ad.humanDelay.enabled = false;
    changes.push('humanDelay.enabled: true -> false');
  }

  // 3) Ollama / 本地模型：硬砍夸张 contextWindow，并强制 num_ctx + 关闭 thinking
  if (!cfg.models) cfg.models = {};
  if (!cfg.models.providers) cfg.models.providers = {};
  const providers = cfg.models.providers;

  if (isObject(providers.ollama) && Array.isArray(providers.ollama.models)) {
    // OpenAI-compat 路径会用 contextWindow 注入 options.num_ctx；过大就会卡死首 token
    if (providers.ollama.api !== 'ollama' && providers.ollama.baseUrl && String(providers.ollama.baseUrl).includes('11434')) {
      // keep as-is, but still cap models
    }
    for (const model of providers.ollama.models) {
      if (!isObject(model)) continue;
      const id = model.id || model.name || 'unknown';
      if (!Number.isFinite(Number(model.contextWindow)) || Number(model.contextWindow) > ollamaCtx) {
        const prev = model.contextWindow;
        model.contextWindow = ollamaCtx;
        changes.push(`ollama/${id}.contextWindow: ${prev ?? 'unset'} -> ${ollamaCtx}`);
      }
      if (!Number.isFinite(Number(model.maxTokens)) || Number(model.maxTokens) > ollamaMaxTokens) {
        const prev = model.maxTokens;
        model.maxTokens = ollamaMaxTokens;
        changes.push(`ollama/${id}.maxTokens: ${prev ?? 'unset'} -> ${ollamaMaxTokens}`);
      }
      if (!isObject(model.params)) model.params = {};
      if (!Number.isFinite(Number(model.params.num_ctx)) || Number(model.params.num_ctx) > ollamaNumCtx) {
        const prev = model.params.num_ctx;
        model.params.num_ctx = ollamaNumCtx;
        changes.push(`ollama/${id}.params.num_ctx: ${prev ?? 'unset'} -> ${ollamaNumCtx}`);
      }
      if (model.params.thinking !== false) {
        model.params.thinking = false;
        changes.push(`ollama/${id}.params.thinking: -> false`);
      }
      if (!isObject(model.compat)) model.compat = {};
      if (model.compat.supportsTools !== false) {
        model.compat.supportsTools = false;
        changes.push(`ollama/${id}.compat.supportsTools: -> false`);
      }
    }
  }

  // 4) 云端模型：只降 OpenClaw 侧预算上限，避免一次塞百万级上下文
  for (const [provId, prov] of Object.entries(providers)) {
    if (provId === 'ollama' || !isObject(prov) || !Array.isArray(prov.models)) continue;
    for (const model of prov.models) {
      if (!isObject(model)) continue;
      if (Number(model.contextWindow) > DEFAULTS.cloudContextWindowCap) {
        const prev = model.contextWindow;
        model.contextWindow = DEFAULTS.cloudContextWindowCap;
        changes.push(`${provId}/${model.id || '?'}.contextWindow: ${prev} -> ${DEFAULTS.cloudContextWindowCap}`);
      }
    }
  }

  // 5) 工具：本地 provider 强制轻量
  if (!cfg.tools) cfg.tools = {};
  if (!cfg.tools.byProvider) cfg.tools.byProvider = {};
  if (!isObject(cfg.tools.byProvider.ollama)) cfg.tools.byProvider.ollama = {};
  if (cfg.tools.byProvider.ollama.profile !== 'minimal') {
    cfg.tools.byProvider.ollama.profile = 'minimal';
    changes.push('tools.byProvider.ollama.profile: -> minimal');
  }
  if (!Array.isArray(cfg.tools.deny)) cfg.tools.deny = [];
  if (!cfg.tools.deny.includes('tts')) {
    cfg.tools.deny.push('tts');
    changes.push('tools.deny += tts');
  }

  // 6) 双模型教学默认不打断主链路；teach-learn / 未显式配置时都落到 collect-only
  if (!cfg.plugins) cfg.plugins = {};
  if (!cfg.plugins.entries) cfg.plugins.entries = {};
  if (!isObject(cfg.plugins.entries['dual-model-trainer'])) {
    cfg.plugins.entries['dual-model-trainer'] = { enabled: true };
  }
  const dmt = cfg.plugins.entries['dual-model-trainer'];
  if (!isObject(dmt.config)) dmt.config = {};
  // teach-learn 会额外打老师/学生，抢 GPU；改成 collect-only，不阻塞回复
  if (!dmt.config.mode || dmt.config.mode === 'teach-learn') {
    const prev = dmt.config.mode;
    dmt.config.mode = 'collect-only';
    changes.push(`dual-model-trainer.mode: ${prev ?? 'unset'} -> collect-only`);
  }
  if (dmt.config.enableTeachLearn !== false) {
    dmt.config.enableTeachLearn = false;
    changes.push('dual-model-trainer.enableTeachLearn: -> false');
  }
  if (dmt.config.timeoutMs == null || Number(dmt.config.timeoutMs) > 20000) {
    dmt.config.timeoutMs = 20000;
    changes.push('dual-model-trainer.timeoutMs: -> 20000');
  }

  return { config: cfg, changed: changes.length > 0, changes };
}

module.exports = {
  DEFAULTS,
  ensureLatencySafeConfig
};
