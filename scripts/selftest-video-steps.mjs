import { httpPostJson, httpGet } from '../media-cli/media-core/media-http.js';
import { BUILTIN_API_KEYS } from '../media-cli/media-core/keys.js';

const key = BUILTIN_API_KEYS[0];
const body = {
  model: 'agnes-video-v2.0',
  prompt: '一只可爱的粉色小猪在草地上奔跑，卡通风格',
  width: 832,
  height: 448,
  num_frames: 25,
  frame_rate: 24,
};

async function main() {
  console.log('[step1] create task...');
  const t1 = Date.now();
  let create;
  try {
    create = await httpPostJson('https://apihub.agnes-ai.com/v1/videos', body, key, 120000);
    console.log('[step1] create OK', Date.now() - t1, 'ms', create.statusCode, create.text.slice(0, 400));
  } catch (e) {
    console.error('[step1] create FAIL', Date.now() - t1, 'ms', e.message);
    process.exit(1);
  }

  let parsed;
  try { parsed = JSON.parse(create.text); } catch (e) {
    console.error('[step1] parse fail', e.message);
    process.exit(1);
  }

  const videoId = parsed.video_id || parsed.id || parsed.task_id;
  if (!videoId) {
    console.error('[step1] no task id', parsed);
    process.exit(1);
  }
  console.log('[step1] taskId=', videoId);

  const pollUrl = `https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=agnes-video-v2.0`;
  console.log('[step2] poll', pollUrl);
  const t2 = Date.now();
  for (let i = 0; i < 80; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 5000));
    try {
      const r = await httpGet(pollUrl, { Authorization: `Bearer ${key}` }, 30000);
      const data = JSON.parse(r.text);
      const status = data.status || data.data?.status || 'unknown';
      console.log(`[step2] poll #${i + 1}`, status, Date.now() - t2, 'ms');
      const url = data.metadata?.url || data.video?.url || data.url;
      if (status === 'succeeded' || status === 'completed' || status === 'success') {
        console.log('[step2] DONE', url || data);
        process.exit(0);
      }
      if (status === 'failed' || status === 'error') {
        console.error('[step2] FAILED', data);
        process.exit(1);
      }
    } catch (e) {
      console.warn('[step2] poll err', e.message);
    }
  }
  console.error('[step2] timeout after', Date.now() - t2, 'ms');
  process.exit(1);
}

main();
