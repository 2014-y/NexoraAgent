/**
 * remote-policy 插件 — 远程策略分发
 *
 * 功能：
 * 1. Gateway 启动时从远程服务器拉取控制策略 JSON
 * 2. 合并/覆盖本地 capabilities.json 的配置
 * 3. 支持热更新：定期拉取最新策略
 *
 * 策略文件格式（远程服务器上）：
 * {
 *   "version": 1,
 *   "updated": "2026-07-04T00:00:00Z",
 *   "enabledCapabilities": ["screen-info", "mouse-click", "keyboard-send", ...],
 *   "disabledCapabilities": ["some-broken-feature"],
 *   "customCommands": {
 *     "brightness-default": 80,
 *     "volume-default": 50
 *   },
 *   "behaviorOverrides": {
 *     "skipHealthCheck": false,
 *     "forceRefreshInterval": 3600000
 *   }
 * }
 *
 * 使用方式：
 * - 放在 ~/.openclaw/plugins/remote-policy/index.js
 * - 在 openclaw.json 的 plugins.allow 中添加 "remote-policy"
 * - 在 openclaw.json 的 plugins.entries.remote-policy.config 中配置 policyUrl
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

// ─── 常量 ───
const PROFILE = process.env.USERPROFILE || require('os').homedir();
const CACHE_DIR = path.join(PROFILE, '.openclaw', 'workspace', '.desktop-cache');
const POLICY_PATH = path.join(CACHE_DIR, 'remote-policy.json');
const HEALTH_CHECK_SCRIPT = path.join(PROFILE, '.openclaw', 'plugins', 'health-check', 'index.js');

// ─── 工具函数 ───

/** HTTP/HTTPS GET 请求 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject).on('timeout', () => {
      reject(new Error('Request timeout'));
    });
  });
}

/** 加载本地策略文件（作为 fallback） */
function loadLocalPolicy() {
  try {
    if (fs.existsSync(POLICY_PATH)) {
      const raw = fs.readFileSync(POLICY_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.log(`[remote-policy] ⚠️  本地策略文件读取失败: ${e.message}`);
  }
  return null;
}

/** 保存策略文件 */
function savePolicy(policy) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2), 'utf-8');
}

/** 默认策略 */
function defaultPolicy() {
  return {
    version: 0,
    updated: new Date().toISOString(),
    enabledCapabilities: [], // 空表示使用自检结果
    disabledCapabilities: [],
    customCommands: {},
    behaviorOverrides: {
      skipHealthCheck: false,
      forceRefreshInterval: 3600000, // 1小时刷新
    },
    source: 'local-default',
  };
}

/** 拉取远程策略 */
async function fetchRemotePolicy(policyUrl, token) {
  if (!policyUrl) {
    console.log('[remote-policy] 未配置 policyUrl，跳过远程拉取');
    return null;
  }

  try {
    console.log(`[remote-policy] 拉取远程策略: ${policyUrl}`);
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const data = await httpGet(policyUrl);
    const policy = JSON.parse(data);
    policy.source = 'remote';
    policy.fetchedAt = new Date().toISOString();

    console.log(`[remote-policy] 远程策略拉取成功 (v${policy.version || '?'})`);
    return policy;
  } catch (err) {
    console.log(`[remote-policy] 远程拉取失败: ${err.message}`);
    return null;
  }
}

/** 合并策略 */
function mergePolicies(local, remote) {
  if (!remote) return local;
  if (!local) return remote;

  return {
    ...local,
    ...remote,
    enabledCapabilities: remote.enabledCapabilities?.length > 0
      ? remote.enabledCapabilities
      : local.enabledCapabilities || [],
    disabledCapabilities: [...(local.disabledCapabilities || []), ...(remote.disabledCapabilities || [])],
    customCommands: { ...local.customCommands, ...remote.customCommands },
    behaviorOverrides: { ...local.behaviorOverrides, ...remote.behaviorOverrides },
    mergedAt: new Date().toISOString(),
  };
}

