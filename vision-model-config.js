'use strict';
/**
 * OpenClaw media understanding depends on models.providers.*.models[].input.
 * If a vision-capable custom model is not marked with image input, OpenClaw can
 * treat it as text-only and the main model never receives image context.
 */

const VISION_MODEL_ID_PATTERNS = [
  /^agnes-\d+\.\d+-flash$/i,
  /^agnes-1\.5-flash$/i,
  /vl/i,
  /vision/i,
  /llava/i,
  /gemma3/i,
  /pixtral/i,
  /moondream/i,
  /minicpm-v/i,
  /qwen.*vl/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /claude-.*-(?:sonnet|opus|haiku)/i,
  /gemini/i
];

const GENERATION_ONLY_PATTERNS = [
  /^agnes-image-/i,
  /^agnes-video-/i,
  /^dall-e/i,
  /^stable-diffusion/i,
  /^hy-image/i
];

const DEFAULT_VISION_MODEL = 'agnes-ai/agnes-2.0-flash';
const DEFAULT_MEDIA_PROMPT =
  '\u8bf7\u7528\u4e2d\u6587\u8be6\u7ec6\u63cf\u8ff0\u8fd9\u5f20\u56fe\u7247\u7684\u5185\u5bb9\uff0c\u5305\u62ec\u573a\u666f\u3001\u7269\u4f53\u3001\u6587\u5b57\u3001\u989c\u8272\u7b49\u3002\u5982\u679c\u6709\u591a\u4e2a\u7269\u4f53\uff0c\u9010\u4e2a\u63cf\u8ff0\u3002\u4e0d\u8d85\u8fc7300\u5b57\u3002';

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function parseModelRef(ref) {
  const s = String(ref || '').trim();
  if (!s || !s.includes('/')) return null;
  const idx = s.indexOf('/');
  return {
    provider: s.slice(0, idx).trim(),
    model: s.slice(idx + 1).trim(),
    primary: s
  };
}

function isGenerationOnlyModelId(modelId) {
  const id = String(modelId || '').trim();
  return GENERATION_ONLY_PATTERNS.some((re) => re.test(id));
}

function isLikelyVisionModelId(modelId) {
  const id = String(modelId || '').trim();
  if (!id || isGenerationOnlyModelId(id)) return false;
  return VISION_MODEL_ID_PATTERNS.some((re) => re.test(id));
}

function hasImageEntry(value) {
  return Array.isArray(value) && value.map(String).some((entry) => entry.toLowerCase() === 'image');
}

function hasVisionCapabilityMetadata(model) {
  if (!isObject(model)) return false;
  if (hasImageEntry(model.input) || hasImageEntry(model.inputs) || hasImageEntry(model.modalities)) return true;
  if (model.supportsImages === true || model.supportsImage === true || model.vision === true) return true;

  const caps = model.capabilities;
  if (Array.isArray(caps)) {
    return caps.map(String).some((entry) => /^(image|images|vision|multimodal)$/i.test(entry));
  }
  if (isObject(caps)) {
    return caps.image === true || caps.images === true || caps.vision === true || caps.multimodal === true;
  }
  return false;
}

function isVisionModelObject(model) {
  if (!isObject(model)) return false;
  const id = model.id || model.name || '';
  if (isGenerationOnlyModelId(id)) return false;
  return hasVisionCapabilityMetadata(model) || isLikelyVisionModelId(id);
}

function ensureModelInput(model) {
  if (!isObject(model) || !isVisionModelObject(model)) return false;
  const current = Array.isArray(model.input) ? model.input.map(String) : [];
  if (current.includes('image')) return false;
  model.input = current.length > 0 ? Array.from(new Set([...current, 'image'])) : ['text', 'image'];
  return true;
}

function findProviderModel(cfg, providerId, modelId) {
  const provider = cfg && cfg.models && cfg.models.providers && cfg.models.providers[providerId];
  if (!isObject(provider) || !Array.isArray(provider.models)) return null;
  return provider.models.find((model) => isObject(model) && String(model.id || model.name || '').trim() === modelId) || null;
}

function findFirstVisionModelRef(cfg) {
  const providers = cfg && cfg.models && cfg.models.providers;
  if (!isObject(providers)) return null;

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isObject(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isObject(model)) continue;
      const id = model.id || model.name;
      if (!id) continue;
      if (isVisionModelObject(model)) return `${providerId}/${id}`;
    }
  }
  return null;
}

