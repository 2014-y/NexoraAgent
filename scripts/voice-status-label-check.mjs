const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || {}); pending.delete(m.id); }
  };
  const evalJs = (expression, awaitPromise = false) => new Promise((r) => {
    const i = ++id; pending.set(i, (res) => r(res.result && res.result.value));
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
  });
  await evalJs(`document.querySelector('.nav-item[data-tab="voice-view"]').click()`);
  await sleep(700);
  const r = await evalJs(`(async () => {
    await window.api.voice.setSettings({ enabled: true });
    await new Promise(x => setTimeout(x, 300));
    const onText = document.getElementById('voice-status-text').textContent;
    await window.api.voice.setSettings({ enabled: false });
    await new Promise(x => setTimeout(x, 300));
    const offText = document.getElementById('voice-status-text').textContent;
    await window.api.voice.setSettings({ enabled: true });
    return { onText, offText };
  })()`, true);
  console.log(JSON.stringify(r));
  const ok = /就绪/.test(r.onText) && /未启用/.test(r.offText);
  console.log(ok ? 'PASS' : 'FAIL');
  ws.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
