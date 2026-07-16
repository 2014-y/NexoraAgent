'use strict';
/**
 * OpenClaw 家目录解析（兼容：家用电脑 + 各类云电脑 + 极端锁盘）
 *
 * 降级链（从前到后）：
 *  真实用户目录 → Local/Roaming AppData\NexoraAgent → D/E:\NexoraAgent-data
 *  → 安装目录\data（便携） → ProgramData\NexoraAgent\<用户> → Public\NexoraAgent
 *  → Temp\NexoraAgent-home（最后手段，会标 critical 并提示用户）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

function isTempLikePath(p) {
    const n = String(p || '').toLowerCase().replace(/\//g, '\\');
    return (
        n.includes('\\temp\\') ||
        n.includes('\\tmp\\') ||
        n.includes('\\appdata\\local\\temp') ||
        /\\temp\\\d+(\\|$)/.test(n)
    );
}

/** 仅会话 Temp（\Temp\1）；标准 %LOCALAPPDATA%\Temp 不算 */
function isSessionTempPath(p) {
    const n = String(p || '').toLowerCase().replace(/\//g, '\\');
    return /\\temp\\\d+(\\|$)/.test(n);
}

function safeUsername(env = process.env) {
    const raw = String(env.USERNAME || env.USER || env.LOGNAME || 'user').trim() || 'user';
    return raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 64);
}

