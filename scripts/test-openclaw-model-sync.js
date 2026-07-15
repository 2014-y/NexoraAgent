'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const {
  parseProviderModel,
  shouldUpdateSessionKey,
  applyDefaultModelToSessions,
  syncModelConfigToStateDirs
} = require('../openclaw-model-sync');

assert.deepStrictEqual(parseProviderModel('agnes-ai/agnes-2.0-flash'), {
  provider: 'agnes-ai',
  model: 'agnes-2.0-flash',
  primary: 'agnes-ai/agnes-2.0-flash'
});
assert.strictEqual(shouldUpdateSessionKey('agent:main:main'), true);
assert.strictEqual(shouldUpdateSessionKey('agent:main:dashboard:abc'), true);
assert.strictEqual(shouldUpdateSessionKey('agent:main:openclaw-weixin:x'), false);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clawai-model-sync-'));
const stateA = path.join(tmp, 'a', '.openclaw');
const stateB = path.join(tmp, 'b', '.openclaw');
fs.mkdirSync(path.join(stateA, 'agents', 'main', 'sessions'), { recursive: true });
fs.mkdirSync(path.join(stateB, 'agents', 'main', 'sessions'), { recursive: true });

fs.writeFileSync(path.join(stateA, 'openclaw.json'), JSON.stringify({
  agents: { defaults: { model: { primary: 'ollama/old', fallbacks: ['ollama/old2'] } } },
  models: { providers: { ollama: { baseUrl: 'http://x' } } },
  gateway: { auth: { mode: 'token', token: 'keep-a' }, port: 18789 }
}, null, 2));

fs.writeFileSync(path.join(stateB, 'openclaw.json'), JSON.stringify({
  agents: { defaults: { model: { primary: 'ollama/old', fallbacks: ['ollama/old2'] } } },
  models: { providers: { ollama: { baseUrl: 'http://x' } } },
  gateway: { auth: { mode: 'token', token: 'keep-b' }, port: 18789 }
}, null, 2));

const sessions = {
  'agent:main:main': {
    model: 'agnes-2.0-flash',
    modelProvider: 'agnes-ai',
    modelOverride: 'gemma4:latest',
    providerOverride: 'ollama'
  },
  'agent:main:dashboard:1': {
    model: 'agnes-2.0-flash',
    modelProvider: 'agnes-ai'
  },
  'agent:main:openclaw-weixin:bot': {
    model: 'agnes-2.0-flash',
    modelProvider: 'agnes-ai'
  }
};
fs.writeFileSync(path.join(stateA, 'agents', 'main', 'sessions', 'sessions.json'), JSON.stringify(sessions, null, 2));
fs.writeFileSync(path.join(stateB, 'agents', 'main', 'sessions', 'sessions.json'), JSON.stringify(sessions, null, 2));

const source = {
  agents: { defaults: { model: { primary: 'ollama/gemma4:latest', fallbacks: ['ollama/qwen2.5:7b'] } } },
  models: { providers: { ollama: { baseUrl: 'http://localhost:11434/v1', models: [{ id: 'gemma4:latest' }] } } },
  env: { OLLAMA_API_KEY: 'x' }
};

// write primary first (simulate config-save)
fs.writeFileSync(path.join(stateA, 'openclaw.json'), JSON.stringify({
  ...source,
  gateway: { auth: { mode: 'token', token: 'keep-a' }, port: 18789 }
}, null, 2));

const synced = syncModelConfigToStateDirs([stateA, stateB], source, stateA);
assert.ok(synced.includes(path.resolve(stateB)), 'should sync secondary config dir');

const cfgB = JSON.parse(fs.readFileSync(path.join(stateB, 'openclaw.json'), 'utf8'));
assert.strictEqual(cfgB.agents.defaults.model.primary, 'ollama/gemma4:latest');
assert.strictEqual(cfgB.gateway.auth.token, 'keep-b', 'must preserve secondary auth token');

const sessA = JSON.parse(fs.readFileSync(path.join(stateA, 'agents', 'main', 'sessions', 'sessions.json'), 'utf8'));
assert.strictEqual(sessA['agent:main:main'].model, 'gemma4:latest');
assert.strictEqual(sessA['agent:main:main'].modelProvider, 'ollama');
assert.strictEqual(sessA['agent:main:main'].modelOverride, undefined);
assert.strictEqual(sessA['agent:main:dashboard:1'].model, 'gemma4:latest');
assert.strictEqual(sessA['agent:main:openclaw-weixin:bot'].model, 'agnes-2.0-flash', 'channel sessions untouched');

const r = applyDefaultModelToSessions(stateA, 'agnes-ai/agnes-1.5-flash');
assert.ok(r.changed);
const sessA2 = JSON.parse(fs.readFileSync(path.join(stateA, 'agents', 'main', 'sessions', 'sessions.json'), 'utf8'));
assert.strictEqual(sessA2['agent:main:main'].model, 'agnes-1.5-flash');
assert.strictEqual(sessA2['agent:main:main'].modelProvider, 'agnes-ai');

console.log('ok openclaw-model-sync');
