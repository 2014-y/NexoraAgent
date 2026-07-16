'use strict';
/**
 * 内置插件目录：零配置 / 需凭证 / 需本机软件
 * 保证别人电脑上开关能进 plugins.allow，并给出探活结果。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

/**
 * 长期记忆真实插件栈（OpenClaw 加载的是这些 ID，不是 UI 伞形卡）。
 * UI 用 `long-term-memory` 统一开关这三者，开箱强制开启以保证人人可用。
 */
const LONG_TERM_MEMORY_STACK = [
  'auto-summary',
  'memory-rotate',
  'compaction-memory-guard'
];

/** UI 伞形卡 ID（仅用于 Nexora Agent 插件菜单，不写入 OpenClaw plugins.allow） */
const LONG_TERM_MEMORY_UI_ID = 'long-term-memory';

/** A：零配置（随 OpenClaw 或我们 seed） */
const ZERO_CONFIG_PLUGINS = [
  'dual-model-trainer',
  'duckduckgo',
  'webhooks',
  'workboard',
  'bonjour',
  'llm-task',
  'auto-summary',
  'memory-rotate',
  'compaction-memory-guard',
  'openclaw-weixin'
];

/** 新机首次 stamp：推荐默认开启 */
const ZERO_CONFIG_DEFAULT_ON = [
  'dual-model-trainer',
  'duckduckgo',
  'auto-summary',
  'memory-rotate',
  'compaction-memory-guard',
  'openclaw-weixin',
  LONG_TERM_MEMORY_UI_ID
];

/** B：需外部平台凭证 / 渠道配置 */
const CREDENTIAL_PLUGINS = ['slack', 'matrix', 'telegram', 'whatsapp', 'voice-call', 'qqbot', 'feishu'];

/** C：需本机安装软件 */
const LOCAL_SOFTWARE_PLUGINS = ['auto-start-codex'];

/**
 * 异步扫码/登录类内置渠道（OpenClaw `channels login`）。
 * 新增内置扫码插件时在此登记一眼即可继承：信任预同步、自动跳过 Install?、出码超时、可取消、失败事件。
 * feishu 走独立 OAuth device-code，不在此表，但仍必须走前端 beginCommBinding 闭环。
 *
 * @type {Record<string, { openclawChannel: string, label: string, uiChannel: string, wakeTimeoutMs?: number }>}
 */
const ASYNC_CHANNEL_LOGIN = {
  'openclaw-weixin': {
    openclawChannel: 'openclaw-weixin',
    label: '微信',
    uiChannel: 'wechat',
    wakeTimeoutMs: 120000
  }
  // 以后例如 WhatsApp 扫码：取消下行注释并补齐 BUNDLED_NPM_CHANNEL_PLUGINS + UI
  // 'whatsapp': { openclawChannel: 'whatsapp', label: 'WhatsApp', uiChannel: 'whatsapp', wakeTimeoutMs: 120000 }
};

/** UI 插件页展示的完整列表（顺序即卡片顺序） */
const UI_PLUGIN_IDS = [
  'dual-model-trainer',
  'openclaw-weixin',
  LONG_TERM_MEMORY_UI_ID,
  'feishu',
  'qqbot',
  'voice-call',
  'telegram',
  'slack',
  'whatsapp',
  'matrix',
  'duckduckgo',
  'webhooks',
  'bonjour',
  'workboard',
  'auto-start-codex'
];

const PLUGIN_TIER = {};
for (const id of ZERO_CONFIG_PLUGINS) PLUGIN_TIER[id] = 'zero';
for (const id of CREDENTIAL_PLUGINS) PLUGIN_TIER[id] = 'credentials';
for (const id of LOCAL_SOFTWARE_PLUGINS) PLUGIN_TIER[id] = 'software';
PLUGIN_TIER[LONG_TERM_MEMORY_UI_ID] = 'zero';

