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
  /** 云端模型窗口硬上限（成本+压缩时长的安全阀）。默认放到 2M，只挡异常大的值，不再一刀切压到 128k。
   *  用 NEXORA_CLOUD_CTX_CAP 可自定义（比如想省成本就调小）。真实窗口由 inferCloudContextWindow 自适应推断。 */
  cloudContextWindowCap:
    Number(process.env.NEXORA_CLOUD_CTX_CAP) > 0 ? Number(process.env.NEXORA_CLOUD_CTX_CAP) : 2097152,
  // 云端大窗：预留足够压缩缓冲，尽早触发压缩，避免撑到 overflow 后 120s 超时
  reserveTokensFloor: 8000,
  /** 大上下文云端模型的主动压缩地板（勿再压回 8000） */
  cloudReserveTokensFloor: 35000,
  /** 小于等于此窗口视为「小上下文」——用自适应 floor + 短 bootstrap */
  smallContextThreshold: 24576
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 从模型 ID 自适应推断上下文窗口（面向未来模型：按厂商/系列 + 名称内显式窗口标记）。
 * 未知返回 null。注意：renderer.js 里有一份等价实现，改动需同步。
 */
function inferCloudContextWindow(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return null;
  const m = id.match(/(?:^|[^a-z0-9.])(\d{1,4})(k|m)(?![a-z0-9])/);
  if (m) {
    const n = parseInt(m[1], 10) * (m[2] === 'm' ? 1000000 : 1000);
    if (n >= 8000) return n;
  }
  if (/gemini/.test(id)) {
    if (/1\.5.*pro/.test(id)) return 2000000;
    return 1000000;
  }
  if (/claude|sonnet|opus|haiku/.test(id)) return 200000;
  if (/gpt-4\.1/.test(id)) return 1000000;
  if (/(^|[^a-z])o[134]([^a-z0-9]|$)|o1-|o3-|o4-/.test(id)) return 200000;
  if (/gpt-4o|gpt-4-turbo/.test(id)) return 128000;
  if (/gpt-3\.5/.test(id)) return 16384;
  if (/qwen|qwq/.test(id)) return 131072;
  if (/deepseek/.test(id)) return 131072;
  if (/glm-4|chatglm/.test(id)) return 131072;
  if (/llama-?3|llama3/.test(id)) return 131072;
  if (/moonshot|kimi/.test(id)) return 131072;
  if (/mistral|mixtral/.test(id)) return 32768;
  if (/(^|[^a-z])yi-/.test(id)) return 200000;
  return null;
}

const PRIVATE_PROVIDER_TIMEOUT_SEC = 60;

function hostnameFromBaseUrl(baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''));
    return String(u.hostname || '').toLowerCase();
  } catch (_) {
    return '';
  }
}

function isPrivateOrLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local')) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/** 内网/本机 OpenAI 兼容口：短超时以便尽快切备用 */
function ensurePrivateProviderTimeouts(cfg, changes) {
  const providers = cfg && cfg.models && cfg.models.providers;
  if (!isObject(providers)) return;
  for (const [id, prov] of Object.entries(providers)) {
    if (!isObject(prov)) continue;
    const host = hostnameFromBaseUrl(prov.baseUrl);
    if (!isPrivateOrLocalHost(host)) continue;
    const pt = Number(prov.timeoutSeconds);
    if (!Number.isFinite(pt) || pt > PRIVATE_PROVIDER_TIMEOUT_SEC) {
      const prev = prov.timeoutSeconds;
      prov.timeoutSeconds = PRIVATE_PROVIDER_TIMEOUT_SEC;
      changes.push(
        `models.providers.${id}.timeoutSeconds: ${prev ?? 'unset'} -> ${PRIVATE_PROVIDER_TIMEOUT_SEC} (private-host)`
      );
    }
  }
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
  // 主模型是非 ollama 的云端 provider：不要用本机 ollama 小窗冒充有效窗口
  if (typeof primaryRaw === 'string' && primaryRaw.includes('/')) {
    const provId = primaryRaw.slice(0, primaryRaw.indexOf('/')).toLowerCase();
    if (provId && provId !== 'ollama') {
      return DEFAULTS.cloudContextWindowCap;
    }
  }
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
  // 大窗云端：主动抬高地板，提前压缩，避免 overflow 后 compaction 超时
  if (ctx >= 100000) return DEFAULTS.cloudReserveTokensFloor;
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

  // Chat turns must not fail just because the optional semantic-memory
  // embedding backend has no credentials. When the user has not explicitly
  // selected a memory provider and no OpenAI embedding key is available,
  // choose OpenClaw's deterministic FTS-only mode. This keeps memory_search
  // usable for keyword recall instead of returning "unavailable" and aborting
  // the assistant turn. An explicit user provider is always respected.
  if (!isObject(cfg.memory)) cfg.memory = {};
  const memorySearch = isObject(cfg.memory.search) ? cfg.memory.search : null;
  const hasOpenAiEmbeddingKey = Boolean(
    String(process.env.OPENAI_API_KEY || '').trim() ||
    (isObject(providers.openai) && String(providers.openai.apiKey || '').trim())
  );
  if (!memorySearch && !hasOpenAiEmbeddingKey) {
    cfg.memory.search = { provider: 'none' };
    changes.push('memory.search.provider: unset -> none (FTS fallback)');
  }

  // A fallback identical to the primary is not failover: it repeats the same
  // failing request, increases latency, and can double-charge on ambiguous
  // upstream failures. Keep only distinct, explicitly configured fallbacks.
  if (isObject(ad.model) && typeof ad.model.primary === 'string' && Array.isArray(ad.model.fallbacks)) {
    const primary = ad.model.primary.trim();
    const seenFallbacks = new Set();
    const nextFallbacks = ad.model.fallbacks.filter((value) => {
      const ref = String(value || '').trim();
      if (!ref || ref === primary || seenFallbacks.has(ref)) return false;
      seenFallbacks.add(ref);
      return true;
    });
    if (JSON.stringify(nextFallbacks) !== JSON.stringify(ad.model.fallbacks)) {
      ad.model.fallbacks = nextFallbacks;
      changes.push('agents.defaults.model.fallbacks: removed duplicate/primary entries');
    }
  }

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
      const cw = Number(model.contextWindow);
      const inferred = inferCloudContextWindow(model.id);
      // 自适应升级：仅当窗口未设置、或还停留在历史一刀切默认值(128000/131072)时，用推断出的真实窗口顶上。
      // 用户显式设过的其它值（如故意调小的 64k、或调大的 256k）一律尊重、不动。
      const isDefaultish = !Number.isFinite(cw) || cw <= 0 || cw === 128000 || cw === 131072;
      if (inferred && isDefaultish && inferred > (cw || 0)) {
        const prev = Number.isFinite(cw) && cw > 0 ? cw : 'unset';
        model.contextWindow = inferred;
        changes.push(`${provId}/${model.id || '?'}.contextWindow: ${prev} -> ${inferred} (auto)`);
      }
      // 硬上限安全阀：只挡超过上限的异常值（默认 2M，可用 NEXORA_CLOUD_CTX_CAP 调整）
      if (Number(model.contextWindow) > DEFAULTS.cloudContextWindowCap) {
        const prev = model.contextWindow;
        model.contextWindow = DEFAULTS.cloudContextWindowCap;
        changes.push(`${provId}/${model.id || '?'}.contextWindow: ${prev} -> ${DEFAULTS.cloudContextWindowCap} (cap)`);
      }
    }
  }

  const resolvedCtx = resolveEffectiveContextWindow(cfg);
  const effectiveCtx = Number.isFinite(Number(resolvedCtx)) ? Number(resolvedCtx) : ollamaCtx;
  const smallCtx = effectiveCtx <= DEFAULTS.smallContextThreshold;
  // 云端主模型：绝对禁止被小窗分支/默认 8000 压低（否则会反复 overflow）
  const primaryRawForGate = ad.model && (typeof ad.model === 'string' ? ad.model : ad.model.primary);
  const cloudPrimary =
    typeof primaryRawForGate === 'string' &&
    primaryRawForGate.includes('/') &&
    primaryRawForGate.slice(0, primaryRawForGate.indexOf('/')).toLowerCase() !== 'ollama';

  // bootstrap：启动一次性注入；云端若被误标成 small-ctx 过矮，也要抬回云端默认
  const bootMax = smallCtx && !cloudPrimary ? DEFAULTS.smallBootstrapMaxChars : DEFAULTS.bootstrapMaxChars;
  const bootTotal = smallCtx && !cloudPrimary ? DEFAULTS.smallBootstrapTotalMaxChars : DEFAULTS.bootstrapTotalMaxChars;
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

  // OpenClaw 2026.9 retired reserveTokensFloor/maxHistoryShare/maxContextTokens
  // in favor of built-in tier-aware planning. Keep only supported compaction
  // controls; stale numeric knobs now make the entire Gateway config invalid.
  if (!ad.compaction || typeof ad.compaction !== 'object') ad.compaction = {};
  for (const retired of ['reserveTokensFloor', 'maxHistoryShare', 'maxContextTokens']) {
    if (Object.prototype.hasOwnProperty.call(ad.compaction, retired)) {
      delete ad.compaction[retired];
      changes.push(`compaction.${retired}: retired -> unset`);
    }
  }
  if (ad.compaction.mode !== 'safeguard') {
    ad.compaction.mode = 'safeguard';
    changes.push('compaction.mode: -> safeguard');
  }
  if (smallCtx) {
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
  }

  // 压缩超时：长会话摘要至少给 240s。
  if (!(Number(ad.compaction.timeoutSeconds) >= 240)) {
    const prev = ad.compaction.timeoutSeconds;
    ad.compaction.timeoutSeconds = 240;
    changes.push(`compaction.timeoutSeconds: ${prev ?? 'unset'} -> 240`);
  }

  // contextPruning.softTrim was retired in 2026.9; hardClear remains valid.
  if (!ad.contextPruning || typeof ad.contextPruning !== 'object') ad.contextPruning = {};
  if (Object.prototype.hasOwnProperty.call(ad.contextPruning, 'softTrim')) {
    delete ad.contextPruning.softTrim;
    changes.push('contextPruning.softTrim: retired -> unset');
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

  // These session timeout knobs were retired in OpenClaw 2026.9. Keep the
  // supported agent/provider request timeouts above and remove stale values.
  if (isObject(cfg.diagnostics)) {
    for (const retired of ['stuckSessionWarnMs', 'stuckSessionAbortMs']) {
      if (Object.prototype.hasOwnProperty.call(cfg.diagnostics, retired)) {
        delete cfg.diagnostics[retired];
        changes.push(`diagnostics.${retired}: retired -> unset`);
      }
    }
    if (Object.keys(cfg.diagnostics).length === 0) delete cfg.diagnostics;
  }
  // 内网中转：短超时，避免 socket 挂死拖很久才 failover
  ensurePrivateProviderTimeouts(cfg, changes);

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
  computeSafeReserveTokensFloor,
  isPrivateOrLocalHost,
  ensurePrivateProviderTimeouts
};
