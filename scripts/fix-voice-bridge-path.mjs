import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
if (!cfg.plugins) cfg.plugins = {};
if (!cfg.plugins.load) cfg.plugins.load = {};
if (!Array.isArray(cfg.plugins.load.paths)) cfg.plugins.load.paths = [];
if (!cfg.plugins.entries) cfg.plugins.entries = {};
if (!Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = [];

const must = ['voice-bridge', 'role-manager'];
for (const name of must) {
  const abs = path.resolve(path.join(os.homedir(), '.openclaw', 'extensions', name));
  if (!fs.existsSync(path.join(abs, 'index.js'))) {
    console.log('missing', abs);
    continue;
  }
  if (!cfg.plugins.load.paths.some((p) => path.resolve(String(p)) === abs)) {
    cfg.plugins.load.paths.push(abs);
    console.log('added path', abs);
  }
  cfg.plugins.entries[name] = { ...(cfg.plugins.entries[name] || {}), enabled: true };
  if (!cfg.plugins.allow.includes(name)) cfg.plugins.allow.push(name);
}

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
console.log('saved');
console.log('has voice-bridge', cfg.plugins.load.paths.some((p) => String(p).includes('voice-bridge')));
console.log('has role-manager', cfg.plugins.load.paths.some((p) => String(p).includes('role-manager')));
