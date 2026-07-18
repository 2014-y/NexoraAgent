import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const file = path.join(os.tmpdir(), 'openclaw', 'openclaw-2026-07-18.log');
const n = Number(process.argv[2] || 60);
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
for (const line of lines.slice(-n)) {
  try {
    const j = JSON.parse(line);
    const msg = String(j.message || '').replace(/\s+/g, ' ').slice(0, 240);
    console.log(`${j.time} [${j._meta?.logLevelName || '?'}] ${msg}`);
  } catch {
    console.log(line.slice(0, 240));
  }
}
