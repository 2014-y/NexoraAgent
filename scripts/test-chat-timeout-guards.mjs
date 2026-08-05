import fs from 'node:fs';
import assert from 'assert';
import vm from 'node:vm';

const renderer = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');

assert.match(renderer, /function withChatTimeout\(promise, timeoutMs, label, onTimeout\)/,
    'chat operations must have a shared timeout guard');
assert.match(renderer, /CHAT_ROLE_CONFIG_TIMEOUT_MS\s*=\s*4000/,
    'role config reads must be bounded');
assert.match(renderer, /CHAT_ROLE_COMMAND_TIMEOUT_MS\s*=\s*12000/,
    'role commands must be bounded');
assert.match(renderer, /handleChatRoleCommand\(text\)[\s\S]*withChatTimeout\(/,
    'role command execution must not hold the send lock forever');
assert.match(renderer, /saveRoleConfig\(\{ action: 'activate', roleId: role\.id \}\)[\s\S]*withChatTimeout\(/,
    'role activation IPC must be bounded');
assert.match(renderer, /loadChatModels\(\)[\s\S]*withChatTimeout\(/,
    'model list loading must be bounded before sending');
assert.match(renderer, /function readChatResponseText\(response, controller/,
    'response body reads must have an independent timeout');
assert.match(renderer, /CHAT_RESPONSE_MAX_CHARS\s*=\s*16 \* 1024 \* 1024/,
    'chat responses must have a size guard');
assert.match(renderer, /readChatResponseJson\(response, controller\)/,
    'chat JSON parsing must use the bounded reader');
assert.match(renderer, /e\.name === 'ChatTimeoutError'/,
    'chat timeout errors must be surfaced as recoverable request failures');
assert.match(renderer, /finally \{[\s\S]*releaseChatSend\(\)/,
    'all chat request paths must release the send lock');

const helperStart = renderer.indexOf('function withChatTimeout(');
const helperEnd = renderer.indexOf('async function readChatResponseText', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'timeout helper source must be extractable');
const timeoutContext = { setTimeout, clearTimeout, Promise, Error, Number, Math, api: null };
vm.runInNewContext(`${renderer.slice(helperStart, helperEnd)}\nthis.api = { withChatTimeout };`, timeoutContext);
let timeoutCallbackCalled = false;
const startedAt = Date.now();
await assert.rejects(
    timeoutContext.api.withChatTimeout(new Promise(() => {}), 30, 'test timeout', () => { timeoutCallbackCalled = true; }),
    (error) => error && error.name === 'ChatTimeoutError'
);
assert.equal(timeoutCallbackCalled, true, 'timeout callback must run');
assert.ok(Date.now() - startedAt < 500, 'timeout helper must resolve promptly');
assert.equal(await timeoutContext.api.withChatTimeout(Promise.resolve('ok'), 100, 'unused'), 'ok');

console.log('chat timeout guard tests passed');
