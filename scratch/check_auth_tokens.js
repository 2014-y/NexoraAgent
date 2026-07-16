const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

const homes = [
  path.join(process.env.USERPROFILE || '', '.openclaw'),
  path.join(process.env.LOCALAPPDATA || '', 'NexoraAgent', '.openclaw')
];

function redactToken(t) {
  const s = String(t || '');
  if (!s) return '(empty)';
  if (s === 'openclaw-dev-token-998877') return 'DEFAULT_DEV';
  return 'len=' + s.length + ' prefix=' + s.slice(0, 4) + '...';
}

for (const dir of homes) {
  const cf = path.join(dir, 'openclaw.json');
  console.log('---');
  console.log('dir=' + dir);
  if (!fs.existsSync(cf)) {
    console.log('config=MISSING');
    continue;
  }
  try {
    const j = JSON.parse(fs.readFileSync(cf, 'utf8').replace(/^\uFEFF/, ''));
    const auth = (j.gateway && j.gateway.auth) || {};
    console.log('parse=OK');
    console.log('gateway.port=' + (j.gateway && j.gateway.port));
    console.log('auth.mode=' + (auth.mode || '(missing)'));
    console.log('auth.token=' + redactToken(auth.token));
    console.log('has_token_key=' + Object.prototype.hasOwnProperty.call(auth, 'token'));
  } catch (e) {
    console.log('parse=BAD ' + e.message);
  }
  const hh = path.join(dir, 'home-health.json');
  if (fs.existsSync(hh)) {
    try {
      const h = JSON.parse(fs.readFileSync(hh, 'utf8'));
      console.log('homePath=' + h.homePath);
      console.log('home_updated=' + (h.updatedAt || h.ts || ''));
    } catch (_) {}
  }
}

function tcp(port) {
  return new Promise((r) => {
    const s = net.connect(port, '127.0.0.1');
    const t = setTimeout(() => { s.destroy(); r(false); }, 1000);
    s.on('connect', () => { clearTimeout(t); s.end(); r(true); });
    s.on('error', () => { clearTimeout(t); r(false); });
  });
}

(async () => {
  console.log('---');
  console.log('port18789=' + ((await tcp(18789)) ? 'UP' : 'DOWN'));
  // latest log lines mentioning auth token
  for (const dir of homes) {
    const log = path.join(dir, 'gateway_stdout.log');
    if (!fs.existsSync(log)) continue;
    const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => /auth token|runtime token|gateway.auth/i.test(l));
    console.log('auth_log_hits@' + dir + '=' + lines.length);
    for (const l of lines.slice(-5)) {
      console.log(l.replace(/token[=:]\s*[^\s,]+/gi, 'token=***'));
    }
  }
})().finally(() => process.exit(0));
