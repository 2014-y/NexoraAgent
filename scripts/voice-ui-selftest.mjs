// 语音管理页 UI 自测：通过 CDP 连接运行中的 Electron 渲染进程
// 验证：1) 无重绘死循环 2) 页面可滚动且滚动不被重置 3) 下拉切换音色生效 4) 设为当前按钮生效
const PORT = 9223;

function connect(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.onopen = () => resolve(ws);
        ws.onerror = (e) => reject(new Error('ws error'));
    });
}

let msgId = 0;
const pending = new Map();

function send(ws, method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function evalJs(ws, expression, awaitPromise = false) {
    const res = await send(ws, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise
    });
    if (res.exceptionDetails) {
        throw new Error('JS exception: ' + JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails.text));
    }
    return res.result && res.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
    if (!page) throw new Error('未找到应用页面。targets: ' + list.map((t) => `${t.type}:${t.url}`).join(', '));
    console.log('[连接]', page.title, page.url);

    const ws = await connect(page.webSocketDebuggerUrl);
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id).resolve(msg.result || {});
            pending.delete(msg.id);
        }
    };

    const results = [];
    const check = (name, ok, detail = '') => {
        results.push({ name, ok, detail });
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
    };

    // 0. 切换到语音管理页
    const switched = await evalJs(ws, `(() => {
        const nav = document.querySelector('.nav-item[data-tab="voice-view"]');
        if (nav) { nav.click(); }
        const pane = document.getElementById('voice-view');
        return { navFound: !!nav, active: pane ? pane.classList.contains('active') : false };
    })()`);
    await sleep(800);
    const active = await evalJs(ws, `document.getElementById('voice-view').classList.contains('active')`);
    check('切换到语音管理页', switched.navFound && active, JSON.stringify(switched));

    // 1. 重绘循环检测：观察 5 秒内 voice-view 的 DOM 变更次数
    await evalJs(ws, `(() => {
        window.__vtMutations = 0;
        if (window.__vtObserver) window.__vtObserver.disconnect();
        window.__vtObserver = new MutationObserver((muts) => { window.__vtMutations += muts.length; });
        window.__vtObserver.observe(document.getElementById('voice-view'), { childList: true, subtree: true, attributes: true });
        return true;
    })()`);
    await sleep(5000);
    const mutations = await evalJs(ws, `window.__vtMutations`);
    check('静置 5 秒无重绘循环', mutations <= 5, `DOM 变更 ${mutations} 次（此前死循环时每秒上百次）`);

    // 2. 滚动测试：滚到中部，等 2 秒看是否被重置
    const scrollInfo = await evalJs(ws, `(() => {
        const v = document.getElementById('voice-view');
        v.scrollTop = 400;
        return { scrollHeight: v.scrollHeight, clientHeight: v.clientHeight, scrollTop: v.scrollTop };
    })()`);
    await sleep(2000);
    const scrollAfter = await evalJs(ws, `document.getElementById('voice-view').scrollTop`);
    check('页面可滚动', scrollInfo.scrollHeight > scrollInfo.clientHeight && scrollInfo.scrollTop > 0,
        `scrollHeight=${scrollInfo.scrollHeight} clientHeight=${scrollInfo.clientHeight} scrollTop=${scrollInfo.scrollTop}`);
    check('滚动位置 2 秒后未被重置', Math.abs(scrollAfter - scrollInfo.scrollTop) < 2, `之后 scrollTop=${scrollAfter}`);

    // 3. 下拉切换音色：换成另一项，等 1.5 秒确认值保持且状态已更新
    const selTest = await evalJs(ws, `(async () => {
        const sel = document.getElementById('voice-active-pack');
        const before = sel.value;
        const opts = Array.from(sel.options).map(o => o.value);
        const target = opts.find(v => v && v !== before);
        if (!target) return { skip: true, before, opts };
        sel.value = target;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1500));
        const st = await window.api.voice.getState();
        return {
            before, target,
            selValueAfter: sel.value,
            settingsActive: st && st.data && st.data.settings ? st.data.settings.activePackId : null
        };
    })()`, true);
    if (selTest.skip) {
        check('下拉切换音色', false, '没有第二个可选项：' + JSON.stringify(selTest.opts));
    } else {
        check('下拉切换音色后值保持', selTest.selValueAfter === selTest.target,
            `目标=${selTest.target} 实际=${selTest.selValueAfter}`);
        check('设置已持久化到主进程', selTest.settingsActive === selTest.target,
            `主进程 activePackId=${selTest.settingsActive}`);
    }

    // 4. 卡片“设为当前”按钮：点第一张非当前卡片
    const btnTest = await evalJs(ws, `(async () => {
        const st0 = await window.api.voice.getState();
        const current = st0.data.settings.activePackId;
        const btn = Array.from(document.querySelectorAll('.btn-voice-use')).find(b => b.getAttribute('data-voice-id') !== current);
        if (!btn) return { skip: true };
        const target = btn.getAttribute('data-voice-id');
        btn.click();
        await new Promise(r => setTimeout(r, 1500));
        const st = await window.api.voice.getState();
        return { target, after: st.data.settings.activePackId };
    })()`, true);
    if (btnTest.skip) check('设为当前按钮', false, '未找到可点击的按钮');
    else check('设为当前按钮生效', btnTest.after === btnTest.target, `目标=${btnTest.target} 实际=${btnTest.after}`);

    // 5. 按钮点击后再次观察 3 秒，确认没有触发新的重绘循环
    await evalJs(ws, `window.__vtMutations = 0`);
    await sleep(3000);
    const mutations2 = await evalJs(ws, `window.__vtMutations`);
    check('操作后无重绘循环', mutations2 <= 5, `3 秒内 DOM 变更 ${mutations2} 次`);

    // 收尾：断开观察器
    await evalJs(ws, `(() => { if (window.__vtObserver) { window.__vtObserver.disconnect(); window.__vtObserver = null; } return true; })()`);
    ws.close();

    const failed = results.filter((r) => !r.ok);
    console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('SELFTEST ERROR:', e.message); process.exit(2); });
