import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const p = path.join(os.homedir(), '.openclaw', 'extensions', 'voice-bridge', 'index.js');
const s = fs.readFileSync(p, 'utf8');
console.log({
  definePluginEntry: s.includes('definePluginEntry'),
  message_sent: s.includes('message_sent'),
  agent_end: s.includes('agent_end'),
  onAfterResponse: s.includes('onAfterResponse'),
  createPlugin: s.includes('createPlugin')
});