function resolvePrimaryModelRef(cfg) {
  const primaryRef =
    cfg &&
    cfg.agents &&
    cfg.agents.defaults &&
    cfg.agents.defaults.model &&
    (typeof cfg.agents.defaults.model === 'string'
      ? cfg.agents.defaults.model
      : cfg.agents.defaults.model.primary);
  const parsed = parseModelRef(primaryRef);
  if (!parsed) return null;
  const model = findProviderModel(cfg, parsed.provider, parsed.model);
  return isVisionModelObject(model) || isLikelyVisionModelId(parsed.model) ? parsed.primary : null;
}

function resolveVisionModelRef(cfg) {
  const primaryVisionRef = resolvePrimaryModelRef(cfg);
  if (primaryVisionRef) return primaryVisionRef;

  const imageModelRef =
    cfg &&
    cfg.agents &&
    cfg.agents.defaults &&
    cfg.agents.defaults.imageModel &&
    cfg.agents.defaults.imageModel.primary;
  if (imageModelRef) return String(imageModelRef).trim();

  return findFirstVisionModelRef(cfg) || DEFAULT_VISION_MODEL;
}

function ensureMediaImageTools(cfg, visionRef) {
  if (!cfg.tools) cfg.tools = {};
  if (!cfg.tools.media) cfg.tools.media = {};
  if (!cfg.tools.media.image) cfg.tools.media.image = {};

  let changed = false;
  const imageCfg = cfg.tools.media.image;
  if (imageCfg.enabled !== true) {
    imageCfg.enabled = true;
    changed = true;
  }
  if (!isObject(imageCfg.attachments)) {
    imageCfg.attachments = { mode: 'all' };
    changed = true;
  } else if (imageCfg.attachments.mode !== 'all') {
    imageCfg.attachments.mode = 'all';
    changed = true;
  }

  const parsed = parseModelRef(visionRef);
  if (!parsed) return changed;

  const models = Array.isArray(imageCfg.models) ? imageCfg.models : [];
  const matching = models.find(
    (entry) =>
      isObject(entry) &&
      String(entry.provider || '').trim() === parsed.provider &&
      String(entry.model || '').trim() === parsed.model
  );
  const selected = {
    prompt: matching && matching.prompt ? matching.prompt : DEFAULT_MEDIA_PROMPT,
    provider: parsed.provider,
    model: parsed.model
  };
  const rest = models.filter(
    (entry) =>
      !(
        isObject(entry) &&
        String(entry.provider || '').trim() === parsed.provider &&
        String(entry.model || '').trim() === parsed.model
      )
  );
  const nextModels = [selected, ...rest];
  if (JSON.stringify(nextModels) !== JSON.stringify(models)) {
    imageCfg.models = nextModels;
    changed = true;
  }

  return changed;
}

function ensureVisionModelConfig(cfg, opts = {}) {
  if (!isObject(cfg)) return { config: cfg, changed: false };

  let changed = false;

  const providers = cfg.models && cfg.models.providers;
  if (isObject(providers)) {
    for (const provider of Object.values(providers)) {
      if (!isObject(provider) || !Array.isArray(provider.models)) continue;
      for (const model of provider.models) {
        if (ensureModelInput(model)) changed = true;
      }
    }
  }

  if (!cfg.agents) {
    cfg.agents = {};
    changed = true;
  }
  if (!cfg.agents.defaults) {
    cfg.agents.defaults = {};
    changed = true;
  }
  if (!cfg.agents.defaults.imageModel) {
    cfg.agents.defaults.imageModel = {};
    changed = true;
  }

  const visionRef = resolveVisionModelRef(cfg);
  const currentImageModel =
    cfg.agents.defaults.imageModel.primary && String(cfg.agents.defaults.imageModel.primary).trim();
  if (!currentImageModel || currentImageModel === DEFAULT_VISION_MODEL && visionRef !== DEFAULT_VISION_MODEL) {
    cfg.agents.defaults.imageModel.primary = visionRef;
    changed = true;
  }

  const effectiveVisionRef = cfg.agents.defaults.imageModel.primary || visionRef;
  if (ensureMediaImageTools(cfg, effectiveVisionRef)) changed = true;

  return {
    config: cfg,
    changed,
    visionModel: effectiveVisionRef
  };
}

module.exports = {
  DEFAULT_VISION_MODEL,
  isLikelyVisionModelId,
  hasVisionCapabilityMetadata,
  isGenerationOnlyModelId,
  ensureVisionModelConfig
};
