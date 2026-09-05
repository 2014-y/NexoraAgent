'use strict';
// Package the build machine's official Node distribution, including npm, so a
// Finder launch does not depend on Homebrew, nvm or the user's shell PATH.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');

function main() {
  if (process.platform !== 'darwin') throw new Error('Build the macOS package on macOS.');
  const targetArch = process.env.NEXORA_TARGET_ARCH || process.arch;
  if (!['arm64', 'x64'].includes(targetArch) || targetArch !== process.arch) {
    throw new Error('Build each Mac architecture on a matching Node/runner (arm64 or x64); native dependencies cannot be shared.');
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) throw new Error('Node >= 24.15.0 is required.');
  const node = fs.realpathSync(process.execPath);
  const libraries = execFileSync('/usr/bin/otool', ['-L', node], {encoding: 'utf8'});
  const external = libraries.split('\n').slice(1).map(l => l.trim().split(' (')[0])
    .filter(l => l && !l.startsWith('/usr/lib/') && !l.startsWith('/System/Library/'));
  if (external.length) throw new Error(`Node links to non-system libraries: ${external.join(', ')}. Use an official Node distribution (nvm or actions/setup-node), not Homebrew Node.`);
  const nodeDir = path.dirname(node);
  const npmCandidates = [
    path.join(nodeDir, '../lib/node_modules/npm'),
    path.join(nodeDir, 'node_modules/npm')
  ];
  if (process.env.npm_execpath) npmCandidates.push(path.resolve(process.env.npm_execpath, '../..'));
  const npm = npmCandidates.find(p => fs.existsSync(path.join(p, 'bin/npm-cli.js')) && fs.existsSync(path.join(p, 'bin/npm-prefix.js')));
  if (!npm) throw new Error('Cannot locate npm next to Node. Install Node with its bundled npm.');
  const sandbox = path.join(root, '.node-sandbox');
  fs.mkdirSync(sandbox, {recursive: true});
  fs.copyFileSync(node, path.join(sandbox, 'node'));
  fs.chmodSync(path.join(sandbox, 'node'), 0o755);
  const npmDest = path.join(sandbox, 'node_modules/npm');
  fs.rmSync(npmDest, {recursive: true, force: true});
  fs.cpSync(npm, npmDest, {recursive: true, dereference: true});
  for (const [name, entry] of [['npm', 'npm-cli.js'], ['npx', 'npx-cli.js']]) {
    fs.writeFileSync(path.join(sandbox, name), `#!/bin/sh\nNEXORA_NODE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$NEXORA_NODE_DIR/node" "$NEXORA_NODE_DIR/node_modules/npm/bin/${entry}" "$@"\n`, {mode: 0o755});
    fs.chmodSync(path.join(sandbox, name), 0o755);
  }
  fs.writeFileSync(path.join(sandbox, 'runtime-platform.json'), JSON.stringify({platform: process.platform, arch: process.arch, node: process.versions.node}, null, 2));
  const env = {...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin'};
  const info = execFileSync(path.join(sandbox, 'node'), ['-e', "require('node:sqlite'); console.log(process.platform + '/' + process.arch + ' ' + process.version)"], {encoding:'utf8', env}).trim();
  const npmVersion = execFileSync(path.join(sandbox, 'npm'), ['--version'], {encoding:'utf8', env}).trim();
  console.log(`[provision-mac-node] ${info}, npm ${npmVersion}; standalone runtime ready`);
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
