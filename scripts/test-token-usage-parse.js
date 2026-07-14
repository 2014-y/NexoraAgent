'use strict';
const { parseUsageFromLlmBody } = require('../token-usage-parse');

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed += 1;
  console.log('OK:', msg);
}

assert(parseUsageFromLlmBody('') === null, 'empty -> null');
assert(parseUsageFromLlmBody('{"ok":true}') === null, 'no usage -> null');

const openai = parseUsageFromLlmBody('{"model":"gpt","usage":{"prompt_tokens":12,"completion_tokens":34}}');
assert(openai && openai.prompt_tokens === 12 && openai.completion_tokens === 34, 'openai usage');

const ollama = parseUsageFromLlmBody(
  '{"model":"local-test","message":{"role":"assistant","content":"hi"},"done":false}\n' +
  '{"model":"local-test","message":{"role":"assistant","content":"hi"},"done":true,"prompt_eval_count":100,"eval_count":20}'
);
assert(ollama && ollama.prompt_tokens === 100 && ollama.completion_tokens === 20, 'ollama native counts');

const sse = parseUsageFromLlmBody(
  'data: {"choices":[{"delta":{"content":"a"}}]}\n' +
  'data: {"usage":{"prompt_tokens":5,"completion_tokens":7}}\n' +
  'data: [DONE]\n'
);
assert(sse && sse.prompt_tokens === 5 && sse.completion_tokens === 7, 'openai sse usage');

console.log(`\n${passed} passed`);
