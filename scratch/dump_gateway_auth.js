const fs = require('fs');
const path = require('path');

const dirs = [
  path.join(process.env.USERPROFILE || '', '.openclaw'),
  path.join(process.env.LOCALAPPDATA || '', 'NexoraAgent', '.openclaw')
];

for (const dir of dirs) {
  const cf = path.join(dir, 'openclaw.json');
  console.log('=== ' + dir + ' ===');
  if (!fs.existsSync(cf)) {
    console.log('missing');
    continue;
  }
  const j = JSON.parse(fs.readFileSync(cf, 'utf8').replace(/^\uFEFF/, ''));
  const g = j.gateway || {};
  console.log(JSON.stringify({
    port: g.port,
    bind: g.bind,
    mode: g.mode,
    auth: {
      mode: g.auth && g.auth.mode,
      token_present: !!(g.auth && g.auth.token && String(g.auth.token).trim()),
      token_len: g.auth && g.auth.token ? String(g.auth.token).length : 0,
      token_is_default: g.auth && g.auth.token === 'openclaw-dev-token-998877',
      password_present: !!(g.auth && g.auth.password)
    },
    controlUi: g.controlUi || null
  }, null, 2));
}
process.exit(0);
