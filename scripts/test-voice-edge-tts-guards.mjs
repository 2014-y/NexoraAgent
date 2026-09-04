import assert from 'node:assert/strict';
import fs from 'node:fs';

const runtime = fs.readFileSync(new URL('../voice-runtime.js', import.meta.url), 'utf8');
const renderer = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');

assert.match(
  runtime,
  /const result = await tts\.toFile\(jobDir, safeText,/,
  'msedge-tts must receive an output directory rather than an mp3 file path'
);
assert.doesNotMatch(
  runtime,
  /tts\.toFile\(mp3Path,/,
  'the invalid msedge-tts file-path call must not return'
);
assert.match(
  runtime,
  /if \(result && result\.audioFilePath\) mp3Path = path\.resolve\(result\.audioFilePath\)/,
  'playback must use the actual file path returned by msedge-tts'
);
assert.match(
  runtime,
  /hint: 'online_tts_failed'/,
  'online synthesis failures must be delivered to the renderer'
);
assert.match(
  renderer,
  /err\.hint === 'online_tts_failed'/,
  'the voice page must tell the user when online preview fails'
);

console.log('voice Edge TTS guard tests passed');
