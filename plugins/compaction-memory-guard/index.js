import fs from 'node:fs';

const PLUGIN_NAME = 'compaction-memory-guard';
const MEMORY_FILE = '$env:USERPROFILE\\.openclaw\\workspace\\MEMORY.md';

export default function createPlugin(runtime) {
  console.log(`[${PLUGIN_NAME}] 记忆保护插件已加载`);

  function readCurrentMemory() {
    try {
      if (fs.existsSync(MEMORY_FILE)) return fs.readFileSync(MEMORY_FILE, 'utf-8');
    } catch (e) {}
    return '';
  }

  function appendToMemory(summary) {
    try {
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
            if (summary) appendToMemory(summary);
          }
        }
      } catch (e) {}
    },

    async onShutdown() {
      console.log(`[${PLUGIN_NAME}] 插件已停止`);
    },
  };
}
