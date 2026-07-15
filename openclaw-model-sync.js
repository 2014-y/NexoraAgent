'use strict';
/**
 * 默认模型 → 沙箱 OpenClaw 会话同步。
 * OpenClaw 对话会把 model/modelProvider（及 modelOverride）粘在 sessions.json，
 * 只改 openclaw.json 的 agents.defaults.model 不会让已有网关会话换模型。
 */

const fs = require('fs');
const path = require('path');

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

function shouldUpdateSessionKey(key) {
    const k = String(key || '');
    // 主会话 + Control UI / OpenClaw 面板会话
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

/**
 * 把默认主模型写进沙箱 OpenClaw 会话（清除 override，避免面板仍用旧模型）。
 * @returns {{ changed: boolean, updated: number, path?: string }}
 */
function applyDefaultModelToSessions(stateDir, primaryModel) {
    const parsed = parseProviderModel(primaryModel);
    if (!parsed || !parsed.model || !stateDir) {
        return { changed: false, updated: 0 };
    }

    const sessionsPath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
    if (!fs.existsSync(sessionsPath)) {
        return { changed: false, updated: 0, path: sessionsPath };
    }

    let raw = fs.readFileSync(sessionsPath, 'utf8').replace(/^\uFEFF/, '');
    let data;
    try {
        data = JSON.parse(raw);
    } catch (e) {
        const idx = raw.lastIndexOf('}');
        if (idx < 0) throw e;
        data = JSON.parse(raw.slice(0, idx + 1));
    }

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

/**
 * 把主配置的默认模型/供应商同步到其它可能被旧沙箱读到的 openclaw.json。
 * 只改 model 相关字段，保留对方 gateway.auth 等。
 */
function syncModelConfigToStateDirs(stateDirs, sourceConfig, primaryStateDir) {
    const synced = [];
    if (!sourceConfig || typeof sourceConfig !== 'object') return synced;

    const primary = sourceConfig.agents
        && sourceConfig.agents.defaults
        && sourceConfig.agents.defaults.model
        && sourceConfig.agents.defaults.model.primary;

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

            // 主目录已由调用方写完整文件；这里只修旁路目录 + 总会话
            if (dir !== primaryResolved) {
                let raw = fs.readFileSync(cf, 'utf8').replace(/^\uFEFF/, '');
                let cfg;
                try {
                    cfg = JSON.parse(raw);
                } catch (e) {
                    const idx = raw.lastIndexOf('}');
                    if (idx < 0) continue;
                    cfg = JSON.parse(raw.slice(0, idx + 1));
                }

                let changed = false;
                if (!cfg.agents) { cfg.agents = {}; changed = true; }
                if (!cfg.agents.defaults) { cfg.agents.defaults = {}; changed = true; }
                if (!cfg.agents.defaults.model) { cfg.agents.defaults.model = {}; changed = true; }

                const srcModel = sourceConfig.agents && sourceConfig.agents.defaults && sourceConfig.agents.defaults.model;
                if (srcModel) {
                    const before = JSON.stringify(cfg.agents.defaults.model);
                    cfg.agents.defaults.model = {
                        ...cfg.agents.defaults.model,
                        primary: srcModel.primary,
                        fallbacks: Array.isArray(srcModel.fallbacks) ? srcModel.fallbacks : cfg.agents.defaults.model.fallbacks
                    };
                    if (JSON.stringify(cfg.agents.defaults.model) !== before) changed = true;
                }

                if (sourceConfig.models && sourceConfig.models.providers) {
                    if (!cfg.models) cfg.models = {};
                    const before = JSON.stringify(cfg.models.providers || {});
                    cfg.models.providers = JSON.parse(JSON.stringify(sourceConfig.models.providers));
                    if (JSON.stringify(cfg.models.providers) !== before) changed = true;
                }

                if (sourceConfig.env && typeof sourceConfig.env === 'object') {
                    if (!cfg.env) cfg.env = {};
                    for (const [k, v] of Object.entries(sourceConfig.env)) {
                        if (/_API_KEY$/i.test(k) && v != null && cfg.env[k] !== v) {
                            cfg.env[k] = v;
                            changed = true;
                        }
                    }
                }

                if (changed) {
                    fs.writeFileSync(cf, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
                    synced.push(dir);
                }
            }

            if (primary) {
                applyDefaultModelToSessions(dir, primary);
            }
        } catch (e) {
            // 忽略单个目录失败
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
