'use strict';
/**
 * 多用户 / 多机 / 云电脑：插件路径与官方 installs 自愈。
 * 目标：任一用户在任意 Windows（家用、无影、RDS、公司锁盘）上开箱可加载渠道插件，
 * 不依赖从「某台开发机」拷贝绝对路径。
 */
const path = require('path');
const fs = require('fs');

function norm(p) {
    return path.resolve(String(p || '')).toLowerCase().replace(/\//g, '\\');
}

function underRoot(target, root) {
    if (!target || !root) return false;
    const t = norm(target);
    const r = norm(root);
    return t === r || t.startsWith(r.endsWith('\\') ? r : r + '\\');
}

/**
 * 路径是否还能在本机当前安装/账户上下文使用。
 * 拒绝：不存在、他人 Users 目录、旧开发机绝对路径等。
 */
function isPluginPathStaleOnThisMachine(pluginPath, ctx = {}) {
    const p = String(pluginPath || '');
    if (!p) return true;
    const normalizedRaw = p.toLowerCase().replace(/\//g, '\\');
    if (normalizedRaw.includes('\\resources\\app.asar\\node_modules\\')) return true;
    if (normalizedRaw.includes('\\clawai\\nexora agent\\resources\\app.asar\\')) return true;

    const {
        userProfile = process.env.USERPROFILE || process.env.HOME || '',
        configDir = '',
        appRoot = '',
        isForeignUserPath = () => false
    } = ctx;

    if (typeof isForeignUserPath === 'function' && isForeignUserPath(p)) return true;

    try {
        if (!fs.existsSync(p)) return true;
        const stat = fs.statSync(p);
        if (stat.isDirectory() && !fs.existsSync(path.join(p, 'package.json'))) return true;
    } catch (e) {
        return true;
    }

    // 相对路径交给 OpenClaw/调用方解释；此处只拦绝对路径野指针
    if (!path.isAbsolute(p)) return false;

    const allowedRoots = [];
    if (configDir) allowedRoots.push(configDir);
    if (userProfile) allowedRoots.push(path.join(userProfile, '.openclaw'));
    if (appRoot) allowedRoots.push(appRoot);
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    allowedRoots.push(path.join(pf, 'Nexora Agent'));
    allowedRoots.push(path.join(pf86, 'Nexora Agent'));
    // Program Files 通用软件目录下的 resources\app
    allowedRoots.push(path.join(pf, 'Nexora Agent', 'resources', 'app'));

    if (allowedRoots.some((root) => underRoot(p, root))) return false;

    // 允许当前用户主目录下任意 .openclaw / Desktop 安装副本（存在性已校验）
    if (userProfile && underRoot(p, userProfile)) return false;

    // 其它盘符/其它用户绝对路径：换机后常见野指针
    return true;
}

function looksLikeOfficialOpenClawChannelPath(p) {
    return /[\\/]@openclaw[\\/](feishu|qqbot|slack|whatsapp|matrix|voice-call)(?:[\\/]|$)/i.test(String(p || ''));
}

/**
 * 统一清洗 plugins.load.paths / installs：丢掉野指针，官方渠道路径不进 load.paths。
 * @returns {{ config: object, changed: boolean, droppedPaths: string[], notes: string[] }}
 */
function sanitizePluginPathsForThisMachine(config, ctx = {}) {
    const notes = [];
    const droppedPaths = [];
    let changed = false;
    if (!config || typeof config !== 'object') {
        return { config, changed: false, droppedPaths, notes: ['no-config'] };
    }
    if (!config.plugins) config.plugins = {};
    if (!Array.isArray(config.plugins.load?.paths)) {
        if (!config.plugins.load) config.plugins.load = {};
        config.plugins.load.paths = [];
        changed = true;
    }
    if (!config.plugins.installs) config.plugins.installs = {};

    const nextPaths = [];
    for (const p of config.plugins.load.paths) {
        if (typeof p !== 'string') {
            changed = true;
            continue;
        }
        try {
            const stat = fs.existsSync(p) ? fs.statSync(p) : null;
            if (!stat || (stat.isDirectory() && !fs.existsSync(path.join(p, 'package.json')))) {
                droppedPaths.push(p);
                changed = true;
                notes.push('drop-missing-load-path');
                continue;
            }
        } catch (e) {
            droppedPaths.push(p);
            changed = true;
            notes.push('drop-unreadable-load-path');
            continue;
        }
        if (looksLikeOfficialOpenClawChannelPath(p)) {
            droppedPaths.push(p);
            changed = true;
            notes.push('drop-official-from-load-paths');
            continue;
        }
        if (isPluginPathStaleOnThisMachine(p, ctx)) {
            droppedPaths.push(p);
            changed = true;
            notes.push('drop-stale-load-path');
            continue;
        }
        nextPaths.push(p);
    }
    if (JSON.stringify(nextPaths) !== JSON.stringify(config.plugins.load.paths)) {
        config.plugins.load.paths = nextPaths;
        changed = true;
    }

    for (const [pluginId, rec] of Object.entries(config.plugins.installs)) {
        if (!rec || typeof rec !== 'object') continue;
        const ip = rec.installPath;
        if (!ip) continue;
        if (isPluginPathStaleOnThisMachine(ip, ctx)) {
            delete config.plugins.installs[pluginId];
            changed = true;
            droppedPaths.push(ip);
            notes.push(`drop-stale-install:${pluginId}`);
        }
    }

    return { config, changed, droppedPaths, notes };
}

module.exports = {
    isPluginPathStaleOnThisMachine,
    looksLikeOfficialOpenClawChannelPath,
    sanitizePluginPathsForThisMachine,
    underRoot
};