/** 生成策略摘要（给 AI 看的） */
function generatePolicySummary(policy) {
  const lines = [];
  lines.push(`# 远程策略报告 - ${policy.updated || policy.fetchedAt || 'N/A'}`);
  lines.push(`来源: ${policy.source || 'local'}`);
  lines.push(`版本: ${policy.version || 'N/A'}`);
  lines.push('');

  if (policy.enabledCapabilities?.length > 0) {
    lines.push('### 启用的能力');
    for (const cap of policy.enabledCapabilities) {
      lines.push(`- ${cap}`);
    }
    lines.push('');
  }

  if (policy.disabledCapabilities?.length > 0) {
    lines.push('### 禁用的能力');
    for (const cap of policy.disabledCapabilities) {
      lines.push(`- ${cap}`);
    }
    lines.push('');
  }

  if (policy.customCommands) {
    lines.push('### 自定义命令');
    for (const [key, val] of Object.entries(policy.customCommands)) {
      lines.push(`- ${key}: ${JSON.stringify(val)}`);
    }
    lines.push('');
  }

  if (policy.behaviorOverrides) {
    lines.push('### 行为覆盖');
    const bo = policy.behaviorOverrides;
    lines.push(`- 跳过自检: ${bo.skipHealthCheck || false}`);
    lines.push(`- 刷新间隔: ${(bo.forceRefreshInterval || 3600000) / 60000} 分钟`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── 插件入口 ---
export default function createPlugin(runtime) {
  const pluginName = 'remote-policy';

  console.log(`[${pluginName}] 远程策略插件正在初始化...`);

  // 从配置读取策略
  let pluginConfig;
  try {
    pluginConfig = runtime?.config?.plugins?.entries?.[pluginName]?.config || {};
  } catch (e) {
    pluginConfig = {};
  }

  const policyUrl = pluginConfig.policyUrl || pluginConfig.POLICY_URL || null;
  const policyToken = pluginConfig.policyToken || pluginConfig.POLICY_TOKEN || null;
  const refreshInterval = pluginConfig.refreshInterval || pluginConfig.FORCE_REFRESH_INTERVAL || 3600000;

  let currentPolicy = null;
  let refreshTimer = null;

  async function loadPolicy() {
    // 1. 尝试远程拉取
    const remote = await fetchRemotePolicy(policyUrl, policyToken);

    // 2. 加载本地策略
    const local = loadLocalPolicy();

    // 3. 合并
    currentPolicy = mergePolicies(local, remote);

    // 4. 保存合并后的策略
    savePolicy(currentPolicy);

    // 5. 生成 AI 可读摘要
    const summary = generatePolicySummary(currentPolicy);
    const summaryPath = path.join(CACHE_DIR, 'remote-policy-summary.md');
    fs.writeFileSync(summaryPath, summary, 'utf-8');

    console.log(`[${pluginName}] 策略已加载 (${currentPolicy.source}, v${currentPolicy.version || '?'})`);
    console.log(`[${pluginName}] 下次刷新: ${new Date(Date.now() + refreshInterval).toISOString()}`);

    return currentPolicy;
  }

  async function startPeriodicRefresh() {
    if (refreshInterval <= 0) return;

    // 初始加载
    await loadPolicy();

    // 定时刷新
    refreshTimer = setInterval(async () => {
      try {
        console.log(`[${pluginName}] 定时刷新策略...`);
        await loadPolicy();
      } catch (err) {
        console.error(`[${pluginName}] 定时刷新失败: ${err.message}`);
      }
    }, refreshInterval);
  }

  // 插件钩子
  return {
    name: pluginName,

    async onMessage(context) {
      // 第一次消息到来时加载策略
      if (!currentPolicy) {
        await loadPolicy();
      }
    },

    async onLoad() {
      // Gateway 启动时加载
      await startPeriodicRefresh();
    },

    // 手动刷新策略
    async refresh() {
      await loadPolicy();
    },

    // 暴露当前策略给其他模块
    getPolicy() {
      return currentPolicy;
    },

    // 检查某个能力是否被远程策略禁用
    isDisabled(capabilityId) {
      if (!currentPolicy) return false;
      if (currentPolicy.disabledCapabilities?.includes(capabilityId)) return true;
      if (currentPolicy.enabledCapabilities?.length > 0 && !currentPolicy.enabledCapabilities.includes(capabilityId)) {
        return true;
      }
      return false;
    },

    onShutdown() {
      if (refreshTimer) clearInterval(refreshTimer);
    },
  };
}
