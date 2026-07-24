/**
 * ESM: verify overflow/ordering recovery text detection used by session-overflow-rollover.
 */
import assert from 'assert';
import { isOverflowRecoveryText } from '../plugins/session-overflow-rollover/index.js';

const positives = [
  '⚠️ Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session.',
  '⚠️ Context is too large and auto-compaction could not recover this turn. Try again, use /compact, or use /new to start a fresh session.',
  'Message ordering conflict - please try again. If this persists, use /new to start a fresh session.',
  'roles must alternate between user and model',
  '⚠️ The model provider rejected the conversation state. Please try again, or use /new to start a fresh session.',
  '上下文溢出，请使用 /new 开启新会话',
];

const negatives = [
  '好的，我来帮你写一段代码',
  'use /help for more commands',
  'normal assistant reply without recovery banners',
];

for (const t of positives) {
  assert.equal(isOverflowRecoveryText(t), true, `expected positive: ${t.slice(0, 60)}`);
}
for (const t of negatives) {
  assert.equal(isOverflowRecoveryText(t), false, `expected negative: ${t}`);
}

console.log('overflow-recovery-text tests passed');