/** 探测是否像云桌面/RDS/无影等受限环境 */
function detectRestrictedDesktop(env = process.env) {
    const hints = [];
    const sessionName = String(env.SESSIONNAME || '');
    if (/^rdp-/i.test(sessionName) || /rdp/i.test(sessionName)) hints.push('rdp-session');
    if (env.CLIENTNAME) hints.push('thin-client');
    // session-temp：仅当 TEMP 含会话编号后缀（\Temp\1、\Temp\2）时才计入。
    // 标准 Windows TEMP（%USERPROFILE%\AppData\Local\Temp）几乎所有电脑都有，
    // 不应触发 restricted，否则会导致 HOME 被错误重定向到 AppData\Local\NexoraAgent，
    // 进而引发 token 不同步、EPERM、渠道插件全不加载等连锁故障。
    const tempVal = String(env.TEMP || env.TMP || '').toLowerCase().replace(/\//g, '\\');
    if (isSessionTempPath(tempVal)) hints.push('session-temp');

    const user = String(env.USERNAME || env.USER || '').toLowerCase();
    // 无影/云电脑常见默认用户名 + 会话特征
    if (user === 'admin' || user === 'administrator' || user === 'user' || user === 'wuying') {
        if (/^rdp-/i.test(sessionName) || env.CLIENTNAME || env.EDS_DESKTOP || env.WY_SESSION) {
            hints.push('cloud-default-user');
        }
    }

    let hasExplicitCloudEnv = false;
    for (const [k, v] of Object.entries(env)) {
        const kv = `${k}=${v}`;
        if (/wuying|eds_?desktop|aliyun.*desktop|clouddesktop|citrix|vmware.?horizon|huawei.?workspace|tencent.?desk|aws.?workspaces|aspace|yunding/i.test(kv)) {
            hints.push('cloud-desktop-env');
            hasExplicitCloudEnv = true;
            break;
        }
    }

    // 真正的受限云桌面通常带有强烈的多会话/专有变量特征。
    // 如果只是普通用户用 Windows 自带的 Remote Desktop (RDP) 连接家用电脑，
    // 不应直接判定为受限环境，否则会导致正常 RDP 用户的目录被强行重定向到 AppData 从而引发 EPERM。
    const isSessionTemp = isSessionTempPath(tempVal);
    const restricted = hasExplicitCloudEnv || isSessionTemp;

    // D 盘存在仅作为辅助信号
    try {
        if (hints.length > 0 && fs.existsSync('D:\\') && fs.statSync('D:\\').isDirectory()) hints.push('data-disk-d');
    } catch (e) {}

    return { restricted, hints };
}

/** 路径是否指向「另一台电脑/另一个用户」的配置（无影拷贝本机配置时最常见） */
function isForeignUserPath(p, env = process.env) {
    let s = String(p || '');
    try {
        if (fs.existsSync(s)) {
            s = fs.realpathSync(s);
        }
    } catch (e) {}
    const m = s.match(/[\\/]Users[\\/]([^\\/]+)[\\/]/i);
    if (!m) return false;
    const pathUser = String(m[1] || '').toLowerCase();
    const current = safeUsername(env).toLowerCase();
    if (!pathUser || !current) return false;
    if (pathUser === current) return false;
    
    // 兼容 Windows 8.3 短文件名 (例如 admini~1 与 administrator)
    if (current.length >= 6 && pathUser.includes('~')) {
        const shortPart = pathUser.split('~')[0];
        if (current.startsWith(shortPart)) return false;
    }
    if (pathUser.length >= 6 && current.includes('~')) {
        const shortPart = current.split('~')[0];
        if (pathUser.startsWith(shortPart)) return false;
    }

    // Public / Default 不算「别人的配置家目录」
    if (pathUser === 'public' || pathUser === 'default' || pathUser === 'default user' || pathUser === 'all users') {
        return false;
    }
    return true;
}

/**
 * 深度可写探测：创建/写入/改名（贴近 sessions.json 提交）
 */
function probeOpenClawHomeWritable(baseHome, fsImpl = fs) {
    if (!baseHome) return false;
    const sessionsDir = path.join(baseHome, '.openclaw', 'agents', 'main', 'sessions');
    const promptsDir = path.join(sessionsDir, 'skills-prompts');
    const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const testFile = path.join(promptsDir, `.write-test-${stamp}`);
    const jsonTmp = path.join(sessionsDir, `.sessions-probe-${stamp}.tmp`);
    const jsonDst = path.join(sessionsDir, `.sessions-probe-${stamp}.json`);
    try {
        fsImpl.mkdirSync(promptsDir, { recursive: true });
        fsImpl.writeFileSync(testFile, 'test-write', 'utf8');
        fsImpl.unlinkSync(testFile);
        fsImpl.writeFileSync(jsonTmp, JSON.stringify({ ok: true, t: Date.now() }), 'utf8');
        try {
            if (fsImpl.existsSync(jsonDst)) fsImpl.unlinkSync(jsonDst);
        } catch (e) {}
        fsImpl.renameSync(jsonTmp, jsonDst);
        fsImpl.unlinkSync(jsonDst);
        return true;
    } catch (e) {
        try { if (fsImpl.existsSync(testFile)) fsImpl.unlinkSync(testFile); } catch (e2) {}
        try { if (fsImpl.existsSync(jsonTmp)) fsImpl.unlinkSync(jsonTmp); } catch (e2) {}
        try { if (fsImpl.existsSync(jsonDst)) fsImpl.unlinkSync(jsonDst); } catch (e2) {}
        return false;
    }
}

function buildExtremeFallbacks(env = process.env, opts = {}) {
    const list = [];
    const user = safeUsername(env);
    if (opts.installDir) list.push(path.join(opts.installDir, 'data'));
    if (env.ProgramData) list.push(path.join(env.ProgramData, 'NexoraAgent', user));
    // 公共目录：部分锁屏策略仍允许
    list.push(path.join('C:\\Users\\Public', 'NexoraAgent', user));
    if (env.PUBLIC) list.push(path.join(env.PUBLIC, 'NexoraAgent', user));
    return list;
}

function buildHomeCandidates(preferredHome, opts = {}) {
    const {
        appPaths = {},
        env = process.env,
        tmpdir = os.tmpdir(),
        preferAppDataFirst = false,
        installDir = null
    } = opts;

    const stableAppData = [];
    if (env.LOCALAPPDATA) stableAppData.push(path.join(env.LOCALAPPDATA, 'NexoraAgent'));
    if (appPaths.appData) stableAppData.push(path.join(appPaths.appData, 'NexoraAgent'));
    if (env.APPDATA) stableAppData.push(path.join(env.APPDATA, 'NexoraAgent'));
    if (appPaths.userData) stableAppData.push(appPaths.userData);

    const dataDisks = [];
    for (const root of ['D:\\', 'E:\\', 'F:\\']) {
        try {
            if (fs.existsSync(root)) dataDisks.push(path.join(root, 'NexoraAgent-data'));
        } catch (e) {}
    }

    const extreme = buildExtremeFallbacks(env, { installDir });
    const lastResort = path.join(tmpdir, 'NexoraAgent-home');

    const ordered = [];
    const push = (p) => {
        if (!p) return;
        const resolved = path.resolve(String(p));
        if (!ordered.includes(resolved)) ordered.push(resolved);
    };

    if (preferAppDataFirst) {
        for (const p of stableAppData) push(p);
        for (const p of dataDisks) push(p);
        for (const p of extreme) push(p);
        push(preferredHome);
        push(appPaths.home);
        push(lastResort);
    } else {
        push(preferredHome);
        push(appPaths.home);
        for (const p of stableAppData) push(p);
        for (const p of dataDisks) push(p);
        for (const p of extreme) push(p);
        push(lastResort);
    }
    return ordered;
}

/**
 * 评估存储健康度，供 UI/日志提示
 * - ok: 正常家目录或 AppData\NexoraAgent
 * - degraded: 便携目录 / ProgramData / Public（能跑，但建议放宽权限）
 * - critical: 仍在 Temp 或探测失败（高概率会话冲突/不回复）
 */
function assessStorageHealth(homePath, opts = {}) {
    const { probe = probeOpenClawHomeWritable } = opts;
    const n = String(homePath || '').toLowerCase().replace(/\//g, '\\');
    const writable = homePath ? probe(homePath) : false;

    if (!homePath || !writable) {
        return {
            level: 'critical',
            code: 'NOT_WRITABLE',
            title: '数据目录不可写',
            message:
                '当前系统策略导致 Nexora Agent 无法稳定写入数据目录，微信可能无法回复。\n\n请将 Nexora Agent / node.exe 加入「受控文件夹访问」允许列表，或关闭相关安全软件对用户目录的锁定后重启。',
            actions: [
                'Windows 安全中心 → 病毒和威胁防护 → 管理勒索软件保护 → 受控文件夹访问',
                '允许 Nexora Agent.exe、内置 node.exe 通过',
                '重启 Nexora Agent'
            ]
        };
    }

    if (isTempLikePath(homePath)) {
        return {
            level: 'critical',
            code: 'TEMP_HOME',
            title: '数据目录落在临时文件夹',
            message:
                `检测到数据目录位于临时路径：\n${homePath}\n\n这在云电脑/锁屏环境下极易导致会话冲突、微信不回复。请按提示放宽目录写入权限后重启。`,
            actions: [
                '允许写入 %LOCALAPPDATA%\\NexoraAgent 或用户主目录',
                '将 Nexora Agent 加入受控文件夹访问排除项',
                '重启 Nexora Agent 使目录自动迁出 Temp'
            ]
        };
    }

    const degraded =
        n.includes('\\programdata\\nexoraagent') ||
        n.includes('\\users\\public\\nexoraagent') ||
        n.endsWith('\\data') ||
        n.includes('\\nexoraagent\\data');

    if (degraded) {
        return {
            level: 'degraded',
            code: 'EXTREME_FALLBACK',
            title: '已启用兼容数据目录',
            message:
                `系统用户目录写入受限，已自动切换到兼容目录：\n${homePath}\n\n一般可正常使用。若仍出现不回复，请放宽对用户目录/AppData 的写入限制。`,
            actions: [
                '优先允许 %LOCALAPPDATA%\\NexoraAgent',
                '云电脑可放行 D:\\NexoraAgent-data'
            ]
        };
    }

    return {
        level: 'ok',
        code: 'OK',
        title: '数据目录正常',
        message: `使用数据目录：${homePath}`,
        actions: []
    };
}

function resolveStableOpenClawHome(preferredHome, opts = {}) {
    const {
        appPaths = {},
        env = process.env,
        tmpdir = os.tmpdir(),
        probe = probeOpenClawHomeWritable,
        desktopInfo = detectRestrictedDesktop(env),
        installDir = null
    } = opts;

    const preferredWritable = preferredHome ? probe(preferredHome) : false;
    const preferAppDataFirst = Boolean(
        opts.preferAppDataFirst ||
        desktopInfo.restricted ||
        !preferredWritable ||
        isTempLikePath(preferredHome) ||
        isTempLikePath(env.REAL_USER_HOME) ||
        isTempLikePath(env.USERPROFILE)
    );

    const candidates = buildHomeCandidates(preferredHome, {
        appPaths,
        env,
        tmpdir,
        preferAppDataFirst,
        installDir
    });

    const last = candidates[candidates.length - 1];
    for (const candidate of candidates) {
        if (isTempLikePath(candidate) && candidate !== last) continue;
        if (probe(candidate)) {
            const stateDir = path.join(candidate, '.openclaw');
            const health = assessStorageHealth(candidate, { probe });
            return {
                homePath: candidate,
                stateDir,
                fromTempFallback: isTempLikePath(candidate),
                preferAppDataFirst,
                desktopHints: desktopInfo.hints,
                candidatesTried: candidates,
                health
            };
        }
    }

    const fallback = preferredHome || candidates[0];
    const health = assessStorageHealth(fallback, { probe });
    return {
        homePath: fallback,
        stateDir: path.join(fallback || '', '.openclaw'),
        fromTempFallback: isTempLikePath(fallback),
        preferAppDataFirst,
        desktopHints: desktopInfo.hints,
        candidatesTried: candidates,
        health
    };
}

function applyOpenClawHomeEnv(homePath, env = process.env) {
    const stateDir = path.join(homePath, '.openclaw');
    env.USERPROFILE = homePath;
    env.HOME = homePath;
    env.REAL_USER_HOME = homePath;
    env.OPENCLAW_HOME = homePath;
    env.OPENCLAW_STATE_DIR = stateDir;
    return { homePath, stateDir };
}

/** 写入健康标记，方便网关日志/售后排查 */
function writeHomeHealthMarker(stateDir, health, extra = {}) {
    try {
        fs.mkdirSync(stateDir, { recursive: true });
        const file = path.join(stateDir, 'home-health.json');
        fs.writeFileSync(
            file,
            JSON.stringify(
                {
                    ...health,
                    ...extra,
                    updatedAt: new Date().toISOString()
                },
                null,
                2
            ),
            'utf8'
        );
        return file;
    } catch (e) {
        return null;
    }
}

module.exports = {
    isTempLikePath,
    isSessionTempPath,
    safeUsername,
    detectRestrictedDesktop,
    isForeignUserPath,
    probeOpenClawHomeWritable,
    buildExtremeFallbacks,
    buildHomeCandidates,
    assessStorageHealth,
    resolveStableOpenClawHome,
    applyOpenClawHomeEnv,
    writeHomeHealthMarker
};
