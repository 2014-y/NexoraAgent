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
async function evalJs(ws, expression) {
  const res = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true });
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
  await sleep(900);

  const ui = await evalJs(ws, `(() => {
    const roleBind = document.querySelector('.voice-role-bind-panel');
    const oldJarvis = document.getElementById('voice-pack-grid-jarvis');
    const oldZh = document.getElementById('voice-pack-grid-zh');
    const grid = document.getElementById('voice-pack-grid');
    const cards = grid ? grid.querySelectorAll('.plugin-card-item').length : 0;
    const sourceBtns = grid ? grid.querySelectorAll('.btn-voice-source').length : 0;
    const metaRows = grid ? grid.querySelectorAll('.voice-meta-row').length : 0;
    const section = document.querySelector('[data-i18n="voice.section.packs"]');
    const activeSel = document.getElementById('voice-active-pack');
    return {
      roleBindGone: !roleBind,
      oldGridsGone: !oldJarvis && !oldZh,
      singleGrid: !!grid,
      cards,
      noSourceBtns: sourceBtns === 0,
      noMetaRows: metaRows === 0,
      sectionText: section ? section.textContent.trim() : '',
      hasActiveSelect: !!activeSel && activeSel.options.length > 0
    };
  })()`);

  check('角色绑定面板已移除', ui.roleBindGone);
  check('旧双分组已移除', ui.oldGridsGone);
  check('统一语音包列表存在', ui.singleGrid && ui.cards >= 5, 'cards=' + ui.cards);
  check('卡片无「打开来源」按钮', ui.noSourceBtns);
  check('卡片无引擎/许可杂项', ui.noMetaRows);
  check('分区标题为全局共用', /全局|全域|global/i.test(ui.sectionText), ui.sectionText);
  check('顶部当前音色下拉可用', ui.hasActiveSelect);

  ws.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('ERROR', e.message); process.exit(2); });
