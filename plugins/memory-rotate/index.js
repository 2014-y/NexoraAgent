/**
 * 记忆旋转插件 v1.0
 * 
 * 防止 MEMORY.md 无限增长，自动将旧内容归档到 memory/ 目录
 */

import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_NAME = 'memory-rotate';
const MEMORY_FILE = '$env:USERPROFILE\\.openclaw\\workspace\\MEMORY.md';
const MEMORY_DIR = '$env:USERPROFILE\\.openclaw\\workspace\\memory';
const MAX_CHARS = 2000;

export default function createPlugin(runtime) {
  console.log(`[${PLUGIN_NAME}] 记忆旋转插件已加载 (上限: ${MAX_CHARS} chars)`);

  function rotateMemory() {
    try {
      if (!fs.existsSync(MEMORY_FILE)) return;
      const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
      if (content.length <= MAX_CHARS) return;

      const lines = content.split('\n');
      const keepLines = [];
      const archiveLines = [];
      let sectionCount = 0;
      let inArchive = false;

      for (const line of lines) {
        if (line.startsWith('## ')) {
          sectionCount++;
          if (sectionCount > 2) inArchive = true;
        }
        if (inArchive) {
          archiveLines.push(line);
        } else {
          keepLines.push(line);
        }
      }

      if (archiveLines.length === 0) {
        const keepCount = Math.floor(lines.length * 0.4);
        for (let i = 0; i < keepCount; i++) keepLines.push(lines[i]);
        for (let i = keepCount; i < lines.length; i++) archiveLines.push(lines[i]);
      }

      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const archiveFile = path.join(MEMORY_DIR, `MEMORY-ARCHIVE-${dateStr}-${now.getTime()}.md`);
      fs.writeFileSync(archiveFile, archiveLines.join('\n'), 'utf-8');
      
      const trimmed = [...keepLines, '', `<!-- 已归档至 ${archiveFile} -->`, ''].join('\n');
      fs.writeFileSync(MEMORY_FILE, trimmed, 'utf-8');

      console.log(`[${PLUGIN_NAME}] MEMORY.md rotated: ${content.length} -> ${trimmed.length} chars`);
    } catch (e) {
      console.error(`[${PLUGIN_NAME}] Rotation failed: ${e.message}`);
    }
  }

  rotateMemory();

  return {
    name: PLUGIN_NAME,
    async onAfterResponse(context) { rotateMemory(); },
    async onShutdown() { console.log(`[${PLUGIN_NAME}] stopped`); },
  };
}
