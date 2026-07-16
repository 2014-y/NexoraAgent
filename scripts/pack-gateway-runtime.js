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
const manifestModule = require('../runtime-pack-manifest');
let RUNTIME_PACK_ID = manifestModule.RUNTIME_PACK_ID;
const { REQUIRED_ZIP_ENTRIES } = manifestModule;

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
  'gateway-boot-harden.js',
  'runtime-pack-manifest.js',
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
  h.update(`v7|pack-id-dynamic|`);
  h.update(fileHash(path.join(ROOT, 'package.json')));
  h.update(fileHash(path.join(ROOT, 'package-lock.json')));
  // 排除 runtime-pack-manifest.js，防止自更新导致指纹无限改变
  for (const f of ROOT_FILES) h.update(fileHash(path.join(ROOT, f)));
  const keys = [
    'node_modules/openclaw/package.json',
    'node_modules/@tencent-weixin/openclaw-weixin/package.json',
    'node_modules/@openclaw/feishu/package.json',
    'node_modules/@openclaw/qqbot/package.json',
    'node_modules/@openclaw/slack/package.json',
    'node_modules/@openclaw/whatsapp/package.json',
    'node_modules/@openclaw/matrix/package.json',
    'node_modules/@openclaw/voice-call/package.json',
    'node_modules/open-computer-use/package.json',
    'node_modules/openclaw/docs/reference/templates/AGENTS.md',
    'config/openclaw-templates/AGENTS.md',
    '.node-sandbox/node.exe',
    '.node-sandbox/node_modules/npm/bin/npm-cli.js',
    '.node-sandbox/node_modules/npm/bin/npm-prefix.js',
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
  add('**/example');
  add('**/examples');
  add('**/coverage');
  add('**/.github');
  // 默认排除 md，稍后强制追加 openclaw 模板 md
  add('**/*.md');
  add('**/*.markdown');
  add('**/*.map');
  add('**/*.d.ts');
  add('node_modules/openclaw/docs/cli');
  add('node_modules/openclaw/docs/channels');
  add('node_modules/openclaw/docs/concepts');
  add('node_modules/openclaw/docs/gateway');
  add('node_modules/openclaw/docs/plugins');
  add('node_modules/openclaw/docs/tools');
  add('node_modules/openclaw/docs/automation');
  add('node_modules/openclaw/scripts');
  add('node_modules/openclaw/skills');
  // 保留 .node-sandbox/node_modules（至少含 npm）：Doctor 启动迁移需要 npm-cli.js
  // 若整树过大，仅排除无关缓存，勿再 exclude 整个 node_modules
  add('.node-sandbox/node_modules/.cache');
  return args;
}

