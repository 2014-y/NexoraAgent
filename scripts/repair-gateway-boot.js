'use strict';
/**
 * 一键修复：补齐渠道插件包 + npm，并启用已存在的渠道（让飞书/QQ 等真正加载）。
 *
 *   node scripts/repair-gateway-boot.js
 *   node scripts/repair-gateway-boot.js "C:\\Users\\Administrator\\AppData\\Local\\NexoraAgent"
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  softenOpenClawStartupMigrationGuard,
  ensureSandboxNpmPresent,
  forceDisableUninstalledChannelPlugins,
  ensureOpenClawWorkspaceTemplates
} = require('../gateway-boot-harden');
const { explainRuntimeGaps, REQUIRED_RUNTIME_MARKERS } = require('../gateway-runtime');

const ROOT = path.resolve(__dirname, '..');

function exists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

function findBases(explicit) {
  const out = [];
  const push = (p) => { if (p && exists(p) && !out.includes(path.resolve(p))) out.push(path.resolve(p)); };
  if (explicit) push(explicit);
  const la = process.env.LOCALAPPDATA || '';
  push(path.join(la, 'NexoraAgent'));
  push(path.join(la, 'ClawAI'));
  push(ROOT);
  push('C:\\Users\\Administrator\\AppData\\Local\\NexoraAgent');
  push('C:\\Users\\Yuan\\AppData\\Local\\NexoraAgent');
  push('C:\\Users\\Yuan\\AppData\\Local\\ClawAI');
  return out;
}

function resolveRuntime(base) {
  const a = path.join(base, 'gateway-runtime');
  if (exists(path.join(a, 'node_modules', 'openclaw'))) return a;
  if (exists(path.join(base, 'node_modules', 'openclaw'))) return base;
  return null;
}

function findZipCandidates(base) {
  const out = [];
  const push = (p) => { if (p && exists(p)) out.push(p); };
  push(path.join(ROOT, 'build-resources', 'gateway-runtime.zip'));
  push(path.join(base, 'gateway-runtime.zip'));
  // 已安装 Electron 资源
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  for (const root of [pf, pf86, 'D:\\Program Files', 'E:\\Program Files']) {
    push(path.join(root, 'Nexora Agent', 'resources', 'gateway-runtime.zip'));
    push(path.join(root, 'NexoraAgent', 'resources', 'gateway-runtime.zip'));
  }
  return out;
}

/** 从完整 zip 覆盖解压到 runtime（补齐 @openclaw / npm） */
function extractZipIntoRuntime(zipPath, runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const r = spawnSync('tar', ['-a', '-xf', zipPath, '-C', runtimeRoot], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (r.status !== 0) {
    throw new Error(String(r.stderr || r.stdout || 'tar extract failed').slice(0, 500));
  }
}

/** 若工程/本机有完整 @openclaw，直接拷进残缺 runtime */
function copyChannelPackagesFromSource(runtimeRoot) {
  const srcScope = path.join(ROOT, 'node_modules', '@openclaw');
  const dstScope = path.join(runtimeRoot, 'node_modules', '@openclaw');
  if (!exists(srcScope)) return { copied: 0 };
  let copied = 0;
  fs.mkdirSync(dstScope, { recursive: true });
  for (const name of fs.readdirSync(srcScope)) {
    const from = path.join(srcScope, name);
    const to = path.join(dstScope, name);
    if (!exists(path.join(from, 'package.json'))) continue;
    if (exists(path.join(to, 'package.json'))) continue;
    fs.cpSync(from, to, { recursive: true, force: true });
    copied += 1;
  }
  const wxFrom = path.join(ROOT, 'node_modules', '@tencent-weixin', 'openclaw-weixin');
  const wxTo = path.join(runtimeRoot, 'node_modules', '@tencent-weixin', 'openclaw-weixin');
  if (exists(path.join(wxFrom, 'package.json')) && !exists(path.join(wxTo, 'package.json'))) {
    fs.mkdirSync(path.dirname(wxTo), { recursive: true });
    fs.cpSync(wxFrom, wxTo, { recursive: true, force: true });
    copied += 1;
  }
  return { copied };
}

function invalidateStampIfIncomplete(runtimeRoot) {
  const gaps = explainRuntimeGaps(runtimeRoot, '');
  // 版本戳比对会因空 version 误报，只看 missing:
  const missing = gaps.filter((g) => g.startsWith('missing:'));
  if (missing.length === 0) return { invalidated: false, missing };
  const stamp = path.join(runtimeRoot, '.runtime-version');
  if (exists(stamp)) {
    try { fs.unlinkSync(stamp); } catch (e) {}
  }
  return { invalidated: true, missing };
}

function patchConfig(file, runtimeRoot) {
  if (!exists(file)) return null;
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const cfg = JSON.parse(raw);
  // 有包 → 启用；无包 → 删除条目（避免 Doctor npm）
  const r = forceDisableUninstalledChannelPlugins(cfg, { runtimeRoot });
  if (r.changed) {
    const bak = file + '.bak-repair-' + Date.now();
    fs.copyFileSync(file, bak);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    return { file, bak, changed: true };
  }
  return { file, changed: false };
}

function deployPatch(stateDir) {
  const src = path.join(ROOT, 'patch_gateway.js');
  if (!exists(src) || !exists(stateDir)) return;
  fs.copyFileSync(src, path.join(stateDir, 'patch_gateway.js'));
  const harden = path.join(ROOT, 'gateway-boot-harden.js');
  if (exists(harden)) fs.copyFileSync(harden, path.join(stateDir, 'gateway-boot-harden.js'));
}

function main() {
  const bases = findBases(process.argv[2]);
  console.log('[repair-gateway-boot] scanning', bases.length, 'roots');
  console.log('[repair-gateway-boot] required markers:', REQUIRED_RUNTIME_MARKERS.map((x) => x.join('/')).join(' | '));

  for (const base of bases) {
    const runtime = resolveRuntime(base);
    if (!runtime) continue;
    console.log('\n==', runtime);

    let gaps = explainRuntimeGaps(runtime, '');
    let missing = gaps.filter((g) => g.startsWith('missing:'));
    console.log('  gaps:', missing.length ? missing.join(', ') : '(ok)');

    if (missing.length) {
      const zips = findZipCandidates(base);
      if (zips.length) {
        console.log('  extracting zip →', zips[0]);
        try {
          extractZipIntoRuntime(zips[0], runtime);
        } catch (e) {
          console.warn('  zip extract failed:', e.message);
        }
      } else {
        console.log('  no zip found; trying copy from project node_modules…');
        const c = copyChannelPackagesFromSource(runtime);
        console.log('  copied packages:', c.copied);
      }
      const npm = ensureSandboxNpmPresent(runtime, ROOT);
      console.log('  npm:', npm);
      const inv = invalidateStampIfIncomplete(runtime);
      console.log('  stamp invalidate:', inv);
      try {
        fs.unlinkSync(path.join(runtime, '.runtime-stamp'));
        fs.unlinkSync(path.join(runtime, '.runtime-version'));
      } catch (e) {}
      gaps = explainRuntimeGaps(runtime, '');
      missing = gaps.filter((g) => g.startsWith('missing:'));
      console.log('  after repair gaps:', missing.length ? missing.join(', ') : '(ok)');
    } else {
      console.log('  npm:', ensureSandboxNpmPresent(runtime, ROOT));
    }

    console.log('  soft:', softenOpenClawStartupMigrationGuard(runtime));
    const tpl = ensureOpenClawWorkspaceTemplates(runtime, [
      path.join(ROOT, 'config', 'openclaw-templates'),
      path.join(runtime, 'config', 'openclaw-templates')
    ]);
    console.log('  templates:', tpl);

    const stateDirs = [
      path.join(base, '.openclaw'),
      path.join(process.env.USERPROFILE || '', '.openclaw'),
      path.join(path.dirname(runtime), '.openclaw'),
      path.join(runtime, '..', '.openclaw')
    ].map((p) => path.resolve(p));
    const seen = new Set();
    for (const st of stateDirs) {
      if (seen.has(st) || !exists(st)) continue;
      seen.add(st);
      deployPatch(st);
      console.log('  patch →', st);
      const cfg = path.join(st, 'openclaw.json');
      const r = patchConfig(cfg, runtime);
      if (r) console.log('  config:', r);
    }
    const r2 = patchConfig(path.join(base, 'openclaw.json'), runtime);
    if (r2) console.log('  config:', r2);
  }
  console.log('\nOK — 请完全退出 Nexora Agent 后重新打开。');
  console.log('成功时日志应出现: http server listening (N plugins: … feishu / qqbot / …)');
}

main();
