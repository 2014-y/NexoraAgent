const PORT = 9223;
const expr = process.argv[2] || 'document.title';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const evalJs = (expression, awaitPromise = false) => new Promise((r) => {
  const i = ++id;
  pending.set(i, r);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
});
const m = await evalJs(expr, true);
console.log(JSON.stringify(m.result && m.result.result ? m.result.result.value : m, null, 2));
ws.close();
