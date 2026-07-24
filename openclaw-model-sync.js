'use strict';
/**
 * Sync default model settings into OpenClaw state directories.
 * OpenClaw sessions can keep sticky model/provider overrides, so changing only
 * openclaw.json is not enough for already-created gateway sessions.
 */

const fs = require('fs');
const path = require('path');
const { ensureVisionModelConfig } = require('./vision-model-config');

function parseProviderModel(primary) {
    const s = String(primary || '').trim();
    if (!s) return null;
    const idx = s.indexOf('/');
    if (idx <= 0) return { provider: '', model: s, primary: s };
    return {
        provider: s.slice(0, idx).trim(),
        model: s.slice(idx + 1).trim(),
        primary: s
    };
}

function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function jsonChanged(a, b) {
    return JSON.stringify(a) !== JSON.stringify(b);
}

function shouldUpdateSessionKey(key) {
    const k = String(key || '');
    if (k === 'agent:main:main') return true;
    if (k.startsWith('agent:main:dashboard:')) return true;
    if (/^agent:main:main(?:-|$)/.test(k)) return true;
    return false;
}

function stripStickyModelOverrides(entry) {
    if (!entry || typeof entry !== 'object') return;
    delete entry.modelOverride;
    delete entry.providerOverride;
    delete entry.modelOverrideSource;
    delete entry.modelOverrideFallbackOriginProvider;
    delete entry.modelOverrideFallbackOriginModel;
    delete entry.fallbackNoticeSelectedModel;
    delete entry.fallbackNoticeActiveModel;
    delete entry.authProfileOverride;
    delete entry.authProfileOverrideSource;
    delete entry.authProfileOverrideCompactionCount;
}

function readJsonLenient(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    try {
        return JSON.parse(raw);
    } catch (e) {
        const idx = raw.lastIndexOf('}');
        if (idx < 0) throw e;
        return JSON.parse(raw.slice(0, idx + 1));
    }
}

