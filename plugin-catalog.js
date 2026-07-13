'use strict';
/**
 * 内置插件目录：零配置 / 需凭证 / 需本机软件
 * 保证别人电脑上开关能进 plugins.allow，并给出探活结果。
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

/** A：零配置（随 OpenClaw 或我们 seed） */
const ZERO_CONFIG_PLUGINS = [
  'dual-model-trainer',
  'duckduckgo',
  'webhooks',
  'workboard',
  'bonjour',
  'llm-task',
  'auto-summary'
];

/** 新机首次 stamp：推荐默认开启 */
const ZERO_CONFIG_DEFAULT_ON = ['dual-model-trainer', 'duckduckgo', 'auto-summary'];

/** B：需外部平台凭证 */
const CREDENTIAL_PLUGINS = ['slack', 'matrix'];

/** C：需本机安装软件 */
const LOCAL_SOFTWARE_PLUGINS = ['auto-start-codex'];

/** UI 插件页展示的完整列表（顺序即卡片顺序） */
const UI_PLUGIN_IDS = [
  'dual-model-trainer',
  'slack',
  'auto-summary',
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
function ensureUiPluginCatalog(config, opts = {}) {
  if (!config || typeof config !== 'object') return { changed: false, changes: [] };
  const changes = [];
  const forceDefaultOn = Boolean(opts.forceDefaultOn);

  for (const id of ZERO_CONFIG_PLUGINS) {
    const defaultOn = ZERO_CONFIG_DEFAULT_ON.includes(id);
    if (forceDefaultOn && defaultOn) {
      if (!config.plugins) config.plugins = {};
      if (!config.plugins.entries) config.plugins.entries = {};
      if (!config.plugins.entries[id]) config.plugins.entries[id] = {};
      if (config.plugins.entries[id].enabled !== true) {
        config.plugins.entries[id].enabled = true;
        changes.push(`${id}: enabled -> true (default-on)`);
      }
    } else if (ensureEntry(config, id, false)) {
      changes.push(`${id}: entry created`);
    }
    if (ensureAllow(config, id)) changes.push(`${id}: +allow`);
  }

  for (const id of CREDENTIAL_PLUGINS) {
    if (ensureEntry(config, id, false)) changes.push(`${id}: entry created`);
    if (ensureAllow(config, id)) changes.push(`${id}: +allow`);
  }

  // llm-task 作为摘要能力补充始终允许（即使 UI 主卡是 auto-summary）
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

  // 自研 seed
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

  // OpenClaw 内置 / 已安装
  for (const root of listOpenClawExtensionDirs(appRoot)) {
    const d = path.join(root, pluginId);
    if (fs.existsSync(d)) return { present: true, source: 'openclaw' };
  }

  // npm 项目缓存（别人旧机可能有）
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    const npmProjects = path.join(home, '.openclaw', 'npm', 'projects');
    try {
      if (fs.existsSync(npmProjects)) {
        for (const name of fs.readdirSync(npmProjects)) {
          if (String(name).includes(pluginId)) {
            return { present: true, source: 'npm-cache' };
          }
        }
      }
    } catch (e) {}
  }

  // 这些 id 多数版本打进 gateway 核心插件表，即使找不到目录也视为「可能可用」
  const coreish = new Set(['bonjour', 'webhooks', 'workboard', 'llm-task', 'slack', 'matrix', 'duckduckgo']);
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
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
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
    }
    if (!presence.present) {
      base.badge = 'missing-runtime';
      base.hint = (base.hint ? base.hint + '；' : '') + '运行时未发现插件包，首次开启可能需联网安装';
    }
    return base;
  }

  // zero-config
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

  return { ok: false, error: 'unsupported plugin' };
}

module.exports = {
  ZERO_CONFIG_PLUGINS,
  ZERO_CONFIG_DEFAULT_ON,
  CREDENTIAL_PLUGINS,
  LOCAL_SOFTWARE_PLUGINS,
  UI_PLUGIN_IDS,
  PLUGIN_TIER,
  ensureUiPluginCatalog,
  ensureAllow,
  probePlugin,
  probeAllUiPlugins,
  detectCodexInstalled,
  applyPluginCredentials,
  pluginLooksPresent
};
