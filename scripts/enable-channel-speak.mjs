const PORT = 9223;
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
  const r = await evalJs(`(async () => {
    const st = await window.api.voice.setSettings({ enabled: true, channelReplySpeak: true, muted: false });
    return st.data.settings;
  })()`, true);
  console.log(JSON.stringify(r));
  ws.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
