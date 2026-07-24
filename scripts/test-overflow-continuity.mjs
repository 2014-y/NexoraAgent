/**
 * Continuity after overflow rollover: must not "forget" prior chat.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildContinuitySummary,
  buildContinuePrompt,
  upsertActiveSessionContext,
} from '../plugins/session-overflow-rollover/index.js';

function writeSession(dir, turns) {
  const file = path.join(dir, 'sess.jsonl');
  const lines = turns.map((t) =>
    JSON.stringify({
      type: 'message',
      message: { role: t.role, content: t.text },
    })
  );
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-'));
try {
  const sessionFile = writeSession(dir, [
    { role: 'user', text: '我叫小明，请记住。' },
    { role: 'assistant', text: '好的，以后叫你小明。' },
    { role: 'user', text: '帮我写个登录页' },
    { role: 'assistant', text: '可以用 React + Tailwind 做登录页。' },
    { role: 'user', text: '那注册页呢？' },
    { role: 'assistant', text: '注册页可复用登录页表单结构。' },
    { role: 'user', text: '继续把校验规则补上' },
  ]);

  const summary = buildContinuitySummary(sessionFile, '继续把校验规则补上');
  assert.ok(summary.includes('小明'), 'should keep identity fact');
  assert.ok(/登录|注册|校验/.test(summary), 'should keep recent topic');
  assert.ok(summary.length <= 950, 'summary must stay compact');

  const prompt = buildContinuePrompt('继续把校验规则补上', summary);
  assert.ok(prompt.includes('继续把校验规则补上'));
  assert.ok(prompt.includes('内部延续上下文'));
  assert.ok(prompt.includes('小明'));
  const promptWithArchive = buildContinuePrompt('继续把校验规则补上', summary, 'memory/last-session-archive.md');
  assert.ok(promptWithArchive.includes('memory/last-session-archive.md'));
  assert.ok(promptWithArchive.includes('read'));

  const memDir = path.join(dir, 'workspace');
  fs.mkdirSync(memDir, { recursive: true });
  process.env.OPENCLAW_STATE_DIR = dir;
  const memFile = path.join(memDir, 'MEMORY.md');
  fs.writeFileSync(
    memFile,
    '# MEMORY.md\n\n## 核心身份\n- 助手\n\n## 用户偏好\n- 中文\n',
    'utf8'
  );

  // Re-import path uses stateDir() from env — upsert reads OPENCLAW_STATE_DIR
  assert.equal(upsertActiveSessionContext(summary), true);
  const mem = fs.readFileSync(memFile, 'utf8');
  assert.ok(mem.includes('## Active session context'));
  assert.ok(mem.includes('小明'));
  // Active section should appear before 核心身份
  assert.ok(
    mem.indexOf('## Active session context') < mem.indexOf('## 核心身份'),
    'Active context must stay near top for bootstrap'
  );

  console.log('overflow-continuity tests passed');
} finally {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}
