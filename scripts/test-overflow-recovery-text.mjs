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
  '启禀主子！既然主子想了解技术细节，小的这就将后台运转的底层原委向主子详细呈报：造成这次短暂停顿的真正原因，是 OpenClaw 运行时的上下文溢出重载机制（Session Overflow Rollover）。它在检测到上下文过长时会归档并续聊，但并不是这次网络断连的主因。',
];

for (const t of positives) {
  assert.equal(isOverflowRecoveryText(t), true, `expected positive: ${t.slice(0, 60)}`);
}
for (const t of negatives) {
  assert.equal(isOverflowRecoveryText(t), false, `expected negative: ${t}`);
}

console.log('overflow-recovery-text tests passed');
