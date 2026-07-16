'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  DEFAULT_GATEWAY_TOKEN,
  normalizeGatewayAuthConfig,
  buildControlUiUrl,
  syncGatewayAuthToStateDirs,
  buildGatewayChildEnv
} = require('../gateway-auth');
const {
  detectCloudishEnv,
  resolveLockedOpenClawHome,
  isSessionTempPath,
  isTempLikePath
} = require('../openclaw-state');
const { detectRestrictedDesktop } = require('../home-resolve');

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed += 1;
  console.log('OK:', msg);
}

// --- auth normalize ---
{
  const a = normalizeGatewayAuthConfig({}, DEFAULT_GATEWAY_TOKEN);
  assert(a.changed === true, 'empty config needs auth');
  assert(a.token === DEFAULT_GATEWAY_TOKEN, 'default token applied');
  assert(a.config.gateway.controlUi.basePath === '/acp', 'basePath /acp');
  assert(a.config.gateway.port === 18789, 'default port');
}

{
  const a = normalizeGatewayAuthConfig({
    gateway: { auth: { mode: 'token', token: { source: 'env', id: 'X' } } }
  });
  assert(a.token === DEFAULT_GATEWAY_TOKEN, 'SecretRef object rejected');
}

{
  const a = normalizeGatewayAuthConfig({
    gateway: { auth: { mode: 'token', token: 'my-real-token-123456' }, port: 18789 }
  });
  assert(a.changed === true || a.config.gateway.controlUi.basePath === '/acp', 'fills controlUi');
  assert(a.token === 'my-real-token-123456', 'keeps real token');
}

assert(
  buildControlUiUrl(18789, DEFAULT_GATEWAY_TOKEN).includes('token=' + encodeURIComponent(DEFAULT_GATEWAY_TOKEN)),
  'dashboard url embeds token'
);

// --- child env lock ---
{
  const env = buildGatewayChildEnv({ FOO: '1' }, {
    homePath: 'C:\\Users\\NewPC',
    stateDir: 'C:\\Users\\NewPC\\.openclaw',
    token: DEFAULT_GATEWAY_TOKEN
  });
  assert(env.OPENCLAW_HOME === 'C:\\Users\\NewPC', 'child OPENCLAW_HOME locked');
  assert(env.OPENCLAW_STATE_DIR === 'C:\\Users\\NewPC\\.openclaw', 'child STATE_DIR locked');
  assert(env.OPENCLAW_GATEWAY_TOKEN === DEFAULT_GATEWAY_TOKEN, 'child env token set');
  assert(env.USERPROFILE === 'C:\\Users\\NewPC', 'child USERPROFILE locked');
}

// --- zero-env: normal TEMP must NOT be cloudish ---
{
  const normal = {
    USERPROFILE: 'C:\\Users\\NewPC',
    HOME: 'C:\\Users\\NewPC',
    REAL_USER_HOME: 'C:\\Users\\NewPC',
    TEMP: 'C:\\Users\\NewPC\\AppData\\Local\\Temp',
    TMP: 'C:\\Users\\NewPC\\AppData\\Local\\Temp',
    LOCALAPPDATA: 'C:\\Users\\NewPC\\AppData\\Local',
    OPENCLAW_HOME: 'C:\\Users\\NewPC',
    OPENCLAW_STATE_DIR: 'C:\\Users\\NewPC\\.openclaw',
    SESSIONNAME: 'Console'
  };
  assert(detectCloudishEnv(normal) === false, 'normal Windows TEMP not cloudish');
  assert(detectRestrictedDesktop(normal).restricted === false, 'home-resolve agrees not restricted');
  assert(isTempLikePath(normal.TEMP) === true, 'TEMP itself is temp-like path');
  assert(isSessionTempPath(normal.TEMP) === false, 'normal TEMP is not session temp');

  const locked = resolveLockedOpenClawHome(normal, { canWrite: () => true });
  assert(
    path.resolve(locked).toLowerCase() === path.resolve('C:\\Users\\NewPC').toLowerCase(),
    `preset OPENCLAW_HOME wins, got ${locked}`
  );
}

// --- RDP alone must NOT force AppData\Nexora Agent ---
{
  const rdp = {
    USERPROFILE: 'C:\\Users\\NewPC',
    REAL_USER_HOME: 'C:\\Users\\NewPC',
    TEMP: 'C:\\Users\\NewPC\\AppData\\Local\\Temp',
    SESSIONNAME: 'RDP-Tcp#0',
    CLIENTNAME: 'LAPTOP',
    OPENCLAW_HOME: 'C:\\Users\\NewPC'
  };
  assert(detectCloudishEnv(rdp) === false, 'RDP alone not cloudish');
  const locked = resolveLockedOpenClawHome(rdp, { canWrite: () => true });
  assert(path.resolve(locked).toLowerCase() === 'c:\\users\\newpc', 'RDP keeps preset home');
}

// --- session Temp\\1 IS cloudish ---
{
  const session = {
    USERPROFILE: 'C:\\Users\\admin\\AppData\\Local\\Temp\\1',
    REAL_USER_HOME: 'C:\\Users\\admin\\AppData\\Local\\Temp\\1',
    TEMP: 'C:\\Users\\admin\\AppData\\Local\\Temp\\1',
    LOCALAPPDATA: 'C:\\Users\\admin\\AppData\\Local'
  };
  assert(detectCloudishEnv(session) === true, 'session Temp\\1 is cloudish');
}

// --- sync auth across dirs ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-agent-auth-sync-'));
  const d1 = path.join(root, 'a', '.openclaw');
  const d2 = path.join(root, 'b', '.openclaw');
  fs.mkdirSync(d1, { recursive: true });
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d1, 'openclaw.json'), JSON.stringify({
    gateway: { port: 18789, auth: { mode: 'token', token: 'old-token-aaaaaaaaaaaa' } },
    plugins: { allow: ['x'] }
  }, null, 2));
  fs.writeFileSync(path.join(d2, 'openclaw.json'), JSON.stringify({
    gateway: { auth: {} },
    keep: true
  }, null, 2));

  const synced = syncGatewayAuthToStateDirs([d1, d2], {
    token: DEFAULT_GATEWAY_TOKEN,
    mode: 'token',
    port: 18789
  });
  assert(synced.length === 2, 'both dirs synced');

  const j1 = JSON.parse(fs.readFileSync(path.join(d1, 'openclaw.json'), 'utf8'));
  const j2 = JSON.parse(fs.readFileSync(path.join(d2, 'openclaw.json'), 'utf8'));
  assert(j1.gateway.auth.token === DEFAULT_GATEWAY_TOKEN, 'd1 token updated');
  assert(j1.plugins.allow[0] === 'x', 'd1 plugins preserved');
  assert(j2.gateway.auth.token === DEFAULT_GATEWAY_TOKEN, 'd2 token filled');
  assert(j2.keep === true, 'd2 other keys preserved');

  // cleanup
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
}

console.log(`\nALL ${passed} TESTS PASSED`);
