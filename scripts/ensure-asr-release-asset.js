/**
 * 确保发版用的离线 ASR 压缩包存在于 release-assets/asr-models/
 * - 不进 asar / 安装包层
 * - 打包完成后由 copy-asr-to-dist.js 复制到 dist/ 方便上传 Release
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'release-assets', 'asr-models');
const FILE_NAME = 'sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2';
const OUT_FILE = path.join(OUT_DIR, FILE_NAME);
const EXPECT_MIN_BYTES = 100 * 1024 * 1024; // 至少约 100MB，避免空/残包

const URLS = [
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2',
  'https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2',
  'https://mirror.ghproxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2'
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https') ? https : http;
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    const req = getter.get(url, {
      headers: { 'User-Agent': 'NexoraAgent/ensure-asr-release-asset' },
      timeout: 180000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(tmp); } catch (e) {}
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(tmp); } catch (e) {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      let received = 0;
      let lastPct = -1;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            process.stdout.write(`\r[ensure-asr] ${pct}% (${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB)`);
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          try {
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            fs.renameSync(tmp, dest);
          } catch (e) {
            return reject(e);
          }
          process.stdout.write('\n');
          resolve(dest);
        });
      });
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) {}
      try { file.close(); } catch (e) {}
      try { fs.unlinkSync(tmp); } catch (e) {}
      reject(new Error('download timeout'));
    });
    req.on('error', (err) => {
      try { file.close(); } catch (e) {}
      try { fs.unlinkSync(tmp); } catch (e) {}
      reject(err);
    });
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(OUT_FILE)) {
    const size = fs.statSync(OUT_FILE).size;
    if (size >= EXPECT_MIN_BYTES) {
      console.log(`[ensure-asr] ok (reuse): ${OUT_FILE} (${(size / 1048576).toFixed(1)} MB)`);
      return;
    }
    console.warn(`[ensure-asr] incomplete file (${size} bytes), re-download`);
    try { fs.unlinkSync(OUT_FILE); } catch (e) {}
  }

  let lastErr = null;
  for (const url of URLS) {
    try {
      console.log('[ensure-asr] downloading:', url);
      await download(url, OUT_FILE);
      const size = fs.statSync(OUT_FILE).size;
      if (size < EXPECT_MIN_BYTES) throw new Error(`file too small: ${size}`);
      console.log(`[ensure-asr] saved: ${OUT_FILE} (${(size / 1048576).toFixed(1)} MB)`);
      return;
    } catch (e) {
      lastErr = e;
      console.warn('[ensure-asr] failed:', e.message || e);
      try { fs.unlinkSync(OUT_FILE); } catch (ex) {}
      try { fs.unlinkSync(OUT_FILE + '.part'); } catch (ex) {}
    }
  }
  throw lastErr || new Error('all ASR download mirrors failed');
}

main().catch((e) => {
  console.error('[ensure-asr] ERROR:', e.message || e);
  process.exit(1);
});
