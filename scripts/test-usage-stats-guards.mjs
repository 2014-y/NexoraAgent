import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert.doesNotMatch(renderer, /const input = 3000;[\s\S]*const output = 500;/,
  'usage statistics must not synthesize fixed token counts from console output');
assert.doesNotMatch(renderer, /addSessionLog\(['"](?:dialog-test|image-gen|video-gen)['"]/, 
  'usage logs must use the actual provider or omit unknown media token usage');
assert.match(renderer, /const usage = result && \(result\.usage \|\| result\.usageMetadata\);/);
assert.match(renderer, /addSessionLog\(providerKey, modelId, inputTokens, outputTokens/);
assert.match(renderer, /const total_tokens = logs\.reduce\(\(sum, log\) => sum \+ tokenValue\(log\.input\) \+ tokenValue\(log\.output\), 0\);/);
assert.match(renderer, /logs = logs\.filter\(log => logTimestamp\(log\) >= startOfToday\);/);
assert.match(renderer, /Math\.min\(100, Math\.max\(0, \(v \/ 20000\.0\) \* 100\)\)/);
assert.match(main, /const total_tokens = input_t \+ output_t;/);
assert.match(main, /const model_key = `\$\{p_name\}\/\$\{m_name\}`;/);
assert.match(renderer, /const modelKey = `\$\{provider\}\/\$\{model\}`;/);
assert.doesNotMatch(main, /stats\.logs = stats\.logs\.slice\(0, 1000\);/,
  'filtered statistics need the complete detail set, not a truncated table');
assert.match(main, /source: log\.source \|\| \(legacyClientMarker \? 'client' : 'gateway'\)/);
assert.match(html, /<option value="client"[^>]*>客户端直连<\/option>/);

console.log('usage statistics guard tests passed');
