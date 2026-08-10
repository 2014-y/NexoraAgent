/**
 * 打包完成后：把发版 ASR 压缩包复制到 dist/（与 Setup.exe 同级）
 * 不写入 asar / win-unpacked，仅方便上传 GitHub Release。
 */
const fs = require('fs');
const path = require('path');

const { resolveBuildOutputPath } = require('./build-output-dir');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'release-assets', 'asr-models', 'sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2');
const DEST = resolveBuildOutputPath('sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2');

function main() {
  if (!fs.existsSync(SRC)) {
    console.warn('[copy-asr-to-dist] skip: missing', SRC);
    console.warn('[copy-asr-to-dist] run: node scripts/ensure-asr-release-asset.js');
    return;
  }
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.copyFileSync(SRC, DEST);
  const mb = (fs.statSync(DEST).size / 1048576).toFixed(1);
  console.log(`[copy-asr-to-dist] copied -> ${DEST} (${mb} MB)`);
}

main();