/** Append paths into an existing zip. Windows tar forbids -a with -r; use .NET ZipFile there. */
function zipAppendPaths(rels) {
  const list = (Array.isArray(rels) ? rels : [rels]).filter(Boolean);
  if (!list.length) return 0;
  if (process.platform === 'win32') {
    const normalized = list.map((r) => String(r).replace(/\\/g, '/'));
    const payloadPath = path.join(OUT_DIR, '_zip-append-list.json');
    fs.writeFileSync(payloadPath, JSON.stringify({ zip: ZIP_PATH, root: ROOT, rels: normalized }), 'utf8');
    const payloadEsc = payloadPath.replace(/'/g, "''");
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "$data = Get-Content -LiteralPath '" + payloadEsc + "' -Raw -Encoding UTF8 | ConvertFrom-Json",
      "$zip = [System.IO.Compression.ZipFile]::Open($data.zip, [System.IO.Compression.ZipArchiveMode]::Update)",
      "$added = 0",
      "try {",
      "  foreach ($rel in $data.rels) {",
      "    $full = [System.IO.Path]::Combine($data.root, ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar))",
      "    if (-not (Test-Path -LiteralPath $full)) { continue }",
      "    if (Test-Path -LiteralPath $full -PathType Container) {",
      "      Get-ChildItem -LiteralPath $full -Recurse -File | ForEach-Object {",
      "        $sub = $_.FullName.Substring($data.root.Length).TrimStart([char]92, [char]47).Replace([char]92, [char]47)",
      "        $existing = $zip.GetEntry($sub)",
      "        if ($existing) { $existing.Delete() }",
      "        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $sub, [System.IO.Compression.CompressionLevel]::Optimal)",
      "        $added++",
      "      }",
      "    } else {",
      "      $entryName = [string]$rel",
      "      $existing = $zip.GetEntry($entryName)",
      "      if ($existing) { $existing.Delete() }",
      "      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $full, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)",
      "      $added++",
      "    }",
      "  }",
      "} finally { $zip.Dispose() }",
      "try { Remove-Item -LiteralPath '" + payloadEsc + "' -Force } catch {}",
      "Write-Output $added"
    ].join('; ');
    const r = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', ps], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    });
    if (r.status !== 0) {
      throw new Error('zipAppendPaths (powershell): ' + String(r.stderr || r.stdout || 'failed').slice(0, 800));
    }
    const n = parseInt(String(r.stdout || '').trim().split(/\r?\n/).pop(), 10);
    return Number.isFinite(n) ? n : 0;
  }
  let added = 0;
  for (const rel of list) {
    const r = spawnSync('tar', ['-a', '-rf', ZIP_PATH, '-C', ROOT, rel], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true
    });
    if (r.status !== 0) {
      console.warn('[pack-gateway-runtime] zip append warn:', rel, String(r.stderr || r.stdout || '').slice(0, 160));
    } else {
      added += 1;
    }
  }
  return added;
}


