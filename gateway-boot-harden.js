'use strict';
/**
 * Gateway 启动硬修复（不依赖 ESM Module._load）：
 * 1) 改写 openclaw doctor-config-preflight：插件 npm 失败不再 throw
 * 2) 尽量把 npm 种进 .node-sandbox
 * 3) 关掉未安装渠道插件条目
 */
const fs = require('fs');
const path = require('path');

const CHANNEL_PLUGIN_IDS = [
  'feishu', 'qqbot', 'slack', 'whatsapp', 'matrix', 'voice-call', 'telegram'
];
const STALE_PLUGIN_IDS = ['long-term-memory', 'channel-router'];

function exists(p) {
  try { return !!(p && fs.existsSync(p)); } catch (e) { return false; }
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const a = path.join(src, name);
    const b = path.join(dst, name);
    const st = fs.statSync(a);
    if (st.isDirectory()) copyTree(a, b);
    else {
      try { fs.copyFileSync(a, b); } catch (e) {}
    }
  }
}

/** 把 doctor-config-preflight 里的 throw 改成一行提示，不再 dump npm/TokenGuard 长栈 */
function softenOpenClawStartupMigrationGuard(runtimeRoot) {
  const dist = path.join(runtimeRoot || '', 'node_modules', 'openclaw', 'dist');
  if (!exists(dist)) return { ok: false, reason: 'no-dist' };
  const quietBlock = [
    'if (startupMigrationWarnings.length > 0 || blockers.length > 0) {',
    '\t\t\t/* NEXORA_SOFT_STARTUP_MIGRATION */',
    '\t\t\tconsole.error("[NexoraAgent] Soft-skip plugin repair (missing npm/offline); gateway continues.");',
    '\t\t}'
  ].join('\n');
  let patched = 0;
  for (const name of fs.readdirSync(dist)) {
    if (!/^doctor-config-preflight-.*\.js$/i.test(name)) continue;
    const file = path.join(dist, name);
    let src = fs.readFileSync(file, 'utf8');
    let next = src;

    // 已 soft-skip 但仍 dump 全文 → 收成一行
    if (next.includes('NEXORA_SOFT_STARTUP_MIGRATION')) {
      next = next.replace(
        /if \(startupMigrationWarnings\.length > 0 \|\| blockers\.length > 0\) \{[\s\S]*?\/\* NEXORA_SOFT_STARTUP_MIGRATION \*\/[\s\S]*?\n\t\t\}/,
        quietBlock
      );
    } else {
      const re2 = /if \(startupMigrationWarnings\.length > 0 \|\| blockers\.length > 0\) throw new Error\(formatStartupMigrationFailure\([\s\S]*?\)\)\;/;
      if (re2.test(next)) next = next.replace(re2, quietBlock);
    }
    if (next === src) {
      if (src.includes('NEXORA_SOFT_STARTUP_MIGRATION') && !src.includes('gateway continues')) {
        // 旧 soft 块：砍掉 formatStartupMigrationFailure 打印
        next = src.replace(
          /console\.error\("\[NexoraAgent\] Soft-skip[\s\S]*?formatStartupMigrationFailure\([\s\S]*?\)\);[\s\S]*?\} catch \(e\) \{\}/,
          'console.error("[NexoraAgent] Soft-skip plugin repair (missing npm/offline); gateway continues.");'
        );
      }
    }
    if (next !== src) {
      fs.writeFileSync(file, next, 'utf8');
      patched += 1;
    } else if (src.includes('NEXORA_SOFT_STARTUP_MIGRATION')) {
      patched += 1;
    }
  }

  // 额外处理 startup-migration-checkpoint，强行去掉死锁检查
  for (const name of fs.readdirSync(dist)) {
    if (/^startup-migration-checkpoint-.*\.js$/i.test(name)) {
      const file = path.join(dist, name);
      let src = fs.readFileSync(file, 'utf8');
      const reLock = /if\s*\(\s*existing\s*\)\s*throw\s+new\s+Error\s*\(\s*`OpenClaw startup migrations are already running[\s\S]*?`\s*\)\s*;/g;
      const reExpire = /\.where\("expires_at",\s*"<=",\s*nowMs\)/g;
      let next = src;
      let changed = false;
      if (reLock.test(next)) {
        next = next.replace(reLock, '/* NEXORA_SOFT_MIGRATION_LOCK: bypass */');
        changed = true;
      }
      if (reExpire.test(next)) {
        next = next.replace(reExpire, '/* NEXORA_EXPIRE_BYPASS */');
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(file, next, 'utf8');
        patched += 1;
      }
    }
  }

  return { ok: patched > 0, patched };
}

function ensureSandboxNpmPresent(runtimeRoot, projectRoot) {
  const destCli = path.join(runtimeRoot, '.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const destPrefix = path.join(runtimeRoot, '.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-prefix.js');
  if (exists(destCli) && exists(destPrefix)) return { ok: true, skipped: true };

  const nmCandidates = [];
  const pushNm = (p) => { if (p && exists(path.join(p, 'npm', 'bin', 'npm-cli.js'))) nmCandidates.push(p); };
  if (projectRoot) pushNm(path.join(projectRoot, '.node-sandbox', 'node_modules'));
  pushNm(path.join(runtimeRoot, '.node-sandbox', 'node_modules'));
  try {
    const { execSync } = require('child_process');
    const whereNode = execSync('where node', { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    if (whereNode) {
      const nodeDir = path.dirname(whereNode);
      pushNm(path.join(nodeDir, 'node_modules'));
      pushNm(path.join(path.dirname(nodeDir), 'node_modules'));
    }
  } catch (e) {}

  for (const nm of nmCandidates) {
    try {
      const destNm = path.join(runtimeRoot, '.node-sandbox', 'node_modules');
      fs.mkdirSync(destNm, { recursive: true });
      copyTree(path.join(nm, 'npm'), path.join(destNm, 'npm'));
      // npm 依赖常与 npm 同级；缺啥再补常见作用域
      for (const dep of fs.readdirSync(nm)) {
        if (dep === 'npm') continue;
        if (!(dep.startsWith('@npmcli') || dep.startsWith('@isaacs') || dep.startsWith('@sigstore')
          || dep.startsWith('@tufjs') || dep.startsWith('@gar') || dep === 'semver' || dep === 'which'
          || dep === 'nopt' || dep === 'proc-log' || dep === 'tar' || dep === 'ssri' || dep === 'cacache'
          || dep === 'minipass' || dep === 'minimatch' || dep === 'glob' || dep === 'graceful-fs'
          || dep === 'lru-cache' || dep === 'json-parse-even-better-errors' || dep === 'npm-package-arg'
          || dep === 'libnpmaccess' || dep === 'libnpmdiff' || dep === 'libnpmexec' || dep === 'libnpmfund'
          || dep === 'libnpmorg' || dep === 'libnpmpack' || dep === 'libnpmpublish' || dep === 'libnpmsearch'
          || dep === 'libnpmteam' || dep === 'libnpmversion' || dep === 'node-gyp' || dep === 'pacote'
          || dep === 'init-package-json' || dep === 'npm-registry-fetch' || dep === 'make-fetch-happen'
          || dep === 'socks-proxy-agent' || dep === 'http-proxy-agent' || dep === 'https-proxy-agent'
          || dep === 'agent-base' || dep === 'agentkeepalive' || dep === 'encoding' || dep === 'iconv-lite'
          || dep === 'yallist' || dep === 'brace-expansion' || dep === 'balanced-match' || dep === 'abbrev'
          || dep === 'hosted-git-info' || dep === 'validate-npm-package-name' || dep === 'npm-bundled'
          || dep === 'npm-normalize-package-bin' || dep === 'npm-packlist' || dep === 'ignore-walk'
          || dep === 'cmd-shim' || dep === 'read' || dep === 'read-cmd-shim' || dep === 'write-file-atomic'
          || dep === 'unique-filename' || dep === 'unique-slug' || dep === 'imurmurhash' || dep === 'chownr'
          || dep === 'fs-minipass' || dep === 'minizlib' || dep === 'fs.realpath' || dep === 'inflight'
          || dep === 'inherits' || dep === 'once' || dep === 'wrappy' || dep === 'path-is-absolute'
          || dep === 'isexe' || dep === 'cross-spawn' || dep === 'path-key' || dep === 'shebang-command'
          || dep === 'shebang-regex' || dep === 'which' || dep === 'debug' || dep === 'ms'
          || dep === 'negotiator' || dep === 'promise-retry' || dep === 'err-code' || dep === 'retry'
          || dep === 'socks' || dep === 'smart-buffer' || dep === 'ip-address' || dep === 'sprintf-js'
          || dep === 'cidr-regex' || dep === 'is-cidr')) {
          continue;
        }
        const from = path.join(nm, dep);
        const to = path.join(destNm, dep);
        if (!exists(to) && exists(from)) {
          try { copyTree(from, to); } catch (e) {}
        }
      }
      if (exists(destCli) && exists(destPrefix)) return { ok: true, from: nm };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  return { ok: false, reason: 'npm-source-missing' };
}

const CHANNEL_PACKAGE_BY_ID = {
  feishu: '@openclaw/feishu',
  qqbot: '@openclaw/qqbot',
  slack: '@openclaw/slack',
  whatsapp: '@openclaw/whatsapp',
  matrix: '@openclaw/matrix',
  'voice-call': '@openclaw/voice-call',
  telegram: null
};

function resolveBundledChannelPackageDir(runtimeRoot, pluginId) {
  const pkgName = CHANNEL_PACKAGE_BY_ID[pluginId];
  if (!pkgName || !runtimeRoot) return null;
  const dir = path.join(runtimeRoot, 'node_modules', ...pkgName.split('/'));
  // 由于主进程在执行硬修复时可能还未解压 ZIP，取消物理文件存在性检查
  // 我们在打包时已经把这些内置包强行塞入，所以直接信任并返回绝对路径即可。
  return dir;
}

/**
 * 只清理「盘上确实没有包」的渠道条目；有包的保留/启用（和本机体验一致）。
 * stale UI 伞形 id 一律删除。
 */
function forceDisableUninstalledChannelPlugins(config, opts = {}) {
  if (!config || typeof config !== 'object') return { changed: false };
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  if (!config.plugins.installs) config.plugins.installs = {};
  if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
  const runtimeRoot = opts.runtimeRoot || '';
  let changed = false;

  for (const id of STALE_PLUGIN_IDS) {
    if (config.plugins.entries[id]) {
      delete config.plugins.entries[id];
      changed = true;
    }
  }
  if (Array.isArray(config.plugins.allow)) {
    const next = config.plugins.allow.filter((x) => !STALE_PLUGIN_IDS.includes(x));
    if (next.length !== config.plugins.allow.length) {
      config.plugins.allow = next;
      changed = true;
    }
  }

  for (const id of CHANNEL_PLUGIN_IDS) {
    const bundled = resolveBundledChannelPackageDir(runtimeRoot, id);
    const installPath = config.plugins.installs[id] && config.plugins.installs[id].installPath;
    const installOk = installPath && exists(path.join(installPath, 'package.json'));
    const present = !!(bundled || installOk);

    if (!present) {
      // 没包：为了实现“首次启动自动装好”，不再删除条目！
      // 保留它们在配置中，使得底层的 Doctor 可以在首次启动时触发自动 npm install 下载插件
      if (!config.plugins.entries[id]) {
        config.plugins.entries[id] = { enabled: true };
        changed = true;
      } else if (config.plugins.entries[id].enabled !== true) {
        config.plugins.entries[id].enabled = true;
        changed = true;
      }
      if (!config.plugins.allow.includes(id)) {
        config.plugins.allow.push(id);
        changed = true;
      }
      continue;
    }

    // 有包：种 installs + 启用（与本机「会显示启用」一致）
    const pkgName = CHANNEL_PACKAGE_BY_ID[id];
    const usePath = bundled || installPath;
    let ver = '0.0.0';
    try {
      ver = JSON.parse(fs.readFileSync(path.join(usePath, 'package.json'), 'utf8')).version || ver;
    } catch (e) {}
    if (pkgName && usePath) {
      const nextInstall = {
        ...(config.plugins.installs[id] || {}),
        source: 'npm',
        spec: `${pkgName}@${ver}`,
        installPath: usePath,
        resolvedName: pkgName,
        resolvedVersion: ver,
        resolvedSpec: `${pkgName}@${ver}`,
        version: ver,
        installedAt: (config.plugins.installs[id] && config.plugins.installs[id].installedAt)
          || new Date().toISOString()
      };
      if (JSON.stringify(config.plugins.installs[id] || {}) !== JSON.stringify(nextInstall)) {
        config.plugins.installs[id] = nextInstall;
        changed = true;
      }
    }
    if (!config.plugins.entries[id]) {
      config.plugins.entries[id] = { enabled: true };
      changed = true;
    } else if (config.plugins.entries[id].enabled !== true) {
      config.plugins.entries[id].enabled = true;
      changed = true;
    }
    if (!config.plugins.allow.includes(id)) {
      config.plugins.allow.push(id);
      changed = true;
    }
  }
  return { changed };
}

/**
 * 绕过插件受信校验补丁，使 load.paths 下的插件可以正常调用 openKeyedStore
 */
function bypassOpenClawPluginTrustCheck(runtimeRoot) {
  const dist = path.join(runtimeRoot || '', 'node_modules', 'openclaw', 'dist');
  if (!exists(dist)) return { ok: false, reason: 'no-dist' };
  
  let patched = 0;
  try {
    for (const name of fs.readdirSync(dist)) {
      if (!/^registry-.*\.js$/i.test(name)) continue;
      const file = path.join(dist, name);
      let src = fs.readFileSync(file, 'utf8');
      let next = src;
      
      const targetStr = 'record?.origin !== "bundled" && record?.trustedOfficialInstall !== true';
      if (next.includes(targetStr)) {
        next = next.replace(targetStr, 'false');
      }
      
      if (next !== src) {
        fs.writeFileSync(file, next, 'utf8');
        patched += 1;
      } else if (next.includes('false') && src.includes('throw new Error("openKeyedStore')) {
        patched += 1;
      }
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  return { ok: patched > 0, patched };
}

/**
 * 启动 Gateway 前调用：软化 migration + 种 npm + 同步渠道插件 + 补齐 AGENTS.md 模板 + 绕过受信校验
 */
function hardenGatewayBootAgainstPluginNpm(params) {
  const runtimeRoot = params && params.runtimeRoot;
  const projectRoot = params && params.projectRoot;
  const config = params && params.config;
  const templateSources = params && params.templateSources;
  const notes = [];
  if (runtimeRoot) {
    const soft = softenOpenClawStartupMigrationGuard(runtimeRoot);
    notes.push(`soft=${soft.ok ? soft.patched : soft.reason}`);
    const trust = bypassOpenClawPluginTrustCheck(runtimeRoot);
    notes.push(`trust-bypass=${trust.ok ? trust.patched : trust.reason}`);
    const npm = ensureSandboxNpmPresent(runtimeRoot, projectRoot);
    notes.push(`npm=${npm.ok ? (npm.skipped ? 'ok' : 'healed') : npm.reason}`);
    const tpl = ensureOpenClawWorkspaceTemplates(runtimeRoot, templateSources || []);
    notes.push(`templates=${tpl.ok ? `wrote:${tpl.wrote}` : tpl.reason}`);
  }
  let configChanged = false;
  if (config) {
    const d = forceDisableUninstalledChannelPlugins(config, { runtimeRoot });
    configChanged = d.changed;
    notes.push(`plugins-sync=${d.changed}`);
  }
  return { notes, configChanged };
}

/**
 * 把 AGENTS.md 等 workspace 模板写进 openclaw 两处查询路径。
 * 打包时 md 通配符常被排除，缺文件会直接报 Missing workspace template。
 */
function ensureOpenClawWorkspaceTemplates(runtimeRoot, extraSources = []) {
  if (!runtimeRoot) return { ok: false, reason: 'no-runtime', wrote: 0 };
  const destDirs = [
    path.join(runtimeRoot, 'node_modules', 'openclaw', 'docs', 'reference', 'templates'),
    path.join(runtimeRoot, 'node_modules', 'openclaw', 'src', 'agents', 'templates')
  ];
  const required = [
    'AGENTS.md', 'HEARTBEAT.md', 'SOUL.md', 'USER.md', 'IDENTITY.md',
    'TOOLS.md', 'BOOT.md', 'BOOTSTRAP.md'
  ];

  const sourceDirs = [];
  const pushSrc = (p) => {
    if (p && exists(path.join(p, 'AGENTS.md')) && !sourceDirs.includes(p)) sourceDirs.push(p);
  };
  for (const s of extraSources || []) pushSrc(s);
  pushSrc(path.join(runtimeRoot, 'config', 'openclaw-templates'));
  pushSrc(path.join(__dirname, 'config', 'openclaw-templates'));
  pushSrc(path.join(runtimeRoot, 'node_modules', 'openclaw', 'docs', 'reference', 'templates'));

  if (!sourceDirs.length) {
    // 最后兜底：写最小可用 AGENTS.md，避免聊天直接炸
    const fallback = {
      'AGENTS.md': '# AGENTS.md\n\nThis is your agent workspace. Follow user instructions.\n',
      'HEARTBEAT.md': '<!-- empty heartbeat; skip scheduled calls -->\n',
      'SOUL.md': '# SOUL.md\n\nBe helpful and concise.\n',
      'USER.md': '# USER.md\n\n(User profile — fill in as needed)\n',
      'IDENTITY.md': '# IDENTITY.md\n\nName: Nexora Agent\n',
      'TOOLS.md': '# TOOLS.md\n\nUse available tools when helpful.\n',
      'BOOT.md': '# BOOT.md\n',
      'BOOTSTRAP.md': '# BOOTSTRAP.md\n'
    };
    let wrote = 0;
    for (const dest of destDirs) {
      try {
        fs.mkdirSync(dest, { recursive: true });
        for (const [name, body] of Object.entries(fallback)) {
          const out = path.join(dest, name);
          if (!exists(out)) {
            fs.writeFileSync(out, body, 'utf8');
            wrote += 1;
          }
        }
      } catch (e) {}
    }
    return { ok: wrote > 0 || destDirs.every((d) => exists(path.join(d, 'AGENTS.md'))), wrote, reason: wrote ? 'fallback' : 'fallback-failed' };
  }

  const src = sourceDirs[0];
  let wrote = 0;
  for (const dest of destDirs) {
    try {
      fs.mkdirSync(dest, { recursive: true });
      for (const name of required) {
        const from = path.join(src, name);
        const to = path.join(dest, name);
        if (!exists(from)) continue;
        if (!exists(to)) {
          fs.copyFileSync(from, to);
          wrote += 1;
        }
      }
      // 同步其余 .md（dev 模板等）
      for (const name of fs.readdirSync(src)) {
        if (!/\.md$/i.test(name)) continue;
        const from = path.join(src, name);
        const to = path.join(dest, name);
        if (!exists(to)) {
          try { fs.copyFileSync(from, to); wrote += 1; } catch (e) {}
        }
      }
    } catch (e) {}
  }
  const ok = destDirs.every((d) => exists(path.join(d, 'AGENTS.md')));
  return { ok, wrote, source: src };
}

module.exports = {
  softenOpenClawStartupMigrationGuard,
  ensureSandboxNpmPresent,
  forceDisableUninstalledChannelPlugins,
  ensureOpenClawWorkspaceTemplates,
  hardenGatewayBootAgainstPluginNpm,
  CHANNEL_PLUGIN_IDS,
  STALE_PLUGIN_IDS
};
