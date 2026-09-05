import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import net from 'node:net';

const root = path.resolve(import.meta.dirname, '..');
const exe = process.env.NEXORA_STARTUP_EXE || path.join(root, 'dist/win-unpacked/Nexora Agent.exe');
if (!fs.existsSync(exe)) throw new Error(`Build the application first: ${exe}`);
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const assigned = server.address().port;
    server.close(error => error ? reject(error) : resolve(assigned));
  });
});
const started = performance.now();
const child = spawn(exe, [`--remote-debugging-port=${port}`], { cwd: root, windowsHide: true, stdio: 'ignore' });
let launchError;
child.on('error', (error) => { launchError = error; });
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let ws;
const calls = new Map();
let id = 0;
const rendererErrors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++id;
  const timer = setTimeout(() => { calls.delete(callId); reject(new Error(`${method} timeout`)); }, 10000);
  calls.set(callId, msg => { clearTimeout(timer); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); });
  ws.send(JSON.stringify({ id: callId, method, params }));
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { returnByValue: true, expression });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
try {
  let target;
  while (performance.now() - started < 30000) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Application exited before startup: ${child.exitCode}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      target = targets.find(t => t.type === 'page' && /index\.html/.test(t.url));
      if (target) break;
    } catch {}
    await delay(100);
  }
  if (!target) throw new Error('No main renderer target within 30 seconds');
  const targetMs = Math.round(performance.now() - started);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const detail = msg.params.exceptionDetails;
      rendererErrors.push(detail.exception?.description || detail.text);
    }
    if (calls.has(msg.id)) { calls.get(msg.id)(msg); calls.delete(msg.id); }
  };
  await send('Runtime.enable');
  let state;
  while (performance.now() - started < 30000) {
    const res = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const mask = document.getElementById('app-loading-screen');
      const button = document.getElementById('gateway-toggle-btn');
      return { ready: document.readyState === 'complete' && !!button && !button.disabled && !!mask && getComputedStyle(mask).visibility === 'hidden'
          && (!window.__nexoraStartupTimings || !!window.__nexoraStartupTimings.interactive),
        navigation: performance.getEntriesByType('navigation')[0]?.toJSON(),
        timings: window.__nexoraStartupTimings || null,
        nodes: document.querySelectorAll('*').length,
        pluginCards: document.querySelectorAll('#cfg-plugins-grid .plugin-card-item').length };
    })()` });
    state = res.result?.value;
    if (state?.ready) break;
    await delay(100);
  }
  if (!state?.ready) throw new Error('App did not become interactive within 30 seconds');
  const report = { label: process.env.NEXORA_STARTUP_LABEL || 'sample', targetMs, interactiveMs: Math.round(performance.now() - started), ...state };
  if (process.env.NEXORA_STARTUP_VERIFY_PAGES === '1') {
    report.pages = [];
    if (state.pluginCards !== 0) throw new Error('Hidden plugins loaded during startup');
    for (const [tab, selector] of [['plugins-view', '#cfg-plugins-grid .plugin-card-item'], ['roles-view', '.role-card'], ['dashboard-view', '#stats-wave-chart-box svg'], ['console-view', '#gateway-toggle-btn']]) {
      await evaluate(`document.querySelector('.sidebar-nav [data-tab="${tab}"]').click()`);
      const deadline = performance.now() + 15000;
      let count = 0;
      while (performance.now() < deadline) {
        count = await evaluate(`currentTab === '${tab}' && document.getElementById('page-load-mask').hidden
          ? document.querySelectorAll('${selector}').length : 0`);
        if (count) break;
        await delay(100);
      }
      if (!count) throw new Error(`Lazy page did not load: ${tab}`);
      report.pages.push({ tab, count });
    }
  }
  const holdSeconds = Math.min(600, Math.max(0, Number(process.env.NEXORA_STARTUP_HOLD_SECONDS) || 0));
  if (holdSeconds) {
    const until = performance.now() + holdSeconds * 1000;
    report.responsiveness = { seconds: holdSeconds, samples: 0, maxResponseMs: 0 };
    while (performance.now() < until) {
      await delay(Math.min(5000, until - performance.now()));
      const probeStarted = performance.now();
      const ready = await evaluate(`!!window.__nexoraStartupTimings?.interactive && document.readyState === 'complete'`);
      if (!ready) throw new Error('Renderer lost its initialized state during the responsiveness check');
      report.responsiveness.samples++;
      report.responsiveness.maxResponseMs = Math.max(report.responsiveness.maxResponseMs, Math.round(performance.now() - probeStarted));
      if (report.responsiveness.samples % 6 === 0) console.log(`Responsiveness: ${report.responsiveness.samples} successful probes`);
    }
  }
  report.rendererErrors = rendererErrors;
  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join('\n')}`);
  const out = path.join(root, 'output/playwright');
  fs.mkdirSync(out, { recursive: true });
  const fileLabel = report.label.replace(/[^a-zA-Z0-9_-]/g, '_');
  fs.writeFileSync(path.join(out, `startup-${fileLabel}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  if (ws) ws.close();
  // Only the test instance launched by this script is stopped.
  child.kill();
}
