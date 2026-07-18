'use strict';
/**
 * 端到端自测：下载一个真实中文语音包 → sherpa 合成 wav → 校验文件
 * 用法: node scripts/tts-e2e-selftest.mjs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const workDir = path.join(root, '.tmp-voice-test');
const packId = 'piper-zh-chaowen';
const packDir = path.join(workDir, packId);
const archive = path.join(workDir, `${packId}.tar.bz2`);
const downloadUrl =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-chaowen-medium.tar.bz2';
const textFile = path.join(workDir, 'sample.txt');
const wavOut = path.join(workDir, 'out.wav');
const worker = path.join(root, 'tts-worker.js');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const getter = url.startsWith('https') ? https : http;
    const req = getter.get(url, { headers: { 'User-Agent': 'NexoraAgent/tts-e2e' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      let received = 0;
      let lastPct = -1;
      res.on('data', (c) => {
        received += c.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct;
            process.stdout.write(`\r下载 ${pct}%`);
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        process.stdout.write('\n');
        resolve({ received, total });
      }));
    });
    req.on('error', reject);
  });
}

function runWorker() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [
      worker,
      '--model-dir', packDir,
      '--text-file', textFile,
      '--out', wavOut,
      '--sid', '0',
      '--speed', '1.0'
    ], {
      cwd: root,
      env: { ...process.env },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(textFile, '你好，我是超文。这是 Nexora Agent 离线语音引擎自测。', 'utf8');

  const hasOnnx = (() => {
    if (!fs.existsSync(packDir)) return false;
    const stack = [packDir];
    while (stack.length) {
      const cur = stack.pop();
      for (const name of fs.readdirSync(cur)) {
        const full = path.join(cur, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (/\.onnx$/i.test(name)) return true;
      }
    }
    return false;
  })();

  if (!hasOnnx) {
    console.log('下载语音包（约 58 MB）…');
    await download(downloadUrl, archive);
    fs.mkdirSync(packDir, { recursive: true });
    console.log('解压…');
    await execFileAsync('tar', ['-xjf', archive, '-C', packDir], { windowsHide: true });
    console.log('解压完成');
  } else {
    console.log('已有本地测试包，跳过下载');
  }

  console.log('运行 sherpa 合成…');
  const r = await runWorker();
  console.log('worker exit', r.code);
  console.log('stdout:', r.stdout.trim());
  if (r.stderr) console.log('stderr:', r.stderr.slice(0, 500));

  if (r.code !== 0) {
    console.error('FAIL: worker failed');
    process.exit(1);
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {
    console.error('FAIL: bad json');
    process.exit(1);
  }
  if (!parsed.ok || !fs.existsSync(wavOut)) {
    console.error('FAIL:', parsed);
    process.exit(1);
  }
  const size = fs.statSync(wavOut).size;
  console.log(`PASS: wav ${wavOut} size=${size} sampleRate=${parsed.sampleRate}`);
  if (size < 1000) {
    console.error('FAIL: wav too small');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('SELFTEST ERROR:', e.message);
  process.exit(2);
});
