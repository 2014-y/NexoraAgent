/**
 * Continuity after overflow rollover: must not "forget" prior chat.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pluginEntry, {
  pendingContinuityFile,
  writePendingContinuity,
} from '../plugins/session-overflow-rollover/index.js';
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
  process.env.OPENCLAW_STATE_DIR = dir;
  const memDir = path.join(dir, 'workspace');
  fs.mkdirSync(memDir, { recursive: true });
  const memFile = path.join(memDir, 'MEMORY.md');
  fs.writeFileSync(
    memFile,
    '# MEMORY.md\n\n## Active session context\n- 更新: 2026-08-05T00:00:00.000Z\n- 说明: 测试\n此前任务: 门户改版正在处理节点列表刷新。\n\n## 核心身份\n- 助手\n\n## 用户偏好\n- 中文\n',
    'utf8'
  );

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
  assert.ok(summary.includes('门户改版'), 'should carry the previous rollover context forward');
  assert.ok(summary.length <= 1500, 'summary must stay compact');

  const prompt = buildContinuePrompt('继续把校验规则补上', summary);
  assert.ok(prompt.includes('继续把校验规则补上'));
  assert.ok(prompt.includes('内部延续上下文'));
  assert.ok(prompt.includes('小明'));
  const promptWithArchive = buildContinuePrompt('继续把校验规则补上', summary, 'memory/last-session-archive.md');
  assert.ok(promptWithArchive.includes('memory/last-session-archive.md'));
  assert.ok(promptWithArchive.includes('read'));

  assert.equal(upsertActiveSessionContext(summary), true);
  const mem = fs.readFileSync(memFile, 'utf8');
  assert.ok(mem.includes('## Active session context'));
  assert.ok(mem.includes('小明'));
  // Active section should appear before 核心身份
  assert.ok(
    mem.indexOf('## Active session context') < mem.indexOf('## 核心身份'),
    'Active context must stay near top for bootstrap'
  );

  const noisySession = writeSession(dir, [
    {
      role: 'user',
      text: `[Image] User text: 为什么报错 Description: ${'节点列表与界面截图描述。'.repeat(600)}`,
    },
    { role: 'assistant', text: '节点接口请求超时，正在检查代理链路。' },
    { role: 'user', text: '把自动刷新也一起修好' },
    { role: 'assistant', text: '已定位自动刷新会重复发起请求。' },
    { role: 'user', text: '继续修复自动刷新' },
  ]);
  const noisySummary = buildContinuitySummary(noisySession, '继续修复自动刷新');
  assert.ok(noisySummary.includes('继续修复自动刷新'), 'latest question must survive verbose image metadata');
  assert.ok(noisySummary.includes('自动刷新'), 'latest task state must be retained');
  assert.ok(noisySummary.length <= 1500, 'verbose image metadata must remain bounded');

  // Pending continuity is a two-phase handoff: failed model calls keep it; success acknowledges it.
  const handlers = new Map();
  const api = {
    logger: { info() {} },
    runtime: { gateway: { async request() { return {}; } } },
    on(name, handler) { handlers.set(name, handler); },
  };
  pluginEntry.register(api);
  const sessionKey = 'agent:main:test-continuity';
  assert.equal(
    writePendingContinuity(sessionKey, { summary: noisySummary, archivePath: 'memory/last-session-archive.md' }, ''),
    true
  );
  const pendingFile = pendingContinuityFile(sessionKey);
  const injected = await handlers.get('before_prompt_build')({}, { sessionKey, trigger: 'user' });
  assert.ok(injected?.prependContext?.includes('继续修复自动刷新'));
  assert.ok(fs.existsSync(pendingFile), 'pending memory must remain until the model turn succeeds');

  await handlers.get('agent_end')({ success: false, error: 'network reset' }, { sessionKey });
  assert.ok(fs.existsSync(pendingFile), 'failed model turn must retain pending memory for retry');
  const reinjected = await handlers.get('before_prompt_build')({}, { sessionKey, trigger: 'user' });
  assert.ok(reinjected?.prependContext?.includes('继续修复自动刷新'));
  await handlers.get('agent_end')({ success: true }, { sessionKey });
  assert.equal(fs.existsSync(pendingFile), false, 'successful model turn should acknowledge pending memory');
  pluginEntry.shutdown();

  console.log('overflow-continuity tests passed');
} finally {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}