function ensureAllow(config, id) {
  if (!config.plugins) config.plugins = {};
  if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
  if (!config.plugins.allow.includes(id)) {
    config.plugins.allow.push(id);
    return true;
  }
  return false;
}

function ensureEntry(config, id, enabled) {
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  let changed = false;
  if (!config.plugins.entries[id]) {
    config.plugins.entries[id] = { enabled: Boolean(enabled) };
    changed = true;
  } else if (enabled === true && config.plugins.entries[id].enabled == null) {
    config.plugins.entries[id].enabled = true;
    changed = true;
  }
  return changed;
}

/**
 * 启动 / config-read 时合并：A/B 全进 allow；缺 entries 补上；推荐默认开一次。
 * @param {object} config
 * @param {{ forceDefaultOn?: boolean }} opts  forceDefaultOn=true 表示版本 stamp 首次
 */
function ensureLongTermMemoryStack(config) {
  if (!config || typeof config !== 'object') return { changed: false, changes: [] };
  const changes = [];
  for (const id of LONG_TERM_MEMORY_STACK) {
    if (ensureEntry(config, id, true)) changes.push(`${id}: entry created`);
    if (config.plugins.entries[id] && config.plugins.entries[id].enabled !== true) {
      config.plugins.entries[id].enabled = true;
      changes.push(`${id}: enabled -> true (long-term-memory oobe)`);
    }
    if (ensureAllow(config, id)) changes.push(`${id}: +allow`);
  }
  // UI 伞形状态只存在于 Nexora 面板推导；勿写入 openclaw.json（OpenClaw 会告警 plugin not found）
  if (config.plugins.entries && config.plugins.entries[LONG_TERM_MEMORY_UI_ID]) {
    delete config.plugins.entries[LONG_TERM_MEMORY_UI_ID];
    changes.push('long-term-memory: removed ui-only entry from openclaw plugins.entries');
  }
  if (Array.isArray(config.plugins.allow)) {
    const before = config.plugins.allow.length;
    config.plugins.allow = config.plugins.allow.filter((x) => x !== LONG_TERM_MEMORY_UI_ID);
    if (config.plugins.allow.length !== before) changes.push('long-term-memory: stripped from allow (ui-only)');
  }
  return { changed: changes.length > 0, changes };
}

function isLongTermMemoryEnabled(config) {
  const entries = (config && config.plugins && config.plugins.entries) || {};
  return LONG_TERM_MEMORY_STACK.every((id) => entries[id] && entries[id].enabled === true);
}

function setLongTermMemoryEnabled(config, enabled) {
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
  const on = Boolean(enabled);
  for (const id of LONG_TERM_MEMORY_STACK) {
    if (!config.plugins.entries[id]) config.plugins.entries[id] = {};
    config.plugins.entries[id].enabled = on;
    if (on) ensureAllow(config, id);
  }
  if (config.plugins.entries[LONG_TERM_MEMORY_UI_ID]) {
    delete config.plugins.entries[LONG_TERM_MEMORY_UI_ID];
  }
  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = config.plugins.allow.filter((x) => x !== LONG_TERM_MEMORY_UI_ID);
  }
  return { ok: true };
}

