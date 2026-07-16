// main.js - Electron 主进程入口
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { fork } = require('child_process');
const {
    isTempLikePath,
    probeOpenClawHomeWritable,
    resolveStableOpenClawHome: resolveStableOpenClawHomeCore,
    applyOpenClawHomeEnv,
    detectRestrictedDesktop,
    isForeignUserPath,
    writeHomeHealthMarker
} = require('./home-resolve');
const { ensureLatencySafeConfig } = require('./latency-tune');
const {
    isPluginPathStaleOnThisMachine,
    looksLikeOfficialOpenClawChannelPath,
    sanitizePluginPathsForThisMachine
} = require('./plugin-adapt');
const {
    ensureUiPluginCatalog,
    ensureLongTermMemoryStack,
    ensureAllow,
    probeAllUiPlugins,
    probePlugin,
    applyPluginCredentials,
    LONG_TERM_MEMORY_UI_ID,
    LONG_TERM_MEMORY_STACK,
    ASYNC_CHANNEL_LOGIN
} = require('./plugin-catalog');
const {
    resolveOpenClawStateDir,
    listKnownOpenClawStateDirs
} = require('./openclaw-state');
const {
    DEFAULT_GATEWAY_TOKEN,
    normalizeGatewayAuthConfig,
    buildControlUiUrl,
    syncGatewayAuthToStateDirs,
    buildGatewayChildEnv
} = require('./gateway-auth');
const { syncModelConfigToStateDirs } = require('./openclaw-model-sync');
const {
    getGatewayRuntimeRoot,
    ensureGatewayRuntime
} = require('./gateway-runtime');

let hardenGatewayBootAgainstPluginNpm = () => ({ notes: ['harden-unavailable'], configChanged: false });
let softenOpenClawStartupMigrationGuard = () => ({ ok: false, reason: 'harden-unavailable' });
let ensureSandboxNpmPresent = () => ({ ok: false, reason: 'harden-unavailable' });
try {
    const bootHarden = require('./gateway-boot-harden');
    hardenGatewayBootAgainstPluginNpm = bootHarden.hardenGatewayBootAgainstPluginNpm;
    softenOpenClawStartupMigrationGuard = bootHarden.softenOpenClawStartupMigrationGuard;
    ensureSandboxNpmPresent = bootHarden.ensureSandboxNpmPresent;
} catch (e) {
    console.warn('[GatewayBoot] gateway-boot-harden.js missing from package; boot harden disabled:', e && e.message);
}

function safeMainErrorLogPath() {
    try {
        if (typeof CONFIG_DIR === 'string' && CONFIG_DIR) {
            return path.join(CONFIG_DIR, 'main_error.log');
        }
    } catch (e) {}
    try {
        if (process.env.OPENCLAW_STATE_DIR) {
            return path.join(process.env.OPENCLAW_STATE_DIR, 'main_error.log');
        }
    } catch (e) {}
    try {
        return path.join(app.getPath('userData'), 'main_error.log');
    } catch (e) {}
    return path.join(resolveOpenClawStateDir(), 'main_error.log');
}

process.on('uncaughtException', (err) => {
    try {
        const logPath = safeMainErrorLogPath();
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, err.stack || err.message, 'utf8');
    } catch(e) {}
});
process.on('unhandledRejection', (reason) => {
    try {
        const logPath = safeMainErrorLogPath();
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, String(reason), 'utf8');
    } catch(e) {}
});

// 打包后网关运行时在用户目录解压；开发态则是工程根目录。
// Electron 自身资源（preload/html/icon）仍用 __dirname（可在 asar 内）。
function resolveAppFsRoot() {
    try {
        return getGatewayRuntimeRoot(app);
    } catch (e) {
        // app 未就绪时退化：开发态工程根 / 旧 asar.unpacked
    }
    let base = __dirname;
    if (base.includes(`${path.sep}app.asar`) && !base.includes(`${path.sep}app.asar.unpacked`)) {
        base = base.replace(`${path.sep}app.asar`, `${path.sep}app.asar.unpacked`);
    } else if (base.includes('/app.asar') && !base.includes('/app.asar.unpacked')) {
        base = base.replace('/app.asar', '/app.asar.unpacked');
    }
    return base;
}

function resolveAppFsPath(...segments) {
    return path.join(resolveAppFsRoot(), ...segments);
}

// 获取可用的 Node 可执行文件路径
function getAvailableNodePath() {
    const sandboxPath = resolveAppFsPath('.node-sandbox', 'node.exe');
    if (fs.existsSync(sandboxPath)) {
        return sandboxPath;
    }
    
    // 如果内置沙箱不存在，尝试获取系统全局 Node 绝对路径
    try {
        const which = require('child_process').execSync('where node', { encoding: 'utf8' }).trim().split('\r\n')[0];
        if (which && fs.existsSync(which)) {
            // 简单校验一下系统 Node 版本是否满足要求
            const versionOutput = require('child_process').execSync(`"${which}" -v`, { encoding: 'utf8' }).trim();
            const match = versionOutput.match(/^v(\d+)/);
            if (match && parseInt(match[1], 10) >= 22) {
                return which;
            }
        }
    } catch (e) {
        // Ignore
    }
    
    return null;
}

// ==========================================
// 内置 Node 运行时（.node-sandbox）自动升级
// ==========================================

// 比较两个 x.y.z 版本号：a>b →1, a<b →-1, 相等 →0
function compareNodeVersions(a, b) {
    const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}

// 单个比较符是否满足（支持 >= > <= < = ^ ~ 及裸版本号）
function satisfiesComparator(version, comp) {
    comp = String(comp || '').trim();
    if (!comp || comp === '*' || comp === 'x') return true;
    let m;
    if ((m = comp.match(/^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/))) {
        const op = m[1] || '=';
        const target = `${m[2]}.${m[3] || 0}.${m[4] || 0}`;
        const c = compareNodeVersions(version, target);
        switch (op) {
            case '>': return c > 0;
            case '>=': return c >= 0;
            case '<': return c < 0;
            case '<=': return c <= 0;
            case '=': return c === 0;
        }
    }
    if ((m = comp.match(/^\^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/))) {
        const maj = parseInt(m[1], 10), min = parseInt(m[2] || 0, 10), pat = parseInt(m[3] || 0, 10);
        const lower = `${maj}.${min}.${pat}`;
        const upper = maj > 0 ? `${maj + 1}.0.0` : (min > 0 ? `0.${min + 1}.0` : `0.0.${pat + 1}`);
        return compareNodeVersions(version, lower) >= 0 && compareNodeVersions(version, upper) < 0;
    }
    if ((m = comp.match(/^~v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/))) {
        const maj = parseInt(m[1], 10), min = parseInt(m[2] || 0, 10), pat = parseInt(m[3] || 0, 10);
        const lower = `${maj}.${min}.${pat}`;
        const upper = (m[2] != null) ? `${maj}.${min + 1}.0` : `${maj + 1}.0.0`;
        return compareNodeVersions(version, lower) >= 0 && compareNodeVersions(version, upper) < 0;
    }
    return false;
}

// 版本号是否满足 semver 范围（支持 ||（OR）与空格分隔（AND））
function satisfiesNodeRange(version, range) {
    if (!range || range === '*' || range === 'latest') return true;
    return String(range).split('||').some(group => {
        const comps = group.trim().split(/\s+/).filter(Boolean);
        return comps.length > 0 && comps.every(c => satisfiesComparator(version, c));
    });
}

// 轻量 https GET（自动跟随重定向），返回 Buffer 或 JSON
function httpGetBuffer(url, { json = false, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const doReq = (u, redirects) => {
            const req = https.get(u, { headers: { 'User-Agent': 'NexoraAgent-Updater' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    if (redirects > 5) { res.resume(); return reject(new Error('重定向次数过多')); }
                    res.resume();
                    return doReq(new URL(res.headers.location, u).toString(), redirects + 1);
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    if (json) { try { resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { reject(e); } }
                    else resolve(buf);
                });
            });
            req.on('error', reject);
            req.setTimeout(timeout, () => { req.destroy(new Error('请求超时')); });
        };
        doReq(url, 0);
    });
}

// 自愈升级内置的 Node.js 绿色沙箱
async function checkAndHealSandboxNode() {
    const sandboxDir = resolveAppFsPath('.node-sandbox');
    const nodeExePath = path.join(sandboxDir, 'node.exe');
    
    let isOk = false;
    let currentVersion = 'none';
    let currentSqlite = 'none';
    
    if (fs.existsSync(nodeExePath)) {
        try {
            // 版本校验使用非阻塞异步 execFile 包装，保证事件循环畅通
            const { execFile } = require('child_process');
            const checkCode = `
                try {
                    const s = require('node:sqlite');
                    const db = new s.DatabaseSync(':memory:');
                    const sqliteVer = db.prepare('SELECT sqlite_version() AS version').get().version;
                    console.log(process.version + ',' + sqliteVer);
                } catch (e) {
                    console.log(process.version + ',');
                }
            `;
            const output = await new Promise((resolve, reject) => {
                execFile(nodeExePath, ['-e', checkCode], { timeout: 5000 }, (err, stdout) => {
                    if (err) return reject(err);
                    resolve(stdout.trim());
                });
            });
            const parts = output.split(',');
            if (parts[0]) {
                currentVersion = parts[0];
                currentSqlite = parts[1] || 'none';
                
                const cleanNodeVer = currentVersion.replace(/^v/, '');
                const satisfyNode = satisfiesNodeRange(cleanNodeVer, '>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0');
                const satisfySqlite = currentSqlite !== 'none' && satisfiesNodeRange(currentSqlite, '>=3.51.3');
                
                if (satisfyNode && satisfySqlite) {
                    isOk = true;
                }
            }
        } catch (err) {
            console.error('Failed to run check code on sandbox node:', err.message);
        }
    }
    
    if (isOk) {
        console.log(`[SandboxCheck] Sandbox Node version ${currentVersion} and SQLite ${currentSqlite} are compliant. No upgrade needed.`);
        return;
    }
    
    console.warn(`[SandboxCheck] Mismatch detected. Current node: ${currentVersion}, SQLite: ${currentSqlite}. Starting self-healing sandbox upgrade...`);
    
    if (mainWindow) {
        mainWindow.webContents.send('gateway-status', 'upgrading');
        mainWindow.webContents.send('gateway-log', `[System] 检测到内置沙箱环境 (Node: ${currentVersion}, SQLite: ${currentSqlite}) 不适用，正在启动自动环境自愈升级...\n`);
    }
    
    const targetVersion = '24.15.0';
    const tempZip = path.join(__dirname, 'node-v24.15.0.zip');
    const tempExtract = path.join(__dirname, 'node-v24.15.0-temp');
    const arch = process.arch === 'arm64' ? 'win-arm64' : (process.arch === 'ia32' ? 'win-x86' : 'win-x64');
    
    // 优先尝试阿里的国内淘宝/阿里镜像以获得极速下载，备用 Node.js 官方链接
    const urls = [
        `https://npmmirror.com/mirrors/node/v${targetVersion}/node-v${targetVersion}-${arch}.zip`,
        `https://nodejs.org/dist/v${targetVersion}/node-v${targetVersion}-${arch}.zip`
    ];
    
    let downloadSuccess = false;
    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        try {
            console.log(`[SandboxUpgrade] Downloading sandbox zip from: ${url}`);
            if (mainWindow) {
                mainWindow.webContents.send('gateway-log', `[System] 正在连接下载源 (${i === 0 ? '阿里镜像源' : '官方源'})...\n`);
            }
            
            await new Promise((resolve, reject) => {
                const https = require('https');
                const fs = require('fs');
                const doReq = (u, redirects) => {
                    const req = https.get(u, { headers: { 'User-Agent': 'NexoraAgent-Updater' } }, (res) => {
                        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                            if (redirects > 5) { res.resume(); return reject(new Error('重定向次数过多')); }
                            res.resume();
                            return doReq(new URL(res.headers.location, u).toString(), redirects + 1);
                        }
                        if (res.statusCode !== 200) {
                            res.resume();
                            return reject(new Error(`HTTP ${res.statusCode}`));
                        }
                        const total = parseInt(res.headers['content-length'] || '0', 10);
                        let received = 0;
                        const out = fs.createWriteStream(tempZip);
                        let lastPercent = -1;
                        
                        res.on('data', (chunk) => {
                            received += chunk.length;
                            const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
                            if (percent !== lastPercent) {
                                lastPercent = percent;
                                if (mainWindow) {
                                    mainWindow.webContents.send('sandbox-upgrade-progress', {
                                        progress: Math.floor(percent * 0.9), // 下载占 90% 进度
                                        text: `正在下载 Node.js 沙箱环境 (${percent}%)`
                                    });
                                    mainWindow.webContents.send('gateway-log', `[System] 正在下载内置 Node.js 运行时：${percent}% (已接收 ${(received / 1024 / 1024).toFixed(1)}MB / 共 ${(total / 1024 / 1024).toFixed(1)}MB)\r`);
                                }
                            }
                        });
                        res.pipe(out);
                        out.on('finish', () => out.close(() => resolve()));
                        out.on('error', reject);
                    });
                    req.on('error', reject);
                    req.setTimeout(120000, () => { req.destroy(new Error('下载超时')); });
                };
                doReq(url, 0);
            });
            downloadSuccess = true;
            break;
        } catch (err) {
            console.error(`[SandboxUpgrade] Failed downloading from ${url}:`, err.message);
            if (fs.existsSync(tempZip)) {
                try { fs.unlinkSync(tempZip); } catch(e) {}
            }
        }
    }
    
    if (!downloadSuccess) {
        throw new Error('下载 Node.js 绿色沙箱包失败，请检查您的网络连接并重试。');
    }
    
    if (mainWindow) {
        mainWindow.webContents.send('sandbox-upgrade-progress', { progress: 92, text: '下载完成，正在解压沙箱文件...' });
        mainWindow.webContents.send('gateway-log', '\n[System] 下载完成，正在解压 Node.js 沙箱文件...\n');
    }
    
    // 异步非阻塞解包，防止主进程卡死
    if (fs.existsSync(tempExtract)) {
        fs.rmSync(tempExtract, { recursive: true, force: true });
    }
    const { exec } = require('child_process');
    await new Promise((resolve, reject) => {
        exec(`powershell -ExecutionPolicy Bypass -NoProfile -Command "Expand-Archive -Path '${tempZip}' -DestinationPath '${tempExtract}' -Force"`, (err) => {
            if (err) return reject(new Error('解压失败: ' + err.message));
            resolve();
        });
    });
    
    if (mainWindow) {
        mainWindow.webContents.send('sandbox-upgrade-progress', { progress: 96, text: '解压完成，正在替换核心组件...' });
        mainWindow.webContents.send('gateway-log', '[System] 解压完成，正在部署核心二进制组件...\n');
    }
    
    const extractedDir = path.join(tempExtract, `node-v${targetVersion}-win-x64`);
    
    // 物理覆盖
    if (!fs.existsSync(sandboxDir)) {
        fs.mkdirSync(sandboxDir, { recursive: true });
    }
    
    // 异步复制核心 node.exe
    await fs.promises.copyFile(path.join(extractedDir, 'node.exe'), path.join(sandboxDir, 'node.exe'));
    
    // 异步复制 npm/npx 等脚本
    const scripts = ['npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd'];
    for (const s of scripts) {
        const src = path.join(extractedDir, s);
        if (fs.existsSync(src)) {
            await fs.promises.copyFile(src, path.join(sandboxDir, s));
        }
    }
    
    // 覆盖整个 node_modules 目录 (npm 自体)
    const destModules = path.join(sandboxDir, 'node_modules');
    if (fs.existsSync(destModules)) {
        fs.rmSync(destModules, { recursive: true, force: true });
    }
    
    // 异步非阻塞运行 robocopy，防止进程阻塞导致无响应
    await new Promise((resolve) => {
        exec(`robocopy "${path.join(extractedDir, 'node_modules')}" "${destModules}" /E /NJH /NJS /ndl /nc /ns`, () => {
            resolve();
        });
    });
    
    // 清理临时文件
    try {
        if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);
        if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, { recursive: true, force: true });
    } catch(e) {}
    
    if (mainWindow) {
        mainWindow.webContents.send('sandbox-upgrade-progress', { progress: 100, text: '沙箱升级完成！' });
        mainWindow.webContents.send('gateway-log', '[System] 沙箱环境成功联动升级！\n');
    }
    
    console.log('[SandboxUpgrade] Sandbox Node.js successfully upgraded to compliant v24.15.0!');
}

let mainWindow = null;
let tray = null;
let gatewayProcess = null;
let gatewayHttpReadyTimer = null;
let gatewayHttpReadyNotified = false;
let isQuitting = false;
let isMaximizedState = false;
let normalBounds = null;
const appStartTime = Date.now();
global.latestAcpDashboardUrl = '';

function stopGatewayHttpReadyWatch() {
    if (gatewayHttpReadyTimer) {
        clearInterval(gatewayHttpReadyTimer);
        gatewayHttpReadyTimer = null;
    }
}

function notifyGatewayHttpReady(port) {
    if (gatewayHttpReadyNotified) return;
    gatewayHttpReadyNotified = true;
    stopGatewayHttpReadyWatch();
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-http-ready', { port: port || 18789 });
        }
    } catch (e) {}
}

/** TCP 探测：端口可连即通知 UI 解锁（比等日志更稳） */
function startGatewayHttpReadyWatch(port) {
    stopGatewayHttpReadyWatch();
    gatewayHttpReadyNotified = false;
    const targetPort = Number(port) > 0 ? Number(port) : 18789;
    let tries = 0;
    gatewayHttpReadyTimer = setInterval(() => {
        if (!gatewayProcess || gatewayHttpReadyNotified) {
            stopGatewayHttpReadyWatch();
            return;
        }
        tries += 1;
        if (tries > 120) {
            stopGatewayHttpReadyWatch();
            return;
        }
        const socket = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
            try { socket.destroy(); } catch (e) {}
            notifyGatewayHttpReady(targetPort);
        });
        socket.on('error', () => {
            try { socket.destroy(); } catch (e) {}
        });
        socket.setTimeout(350, () => {
            try { socket.destroy(); } catch (e) {}
        });
    }, 400);
}

// 与 open-external / 示例配置一致的桌面端默认网关令牌（仅本机 loopback）
const NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN = DEFAULT_GATEWAY_TOKEN;

/** 从 openclaw.json 组装 Control UI 免密 URL（优先 #token=，并保留 ?token= 兼容旧版） */
function buildGatewayDashboardUrl() {
    let port = 18789;
    let token = NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN;
    try {
        const configPath = CONFIG_PATH || path.join(CONFIG_DIR, 'openclaw.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
            const norm = normalizeGatewayAuthConfig(config, NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN);
            port = norm.port;
            token = norm.token;
        }
    } catch (e) {}
    return buildControlUiUrl(port, token);
}

/**
 * 网关启动前最终锁定：鉴权写入主配置 + 同步到历史双目录 + 返回 fork 应用的 home/token。
 * 根除「主进程有 token、沙箱却 auth token was missing / runtime token」零环境故障。
 */
function lockGatewayAuthBeforeStart() {
    ensureOpenClawConfigInitialized();
    let token = NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN;
    let port = 18789;
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
            const norm = normalizeGatewayAuthConfig(parsed, NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN);
            token = norm.token;
            port = norm.port;
            if (norm.changed) {
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(norm.config, null, 2) + '\n', 'utf8');
                console.log('[TokenGuard] Normalized gateway.auth before start');
            }
        }
    } catch (e) {
        console.warn('[TokenGuard] Primary config normalize failed:', e.message);
        try {
            const minimal = normalizeGatewayAuthConfig({}, NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN).config;
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(minimal, null, 2) + '\n', 'utf8');
            token = NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN;
        } catch (e2) {
            console.error('[TokenGuard] Failed to write emergency auth config:', e2.message);
        }
    }

    const homePath = process.env.OPENCLAW_HOME
        || path.dirname(CONFIG_DIR)
        || (process.env.USERPROFILE || process.env.HOME || '');
    const altDirs = listKnownOpenClawStateDirs(process.env, CONFIG_DIR);
    try {
        const synced = syncGatewayAuthToStateDirs(altDirs, { token, mode: 'token', port });
        if (synced.length) {
            console.log('[TokenGuard] Synced gateway.auth to:', synced.join(' | '));
        }
    } catch (e) {
        console.warn('[TokenGuard] Auth sync skipped:', e.message);
    }

    // 启动前按当前默认模型纠正沙箱 OpenClaw 会话粘性，避免面板仍用旧 modelOverride
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
            const syncedModels = syncModelConfigToStateDirs(altDirs, cfg, CONFIG_DIR);
            if (syncedModels.length) {
                console.log('[ModelSync] Pre-start synced model config to:', syncedModels.join(' | '));
            }
        }
    } catch (e) {
        console.warn('[ModelSync] Pre-start sync skipped:', e.message);
    }

    global.latestAcpDashboardUrl = buildControlUiUrl(port, token);
    return { homePath, stateDir: CONFIG_DIR, token, port };
}

function rememberDashboardUrl(url) {
    if (!url || typeof url !== 'string') return buildGatewayDashboardUrl();
    // 日志里的旧链接可能缺 token / 令牌过期；一律用当前配置重写
    const fresh = buildGatewayDashboardUrl();
    global.latestAcpDashboardUrl = fresh;
    return fresh;
}

let CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Public', '.openclaw');
let CONFIG_PATH = path.join(CONFIG_DIR, 'openclaw.json');

function resolveStableOpenClawHome(preferredHome) {
    const installDir = (() => {
        try {
            // 打包后优先用可执行文件旁；开发态用项目目录
            if (app.isPackaged) return path.dirname(process.execPath);
            return __dirname;
        } catch (e) {
            return __dirname;
        }
    })();
    return resolveStableOpenClawHomeCore(preferredHome, {
        installDir,
        appPaths: {
            home: (() => { try { return app.getPath('home'); } catch (e) { return null; } })(),
            appData: (() => { try { return app.getPath('appData'); } catch (e) { return null; } })(),
            userData: (() => { try { return app.getPath('userData'); } catch (e) { return null; } })()
        }
    });
}

function warnStorageHealthIfNeeded(health, homePath) {
    if (!health || health.level === 'ok') return;
    const detail = `${health.message}\n\n建议：\n- ${(health.actions || []).join('\n- ')}`;
    try {
        showNotification(health.title || '存储目录提醒', health.message.split('\n')[0]);
    } catch (e) {}
    // 窗口起来后再弹一次，避免启动过早 dialog 被挡
    const show = () => {
        try {
            dialog.showMessageBox(mainWindow || undefined, {
                type: health.level === 'critical' ? 'error' : 'warning',
                title: health.title || 'Nexora Agent 存储提醒',
                message: health.title || '存储目录异常',
                detail,
                buttons: ['知道了']
            });
        } catch (e) {
            console.error('[System] Failed to show storage health dialog:', e.message);
        }
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
        setTimeout(show, 800);
    } else {
        setTimeout(show, 2500);
    }
    console.warn(`[System] Storage health=${health.level} code=${health.code} home=${homePath}`);
}

/** 若从旧 Temp 家目录迁出，尽量带上配置/微信缓存，避免对方重配 */
function migrateOpenClawDataIfNeeded(fromHome, toHome) {
    if (!fromHome || !toHome || path.resolve(fromHome) === path.resolve(toHome)) return;
    const srcRoot = path.join(fromHome, '.openclaw');
    const dstRoot = path.join(toHome, '.openclaw');
    if (!fs.existsSync(srcRoot)) return;
    try {
        fs.mkdirSync(dstRoot, { recursive: true });
        const copyIfMissing = (rel) => {
            const s = path.join(srcRoot, rel);
            const d = path.join(dstRoot, rel);
            if (!fs.existsSync(s) || fs.existsSync(d)) return;
            fs.mkdirSync(path.dirname(d), { recursive: true });
            fs.cpSync(s, d, { recursive: true, force: false, errorOnExist: false });
        };
        copyIfMissing('openclaw.json');
        copyIfMissing('openclaw-weixin');
        copyIfMissing('agents');
        console.warn(`[System] Migrated OpenClaw data from temp home ${srcRoot} -> ${dstRoot}`);
    } catch (e) {
        console.warn(`[System] Temp home migration skipped: ${e.message}`);
    }
}

function applyResolvedOpenClawHome(homePath) {
    const applied = applyOpenClawHomeEnv(homePath, process.env);
    CONFIG_DIR = applied.stateDir;
    CONFIG_PATH = path.join(CONFIG_DIR, 'openclaw.json');
}

/** 运行时补丁/脚本落盘目录：优先状态目录，不依赖固定 Users\Public */
function resolveWritableRuntimeDir() {
    const candidates = [
        typeof CONFIG_DIR === 'string' ? CONFIG_DIR : null,
        process.env.OPENCLAW_STATE_DIR,
        process.env.OPENCLAW_HOME && path.join(process.env.OPENCLAW_HOME, '.openclaw'),
        path.join(process.env.ProgramData || 'C:\\ProgramData', 'NexoraAgent', 'runtime'),
        path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'NexoraAgent', 'runtime'),
        path.join(resolveOpenClawStateDir(), 'runtime')
    ].filter(Boolean);
    for (const dir of candidates) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const probe = path.join(dir, `.write-probe-${process.pid}`);
            fs.writeFileSync(probe, '1', 'utf8');
            fs.unlinkSync(probe);
            return dir;
        } catch (e) {}
    }
    return candidates[0] || path.join(__dirname);
}

