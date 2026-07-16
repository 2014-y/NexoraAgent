'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  isPluginPathStaleOnThisMachine,
  looksLikeOfficialOpenClawChannelPath,
  sanitizePluginPathsForThisMachine
} = require('../plugin-adapt');
const { isForeignUserPath, detectRestrictedDesktop } = require('../home-resolve');

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  passed += 1;
  console.log('OK:', msg);
}

assert(looksLikeOfficialOpenClawChannelPath('C:\\x\\node_modules\\@openclaw\\feishu') === true, 'feishu official path');
assert(looksLikeOfficialOpenClawChannelPath('C:\\x\\node_modules\\@tencent-weixin\\openclaw-weixin') === false, 'weixin not official openclaw path');

assert(
  isForeignUserPath('C:\\Users\\Yuan\\.openclaw\\npm\\x', { USERNAME: 'admin', USERPROFILE: 'C:\\Users\\admin' }) === true,
  'foreign Yuan path on admin machine'
);
assert(
  isForeignUserPath('C:\\Users\\admin\\.openclaw\\npm\\x', { USERNAME: 'admin', USERPROFILE: 'C:\\Users\\admin' }) === false,
  'same-user path ok'
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-agent-adapt-'));
const realFile = path.join(tmp, 'keep-me');
fs.writeFileSync(realFile, '1');

assert(
  isPluginPathStaleOnThisMachine('C:\\Users\\OtherDev\\Desktop\\Nexora Agent\\node_modules\\@openclaw\\feishu', {
    userProfile: 'C:\\Users\\admin',
    configDir: 'C:\\Users\\admin\\AppData\\Local\\NexoraAgent\\.openclaw',
    appRoot: 'C:\\Program Files\\Nexora Agent\\resources\\app',
    isForeignUserPath
  }) === true,
  'other user desktop path is stale'
);

assert(
  isPluginPathStaleOnThisMachine(path.join(tmp, 'missing-dir'), {
    userProfile: tmp,
    configDir: path.join(tmp, '.openclaw'),
    appRoot: tmp,
    isForeignUserPath
  }) === true,
  'missing path is stale'
);

assert(
  isPluginPathStaleOnThisMachine(realFile, {
    userProfile: tmp,
    configDir: path.join(tmp, '.openclaw'),
    appRoot: tmp,
    isForeignUserPath
  }) === false,
  'existing path under current profile is ok'
);

const cfg = {
  plugins: {
    load: {
      paths: [
        'C:\\Users\\Yuan\\Desktop\\NexoraAgent\\NexoraAgent\\node_modules\\@openclaw\\feishu',
        'C:\\Users\\Yuan\\Desktop\\old\\openclaw-weixin',
        realFile
      ]
    },
    installs: {
      feishu: { installPath: 'C:\\Users\\Yuan\\.openclaw\\npm\\projects\\x\\node_modules\\@openclaw\\feishu' },
      qqbot: { installPath: realFile }
    }
  }
};

const out = sanitizePluginPathsForThisMachine(cfg, {
  userProfile: tmp,
  configDir: path.join(tmp, '.openclaw'),
  appRoot: tmp,
  // 仅把「明确的别的用户家目录」当 foreign，避免 Temp 探测路径误伤
  isForeignUserPath: (p) => /\\Users\\Yuan\\Desktop\\/i.test(String(p)) || /\\Users\\Yuan\\.openclaw\\/i.test(String(p))
});
assert(out.changed === true, 'sanitize changed config');
assert(!out.config.plugins.load.paths.some((p) => String(p).includes('@openclaw\\feishu')), 'official feishu removed from load.paths');
assert(!out.config.plugins.installs.feishu, 'foreign install dropped');
assert(out.config.plugins.installs.qqbot, 'local install kept');
assert(out.config.plugins.load.paths.includes(realFile), 'valid local path kept');

const cloud = detectRestrictedDesktop({
  SESSIONNAME: 'RDP-Tcp#1',
  CLIENTNAME: 'ThinClient',
  USERNAME: 'admin',
  TEMP: 'C:\\Users\\admin\\AppData\\Local\\Temp\\3'
});
assert(cloud.restricted === true, 'generic cloud/RDP restricted');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log(`\nALL ${passed} TESTS PASSED`);
