'use strict';

(function exposeModelConfigPolicy(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NexoraModelConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModelConfigPolicy() {
  const BUILTIN_ALLOWED_PROVIDERS = Object.freeze(['agnes-ai', 'ollama']);
  const DEFAULT_PRIMARY = 'agnes-ai/agnes-2.0-flash';
  const DEFAULT_FALLBACK = 'agnes-ai/agnes-1.5-flash';

  function parseModelRef(ref) {
    const raw = String(ref || '').trim();
    if (!raw) return { provider: '', model: '', id: '', ref: '' };
    const slash = raw.indexOf('/');
    if (slash <= 0) return { provider: '', model: raw, id: raw, ref: raw };
    const provider = raw.slice(0, slash).trim();
    const model = raw.slice(slash + 1).trim();
    return {
      provider,
      model,
      id: model,
      ref: provider && model ? `${provider}/${model}` : raw
    };
  }

  function isNonChatModelId(modelId) {
    const id = String(modelId || '').trim().toLowerCase();
    return !id || id.includes('image') || id.includes('video') || id.includes('embed');
  }

  function composeModelRef(provider, modelInput) {
    const selectedProvider = String(provider || '').trim();
    const parsed = parseModelRef(modelInput);
    if (!parsed.model) return { provider: selectedProvider, model: '', ref: '', conflict: false };
    const embeddedProvider = parsed.provider;
    const finalProvider = selectedProvider || embeddedProvider;
    return {
      provider: finalProvider,
      model: parsed.model,
      ref: finalProvider ? `${finalProvider}/${parsed.model}` : parsed.model,
      conflict: Boolean(selectedProvider && embeddedProvider && selectedProvider !== embeddedProvider),
      embeddedProvider
    };
  }

  function providerHasModel(providers, providerId, modelId) {
    const provider = providers && providers[providerId];
    if (!provider || !Array.isArray(provider.models)) return false;
    return provider.models.some((model) => String(model && (model.id || model.name) || '').trim() === modelId);
  }

  function inferUniqueProvider(providers, modelId) {
    const matches = Object.keys(providers || {}).filter((providerId) => providerHasModel(providers, providerId, modelId));
    return matches.length === 1 ? matches[0] : '';
  }

  function validateProviders(providers) {
    const errors = [];
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
      return { ok: false, errors: ['模型提供商配置为空'] };
    }
    for (const [providerId, provider] of Object.entries(providers)) {
      if (!/^[a-z0-9_-]{1,64}$/.test(providerId)) {
        errors.push(`提供商标识 ${providerId || '(空)'} 格式无效`);
        continue;
      }
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        errors.push(`提供商 ${providerId} 配置无效`);
        continue;
      }
      const baseUrl = String(provider.baseUrl || '').trim();
      try {
        const parsedUrl = new URL(baseUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('protocol');
      } catch (_) {
        errors.push(`提供商 ${providerId} 的 Base URL 无效`);
      }
      const seen = new Set();
      const models = Array.isArray(provider.models) ? provider.models : [];
      models.forEach((model, index) => {
        const modelId = String(model && (model.id || model.name) || '').trim();
        if (!modelId) {
          errors.push(`提供商 ${providerId} 的第 ${index + 1} 个模型 ID 为空`);
          return;
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(modelId)) {
          errors.push(`提供商 ${providerId} 的模型 ID ${modelId} 格式无效`);
        }
        if (seen.has(modelId)) errors.push(`提供商 ${providerId} 存在重复模型 ${modelId}`);
        seen.add(modelId);
        if (model.contextWindow !== undefined) {
          const contextWindow = Number(model.contextWindow);
          if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
            errors.push(`提供商 ${providerId} 的模型 ${modelId} 上下文窗口无效`);
          }
        }
      });
    }
    return { ok: errors.length === 0, errors };
  }

  function omitBlankProviderApiKeys(providers) {
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return providers;
    for (const provider of Object.values(providers)) {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) continue;
      if (Object.prototype.hasOwnProperty.call(provider, 'apiKey')
        && String(provider.apiKey == null ? '' : provider.apiKey).trim() === '') {
        delete provider.apiKey;
      }
    }
    return providers;
  }

  function validateRoute(routeName, provider, modelInput, providers, options = {}) {
    const optional = options.optional === true;
    const selectedProvider = String(provider || '').trim();
    const rawModel = String(modelInput || '').trim();
    if (optional && !selectedProvider && !rawModel) {
      return { ok: true, provider: '', model: '', ref: '', errors: [], warnings: [] };
    }

    const resolved = composeModelRef(selectedProvider, rawModel);
    const errors = [];
    const warnings = [];
    const label = routeName || '模型';
    if (!resolved.provider) errors.push(`${label}未选择提供商`);
    if (!resolved.model) errors.push(`${label}未选择模型`);
    if (resolved.conflict) {
      errors.push(`${label}输入的提供商 ${resolved.embeddedProvider} 与下拉选择 ${selectedProvider} 不一致`);
    }
    if (resolved.provider && (!providers || !providers[resolved.provider])) {
      errors.push(`${label}提供商 ${resolved.provider} 不存在`);
    }
    const allowedProviders = Array.isArray(options.allowedProviders) ? options.allowedProviders : [];
    if (resolved.provider && allowedProviders.length && !allowedProviders.includes(resolved.provider)) {
      errors.push(`${label}提供商 ${resolved.provider} 在当前模式下不可用`);
    }
    if (resolved.model && isNonChatModelId(resolved.model)) {
      errors.push(`${label}不能使用图片、视频或向量模型`);
    }
    if (resolved.provider && resolved.model && providers && providers[resolved.provider]
      && !providerHasModel(providers, resolved.provider, resolved.model)) {
      warnings.push(`${label} ${resolved.ref} 不在该提供商的模型白名单中`);
    }
    return { ...resolved, ok: errors.length === 0, errors, warnings };
  }

  function validateRoutingForm(input = {}) {
    const providers = input.providers || {};
    const allowedProviders = input.allowedProviders || [];
    const primary = validateRoute('主用模型', input.primaryProvider, input.primaryModel, providers, { allowedProviders });
    const fallbackEnabled = input.fallbackEnabled === true;
    const fallback = validateRoute('备用模型', fallbackEnabled ? input.fallbackProvider : '', fallbackEnabled ? input.fallbackModel : '', providers, {
      allowedProviders,
      optional: !fallbackEnabled
    });
    const errors = [...primary.errors, ...fallback.errors];
    const warnings = [...primary.warnings, ...fallback.warnings];
    if (fallbackEnabled && primary.ref && fallback.ref && primary.ref === fallback.ref) {
      errors.push('备用模型不能与主用模型相同');
    }
    return {
      ok: errors.length === 0,
      primary,
      fallback,
      errors,
      warnings,
      primaryRef: primary.ref,
      fallbackRefs: fallbackEnabled && fallback.ref ? [fallback.ref] : []
    };
  }

  function normalizeConfigRouting(config, options = {}) {
    if (!config || typeof config !== 'object') throw new Error('配置内容无效');
    const providers = config.models && config.models.providers;
    const defaults = config.agents && config.agents.defaults;
    const modelConfig = defaults && defaults.model;
    const providersValidation = validateProviders(providers);
    if (!providersValidation.ok) throw new Error(providersValidation.errors.join('；'));
    omitBlankProviderApiKeys(providers);
    if (!modelConfig || typeof modelConfig !== 'object') throw new Error('默认模型配置为空');

    let primaryRaw = String(modelConfig.primary || '').trim();
    let fallbackRaw = Array.isArray(modelConfig.fallbacks)
      ? modelConfig.fallbacks.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    if (options.inferLegacyRefs === true) {
      const migrateRef = (value) => {
        const parsed = parseModelRef(value);
        if (parsed.provider || !parsed.model) return value;
        const inferredProvider = inferUniqueProvider(providers, parsed.model);
        return inferredProvider ? `${inferredProvider}/${parsed.model}` : value;
      };
      primaryRaw = migrateRef(primaryRaw);
      fallbackRaw = fallbackRaw.map(migrateRef);
    }
    const primaryParsed = parseModelRef(primaryRaw);
    const firstFallback = parseModelRef(fallbackRaw[0] || '');
    const checked = validateRoutingForm({
      providers,
      allowedProviders: options.allowedProviders || [],
      primaryProvider: primaryParsed.provider,
      primaryModel: primaryParsed.model,
      fallbackEnabled: Boolean(firstFallback.ref),
      fallbackProvider: firstFallback.provider,
      fallbackModel: firstFallback.model
    });
    if (!checked.ok) throw new Error(checked.errors.join('；'));

    modelConfig.primary = checked.primaryRef;
    const normalizedFallbacks = [];
    for (const fallbackRef of fallbackRaw) {
      const parsed = parseModelRef(fallbackRef);
      const route = validateRoute('备用模型', parsed.provider, parsed.model, providers, {
        allowedProviders: options.allowedProviders || []
      });
      if (!route.ok) throw new Error(route.errors.join('；'));
      if (route.ref !== modelConfig.primary && !normalizedFallbacks.includes(route.ref)) {
        normalizedFallbacks.push(route.ref);
      }
    }
    modelConfig.fallbacks = normalizedFallbacks;
    return { config, primary: modelConfig.primary, fallbacks: normalizedFallbacks, warnings: checked.warnings };
  }

  return {
    BUILTIN_ALLOWED_PROVIDERS,
    DEFAULT_PRIMARY,
    DEFAULT_FALLBACK,
    parseModelRef,
    isNonChatModelId,
    composeModelRef,
    providerHasModel,
    inferUniqueProvider,
    validateProviders,
    omitBlankProviderApiKeys,
    validateRoute,
    validateRoutingForm,
    normalizeConfigRouting
  };
});
