'use strict';
const {
  ZERO_CONFIG_PLUGINS,
  ZERO_CONFIG_DEFAULT_ON,
  CREDENTIAL_PLUGINS,
  LOCAL_SOFTWARE_PLUGINS,
  UI_PLUGIN_IDS,
  ensureUiPluginCatalog,
  ensureAllow,
  probePlugin,
  applyPluginCredentials
} = require('../plugin-catalog');

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed += 1;
  console.log('OK:', msg);
}

assert(ZERO_CONFIG_PLUGINS.includes('duckduckgo'), 'duckduckgo is zero-config');
assert(ZERO_CONFIG_PLUGINS.includes('auto-summary'), 'auto-summary is zero-config');
assert(ZERO_CONFIG_DEFAULT_ON.includes('dual-model-trainer'), 'dual-model default on');
assert(CREDENTIAL_PLUGINS.includes('slack') && CREDENTIAL_PLUGINS.includes('matrix'), 'slack/matrix credentials');
assert(LOCAL_SOFTWARE_PLUGINS.includes('auto-start-codex'), 'codex is software tier');
assert(UI_PLUGIN_IDS.includes('auto-summary') && !UI_PLUGIN_IDS.includes('llm-task'), 'UI shows auto-summary not llm-task');

const empty = { plugins: { entries: {}, allow: [] } };
const first = ensureUiPluginCatalog(empty, { forceDefaultOn: true });
assert(first.changed === true, 'first-run catalog changes');
assert(empty.plugins.allow.includes('duckduckgo'), 'duckduckgo in allow');
assert(empty.plugins.allow.includes('webhooks'), 'webhooks in allow');
assert(empty.plugins.allow.includes('workboard'), 'workboard in allow');
assert(empty.plugins.allow.includes('bonjour'), 'bonjour in allow');
assert(empty.plugins.allow.includes('llm-task'), 'llm-task in allow');
assert(empty.plugins.allow.includes('slack'), 'slack in allow');
assert(empty.plugins.allow.includes('matrix'), 'matrix in allow');
assert(empty.plugins.entries.duckduckgo.enabled === true, 'duckduckgo default enabled');
assert(empty.plugins.entries['dual-model-trainer'].enabled === true, 'dual-model default enabled');
assert(empty.plugins.entries.slack.enabled !== true, 'slack stays off by default');
assert(empty.hooks.internal.entries['auto-start-codex'], 'codex hook entry created');

const again = ensureUiPluginCatalog(empty, { forceDefaultOn: false });
assert(again.changed === false, 'idempotent catalog merge');

const cfg2 = { plugins: { entries: {}, allow: [] }, channels: {} };
ensureAllow(cfg2, 'webhooks');
assert(cfg2.plugins.allow.includes('webhooks'), 'ensureAllow works');

const slackProbe = probePlugin('slack', { config: cfg2, appRoot: __dirname + '/..' });
assert(slackProbe.needsConfig === true, 'slack needs config without token');
assert(slackProbe.badge === 'needs-config' || slackProbe.badge === 'missing-runtime', 'slack badge warns');

applyPluginCredentials(cfg2, 'slack', { botToken: 'xoxb-test-token-1234567890' });
const slackAfter = probePlugin('slack', { config: cfg2, appRoot: __dirname + '/..' });
assert(slackAfter.needsConfig === false, 'slack ok after token');
assert(cfg2.plugins.entries.slack.enabled === true, 'slack enabled after credentials');

applyPluginCredentials(cfg2, 'matrix', {
  homeserver: 'https://matrix.org',
  accessToken: 'syt_test_token_abcdef'
});
const matrixAfter = probePlugin('matrix', { config: cfg2, appRoot: __dirname + '/..' });
assert(matrixAfter.needsConfig === false, 'matrix ok after credentials');

const codex = probePlugin('auto-start-codex', { config: cfg2 });
assert(codex.tier === 'software', 'codex software tier');
assert(typeof codex.available === 'boolean', 'codex available boolean');
if (!codex.available) {
  assert(codex.badge === 'needs-software', 'codex missing -> needs-software badge');
}

console.log(`\n${passed} passed`);