/** 把补丁与截图脚本部署到可写运行时目录，返回正斜杠补丁路径供 --require 使用 */
function deployRuntimeArtifacts() {
    const dir = resolveWritableRuntimeDir();
    // 优先拷贝应用内最新补丁（asar/工程），再回退 gateway-runtime（可能是旧解压）
    const names = ['patch_gateway.js', 'token-usage-parse.js', 'capture-desktop.ps1', 'openclaw-state.js', 'gateway-auth.js', 'gateway-boot-harden.js'];
    for (const name of names) {
        const srcCandidates = [path.join(__dirname, name), resolveAppFsPath(name)];
        const src = srcCandidates.find((p) => {
            try { return p && fs.existsSync(p) && !String(p).includes(`${path.sep}app.asar${path.sep}`); } catch (e) { return false; }
        }) || srcCandidates.find((p) => fs.existsSync(p));
        if (!src) continue;
        try {
            fs.copyFileSync(src, path.join(dir, name));
        } catch (e) {
            console.warn(`[TokenGuard] copy ${name} failed:`, e.message);
        }
    }
    const patchAbs = path.join(dir, 'patch_gateway.js');
    const patchPath = patchAbs.replace(/\\/g, '/');
    process.env.NEXORA_AGENT_PATCH_PATH = patchPath;
    process.env.NEXORA_AGENT_RUNTIME_DIR = dir;
    return { runtimeDir: dir, patchPath, patchAbs };
}

/** 清掉 OpenClaw 已不存在的 plugins.entries（消除启动 Config warnings） */
function pruneStalePluginConfigEntries(config) {
    if (!config || !config.plugins || !config.plugins.entries) return { changed: false };
    let changed = false;
    const entries = config.plugins.entries;
    const allow = Array.isArray(config.plugins.allow) ? config.plugins.allow : [];
    const installs = config.plugins.installs || {};
    const loadPaths = (config.plugins.load && Array.isArray(config.plugins.load.paths))
        ? config.plugins.load.paths
        : [];

    const existsOnDisk = (id) => {
        if (!id || id.startsWith('.') || id.includes('..')) return false;
        try {
            if (installs[id] && installs[id].installPath
                && fs.existsSync(path.join(installs[id].installPath, 'package.json'))) return true;
        } catch (e) {}
        try {
            const ext = path.join(CONFIG_DIR, 'extensions', id);
            if (fs.existsSync(ext)) return true;
        } catch (e) {}
        for (const p of loadPaths) {
            try {
                if (typeof p === 'string' && p.toLowerCase().includes(String(id).toLowerCase()) && fs.existsSync(p)) return true;
            } catch (e) {}
        }
        // 内置渠道：必须真有包，不能“清单里写了就算存在”（否则 Doctor 会对缺失包强制 npm）
        if (BUNDLED_CUSTOM_PLUGINS.includes(id)) return true;
        const bundled = BUNDLED_NPM_CHANNEL_PLUGINS.find((e) => e.id === id);
        if (bundled) {
            try {
                if (resolveBundledNpmPluginPath(bundled)) return true;
            } catch (e) {}
            return false;
        }
        // UI 伞形 id 不是 OpenClaw 插件 —— 下面会删掉，避免 Config warnings
        if (id === LONG_TERM_MEMORY_UI_ID) return false;
        try {
            if (LONG_TERM_MEMORY_STACK && LONG_TERM_MEMORY_STACK.includes(id)) return true;
        } catch (e) {}
        return false;
    };

    for (const id of Object.keys(entries)) {
        // 安装残留 / 明显无效 id
        if (id.startsWith('.') || id === 'key-rotator-proxy' || id === 'system-control' || id === 'channel-router') {
            delete entries[id];
            changed = true;
            continue;
        }
        // UI 伞形卡勿留给 OpenClaw（会报 plugin not found）；Nexora 面板用栈状态推导
        if (id === LONG_TERM_MEMORY_UI_ID) {
            delete entries[id];
            changed = true;
            continue;
        }
        if (!existsOnDisk(id)) {
            const channelIds = new Set([
                'feishu', 'qqbot', 'telegram', 'slack', 'whatsapp', 'matrix',
                'voice-call', 'openclaw-weixin'
            ]);
            if (channelIds.has(id)) {
                delete entries[id];
                if (installs[id]) {
                    delete installs[id];
                    changed = true;
                }
                if (Array.isArray(config.plugins.allow)) {
                    const next = config.plugins.allow.filter((x) => x !== id);
                    if (next.length !== config.plugins.allow.length) {
                        config.plugins.allow = next;
                        changed = true;
                    }
                }
                changed = true;
                continue;
            }
            delete entries[id];
            changed = true;
        }
    }

    if (Array.isArray(config.plugins.allow)) {
        const nextAllow = config.plugins.allow.filter((id) => {
            if (id === LONG_TERM_MEMORY_UI_ID) return false;
            if (id && id.startsWith('.')) return false;
            if (!entries[id]) return false;
            return true;
        });
        if (JSON.stringify(nextAllow) !== JSON.stringify(config.plugins.allow)) {
            config.plugins.allow = nextAllow;
            changed = true;
        }
    }

    // load.paths 微信已指向 runtime 时，删掉 installs 里的第二份，避免 duplicate 警告
    try {
        const wxInstall = installs['openclaw-weixin'];
        const wxBundled = resolveAppFsPath('node_modules', '@tencent-weixin', 'openclaw-weixin');
        if (wxInstall && wxBundled && fs.existsSync(wxBundled)) {
            const ip = wxInstall.installPath ? path.resolve(wxInstall.installPath) : '';
            const want = path.resolve(wxBundled);
            if (ip && ip !== want) {
                delete config.plugins.installs['openclaw-weixin'];
                changed = true;
            }
        }
    } catch (e) {}

    return { changed };
}

// 随应用打包、必须在别人电脑上默认可运行的自定义插件清单
const BUNDLED_CUSTOM_PLUGINS = [
    'error-filter',
    'weixin-reconnect',
    'auto-summary',
    'dual-model-trainer',
    'memory-rotate',
    'disk-compact',
    'compaction-memory-guard',
    'context-router',
    'health-check',
    'remote-policy'
];

// 随安装包一起交付的 npm 渠道插件。
// viaLoadPaths=false：走官方 installs（复制到本机 ~/.openclaw/npm/projects），
// 避免无影上残留「别人电脑」的绝对路径 / Program Files 坏入口导致全部加载失败。
const BUNDLED_NPM_CHANNEL_PLUGINS = [
    { id: 'openclaw-weixin', viaLoadPaths: true, candidates: [path.join('node_modules', '@tencent-weixin', 'openclaw-weixin')] },
    { id: 'qqbot', viaLoadPaths: true, packageName: '@openclaw/qqbot', candidates: [path.join('node_modules', '@openclaw', 'qqbot')] },
    { id: 'feishu', viaLoadPaths: true, packageName: '@openclaw/feishu', candidates: [path.join('node_modules', '@openclaw', 'feishu')] },
    // voice-call 绝不能进 load.paths（trusted store）
    { id: 'voice-call', viaLoadPaths: false, packageName: '@openclaw/voice-call', candidates: [path.join('node_modules', '@openclaw', 'voice-call')] },
    { id: 'slack', viaLoadPaths: true, packageName: '@openclaw/slack', candidates: [path.join('node_modules', '@openclaw', 'slack')] },
    { id: 'whatsapp', viaLoadPaths: true, packageName: '@openclaw/whatsapp', candidates: [path.join('node_modules', '@openclaw', 'whatsapp')] },
    { id: 'matrix', viaLoadPaths: true, packageName: '@openclaw/matrix', candidates: [path.join('node_modules', '@openclaw', 'matrix')] }
];

function pathLooksLikeOfficialOpenClawChannel(p) {
    return looksLikeOfficialOpenClawChannelPath(p);
}

function pluginPathUsableOnThisMachine(p) {
    if (!p || typeof p !== 'string') return false;
    return !isPluginPathStaleOnThisMachine(p, {
        userProfile: process.env.USERPROFILE || process.env.HOME || '',
        configDir: typeof CONFIG_DIR !== 'undefined' ? CONFIG_DIR : '',
        appRoot: __dirname,
        isForeignUserPath
    });
}

function applyMachinePluginPathSanitize(config) {
    return sanitizePluginPathsForThisMachine(config, {
        userProfile: process.env.USERPROFILE || process.env.HOME || '',
        configDir: typeof CONFIG_DIR !== 'undefined' ? CONFIG_DIR : '',
        appRoot: __dirname,
        isForeignUserPath
    });
}

function resolveBundledNpmPluginPath(entry) {
    const candidates = entry.candidates || [];
    for (const rel of candidates) {
        if (path.isAbsolute(rel)) {
            if (fs.existsSync(rel)) return rel;
            continue;
        }
        // 优先 asar.unpacked（沙箱 OpenClaw / 渠道插件需要真实文件路径）
        const unpacked = resolveAppFsPath(rel);
        if (fs.existsSync(unpacked)) return unpacked;
        const abs = path.join(__dirname, rel);
        if (fs.existsSync(abs)) return abs;
    }
    // 开发树缺包时，回退到网关解压目录及已安装产品目录
    const fallbackRoots = [
        getGatewayRuntimeRoot(require('electron').app),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Nexora Agent', 'resources', 'app.asar.unpacked'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Nexora Agent', 'resources', 'app'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Nexora Agent', 'resources', 'app.asar.unpacked'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Nexora Agent', 'resources', 'app')
    ];
    for (const root of fallbackRoots) {
        for (const rel of candidates) {
            if (path.isAbsolute(rel)) continue;
            const abs = path.join(root, rel);
            if (fs.existsSync(abs)) return abs;
        }
    }
    return null;
}

/**
 * OpenClaw 官方外部插件的 managed npm 项目目录名（与 openclaw install-safe-path 一致）。
 * 例: @openclaw/voice-call → openclaw-voice-call-<sha256前10位>
 */
function encodeOpenClawNpmProjectDirName(packageName) {
    const crypto = require('crypto');
    const trimmed = String(packageName || '').trim();
    if (!trimmed) throw new Error('invalid npm package name');
    const base = trimmed
        .replace(/[\\/]/g, '-')
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+/g, '')
        .replace(/-+$/g, '');
    const safe = (!base || base === '.' || base === '..') ? 'skill' : base;
    const hash = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 10);
    if (safe !== trimmed) return `${safe.length > 50 ? safe.slice(0, 50) : safe}-${hash}`;
    if (safe.length > 60) return `${safe.slice(0, 50)}-${hash}`;
    return safe;
}

/**
 * OpenClaw 官方 npm 插件常把 extensions 写成 ./index.ts，但发布包里只有 dist/index.js。
 * 不修的话 Gateway 会 ENOENT 跳过，表现为飞书/QQ/Slack 等「全部没加载」。
 * @returns {boolean} 是否改写了 package.json
 */
function repairOpenClawPluginPackageEntry(pluginDir) {
    if (!pluginDir || typeof pluginDir !== 'string') return false;
    const pkgPath = path.join(pluginDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) {
        return false;
    }
    if (!pkg || typeof pkg !== 'object') return false;

    let changed = false;
    const resolveExisting = (rel) => {
        if (!rel || typeof rel !== 'string') return null;
        const abs = path.isAbsolute(rel) ? rel : path.join(pluginDir, rel);
        return fs.existsSync(abs) ? abs : null;
    };

    const pickFallback = () => {
        const candidates = [
            './dist/index.js',
            './dist/channel-entry.js',
            './index.js',
            './index.mjs'
        ];
        for (const c of candidates) {
            if (resolveExisting(c)) return c;
        }
        return null;
    };

    const patchRelPath = (rel) => {
        if (!rel || typeof rel !== 'string') return rel;
        if (resolveExisting(rel)) return rel;
        // 典型坏配置：./index.ts 在 npm 包中不存在
        if (/\.tsx?$/i.test(rel) || /(?:^|[\\/])index\.tsx?$/i.test(rel)) {
            const fb = pickFallback();
            if (fb) {
                changed = true;
                return fb;
            }
        }
        const fb = pickFallback();
        if (fb && !resolveExisting(rel)) {
            changed = true;
            return fb;
        }
        return rel;
    };

    if (pkg.openclaw && Array.isArray(pkg.openclaw.extensions)) {
        const next = pkg.openclaw.extensions.map(patchRelPath);
        if (JSON.stringify(next) !== JSON.stringify(pkg.openclaw.extensions)) {
            pkg.openclaw.extensions = next;
            changed = true;
        }
    }

    if (pkg.openclaw && typeof pkg.openclaw.setupEntry === 'string') {
        const nextSetup = patchRelPath(pkg.openclaw.setupEntry);
        if (nextSetup !== pkg.openclaw.setupEntry) {
            pkg.openclaw.setupEntry = nextSetup;
            changed = true;
        }
    }

    // 若仍缺源文件，补一个最小 JS 入口，避免 OpenClaw 再追 index.ts
    try {
        const distIndex = path.join(pluginDir, 'dist', 'index.js');
        const rootTs = path.join(pluginDir, 'index.ts');
        const rootJs = path.join(pluginDir, 'index.js');
        if (fs.existsSync(distIndex) && !fs.existsSync(rootTs) && !fs.existsSync(rootJs)) {
            fs.writeFileSync(
                rootJs,
                "export * from './dist/index.js';\nexport { default } from './dist/index.js';\n",
                'utf8'
            );
            changed = true;
        }
    } catch (e) {}

    if (changed) {
        try {
            fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
            console.log(`[PluginSeed] Repaired plugin entry: ${pluginDir}`);
        } catch (e) {
            console.warn(`[PluginSeed] Failed to write repaired package.json at ${pkgPath}:`, e.message);
            return false;
        }
    }
    return changed;
}

/** 扫描随包 / load.paths / npm installs，批量修复坏掉的插件入口 */
function repairAllOpenClawPluginEntries(extraDirs) {
    const dirs = new Set();
    const add = (d) => {
        if (d && typeof d === 'string') dirs.add(path.resolve(d));
    };
    for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
        add(resolveBundledNpmPluginPath(entry));
    }
    if (Array.isArray(extraDirs)) {
        for (const d of extraDirs) add(d);
    }
    try {
        const installsRoot = path.join(CONFIG_DIR, 'npm', 'projects');
        if (fs.existsSync(installsRoot)) {
            for (const project of fs.readdirSync(installsRoot)) {
                const nm = path.join(installsRoot, project, 'node_modules');
                if (!fs.existsSync(nm)) continue;
                // @scope/name
                for (const scopeOrPkg of fs.readdirSync(nm)) {
                    const p1 = path.join(nm, scopeOrPkg);
                    if (scopeOrPkg.startsWith('@')) {
                        try {
                            for (const name of fs.readdirSync(p1)) add(path.join(p1, name));
                        } catch (e) {}
                    } else {
                        add(p1);
                    }
                }
            }
        }
    } catch (e) {}

    let n = 0;
    for (const d of dirs) {
        try {
            const pkgPath = path.join(d, 'package.json');
            if (!fs.existsSync(pkgPath)) continue;
            let name = '';
            try { name = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name || ''; } catch (e) {}
            // 仅修 OpenClaw 渠道/官方插件，避免误伤无关包
            if (!name.startsWith('@openclaw/') && !name.includes('openclaw-weixin') && !name.includes('openclaw-qqbot')) {
                continue;
            }
            if (repairOpenClawPluginPackageEntry(d)) n += 1;
        } catch (e) {}
    }
    if (n > 0) console.log(`[PluginSeed] Repaired ${n} plugin package entry(ies)`);
    return n;
}

/**
 * 把随包自带的官方 npm 插件离线种进 ~/.openclaw/npm/projects/...，
 * 让 OpenClaw 按官方安装恢复 install record → trustedOfficialInstall=true。
 * 这样别人电脑无需联网 npm install，也不必写 load.paths（load.paths 会丢掉 trust）。
 * @returns {{ seeded: boolean, installPath?: string, reason?: string }}
 */
function ensureOfficialExternalNpmPluginSeeded(params) {
    const packageName = params.packageName;
    const pluginId = params.pluginId;
    const packagedRel = path.join('node_modules', ...String(packageName).split('/'));
    const bundledSrc = params.bundledSrc
        || resolveBundledNpmPluginPath({ id: pluginId, candidates: [packagedRel] })
        || path.join(__dirname, packagedRel);
    if (!fs.existsSync(bundledSrc)) {
        return { seeded: false, reason: `bundled package missing: ${bundledSrc}` };
    }

    // 源目录也先修入口，避免 cpSync 把坏 package.json 再写进去
    try { repairOpenClawPluginPackageEntry(bundledSrc); } catch (e) {}

    let srcVersion = '';
    try {
        srcVersion = JSON.parse(fs.readFileSync(path.join(bundledSrc, 'package.json'), 'utf8')).version || '';
    } catch (e) {}

    // 不再拷贝到 ~/.openclaw/npm/projects/ 导致丢失 hoisted node_modules
    // 而是直接使用自带的绝对路径，并在 openclaw.json 中使用绝对路径的 installs
    const installPath = bundledSrc;

    return { seeded: true, installPath, version: srcVersion || '2026.7.1' };
}

// 飞书渠道配置自愈与规范化：返回是否发生了变更。
function sanitizeFeishuConfig(config) {
    if (!config || !config.channels || !config.channels.feishu) return false;
    const feishu = config.channels.feishu;
    if (typeof feishu !== 'object' || Array.isArray(feishu)) return false;
    let changed = false;

    // 空字符串的可选凭证会触发 OpenClaw secret 校验失败或让 websocket 模式误判，统一删除。
    const stripEmptyOptionalSecrets = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        for (const key of ['encryptKey', 'verificationToken', 'appSecret']) {
            if (obj[key] === '' || (typeof obj[key] === 'string' && obj[key].trim() === '')) {
                delete obj[key];
                changed = true;
            }
        }
    };

    stripEmptyOptionalSecrets(feishu);
    const accounts = feishu.accounts;
    let hasConfiguredAccount = false;
    if (accounts && typeof accounts === 'object') {
        for (const id of Object.keys(accounts)) {
            stripEmptyOptionalSecrets(accounts[id]);
            if (accounts[id] && accounts[id].appId && accounts[id].appSecret) hasConfiguredAccount = true;
        }
    }
    if (feishu.appId && feishu.appSecret) hasConfiguredAccount = true;

    // 已配置了有效账号时，补齐渠道启用与开放策略（不覆盖用户已有设置）。
    if (hasConfiguredAccount) {
        if (feishu.enabled !== true) { feishu.enabled = true; changed = true; }
        if (!feishu.dmPolicy) { feishu.dmPolicy = 'open'; changed = true; }
        if (!Array.isArray(feishu.allowFrom)) { feishu.allowFrom = ['*']; changed = true; }
        if (!feishu.groupPolicy) { feishu.groupPolicy = 'open'; changed = true; }
        if (!Array.isArray(feishu.groupAllowFrom)) { feishu.groupAllowFrom = ['*']; changed = true; }
        // 群里未 @ 也放行，避免「发了没反应」被误当成插件没加载
        if (feishu.requireMention === true) { feishu.requireMention = false; changed = true; }
        if (!feishu.connectionMode) { feishu.connectionMode = 'websocket'; changed = true; }
    }

    return changed;
}

// 通过 NODE_OPTIONS 把 patch_gateway.js 传播到Nexora Agent及其 spawn 出的所有子进程/worker。
function buildPatchedNodeOptions(patchPath) {
    const targetPath = String(patchPath || process.env.NEXORA_AGENT_PATCH_PATH || '')
        .replace(/\\/g, '/');
    if (!targetPath) return (process.env.NODE_OPTIONS || '').trim();
    const injected = `--require "${targetPath}" --dns-result-order=ipv4first --no-warnings`;
    const existing = (process.env.NODE_OPTIONS || '').trim();
    if (existing.includes(targetPath) || existing.includes('patch_gateway.js')) return existing.includes(targetPath) ? existing : `${injected} ${existing}`;
    return existing ? `${injected} ${existing}` : injected;
}

// 将随应用打包的自定义插件同步部署到 ~/.openclaw/extensions/
// 关键:
// 1) OpenClaw 发现用户插件的全局目录是 ~/.openclaw/extensions (不是 plugins)
// 2) 本仓库 plugins/* 几乎全是 ESM (import/export)，但多数缺少 package.json "type":"module"，
//    Node 会按 CJS 解析并直接 SyntaxError —— 这正是“打包后别人电脑插件全挂、控制台报错”的主因
// 3) 旧版本曾错误地复制到 ~/.openclaw/plugins，这里会顺带迁移过去
function ensurePluginPackageJson(destDir, pluginId) {
    const pkgPath = path.join(destDir, 'package.json');
    let pkg = null;
    try {
        if (fs.existsSync(pkgPath)) pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) { pkg = null; }

    if (!pkg) {
        pkg = {
            name: `@openclaw-plugin/${pluginId}`,
            version: '1.0.0'
        };
    }

    const indexJs = path.join(destDir, 'index.js');
    let needsEsm = false;
    try {
        if (fs.existsSync(indexJs)) {
            const head = fs.readFileSync(indexJs, 'utf8').slice(0, 4000);
            needsEsm = /\bimport\s/.test(head) || /\bexport\s/.test(head);
        }
    } catch (e) {}
    if (needsEsm && pkg.type !== 'module') pkg.type = 'module';

    let resolvedExtensions = null;

    // 如果原配置的 openclaw.extensions 有效且指向已存在的文件，则尊重原配置
    if (pkg.openclaw && Array.isArray(pkg.openclaw.extensions) && pkg.openclaw.extensions.length > 0) {
        const validExts = pkg.openclaw.extensions.filter(extPath => {
            return fs.existsSync(path.join(destDir, extPath));
        });
        if (validExts.length > 0) {
            resolvedExtensions = validExts;
        }
    }

    // 自动探测可用的 JS 入口
    if (!resolvedExtensions) {
        if (fs.existsSync(path.join(destDir, 'index.js'))) {
            resolvedExtensions = ['./index.js'];
        } else if (pkg.main && fs.existsSync(path.join(destDir, pkg.main))) {
            resolvedExtensions = [pkg.main];
        } else if (fs.existsSync(path.join(destDir, 'dist', 'index.js'))) {
            resolvedExtensions = ['./dist/index.js'];
        } else if (fs.existsSync(path.join(destDir, 'dist', 'index.mjs'))) {
            resolvedExtensions = ['./dist/index.mjs'];
        }
    }

    if (resolvedExtensions) {
        if (!pkg.openclaw) pkg.openclaw = {};
        pkg.openclaw.extensions = resolvedExtensions;
        if (!pkg.main) pkg.main = resolvedExtensions[0];
    } else {
        // 如果文件系统里确实没有任何合法的 JS 入口，直接删除整个 openclaw 字段，避免加载校验报错
        delete pkg.openclaw;
    }

    try {
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
    } catch (e) {
        console.error(`[PluginSeed] Failed to write package.json for ${pluginId}:`, e.message);
    }
}

function ensurePluginManifestJson(destDir, pluginId) {
    const manifestPath = path.join(destDir, 'openclaw.plugin.json');
    let manifest = null;
    let needsUpdate = false;

    if (fs.existsSync(manifestPath)) {
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (e) {
            manifest = null;
        }
    }

    if (!manifest) {
        let name = pluginId;
        let desc = `本地插件: ${pluginId}`;
        const pkgPath = path.join(destDir, 'package.json');
        try {
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                if (pkg.name) name = pkg.name;
                if (pkg.description) desc = pkg.description;
            }
        } catch (e) {}

        manifest = {
            id: pluginId,
            name: name,
            description: desc,
            version: '1.0.0',
            main: 'index.js'
        };
        needsUpdate = true;
    }

    const pkgPath = path.join(destDir, 'package.json');
    try {
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.main && manifest.main !== pkg.main) {
                manifest.main = pkg.main;
                needsUpdate = true;
            }
            if (pkg.type === 'module' && manifest.type !== 'module') {
                manifest.type = 'module';
                needsUpdate = true;
            }
        }
    } catch (e) {}

    if (!manifest.configSchema || typeof manifest.configSchema !== 'object') {
        manifest.configSchema = {
            type: 'object',
            properties: {
                enabled: {
                    type: 'boolean',
                    default: true,
                    description: `是否启用 ${manifest.name || pluginId} 插件`
                }
            }
        };
        needsUpdate = true;
    }

    if (needsUpdate) {
        try {
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
            console.log(`[PluginSeed] Successfully verified/updated openclaw.plugin.json for ${pluginId}`);
        } catch (e) {
            console.error(`[PluginSeed] Failed to write openclaw.plugin.json for ${pluginId}:`, e.message);
        }
    }
}

function copyPluginDir(srcDir, destDir, pluginId, appVersion) {
    const stampPath = path.join(destDir, '.bundle-version');
    let needCopy = true;
    if (fs.existsSync(destDir)) {
        try { if (fs.readFileSync(stampPath, 'utf8').trim() === appVersion) needCopy = false; } catch (e) {}
    }
    if (needCopy) {
        fs.cpSync(srcDir, destDir, { recursive: true, force: true });
        try { fs.writeFileSync(stampPath, appVersion, 'utf8'); } catch (e) {}
        console.log(`[PluginSeed] Deployed bundled plugin: ${pluginId}`);
    }
    ensurePluginPackageJson(destDir, pluginId);
    ensurePluginManifestJson(destDir, pluginId);
}

const DEFAULT_MEMORY_MD_TEMPLATE = `# MEMORY.md

## 核心身份
- （在此填写助手人设 / 名字）

## 用户偏好
- 称呼用户为：（待补充）
- 时区：GMT+8

## 工具使用规范
- （常用工具与注意事项）

## 重要约定
- 本文件是长期记忆；对话压缩后仍会优先读取这里的信息。
- 由 Nexora Agent「长期记忆」插件栈自动维护（摘要 / 旋转归档 / 压缩护栏）。
`;

/** 本地小模型专用短模板：官方 AGENTS.md 过长会直接撑爆 8k 上下文 */
const SHORT_WORKSPACE_AGENTS_MD = `# AGENTS.md

Be helpful and concise. Prefer short answers.

## Memory
- Use MEMORY.md for lasting facts only.

## Tools
- Prefer minimal tools. Skip heavy desktop actions unless asked.
`;

