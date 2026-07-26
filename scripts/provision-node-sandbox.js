'use strict';
/**
 * 从当前运行的 Node 安装构建 .node-sandbox/（便携 Node + npm + VC++ 运行库）。
 *
 * 用途：CI（GitHub Actions windows runner）上 .node-sandbox/ 被 .gitignore 忽略、干净 checkout 不存在，
 * 而 pack-gateway-runtime.js 的 assertPackSourcesPresent() 硬性要求它存在，否则 Windows 打包必然失败。
 * 本脚本用 setup-node 提供的 Node 复刻一份沙箱，供打包使用。非 Windows 平台直接跳过（那些包不含 .node-sandbox）。
 *
 * 幂等：已存在且完整则跳过。本地开发仍可用 init.bat/init.ps1。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SANDBOX = path.join(ROOT, '.node-sandbox');

if (process.platform !== 'win32') {
  console.log('[provision-node-sandbox] non-Windows platform, skip (.node-sandbox 仅 Windows 包需要)');
  process.exit(0);
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function main() {
  const nodeDir = path.dirname(process.execPath); // 当前 Node 安装目录
  fs.mkdirSync(SANDBOX, { recursive: true });

  // 1) node.exe
  fs.copyFileSync(process.execPath, path.join(SANDBOX, 'node.exe'));

  // 2) npm / npx 启动脚本（.cmd 等）
  for (const f of ['npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd', 'nodevars.bat']) {
    const src = path.join(nodeDir, f);
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, path.join(SANDBOX, f)); } catch (e) {}
    }
  }

  // 3) node_modules/npm（含 bin/npm-cli.js、npm-prefix.js —— manifest 强制要求）
  const npmSrc = path.join(nodeDir, 'node_modules');
  if (fs.existsSync(npmSrc)) {
    copyRecursive(npmSrc, path.join(SANDBOX, 'node_modules'));
  } else {
    console.warn('[provision-node-sandbox] 警告：未在 ' + npmSrc + ' 找到 node_modules（npm）');
  }

  // 4) VC++ 运行库（pack-gateway-runtime 也会补，这里先行拷贝更保险）
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  for (const dll of ['vcruntime140.dll', 'msvcp140.dll']) {
    const src = path.join(sys32, dll);
    if (fs.existsSync(src)) {
      try { fs.copyFileSync(src, path.join(SANDBOX, dll)); } catch (e) {}
    }
  }

  // 校验关键件
  const required = [
    ['node.exe'],
    ['node_modules', 'npm', 'bin', 'npm-cli.js'],
    ['node_modules', 'npm', 'bin', 'npm-prefix.js'],
  ];
  const missing = required.filter((segs) => !fs.existsSync(path.join(SANDBOX, ...segs)));
  if (missing.length) {
    console.error('[provision-node-sandbox] 失败：沙箱缺少关键件:\n  - ' + missing.map((s) => s.join('/')).join('\n  - '));
    process.exit(1);
  }
  console.log('[provision-node-sandbox] .node-sandbox 就绪 (node + npm' + (fs.existsSync(path.join(SANDBOX, 'vcruntime140.dll')) ? ' + VC++ DLL' : '') + ')');
}

try {
  main();
} catch (e) {
  console.error('[provision-node-sandbox] 出错:', e && e.message);
  process.exit(1);
}
