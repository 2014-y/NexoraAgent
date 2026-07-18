import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const file = path.join(os.tmpdir(), 'openclaw', 'openclaw-2026-07-18.log');
const pattern = new RegExp(process.argv[2] || '.', 'i');
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
for (const line of lines) {
  try {
    const j = JSON.parse(line);
    const msg = String(j.message || '').replace(/\s+/g, ' ');
    const lvl = j._meta?.logLevelName || '?';
    if (pattern.test(msg) || pattern.test(lvl)) {
      console.log(`${j.time} [${lvl}] ${msg.slice(0, 400)}`);
    }
  } catch {}
}
