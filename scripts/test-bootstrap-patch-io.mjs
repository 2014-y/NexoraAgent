import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../patch_gateway.js', import.meta.url), 'utf8');
const end = source.indexOf('bootstrapPatchSources.clear();');
assert.ok(end > 0);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-bootstrap-'));
const dist = path.join(root, 'node_modules/openclaw/dist');
fs.mkdirSync(dist, { recursive: true });
const file = path.join(dist, 'arbitrary-bundle.js');
const input = `function hasMessageToolOnlySourceDelivery(ctx) {
\treturn ctx.params.sourceReplyDeliveryMode === "message_tool_only" && (ctx.state.messageToolOnlySourceReplyDelivered || ctx.params.hasDeliveredMessageToolOnlySourceReply?.() === true || (ctx.state.messagingToolSourceReplyPayloads?.length ?? 0) > 0);
}
const INTERRUPTED_NETWORK_ERROR_RE = /network error/i;
`;
fs.writeFileSync(file, input);
const unused = path.join(dist, 'unrelated.js');
fs.writeFileSync(unused, 'export const untouched = true;');
const reads = new Map();
const trackedFs = { ...fs, readFileSync(p, ...args) {
  reads.set(p, (reads.get(p) || 0) + 1);
  return fs.readFileSync(p, ...args);
} };
const originalRead = fs.readFileSync;
const context = vm.createContext({
  require(name) {
    if (name === 'fs') return trackedFs;
    if (name === 'module') return { prototype: { _compile() {} } };
    if (name === 'os') return { homedir: () => root };
    return require(name);
  },
  __dirname: root,
  process: { env: { NEXORA_AGENT_RUNTIME_DIR: root, OPENCLAW_STATE_DIR: root } },
  console: { log() {}, warn() {} },
});
try {
  const remaining = vm.runInContext('(function () {' + source.slice(0, end + 'bootstrapPatchSources.clear();'.length) + '\nreturn bootstrapPatchSources.size;})()', context);
  const output = fs.readFileSync(file, 'utf8');
  assert.match(output, /nexora-msgtool-dedup/, 'the first transform is preserved');
  assert.match(output, /connection failed/, 'later transforms see the latest written source');
  assert.equal(reads.get(file), 1, 'multiple patch passes read each source only once');
  assert.equal(reads.get(unused), 1);
  assert.equal(fs.readFileSync(unused, 'utf8'), 'export const untouched = true;');
  assert.equal(remaining, 0, 'release bootstrap source strings');
  assert.equal(fs.readFileSync, originalRead, 'do not patch application filesystem reads');
  console.log('Bootstrap patch I/O regression checks passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const watch = main.slice(main.indexOf('function startGatewayHttpReadyWatch(port) {'), main.indexOf('// 与 open-external'));
let now = 0;
let tick;
let retries = 0;
const probeContext = vm.createContext({
  Date: { now: () => now },
  require: () => ({ get: () => ({ on() {} }) }),
  setInterval: fn => { tick = fn; return 1; },
  gatewayProcess: {}, gatewayHttpReadyNotified: false, gatewayHttpReadyTimer: null,
  stopGatewayHttpReadyWatch() {}, appendMainDiagnostic() {}, mainWindow: null,
  notifyGatewayHttpReady() {}, scheduleGatewayCrashRestart() { retries++; },
});
vm.runInContext(watch + '\nstartGatewayHttpReadyWatch(18789);', probeContext);
now = 91_000;
tick();
assert.equal(retries, 0, 'cold initialization must survive the old 90 second limit');
now = 180_000;
tick();
assert.equal(retries, 0, 'first Windows startup must survive three minutes of initialization');
now = 300_000;
tick();
assert.equal(retries, 1, 'an unresponsive gateway still has a bounded startup deadline');
console.log('Cold gateway startup deadline checks passed');

const recovery = main.slice(main.indexOf('    let rendererResponsive = true;'), main.indexOf('    // 仅对「本地控制台'));
const handlers = {};
let recoveryTimer;
let recoveryDelay;
let loadedFile;
let reloads = 0;
let currentUrl = '';
const recoveryContext = vm.createContext({
  isQuitting: false, Date: { now: () => 20000 },
  mainWindow: {
    isDestroyed: () => false,
    loadFile: file => { loadedFile = file; return Promise.resolve(); },
    webContents: { getURL: () => currentUrl, reload: () => { reloads++; }, on: (name, fn) => { handlers[name] = fn; } },
  },
  appendMainDiagnostic() {}, showNotification() {}, clearTimeout() {},
  setTimeout(fn, ms) { recoveryTimer = fn; recoveryDelay = ms; return 1; },
});
vm.runInContext(recovery, recoveryContext);
handlers.unresponsive();
assert.equal(recoveryDelay, 120000, 'allow cold first navigation to finish');
handlers['render-process-gone']({}, { reason: 'clean-exit' });
assert.equal(recoveryDelay, 800);
recoveryTimer();
assert.equal(loadedFile, 'index.html', 'recover an interrupted initial navigation from the entry file');
assert.equal(reloads, 0, 'do not reload a renderer with no document URL');
currentUrl = 'file:///app/index.html';
handlers['did-finish-load']();
handlers.unresponsive();
assert.equal(recoveryDelay, 15000, 'retain normal recovery delay after successful startup');
console.log('Initial renderer recovery checks passed');
