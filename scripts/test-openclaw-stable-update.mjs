import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = require(path.join(root, 'openclaw-update-policy.js'));

assert.equal(policy.isStableVersion('2026.9.1'), true);
assert.equal(policy.isStableVersion('v2026.9.1'), true);
assert.equal(policy.isStableVersion('2026.9.2-beta.1'), false);
assert.equal(policy.compareStableVersions('2026.10.0', '2026.9.99'), 1);

const plan = policy.resolveStableTarget(
  { latest: '2026.9.2', beta: '2026.10.0-beta.1' },
  '2026.9.1',
  '2026.8.0'
);
assert.equal(plan.latestVersion, '2026.9.2');
assert.equal(plan.hasUpdate, true);
assert.equal(plan.requestedMatched, false, 'webview target cannot override official latest');

const ahead = policy.resolveStableTarget({ latest: '2026.9.1' }, '2026.9.2', '');
assert.equal(ahead.hasUpdate, false, 'stable updater must never downgrade');
assert.equal(ahead.aheadOfLatest, true);

assert.throws(
  () => policy.resolveStableTarget({ latest: '2026.10.0-beta.1' }, '2026.9.1', ''),
  /不是正式稳定版/
);
assert.throws(
  () => policy.resolveStableTarget({ latest: '2026.9.2' }, '2026.9.1', 'latest;calc.exe'),
  /拒绝安装/
);
assert.throws(() => policy.normalizeIntegrity(''), /完整性摘要/);
assert.equal(policy.normalizeIntegrity('sha512-YWJjZA=='), 'sha512-YWJjZA==');

const manifest = policy.buildGatewayRuntimeManifest({
  version: '2.0.3',
  dependencies: { openclaw: '2026.9.1', '@openclaw/feishu': '2026.9.1' },
  optionalDependencies: { 'optional-runtime': '^1.0.0' }
}, {
  openclaw: '2026.9.2',
  '@openclaw/feishu': '2026.9.1'
});
assert.equal(manifest.private, true);
assert.equal(manifest.dependencies.openclaw, '2026.9.2');
assert.equal(manifest.dependencies['@openclaw/feishu'], '2026.9.1');
assert.equal(manifest.dependencies['optional-runtime'], '^1.0.0');

const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert.ok(main.includes("ipcMain.handle('check-openclaw-stable-update'"));
assert.ok(main.includes("ipcMain.handle('update-openclaw-package'"));
assert.ok(main.includes('OFFICIAL_NPM_REGISTRY'));
assert.ok(main.includes('waitForGatewayControlUiReady'));
assert.ok(main.includes('restoreOpenclawStateSnapshot'));
assert.ok(main.includes('openclawStableUpdateInFlight'));
assert.ok(main.includes('fs.renameSync(liveModules, rollbackModules)'));
assert.ok(preload.includes("ipcRenderer.invoke('check-openclaw-stable-update')"));
assert.ok(renderer.includes('maintainOpenclawStableVersion(false)'));
assert.ok(html.includes('id="btn-openclaw-stable-update"'));
assert.ok(html.includes('不安装 Beta/预览版'));

console.log('openclaw stable update guards: OK');
