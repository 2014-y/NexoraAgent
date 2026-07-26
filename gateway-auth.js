'use strict';
/**
 * Gateway 鉴权与 Control UI 配置守卫（零环境首启安全）。
 * 保证：磁盘上的 token、仪表盘 URL、OPENCLAW_GATEWAY_TOKEN 永远同一套。
 */

// 历史遗留的全网统一静态令牌——一旦发现即迁移为每机随机令牌
const DEFAULT_GATEWAY_TOKEN = 'openclaw-dev-token-998877';
const INSECURE_STATIC_TOKENS = new Set(['openclaw-dev-token-998877']);
const DEFAULT_PORT = 18789;
const DEFAULT_BASE_PATH = '/acp';

let _cachedInstallToken = null;

/** 每机随机令牌的落盘位置（0600），随 state 目录 */
function installTokenPath() {
    const path = require('path');
    const os = require('os');
    const stateDir = process.env.OPENCLAW_STATE_DIR
        || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(), '.openclaw');
    return path.join(stateDir, '.gateway-token');
}

/**
 * 取得（或首次生成）每机随机网关令牌，替代全网统一的静态默认值。
 * 令牌真正的真相源是 openclaw.json 里的 gateway.auth.token；此文件只是种子/兜底，
 * 即使写盘失败，进程内也缓存同一值以保证 config / env / 控制台 URL 三者一致。
 */
function getOrCreateInstallToken() {
    if (_cachedInstallToken) return _cachedInstallToken;
    const fs = require('fs');
    const p = installTokenPath();
    try {
        const existing = String(fs.readFileSync(p, 'utf8')).trim();
        if (existing && existing.length >= 16 && !INSECURE_STATIC_TOKENS.has(existing)) {
            _cachedInstallToken = existing;
            return existing;
        }
    } catch (_) {}
    const tok = 'nx-' + require('crypto').randomBytes(24).toString('hex');
    try {
        fs.mkdirSync(require('path').dirname(p), { recursive: true });
        fs.writeFileSync(p, tok, { encoding: 'utf8', mode: 0o600 });
    } catch (_) {}
    _cachedInstallToken = tok;
    return tok;
}

