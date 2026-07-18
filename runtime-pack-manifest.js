'use strict';
/**
 * 网关运行时打包 / 解压共用清单（单一真相源）。
 * pack-gateway-runtime.js 与 gateway-runtime.js 必须引用同一份。
 */
const RUNTIME_PACK_ID = 'pack-71375d51b089';

/** 相对 gateway-runtime 根目录；缺任一即视为残缺，必须重解压 */
const REQUIRED_RUNTIME_MARKERS = [
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
  ['node_modules', 'openclaw', 'docs', 'reference', 'templates', 'AGENTS.md'],
  ['node_modules', 'openclaw', 'src', 'agents', 'templates', 'AGENTS.md']
];

/** zip 内路径（正斜杠），打包结束必须全部存在 */
const REQUIRED_ZIP_ENTRIES = REQUIRED_RUNTIME_MARKERS.map((segs) => segs.join('/'));

module.exports = {
  RUNTIME_PACK_ID,
  REQUIRED_RUNTIME_MARKERS,
  REQUIRED_ZIP_ENTRIES
};