function ensureUiPluginCatalog(config, opts = {}) {
  if (!config || typeof config !== 'object') return { changed: false, changes: [] };
  const changes = [];
  const forceDefaultOn = Boolean(opts.forceDefaultOn);

  // 迁移历史错误插件 ID：早期版本误用 `openclaw-qqbot`，但 OpenClaw QQ 机器人插件的真实 ID 是 `qqbot`。
  // 错误 ID 会导致插件既不进 allow 也不被加载，QQ 绑定“完全没效果”。此处把旧条目安全迁移到正确 ID。
  try {
    if (config.plugins && config.plugins.entries && config.plugins.entries['openclaw-qqbot']) {
      const legacy = config.plugins.entries['openclaw-qqbot'];
      if (!config.plugins.entries['qqbot']) {
        config.plugins.entries['qqbot'] = legacy;
      } else if (legacy && legacy.enabled === true) {
        config.plugins.entries['qqbot'].enabled = true;
      }
      delete config.plugins.entries['openclaw-qqbot'];
      changes.push('qqbot: migrated legacy id openclaw-qqbot -> qqbot');
    }
    if (config.plugins && Array.isArray(config.plugins.allow)) {
      const before = config.plugins.allow.length;
      config.plugins.allow = config.plugins.allow.filter((x) => x !== 'openclaw-qqbot');
      if (config.plugins.allow.length !== before) changes.push('qqbot: removed legacy openclaw-qqbot from allow');
    }
  } catch (e) {}

  for (const id of ZERO_CONFIG_PLUGINS) {
    const defaultOn = forceDefaultOn && ZERO_CONFIG_DEFAULT_ON.includes(id);
    if (ensureEntry(config, id, defaultOn)) {
      changes.push(`${id}: entry created`);
    }
    // 仅首次 stamp 强制默认开；之后尊重用户开关，绝不能每次启动把凭证类/渠道类重新打开
    if (defaultOn && config.plugins.entries[id] && config.plugins.entries[id].enabled !== true) {
      config.plugins.entries[id].enabled = true;
      changes.push(`${id}: enabled -> true (force default-on)`);
    }
    if (ensureAllow(config, id)) changes.push(`${id}: +allow`);
  }

  for (const id of CREDENTIAL_PLUGINS) {
    // 不要预先写入 entries（OpenClaw 会对「有条目但未安装」刷 Config warnings）
    // 用户在插件页打开时再写入；allow 仍保留方便一键启用
    if (ensureAllow(config, id)) changes.push(`${id}: +allow`);
  }

  // 长期记忆开箱：强制启用真实插件栈 + UI 伞形卡
  const ltm = ensureLongTermMemoryStack(config);
  if (ltm.changed) changes.push(...ltm.changes);

  // llm-task 作为摘要能力补充始终允许（即使 UI 主卡是 long-term-memory）
  if (ensureAllow(config, 'llm-task')) changes.push('llm-task: +allow');

  // Codex 是 hook，不是 plugins.entries 必需，但允许记录
  if (!config.hooks) config.hooks = {};
  if (!config.hooks.internal) config.hooks.internal = { enabled: false, entries: {} };
  if (!config.hooks.internal.entries) config.hooks.internal.entries = {};
  if (!config.hooks.internal.entries['auto-start-codex']) {
    config.hooks.internal.entries['auto-start-codex'] = { enabled: false };
    changes.push('auto-start-codex: hook entry created');
  }

  return { changed: changes.length > 0, changes };
}

function listOpenClawExtensionDirs(appRoot) {
  const roots = [];
  const push = (p) => {
    if (p && fs.existsSync(p) && !roots.includes(p)) roots.push(p);
  };
  try {
    push(path.join(appRoot || '', 'node_modules', 'openclaw', 'dist', 'extensions'));
    push(path.join(appRoot || '', 'node_modules', 'openclaw', 'extensions'));
  } catch (e) {}
  try {
    const resolved = require.resolve('openclaw/package.json');
    const base = path.dirname(resolved);
    push(path.join(base, 'dist', 'extensions'));
    push(path.join(base, 'extensions'));
  } catch (e) {}
  return roots;
}

