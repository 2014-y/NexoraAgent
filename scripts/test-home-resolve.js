'use strict';
const path = require('path');
const {
  isTempLikePath,
  detectRestrictedDesktop,
  resolveStableOpenClawHome,
  applyOpenClawHomeEnv,
  assessStorageHealth,
  buildExtremeFallbacks
} = require('../home-resolve');

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed += 1;
  console.log('OK:', msg);
}

assert(isTempLikePath('C:\\Users\\admin\\AppData\\Local\\Temp\\1') === true, 'Temp\\1 detected');
assert(isTempLikePath('C:\\Users\\admin') === false, 'real home not temp');

const homeNormal = detectRestrictedDesktop({
  SESSIONNAME: 'Console',
  TEMP: 'C:\\Users\\Yuan\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\Yuan\\AppData\\Local\\Temp',
  USERPROFILE: 'C:\\Users\\Yuan',
  LOCALAPPDATA: 'C:\\Users\\Yuan\\AppData\\Local'
});
assert(homeNormal.restricted === false, 'normal Windows TEMP is NOT restricted');

const rdpOnly = detectRestrictedDesktop({
  SESSIONNAME: 'RDP-Tcp#3',
  CLIENTNAME: 'OFFICE-PC',
  TEMP: 'C:\\Users\\Yuan\\AppData\\Local\\Temp',
  USERPROFILE: 'C:\\Users\\Yuan'
});
assert(rdpOnly.restricted === false, 'plain RDP alone is NOT restricted');

const cloud = detectRestrictedDesktop({
  SESSIONNAME: 'RDP-Tcp#3',
  CLIENTNAME: 'WUYING',
  TEMP: 'C:\\Users\\admin\\AppData\\Local\\Temp\\1',
  LOCALAPPDATA: 'C:\\Users\\admin\\AppData\\Local'
});
assert(cloud.restricted === true, 'session Temp\\1 detected as restricted');

const extreme = buildExtremeFallbacks(
  { USERNAME: 'admin', ProgramData: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public' },
  { installDir: 'C:\\Program Files\\ai-assistant' }
);
assert(extreme.some((p) => p.toLowerCase().includes('\\program files\\ai-assistant\\data')), 'portable install data candidate');
assert(extreme.some((p) => p.toLowerCase().includes('\\programdata\\nexoraagent\\admin')), 'programdata candidate');
assert(extreme.some((p) => p.toLowerCase().includes('\\users\\public\\nexoraagent\\admin')), 'public candidate');

const probe = (base) => {
  const n = String(base).toLowerCase().replace(/\//g, '\\');
  if (n.includes('blocked')) return false;
  if (n.includes('\\appdata\\local\\nexoraagent')) return false; // 模拟 AppData 也被锁
  if (n.includes('\\appdata\\roaming\\nexoraagent')) return false;
  if (isTempLikePath(base) && !n.includes('nexoraagent-home')) return false;
  // 极端：只有 ProgramData 可写
  return n.includes('\\programdata\\nexoraagent\\admin');
};

const locked = resolveStableOpenClawHome('C:\\Users\\admin\\blocked-home', {
  appPaths: {
    home: 'C:\\Users\\admin\\blocked-home',
    appData: 'C:\\Users\\admin\\AppData\\Roaming',
    userData: 'C:\\Users\\admin\\AppData\\Roaming\\ai-assistant'
  },
  env: {
    SESSIONNAME: 'RDP-Tcp#3',
    TEMP: 'C:\\Users\\admin\\AppData\\Local\\Temp\\1',
    LOCALAPPDATA: 'C:\\Users\\admin\\AppData\\Local',
    APPDATA: 'C:\\Users\\admin\\AppData\\Roaming',
    ProgramData: 'C:\\ProgramData',
    USERNAME: 'admin',
    PUBLIC: 'C:\\Users\\Public'
  },
  tmpdir: 'C:\\Users\\admin\\AppData\\Local\\Temp\\1',
  installDir: 'C:\\Program Files\\ai-assistant',
  probe
});
assert(
  String(locked.homePath).toLowerCase().replace(/\//g, '\\') === 'c:\\programdata\\nexoraagent\\admin',
  `extreme fallback to ProgramData, got ${locked.homePath}`
);
assert(locked.health && locked.health.level === 'degraded', 'extreme fallback marked degraded');

const critical = assessStorageHealth('C:\\Users\\admin\\AppData\\Local\\Temp\\1\\NexoraAgent-home', {
  probe: () => true
});
assert(critical.level === 'critical', 'temp home is critical');

const homePc = resolveStableOpenClawHome('C:\\Users\\Yuan', {
  appPaths: { home: 'C:\\Users\\Yuan' },
  env: { LOCALAPPDATA: 'C:\\Users\\Yuan\\AppData\\Local', USERNAME: 'Yuan' },
  tmpdir: 'C:\\Users\\Yuan\\AppData\\Local\\Temp',
  probe: (base) => {
    const n = String(base).toLowerCase().replace(/\//g, '\\');
    return n === 'c:\\users\\yuan' || n.includes('\\nexoraagent');
  }
});
assert(path.resolve(homePc.homePath) === path.resolve('C:\\Users\\Yuan'), 'home PC keeps real home');
assert(homePc.health.level === 'ok', 'home PC health ok');

const envBag = {};
applyOpenClawHomeEnv('C:\\Users\\admin\\AppData\\Local\\Nexora Agent', envBag);
assert(envBag.OPENCLAW_HOME && envBag.OPENCLAW_STATE_DIR, 'OPENCLAW env applied');

console.log(`\nALL ${passed} TESTS PASSED`);
