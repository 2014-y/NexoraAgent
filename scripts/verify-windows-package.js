'use strict';

/**
 * Windows 发版产物闸门：拒绝缺文件、残缺 runtime 或 pack ID 混杂的安装包。
 * 用法：node scripts/verify-windows-package.js [输出目录，默认 dist]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { getBuildOutputDir } = require('./build-output-dir');
const { RUNTIME_PACK_ID, REQUIRED_ZIP_ENTRIES } = require('../runtime-pack-manifest');

function loadAsar() {
  const candidates = [
    '@electron/asar',
    'electron-builder/node_modules/@electron/asar'
  ];
  for (const name of candidates) {
    try { return require(name); } catch (e) {}
  }
  throw new Error('cannot load @electron/asar from electron-builder dependencies');
}

const asar = loadAsar();

const ROOT = path.resolve(__dirname, '..');
const outputArg = process.argv[2] || getBuildOutputDir();
const OUT = path.resolve(ROOT, outputArg);
const UNPACKED = path.join(OUT, 'win-unpacked');
const RESOURCES = path.join(UNPACKED, 'resources');
const APP_EXE = path.join(UNPACKED, 'Nexora Agent.exe');
const APP_ASAR = path.join(RESOURCES, 'app.asar');
const BUNDLED_RUNTIME = path.join(RESOURCES, 'gateway-runtime.tar');
const SOURCE_RUNTIME = path.join(ROOT, 'build-resources', 'gateway-runtime.tar');

function requireFile(file, minBytes, label) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    throw new Error(`${label} missing: ${file}`);
  }
  if (!stat.isFile() || stat.size < minBytes) {
    throw new Error(`${label} invalid (${stat.size} bytes): ${file}`);
  }
  return stat;
}

function readAsarText(file) {
  try {
    return asar.extractFile(APP_ASAR, file).toString('utf8');
  } catch (e) {
    throw new Error(`app.asar missing or cannot read ${file}: ${e.message}`);
  }
}

function extractPackId(source, label) {
  const match = String(source).match(/const\s+RUNTIME_PACK_ID\s*=\s*['"]([^'"]+)['"]/);
  if (!match) throw new Error(`${label} does not declare RUNTIME_PACK_ID`);
  return match[1];
}

function validateRuntimeTar(tarPath) {
  const result = spawnSync('tar', ['-tf', tarPath], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`cannot list bundled gateway-runtime.tar: ${String(result.stderr || result.stdout || '').slice(0, 500)}`);
  }
  const entries = new Set(
    String(result.stdout || '')
      .split(/\r?\n/)
      .map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''))
      .filter(Boolean)
  );
  const missing = REQUIRED_ZIP_ENTRIES.filter((entry) => !entries.has(entry));
  if (missing.length) {
    throw new Error('bundled gateway-runtime.tar missing required entries:\n  - ' + missing.join('\n  - '));
  }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[verify-windows-package] skipped on non-Windows platform');
    return;
  }

  requireFile(APP_EXE, 1024 * 1024, 'unpacked application executable');
  requireFile(APP_ASAR, 1024, 'app.asar');
  const sourceStat = requireFile(SOURCE_RUNTIME, 1024, 'source gateway runtime');
  const bundledStat = requireFile(BUNDLED_RUNTIME, 1024, 'bundled gateway runtime');

  const installers = fs.existsSync(OUT)
    ? fs.readdirSync(OUT)
      .filter((name) => /\.exe$/i.test(name))
      .map((name) => path.join(OUT, name))
      .filter((file) => fs.statSync(file).isFile() && fs.statSync(file).size >= 10 * 1024 * 1024)
    : [];
  if (!installers.length) {
    throw new Error(`NSIS installer missing from output directory: ${OUT}`);
  }

  for (const file of ['main.js', 'patch_gateway.js', 'openclaw-plugin-registry.js', 'index.css']) {
    if (readAsarText(file) !== fs.readFileSync(path.join(ROOT, file), 'utf8')) {
      throw new Error(`app.asar contains stale source: ${file}`);
    }
  }
  readAsarText('gateway-runtime.js');
  const packedManifest = readAsarText('runtime-pack-manifest.js');
  const packedId = extractPackId(packedManifest, 'app.asar runtime manifest');
  if (packedId !== RUNTIME_PACK_ID) {
    throw new Error(`pack ID mismatch: app.asar=${packedId}, source=${RUNTIME_PACK_ID}`);
  }

  const installerNsh = fs.readFileSync(path.join(ROOT, 'config', 'installer.nsh'), 'utf8');
  if (!installerNsh.includes(`\${VERSION}:${RUNTIME_PACK_ID}`)) {
    throw new Error(`installer.nsh does not contain current pack ID ${RUNTIME_PACK_ID}`);
  }

  if (sourceStat.size !== bundledStat.size) {
    throw new Error(`runtime tar size mismatch: source=${sourceStat.size}, bundled=${bundledStat.size}`);
  }
  const [sourceHash, bundledHash] = await Promise.all([
    hashFile(SOURCE_RUNTIME),
    hashFile(BUNDLED_RUNTIME)
  ]);
  if (sourceHash !== bundledHash) {
    throw new Error(`runtime tar hash mismatch: source=${sourceHash}, bundled=${bundledHash}`);
  }

  validateRuntimeTar(BUNDLED_RUNTIME);

  console.log(`[verify-windows-package] OK output=${OUT}`);
  console.log(`  app.asar pack ID: ${packedId}`);
  console.log(`  runtime markers: ${REQUIRED_ZIP_ENTRIES.length}/${REQUIRED_ZIP_ENTRIES.length}`);
  console.log(`  runtime sha256: ${bundledHash}`);
  console.log(`  installer: ${path.basename(installers[0])}`);
}

main().catch((error) => {
  console.error('[verify-windows-package] FAILED:', error.message || error);
  process.exitCode = 1;
});
