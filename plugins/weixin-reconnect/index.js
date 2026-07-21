/**
 * WeChat 自动重连增强插件 v3 (高可用网关重连版)
 * 
 * 监控 WeChat channel 连接状态，检测到断线后自动触发重连。
 * 采用指数退避无限重发机制，解决网络网关断掉后无限卡死不回复问题。
 */

const PLUGIN_NAME = 'weixin-reconnect';
const GATEWAY_URL = 'http://127.0.0.1:18789';
const CHECK_INTERVAL_MS = 15_000;          // 每15秒检查一次
const DISCONNECT_THRESHOLD_MS = 45_000;     // 45秒无活动视为断网/断线
const MAX_RECONNECT_ATTEMPTS = 999999;      // 无限次自动退避重连，避免网络恢复后彻底死死挂住
const RECONNECT_COOLDOWN_MS = 5_000;        // 重连基础冷却时间 5 秒

export default function createPlugin(runtime) {
  console.log(`[${PLUGIN_NAME}] 🔌 WeChat 自动重连插件 (v3 高可用增强版) 已加载`);

  let lastEventAt = Date.now();
  let consecutiveDisconnects = 0;
  let isReconnecting = false;
  let timer = null;

  /** 查询 WeChat channel 状态 */
  async function getChannelStatus() {
    try {
      const resp = await fetch(`${GATEWAY_URL}/api/channels/openclaw-weixin/status`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  /** 重启 WeChat channel */
  async function restartChannel() {
    if (isReconnecting) {
      console.log(`[${PLUGIN_NAME}] ⏳ 重连进行中，跳过重发`);
      return false;
    }

    isReconnecting = true;
    consecutiveDisconnects++;

    // 指数退避等待，最大退避 60 秒
    const backoffMs = Math.min(RECONNECT_COOLDOWN_MS * Math.pow(1.5, Math.min(consecutiveDisconnects, 8)), 60_000);
    console.log(`[${PLUGIN_NAME}] 🔄 自动重启 WeChat channel (第 ${consecutiveDisconnects} 次尝试，退避间隔: ${Math.round(backoffMs/1000)}s)...`);

    if (consecutiveDisconnects > 1) {
      await new Promise(r => setTimeout(r, backoffMs));
    }

    try {
      // 通过 gateway RPC 重启 channel
      const resp = await fetch(`${GATEWAY_URL}/api/channels/openclaw-weixin/restart`, {
        method: 'POST',
        signal: AbortSignal.timeout(12000)
      });

      if (resp.ok) {
        console.log(`[${PLUGIN_NAME}] ✅ WeChat channel 重启重连指令发起成功`);
        // 尝试触发一次握手状态检查
        const postStatus = await getChannelStatus();
        if (postStatus && postStatus.connected !== false) {
          consecutiveDisconnects = 0;
          lastEventAt = Date.now();
        }
        isReconnecting = false;
        return true;
      } else {
        console.log(`[${PLUGIN_NAME}] ⚠️ 重启回应状态异常: ${resp.status}`);
      }
    } catch (err) {
      console.log(`[${PLUGIN_NAME}] ⚠️ 网关重启响应网络异常: ${err.message}`);
    }

    isReconnecting = false;
    return false;
  }

  /** 心跳检测循环 */
  async function checkLoop() {
    const status = await getChannelStatus();

    if (status) {
      // 从状态中提取最后活动时间
      const account = status.accounts?.[0] || status;
      const lastActivity = account.lastEventAt || account.last_activity || account.lastPingAt || 0;

      if (lastActivity > lastEventAt) {
        lastEventAt = lastActivity;
        if (consecutiveDisconnects > 0) {
          console.log(`[${PLUGIN_NAME}] 🎉 检测到微信网关已有新的收发活动，连接自动恢复完成！`);
        }
        consecutiveDisconnects = 0; // 有活动就自动恢复
      }

      // 检查是否断线
      const inactiveMs = Date.now() - lastEventAt;
      if (lastEventAt > 0 && inactiveMs > DISCONNECT_THRESHOLD_MS) {
        console.log(`[${PLUGIN_NAME}] ⚠️ 检测到网络抖动/通道静默: ${Math.round(inactiveMs / 1000)} 秒无收发包活动`);
        await restartChannel();
      } else if (lastEventAt > 0) {
        if (consecutiveDisconnects > 0) {
          console.log(`[${PLUGIN_NAME}] ✅ WeChat 连接握手成功`);
          consecutiveDisconnects = 0;
        }
      }
    } else {
      // API 返回 null，网关接口暂时不可达（网络阻塞）
      console.log(`[${PLUGIN_NAME}] ℹ️ 本地 Gateway API 响应超时，尝试拉起连接检测...`);
      await restartChannel();
    }
  }

  return {
    name: PLUGIN_NAME,

    async onReady() {
      console.log(`[${PLUGIN_NAME}] 📡 高可用监控机制启动 (检测间隔: ${CHECK_INTERVAL_MS/1000}s, 静默断线阈值: ${DISCONNECT_THRESHOLD_MS/1000}s)`);
      
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
