const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFileSync } = require('child_process');

function redact(line) {
  return String(line)
    .replace(/token=[^&\s"]+/g, 'token=***')
    .replace(/openclaw-dev-token-\d+/g, '***')
    .replace(/[a-fA-F0-9]{32}/g, '***');
}

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let len = 0;
      res.on('data', (c) => { len += c.length; });
      res.on('end', () => resolve(`status=${res.statusCode} len=${len}`));
    });
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });
    req.on('error', (e) => resolve('FAIL=' + e.message));
  });
}

function tcpProbe(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('TIMEOUT');
    }, timeoutMs);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve('OK');
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      resolve('FAIL ' + e.message);
    });
  });
}

async function main() {
  console.log('---tcp---');
  console.log('127.0.0.1:18789=' + (await tcpProbe('127.0.0.1', 18789)));

  console.log('---http---');
  console.log('ACP=' + (await httpGet('http://127.0.0.1:18789/acp/')));
  console.log('ROOT=' + (await httpGet('http://127.0.0.1:18789/')));

  console.log('---config---');
  const cf = path.join(process.env.USERPROFILE || '', '.openclaw', 'openclaw.json');
  if (fs.existsSync(cf)) {
    const j = JSON.parse(fs.readFileSync(cf, 'utf8').replace(/^\uFEFF/, ''));
    const tok = String((j.gateway && j.gateway.auth && j.gateway.auth.token) || '');
    console.log('port=' + (j.gateway && j.gateway.port));
    console.log('auth.mode=' + (j.gateway && j.gateway.auth && j.gateway.auth.mode));
    console.log('token_len=' + tok.length);
    console.log('token_is_default_dev=' + (tok === 'openclaw-dev-token-998877'));
    console.log('basePath=' + (j.gateway && j.gateway.controlUi && j.gateway.controlUi.basePath));
    console.log('bind=' + (j.gateway && j.gateway.bind));
  } else {
    console.log('NO_CONFIG');
  }

  console.log('---procs---');
  const psScript = path.join(__dirname, 'diag_procs_only.ps1');
  fs.writeFileSync(psScript, `
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
    $cmd = [string]$p.CommandLine
    $short = if ($cmd.Length -gt 140) { $cmd.Substring(0,140) + '...' } else { $cmd }
    'PROC pid=' + $p.ProcessId
    'EXE_HAS_SANDBOX=' + ([string]$p.ExecutablePath -like '*.node-sandbox*')
    'CMD_HAS_GATEWAY=' + ($cmd -like '*gateway*')
    'CMD_PREFIX=' + $short
    '---'
  }
} catch {}
exit 0
`, 'utf8');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-File', psScript], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    console.log((out || '').trim() || 'NO_SANDBOX_NODE_PROCESS');
  } catch (e) {
    console.log('PROC_CHECK_FAIL=' + e.message);
  }

  console.log('---log---');
  const log = path.join(process.env.USERPROFILE || '', '.openclaw', 'gateway_stdout.log');
  if (fs.existsSync(log)) {
    const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).slice(-40);
    for (const line of lines) console.log(redact(line));
  } else {
    console.log('NO_LOG');
  }
}

main().catch((e) => {
  console.log('ERR=' + e.message);
}).finally(() => process.exit(0));
