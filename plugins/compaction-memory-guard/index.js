import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const PLUGIN_NAME = 'compaction-memory-guard';
/** 每会话最短追加间隔：默认 10 分钟，避免每回合都写 MEMORY.md 跟 memory-rotate 抢写（defect 4） */
const APPEND_THROTTLE_MS = Number(process.env.NEXORA_MEMORY_GUARD_THROTTLE_MS || 10 * 60 * 1000);
/** 每会话上次追加记录：sessionFile -> { at, fp }（fp = 内容指纹，用于跳过重复块） */
const lastAppendBySession = new Map();
const MEMORY_FILE = path.join(
  process.env.OPENCLAW_STATE_DIR
    || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(), '.openclaw'),
  'workspace',
  'MEMORY.md'
);

function createLegacyPlugin(runtime) {
  console.log(`[${PLUGIN_NAME}] 记忆保护插件已加载`);

  function readCurrentMemory() {
    try {
      if (fs.existsSync(MEMORY_FILE)) return fs.readFileSync(MEMORY_FILE, 'utf-8');
    } catch (e) {}
    return '';
  }

  function appendToMemory(summary) {
    try {
      const dir = path.dirname(MEMORY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, '', 'utf-8');
      const timestamp = new Date().toISOString().split('T')[0];
      const entry = `\n## [自动备份] ${timestamp}\n${summary}\n`;
      fs.appendFileSync(MEMORY_FILE, entry, 'utf-8');
      console.log(`[${PLUGIN_NAME}] 对话摘要已备份到 MEMORY.md`);
    } catch (e) {
      console.error(`[${PLUGIN_NAME}] 写入失败: ${e.message}`);
    }
  }

  return {
    name: PLUGIN_NAME,

    async onAfterResponse(context) {
      try {
        const sessionFile = context?.sessionFile;
        if (sessionFile && fs.existsSync(sessionFile)) {
          const content = fs.readFileSync(sessionFile, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          if (lines.length > 50) {
            const recentLines = lines.slice(-10);
            const summary = recentLines.map(l => {
              try {
                const obj = JSON.parse(l);
                if (obj.message?.content) {
                  const text = typeof obj.message.content === 'string'
                    ? obj.message.content
                    : obj.message.content.map(c => c.text || '').join('');
                  return `[${obj.message.role}]: ${text.substring(0, 200)}`;
                }
              } catch {}
              return '';
            }).filter(Boolean).join('\n');
            if (summary) {
              // 节流 + 去重：每会话最多每 APPEND_THROTTLE_MS 追加一次，且内容与上次相同则跳过，
              // 避免每回合都写「最近 10 行」把 MEMORY.md 撑爆并与 memory-rotate 互相打架（defect 4）
              const sessKey = String(sessionFile);
              const fp = crypto.createHash('sha1').update(summary).digest('hex');
              const prev = lastAppendBySession.get(sessKey);
              const now = Date.now();
              if (prev && (now - prev.at < APPEND_THROTTLE_MS || prev.fp === fp)) {
                // 距上次太近或内容重复：本轮不写
              } else {
                lastAppendBySession.set(sessKey, { at: now, fp });
                // 轻量封顶，避免 Map 随会话数无界增长
                if (lastAppendBySession.size > 500) {
                  for (const [k, v] of lastAppendBySession) {
                    if (now - (v && v.at || 0) > APPEND_THROTTLE_MS) lastAppendBySession.delete(k);
                  }
                }
                appendToMemory(summary);
              }
            }
          }
        }
      } catch (e) {}
    },

    async onShutdown() {
      console.log(`[${PLUGIN_NAME}] 插件已停止`);
    },
  };
}

export default definePluginEntry({
  id: PLUGIN_NAME,
  name: 'Compaction Memory Guard',
  description: '对话压缩后自动备份近期关键信息到 MEMORY.md',
  register(api) {
    const legacy = createLegacyPlugin({ ...api.runtime, config: api.config });
    api.on('after_compaction', async (event) => {
      await legacy.onAfterResponse?.({ sessionFile: event?.sessionFile });
    }, { timeoutMs: 30_000 });
    api.on('gateway_stop', async () => {
      await legacy.onShutdown?.();
    });
  },
});
