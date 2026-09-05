'use strict';
// Exercise the delivered bundle with a Finder-like PATH, without system Node.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {ROOT, getBuildOutputDir} = require('./build-output-dir');
const {requiredRuntimeMarkers} = require('../runtime-pack-manifest');

function main() {
  assert.equal(process.platform, 'darwin', 'Verify Mac bundles on macOS');
  const output = path.resolve(ROOT, getBuildOutputDir());
  const folder = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  const app = process.argv[2] ? path.resolve(process.argv[2]) : path.join(output, folder, 'Nexora Agent.app');
  const resources = path.join(app, 'Contents/Resources');
  const binary = path.join(app, 'Contents/MacOS/Nexora Agent');
  const archive = path.join(resources, 'gateway-runtime.tar');
  assert.ok(fs.existsSync(binary), `Missing app binary: ${binary}`);
  const minimum = execFileSync('/usr/bin/plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', path.join(app, 'Contents/Info.plist')], {encoding:'utf8'}).trim();
  assert.equal(minimum, '13.5', 'Bundle minimum OS must cover the bundled Node runtime');
  const listing = new Set(execFileSync('/usr/bin/tar', ['-tf', archive], {encoding:'utf8', maxBuffer:64*1024*1024}).split('\n'));
  for (const marker of requiredRuntimeMarkers('darwin')) assert.ok(listing.has(marker.join('/')), `Missing runtime file: ${marker.join('/')}`);
  const scratch = path.join(ROOT, 'build-resources');
  fs.mkdirSync(scratch, {recursive:true});
  const runtime = fs.mkdtempSync(path.join(scratch, '_verify-mac-'));
  const env = {...process.env, PATH:'/usr/bin:/bin:/usr/sbin:/sbin'};
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    execFileSync('/usr/bin/tar', ['-xf', archive, '-C', runtime], {maxBuffer:1024*1024});
    const node = path.join(runtime, '.node-sandbox/node');
    const metadata = JSON.parse(fs.readFileSync(path.join(runtime, '.node-sandbox/runtime-platform.json')));
    assert.equal(metadata.arch, process.arch);
    assert.equal(metadata.platform, 'darwin');
    const info = JSON.parse(execFileSync(node, ['-e', "require('node:sqlite'); console.log(JSON.stringify({arch:process.arch,version:process.version}))"], {encoding:'utf8', env}));
    assert.equal(info.arch, process.arch);
    execFileSync(path.join(runtime, '.node-sandbox/npm'), ['--version'], {env, stdio:'pipe'});
    const version = execFileSync(node, [path.join(runtime, 'node_modules/openclaw/openclaw.mjs'), '--version'], {env, encoding:'utf8', timeout:30000}).trim();
    console.log(`[verify:mac] standalone Node ${info.version}/${info.arch}; npm; ${version}`);
    const ptyPath = path.join(resources, 'app.asar/node_modules/node-pty');
    const sherpaPath = path.join(resources, 'app.asar/node_modules/sherpa-onnx-node');
    const code = `
      require('node:sqlite');
      require(${JSON.stringify(sherpaPath)});
      const pty = require(${JSON.stringify(ptyPath)});
      const child = pty.spawn('/bin/sh', ['-c', 'printf nexora-pty-ok'], {env: {PATH:'/usr/bin:/bin'}, cwd:'/'});
      let output = '';
      const timer = setTimeout(() => { console.error('PTY timeout'); process.exit(1); }, 10000);
      child.onData(data => { output += data; });
      child.onExit(({exitCode}) => { clearTimeout(timer); if (exitCode || !output.includes('nexora-pty-ok')) process.exit(1); console.log('Electron native modules and PTY passed'); });
    `;
    execFileSync(binary, ['-e', code], {env:{...env, ELECTRON_RUN_AS_NODE:'1'}, stdio:'inherit', timeout:15000});
    console.log(`[verify:mac] PASS: ${app}`);
  } finally {
    fs.rmSync(runtime, {recursive:true, force:true});
  }
}
try {main();} catch(error) {console.error(error.stack || error); process.exitCode = 1;}
