/**
 * Unit tests for local-model tool-call guard helpers in patch_gateway.js
 * Run: node scripts/test-local-model-guard.js
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'patch_gateway.js'), 'utf8');
const start = src.indexOf('function isLlmProxyPath');
const end = src.indexOf('// ─── 全局 API Key');
if (start < 0 || end < 0) {
  console.error('Could not locate helper functions in patch_gateway.js');
  process.exit(1);
}
eval(src.slice(start, end));

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed += 1;
  console.log('OK:', msg);
}

assert(isLlmProxyPath('/api/chat') === true, 'detect /api/chat');
assert(isLlmProxyPath('/api/chat?stream=true') === true, 'detect /api/chat?');
assert(isLlmProxyPath('http://127.0.0.1:11434/api/chat') === true, 'detect full ollama url');
assert(isLlmProxyPath('/api/chat/') === true, 'detect /api/chat/ trailing slash');
assert(isLlmProxyPath('/v1/chat/completions') === true, 'detect completions');
assert(isLlmProxyPath('/api/embeddings') === true, 'detect embeddings');
assert(isLlmProxyPath('/api/chat/media/outgoing/x') === false, 'exclude media path');
assert(isLlmProxyPath('/health') === false, 'ignore health');

assert(isLocalModelRequest('local-test', 'http://127.0.0.1:11434/api/chat') === true, 'any model on 11434 is local');
assert(isLocalModelRequest('local-test', 'http://localhost:11434/api/chat') === true, 'named model on localhost is local via host');
assert(isLocalModelRequest('local-test', 'https://api.example.com/v1/chat/completions') === false, 'model name alone NOT local');
assert(isLocalModelRequest('cloud-only-name', 'https://api.example.com/v1/chat/completions') === false, 'unknown name on cloud URL NOT local');
assert(isLocalModelRequest('qwen3-max', 'https://dashscope.aliyuncs.com/v1/chat/completions') === false, 'cloud qwen3 NOT local');
assert(isLocalModelRequest('agnes-2.0-flash', 'https://apihub.agnes-ai.com/v1/chat/completions') === false, 'agnes NOT local');
assert(isLocalModelRequest('something', 'http://127.0.0.1:11434/api/chat') === true, 'any model on 11434 is local');
assert(isLocalModelRequest('ollama/qwen2.5:7b', 'https://api.example.com/v1') === true, 'ollama/ prefix is local');

assert(
  sanitizeRawToolCallContent('{"name":"tts","arguments":{"text":"你好","timeoutMs":5000}}') === '你好',
  'tts -> text'
);
assert(
  sanitizeRawToolCallContent('{"name":"update_goal","arguments":{"status":"blocked"}}') === '',
  'update_goal cleared'
);
assert(sanitizeRawToolCallContent('你好呀') === '你好呀', 'normal text kept');
assert(
  sanitizeRawToolCallContent('请用 JSON：{"name":"x"}') === '请用 JSON：{"name":"x"}',
  'incomplete JSON not treated as tool call'
);

const body = {
  model: 'local-test',
  tools: [{ name: 'tts' }, { name: 'update_goal' }],
  tool_choice: 'auto',
  messages: [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '{"name":"tts","arguments":{"text":"你好","timeoutMs":5000}}' },
    { role: 'assistant', content: '{"name":"update_goal","arguments":{"status":"blocked"}}' },
    { role: 'user', content: '再来' }
  ]
};
const mod = scrubLocalModelRequestBody(body, 'http://127.0.0.1:11434/api/chat');
assert(mod === true, 'body modified');
assert(!body.tools && !body.tool_choice, 'tools stripped');
assert(body.messages.some((m) => m.role === 'assistant' && m.content === '你好'), 'tts rewritten to 你好');
assert(
  !body.messages.some((m) => m.role === 'assistant' && m.content && String(m.content).includes('update_goal')),
  'update_goal assistant message removed'
);
assert(
  body.messages[0] && body.messages[0].role === 'system' && String(body.messages[0].content).includes('[LocalModelGuard]'),
  'local guard system message injected'
);

// Idempotent guard injection
const modAgain = scrubLocalModelRequestBody(body, 'http://127.0.0.1:11434/api/chat');
const guardCount = body.messages.filter((m) => m.role === 'system' && String(m.content || '').includes('[LocalModelGuard]')).length;
assert(guardCount === 1, 'guard injected only once');
assert(modAgain === false, 'second scrub is no-op when already cleaned');

const cloud = {
  model: 'qwen3-max',
  tools: [{ name: 'tts' }],
  tool_choice: 'auto',
  messages: [{ role: 'user', content: 'hi' }]
};
const mod2 = scrubLocalModelRequestBody(
  cloud,
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
);
assert(mod2 === false, 'cloud body not modified');
assert(Array.isArray(cloud.tools) && cloud.tools.length === 1, 'cloud tools preserved');

console.log(`\nALL ${passed} TESTS PASSED`);