function seedDefaultMemoryFile(memFile) {
    try {
        const dir = path.dirname(memFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(memFile)) {
            fs.writeFileSync(memFile, DEFAULT_MEMORY_MD_TEMPLATE, 'utf8');
            console.log('[PluginSeed] Seeded default MEMORY.md');
            return true;
        }
        // 空文件也补齐模板，避免“有文件但无内容”导致看起来长期记忆无效
        try {
            const cur = fs.readFileSync(memFile, 'utf8').replace(/^\uFEFF/, '').trim();
            if (!cur) {
                fs.writeFileSync(memFile, DEFAULT_MEMORY_MD_TEMPLATE, 'utf8');
                console.log('[PluginSeed] Replaced empty MEMORY.md with template');
                return true;
            }
        } catch (e) {}
    } catch (e) {
        console.warn('[PluginSeed] seedDefaultMemoryFile failed:', e.message);
    }
    return false;
}

/**
 * 保证 workspace/AGENTS.md 存在且不会撑爆本地小模型上下文。
 * - 缺失：种短模板
 * - 已是官方长模板（>2.5KB）且当前主模型是 ollama/小窗：自动换成短模板（备份 .bak）
 */
function ensureCompactWorkspaceAgentsMd(wsDir) {
    try {
        const agentsWs = path.join(wsDir, 'AGENTS.md');
        const shortLocal = [
            path.join(__dirname, 'config', 'openclaw-templates', 'AGENTS.local.md'),
            resolveAppFsPath('config', 'openclaw-templates', 'AGENTS.local.md')
        ].find((p) => {
            try { return fs.existsSync(p); } catch (e) { return false; }
        });
        const shortBody = shortLocal
            ? fs.readFileSync(shortLocal, 'utf8')
            : SHORT_WORKSPACE_AGENTS_MD;

        let preferShort = true;
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
                const primary = cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model
                    && (typeof cfg.agents.defaults.model === 'string'
                        ? cfg.agents.defaults.model
                        : cfg.agents.defaults.model.primary);
                if (typeof primary === 'string' && !primary.startsWith('ollama/')) {
                    // 云端模型可用完整模板；仍保证文件存在
                    preferShort = false;
                }
            }
        } catch (e) {}

        if (!fs.existsSync(agentsWs)) {
            fs.writeFileSync(agentsWs, preferShort ? shortBody : SHORT_WORKSPACE_AGENTS_MD, 'utf8');
            console.log('[PluginSeed] Seeded workspace AGENTS.md (compact)');
            return true;
        }

        if (!preferShort) return false;

        const cur = fs.readFileSync(agentsWs, 'utf8');
        // 官方模板特征：很长，或含 First Run / Session Startup 大段
        const tooFat = cur.length > 2500
            || /## First Run/i.test(cur)
            || /## Session Startup/i.test(cur);
        if (tooFat) {
            try {
                fs.copyFileSync(agentsWs, agentsWs + '.bak-fat-' + Date.now());
            } catch (e) {}
            fs.writeFileSync(agentsWs, shortBody, 'utf8');
            console.log('[PluginSeed] Replaced fat workspace AGENTS.md with compact local template');
            return true;
        }
    } catch (e) {
        console.warn('[PluginSeed] ensureCompactWorkspaceAgentsMd:', e.message);
    }
    return false;
}

/**
 * 本地小模型：若 main session 转录过大，截断尾部，避免每轮 Preflight compaction 必挂。
 * 同时清理「已压缩但仍溢出」的卡死会话（already_compacted_recently）。
 */
function trimOversizedMainSessionTranscript() {
    try {
        const sessionsDir = path.join(CONFIG_DIR, 'agents', 'main', 'sessions');
        if (!fs.existsSync(sessionsDir)) return false;
        const MAX_BYTES = 120 * 1024;
        let trimmed = 0;
        let reset = 0;
        for (const name of fs.readdirSync(sessionsDir)) {
            if (!/\.(jsonl|json)$/i.test(name)) continue;
            const full = path.join(sessionsDir, name);
            let st;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if (!st.isFile()) continue;

            // 卡死标志：compaction checkpoint / 超大 / 近期 overflow
            let forceReset = false;
            try {
                if (st.size > MAX_BYTES) forceReset = true;
                else if (st.size > 4 * 1024) {
                    const fd = fs.openSync(full, 'r');
                    try {
                        const buf = Buffer.alloc(8000);
                        const n = fs.readSync(fd, buf, 0, 8000, 0);
                        const head = buf.slice(0, n).toString('utf8');
                        if (/compaction|checkpoint|COMPACTED|context.?overflow/i.test(head)) forceReset = true;
                    } finally {
                        try { fs.closeSync(fd); } catch (e) {}
                    }
                }
            } catch (e) {}

            if (forceReset) {
                try {
                    fs.copyFileSync(full, full + '.bak-reset-' + Date.now());
                    fs.writeFileSync(full, '', 'utf8');
                    reset += 1;
                    continue;
                } catch (e) {}
            }

            if (st.size <= MAX_BYTES) continue;
            try {
                const buf = fs.readFileSync(full);
                const keep = buf.slice(Math.max(0, buf.length - Math.floor(MAX_BYTES * 0.5)));
                const nl = keep.indexOf(0x0a);
                const out = nl >= 0 ? keep.slice(nl + 1) : keep;
                fs.copyFileSync(full, full + '.bak-trim-' + Date.now());
                fs.writeFileSync(full, out);
                trimmed += 1;
            } catch (e) {}
        }
        // sessions.json 里可能记着旧 token 估算，一并清掉 overflow 状态
        try {
            const store = path.join(sessionsDir, 'sessions.json');
            if (fs.existsSync(store)) {
                const raw = JSON.parse(fs.readFileSync(store, 'utf8').replace(/^\uFEFF/, ''));
                let changed = false;
                const walk = (obj) => {
                    if (!obj || typeof obj !== 'object') return;
                    if (Array.isArray(obj)) { obj.forEach(walk); return; }
                    for (const k of Object.keys(obj)) {
                        if (/token|compaction|overflow|checkpoint/i.test(k) && (typeof obj[k] === 'number' || typeof obj[k] === 'string')) {
                            // 不乱删结构，只清明显的估算字段
                            if (/estimated|overflow|compactionCount|lastCompaction/i.test(k)) {
                                delete obj[k];
                                changed = true;
                            }
                        } else if (typeof obj[k] === 'object') walk(obj[k]);
                    }
                };
                walk(raw);
                if (changed) {
                    fs.copyFileSync(store, store + '.bak-reset-' + Date.now());
                    fs.writeFileSync(store, JSON.stringify(raw, null, 2), 'utf8');
                    reset += 1;
                }
            }
        } catch (e) {}

        if (trimmed || reset) {
            console.log(`[PluginSeed] Session heal: trimmed=${trimmed} reset=${reset}`);
        }
        return trimmed > 0 || reset > 0;
    } catch (e) {
        console.warn('[PluginSeed] trimOversizedMainSessionTranscript:', e.message);
    }
    return false;
}

/** 启动时：主模型是 ollama 则强制重置卡死会话 + 压短 workspace */
function healOllamaContextOverflowOnBoot() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return;
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
        const primary = cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model
            && (typeof cfg.agents.defaults.model === 'string'
                ? cfg.agents.defaults.model
                : cfg.agents.defaults.model.primary);
        if (typeof primary !== 'string' || !primary.startsWith('ollama/')) return;
        ensureCompactWorkspaceAgentsMd(path.join(CONFIG_DIR, 'workspace'));

        const sessionsDir = path.join(CONFIG_DIR, 'agents', 'main', 'sessions');
        const healStamp = path.join(CONFIG_DIR, '.ollama-session-heal-v5');
        const needHardReset = !fs.existsSync(healStamp);
        let resetCount = 0;

        // 升级后一次性硬重置：清掉 already_compacted_recently / 错误 token 估算
        if (needHardReset && fs.existsSync(sessionsDir)) {
            for (const name of fs.readdirSync(sessionsDir)) {
                if (!/\.(jsonl|json)$/i.test(name)) continue;
                if (/^sessions\.json$/i.test(name)) continue;
                const full = path.join(sessionsDir, name);
                try {
                    if (!fs.statSync(full).isFile()) continue;
                    fs.copyFileSync(full, full + '.bak-heal-v5-' + Date.now());
                    if (/\.jsonl$/i.test(name)) fs.writeFileSync(full, '', 'utf8');
                    else fs.renameSync(full, full + '.bak-dead-' + Date.now());
                    resetCount += 1;
                } catch (e) {}
            }
            // sessions.json：去掉 compaction / token 估算，打断卡死映射
            try {
                const store = path.join(sessionsDir, 'sessions.json');
                if (fs.existsSync(store)) {
                    const raw = JSON.parse(fs.readFileSync(store, 'utf8').replace(/^\uFEFF/, ''));
                    const scrub = (obj) => {
                        if (!obj || typeof obj !== 'object') return;
                        if (Array.isArray(obj)) { obj.forEach(scrub); return; }
                        for (const k of Object.keys(obj)) {
                            if (/compaction|overflow|checkpoint|estimatedTokens|totalTokens|inputTokens|promptTokens|contextTokens|lastCompaction/i.test(k)) {
                                delete obj[k];
                            } else if (typeof obj[k] === 'object') scrub(obj[k]);
                        }
                    };
                    scrub(raw);
                    fs.copyFileSync(store, store + '.bak-heal-v5-' + Date.now());
                    fs.writeFileSync(store, JSON.stringify(raw, null, 2), 'utf8');
                    resetCount += 1;
                }
            } catch (e) {}
            try {
                fs.writeFileSync(healStamp, new Date().toISOString() + '\n', 'utf8');
            } catch (e) {}
            console.log(`[PluginSeed] ollama hard session reset (v5): files=${resetCount}`);
        } else {
            trimOversizedMainSessionTranscript();
        }
        console.log('[PluginSeed] ollama context overflow heal applied');
    } catch (e) {
        console.warn('[PluginSeed] healOllamaContextOverflowOnBoot:', e.message);
    }
}

function seedBundledPlugins() {
    try {
        const destRoot = path.join(CONFIG_DIR, 'extensions');
        fs.mkdirSync(destRoot, { recursive: true });
        try {
            fs.mkdirSync(path.join(CONFIG_DIR, 'workspace', 'memory'), { recursive: true });
            const memFile = path.join(CONFIG_DIR, 'workspace', 'MEMORY.md');
            seedDefaultMemoryFile(memFile);
        } catch (e) {}

        let appVersion = '0.0.0';
        try { appVersion = app.getVersion(); } catch (e) {}

        const legacyRoot = path.join(CONFIG_DIR, 'plugins');
        if (fs.existsSync(legacyRoot)) {
            try {
                for (const name of fs.readdirSync(legacyRoot)) {
                    const srcDir = path.join(legacyRoot, name);
                    const destDir = path.join(destRoot, name);
                    if (!fs.statSync(srcDir).isDirectory()) continue;
                    if (!fs.existsSync(destDir)) {
                        fs.cpSync(srcDir, destDir, { recursive: true, force: true });
                        console.log(`[PluginSeed] Migrated legacy plugin: ${name}`);
                    }
                    ensurePluginPackageJson(destDir, name);
                    ensurePluginManifestJson(destDir, name);
                }
            } catch (e) {
                console.error('[PluginSeed] Legacy migration failed:', e.message);
            }
        }

        const seedFromRoot = (srcRoot) => {
            if (!fs.existsSync(srcRoot)) return;
            for (const name of fs.readdirSync(srcRoot)) {
                const srcDir = path.join(srcRoot, name);
                try {
                    if (!fs.statSync(srcDir).isDirectory()) continue;
                    if (name === 'matrix') continue;
                    const looksLikePlugin = fs.existsSync(path.join(srcDir, 'openclaw.plugin.json')) ||
                        fs.existsSync(path.join(srcDir, 'index.js')) ||
                        fs.existsSync(path.join(srcDir, 'package.json'));
                    if (!looksLikePlugin) continue;
                    copyPluginDir(srcDir, path.join(destRoot, name), name, appVersion);
                } catch (e) {
                    console.error(`[PluginSeed] Failed to deploy plugin ${name}:`, e.message);
                }
            }
        };

        seedFromRoot(resolveAppFsPath('plugins'));
        seedFromRoot(resolveAppFsPath('extensions'));
        // 开发态/asar 回退
        if (!fs.existsSync(resolveAppFsPath('plugins'))) seedFromRoot(path.join(__dirname, 'plugins'));
        if (!fs.existsSync(resolveAppFsPath('extensions'))) seedFromRoot(path.join(__dirname, 'extensions'));

        // 终极自愈保底：遍历所有已部署的 extensions 插件目录，补齐缺失的配置文件防止 OpenClaw 报错
        if (fs.existsSync(destRoot)) {
            for (const name of fs.readdirSync(destRoot)) {
                const pluginDir = path.join(destRoot, name);
                try {
                    if (fs.statSync(pluginDir).isDirectory()) {
                        ensurePluginPackageJson(pluginDir, name);
                        ensurePluginManifestJson(pluginDir, name);
                    }
                } catch (e) {}
            }
        }
    } catch (e) {
        console.error('[PluginSeed] seedBundledPlugins failed:', e.message);
    }
}

/** Gateway 启动前：把内置渠道插件登记进 installs / load.paths，避免交互式 Install? 卡死。 */
function prepareChannelPluginsBeforeGateway() {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    let config = JSON.parse(raw);
    let needsSave = false;

    if (!config.plugins) { config.plugins = {}; needsSave = true; }
    if (!config.plugins.entries) { config.plugins.entries = {}; needsSave = true; }
    if (!config.plugins.allow) { config.plugins.allow = []; needsSave = true; }
    if (!config.plugins.load) { config.plugins.load = {}; needsSave = true; }
    if (!Array.isArray(config.plugins.load.paths)) { config.plugins.load.paths = []; needsSave = true; }
    if (!config.plugins.installs) { config.plugins.installs = {}; needsSave = true; }

    try {
        const pruned = pruneStalePluginConfigEntries(config);
        if (pruned.changed) needsSave = true;
    } catch (e) {}

    // 启动前：多机/多用户路径自愈（云电脑、换账号、从旧机拷配置都能用）
    try {
        const sanitized = applyMachinePluginPathSanitize(config);
        if (sanitized.changed) {
            needsSave = true;
            console.warn(
                `[PluginSeed] Machine adapt cleaned ${sanitized.droppedPaths.length} stale path(s):`,
                (sanitized.notes || []).slice(0, 8).join(', ')
            );
        }
    } catch (e) {
        console.warn('[PluginSeed] applyMachinePluginPathSanitize:', e.message);
    }

    // 启动前先修坏掉的 index.ts 入口，否则飞书/QQ/Slack 等会整批加载失败
    try {
        const installPaths = Object.values(config.plugins.installs || {})
            .map((x) => x && x.installPath)
            .filter(Boolean);
        repairAllOpenClawPluginEntries([...(config.plugins.load.paths || []), ...installPaths]);
    } catch (e) {
        console.warn('[PluginSeed] repairAllOpenClawPluginEntries:', e.message);
    }

    // fatal/silent 会让渠道收消息在控制台完全没痕迹，像「没加载 / 没反应」
    if (!config.logging) { config.logging = {}; needsSave = true; }
    if (config.logging.level === 'fatal' || config.logging.level === 'silent' || !config.logging.level) {
        config.logging.level = 'info';
        needsSave = true;
    }

    const wantById = {};
    for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
        if (entry.viaLoadPaths === false) continue;
        const abs = resolveBundledNpmPluginPath(entry);
        if (abs) wantById[entry.id] = path.resolve(abs);
    }

    const channelPathMatchers = [
        { id: 'openclaw-weixin', re: /(?:^|[\\/])openclaw-weixin(?:[\\/]|$)/i },
        { id: 'feishu', re: /[\\/]@openclaw[\\/]feishu(?:[\\/]|$)/i },
        { id: 'qqbot', re: /[\\/]@openclaw[\\/]qqbot(?:[\\/]|$)/i },
        { id: 'slack', re: /[\\/]@openclaw[\\/]slack(?:[\\/]|$)/i },
        { id: 'whatsapp', re: /[\\/]@openclaw[\\/]whatsapp(?:[\\/]|$)/i },
        { id: 'matrix', re: /[\\/]@openclaw[\\/]matrix(?:[\\/]|$)/i },
        { id: 'voice-call', re: /[\\/]@openclaw[\\/]voice-call(?:[\\/]|$)/i }
    ];

    const filteredPaths = [];
    for (const p of config.plugins.load.paths) {
        if (typeof p !== 'string') { needsSave = true; continue; }
        // 无影：丢掉「别人电脑」绝对路径 / 已删除路径 / 应走 installs 的官方包
        if (isForeignUserPath(p) || pathLooksLikeOfficialOpenClawChannel(p) || !pluginPathUsableOnThisMachine(p)) {
            needsSave = true;
            continue;
        }
        let drop = false;
        for (const m of channelPathMatchers) {
            if (!m.re.test(p)) continue;
            const entry = BUNDLED_NPM_CHANNEL_PLUGINS.find((e) => e.id === m.id);
            if (entry && entry.viaLoadPaths === false) {
                drop = true;
                needsSave = true;
                break;
            }
            const want = wantById[m.id];
            if (!want || path.resolve(p) !== want) {
                drop = true;
                needsSave = true;
            }
            break;
        }
        if (drop) continue;
        filteredPaths.push(p);
    }

    // 仅微信等非官方包写入 load.paths；飞书/QQ 等一律走下方 installs 种子
    // 注意：viaLoadPaths=false 时绝不能无条件 enabled=true（缺包会触发 Doctor npm install 并阻断 Gateway ready）
    for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
        if (entry.viaLoadPaths === false) continue;
        const abs = resolveBundledNpmPluginPath(entry);
        if (!abs) {
            console.warn(`[PluginSeed] Pre-gateway missing bundled: ${entry.id}`);
            if (config.plugins.entries[entry.id] && config.plugins.entries[entry.id].enabled !== false) {
                config.plugins.entries[entry.id].enabled = false;
                needsSave = true;
            }
            continue;
        }
        // 即便 bundled 在 Program Files，也优先种到本机 installs 再用；load.paths 仅保留本机可用路径
        if (!pluginPathUsableOnThisMachine(abs) || isForeignUserPath(abs)) {
            console.warn(`[PluginSeed] Skip foreign/missing load path for ${entry.id}: ${abs}`);
            continue;
        }
        const resolvedPath = path.resolve(abs);
        if (!filteredPaths.some((p) => path.resolve(p) === resolvedPath)) {
            filteredPaths.push(abs);
            needsSave = true;
        }
        if (!config.plugins.entries[entry.id]) {
            config.plugins.entries[entry.id] = { enabled: true };
            needsSave = true;
        }
        if (config.plugins.entries[entry.id].enabled === true && !config.plugins.allow.includes(entry.id)) {
            config.plugins.allow.push(entry.id);
            needsSave = true;
        }
    }

    if (JSON.stringify(config.plugins.load.paths) !== JSON.stringify(filteredPaths)) {
        config.plugins.load.paths = filteredPaths;
        needsSave = true;
    }

    // 官方渠道：强制种到「当前用户」的 npm/projects，并纠正跨机 installPath
    // viaLoadPaths=true（如微信）只走 load.paths，避免 installs + load.paths 双份 duplicate
    for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
        if (entry.viaLoadPaths === true) {
            if (config.plugins.installs && config.plugins.installs[entry.id]) {
                delete config.plugins.installs[entry.id];
                needsSave = true;
            }
            continue;
        }
        const packageName = entry.packageName
            || (entry.id === 'openclaw-weixin' ? '@tencent-weixin/openclaw-weixin' : null);
        if (!packageName) continue;
        try {
            const prev = config.plugins.installs[entry.id] || {};
            if (prev.installPath && (isForeignUserPath(prev.installPath) || !fs.existsSync(prev.installPath))) {
                delete config.plugins.installs[entry.id];
                needsSave = true;
                console.warn(`[PluginSeed] Dropped foreign/missing install for ${entry.id}: ${prev.installPath}`);
            }
            const seed = ensureOfficialExternalNpmPluginSeeded({
                pluginId: entry.id,
                packageName
            });
            if (!seed.seeded) {
                console.warn(`[PluginSeed] Pre-gateway ${entry.id}:`, seed.reason);
                // 种不进去就关闭，避免 Doctor 在沙箱缺 npm 时卡死启动
                if (!config.plugins.entries[entry.id]) {
                    config.plugins.entries[entry.id] = { enabled: false };
                    needsSave = true;
                } else if (config.plugins.entries[entry.id].enabled !== false) {
                    config.plugins.entries[entry.id].enabled = false;
                    needsSave = true;
                }
                if (Array.isArray(config.plugins.allow)) {
                    const nextAllow = config.plugins.allow.filter((x) => x !== entry.id);
                    if (nextAllow.length !== config.plugins.allow.length) {
                        config.plugins.allow = nextAllow;
                        needsSave = true;
                    }
                }
                continue;
            }
            const ver = seed.version || (prev && prev.resolvedVersion) || '0.0.0';
            const next = {
                ...(config.plugins.installs[entry.id] || {}),
                source: 'npm',
                spec: `${packageName}@${ver}`,
                installPath: seed.installPath,
                resolvedName: packageName,
                resolvedVersion: ver,
                resolvedSpec: `${packageName}@${ver}`,
                version: ver,
                installedAt: (config.plugins.installs[entry.id] && config.plugins.installs[entry.id].installedAt)
                    || new Date().toISOString()
            };
            if (JSON.stringify(config.plugins.installs[entry.id] || {}) !== JSON.stringify(next)) {
                config.plugins.installs[entry.id] = next;
                needsSave = true;
            }
            // 有包：与本机一致，默认启用并进 allow（Doctor 认 installs 后不会再去 npm）
            if (!config.plugins.entries[entry.id]) {
                config.plugins.entries[entry.id] = { enabled: true };
                needsSave = true;
            } else if (config.plugins.entries[entry.id].enabled !== true) {
                config.plugins.entries[entry.id].enabled = true;
                needsSave = true;
            }
            if (!config.plugins.allow.includes(entry.id)) {
                config.plugins.allow.push(entry.id);
                needsSave = true;
            }
        } catch (e) {
            console.warn(`[PluginSeed] Pre-gateway ${entry.id} failed:`, e.message);
        }
    }

    // 已配置凭证的渠道必须 enabled+allow，否则 Gateway 不加载、发消息控制台无日志也不回复
    try {
        const forceOn = (pluginId) => {
            const bundled = BUNDLED_NPM_CHANNEL_PLUGINS.find((e) => e.id === pluginId);
            if (bundled) {
                if (bundled.viaLoadPaths === true) {
                    if (!resolveBundledNpmPluginPath(bundled)) {
                        console.warn(`[PluginSeed] Cannot force-enable ${pluginId}: bundled package missing`);
                        return;
                    }
                } else {
                    const inst = config.plugins.installs && config.plugins.installs[pluginId];
                    const ok = inst && inst.installPath
                        && fs.existsSync(path.join(inst.installPath, 'package.json'));
                    if (!ok) {
                        console.warn(`[PluginSeed] Cannot force-enable ${pluginId}: install seed missing`);
                        return;
                    }
                }
            }
            if (!config.plugins.entries[pluginId]) config.plugins.entries[pluginId] = {};
            if (config.plugins.entries[pluginId].enabled !== true) {
                config.plugins.entries[pluginId].enabled = true;
                needsSave = true;
            }
            if (!config.plugins.allow.includes(pluginId)) {
                config.plugins.allow.push(pluginId);
                needsSave = true;
            }
        };
        if (config.channels && config.channels.feishu) {
            if (sanitizeFeishuConfig(config)) needsSave = true;
            const f = config.channels.feishu;
            const hasCred = !!(f.appId && f.appSecret)
                || (f.accounts && Object.values(f.accounts).some((a) => a && a.appId && a.appSecret));
            if (hasCred) {
                if (f.enabled !== true) { f.enabled = true; needsSave = true; }
                forceOn('feishu');
            }
        }
        if (config.channels && config.channels.qqbot) {
            const q = config.channels.qqbot;
            const hasQ = !!(q.appId || q.appSecret || q.clientId
                || (q.accounts && Object.keys(q.accounts).length));
            if (hasQ || q.enabled === true) {
                if (q.enabled !== true) { q.enabled = true; needsSave = true; }
                forceOn('qqbot');
            }
        }
        // 微信以磁盘账号为准：accounts.json 有号 → 强制开插件
        try {
            const wxAccounts = path.join(CONFIG_DIR, 'openclaw-weixin', 'accounts.json');
            if (fs.existsSync(wxAccounts)) {
                const list = JSON.parse(fs.readFileSync(wxAccounts, 'utf8'));
                if (Array.isArray(list) && list.length > 0) forceOn('openclaw-weixin');
            }
        } catch (e) {}
        if (config.channels && config.channels['openclaw-weixin']) forceOn('openclaw-weixin');
    } catch (e) {
        console.warn('[PluginSeed] channel force-enable skipped:', e.message);
    }

    // 持久化 gateway auth token，避免每次启动临时 token + 控制台刷屏
    try {
        const norm = normalizeGatewayAuthConfig(config, NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN);
        config = norm.config;
        if (norm.changed) {
            needsSave = true;
            console.log('[PluginSeed] Persisted default gateway.auth.token');
        }
    } catch (e) {}

    if (needsSave) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        console.log('[PluginSeed] Pre-gateway channel trust records synced');
        
        // 关键安全重置：如果发生了配置保存（通常意味着清除了跨机错乱的 installPath，或者初次写 installs），
        // 那么缓存的 SQLite 插件状态可能也是脏的。我们直接清除 sqlite 数据库，逼迫 OpenClaw 下次启动
        // 从干净的 config 中重新读取 installs 并重建 plugin index。
        const dbPath = path.join(CONFIG_DIR, 'openclaw.sqlite');
        const dbWal = path.join(CONFIG_DIR, 'openclaw.sqlite-wal');
        const dbShm = path.join(CONFIG_DIR, 'openclaw.sqlite-shm');
        try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch (e) {}
        try { if (fs.existsSync(dbWal)) fs.unlinkSync(dbWal); } catch (e) {}
        try { if (fs.existsSync(dbShm)) fs.unlinkSync(dbShm); } catch (e) {}
        console.log('[PluginSeed] Cleared stale SQLite database cache due to config update');
    }
}

