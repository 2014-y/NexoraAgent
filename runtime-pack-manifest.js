'use strict';
/**
 * 网关运行时打包 / 解压共用清单（单一真相源）。
 * pack-gateway-runtime.js 与 gateway-runtime.js 必须引用同一份。
 */
const RUNTIME_PACK_ID = 'pack-332f86754f92';

/** 相对 gateway-runtime 根目录；缺任一即视为残缺，必须重解压 */
const ALL_RUNTIME_MARKERS = [
  // 裸机自包含关键件：便携 Node + VC++ 运行库，缺任一则打包直接失败（不给出坏包）
  ['.node-sandbox', 'node.exe'],
  ['.node-sandbox', 'vcruntime140.dll'],
  ['.node-sandbox', 'msvcp140.dll'],
  ['node_modules', 'openclaw', 'dist', 'index.js'],
  ['node_modules', 'openclaw', 'openclaw.mjs'],
  ['node_modules', '@tencent-weixin', 'openclaw-weixin', 'package.json'],
  ['node_modules', '@openclaw', 'feishu', 'package.json'],
  ['node_modules', '@openclaw', 'feishu', 'dist', 'index.js'],
  ['node_modules', '@openclaw', 'feishu', 'dist', 'setup-entry.js'],
  ['node_modules', '@tencent-connect', 'openclaw-qqbot', 'package.json'],
  ['node_modules', '@tencent-connect', 'openclaw-qqbot', 'preload.cjs'],
  ['node_modules', '@openclaw', 'slack', 'package.json'],
  ['node_modules', '@openclaw', 'whatsapp', 'package.json'],
  ['node_modules', '@openclaw', 'matrix', 'package.json'],
  ['node_modules', '@openclaw', 'voice-call', 'package.json'],
  ['.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-cli.js'],
  ['.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-prefix.js'],
  ['node_modules', 'openclaw', 'docs', 'reference', 'templates', 'AGENTS.md']
];

// Mac packages include native Node/npm too; Linux keeps its existing behavior.
function requiredRuntimeMarkers(platform = process.platform) {
  const common = ALL_RUNTIME_MARKERS.filter(segs => segs[0] !== '.node-sandbox');
  if (platform === 'win32') return ALL_RUNTIME_MARKERS;
  if (platform === 'darwin') return [
    ...common,
    ['.node-sandbox', 'node'],
    ['.node-sandbox', 'npm'],
    ['.node-sandbox', 'npx'],
    ['.node-sandbox', 'runtime-platform.json'],
    ['.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-cli.js'],
    ['.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-prefix.js']
  ];
  return common;
}
const REQUIRED_RUNTIME_MARKERS = requiredRuntimeMarkers();

/** zip 内路径（正斜杠），打包结束必须全部存在 */
const REQUIRED_ZIP_ENTRIES = REQUIRED_RUNTIME_MARKERS.map((segs) => segs.join('/'));

module.exports = {
  RUNTIME_PACK_ID,
  requiredRuntimeMarkers,
  REQUIRED_RUNTIME_MARKERS,
  REQUIRED_ZIP_ENTRIES
};
