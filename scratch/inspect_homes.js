const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');

const candidates = [
  path.join(process.env.USERPROFILE || '', '.openclaw'),
  path.join(process.env.LOCALAPPDATA || '', 'NexoraAgent', '.openclaw'),
  path.join(process.env.APPDATA || '', 'NexoraAgent', '.openclaw'),
  path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'NexoraAgent', '.openclaw')
];

function canParse(p) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    JSON.parse(s);
    return 'OK';
  } catch (e) {
    return 'FAIL:' + e.message;
  }
}

function tcp(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const t = setTimeout(() => { s.destroy(); resolve('DOWN'); }, 1500);
    s.on('connect', () => { clearTimeout(t); s.end(); resolve('UP'); });
    s.on('error', () => { clearTimeout(t); resolve('DOWN'); });
  });
}

(async () => {
  console.log('port18789=' + (await tcp(18789)));
  for (const dir of candidates) {
    const cf = path.join(dir, 'openclaw.json');
    const log = path.join(dir, 'gateway_stdout.log');
    console.log('---');
    console.log('dir=' + dir);
    console.log('exists=' + fs.existsSync(dir));
    console.log('config=' + fs.existsSync(cf));
    if (fs.existsSync(cf)) {
      const st = fs.statSync(cf);
      console.log('config_mtime=' + st.mtime.toISOString());
      console.log('config_parse=' + canParse(cf));
    }
    console.log('log=' + fs.existsSync(log));
    if (fs.existsSync(log)) {
      const st = fs.statSync(log);
      console.log('log_mtime=' + st.mtime.toISOString());
      const tail = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-5);
      for (const line of tail) {
        console.log(line
          .replace(/token=[^&\s"]+/g, 'token=***')
          .replace(/openclaw-dev-token-\d+/g, '***')
          .replace(/[a-fA-F0-9]{32}/g, '***'));
      }
    }
  }

  console.log('---procs---');
  const ps = path.join(__dirname, 'diag_procs_only.ps1');
  fs.writeFileSync(ps, `
$ErrorActionPreference='SilentlyContinue'
try {
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object {
      $_.ExecutablePath -like '*Nexora Agent*' -or
      $_.CommandLine -like '*openclaw*' -or
      $_.ExecutablePath -like '*.node-sandbox*'
    }
  if (-not $procs) { 'NO_SANDBOX_NODE_PROCESS'; exit 0 }
  foreach ($p in @($procs)) {
    'PROC pid=' + $p.ProcessId
    'EXE_HAS_SANDBOX=' + ([string]$p.ExecutablePath -like '*.node-sandbox*')
    'CMD_HAS_GATEWAY=' + (([string]$p.CommandLine) -like '*gateway*')
  }
} catch { 'PROC_CHECK_FAIL' }
exit 0
`, 'utf8');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-File', ps], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    console.log((out || '').trim());
  } catch (e) {
    console.log('PROC_CHECK_FAIL');
  }
})().finally(() => process.exit(0));
