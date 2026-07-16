'use strict';
/**
 * 统一解析 OpenClaw 状态目录（多用户 / 云电脑安全）。
 * 优先环境变量（Electron 主进程 / patch_gateway 会注入），避免硬编码 Users\某人。
 *
 * 同时提供「子进程家目录锁定」逻辑，供 patch_gateway.js 与主进程共用，
 * 杜绝零环境新电脑上主进程 CONFIG_DIR 与沙箱 Gateway 读不同 openclaw.json。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

function isTempLikePath(p) {
    const n = String(p || '').toLowerCase().replace(/\//g, '\\');
    return (
        n.includes('\\temp\\') ||
        n.includes('\\tmp\\') ||
        n.includes('\\appdata\\local\\temp') ||
        /\\temp\\\d+(\\|$)/.test(n)
    );
}

/** 仅会话 Temp（\Temp\1）；标准 Local\Temp 不算 */
function isSessionTempPath(p) {
    const n = String(p || '').toLowerCase().replace(/\//g, '\\');
    return /\\temp\\\d+(\\|$)/.test(n);
}

/**
 * 与 home-resolve.detectRestrictedDesktop 对齐：
 * 不要把普通 %TEMP% / 单纯 RDP CLIENTNAME 当成云桌面。
 */
function detectCloudishEnv(env = process.env) {
    if (isTempLikePath(env.REAL_USER_HOME) || isTempLikePath(env.USERPROFILE) || isTempLikePath(env.HOME)) {
        return true;
    }
    if (isSessionTempPath(env.TEMP) || isSessionTempPath(env.TMP)) return true;
    for (const [k, v] of Object.entries(env)) {
        const kv = `${k}=${v}`;
        if (/wuying|eds_?desktop|aliyun.*desktop|clouddesktop|citrix|vmware.?horizon|huawei.?workspace|tencent.?desk|aws.?workspaces|aspace|yunding/i.test(kv)) {
            return true;
        }
    }
    return false;
}

function resolveOpenClawHome(env = process.env) {
    if (env.OPENCLAW_HOME && String(env.OPENCLAW_HOME).trim()) {
        return path.resolve(String(env.OPENCLAW_HOME).trim());
    }
    if (env.REAL_USER_HOME && String(env.REAL_USER_HOME).trim()) {
        return path.resolve(String(env.REAL_USER_HOME).trim());
    }
    const profile = env.USERPROFILE || env.HOME || '';
    if (profile) return path.resolve(profile);
    try {
        return path.resolve(os.homedir());
    } catch (e) {
        return path.resolve(process.cwd());
    }
}

function resolveOpenClawStateDir(env = process.env) {
    if (env.OPENCLAW_STATE_DIR && String(env.OPENCLAW_STATE_DIR).trim()) {
        return path.resolve(String(env.OPENCLAW_STATE_DIR).trim());
    }
    return path.join(resolveOpenClawHome(env), '.openclaw');
}

function resolveLearningDataDir(env = process.env) {
    return path.join(resolveOpenClawStateDir(env), 'workspace', 'learning_data');
}

function defaultCanWriteOpenClawHome(base) {
    try {
        const sessionsDir = path.join(base, '.openclaw', 'agents', 'main', 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        const tmp = path.join(sessionsDir, `.home-probe-${process.pid}.tmp`);
        const dst = path.join(sessionsDir, `.home-probe-${process.pid}.json`);
        fs.writeFileSync(tmp, '{"ok":1}');
        try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (e) {}
        fs.renameSync(tmp, dst);
        try { fs.unlinkSync(dst); } catch (e) {}
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * 沙箱 Gateway / patch 用：锁定家目录。
 * 规则：主进程已注入的 OPENCLAW_HOME / STATE_DIR 绝对优先，禁止再「聪明重算」导致配置分叉。
 */
function resolveLockedOpenClawHome(env = process.env, opts = {}) {
    const canWrite = opts.canWrite || defaultCanWriteOpenClawHome;
    const originalHomedir = opts.originalHomedir || (() => {
        try { return os.homedir(); } catch (e) { return ''; }
    });

    const presetHome =
        (env.OPENCLAW_HOME && String(env.OPENCLAW_HOME).trim()) ||
        (env.REAL_USER_HOME && String(env.REAL_USER_HOME).trim()) ||
        '';
    if (presetHome && !isTempLikePath(presetHome) && canWrite(presetHome)) {
        return path.resolve(presetHome);
    }

    if (env.OPENCLAW_STATE_DIR) {
        const parent = path.dirname(String(env.OPENCLAW_STATE_DIR));
        if (parent && !isTempLikePath(parent) && canWrite(parent)) {
            return path.resolve(parent);
        }
    }

    const candidates = [];
    const push = (p) => {
        if (!p) return;
        const r = path.resolve(String(p));
        if (!candidates.includes(r)) candidates.push(r);
    };

    const cloudish = detectCloudishEnv(env);
    if (cloudish) {
        if (env.LOCALAPPDATA) push(path.join(env.LOCALAPPDATA, 'NexoraAgent'));
        if (env.APPDATA) push(path.join(env.APPDATA, 'NexoraAgent'));
        try { if (fs.existsSync('D:\\')) push('D:\\NexoraAgent-data'); } catch (e) {}
        try { if (fs.existsSync('E:\\')) push('E:\\NexoraAgent-data'); } catch (e) {}
        try {
            const exeDir = path.dirname(process.execPath || '');
            if (exeDir && !exeDir.toLowerCase().includes('system32')) push(path.join(exeDir, 'data'));
        } catch (e) {}
        if (env.ProgramData && env.USERNAME) push(path.join(env.ProgramData, 'NexoraAgent', String(env.USERNAME)));
        push(path.join('C:\\Users\\Public', 'NexoraAgent', String(env.USERNAME || 'user')));
        push(env.REAL_USER_HOME);
        push(env.USERPROFILE);
        push(env.HOME);
        try { push(originalHomedir()); } catch (e) {}
    } else {
        push(env.REAL_USER_HOME);
        push(env.USERPROFILE);
        push(env.HOME);
        try { push(originalHomedir()); } catch (e) {}
        if (env.LOCALAPPDATA) push(path.join(env.LOCALAPPDATA, 'NexoraAgent'));
        if (env.APPDATA) push(path.join(env.APPDATA, 'NexoraAgent'));
        try { if (fs.existsSync('D:\\')) push('D:\\NexoraAgent-data'); } catch (e) {}
        try {
            const exeDir = path.dirname(process.execPath || '');
            if (exeDir && !exeDir.toLowerCase().includes('system32')) push(path.join(exeDir, 'data'));
        } catch (e) {}
        if (env.ProgramData && env.USERNAME) push(path.join(env.ProgramData, 'NexoraAgent', String(env.USERNAME)));
        push(path.join('C:\\Users\\Public', 'NexoraAgent', String(env.USERNAME || 'user')));
    }
    push(path.join(os.tmpdir(), 'NexoraAgent-home'));

    for (const c of candidates) {
        if (isTempLikePath(c) && !String(c).toLowerCase().includes('nexoraagent-home')) continue;
        if (canWrite(c)) return c;
    }
    for (const c of candidates) {
        if (canWrite(c)) return c;
    }
    return path.resolve(env.REAL_USER_HOME || originalHomedir() || process.cwd());
}

/** 已知可能残留的状态目录（旧 bug 双写），用于鉴权同步 */
function listKnownOpenClawStateDirs(env = process.env, primaryStateDir = null) {
    const dirs = [];
    const push = (d) => {
        if (!d) return;
        const r = path.resolve(String(d));
        if (!dirs.includes(r)) dirs.push(r);
    };
    if (primaryStateDir) push(primaryStateDir);
    if (env.OPENCLAW_STATE_DIR) push(env.OPENCLAW_STATE_DIR);
    if (env.OPENCLAW_HOME) push(path.join(env.OPENCLAW_HOME, '.openclaw'));
    if (env.REAL_USER_HOME) push(path.join(env.REAL_USER_HOME, '.openclaw'));
    // 未改写前的真实用户目录（fork 前主进程仍可读）
    const rawProfile = env.NEXORA_AGENT_ORIGINAL_USERPROFILE || '';
    if (rawProfile) push(path.join(rawProfile, '.openclaw'));
    if (env.LOCALAPPDATA) push(path.join(env.LOCALAPPDATA, 'NexoraAgent', '.openclaw'));
    if (env.APPDATA) push(path.join(env.APPDATA, 'NexoraAgent', '.openclaw'));
    return dirs;
}

module.exports = {
    isTempLikePath,
    isSessionTempPath,
    detectCloudishEnv,
    resolveOpenClawHome,
    resolveOpenClawStateDir,
    resolveLearningDataDir,
    resolveLockedOpenClawHome,
    listKnownOpenClawStateDirs,
    defaultCanWriteOpenClawHome
};
