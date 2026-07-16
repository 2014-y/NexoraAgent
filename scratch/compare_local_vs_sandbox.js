const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { execFileSync } = require('child_process');

function tcp(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 1000);
    s.on('connect', () => { clearTimeout(t); s.end(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      resolve('status=' + res.statusCode);
      res.resume();
    });
    req.on('error', (e) => resolve('FAIL ' + e.message));
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });
  });
}

function parseConfig(cf) {
  try {
    const j = JSON.parse(fs.readFileSync(cf, 'utf8').replace(/^\uFEFF/, ''));
    const tok = String((j.gateway && j.gateway.auth && j.gateway.auth.token) || '');
    return {
      ok: true,
      port: j.gateway && j.gateway.port,
      token_len: tok.length,
      token_is_default: tok === 'openclaw-dev-token-998877',
      basePath: j.gateway && j.gateway.controlUi && j.gateway.controlUi.basePath
    };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

(async () => {
  const homes = [
    ['user_home', path.join(process.env.USERPROFILE || '', '.openclaw')],
    ['local_nexora-agent', path.join(process.env.LOCALAPPDATA || '', 'NexoraAgent', '.openclaw')]
  ];
  for (const [name, dir] of homes) {
    const cf = path.join(dir, 'openclaw.json');
    console.log('---' + name + '---');
    console.log('dir=' + dir);
    console.log('exists=' + fs.existsSync(dir));
    if (fs.existsSync(cf)) console.log(JSON.stringify(parseConfig(cf)));
  }

  for (const port of [18789, 18790, 18791, 19001]) {
    const up = await tcp(port);
    console.log('port_' + port + '=' + (up ? 'UP' : 'DOWN'));
    if (up) console.log('  acp=' + (await httpGet('http://127.0.0.1:' + port + '/acp/')));
  }

  console.log('---procs---');
  const ps = path.join(__dirname, '_cmp_procs.ps1');
  fs.writeFileSync(ps, `
$ErrorActionPreference='SilentlyContinue'
try {
  $all = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
  $hit = $all | Where-Object {
    $_.ExecutablePath -like '*Nexora Agent*' -or
    $_.ExecutablePath -like '*.node-sandbox*' -or
    $_.CommandLine -like '*openclaw*' -or
    $_.CommandLine -like '*gateway*'
  }
  if (-not $hit) { 'NO_RELATED_NODE'; exit 0 }
  foreach ($p in @($hit)) {
    $exe = [string]$p.ExecutablePath
    $cmd = [string]$p.CommandLine
    $kind = 'other'
    if ($exe -like '*.node-sandbox*') { $kind = 'sandbox' }
    elseif ($exe -like '*Nexora Agent*') { $kind = 'nexora-agent' }
    elseif ($cmd -like '*openclaw*') { $kind = 'openclaw_cli_or_global' }
    'KIND=' + $kind
    'PID=' + $p.ProcessId
    'EXE=' + $exe
    'CMD_HAS_GATEWAY=' + ($cmd -like '*gateway*')
    'CMD_PREFIX=' + $(if ($cmd.Length -gt 160) { $cmd.Substring(0,160) + '...' } else { $cmd })
    '---'
  }
} catch { 'PROC_FAIL' }
exit 0
`, 'utf8');
  try {
    console.log(execFileSync('powershell', ['-NoProfile', '-File', ps], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    }).trim());
  } catch {
    console.log('PROC_FAIL');
  }

  // where openclaw
  console.log('---where---');
  try {
    console.log(execFileSync('where.exe', ['openclaw'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    }).trim());
  } catch {
    console.log('openclaw_cmd=NOT_IN_PATH');
  }
})().finally(() => process.exit(0));
