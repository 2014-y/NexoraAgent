/**
 * Verify chat.send resume params carry explicit WeChat delivery route.
 */
import assert from 'assert';
import {
  buildChatSendParams,
  isOverflowRecoveryText,
} from '../plugins/session-overflow-rollover/index.js';

const params = buildChatSendParams(
  'agent:main:main',
  '继续刚才的校验规则',
  {
    channel: 'openclaw-weixin',
    to: 'user-abc',
    accountId: 'acct-1',
  }
);

assert.equal(params.deliver, true);
assert.equal(params.originatingChannel, 'openclaw-weixin');
assert.equal(params.originatingTo, 'user-abc');
assert.equal(params.originatingAccountId, 'acct-1');
assert.ok(params.idempotencyKey);

const bare = buildChatSendParams('agent:main:main', 'hi', null);
assert.equal(bare.deliver, true);
assert.equal(bare.originatingChannel, undefined);

assert.equal(
  isOverflowRecoveryText(
    'Message ordering conflict - please try again. If this persists, use /new to start a fresh session.'
  ),
  true
);

console.log('overflow-delivery-route tests passed');
