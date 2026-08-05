/**
 * Deep health check for double-reply defenses.
 * Run: node scripts/audit-double-reply.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(__dirname, '..');
const home = os.homedir();
const local = process.env.LOCALAPPDATA || '';
const checks = [];

function add(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail: String(detail || '') });
}

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

const pluginIds = ['error-filter', 'session-overflow-rollover'];
const loc = {
  repo: (id) => path.join(repo, 'plugins', id, 'index.js'),
  ext: (id) => path.join(home, '.openclaw', 'extensions', id, 'index.js'),
  rt: (id) => path.join(local, 'NexoraAgent', 'gateway-runtime', 'plugins', id, 'index.js'),
};

for (const id of pluginIds) {
  const bodies = {};
  for (const [label, fn] of Object.entries(loc)) {
    const f = fn(id);
    bodies[label] = read(f);
    add(`${id} @${label} exists`, bodies[label].length > 0, f);
  }
  add(`${id} repo==ext`, bodies.repo === bodies.ext);
  add(`${id} repo==rt`, bodies.repo === bodies.rt);
}

const ef = read(loc.repo('error-filter'));
for (const m of [
  'SESSION_TEXT_DEDUP_TTL_MS',
  'suppress-duplicate-media',
  'SESSION_DRAW_COOLDOWN_MS',
  'claimMediaDelivery',
  'reserveSessionDrawSlot',
  'shouldCancelDuplicateRunOutbound',
]) {
  add(`error-filter has ${m}`, ef.includes(m));
}

const ov = read(loc.repo('session-overflow-rollover'));
for (const m of [
  'skip rollover entirely (already delivered, no reset)',
  'unwrapUserQuestion',
  'sessionRecentlyDelivered',
  'event.success !== false',
  'suppress-overflow-banner-after-delivery',
]) {
  add(`overflow has ${m}`, ov.includes(m));
}
add('overflow no JSON.stringify(event)', !/JSON\.stringify\(\s*event\s*\)/.test(ov));
add('overflow no bare use /new', !ov.includes('/use \\/new/i.test(t)'));
add('overflow noise filters continuity', ov.includes('[内部延续上下文]'));

const iDel = ov.indexOf('skip rollover entirely (already delivered, no reset)');
const iReset = ov.indexOf("await gatewayRequest(api, 'sessions.reset'");
add('delivered-check BEFORE reset', iDel > 0 && iReset > iDel, `del@${iDel} reset@${iReset}`);

add(
  'silent-retry path removed',
  !/performSilentRetry|scheduleSilentRetry/.test(ov),
  'rollover must not launch a second invisible chat turn'
);
add(
  'rollover retry is delivery-aware',
  ov.includes('isOriginatingRouteValidationError') && ov.includes('delivery outcome uncertain; skipped duplicate retry notice'),
  'only route-validation errors may be retried without risking duplicate billing'
);

const sel = path.join(
  local,
  'NexoraAgent',
  'gateway-runtime',
  'node_modules',
  'openclaw',
  'dist',
  'selection-JInn13lc.js'
);
const t = read(sel);
add('live selection exists', t.length > 0, sel);
add('live msgtool patch', t.includes('nexora-msgtool-dedup'));
add('live msgtool inner', t.includes('nexora-msgtool-dedup-inner'));
add('live msgend media patch', t.includes('nexora-msgend-media-dedup'));
add('live msgend skip re-send', t.includes('media already delivered with final text'));

const patchSrc = read(path.join(repo, 'patch_gateway.js'));
add('patch_gateway has msgend patcher', patchSrc.includes('patchMessageEndMediaResend') || patchSrc.includes('nexora-msgend-media-dedup'));
add('patch_gateway has msgtool patcher', patchSrc.includes('nexora-msgtool-dedup'));

const cfgPath = path.join(home, '.openclaw', 'openclaw.json');
const cfg = JSON.parse(read(cfgPath) || '{}');
const load = cfg.plugins?.load?.paths || [];
const norm = (p) => String(p || '').replace(/\\/g, '/');
add(
  'load path error-filter',
  load.some((p) => norm(p).endsWith('/extensions/error-filter')),
  load.filter((p) => /error-filter|overflow/.test(p)).map(norm).join(' | ')
);
add(
  'load path overflow',
  load.some((p) => norm(p).endsWith('/extensions/session-overflow-rollover'))
);
const dmt = cfg.plugins?.entries?.['dual-model-trainer'] || {};
const dmtCfg = dmt.config || dmt;
add(
  'dual-model not live-answering',
  dmtCfg.enableTeachLearn === false || dmtCfg.mode === 'collect-only' || dmt.enabled === false,
  JSON.stringify({ mode: dmtCfg.mode, enableTeachLearn: dmtCfg.enableTeachLearn, enabled: dmt.enabled })
);

// Logic smoke: import error-filter testables
const { __testables: et } = await import(pathToFileUrl(loc.repo('error-filter')));
et.resetMediaDedupeState();
const draw = JSON.stringify({ action: 'draw_picture', action_input: { prompt: 'audit dragon' } });
const ev = { runId: 'audit-1', to: 'webchat', metadata: {} };
const c1 = et.claimMediaDelivery(ev, draw, ['C:/tmp/a.png'], 'audit dragon');
const c2 = et.claimMediaDelivery({ runId: 'audit-2', to: 'webchat', metadata: {} }, draw, ['C:/tmp/b.png'], 'audit dragon');
add('media claim first ok', c1.ok);
add('media claim second blocked', !c2.ok);

et.resetMediaDedupeState();
const textEv = { runId: 't1', to: 'webchat', metadata: {} };
// exercise via dynamic eval of shouldCancel by simulating remember through claim paths is hard;
// at least ensure functions export
add('error-filter exports testables', typeof et.claimMediaDelivery === 'function');

let fail = 0;
for (const c of checks) {
  console.log(c.ok ? 'OK ' : 'FAIL', c.name + (c.detail ? ` — ${c.detail}` : ''));
  if (!c.ok) fail += 1;
}
console.log(fail ? `RESULT FAIL ${fail}/${checks.length}` : `RESULT PASS ${checks.length}/${checks.length}`);
process.exit(fail ? 1 : 0);

function pathToFileUrl(p) {
  const u = path.resolve(p).replace(/\\/g, '/');
  return 'file:///' + u.replace(/^([A-Za-z]):/, '$1:');
}
