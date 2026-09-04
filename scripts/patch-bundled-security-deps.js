'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourceCandidates = [
  path.join(root, 'node_modules', 'qs'),
  path.join(root, 'node_modules', 'openclaw', 'node_modules', 'qs')
];
const targets = [
  path.join(root, 'node_modules', '@openclaw', 'feishu', 'node_modules', '@larksuiteoapi', 'node-sdk', 'node_modules', 'qs'),
  path.join(root, 'node_modules', '@openclaw', 'slack', 'node_modules', '@slack', 'bolt', 'node_modules', 'qs')
];
const targetLockKeys = [
  'node_modules/@openclaw/feishu/node_modules/@larksuiteoapi/node-sdk/node_modules/qs',
  'node_modules/@openclaw/slack/node_modules/@slack/bolt/node_modules/qs'
];

function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '';
  } catch (_) {
    return '';
  }
}

const source = sourceCandidates.find((dir) => readVersion(dir) === '6.16.0');
const sourceVersion = readVersion(source || '');
if (sourceVersion !== '6.16.0') {
  throw new Error(`Expected patched qs@6.16.0, found ${sourceVersion || 'missing'}`);
}

let patched = 0;
for (const target of targets) {
  if (!fs.existsSync(path.dirname(target))) continue;
  if (readVersion(target) === sourceVersion) continue;
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  patched += 1;
}

// Both upstream plugins currently ship qs@6.15.3 inside bundled dependency
// archives. npm audit reads package-lock.json rather than the postinstall
// filesystem, so keep the lock evidence aligned with the final patched tree.
const lockPath = path.join(root, 'package-lock.json');
let lockPatched = 0;
try {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const sourceLock = lock.packages?.['node_modules/qs']
    || lock.packages?.['node_modules/openclaw/node_modules/qs'];
  if (sourceLock?.version !== sourceVersion) {
    throw new Error(`Expected package-lock source qs@${sourceVersion}`);
  }
  for (const key of targetLockKeys) {
    if (!lock.packages?.[key] || lock.packages[key].version === sourceVersion) continue;
    lock.packages[key] = { ...sourceLock };
    lockPatched += 1;
  }
  if (lockPatched) {
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }
} catch (error) {
  throw new Error(`Unable to align package-lock bundled qs entries: ${error.message}`);
}

console.log(`[SecurityDeps] bundled qs ${sourceVersion}; patched=${patched}; lockPatched=${lockPatched}`);
