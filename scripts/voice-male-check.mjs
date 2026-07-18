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
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async (expression, awaitPromise = false) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    return res.result && res.result.value;
  };
  await evalJs(`document.querySelector('.nav-item[data-tab="voice-view"]').click()`);
  await sleep(600);
  const r = await evalJs(`(async () => {
    await window.api.voice.setSettings({ activePackId: 'piper-zh-chaowen', enabled: true, muted: false, desktopSpeak: true });
    await window.api.voice.speak({ text: '你好，我是超文男声。', source: 'preview', packId: 'piper-zh-chaowen' });
    for (let i = 0; i < 30; i++) {
      await new Promise((x) => setTimeout(x, 400));
      const s = await window.api.voice.getState();
      if (s.data.status === 'idle') break;
    }
    const st = await window.api.voice.getState();
    return {
      note: st.data.engineNote,
      active: st.data.settings.activePackId,
      installed: st.data.catalog.filter((p) => p.installed).map((p) => p.id)
    };
  })()`, true);
  console.log(JSON.stringify(r, null, 2));
  ws.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
