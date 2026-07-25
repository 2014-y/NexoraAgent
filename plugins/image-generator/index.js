/**
 * image-generator Skill
 * Multi-vendor image generation via media-core provider registry.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { loadMediaCore } from "../media-core-resolve.js";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR
  || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(), '.openclaw');
const SAVE_DIR = path.join(STATE_DIR, 'image-output');

function registerDrawPicture(api) {
  const runtime = api?.runtime ?? api;
  const skill = createSkill(runtime);
  if (typeof api?.registerTool !== 'function') {
    console.warn('[image-generator] registerTool unavailable; draw_picture not registered');
    return { name: 'image-generator' };
  }
  api.registerTool((_toolCtx) => ({
    name: 'draw_picture',
    description: skill.description + ' Use when the user asks to generate, draw, or create an image.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Image description (required)' },
        model: { type: 'string', description: 'Model id, e.g. agnes-image-2.0-flash or dall-e-3' },
        size: { type: 'string', description: '512x512, 1024x1024, 1024x1792, 1792x1024' },
        quality: { type: 'string', description: 'Optional. DALL·E-compatible APIs only (standard/hd)' },
        style: { type: 'string', description: 'Optional. DALL·E-compatible APIs only (vivid/natural)' },
        n: { type: 'number', description: 'Number of images (1-4)' },
      },
    },
    async execute(_toolCallId, params) {
      const result = await skill.draw_picture(params || {});
      const files = (result.files || []).map((f) => f.filepath).filter(Boolean);
      const mediaHint = files.length ? `MEDIA:${files.join('\nMEDIA:')}` : '';
      return {
        content: [{ type: 'text', text: mediaHint ? mediaHint + '\n' + JSON.stringify(result) : JSON.stringify(result) }],
        details: result,
      };
    },
  }), { name: 'draw_picture' });
  try { api.logger?.info?.('[image-generator] draw_picture registered'); } catch (_) {}
  console.log('[image-generator] draw_picture registered');
  return { name: 'image-generator' };
}

const pluginEntry = {
  id: 'image-generator',
  name: 'Image Generator',
  description: 'Generate images via configurable multi-vendor media providers',
  register: registerDrawPicture,
};

export default pluginEntry;
export function activate(api) {
  return registerDrawPicture(api);
}

export function createSkill(runtime) {
  if (!fs.existsSync(SAVE_DIR)) {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
  }

  return {
    name: "image-generator",
    description: "Generate images via agnes-ai, OpenAI-compatible, or custom media providers",

    instruction: "Use draw_picture when the user asks to generate, draw, or create an image. Return each generated file as a MEDIA:<absolute path> line before any prose.",

    async draw_picture(params = {}) {
      const core = await loadMediaCore();
      return core.generateImage(
        { ...params, output_dir: params.output_dir || SAVE_DIR },
        runtime
      );
    },
  };
}
