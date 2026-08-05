import assert from 'assert';
import fs from 'node:fs';
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
  /bundledDiscovery !== 'allowlist'[\s\S]*bundledDiscovery = 'allowlist'/s,
  'startup must prefer explicit plugin allowlisting to avoid duplicate auto-discovery'
);
const bootHarden = fs.readFileSync(new URL('../gateway-boot-harden.js', import.meta.url), 'utf8');
assert.match(
  bootHarden,
  /STALE_PLUGIN_IDS = \[[\s\S]*key-rotator-proxy[\s\S]*system-control/s,
  'direct gateway startup must prune the same stale plugin ids'
);

const require = createRequire(import.meta.url);
const { forceDisableUninstalledChannelPlugins } = require('../gateway-boot-harden.js');
const pluginConfig = {
  browser: { enabled: true },
  tools: { web: { search: { provider: 'duckduckgo' }, fetch: { enabled: true } } },
  models: { providers: { ollama: { models: [] } } },
  plugins: {
    allow: ['session-overflow-rollover', 'key-rotator-proxy'],
    entries: {
      'session-overflow-rollover': { enabled: true },
      'key-rotator-proxy': { enabled: true },
      'system-control': { enabled: true },
    },
    installs: {
      'key-rotator-proxy': { installPath: 'missing' },
      'system-control': { installPath: 'missing' },
    },
  },
};
forceDisableUninstalledChannelPlugins(pluginConfig, { runtimeRoot: '' });
assert.equal(pluginConfig.plugins.bundledDiscovery, 'allowlist');
assert.equal(pluginConfig.plugins.entries['key-rotator-proxy'], undefined);
assert.equal(pluginConfig.plugins.entries['system-control'], undefined);
assert.ok(pluginConfig.plugins.allow.includes('browser'));
assert.ok(pluginConfig.plugins.allow.includes('duckduckgo'));
assert.ok(pluginConfig.plugins.allow.includes('ollama'));

console.log('gateway lifecycle guard tests passed');
