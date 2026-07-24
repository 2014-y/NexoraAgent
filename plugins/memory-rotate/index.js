/**
 * 记忆旋转插件 v1.1
 *
 * 防止 MEMORY.md 无限增长，自动将旧内容归档到 memory/ 目录。
 * 必须保留「Active session context」——溢出换新会话后的续聊锚点。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PLUGIN_NAME = 'memory-rotate';
const STATE_DIR = process.env.OPENCLAW_STATE_DIR
  || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(), '.openclaw');
const MEMORY_FILE = path.join(STATE_DIR, 'workspace', 'MEMORY.md');
const MEMORY_DIR = path.join(STATE_DIR, 'workspace', 'memory');
const MAX_CHARS = 4500;
const PROTECTED_HEADING = /^##\s+Active session context\b/i;

export default function createPlugin(runtime) {
  console.log(`[${PLUGIN_NAME}] 记忆旋转插件已加载 (上限: ${MAX_CHARS} chars)`);

  function parseSections(content) {
    const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
    const title = [];
    const sections = [];
    let cur = null;
    for (const line of lines) {
      if (/^#\s+/.test(line) && title.length === 0 && sections.length === 0 && !cur) {
        title.push(line);
        continue;
      }
      if (/^##\s+/.test(line)) {
        if (cur) sections.push(cur);
        cur = { heading: line.trim(), lines: [] };
        continue;
      }
      if (cur) cur.lines.push(line);
      else title.push(line);
    }
    if (cur) sections.push(cur);
    return { title, sections };
  }

  function render({ title, sections }) {
    let out = (title.join('\n').trim() || '# MEMORY.md') + '\n\n';
    out += sections
      .map((s) => [s.heading, ...s.lines].join('\n').replace(/\n+$/, '') + '\n')
      .join('\n');
    return out;
  }

  function rotateMemory() {
    try {
      if (!fs.existsSync(MEMORY_FILE)) return;
      const content = fs.readFileSync(MEMORY_FILE, 'utf-8');
      if (content.length <= MAX_CHARS) return;

      const { title, sections } = parseSections(content);
      const protectedSecs = sections.filter((s) => PROTECTED_HEADING.test(s.heading));
      const normalSecs = sections.filter((s) => !PROTECTED_HEADING.test(s.heading));

      // 保留：全部受保护区 + 最多 2 个普通区；其余归档
      const keepNormal = normalSecs.slice(0, 2);
      const archiveSecs = normalSecs.slice(2);
      if (archiveSecs.length === 0 && content.length > MAX_CHARS) {
        // 普通区本来就很少但仍超长：截断受保护区正文，不整段丢掉
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
        const archiveFile = path.join(MEMORY_DIR, `MEMORY-ARCHIVE-${dateStr}-${now.getTime()}.md`);
        fs.writeFileSync(archiveFile, content, 'utf-8');
        let trimmed = render({
          title,
          sections: [...protectedSecs, ...keepNormal],
        });
        if (trimmed.length > MAX_CHARS) trimmed = trimmed.slice(0, MAX_CHARS) + '\n';
        trimmed += `\n<!-- 已归档至 ${archiveFile} -->\n`;
        fs.writeFileSync(MEMORY_FILE, trimmed, 'utf-8');
        console.log(`[${PLUGIN_NAME}] MEMORY.md force-trimmed: ${content.length} -> ${trimmed.length} chars`);
        return;
      }

      if (archiveSecs.length === 0) return;

      if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const archiveFile = path.join(MEMORY_DIR, `MEMORY-ARCHIVE-${dateStr}-${now.getTime()}.md`);
      fs.writeFileSync(
        archiveFile,
        archiveSecs
          .map((s) => [s.heading, ...s.lines].join('\n').replace(/\n+$/, '') + '\n')
          .join('\n'),
        'utf-8'
      );

      let trimmed = render({
        title,
        sections: [...protectedSecs, ...keepNormal],
      });
      trimmed += `\n<!-- 已归档至 ${archiveFile} -->\n`;
      fs.writeFileSync(MEMORY_FILE, trimmed, 'utf-8');

      console.log(`[${PLUGIN_NAME}] MEMORY.md rotated: ${content.length} -> ${trimmed.length} chars (kept Active session context)`);
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
