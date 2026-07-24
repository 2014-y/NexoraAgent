'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const repair = require('../tool-turn-repair');

function testRepairMessages() {
  let r = repair.repairBrokenToolTurns([
    { role: 'tool', tool_call_id: '1', content: 'x' },
    { role: 'user', content: 'hi' },
  ]);
  assert.strictEqual(r.modified, true);
  assert.strictEqual(r.messages.length, 1);
  assert.strictEqual(r.messages[0].role, 'user');

  r = repair.repairBrokenToolTurns([
    {
      role: 'assistant',
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'exec', arguments: '{}' } }],
      content: null,
    },
    { role: 'user', content: 'hi' },
  ]);
  assert.strictEqual(r.modified, true);
  assert.ok(r.messages[0].tool_calls, 'should keep tool_calls and synthesize result');
  assert.strictEqual(r.messages[1].role, 'tool');
  assert.strictEqual(r.messages[1].tool_call_id, 'a');
  assert.strictEqual(r.messages[2].role, 'user');

  r = repair.repairBrokenToolTurns([
    {
      role: 'assistant',
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'exec', arguments: '{}' } }],
      content: null,
    },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'user', content: 'hi' },
  ]);
  assert.strictEqual(r.modified, false);
  assert.strictEqual(r.messages.length, 3);

  r = repair.repairBrokenToolTurns([
    {
      role: 'assistant',
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'exec', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'exec', arguments: '{}' } },
      ],
      content: null,
    },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'user', content: 'hi' },
  ]);
  assert.strictEqual(r.modified, true);
  assert.ok(r.messages[0].tool_calls);
  assert.strictEqual(r.messages[1].tool_call_id, 'a');
  assert.strictEqual(r.messages[2].role, 'tool');
  assert.strictEqual(r.messages[2].tool_call_id, 'b');
  assert.strictEqual(r.messages[3].role, 'user');

  // displaced tool after user → pull forward
  r = repair.repairBrokenToolTurns([
    {
      role: 'assistant',
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'exec', arguments: '{}' } }],
      content: null,
    },
    { role: 'user', content: 'note' },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
  ]);
  assert.strictEqual(r.modified, true);
  assert.strictEqual(r.messages[0].role, 'assistant');
  assert.strictEqual(r.messages[1].role, 'tool');
  assert.strictEqual(r.messages[1].tool_call_id, 'a');
  assert.strictEqual(r.messages[2].role, 'user');

  // 混在普通 user 里的残留 tool_result 应被剥掉
  r = repair.repairBrokenToolTurns([
    { role: 'user', content: 'hi' },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'x', content: 'orphan' },
        { type: 'text', text: 'keep me' },
      ],
    },
  ]);
  assert.strictEqual(r.modified, true);
  assert.strictEqual(r.messages.length, 2);
  assert.ok(Array.isArray(r.messages[1].content));
  assert.ok(!r.messages[1].content.some((p) => p.type === 'tool_result'));
  assert.ok(r.messages[1].content.some((p) => p.type === 'text' && p.text === 'keep me'));

  // OpenClaw 原生：健康的 toolCall + toolResult 绝不能被改写
  r = repair.repairBrokenToolTurns([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'toolCall', id: 'call_abc', name: 'memory_get', arguments: {} },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call_abc',
      toolName: 'memory_get',
      isError: false,
      content: [{ type: 'text', text: '{}' }],
    },
  ]);
  assert.strictEqual(r.modified, false, 'native OpenClaw pair must stay untouched');
  assert.strictEqual(r.messages.length, 3);
  assert.strictEqual(r.messages[2].role, 'toolResult');

  // OpenClaw：缺 toolResult 时应合成 role:toolResult，而不是 Anthropic user
  r = repair.repairBrokenToolTurns([
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_x', name: 'read', arguments: { path: 'a' } }],
    },
    { role: 'user', content: 'again' },
  ]);
  assert.strictEqual(r.modified, true);
  assert.strictEqual(r.messages[1].role, 'toolResult');
  assert.strictEqual(r.messages[1].toolCallId, 'call_x');
  assert.strictEqual(r.messages[1].toolName, 'read');
  assert.strictEqual(r.messages[2].role, 'user');
}

function testSliceKeepsPairs() {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push({ type: 'message', message: { role: 'user', content: `u${i}` } });
    lines.push({ type: 'message', message: { role: 'assistant', content: `a${i}` } });
  }
  lines.push({
    type: 'message',
    message: {
      role: 'assistant',
      tool_calls: [{ id: 'z', type: 'function', function: { name: 'exec', arguments: '{}' } }],
      content: null,
    },
  });
  lines.push({ type: 'message', message: { role: 'tool', tool_call_id: 'z', content: 'done' } });
  lines.push({ type: 'message', message: { role: 'user', content: 'continue' } });

  const sliced = repair.sliceSessionLinesKeepingToolPairs(lines, 5);
  const msgs = sliced.lines.filter((l) => l.type === 'message').map((l) => l.message);
  const r2 = repair.repairBrokenToolTurns(msgs);
  assert.strictEqual(r2.modified, false, 'sliced window must already be tool-pair safe');
}

function testSessionFileHeal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolheal-'));
  const file = path.join(dir, 't.jsonl');
  const rows = [
    { type: 'session', id: 's1' },
    { type: 'message', message: { role: 'user', content: 'hi' } },
    {
      type: 'message',
      message: {
        role: 'assistant',
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'exec', arguments: '{}' } }],
        content: null,
      },
    },
    { type: 'message', message: { role: 'user', content: 'again' } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = repair.healSessionTranscriptFile(file, fs);
  assert.strictEqual(r.changed, true);
  const healed = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const asst = healed.find((x) => x.type === 'message' && x.message.role === 'assistant');
  assert.ok(asst);
  assert.ok(asst.message.tool_calls);
  const tool = healed.find((x) => x.type === 'message' && x.message.role === 'tool');
  assert.ok(tool);
  assert.strictEqual(tool.message.tool_call_id, 'a');
  assert.ok(
    repair.looksLikeToolPairFormatError(
      'function response turn comes immediately after a function call turn'
    )
  );
  assert.ok(
    repair.looksLikeToolPairFormatError(
      'Message ordering conflict - please try again. If this persists, use /new to start a fresh session.'
    )
  );
  assert.ok(repair.looksLikeToolPairFormatError('roles must alternate between user and model'));
  fs.rmSync(dir, { recursive: true, force: true });
}

testRepairMessages();
testSliceKeepsPairs();
testSessionFileHeal();
console.log('tool-turn-repair tests passed');
