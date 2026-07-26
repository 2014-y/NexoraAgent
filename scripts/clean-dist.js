'use strict';
/**
 * 每次打包前清理旧的安装包/构建产物，保证 dist 里只留本次新打的包。
 * - 清理 dist / dist_release / dist2 下的：安装包(.exe)、blockmap、latest.yml、win-unpacked、以及随包资源(.tar.bz2 / voice-packs)
 * - 对被占用（如 Windows Defender 正在扫 app.asar）删不掉的文件容错跳过、不中断构建
 * 由 preapp:dist 在打包前自动调用。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIRS = ['dist', 'dist_release', 'dist2'];

function rmrf(target) {
  let st;
  try { st = fs.lstatSync(target); } catch (e) { return true; } // 不存在 = 已清理
  try {
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(target)) rmrf(path.join(target, name));
      try { fs.rmdirSync(target); } catch (e) { return false; }
    } else {
      try { fs.unlinkSync(target); } catch (e) { return false; }
    }
    return true;
  } catch (e) { return false; }
}

let cleaned = 0, skipped = 0;
for (const d of OUT_DIRS) {
  const full = path.join(ROOT, d);
  if (!fs.existsSync(full)) continue;
  const ok = rmrf(full);
  if (ok) { cleaned++; console.log('[clean-dist] removed ' + d + '/'); }
  else { skipped++; console.warn('[clean-dist] ' + d + '/ partially locked (probably antivirus scanning app.asar); leftovers skipped, build continues'); }
}
if (!cleaned && !skipped) console.log('[clean-dist] nothing to clean');
