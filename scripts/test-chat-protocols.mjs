import fs from 'fs';
import vm from 'vm';
import assert from 'assert';

const source = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');
const start = source.indexOf('const MODEL_API_PROTOCOLS');
const end = source.indexOf('function isBuiltinAllowedProvider');
assert.ok(start >= 0 && end > start, 'chat protocol helpers must be present');

const context = { encodeURIComponent, JSON, String, Array, Object, RegExp, Math };
vm.runInNewContext(`${source.slice(start, end)}\nthis.api = { buildChatRequest, extractChatReply };`, context);
const { buildChatRequest, extractChatReply } = context.api;
const image = 'data:image/png;base64,AAAA';
const messages = [
  { role: 'system', content: 'be concise' },
  { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: image } }] }
];

const openai = buildChatRequest('https://api.example/v1', 'openai-chat', 'vision', messages, { apiKey: 'k1' });
assert.equal(openai.url, 'https://api.example/v1/chat/completions');
assert.equal(openai.headers.Authorization, 'Bearer k1');
assert.deepEqual(openai.body.messages[1].content, messages[1].content);

const azure = buildChatRequest('https://azure.example/openai?api-version=2024-06-01', 'azure-openai', 'vision', messages, { apiKey: 'k2' });
assert.equal(azure.url, 'https://azure.example/openai/chat/completions?api-version=2024-06-01');
assert.equal(azure.headers['api-key'], 'k2');
assert.equal(azure.headers.Authorization, undefined);

const anthropic = buildChatRequest('https://anthropic.example/v1', 'anthropic-messages', 'claude', messages, { apiKey: 'k3' });
assert.equal(anthropic.headers['x-api-key'], 'k3');
assert.equal(anthropic.body.messages[0].content[1].source.type, 'base64');
assert.equal(anthropic.body.messages[0].content[1].source.media_type, 'image/png');

const gemini = buildChatRequest('https://generativelanguage.example/v1beta', 'gemini-generate-content', 'gemini-pro-vision', messages, { apiKey: 'k4' });
assert.equal(gemini.headers['x-goog-api-key'], 'k4');
assert.deepEqual(gemini.body.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'AAAA' } });

const responses = buildChatRequest('https://api.example/v1', 'openai-responses', 'vision', messages, { apiKey: 'k5' });
assert.deepEqual(responses.body.input[1].content[1], { type: 'input_image', image_url: image });

const ollama = buildChatRequest('http://127.0.0.1:11434/v1', 'ollama', 'llava', messages, { apiKey: '' });
assert.equal(ollama.url, 'http://127.0.0.1:11434/api/chat');
assert.deepEqual(ollama.body.messages[1].images, ['AAAA']);

assert.equal(extractChatReply({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'ab');
assert.equal(extractChatReply({ candidates: [{ content: { parts: [{ text: 'vision ok' }] } }] }), 'vision ok');

console.log('chat protocol tests passed');
