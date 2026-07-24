'use strict';
/**
 * Ensure data-center deps exist for packaging.
 * Avoids re-running npm install on every pack when node_modules is already present
 * (system Node 14 + lockfile v3 can hang for a long time).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const dcRoot = path.join(root, 'data-center');
const markers = [
  path.join(dcRoot, 'node_modules', 'express', 'package.json'),
  path.join(dcRoot, 'node_modules', 'cors', 'package.json'),
  path.join(dcRoot, 'node_modules', 'sql.js', 'package.json'),
];

function ok() {
  return markers.every((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  });
}

if (ok()) {
  console.log('[ensure-data-center-deps] ok (reuse existing node_modules)');
  process.exit(0);
}

console.log('[ensure-data-center-deps] missing deps, running npm install…');
const r = spawnSync('npm', ['--prefix', dcRoot, 'install', '--omit=dev'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: process.env,
});
if (r.status !== 0) {
  console.error('[ensure-data-center-deps] npm install failed');
  process.exit(r.status || 1);
}
if (!ok()) {
  console.error('[ensure-data-center-deps] deps still missing after install');
  process.exit(1);
}
console.log('[ensure-data-center-deps] installed');
