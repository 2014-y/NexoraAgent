import fs from 'node:fs';

const PLUGIN_NAME = 'error-filter';

// ALL error/notification patterns that should be suppressed
const ERROR_PATTERNS = [
  // Emoji notifications
  '⚠️',
  '🛠️',
  '❌',
  '⚡',
  
  // System command failures
  'del ~',
  'Get-NetAdapter',
  'wmic cpu',
  'netsh ',
  'audio_check',
  'audio.ps1',
  'temp_hw',
  'status_check',
  
  // Config/system errors
  'consoleLevel',
  'redactSensitive',
  'browser.ssrfPolicy',
  'startup_failed',
  'plugin already exists',
  'State dir migration',
  'Config observe',
  'doctor warnings',
  'config warnings',
  'bonjour.*conflict',
  'plugins\\.allow is empty',
  
  // WeChat channel errors
  'fetch failed',
  'getUpdates',
  'sendTyping',
  'POST fetch failed',
  'ilinkai.weixin.qq.com',
  'Monitor ended',
  'notifyStart failed',
  'failed to load bundled channel',
  'missing generated module',
  'Could not determine host',
  
  // Generic error patterns
  'TypeError:',
  'AbortError:',
  'ETIMEDOUT',
  'TCP connection timeout',
  'request timeout',
  'TLS handshake error',
  'code=UND_ERR',
  'code=ETIMEDOUT',
  'getUpdates error',
  'TTS conversion failed',
  
  // Cleanup/health check messages
  '临时文件已清理',
  'cleanup',
  'health check',
  'diagnostic',

  // Heartbeat notifications
  'HEARTBEAT_OK',
  'HEARTBEAT',
  
  // Delivery recovery logs on startup
  'delivery-recovery',
  'send_attempt_started',
  'refusing blind replay',
];

function isErrorMessage(text) {
  if (!text || typeof text !== 'string') return false;
  const lowerText = text.toLowerCase();
  return ERROR_PATTERNS.some(p => {
    try {
      const regex = new RegExp(p, 'i');
      return regex.test(text);
    } catch (e) {
      return lowerText.includes(p.toLowerCase());
    }
  });
}

export default function createPlugin(runtime) {
  console.log(`[${PLUGIN_NAME}] 错误过滤插件已加载 (${ERROR_PATTERNS.length} 个过滤规则)`);
  
  return {
    name: PLUGIN_NAME,

    async onReady() {
      console.log(`[${PLUGIN_NAME}] 已就绪，开始拦截系统错误通知`);
    },

    // KEY HOOK: Intercept ALL incoming messages before processing
    async onMessage(context) {
      try {
        const msg = context?.message?.content || context?.content || '';
        
        if (isErrorMessage(msg)) {
          console.log(`[${PLUGIN_NAME}] 拦截系统通知: ${msg.substring(0, 80)}`);
          // Return null/undefined to suppress the message
          return null;
        }
      } catch (e) {
        // Never crash
        console.error(`[${PLUGIN_NAME}] 拦截异常: ${e.message}`);
      }
      // Continue normal processing
      return context;
    },

    async onAfterResponse(context) {
      // Secondary defense: also check responses
      try {
        const response = context?.response;
        const text = typeof response === 'string' ? response : 
          (response?.content?.map?.(c => c.text || '').join('') || '');
        
        if (isErrorMessage(text)) {
          console.log(`[${PLUGIN_NAME}] 二次拦截响应: ${text.substring(0, 80)}`);
        }
      } catch (e) {}
    },

    async onShutdown() {
      console.log(`[${PLUGIN_NAME}] 插件已停止`);
    }
  };
}
