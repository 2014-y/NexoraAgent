import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const logFile = path.join(os.tmpdir(), 'openclaw', 'openclaw-2026-07-18.log');
const deadline = Date.now() + 90000;

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

while (Date.now() < deadline) {
  try {
    const st = await fetch('http://127.0.0.1:18791/voice/status');
    if (st.ok) {
      const j = await st.json();
      if (j.settings && j.settings.enabled && j.settings.channelReplySpeak) {
        console.log('VOICE_HTTP_READY');
        break;
      }
    }
  } catch {}
  await sleep(1000);
}

// ensure settings
try {
  // via CDP if available
} catch {}

let found = false;
for (let i = 0; i < 30 && !found; i++) {
  try {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-80);
    for (const line of lines) {
      if (line.includes('[voice-bridge] loaded')) {
        console.log('PLUGIN_LOADED_LOG');
        found = true;
        break;
      }
    }
  } catch {}
  await sleep(1000);
}

if (!found) console.log('PLUGIN_LOADED_LOG_MISSING');
process.exit(0);
