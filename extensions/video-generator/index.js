/**
 * video-generator Skill
 * Multi-vendor video generation via media-core provider registry.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { loadMediaCore } from "../media-core-resolve.js";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR
  || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(), '.openclaw');
const SAVE_DIR = path.join(STATE_DIR, 'video-output');

function registerDrawVideo(api) {
  const runtime = api?.runtime ?? api;
  const skill = createSkill(runtime);
  if (typeof api?.registerTool !== 'function') {
    console.warn('[video-generator] registerTool unavailable; draw_video not registered');
    return { name: 'video-generator' };
  }
  api.registerTool((_toolCtx) => ({
    name: 'draw_video',
    description: skill.description + ' Use when the user asks to generate or create a video. May take 2-10 minutes; wait for completion; do not cancel early.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Video description (required)' },
        image_url: { type: 'string', description: 'Optional first-frame image URL' },
        model: { type: 'string', description: 'Model id, e.g. agnes-video-v2.0' },
        duration: { type: 'number', description: 'Duration in seconds (default 5)' },
        resolution: { type: 'string', description: '480p, 720p, or 1080p' },
        fps: { type: 'number', description: 'Frames per second' },
        aspect_ratio: { type: 'string', description: '16:9, 9:16, 1:1, or 4:3' },
      },
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      const result = await skill.draw_video(params || {}, { signal, onUpdate });
      const mediaHint = result.filepath ? `\nMEDIA:${result.filepath}` : '';
      return {
        content: [{ type: 'text', text: JSON.stringify(result) + mediaHint }],
        details: result,
      };
    },
  }), { name: 'draw_video' });
  try { api.logger?.info?.('[video-generator] draw_video registered'); } catch (_) {}
  console.log('[video-generator] draw_video registered');
  return { name: 'video-generator' };
}

const pluginEntry = {
  id: 'video-generator',
  name: 'Video Generator',
  description: 'Generate videos via configurable multi-vendor media providers',
  register: registerDrawVideo,
};

export default pluginEntry;
export function activate(api) {
  return registerDrawVideo(api);
}

export function createSkill(runtime) {
  if (!fs.existsSync(SAVE_DIR)) {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
  }

  return {
    name: "video-generator",
    description: "Generate videos via agnes-ai, OpenAI-compatible, or custom media providers",

    instruction: `当用户要求生成视频时使用此技能。支持以下参数控制：

- prompt (必填): 视频描述文本
- image_url (可选): 首帧图片 URL
- model: 模型名称
- duration (默认 5): 视频时长（秒）
- resolution (默认 "720p"): 分辨率
- fps (默认 24): 帧率
- aspect_ratio (默认 "16:9"): 宽高比

供应商在 ~/.openclaw/video-generator.json 配置（provider / apiBase / apiKey / model）。
自定义供应商可写在 ~/.openclaw/media-providers.json。`,

    async draw_video(params = {}, opts = {}) {
      const core = await loadMediaCore();
      return core.generateVideo(
        { ...params, output_dir: params.output_dir || SAVE_DIR },
        runtime,
        opts
      );
    },
  };
}