function pluginLooksPresent(pluginId, opts = {}) {
  const appRoot = opts.appRoot || '';
  const stateDir = opts.stateDir || '';

  // 自研 seed（随应用 plugins/ 复制到 ~/.openclaw/extensions）
  if (stateDir) {
    const local = path.join(stateDir, 'extensions', pluginId);
    if (fs.existsSync(path.join(local, 'index.js')) || fs.existsSync(path.join(local, 'openclaw.plugin.json'))) {
      return { present: true, source: 'extensions' };
    }
  }
  if (appRoot) {
    for (const rel of ['plugins', 'extensions']) {
      const local = path.join(appRoot, rel, pluginId);
      if (fs.existsSync(path.join(local, 'index.js')) || fs.existsSync(path.join(local, 'openclaw.plugin.json'))) {
        return { present: true, source: rel };
      }
    }
  }

  // 随安装包交付的 npm 插件（必须存在于应用 node_modules，不能只看用户缓存）
  if (appRoot) {
    const scoped = {
      'openclaw-weixin': ['@tencent-weixin/openclaw-weixin'],
      qqbot: ['@openclaw/qqbot'],
      feishu: ['@openclaw/feishu'],
      'voice-call': ['@openclaw/voice-call'],
      slack: ['@openclaw/slack'],
      whatsapp: ['@openclaw/whatsapp'],
      matrix: ['@openclaw/matrix'],
      telegram: ['@openclaw/telegram']
    };
    const names = [
      pluginId,
      `@openclaw/${pluginId.replace(/^openclaw-/, '')}`,
      ...(scoped[pluginId] || [])
    ];
    for (const name of names) {
      const p = path.join(appRoot, 'node_modules', name);
      if (fs.existsSync(p)) {
        return { present: true, source: 'node_modules' };
      }
      // scoped 包在 node_modules/@scope/name
      if (name.startsWith('@')) {
        const parts = name.split('/');
        const scopedPath = path.join(appRoot, 'node_modules', parts[0], parts[1]);
        if (fs.existsSync(scopedPath)) {
          return { present: true, source: 'node_modules' };
        }
      }
    }
  }

  // OpenClaw 核心发行包内置 extensions（telegram / duckduckgo / webhooks 等）
  for (const root of listOpenClawExtensionDirs(appRoot)) {
    const d = path.join(root, pluginId);
    if (fs.existsSync(d)) return { present: true, source: 'openclaw' };
  }

  // 用户本机历史 npm 缓存：仅作 soft 提示，不能当作“已随安装包内置”
  const resolvedStateDir = stateDir || process.env.OPENCLAW_STATE_DIR
    || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || '', '.openclaw');
  if (resolvedStateDir) {
    const npmProjects = path.join(resolvedStateDir, 'npm', 'projects');
    try {
      if (fs.existsSync(npmProjects)) {
        for (const name of fs.readdirSync(npmProjects)) {
          if (String(name).includes(pluginId)) {
            return { present: true, source: 'npm-cache', soft: true };
          }
        }
      }
    } catch (e) {}
  }

  // 仅真正打进 openclaw dist 的核心扩展可假定可用
  const coreish = new Set(['bonjour', 'webhooks', 'workboard', 'llm-task', 'duckduckgo', 'telegram']);
  if (coreish.has(pluginId)) {
    return { present: true, source: 'core-assumed', soft: true };
  }

  return { present: false, source: null };
}

function detectCodexInstalled() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Codex', 'Codex.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Codex', 'Codex.exe'),
    path.join(process.env.ProgramFiles || '', 'Codex', 'Codex.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Codex', 'Codex.exe'),
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Programs', 'codex', 'Codex.exe')
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return { installed: true, path: c };
    } catch (e) {}
  }
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command',
        "try { $c = Get-Command codex -ErrorAction SilentlyContinue; if ($c) { $c.Source } else { '' } } catch { '' }"],
      { encoding: 'utf8', timeout: 1500, windowsHide: true }
    ).trim();
    if (out) return { installed: true, path: out };
  } catch (e) {}
  return { installed: false, path: null };
}

function slackNeedsConfig(config) {
  const slack = (config.channels && config.channels.slack) ||
    (config.plugins && config.plugins.entries && config.plugins.entries.slack && config.plugins.entries.slack.config) ||
    {};
  const token = slack.botToken || slack.token || slack.bot_token ||
    (config.env && (config.env.SLACK_BOT_TOKEN || config.env.SLACK_TOKEN));
  if (!token || String(token).includes('YOUR_') || String(token).length < 10) {
    return { needsConfig: true, missingFields: ['botToken'], hint: '需要 Slack Bot Token（以 xoxb- 开头）' };
  }
  return { needsConfig: false, missingFields: [], hint: '' };
}

