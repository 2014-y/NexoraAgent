const fs = require('fs');
const path = require('path');

const DEFAULT_TOKEN = 'openclaw-dev-token-998877';
const targets = [
  path.join(process.env.USERPROFILE || '', '.openclaw', 'openclaw.json'),
  path.join(process.env.LOCALAPPDATA || '', 'NexoraAgent', '.openclaw', 'openclaw.json')
];

for (const cf of targets) {
  console.log('---');
  console.log('file=' + cf);
  if (!fs.existsSync(cf)) {
    console.log('skip=missing');
    continue;
  }
  let raw = fs.readFileSync(cf, 'utf8');
  const bom = raw.charCodeAt(0) === 0xfeff ? raw.slice(0, 1) : '';
  if (bom) raw = raw.slice(1);

  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    console.log('skip=parse_fail ' + e.message);
    continue;
  }

  if (!j.gateway) j.gateway = {};
  if (!j.gateway.auth) j.gateway.auth = {};

  const beforeMode = j.gateway.auth.mode;
  const beforeLen = j.gateway.auth.token ? String(j.gateway.auth.token).length : 0;
  const beforeIsObj = j.gateway.auth.token && typeof j.gateway.auth.token === 'object';

  j.gateway.auth.mode = 'token';
  // Force plain string token (not SecretRef object) so Control UI + gateway stay in sync
  j.gateway.auth.token = DEFAULT_TOKEN;
  if (!j.gateway.controlUi) j.gateway.controlUi = {};
  j.gateway.controlUi.basePath = '/acp';

  const bak = cf + '.bak-token-' + Date.now();
  fs.copyFileSync(cf, bak);
  fs.writeFileSync(cf, bom + JSON.stringify(j, null, 2) + '\n', 'utf8');

  console.log('before_mode=' + beforeMode);
  console.log('before_token_len=' + beforeLen);
  console.log('before_token_was_object=' + beforeIsObj);
  console.log('after_token=DEFAULT_DEV');
  console.log('backup=' + path.basename(bak));
}

console.log('DONE');
process.exit(0);
