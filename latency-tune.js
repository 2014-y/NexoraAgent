'use strict';
/**
 * 回复延迟收紧 + 小上下文模型压缩安全：
 * - 微信 debounce / bootstrap 过大
 * - Ollama contextWindow / num_ctx 过大
 * - 本地小模型：reserveTokensFloor=20000 会远超 8k 窗口，导致
 *   「Auto-compaction could not recover this turn」——必须按窗口自适应
 */
const DEFAULTS = {
  weixinDebounceMs: 500,
  /**
   * 实测：OpenClaw 系统提示+workspace 空会话就约 6500+ tokens。
   * 8192 窗 + reserve≈4096 → 提示预算仅 4096，必触发 compaction 失败。
   * 16384 才能给提示留出余量；再大拖慢首 token，不默认更高。
   */
  ollamaContextWindow: 16384,
  ollamaNumCtx: 16384,
  ollamaMaxTokens: 1024,
  bootstrapMaxChars: 8000,
  bootstrapTotalMaxChars: 24000,
  /** 本地模型：尽量少注入，但仍靠更大窗口兜底 */
  smallBootstrapMaxChars: 1200,
  smallBootstrapTotalMaxChars: 2800,
  cloudContextWindowCap: 131072,
  reserveTokensFloor: 20000,
  /** 小于等于此窗口视为「小上下文」——用自适应 floor + 短 bootstrap */
  smallContextThreshold: 24576
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** 从配置推断有效上下文窗口（优先主模型，其次 ollama 最小值） */
function resolveEffectiveContextWindow(cfg) {
  const providers = cfg && cfg.models && cfg.models.providers;
  if (!isObject(providers)) return null;

  let primaryCtx = null;
  const primaryRaw = cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model
    && (typeof cfg.agents.defaults.model === 'string'
      ? cfg.agents.defaults.model
      : cfg.agents.defaults.model.primary);
  if (typeof primaryRaw === 'string' && primaryRaw.includes('/')) {
    const slash = primaryRaw.indexOf('/');
    const provId = primaryRaw.slice(0, slash);
    const modelId = primaryRaw.slice(slash + 1);
    const prov = providers[provId];
    if (isObject(prov) && Array.isArray(prov.models)) {
      const hit = prov.models.find((m) => m && (m.id === modelId || m.name === modelId));
      if (hit && Number.isFinite(Number(hit.contextWindow))) {
        primaryCtx = Number(hit.contextWindow);
      }
    }
  }

  let ollamaMin = null;
  if (isObject(providers.ollama) && Array.isArray(providers.ollama.models)) {
    for (const model of providers.ollama.models) {
      if (!isObject(model)) continue;
      const w = Number(model.contextWindow);
      if (Number.isFinite(w) && w > 0) {
        ollamaMin = ollamaMin == null ? w : Math.min(ollamaMin, w);
      }
    }
  }

  if (primaryCtx != null) return primaryCtx;
  if (ollamaMin != null) return ollamaMin;
  return null;
}

/**
 * 按上下文窗口算安全的 reserveTokensFloor。
 * 规则：约 20% 窗口，且不超过 窗口 - 2048（给提示词留空间），云端大窗仍可用 20000。
 */
function computeSafeReserveTokensFloor(contextWindow) {
  const ctx = Number(contextWindow);
  if (!Number.isFinite(ctx) || ctx <= 0) return DEFAULTS.reserveTokensFloor;
  if (ctx >= 100000) return DEFAULTS.reserveTokensFloor;
  // 小窗口：floor 绝不能接近或超过整个窗口
  const byRatio = Math.floor(ctx * 0.2);
  const byHeadroom = Math.max(512, ctx - 2048);
  return Math.max(512, Math.min(byRatio, byHeadroom, 4096));
}

function ensureLatencySafeConfig(config, opts = {}) {
  if (!isObject(config)) return { config, changed: false, changes: [] };
  const changes = [];
  const cfg = config;
  const ollamaCtx = Number(opts.ollamaContextWindow) || DEFAULTS.ollamaContextWindow;
  const ollamaNumCtx = Number(opts.ollamaNumCtx) || DEFAULTS.ollamaNumCtx;
  const ollamaMaxTokens = Number(opts.ollamaMaxTokens) || DEFAULTS.ollamaMaxTokens;

  // 1) 微信防抖
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

  // 2) agents defaults
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.defaults) cfg.agents.defaults = {};
  const ad = cfg.agents.defaults;

  // 3) 先收紧 ollama 窗口（后面按有效窗口算 compaction）
  if (!cfg.models) cfg.models = {};
  if (!cfg.models.providers) cfg.models.providers = {};
  const providers = cfg.models.providers;

  if (isObject(providers.ollama) && Array.isArray(providers.ollama.models)) {
    for (const model of providers.ollama.models) {
      if (!isObject(model)) continue;
      const id = model.id || model.name || 'unknown';
      // 强制钉在目标窗口：过小会 compaction 必挂，过大首 token 极慢
      if (!Number.isFinite(Number(model.contextWindow)) || Number(model.contextWindow) !== ollamaCtx) {
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
      if (!Number.isFinite(Number(model.params.num_ctx)) || Number(model.params.num_ctx) !== ollamaNumCtx) {
        const prev = model.params.num_ctx;
        model.params.num_ctx = ollamaNumCtx;
        changes.push(`ollama/${id}.params.num_ctx: ${prev ?? 'unset'} -> ${ollamaNumCtx}`);
      }
      if (model.params.thinking !== false) {
        model.params.thinking = false;
        changes.push(`ollama/${id}.params.thinking: -> false`);
      }
      // 关掉 thinking 档位（日志出现 thinking=medium 时会额外吃 token）
      if (model.params.think != null && model.params.think !== false) {
        model.params.think = false;
        changes.push(`ollama/${id}.params.think: -> false`);
      }
      if (!isObject(model.compat)) model.compat = {};
      if (model.compat.supportsTools !== false) {
        model.compat.supportsTools = false;
        changes.push(`ollama/${id}.compat.supportsTools: -> false`);
      }
    }
  }

  // agents.defaults 上的 thinking 也会覆盖模型级设置
  if (ad.thinkingDefault && ad.thinkingDefault !== 'off') {
    const prev = ad.thinkingDefault;
    ad.thinkingDefault = 'off';
    changes.push(`agents.defaults.thinkingDefault: ${prev} -> off`);
  }
  if (ad.thinking !== undefined && ad.thinking !== false && ad.thinking !== 'off') {
    const prev = ad.thinking;
    ad.thinking = 'off';
    changes.push(`agents.defaults.thinking: ${prev} -> off`);
  }

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

  const effectiveCtx = resolveEffectiveContextWindow(cfg) || ollamaCtx;
  const smallCtx = effectiveCtx <= DEFAULTS.smallContextThreshold;

  // bootstrap：小窗口必须砍，否则 AGENTS.md 一注入就超窗
  const bootMax = smallCtx ? DEFAULTS.smallBootstrapMaxChars : DEFAULTS.bootstrapMaxChars;
  const bootTotal = smallCtx ? DEFAULTS.smallBootstrapTotalMaxChars : DEFAULTS.bootstrapTotalMaxChars;
  if (!Number.isFinite(Number(ad.bootstrapMaxChars)) || Number(ad.bootstrapMaxChars) > bootMax) {
    const prev = ad.bootstrapMaxChars;
    ad.bootstrapMaxChars = bootMax;
    changes.push(`bootstrapMaxChars: ${prev ?? 'unset'} -> ${bootMax}${smallCtx ? ' (small-ctx)' : ''}`);
  }
  if (!Number.isFinite(Number(ad.bootstrapTotalMaxChars)) || Number(ad.bootstrapTotalMaxChars) > bootTotal) {
    const prev = ad.bootstrapTotalMaxChars;
    ad.bootstrapTotalMaxChars = bootTotal;
    changes.push(`bootstrapTotalMaxChars: ${prev ?? 'unset'} -> ${bootTotal}${smallCtx ? ' (small-ctx)' : ''}`);
  }

  // 压缩预留：按窗口自适应（绝不能对 8k 模型写 20000）
  if (!ad.compaction || typeof ad.compaction !== 'object') ad.compaction = {};
  const safeFloor = computeSafeReserveTokensFloor(effectiveCtx);
  const floor = Number(ad.compaction.reserveTokensFloor);
  // 过小或过大（相对窗口）都纠正
  const tooSmall = !Number.isFinite(floor) || floor < Math.min(512, safeFloor);
  const tooLargeForWindow = Number.isFinite(floor) && floor > safeFloor && smallCtx;
  // 云端：仍保证至少 20000；小窗：强制落到 safeFloor
  if (smallCtx) {
    if (!Number.isFinite(floor) || floor !== safeFloor) {
      const prev = ad.compaction.reserveTokensFloor;
      ad.compaction.reserveTokensFloor = safeFloor;
      changes.push(`compaction.reserveTokensFloor: ${prev ?? 'unset'} -> ${safeFloor} (ctx=${effectiveCtx})`);
    }
    if (ad.compaction.maxHistoryShare == null || Number(ad.compaction.maxHistoryShare) > 0.45) {
      const prev = ad.compaction.maxHistoryShare;
      ad.compaction.maxHistoryShare = 0.4;
      changes.push(`compaction.maxHistoryShare: ${prev ?? 'unset'} -> 0.4`);
    }
    if (ad.compaction.mode !== 'safeguard') {
      ad.compaction.mode = 'safeguard';
      changes.push('compaction.mode: -> safeguard');
    }
    if (!isObject(ad.compaction.qualityGuard)) ad.compaction.qualityGuard = {};
    if (ad.compaction.qualityGuard.enabled !== true) {
      ad.compaction.qualityGuard.enabled = true;
      changes.push('compaction.qualityGuard.enabled: -> true');
    }
    const retries = Number(ad.compaction.qualityGuard.maxRetries);
    if (!Number.isFinite(retries) || retries < 1) {
      ad.compaction.qualityGuard.maxRetries = 2;
      changes.push('compaction.qualityGuard.maxRetries: -> 2');
    }
  } else if (tooSmall || !Number.isFinite(floor) || floor < DEFAULTS.reserveTokensFloor) {
    const prev = ad.compaction.reserveTokensFloor;
    ad.compaction.reserveTokensFloor = DEFAULTS.reserveTokensFloor;
    changes.push(`compaction.reserveTokensFloor: ${prev ?? 'unset'} -> ${DEFAULTS.reserveTokensFloor}`);
  } else if (tooLargeForWindow) {
    // unreachable when !smallCtx, kept for clarity
  }

  // contextPruning：小窗口强制软裁剪工具输出
  if (smallCtx) {
    if (!ad.contextPruning || typeof ad.contextPruning !== 'object') ad.contextPruning = {};
    if (!isObject(ad.contextPruning.softTrim)) ad.contextPruning.softTrim = {};
    const st = ad.contextPruning.softTrim;
    if (!Number.isFinite(Number(st.maxChars)) || Number(st.maxChars) > 4000) {
      st.maxChars = 3000;
      changes.push('contextPruning.softTrim.maxChars: -> 3000');
    }
    if (!isObject(ad.contextPruning.hardClear)) ad.contextPruning.hardClear = {};
    if (ad.contextPruning.hardClear.enabled !== true) {
      ad.contextPruning.hardClear.enabled = true;
      changes.push('contextPruning.hardClear.enabled: -> true');
    }
  }

  if (ad.humanDelay && ad.humanDelay.enabled) {
    ad.humanDelay.enabled = false;
    changes.push('humanDelay.enabled: true -> false');
  }

  // 工具：本地 provider 强制轻量
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

  // 双模型教学默认不打断主链路
  if (!cfg.plugins) cfg.plugins = {};
  if (!cfg.plugins.entries) cfg.plugins.entries = {};
  if (!isObject(cfg.plugins.entries['dual-model-trainer'])) {
    cfg.plugins.entries['dual-model-trainer'] = { enabled: true };
  }
  const dmt = cfg.plugins.entries['dual-model-trainer'];
  if (!isObject(dmt.config)) dmt.config = {};
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
  ensureLatencySafeConfig,
  resolveEffectiveContextWindow,
  computeSafeReserveTokensFloor
};
