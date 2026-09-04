import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = require(path.join(root, 'model-config-policy.js'));
const { ensureLatencySafeConfig } = require(path.join(root, 'latency-tune.js'));

const providers = {
  'agnes-ai': {
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    models: [
      { id: 'agnes-2.0-flash' },
      { id: 'agnes-1.5-flash' },
      { id: 'agnes-image-2.0-flash' }
    ]
  },
  ollama: { baseUrl: 'http://localhost:11434/v1', models: [{ id: 'qwen2.5:7b' }] },
  custom: { baseUrl: 'https://example.com/v1', models: [{ id: 'same-name' }] }
};

assert.equal(policy.validateProviders(providers).ok, true);
assert.equal(policy.validateProviders({ bad: { baseUrl: 'javascript:alert(1)', models: [{ id: '' }] } }).ok, false);
assert.equal(policy.validateProviders({ bad: { baseUrl: 'https://example.com', models: [{ id: 'dup' }, { id: 'dup' }] } }).ok, false);

assert.deepEqual(policy.parseModelRef('custom/team/model'), {
  provider: 'custom', model: 'team/model', id: 'team/model', ref: 'custom/team/model'
});

const valid = policy.validateRoutingForm({
  providers,
  allowedProviders: ['agnes-ai', 'ollama'],
  primaryProvider: 'agnes-ai',
  primaryModel: 'agnes-2.0-flash',
  fallbackEnabled: true,
  fallbackProvider: 'agnes-ai',
  fallbackModel: 'agnes-1.5-flash'
});
assert.equal(valid.ok, true);
assert.equal(valid.primaryRef, 'agnes-ai/agnes-2.0-flash');
assert.deepEqual(valid.fallbackRefs, ['agnes-ai/agnes-1.5-flash']);

const disabledFallback = policy.validateRoutingForm({
  providers,
  primaryProvider: 'agnes-ai',
  primaryModel: 'agnes-2.0-flash',
  fallbackEnabled: false,
  fallbackProvider: 'agnes-ai',
  fallbackModel: 'stale-value-must-not-save'
});
assert.equal(disabledFallback.ok, true);
assert.deepEqual(disabledFallback.fallbackRefs, []);

assert.equal(policy.validateRoutingForm({
  providers,
  primaryProvider: 'agnes-ai',
  primaryModel: 'custom/same-name',
  fallbackEnabled: false
}).ok, false, 'embedded provider conflict must fail');

assert.equal(policy.validateRoutingForm({
  providers,
  primaryProvider: 'agnes-ai',
  primaryModel: 'agnes-image-2.0-flash',
  fallbackEnabled: false
}).ok, false, 'non-chat model must fail');

assert.equal(policy.validateRoutingForm({
  providers,
  primaryProvider: 'missing',
  primaryModel: 'model',
  fallbackEnabled: false
}).ok, false, 'missing provider must fail');

const config = {
  models: { providers: structuredClone(providers) },
  agents: { defaults: { model: {
    primary: 'agnes-ai/agnes-2.0-flash',
    fallbacks: ['', 'agnes-ai/agnes-1.5-flash', 'agnes-ai/agnes-1.5-flash', 'agnes-ai/agnes-2.0-flash']
  } } }
};
const normalized = policy.normalizeConfigRouting(config, { allowedProviders: ['agnes-ai', 'ollama'] });
assert.deepEqual(normalized.fallbacks, ['agnes-ai/agnes-1.5-flash']);

const blankKeyConfig = {
  models: { providers: {
    'agnes-ai': { ...structuredClone(providers['agnes-ai']), apiKey: 'kept-real-key' },
    ollama: { ...structuredClone(providers.ollama), apiKey: '   ' }
  } },
  agents: { defaults: { model: { primary: 'agnes-ai/agnes-2.0-flash', fallbacks: [] } } }
};
policy.normalizeConfigRouting(blankKeyConfig, { allowedProviders: ['agnes-ai', 'ollama'] });
assert.equal(blankKeyConfig.models.providers['agnes-ai'].apiKey, 'kept-real-key');
assert.equal(Object.prototype.hasOwnProperty.call(blankKeyConfig.models.providers.ollama, 'apiKey'), false);

assert.throws(() => policy.normalizeConfigRouting({
  models: { providers },
  agents: { defaults: { model: { primary: 'agnes-2.0-flash', fallbacks: [] } } }
}), /未选择提供商/);

const legacy = policy.normalizeConfigRouting({
  models: { providers: structuredClone(providers) },
  agents: { defaults: { model: { primary: 'agnes-2.0-flash', fallbacks: ['agnes-1.5-flash'] } } }
}, { inferLegacyRefs: true });
assert.equal(legacy.primary, 'agnes-ai/agnes-2.0-flash');
assert.deepEqual(legacy.fallbacks, ['agnes-ai/agnes-1.5-flash']);

const explicitTeaching = {
  plugins: { entries: { 'dual-model-trainer': {
    enabled: true,
    config: { mode: 'teach-learn', enableTeachLearn: true, timeoutMs: 15000 }
  } } }
};
ensureLatencySafeConfig(explicitTeaching);
assert.equal(explicitTeaching.plugins.entries['dual-model-trainer'].config.mode, 'teach-learn');
assert.equal(explicitTeaching.plugins.entries['dual-model-trainer'].config.enableTeachLearn, true);

const defaultTeaching = { plugins: { entries: { 'dual-model-trainer': { enabled: true, config: {} } } } };
ensureLatencySafeConfig(defaultTeaching);
assert.equal(defaultTeaching.plugins.entries['dual-model-trainer'].config.mode, 'collect-only');
assert.equal(defaultTeaching.plugins.entries['dual-model-trainer'].config.enableTeachLearn, false);

const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const plugin = fs.readFileSync(path.join(root, 'plugins', 'dual-model-trainer', 'index.js'), 'utf8');
assert.match(renderer, /buildConfigDraftFromForm/);
assert.match(renderer, /fallbackRefs/);
assert.doesNotMatch(renderer, /fallbacks\s*=\s*\[finalFallback\]/);
assert.match(main, /normalizeConfigRouting\(cleanConfig/);
assert.match(html, /id="model-fallback-enabled"/);
assert.match(html, /id="dmt-mode"/);
assert.match(plugin, /Promise\.resolve\(studentLearnInBackground\(/);
assert.doesNotMatch(plugin, /Promise\.resolve\(teachAndLearn\(question/);

console.log('model config policy guards passed');
