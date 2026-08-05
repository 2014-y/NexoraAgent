import { createRequire } from 'node:module';
import fs from 'node:fs';

const assert = {
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
};

const require = createRequire(import.meta.url);
const { ensureLatencySafeConfig } = require('../latency-tune.js');
const { ensureVisionModelConfig } = require('../vision-model-config.js');
const renderer = fs.readFileSync(new URL('../renderer.js', import.meta.url), 'utf8');

if (!/customRefs\.slice\(1, 3\)/.test(renderer)) {
  throw new Error('built-in toggle must write distinct custom fallback models');
}
if (!/no_custom_model_configured/.test(renderer)) {
  throw new Error('built-in toggle must reject disabling when no custom model exists');
}
if (!/save_config_failed/.test(renderer)) {
  throw new Error('built-in toggle must roll back when config-save fails');
}

const originalOpenAiKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;

try {
  const memoryCfg = {
    models: { providers: { ollama: { models: [{ id: 'nomic-embed-text:latest' }] } } },
    agents: {
      defaults: {
        model: {
          primary: 'newapi/model-a',
          fallbacks: ['newapi/model-a', 'agnes-ai/agnes-1.5-flash', 'agnes-ai/agnes-1.5-flash'],
        },
      },
    },
    plugins: {
      entries: {
        slack: { enabled: true },
        whatsapp: { enabled: true },
        matrix: { enabled: true },
        'voice-call': { enabled: true },
      },
    },
  };
  const memoryResult = ensureLatencySafeConfig(memoryCfg);
  assert.equal(memoryResult.config.agents.defaults.memorySearch.provider, 'none');
  assert.equal(memoryResult.config.agents.defaults.model.fallbacks.length, 1);
  assert.equal(memoryResult.config.agents.defaults.model.fallbacks[0], 'agnes-ai/agnes-1.5-flash');
  assert.equal(memoryResult.config.plugins.entries.slack.enabled, true);
  assert.equal(memoryResult.config.plugins.entries.whatsapp.enabled, true);
  assert.equal(memoryResult.config.plugins.entries.matrix.enabled, true);
  assert.equal(memoryResult.config.plugins.entries['voice-call'].enabled, true);

  const visionCfg = {
    models: {
      providers: {
        'agnes-ai': {
          models: [{ id: 'agnes-2.0-flash', input: ['text', 'image'] }],
        },
        newapi: {
          models: [{ id: 'gemini-3.6-flash-high', input: ['text', 'image'] }],
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: 'newapi/gemini-3.6-flash-high' },
        imageModel: { primary: 'gemini/gemini-3.1-flash-lite' },
      },
    },
    tools: { media: { image: { enabled: true, models: [] } } },
  };
  const visionResult = ensureVisionModelConfig(visionCfg);
  assert.equal(visionResult.config.agents.defaults.imageModel.primary, 'agnes-ai/agnes-2.0-flash');
  assert.equal(visionResult.config.tools.media.image.models[0].provider, 'agnes-ai');

  console.log('chat config guard tests passed');
} finally {
  if (originalOpenAiKey == null) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
}