function matrixNeedsConfig(config) {
  const matrix = (config.channels && config.channels.matrix) ||
    (config.plugins && config.plugins.entries && config.plugins.entries.matrix && config.plugins.entries.matrix.config) ||
    {};
  const homeserver = matrix.homeserver || matrix.homeserverUrl || matrix.baseUrl;
  const token = matrix.accessToken || matrix.token || matrix.access_token ||
    (config.env && config.env.MATRIX_ACCESS_TOKEN);
  const missing = [];
  if (!homeserver) missing.push('homeserver');
  if (!token || String(token).includes('YOUR_')) missing.push('accessToken');
  if (missing.length) {
    return { needsConfig: true, missingFields: missing, hint: '需要 Matrix 服务器地址与 Access Token' };
  }
  return { needsConfig: false, missingFields: [], hint: '' };
}

function telegramNeedsConfig(config) {
  const tg = (config.channels && config.channels.telegram) ||
    (config.plugins && config.plugins.entries && config.plugins.entries.telegram && config.plugins.entries.telegram.config) ||
    {};
  const token = tg.botToken || tg.token || tg.bot_token ||
    (config.env && (config.env.TELEGRAM_BOT_TOKEN || config.env.TELEGRAM_TOKEN));
  if (!token || String(token).includes('YOUR_') || String(token).length < 10) {
    return { needsConfig: true, missingFields: ['botToken'], hint: '需要 Telegram Bot Token（向 @BotFather 申请）' };
  }
  return { needsConfig: false, missingFields: [], hint: '' };
}

function whatsappNeedsConfig(config) {
  // WhatsApp 通常扫码登录，配置非静态 Token；仅提示
  const wa = (config.channels && config.channels.whatsapp) || {};
  if (wa.linked === true || wa.session || wa.authDir) {
    return { needsConfig: false, missingFields: [], hint: '已有会话痕迹，可尝试开启' };
  }
  return {
    needsConfig: true,
    missingFields: ['session'],
    hint: '开启后请到网关控制台完成 WhatsApp 扫码绑定'
  };
}

function qqbotNeedsConfig(config) {
  const qqbot = (config.channels && config.channels.qqbot) || {};
  const accounts = qqbot.accounts || {};
  // 顶层默认账号 或 任意命名账号带 appId 即视为已配置
  const hasTopLevel = Boolean(qqbot.appId && (qqbot.clientSecret || qqbot.clientSecretFile));
  const hasNamed = Object.keys(accounts).some((id) => accounts[id] && accounts[id].appId && (accounts[id].clientSecret || accounts[id].clientSecretFile));
  if (hasTopLevel || hasNamed) {
    return { needsConfig: false, missingFields: [], hint: '已配置 QQ 机器人凭证' };
  }
  return { needsConfig: true, missingFields: ['appId', 'clientSecret'], hint: '需要 QQ 开放平台机器人的 AppID 与 AppSecret' };
}

function feishuNeedsConfig(config) {
  const feishu = (config.channels && config.channels.feishu) || {};
  const accounts = feishu.accounts || {};
  const hasTopLevel = Boolean(feishu.appId && feishu.appSecret);
  const hasNamed = Object.keys(accounts).some((id) => accounts[id] && accounts[id].appId && accounts[id].appSecret);
  if (hasTopLevel || hasNamed) {
    return { needsConfig: false, missingFields: [], hint: '已配置飞书应用凭证；账号绑定请到「通讯管理」' };
  }
  return { needsConfig: true, missingFields: ['appId', 'appSecret'], hint: '需要飞书开放平台 App ID / App Secret，可在「通讯管理」扫码或手动添加' };
}

