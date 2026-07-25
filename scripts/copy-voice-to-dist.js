/**
 * 打包完成后：把发版语音相关文件复制到 dist/（与 Setup.exe 同级）
 * 不写入 asar / win-unpacked，仅方便上传 GitHub Release。
 *
 * 当前默认朗读为微软在线「云扬」，无需离线大包；
 * 本目录可放说明、试听 mp3，或以后的可选离线音色压缩包。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'release-assets', 'voice-packs');
const DIST = path.join(ROOT, 'dist');

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.warn('[copy-voice-to-dist] skip: missing', SRC_DIR);
    return;
  }
  fs.mkdirSync(DIST, { recursive: true });
  const entries = fs.readdirSync(SRC_DIR).filter((name) => {
    if (name === 'README.md' || name.startsWith('.')) return false;
    const full = path.join(SRC_DIR, name);
    return fs.statSync(full).isFile();
  });
  if (!entries.length) {
    console.warn('[copy-voice-to-dist] skip: no files in', SRC_DIR);
    return;
  }
  for (const name of entries) {
    const src = path.join(SRC_DIR, name);
    const dest = path.join(DIST, name);
    fs.copyFileSync(src, dest);
    const mb = (fs.statSync(dest).size / 1048576).toFixed(2);
    console.log(`[copy-voice-to-dist] copied -> ${dest} (${mb} MB)`);
  }
}

main();
