'use strict';
/**
 * 打包前把发版 ASR 压缩包解压到 builtin-asr/，供 extraResources 打进安装包，
 * 实现「语音转文字」离线开箱即用（无需首次联网下载 / 手动导入）。
 *
 * - 幂等：builtin-asr/ 里已有 .onnx + tokens.txt 就跳过。
 * - 源压缩包由 scripts/ensure-asr-release-asset.js 保证存在。
 * - builtin-asr/ 是 gitignore 的构建产物（223MB，不入库）。
 * - 用系统 tar（Win10+ 自带 bsdtar，支持 .tar.bz2），与运行时 voice-runtime 解压方式一致。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'release-assets', 'asr-models', 'sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2');
const DEST = path.join(ROOT, 'builtin-asr');

function hasValidModel(dir) {
  if (!fs.existsSync(dir)) return false;
  let onnx = false, tokens = false;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      const lower = ent.name.toLowerCase();
      if (lower.endsWith('.onnx') && !lower.endsWith('.json')) onnx = true;
      else if (lower === 'tokens.txt') tokens = true;
      if (onnx && tokens) return true;
    }
  }
  return false;
}

function main() {
  if (hasValidModel(DEST)) {
    console.log('[ensure-builtin-asr] ok (reuse): builtin-asr already has model');
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.warn('[ensure-builtin-asr] skip: missing', SRC);
    console.warn('[ensure-builtin-asr] run: node scripts/ensure-asr-release-asset.js');
    return; // 不硬失败：无内置模型时 app 仍可运行时下载/导入
  }
  fs.mkdirSync(DEST, { recursive: true });
  console.log('[ensure-builtin-asr] extracting', path.basename(SRC), '-> builtin-asr/ ...');
  execFileSync('tar', ['-xjf', SRC, '-C', DEST], { stdio: 'inherit', windowsHide: true });
  if (!hasValidModel(DEST)) {
    throw new Error('[ensure-builtin-asr] extracted but no .onnx + tokens.txt found');
  }
  console.log('[ensure-builtin-asr] done: builtin-asr populated');
}

main();
