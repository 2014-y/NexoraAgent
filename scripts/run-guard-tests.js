'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tests = [
  'test-bootstrap-patch-io.mjs',
  'test-acceleration-lazy-install.mjs',
  'test-client-settings-store.mjs',
  'test-chat-config-guards.mjs',
  'test-chat-protocols.mjs',
  'test-chat-reliability-guards.mjs',
  'test-chat-timeout-guards.mjs',
  'test-data-center-schema.mjs',
  'test-delivery-gate-dedupe.mjs',
  'test-error-filter-banner-fp.mjs',
  'test-gateway-lifecycle-guards.mjs',
  'test-openclaw-stable-update.mjs',
  'test-plugin-runtime-registrations.mjs',
  'test-plugin-install-registry.mjs',
  'test-media-dedupe.mjs',
  'test-menu-visibility-guards.mjs',
  'test-model-config-policy.mjs',
  'test-usage-stats-guards.mjs',
  'test-voice-edge-tts-guards.mjs',
  'test-outbound-dedupe.mjs',
  'test-overflow-continuity.mjs',
  'test-overflow-delivery-route.mjs',
  'test-overflow-recovery-text.mjs',
  'test-overflow-rollover-detect.js',
  'test-tool-turn-repair.js'
];

for (const file of tests) {
  console.log(`\n[test] ${file}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`\n[test] ${tests.length}/${tests.length} guard suites passed`);
