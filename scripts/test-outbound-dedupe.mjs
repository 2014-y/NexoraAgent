/**
 * Smoke test: error-filter duplicate-run outbound cancel logic.
 * Run: node scripts/test-outbound-dedupe.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'error-filter', 'index.js'), 'utf8');

const checks = [
  ['LLM request failed block', /LLM request failed/],
  ['duplicate cancel reason', /suppress-duplicate-run-outbound/],
  ['media duplicate cancel', /suppress-duplicate-media/],
  ['session text dedupe', /SESSION_TEXT_DEDUP_TTL_MS/],
  ['prompt fingerprint cache', /draw:\$\{normalizePromptFingerprint/],
  ['session draw cooldown', /SESSION_DRAW_COOLDOWN_MS/],
  ['remember after allow', /rememberRunOutbound/],
  ['channel delivery gate', /channel-layer skip duplicate cancel \(delivery gate\)/],
  ['channel pass claimed media', /channel-layer pass claimed media \(delivery gate\)/],
];

let failed = 0;
for (const [name, re] of checks) {
  const ok = re.test(src);
  console.log(ok ? 'OK ' : 'FAIL', name);
  if (!ok) failed += 1;
}

const overflow = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'session-overflow-rollover', 'index.js'), 'utf8');
const overflowChecks = [
  ['no event stringify', !/JSON\.stringify\(\s*event\s*\)/.test(overflow)],
  ['success gate', /event\.success !== false/.test(overflow)],
  // silent-retry 必须处于禁用状态以防双回复：要么整套机制已移除（无 scheduleSilentRetry 调用），
  // 要么保留了明确的 disabled 守卫日志。二者皆可，避免测试锁死具体实现细节。
  ['silent-retry disabled', !/\bscheduleSilentRetry\s*\(/.test(overflow) || /disabled to prevent double replies/.test(overflow)],
  ['skip resume if delivered', /already delivered/.test(overflow)],
  ['no reset after delivery', /skip rollover entirely \(already delivered, no reset\)/.test(overflow)],
  ['unwrap continuity', /function unwrapUserQuestion/.test(overflow)],
  ['remember delivery route', /function rememberDeliveryRoute/.test(overflow)],
  ['route missing warning', /no originating route/.test(overflow)],
  ['no bare use \\/new', !/\/use \\\/new\/i\.test\(t\)/.test(overflow) && !/\/use \\\/new\/i/.test(overflow.split('isOverflowRecoveryText')[1]?.slice(0,1200) || '')],
];
for (const [name, ok] of overflowChecks) {
  console.log(ok ? 'OK ' : 'FAIL', name);
  if (!ok) failed += 1;
}

// route cache lives in overflow plugin, not error-filter — fix mis-placed check
const efHasGate = /channel-layer skip duplicate cancel \(delivery gate\)/.test(src);
const ovHasRoute = /function rememberDeliveryRoute/.test(overflow);
if (!efHasGate) {
  console.log('FAIL', 'channel delivery gate in error-filter');
  failed += 1;
}
if (!ovHasRoute) {
  console.log('FAIL', 'rememberDeliveryRoute in overflow');
  failed += 1;
}

const oc = path.join(__dirname, '..', 'node_modules', 'openclaw', 'dist', 'selection-JInn13lc.js');
const ocLive = path.join(process.env.LOCALAPPDATA || '', 'NexoraAgent', 'gateway-runtime', 'node_modules', 'openclaw', 'dist', 'selection-JInn13lc.js');
for (const [label, file] of [['repo', oc], ['live', ocLive]]) {
  if (!fs.existsSync(file)) continue;
  const t = fs.readFileSync(file, 'utf8');
  if (t.includes('hasMessageToolOnlySourceDelivery') || t.includes('alreadyDeliveredFinalText')) {
    const a = t.includes('/*nexora-msgtool-dedup*/');
    const b = t.includes('/*nexora-msgtool-dedup-inner*/');
    const c = !t.includes('alreadyDeliveredFinalText') || t.includes('/*nexora-msgend-media-dedup*/');
    console.log(a ? 'OK ' : 'FAIL', label, 'openclaw outer msgtool patch');
    console.log(b ? 'OK ' : 'FAIL', label, 'openclaw inner msgtool patch');
    console.log(c ? 'OK ' : 'FAIL', label, 'openclaw message_end media dedup');
    if (!a) failed += 1;
    if (!b) failed += 1;
    if (!c) failed += 1;
  }
}

process.exit(failed ? 1 : 0);