// 忽略证书错误以兼容 Clash 等代理软件的 HTTPS 劫持/解密校验
app.commandLine.appendSwitch('ignore-certificate-errors');

// 单例锁，防止启动多个应用
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            try { mainWindow.setBackgroundColor('#0d0b18'); } catch (e) {}
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function createSplashWindow() {
    const splash = new BrowserWindow({
        width: 400,
        height: 300,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        center: true,
        show: true,
        backgroundColor: '#00000000'
    });
    splash.loadFile('splash.html');
    return splash;
}

function updateSplashStatus(splash, message, percent) {
    if (!splash || splash.isDestroyed()) return;
    const msg = JSON.stringify(String(message || ''));
    const pct = typeof percent === 'number' ? percent : 'null';
    splash.webContents
        .executeJavaScript(`window.__setStatus && window.__setStatus(${msg}, ${pct})`)
        .catch(() => {});
}

function createWindow(existingSplash) {
    // ------------------- Splash Screen -------------------
    const splash = existingSplash && !existingSplash.isDestroyed()
        ? existingSplash
        : createSplashWindow();
    // 主窗口保持隐藏，待渲染完成后一次性弹出
    const WINDOW_BG = '#0d0b18';
    mainWindow = new BrowserWindow({
        width: 1120,
        height: 760,
        minWidth: 1120,
        minHeight: 760,
        frame: false,
        resizable: true,
        maximizable: true,
        show: false,
        backgroundColor: WINDOW_BG,
        // 明确不透明，避免还原时透出系统白底
        transparent: false,
        hasShadow: true,
        icon: path.join(__dirname, 'config', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: false,
            allowRunningInsecureContent: true,
            webviewTag: true,
            backgroundThrottling: false
        }
    });
    // 开发态才清缓存；安装包每次 clearCache 会明显拖慢首屏
    try {
        if (!app.isPackaged) {
            session.defaultSession.clearCache().catch(() => {});
        }
    } catch (e) {}

    mainWindow.loadFile('index.html');
    // 当渲染进程首次绘制完成后，关闭 splash 并展示主窗口
    mainWindow.once('ready-to-show', () => {
        splash.destroy();
        try { mainWindow.setBackgroundColor(WINDOW_BG); } catch (e) {}
        mainWindow.show();
    });

    // 最小化/托盘还原时再刷一次底色，压住 Windows 白闪
    const paintDarkBg = () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.setBackgroundColor(WINDOW_BG);
            }
        } catch (e) {}
    };
    mainWindow.on('restore', paintDarkBg);
    mainWindow.on('show', paintDarkBg);
    mainWindow.on('focus', paintDarkBg);

    // 拦截本地Nexora Agent面板的 HTTP 响应头，移除 X-Frame-Options 限制，防止内置 iframe 跨域白屏/黑屏拒绝渲染
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = { ...details.responseHeaders };
        const headersToDelete = [
            'x-frame-options', 
            'X-Frame-Options', 
            'content-security-policy', 
            'Content-Security-Policy'
        ];
        headersToDelete.forEach(h => {
            delete responseHeaders[h];
        });
        callback({ cancel: false, responseHeaders });
    });



    mainWindow.on('maximize', () => {
        isMaximizedState = true;
        mainWindow.webContents.send('window-maximized-status', true);
    });

    mainWindow.on('unmaximize', () => {
        isMaximizedState = false;
        mainWindow.webContents.send('window-maximized-status', false);
    });

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide(); // 隐藏窗口到托盘
            showNotification('Nexora Agent助手已最小化', 'Nexora Agent服务在后台持续运行，可通过右下角托盘图标唤醒。');
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 移除硬编码自动拉起，改由前端根据设置（setting_auto_launch_gateway）自主判断并发送 IPC 触发拉起
    // startGatewayProcess();
}

// 创建系统托盘
function createTray() {
    tray = new Tray(path.join(__dirname, 'config', 'icon.png')); // 使用机器人高级图标
    const contextMenu = Menu.buildFromTemplate([
        { 
            label: '显示主界面', 
            click: () => {
                try { mainWindow.setBackgroundColor('#0d0b18'); } catch (e) {}
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            } 
        },
        { type: 'separator' },
        { 
            label: '启动Nexora Agent', 
            click: () => {
                if (mainWindow) mainWindow.webContents.send('gateway-control-trigger', 'start');
            } 
        },
        { 
            label: '停止Nexora Agent', 
            click: () => {
                if (mainWindow) mainWindow.webContents.send('gateway-control-trigger', 'stop');
            } 
        },
        { type: 'separator' },
        { 
            label: '退出应用', 
            click: () => {
                isQuitting = true;
                stopGatewayProcess();
                app.quit();
            } 
        }
    ]);
    tray.setToolTip('Nexora Agent');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
        try { mainWindow.setBackgroundColor('#0d0b18'); } catch (e) {}
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });
}

// 辅助显示原生系统通知
function showNotification(title, body) {
    if (Notification.isSupported()) {
        new Notification({ title, body }).show();
    }
}

// 异步非阻塞执行命令，防止锁死主进程事件循环导致的界面卡死
function execAsync(cmd) {
    const { exec } = require('child_process');
    return new Promise((resolve) => {
        exec(cmd, (err, stdout) => {
            resolve(stdout || '');
        });
    });
}

// 停止后台Nexora Agent子进程
async function stopGatewayProcess() {
    if (gatewayProcess) {
        gatewayProcess.isIntentionallyStopped = true; // 标记为主动停止，避免触发意外退出警报
        if (process.platform === 'win32') {
            try {
                // 精准物理强杀所有可能遗留的旧沙箱 node.exe 僵尸进程，彻底杜绝多实例抢占和日志刷屏
                const killCmd = `powershell -ExecutionPolicy Bypass -NoProfile -Command "try { Get-CimInstance Win32_Process -Filter \\"Name = 'node.exe'\\" | Where-Object { $_.ExecutablePath -like '*Nexora Agent*' -or $_.CommandLine -like '*openclaw*' -or $_.ExecutablePath -like '*.node-sandbox*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } } catch {}; exit 0"`;
                await execAsync(killCmd);
                await execAsync(`taskkill /pid ${gatewayProcess.pid} /T /F`);
            } catch (err) {
                try { gatewayProcess.kill('SIGKILL'); } catch (e) {}
            }
            // 保底物理清除霸占端口 18789 的残留
            try {
                const netstatOut = await execAsync('netstat -ano');
                const lines = netstatOut.split('\n');
                for (const line of lines) {
                    if (line.includes(':18789') && line.includes('LISTENING')) {
                        const parts = line.trim().split(/\s+/);
                        const pid = parts[parts.length - 1];
                        if (pid && parseInt(pid) > 0) {
                            try { await execAsync(`taskkill /pid ${pid} /F /T`); } catch(e) {}
                        }
                    }
                }
            } catch(err) {}
        } else {
            gatewayProcess.kill('SIGTERM');
        }
        gatewayProcess = null;
        stopGatewayHttpReadyWatch();
        gatewayHttpReadyNotified = false;
        if (mainWindow) {
            mainWindow.webContents.send('gateway-status', 'stopped');
            mainWindow.webContents.send('gateway-log', '\n[System] Nexora Agent服务已停止。\n');
        }
    }
}

// IPC 消息监听
ipcMain.on('window-action', (event, action) => {
    if (!mainWindow) return;
    if (action === 'minimize') {
        mainWindow.minimize();
    } else if (action === 'maximize') {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
            if (normalBounds) {
                mainWindow.setBounds(normalBounds, true);
            } else {
                mainWindow.setSize(1120, 760, true);
                mainWindow.center();
            }
        } else {
            normalBounds = mainWindow.getBounds();
            mainWindow.maximize();
        }
    } else if (action === 'close') {
        mainWindow.close();
    }
});

// 启动后台Nexora Agent进程
async function startGatewayProcess() {
        if (gatewayProcess) {
            if (mainWindow) {
                mainWindow.webContents.send('gateway-status', 'running');
            }
            return;
        }

        try {
            await checkAndHealSandboxNode();
        } catch (err) {
            console.error('[SandboxCheck] Error during check and heal:', err);
            if (mainWindow) {
                mainWindow.webContents.send('gateway-status', 'stopped');
                mainWindow.webContents.send('gateway-log', `[System] 环境自愈升级出错: ${err.message}\n`);
            }
            showNotification('环境自愈失败', err.message);
            return;
        }

        // 每次拉起Nexora Agent前，先物理强制杀掉任何霸占 18789 端口的残留进程，确保新实例完美就绪
        if (process.platform === 'win32') {
            try {
                // 精准物理强杀所有可能遗留的旧沙箱 node.exe 僵尸进程，彻底杜绝多实例抢占和日志刷屏
                const killCmd = `powershell -ExecutionPolicy Bypass -NoProfile -Command "try { Get-CimInstance Win32_Process -Filter \\"Name = 'node.exe'\\" | Where-Object { $_.ExecutablePath -like '*Nexora Agent*' -or $_.CommandLine -like '*openclaw*' -or $_.ExecutablePath -like '*.node-sandbox*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } } catch {}; exit 0"`;
                await execAsync(killCmd);

                const currentPid = process.pid;
                const parentPid = process.ppid;
                const netstatOut = await execAsync('netstat -ano');
                const lines = netstatOut.split('\n');
                const pidsToKill = new Set();
                for (const line of lines) {
                    if (line.includes(':18789') && line.includes('LISTENING')) {
                        const parts = line.trim().split(/\s+/);
                        const pid = parts[parts.length - 1];
                        if (pid && parseInt(pid) > 0 && pid !== currentPid.toString() && pid !== parentPid.toString()) {
                            pidsToKill.add(pid);
                        }
                    }
                }
                for (const pid of pidsToKill) {
                    try {
                        await execAsync(`taskkill /pid ${pid} /F`);
                    } catch (e) {}
                }
            } catch(err) {
                console.error('Failed to cleanup leftover port 18789 processes:', err);
            }
        }

        if (mainWindow) {
            mainWindow.webContents.send('gateway-status', 'starting');
            mainWindow.webContents.send('gateway-log', '[System] 正在拉起内置 OpenClaw Gateway 核心...\n');
        }
        try {
            // 不再每次启动清空 skills-prompts：删除后启动期会海量 ENOENT + 日志洪水，Ready 极慢。
            // 仅保证目录存在；损坏（同名非目录文件）时由 patch_gateway 清理。
            const promptsDirs = [
                path.join(CONFIG_DIR, 'agents', 'main', 'sessions', 'skills-prompts'),
                process.env.OPENCLAW_STATE_DIR
                    ? path.join(process.env.OPENCLAW_STATE_DIR, 'agents', 'main', 'sessions', 'skills-prompts')
                    : null
            ].filter(Boolean);
            promptsDirs.forEach((p) => {
                try {
                    if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
                        fs.unlinkSync(p);
                    }
                    fs.mkdirSync(p, { recursive: true });
                } catch (e) {}
            });

            // workspace 模板：缺文件会报 Missing workspace template；本地小模型必须用短 AGENTS.md
            try {
                const ws = path.join(CONFIG_DIR, 'workspace');
                fs.mkdirSync(ws, { recursive: true });
                const hb = path.join(ws, 'HEARTBEAT.md');
                if (!fs.existsSync(hb)) {
                    fs.writeFileSync(hb, '<!-- empty heartbeat; skip scheduled calls -->\n', 'utf8');
                }
                seedDefaultMemoryFile(path.join(ws, 'MEMORY.md'));
                ensureCompactWorkspaceAgentsMd(ws);
            } catch (e) {}

            // 部署补丁到可写目录（Doctor 迁移 / harden 依赖最新脚本）
            try { deployRuntimeArtifacts(); } catch (e) {}

            // 确保在网关启动前，openclaw.json 已经初始化了必需的插件 allow 列表
            ensureOpenClawConfigInitialized();

            // 每次启动 Gateway 前强制同步渠道插件信任记录（load.paths + plugins.installs），
            try {
                prepareChannelPluginsBeforeGateway();
            } catch (e) {
                console.warn('[PluginSeed] pre-gateway prepare skipped:', e.message);
            }

            // 硬修复：软化 migration + npm + 模板 + 同步渠道插件配置
            try {
                const runtimeRoot = resolveAppFsRoot();
                let cfg = null;
                if (fs.existsSync(CONFIG_PATH)) {
                    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
                }
                const hard = hardenGatewayBootAgainstPluginNpm({
                    runtimeRoot,
                    projectRoot: __dirname,
                    config: cfg,
                    templateSources: [
                        path.join(__dirname, 'config', 'openclaw-templates'),
                        resolveAppFsPath('config', 'openclaw-templates'),
                        path.join(runtimeRoot, 'config', 'openclaw-templates')
                    ]
                });
                console.log('[GatewayBoot] harden:', (hard.notes || []).join(', '));
                if (cfg && hard.configChanged) {
                    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
                    try { prepareChannelPluginsBeforeGateway(); } catch (e2) {}
                }
            } catch (e) {
                console.warn('[GatewayBoot] harden skipped:', e.message);
            }

            // 部署内置自定义插件到用户状态目录
            seedBundledPlugins();

            // 启动Nexora Agent前再跑一次延迟收紧，确保磁盘上的配置已是“快配置”
            try {
                if (fs.existsSync(CONFIG_PATH)) {
                    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
                    const parsed = JSON.parse(raw);
                    const tuned = ensureLatencySafeConfig(parsed);
                    if (tuned.changed) {
                        fs.writeFileSync(CONFIG_PATH, JSON.stringify(tuned.config, null, 2), 'utf8');
                        console.log('[LatencyTune] Pre-gateway:', tuned.changes.join(' | '));
                    }
                    // 小窗口：再压一次 workspace AGENTS.md + 过大会话 / 卡死 compaction
                    try {
                        healOllamaContextOverflowOnBoot();
                    } catch (e2) {}
                }
            } catch (e) {
                console.warn('[LatencyTune] pre-gateway skipped:', e.message);
            }

            // 最终锁定鉴权（写主配置 + 同步历史双目录）；必须在 fork 之前
            const lockedAuth = lockGatewayAuthBeforeStart();

            // 部署补丁/截图脚本到可写运行时目录（云电脑不用固定 Public）
            let patchPath = resolveAppFsPath('patch_gateway.js').replace(/\\/g, '/');
            if (!fs.existsSync(patchPath)) {
                patchPath = path.join(__dirname, 'patch_gateway.js').replace(/\\/g, '/');
            }
            try {
                const deployed = deployRuntimeArtifacts();
                if (deployed && deployed.patchPath && fs.existsSync(deployed.patchAbs)) {
                    patchPath = deployed.patchPath;
                    console.log(`[TokenGuard] Runtime artifacts at ${deployed.runtimeDir}`);
                }
            } catch (e) {
                console.error('[TokenGuard] Failed to deploy runtime artifacts:', e.message);
            }

            // 优先通过物理路径直接定位（asar 打包时走 unpacked，供沙箱 Node 读取）
            let openclawEntry = resolveAppFsPath('node_modules', 'openclaw', 'dist', 'index.js');
            if (!fs.existsSync(openclawEntry)) {
                openclawEntry = path.join(__dirname, 'node_modules', 'openclaw', 'dist', 'index.js');
            }
            if (!fs.existsSync(openclawEntry)) {
                openclawEntry = require.resolve('openclaw/dist/index.js');
            }
            
            // 优先使用打包内置的或系统全局符合版本要求的 Node 运行时
            const nodeExePath = getAvailableNodePath();
            // 强制子进程继承与主进程完全一致的 OPENCLAW_* + OPENCLAW_GATEWAY_TOKEN，杜绝补丁重算家目录后丢 token
            const childEnv = buildGatewayChildEnv(process.env, {
                homePath: lockedAuth.homePath,
                stateDir: lockedAuth.stateDir,
                token: lockedAuth.token
            });
            childEnv.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            childEnv.NEXORA_AGENT_PATCH_PATH = patchPath;
            childEnv.NODE_OPTIONS = buildPatchedNodeOptions(patchPath);
            childEnv.NEXORA_AGENT_RUNTIME_DIR = process.env.NEXORA_AGENT_RUNTIME_DIR || path.dirname(patchPath);
            // 打包后依赖在 gateway-runtime/node_modules（不在 asar），显式注入便于解析
            try {
                const runtimeNm = resolveAppFsPath('node_modules');
                if (fs.existsSync(runtimeNm)) {
                    childEnv.NODE_PATH = childEnv.NODE_PATH
                        ? `${runtimeNm}${path.delimiter}${childEnv.NODE_PATH}`
                        : runtimeNm;
                    childEnv.NEXORA_AGENT_GATEWAY_RUNTIME = resolveAppFsRoot();
                }
            } catch (e) {}

            const forkOptions = {
                cwd: CONFIG_DIR,
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                execArgv: ['--require', patchPath, '--no-warnings', '--dns-result-order=ipv4first'],
                env: childEnv
            };
            if (nodeExePath) {
                forkOptions.execPath = nodeExePath;
                const sandboxDir = path.dirname(nodeExePath);
                const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
                const originalPath = process.env[pathKey] || '';
                forkOptions.env[pathKey] = `${sandboxDir}${path.delimiter}${originalPath}`;
            }

            console.log(`[TokenGuard] Fork gateway home=${lockedAuth.homePath} state=${lockedAuth.stateDir} token_len=${String(lockedAuth.token).length}`);

            // 启动子进程运行Nexora Agent
            gatewayProcess = fork(openclawEntry, ['gateway', 'run', '--force', '--allow-unconfigured'], forkOptions);

            mainWindow.webContents.send('gateway-status', 'running');
            showNotification('Nexora Agent已成功启动', 'AI 本地Nexora Agent已在后台运行，开始监听 18789 端口。');

            let watchPort = 18789;
            try {
                const cfgPath = path.join(CONFIG_DIR, 'openclaw.json');
                if (fs.existsSync(cfgPath)) {
                    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
                    if (cfg && cfg.gateway && cfg.gateway.port) watchPort = Number(cfg.gateway.port) || 18789;
                }
            } catch (e) {}
            startGatewayHttpReadyWatch(watchPort);

            // 提取日志及匹配登录二维码的公共处理函数
            let gatewayLogTail = '';
            const handleLogData = (data) => {
                let text = data.toString();
                if (text.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
                    text = text.split(/\r?\n/).filter(line => !line.includes('NODE_TLS_REJECT_UNAUTHORIZED') && !line.includes('disabling certificate verification')).join('\n');
                }
                if (!text.trim()) return;

                // OpenClaw 偶发弹出「* Install xxx plugin?」；必须选「用本地内置」而不是 Skip，否则渠道会报 does not support login
                tryAutoAnswerInstallPluginPrompt(gatewayProcess, text, 'Gateway');
                
                // 实时保存流日志用于诊断
                try {
                    require('fs').appendFileSync(
                        require('path').join(CONFIG_DIR, 'gateway_stdout.log'),
                        text,
                        'utf8'
                    );
                } catch(e) {}

                if (mainWindow) {
                    mainWindow.webContents.send('gateway-log', text);

                    // 日志就绪信号：立刻通知 UI（不依赖 TCP 探测时机）
                    if (/http server listening/i.test(text) || text.includes('[gateway] ready')) {
                        notifyGatewayHttpReady(watchPort);
                    }
                    
                    // 拦截控制台免密登录 URL，并统一改写为当前配置令牌（避免日志旧 token 导致限流）
                    const acpMatch = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/acp\/[^\s"'\n]+/);
                    if (acpMatch) {
                        const fresh = rememberDashboardUrl(acpMatch[0].trim());
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('dashboard-url-updated', fresh);
                        }
                    }

                    // 跨分片拼接后再抓微信扫码 URL（liteapp.weixin.qq.com/q/... 等）
                    gatewayLogTail = (gatewayLogTail + text).slice(-12000);
                    const qrUrl = extractChannelLoginQrUrl(gatewayLogTail);
                    if (qrUrl) {
                        mainWindow.webContents.send('gateway-qrcode', {
                            url: qrUrl,
                            channel: 'wechat',
                            title: '微信扫码登录',
                            tip: '请使用手机微信扫描下方二维码授权登录。'
                        });
                    }
                }
            };

            // 同时监听 stdout 与 stderr，防范 debug/wechaty 日志输出在 stderr 中导致二维码漏接
            gatewayProcess.stdout.on('data', handleLogData);
            gatewayProcess.stderr.on('data', handleLogData);

            // 监听退出
            gatewayProcess.on('exit', (code) => {
                console.log(`Gateway exited with code ${code}`);
                const wasIntentionallyStopped = gatewayProcess && gatewayProcess.isIntentionallyStopped;
                gatewayProcess = null;
                stopGatewayHttpReadyWatch();
                gatewayHttpReadyNotified = false;
                if (mainWindow) {
                    mainWindow.webContents.send('gateway-status', 'stopped');
                    if (!wasIntentionallyStopped) {
                        console.error(`[System] Nexora Agent核心进程意外退出，退出码: ${code}`);
                    }
                }
            });

        } catch (e) {
            if (mainWindow) {
                mainWindow.webContents.send('gateway-status', 'stopped');
                mainWindow.webContents.send('gateway-log', `[System] [ERROR] 无法找到内置Nexora Agent模块: ${e.message}\n`);
            }
        }
}

ipcMain.on('gateway-action', (event, action) => {
    if (action === 'start') {
        startGatewayProcess();
    } else if (action === 'stop') {
        stopGatewayProcess();
    } else if (action === 'query-status') {
        if (mainWindow) {
            mainWindow.webContents.send('gateway-status', gatewayProcess ? 'running' : 'stopped');
        }
    }
});

ipcMain.on('open-sandbox-terminal', () => {
    const sandboxDir = resolveAppFsPath('.node-sandbox');
    const { spawn } = require('child_process');
    
    // 终极无痛方案：使用 PowerShell 的 -EncodedCommand 特性！
    // 将整个包含特殊字符、中文、和环境变量的脚本打包为 Base64 传递，彻底避开 CMD 的单双引号解析、吃字符以及防病毒脚本策略的拦截。
    const initScript = [
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
        `$env:Path = "${sandboxDir.replace(/\\/g, '\\\\')};" + $env:Path`,
        `Clear-Host`,
        `Write-Host "==========================================================" -ForegroundColor Green`,
        `Write-Host "         Nexora Agent 绿色沙箱开发终端 (PowerShell)             " -ForegroundColor Green`,
        `Write-Host "==========================================================" -ForegroundColor Green`,
        `Write-Host "  * 内置 Node 运行时已成功注入环境变量 PATH 最前面。" -ForegroundColor Cyan`,
        `Write-Host "  * 您可以直接在此处执行以下命令：" -ForegroundColor Cyan`,
        `Write-Host "      - node -v            (查看内置沙箱 Node 版本)" -ForegroundColor White`,
        `Write-Host "      - npm -v             (查看内置沙箱 npm 版本)" -ForegroundColor White`,
        `Write-Host "      - npx openclaw doctor (执行Nexora Agent CLI 诊断自检)" -ForegroundColor White`,
        `Write-Host "==========================================================" -ForegroundColor Green`,
        `Write-Host ""`
    ].join('\r\n');

    // 必须转换为 UTF-16LE 编码的 Buffer，然后再转 Base64 才能被 PowerShell 正确识别
    const encodedCmd = Buffer.from(initScript, 'utf16le').toString('base64');
    
    // 现在调用的命令行里，只有绝对安全的英文字母 Base64 字符串，不可能再有任何解析边界和乱码问题！
    const cmdLine = `start powershell -NoExit -ExecutionPolicy Bypass -EncodedCommand ${encodedCmd}`;

    spawn('cmd.exe', ['/c', cmdLine], {
        cwd: resolveBuiltinTerminalCwd(),
        detached: true,
        stdio: 'ignore'
    }).unref();
});

let ptyProcess = null;

function resolveBuiltinTerminalCwd() {
    const candidates = [
        resolveAppFsPath('.node-sandbox'),
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'NexoraAgent') : null,
        CONFIG_DIR,
        process.env.USERPROFILE || process.env.HOME || null
    ].filter(Boolean);
    for (const c of candidates) {
        try {
            if (c && fs.existsSync(c) && !String(c).includes('app.asar')) return c;
        } catch (e) {}
    }
    try { return app.getPath('home'); } catch (e) { return process.cwd(); }
}

