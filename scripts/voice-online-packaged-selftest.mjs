// 打包态验收：语音菜单默认隐藏，但从设置进入后“试听”仍能走在线云扬并正常收尾。
const PORT = Number(process.env.NEXORA_CDP_PORT || 9223);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((target) => target.type === 'page' && !/devtools/i.test(target.url));
  if (!page) throw new Error('no page');
  const ws = await connect(page.webSocketDebuggerUrl);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result || {});
      pending.delete(msg.id);
    }
  };

  const nav = await evalJs(ws, `(() => {
    const item = document.querySelector('.nav-item[data-tab="voice-view"]');
    return { exists: !!item, display: item ? getComputedStyle(item).display : '', hiddenClass: !!item?.classList.contains('is-menu-hidden') };
  })()`);
  check('语音服务菜单默认隐藏', nav.exists && nav.display === 'none' && nav.hiddenClass, JSON.stringify(nav));

  // 隐藏仅作用于侧栏入口；设置页仍可恢复显示，页面与功能不可被销毁。
  await evalJs(ws, `document.querySelector('.nav-item[data-tab="voice-view"]')?.click()`);
  await sleep(700);

  const state = await evalJs(ws, `(async () => {
    const response = await window.api.voice.getState();
    const data = response.data || {};
    const yunyang = (data.catalog || []).find((pack) => pack.id === 'edge-yunyang');
    return {
      activePackId: data.settings?.activePackId || '',
      yunyangInstalled: !!yunyang?.installed,
      yunyangOnline: !!yunyang?.online,
      buttonExists: !!document.getElementById('btn-voice-test')
    };
  })()`, true);
  check('在线云扬音色可用', state.activePackId === 'edge-yunyang' && state.yunyangInstalled && state.yunyangOnline, JSON.stringify(state));
  check('试听按钮存在', state.buttonExists);

  const preview = await evalJs(ws, `(async () => {
    await window.api.voice.stop();
    const statuses = [];
    const errors = [];
    const offStatus = window.api.voice.onStatus((value) => statuses.push(value?.status || ''));
    const offError = window.api.voice.onSpeakError((value) => errors.push(value?.error || 'unknown'));
    const started = Date.now();
    document.getElementById('btn-voice-test')?.click();
    for (let i = 0; i < 150; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (statuses.includes('speaking') && statuses.at(-1) === 'idle') break;
    }
    try { offStatus(); } catch (_) {}
    try { offError(); } catch (_) {}
    return { statuses, errors, elapsedMs: Date.now() - started, state: (await window.api.voice.getState()).data };
  })()`, true);

  check('试听进入朗读状态', preview.statuses.includes('speaking'), JSON.stringify(preview.statuses));
  check('试听完成后恢复空闲', preview.statuses.at(-1) === 'idle' && preview.state?.status === 'idle', JSON.stringify(preview.statuses));
  check('试听无合成或播放错误', preview.errors.length === 0, JSON.stringify(preview.errors));
  check('打包态使用在线云扬引擎', /云扬|Edge TTS/.test(preview.state?.engineNote || ''), preview.state?.engineNote || '');
  check('试听不是瞬时空操作', preview.elapsedMs > 1000 && preview.elapsedMs < 15000, `elapsed=${preview.elapsedMs}ms`);

  ws.close();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('ERROR', error.message);
  process.exit(2);
});
