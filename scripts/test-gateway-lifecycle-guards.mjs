import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const renderer = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');

assert.match(
  main,
  /gatewayProcess\.exitCode == null[\s\S]*gatewayProcess\.signalCode == null[\s\S]*return Promise\.resolve\(gatewayProcess\);/,
  'start must be idempotent while a gateway child is already running'
);
assert.match(
  main,
  /preserveClash: true,\s*preserveCrashBudget: true,\s*cancelInFlightStart: !gatewayProcess && !!gatewayStartInFlight/,
  'channel reload must preserve proxy state and cancel an in-flight start'
);
assert.match(
  main,
  /await stopGatewayProcess\(\{ preserveClash: true, preserveCrashBudget: true \}\);/,
  'internal gateway cleanup must not reset the bounded crash-restart budget'
);
assert.match(
  renderer,
  /if \(status === 'stopped'\) \{\s*if \(window\.pluginDownloadTimer\)/s,
  'renderer must stop the plugin progress interval when gateway stops'
);
assert.doesNotMatch(
  renderer,
  /let autoOn = localStorage\.getItem\('setting_auto_launch_gateway'\).*gatewayAction\('start', \{ source: 'autostart' \}\)/s,
  'renderer must not own a second automatic gateway start path'
);
assert.match(
  main,
  /staleIds = new Set\(\[[\s\S]*key-rotator-proxy[\s\S]*system-control/s,
  'startup must prune stale plugin ids that trigger plugin-not-found warnings'
);
assert.match(
  main,
  /hasOwnProperty\.call\(config\.plugins, 'bundledDiscovery'\)[\s\S]*delete config\.plugins\.bundledDiscovery/s,
  'startup must remove the discovery key retired by OpenClaw 2026.9'
);
assert.match(
  main,
  /const duckEnabled = Boolean\(duckEntry && duckEntry\.enabled === true\)[\s\S]*config\.tools\.web\.search\.enabled !== duckEnabled/s,
  'web search runtime must follow the DuckDuckGo plugin switch'
);
assert.match(
  renderer,
  /pluginKey === 'duckduckgo'[\s\S]*configData\.tools\.web\.search\.enabled = checked/s,
  'DuckDuckGo UI toggle must update the web-search runtime switch'
);
const bootHarden = fs.readFileSync(new URL('../gateway-boot-harden.js', import.meta.url), 'utf8');
const gatewayPatch = fs.readFileSync(new URL('../patch_gateway.js', import.meta.url), 'utf8');
assert.doesNotMatch(gatewayPatch, /selectedKey\.substring\(/, 'gateway logs must never expose API key prefixes');
assert.match(gatewayPatch, /fingerprint=\$\{safeKeyFingerprint\(selectedKey\)\}/, 'gateway key rotation logs must use one-way fingerprints');
assert.match(
  bootHarden,
  /STALE_PLUGIN_IDS = \[[\s\S]*key-rotator-proxy[\s\S]*system-control/s,
  'direct gateway startup must prune the same stale plugin ids'
);

const require = createRequire(import.meta.url);
const { isAllowedLoopbackHttpUrl } = require('../gateway-auth.js');
assert.equal(isAllowedLoopbackHttpUrl('http://127.0.0.1:18789/acp/?token=x#token=x', [18789]), true);
assert.equal(isAllowedLoopbackHttpUrl('http://localhost:3210/', new Set(['3210'])), true);
assert.equal(isAllowedLoopbackHttpUrl('http://127.0.0.1:18790/acp/', [18789]), false);
assert.equal(isAllowedLoopbackHttpUrl('https://127.0.0.1:18789/acp/', [18789]), false);
assert.equal(isAllowedLoopbackHttpUrl('http://example.com:18789/acp/', [18789]), false);
assert.doesNotMatch(main, /getGatewayPort\(\)/, 'webview allowlist must not call an undefined gateway port helper');
const { syncAgentModelCatalog } = require('../openclaw-model-sync.js');
const { ensureAgnesAuthProfileConfig, repairAuthPayloads } = require('../openclaw-auth-sync.js');
const authConfig = {
  env: { vars: { AGNES_AI_API_KEY: 'valid-restored-key-value-1234567890' } },
  models: { providers: { 'agnes-ai': { apiKey: 'valid-restored-key-value-1234567890' } } }
};
const preparedAuthConfig = ensureAgnesAuthProfileConfig(authConfig);
assert.equal(preparedAuthConfig.changed, true);
assert.deepEqual(authConfig.auth.profiles['agnes-ai:default'], { provider: 'agnes-ai', mode: 'api_key' });
assert.equal(authConfig.env, undefined, 'duplicate Agnes env credentials must be removed');
const repairedAuth = repairAuthPayloads(
  { version: 1, profiles: { 'agnes-ai:default': { type: 'api_key', provider: 'agnes-ai', key: 'YOUR_AGNES_API_KEY_HERE' } } },
  { version: 1, usageStats: { 'agnes-ai:default': { cooldownUntil: Date.now() + 30_000 }, 'inline-api-key:agnes-ai': { cooldownUntil: Date.now() + 30_000 } } },
  'valid-restored-key-value-1234567890'
);
assert.equal(repairedAuth.credentialChanged, true);
assert.equal(repairedAuth.store.profiles['agnes-ai:default'].key, 'valid-restored-key-value-1234567890');
assert.equal(repairedAuth.state.usageStats, undefined, 'stale Agnes cooldowns must be cleared with a replaced credential');
const modelSyncTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-model-sync-'));
try {
  const agentDir = path.join(modelSyncTemp, 'agents', 'main', 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const modelsPath = path.join(agentDir, 'models.json');
  fs.writeFileSync(modelsPath, JSON.stringify({
    providers: {
      'agnes-ai': { apiKey: 'YOUR_AGNES_API_KEY_HERE', models: [] },
      ollama: { apiKey: 'stale-should-be-removed', models: [] }
    }
  }));
  const result = syncAgentModelCatalog(modelSyncTemp, {
    models: {
      providers: {
        'agnes-ai': { apiKey: 'valid-restored-key-value-1234567890', models: [{ id: 'agnes-2.0-flash' }] },
        ollama: { apiKey: '   ', baseUrl: 'http://localhost:11434/v1', models: [] }
      }
    }
  });
  const synced = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  assert.equal(result.changed, true);
  assert.equal(synced.providers['agnes-ai'].apiKey, 'valid-restored-key-value-1234567890');
  assert.equal(synced.providers['agnes-ai'].models[0].id, 'agnes-2.0-flash');
  assert.equal(Object.prototype.hasOwnProperty.call(synced.providers.ollama, 'apiKey'), false, 'blank local-provider API keys must be omitted');
} finally {
  fs.rmSync(modelSyncTemp, { recursive: true, force: true });
}
const { forceDisableUninstalledChannelPlugins } = require('../gateway-boot-harden.js');
const { sanitizeQqbotConfig } = require('../channel-config-sanitize.js');
const qqConfig = { channels: { qqbot: { dmPolicy: 'open', allowFrom: ['openclaw:approval-disabled'], accounts: {} } } };
assert.equal(sanitizeQqbotConfig(qqConfig), false);
assert.deepEqual(qqConfig.channels.qqbot.allowFrom, ['openclaw:approval-disabled']);
const legacyQqConfig = {
  channels: {
    qqbot: {
      defaultAccount: 'default',
      dmPolicy: 'open',
      allowFrom: ['*'],
      accounts: { default: { appId: '123', clientSecret: 'secret' } }
    }
  }
};
assert.equal(sanitizeQqbotConfig(legacyQqConfig), true);
assert.equal(legacyQqConfig.channels.qqbot.defaultAccount, undefined);
assert.equal(legacyQqConfig.channels.qqbot.appId, '123');
assert.equal(legacyQqConfig.channels.qqbot.clientSecret, 'secret');
assert.deepEqual(legacyQqConfig.channels.qqbot.allowFrom, ['openclaw:approval-disabled']);
const { probePlugin, applyPluginCredentials } = require('../plugin-catalog.js');
const webhookConfig = { plugins: { entries: {}, allow: [] } };
assert.equal(probePlugin('webhooks', { config: webhookConfig }).needsConfig, true);
assert.deepEqual(applyPluginCredentials(webhookConfig, 'webhooks', {
  routeId: 'orders', path: 'hooks/orders', sessionKey: 'agent:main:orders', secret: 'test-secret'
}), { ok: true });
assert.equal(webhookConfig.plugins.entries.webhooks.config.routes.orders.path, '/hooks/orders');
assert.equal(probePlugin('webhooks', { config: webhookConfig }).needsConfig, false);
const pluginConfig = {
  browser: { enabled: true },
  tools: { web: { search: { provider: 'duckduckgo' }, fetch: { enabled: true } } },
  models: { providers: { ollama: { models: [] } } },
  plugins: {
    allow: ['session-overflow-rollover', 'key-rotator-proxy', 'qqbot'],
    entries: {
      'session-overflow-rollover': { enabled: true },
      'key-rotator-proxy': { enabled: true },
      'system-control': { enabled: true },
      qqbot: { enabled: true },
    },
    installs: {
      'key-rotator-proxy': { installPath: 'missing' },
      'system-control': { installPath: 'missing' },
    },
  },
};
forceDisableUninstalledChannelPlugins(pluginConfig, { runtimeRoot: '' });
assert.equal(Object.prototype.hasOwnProperty.call(pluginConfig.plugins, 'bundledDiscovery'), false);
assert.equal(Object.prototype.hasOwnProperty.call(pluginConfig.plugins, 'installs'), false);
assert.equal(pluginConfig.plugins.entries['key-rotator-proxy'], undefined);
assert.equal(pluginConfig.plugins.entries['system-control'], undefined);
assert.equal(pluginConfig.plugins.entries.qqbot, undefined);
assert.equal(pluginConfig.plugins.allow.includes('qqbot'), false);
assert.ok(pluginConfig.plugins.allow.includes('browser'));
assert.ok(pluginConfig.plugins.allow.includes('duckduckgo'));
assert.ok(pluginConfig.plugins.allow.includes('ollama'));

console.log('gateway lifecycle guard tests passed');
