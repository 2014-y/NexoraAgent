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
  // 云端：启动时一次性注入规则即可，总量过大只会每轮拖慢
  bootstrapMaxChars: 2500,
  bootstrapTotalMaxChars: 8000,
  /** 本地模型：尽量少注入，但仍靠更大窗口兜底 */
  smallBootstrapMaxChars: 1200,
  smallBootstrapTotalMaxChars: 2800,
  cloudContextWindowCap: 131072,
  // 压缩预留：云端也不再顶到 20000，否则历史很长才压缩、越聊越慢
  reserveTokensFloor: 8000,
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

  // bootstrap：启动一次性注入；云端若被误标成 small-ctx 过矮，也要抬回云端默认
  const bootMax = smallCtx ? DEFAULTS.smallBootstrapMaxChars : DEFAULTS.bootstrapMaxChars;
  const bootTotal = smallCtx ? DEFAULTS.smallBootstrapTotalMaxChars : DEFAULTS.bootstrapTotalMaxChars;
  const curBoot = Number(ad.bootstrapMaxChars);
  const curTotal = Number(ad.bootstrapTotalMaxChars);
  if (!Number.isFinite(curBoot) || curBoot > bootMax || (!smallCtx && curBoot < bootMax)) {
    const prev = ad.bootstrapMaxChars;
    ad.bootstrapMaxChars = bootMax;
    if (prev !== bootMax) changes.push(`bootstrapMaxChars: ${prev ?? 'unset'} -> ${bootMax}${smallCtx ? ' (small-ctx)' : ''}`);
  }
  if (!Number.isFinite(curTotal) || curTotal > bootTotal || (!smallCtx && curTotal < bootTotal)) {
    const prev = ad.bootstrapTotalMaxChars;
    ad.bootstrapTotalMaxChars = bootTotal;
    if (prev !== bootTotal) changes.push(`bootstrapTotalMaxChars: ${prev ?? 'unset'} -> ${bootTotal}${smallCtx ? ' (small-ctx)' : ''}`);
  }

  // 压缩预留：按窗口自适应（绝不能对 8k 模型写 20000）
  if (!ad.compaction || typeof ad.compaction !== 'object') ad.compaction = {};
  const safeFloor = computeSafeReserveTokensFloor(effectiveCtx);
  const floor = Number(ad.compaction.reserveTokensFloor);
  // 过小或过大（相对窗口）都纠正
  const tooSmall = !Number.isFinite(floor) || floor < Math.min(512, safeFloor);
  const tooLargeForWindow = Number.isFinite(floor) && floor > safeFloor && smallCtx;
  // 云端：保证至少 DEFAULTS.reserveTokensFloor，但若配置更大也往下收到默认（加速压缩）
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
  } else if (tooSmall || !Number.isFinite(floor) || floor > DEFAULTS.reserveTokensFloor) {
    const prev = ad.compaction.reserveTokensFloor;
    ad.compaction.reserveTokensFloor = DEFAULTS.reserveTokensFloor;
    changes.push(`compaction.reserveTokensFloor: ${prev ?? 'unset'} -> ${DEFAULTS.reserveTokensFloor}`);
  } else if (tooLargeForWindow) {
    // unreachable when !smallCtx, kept for clarity
  }

  // contextPruning：云端也裁工具长输出，避免历史里堆满截图/命令结果
  if (!ad.contextPruning || typeof ad.contextPruning !== 'object') ad.contextPruning = {};
  if (!isObject(ad.contextPruning.softTrim)) ad.contextPruning.softTrim = {};
  const st = ad.contextPruning.softTrim;
  const softCap = smallCtx ? 3000 : 6000;
  if (!Number.isFinite(Number(st.maxChars)) || Number(st.maxChars) > softCap) {
    st.maxChars = softCap;
    changes.push(`contextPruning.softTrim.maxChars: -> ${softCap}`);
  }
  if (!isObject(ad.contextPruning.hardClear)) ad.contextPruning.hardClear = {};
  if (ad.contextPruning.hardClear.enabled !== true) {
    ad.contextPruning.hardClear.enabled = true;
    changes.push('contextPruning.hardClear.enabled: -> true');
  }

  if (ad.humanDelay && ad.humanDelay.enabled) {
    ad.humanDelay.enabled = false;
    changes.push('humanDelay.enabled: true -> false');
  }

  // 工具：本地 provider 强制轻量；云端收紧默认 coding 全量工具表（~8k tokens/轮）
  if (!cfg.tools) cfg.tools = {};
  if (!cfg.tools.byProvider) cfg.tools.byProvider = {};
  if (!isObject(cfg.tools.byProvider.ollama)) cfg.tools.byProvider.ollama = {};
  if (cfg.tools.byProvider.ollama.profile !== 'minimal') {
    cfg.tools.byProvider.ollama.profile = 'minimal';
    changes.push('tools.byProvider.ollama.profile: -> minimal');
  }
  if (!Array.isArray(cfg.tools.deny)) cfg.tools.deny = [];
  // 禁用 OpenClaw 核心生图/生视频（常走 Google 且无有效 Key）；统一走 draw_picture / draw_video
  for (const toolName of ['tts', 'browser', 'image_generate', 'video_generate']) {
    if (!cfg.tools.deny.includes(toolName)) {
      cfg.tools.deny.push(toolName);
      changes.push(`tools.deny += ${toolName}`);
    }
  }

  // agnes-ai / ten：profile + alsoAllow 扩权（勿与 allow 同用；allow 会变成交集砍掉桌面工具）
  // 禁止 deny group:plugins（会误杀 draw_*）；改按渠道插件 id 砍 schema
  const cloudToolLean = {
    profile: 'messaging',
    alsoAllow: [
      'group:fs',
      'group:runtime',
      'group:web',
      'memory_search',
      'memory_get',
      'image',
      'draw_picture',
      'draw_video'
    ],
    deny: [
      'sessions_history',
      'sessions_send',
      'sessions_spawn',
      'sessions_yield',
      'subagents',
      'agents_list',
      'canvas',
      'nodes',
      'cron',
      'gateway',
      'tts',
      'browser',
      'image_generate',
      'video_generate',
      'pdf',
      'feishu',
      'qqbot',
      'whatsapp',
      'voice-call',
      'matrix',
      'discord',
      'slack',
      'openclaw-weixin'
    ]
  };
  for (const prov of ['agnes-ai', 'ten']) {
    if (!isObject(cfg.tools.byProvider[prov])) cfg.tools.byProvider[prov] = {};
    const tp = cfg.tools.byProvider[prov];
    if (tp.profile !== cloudToolLean.profile) {
      tp.profile = cloudToolLean.profile;
      changes.push(`tools.byProvider.${prov}.profile: -> ${cloudToolLean.profile}`);
    }
    const alsoKey = JSON.stringify(cloudToolLean.alsoAllow);
    if (JSON.stringify(tp.alsoAllow || []) !== alsoKey) {
      tp.alsoAllow = [...cloudToolLean.alsoAllow];
      changes.push(`tools.byProvider.${prov}.alsoAllow: -> lean desktop set`);
    }
    if (tp.allow) {
      delete tp.allow;
      changes.push(`tools.byProvider.${prov}.allow: removed (use alsoAllow)`);
    }
    const denyKey = JSON.stringify(cloudToolLean.deny);
    if (JSON.stringify(tp.deny || []) !== denyKey) {
      tp.deny = [...cloudToolLean.deny];
      changes.push(`tools.byProvider.${prov}.deny: -> channel-plugin lean`);
    }
  }

  // 防止工具轮询把对话拖死
  if (!isObject(cfg.tools.loopDetection)) cfg.tools.loopDetection = {};
  if (cfg.tools.loopDetection.enabled !== true) {
    cfg.tools.loopDetection.enabled = true;
    changes.push('tools.loopDetection.enabled: -> true');
  }

  // Skills 目录默认把几十个 skill 塞进 system prompt（~3–4k tokens）；硬顶字数
  if (!cfg.skills || typeof cfg.skills !== 'object') cfg.skills = {};
  if (!isObject(cfg.skills.limits)) cfg.skills.limits = {};
  const maxSkillChars = Number(cfg.skills.limits.maxSkillsPromptChars);
  if (!Number.isFinite(maxSkillChars) || maxSkillChars > 3000) {
    cfg.skills.limits.maxSkillsPromptChars = 3000;
    changes.push('skills.limits.maxSkillsPromptChars: -> 3000');
  }

  // 云端总超时：生图/生视频轮询常要几分钟；过短会报 Request timed out
  if (!cfg.agents) cfg.agents = {};
  if (!isObject(cfg.agents.defaults)) cfg.agents.defaults = {};
  const timeoutSec = Number(cfg.agents.defaults.timeoutSeconds);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 300) {
    cfg.agents.defaults.timeoutSeconds = 600;
    changes.push('agents.defaults.timeoutSeconds: -> 600');
  }

  // 生视频轮询最长约 10 分钟；默认 stuckSessionAbort≈6min 会误杀 draw_video
  if (!isObject(cfg.diagnostics)) cfg.diagnostics = {};
  const diag = cfg.diagnostics;
  const stuckWarnMs = Number(diag.stuckSessionWarnMs);
  if (!Number.isFinite(stuckWarnMs) || stuckWarnMs < 300000) {
    diag.stuckSessionWarnMs = 300000;
    changes.push('diagnostics.stuckSessionWarnMs: -> 300000');
  }
  const stuckAbortMs = Number(diag.stuckSessionAbortMs);
  if (!Number.isFinite(stuckAbortMs) || stuckAbortMs < 900000) {
    diag.stuckSessionAbortMs = 900000;
    changes.push('diagnostics.stuckSessionAbortMs: -> 900000');
  }
  // 同步抬高 agnes-ai 请求超时，避免工具跑着模型侧先 idle Abort
  if (isObject(cfg.models) && isObject(cfg.models.providers) && isObject(cfg.models.providers['agnes-ai'])) {
    const prov = cfg.models.providers['agnes-ai'];
    const pt = Number(prov.timeoutSeconds);
    if (!Number.isFinite(pt) || pt < 300) {
      prov.timeoutSeconds = 600;
      changes.push('models.providers.agnes-ai.timeoutSeconds: -> 600');
    }
  }
  if (isObject(cfg.models) && isObject(cfg.models.providers) && isObject(cfg.models.providers.ten)) {
    const prov = cfg.models.providers.ten;
    const pt = Number(prov.timeoutSeconds);
    if (!Number.isFinite(pt) || pt < 300) {
      prov.timeoutSeconds = 600;
      changes.push('models.providers.ten.timeoutSeconds: -> 600');
    }
  }

  // 未绑定渠道插件默认关掉，减少工具 schema 体积（用户启用通讯时再开）
  if (!cfg.plugins) cfg.plugins = {};
  if (!cfg.plugins.entries) cfg.plugins.entries = {};
  for (const idle of ['slack', 'whatsapp', 'matrix', 'voice-call']) {
    if (!isObject(cfg.plugins.entries[idle])) continue;
    if (cfg.plugins.entries[idle].enabled !== false) {
      cfg.plugins.entries[idle].enabled = false;
      changes.push(`plugins.entries.${idle}.enabled: -> false`);
    }
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
