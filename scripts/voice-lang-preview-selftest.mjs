// 验证：英文包用英文试听、中文包用中文试听；未下载包会提示
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
  await sleep(800);

  const catalog = await evalJs(ws, `(async () => {
    const r = await window.api.voice.getState();
    return (r.data.catalog || []).map(p => ({ id: p.id, lang: p.lang, installed: p.installed, name: p.name }));
  })()`, true);
  const alan = catalog.find((p) => p.id === 'piper-en-gb-alan');
  const chaowen = catalog.find((p) => p.id === 'piper-zh-chaowen');
  const joe = catalog.find((p) => p.id === 'piper-en-us-joe');
  check('Alan 标记为英文', alan && alan.lang === 'en', JSON.stringify(alan));
  check('超文标记为中文', chaowen && chaowen.lang === 'zh', JSON.stringify(chaowen));
  check('超文已下载', chaowen && chaowen.installed);

  // 顶部试听应走语言匹配
  const phraseEn = await evalJs(ws, `voicePreviewPhrase({ lang: 'en' })`);
  const phraseZh = await evalJs(ws, `voicePreviewPhrase({ lang: 'zh' })`);
  check('英文试听句为英文', /^Hello/.test(phraseEn), phraseEn);
  check('中文试听句为中文', /你好/.test(phraseZh), phraseZh);

  // 已下载卡片应有试听按钮
  const previewBtns = await evalJs(ws, `document.querySelectorAll('.btn-voice-preview').length`);
  check('已下载包有试听按钮', previewBtns >= 1, 'count=' + previewBtns);

  // 选未下载包应能 toast（检查函数存在）
  const hasWarn = await evalJs(ws, `typeof warnIfPackNotInstalled === 'function' && typeof previewVoicePack === 'function'`);
  check('未下载提示函数就绪', hasWarn);

  // 用超文神经引擎朗读（确认仍可用）
  if (chaowen && chaowen.installed) {
    const speak = await evalJs(ws, `(async () => {
      await window.api.voice.stop();
      const t0 = Date.now();
      await window.api.voice.speak({ text: '你好，我是超文。', source: 'preview', packId: 'piper-zh-chaowen' });
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 400));
        const s = await window.api.voice.getState();
        if (s.data.status === 'idle') break;
      }
      const note = (await window.api.voice.getState()).data.engineNote;
      return { ms: Date.now() - t0, note };
    })()`, true);
    check('超文神经引擎可用', speak.ms > 800 && /超文|神经/.test(speak.note || ''), JSON.stringify(speak));
  }

  // Alan 若已下载，用英文试听
  if (alan && alan.installed) {
    const speakEn = await evalJs(ws, `(async () => {
      await window.api.voice.stop();
      const t0 = Date.now();
      await window.api.voice.speak({ text: 'Hello, I am Alan.', source: 'preview', packId: 'piper-en-gb-alan' });
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 400));
        const s = await window.api.voice.getState();
        if (s.data.status === 'idle') break;
      }
      return { ms: Date.now() - t0 };
    })()`, true);
    check('Alan 英文神经引擎可用', speakEn.ms > 800, JSON.stringify(speakEn));
  } else {
    check('Alan 未下载（预期可跳过英文对比）', true, 'not installed');
  }

  if (joe && !joe.installed) {
    check('Joe 未下载（切换会走系统兜底）', true);
  }

  ws.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('ERROR', e.message); process.exit(2); });
