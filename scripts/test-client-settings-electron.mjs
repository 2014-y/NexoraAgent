import assert from 'node:assert/strict';

const port = Number(process.env.NEXORA_CDP_PORT || 9444);
const mode = String(process.argv[2] || 'write');
const probeValue = String(process.env.NEXORA_SETTING_PROBE_VALUE || '');
if (!probeValue) throw new Error('NEXORA_SETTING_PROBE_VALUE is required');

const deadline = Date.now() + 30000;
let target = null;
while (Date.now() < deadline) {
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    target = list.find((item) => item.type === 'page' && /index\.html/.test(String(item.url || '')));
    if (target && target.webSocketDebuggerUrl) break;
  } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!target || !target.webSocketDebuggerUrl) throw new Error('Electron settings smoke target not ready');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result || {});
});

function send(method, params = {}, timeoutMs = 12000) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluation failed');
  return result.result && result.result.value;
}

try {
  await send('Runtime.enable');
  const readyDeadline = Date.now() + 20000;
  let diagnostic = null;
  while (Date.now() < readyDeadline) {
    try {
      diagnostic = await evaluate(`window.__nexoraClientSettingsPersistence || null`);
      if (diagnostic && diagnostic.hooked) break;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.equal(diagnostic && diagnostic.hooked, true, `settings hook must be active: ${JSON.stringify(diagnostic)}`);

  if (mode === 'write') {
    await evaluate(`localStorage.setItem('setting_persistence_probe', ${JSON.stringify(probeValue)}); true`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    console.log(JSON.stringify({ success: true, phase: 'write', hook: true }));
  } else if (mode === 'read-remove') {
    const restored = await evaluate(`localStorage.getItem('setting_persistence_probe')`);
    assert.equal(restored, probeValue, 'setting must restore from SQLite after localStorage is deleted');
    await evaluate(`localStorage.removeItem('setting_persistence_probe'); true`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const databaseValue = await evaluate(`window.api.clientSettings.bootstrap({}).values.setting_persistence_probe ?? null`);
    assert.equal(databaseValue, null, 'removing a setting must remove its SQLite row');
    console.log(JSON.stringify({ success: true, phase: 'read-remove', restored: true, removed: true }));
  } else {
    throw new Error(`unknown smoke mode: ${mode}`);
  }
} finally {
  ws.close();
}