function applyDefaultModelToSessions(stateDir, primaryModel) {
    const parsed = parseProviderModel(primaryModel);
    if (!parsed || !parsed.model || !stateDir) {
        return { changed: false, updated: 0 };
    }

    const sessionsPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    if (!fs.existsSync(sessionsPath)) {
        return { changed: false, updated: 0, path: sessionsPath };
    }

    const data = readJsonLenient(sessionsPath);
    const hasWrapper = data && typeof data === 'object' && data.sessions && typeof data.sessions === 'object';
    const entries = hasWrapper ? data.sessions : data;
    if (!entries || typeof entries !== 'object') {
        return { changed: false, updated: 0, path: sessionsPath };
    }

    let updated = 0;
    for (const [key, entry] of Object.entries(entries)) {
        if (!shouldUpdateSessionKey(key)) continue;
        if (!entry || typeof entry !== 'object') continue;

        const before = JSON.stringify({
            model: entry.model,
            modelProvider: entry.modelProvider,
            modelOverride: entry.modelOverride,
            providerOverride: entry.providerOverride,
            authProfileOverride: entry.authProfileOverride
        });

        stripStickyModelOverrides(entry);
        entry.model = parsed.model;
        if (parsed.provider) entry.modelProvider = parsed.provider;
        else delete entry.modelProvider;

        const after = JSON.stringify({
            model: entry.model,
            modelProvider: entry.modelProvider,
            modelOverride: entry.modelOverride,
            providerOverride: entry.providerOverride,
            authProfileOverride: entry.authProfileOverride
        });
        if (before !== after) updated += 1;
    }

    if (updated > 0) {
        const out = hasWrapper ? data : entries;
        fs.writeFileSync(sessionsPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
    }

    return { changed: updated > 0, updated, path: sessionsPath };
}

function syncAgentDefaults(cfg, sourceConfig) {
    let changed = false;
    if (!cfg.agents) { cfg.agents = {}; changed = true; }
    if (!cfg.agents.defaults) { cfg.agents.defaults = {}; changed = true; }

    const srcDefaults = sourceConfig.agents && sourceConfig.agents.defaults;
    if (!srcDefaults) return changed;

    if (srcDefaults.model) {
        if (!cfg.agents.defaults.model) cfg.agents.defaults.model = {};
        const before = cloneJson(cfg.agents.defaults.model);
        cfg.agents.defaults.model = {
            ...cfg.agents.defaults.model,
            primary: srcDefaults.model.primary,
            fallbacks: Array.isArray(srcDefaults.model.fallbacks)
                ? cloneJson(srcDefaults.model.fallbacks)
                : cfg.agents.defaults.model.fallbacks
        };
        if (jsonChanged(before, cfg.agents.defaults.model)) changed = true;
    }

    for (const key of ['imageModel', 'imageGenerationModel', 'videoGenerationModel']) {
        if (!srcDefaults[key]) continue;
        const before = cloneJson(cfg.agents.defaults[key]);
        cfg.agents.defaults[key] = cloneJson(srcDefaults[key]);
        if (jsonChanged(before, cfg.agents.defaults[key])) changed = true;
    }

    return changed;
}

function syncModelConfigToStateDirs(stateDirs, sourceConfig, primaryStateDir) {
    const synced = [];
    if (!sourceConfig || typeof sourceConfig !== 'object') return synced;

    const preparedSource = ensureVisionModelConfig(cloneJson(sourceConfig)).config;
    const primary = preparedSource.agents
        && preparedSource.agents.defaults
        && preparedSource.agents.defaults.model
        && preparedSource.agents.defaults.model.primary;

    const uniq = [];
    for (const dir of stateDirs || []) {
        if (!dir) continue;
        const r = path.resolve(String(dir));
        if (!uniq.includes(r)) uniq.push(r);
    }

    const primaryResolved = primaryStateDir ? path.resolve(String(primaryStateDir)) : '';

    for (const dir of uniq) {
        const cf = path.join(dir, 'openclaw.json');
        try {
            if (!fs.existsSync(cf)) continue;

            if (dir !== primaryResolved) {
                const cfg = readJsonLenient(cf);
                let changed = false;

                if (syncAgentDefaults(cfg, preparedSource)) changed = true;

                if (preparedSource.models && preparedSource.models.providers) {
                    if (!cfg.models) cfg.models = {};
                    const before = cloneJson(cfg.models.providers || {});
                    cfg.models.providers = cloneJson(preparedSource.models.providers);
                    if (jsonChanged(before, cfg.models.providers)) changed = true;
                }

                if (preparedSource.tools && preparedSource.tools.media) {
                    if (!cfg.tools) cfg.tools = {};
                    const before = cloneJson(cfg.tools.media);
                    cfg.tools.media = cloneJson(preparedSource.tools.media);
                    if (jsonChanged(before, cfg.tools.media)) changed = true;
                }

                if (preparedSource.env && typeof preparedSource.env === 'object') {
                    if (!cfg.env) cfg.env = {};
                    for (const [k, v] of Object.entries(preparedSource.env)) {
                        if (/_API_KEY$/i.test(k) && v != null && cfg.env[k] !== v) {
                            cfg.env[k] = v;
                            changed = true;
                        }
                    }
                }

                const vision = ensureVisionModelConfig(cfg);
                changed = vision.changed || changed;

                if (changed) {
                    fs.writeFileSync(cf, JSON.stringify(vision.config, null, 2) + '\n', 'utf8');
                    synced.push(dir);
                }
            }

            if (primary) {
                applyDefaultModelToSessions(dir, primary);
            }
        } catch (e) {
            // Ignore a single broken state directory and keep syncing the rest.
        }
    }

    return synced;
}

module.exports = {
    parseProviderModel,
    shouldUpdateSessionKey,
    applyDefaultModelToSessions,
    syncModelConfigToStateDirs
};
