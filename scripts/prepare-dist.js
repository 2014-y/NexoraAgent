'use strict';
/**
 * Cross-platform pre-dist orchestrator.
 * - Windows: full chain (release assets, gateway runtime, acceleration core, NSIS patch).
 * - macOS / Linux: platform-neutral steps only (acceleration core is a Windows-only
 *   feature — mihomo/wintun binaries — and patch_nsis only applies to the NSIS installer).
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const isWin = process.platform === 'win32';

const steps = [];
if (process.platform === 'darwin') {
  steps.push('scripts/provision-mac-node.js');
  steps.push('scripts/rebuild-mac-native.js');
}
steps.push('scripts/patch-bundled-security-deps.js');
if (isWin) {
  steps.push('scripts/ensure-asr-release-asset.js');
  steps.push('scripts/ensure-builtin-asr.js');
  steps.push('scripts/ensure-voice-release-asset.js');
}
steps.push('scripts/pack-gateway-runtime.js');
if (isWin) {
  steps.push('scripts/prepare-acceleration-core.js');
  steps.push('patch_nsis.js');
}
steps.push('scripts/ensure-data-center-deps.js');

for (const script of steps) {
  console.log(`\n[prepare-dist] node ${script}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`[prepare-dist] FAILED: ${script}`);
    process.exit(r.status || 1);
  }
}
console.log('\n[prepare-dist] done');