ipcMain.handle('builtin-terminal-start', (event, lang) => {
    if (ptyProcess) return { ok: true, reused: true };

    const pushTerm = (text) => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('builtin-terminal-data', text);
            }
        } catch (e) {}
    };

    try {
        const sandboxDir = resolveAppFsPath('.node-sandbox');
        let pty;
        try {
            pty = require('node-pty');
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            pushTerm(`\r\n\x1b[31m[内置终端] node-pty 加载失败（打包环境常见于未解包原生模块）\x1b[0m\r\n${msg}\r\n`);
            pushTerm(`\x1b[33m正在打开外部 PowerShell 沙箱窗口作为后备…\x1b[0m\r\n`);
            try { ipcMain.emit('open-sandbox-terminal'); } catch (e2) {}
            return { ok: false, error: msg, fallback: 'external' };
        }

        const isEn = lang === 'en-US';
        const isTw = lang === 'zh-TW';

        const bannerTitle = isEn
            ? "         Nexora Agent Built-in Sandbox Terminal (node-pty)      "
            : (isTw ? "         Nexora Agent 內置沙箱開發終端 (node-pty)               " : "         Nexora Agent 内置沙箱开发终端 (node-pty)               ");

        const bannerCmds = isEn
            ? "  * You can execute the following commands directly here:"
            : (isTw ? "  * 您可以直接在此處執行以下命令：" : "  * 您可以直接在此处执行以下命令：");

        const cmdNode = isEn
            ? "      - node -v            (Show sandbox Node version)"
            : (isTw ? "      - node -v            (查看內置沙箱 Node 版本)" : "      - node -v            (查看内置沙箱 Node 版本)");

        const cmdNpm = isEn
            ? "      - npm -v             (Show sandbox npm version)"
            : (isTw ? "      - npm -v             (查看內置沙箱 npm 版本)" : "      - npm -v             (查看内置沙箱 npm 版本)");

        const sandboxPathForPs = String(sandboxDir || '').replace(/'/g, "''");
        const initScript = [
            `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
            `if (Test-Path -LiteralPath '${sandboxPathForPs}') { $env:Path = '${sandboxPathForPs};' + $env:Path }`,
            `Clear-Host`,
            `Write-Host "==========================================================" -ForegroundColor Green`,
            `Write-Host "${bannerTitle}" -ForegroundColor Green`,
            `Write-Host "==========================================================" -ForegroundColor Green`,
            `Write-Host "${bannerCmds}" -ForegroundColor Cyan`,
            `Write-Host "${cmdNode}" -ForegroundColor White`,
            `Write-Host "${cmdNpm}" -ForegroundColor White`,
            `Write-Host "==========================================================" -ForegroundColor Green`,
            `Write-Host ""`
        ].join('\r\n');

        const encodedCmd = Buffer.from(initScript, 'utf16le').toString('base64');
        const termCwd = resolveBuiltinTerminalCwd();
        const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
        const childEnv = { ...process.env };
        if (sandboxDir && fs.existsSync(sandboxDir)) {
            childEnv[pathKey] = `${sandboxDir}${path.delimiter}${childEnv[pathKey] || ''}`;
        }

        ptyProcess = pty.spawn('powershell.exe', ['-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCmd], {
            name: 'xterm-256color',
            cols: 80,
            rows: 30,
            // 打包后 __dirname 在 app.asar 内，不能当 cwd，否则壳进程起不来、终端空白
            cwd: termCwd,
            env: childEnv,
            useConpty: true
        });

        ptyProcess.on('data', function (data) {
            pushTerm(data);
        });

        ptyProcess.on('exit', () => {
            ptyProcess = null;
            pushTerm('\r\n\x1b[33m[内置终端已退出]\x1b[0m\r\n');
        });

        return { ok: true, cwd: termCwd };
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('[BuiltinTerminal] start failed:', msg);
        pushTerm(`\r\n\x1b[31m[内置终端启动失败]\x1b[0m\r\n${msg}\r\n`);
        pushTerm(`\x1b[33m正在打开外部 PowerShell 沙箱窗口作为后备…\x1b[0m\r\n`);
        try {
            // 复用外部终端入口
            const sandboxDir = resolveAppFsPath('.node-sandbox');
            const { spawn } = require('child_process');
            const initScript = [
                `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
                `$env:Path = "${String(sandboxDir).replace(/\\/g, '\\\\')};" + $env:Path`,
                `Write-Host "Nexora Agent 外部沙箱终端（内置终端启动失败时的后备）" -ForegroundColor Yellow`
            ].join('\r\n');
            const encodedCmd = Buffer.from(initScript, 'utf16le').toString('base64');
            spawn('cmd.exe', ['/c', `start powershell -NoExit -ExecutionPolicy Bypass -EncodedCommand ${encodedCmd}`], {
                cwd: resolveBuiltinTerminalCwd(),
                detached: true,
                stdio: 'ignore'
            }).unref();
        } catch (e2) {}
        return { ok: false, error: msg, fallback: 'external' };
    }
});

ipcMain.on('builtin-terminal-write', (event, data) => {
    if (ptyProcess) {
        ptyProcess.write(data);
    }
});

ipcMain.on('builtin-terminal-resize', (event, size) => {
    if (ptyProcess && size.cols && size.rows) {
        try {
            ptyProcess.resize(size.cols, size.rows);
        } catch (e) {}
    }
});

// 提取的配置初始化逻辑：确保在 Gateway 启动前就把默认插件（如 health-check 等）写入 allow 列表
function ensureOpenClawConfigInitialized() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            // 从模板初始化
            const examplePath = path.join(__dirname, 'config', 'openclaw.json.example');
            if (fs.existsSync(examplePath)) {
                if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
                fs.copyFileSync(examplePath, CONFIG_PATH);
            } else {
                return;
            }
        }
        let content = fs.readFileSync(CONFIG_PATH, 'utf8');
        content = content.replace(/^\uFEFF/, '');
        let config = JSON.parse(content);
        // 自动补全 ui.assistant 头像配置，以及 gateway.controlUi.basePath (修复面板侧边栏破图问题)
        let needsSave = false;
        if (!config.ui) { config.ui = {}; needsSave = true; }
        if (!config.ui.assistant) { config.ui.assistant = {}; needsSave = true; }
        if (!config.ui.assistant.avatar) {
            config.ui.assistant.avatar = '🤖';
            config.ui.assistant.name = config.ui.assistant.name || 'Nexora Agent';
            needsSave = true;
        }
        // 统一规范化 gateway.auth / controlUi / port（禁止 SecretRef/空值/随机令牌导致面板永登不上）
        {
            const norm = normalizeGatewayAuthConfig(config, NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN);
            config = norm.config;
            if (norm.changed) {
                needsSave = true;
                console.log('[System] Persisted default gateway.auth.token for dashboard auto-login');
            }
        }
        // 确保微信插件始终处于启用状态
        if (!config.plugins) { config.plugins = {}; needsSave = true; }
        if (!config.plugins.entries) { config.plugins.entries = {}; needsSave = true; }
        if (!config.plugins.entries['openclaw-weixin'] || config.plugins.entries['openclaw-weixin'].enabled !== true) {
            config.plugins.entries['openclaw-weixin'] = config.plugins.entries['openclaw-weixin'] || {};
            config.plugins.entries['openclaw-weixin'].enabled = true;
            needsSave = true;
        }

        if (!config.plugins.allow) { config.plugins.allow = []; needsSave = true; }

        // 默认启用全部内置自定义插件 (含别人电脑首次安装 / 升级迁移)
        let appVersion = '0.0.0';
        try { appVersion = app.getVersion(); } catch (e) {}
        const stampPath = path.join(CONFIG_DIR, '.claw-bundled-enable-stamp');
        let enableStamp = '';
        try { if (fs.existsSync(stampPath)) enableStamp = fs.readFileSync(stampPath, 'utf8').trim(); } catch (e) {}
        if (enableStamp !== appVersion) {
            for (const name of BUNDLED_CUSTOM_PLUGINS) {
                if (!config.plugins.entries[name]) config.plugins.entries[name] = {};
                config.plugins.entries[name].enabled = true;
                if (!config.plugins.allow.includes(name)) config.plugins.allow.push(name);
            }
            const catalogFirst = ensureUiPluginCatalog(config, { forceDefaultOn: true });
            if (catalogFirst.changed) {
                console.log('[PluginCatalog] First-run:', catalogFirst.changes.join(' | '));
            }
            try { fs.writeFileSync(stampPath, appVersion, 'utf8'); } catch (e) {}
            needsSave = true;
            console.log(`[PluginSeed] Enabled ${BUNDLED_CUSTOM_PLUGINS.length} bundled plugins for v${appVersion}`);
        } else {
            // 版本内: 缺失条目仍默认开启; 已有条目尊重用户开关, 但启用态必须进 allow
            for (const name of BUNDLED_CUSTOM_PLUGINS) {
                if (!config.plugins.entries[name]) {
                    config.plugins.entries[name] = { enabled: true };
                    needsSave = true;
                }
                if (config.plugins.entries[name].enabled === true && !config.plugins.allow.includes(name)) {
                    config.plugins.allow.push(name);
                    needsSave = true;
                }
            }
            const catalogNext = ensureUiPluginCatalog(config, { forceDefaultOn: false });
            if (catalogNext.changed) {
                needsSave = true;
                console.log('[PluginCatalog] Ensured:', catalogNext.changes.join(' | '));
            }
        }

        // 若用户目录里残留了损坏的 matrix 拷贝, 删掉以免覆盖 OpenClaw 自带的 bundled matrix
        try {
            const localMatrix = path.join(CONFIG_DIR, 'extensions', 'matrix');
            if (fs.existsSync(localMatrix)) {
                const pkgPath = path.join(localMatrix, 'package.json');
                let broken = !fs.existsSync(path.join(localMatrix, 'index.js'));
                if (fs.existsSync(pkgPath)) {
                    try {
                        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                        const entries = pkg?.openclaw?.extensions || [];
                        if (entries.some((e) => typeof e === 'string' && e.endsWith('.ts') && !fs.existsSync(path.join(localMatrix, e)))) {
                            broken = true;
                        }
                    } catch (e) {}
                }
                if (broken) {
                    fs.rmSync(localMatrix, { recursive: true, force: true });
                    console.log('[PluginSeed] Removed broken local matrix extension copy');
                    if (config.plugins.entries.matrix) {
                        config.plugins.entries.matrix.enabled = false;
                        needsSave = true;
                    }
                }
            }
        } catch (e) {}
        
        Object.keys(config.plugins.entries).forEach(pluginName => {
            // UI 伞形卡不能进 OpenClaw allow 列表
            if (pluginName === LONG_TERM_MEMORY_UI_ID) return;
            if (config.plugins.entries[pluginName].enabled === true) {
                if (!config.plugins.allow.includes(pluginName)) {
                    config.plugins.allow.push(pluginName);
                    needsSave = true;
                }
            }
        });

        try {
            const pruned = pruneStalePluginConfigEntries(config);
            if (pruned.changed) {
                needsSave = true;
                console.log('[PluginSeed] Pruned stale plugins.entries / duplicate weixin install');
            }
        } catch (e) {}

        // 长期记忆开箱强保：即使用户旧配置关掉过，也强制写回真实插件栈
        try {
            const ltm = ensureLongTermMemoryStack(config);
            if (ltm.changed) {
                needsSave = true;
                console.log('[LongTermMemory] Ensured:', ltm.changes.join(' | '));
            }
            seedDefaultMemoryFile(path.join(CONFIG_DIR, 'workspace', 'MEMORY.md'));
        } catch (e) {}

        // 把已部署到 ~/.openclaw/extensions 的自定义插件也加入 allow (仅启用态的 entries)
        // 同时把该目录注入 load.paths, 双保险确保 openclaw 能发现
        if (!config.plugins.load) { config.plugins.load = {}; needsSave = true; }
        if (!config.plugins.load.paths) { config.plugins.load.paths = []; needsSave = true; }

        const extensionsRoot = path.join(CONFIG_DIR, 'extensions');
        if (fs.existsSync(extensionsRoot)) {
            try {
                for (const name of fs.readdirSync(extensionsRoot)) {
                    const pluginDir = path.join(extensionsRoot, name);
                    if (!fs.statSync(pluginDir).isDirectory()) continue;
                    if (BUNDLED_CUSTOM_PLUGINS.includes(name)) continue; // 已在上面处理
                    if (!config.plugins.entries[name]) {
                        config.plugins.entries[name] = { enabled: false };
                        needsSave = true;
                    }
                }
            } catch (e) {}
        }
        
        // 多用户/云电脑：读配置时也清洗野指针，避免长期保留别人机器的绝对路径
        try {
            const sanitized = applyMachinePluginPathSanitize(config);
            if (sanitized.changed) needsSave = true;
        } catch (e) {}

        const weixinPluginPath = resolveAppFsPath('node_modules', '@tencent-weixin', 'openclaw-weixin');
        // 当前安装目录下「允许进 load.paths」的渠道插件权威路径（仅微信等非官方）
        const bundledChannelAbsById = {};
        for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
            if (entry.viaLoadPaths === false) continue;
            const abs = resolveBundledNpmPluginPath(entry);
            if (abs) bundledChannelAbsById[entry.id] = path.resolve(abs);
        }
        const originalPaths = config.plugins.load.paths || [];
        const filteredPaths = originalPaths.filter(p => {
            if (typeof p !== 'string') return false;
            // 无影/换机：别人的 Users\xxx 路径一律丢弃
            if (isForeignUserPath(p) || pathLooksLikeOfficialOpenClawChannel(p)) {
                needsSave = true;
                return false;
            }
            // 迁移：剔除 load.paths 里的官方 @openclaw 包与 voice-call
            if (/[\\/]@openclaw[\\/]voice-call(?:[\\/]|$)/i.test(p) || /[\\/]voice-call$/i.test(p)) {
                needsSave = true;
                return false;
            }
            // 过滤掉所有不一致的微信插件旧路径
            if (/(?:^|[\\/])openclaw-weixin(?:[\\/]|$)/i.test(p) || p.endsWith('openclaw-weixin')) {
                const want = bundledChannelAbsById['openclaw-weixin'] || path.resolve(weixinPluginPath);
                if (path.resolve(p) !== want) {
                    needsSave = true;
                    return false;
                }
            }
            // 丢弃明显不可用的死路径（换机后最常见）
            try {
                if (!fs.existsSync(p)) {
                    needsSave = true;
                    return false;
                }
            } catch (e) {
                needsSave = true;
                return false;
            }
            return true;
        });

        // 仅微信等 viaLoadPaths=true 写入 load.paths；飞书/QQ 等走官方 installs
        for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
            if (entry.viaLoadPaths === false) continue;
            const abs = resolveBundledNpmPluginPath(entry);
            if (!abs || !pluginPathUsableOnThisMachine(abs)) {
                console.warn(`[PluginSeed] Bundled npm plugin missing/unusable: ${entry.id}`);
                if (config.plugins.entries[entry.id] && config.plugins.entries[entry.id].enabled !== false) {
                    config.plugins.entries[entry.id].enabled = false;
                    needsSave = true;
                }
                continue;
            }
            const resolvedPath = path.resolve(abs);
            const hasPath = filteredPaths.some(p => typeof p === 'string' && path.resolve(p) === resolvedPath);
            if (!hasPath) {
                filteredPaths.push(abs);
                needsSave = true;
            }
            if (!config.plugins.entries[entry.id]) {
                config.plugins.entries[entry.id] = { enabled: true };
                needsSave = true;
            }
            if (config.plugins.entries[entry.id].enabled === true && !config.plugins.allow.includes(entry.id)) {
                config.plugins.allow.push(entry.id);
                needsSave = true;
            }
        }

        // 官方渠道：直接使用打包目录，不再拷贝到 ~/.openclaw/npm/projects/ 导致丢失 hoisted node_modules
        for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
            if (entry.viaLoadPaths === true) {
                if (config.plugins.installs && config.plugins.installs[entry.id]) {
                    delete config.plugins.installs[entry.id];
                    needsSave = true;
                }
                continue;
            }
            const packageName = entry.packageName
                || (entry.id === 'openclaw-weixin' ? '@tencent-weixin/openclaw-weixin' : null);
            if (!packageName) continue;
            try {
                if (!config.plugins.installs) config.plugins.installs = {};
                const prev = config.plugins.installs[entry.id] || {};
                if (prev.installPath && (isForeignUserPath(prev.installPath) || !fs.existsSync(prev.installPath))) {
                    delete config.plugins.installs[entry.id];
                    needsSave = true;
                }
                const seed = ensureOfficialExternalNpmPluginSeeded({
                    pluginId: entry.id,
                    packageName
                });
                if (!seed.seeded) {
                    console.warn(`[PluginSeed] ${entry.id} official seed skipped:`, seed.reason);
                    if (!config.plugins.entries[entry.id]) {
                        config.plugins.entries[entry.id] = { enabled: false };
                        needsSave = true;
                    } else if (config.plugins.entries[entry.id].enabled !== false) {
                        config.plugins.entries[entry.id].enabled = false;
                        needsSave = true;
                    }
                    continue;
                }
                const ver = seed.version || '0.0.0';
                const next = {
                    ...(config.plugins.installs[entry.id] || {}),
                    source: 'npm',
                    spec: `${packageName}@${ver}`,
                    installPath: seed.installPath,
                    resolvedName: packageName,
                    resolvedVersion: ver,
                    resolvedSpec: `${packageName}@${ver}`,
                    version: ver,
                    installedAt: (config.plugins.installs[entry.id] && config.plugins.installs[entry.id].installedAt)
                        || new Date().toISOString()
                };
                if (JSON.stringify(config.plugins.installs[entry.id] || {}) !== JSON.stringify(next)) {
                    config.plugins.installs[entry.id] = next;
                    needsSave = true;
                }
                if (!config.plugins.entries[entry.id]) {
                    config.plugins.entries[entry.id] = { enabled: true };
                    needsSave = true;
                } else if (config.plugins.entries[entry.id].enabled !== true) {
                    config.plugins.entries[entry.id].enabled = true;
                    needsSave = true;
                }
                if (!config.plugins.allow.includes(entry.id)) {
                    config.plugins.allow.push(entry.id);
                    needsSave = true;
                }
            } catch (e) {
                console.warn(`[PluginSeed] ${entry.id} seed failed:`, e.message);
            }
        }
        
        if (JSON.stringify(config.plugins.load.paths) !== JSON.stringify(filteredPaths)) {
            config.plugins.load.paths = filteredPaths;
            needsSave = true;
        }

        // 回复速度：纠正常见慢配置（debounce / 夸张 num_ctx / 超大 bootstrap）
        try {
            const tuned = ensureLatencySafeConfig(config);
            if (tuned.changed) {
                needsSave = true;
                console.log('[LatencyTune] Applied:', tuned.changes.join(' | '));
            }
        } catch (e) {
            console.warn('[LatencyTune] skipped:', e.message);
        }

        // 飞书渠道自愈：清除历史写入的空字符串可选凭证（encryptKey/verificationToken/appSecret），
        // 并在已配置账号时补齐渠道启用与开放策略，修复“绑定后收到不回”的问题。
        try {
            if (sanitizeFeishuConfig(config)) {
                needsSave = true;
                console.log('[FeishuFix] Normalized feishu channel config');
            }
        } catch (e) {}

        if (needsSave) {
            try {
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
                const dbPath = path.join(CONFIG_DIR, 'openclaw.sqlite');
                const dbWal = path.join(CONFIG_DIR, 'openclaw.sqlite-wal');
                const dbShm = path.join(CONFIG_DIR, 'openclaw.sqlite-shm');
                try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch (e) {}
                try { if (fs.existsSync(dbWal)) fs.unlinkSync(dbWal); } catch (e) {}
                try { if (fs.existsSync(dbShm)) fs.unlinkSync(dbShm); } catch (e) {}
                console.log('[PluginSeed] Cleared stale SQLite database cache due to config initialization/update');
            } catch(e) {}
        }
        
        // Return initialized config for callers if needed
        return config;
    } catch (e) {
        console.error('[PluginSeed] ensureOpenClawConfigInitialized failed:', e);
        return null;
    }
}

// 配置文件的读写 IPC
ipcMain.handle('config-read', async () => {
    try {
        const config = ensureOpenClawConfigInitialized();
        if (config) return config;
        
        if (!fs.existsSync(CONFIG_PATH)) return null;
        let content = fs.readFileSync(CONFIG_PATH, 'utf8');
        content = content.replace(/^\uFEFF/, '');
        return JSON.parse(content);
    } catch (e) {
        console.error('Failed to read config:', e);
        return null;
    }
});

ipcMain.handle('config-save', async (event, newConfig) => {
    try {
        let cleanConfig = JSON.parse(JSON.stringify(newConfig));
        delete cleanConfig.videoGenerator;
        delete cleanConfig.imageGenerator;

        // 启用插件必须进 allow，保证别人电脑上开关真能加载
        try {
            if (cleanConfig.plugins && cleanConfig.plugins.entries) {
                if (!Array.isArray(cleanConfig.plugins.allow)) cleanConfig.plugins.allow = [];
                for (const [id, entry] of Object.entries(cleanConfig.plugins.entries)) {
                    if (id === LONG_TERM_MEMORY_UI_ID) continue;
                    if (entry && entry.enabled === true) ensureAllow(cleanConfig, id);
                }
            }
            ensureUiPluginCatalog(cleanConfig, { forceDefaultOn: false });
            // 保存时也强制长期记忆栈开箱态，避免用户关了后下次别人装的版本失效
            ensureLongTermMemoryStack(cleanConfig);
            if (Array.isArray(cleanConfig.plugins.allow)) {
                cleanConfig.plugins.allow = cleanConfig.plugins.allow.filter((x) => x !== LONG_TERM_MEMORY_UI_ID);
            }
        } catch (e) {}

        // 保存时禁止把 gateway.auth 抹掉（否则下次启动又会变成 runtime token）
        try {
            cleanConfig = normalizeGatewayAuthConfig(cleanConfig, NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN).config;
        } catch (e) {}

        // 保存时强制补齐压缩预留等安全默认，避免 Auto-compaction could not recover
        try {
            cleanConfig = ensureLatencySafeConfig(cleanConfig).config;
        } catch (e) {}
        
        // 读取原本的文件尺寸
        const originalBytes = fs.existsSync(CONFIG_PATH) ? fs.statSync(CONFIG_PATH).size : 39500;
        
        let newJson = JSON.stringify(cleanConfig, null, 2);
        
        // 空白填充算法防回滚自愈
        const newBytes = Buffer.byteLength(newJson, 'utf8');
        if (newBytes < originalBytes) {
            const padSize = originalBytes - newBytes;
            newJson = newJson + '\n' + ' '.repeat(padSize - 1);
        }

        fs.writeFileSync(CONFIG_PATH, newJson, 'utf8');

        // 沙箱 OpenClaw 会话会粘住旧 model/modelOverride；只改 openclaw.json 不会换网关对话模型。
        // 保存时把默认主/备模型同步进 sessions + 旁路状态目录，避免面板仍用上一模型。
        try {
            const altDirs = listKnownOpenClawStateDirs(process.env, CONFIG_DIR);
            const syncedDirs = syncModelConfigToStateDirs(altDirs, cleanConfig, CONFIG_DIR);
            if (syncedDirs.length) {
                console.log('[ModelSync] Synced default model config to:', syncedDirs.join(' | '));
            }
        } catch (e) {
            console.warn('[ModelSync] Session/model sync skipped:', e.message);
        }

        return { success: true };
    } catch (e) {
        console.error('Failed to save config:', e);
        return { success: false, error: e.message };
    }
});

// 插件探活：UI 徽章 / 开关前检查
ipcMain.handle('plugins-probe', async () => {
    try {
        let config = {};
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
            }
        } catch (e) {}
        const probes = probeAllUiPlugins({
            config,
            appRoot: __dirname,
            stateDir: CONFIG_DIR
        });
        return { success: true, probes };
    } catch (e) {
        return { success: false, error: e.message, probes: [] };
    }
});