function isUsableToken(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/** 是否为需要迁移的旧静态令牌 */
function isInsecureStaticToken(value) {
    return typeof value === 'string' && INSECURE_STATIC_TOKENS.has(value.trim());
}

/**
 * 规范化 gateway.auth / controlUi / port。
 * @returns {{ config: object, changed: boolean, token: string, port: number }}
 */
function normalizeGatewayAuthConfig(config, defaultToken = getOrCreateInstallToken()) {
    const cfg = config && typeof config === 'object' ? config : {};
    let changed = false;
    // 若调用方仍传入旧静态令牌作默认，替换为随机令牌，避免迁移又写回不安全值
    if (isInsecureStaticToken(defaultToken)) defaultToken = getOrCreateInstallToken();

    if (!cfg.gateway || typeof cfg.gateway !== 'object') {
        cfg.gateway = {};
        changed = true;
    }
    if (!cfg.gateway.auth || typeof cfg.gateway.auth !== 'object') {
        cfg.gateway.auth = {};
        changed = true;
    }
    if (cfg.gateway.auth.mode !== 'token') {
        cfg.gateway.auth.mode = 'token';
        changed = true;
    }
    // 缺失/非字符串 → 用每机随机令牌；发现旧静态令牌 → 迁移为随机令牌（禁止再写回全网统一值）
    if (!isUsableToken(cfg.gateway.auth.token) || isInsecureStaticToken(cfg.gateway.auth.token)) {
        cfg.gateway.auth.token = defaultToken;
        changed = true;
    }

    if (!cfg.gateway.controlUi || typeof cfg.gateway.controlUi !== 'object') {
        cfg.gateway.controlUi = {};
        changed = true;
    }
    if (cfg.gateway.controlUi.basePath !== DEFAULT_BASE_PATH) {
        cfg.gateway.controlUi.basePath = DEFAULT_BASE_PATH;
        changed = true;
    }

    const portNum = Number(cfg.gateway.port);
    if (!(portNum > 0)) {
        cfg.gateway.port = DEFAULT_PORT;
        changed = true;
    }

    if (cfg.gateway.mode !== 'local' && cfg.gateway.mode !== 'remote') {
        cfg.gateway.mode = 'local';
        changed = true;
    }

    return {
        config: cfg,
        changed,
        token: String(cfg.gateway.auth.token).trim(),
        port: Number(cfg.gateway.port) || DEFAULT_PORT
    };
}

function buildControlUiUrl(port, token) {
    const p = Number(port) > 0 ? Number(port) : DEFAULT_PORT;
    const t = (isUsableToken(token) && !isInsecureStaticToken(token)) ? String(token).trim() : getOrCreateInstallToken();
    const enc = encodeURIComponent(t);
    return `http://127.0.0.1:${p}${DEFAULT_BASE_PATH}/?token=${enc}#token=${enc}`;
}

/**
 * 把鉴权字段同步进其它可能被旧版 patch 读到的状态目录（消除双目录分叉）。
 * 只改 gateway.auth / controlUi.basePath / port，不覆盖其它业务配置。
 */
function syncGatewayAuthToStateDirs(stateDirs, authPayload) {
    const fs = require('fs');
    const path = require('path');
    const token = (isUsableToken(authPayload.token) && !isInsecureStaticToken(authPayload.token)) ? String(authPayload.token).trim() : getOrCreateInstallToken();
    const mode = authPayload.mode || 'token';
    const port = Number(authPayload.port) > 0 ? Number(authPayload.port) : DEFAULT_PORT;
    const synced = [];

    const uniq = [];
    for (const dir of stateDirs || []) {
        if (!dir) continue;
        const resolved = path.resolve(String(dir));
        if (!uniq.includes(resolved)) uniq.push(resolved);
    }

    for (const dir of uniq) {
        const cf = path.join(dir, 'openclaw.json');
        try {
            // 只修补已存在的配置，避免在备用目录生成「只有 auth 的空壳」覆盖业务配置
            if (!fs.existsSync(cf)) continue;
            const cfg = JSON.parse(fs.readFileSync(cf, 'utf8').replace(/^\uFEFF/, ''));
            const before = JSON.stringify({
                auth: cfg.gateway && cfg.gateway.auth,
                port: cfg.gateway && cfg.gateway.port,
                basePath: cfg.gateway && cfg.gateway.controlUi && cfg.gateway.controlUi.basePath
            });
            const norm = normalizeGatewayAuthConfig(cfg, token);
            norm.config.gateway.auth.mode = mode;
            norm.config.gateway.auth.token = token;
            norm.config.gateway.port = port;
            const after = JSON.stringify({
                auth: norm.config.gateway.auth,
                port: norm.config.gateway.port,
                basePath: norm.config.gateway.controlUi && norm.config.gateway.controlUi.basePath
            });
            if (before !== after) {
                fs.writeFileSync(cf, JSON.stringify(norm.config, null, 2) + '\n', 'utf8');
                synced.push(dir);
            }
        } catch (e) {
            // 忽略单个目录失败，主 CONFIG_PATH 仍由调用方保证
        }
    }
    return synced;
}

/** 组装 fork 网关子进程必须继承的 OPENCLAW_* / 令牌环境 */
function buildGatewayChildEnv(baseEnv, opts) {
    const homePath = opts.homePath;
    const stateDir = opts.stateDir;
    const token = (isUsableToken(opts.token) && !isInsecureStaticToken(opts.token)) ? String(opts.token).trim() : getOrCreateInstallToken();
    const env = {
        ...baseEnv,
        USERPROFILE: homePath,
        HOME: homePath,
        REAL_USER_HOME: homePath,
        OPENCLAW_HOME: homePath,
        OPENCLAW_STATE_DIR: stateDir,
        // OpenClaw ensureGatewayStartupAuth 会优先认环境变量，作为配置分叉时的最后保险
        OPENCLAW_GATEWAY_TOKEN: token
    };
    // 剥掉「supervisor 存在」的假标记：否则 OpenClaw 内部重启时会「退出等计划任务拉起」，
    // 而这里是 Electron fork 的子进程、根本没有 schtasks/systemd 守护 → 网关一去不回。
    for (const k of ['OPENCLAW_WINDOWS_TASK_NAME', 'OPENCLAW_SERVICE_MARKER', 'OPENCLAW_SERVICE_KIND', 'OPENCLAW_SYSTEMD_UNIT']) {
        delete env[k];
    }
    return env;
}

module.exports = {
    DEFAULT_GATEWAY_TOKEN,
    DEFAULT_PORT,
    DEFAULT_BASE_PATH,
    isUsableToken,
    isInsecureStaticToken,
    getOrCreateInstallToken,
    normalizeGatewayAuthConfig,
    buildControlUiUrl,
    syncGatewayAuthToStateDirs,
    buildGatewayChildEnv
};
