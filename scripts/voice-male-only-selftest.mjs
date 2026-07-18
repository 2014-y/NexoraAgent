const PORT = 9223;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((target) => target.type === 'page' && !/devtools/i.test(target.url));
  if (!page) throw new Error('no Electron page');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result || {});
      pending.delete(message.id);
    }
  };
  const evaluate = (expression, awaitPromise = false) => new Promise((resolve) => {
    const callId = ++id;
    pending.set(callId, (result) => resolve(result.result && result.result.value));
    ws.send(JSON.stringify({
      id: callId,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise }
    }));
  });

  await evaluate(`document.querySelector('.nav-item[data-tab="voice-view"]').click()`);
  await sleep(700);
  const result = await evaluate(`(async () => {
    const initial = await window.api.voice.getState();
    const catalog = initial.data.catalog;
    const cards = Array.from(document.querySelectorAll('#voice-pack-grid .plugin-card-item'))
      .map((card) => card.getAttribute('data-voice-id'));

    await window.api.voice.setSettings({ activePackId: 'piper-zh-xiaoya' });
    const rejectedFemale = await window.api.voice.getState();
    await window.api.voice.setSettings({ activePackId: 'piper-zh-chaowen' });

    return {
      ids: catalog.map((pack) => pack.id),
      names: catalog.map((pack) => pack.name),
      cards,
      femaleRejectedTo: rejectedFemale.data.settings.activePackId,
      active: (await window.api.voice.getState()).data.settings.activePackId,
      notice: document.querySelector('[data-i18n="voice.notice"]').textContent,
      heading: document.querySelector('[data-i18n="voice.section.packs"]').textContent
    };
  })()`, true);
  ws.close();

  const expected = [
    'piper-en-gb-alan',
    'piper-en-gb-northern-male',
    'piper-en-us-joe',
    'piper-zh-chaowen'
  ];
  const checks = [
    ['目录只含四个确认男声', JSON.stringify(result.ids) === JSON.stringify(expected), result.ids],
    ['界面只渲染四个男声', JSON.stringify(result.cards) === JSON.stringify(expected), result.cards],
    ['女声 ID 无法设为当前', result.femaleRejectedTo === 'piper-zh-chaowen', result.femaleRejectedTo],
    ['默认当前音色为超文男声', result.active === 'piper-zh-chaowen', result.active],
    ['页面明确纯男声模式', /纯男声/.test(result.notice), result.notice],
    ['分区标题明确男声', /男声/.test(result.heading), result.heading]
  ];

  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} -- ${Array.isArray(detail) ? detail.join(', ') : detail}`);
  }
  const failed = checks.filter((check) => !check[1]);
  console.log(`\n结果: ${checks.length - failed.length}/${checks.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('SELFTEST ERROR:', error.message);
  process.exit(2);
});
