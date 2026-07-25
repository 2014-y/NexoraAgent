/**
 * Regression: same prompt / same run / same session must not deliver media twice.
 * Run: node scripts/test-media-dedupe.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(path.join(__dirname, '..', 'plugins', 'error-filter', 'index.js')).href;
const { __testables: t } = await import(modUrl);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

t.resetMediaDedupeState();

const drawText = JSON.stringify({
  action: 'draw_picture',
  action_input: { prompt: '一条金色的中国龙在祥云中飞翔' },
});
const drawTextSpaced = JSON.stringify({
  action: 'draw_picture',
  action_input: { prompt: '一条金色的中国龙在祥云中飞翔' },
}).replace(':', ' : ');
const eventA = { runId: 'run-a', to: 'webchat', metadata: {} };
const eventB = { runId: 'run-b', to: 'webchat', metadata: {} };
const path1 = 'C:/Users/Yuan/.openclaw/image-output/dragon-1.png';
const path2 = 'C:/Users/Yuan/.openclaw/image-output/dragon-2.png';

assert(t.extractDrawPicturePrompt(drawText), 'extract draw prompt');
assert(
  t.pseudoMediaCacheKey(drawText) === `draw:${t.normalizePromptFingerprint(t.extractDrawPicturePrompt(drawText))}`,
  'cache key must be prompt-fingerprint based'
);
assert(
  t.normalizePromptFingerprint('  A  B\nC ') === 'a b c',
  'prompt normalize collapses whitespace'
);

const claim1 = t.claimMediaDelivery(eventA, drawText, [path1], t.extractDrawPicturePrompt(drawText));
assert(claim1.ok, 'first claim should succeed');

assert(
  t.isMediaDeliveryClaimed(eventA, 'Image generated.', [], ''),
  'same run status-only must be claimed'
);
assert(
  t.isMediaDeliveryClaimed(eventA, `MEDIA:${path2}\nImage generated.`, [path2], ''),
  'same run second media path must be claimed'
);
assert(
  t.isMediaDeliveryClaimed(eventB, drawText, [path2], t.extractDrawPicturePrompt(drawText)),
  'same prompt different run must be claimed'
);
assert(
  t.isMediaDeliveryClaimed(eventB, drawTextSpaced.replace('金色的中国龙', '金色祥龙'), [path2], '金色祥龙在云中'),
  'session draw cooldown must block near-duplicate draw'
);

const claim2 = t.claimMediaDelivery(eventB, drawText, [path2], t.extractDrawPicturePrompt(drawText));
assert(!claim2.ok, 'second claim same prompt must fail');

t.resetMediaDedupeState();
const other = JSON.stringify({
  action: 'draw_picture',
  action_input: { prompt: '一只蓝色的猫' },
});
const claim3 = t.claimMediaDelivery(eventB, other, [path2], t.extractDrawPicturePrompt(other));
assert(claim3.ok, 'different prompt should be allowed after reset');

console.log('OK media dedupe regressions');
