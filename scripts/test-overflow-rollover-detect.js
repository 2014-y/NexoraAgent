'use strict';
/**
 * Regression: window-full / role-ordering recovery must trigger silent rollover,
 * not just get cancelled into channel mute.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const trigger = require('../overflow-rollover-trigger');

function testLogDetection() {
  assert.strictEqual(
    trigger.isCompactionOverflowFailureLog(
      '[compaction-diag] outcome=failed reason=timeout sessionKey=agent:main:main'
    ),
    true
  );
  assert.strictEqual(
    trigger.isCompactionOverflowFailureLog(
      'Message ordering conflict - please try again. If this persists, use /new to start a fresh session.'
    ),
    true
  );
  assert.strictEqual(
    trigger.isCompactionOverflowFailureLog('roles must alternate between user and model'),
    true
  );
  assert.strictEqual(
    trigger.isCompactionOverflowFailureLog('hello world normal chat'),
    false
  );
}

function testQueueWritesTrigger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf-trig-'));
  try {
    const r = trigger.queueOverflowRolloverFromLog(
      dir,
      'Message ordering conflict sessionKey=agent:main:openclaw-weixin:dm:abc use /new to start a fresh session.'
    );
    assert.strictEqual(r.queued, true);
    assert.strictEqual(r.sessionKey, 'agent:main:openclaw-weixin:dm:abc');
    const file = path.join(dir, trigger.TRIGGER_NAME);
    assert.ok(fs.existsSync(file));
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(/ordering|state|compaction/i.test(obj.reason));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

testLogDetection();
testQueueWritesTrigger();
console.log('overflow-rollover-detect tests passed');
