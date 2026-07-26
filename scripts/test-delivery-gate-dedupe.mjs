/**
 * Regression: reply_payload remember must NOT cause message_sending silence.
 * WeChat fires reply_payload_sending then message_sending for the same runId.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const modUrl = pathToFileURL(path.join(process.cwd(), 'plugins', 'error-filter', 'index.js')).href;
const { __testables: t } = await import(modUrl + '?t=' + Date.now());

t.resetMediaDedupeState();

const event = {
  runId: 'run-delivery-gate-1',
  to: 'wxid_test_peer',
  metadata: { runId: 'run-delivery-gate-1', channel: 'openclaw-weixin' },
};
const text =
  '启禀主子！这是一轮正常回复，用于验证微信二道门不会被去重误杀。后续还有更多说明与步骤。';

// Simulate reply_payload_sending approve
t.rememberRunOutbound(event, text);

if (!t.runAlreadyRecordedTextOutbound(event)) {
  console.error('FAIL remember did not record run');
  process.exit(1);
}

// Same text at channel layer must NOT cancel (fingerprint match would cancel at reply layer only)
const wouldCancelAtReply = t.shouldCancelDuplicateRunOutbound(event, text);
if (!wouldCancelAtReply) {
  console.error('FAIL expected reply-layer duplicate detect for identical text');
  process.exit(1);
}

// Different bubble in same run should NOT cancel
const bubble2 = '启禀主子！这是同一轮的第二条不同气泡，补充技术细节与操作步骤说明。';
const cancelBubble2 = t.shouldCancelDuplicateRunOutbound(event, bubble2);
if (cancelBubble2) {
  console.error('FAIL multi-bubble different text should not cancel');
  process.exit(1);
}

// No runId on channel event: fingerprint stamp must still approve
t.resetMediaDedupeState();
const text2 = '启禀主子！无 runId 场景下 reply 盖章后，微信二道门必须放行本条正文，不能静默。';
t.rememberRunOutbound({ runId: 'r-fp-1', metadata: { runId: 'r-fp-1' } }, text2);
const channelNoRun = { to: 'wxid_norun', metadata: { channel: 'openclaw-weixin' } };
if (!t.isChannelDeliveryAlreadyApproved(channelNoRun, text2)) {
  console.error('FAIL fingerprint approve without runId');
  process.exit(1);
}

console.log('PASS delivery-gate: remember + identical detect + multi-bubble allow + no-runId stamp');
console.log('DELIVERY_GATE_OK');
