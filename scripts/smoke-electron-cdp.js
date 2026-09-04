'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// Windows 旧版系统 Node 也可运行打包烟测；应用自己的运行时解包前不依赖全局 fetch/WebSocket。
if (typeof global.WebSocket === 'undefined') {
  try { global.WebSocket = require('ws'); }
  catch (_) { global.WebSocket = require('../node_modules/openclaw/node_modules/ws'); }
}
if (typeof global.fetch === 'undefined') {
  global.fetch = (url) => new Promise((resolve, reject) => {
    const client = String(url).startsWith('https:') ? https : http;
    const request = client.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode || 0,
          ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
          text: async () => body,
          json: async () => JSON.parse(body)
        });
      });
    });
    request.on('error', reject);
  });
}

const port = Number(process.env.NEXORA_CDP_PORT || 9333);
const outputDir = path.resolve(__dirname, '..', 'output', 'playwright');
fs.mkdirSync(outputDir, { recursive: true });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const target = targets.find((item) => item.type === 'page' && /index\.html/.test(item.url));
      if (target && target.webSocketDebuggerUrl) return target;
    } catch (_) {}
    await delay(250);
  }
  throw new Error('Electron renderer CDP target did not become ready');
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result || {});
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}, timeoutMs = 10000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, 12000);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer evaluation failed');
    return result.result && result.result.value;
  }
  close() { this.ws.close(); }
}

