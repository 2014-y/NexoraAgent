/**
 * Self-test: video create + poll + download via media-core
 */
import { generateVideo } from '../media-cli/media-core/index.js';

const updates = [];
const toolOpts = {
  onUpdate(partial) {
    const text = partial?.progress?.text || partial?.content?.[0]?.text || '';
    updates.push({ t: Date.now(), text });
    console.log(`[progress] ${text}`);
  },
};

const prompt = '一只可爱的粉色小猪在草地上奔跑，卡通风格';
const t0 = Date.now();
console.log('[selftest] start video generation...');

try {
  const res = await generateVideo(
    { prompt, duration: 5, resolution: '480p', fps: 24 },
    null,
    toolOpts
  );
  console.log('[selftest] OK', Math.round((Date.now() - t0) / 1000), 's');
  console.log(JSON.stringify(res, null, 2));
  console.log('[selftest] progress updates:', updates.length);
  process.exit(0);
} catch (e) {
  console.error('[selftest] FAIL', Math.round((Date.now() - t0) / 1000), 's', e.message);
  console.error('[selftest] progress updates:', updates.length, updates.slice(-3));
  process.exit(1);
}
