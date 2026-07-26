/**
 * WeChat 自动重连增强插件 v3 (高可用网关重连版)
 * 
 * 监控 WeChat channel 连接状态，检测到断线后自动触发重连。
 * 采用指数退避无限重发机制，解决网络网关断掉后无限卡死不回复问题。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN_NAME = 'weixin-reconnect';
const GATEWAY_URL = 'http://127.0.0.1:18789';
const CHECK_INTERVAL_MS = 15_000;          // 每15秒检查一次
// 仅在「明确断开」时重连；不再用「静默 N 秒 = 断线」这种误判（长回复/空闲会被误杀）
const REQUIRED_FAILED_PROBES = 3;          // 连续 N 次明确断开才动手，抗抖动
const RECONNECT_COOLDOWN_MS = 5_000;        // 重连基础冷却时间 5 秒

/** 解析网关鉴权 token（env 优先，其次读 openclaw.json）；否则探测会 401 → 误判断开 */
function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN;
  if (envTok && String(envTok).trim()) return String(envTok).trim();
  try {
    const stateDir = process.env.OPENCLAW_STATE_DIR
      || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(), '.openclaw');
    const cfg = JSON.parse(fs.readFileSync(path.join(stateDir, 'openclaw.json'), 'utf8').replace(/^﻿/, ''));
    const tok = cfg?.gateway?.auth?.token;
    if (tok && String(tok).trim()) return String(tok).trim();
  } catch (_) {}
  return '';
}

export default function createPlugin(runtime) {
  console.log(`[${PLUGIN_NAME}] 🔌 WeChat 自动重连插件 (v4 保守重连版) 已加载`);

  let consecutiveFailedProbes = 0;
  let isReconnecting = false;
  let timer = null;
  const authToken = resolveGatewayToken();

  /** 查询 WeChat channel 状态；返回 {connected:bool} 或 null(无法判定，绝不当断开处理) */
  async function getChannelStatus() {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    for (const url of [
      `${GATEWAY_URL}/v1/channels/openclaw-weixin/status`,
      `${GATEWAY_URL}/api/channels/openclaw-weixin/status`,
    ]) {
      try {
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
        if (resp.status === 404) continue;      // 路径不对，换下一个
        if (!resp.ok) return null;               // 401/5xx：无法判定，不当断开
        return await resp.json();
      } catch { /* 网络异常：无法判定，不当断开 */ }
    }
    return null;
  }

  /** 从状态负载中判断是否「明确断开」——只有拿到肯定信号才返回 true */
  function isExplicitlyDisconnected(status) {
    if (!status || typeof status !== 'object') return false; // 拿不到状态 ≠ 断开
    const acct = (Array.isArray(status.accounts) && status.accounts[0]) || status;
    if (acct.connected === false) return true;
    const s = String(acct.state || acct.status || '').toLowerCase();
    return s === 'disconnected' || s === 'offline' || s === 'closed' || s === 'error';
  }

  /** 重启 WeChat channel */
  async function restartChannel() {
    if (isReconnecting) {
      console.log(`[${PLUGIN_NAME}] ⏳ 重连进行中，跳过重发`);
      return false;
    }

    isReconnecting = true;

    const backoffMs = Math.min(RECONNECT_COOLDOWN_MS * Math.pow(1.5, Math.min(consecutiveFailedProbes, 8)), 60_000);
    console.log(`[${PLUGIN_NAME}] 🔄 通道明确断开，发起重启 (退避间隔: ${Math.round(backoffMs/1000)}s)...`);
    await new Promise(r => setTimeout(r, backoffMs));

    try {
      const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
      let resp = await fetch(`${GATEWAY_URL}/v1/channels/openclaw-weixin/restart`, {
        method: 'POST', headers, signal: AbortSignal.timeout(12000)
      });
      if (resp.status === 404) {
        resp = await fetch(`${GATEWAY_URL}/api/channels/openclaw-weixin/restart`, {
          method: 'POST', headers, signal: AbortSignal.timeout(12000)
        });
      }
      if (resp.ok) {
        console.log(`[${PLUGIN_NAME}] ✅ WeChat channel 重启指令发起成功`);
        isReconnecting = false;
        return true;
      }
      console.log(`[${PLUGIN_NAME}] ⚠️ 重启回应状态异常: ${resp.status}`);
    } catch (err) {
      console.log(`[${PLUGIN_NAME}] ⚠️ 网关重启响应网络异常: ${err.message}`);
    }

    isReconnecting = false;
    return false;
  }

  /**
   * 心跳检测循环（保守版）：
   * - 只有连续 REQUIRED_FAILED_PROBES 次「明确断开」才重启；
   * - 状态拿不到 / 空闲 / 长回复期间一律不动，避免打断正在生成的回复。
   */
  async function checkLoop() {
    if (isReconnecting) return;
    const status = await getChannelStatus();

    if (isExplicitlyDisconnected(status)) {
      consecutiveFailedProbes++;
      console.log(`[${PLUGIN_NAME}] ⚠️ 探测到通道断开 (${consecutiveFailedProbes}/${REQUIRED_FAILED_PROBES})`);
      if (consecutiveFailedProbes >= REQUIRED_FAILED_PROBES) {
        await restartChannel();
        consecutiveFailedProbes = 0;
      }
    } else {
      // 已连接、或无法判定：都视为正常，清零抖动计数，绝不重启
      if (consecutiveFailedProbes > 0) {
        console.log(`[${PLUGIN_NAME}] ✅ 通道恢复正常，取消重连计数`);
      }
      consecutiveFailedProbes = 0;
    }
  }

  return {
    name: PLUGIN_NAME,

    async onReady() {
      console.log(`[${PLUGIN_NAME}] 📡 保守重连监控启动 (检测间隔: ${CHECK_INTERVAL_MS/1000}s, 连续 ${REQUIRED_FAILED_PROBES} 次明确断开才重启, token=${authToken ? '已加载' : '缺失'})`);
      
      // 初始延迟3秒后开始检测
      await new Promise(r => setTimeout(r, 3000));
      await checkLoop();
      
      timer = setInterval(checkLoop, CHECK_INTERVAL_MS);
    },

    async onShutdown() {
      if (timer) clearInterval(timer);
      console.log(`[${PLUGIN_NAME}] 🛑 微信自动重连插件已停止`);
    }
  };
}
