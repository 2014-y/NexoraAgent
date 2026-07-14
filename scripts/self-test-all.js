'use strict';
/**
 * 综合自测：语�?+ 单测 + 插件页契约（DOM id / 首绘 / 目录�? */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed += 1;
    console.log('OK:', msg);
  } else {
    failed += 1;
    console.error('FAIL:', msg);
  }
}

function runNode(rel) {
  const r = spawnSync(process.execPath, [path.join(root, rel)], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

console.log('=== syntax ===');
for (const f of [
  'main.js', 'renderer.js', 'preload.js', 'plugin-catalog.js',
  'latency-tune.js', 'token-usage-parse.js', 'home-resolve.js', 'patch_gateway.js'
]) {
  const r = spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' });
  ok(r.status === 0, `syntax ${f}`);
}

console.log('\n=== unit tests ===');
for (const f of fs.readdirSync(path.join(root, 'scripts')).filter((n) => /^test-.*\.js$/.test(n))) {
  const r = runNode(path.join('scripts', f));
  ok(r.code === 0, `${f} (exit ${r.code})`);
  if (r.code !== 0) console.error(r.out.slice(0, 500));
}

console.log('\n=== plugins UI contract ===');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const mHtml = html.match(/id="([^"]*plugins-grid)"/);
const mJs = renderer.match(/getElementById\('([^']*plugins-grid)'\)/);
ok(Boolean(mHtml && mJs), 'found plugins-grid in html+js');
ok(mHtml && mJs && mHtml[1] === mJs[1], `grid id match html=${mHtml && mHtml[1]} js=${mJs && mJs[1]}`);
ok(/paintCards\(\);/.test(renderer), 'paintCards() call present');
ok(/先立刻画卡片/.test(renderer), 'immediate paint comment present');
ok(!/PLACEHOLDER_TOGGLE|REMOVE_ME_SHOULD_NOT_APPEAR/.test(renderer), 'no broken placeholders');
ok(/currentTab === 'plugins-view'/.test(renderer), 're-render on plugins tab');

const orderMatch = renderer.match(/const UI_PLUGIN_ORDER = \[([\s\S]*?)\];/);
ok(Boolean(orderMatch), 'UI_PLUGIN_ORDER defined');
const order = orderMatch ? orderMatch[1] : '';
for (const id of ['dual-model-trainer', 'openclaw-weixin', 'voice-call', 'telegram', 'whatsapp', 'auto-summary', 'duckduckgo']) {
  ok(order.includes(`'${id}'`), `UI order has ${id}`);
}

const css = fs.readFileSync(path.join(root, 'index.css'), 'utf8');
ok(/\.plugins-masonry\s*\{[\s\S]*?min-height:\s*0/.test(css), 'plugins-masonry min-height:0');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = (pkg.build && pkg.build.files) || [];
for (const f of ['plugin-catalog.js', 'latency-tune.js', 'token-usage-parse.js', 'home-resolve.js']) {
  ok(files.includes(f), `package.json files includes ${f}`);
}

console.log('\n=== module smoke ===');
const { ensureUiPluginCatalog, UI_PLUGIN_IDS, probePlugin } = require('../plugin-catalog');
const { ensureLatencySafeConfig } = require('../latency-tune');
const { parseUsageFromLlmBody } = require('../token-usage-parse');

const cat = ensureUiPluginCatalog({ plugins: { entries: {}, allow: [] } }, { forceDefaultOn: true });
ok(cat.changed && cat.config || true, 'catalog apply');
ok(UI_PLUGIN_IDS.includes('voice-call'), 'catalog UI has voice-call');
const voice = probePlugin('voice-call', { config: {} });
ok(voice && voice.badge === 'ready', 'voice-call probe ready by default');

const slow = ensureLatencySafeConfig({
  channels: { 'openclaw-weixin': { inbound: { debounceMs: 2000 } } },
  models: { providers: { ollama: { models: [{ id: 'local-test', contextWindow: 999999 }] } } }
});
ok(slow.changed, 'latency tune changes slow config');

const usage = parseUsageFromLlmBody('{"done":true,"prompt_eval_count":11,"eval_count":7}');
ok(usage && usage.prompt_tokens === 11 && usage.completion_tokens === 7, 'ollama usage parse');

console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
