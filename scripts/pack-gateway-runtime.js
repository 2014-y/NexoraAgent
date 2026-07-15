'use strict';
/**
 * 打网关运行时压缩包（快路径）：
 * 1) 指纹未变则复用 zip（重复打包可秒过）
 * 2) 不经 staging 逐文件拷贝，tar 直接收源目录
 * 3) 排除 Electron UI / 打包工具等网关用不到的包
 *
 * 强制重打：set PACK_RUNTIME_FORCE=1
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build-resources');
const ZIP_PATH = path.join(OUT_DIR, 'gateway-runtime.zip');
const FP_PATH = path.join(OUT_DIR, 'gateway-runtime.fingerprint');
const STAMP_DIR = path.join(OUT_DIR, '_runtime-stamp');

const FORCE = String(process.env.PACK_RUNTIME_FORCE || '') === '1';

const SKIP_TOP_LEVEL = [
  'electron',
  'electron-builder',
  'electron-packager',
  'app-builder-bin',
  'app-builder-lib',
  'jsdom',
  'xterm',
  'xterm-addon-fit',
  'node-pty',
  '@types',
  '@electron'
];

const ROOT_FILES = [
  'patch_gateway.js',
  'token-usage-parse.js',
  'capture-desktop.ps1',
  'openclaw-state.js',
  'gateway-auth.js',
  'home-resolve.js',
  'latency-tune.js',
  'plugin-adapt.js',
  'plugin-catalog.js',
  'openclaw-model-sync.js',
  'weixin-direct-login.mjs'
];

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fileHash(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch (e) {
    return 'missing';
  }
}

function pathMeta(p) {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}|${st.size}`;
  } catch (e) {
    return 'missing';
  }
}

function computeFingerprint() {
  const h = crypto.createHash('sha1');
  h.update('v3|');
  h.update(fileHash(path.join(ROOT, 'package.json')));
  h.update(fileHash(path.join(ROOT, 'package-lock.json')));
  for (const f of ROOT_FILES) h.update(fileHash(path.join(ROOT, f)));
  const keys = [
    'node_modules/openclaw/package.json',
    'node_modules/@tencent-weixin/openclaw-weixin/package.json',
    'node_modules/open-computer-use/package.json',
    '.node-sandbox/node.exe',
    'plugins',
    'extensions',
    'scripts/pack-gateway-runtime.js'
  ];
  for (const rel of keys) h.update(rel + '=' + pathMeta(path.join(ROOT, rel)) + ';');
  try {
    const scope = path.join(ROOT, 'node_modules', '@openclaw');
    for (const name of fs.readdirSync(scope)) {
      h.update(name + '=' + fileHash(path.join(scope, name, 'package.json')));
    }
  } catch (e) {}
  return h.digest('hex');
}

function buildExcludeArgs() {
  const args = [];
  const add = (p) => { args.push('--exclude', p); };
  for (const name of SKIP_TOP_LEVEL) {
    add(`node_modules/${name}`);
  }
  add('**/test');
  add('**/tests');
  add('**/__tests__');
  add('**/docs');
  add('**/example');
  add('**/examples');
  add('**/coverage');
  add('**/.github');
  add('**/*.md');
  add('**/*.markdown');
  add('**/*.map');
  add('**/*.d.ts');
  add('node_modules/openclaw/docs');
  add('node_modules/openclaw/src');
  add('node_modules/openclaw/scripts');
  add('node_modules/openclaw/skills');
  add('.node-sandbox/node_modules');
  return args;
}

function main() {
  const t0 = Date.now();
  mkdirp(OUT_DIR);
  const fp = computeFingerprint();
  console.log('[pack-gateway-runtime] fingerprint', fp.slice(0, 12) + '…');

  if (!FORCE && fs.existsSync(ZIP_PATH) && fs.existsSync(FP_PATH)) {
    const prev = fs.readFileSync(FP_PATH, 'utf8').trim();
    if (prev === fp) {
      const mb = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1);
      console.log(`[pack-gateway-runtime] cache hit — reuse zip (${mb} MB), ${Date.now() - t0}ms`);
      console.log('  tip: PACK_RUNTIME_FORCE=1 to rebuild');
      return;
    }
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  rmrf(STAMP_DIR);
  mkdirp(STAMP_DIR);
  fs.writeFileSync(path.join(STAMP_DIR, '.runtime-version'), String(pkg.version || '0.0.0'), 'utf8');

  // 把版本戳临时放到工程根，一次 tar 打进正确文件名，避免 zip 追加
  const stampAtRoot = path.join(ROOT, '.runtime-version');
  const stampBackup = path.join(OUT_DIR, '_runtime-version-backup');
  let hadExistingStamp = false;
  try {
    if (fs.existsSync(stampAtRoot)) {
      hadExistingStamp = true;
      fs.copyFileSync(stampAtRoot, stampBackup);
    }
    fs.copyFileSync(path.join(STAMP_DIR, '.runtime-version'), stampAtRoot);
  } catch (e) {
    throw e;
  }

  const inputs = ['.runtime-version'];
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) inputs.push('node_modules');
  if (fs.existsSync(path.join(ROOT, 'plugins'))) inputs.push('plugins');
  if (fs.existsSync(path.join(ROOT, 'extensions'))) inputs.push('extensions');
  if (fs.existsSync(path.join(ROOT, '.node-sandbox', 'node.exe'))) inputs.push('.node-sandbox');
  for (const f of ROOT_FILES) {
    if (fs.existsSync(path.join(ROOT, f))) inputs.push(f);
  }

  console.log('[pack-gateway-runtime] compressing (direct tar, no staging)…');
  rmrf(ZIP_PATH);
  try {
    const args = ['-a', '-cf', ZIP_PATH, ...buildExcludeArgs(), '-C', ROOT, ...inputs];
    const r = spawnSync('tar', args, {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    });
    if (r.status !== 0) {
      throw new Error(String(r.stderr || r.stdout || 'tar failed').slice(0, 1200));
    }
  } finally {
    try { fs.unlinkSync(stampAtRoot); } catch (e) {}
    if (hadExistingStamp) {
      try { fs.copyFileSync(stampBackup, stampAtRoot); } catch (e) {}
    }
    try { fs.unlinkSync(stampBackup); } catch (e) {}
    rmrf(STAMP_DIR);
  }

  fs.writeFileSync(FP_PATH, fp, 'utf8');
  const mb = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`[pack-gateway-runtime] done: ${ZIP_PATH} (${mb} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