ipcMain.handle('plugin-probe', async (event, pluginId) => {
    try {
        let config = {};
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
            }
        } catch (e) {}
        const probe = probePlugin(String(pluginId || ''), {
            config,
            appRoot: __dirname,
            stateDir: CONFIG_DIR
        });
        return { success: true, probe };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('plugin-save-credentials', async (event, payload) => {
    try {
        const pluginId = payload && payload.pluginId;
        const fields = (payload && payload.fields) || {};
        if (!pluginId) return { success: false, error: 'missing pluginId' };
        if (!fs.existsSync(CONFIG_PATH)) return { success: false, error: 'config missing' };
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
        const result = applyPluginCredentials(config, pluginId, fields);
        if (!result.ok) return { success: false, error: result.error || 'failed' };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        return { success: true, config };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('plugin-prompt-credentials', async (event, pluginId) => {
    try {
        const id = String(pluginId || '');
        if (id === 'slack') {
            const r = await dialog.showMessageBox(mainWindow || undefined, {
                type: 'question',
                title: '配置 Slack',
                message: '需要 Slack Bot Token 才能启用。请在 Slack API 后台创建应用后复制 Bot Token（xoxb-…）。',
                detail: '点击「继续」后将弹出输入框；也可先取消，稍后再开。',
                buttons: ['取消', '继续'],
                defaultId: 1,
                cancelId: 0
            });
            if (r.response !== 1) return { success: false, cancelled: true };
            // Electron 无原生 prompt，用简易两个输入通过顺序 MessageBox 不够；改用临时 HTML 不可行时用 env 写入要求渲染进程弹窗
            return { success: true, needsRendererPrompt: true, fields: ['botToken', 'appToken'] };
        }
        if (id === 'matrix') {
            const r = await dialog.showMessageBox(mainWindow || undefined, {
                type: 'question',
                title: '配置 Matrix',
                message: '需要 Matrix Homeserver 与 Access Token。',
                detail: '点击「继续」后在应用内填写。',
                buttons: ['取消', '继续'],
                defaultId: 1,
                cancelId: 0
            });
            if (r.response !== 1) return { success: false, cancelled: true };
            return { success: true, needsRendererPrompt: true, fields: ['homeserver', 'accessToken'] };
        }
        return { success: false, error: 'unsupported' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 清理微信登录态凭证实现彻底解绑
ipcMain.handle('wechat-clear', async () => {
    try {
        // 1. 如果Nexora Agent运行中，先停止以解除文件夹句柄锁
        stopGatewayProcess();

        // 2. 物理清除微信缓存目录 openclaw-weixin
        const weixinCachePath = path.join(CONFIG_DIR, 'openclaw-weixin');
        if (fs.existsSync(weixinCachePath)) {
            fs.rmSync(weixinCachePath, { recursive: true, force: true });
        }
        return { success: true };
    } catch (e) {
        console.error('Failed to clear WeChat session:', e);
        return { success: false, error: e.message };
    }
});

// 检测微信当前是否已绑定 (检测 openclaw-weixin 缓存文件夹是否存在)
// 统一的微信绑定状态探测：以 accounts.json 中是否存在有效账号 + 对应账号详情为准，
// 避免登录过程中缓存目录刚生成（尚未写入 accounts.json）时误报为“已绑定”导致前端渲染异常。
function getWeChatStatus() {
    try {
        const weixinCachePath = path.join(CONFIG_DIR, 'openclaw-weixin');
        let details = null;
        let bound = false;

        const accountsJsonPath = path.join(weixinCachePath, 'accounts.json');
        if (fs.existsSync(accountsJsonPath)) {
            const accounts = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf8'));
            if (Array.isArray(accounts) && accounts.length > 0) {
                const accountId = accounts[0];
                const accountDetailPath = path.join(weixinCachePath, 'accounts', `${accountId}.json`);
                if (fs.existsSync(accountDetailPath)) {
                    const accountDetail = JSON.parse(fs.readFileSync(accountDetailPath, 'utf8'));
                    details = {
                        accountId: accountId.split('-')[0], // 简化标识名
                        savedAt: accountDetail.savedAt,
                        userId: accountDetail.userId ? accountDetail.userId.split('@')[0] : 'WeChat Bot'
                    };
                    bound = true;
                }
            }
        }

        return { success: true, bound, details };
    } catch (e) {
        return { success: false, bound: false, details: null, error: e.message };
    }
}

ipcMain.handle('wechat-check-status', async () => {
    return getWeChatStatus();
});

// 读取本地持久化系统日志 gateway_stdout.log (支持提取最近 256KB 内容，防撑爆渲染进程)
ipcMain.handle('read-system-logs', async () => {
    try {
        const logPath = path.join(CONFIG_DIR, 'gateway_stdout.log');
        if (fs.existsSync(logPath)) {
            const stats = fs.statSync(logPath);
            const fd = fs.openSync(logPath, 'r');
            const bufferSize = Math.min(stats.size, 256 * 1024);
            const buffer = Buffer.alloc(bufferSize);
            fs.readSync(fd, buffer, 0, bufferSize, stats.size - bufferSize);
            fs.closeSync(fd);
            return { success: true, content: buffer.toString('utf8') };
        }
        return { success: true, content: '📋 系统尚未生成任何运行日志\n' };
    } catch (e) {
        return { success: false, content: '', error: e.message };
    }
});

// 清空本地持久化系统日志 gateway_stdout.log
ipcMain.handle('clear-system-logs', async () => {
    try {
        const logPath = path.join(CONFIG_DIR, 'gateway_stdout.log');
        if (fs.existsSync(logPath)) {
            fs.writeFileSync(logPath, '', 'utf8');
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

let wechatLoginProcess = null;
let wechatLoginSuccessWatcher = null;
let wechatQrWaitTimer = null;
let wechatQrEmitted = false;
let wechatFailEmitted = false;

function clearWeChatQrWaitTimer() {
    if (wechatQrWaitTimer) {
        clearTimeout(wechatQrWaitTimer);
        wechatQrWaitTimer = null;
    }
}

function forceKillChildProcess(proc) {
    if (!proc) return;
    try {
        if (process.platform === 'win32' && proc.pid) {
            const { execSync } = require('child_process');
            execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
        } else {
            proc.kill('SIGKILL');
        }
    } catch (e) {}
}

function forceKillWeChatLoginProcess() {
    forceKillChildProcess(wechatLoginProcess);
    wechatLoginProcess = null;
}

function emitWeChatLoginFailed(error) {
    if (wechatFailEmitted) return;
    wechatFailEmitted = true;
    clearWeChatQrWaitTimer();
    if (wechatLoginSuccessWatcher) {
        clearInterval(wechatLoginSuccessWatcher);
        wechatLoginSuccessWatcher = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('wechat-login-failed', { error: error || '微信绑定失败' });
        mainWindow.webContents.send('channel-login-failed', {
            pluginId: 'openclaw-weixin',
            channel: 'wechat',
            error: error || '微信绑定失败'
        });
        mainWindow.webContents.send('gateway-log', `[WeChat Login] ❌ ${error || '微信绑定失败'}\n`);
    }
}

/** 从日志中提取微信 / 通用扫码登录 URL（兼容 liteapp.weixin.qq.com/q/...）。 */
function extractChannelLoginQrUrl(rawText) {
    const cleanText = String(rawText || '').replace(/\x1B\[[0-9;]*m/g, '');
    const patterns = [
        /https?:\/\/liteapp\.weixin\.qq\.com\/q\/[^\s"'<>\]\)\}\n]+/i,
        /https?:\/\/(?:login\.)?weixin\.qq\.com\/[^\s"'<>\]\)\}\n]+/i,
        /https?:\/\/wechaty\.js\.org\/qrcode\/[^\s"'<>\]\)\}\n]+/i
    ];
    for (const re of patterns) {
        const m = cleanText.match(re);
        if (m && m[0]) return m[0].replace(/[),.;]+$/g, '');
    }
    return null;
}

/**
 * 管道 stdin 下 OpenClaw 会卡在「* Install xxx plugin?」。
 * 绝不能选 Skip（会导致 Channel does not support login）；优先选本地内置（↓1 + Enter），否则回车接受默认。
 */
function tryAutoAnswerInstallPluginPrompt(child, text, label) {
    if (!child || child.__installPromptAnswered) return false;
    const raw = String(text || '');
    if (!/\*\s*Install\s+.+\s+plugin\?/i.test(raw) && !/Install\s+\w+\s+plugin\?/i.test(raw)) {
        return false;
    }
    child.__installPromptAnswered = true;
    try {
        if (child.stdin && child.stdin.writable) {
            // 常见选项：ClawHub / npm / local / skip。微信等内置包 default 常在 npm；↓ 一次落到 local。
            child.stdin.write('\x1b[B');
            child.stdin.write('\r');
        }
    } catch (e) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gateway-log',
            `[System] ${label || '子进程'}：检测到插件安装询问，已自动选择本地/默认安装（禁止 Skip，避免渠道无法登录）\n`);
    }
    return true;
}

/** @deprecated 保留别名，防止遗漏调用点 */
function tryAutoSkipInstallPluginPrompt(child, text, label) {
    return tryAutoAnswerInstallPluginPrompt(child, text, label);
}

/** 当前通用渠道 login 会话（微信 + 以后 ASYNC_CHANNEL_LOGIN / IPC 传入的任意内置扫码插件） */
let activeChannelLogin = null;

function resolveAsyncChannelLoginSpec(pluginIdOrOpts) {
    const opts = (typeof pluginIdOrOpts === 'string')
        ? { pluginId: pluginIdOrOpts }
        : (pluginIdOrOpts || {});
    const pluginId = String(opts.pluginId || opts.channel || '').trim();
    const fromCatalog = (ASYNC_CHANNEL_LOGIN && ASYNC_CHANNEL_LOGIN[pluginId]) || null;
    const openclawChannel = opts.openclawChannel
        || (fromCatalog && fromCatalog.openclawChannel)
        || pluginId;
    const label = opts.label || (fromCatalog && fromCatalog.label) || pluginId || '渠道';
    const uiChannel = opts.uiChannel || (fromCatalog && fromCatalog.uiChannel) || pluginId;
    const wakeTimeoutMs = Number(opts.wakeTimeoutMs)
        || (fromCatalog && fromCatalog.wakeTimeoutMs)
        || 120000;
    if (!openclawChannel) return null;
    return { pluginId: pluginId || openclawChannel, openclawChannel, label, uiChannel, wakeTimeoutMs };
}

function stopActiveChannelLogin(opts = {}) {
    const sess = activeChannelLogin;
    if (!sess) return;
    if (sess.wakeTimer) {
        clearTimeout(sess.wakeTimer);
        sess.wakeTimer = null;
    }
    if (sess.successWatcher) {
        clearInterval(sess.successWatcher);
        if (wechatLoginSuccessWatcher === sess.successWatcher) wechatLoginSuccessWatcher = null;
        sess.successWatcher = null;
    }
    if (opts.suppressFail) sess.failEmitted = true;
    forceKillChildProcess(sess.process);
    if (wechatLoginProcess === sess.process) wechatLoginProcess = null;
    activeChannelLogin = null;
}

function emitChannelLoginFailed(sess, error) {
    if (!sess || sess.failEmitted) return;
    sess.failEmitted = true;
    if (sess.wakeTimer) {
        clearTimeout(sess.wakeTimer);
        sess.wakeTimer = null;
    }
    if (sess.successWatcher) {
        clearInterval(sess.successWatcher);
        if (wechatLoginSuccessWatcher === sess.successWatcher) wechatLoginSuccessWatcher = null;
        sess.successWatcher = null;
    }
    const payload = {
        pluginId: sess.pluginId,
        channel: sess.uiChannel,
        error: error || `${sess.label}绑定失败`
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('channel-login-failed', payload);
        mainWindow.webContents.send('gateway-log', `[Channel Login/${sess.label}] ❌ ${payload.error}\n`);
        if (sess.pluginId === 'openclaw-weixin' || sess.openclawChannel === 'openclaw-weixin') {
            wechatFailEmitted = true;
            mainWindow.webContents.send('wechat-login-failed', { error: payload.error });
        }
    }
}

/**
 * 解析/落盘微信直连登录脚本：安装包遗漏或只热更了 main.js 时，自动写到用户目录以保证可用。
 */
function ensureWeixinDirectLoginScript() {
    const candidates = [
        resolveAppFsPath('weixin-direct-login.mjs'),
        path.join(__dirname, 'weixin-direct-login.mjs'),
        path.join(CONFIG_DIR, 'weixin-direct-login.mjs')
    ];
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return p;
        } catch (e) {}
    }

    const src = candidates.find((p) => {
        try { return fs.existsSync(p) && !p.startsWith(CONFIG_DIR); } catch (e) { return false; }
    }) || resolveAppFsPath('weixin-direct-login.mjs');
    // 开发树有源文件时拷到 ~/.openclaw
    if (fs.existsSync(src)) {
        try {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
            const dest = path.join(CONFIG_DIR, 'weixin-direct-login.mjs');
            fs.copyFileSync(src, dest);
            return dest;
        } catch (e) {}
        return src;
    }

    // 打包遗漏时内嵌写出，避免再报「缺少 weixin-direct-login.mjs」
    const embedded = `/**
 * 直接调用 @tencent-weixin/openclaw-weixin 扫码登录 API（Nexora Agent 运行时自动落盘）
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function normalizeAccountId(id) {
  return String(id || '').trim().replace(/@/g, '-').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'weixin';
}
async function main() {
  const pluginRoot = process.env.WEIXIN_PLUGIN_ROOT;
  if (!pluginRoot) { emit({ type: 'error', message: 'WEIXIN_PLUGIN_ROOT 未设置' }); process.exit(1); }
  const loginQrUrl = pathToFileURL(path.join(pluginRoot, 'dist', 'src', 'auth', 'login-qr.js')).href;
  const accountsUrl = pathToFileURL(path.join(pluginRoot, 'dist', 'src', 'auth', 'accounts.js')).href;
  let loginQr, accounts;
  try {
    loginQr = await import(loginQrUrl);
    accounts = await import(accountsUrl);
  } catch (e) {
    emit({ type: 'error', message: '加载微信登录模块失败: ' + (e.message || e) });
    process.exit(1);
  }
  const botType = loginQr.DEFAULT_ILINK_BOT_TYPE || '3';
  emit({ type: 'log', message: '正在向微信请求登录二维码...' });
  let startResult;
  try {
    startResult = await loginQr.startWeixinLoginWithQr({ botType, verbose: false });
  } catch (e) {
    emit({ type: 'error', message: '拉取二维码失败: ' + (e.message || e) });
    process.exit(1);
  }
  if (!startResult || !startResult.qrcodeUrl) {
    emit({ type: 'error', message: (startResult && startResult.message) || '未返回二维码链接' });
    process.exit(1);
  }
  emit({ type: 'qr', url: startResult.qrcodeUrl });
  emit({ type: 'log', message: '二维码已生成，请用手机微信扫码确认...' });
  let waitResult;
  try {
    waitResult = await loginQr.waitForWeixinLogin({
      sessionKey: startResult.sessionKey,
      apiBaseUrl: accounts.DEFAULT_BASE_URL || 'https://ilinkai.weixin.qq.com',
      timeoutMs: 480000, verbose: false, botType
    });
  } catch (e) {
    emit({ type: 'error', message: '等待扫码失败: ' + (e.message || e) });
    process.exit(1);
  }
  if (waitResult && waitResult.alreadyConnected) {
    emit({ type: 'success', accountId: 'already-connected', alreadyConnected: true });
    process.exit(0);
  }
  if (waitResult && waitResult.connected && waitResult.botToken && waitResult.accountId) {
    try {
      const normalizedId = normalizeAccountId(waitResult.accountId);
      accounts.saveWeixinAccount(normalizedId, {
        token: waitResult.botToken, baseUrl: waitResult.baseUrl, userId: waitResult.userId
      });
      accounts.registerWeixinAccountId(normalizedId);
      emit({ type: 'success', accountId: normalizedId, userId: waitResult.userId || null });
      process.exit(0);
    } catch (e) {
      emit({ type: 'error', message: '保存微信账号失败: ' + (e.message || e) });
      process.exit(1);
    }
  }
  emit({ type: 'error', message: (waitResult && waitResult.message) || '扫码未完成' });
  process.exit(1);
}
main().catch((e) => { emit({ type: 'error', message: String(e && e.message || e) }); process.exit(1); });
`;
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        const dest = path.join(CONFIG_DIR, 'weixin-direct-login.mjs');
        fs.writeFileSync(dest, embedded, 'utf8');
        return dest;
    } catch (e) {
        return null;
    }
}

/**
 * 微信专用：直接跑 weixin-direct-login.mjs，不经过 openclaw channels login。
 */
function startDirectWeixinChannelLogin(spec) {
    const pluginEntry = BUNDLED_NPM_CHANNEL_PLUGINS.find((e) => e.id === 'openclaw-weixin');
    let pluginRoot = pluginEntry ? resolveBundledNpmPluginPath(pluginEntry) : null;
    if (!pluginRoot) {
        try {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
            const cfg = JSON.parse(raw);
            const ip = cfg?.plugins?.installs?.['openclaw-weixin']?.installPath;
            if (ip && fs.existsSync(ip)) pluginRoot = ip;
        } catch (e) {}
    }
    if (!pluginRoot || !fs.existsSync(path.join(pluginRoot, 'dist', 'src', 'auth', 'login-qr.js'))) {
        return { success: false, error: '未找到内置微信插件登录模块，请重装 Nexora Agent' };
    }

    const scriptPath = ensureWeixinDirectLoginScript();
    if (!scriptPath || !fs.existsSync(scriptPath)) {
        return { success: false, error: '缺少微信直连登录脚本，请更新/重装 Nexora Agent' };
    }

    const nodeExePath = getAvailableNodePath() || process.execPath;
    const { spawn } = require('child_process');
    const env = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' };
    for (const key of Object.keys(env)) {
        if (key.toLowerCase().includes('proxy')) delete env[key];
    }
    env.WEIXIN_PLUGIN_ROOT = pluginRoot;
    // 让插件能解析到同级的 openclaw/plugin-sdk
    const appNm = resolveAppFsPath('node_modules');
    env.NODE_PATH = env.NODE_PATH ? `${appNm}${path.delimiter}${env.NODE_PATH}` : appNm;

    const child = spawn(nodeExePath, [scriptPath], {
        cwd: CONFIG_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });

    const sess = {
        pluginId: spec.pluginId,
        openclawChannel: spec.openclawChannel,
        label: spec.label,
        uiChannel: spec.uiChannel,
        process: child,
        qrEmitted: false,
        failEmitted: false,
        wakeTimer: null,
        successWatcher: null,
        direct: true
    };
    activeChannelLogin = sess;
    wechatLoginProcess = child;

    sess.wakeTimer = setTimeout(() => {
        if (!sess.qrEmitted) {
            forceKillChildProcess(sess.process);
            wechatLoginProcess = null;
            sess.process = null;
            emitChannelLoginFailed(sess, `等待${sess.label}二维码超时。请检查网络后重试。`);
            if (activeChannelLogin === sess) activeChannelLogin = null;
        }
    }, spec.wakeTimeoutMs);
    wechatQrWaitTimer = sess.wakeTimer;

    let lineBuf = '';
    const onChunk = (buf) => {
        const text = buf.toString();
        lineBuf += text;
        const parts = lineBuf.split(/\r?\n/);
        lineBuf = parts.pop() || '';
        for (const line of parts) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let msg;
            try { msg = JSON.parse(trimmed); } catch (e) {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('gateway-log', `[WeChat Login] ${trimmed}\n`);
                }
                continue;
            }
            if (msg.type === 'log' && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('gateway-log', `[WeChat Login] ${msg.message}\n`);
            } else if (msg.type === 'qr' && msg.url) {
                sess.qrEmitted = true;
                wechatQrEmitted = true;
                if (sess.wakeTimer) {
                    clearTimeout(sess.wakeTimer);
                    sess.wakeTimer = null;
                }
                clearWeChatQrWaitTimer();
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('gateway-log', `[WeChat Login] 二维码已生成\n`);
                    mainWindow.webContents.send('gateway-qrcode', {
                        url: msg.url,
                        channel: 'wechat',
                        pluginId: 'openclaw-weixin',
                        title: '微信扫码登录',
                        tip: '请使用手机微信扫描下方二维码授权登录。'
                    });
                }
            } else if (msg.type === 'success') {
                clearWeChatQrWaitTimer();
                if (sess.wakeTimer) {
                    clearTimeout(sess.wakeTimer);
                    sess.wakeTimer = null;
                }
                const accountId = msg.accountId || 'weixin';
                // 延迟检查：给文件系统足够的时间落盘
                const verifyAndNotify = () => {
                    try {
                        let status = getWeChatStatus();
                        // 如果凭证文件不存在，创建目录后再试一次
                        if (!status.bound) {
                            console.warn(`[WeChat Login] 子进程报告成功但 accounts.json 不存在，创建目录后重试...`);
                            try {
                                const weixinDir = path.join(CONFIG_DIR, 'openclaw-weixin');
                                fs.mkdirSync(weixinDir, { recursive: true });
                                fs.mkdirSync(path.join(weixinDir, 'accounts'), { recursive: true });
                            } catch (e) {}
                            // 再等 1.5s 后最终检查
                            setTimeout(() => {
                                try {
                                    status = getWeChatStatus();
                                    emitWeChatResult(status, accountId, msg.userId);
                                } catch (e2) {
                                    console.error('[WeChat Login] 延迟校验失败:', e2);
                                    emitWeChatResult({ bound: false }, accountId, msg.userId);
                                }
                            }, 1500);
                            return;
                        }
                        emitWeChatResult(status, accountId, msg.userId);
                    } catch (e) {
                        console.error('[WeChat Login] verifyAndNotify error:', e);
                        emitWeChatResult({ bound: false }, accountId, msg.userId);
                    }
                };
                const emitWeChatResult = (status, acctId, userId) => {
                    if (!mainWindow || mainWindow.isDestroyed()) return;
                    if (status.bound) {
                        mainWindow.webContents.send('wechat-login-success', status);
                        mainWindow.webContents.send('gateway-log', `[WeChat Login] ✅ 绑定成功 (凭证已落盘)\n`);
                    } else {
                        console.warn(`[WeChat Login] 凭证文件仍未找到，使用子进程返回信息。accountId=${acctId}`);
                        mainWindow.webContents.send('wechat-login-success', {
                            success: true, bound: true,
                            details: { accountId: (acctId || '').split('-')[0], userId: userId || 'WeChat Bot' }
                        });
                        mainWindow.webContents.send('gateway-log', `[WeChat Login] ⚠️ 绑定成功但凭证文件未发现，重启网关后可能需要重新扫码\n`);
                    }
                    mainWindow.webContents.send('channel-login-success', {
                        pluginId: 'openclaw-weixin', channel: 'wechat', accountId: acctId
                    });
                    // 确保 channels 配置中有 enabled: true
                    try {
                        const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
                        const cfg = JSON.parse(raw);
                        let save = false;
                        if (!cfg.channels) { cfg.channels = {}; save = true; }
                        if (!cfg.channels['openclaw-weixin']) { cfg.channels['openclaw-weixin'] = {}; save = true; }
                        if (cfg.channels['openclaw-weixin'].enabled !== true) {
                            cfg.channels['openclaw-weixin'].enabled = true; save = true;
                        }
                        if (save) {
                            fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
                            console.log('[WeChat Login] 已在 openclaw.json channels 中设置 openclaw-weixin.enabled = true');
                        }
                    } catch (cfgErr) {
                        console.warn('[WeChat Login] 更新 channels 配置失败:', cfgErr.message);
                    }
                };
                setTimeout(verifyAndNotify, 500);
            } else if (msg.type === 'error') {
                emitChannelLoginFailed(sess, msg.message || '微信绑定失败');
            }
        }
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', (d) => {
        const t = d.toString();
        if (mainWindow && !mainWindow.isDestroyed() && t.trim()) {
            mainWindow.webContents.send('gateway-log', `[WeChat Login] ${t}`);
        }
    });
    child.on('exit', (code) => {
        console.log(`[Channel Login] Weixin direct exited code=${code}`);
        if (wechatLoginProcess === child) wechatLoginProcess = null;
        sess.process = null;
        if (sess.wakeTimer) {
            clearTimeout(sess.wakeTimer);
            sess.wakeTimer = null;
        }
        clearWeChatQrWaitTimer();
        if (!sess.qrEmitted && !sess.failEmitted) {
            emitChannelLoginFailed(sess, `微信绑定进程已退出（code ${code == null ? '?' : code}），未能生成二维码`);
        }
        if (activeChannelLogin === sess) activeChannelLogin = null;
    });

    return { success: true, pluginId: spec.pluginId, channel: spec.uiChannel, mode: 'direct' };
}

/**
 * 通用内置渠道 login。新增扫码插件：在 ASYNC_CHANNEL_LOGIN 登记，或 IPC 传 openclawChannel/label。
 * 统一：信任预同步、跳过 Install?、出码超时、失败事件、可取消。
 * 微信：走 weixin-direct-login.mjs 直连，避开 channels login 的 does not support login。
 */
async function startBundledChannelLogin(pluginIdOrOpts) {
    const spec = resolveAsyncChannelLoginSpec(pluginIdOrOpts);
    if (!spec) return { success: false, error: '无效的渠道插件 ID' };

    stopActiveChannelLogin({ suppressFail: true });
    clearWeChatQrWaitTimer();
    wechatQrEmitted = false;
    wechatFailEmitted = false;
    forceKillWeChatLoginProcess();
    if (wechatLoginSuccessWatcher) {
        clearInterval(wechatLoginSuccessWatcher);
        wechatLoginSuccessWatcher = null;
    }

    try { prepareChannelPluginsBeforeGateway(); } catch (e) {
        console.warn('[Channel Login] prepareChannelPluginsBeforeGateway:', e.message);
    }

    if (spec.openclawChannel === 'openclaw-weixin') {
        return startDirectWeixinChannelLogin(spec);
    }

    const openclawEntry = resolveAppFsPath('node_modules', 'openclaw', 'dist', 'index.js');
    if (!fs.existsSync(openclawEntry)) {
        return { success: false, error: '内置 OpenClaw 模块缺失，无法唤醒绑定' };
    }

    const nodeExePath = getAvailableNodePath();
    const deployed = (() => {
        try { return deployRuntimeArtifacts(); } catch (e) { return null; }
    })();
    const patchPath = (deployed && deployed.patchPath)
        || (fs.existsSync(resolveAppFsPath('patch_gateway.js'))
            ? resolveAppFsPath('patch_gateway.js').replace(/\\/g, '/')
            : path.join(__dirname, 'patch_gateway.js').replace(/\\/g, '/'));
    const cleanEnv = {
        ...process.env,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        NEXORA_AGENT_PATCH_PATH: patchPath
    };
    for (const key of Object.keys(cleanEnv)) {
        if (key.toLowerCase().includes('proxy')) delete cleanEnv[key];
    }
    cleanEnv.NODE_OPTIONS = buildPatchedNodeOptions(patchPath);
    try {
        const runtimeNm = resolveAppFsPath('node_modules');
        if (fs.existsSync(runtimeNm)) {
            cleanEnv.NODE_PATH = cleanEnv.NODE_PATH
                ? `${runtimeNm}${path.delimiter}${cleanEnv.NODE_PATH}`
                : runtimeNm;
            cleanEnv.NEXORA_AGENT_GATEWAY_RUNTIME = resolveAppFsRoot();
        }
    } catch (e) {}
    const forkOptions = {
        cwd: CONFIG_DIR,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--require', patchPath, '--dns-result-order=ipv4first'],
        env: cleanEnv
    };
    if (nodeExePath) {
        forkOptions.execPath = nodeExePath;
        const sandboxDir = path.dirname(nodeExePath);
        const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
        forkOptions.env[pathKey] = `${sandboxDir}${path.delimiter}${process.env[pathKey] || ''}`;
    }

    const child = fork(openclawEntry, ['channels', 'login', '--channel', spec.openclawChannel], forkOptions);
    const sess = {
        pluginId: spec.pluginId,
        openclawChannel: spec.openclawChannel,
        label: spec.label,
        uiChannel: spec.uiChannel,
        process: child,
        qrEmitted: false,
        failEmitted: false,
        wakeTimer: null,
        successWatcher: null
    };
    activeChannelLogin = sess;
    if (spec.openclawChannel === 'openclaw-weixin') wechatLoginProcess = child;

    if (spec.openclawChannel === 'openclaw-weixin') {
        const watcherStartedAt = Date.now();
        sess.successWatcher = setInterval(() => {
            try {
                const status = getWeChatStatus();
                if (status.bound && status.details) {
                    if (sess.successWatcher) {
                        clearInterval(sess.successWatcher);
                        if (wechatLoginSuccessWatcher === sess.successWatcher) wechatLoginSuccessWatcher = null;
                        sess.successWatcher = null;
                    }
                    if (sess.wakeTimer) {
                        clearTimeout(sess.wakeTimer);
                        sess.wakeTimer = null;
                    }
                    clearWeChatQrWaitTimer();
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('wechat-login-success', status);
                        mainWindow.webContents.send('channel-login-success', {
                            pluginId: sess.pluginId,
                            channel: sess.uiChannel,
                            ...status
                        });
                    }
                }
            } catch (err) {}
            if (Date.now() - watcherStartedAt > 5 * 60 * 1000 && sess.successWatcher) {
                clearInterval(sess.successWatcher);
                if (wechatLoginSuccessWatcher === sess.successWatcher) wechatLoginSuccessWatcher = null;
                sess.successWatcher = null;
            }
        }, 1500);
        wechatLoginSuccessWatcher = sess.successWatcher;
    }

    sess.wakeTimer = setTimeout(() => {
        if (!sess.qrEmitted) {
            forceKillChildProcess(sess.process);
            if (wechatLoginProcess === sess.process) wechatLoginProcess = null;
            sess.process = null;
            emitChannelLoginFailed(sess, `等待${sess.label}二维码超时（绑定模块未响应）。请重试一次。`);
            if (activeChannelLogin === sess) activeChannelLogin = null;
        }
    }, spec.wakeTimeoutMs);
    if (spec.openclawChannel === 'openclaw-weixin') wechatQrWaitTimer = sess.wakeTimer;

    let loginLogTail = '';
    const handleLoginLog = (data) => {
        let text = data.toString();
        if (text.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
            text = text.split(/\r?\n/).filter(line =>
                !line.includes('NODE_TLS_REJECT_UNAUTHORIZED') && !line.includes('disabling certificate verification')
            ).join('\n');
        }
        if (!text.trim()) return;
        tryAutoAnswerInstallPluginPrompt(child, text, `${sess.label}绑定`);
        loginLogTail = (loginLogTail + text).slice(-16000);
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('gateway-log', text);

        if (/does not support\s+login/i.test(loginLogTail)) {
            forceKillChildProcess(sess.process);
            if (wechatLoginProcess === sess.process) wechatLoginProcess = null;
            sess.process = null;
            emitChannelLoginFailed(sess,
                `${sess.label}渠道当前无法登录（插件未正确加载）。请停止后再启动 Nexora Agent，然后重试扫码绑定。`);
            if (activeChannelLogin === sess) activeChannelLogin = null;
            return;
        }

        const qrUrl = extractChannelLoginQrUrl(loginLogTail);
        if (qrUrl) {
            sess.qrEmitted = true;
            if (sess.openclawChannel === 'openclaw-weixin') wechatQrEmitted = true;
            if (sess.wakeTimer) {
                clearTimeout(sess.wakeTimer);
                sess.wakeTimer = null;
            }
            clearWeChatQrWaitTimer();
            mainWindow.webContents.send('gateway-qrcode', {
                url: qrUrl,
                channel: sess.uiChannel,
                pluginId: sess.pluginId,
                title: `${sess.label}扫码登录`,
                tip: `请使用手机扫描下方二维码完成${sess.label}授权。`
            });
        }
    };

    child.stdout.on('data', handleLoginLog);
    child.stderr.on('data', handleLoginLog);
    child.on('exit', (code) => {
        console.log(`[Channel Login] ${sess.label} exited code=${code}`);
        if (wechatLoginProcess === child) wechatLoginProcess = null;
        sess.process = null;
        let succeeded = false;
        if (sess.openclawChannel === 'openclaw-weixin') {
            try {
                const status = getWeChatStatus();
                if (status.bound && status.details && mainWindow && !mainWindow.isDestroyed()) {
                    succeeded = true;
                    clearWeChatQrWaitTimer();
                    mainWindow.webContents.send('wechat-login-success', status);
                    mainWindow.webContents.send('channel-login-success', {
                        pluginId: sess.pluginId,
                        channel: sess.uiChannel,
                        ...status
                    });
                }
            } catch (err) {}
        }
        if (sess.successWatcher) {
            clearInterval(sess.successWatcher);
            if (wechatLoginSuccessWatcher === sess.successWatcher) wechatLoginSuccessWatcher = null;
            sess.successWatcher = null;
        }
        if (!succeeded && !sess.qrEmitted) {
            emitChannelLoginFailed(sess, `${sess.label}绑定进程已退出（code ${code == null ? '?' : code}），未能生成二维码`);
        }
        if (activeChannelLogin === sess) activeChannelLogin = null;
    });

    return { success: true, pluginId: spec.pluginId, channel: spec.uiChannel };
}

ipcMain.handle('wechat-login-cancel', async () => {
    stopActiveChannelLogin({ suppressFail: true });
    clearWeChatQrWaitTimer();
    wechatQrEmitted = false;
    wechatFailEmitted = true;
    if (wechatLoginSuccessWatcher) {
        clearInterval(wechatLoginSuccessWatcher);
        wechatLoginSuccessWatcher = null;
    }
    forceKillWeChatLoginProcess();
    return { success: true };
});

ipcMain.handle('channel-login-start', async (_event, opts) => {
    try {
        return await startBundledChannelLogin(opts);
    } catch (e) {
        console.error('channel-login-start failed:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('channel-login-cancel', async (_event, pluginId) => {
    if (activeChannelLogin) {
        if (!pluginId
            || activeChannelLogin.pluginId === pluginId
            || activeChannelLogin.openclawChannel === pluginId
            || activeChannelLogin.uiChannel === pluginId) {
            stopActiveChannelLogin({ suppressFail: true });
            wechatFailEmitted = true;
        }
    }
    return { success: true };
});

ipcMain.handle('channel-login-cancel-all', async () => {
    stopActiveChannelLogin({ suppressFail: true });
    clearWeChatQrWaitTimer();
    wechatFailEmitted = true;
    forceKillWeChatLoginProcess();
    if (wechatLoginSuccessWatcher) {
        clearInterval(wechatLoginSuccessWatcher);
        wechatLoginSuccessWatcher = null;
    }
    try {
        if (typeof feishuQrAbortController !== 'undefined' && feishuQrAbortController) {
            try { feishuQrAbortController.abort(); } catch (e) {}
            feishuQrAbortController = null;
        }
        if (typeof feishuQrBusy !== 'undefined') feishuQrBusy = false;
    } catch (e) {}
    return { success: true };
});

ipcMain.handle('wechat-login', async () => {
    try {
        return await startBundledChannelLogin('openclaw-weixin');
    } catch (e) {
        console.error('Failed to start WeChat login process:', e);
        return { success: false, error: e.message };
    }
});

// ========== 飞书第二种配置模型：扫码创机器人（OAuth device-code）==========
// 对接 @openclaw/feishu 官方 app-registration 流程；扫码后自动写入 App ID/Secret。
const FEISHU_ACCOUNTS_URL = 'https://accounts.feishu.cn';
const LARK_ACCOUNTS_URL = 'https://accounts.larksuite.com';
const FEISHU_REGISTRATION_PATH = '/oauth/v1/app/registration';
const FEISHU_SCAN_TP = 'ob_cli_app';
let feishuQrAbortController = null;
let feishuQrBusy = false;

function feishuAccountsBaseUrl(domain) {
    return domain === 'lark' ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
}

async function postFeishuAppRegistration(baseUrl, body, signal) {
    const res = await fetch(`${baseUrl}${FEISHU_REGISTRATION_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        signal: signal || AbortSignal.timeout(10000)
    });
    if (!res.ok) {
        throw new Error(`飞书注册接口 HTTP ${res.status}`);
    }
    return await res.json();
}

function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeOpenClawConfigObject(config) {
    const cleanConfig = JSON.parse(JSON.stringify(config));
    delete cleanConfig.videoGenerator;
    delete cleanConfig.imageGenerator;
    const originalBytes = fs.existsSync(CONFIG_PATH) ? fs.statSync(CONFIG_PATH).size : 39500;
    let newJson = JSON.stringify(cleanConfig, null, 2);
    const newBytes = Buffer.byteLength(newJson, 'utf8');
    if (newBytes < originalBytes) {
        const padSize = originalBytes - newBytes;
        newJson = newJson + '\n' + ' '.repeat(Math.max(0, padSize - 1));
    }
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, newJson, 'utf8');
}

function applyFeishuScanResultToConfig(result) {
    let config = {};
    if (fs.existsSync(CONFIG_PATH)) {
        let content = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
        config = JSON.parse(content);
    }
    if (!config.channels) config.channels = {};
    if (!config.channels.feishu || typeof config.channels.feishu !== 'object') {
        config.channels.feishu = {};
    }
    const feishu = config.channels.feishu;
    if (!feishu.accounts || typeof feishu.accounts !== 'object') feishu.accounts = {};

    const baseId = 'feishu-scan';
    let accountId = baseId;
    let n = 2;
    while (feishu.accounts[accountId]) {
        accountId = `${baseId}-${n}`;
        n += 1;
    }

    const accountPatch = {
        appId: result.appId,
        appSecret: result.appSecret,
        enabled: true
    };
    if (result.domain) accountPatch.domain = result.domain;
    if (result.openId) {
        accountPatch.dmPolicy = 'allowlist';
        accountPatch.allowFrom = [result.openId];
    }

    feishu.accounts[accountId] = accountPatch;
    feishu.enabled = true;
    if (!feishu.defaultAccount) feishu.defaultAccount = accountId;
    if (result.domain) feishu.domain = result.domain;
    // 扫码创建的个人 Agent：私信默认仅本人；群聊开放但需要 @
    if (!feishu.groupPolicy) feishu.groupPolicy = 'open';
    if (feishu.requireMention === undefined) feishu.requireMention = true;
    if (result.openId && !feishu.dmPolicy) {
        feishu.dmPolicy = 'allowlist';
        if (!Array.isArray(feishu.allowFrom) || feishu.allowFrom.length === 0) {
            feishu.allowFrom = [result.openId];
        }
    }

    if (!config.plugins) config.plugins = {};
    if (!config.plugins.entries) config.plugins.entries = {};
    config.plugins.entries.feishu = { ...(config.plugins.entries.feishu || {}), enabled: true };
    if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
    if (!config.plugins.allow.includes('feishu')) config.plugins.allow.push('feishu');

    try { sanitizeFeishuConfig(config); } catch (e) {}
    writeOpenClawConfigObject(config);
    return { accountId, appId: result.appId, openId: result.openId || null, domain: result.domain || 'feishu' };
}

async function pollFeishuAppRegistration(params) {
    const { deviceCode, expireIn, interval, initialDomain, abortSignal } = params;
    let currentInterval = Math.max(1, Number(interval) || 5);
    let domain = initialDomain || 'feishu';
    let domainSwitched = false;
    const expireMs = (Math.max(30, Number(expireIn) || 600)) * 1000;
    const deadline = Date.now() + expireMs;

    while (Date.now() < deadline) {
        if (abortSignal?.aborted) return { status: 'cancelled' };
        let pollRes;
        try {
            pollRes = await postFeishuAppRegistration(
                feishuAccountsBaseUrl(domain),
                {
                    action: 'poll',
                    device_code: deviceCode,
                    tp: FEISHU_SCAN_TP
                },
                abortSignal
            );
        } catch (e) {
            if (abortSignal?.aborted) return { status: 'cancelled' };
            await sleepMs(currentInterval * 1000);
            continue;
        }

        if (pollRes.user_info?.tenant_brand) {
            const isLark = pollRes.user_info.tenant_brand === 'lark';
            if (!domainSwitched && isLark) {
                domain = 'lark';
                domainSwitched = true;
                continue;
            }
        }

        if (pollRes.client_id && pollRes.client_secret) {
            return {
                status: 'success',
                result: {
                    appId: pollRes.client_id,
                    appSecret: pollRes.client_secret,
                    domain,
                    openId: pollRes.user_info?.open_id
                }
            };
        }

        if (pollRes.error) {
            if (pollRes.error === 'authorization_pending') {
                // keep polling
            } else if (pollRes.error === 'slow_down') {
                currentInterval += 5;
            } else if (pollRes.error === 'access_denied') {
                return { status: 'access_denied' };
            } else if (pollRes.error === 'expired_token') {
                return { status: 'expired' };
            } else {
                return {
                    status: 'error',
                    message: `${pollRes.error}: ${pollRes.error_description || 'unknown'}`
                };
            }
        }
        await sleepMs(currentInterval * 1000);
    }
    return { status: 'timeout' };
}

ipcMain.handle('feishu-qr-login-cancel', async () => {
    if (feishuQrAbortController) {
        try { feishuQrAbortController.abort(); } catch (e) {}
        feishuQrAbortController = null;
    }
    feishuQrBusy = false;
    return { success: true };
});

ipcMain.handle('feishu-qr-login', async (_event, opts = {}) => {
    if (feishuQrBusy) {
        return { success: false, error: '飞书扫码绑定已在进行中' };
    }
    feishuQrBusy = true;
    if (feishuQrAbortController) {
        try { feishuQrAbortController.abort(); } catch (e) {}
    }
    feishuQrAbortController = new AbortController();
    const abortSignal = feishuQrAbortController.signal;
    const domain = (opts && opts.domain === 'lark') ? 'lark' : 'feishu';

    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-log', '\n[Feishu QR] 正在发起扫码创建机器人...\n');
        }

        try {
            const initRes = await postFeishuAppRegistration(
                feishuAccountsBaseUrl(domain),
                { action: 'init' },
                abortSignal
            );
            if (!(initRes.supported_auth_methods || []).includes('client_secret')) {
                feishuQrBusy = false;
                return { success: false, error: '当前环境不支持扫码创建应用，请改用手动填写 App ID / Secret' };
            }
        } catch (e) {
            if (abortSignal.aborted) {
                feishuQrBusy = false;
                return { success: false, cancelled: true };
            }
            feishuQrBusy = false;
            return { success: false, error: '扫码创建暂不可用：' + (e.message || String(e)) };
        }

        const beginRes = await postFeishuAppRegistration(
            feishuAccountsBaseUrl(domain),
            {
                action: 'begin',
                archetype: 'PersonalAgent',
                auth_method: 'client_secret',
                request_user_info: 'open_id'
            },
            abortSignal
        );

        if (!beginRes.device_code || !beginRes.verification_uri_complete) {
            feishuQrBusy = false;
            return { success: false, error: '飞书未返回有效的扫码信息，请稍后重试或改用手动配置' };
        }

        const qrUrl = new URL(beginRes.verification_uri_complete);
        qrUrl.searchParams.set('from', 'oc_onboard');
        qrUrl.searchParams.set('tp', FEISHU_SCAN_TP);
        const qrUrlStr = qrUrl.toString();

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-qrcode', {
                url: qrUrlStr,
                channel: 'feishu',
                title: '飞书扫码绑定',
                tip: '请使用手机飞书扫描下方二维码，自动创建并绑定机器人。'
            });
            mainWindow.webContents.send('gateway-log', `[Feishu QR] 二维码已生成，请使用飞书 App 扫码授权...\n`);
        }

        // 异步轮询，完成后推送事件（本 handler 先返回成功表示二维码已拉起）
        (async () => {
            try {
                const outcome = await pollFeishuAppRegistration({
                    deviceCode: beginRes.device_code,
                    expireIn: beginRes.expire_in || 600,
                    interval: beginRes.interval || 5,
                    initialDomain: domain,
                    abortSignal
                });

                if (outcome.status === 'success' && outcome.result) {
                    const saved = applyFeishuScanResultToConfig(outcome.result);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('feishu-login-success', saved);
                        mainWindow.webContents.send('gateway-log',
                            `[Feishu QR] 扫码绑定成功：账号 ${saved.accountId} / AppId ${saved.appId}\n`);
                    }
                } else if (outcome.status !== 'cancelled') {
                    const msgMap = {
                        access_denied: '用户拒绝了授权',
                        expired: '二维码已过期，请重新扫码绑定',
                        timeout: '等待扫码超时，请重试',
                        error: outcome.message || '扫码绑定失败'
                    };
                    const errMsg = msgMap[outcome.status] || ('扫码绑定失败: ' + outcome.status);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('feishu-login-failed', { error: errMsg });
                        mainWindow.webContents.send('gateway-log', `[Feishu QR] ${errMsg}\n`);
                    }
                }
            } catch (e) {
                if (!abortSignal.aborted && mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('feishu-login-failed', { error: e.message || String(e) });
                }
            } finally {
                feishuQrBusy = false;
                feishuQrAbortController = null;
            }
        })();

        return { success: true, qrUrl: qrUrlStr };
    } catch (e) {
        feishuQrBusy = false;
        feishuQrAbortController = null;
        if (abortSignal.aborted) return { success: false, cancelled: true };
        console.error('Failed to start Feishu QR login:', e);
        return { success: false, error: e.message || String(e) };
    }
});

// 开机自启的设置与获取
ipcMain.handle('autostart-get', async () => {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
});

// 获取应用当前版本号
ipcMain.handle('get-app-version', async () => {
    return app.getVersion();
});

ipcMain.handle('autostart-set', async (event, enabled) => {
    app.setLoginItemSettings({
        openAtLogin: enabled,
        path: app.getPath('exe')
    });
    return true;
});

// 读取本地真实大模型调用统计 (使用纯原生 Node.js 实现，彻底剔除外部 Python 脚本依赖，实现 100% 开箱即用)
ipcMain.handle('stats-get', async () => {
    try {
        const stats = {
            total_tokens: 0,
            total_requests: 0,
            total_cost: 0.0,
            sub_input_tokens: 0,
            sub_output_tokens: 0,
            sub_hit_tokens: 0,
            hit_rate: 0.0,
            hourly_trend: {}, // {hour: {cost: 0, hit: 0, input: 0, output: 0}}
            logs: [],
            providers: {},
            models: {}
        };

        const persistentCandidates = [
            path.join(CONFIG_DIR, 'persistent_logs', 'real_tokens.json'),
            process.env.OPENCLAW_STATE_DIR ? path.join(process.env.OPENCLAW_STATE_DIR, 'persistent_logs', 'real_tokens.json') : null,
            process.env.OPENCLAW_HOME ? path.join(process.env.OPENCLAW_HOME, '.openclaw', 'persistent_logs', 'real_tokens.json') : null,
            path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'persistent_logs', 'real_tokens.json'),
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'NexoraAgent', '.openclaw', 'persistent_logs', 'real_tokens.json') : null
        ].filter((p, i, arr) => Boolean(p) && String(p).includes('real_tokens.json') && arr.indexOf(p) === i);

        let realTokensPath = null;
        for (const candidate of persistentCandidates) {
            try {
                if (fs.existsSync(candidate)) {
                    realTokensPath = candidate;
                    break;
                }
            } catch (e) {}
        }

        if (realTokensPath) {
            try {
                const content = fs.readFileSync(realTokensPath, 'utf8');
                const realLogs = JSON.parse(content);
                if (Array.isArray(realLogs)) {
                    for (const log of realLogs) {
                        const p_name = log.provider || 'gateway';
                        const m_name = log.model || 'unknown-model';
                        const input_t = parseInt(log.input) || 0;
                        const output_t = parseInt(log.output) || 0;
                        const hit_t = parseInt(log.hit) || 0;
                        const elapsed_str = log.duration || '1.0s';
                        
                        let elapsed_ms = 1000;
                        try {
                            elapsed_ms = parseInt(parseFloat(elapsed_str.replace('s', '')) * 1000);
                        } catch(e) {}
                        
                        const timestamp = log.timestamp || Date.now();
                        const est_tokens = input_t + output_t + hit_t;
                        
                        stats.total_tokens += est_tokens;
                        stats.total_requests += 1;
                        stats.sub_input_tokens += input_t;
                        stats.sub_output_tokens += output_t;
                        stats.sub_hit_tokens += hit_t;
                        
                        const dt = new Date(timestamp);
                        const hour_str = `${dt.getHours().toString().padStart(2, '0')}:00`;
                        
                        if (!stats.hourly_trend[hour_str]) {
                            stats.hourly_trend[hour_str] = { cost: 0, hit: 0, input: 0, output: 0 };
                        }
                        stats.hourly_trend[hour_str].input += input_t;
                        stats.hourly_trend[hour_str].output += output_t;
                        stats.hourly_trend[hour_str].hit += hit_t;
                        
                        if (!stats.providers[p_name]) {
                            stats.providers[p_name] = { requests: 0, tokens: 0, hit: 0 };
                        }
                        stats.providers[p_name].requests += 1;
                        stats.providers[p_name].tokens += est_tokens;
                        stats.providers[p_name].hit += hit_t;
                        
                        if (!stats.models[m_name]) {
                            stats.models[m_name] = { provider: p_name, calls: 0, tokens: 0, duration: 0.0, hit: 0 };
                        }
                        stats.models[m_name].calls += 1;
                        stats.models[m_name].tokens += est_tokens;
                        stats.models[m_name].duration += (elapsed_ms / 1000.0);
                        stats.models[m_name].hit += hit_t;
                        
                        const time_str = log.time || `${dt.getHours().toString().padStart(2, '0')}:${dt.getMinutes().toString().padStart(2, '0')}:${dt.getSeconds().toString().padStart(2, '0')}`;
                        stats.logs.push({
                            time: time_str,
                            provider: p_name,
                            model: m_name,
                            input: input_t,
                            output: output_t,
                            hit: hit_t,
                            duration: elapsed_str,
                            status: log.status || '成功',
                            timestamp: timestamp
                        });
                    }
                }
            } catch(err) {
                console.error('Failed to parse real_tokens.json in stats:', err);
            }
        }

        if (stats.total_tokens > 0) {
            stats.hit_rate = (stats.sub_hit_tokens / stats.total_tokens) * 100.0;
        }
        
        // 计算成本：输入 1.5$/M，输出 6.0$/M
        stats.total_cost = (stats.sub_input_tokens / 1000000.0) * 1.5 + (stats.sub_output_tokens / 1000000.0) * 6.0;
        
        // 按时间戳降序排列，取最近 1000 条 (前端需要全局数据计算总量)
        stats.logs.sort((a, b) => b.timestamp - a.timestamp);
        stats.logs = stats.logs.slice(0, 1000);

        return { success: true, data: stats };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('stats-append', async (event, logEntry) => {
    try {
        const persistentCandidates = [
            path.join(CONFIG_DIR, 'persistent_logs', 'real_tokens.json'),
            process.env.OPENCLAW_STATE_DIR ? path.join(process.env.OPENCLAW_STATE_DIR, 'persistent_logs', 'real_tokens.json') : null,
            process.env.OPENCLAW_HOME ? path.join(process.env.OPENCLAW_HOME, '.openclaw', 'persistent_logs', 'real_tokens.json') : null,
            path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'persistent_logs', 'real_tokens.json'),
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'NexoraAgent', '.openclaw', 'persistent_logs', 'real_tokens.json') : null
        ].filter((p, i, arr) => Boolean(p) && String(p).includes('real_tokens.json') && arr.indexOf(p) === i);

        let realTokensPath = null;
        for (const candidate of persistentCandidates) {
            try {
                if (fs.existsSync(candidate)) {
                    realTokensPath = candidate;
                    break;
                }
            } catch (e) {}
        }

        if (!realTokensPath && persistentCandidates.length > 0) {
            realTokensPath = persistentCandidates[0];
            const dir = path.dirname(realTokensPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(realTokensPath, '[]', 'utf8');
        }

        if (realTokensPath) {
            let realLogs = [];
            try {
                const content = fs.readFileSync(realTokensPath, 'utf8');
                realLogs = JSON.parse(content);
            } catch (e) {}
            
            if (!Array.isArray(realLogs)) realLogs = [];
            
            if (!logEntry.time) {
                const dt = new Date();
                const pad = (n) => n < 10 ? '0' + n : n;
                logEntry.time = `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
            }
            if (!logEntry.timestamp) logEntry.timestamp = Date.now();
            if (!logEntry.status) logEntry.status = '成功';

            realLogs.push(logEntry);
            
            fs.writeFileSync(realTokensPath, JSON.stringify(realLogs, null, 2), 'utf8');
        }
        return true;
    } catch (err) {
        console.error('stats-append error:', err);
        return false;
    }
});

// 获取本地最新的带 token 的Nexora Agent面板 URL（始终按当前 openclaw.json 组装，保证默认免密登入）
ipcMain.handle('get-dashboard-url', async () => {
    return rememberDashboardUrl(global.latestAcpDashboardUrl || buildGatewayDashboardUrl());
});

// 清除内置 Control UI webview 的持久化会话（过期 token / 限流后重建）
ipcMain.handle('clear-openclaw-panel-session', async () => {
    try {
        const ses = session.fromPartition('persist:nexora-agent-openclaw-panel');
        await ses.clearStorageData({
            storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']
        });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 一键拉起外部浏览器链接 (用于免密 ACP 控制台跳转)
ipcMain.handle('open-external', async (event, url) => {
    try {
        const { shell } = require('electron');
        
        // 特殊处理：如果是打开 OpenClaw 控制面板，我们通过官方 dashboard 命令动态获取带最新令牌的免密 URL
        if (url === 'openclaw-dashboard') {
            const freshUrl = buildGatewayDashboardUrl();
            global.latestAcpDashboardUrl = freshUrl;
            shell.openExternal(freshUrl);
            return true;
        }

        await shell.openExternal(url);
        return true;
    } catch (e) {
        console.error('Failed to open external url:', e);
        return false;
    }
});

// 获取应用启动时间
ipcMain.handle('get-app-start-time', () => {
    return appStartTime;
});

// ─── 软件更新：多通道探测 (直连 GitHub API → 镜像代理 → 页面重定向解析) ───
const UPDATE_REPO = '2014-y/Nexora-Agent';
const UPDATE_RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`;
const UPDATE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function withGithubMirrors(url) {
    // 国内常见 GitHub 加速前缀；直连放首位，失败后再依次尝试镜像
    return [
        url,
        `https://ghproxy.net/${url}`,
        `https://mirror.ghproxy.com/${url}`,
        `https://gh.ddlc.top/${url}`
    ];
}

function httpsRequest(urlStr, { method = 'GET', headers = {}, timeout = 10000, maxRedirects = 5 } = {}) {
    const https = require('https');
    const http = require('http');
    const { URL } = require('url');

    return new Promise((resolve, reject) => {
        let redirects = 0;

        const doRequest = (currentUrl) => {
            let parsed;
            try { parsed = new URL(currentUrl); }
            catch (e) { return reject(e); }

            const lib = parsed.protocol === 'http:' ? http : https;
            const req = lib.request({
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
                path: parsed.pathname + parsed.search,
                method,
                headers: { 'User-Agent': UPDATE_UA, ...headers },
                timeout,
                rejectUnauthorized: false
            }, (res) => {
                const status = res.statusCode || 0;
                const location = res.headers.location;

                // 跟随重定向，同时把最终 Location 暴露给调用方做版本解析
                if (status >= 300 && status < 400 && location && redirects < maxRedirects) {
                    redirects++;
                    res.resume();
                    const nextUrl = location.startsWith('http') ? location : `${parsed.protocol}//${parsed.host}${location}`;
                    return doRequest(nextUrl);
                }

                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    resolve({
                        status,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString('utf8'),
                        finalUrl: currentUrl,
                        location
                    });
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('请求超时'));
            });
            req.end();
        };

        doRequest(urlStr);
    });
}

async function httpsGetJson(urlStr) {
    const res = await httpsRequest(urlStr, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github.v3+json' },
        timeout: 10000
    });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(`请求失败，状态码: ${res.status}`);
    }
    try {
        return JSON.parse(res.body);
    } catch (e) {
        throw new Error('响应不是合法 JSON');
    }
}

function isNewerVersion(latest, current) {
    const normalize = (v) => String(v || '').replace(/^v/i, '').split(/[.-]/).map((p) => {
        const n = parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
    });
    const lParts = normalize(latest);
    const cParts = normalize(current);
    const len = Math.max(lParts.length, cParts.length, 3);
    for (let i = 0; i < len; i++) {
        const lVal = lParts[i] || 0;
        const cVal = cParts[i] || 0;
        if (lVal > cVal) return true;
        if (lVal < cVal) return false;
    }
    return false;
}

function extractTagFromText(text) {
    if (!text) return '';
    const match = String(text).match(/\/releases\/tag\/(v?[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-.][0-9A-Za-z]+)*)/);
    return match ? match[1] : '';
}

// 通过 HEAD/GET releases/latest 解析最终重定向到的 tag
async function getLatestVersionFromRedirect(urlStr) {
    // 先 HEAD（轻量）；部分代理不支持 HEAD，再降级 GET
    for (const method of ['HEAD', 'GET']) {
        try {
            const res = await httpsRequest(urlStr, {
                method,
                timeout: 10000,
                maxRedirects: 8
            });
            const tag =
                extractTagFromText(res.finalUrl) ||
                extractTagFromText(res.location) ||
                extractTagFromText(res.body);
            if (tag) return tag;
            throw new Error(`未能从 ${method} 响应中解析版本号 (status=${res.status})`);
        } catch (e) {
            if (method === 'GET') throw e;
        }
    }
    throw new Error('重定向解析失败');
}

async function fetchLatestReleaseData() {
    const apiUrls = withGithubMirrors(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
    let lastErr = null;
    for (const url of apiUrls) {
        try {
            const data = await httpsGetJson(url);
            if (data && data.tag_name) return { data, source: url };
        } catch (e) {
            lastErr = e;
            console.error('[UpdateCheck] API 失败:', url, e.message);
        }
    }

    const pageUrls = withGithubMirrors(`https://github.com/${UPDATE_REPO}/releases/latest`);
    for (const url of pageUrls) {
        try {
            const tag = await getLatestVersionFromRedirect(url);
            if (tag) return { data: null, redirectTag: tag, source: url };
        } catch (e) {
            lastErr = e;
            console.error('[UpdateCheck] 重定向失败:', url, e.message);
        }
    }

    const err = lastErr || new Error('所有更新通道均失败');
    throw err;
}

// 1. 检查更新
ipcMain.handle('check-update', async (event, isManual) => {
    const currentVersion = app.getVersion();

    try {
        const result = await fetchLatestReleaseData();
        const redirectTag = result.redirectTag || '';
        const data = result.data;
        const latestVersion = (data ? data.tag_name : redirectTag).replace(/^v/i, '');
        const hasUpdate = isNewerVersion(latestVersion, currentVersion);

        let downloadUrl = '';
        let fileName = '';
        let releaseNotes = '';

        if (data) {
            releaseNotes = data.body || '';
            if (Array.isArray(data.assets)) {
                const exeAsset = data.assets.find((asset) => /\.exe$/i.test(asset.name));
                if (exeAsset) {
                    downloadUrl = exeAsset.browser_download_url;
                    fileName = exeAsset.name;
                }
            }
            if (!downloadUrl) downloadUrl = data.html_url || UPDATE_RELEASES_PAGE;
        } else {
            releaseNotes = '已通过镜像通道确认版本号，但未能拉取完整更新日志。可继续尝试应用内升级，或前往 Releases 页面手动下载。';
            fileName = `Nexora Agent.Setup.${latestVersion}.exe`;
            const tag = redirectTag || `v${latestVersion}`;
            downloadUrl = `https://github.com/${UPDATE_REPO}/releases/download/${tag}/${fileName}`;
        }

        return {
            hasUpdate,
            checkFailed: false,
            latestVersion,
            currentVersion,
            releaseNotes,
            downloadUrl,
            fileName
        };
    } catch (err) {
        console.error('[UpdateCheck] 全部通道失败:', err.message);
        // 关键: 探测失败 ≠ 有新版本。绝不能再返回 hasUpdate:true + "未知"
        if (!isManual) {
            throw new Error(`后台自动检查更新失败：${err.message}`);
        }
        return {
            hasUpdate: false,
            checkFailed: true,
            latestVersion: '',
            currentVersion,
            releaseNotes: '',
            downloadUrl: UPDATE_RELEASES_PAGE,
            fileName: '',
            message: `无法连接更新服务器（${err.message}）。可点击「打开 Releases 页面」手动检查。`
        };
    }
});

// 2. 开始下载更新
ipcMain.handle('start-download-update', async (event, { downloadUrl, fileName }) => {
    const fs = require('fs');
    const path = require('path');
    const https = require('https');
    const http = require('http');
    const { URL } = require('url');

    if (!downloadUrl) return { success: false, message: '无效的下载链接' };
    // Releases 页面不是安装包，交给前端打开浏览器
    if (!/\.exe($|\?)/i.test(downloadUrl) && !/\/releases\/download\//i.test(downloadUrl)) {
        return { success: false, message: '当前链接不是可下载的安装包，请前往 Releases 页面手动下载' };
    }

    const candidateUrls = [];
    const pushUnique = (u) => { if (u && !candidateUrls.includes(u)) candidateUrls.push(u); };
    if (downloadUrl.startsWith('https://github.com')) {
        pushUnique('https://ghproxy.net/' + downloadUrl);
        pushUnique('https://mirror.ghproxy.com/' + downloadUrl);
        pushUnique('https://gh.ddlc.top/' + downloadUrl);
    }
    pushUnique(downloadUrl);

    const tempDir = app.getPath('temp');
    const savePath = path.join(tempDir, fileName || 'NexoraAgent-Setup-Latest.exe');

    const downloadOnce = (url) => new Promise((resolve, reject) => {
        let receivedBytes = 0;
        let totalBytes = 0;
        let settled = false;
        let redirectsLeft = 8;
        const fileStream = fs.createWriteStream(savePath);

        const fail = (msg) => {
            if (settled) return;
            settled = true;
            try { fileStream.close(); } catch (e) {}
            try { fs.unlinkSync(savePath); } catch (e) {}
            reject(new Error(msg));
        };

        const succeed = () => {
            if (settled) return;
            settled = true;
            fileStream.end();
            resolve({ success: true, savePath });
        };

        const streamDownload = (currentUrl) => {
            let parsed;
            try { parsed = new URL(currentUrl); }
            catch (e) { return fail(e.message); }
            const lib = parsed.protocol === 'http:' ? http : https;
            const req = lib.get({
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
                path: parsed.pathname + parsed.search,
                headers: { 'User-Agent': 'NexoraAgent-Updater' },
                timeout: 30000,
                rejectUnauthorized: false
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft-- > 0) {
                    res.resume();
                    let next = res.headers.location;
                    if (!next.startsWith('http')) next = `${parsed.protocol}//${parsed.host}${next}`;
                    return streamDownload(next);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return fail(`下载失败，状态码: ${res.statusCode}`);
                }
                totalBytes = parseInt(res.headers['content-length'], 10) || 0;
                res.on('data', (chunk) => {
                    receivedBytes += chunk.length;
                    fileStream.write(chunk);
                    if (totalBytes > 0 && mainWindow && !mainWindow.isDestroyed()) {
                        const progress = Math.round((receivedBytes / totalBytes) * 100);
                        mainWindow.webContents.send('download-progress', progress);
                    }
                });
                res.on('end', succeed);
                res.on('error', (err) => fail(`下载数据流出错: ${err.message}`));
            });
            req.on('error', (err) => fail(`请求出错: ${err.message}`));
            req.on('timeout', () => {
                req.destroy();
                fail('下载请求超时');
            });
        };

        streamDownload(url);
    });

    let lastError = null;
    for (const url of candidateUrls) {
        try {
            if (fs.existsSync(savePath)) {
                try { fs.unlinkSync(savePath); } catch (e) {}
            }
            return await downloadOnce(url);
        } catch (e) {
            lastError = e;
            console.error('[UpdateDownload] 通道失败:', url, e.message);
        }
    }
    return { success: false, message: lastError ? lastError.message : '所有下载通道均失败' };
});

// 3. 执行覆盖安装
ipcMain.handle('install-update', async (event, savePath) => {
    const { shell } = require('electron');
    const fs = require('fs');
    if (!savePath || !fs.existsSync(savePath)) {
        return { success: false, message: '未找到安装包文件' };
    }
    
    // 使用 Electron shell 安全拉起安装程序（完美支持 .exe, .msi, .dmg 等各种格式）
    try {
        await shell.openPath(savePath);
        app.quit();
        return { success: true };
    } catch (err) {
        console.error('无法启动安装程序:', err);
        return { success: false, message: `启动安装程序失败: ${err.message}` };
    }
});

// 4. 内置Nexora Agent核心包更新（openclaw npm 包热更新）
ipcMain.handle('update-openclaw-package', async (event, { targetVersion }) => {
    const { execFile } = require('child_process');
    const path = require('path');
    const fs = require('fs');

    const appDir = __dirname;
    const log = (msg) => {
        console.log(`[GatewayUpdate] ${msg}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-update-progress', { message: msg });
        }
    };

    try {
        // 1) 查询 npm 最新版本
        let version = targetVersion;
        if (!version) {
            log('正在查询 npm 最新版本...');
            try {
                const result = await new Promise((resolve, reject) => {
                    execFile('npm', ['view', 'openclaw', 'version', '--json'], {
                        cwd: appDir, shell: true, timeout: 30000
                    }, (err, stdout) => {
                        if (err) return reject(err);
                        try { resolve(JSON.parse(stdout.trim())); }
                        catch (e) { resolve(stdout.trim().replace(/"/g, '')); }
                    });
                });
                version = String(result);
            } catch (e) {
                log('查询版本失败，将使用 latest 标签');
                version = 'latest';
            }
        }
        log(`目标版本: openclaw@${version}`);

        // 2) 检查 Node.js 运行时兼容性（从 npm 查引擎约束），决定是否需要自动升级内置 Node
        log('正在检查 Node.js 运行时兼容性...');
        let nodeUpgrade = null; // { targetVersion } 需要升级时填充
        try {
            const engineInfo = await new Promise((resolve) => {
                execFile('npm', ['view', `openclaw@${version}`, 'engines.node', '--json'], {
                    cwd: appDir, shell: true, timeout: 15000
                }, (err, stdout) => {
                    if (err) return resolve(null);
                    try { resolve(JSON.parse(stdout.trim())); }
                    catch (e) { resolve(stdout.trim().replace(/"/g, '')); }
                });
            });

            if (engineInfo) {
                const engineRange = String(engineInfo);
                // 读取当前内置沙箱 Node 版本（不存在或系统 Node 也一并纳入判断）
                let currentNodeVer = null;
                const nodeExePath = getAvailableNodePath();
                if (nodeExePath) {
                    try { currentNodeVer = require('child_process').execSync(`"${nodeExePath}" -v`, { encoding: 'utf8', timeout: 10000 }).trim().replace(/^v/, ''); } catch (e) {}
                }
                log(`当前 Node: ${currentNodeVer ? 'v' + currentNodeVer : '未安装'} | 新版要求: ${engineRange}`);

                const compatible = currentNodeVer && satisfiesNodeRange(currentNodeVer, engineRange);
                if (compatible) {
                    log('内置 Node 版本兼容，无需升级');
                } else {
                    log('内置 Node 不满足新版要求，正在为您匹配可用版本...');
                    const currentMajor = currentNodeVer ? parseInt(currentNodeVer.split('.')[0], 10) : 0;
                    const target = await resolveBestNodeVersion(engineRange, currentMajor);
                    if (target) {
                        nodeUpgrade = { targetVersion: target };
                        log(`将自动升级内置 Node → v${target}`);
                    } else {
                        log('未找到满足要求的 Node 版本，将跳过 Node 自动升级');
                    }
                }
            }
        } catch (e) {
            log('兼容性检查跳过: ' + e.message);
        }

        // 3) 停止Nexora Agent（同时释放 node.exe 文件句柄，便于随后替换）
        log('正在停止Nexora Agent...');
        stopGatewayProcess();
        gatewayProcess = null;
        await new Promise(r => setTimeout(r, 1500));

        // 3.5) 如需升级内置 Node 运行时，下载并替换 .node-sandbox/node.exe
        if (nodeUpgrade) {
            try {
                log(`正在下载 Node v${nodeUpgrade.targetVersion} 运行时...`);
                let lastPct = -1;
                await downloadAndInstallSandboxNode(nodeUpgrade.targetVersion, (received, total) => {
                    if (total > 0) {
                        const pct = Math.floor((received / total) * 100);
                        if (pct >= lastPct + 10 || pct === 100) {
                            lastPct = pct;
                            const mb = (received / 1048576).toFixed(1);
                            const totalMb = (total / 1048576).toFixed(1);
                            log(`Node 下载中 ${pct}% (${mb} MB / ${totalMb} MB)`);
                        }
                    }
                });
                log(`内置 Node 运行时已升级到 v${nodeUpgrade.targetVersion}`);
            } catch (e) {
                // Node 升级失败不阻断 openclaw 安装，但要明确告知（否则新核心可能无法启动）
                log(`Node 自动升级失败: ${e.message}（将继续安装核心，如无法启动请手动升级 Node）`);
            }
        }

        // 4) 执行 npm install
        log(`正在安装 openclaw@${version}，请稍候...`);
        const installResult = await new Promise((resolve, reject) => {
            const npmArgs = ['install', `openclaw@${version}`, '--save', '--save-exact'];
            const child = execFile('npm', npmArgs, {
                cwd: appDir,
                shell: true,
                timeout: 120000,
                env: { ...process.env }
            }, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(`npm install 失败: ${err.message}\n${stderr || ''}`));
                } else {
                    resolve(stdout);
                }
            });

            // 实时输出安装日志
            if (child.stdout) child.stdout.on('data', (d) => log(d.toString().trim()));
            if (child.stderr) child.stderr.on('data', (d) => {
                const text = d.toString().trim();
                if (text && !text.startsWith('npm warn')) log(text);
            });
        });
        log('npm install 完成');

        // 5) 验证新版本是否安装成功
        let installedVersion = '未知';
        try {
            const pkgPath = path.join(appDir, 'node_modules', 'openclaw', 'package.json');
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                installedVersion = pkg.version || '未知';
            }
        } catch (e) {}
        log(`已安装版本: openclaw@${installedVersion}`);

        // 6) 同步锁定 package.json 中的版本号
        try {
            const appPkgPath = path.join(appDir, 'package.json');
            const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));
            if (appPkg.dependencies && appPkg.dependencies.openclaw) {
                appPkg.dependencies.openclaw = installedVersion;
                fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + '\n', 'utf8');
                log('package.json 版本已锁定');
            }
        } catch (e) {
            log('锁定 package.json 版本失败（非致命）: ' + e.message);
        }

        // 7) 自动重启Nexora Agent（直接在主进程内拉起并校验，避免 IPC 往返 + 端口/文件句柄未释放导致的重启失败）
        log('正在重启Nexora Agent...');

        // 确保上一实例已被彻底回收：Windows 释放 18789 端口与 node_modules 文件句柄需要更充裕的时间
        gatewayProcess = null;
        await new Promise(r => setTimeout(r, 2000));

        let restarted = false;
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                startGatewayProcess();
            } catch (e) {
                log(`启动尝试 ${attempt}/${maxAttempts} 异常: ${e.message}`);
            }
            // 等待Nexora Agent进程真正就绪（若入口缺失或崩溃，exit 回调会把 gatewayProcess 复位为 null）
            await new Promise(r => setTimeout(r, 2500));
            if (gatewayProcess) { restarted = true; break; }
            if (attempt < maxAttempts) {
                log(`Nexora Agent尚未就绪，正在重试 (${attempt}/${maxAttempts})...`);
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        if (restarted) {
            log('Nexora Agent已重启成功');
        } else {
            log('Nexora Agent自动重启失败，请手动点击右侧「启动Nexora Agent」按钮');
            // 兜底：再通过渲染层触发一次，双保险
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('gateway-control-trigger', 'start');
            }
        }

        return {
            success: true,
            installedVersion,
            restarted,
            message: restarted
                ? `Nexora Agent核心已成功更新到 openclaw@${installedVersion}，Nexora Agent已重启完成。`
                : `Nexora Agent核心已更新到 openclaw@${installedVersion}，但自动重启失败，请手动点击「启动Nexora Agent」。`
        };

    } catch (err) {
        console.error('[GatewayUpdate] 更新失败:', err);
        return {
            success: false,
            message: `更新失败: ${err.message}`
        };
    }
});

// 初始化应用
app.whenReady().then(async () => {
    // 家目录矫正：优先真实用户目录；不可写时改走 AppData\NexoraAgent，禁止落到裸 Temp
    try {
        // 保留改写前的真实用户目录，供鉴权双目录同步 / 排障
        if (!process.env.NEXORA_AGENT_ORIGINAL_USERPROFILE) {
            process.env.NEXORA_AGENT_ORIGINAL_USERPROFILE =
                process.env.USERPROFILE || process.env.HOME || app.getPath('home') || '';
        }
        let preferredHome = app.getPath('home');
        const desktopInfo = detectRestrictedDesktop(process.env);
        const preferredWritable = preferredHome ? probeOpenClawHomeWritable(preferredHome) : false;

        // 旧版本可能已经把 USERPROFILE 指到 Temp\1；本次启动强制纠正
        const envHome = process.env.REAL_USER_HOME || process.env.USERPROFILE || preferredHome;
        const mustLeaveTemp = isTempLikePath(envHome) || isTempLikePath(CONFIG_DIR);

        let homePath = preferredHome;
        let health = null;
        if (!preferredWritable || mustLeaveTemp || desktopInfo.restricted) {
            const resolved = resolveStableOpenClawHome(preferredWritable && !mustLeaveTemp ? preferredHome : null);
            homePath = resolved.homePath;
            health = resolved.health;
            console.warn(
                `[System] OpenClaw home redirected for stability. preferredWritable=${preferredWritable} mustLeaveTemp=${mustLeaveTemp} cloudHints=${(resolved.desktopHints || []).join(',') || 'none'} health=${health && health.level} -> ${homePath}`
            );
            if (envHome && homePath && envHome !== homePath) {
                migrateOpenClawDataIfNeeded(envHome, homePath);
            } else if (preferredHome && homePath && preferredHome !== homePath) {
                migrateOpenClawDataIfNeeded(preferredHome, homePath);
            }
        } else {
            const resolvedOk = resolveStableOpenClawHome(preferredHome);
            health = resolvedOk.health;
            homePath = preferredHome;
        }

        applyResolvedOpenClawHome(homePath);
        try {
            writeHomeHealthMarker(CONFIG_DIR, health || { level: 'ok', code: 'OK' }, {
                homePath,
                desktopHints: desktopInfo.hints
            });
        } catch (e) {}
        console.log(`[System] Final resolved user home: ${homePath}`);
        console.log(`[System] OPENCLAW_HOME=${process.env.OPENCLAW_HOME}`);
        console.log(`[System] OPENCLAW_STATE_DIR=${process.env.OPENCLAW_STATE_DIR}`);
        console.log(`[System] OpenClaw config dir: ${CONFIG_DIR}`);
        if (desktopInfo.hints.length) {
            console.log(`[System] Desktop environment hints: ${desktopInfo.hints.join(', ')}`);
        }
        if (isTempLikePath(homePath) || (health && health.level !== 'ok')) {
            // createWindow 之后再弹，这里先挂到 next tick 链
            setImmediate(() => warnStorageHealthIfNeeded(health || {
                level: 'critical',
                code: 'TEMP_HOME',
                title: '数据目录落在临时文件夹',
                message: `检测到数据目录位于临时路径：\n${homePath}`,
                actions: ['将 Nexora Agent 加入受控文件夹访问排除项', '重启 Nexora Agent']
            }, homePath));
        }
    } catch (err) {
        console.error('[System] Failed to resolve true user home:', err.message);
    }

    // 打包态：异步解压 gateway-runtime.zip（切勿 spawnSync，否则窗口「未响应」）
    let bootSplash = null;
    let heartbeat = null;
    try {
        let packaged = false;
        try { packaged = !!app.isPackaged; } catch (e) { packaged = false; }
        if (packaged) {
            bootSplash = createSplashWindow();
            updateSplashStatus(bootSplash, '正在准备 OpenClaw 运行时…', 5);
            let tick = 8;
            heartbeat = setInterval(() => {
                tick = Math.min(72, tick + 1.5);
                updateSplashStatus(bootSplash, '正在解压运行时（首次启动，请稍候）…', Math.floor(tick));
            }, 700);
        }
        const runtimeInfo = await ensureGatewayRuntime(app, {
            onProgress: (p) => {
                updateSplashStatus(bootSplash, (p && p.message) || '', p && p.percent);
            }
        });
        console.log(
            `[GatewayRuntime] mode=${runtimeInfo && runtimeInfo.mode} extracted=${runtimeInfo && runtimeInfo.extracted} root=${runtimeInfo && runtimeInfo.root}`
        );
        try {
            if (runtimeInfo && runtimeInfo.root) {
                deployRuntimeArtifacts();
                try {
                    const deployedHarden = path.join(process.env.NEXORA_AGENT_RUNTIME_DIR || '', 'gateway-boot-harden.js');
                    if (deployedHarden && fs.existsSync(deployedHarden)) {
                        const bootHarden = require(deployedHarden);
                        softenOpenClawStartupMigrationGuard = bootHarden.softenOpenClawStartupMigrationGuard;
                        ensureSandboxNpmPresent = bootHarden.ensureSandboxNpmPresent;
                        hardenGatewayBootAgainstPluginNpm = bootHarden.hardenGatewayBootAgainstPluginNpm;
                    }
                } catch (e) {}
                const soft = softenOpenClawStartupMigrationGuard(runtimeInfo.root);
                const npm = ensureSandboxNpmPresent(runtimeInfo.root, __dirname);
                let tpl = { ok: false };
                try {
                    if (typeof require('./gateway-boot-harden').ensureOpenClawWorkspaceTemplates === 'function') {
                        tpl = require('./gateway-boot-harden').ensureOpenClawWorkspaceTemplates(runtimeInfo.root, [
                            path.join(__dirname, 'config', 'openclaw-templates'),
                            path.join(runtimeInfo.root, 'config', 'openclaw-templates')
                        ]);
                    }
                } catch (e) {}
                console.log(`[GatewayBoot] post-extract soft=${JSON.stringify(soft)} npm=${JSON.stringify(npm)} templates=${JSON.stringify(tpl)}`);
            }
        } catch (e) {
            console.warn('[GatewayBoot] post-extract harden:', e.message);
        }
        if (runtimeInfo && runtimeInfo.extracted) {
            updateSplashStatus(bootSplash, '运行时就绪，正在启动…', 100);
        }
    } catch (err) {
        console.error('[GatewayRuntime] ensure failed:', err);
        try {
            dialog.showErrorBox(
                'OpenClaw 运行时未就绪',
                `无法解压或定位网关运行时。\n\n${err && err.message ? err.message : err}\n\n请重新安装 Nexora Agent，或联系支持。`
            );
        } catch (e) {}
    } finally {
        if (heartbeat) {
            try { clearInterval(heartbeat); } catch (e) {}
        }
    }

    // 先出窗口再种插件，避免首启同步拷贝把 UI 卡死
    createWindow(bootSplash);
    createTray();
    setImmediate(() => {
        try { seedBundledPlugins(); } catch (e) {}
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