(async () => {
  const target = await waitForTarget();
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');

  await cdp.eval(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 20000;
    const tick = () => {
      if (document.readyState === 'complete' && document.querySelectorAll('.nav-item[data-tab]').length >= 10) resolve(true);
      else if (Date.now() > deadline) reject(new Error('UI readiness timeout'));
      else setTimeout(tick, 100);
    };
    tick();
  })`);
  // Log.enable may replay renderer entries produced before this smoke run.
  // Clear both Chromium's buffer and the local event queue so the report only
  // covers the navigation workload below.
  try { await cdp.send('Log.clear'); } catch (_) {}
  cdp.events.length = 0;

  const tabs = await cdp.eval(`[...document.querySelectorAll('.nav-item[data-tab]')].map((el) => el.dataset.tab)`);
  const initial = await cdp.eval(`({
    title: document.title,
    readyState: document.readyState,
    bodyText: document.body.innerText.slice(0, 250),
    nodes: document.querySelectorAll('*').length,
    heap: performance.memory ? performance.memory.usedJSHeapSize : null
  })`);

  let agnesConfigRepair = null;
  if (String(process.env.NEXORA_REPAIR_BUILTIN_AGNES || '') === '1') {
    agnesConfigRepair = await cdp.eval(`(async () => {
      const config = await window.api.readConfig();
      if (!config?.models?.providers?.['agnes-ai']) return { success: false, error: 'Agnes provider is missing' };
      config.__nexoraUseBuiltIn = true;
      const result = await window.api.saveConfig(config);
      return { success: !!result?.success, error: result?.error || '' };
    })()`);
    if (!agnesConfigRepair?.success) throw new Error(`Agnes config repair failed: ${agnesConfigRepair?.error || 'unknown error'}`);
  }

  if (String(process.env.NEXORA_SMOKE_ENABLE_AUTO_UPDATE || '') === '1') {
    await cdp.eval(`(() => {
      localStorage.setItem('setting_auto_update', 'true');
      const toggle = document.getElementById('setting-auto-update-toggle');
      if (toggle) toggle.checked = true;
      return true;
    })()`);
  }

  if (String(process.env.NEXORA_SMOKE_CHECK_CORE_UPDATE || '') === '1') {
    await cdp.eval(`maintainOpenclawStableVersion(true)`);
  }

  const visits = [];
  const rounds = Math.max(1, Math.min(100, Number(process.env.NEXORA_SMOKE_ROUNDS || 5)));
  for (let round = 0; round < rounds; round++) {
    for (const tab of tabs) {
      const state = await cdp.eval(`(() => {
        const item = document.querySelector('.nav-item[data-tab=${JSON.stringify(tab)}]');
        if (!item) return { tab: ${JSON.stringify(tab)}, missing: true };
        item.click();
        const pane = document.getElementById(${JSON.stringify(tab)});
        return { tab: ${JSON.stringify(tab)}, active: item.classList.contains('active'), pane: !!pane };
      })()`);
      if (round === 0) visits.push(state);
      await delay(tab === 'data-center-view' ? 500 : 70);
    }
  }

  const requestedFinalTab = String(process.env.NEXORA_SMOKE_FINAL_TAB || 'data-center-view');
  const finalTab = tabs.includes(requestedFinalTab) ? requestedFinalTab : 'data-center-view';
  await cdp.eval(`document.querySelector('.nav-item[data-tab=${JSON.stringify(finalTab)}]').click()`);
  if (finalTab === 'acceleration-view' && process.env.NEXORA_SMOKE_ACCEL_PANEL) {
    const panel = String(process.env.NEXORA_SMOKE_ACCEL_PANEL);
    await cdp.eval(`setAccelerationPanel(${JSON.stringify(panel)})`);
  }
  await delay(finalTab === 'data-center-view' ? 2500 : (finalTab === 'openclaw-panel-view' ? 5000 : 700));
  const final = await cdp.eval(`({
    title: document.title,
    activeTab: document.querySelector('.nav-item.active')?.dataset.tab || '',
    nodes: document.querySelectorAll('*').length,
    heap: performance.memory ? performance.memory.usedJSHeapSize : null,
    animations: document.getAnimations().filter((animation) => animation.playState === 'running').slice(0, 30).map((animation) => ({
      name: animation.animationName || '',
      target: animation.effect?.target?.id || animation.effect?.target?.className || animation.effect?.target?.tagName || ''
    })),
    iframeSrc: document.getElementById('data-center-iframe')?.src || '',
    iframeVisible: getComputedStyle(document.getElementById('data-center-iframe')).visibility,
    bodyVisible: !!(document.body.offsetWidth && document.body.offsetHeight),
    htmlCursor: getComputedStyle(document.documentElement).cursor,
    bodyCursor: getComputedStyle(document.body).cursor,
    openclawUpdate: {
      status: document.getElementById('openclaw-update-status')?.textContent || '',
      button: document.getElementById('btn-openclaw-stable-update')?.textContent || '',
      autoEnabled: !!document.getElementById('setting-auto-update-toggle')?.checked
    },
    openclaw: (() => {
      const webview = document.getElementById('openclaw-iframe');
      const overlay = document.getElementById('openclaw-panel-overlay');
      if (!webview) return { exists: false };
      let guestUrl = '';
      try { guestUrl = typeof webview.getURL === 'function' ? webview.getURL() : ''; } catch (error) { guestUrl = 'getURL failed: ' + error.message; }
      return {
        exists: true,
        src: webview.getAttribute('src') || '',
        guestUrl,
        hasGetUrl: typeof webview.getURL === 'function',
        hasExecuteJavaScript: typeof webview.executeJavaScript === 'function',
        clientWidth: webview.clientWidth,
        clientHeight: webview.clientHeight,
        display: getComputedStyle(webview).display,
        visibility: getComputedStyle(webview).visibility,
        opacity: getComputedStyle(webview).opacity,
        overlayHidden: overlay ? overlay.hidden : null,
        overlayDisplay: overlay ? getComputedStyle(overlay).display : '',
        loading: typeof __openclawPanelLoading !== 'undefined' ? __openclawPanelLoading : null,
        lastUrl: typeof __openclawPanelLastUrl !== 'undefined' ? __openclawPanelLastUrl : '',
        gatewayReady: typeof gatewayFullyReady !== 'undefined' ? gatewayFullyReady : null
      };
    })()
  })`);

  let gateway = null;
  if (String(process.env.NEXORA_SMOKE_START_GATEWAY || '') === '1') {
    const readGatewayState = () => cdp.eval(`({
      className: document.getElementById('gateway-toggle-btn')?.className || '',
      status: document.getElementById('status-label')?.innerText || '',
      button: document.getElementById('btn-label-text')?.innerText || '',
      ready: typeof gatewayFullyReady !== 'undefined' && gatewayFullyReady === true,
      logTail: (document.getElementById('system-raw-logs-area')?.value || '').slice(-3000)
    })`);
    let before = await readGatewayState();
    if (String(process.env.NEXORA_SMOKE_RESTART_GATEWAY || '') === '1' && /\brunning\b/.test(before.className)) {
      await cdp.eval(`window.api.gatewayAction('stop')`);
      const stopDeadline = Date.now() + 60000;
      while (Date.now() < stopDeadline) {
        await delay(500);
        const stopped = await readGatewayState();
        if (/\bstopped\b/.test(stopped.className)) {
          before = stopped;
          break;
        }
      }
      if (!/\bstopped\b/.test(before.className)) throw new Error(`Gateway did not stop for restart: ${JSON.stringify(before)}`);
    }
    if (!/\brunning\b|\bstarting\b/.test(before.className)) {
      await cdp.eval(`document.getElementById('gateway-toggle-btn')?.click()`);
    }
    const timeoutMs = Math.max(30000, Math.min(300000, Number(process.env.NEXORA_SMOKE_GATEWAY_TIMEOUT || 180000)));
    const deadline = Date.now() + timeoutMs;
    let current = before;
    while (Date.now() < deadline) {
      await delay(1000);
      current = await readGatewayState();
      if (/\brunning\b/.test(current.className) && current.ready) break;
      if (/\bstopped\b/.test(current.className) && /失败|错误|failed|error/i.test(current.status + current.logTail)) break;
    }
    gateway = { before, after: current };
    if (!/\brunning\b/.test(current.className) || !current.ready) {
      cdp.close();
      throw new Error(`Gateway did not reach running state: ${JSON.stringify(gateway)}`);
    }
  }

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 20000);
  const screenshotPath = path.join(outputDir, 'electron-smoke.png');
  fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));

  let iframe = null;
  let openclawTarget = null;
  let targetsSnapshot = [];
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    targetsSnapshot = targets.map(({ id, type, title, url }) => ({ id, type, title, url }));
    const openclawGuestTarget = targets.find((item) => /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/acp\//.test(item.url));
    if (openclawGuestTarget) {
      const guestCdp = new CdpClient(openclawGuestTarget.webSocketDebuggerUrl);
      await guestCdp.open();
      await guestCdp.send('Runtime.enable');
      openclawTarget = await guestCdp.eval(`({
        readyState: document.readyState,
        url: location.href,
        title: document.title,
        text: document.body?.innerText?.slice(0, 500) || '',
        nodes: document.querySelectorAll('*').length,
        composerProbe: (() => {
          const field = document.querySelector('textarea, [contenteditable="true"], input[placeholder*="发送消息"]');
          if (!field) return [];
          const result = [];
          let node = field;
          for (let depth = 0; node && depth < 9; depth += 1, node = node.parentElement) {
            const style = getComputedStyle(node);
            const before = getComputedStyle(node, '::before');
            const after = getComputedStyle(node, '::after');
            const rect = node.getBoundingClientRect();
            result.push({
              tag: node.tagName,
              id: node.id || '',
              className: typeof node.className === 'string' ? node.className : '',
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              background: style.background,
              backgroundImage: style.backgroundImage,
              boxShadow: style.boxShadow,
              filter: style.filter,
              overflow: style.overflow,
              position: style.position,
              zIndex: style.zIndex,
              before: { content: before.content, background: before.background, boxShadow: before.boxShadow, position: before.position, inset: before.inset },
              after: { content: after.content, background: after.background, boxShadow: after.boxShadow, position: after.position, inset: after.inset }
            });
          }
          return result;
        })()
      })`);
      openclawTarget.severeEvents = guestCdp.events.filter((event) => event.method === 'Runtime.exceptionThrown');
      guestCdp.close();
    }
    const iframeTarget = targets.find((item) => item !== openclawGuestTarget && item.type === 'iframe' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url));
    if (iframeTarget) {
      const iframeCdp = new CdpClient(iframeTarget.webSocketDebuggerUrl);
      await iframeCdp.open();
      await iframeCdp.send('Runtime.enable');
      iframe = await iframeCdp.eval(`({
        readyState: document.readyState,
        title: document.title,
        text: document.body?.innerText?.slice(0, 500) || '',
        nodes: document.querySelectorAll('*').length,
        background: getComputedStyle(document.body).backgroundColor,
        htmlCursor: getComputedStyle(document.documentElement).cursor,
        bodyCursor: getComputedStyle(document.body).cursor,
        tokenPresent: location.hash.startsWith('#token=')
      })`);
      iframe.severeEvents = iframeCdp.events.filter((event) => event.method === 'Runtime.exceptionThrown');
      iframeCdp.close();
    }
  } catch (error) {
    iframe = { error: error.message || String(error) };
  }

  const severeEvents = cdp.events.filter((event) =>
    event.method === 'Runtime.exceptionThrown' ||
    (event.method === 'Log.entryAdded' && ['error', 'warning'].includes(event.params?.entry?.level))
  );
  const validationErrors = [];
  if (finalTab === 'openclaw-panel-view') {
    if (!openclawTarget) validationErrors.push('OpenClaw WebView target was not attached');
    else if (openclawTarget.readyState !== 'complete') validationErrors.push(`OpenClaw document is ${openclawTarget.readyState}`);
    else if (openclawTarget.nodes < 10 || !String(openclawTarget.text || '').trim()) validationErrors.push('OpenClaw document rendered no meaningful content');
  }
  const report = { initial, agnesConfigRepair, rounds, tabCount: tabs.length, visits, final, gateway, openclawTarget, iframe, targetsSnapshot, severeEventCount: severeEvents.length, severeEvents, validationErrors, screenshotPath };
  fs.writeFileSync(path.join(outputDir, 'electron-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  cdp.close();
  if (validationErrors.length) throw new Error(validationErrors.join('; '));
})().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