function voiceCallNeedsConfig() {
  // 语音通话默认关闭；开启即可加载插件，细项可在控制台配置
  return {
    needsConfig: false,
    missingFields: [],
    hint: '默认关闭；开启后可通过微信等进行语音通话（需网关语音能力可用）'
  };
}

/**
 * @returns {{ id, tier, available, needsConfig, missingFields, hint, badge, codexPath? }}
 */
function probePlugin(pluginId, opts = {}) {
  const config = opts.config || {};
  const tier = PLUGIN_TIER[pluginId] || 'zero';
  const presence = pluginLooksPresent(pluginId, opts);
  const base = {
    id: pluginId,
    tier,
    available: presence.present,
    needsConfig: false,
    missingFields: [],
    hint: '',
    badge: 'ready',
    source: presence.source || null,
    soft: Boolean(presence.soft)
  };

  if (pluginId === 'auto-start-codex') {
    const codex = detectCodexInstalled();
    base.available = codex.installed;
    base.codexPath = codex.path;
    if (!codex.installed) {
      base.badge = 'needs-software';
      base.hint = '本机未检测到 Codex，请先安装 Codex 桌面端';
      base.needsConfig = true;
    } else {
      base.badge = 'ready';
      base.hint = `已找到 Codex: ${codex.path}`;
    }
    return base;
  }

  if (tier === 'credentials') {
    if (pluginId === 'slack') {
      const n = slackNeedsConfig(config);
      Object.assign(base, n);
      base.badge = n.needsConfig ? 'needs-config' : 'ready';
    } else if (pluginId === 'matrix') {
      const n = matrixNeedsConfig(config);
      Object.assign(base, n);
      base.badge = n.needsConfig ? 'needs-config' : 'ready';
    } else if (pluginId === 'telegram') {
      const n = telegramNeedsConfig(config);
      Object.assign(base, n);
      base.badge = n.needsConfig ? 'needs-config' : 'ready';
    } else if (pluginId === 'whatsapp') {
      const n = whatsappNeedsConfig(config);
      Object.assign(base, n);
      // WhatsApp 允许先开再扫码，不强制拦截开关
      base.badge = n.needsConfig ? 'needs-config' : 'ready';
      base.blockEnable = false;
    } else if (pluginId === 'voice-call') {
      const n = voiceCallNeedsConfig();
      Object.assign(base, n);
      base.badge = 'ready';
    } else if (pluginId === 'qqbot') {
      const n = qqbotNeedsConfig(config);
      Object.assign(base, n);
      // 允许先开启插件再填凭证，不强制拦截开关
      base.badge = n.needsConfig ? 'needs-config' : 'ready';
      base.blockEnable = false;
    } else if (pluginId === 'feishu') {
      const n = feishuNeedsConfig(config);
      Object.assign(base, n);
      base.badge = n.needsConfig ? 'needs-config' : 'ready';
      base.blockEnable = false;
    }
    if (!presence.present) {
      // 核心渠道插件多数随 gateway 分发
      // 只有真正打进 openclaw dist 的可 soft 假定；npm 外挂必须随包存在
      const softChannels = new Set(['telegram']);
      if (softChannels.has(pluginId)) {
        base.available = true;
        base.soft = true;
        if (!base.hint) base.hint = '随网关渠道插件分发';
      } else {
        base.badge = 'missing-runtime';
        base.hint = (base.hint ? base.hint + '；' : '') + '运行时未发现插件包，请使用完整安装包（已内置渠道插件，无需再联网下载）';
      }
    }
    return base;
  }

  // zero-config
  if (pluginId === 'openclaw-weixin') {
    base.badge = 'ready';
    base.hint = '微信渠道（建议保持开启）';
    base.available = true;
    return base;
  }

  if (pluginId === LONG_TERM_MEMORY_UI_ID) {
    // 伞形卡：只要三者中至少一个包在就认为可用；栈启用状态在主进程强制对齐
    let presentCount = 0;
    for (const id of LONG_TERM_MEMORY_STACK) {
      if (pluginLooksPresent(id, opts).present) presentCount += 1;
    }
    base.available = true; // 随应用内置 seed，开箱视为可用
    base.badge = 'ready';
    base.hint = presentCount >= LONG_TERM_MEMORY_STACK.length
      ? 'plugin.long-term-memory.hint.ready'
      : 'plugin.long-term-memory.hint.seeding';
    base.hintKey = base.hint;
    base.stack = LONG_TERM_MEMORY_STACK.slice();
    return base;
  }

  if (!presence.present) {
    base.badge = 'missing-runtime';
    base.hint = '当前 OpenClaw 运行时未发现该插件';
    base.available = false;
  } else if (presence.soft) {
    base.badge = 'ready';
    base.hint = '开箱可用（随网关核心分发）';
  } else {
    base.badge = 'ready';
    base.hint = '开箱可用';
  }
  return base;
}