/** 模板曾被 md 通配符排除；必须把 .md 文件显式打进 zip（目录空壳不够） */
function appendOpenClawTemplates() {
  const docsRel = 'node_modules/openclaw/docs/reference/templates';
  const srcRel = 'node_modules/openclaw/src/agents/templates';
  const bundledRel = 'config/openclaw-templates';
  const docsAbs = path.join(ROOT, docsRel);
  const srcAbs = path.join(ROOT, srcRel);
  const bundledAbs = path.join(ROOT, bundledRel);

  const sourceDir = [docsAbs, bundledAbs].find((p) => {
    try { return fs.existsSync(path.join(p, 'AGENTS.md')); } catch (e) { return false; }
  });
  if (!sourceDir) {
    console.warn('[pack-gateway-runtime] AGENTS.md source missing — workspace templates will be broken');
    return;
  }

  // 保证 src/agents/templates 与 docs 同步（OpenClaw 两处都会查）
  for (const dest of [docsAbs, srcAbs]) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(sourceDir)) {
      if (!/\.md$/i.test(name)) continue;
      try { fs.copyFileSync(path.join(sourceDir, name), path.join(dest, name)); } catch (e) {}
    }
  }

  const filesToAdd = [];
  for (const relDir of [docsRel, srcRel, bundledRel]) {
    const absDir = path.join(ROOT, relDir);
    if (!fs.existsSync(absDir)) continue;
    for (const name of fs.readdirSync(absDir)) {
      if (!/\.md$/i.test(name)) continue;
      filesToAdd.push(path.join(relDir, name).replace(/\\/g, '/'));
    }
  }

  const added = zipAppendPaths(filesToAdd);
  console.log(`  + forced template md files: ${added}`);

  // 校验 zip 内真有 AGENTS.md
  const check = spawnSync('tar', ['-tf', ZIP_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  const listing = String(check.stdout || '');
  if (!/node_modules\/openclaw\/docs\/reference\/templates\/AGENTS\.md/.test(listing)) {
    throw new Error('pack-gateway-runtime: AGENTS.md missing from zip after append — refuse broken package');
  }
}

/** 确保沙箱自带 npm（Doctor 插件修复 / openclaw plugins install 依赖） */
function appendSandboxNpm() {
  const npmCli = path.join(ROOT, '.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmPrefix = path.join(ROOT, '.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-prefix.js');
  if (!fs.existsSync(npmCli) || !fs.existsSync(npmPrefix)) {
    throw new Error(
      'pack-gateway-runtime: sandbox npm incomplete — need both npm-cli.js and npm-prefix.js under .node-sandbox'
    );
  }
  const check = spawnSync('tar', ['-tf', ZIP_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  const listing = String(check.stdout || '');
  const hasCli = listing.includes('.node-sandbox/node_modules/npm/bin/npm-cli.js');
  const hasPrefix = listing.includes('.node-sandbox/node_modules/npm/bin/npm-prefix.js');
  if (hasCli && hasPrefix) {
    console.log('  + sandbox npm already in zip (skip append)');
    return;
  }
  const rel = '.node-sandbox/node_modules';
  const n = zipAppendPaths([rel]);
  console.log('  + forced sandbox node_modules (npm), entries=' + n);
}

/** 打包结束强制校验：渠道包 / npm / AGENTS.md 缺一不可 */
function assertZipComplete() {
  const check = spawnSync('tar', ['-tf', ZIP_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (check.status !== 0) {
    throw new Error('pack-gateway-runtime: cannot list zip for validation');
  }
  const listing = String(check.stdout || '');
  const missing = REQUIRED_ZIP_ENTRIES.filter((entry) => !listing.includes(entry));
  if (missing.length) {
    throw new Error(
      'pack-gateway-runtime: zip missing required entries:\n  - ' + missing.join('\n  - ')
    );
  }
  console.log(`  + zip validated (${REQUIRED_ZIP_ENTRIES.length} required markers ok)`);
}

function assertPackSourcesPresent() {
  const missing = [];
  for (const entry of REQUIRED_ZIP_ENTRIES) {
    if (!fs.existsSync(path.join(ROOT, ...entry.split('/')))) missing.push(entry);
  }
  if (missing.length) {
    throw new Error(
      'pack-gateway-runtime: source tree missing required files (refuse incomplete package):\n  - '
      + missing.join('\n  - ')
    );
  }
}

function main() {
  const t0 = Date.now();
  mkdirp(OUT_DIR);

  const fp = computeFingerprint();
  const nextPackId = 'pack-' + fp.slice(0, 12);

  if (nextPackId !== RUNTIME_PACK_ID) {
    const manifestPath = path.join(ROOT, 'runtime-pack-manifest.js');
    try {
      let content = fs.readFileSync(manifestPath, 'utf8');
      content = content.replace(/const RUNTIME_PACK_ID = '[^']+';/, `const RUNTIME_PACK_ID = '${nextPackId}';`);
      fs.writeFileSync(manifestPath, content, 'utf8');
      console.log(`[pack-gateway-runtime] Auto-updated RUNTIME_PACK_ID to: ${nextPackId}`);
      RUNTIME_PACK_ID = nextPackId;
    } catch (e) {
      console.warn('[pack-gateway-runtime] Failed to auto-update RUNTIME_PACK_ID:', e.message);
    }
  }

  assertPackSourcesPresent();
  console.log('[pack-gateway-runtime] fingerprint', fp.slice(0, 12) + '…', 'pack=' + RUNTIME_PACK_ID);

  if (!FORCE && fs.existsSync(ZIP_PATH) && fs.existsSync(FP_PATH)) {
    const prev = fs.readFileSync(FP_PATH, 'utf8').trim();
    if (prev === fp) {
      let zipOk = false;
      try {
        assertZipComplete();
        zipOk = true;
      } catch (e) {
        console.warn('[pack-gateway-runtime] cache zip incomplete, rebuilding…', String(e.message || e).slice(0, 160));
      }
      if (zipOk) {
        const mb = (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1);
        console.log(`[pack-gateway-runtime] cache hit — reuse zip (${mb} MB), ${Date.now() - t0}ms`);
        console.log('  tip: PACK_RUNTIME_FORCE=1 to rebuild');
        return;
      }
    }
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  rmrf(STAMP_DIR);
  mkdirp(STAMP_DIR);
  fs.writeFileSync(path.join(STAMP_DIR, '.runtime-version'), String(pkg.version || '0.0.0'), 'utf8');

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
  if (fs.existsSync(path.join(ROOT, 'config', 'openclaw-templates'))) inputs.push(path.join('config', 'openclaw-templates'));
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
    appendOpenClawTemplates();
    appendSandboxNpm();
    assertZipComplete();
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
