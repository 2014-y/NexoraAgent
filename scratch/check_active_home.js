const fs = require('fs');
const path = require('path');

const markers = [
  path.join(process.env.USERPROFILE || '', '.openclaw', 'home-health.json'),
  path.join(process.env.LOCALAPPDATA || '', 'NexoraAgent', '.openclaw', 'home-health.json')
];

for (const m of markers) {
  console.log('---');
  console.log('file=' + m);
  console.log('exists=' + fs.existsSync(m));
  if (fs.existsSync(m)) {
    try {
      const j = JSON.parse(fs.readFileSync(m, 'utf8'));
      console.log(JSON.stringify({
        level: j.level,
        homePath: j.homePath,
        stateDir: j.stateDir,
        message: j.message,
        checkedAt: j.checkedAt || j.ts || j.updatedAt
      }, null, 2));
    } catch (e) {
      console.log('parse_fail');
    }
  }
}

// Also peek gateway/auth from healthy Local config without printing token
const localCfg = path.join(process.env.LOCALAPPDATA || '', 'NexoraAgent', '.openclaw', 'openclaw.json');
if (fs.existsSync(localCfg)) {
  const j = JSON.parse(fs.readFileSync(localCfg, 'utf8'));
  const tok = String((j.gateway && j.gateway.auth && j.gateway.auth.token) || '');
  console.log('---local_cfg---');
  console.log('port=' + (j.gateway && j.gateway.port));
  console.log('auth.mode=' + (j.gateway && j.gateway.auth && j.gateway.auth.mode));
  console.log('token_len=' + tok.length);
  console.log('token_is_default_dev=' + (tok === 'openclaw-dev-token-998877'));
  console.log('basePath=' + (j.gateway && j.gateway.controlUi && j.gateway.controlUi.basePath));
}
process.exit(0);