function probeAllUiPlugins(opts = {}) {
  return UI_PLUGIN_IDS.map((id) => probePlugin(id, opts));
}

function applyPluginCredentials(config, pluginId, fields) {
  if (!config.channels) config.channels = {};
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  if (!config.plugins.entries[pluginId]) config.plugins.entries[pluginId] = {};

  if (pluginId === 'slack') {
    if (!config.channels.slack) config.channels.slack = {};
    if (fields.botToken) {
      config.channels.slack.botToken = String(fields.botToken).trim();
      config.plugins.entries.slack.config = {
        ...(config.plugins.entries.slack.config || {}),
        botToken: String(fields.botToken).trim()
      };
    }
    if (fields.appToken) {
      config.channels.slack.appToken = String(fields.appToken).trim();
    }
    config.plugins.entries.slack.enabled = true;
    ensureAllow(config, 'slack');
    return { ok: true };
  }

  if (pluginId === 'matrix') {
    if (!config.channels.matrix) config.channels.matrix = {};
    if (fields.homeserver) config.channels.matrix.homeserver = String(fields.homeserver).trim();
    if (fields.accessToken) config.channels.matrix.accessToken = String(fields.accessToken).trim();
    config.plugins.entries.matrix.config = {
      ...(config.plugins.entries.matrix.config || {}),
      homeserver: config.channels.matrix.homeserver,
      accessToken: config.channels.matrix.accessToken
    };
    config.plugins.entries.matrix.enabled = true;
    ensureAllow(config, 'matrix');
    return { ok: true };
  }

  if (pluginId === 'telegram') {
    if (!config.channels.telegram) config.channels.telegram = {};
    if (fields.botToken) {
      config.channels.telegram.botToken = String(fields.botToken).trim();
      config.plugins.entries.telegram.config = {
        ...(config.plugins.entries.telegram.config || {}),
        botToken: String(fields.botToken).trim()
      };
    }
    config.plugins.entries.telegram.enabled = true;
    ensureAllow(config, 'telegram');
    return { ok: true };
  }

  return { ok: false, error: 'unsupported plugin' };
}

module.exports = {
  ZERO_CONFIG_PLUGINS,
  ZERO_CONFIG_DEFAULT_ON,
  CREDENTIAL_PLUGINS,
  LOCAL_SOFTWARE_PLUGINS,
  ASYNC_CHANNEL_LOGIN,
  UI_PLUGIN_IDS,
  PLUGIN_TIER,
  LONG_TERM_MEMORY_STACK,
  LONG_TERM_MEMORY_UI_ID,
  ensureUiPluginCatalog,
  ensureLongTermMemoryStack,
  isLongTermMemoryEnabled,
  setLongTermMemoryEnabled,
  ensureAllow,
  probePlugin,
  probeAllUiPlugins,
  detectCodexInstalled,
  applyPluginCredentials,
  pluginLooksPresent
};
