import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'acceleration.js'));
const scratch = path.join(root, 'work');
fs.mkdirSync(scratch, { recursive: true });
const temp = fs.mkdtempSync(path.join(scratch, 'acceleration-test-'));
const resources = path.join(temp, 'resources');
const bundle = path.join(resources, 'acceleration-core', `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`);
fs.mkdirSync(bundle, { recursive: true });
const files = {};
for (const [key, name, size] of [
  ['mihomo', 'mihomo.exe', 1024 * 1024], ['wintun', 'wintun.dll', 32 * 1024],
  ['geoip', 'geoip.dat', 1024 * 1024], ['geosite', 'geosite.dat', 100 * 1024]
]) {
  const data = Buffer.alloc(size, 1);
  fs.writeFileSync(path.join(bundle, name), data);
  files[key] = { name, sha256: crypto.createHash('sha256').update(data).digest('hex'), minSize: size };
}
fs.writeFileSync(path.join(bundle, 'core-manifest.json'), JSON.stringify({ files }));

let copies = 0;
let scheduled = 0;
const instrumentedFs = { ...fs, copyFileSync(...args) { copies++; return fs.copyFileSync(...args); } };
const context = vm.createContext({
  require: name => name === 'fs' ? instrumentedFs : require(name),
  module: { exports: {} }, __dirname: root, console, Buffer, URL,
  process: { ...process, resourcesPath: resources }, global: {},
  setTimeout() { scheduled++; }, clearTimeout, setInterval, clearInterval
});
try {
  vm.runInContext(fs.readFileSync(path.join(root, 'acceleration.js'), 'utf8'), context);
  const api = context.module.exports;
  const userData = path.join(temp, 'profile1');
  api.init({ getPath: () => userData });
  assert.equal(copies, 0, 'idle startup must not copy bundled binaries');
  assert.equal(scheduled, 0, 'no subscription must not schedule an automatic core start');
  assert.equal(api.isCoreReady(), false);
  assert.equal((await api.ensureCore()).success, true, 'first use must install the bundled core offline');
  const copied = copies;
  assert.ok(copied >= 4);
  assert.equal((await api.ensureCore()).success, true);
  assert.equal(copies, copied, 'repeated use must reuse installed files');
  const geoip = path.join(userData, 'acceleration', 'geoip.dat');
  fs.unlinkSync(geoip);
  await api.ensureCore();
  assert.ok(fs.existsSync(geoip), 'removed geographic data must be restored');
  fs.writeFileSync(geoip, Buffer.alloc(files.geoip.minSize, 2));
  fs.utimesSync(geoip, new Date(0), new Date(0));
  await api.ensureCore();
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(geoip)).digest('hex'), files.geoip.sha256,
    'same-size modified data must invalidate the installation cache');
  if (process.platform === 'win32') {
    const wintun = path.join(userData, 'acceleration', 'core', 'wintun.dll');
    fs.writeFileSync(wintun, 'incomplete');
    await api.ensureCore();
    assert.equal(fs.statSync(wintun).size, files.wintun.minSize, 'partial driver must be restored');
    const workingWintun = path.join(userData, 'acceleration', 'wintun.dll');
    fs.unlinkSync(workingWintun);
    await api.ensureCore();
    assert.ok(fs.existsSync(workingWintun), 'working-directory driver must be restored too');
  }
  api.init({ getPath: () => path.join(temp, 'profile2') });
  assert.equal((await api.ensureCore()).success, true, 'installation cache must not cross user data directories');
  fs.writeFileSync(path.join(bundle, 'mihomo.exe'), Buffer.alloc(files.mihomo.minSize, 3));
  api.init({ getPath: () => path.join(temp, 'profile3') });
  assert.equal(vm.runInContext('installBundledCore().success', context), false,
    'a bundled executable with an invalid hash must be rejected before copying');
  assert.equal(api.isCoreReady(), false);
  console.log('acceleration lazy installation tests passed');
} finally {
  // temp is created under this test-owned workspace directory.
  fs.rmSync(temp, { recursive: true, force: true });
}
