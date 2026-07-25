/**
 * 确保发版用的语音资源在 release-assets/voice-packs/
 * - 默认：生成云扬在线 TTS 试听 mp3 + 说明（应用内朗读走在线，无需离线大包）
 * - 不进 asar / 安装包层；打包后由 copy-voice-to-dist.js 复制到 dist/
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'release-assets', 'voice-packs');
const DEMO_MP3 = path.join(OUT_DIR, 'yunyang-edge-tts-demo.mp3');
const NOTE_TXT = path.join(OUT_DIR, '云扬在线TTS说明.txt');
const EXPECT_MIN_BYTES = 8 * 1024;

function writeNote() {
  const body = [
    'Nexora Agent 朗读音色：微软 Edge 在线「云扬」神经男声（zh-CN-YunyangNeural）',
    '',
    '特点：',
    '- 更自然、有语气；需联网',
    '- 应用内默认使用，无需下载离线语音大包',
    '',
    '本目录文件会在 npm run app:dist 之后复制到 dist/，方便随安装包一起上传 GitHub Release。',
    'yunyang-edge-tts-demo.mp3 为发版试听样例。',
    ''
  ].join('\r\n');
  fs.writeFileSync(NOTE_TXT, body, 'utf8');
}

function synthDemo() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(DEMO_MP3) && fs.statSync(DEMO_MP3).size >= EXPECT_MIN_BYTES) {
      console.log('[ensure-voice] ok (reuse demo):', DEMO_MP3);
      return resolve(true);
    }
    const text =
      '你好，我是云扬。这是 Nexora Agent 的在线神经朗读音色，听感更自然。';
    const textFile = path.join(OUT_DIR, '.demo-text.txt');
    fs.writeFileSync(textFile, text, 'utf8');
    const args = [
      '-m', 'edge_tts',
      '--voice', 'zh-CN-YunyangNeural',
      '--rate', '+0%',
      '--file', textFile,
      '--write-media', DEMO_MP3
    ];
    console.log('[ensure-voice] synthesizing Yunyang demo via python edge_tts…');
    const proc = spawn('python', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => {
      try { fs.unlinkSync(textFile); } catch (ex) {}
      reject(e);
    });
    proc.on('close', (code) => {
      try { fs.unlinkSync(textFile); } catch (ex) {}
      if (code === 0 && fs.existsSync(DEMO_MP3) && fs.statSync(DEMO_MP3).size >= EXPECT_MIN_BYTES) {
        console.log('[ensure-voice] saved:', DEMO_MP3, `(${(fs.statSync(DEMO_MP3).size / 1024).toFixed(1)} KB)`);
        return resolve(true);
      }
      reject(new Error(err.slice(0, 400) || 'edge_tts demo failed'));
    });
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  writeNote();
  console.log('[ensure-voice] wrote note:', NOTE_TXT);
  try {
    await synthDemo();
  } catch (e) {
    console.warn('[ensure-voice] demo synth skipped:', e.message || e);
    console.warn('[ensure-voice] 仍会复制说明文件到 dist；试听 mp3 可稍后手动生成');
  }
}

main().catch((e) => {
  console.error('[ensure-voice] ERROR:', e.message || e);
  process.exit(1);
});
