// 验证：已安装 chaowen 包 → getState 显示 installed → speak 走 sherpa（引擎提示变化 + 朗读完成）
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('ws error'));
  });
}

let msgId = 0;
const pending = new Map();
function send(ws, method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(ws, expression, awaitPromise = false) {
  const res = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return res.result && res.result.value;
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
  if (!page) throw new Error('no page');
  const ws = await connect(page.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result || {});
      pending.delete(msg.id);
    }
  };

  await evalJs(ws, `document.querySelector('.nav-item[data-tab="voice-view"]').click()`);
  await sleep(600);

  const st = await evalJs(ws, `(async () => {
    const r = await window.api.voice.getState();
    const cat = (r.data && r.data.catalog) || [];
    const chaowen = cat.find(p => p.id === 'piper-zh-chaowen');
    return {
      engineNote: r.data.engineNote,
      active: r.data.settings.activePackId,
      chaowenInstalled: !!(chaowen && chaowen.installed),
      installedCount: cat.filter(p => p.installed).length
    };
  })()`, true);
  check('超文包已识别为已下载', st.chaowenInstalled, JSON.stringify(st));

  // 启用总开关 + 桌面朗读，设为超文，试听
  const speak = await evalJs(ws, `(async () => {
    await window.api.voice.setSettings({ enabled: true, desktopSpeak: true, muted: false, activePackId: 'piper-zh-chaowen', volume: 0.8 });
    const t0 = Date.now();
    const r = await window.api.voice.speak({ text: '你好，我是超文。这是神经引擎朗读测试。', source: 'preview' });
    // 等状态回到 idle（最长 25s）
    let last = null;
    for (let i = 0; i < 50; i++) {
      await new Promise(res => setTimeout(res, 500));
      const s = await window.api.voice.getState();
      last = s.data.status;
      if (last === 'idle' || last === 'listening_wake') break;
    }
    return { speakOk: !!(r && r.success !== false), elapsedMs: Date.now() - t0, lastStatus: last, engineNote: (await window.api.voice.getState()).data.engineNote };
  })()`, true);

  check('speak API 调用成功', speak.speakOk, JSON.stringify(speak));
  check('朗读后状态恢复', speak.lastStatus === 'idle' || speak.lastStatus === 'listening_wake', 'status=' + speak.lastStatus);
  check('引擎提示为神经引擎', /sherpa|神经|已下载/.test(speak.engineNote || ''), speak.engineNote);
  // 神经合成通常 > 1.5s；SAPI 很快也可能，但至少确认完成
  check('朗读耗时合理（>1s）', speak.elapsedMs > 1000, 'elapsed=' + speak.elapsedMs + 'ms');

  ws.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('ERROR', e.message); process.exit(2); });
