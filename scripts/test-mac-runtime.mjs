import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { requiredRuntimeMarkers } = require('../runtime-pack-manifest');
const { runtimeLooksReady, writeRuntimeStamp, explainRuntimeGaps } = require('../gateway-runtime');
const win = requiredRuntimeMarkers('win32').map(p => p.join('/'));
const mac = requiredRuntimeMarkers('darwin').map(p => p.join('/'));
assert.ok(win.includes('.node-sandbox/node.exe'));
assert.ok(win.includes('.node-sandbox/vcruntime140.dll'));
assert.ok(!mac.some(p => /\.(exe|dll)$/.test(p)));
assert.ok(mac.includes('.node-sandbox/node'));
assert.ok(mac.includes('.node-sandbox/node_modules/npm/bin/npm-cli.js'));
if (process.platform === 'darwin') {
  const work = path.resolve('build-resources');
  fs.mkdirSync(work, {recursive:true});
  const fixture = fs.mkdtempSync(path.join(work, '_mac-runtime-test-'));
  try {
    for (const name of mac) {
      const file = path.join(fixture, name);
      fs.mkdirSync(path.dirname(file), {recursive:true});
      fs.writeFileSync(file, 'fixture');
    }
    writeRuntimeStamp(fixture, '2.0.5');
    assert.equal(runtimeLooksReady(fixture, '2.0.5'), true);
    assert.equal(runtimeLooksReady(fixture, '2.0.6'), false);
    for (const name of ['.node-sandbox/node', '.node-sandbox/node_modules/npm/bin/npm-prefix.js']) {
      fs.unlinkSync(path.join(fixture, name));
      assert.equal(runtimeLooksReady(fixture, '2.0.5'), false, `must re-extract without ${name}`);
      assert.ok(explainRuntimeGaps(fixture, '2.0.5').includes(`missing:${name}`));
      fs.writeFileSync(path.join(fixture, name), 'fixture');
    }
  } finally { fs.rmSync(fixture, {recursive:true, force:true}); }
}
console.log('Mac self-contained runtime and Windows marker regression checks passed');
