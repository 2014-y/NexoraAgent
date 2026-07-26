'use strict';
/**
 * 网关运行时打包 / 解压共用清单（单一真相源）。
 * pack-gateway-runtime.js 与 gateway-runtime.js 必须引用同一份。
 */
const RUNTIME_PACK_ID = 'pack-d255b3e225a6';

/** 相对 gateway-runtime 根目录；缺任一即视为残缺，必须重解压 */
const ALL_RUNTIME_MARKERS = [
  // 裸机自包含关键件：便携 Node + VC++ 运行库，缺任一则打包直接失败（不给出坏包）
  ['.node-sandbox', 'node.exe'],
  ['.node-sandbox', 'vcruntime140.dll'],
  ['.node-sandbox', 'msvcp140.dll'],
  ['node_modules', 'openclaw', 'dist', 'index.js'],
  ['node_modules', '@tencent-weixin', 'openclaw-weixin', 'package.json'],
  ['node_modules', '@openclaw', 'feishu', 'package.json'],
  ['node_modules', '@openclaw', 'qqbot', 'package.json'],
  ['node_modules', '@openclaw', 'slack', 'package.json'],
  ['node_modules', '@openclaw', 'whatsapp', 'package.json'],
  ['node_modules', '@openclaw', 'matrix', 'package.json'],
  ['node_modules', '@openclaw', 'voice-call', 'package.json'],
  ['.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-cli.js'],
  ['.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-prefix.js'],
  ['node_modules', 'openclaw', 'docs', 'reference', 'templates', 'AGENTS.md']
];

// .node-sandbox（内置 Windows Node/npm）只随 Windows 包分发，mac/linux 用系统或 Electron 内置 Node
const REQUIRED_RUNTIME_MARKERS = process.platform === 'win32'
  ? ALL_RUNTIME_MARKERS
  : ALL_RUNTIME_MARKERS.filter((segs) => segs[0] !== '.node-sandbox');

/** zip 内路径（正斜杠），打包结束必须全部存在 */
const REQUIRED_ZIP_ENTRIES = REQUIRED_RUNTIME_MARKERS.map((segs) => segs.join('/'));

module.exports = {
  RUNTIME_PACK_ID,
  REQUIRED_RUNTIME_MARKERS,
  REQUIRED_ZIP_ENTRIES
};
