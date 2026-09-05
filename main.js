// main.js - Electron 主进程入口
const clientBootStartedAt = Date.now();
function markClientBootPhase(phase) {
    const elapsedMs = Date.now() - clientBootStartedAt;
    setImmediate(() => appendMainDiagnostic('client-start-phase', null, { phase, elapsedMs }));
}
// [FIX] 清理外部 NODE_OPTIONS 污染，防止 --require 等参数干扰 Electron 主进程启动
// 打包后的应用不应依赖任何外部 NODE_OPTIONS 设置
delete process.env.NODE_OPTIONS;
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, session, dialog, clipboard, protocol, crashReporter, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { fileURLToPath } = require('url');
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
const { ensureVisionModelConfig } = require('./vision-model-config');
const { sanitizeQqbotConfig } = require('./channel-config-sanitize');
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
    isAllowedLoopbackHttpUrl,
    syncGatewayAuthToStateDirs,
    buildGatewayChildEnv
} = require('./gateway-auth');
const { syncModelConfigToStateDirs } = require('./openclaw-model-sync');
const {
    normalizeConfigRouting,
    omitBlankProviderApiKeys,
    BUILTIN_ALLOWED_PROVIDERS
} = require('./model-config-policy');
const {
    getConfiguredAgnesApiKey,
    ensureAgnesAuthProfileConfig,
    syncAgnesAuthProfileToState
} = require('./openclaw-auth-sync');
const {
    getGatewayRuntimeRoot,
    ensureGatewayRuntime
} = require('./gateway-runtime');
const {
    OFFICIAL_NPM_REGISTRY,
    normalizeVersion: normalizeOpenClawVersion,
    isStableVersion: isStableOpenClawVersion,
    resolveStableTarget,
    normalizeIntegrity,
    buildGatewayRuntimeManifest
} = require('./openclaw-update-policy');
const acceleration = require('./acceleration');
const roleConfig = require('./role-config');
const { voiceRuntime } = require('./voice-runtime');
const { startGoogleLogin, cancelGoogleLogin, uploadConfigToDrive, downloadConfigFromDrive, refreshAccessToken } = require('./google-login');
const { createSkillCenter } = require('./skill-center');
const { ClientSettingsStore, isSafeRendererSettingKey } = require('./client-settings-store');

let clientSettingsStore = null;
function getClientSettingsStore() {
    if (clientSettingsStore) return clientSettingsStore;
    const dbPath = path.join(app.getPath('userData'), 'client-settings.sqlite');
    clientSettingsStore = new ClientSettingsStore(dbPath);
    return clientSettingsStore;
}

function readClientSystemSetting(key, fallback = undefined) {
    try { return getClientSettingsStore().get('system', key, fallback); } catch (e) {
        console.warn('[ClientSettings] read system setting failed:', key, e && e.message);
        return fallback;
    }
}

function writeClientSystemSetting(key, value) {
    try { return getClientSettingsStore().set('system', key, value); } catch (e) {
        console.warn('[ClientSettings] write system setting failed:', key, e && e.message);
        return value;
    }
}

function seedClientSystemSetting(key, value) {
    try { getClientSettingsStore().setIfAbsent('system', key, value); } catch (e) {
        console.warn('[ClientSettings] migrate system setting failed:', key, e && e.message);
    }
    return readClientSystemSetting(key, value);
}

/** 技能中心（延迟绑定 CONFIG_DIR，避免启动期 TDZ） */
let skillCenterApi = null;
function getSkillCenter() {
    if (skillCenterApi) return skillCenterApi;
    skillCenterApi = createSkillCenter({
        getConfigDir: () => CONFIG_DIR,
        getConfigPath: () => CONFIG_PATH,
        resolveNode: () => getAvailableNodePath() || 'node',
        resolveOpenClawCli: () => {
            const roots = [
                getGatewayRuntimeRoot(app),
                __dirname,
                process.env.LOCALAPPDATA
                    ? path.join(process.env.LOCALAPPDATA, 'NexoraAgent', 'gateway-runtime')
                    : null
            ].filter(Boolean);
            for (const root of roots) {
                const p = path.join(root, 'node_modules', 'openclaw', 'openclaw.mjs');
                if (fs.existsSync(p)) return p;
            }
            return null;
        }
    });
    return skillCenterApi;
}

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

function appendMainDiagnostic(kind, error, details = {}) {
    try {
        const logPath = safeMainErrorLogPath();
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        try {
            const stat = fs.statSync(logPath);
            if (stat.size > 4 * 1024 * 1024) {
                const previous = `${logPath}.previous`;
                try { if (fs.existsSync(previous)) fs.unlinkSync(previous); } catch (_) {}
                try { fs.renameSync(logPath, previous); } catch (_) {
                    try { fs.writeFileSync(logPath, '', 'utf8'); } catch (__) {}
                }
            }
        } catch (_) {}
        const memory = (() => {
            try { return process.memoryUsage(); } catch (_) { return null; }
        })();
        const record = {
            time: new Date().toISOString(),
            kind,
            pid: process.pid,
            memory,
            details,
            error: error
                ? String(error.stack || error.message || error)
                : null
        };
        fs.appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8');
    } catch (_) {}
}

try {
    crashReporter.start({
        productName: 'Nexora Agent',
        companyName: 'Nexora Agent',
        submitURL: 'https://localhost.invalid/nexora-crash',
        uploadToServer: false,
        compress: false,
        ignoreSystemCrashHandler: false
    });
} catch (_) {}

/**
 * 同步应急网络清理：崩溃/硬退出时(绕过 will-quit)必须做的两件事——
 * 1) 若开过系统代理，清掉注册表代理开关，否则浏览器等全部走向已死端口 = 整机网络黑洞；
 * 2) 杀掉可能残留的 mihomo 内核(含测速临时核)，避免占端口。
 * 只用同步操作(process 'exit' 只允许同步)，且仅在确实用过加速时执行。
 */
let __nexoraAccelUsed = false; // 标记是否启用过加速/系统代理，避免误清用户自己设的代理
function emergencyNetworkCleanupSync() {
    if (!__nexoraAccelUsed) return;
    try {
        const st = (() => { try { return acceleration.getStatus(); } catch (_) { return null; } })();
        if (!st || st.systemProxy) {
            require('child_process').execSync(
                'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f',
                { windowsHide: true, timeout: 4000, stdio: 'ignore' }
            );
        }
    } catch (_) {}
    try {
        require('child_process').execSync('taskkill /F /IM mihomo.exe /T', { windowsHide: true, timeout: 4000, stdio: 'ignore' });
    } catch (_) {}
}

process.on('exit', () => { emergencyNetworkCleanupSync(); });

// 从终端、自动化工具或父进程启动时，父进程可能先关闭 stdout/stderr。
// Node 的 Socket 默认没有 error 监听，后续任意 console.log 都会把 EPIPE
// 抛成 uncaughtException，并形成高 CPU 的“记录异常 -> 再输出 -> 再异常”循环。
for (const [name, stream] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
    if (!stream || typeof stream.on !== 'function') continue;
    stream.on('error', (error) => {
        if (error && error.code === 'EPIPE') return;
        appendMainDiagnostic(`${name}-stream-error`, error);
    });
}

process.on('uncaughtException', (err) => {
    appendMainDiagnostic('uncaughtException', err);
    emergencyNetworkCleanupSync();
});
process.on('unhandledRejection', (reason) => {
    appendMainDiagnostic('unhandledRejection', reason);
});

// 默认保留硬件加速。强制软件合成会让 Chromium 的 GPU 进程长期吃满一个 CPU 核，
// 页面动画/Canvas 较多时反而更容易出现“卡死”。仅在显卡驱动确有问题时显式降级。
const forceSoftwareRendering = process.argv.includes('--nexora-software-rendering')
    || /^(1|true|yes)$/i.test(String(process.env.NEXORA_DISABLE_GPU || ''));
if (process.platform === 'win32' && forceSoftwareRendering) {
    app.disableHardwareAcceleration();
}

app.on('render-process-gone', (event, webContents, details) => {
    appendMainDiagnostic('render-process-gone', null, details || {});
});
app.on('child-process-gone', (event, details) => {
    appendMainDiagnostic('child-process-gone', null, details || {});
    if (details && details.type === 'GPU') {
        setTimeout(() => {
            try {
                if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
            } catch (_) {}
        }, 500);
    }
});
app.on('gpu-process-crashed', (event, killed) => {
    appendMainDiagnostic('gpu-process-crashed', null, { killed: !!killed });
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
    const isWin = process.platform === 'win32';
    const sandboxName = isWin ? 'node.exe' : 'node';
    let runtimeRoot = null;
    try { runtimeRoot = getGatewayRuntimeRoot(app); } catch (e) {}

    const candidates = [
        resolveAppFsPath('.node-sandbox', sandboxName),
        runtimeRoot ? path.join(runtimeRoot, '.node-sandbox', sandboxName) : null,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'NexoraAgent', 'gateway-runtime', '.node-sandbox', sandboxName) : null,
    ].filter(Boolean);

    for (const sandboxPath of candidates) {
        if (fs.existsSync(sandboxPath)) {
            try {
                // 检查内置 node 是否真的能运行（防范缺少 VC++ 运行时库或被安全组策略拦截）
                const check = require('child_process').execFileSync(sandboxPath, ['-v'], { encoding: 'utf8', timeout: 1000 }).trim();
                const match = check.match(/^v(\d+)\.(\d+)\.(\d+)/);
                const major = match ? parseInt(match[1], 10) : 0;
                const minor = match ? parseInt(match[2], 10) : 0;
                const patch = match ? parseInt(match[3], 10) : 0;
                if (major > 24 || (major === 24 && (minor > 15 || (minor === 15 && patch >= 0))) || (major === 22 && minor >= 22) || major >= 25) {
                    return sandboxPath;
                }
            } catch (e) {
                console.warn(`[NodeSandbox] 内置 Node 存在但无法运行 (${sandboxPath}): ${e.message}`);
            }
        }
    }
    
    // 如果内置沙箱不存在或无法运行，尝试获取系统全局 Node 绝对路径
    try {
        const cmd = isWin ? 'where node' : 'which node';
        const sep = isWin ? '\r\n' : '\n';
        const which = require('child_process').execSync(cmd, { encoding: 'utf8' }).trim().split(sep)[0];
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

function execSqliteStatementsWithSandbox(sqlitePath, statements) {
    if (!sqlitePath || !fs.existsSync(sqlitePath)) return false;
    const nodeExePath = getAvailableNodePath();
    if (!nodeExePath) throw new Error('no Node runtime with node:sqlite available');
    const list = Array.isArray(statements) ? statements.filter(Boolean) : [statements].filter(Boolean);
    if (!list.length) return false;
    const code = `
        const { DatabaseSync } = require('node:sqlite');
        const sqlitePath = process.argv[1];
        const statements = JSON.parse(process.argv[2] || '[]');
        const db = new DatabaseSync(sqlitePath);
        try {
            for (const sql of statements) {
                if (typeof sql !== 'string' || !sql.trim()) continue;
                try {
                    db.exec(sql);
                } catch (_) {}
            }
        } finally {
            db.close();
        }
    `;
    require('child_process').execFileSync(nodeExePath, ['-e', code, sqlitePath, JSON.stringify(list)], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
    });
    return true;
}



function resolveBundledNpmCliPath() {
    const candidates = [];
    const push = (value) => {
        if (!value) return;
        if (!candidates.includes(value)) candidates.push(value);
    };

    push(resolveAppFsPath('.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    push(path.join(__dirname, '.node-sandbox', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    push(path.join(__dirname, 'node_modules', 'npm', 'bin', 'npm-cli.js'));

    const nodePath = getAvailableNodePath();
    if (nodePath) {
        const nodeDir = path.dirname(nodePath);
        push(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
        push(path.join(path.dirname(nodeDir), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }

    const pathEntries = String(process.env.Path || process.env.PATH || '')
        .split(path.delimiter)
        .filter(Boolean);
    for (const entry of pathEntries) {
        push(path.join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
        push(path.join(path.dirname(entry), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch (e) {}
    }
    return null;
}

function buildNpmUpdateEnv() {
    const env = { ...process.env };
    const winDir = env.SystemRoot || env.WINDIR || 'C:\\Windows';
    env.SystemRoot = winDir;
    env.WINDIR = winDir;
    env.ComSpec = env.ComSpec && fs.existsSync(env.ComSpec)
        ? env.ComSpec
        : path.join(winDir, 'System32', 'cmd.exe');

    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const additions = [
        resolveAppFsPath('.node-sandbox'),
        path.dirname(getAvailableNodePath() || ''),
        path.join(winDir, 'System32'),
        winDir,
        path.join(winDir, 'System32', 'WindowsPowerShell', 'v1.0'),
    ].filter(Boolean);
    const existing = env[pathKey] || env.PATH || env.Path || '';
    env[pathKey] = [...additions, existing].filter(Boolean).join(path.delimiter);
    env.PATH = env[pathKey];
    return env;
}

function resolveNpmUpdateRunner() {
    try {
        ensureSandboxNpmPresent(resolveAppFsRoot(), __dirname);
    } catch (e) {}

    const nodePath = getAvailableNodePath();
    const npmCli = resolveBundledNpmCliPath();
    if (nodePath && npmCli) {
        return {
            command: nodePath,
            prefixArgs: [npmCli],
            nodePath,
            npmCli,
            via: 'bundled-node-npm-cli'
        };
    }

    throw new Error('No bundled npm runtime available. node=' + (nodePath || 'missing') + ' npmCli=' + (npmCli || 'missing'));
}

function runNpmUpdateCommand(args, opts = {}) {
    const { spawn } = require('child_process');
    const runner = resolveNpmUpdateRunner();
    const timeoutMs = opts.timeout || 30000;
    return new Promise((resolve, reject) => {
        const child = spawn(runner.command, [...runner.prefixArgs, ...args], {
            cwd: opts.cwd || __dirname,
            shell: false,
            windowsHide: true,
            env: buildNpmUpdateEnv()
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (fn) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const timer = setTimeout(() => {
            try { child.kill(); } catch (e) {}
            finish(() => reject(new Error('npm command timed out: ' + args.join(' '))));
        }, timeoutMs);

        child.stdout?.on('data', (d) => {
            const text = d.toString();
            stdout += text;
            opts.onStdout?.(text);
        });
        child.stderr?.on('data', (d) => {
            const text = d.toString();
            stderr += text;
            opts.onStderr?.(text);
        });
        child.on('error', (err) => finish(() => reject(new Error(
            'npm command failed to start: ' + err.message
            + ' | runner=' + runner.via
            + ' | node=' + runner.nodePath
            + ' | npmCli=' + runner.npmCli
        ))));
        child.on('close', (code) => finish(() => {
            if (code === 0) resolve(stdout);
            else reject(new Error(
                'npm command failed: exit ' + code
                + ' | runner=' + runner.via
                + ' | node=' + runner.nodePath
                + ' | npmCli=' + runner.npmCli
                + '\n' + (stderr || stdout)
            ));
        }));
    });
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
    if (process.platform !== 'win32') {
        console.log('[SandboxCheck] 非 Windows 平台，跳过内置 Node 沙箱检测与升级。');
        return;
    }
    const sandboxDir = resolveAppFsPath('.node-sandbox');
    const nodeExePath = path.join(sandboxDir, 'node.exe');

    // A compliant bundled Node does not change during one app lifetime. Avoid
    // spawning a child process on every manual/channel restart while still
    // invalidating the cache when the executable is replaced.
    let nodeProbeKey = 'missing';
    try {
        if (fs.existsSync(nodeExePath)) {
            const st = fs.statSync(nodeExePath);
            nodeProbeKey = `${st.size}:${st.mtimeMs}`;
        }
    } catch (_) {}
    if (global.__nexoraSandboxNodeHealthyKey === nodeProbeKey && nodeProbeKey !== 'missing') {
        return;
    }
    
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
        global.__nexoraSandboxNodeHealthyKey = nodeProbeKey;
        console.log(`[SandboxCheck] Sandbox Node version ${currentVersion} and SQLite ${currentSqlite} are compliant. No upgrade needed.`);
        return;
    }
    
    console.warn(`[SandboxCheck] Mismatch detected. Current node: ${currentVersion}, SQLite: ${currentSqlite}. Starting self-healing sandbox upgrade...`);
    
    if (mainWindow) {
        mainWindow.webContents.send('gateway-status', 'upgrading');
        mainWindow.webContents.send('gateway-log', `[System] 检测到内置沙箱环境 (Node: ${currentVersion}, SQLite: ${currentSqlite}) 不适用，正在启动自动环境自愈升级...\n`);
    }
    
    const targetVersion = '24.15.0';
    const arch = process.arch === 'arm64' ? 'win-arm64' : (process.arch === 'ia32' ? 'win-x86' : 'win-x64');
    // 打包后 __dirname 在只读 asar / Program Files，临时文件必须落可写目录
    let upgradeTmp;
    try {
        upgradeTmp = path.join(app.getPath('temp'), 'nexora-sandbox-upgrade');
    } catch (e) {
        upgradeTmp = path.join(require('os').tmpdir(), 'nexora-sandbox-upgrade');
    }
    try { fs.mkdirSync(upgradeTmp, { recursive: true }); } catch (e) {}
    const tempZip = path.join(upgradeTmp, `node-v${targetVersion}.zip`);
    const tempExtract = path.join(upgradeTmp, `node-v${targetVersion}-temp`);
    
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
    
    const extractedDir = path.join(tempExtract, `node-v${targetVersion}-${arch}`);
    
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
        exec(`robocopy "${path.join(extractedDir, 'node_modules')}" "${destModules}" /E /NJH /NJS /ndl /nc /ns`, (error) => {
            // robocopy 退出码 <8 都算成功(0=无变化,1=已复制…)，≥8 才是真失败；
            // Node exec 会把任何非零退出都塞进 error，故必须按 error.code 判断
            const code = error && typeof error.code === 'number' ? error.code : 0;
            if (code >= 8) console.warn(`[SandboxHeal] robocopy 复制 node_modules 失败 (exit=${code})，内置 npm 可能不完整`);
            resolve();
        });
    });
    // 复制后校验关键文件到位，避免半残的内置 npm 之后在热更新时才暴露
    try {
        const npmCliCheck = path.join(destModules, 'npm', 'bin', 'npm-cli.js');
        if (!fs.existsSync(npmCliCheck)) console.warn('[SandboxHeal] 复制后仍缺少 npm-cli.js，内置 npm 可能不可用');
    } catch (_) {}
    
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
let gatewayStartInFlight = null;
let gatewayLastStartSource = '';
// 用户在「启动进行中」（gatewayProcess 尚未 fork、gatewayStartInFlight 挂起）时点停止的取消标记：
// 启动流程会在关键节点（尤其 fork 前）检查它，若已请求取消则中止启动，避免停止被静默吞掉。
let gatewayStartCancelRequested = false;
let channelBreakerOverrideTimer = null;
let overflowRolloverTriggerHelper = null;
let gatewayHttpReadyTimer = null;
let gatewayHttpReadyNotified = false;

function getOverflowRolloverTriggerHelper() {
    if (overflowRolloverTriggerHelper) return overflowRolloverTriggerHelper;
    try {
        overflowRolloverTriggerHelper = require('./overflow-rollover-trigger');
    } catch (e) {
        overflowRolloverTriggerHelper = null;
    }
    return overflowRolloverTriggerHelper;
}
/** 意外退出自动拉起：5 分钟内最多 3 次，避免启动失败后只能靠用户重开应用。 */
let gatewayCrashRestartTimer = null;
let gatewayCrashRestartAt = [];
const GATEWAY_CRASH_RESTART_WINDOW_MS = 5 * 60 * 1000;
const GATEWAY_CRASH_RESTART_MAX = 3;
let isQuitting = false;
let isMaximizedState = false;
let normalBounds = null;
const appStartTime = Date.now();
global.latestAcpDashboardUrl = '';

const TRUSTED_RENDERER_ENTRY = path.resolve(__dirname, 'index.html');

function isTrustedRendererIpcEvent(event) {
    try {
        if (!event || !event.sender || !mainWindow || mainWindow.isDestroyed()) return false;
        if (event.sender.id !== mainWindow.webContents.id) return false;
        const senderFrame = event.senderFrame;
        if (!senderFrame || senderFrame !== event.sender.mainFrame) return false;
        const senderUrl = senderFrame.url || event.sender.getURL();
        if (!String(senderUrl || '').startsWith('file:')) return false;
        return path.resolve(fileURLToPath(senderUrl)) === TRUSTED_RENDERER_ENTRY;
    } catch (_) {
        return false;
    }
}

// All renderer-callable IPC channels are privileged. Keep their existing handlers,
// but reject calls from embedded frames/webviews or a navigated main document.
const registerTrustedIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => registerTrustedIpcHandle(channel, (event, ...args) => {
    if (!isTrustedRendererIpcEvent(event)) throw new Error('Blocked untrusted IPC sender');
    return listener(event, ...args);
});

const registerTrustedIpcListener = ipcMain.on.bind(ipcMain);
ipcMain.on = (channel, listener) => registerTrustedIpcListener(channel, (event, ...args) => {
    // Internal main-process emits have no WebContents sender and are not renderer IPC.
    if (!event || !event.sender) return listener(event, ...args);
    if (!isTrustedRendererIpcEvent(event)) {
        try { event.returnValue = null; } catch (_) {}
        return undefined;
    }
    return listener(event, ...args);
});

function stopGatewayHttpReadyWatch() {
    if (gatewayHttpReadyTimer) {
        clearInterval(gatewayHttpReadyTimer);
        gatewayHttpReadyTimer = null;
    }
}

function clearGatewayCrashRestartSchedule() {
    if (gatewayCrashRestartTimer) {
        clearTimeout(gatewayCrashRestartTimer);
        gatewayCrashRestartTimer = null;
    }
}

function resetGatewayCrashRestartBudget() {
    clearGatewayCrashRestartSchedule();
    gatewayCrashRestartAt = [];
}

function scheduleGatewayCrashRestart(exitCode, options = {}) {
    if (isQuitting) return false;
    clearGatewayCrashRestartSchedule();
    const now = Date.now();
    gatewayCrashRestartAt = gatewayCrashRestartAt.filter((at) => now - at < GATEWAY_CRASH_RESTART_WINDOW_MS);
    if (gatewayCrashRestartAt.length >= GATEWAY_CRASH_RESTART_MAX) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
                'gateway-log',
                `\n[System] 核心进程连续异常退出（码 ${exitCode}），已暂停自动重试，请点击左上角手动启动。\n`
            );
            mainWindow.webContents.send('gateway-status', 'stopped');
            try { showNotification('Nexora Agent 启动失败', '核心进程连续异常退出，请检查日志后重试。'); } catch (_) {}
        }
        return false;
    }
    gatewayCrashRestartAt.push(now);
    const attempt = gatewayCrashRestartAt.length;
    const delayMs = Math.min(8000, 1200 * attempt);
    appendMainDiagnostic('gateway-auto-restart-scheduled', null, {
        exitCode,
        attempt,
        delayMs,
        source: gatewayLastStartSource,
    });
    if (mainWindow) {
        mainWindow.webContents.send(
            'gateway-log',
            `\n[System] 核心进程意外退出（码 ${exitCode}），将在 ${Math.ceil(delayMs / 1000)} 秒后自动重试（${attempt}/${GATEWAY_CRASH_RESTART_MAX}）。\n`
        );
        mainWindow.webContents.send('gateway-status', 'starting');
        try {
            showNotification(
                'Nexora Agent 正在恢复',
                `核心进程异常退出，正在自动重试（${attempt}/${GATEWAY_CRASH_RESTART_MAX}）。`
            );
        } catch (e) {}
    }
    gatewayCrashRestartTimer = setTimeout(async () => {
        gatewayCrashRestartTimer = null;
        if (isQuitting || gatewayStartInFlight) return;
        try {
            if (gatewayProcess && options.force) {
                const restartHistory = gatewayCrashRestartAt.slice();
                await stopGatewayProcess({ preserveClash: true });
                // stopGatewayProcess normally resets the retry budget for a user stop;
                // recovery-triggered recycling must keep the bounded crash history.
                gatewayCrashRestartAt = restartHistory;
            }
            if (gatewayProcess) return;
            await withGatewayRestartPermit(() => startGatewayProcess({ source: 'reload' }));
        } catch (e) {
            console.error('[Gateway] automatic crash recovery failed:', e && e.message ? e.message : e);
        }
    }, delayMs);
    return true;
}

function probeGatewayPort(port, timeoutMs = 500) {
    return new Promise((resolve) => {
        const targetPort = Number(port) > 0 ? Number(port) : 18789;
        const socket = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
            try { socket.destroy(); } catch (e) {}
            resolve(true);
        });
        socket.on('error', () => {
            try { socket.destroy(); } catch (e) {}
            resolve(false);
        });
        socket.setTimeout(timeoutMs, () => {
            try { socket.destroy(); } catch (e) {}
            resolve(false);
        });
    });
}

function resolveConfiguredGatewayPort() {
    try {
        const cfgPath = path.join(CONFIG_DIR, 'openclaw.json');
        if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
            if (cfg && cfg.gateway && cfg.gateway.port) return Number(cfg.gateway.port) || 18789;
        }
    } catch (e) {}
    return (global.nexoraInstance && global.nexoraInstance.gatewayPortHint) || 18789;
}

/** 移除 OpenClaw 根 Schema 不接受的扩展字段，防止网关启动/热重载失败 */
function normalizeWebToolsConfig(config) {
    let changed = false;
    if (!config || typeof config !== 'object') return false;
    if (!config.tools || typeof config.tools !== 'object') {
        config.tools = {};
        changed = true;
    }
    if (!config.tools.web || typeof config.tools.web !== 'object') {
        config.tools.web = {};
        changed = true;
    }
    if (!config.tools.web.search || typeof config.tools.web.search !== 'object') {
        config.tools.web.search = {};
        changed = true;
    }
    if (!config.tools.web.fetch || typeof config.tools.web.fetch !== 'object') {
        config.tools.web.fetch = {};
        changed = true;
    }

    if (config.tools.webSearch && typeof config.tools.webSearch === 'object') {
        Object.assign(config.tools.web.search, config.tools.webSearch);
        delete config.tools.webSearch;
        changed = true;
    }
    if (config.tools.webFetch && typeof config.tools.webFetch === 'object') {
        Object.assign(config.tools.web.fetch, config.tools.webFetch);
        delete config.tools.webFetch;
        changed = true;
    }
    // Search must follow the DuckDuckGo plugin switch.  Forcing it on while
    // the provider plugin is disabled produces WEB_SEARCH_PROVIDER_INVALID_AUTODETECT
    // on every gateway start and leaves the UI in a false "available" state.
    const duckEntry = config.plugins && config.plugins.entries && config.plugins.entries.duckduckgo;
    const duckEnabled = Boolean(duckEntry && duckEntry.enabled === true);
    if (config.tools.web.search.enabled !== duckEnabled) {
        config.tools.web.search.enabled = duckEnabled;
        changed = true;
    }
    if (duckEnabled && config.tools.web.search.provider !== 'duckduckgo') {
        config.tools.web.search.provider = 'duckduckgo';
        changed = true;
    } else if (!duckEnabled && config.tools.web.search.provider === 'duckduckgo') {
        // A selected-but-disabled provider still triggers OpenClaw's
        // WEB_SEARCH_PROVIDER_INVALID_AUTODETECT warning during startup.
        delete config.tools.web.search.provider;
        changed = true;
    }
    if (config.tools.web.fetch.enabled !== true) {
        config.tools.web.fetch.enabled = true;
        changed = true;
    }
    return changed;
}

function readProviderUiMetaFile() {
    let meta = {};
    try {
        const p = path.join(CONFIG_DIR, PROVIDER_UI_META_FILE);
        if (fs.existsSync(p)) {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
            if (raw && typeof raw === 'object') meta = { ...raw };
        }
    } catch (e) {}
    try {
        const legacyPath = path.join(CONFIG_DIR, 'provider-labels.json');
        if (fs.existsSync(legacyPath)) {
            const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8').replace(/^\uFEFF/, ''));
            if (legacy && typeof legacy === 'object') {
                for (const [k, v] of Object.entries(legacy)) {
                    const label = typeof v === 'string' ? v.trim() : String((v && v.label) || '').trim();
                    if (!label) continue;
                    meta[k] = { ...(meta[k] || {}), label };
                }
            }
        }
    } catch (e) {}
    return meta;
}

function persistProviderUiMeta(meta) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        const out = meta && typeof meta === 'object' ? meta : {};
        fs.writeFileSync(
            path.join(CONFIG_DIR, PROVIDER_UI_META_FILE),
            JSON.stringify(out, null, 2),
            'utf8'
        );
    } catch (e) {
        console.warn('[ProviderUiMeta] persist failed:', e.message);
    }
}

/**
 * 抽出并移除 models.providers.* 上的 UI 字段（label/displayName/remark），
 * 写入侧车 provider-ui-meta.json，避免 Gateway Schema 报 Unrecognized key。
 */
function extractAndStripProviderUiFields(config, options = {}) {
    const replaceMeta = options.replaceMeta === true;
    let changed = false;
    const providers = config && config.models && config.models.providers;
    if (!providers || typeof providers !== 'object') {
        return { changed: false, meta: readProviderUiMetaFile() };
    }

    let nextMeta = replaceMeta ? {} : { ...readProviderUiMetaFile() };

    // 兼容旧侧车 provider-labels.json（仅 label 字符串映射）
    try {
        const legacyPath = path.join(CONFIG_DIR, 'provider-labels.json');
        if (fs.existsSync(legacyPath)) {
            const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8').replace(/^\uFEFF/, ''));
            if (legacy && typeof legacy === 'object') {
                for (const [k, v] of Object.entries(legacy)) {
                    const label = typeof v === 'string' ? v.trim() : String((v && v.label) || '').trim();
                    if (!label) continue;
                    if (replaceMeta) {
                        // replace 模式下仅在该 provider 仍存在时由下方循环写入
                    } else {
                        nextMeta[k] = { ...(nextMeta[k] || {}), label };
                    }
                }
            }
        }
    } catch (e) {}

    for (const [key, provider] of Object.entries(providers)) {
        if (!provider || typeof provider !== 'object') continue;
        const label = String(provider.label || provider.displayName || '').trim();
        const remark = String(provider.remark || '').trim();
        if (replaceMeta) {
            if (label || remark) {
                nextMeta[key] = {};
                if (label) nextMeta[key].label = label;
                if (remark) nextMeta[key].remark = remark;
            }
        } else if (label || remark) {
            nextMeta[key] = { ...(nextMeta[key] || {}) };
            if (label) nextMeta[key].label = label;
            if (remark) nextMeta[key].remark = remark;
        }
        for (const uk of PROVIDER_UI_ONLY_KEYS) {
            if (Object.prototype.hasOwnProperty.call(provider, uk)) {
                delete provider[uk];
                changed = true;
            }
        }
    }

    if (replaceMeta || changed) {
        persistProviderUiMeta(nextMeta);
    }
    return { changed, meta: nextMeta };
}

/** 读配置时把侧车显示名/备注合回 providers，供面板展示（不写回 openclaw.json） */
function applyProviderUiMetaToConfig(config) {
    if (!config || typeof config !== 'object') return config;
    const meta = readProviderUiMetaFile();
    const providers = config.models && config.models.providers;
    if (!providers || typeof providers !== 'object') return config;
    for (const [key, m] of Object.entries(meta)) {
        if (!m || typeof m !== 'object') continue;
        if (!providers[key] || typeof providers[key] !== 'object') continue;
        if (m.label) providers[key].label = String(m.label);
        if (m.remark) providers[key].remark = String(m.remark);
    }
    return config;
}

function redactBuiltInAgnesCredentials(config) {
    const copy = JSON.parse(JSON.stringify(config || {}));
    const builtInKeys = new Set(BUILTIN_AGNES_API_KEYS);
    const provider = copy.models && copy.models.providers && copy.models.providers['agnes-ai'];
    if (provider && builtInKeys.has(String(provider.apiKey || ''))) provider.apiKey = '';
    if (copy.env && builtInKeys.has(String(copy.env.AGNES_AI_API_KEY || ''))) delete copy.env.AGNES_AI_API_KEY;
    if (copy.env && copy.env.vars && builtInKeys.has(String(copy.env.vars.AGNES_AI_API_KEY || ''))) {
        delete copy.env.vars.AGNES_AI_API_KEY;
        if (Object.keys(copy.env.vars).length === 0) delete copy.env.vars;
        if (Object.keys(copy.env).length === 0) delete copy.env;
    }
    return copy;
}

function stripNonSchemaOpenClawConfig(config, options = {}) {
    let changed = false;
    if (!config || typeof config !== 'object') return false;

    // OpenClaw 2026.9 moved/retired several previously accepted settings.
    // Migrate values that still have a supported equivalent and remove only
    // retired runtime tuning metadata that the new built-in defaults replace.
    if (config.agents && config.agents.defaults) {
        const defaults = config.agents.defaults;
        if (defaults.memorySearch && typeof defaults.memorySearch === 'object') {
            if (!config.memory || typeof config.memory !== 'object') config.memory = {};
            const current = config.memory.search && typeof config.memory.search === 'object'
                ? config.memory.search
                : {};
            config.memory.search = { ...defaults.memorySearch, ...current };
            delete defaults.memorySearch;
            changed = true;
        }
        if (defaults.compaction && typeof defaults.compaction === 'object') {
            for (const key of ['reserveTokensFloor', 'maxHistoryShare', 'maxContextTokens']) {
                if (Object.prototype.hasOwnProperty.call(defaults.compaction, key)) {
                    delete defaults.compaction[key];
                    changed = true;
                }
            }
        }
        if (defaults.contextPruning && typeof defaults.contextPruning === 'object'
            && Object.prototype.hasOwnProperty.call(defaults.contextPruning, 'softTrim')) {
            delete defaults.contextPruning.softTrim;
            changed = true;
        }
    }
    if (config.ui && typeof config.ui === 'object'
        && Object.prototype.hasOwnProperty.call(config.ui, 'assistant')) {
        delete config.ui.assistant;
        changed = true;
    }
    if (config.auth && typeof config.auth === 'object'
        && Object.prototype.hasOwnProperty.call(config.auth, 'cooldowns')) {
        delete config.auth.cooldowns;
        changed = true;
    }
    if (config.diagnostics && typeof config.diagnostics === 'object') {
        for (const key of ['stuckSessionWarnMs', 'stuckSessionAbortMs']) {
            if (Object.prototype.hasOwnProperty.call(config.diagnostics, key)) {
                delete config.diagnostics[key];
                changed = true;
            }
        }
        if (Object.keys(config.diagnostics).length === 0) {
            delete config.diagnostics;
            changed = true;
        }
    }
    if (config.skills && config.skills.workshop && typeof config.skills.workshop === 'object') {
        const autonomous = config.skills.workshop.autonomous;
        if (autonomous && typeof autonomous === 'object'
            && Object.prototype.hasOwnProperty.call(autonomous, 'enabled')) {
            if (!autonomous.mode) autonomous.mode = autonomous.enabled === false ? 'off' : 'auto';
            delete autonomous.enabled;
            changed = true;
        }
    }
    if (config.plugins && typeof config.plugins === 'object') {
        for (const key of ['bundledDiscovery', 'installs']) {
            if (Object.prototype.hasOwnProperty.call(config.plugins, key)) {
                delete config.plugins[key];
                changed = true;
            }
        }
    }
    if (config.tools && config.tools.media && typeof config.tools.media === 'object') {
        const media = config.tools.media;
        const canonical = Array.isArray(media.models) ? media.models.slice() : [];
        for (const capability of ['image', 'audio', 'video']) {
            const section = media[capability];
            if (!section || typeof section !== 'object' || !Array.isArray(section.models)) continue;
            for (const legacy of section.models) {
                if (!legacy || typeof legacy !== 'object') continue;
                const entry = { ...legacy };
                const caps = Array.isArray(entry.capabilities) ? entry.capabilities.map(String) : [];
                entry.capabilities = Array.from(new Set([...caps, capability]));
                const idx = canonical.findIndex((item) => item && typeof item === 'object'
                    && String(item.provider || '') === String(entry.provider || '')
                    && String(item.model || '') === String(entry.model || ''));
                if (idx >= 0) {
                    canonical[idx] = {
                        ...entry,
                        ...canonical[idx],
                        capabilities: Array.from(new Set([
                            ...entry.capabilities,
                            ...(Array.isArray(canonical[idx].capabilities) ? canonical[idx].capabilities.map(String) : [])
                        ]))
                    };
                } else {
                    canonical.push(entry);
                }
            }
            delete section.models;
            changed = true;
        }
        if (canonical.length > 0 && JSON.stringify(media.models || []) !== JSON.stringify(canonical)) {
            media.models = canonical;
            changed = true;
        }
    }
    if (config.channels && typeof config.channels === 'object') {
        if (config.channels.feishu && typeof config.channels.feishu === 'object') {
            const mode = config.channels.feishu.connectionMode;
            if (mode && mode !== 'websocket' && mode !== 'webhook') {
                config.channels.feishu.connectionMode = 'websocket';
                changed = true;
            }
        }
    }
    if (config.imageGenerator) { delete config.imageGenerator; changed = true; }
    if (config.videoGenerator) { delete config.videoGenerator; changed = true; }
    if (config.agents && config.agents.defaults) {
        if (config.agents.defaults.imageGenerationModel) {
            delete config.agents.defaults.imageGenerationModel;
            changed = true;
        }
        if (config.agents.defaults.videoGenerationModel) {
            delete config.agents.defaults.videoGenerationModel;
            changed = true;
        }
    }
    try {
        if (extractAndStripProviderUiFields(config, {
            replaceMeta: options.replaceProviderUiMeta === true
        }).changed) changed = true;
    } catch (e) {}
    if (normalizeWebToolsConfig(config)) changed = true;
    return changed;
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

/** HTTP 探测 Control UI：/acp/ 能响应再通知解锁（避免仅 TCP 通了就进白屏） */
function startGatewayHttpReadyWatch(port) {
    stopGatewayHttpReadyWatch();
    gatewayHttpReadyNotified = false;
    const targetPort = Number(port) > 0 ? Number(port) : 18789;
    const http = require('http');
    let tries = 0;
    gatewayHttpReadyTimer = setInterval(() => {
        if (!gatewayProcess || gatewayHttpReadyNotified) {
            stopGatewayHttpReadyWatch();
            return;
        }
        tries += 1;
        if (tries > 180) {
            stopGatewayHttpReadyWatch();
            appendMainDiagnostic('gateway-http-ready-timeout', null, {
                port: targetPort,
                tries,
            });
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                    'gateway-log',
                    `\n[System] Gateway 进程已启动，但 ${Math.ceil(tries / 2)} 秒内 HTTP 接口未就绪，正在自动回收并重试。\n`
                );
            }
            scheduleGatewayCrashRestart(-2, { force: true });
            return;
        }
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            if (ok) notifyGatewayHttpReady(targetPort);
        };
        try {
            const req = http.get({
                hostname: '127.0.0.1',
                port: targetPort,
                path: '/acp/',
                timeout: 500,
                headers: { Accept: 'text/html,*/*' },
            }, (res) => {
                try { res.resume(); } catch (e) {}
                // 任意 HTTP 响应都说明 Control UI 路由已起来（含 3xx/401）
                finish(true);
            });
            req.on('error', () => finish(false));
            req.on('timeout', () => {
                try { req.destroy(); } catch (e) {}
                finish(false);
            });
        } catch (e) {
            finish(false);
        }
    }, 500);
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
    const instanceId = (global.nexoraInstance && global.nexoraInstance.id) || 1;
    const portHint = (global.nexoraInstance && global.nexoraInstance.gatewayPortHint) || 18789;
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
            const norm = normalizeGatewayAuthConfig(parsed, NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN);
            token = norm.token;
            port = norm.port;
            // 多开实例强制使用错开端口，避免两套网关互抢 18789
            if (instanceId > 1) {
                port = portHint;
                if (!norm.config.gateway) norm.config.gateway = {};
                norm.config.gateway.port = port;
                norm.changed = true;
            }
            if (norm.changed) {
                writeConfigFileAtomic(JSON.stringify(norm.config, null, 2) + '\n');
                console.log('[TokenGuard] Normalized gateway.auth before start');
            }
        }
    } catch (e) {
        console.warn('[TokenGuard] Primary config normalize failed:', e.message);
        try {
            const minimal = normalizeGatewayAuthConfig({}, NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN).config;
            if (instanceId > 1) {
                if (!minimal.gateway) minimal.gateway = {};
                minimal.gateway.port = portHint;
                port = portHint;
            }
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
            writeConfigFileAtomic(JSON.stringify(minimal, null, 2) + '\n');
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
            const providersBefore = JSON.stringify(cfg.models && cfg.models.providers || {});
            omitBlankProviderApiKeys(cfg.models && cfg.models.providers);
            if (providersBefore !== JSON.stringify(cfg.models && cfg.models.providers || {})) {
                writeConfigFileAtomic(JSON.stringify(cfg, null, 2) + '\n');
                console.log('[ModelSync] Removed blank provider API keys from primary config');
            }
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

/**
 * 原子写 openclaw.json：写临时文件 → fsync → renameSync 覆盖。
 * 消除「非原子整文件覆盖」被网关并发读到半截 JSON 的问题（这是 .rejected /
 * unreadable-config-before-write / .bak-jsonfix 等损坏文件的根因）。
 * 同卷 rename 在 Windows/NTFS 上是原子替换，读者永远看到完整旧文件或完整新文件。
 * 注：同时同步网关 clobber 守卫的还原源（.bak）与基线（.last-good）。
 * OpenClaw 网关会把「体积骤降 50%+ 的外部写入」当成配置损坏，从 .bak 整体还原——
 * 用户在 UI 里删厂商/换模型会让配置合法变小，若不同步基线就会被守卫秒回滚
 * （表现为「厂商删了重启又回来」「配置的模型不生效」）。
 * 同步后即使守卫触发，还原源也是同一份新内容，等于放行。
 */
function writeConfigFileAtomic(contents) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.dirname(CONFIG_PATH);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const tmp = path.join(dir, `.openclaw.json.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    try {
        const fd = fs.openSync(tmp, 'w');
        try {
            fs.writeSync(fd, contents);
            try { fs.fsyncSync(fd); } catch (_) {}
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, CONFIG_PATH);
    } catch (e) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
        throw e;
    }
    try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak'); } catch (_) {}
    try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.last-good'); } catch (_) {}
}

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
    const names = ['patch_gateway.js', 'tool-turn-repair.js', 'token-usage-parse.js', 'capture-desktop.ps1', 'desktop-control.ps1', 'openclaw-state.js', 'gateway-auth.js', 'gateway-boot-harden.js'];
    for (const name of names) {
        const srcCandidates = [path.join(__dirname, name), resolveAppFsPath(name)];
        const src = srcCandidates.find((p) => {
            try { return p && fs.existsSync(p) && !String(p).includes(`${path.sep}app.asar${path.sep}`); } catch (e) { return false; }
        }) || srcCandidates.find((p) => fs.existsSync(p));
        if (!src) continue;
        try {
            const dest = path.join(dir, name);
            let copyNeeded = !fs.existsSync(dest);
            if (!copyNeeded) {
                const srcStat = fs.statSync(src);
                const destStat = fs.statSync(dest);
                copyNeeded = srcStat.size !== destStat.size || srcStat.mtimeMs > destStat.mtimeMs + 1;
            }
            if (copyNeeded) fs.copyFileSync(src, dest);
        } catch (e) {
            console.warn(`[TokenGuard] copy ${name} failed:`, e.message);
        }
    }
    const patchAbs = path.join(dir, 'patch_gateway.js');
    const patchPath = patchAbs.replace(/\\/g, '/');
    // [FIX] 不再往 process.env 写入，避免污染 Electron 主进程环境变量
    // 这些值通过返回值传递给 startGatewayProcess 中的子进程环境
    return { runtimeDir: dir, patchPath, patchAbs };
}

/** 同步到 state 的「库」目录，不是 OpenClaw 插件（无 openclaw.plugin.json） */
const NON_PLUGIN_EXTENSION_DIRS = new Set(['media-core']);

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
        // media-core 等是运行时库，不是插件根目录
        if (NON_PLUGIN_EXTENSION_DIRS.has(id)) return false;
        try {
            if (installs[id] && installs[id].installPath
                && fs.existsSync(path.join(installs[id].installPath, 'package.json'))) return true;
        } catch (e) {}
        try {
            const ext = path.join(CONFIG_DIR, 'extensions', id);
            if (fs.existsSync(ext) && fs.existsSync(path.join(ext, 'openclaw.plugin.json'))) return true;
        } catch (e) {}
        for (const p of loadPaths) {
            try {
                if (typeof p === 'string' && p.toLowerCase().includes(String(id).toLowerCase()) && fs.existsSync(p)) return true;
            } catch (e) {}
        }
        // 内置渠道：必须真有包，不能“清单里写了就算存在”（否则 Doctor 会对缺失包强制 npm）
        if (BUNDLED_CUSTOM_PLUGINS.includes(id) || BUNDLED_EXTENSION_PLUGINS.includes(id)) return true;
        const bundled = BUNDLED_NPM_CHANNEL_PLUGINS.find((e) => e.id === id);
        if (bundled) {
            if (bundled.viaLoadPaths === false) {
                try {
                    if (installs[id] && installs[id].installPath
                        && fs.existsSync(path.join(installs[id].installPath, 'package.json'))) return true;
                } catch (e) {}
                return false;
            }
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

    const staleIds = new Set([
        'key-rotator-proxy',
        'system-control',
        'channel-router',
        LONG_TERM_MEMORY_UI_ID,
    ]);

    for (const id of Object.keys(entries)) {
        // 安装残留 / 明显无效 id
        if (id.startsWith('.') || staleIds.has(id)) {
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
                'feishu', 'openclaw-qqbot', 'qqbot', 'telegram', 'slack', 'whatsapp', 'matrix',
                'voice-call', 'openclaw-weixin'
            ]);
            if (channelIds.has(id)) {
                // Never silently disable a user-configured communication
                // channel during startup. A package can be temporarily
                // unavailable while runtime extraction is finishing; keeping
                // entries/allow/install metadata lets the channel recover on
                // the next probe instead of appearing "closed" to the user.
                console.warn(`[PluginSeed] Preserve configured communication channel: ${id}`);
                continue;
            }
            delete entries[id];
            changed = true;
        }
    }

    if (Array.isArray(config.plugins.allow)) {
        const nextAllow = config.plugins.allow.filter((id) => {
            if (staleIds.has(id)) return false;
            if (id && id.startsWith('.')) return false;
            if (!entries[id]) return false;
            return true;
        });
        if (JSON.stringify(nextAllow) !== JSON.stringify(config.plugins.allow)) {
            config.plugins.allow = nextAllow;
            changed = true;
        }
    }

    // Remove install metadata for plugins that no longer exist. Leaving these
    // records behind makes OpenClaw attempt npm repair on every cold start.
    for (const id of Object.keys(installs)) {
        if (staleIds.has(id) || id.startsWith('.')) {
            delete installs[id];
            changed = true;
        }
    }

    // Explicit load paths are authoritative in Nexora. A stale staging folder
    // or an old extension path can otherwise be auto-discovered as a second
    // copy of the same plugin, producing duplicate-id warnings and extra boot
    // work. Keep user extensions and bundled communication paths intact.
    if (Array.isArray(loadPaths) && config.plugins.load) {
        const nextPaths = loadPaths.filter((raw) => {
            if (typeof raw !== 'string' || !raw.trim()) return false;
            const normalized = raw.replace(/\\/g, '/').toLowerCase();
            if (normalized.includes('/.openclaw-install-stage-')) return false;
            for (const id of staleIds) {
                if (normalized.endsWith('/' + id) || normalized.includes('/' + id + '/')) return false;
            }
            return true;
        });
        if (JSON.stringify(nextPaths) !== JSON.stringify(loadPaths)) {
            config.plugins.load.paths = nextPaths;
            changed = true;
        }
    }

    // Preserve bundled capabilities that are selected outside plugins.entries.
    // They were previously pulled in by compat discovery, so switching to an
    // allow list without copying these references would silently disable web
    // search, browser automation, or the bundled Ollama provider.
    if (Array.isArray(config.plugins.allow)) {
        const requiredBundledIds = new Set();
        if (config.browser && config.browser.enabled !== false) requiredBundledIds.add('browser');
        const webSearchProvider = config.tools && config.tools.web && config.tools.web.search
            && config.tools.web.search.provider;
        const webFetchProvider = config.tools && config.tools.web && config.tools.web.fetch
            && config.tools.web.fetch.provider;
        if (typeof webSearchProvider === 'string' && webSearchProvider.trim()) {
            requiredBundledIds.add(webSearchProvider.trim());
        }
        if (typeof webFetchProvider === 'string' && webFetchProvider.trim()) {
            requiredBundledIds.add(webFetchProvider.trim());
        }
        if (config.models && config.models.providers && config.models.providers.ollama) {
            requiredBundledIds.add('ollama');
        }
        for (const id of requiredBundledIds) {
            if (!config.plugins.allow.includes(id)) {
                config.plugins.allow.push(id);
                changed = true;
            }
        }
    }

    // OpenClaw 2026.9 removed this compatibility-discovery switch.
    if (Object.prototype.hasOwnProperty.call(config.plugins, 'bundledDiscovery')) {
        delete config.plugins.bundledDiscovery;
        changed = true;
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
    'remote-policy',
    'voice-bridge',
    'session-tool-heal',
    'session-overflow-rollover'
];

/** extensions/ 下的媒体生成插件：云电脑开箱必须启用并注入 load.paths */
const BUNDLED_EXTENSION_PLUGINS = [
    'image-generator',
    'video-generator'
];

const MEDIA_TOOLS_MARKER = '<!-- nexora-media-tools-v3 -->';
const MEDIA_MEMORY_MARKER = '<!-- nexora-media-memory-v1 -->';
const MEDIA_AGENTS_MARKER = '<!-- nexora-media-agents-v2 -->';
const SESSION_CONTINUITY_AGENTS_MARKER = '<!-- nexora-session-continuity-v1 -->';
const MEDIA_TOOLS_MARKER_LEGACY = '<!-- nexora-media-tools-v1 -->';
const MEDIA_AGENTS_MARKER_LEGACY = '<!-- nexora-media-agents-v1 -->';
const REPLY_DEDUPE_AGENTS_MARKER = '<!-- nexora-reply-dedupe-v1 -->';
const MEDIA_IMAGE_PREFS_FILE = 'media-generator.json';
const MEDIA_VIDEO_PREFS_FILE = 'video-generator.json';
/** UI-only provider 显示名/备注；OpenClaw Schema 不接受 models.providers.*.label|remark */
const PROVIDER_UI_META_FILE = 'provider-ui-meta.json';
const PROVIDER_UI_ONLY_KEYS = ['label', 'displayName', 'remark'];
// ⚠️ 安全：以下内联 key 已泄露（进过源码/公网快照），仅作全新安装的最后兜底。
// 轮换后用环境变量 AGNES_API_KEYS(逗号分隔) 或 ~/.openclaw/.agnes-keys.json 覆盖，无需改源码。
// Never ship API credentials in source or packaged resources. Built-in access
// may be supplied explicitly through AGNES_API_KEYS/AGNES_API_KEY or the
// per-user .agnes-keys.json file; otherwise the provider remains unconfigured.
const _COMPROMISED_AGNES_KEYS = [];
function loadAgnesApiKeys() {
    const envRaw = process.env.AGNES_API_KEYS || process.env.AGNES_API_KEY || '';
    const envKeys = String(envRaw).split(',').map(s => s.trim()).filter(Boolean);
    if (envKeys.length) return envKeys;
    try {
        const os = require('os');
        const p = path.join(
            process.env.OPENCLAW_STATE_DIR || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || os.homedir(), '.openclaw'),
            '.agnes-keys.json'
        );
        const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
        const fileKeys = (Array.isArray(arr) ? arr : []).map(s => String(s).trim()).filter(Boolean);
        if (fileKeys.length) return fileKeys;
    } catch (_) {}
    return [];
}
const BUILTIN_AGNES_API_KEYS = loadAgnesApiKeys();
const _AGNES_PRIMARY_KEY = BUILTIN_AGNES_API_KEYS[0] || _COMPROMISED_AGNES_KEYS[0];
const DEFAULT_MEDIA_IMAGE_PREFS = {
    apiBase: 'https://apihub.agnes-ai.com/v1/images/generations',
    apiKey: _AGNES_PRIMARY_KEY,
    model: 'agnes-ai/agnes-image-2.0-flash'
};
const DEFAULT_MEDIA_VIDEO_PREFS = {
    apiBase: 'https://apihub.agnes-ai.com/v1/videos',
    apiKey: _AGNES_PRIMARY_KEY,
    model: 'agnes-ai/agnes-video-v2.0'
};
function normalizeMediaApiBase(apiBase, type) {
  const b = String(apiBase || '').trim().replace(/\/$/, '');
  if (!b) return type === 'video' ? 'https://apihub.agnes-ai.com/v1/videos' : 'https://apihub.agnes-ai.com/v1/images/generations';
  if (type === 'image') {
    if (b.endsWith('/images/generations')) return b;
    if (b.endsWith('/images')) return `${b}/generations`;
    if (b.endsWith('/v1')) return `${b}/images/generations`;
    return b;
  }
  if (b.endsWith('/videos')) return b;
  if (b.endsWith('/v1')) return `${b}/videos`;
  return b;
}

function migrateMediaGeneratorPrefs() {
  for (const [file, type] of [[MEDIA_IMAGE_PREFS_FILE, 'image'], [MEDIA_VIDEO_PREFS_FILE, 'video']]) {
    try {
      const p = path.join(CONFIG_DIR, file);
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!data || typeof data !== 'object') continue;
      const normalized = normalizeMediaApiBase(data.apiBase, type);
      if (normalized !== data.apiBase) {
        data.apiBase = normalized;
        fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
        console.log('[MediaPrefs] Migrated', file, 'apiBase ->', normalized);
      }
    } catch (e) {}
  }
}

function resolveAccelerationProxyPort() {
    try {
        const st = acceleration.getStatus();
        if (st && st.enabled && Number(st.mixedPort) > 0) return Number(st.mixedPort);
    } catch (e) {}
    return 0;
}

function requestJson(urlStr, { method = 'GET', headers = {}, body = null, timeout = 12000, maxResponseBytes = 40 * 1024 * 1024 } = {}) {
    const https = require('https');
    const http = require('http');
    const tls = require('tls');
    const { URL } = require('url');
    return new Promise((resolve, reject) => {
        let parsed;
        try {
            parsed = new URL(urlStr);
        } catch (e) {
            reject(e);
            return;
        }

        const targetPort = Number(parsed.port) || (parsed.protocol === 'http:' ? 80 : 443);
        const proxyPort = resolveAccelerationProxyPort();
        const useHttpsProxy = proxyPort > 0 && parsed.protocol === 'https:';

        const handleResponse = (res) => {
            const chunks = [];
            let received = 0;
            let rejectedForSize = false;
            res.on('data', (c) => {
                received += c.length;
                if (received > maxResponseBytes) {
                    rejectedForSize = true;
                    res.destroy(new Error('Response body too large'));
                    return;
                }
                chunks.push(c);
            });
            res.on('error', reject);
            res.on('end', () => {
                if (rejectedForSize) return;
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch (e) {}
                resolve({
                    status: res.statusCode || 0,
                    statusText: res.statusMessage || '',
                    headers: res.headers || {},
                    text,
                    json,
                    viaProxy: useHttpsProxy
                });
            });
        };

        // Clash 开着才走本地代理；关着则直连（与网关一致）
        if (useHttpsProxy) {
            const connectReq = http.request({
                host: '127.0.0.1',
                port: proxyPort,
                method: 'CONNECT',
                path: `${parsed.hostname}:${targetPort}`,
                timeout,
                headers: {
                    Host: `${parsed.hostname}:${targetPort}`,
                    'Proxy-Connection': 'keep-alive'
                }
            });
            connectReq.on('connect', (res, socket) => {
                if (res.statusCode !== 200) {
                    try { socket.destroy(); } catch (e) {}
                    reject(new Error(`代理 CONNECT 失败 HTTP ${res.statusCode}`));
                    return;
                }
                const tlsSocket = tls.connect({
                    socket,
                    servername: parsed.hostname,
                    // 校验远端证书（原先全关 = 经代理的出站可被中间人）；自签名场景可设 NEXORA_INSECURE_TLS=1
                    rejectUnauthorized: !/^(1|true|yes)$/i.test(String(process.env.NEXORA_INSECURE_TLS || ''))
                }, () => {
                    // TLS 已由 CONNECT 隧道完成，这里用 http 在加密套接字上发请求
                    const req = http.request({
                        host: parsed.hostname,
                        port: targetPort,
                        path: parsed.pathname + parsed.search,
                        method,
                        headers: {
                            Host: parsed.host,
                            ...headers
                        },
                        timeout,
                        createConnection: () => tlsSocket
                    }, handleResponse);
                    req.on('error', reject);
                    req.on('timeout', () => {
                        req.destroy(new Error('Request Timeout'));
                    });
                    if (body) req.write(body);
                    req.end();
                });
                tlsSocket.on('error', reject);
            });
            connectReq.on('error', reject);
            connectReq.on('timeout', () => {
                connectReq.destroy(new Error('Request Timeout'));
            });
            connectReq.end();
            return;
        }

        const lib = parsed.protocol === 'http:' ? http : https;
        const req = lib.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: targetPort,
            path: parsed.pathname + parsed.search,
            method,
            headers,
            timeout,
            rejectUnauthorized: !/^(1|true|yes)$/i.test(String(process.env.NEXORA_INSECURE_TLS || ''))
        }, handleResponse);
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error('Request Timeout'));
        });
        if (body) req.write(body);
        req.end();
    });
}

const BUILTIN_AGNES_ENDPOINTS = Object.freeze({
    models: { method: 'GET', path: '/v1/models', timeout: 25000 },
    chat: { method: 'POST', path: '/v1/chat/completions', timeout: 120000 },
    image: { method: 'POST', path: '/v1/images/generations', timeout: 180000 },
    video: { method: 'POST', path: '/v1/videos', timeout: 180000 },
    videoStatus: { method: 'GET', path: '/agnesapi', timeout: 30000 }
});

/** Keep built-in credentials in the main process behind a fixed endpoint allowlist. */
async function requestBuiltInAgnes(payload) {
    const action = String(payload && payload.action || '');
    const endpoint = BUILTIN_AGNES_ENDPOINTS[action];
    if (!endpoint) return { success: false, error: 'Unsupported built-in Agnes action' };
    if (!BUILTIN_AGNES_API_KEYS.length) return { success: false, error: 'Built-in Agnes API key is not configured' };

    let body = null;
    if (endpoint.method === 'POST') {
        const data = payload && payload.body;
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return { success: false, error: 'Invalid request body' };
        }
        body = JSON.stringify(data);
        if (Buffer.byteLength(body, 'utf8') > 20 * 1024 * 1024) {
            return { success: false, error: 'Request body too large' };
        }
    }

    let url = `https://apihub.agnes-ai.com${endpoint.path}`;
    if (action === 'videoStatus') {
        const taskId = String(payload && payload.taskId || '').trim();
        const modelName = String(payload && payload.modelName || '').trim();
        if (!/^[A-Za-z0-9._:-]{1,160}$/.test(taskId)) return { success: false, error: 'Invalid video task id' };
        const query = new URLSearchParams({ video_id: taskId });
        if (modelName && /^[A-Za-z0-9._:+/-]{1,160}$/.test(modelName)) query.set('model_name', modelName);
        url += `?${query.toString()}`;
    }

    let lastError = null;
    for (let i = 0; i < BUILTIN_AGNES_API_KEYS.length; i++) {
        try {
            const response = await requestJson(url, {
                method: endpoint.method,
                headers: {
                    ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
                    Authorization: `Bearer ${BUILTIN_AGNES_API_KEYS[i]}`
                },
                body,
                timeout: endpoint.timeout
            });
            if ([401, 403, 429].includes(response.status) && i + 1 < BUILTIN_AGNES_API_KEYS.length) continue;
            return { success: true, status: response.status, statusText: response.statusText, text: response.text };
        } catch (e) {
            lastError = e;
            if (isNetworkProbeError(e && e.message)) break;
        }
    }
    return { success: false, error: (lastError && lastError.message) || 'Built-in Agnes request failed' };
}

function isNetworkProbeError(errOrMsg) {
    return /timeout|超时|ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket hang up|代理 CONNECT|AbortError|aborted/i.test(String(errOrMsg || ''));
}

/** 生图/生视频底层重试与网络报错：不写入 UI 日志流 */
function isMediaApiNoiseLog(text) {
    const l = String(text || '').toLowerCase();
    return (
        l.includes('[video-generator]') ||
        l.includes('[image-generator]') ||
        l.includes('[media-http]') ||
        l.includes('[media-cli]') ||
        l.includes('draw_video failed') ||
        l.includes('draw_picture failed') ||
        (l.includes('built-in key') && l.includes('failed')) ||
        (l.includes('[tools]') && (l.includes('draw_video') || l.includes('draw_picture'))) ||
        l.includes('unsupportedparamserror') ||
        l.includes('all image api keys failed') ||
        l.includes('all video api keys failed') ||
        
        l.includes('extensions/image-generator') ||
        l.includes('extensions/video-generator') ||
        l.includes('extensions\\image-generator') ||
        l.includes('extensions\\video-generator') ||
        (l.includes('etimedout') && (l.includes('198.18.') || l.includes('agnes') || l.includes('apihub'))) ||
        (l.includes('connect etimedout') && l.includes(':443')) ||
        (l.includes('stalled session') && l.includes('draw_video')) ||
        l.includes('stuck session recovery') ||
        l.includes('embedded abort settle timed out') ||
        (l.includes('lane task error') && l.includes('reply operation aborted'))
    );
}

function filterGatewayLogText(text) {
    if (!text || typeof text !== 'string') return text;
    const lines = text.split('\n');
    const kept = lines.filter((line) => !isMediaApiNoiseLog(line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim()));
    if (kept.length === lines.length) return text;
    return kept.length ? kept.join('\n') : '';
}

async function verifyBuiltInAgnesRequest(mode = 'key') {
    const useKeyCheck = mode === 'key';
    const viaProxy = resolveAccelerationProxyPort() > 0;
    // /models 更轻量；密钥可用性看 HTTP 鉴权结果即可，不必打 chat/completions
    const url = 'https://apihub.agnes-ai.com/v1/models';
    const timeoutMs = viaProxy ? 20000 : 25000;

    const attempts = [];
    for (let i = 0; i < BUILTIN_AGNES_API_KEYS.length; i++) {
        const apiKey = BUILTIN_AGNES_API_KEYS[i];
        try {
            const response = await requestJson(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
                },
                body: null,
                timeout: timeoutMs
            });
            const errMsg = response.json?.error?.message || '';
            const status = response.status || 0;
            // 401/403：这把 Key 无效，换下一把；429：限流，换下一把
            const authFailed = status === 401 || status === 403;
            const rateLimited = status === 429;
            const ok = status >= 200 && status < 300;
            attempts.push({
                index: i + 1,
                status,
                statusText: response.statusText,
                ok,
                error: errMsg || (authFailed ? 'Unauthorized' : (rateLimited ? 'Rate limited' : null)),
                viaProxy: !!response.viaProxy
            });
            if (ok) {
                return {
                    success: true,
                    mode,
                    keyIndex: i + 1,
                    rotated: i > 0,
                    viaProxy: !!response.viaProxy,
                    attempts
                };
            }
            // 非鉴权/限流类失败（如 5xx）也继续试下一把；纯网络问题在 catch 里快速结束
            if (!authFailed && !rateLimited && status > 0 && status < 500) {
                // 其它 4xx：这把 Key 多半不可用，继续轮询
            }
        } catch (e) {
            const msg = e.message || String(e);
            attempts.push({
                index: i + 1,
                status: 0,
                statusText: '',
                ok: false,
                error: msg,
                viaProxy
            });
            // 网络层超时/连不上：开不开 Clash 都一样会挂，不必把 7 把 Key 各超时一遍
            if (isNetworkProbeError(msg)) {
                break;
            }
        }
    }
    return {
        success: false,
        mode,
        keyIndex: null,
        rotated: attempts.length > 1,
        viaProxy,
        networkHint: attempts.some((a) => isNetworkProbeError(a.error))
            ? (viaProxy ? 'proxy_or_upstream_timeout' : 'direct_timeout')
            : null,
        attempts
    };
}

function allBundledManagedPluginIds() {
    return [...BUNDLED_CUSTOM_PLUGINS, ...BUNDLED_EXTENSION_PLUGINS];
}

// 随安装包一起交付的 npm 渠道插件。
// viaLoadPaths=false：走官方 installs（复制到本机 ~/.openclaw/npm/projects），
// 避免无影上残留「别人电脑」的绝对路径 / Program Files 坏入口导致全部加载失败。
const BUNDLED_NPM_CHANNEL_PLUGINS = [
    { id: 'openclaw-weixin', viaLoadPaths: true, candidates: [path.join('node_modules', '@tencent-weixin', 'openclaw-weixin')] },
    { id: 'openclaw-qqbot', viaLoadPaths: false, packageName: '@tencent-connect/openclaw-qqbot', candidates: [path.join('node_modules', '@tencent-connect', 'openclaw-qqbot')] },
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
    // 顶层旧版单账号 → 迁入 accounts，让通讯管理列表能看见
    if (feishu.appId && feishu.appSecret) {
        hasConfiguredAccount = true;
        if (!feishu.accounts || typeof feishu.accounts !== 'object') feishu.accounts = {};
        if (Object.keys(feishu.accounts).length === 0) {
            const legacyId = 'default';
            feishu.accounts[legacyId] = {
                appId: String(feishu.appId).trim(),
                appSecret: String(feishu.appSecret).trim()
            };
            if (feishu.domain) feishu.accounts[legacyId].domain = feishu.domain;
            if (feishu.encryptKey) feishu.accounts[legacyId].encryptKey = feishu.encryptKey;
            if (feishu.verificationToken) feishu.accounts[legacyId].verificationToken = feishu.verificationToken;
            if (!feishu.defaultAccount) feishu.defaultAccount = legacyId;
            delete feishu.appId;
            delete feishu.appSecret;
            delete feishu.encryptKey;
            delete feishu.verificationToken;
            changed = true;
        }
    }

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
function buildPatchedNodeOptions(patchPath, baseNodeOptions) {
    const targetPath = String(patchPath || process.env.NEXORA_AGENT_PATCH_PATH || '')
        .replace(/\\/g, '/');
    // [FIX] 不再从主进程 process.env.NODE_OPTIONS 继承（主进程启动时已清理）
    // 改为显式接收 baseNodeOptions 参数，默认为空
    const existing = String(baseNodeOptions || '').trim();
    if (!targetPath) return existing;
    const injected = `--require "${targetPath}" --dns-result-order=ipv4first --no-warnings`;
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

    // 媒体插件：声明 tools contract，避免 allowlist 把 draw_* 当成 unknown
    const mediaToolContracts = {
        'image-generator': ['draw_picture'],
        'video-generator': ['draw_video']
    };
    if (mediaToolContracts[pluginId]) {
        const want = mediaToolContracts[pluginId];
        const have = manifest.contracts && Array.isArray(manifest.contracts.tools)
            ? manifest.contracts.tools
            : [];
        if (JSON.stringify(have) !== JSON.stringify(want)) {
            if (!manifest.contracts || typeof manifest.contracts !== 'object') manifest.contracts = {};
            manifest.contracts.tools = want;
            needsUpdate = true;
        }
        if (!manifest.activation || typeof manifest.activation !== 'object') {
            manifest.activation = { onStartup: true };
            needsUpdate = true;
        } else if (manifest.activation.onStartup !== true) {
            manifest.activation.onStartup = true;
            needsUpdate = true;
        }
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

/** 强制同步某个内置插件目录到 ~/.openclaw/extensions，不受 .bundle-version 限制。 */
function syncBundledPluginFiles(pluginId) {
    try {
        if (!pluginId) return;
        const destDir = path.join(CONFIG_DIR, 'extensions', pluginId);
        fs.mkdirSync(destDir, { recursive: true });
        const pluginSrcCandidates = [
            path.join(__dirname, 'plugins', pluginId),
            resolveAppFsPath('plugins', pluginId),
            path.join(__dirname, 'extensions', pluginId),
            resolveAppFsPath('extensions', pluginId)
        ];
        let pluginSrc = null;
        for (const candidate of pluginSrcCandidates) {
            if (candidate && fs.existsSync(path.join(candidate, 'index.js'))) {
                pluginSrc = candidate;
                break;
            }
        }
        if (!pluginSrc) return;
        // 清掉历史误拷产生的嵌套目录（extensions/image-generator/image-generator）
        try {
            const nestedJunk = path.join(destDir, pluginId);
            if (fs.existsSync(nestedJunk) && fs.statSync(nestedJunk).isDirectory()) {
                fs.rmSync(nestedJunk, { recursive: true, force: true });
            }
        } catch (e) {}
        const copyPluginTree = (toDir) => {
            fs.mkdirSync(toDir, { recursive: true });
            for (const name of fs.readdirSync(pluginSrc)) {
                if (name === 'node_modules' || name === '.bundle-version') continue;
                if (name === pluginId) continue;
                const from = path.join(pluginSrc, name);
                const to = path.join(toDir, name);
                try {
                    const st = fs.statSync(from);
                    if (st.isDirectory()) {
                        fs.cpSync(from, to, { recursive: true, force: true });
                    } else {
                        fs.copyFileSync(from, to);
                    }
                } catch (e) {
                    console.warn(`[PluginSeed] Failed syncing ${pluginId}/${name}:`, e.message);
                }
            }
        };
        copyPluginTree(destDir);
        // 运行时目录偶发也被 gateway 解析到：一并覆盖，避免旧版 JSON.stringify(event) 双回复
        try {
            const rtRoot = getGatewayRuntimeRoot(require('electron').app);
            if (rtRoot) {
                const rtPluginDir = path.join(rtRoot, 'plugins', pluginId);
                if (fs.existsSync(path.join(rtRoot, 'plugins')) || pluginId === 'error-filter' || pluginId === 'session-overflow-rollover') {
                    copyPluginTree(rtPluginDir);
                    ensurePluginPackageJson(rtPluginDir, pluginId);
                    ensurePluginManifestJson(rtPluginDir, pluginId);
                }
            }
        } catch (e) {}
        ensurePluginPackageJson(destDir, pluginId);
        ensurePluginManifestJson(destDir, pluginId);
        syncMediaHttpHelper(destDir);
        if (pluginId === 'image-generator' || pluginId === 'video-generator') {
            syncMediaCoreBundle();
        }
    } catch (e) {
        console.warn(`[PluginSeed] syncBundledPluginFiles(${pluginId}) failed:`, e.message);
    }
}

function syncMediaHttpHelper(destDir) {
    try {
        const srcCandidates = [
            path.join(__dirname, 'extensions', 'media-http.js'),
            path.join(__dirname, 'extensions', path.basename(destDir), 'media-http.js'),
            resolveAppFsPath('extensions', 'media-http.js'),
            resolveAppFsPath('extensions', path.basename(destDir), 'media-http.js'),
        ];
        const src = srcCandidates.find((p) => p && fs.existsSync(p));
        if (!src || !destDir) return;
        fs.copyFileSync(src, path.join(destDir, 'media-http.js'));
    } catch (e) {
        console.warn('[PluginSeed] syncMediaHttpHelper failed:', e && e.message);
    }
}

/** 强制同步 role-manager 插件与共享 role-config，不受 .bundle-version 限制。 */
function syncRoleManagerSharedModules() {
    try {
        const destDir = path.join(CONFIG_DIR, 'extensions', 'role-manager');
        fs.mkdirSync(destDir, { recursive: true });

        const pluginSrcCandidates = [
            path.join(__dirname, 'plugins', 'role-manager'),
            resolveAppFsPath('plugins', 'role-manager')
        ];
        let pluginSrc = null;
        for (const candidate of pluginSrcCandidates) {
            if (candidate && fs.existsSync(path.join(candidate, 'index.js'))) {
                pluginSrc = candidate;
                break;
            }
        }
        if (pluginSrc) {
            for (const name of fs.readdirSync(pluginSrc)) {
                if (name === 'node_modules' || name === '.bundle-version') continue;
                const from = path.join(pluginSrc, name);
                const to = path.join(destDir, name);
                try {
                    const st = fs.statSync(from);
                    if (st.isDirectory()) {
                        fs.cpSync(from, to, { recursive: true, force: true });
                    } else {
                        const srcBuf = fs.readFileSync(from);
                        let same = false;
                        if (fs.existsSync(to)) {
                            try { same = Buffer.compare(srcBuf, fs.readFileSync(to)) === 0; } catch (e) {}
                        }
                        if (!same) fs.writeFileSync(to, srcBuf);
                    }
                } catch (e) {
                    console.warn(`[PluginSeed] Failed syncing role-manager/${name}:`, e.message);
                }
            }
        }

        const sharedFiles = ['role-config.js'];
        for (const name of sharedFiles) {
            const srcCandidates = [
                path.join(__dirname, name),
                resolveAppFsPath(name)
            ];
            let src = null;
            for (const candidate of srcCandidates) {
                if (candidate && fs.existsSync(candidate)) {
                    src = candidate;
                    break;
                }
            }
            if (!src) continue;
            const dest = path.join(destDir, name);
            try {
                const srcBuf = fs.readFileSync(src);
                let same = false;
                if (fs.existsSync(dest)) {
                    try { same = Buffer.compare(srcBuf, fs.readFileSync(dest)) === 0; } catch (e) {}
                }
                if (!same) {
                    fs.writeFileSync(dest, srcBuf);
                    console.log(`[PluginSeed] Synced ${name} -> role-manager`);
                }
            } catch (e) {
                console.warn(`[PluginSeed] Failed syncing ${name} to role-manager:`, e.message);
            }
        }
        ensurePluginPackageJson(destDir, 'role-manager');
        ensurePluginManifestJson(destDir, 'role-manager');
        console.log('[PluginSeed] role-manager synced');
    } catch (e) {
        console.warn('[PluginSeed] syncRoleManagerSharedModules failed:', e.message);
    }
}

const DEFAULT_MEMORY_MD_TEMPLATE = `# MEMORY.md

## Active session context
- （溢出换新会话后，这里会自动写入近期对话摘要）
- 完整上一会话可读归档：\`memory/last-session-archive.md\`（需要细节时用 read 读取）

## 核心身份
- （在此填写助手人设 / 名字）

## 用户偏好
- 称呼用户为：（待补充）
- 时区：GMT+8

## 工具使用规范
${MEDIA_MEMORY_MARKER}
- 生图/生视频规则见 TOOLS.md（优先 draw_picture / draw_video）

## 重要约定
- 本文件是长期记忆；对话压缩或自动换新会话后仍会优先读取这里的信息。
- 「Active session context」是换新会话后的续聊锚点；缺细节时 read \`memory/last-session-archive.md\`，不要向用户提及换会话或失忆。
- 由 Nexora Agent「长期记忆」插件栈自动维护（摘要 / 旋转归档 / 压缩护栏）。
`;

/** 本地小模型专用短模板：官方 AGENTS.md 过长会直接撑爆 8k 上下文 */
const SHORT_WORKSPACE_AGENTS_MD = `# AGENTS.md

Be helpful and concise. Prefer short answers.

## 启动规则（一次性）
- 启动上下文已含 AGENTS / TOOLS / MEMORY。不要重复 read 这些文件。

## Memory
- Use MEMORY.md for lasting facts only.

## Tools
- Prefer minimal tools. Skip heavy desktop actions unless asked.

## 图片/视频
${MEDIA_AGENTS_MARKER}
- 用户要画图/视频：**优先** \`draw_picture\` / \`draw_video\`；否则 \`exec\` 运行 \`node <用户目录>/.openclaw/media-cli/agnes-media-cli.js image|video --prompt "描述"\`
- **禁止** \`image_generate\` / \`video_generate\`；完成后回复首行加 \`MEDIA:绝对文件路径\`
- **禁止**输出 \`[[video_media]]\` / \`[[image_media]]\` / \`[[image]]\` / \`[[video]]\` 等占位符（通道不会渲染）

## 防双发
${REPLY_DEDUPE_AGENTS_MARKER}
- 普通对话只输出助手正文，**不要**用 \`message\` 工具再发一遍纯文本
- 若本轮必须用 \`message\`/\`sendMedia\`，结尾只能是 \`NO_REPLY\`
- 一轮只允许用户看到一条回复

## 会话连续性
${SESSION_CONTINUITY_AGENTS_MARKER}
- 上下文长度与会话切换完全由系统自动处理（自动压缩、自动归档、自动续聊）
- **禁止**要求或建议用户「开新会话 / 新窗口 / 重新开始对话 / 发 /new」
- **禁止**向用户提及换会话、归档、压缩、上下文过长或「失忆」
- 感觉历史太长也照常直接回答；缺历史细节可 read \`memory/last-session-archive.md\`
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
                let out = nl >= 0 ? keep.slice(nl + 1) : keep;
                // 截断必须对齐到 user 消息边界：以 assistant/toolResult 开头的转录会触发
                // 「roles must alternate」类拒绝，反而制造新的哑火
                try {
                    const kept = out.toString('utf8').split('\n');
                    let firstUser = -1;
                    for (let i = 0; i < kept.length; i++) {
                        if (!kept[i].trim()) continue;
                        try {
                            const rec = JSON.parse(kept[i]);
                            if (rec && rec.message && rec.message.role === 'user') { firstUser = i; break; }
                        } catch (e2) {}
                    }
                    if (firstUser > 0) out = Buffer.from(kept.slice(firstUser).join('\n'), 'utf8');
                } catch (e2) {}
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

/** 启动时：修复所有会话里断裂的 tool_call/tool_result（Gemini 哑火根因） */
function healBrokenToolTurnsOnBoot() {
    try {
        const repairPath = path.join(__dirname, 'tool-turn-repair.js');
        const alt = path.join(CONFIG_DIR, 'tool-turn-repair.js');
        let repair = null;
        if (fs.existsSync(repairPath)) repair = require(repairPath);
        else if (fs.existsSync(alt)) repair = require(alt);
        if (!repair || typeof repair.healAllSessionTranscripts !== 'function') return;
        // 确保状态目录 + 运行时目录都有一份，供 TokenGuard / 插件 require
        try {
            if (fs.existsSync(repairPath) && CONFIG_DIR) {
                fs.copyFileSync(repairPath, path.join(CONFIG_DIR, 'tool-turn-repair.js'));
            }
        } catch (e) {}
        try {
            const runtimeDir = process.env.NEXORA_AGENT_RUNTIME_DIR;
            if (runtimeDir && fs.existsSync(repairPath)) {
                fs.copyFileSync(repairPath, path.join(runtimeDir, 'tool-turn-repair.js'));
            }
        } catch (e) {}
        const summary = repair.healAllSessionTranscripts(CONFIG_DIR, fs, path);
        if (summary.healed > 0) {
            console.log(`[ToolHeal] Boot heal: scanned=${summary.scanned} healed=${summary.healed}`);
        }
    } catch (e) {
        console.warn('[ToolHeal] healBrokenToolTurnsOnBoot:', e.message);
    }
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

function resolveMediaCliScriptPath() {
    return path.join(CONFIG_DIR, 'media-cli', 'agnes-media-cli.js').replace(/\\/g, '/');
}

function sanitizeMediaGeneratorPrefs(imageGenerator, videoGenerator) {
    const sanitize = (sec, type) => {
        if (!sec || typeof sec !== 'object') return null;
        const out = { ...sec };
        const rawKey = String(out.apiKey || '').trim();
        // 额外剥掉 UI 的圆点遮罩(KEY_MASK)——否则内置模式下遮罩串会被当成真 key 写进媒体配置 → 生图/生视频鉴权失败
        const isBulletMask = /^[•*·●•●]{6,}$/.test(rawKey);
        if (!rawKey || isBulletMask || rawKey === 'sk-builtin-agnes-key-mask' || rawKey === DEFAULT_MEDIA_IMAGE_PREFS.apiKey) {
            delete out.apiKey;
        }
        if (out.apiBase) out.apiBase = normalizeMediaApiBase(out.apiBase, type);
        return out;
    };
    return {
        imageGenerator: sanitize(imageGenerator, 'image'),
        videoGenerator: sanitize(videoGenerator, 'video')
    };
}

function persistMediaGeneratorPrefs(imageGenerator, videoGenerator) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        const cleaned = sanitizeMediaGeneratorPrefs(imageGenerator, videoGenerator);
        if (cleaned.imageGenerator) {
            fs.writeFileSync(
                path.join(CONFIG_DIR, MEDIA_IMAGE_PREFS_FILE),
                JSON.stringify(cleaned.imageGenerator, null, 2),
                'utf8'
            );
        }
        if (cleaned.videoGenerator) {
            fs.writeFileSync(
                path.join(CONFIG_DIR, MEDIA_VIDEO_PREFS_FILE),
                JSON.stringify(cleaned.videoGenerator, null, 2),
                'utf8'
            );
        }
    } catch (e) {
        console.warn('[MediaPrefs] persist failed:', e.message);
    }
}

function ensureDefaultMediaGeneratorPrefs() {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        const imagePath = path.join(CONFIG_DIR, MEDIA_IMAGE_PREFS_FILE);
        const videoPath = path.join(CONFIG_DIR, MEDIA_VIDEO_PREFS_FILE);
        if (!fs.existsSync(imagePath)) {
            fs.writeFileSync(imagePath, JSON.stringify(DEFAULT_MEDIA_IMAGE_PREFS, null, 2), 'utf8');
            console.log('[MediaPrefs] Seeded default', MEDIA_IMAGE_PREFS_FILE);
        }
        if (!fs.existsSync(videoPath)) {
            fs.writeFileSync(videoPath, JSON.stringify(DEFAULT_MEDIA_VIDEO_PREFS, null, 2), 'utf8');
            console.log('[MediaPrefs] Seeded default', MEDIA_VIDEO_PREFS_FILE);
        }
    } catch (e) {
        console.warn('[MediaPrefs] ensureDefaultMediaGeneratorPrefs:', e.message);
    }
}

function buildMediaAgentsSection() {
    const cliPath = resolveMediaCliScriptPath();
    return `
## 图片/视频
${MEDIA_AGENTS_MARKER}
- 用户要画图/视频：**优先** \`draw_picture\` / \`draw_video\`；否则 \`exec\` 运行 \`node "${cliPath}" image|video --prompt "描述"\`
- **禁止** \`image_generate\` / \`video_generate\`；完成后回复首行加 \`MEDIA:绝对路径\`（半角冒号）
- **禁止**输出 \`[[video_media]]\` / \`[[image_media]]\` / \`[[image]]\` / \`[[video]]\` 等占位符（通道无法渲染）
- **禁止**复用历史里的旧 \`MEDIA:\` 路径；只能发送本次生成命令刚返回的新文件
`;
}

function ensureMediaAgentsGuidance(wsDir) {
    try {
        fs.mkdirSync(wsDir, { recursive: true });
        const agentsPath = path.join(wsDir, 'AGENTS.md');
        const section = buildMediaAgentsSection().trim() + '\n';
        if (!fs.existsSync(agentsPath)) return;
        let cur = fs.readFileSync(agentsPath, 'utf8');
        if (cur.includes(MEDIA_AGENTS_MARKER)) return;
        // 升级旧版 media agents 块（含 v1），补上禁止占位符规则
        if (cur.includes(MEDIA_AGENTS_MARKER_LEGACY) || /##\s*图片\/视频/.test(cur)) {
            const stripped = cur
                .replace(/<!--\s*nexora-media-agents-v\d+\s*-->[\s\S]*?(?=\n##\s|\n<!--|\s*$)/m, '')
                .replace(/##\s*图片\/视频[\s\S]*?(?=\n##\s|\n<!--|\s*$)/m, '')
                .trim();
            // 若 marker 在段落中间，上面第一条替换可能留下残缺；再清一遍含 marker 的旧段
            const cleaned = stripped
                .replace(/##\s*图片\/视频[\s\S]*?<!--\s*nexora-media-agents-v\d+\s*-->[\s\S]*?(?=\n##\s|\n<!--|\s*$)/m, '')
                .trim();
            cur = cleaned + (cleaned ? '\n\n' : '') + section;
            fs.writeFileSync(agentsPath, cur, 'utf8');
            console.log('[PluginSeed] Upgraded workspace AGENTS.md media guidance (v2)');
            return;
        }
        fs.appendFileSync(agentsPath, '\n' + section, 'utf8');
        console.log('[PluginSeed] Appended media guidance to workspace AGENTS.md');
    } catch (e) {
        console.warn('[PluginSeed] ensureMediaAgentsGuidance:', e.message);
    }
}

/**
 * 会话连续性规则：禁止模型让用户「开新会话/新窗口」。
 * 上下文吃紧时由 session-overflow-rollover 插件自动归档换新，用户全程无感。
 */
function ensureSessionContinuityGuidance(wsDir) {
    try {
        const agentsPath = path.join(wsDir, 'AGENTS.md');
        if (!fs.existsSync(agentsPath)) return;
        const cur = fs.readFileSync(agentsPath, 'utf8');
        if (cur.includes(SESSION_CONTINUITY_AGENTS_MARKER)) return;
        const section = [
            '',
            '## 会话连续性',
            SESSION_CONTINUITY_AGENTS_MARKER,
            '- 上下文长度与会话切换完全由系统自动处理（自动压缩、自动归档、自动续聊）',
            '- **禁止**要求或建议用户「开新会话 / 新窗口 / 重新开始对话 / 发 /new」',
            '- **禁止**向用户提及换会话、归档、压缩、上下文过长或「失忆」',
            '- 感觉历史太长也照常直接回答；缺历史细节可 read `memory/last-session-archive.md`',
            ''
        ].join('\n');
        fs.appendFileSync(agentsPath, section, 'utf8');
        console.log('[PluginSeed] Appended session continuity guidance to workspace AGENTS.md');
    } catch (e) {
        console.warn('[PluginSeed] ensureSessionContinuityGuidance:', e.message);
    }
}

const FILE_HANDLING_AGENTS_MARKER = '<!-- nexora-file-handling-v1 -->';

/**
 * 文件消息处理规则：用户经微信等渠道发来的文件已下载到本地路径并随消息附带。
 * 不写清楚每类文件怎么处理，模型会假装读过、或对二进制文件乱来。
 */
function ensureFileHandlingGuidance(wsDir) {
    try {
        const agentsPath = path.join(wsDir, 'AGENTS.md');
        if (!fs.existsSync(agentsPath)) return;
        const cur = fs.readFileSync(agentsPath, 'utf8');
        if (cur.includes(FILE_HANDLING_AGENTS_MARKER)) return;
        const section = [
            '',
            '## 文件消息',
            FILE_HANDLING_AGENTS_MARKER,
            '- 用户发来的文件已下载到本地，路径随消息附带（media/attachment 路径）',
            '- 文本类（txt/md/csv/json/log/代码）：直接 `read` 该路径后回答；大文件先读开头，需要再分段读',
            '- PDF：用 `pdf` 工具解析（可带 pages 参数节省 token）',
            '- Word/Excel/PPT（docx/xlsx/pptx）：暂无解析工具——坦诚说明并请用户转成 PDF/文字/截图，**不要假装读过内容**',
            '- 可执行文件或未知二进制：**绝不** `exec` 运行、**绝不**整读进上下文，提醒用户注意安全即可',
            '- 语音已自动转文字、图片已自动生成描述，按文字内容正常回答；视频先确认用户想了解什么',
            ''
        ].join('\n');
        fs.appendFileSync(agentsPath, section, 'utf8');
        console.log('[PluginSeed] Appended file handling guidance to workspace AGENTS.md');
    } catch (e) {
        console.warn('[PluginSeed] ensureFileHandlingGuidance:', e.message);
    }
}

/**
 * 启动时一次性注入规则即可；禁止 AGENTS 再要求「先读 SYSTEM_RULES / MEMORY」导致每轮重复读盘。
 */
function ensureStartupRulesOnceGuidance(wsDir) {
    try {
        const agentsPath = path.join(wsDir, 'AGENTS.md');
        if (!fs.existsSync(agentsPath)) return;
        let cur = fs.readFileSync(agentsPath, 'utf8');
        let changed = false;
        const onceBlock = [
            '## 启动规则（一次性）',
            '- 会话启动上下文已包含 AGENTS / SOUL / TOOLS / MEMORY / SYSTEM_RULES（若有）。',
            '- **不要**再主动 `read` 这些启动文件，除非用户明确要求或启动上下文明显缺失。',
            '- 闲聊、问答、生图/生视频：直接回复，不要额外读大文件。',
            '- 桌面操作细节在 `DESKTOP_RULES.md`：仅在需要操控桌面时再读。',
            ''
        ].join('\n');

        // 改掉「先读 xxx」类指令
        const reReadPatterns = [
            /先读\s*SYSTEM_RULES\.md[，,]\s*再读\s*MEMORY\.md/g,
            /先读\s*`?SYSTEM_RULES\.md`?[，,\s]*再读\s*`?MEMORY\.md`?/gi,
            /每次会话开始.*读.*SYSTEM_RULES/gi
        ];
        for (const re of reReadPatterns) {
            if (re.test(cur)) {
                cur = cur.replace(re, '启动上下文已含 SYSTEM_RULES / MEMORY，勿重复读取');
                changed = true;
            }
        }

        if (!cur.includes('## 启动规则（一次性）') && !cur.includes('不要**再主动 `read` 这些启动文件')) {
            // 插到文首标题后
            if (/^#\s*AGENTS\.md[^\n]*\n/m.test(cur)) {
                cur = cur.replace(/^(#\s*AGENTS\.md[^\n]*\n)/m, `$1\n${onceBlock}`);
            } else {
                cur = onceBlock + '\n' + cur;
            }
            changed = true;
        }

        if (changed) {
            fs.writeFileSync(agentsPath, cur, 'utf8');
            console.log('[PluginSeed] Patched AGENTS.md: startup rules once (no re-read)');
        }
    } catch (e) {
        console.warn('[PluginSeed] ensureStartupRulesOnceGuidance:', e.message);
    }
}

function buildReplyDedupeAgentsSection() {
    return `
## 防双发
${REPLY_DEDUPE_AGENTS_MARKER}
- 普通对话只输出助手正文，**不要**用 \`message\` 工具再发一遍纯文本
- 若本轮必须用 \`message\`/\`sendMedia\`，结尾只能是精确的 \`NO_REPLY\`
- 禁止「工具推送一条 + 口述再一条」；一轮只允许用户看到一条回复
`;
}

function ensureReplyDedupeAgentsGuidance(wsDir) {
    try {
        fs.mkdirSync(wsDir, { recursive: true });
        const agentsPath = path.join(wsDir, 'AGENTS.md');
        if (!fs.existsSync(agentsPath)) return;
        let cur = fs.readFileSync(agentsPath, 'utf8');
        if (cur.includes(REPLY_DEDUPE_AGENTS_MARKER)) return;
        const section = buildReplyDedupeAgentsSection().trim() + '\n';
        if (/##\s*防双发|##\s*Reply Delivery/i.test(cur)) {
            cur = cur
                .replace(/##\s*防双发[\s\S]*?(?=\n##\s|\n<!--|\s*$)/m, '')
                .replace(/##\s*Reply Delivery[\s\S]*?(?=\n##\s|\n<!--|\s*$)/mi, '')
                .trim();
            cur = cur + (cur ? '\n\n' : '') + section;
            fs.writeFileSync(agentsPath, cur, 'utf8');
            console.log('[PluginSeed] Upgraded workspace AGENTS.md reply-dedupe guidance');
            return;
        }
        fs.appendFileSync(agentsPath, '\n' + section, 'utf8');
        console.log('[PluginSeed] Appended reply-dedupe guidance to workspace AGENTS.md');
    } catch (e) {
        console.warn('[PluginSeed] ensureReplyDedupeAgentsGuidance:', e.message);
    }
}

function buildMediaToolsSection() {
    const cliPath = resolveMediaCliScriptPath();
    return `${MEDIA_TOOLS_MARKER}
## 图片/视频生成（必须遵守）
- 用户要生成图片或视频时，**优先**调用工具 \`draw_picture\` / \`draw_video\`
- 若不可用，用 \`exec\`：\`node "${cliPath}" image --prompt "描述"\` 或 \`node "${cliPath}" video --prompt "描述"\`
- **禁止**调用内置 \`image_generate\` / \`video_generate\`（默认无 Google Key，会失败）
- 生成完成后在回复**首行**加入 \`MEDIA:完整绝对路径\`（半角冒号，不要 Markdown/代码块）
- **禁止**输出 \`[[video_media]]\` / \`[[image_media]]\` / \`[[image]]\` / \`[[video]]\` 等占位符——通道不会渲染它们
- 图片约 30–90 秒；**视频常需 2–10 分钟**。用 \`exec\` 时 \`timeout\` 至少 **600**，并用 \`process poll\` 等待
`;
}

function ensureMediaWorkspaceGuidance(wsDir) {
    try {
        fs.mkdirSync(wsDir, { recursive: true });
        const toolsPath = path.join(wsDir, 'TOOLS.md');
        const section = buildMediaToolsSection();
        if (!fs.existsSync(toolsPath)) {
            fs.writeFileSync(toolsPath, section + '\n', 'utf8');
            console.log('[PluginSeed] Seeded workspace TOOLS.md (media guidance)');
            return;
        }
        let cur = fs.readFileSync(toolsPath, 'utf8');
        if (cur.includes(MEDIA_TOOLS_MARKER)) return;
        // 升级旧版 media tools 块（含 v1/v2），补上禁止占位符规则
        if (
            cur.includes(MEDIA_TOOLS_MARKER_LEGACY)
            || cur.includes('<!-- nexora-media-tools-v2 -->')
            || /##\s*图片\/视频生成/.test(cur)
        ) {
            const stripped = cur
                .replace(/<!--\s*nexora-media-tools-v\d+\s*-->[\s\S]*?(?=\n##\s|\n<!--|\s*$)/m, '')
                .replace(/##\s*图片\/视频生成[\s\S]*?(?=\n##\s|\n<!--|\s*$)/m, '')
                .trim();
            cur = section + (stripped ? '\n\n' + stripped + '\n' : '\n');
            fs.writeFileSync(toolsPath, cur, 'utf8');
            console.log('[PluginSeed] Upgraded workspace TOOLS.md media guidance (v3)');
            return;
        }
        fs.writeFileSync(toolsPath, section + '\n\n' + cur, 'utf8');
        console.log('[PluginSeed] Prepended media guidance to workspace TOOLS.md');
    } catch (e) {
        console.warn('[PluginSeed] ensureMediaWorkspaceGuidance:', e.message);
    }
}

function ensureMediaMemoryGuidance(memFile) {
    try {
        const dir = path.dirname(memFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const block = `
## 图片/视频生成
${MEDIA_MEMORY_MARKER}
- 生图/生视频规则见 TOOLS.md（优先 draw_picture / draw_video）
`;
        if (!fs.existsSync(memFile)) return;
        let cur = fs.readFileSync(memFile, 'utf8');
        if (cur.includes(MEDIA_MEMORY_MARKER)) {
            // 旧版长文案压成短指针，避免与 AGENTS/TOOLS 重复
            if (/agnes-media-cli\.js/i.test(cur) && cur.includes(MEDIA_MEMORY_MARKER)) {
                const next = cur.replace(
                    /##\s*图片\/视频生成[\s\S]*?<!--\s*nexora-media-memory-v1\s*-->[\s\S]*?(?=\n##\s|$)/m,
                    block.trim() + '\n'
                );
                if (next !== cur) {
                    fs.writeFileSync(memFile, next, 'utf8');
                    console.log('[PluginSeed] Compacted MEMORY.md media block');
                }
            }
            return;
        }
        fs.appendFileSync(memFile, block, 'utf8');
        console.log('[PluginSeed] Appended media guidance to MEMORY.md');
    } catch (e) {
        console.warn('[PluginSeed] ensureMediaMemoryGuidance:', e.message);
    }
}

function syncMediaCliBundle() {
    try {
        const destDir = path.join(CONFIG_DIR, 'media-cli');
        const srcCandidates = [
            path.join(__dirname, 'media-cli'),
            resolveAppFsPath('media-cli')
        ];
        const src = srcCandidates.find((p) => p && fs.existsSync(path.join(p, 'agnes-media-cli.js')));
        if (!src) {
            console.warn('[PluginSeed] media-cli source not found in app bundle');
            return;
        }
        fs.mkdirSync(destDir, { recursive: true });
        for (const name of fs.readdirSync(src)) {
            const from = path.join(src, name);
            const to = path.join(destDir, name);
            const st = fs.statSync(from);
            if (st.isDirectory()) {
                fs.cpSync(from, to, { recursive: true, force: true });
            } else {
                fs.copyFileSync(from, to);
            }
        }
        console.log('[PluginSeed] Synced media-cli to', destDir);
    } catch (e) {
        console.warn('[PluginSeed] syncMediaCliBundle failed:', e.message);
    }
}

function removeStaleNonPluginExtensionDirs() {
    for (const id of NON_PLUGIN_EXTENSION_DIRS) {
        const stalePluginDir = path.join(CONFIG_DIR, 'extensions', id);
        try {
            if (fs.existsSync(stalePluginDir)) {
                fs.rmSync(stalePluginDir, { recursive: true, force: true });
                console.log(`[PluginSeed] Removed stale extensions/${id} (not a plugin)`);
            }
        } catch (e) {
            console.warn(`[PluginSeed] Failed removing stale extensions/${id}:`, e.message);
        }
    }
}

function syncMediaCoreBundle() {
    try {
        // 禁止落到 extensions/media-core：OpenClaw 会把它当插件根目录并要求 openclaw.plugin.json
        const destExtCore = path.join(CONFIG_DIR, 'media-runtime', 'media-core');
        const destResolve = path.join(CONFIG_DIR, 'extensions', 'media-core-resolve.js');
        const srcCoreCandidates = [
            path.join(__dirname, 'extensions', 'media-core'),
            path.join(__dirname, 'media-cli', 'media-core'),
            resolveAppFsPath('extensions', 'media-core'),
            resolveAppFsPath('media-cli', 'media-core'),
        ];
        const srcCore = srcCoreCandidates.find((p) => p && fs.existsSync(path.join(p, 'index.js')));
        // 无论源是否存在，都先清掉 extensions 下的误种目录
        removeStaleNonPluginExtensionDirs();
        if (!srcCore) {
            console.warn('[PluginSeed] media-core source not found in app bundle');
            return;
        }
        fs.mkdirSync(destExtCore, { recursive: true });
        for (const name of fs.readdirSync(srcCore)) {
            const from = path.join(srcCore, name);
            const to = path.join(destExtCore, name);
            const st = fs.statSync(from);
            if (st.isDirectory()) {
                fs.cpSync(from, to, { recursive: true, force: true });
            } else {
                fs.copyFileSync(from, to);
            }
        }
        const httpCandidates = [
            path.join(__dirname, 'extensions', 'media-http.js'),
            path.join(srcCore, 'media-http.js'),
            resolveAppFsPath('extensions', 'media-http.js'),
        ];
        const httpSrc = httpCandidates.find((p) => p && fs.existsSync(p));
        if (httpSrc) {
            fs.copyFileSync(httpSrc, path.join(destExtCore, 'media-http.js'));
        }
        const resolveCandidates = [
            path.join(__dirname, 'extensions', 'media-core-resolve.js'),
            resolveAppFsPath('extensions', 'media-core-resolve.js'),
        ];
        const resolveSrc = resolveCandidates.find((p) => p && fs.existsSync(p));
        if (resolveSrc) {
            fs.mkdirSync(path.dirname(destResolve), { recursive: true });
            fs.copyFileSync(resolveSrc, destResolve);
        }
        // 再次确保未回写到 extensions（防并发 seed）
        removeStaleNonPluginExtensionDirs();
        console.log('[PluginSeed] Synced media-core to', destExtCore);
    } catch (e) {
        console.warn('[PluginSeed] syncMediaCoreBundle failed:', e.message);
        try { removeStaleNonPluginExtensionDirs(); } catch (e2) {}
    }
}

/** 把 media-core 等非插件目录从 plugins 配置里剔除，防止 Gateway Invalid config */
function sanitizeNonPluginLibraryConfig(config) {
    if (!config || !config.plugins) return { changed: false };
    let changed = false;
    const isNonPluginPath = (p) => {
        if (typeof p !== 'string') return false;
        const n = p.replace(/\\/g, '/').toLowerCase();
        return [...NON_PLUGIN_EXTENSION_DIRS].some((id) =>
            n.endsWith('/extensions/' + id) || n.endsWith('/' + id) || n.includes('/extensions/' + id + '/')
        );
    };
    if (config.plugins.entries) {
        for (const id of Object.keys(config.plugins.entries)) {
            if (NON_PLUGIN_EXTENSION_DIRS.has(id)) {
                delete config.plugins.entries[id];
                changed = true;
            }
        }
    }
    if (Array.isArray(config.plugins.allow)) {
        const next = config.plugins.allow.filter((id) => !NON_PLUGIN_EXTENSION_DIRS.has(id));
        if (next.length !== config.plugins.allow.length) {
            config.plugins.allow = next;
            changed = true;
        }
    }
    if (config.plugins.installs) {
        for (const id of Object.keys(config.plugins.installs)) {
            if (NON_PLUGIN_EXTENSION_DIRS.has(id)) {
                delete config.plugins.installs[id];
                changed = true;
            }
        }
    }
    if (config.plugins.load && Array.isArray(config.plugins.load.paths)) {
        const next = config.plugins.load.paths.filter((p) => !isNonPluginPath(p));
        if (next.length !== config.plugins.load.paths.length) {
            config.plugins.load.paths = next;
            changed = true;
        }
    }
    return { changed };
}

function forceSyncWorkspaceSkill(skillName) {
    try {
        const srcCandidates = [
            path.join(__dirname, 'workspace', 'skills', skillName),
            resolveAppFsPath('workspace', 'skills', skillName)
        ];
        const src = srcCandidates.find((p) => p && fs.existsSync(path.join(p, 'SKILL.md')));
        if (!src) return;
        const dest = path.join(CONFIG_DIR, 'workspace', 'skills', skillName);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true, force: true });
        console.log(`[PluginSeed] Force-synced workspace skill: ${skillName}`);
    } catch (e) {
        console.warn(`[PluginSeed] forceSyncWorkspaceSkill(${skillName}):`, e.message);
    }
}

function seedWorkspaceMediaSkills() {
    for (const skillName of ['image-generator', 'video-generator']) {
        forceSyncWorkspaceSkill(skillName);
    }
}

function ensureMediaOutputDirs() {
    for (const sub of ['media-output', 'image-output', 'video-output', 'screenshots', 'media']) {
        try {
            fs.mkdirSync(path.join(CONFIG_DIR, sub), { recursive: true });
        } catch (e) {}
    }
}

function ensureMediaAgentDefaults(config) {
    // 图片/视频模型配置走侧车文件 media-generator.json，不写 openclaw.json（Schema 不接受）
    return stripNonSchemaOpenClawConfig(config);
}

function seedMediaRuntimeArtifacts(appVersion) {
    try {
        syncMediaCliBundle();
        syncMediaCoreBundle();
        ensureMediaOutputDirs();
        ensureDefaultMediaGeneratorPrefs();
        migrateMediaGeneratorPrefs();
        seedWorkspaceMediaSkills();
        const wsDir = path.join(CONFIG_DIR, 'workspace');
        ensureMediaWorkspaceGuidance(wsDir);
        ensureMediaAgentsGuidance(wsDir);
        ensureReplyDedupeAgentsGuidance(wsDir);
        ensureStartupRulesOnceGuidance(wsDir);
        ensureSessionContinuityGuidance(wsDir);
        ensureFileHandlingGuidance(wsDir);
        try { getSkillCenter().ensureSkillWorkshopGuidance(wsDir); } catch (e) {}
        ensureMediaMemoryGuidance(path.join(wsDir, 'MEMORY.md'));
    } catch (e) {
        console.warn('[PluginSeed] seedMediaRuntimeArtifacts failed:', e.message);
    }
}

function syncBundledInternalHookFiles(hookId) {
    try {
        const srcCandidates = [
            resolveAppFsPath('hooks', hookId),
            path.join(__dirname, 'hooks', hookId)
        ];
        const src = srcCandidates.find((p) => fs.existsSync(path.join(p, 'HOOK.md')));
        if (!src) return false;
        const dest = path.join(CONFIG_DIR, 'hooks', hookId);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(src, dest, { recursive: true, force: true });
        return true;
    } catch (e) {
        console.warn(`[HookSeed] ${hookId}:`, e.message);
        return false;
    }
}

function seedBundledPlugins(options = {}) {
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
        if (options.fast === true && global.__nexoraBundledSeedVersion === appVersion) {
            return;
        }
        const seedStampPath = path.join(CONFIG_DIR, '.nexora-bundled-seed-stamp');
        if (options.fast === true) {
            try {
                if (fs.existsSync(seedStampPath) && fs.readFileSync(seedStampPath, 'utf8').trim() === appVersion) {
                    // 快路径跳过全量目录扫描，但关键运行时插件仍要同步；否则源码修复在
                    // 版本号不变时不会落到用户目录，下一次启动仍会加载旧插件。
                    for (const name of [
                        'session-overflow-rollover',
                        'compaction-memory-guard',
                        'memory-rotate',
                        'auto-summary',
                        'error-filter',
                        'session-tool-heal',
                        'disk-compact',
                        'voice-bridge'
                    ]) {
                        try { syncBundledPluginFiles(name); } catch (_) {}
                    }
                    // 快路径也必须清掉误种的 media-core，并确保 media-runtime 可用
                    try { syncMediaCoreBundle(); } catch (e) {}
                    syncBundledInternalHookFiles('auto-start-codex');
                    global.__nexoraBundledSeedVersion = appVersion;
                    return;
                }
            } catch (e) {}
        }

        const legacyRoot = path.join(CONFIG_DIR, 'plugins');
        if (fs.existsSync(legacyRoot)) {
            try {
                for (const name of fs.readdirSync(legacyRoot)) {
                    if (NON_PLUGIN_EXTENSION_DIRS.has(name)) continue;
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
                    // media-core 等是运行时库，绝不能种到 extensions（OpenClaw 会当插件扫）
                    if (NON_PLUGIN_EXTENSION_DIRS.has(name)) continue;
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
                if (NON_PLUGIN_EXTENSION_DIRS.has(name)) continue;
                const pluginDir = path.join(destRoot, name);
                try {
                    if (fs.statSync(pluginDir).isDirectory()) {
                        ensurePluginPackageJson(pluginDir, name);
                        ensurePluginManifestJson(pluginDir, name);
                    }
                } catch (e) {}
            }
        }

        // 角色管理插件依赖根目录 role-config.js：无论 bundle stamp 是否变化都强制同步
        syncRoleManagerSharedModules();
        // voice-bridge / error-filter / session-tool-heal / disk-compact / overflow-rollover 钩子变更必须立即覆盖用户目录
        syncBundledPluginFiles('voice-bridge');
        syncBundledPluginFiles('error-filter');
        syncBundledPluginFiles('session-tool-heal');
        syncBundledPluginFiles('disk-compact');
        syncBundledPluginFiles('session-overflow-rollover');
        syncBundledPluginFiles('memory-rotate');
        // 本次修复涉及的其余插件也强制覆盖用户目录，避免 .bundle-version 戳导致修复不落地
        syncBundledPluginFiles('weixin-reconnect');
        syncBundledPluginFiles('dual-model-trainer');
        syncBundledPluginFiles('health-check');
        syncBundledPluginFiles('context-router');
        syncBundledPluginFiles('compaction-memory-guard');
        syncBundledPluginFiles('auto-summary');
        for (const name of BUNDLED_EXTENSION_PLUGINS) {
            syncBundledPluginFiles(name);
        }
        seedMediaRuntimeArtifacts(appVersion);
        syncBundledInternalHookFiles('auto-start-codex');
        try { fs.writeFileSync(seedStampPath, appVersion, 'utf8'); } catch (e) {}
        global.__nexoraBundledSeedVersion = appVersion;
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

    try {
        const cleaned = sanitizeNonPluginLibraryConfig(config);
        if (cleaned.changed) needsSave = true;
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

    const channelPathMatchers = [
        { id: 'openclaw-weixin', re: /(?:^|[\\/])openclaw-weixin(?:[\\/]|$)/i },
        { id: 'feishu', re: /[\\/]@openclaw[\\/]feishu(?:[\\/]|$)/i },
        { id: 'openclaw-qqbot', re: /[\\/]@tencent-connect[\\/]openclaw-qqbot(?:[\\/]|$)/i },
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
            // OpenClaw 2026.9 discovers runtime channel packages globally.
            // Keeping their package roots in load.paths loads each id twice.
            drop = true;
            needsSave = true;
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
            // Preserve the user's channel state. Runtime extraction or repair may
            // make the package available on the next probe.
            continue;
        }
        // 即便 bundled 在 Program Files，也优先种到本机 installs 再用；load.paths 仅保留本机可用路径
        if (!pluginPathUsableOnThisMachine(abs) || isForeignUserPath(abs)) {
            console.warn(`[PluginSeed] Skip foreign/missing load path for ${entry.id}: ${abs}`);
            continue;
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
                // 种不进去就彻底删除配置，避免 Doctor 在沙箱缺 npm 时卡死启动
                if (config.plugins.entries[entry.id]) {
                    delete config.plugins.entries[entry.id];
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
                trustedOfficialInstall: true,
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
            if (sanitizeQqbotConfig(config)) needsSave = true;
            const q = config.channels.qqbot;
            const hasQ = !!(q.appId || q.appSecret || q.clientId
                || (q.accounts && Object.keys(q.accounts).length));
            if (hasQ || q.enabled === true) {
                if (q.enabled !== true) { q.enabled = true; needsSave = true; }
                forceOn('openclaw-qqbot');
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

    // -------------------
    // 终极清洗（最后防线）：防止任何已失效的、没装上的幽灵插件依然留在 entries 导致网关卡在 Doctor
    // -------------------
    if (config.plugins && config.plugins.entries) {
        const deadOrUninstalled = [];
        for (const pid of Object.keys(config.plugins.entries)) {
            // 特殊系统/内置组件不删
            if (pid === LONG_TERM_MEMORY_UI_ID || pid === 'system-control') continue;
            
            // 阶段遗留残留
            if (pid.startsWith('.')) { deadOrUninstalled.push(pid); continue; }
            if (pid === 'channel-router' || pid === 'key-rotator-proxy') { deadOrUninstalled.push(pid); continue; }
            
            const b = BUNDLED_NPM_CHANNEL_PLUGINS.find(x => x.id === pid);
            if (b) {
                if (b.viaLoadPaths === false) {
                    const inst = config.plugins.installs && config.plugins.installs[pid];
                    const ok = inst && inst.installPath && fs.existsSync(path.join(inst.installPath, 'package.json'));
                    if (!ok) deadOrUninstalled.push(pid);
                } else {
                    const resolved = resolveBundledNpmPluginPath(b);
                    if (!resolved || !fs.existsSync(resolved)) deadOrUninstalled.push(pid);
                }
            }
        }
        for (const badPid of deadOrUninstalled) {
            delete config.plugins.entries[badPid];
            if (config.plugins.installs) delete config.plugins.installs[badPid];
            if (Array.isArray(config.plugins.allow)) {
                config.plugins.allow = config.plugins.allow.filter(x => x !== badPid);
            }
            needsSave = true;
            console.log(`[PluginSeed] Ultimate Reaper swept ghost plugin: ${badPid}`);
        }
    }

    // -------------------
    // 清扫 ~/.openclaw/npm/projects 里残缺的官方插件缓存副本。
    // OpenClaw 启动时会优先校验这些副本；若其声明的 runtime 入口（dist/*.js）
    // 缺失，整个 Gateway 会以 Invalid config 拒绝启动，即使随包 runtime 完好。
    // -------------------
    try {
        const projectsDir = path.join(CONFIG_DIR, 'npm', 'projects');
        if (fs.existsSync(projectsDir)) {
            for (const projName of fs.readdirSync(projectsDir)) {
                const projDir = path.join(projectsDir, projName);
                let broken = false;
                try {
                    if (!fs.statSync(projDir).isDirectory()) continue;
                    const nmDir = path.join(projDir, 'node_modules');
                    if (!fs.existsSync(nmDir)) continue;
                    const pkgDirs = [];
                    for (const scopeOrPkg of fs.readdirSync(nmDir)) {
                        const p1 = path.join(nmDir, scopeOrPkg);
                        if (scopeOrPkg.startsWith('@')) {
                            for (const sub of fs.readdirSync(p1)) pkgDirs.push(path.join(p1, sub));
                        } else {
                            pkgDirs.push(p1);
                        }
                    }
                    for (const pkgDir of pkgDirs) {
                        const pkgJsonPath = path.join(pkgDir, 'package.json');
                        if (!fs.existsSync(pkgJsonPath)) continue;
                        let meta = null;
                        try { meta = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).openclaw; } catch (e) {}
                        if (!meta) continue;
                        const declared = []
                            .concat(Array.isArray(meta.runtimeExtensions) ? meta.runtimeExtensions : [])
                            .concat(meta.runtimeSetupEntry ? [meta.runtimeSetupEntry] : []);
                        for (const rel of declared) {
                            if (typeof rel !== 'string' || !rel) continue;
                            if (!fs.existsSync(path.join(pkgDir, rel))) { broken = true; break; }
                        }
                        if (broken) break;
                    }
                } catch (e) { continue; }
                if (broken) {
                    try {
                        fs.rmSync(projDir, { recursive: true, force: true });
                        console.log(`[PluginSeed] Removed broken npm/projects plugin cache: ${projName}`);
                    } catch (e) {
                        console.error(`[PluginSeed] Failed to remove broken plugin cache ${projName}:`, e.message);
                    }
                }
            }
        }
    } catch (e) {}
    // Preparation can consume legacy installs metadata, but OpenClaw 2026.9
    // must never receive those retired keys in the persisted document.
    if (stripNonSchemaOpenClawConfig(config)) needsSave = true;

    if (needsSave) {
        writeConfigFileAtomic(JSON.stringify(config, null, 2));
        console.log('[PluginSeed] Pre-gateway channel trust records synced');
        // 切勿删除 openclaw.sqlite：该库含审计事件 / Token / 工具调用等数据中心指标。
        // 插件索引脏数据由 Gateway 下次启动按 config 重建即可。
    }
}

// 忽略证书错误以兼容 Clash 等代理软件的 HTTPS 劫持/解密校验
if (/^(1|true|yes)$/i.test(String(process.env.NEXORA_INSECURE_TLS || ''))) {
    app.commandLine.appendSwitch('ignore-certificate-errors');
}

// 默认单实例：启动期间重复点击只唤醒已有窗口，不再创建一个尚未初始化的隔离实例。
// 需要调试多开时可显式设置 NEXORA_ALLOW_MULTI_INSTANCE=1。
const nexoraSingleInstanceLock = /^(1|true|yes)$/i.test(String(process.env.NEXORA_ALLOW_MULTI_INSTANCE || ''))
    ? true
    : app.requestSingleInstanceLock();
let focusPrimaryWindowWhenReady = false;
if (!nexoraSingleInstanceLock) {
    console.warn('[Instance] another Nexora Agent process is already running; exiting duplicate launch');
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            } catch (_) {}
        } else {
            focusPrimaryWindowWhenReady = true;
        }
    });
}

/** 调试多开：每个实例独占 userData 槽位（-i2/-i3…），默认不会启用。 */
function isPidAlive(pid) {
    const n = Number(pid);
    if (!Number.isFinite(n) || n <= 0) return false;
    try {
        process.kill(n, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function tryAcquireInstanceLock(dir) {
    const lockFile = path.join(dir, '.nexora-instance.lock');
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {}
    const tryCreate = () => {
        const fd = fs.openSync(lockFile, 'wx');
        try {
            fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
        } finally {
            try { fs.closeSync(fd); } catch (e) {}
        }
        return true;
    };
    try {
        return tryCreate();
    } catch (e) {
        try {
            const raw = fs.readFileSync(lockFile, 'utf8');
            const oldPid = parseInt(String(raw).split(/\r?\n/)[0], 10);
            if (!isPidAlive(oldPid)) {
                try { fs.unlinkSync(lockFile); } catch (e2) {}
                return tryCreate();
            }
        } catch (e3) {}
        return false;
    }
}

function releaseInstanceLock(dir) {
    try {
        const lockFile = path.join(dir, '.nexora-instance.lock');
        if (!fs.existsSync(lockFile)) return;
        const raw = fs.readFileSync(lockFile, 'utf8');
        const oldPid = parseInt(String(raw).split(/\r?\n/)[0], 10);
        if (!oldPid || oldPid === process.pid || !isPidAlive(oldPid)) {
            fs.unlinkSync(lockFile);
        }
    } catch (e) {}
}

function acquireNexoraInstanceSlot() {
    const base = app.getPath('userData');
    const max = 8;
    for (let id = 1; id <= max; id++) {
        const dir = id === 1 ? base : `${base}-i${id}`;
        if (!tryAcquireInstanceLock(dir)) continue;
        app.setPath('userData', dir);
        const release = () => releaseInstanceLock(dir);
        app.on('will-quit', release);
        process.on('exit', release);
        return {
            id,
            dir,
            isPrimary: id === 1,
            primaryUserData: base,
            gatewayPortHint: 18789 + (id - 1) * 100
        };
    }
    return null;
}

const nexoraInstance = nexoraSingleInstanceLock ? acquireNexoraInstanceSlot() : null;
if (!nexoraInstance) {
    if (nexoraSingleInstanceLock) {
        console.error('[Instance] 已达到最大多开数量（8），退出');
    }
    app.quit();
} else {
    global.nexoraInstance = nexoraInstance;
    console.log(`[Instance] #${nexoraInstance.id} userData=${nexoraInstance.dir}`);
    // 第 2+ 实例隔离 OpenClaw 状态目录，避免与主实例抢网关/会话
    if (nexoraInstance.id > 1) {
        process.env.NEXORA_INSTANCE_ID = String(nexoraInstance.id);
        process.env.OPENCLAW_HOME = path.join(nexoraInstance.dir, 'openclaw-home');
    }
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
        show: false,
        backgroundColor: '#00000000'
    });
    splash.loadFile('splash.html').catch((err) => {
        appendMainDiagnostic('splash-load-error', err, { file: 'splash.html' });
        try { if (!splash.isDestroyed()) splash.destroy(); } catch (_) {}
    });
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
    const WINDOW_BG = '#06020f';
    mainWindow = new BrowserWindow({
        width: 1120,
        height: 760,
        minWidth: 1120,
        minHeight: 760,
        frame: false,
        resizable: true,
        maximizable: true,
        show: true,
        backgroundColor: WINDOW_BG,
        // 明确不透明，避免还原时透出系统白底
        transparent: false,
        hasShadow: true,
        icon: path.join(__dirname, 'config', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            // 关闭「HTTPS 上下文加载 HTTP 子资源」——主页面是 file://，关掉不影响本地/localhost 加载，
            // 但能减少被嵌 webview 加载明文子资源被 MITM 注入的面。
            allowRunningInsecureContent: false,
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

    // 语音：仅对「应用自身页面」(file:// 的 index.html) 授权麦克风；
    // webview 里加载的第三方/远端内容不得静默拿麦克风（原实现对任意源都放行）。
    const isOwnAppOrigin = (url) => {
        try {
            return String(url || '').startsWith('file:')
                && path.resolve(fileURLToPath(url)) === TRUSTED_RENDERER_ENTRY;
        } catch (_) { return false; }
    };
    const isAllowedEmbeddedLocalUrl = (url) => {
        try {
            const dashboardPort = new URL(buildGatewayDashboardUrl()).port || '80';
            const allowedPorts = new Set([String(dashboardPort)]);
            if (dataCenterRuntime && dataCenterRuntime.port) allowedPorts.add(String(dataCenterRuntime.port));
            return isAllowedLoopbackHttpUrl(url, allowedPorts);
        } catch (_) { return false; }
    };
    const isMediaPermission = (p) => p === 'media' || p === 'microphone' || p === 'audioCapture';
    try {
        session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
            const origin = (details && (details.requestingUrl || details.requestingOrigin)) || (wc && wc.getURL && wc.getURL());
            if (isMediaPermission(permission) && isOwnAppOrigin(origin)) {
                return callback(true);
            }
            callback(false);
        });
        session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
            const origin = requestingOrigin || (wc && wc.getURL && wc.getURL());
            return isMediaPermission(permission) && isOwnAppOrigin(origin);
        });
    } catch (e) {}

    let mainDocumentLoadFailures = 0;
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        mainDocumentLoadFailures += 1;
        appendMainDiagnostic('main-window-load-failed', null, {
            errorCode,
            errorDescription,
            validatedURL,
            attempt: mainDocumentLoadFailures,
        });
        if (mainDocumentLoadFailures <= 2 && !mainWindow.isDestroyed()) {
            setTimeout(() => {
                try {
                    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile('index.html').catch(() => {});
                } catch (_) {}
            }, 500 * mainDocumentLoadFailures);
        }
    });
    mainWindow.loadFile('index.html').catch((err) => {
        appendMainDiagnostic('main-window-load-error', err, { file: 'index.html' });
    });
    try {
        const id = (global.nexoraInstance && global.nexoraInstance.id) || 1;
        mainWindow.setTitle(id > 1 ? `Nexora Agent #${id}` : 'Nexora Agent');
    } catch (e) {}
    // 当渲染进程首次绘制完成后，关闭 splash；静默启动则不弹主窗口（托盘后台）
    let windowRevealed = false;
    const revealWindow = () => {
        if (windowRevealed || !mainWindow || mainWindow.isDestroyed()) return;
        windowRevealed = true;
        markClientBootPhase('window-visible');
        try { if (splash && !splash.isDestroyed()) splash.destroy(); } catch (e) {}
        try { mainWindow.setBackgroundColor(WINDOW_BG); } catch (e) {}
        const silent = isSilentStartEnabled() && process.argv.includes('--silent');
        if (silent) {
            // 只有系统开机带 --silent 参数时才隐式托盘启动
            try { mainWindow.hide(); } catch (e) {}
        } else {
            try {
                mainWindow.center();
                mainWindow.show();
                mainWindow.restore();
                mainWindow.setAlwaysOnTop(true);
                mainWindow.focus();
                focusPrimaryWindowWhenReady = false;
                setTimeout(() => {
                    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false); } catch (e) {}
                }, 500);
            } catch (e) {}
        }
        const id = (global.nexoraInstance && global.nexoraInstance.id) || 1;
        if (id > 1 && !silent) {
            try {
                showNotification(`Nexora Agent 多开 #${id}`, '已使用独立数据目录与端口；系统代理请勿多实例同时开启。');
            } catch (e) {}
        }
    };
    mainWindow.once('ready-to-show', revealWindow);
    // 极慢磁盘上 ready-to-show 可能延迟，但绝不能在主文档仍加载时提前展示空白窗口。
    setTimeout(() => {
        try {
            if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoadingMainFrame()) return;
            revealWindow();
        } catch (_) {}
    }, 8000);

    // 最小化/托盘还原时再刷一次底色，压住 Windows 白闪
    const paintDarkBg = () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.setBackgroundColor(WINDOW_BG);
            }
        } catch (e) {}
    };
    mainWindow.on('restore', paintDarkBg);
    mainWindow.on('show', () => {
        paintDarkBg();
        // 托盘唤起 / 自启后窗口显示时，强制把按钮状态与真实进程对齐
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                const st = gatewayProcess
                    ? 'running'
                    : (gatewayStartInFlight ? 'starting' : 'stopped');
                mainWindow.webContents.send('gateway-status', st);
            }
        } catch (e) {}
    });
    mainWindow.on('focus', () => {
        paintDarkBg();
        try {
            if (mainWindow && !mainWindow.isDestroyed() && gatewayProcess) {
                mainWindow.webContents.send('gateway-status', 'running');
            }
        } catch (e) {}
    });

    let rendererResponsive = true;
    let rendererRecoveryTimer = null;
    let lastRendererRecoveryAt = 0;
    const recoverRenderer = (reason) => {
        if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
        const now = Date.now();
        if (now - lastRendererRecoveryAt < 10000) return;
        lastRendererRecoveryAt = now;
        appendMainDiagnostic('renderer-auto-recovery', null, { reason });
        try { mainWindow.webContents.reload(); } catch (_) {}
    };
    mainWindow.webContents.on('unresponsive', () => {
        rendererResponsive = false;
        appendMainDiagnostic('renderer-unresponsive', null, { url: mainWindow.webContents.getURL() });
        try { showNotification('Nexora Agent 界面正在恢复', '检测到界面长时间无响应，服务会保持运行。'); } catch (_) {}
        if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
        rendererRecoveryTimer = setTimeout(() => {
            rendererRecoveryTimer = null;
            if (!rendererResponsive) recoverRenderer('unresponsive-timeout');
        }, 15000);
    });
    mainWindow.webContents.on('responsive', () => {
        rendererResponsive = true;
        if (rendererRecoveryTimer) {
            clearTimeout(rendererRecoveryTimer);
            rendererRecoveryTimer = null;
        }
        appendMainDiagnostic('renderer-responsive');
    });
    mainWindow.webContents.on('did-finish-load', () => {
        rendererResponsive = true;
        if (rendererRecoveryTimer) {
            clearTimeout(rendererRecoveryTimer);
            rendererRecoveryTimer = null;
        }
    });
    mainWindow.webContents.on('render-process-gone', (event, details) => {
        rendererResponsive = false;
        appendMainDiagnostic('main-window-render-process-gone', null, details || {});
        if (!isQuitting && (!details || details.reason !== 'clean-exit')) {
            setTimeout(() => recoverRenderer((details && details.reason) || 'render-process-gone'), 800);
        }
    });

    // 仅对「本地控制台(127.0.0.1/localhost)」响应移除 X-Frame-Options / CSP，让内置 iframe 能嵌入；
    // 远端内容一律保留其 CSP / XFO（原实现对所有响应全局剥离 = 任何被嵌页面都失去 CSP 防护）。
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        let isLocal = false;
        try {
            isLocal = isAllowedEmbeddedLocalUrl(details.url);
        } catch (_) {}
        if (!isLocal) {
            return callback({ cancel: false, responseHeaders: details.responseHeaders });
        }
        const responseHeaders = { ...details.responseHeaders };
        ['x-frame-options', 'X-Frame-Options', 'content-security-policy', 'Content-Security-Policy']
            .forEach(hd => { delete responseHeaders[hd]; });
        callback({ cancel: false, responseHeaders });
    });

    // 导航守卫：禁止主框架被导航到外部源、禁止 window.open 打开新窗口、净化 webview 权限。
    // 配合 webSecurity:false，防止被注入内容把主页面导去攻击者站点后再放大权限。
    try {
        const allowNavigate = (url) => isOwnAppOrigin(url);
        mainWindow.webContents.on('will-navigate', (ev, url) => {
            if (!allowNavigate(url)) { ev.preventDefault(); try { require('electron').shell.openExternal(url); } catch (_) {} }
        });
        mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            // 外链交给系统浏览器（open-external 已限定 http/https），不在应用内开新窗口
            if (/^https?:\/\//i.test(String(url || ''))) { try { require('electron').shell.openExternal(url); } catch (_) {} }
            return { action: 'deny' };
        });
        mainWindow.webContents.on('will-attach-webview', (ev, webPreferences, params) => {
            if (params && params.src && !isAllowedEmbeddedLocalUrl(params.src)) {
                appendMainDiagnostic('webview-navigation-blocked', null, { url: String(params.src) });
                ev.preventDefault();
                return;
            }
            // 净化 webview 的进程权限：禁 nodeIntegration、强制隔离，去掉可能被传入的 preload
            webPreferences.nodeIntegration = false;
            webPreferences.contextIsolation = true;
            webPreferences.webSecurity = true;
            webPreferences.allowRunningInsecureContent = false;
            delete webPreferences.preload;
            delete webPreferences.preloadURL;
        });
    } catch (e) {}



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

    // 同步渲染进程 localStorage 偏好到 userData，再按设置决定是否兜底拉起网关
    mainWindow.webContents.once('did-finish-load', () => {
        const syncAndMaybeStart = async () => {
            try {
                const settingsPath = autoLaunchGatewaySettingsPath();
                if (!fs.existsSync(settingsPath)) {
                    const v = await mainWindow.webContents.executeJavaScript(
                        `try { localStorage.getItem('setting_auto_launch_gateway') } catch (e) { null }`
                    );
                    if (v === 'false') setAutoLaunchGatewayEnabled(false);
                    else if (v === 'true') setAutoLaunchGatewayEnabled(true);
                }
            } catch (e) {}
            try {
                if (!isAutoLaunchGatewayEnabled()) return;
                startGatewayProcess({ source: 'autostart' });
                // 自启后补几次状态推送，避免渲染进程还没挂上监听时漏掉 running
                const push = () => {
                    try {
                        if (!mainWindow || mainWindow.isDestroyed()) return;
                        if (gatewayProcess) mainWindow.webContents.send('gateway-status', 'running');
                        else if (gatewayStartInFlight) mainWindow.webContents.send('gateway-status', 'starting');
                    } catch (e) {}
                };
                setTimeout(push, 1200);
                setTimeout(push, 3000);
                setTimeout(push, 6000);
            } catch (e) {
                console.warn('[Gateway] boot auto-start failed:', e && e.message);
            }
        };
        setTimeout(() => { syncAndMaybeStart(); }, 800);
    });
}

// 创建系统托盘
function createTray() {
    tray = new Tray(path.join(__dirname, 'config', 'icon.png')); // 使用机器人高级图标
    const contextMenu = Menu.buildFromTemplate([
        { 
            label: '显示主界面', 
            click: () => {
                try { mainWindow.setBackgroundColor('#06020f'); } catch (e) {}
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
                try { acceleration.stopCore(); } catch (e) {}
                stopGatewayProcess();
                app.quit();
            } 
        }
    ]);
    tray.setToolTip('Nexora Agent');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
        try { mainWindow.setBackgroundColor('#06020f'); } catch (e) {}
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

// 异步非阻塞执行命令；默认带超时，避免启动网关时卡死在 Get-CimInstance 扫全机 node
function execAsync(cmd, timeoutMs = 20000) {
    const { exec } = require('child_process');
    return new Promise((resolve) => {
        let settled = false;
        const child = exec(cmd, { windowsHide: true }, (err, stdout) => {
            if (settled) return;
            settled = true;
            resolve(stdout || '');
        });
        if (timeoutMs > 0) {
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { child.kill(); } catch (e) {}
                console.warn(`[execAsync] timeout ${timeoutMs}ms: ${String(cmd).slice(0, 120)}`);
                resolve('');
            }, timeoutMs);
            child.on('exit', () => clearTimeout(timer));
        }
    });
}

/** 与 execAsync 相同，但命令失败（非零退出/无法执行/超时）时 reject —— 供需要感知成败的调用方（如 taskkill 兜底）使用 */
function execAsyncStrict(cmd, timeoutMs = 20000) {
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = exec(cmd, { windowsHide: true }, (err, stdout) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve(stdout || '');
        });
        if (timeoutMs > 0) {
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { child.kill(); } catch (e) {}
                reject(new Error(`exec timeout ${timeoutMs}ms: ${String(cmd).slice(0, 120)}`));
            }, timeoutMs);
            child.on('exit', () => clearTimeout(timer));
        }
    });
}

/** 只杀占用指定端口的进程（快、可超时）；不要扫全机 node.exe */
async function killPidsListeningOnPort(port, excludePids = []) {
    const exclude = new Set((excludePids || []).map((p) => String(p)).filter(Boolean));
    const portToken = `:${Number(port)}`;
    try {
        const netstatOut = await execAsync('netstat -ano', 8000);
        const pids = new Set();
        for (const line of String(netstatOut || '').split(/\r?\n/)) {
            if (!line.includes(portToken) || !/LISTENING/i.test(line)) continue;
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && /^\d+$/.test(pid) && !exclude.has(pid) && Number(pid) > 0) {
                pids.add(pid);
            }
        }
        let killed = 0;
        for (const pid of pids) {
            try {
                // 安全护栏：只结束 node.exe（我们的网关就是 node 进程）。
                // 否则若 18789 被无关的第三方软件占用，会连它整棵进程树一起强杀、可能导致对方数据丢失。
                const imageLine = await execAsync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, 5000);
                if (!/(^|[",])"?node\.exe"?/i.test(String(imageLine || ''))) {
                    console.warn(`[Gateway] port ${port} held by non-node PID ${pid}; refuse to kill unrelated process`);
                    continue;
                }
                await execAsync(`taskkill /pid ${pid} /F /T`, 8000);
                killed += 1;
            } catch (e) {}
        }
        return killed;
    } catch (e) {
        return 0;
    }
}

/** 渠道绑定/改配后热重载网关（防抖；先完整停再启，避免 setTimeout 竞态导致新凭证未加载） */
let gatewayChannelReloadTimer = null;
let gatewayChannelReloadInFlight = false;
// 一次重载进行中又收到新的改配：记下待处理请求，本轮结束后补跑一次，避免新配置被静默丢弃
let gatewayChannelReloadPending = null;
/**
 * @param {string} reason
 * @param {{ startIfStopped?: boolean }} [opts]
 *   startIfStopped 已废弃：未运行时禁止由渠道自动启用，仅热重载「已在运行」的实例
 */
function scheduleGatewayReloadAfterChannelChange(reason, opts = {}) {
    const label = String(reason || 'channel-change');
    const wantedStartIfStopped = opts.startIfStopped === true;
    if (gatewayChannelReloadTimer) {
        clearTimeout(gatewayChannelReloadTimer);
        gatewayChannelReloadTimer = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
            'gateway-log',
            `\n[System] 渠道已更新（${label}），正在热重载网关以使配置立即生效...\n`
        );
        mainWindow.webContents.send('channel-gateway-reloading', { reason: label });
    }
    gatewayChannelReloadTimer = setTimeout(async () => {
        gatewayChannelReloadTimer = null;
        if (gatewayChannelReloadInFlight) {
            // 本轮重载还在跑：记下最新请求，等它结束后补跑，别丢
            gatewayChannelReloadPending = { reason: label, opts };
            return;
        }
        const wasRunning = !!gatewayProcess || !!gatewayStartInFlight;
        if (!wasRunning) {
            if (wantedStartIfStopped && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                    'gateway-log',
                    `[System] 渠道配置已保存（${label}），但网关未运行。已禁止渠道自动启用，请点击左上角手动启动。\n`
                );
            }
            return;
        }
        gatewayChannelReloadInFlight = true;
        try {
            // 热重载不是“真正停止”：保留 Clash/系统代理，也不要抹掉崩溃恢复预算。
            // 若此时仍在启动阶段，必须取消 in-flight 启动，否则旧流程可能在本轮重载后继续 fork。
            await stopGatewayProcess({
                preserveClash: true,
                preserveCrashBudget: true,
                cancelInFlightStart: !gatewayProcess && !!gatewayStartInFlight
            });
            // Windows 杀进程/释放 18789 需要一点余量
            await new Promise((r) => setTimeout(r, 1000));
            await withGatewayRestartPermit(() => startGatewayProcess({ source: 'reload' }));
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                    'gateway-log',
                    `[System] 渠道热重载完成（${label}），新绑定通道已就绪。\n`
                );
            }
        } catch (e) {
            console.warn('[Gateway] channel reload failed:', e && e.message);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                    'gateway-log',
                    `[System] 渠道热重载失败（${label}）: ${(e && e.message) || e}\n`
                );
            }
        } finally {
            gatewayChannelReloadInFlight = false;
            // 期间若有被搁置的改配，补跑一次（用最新一次的原因/选项）
            if (gatewayChannelReloadPending) {
                const next = gatewayChannelReloadPending;
                gatewayChannelReloadPending = null;
                scheduleGatewayReloadAfterChannelChange(next.reason, next.opts);
            }
        }
    }, 600);
}

// 停止后台Nexora Agent子进程
function clearGatewayRuntimeLogsForFreshStart() {
    const names = [
        'gateway_stdout.log',
        'gateway_stderr.log',
        'gateway-output.log',
        'gateway-error.log',
    ];
    for (const name of names) {
        try {
            const target = path.join(CONFIG_DIR, name);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            try {
                const stat = fs.statSync(target);
                if (stat.size > 0) {
                    const previous = `${target}.previous`;
                    try { if (fs.existsSync(previous)) fs.unlinkSync(previous); } catch (_) {}
                    const buf = fs.readFileSync(target);
                    fs.writeFileSync(previous, buf.slice(Math.max(0, buf.length - 2 * 1024 * 1024)));
                }
            } catch (_) {}
            fs.writeFileSync(target, '', 'utf8');
        } catch (e) {}
    }
}

async function stopGatewayProcess(opts = {}) {
    const preserveClash = opts.preserveClash === true;
    if (opts.preserveCrashBudget !== true) {
        resetGatewayCrashRestartBudget();
    }
    // 清掉待触发的渠道 crash-breaker override 定时器，否则它可能在网关已停/新实例上误触发
    if (channelBreakerOverrideTimer) {
        clearTimeout(channelBreakerOverrideTimer);
        channelBreakerOverrideTimer = null;
    }
    // 用户在启动进行中（子进程尚未 fork）点停止：请求取消 in-flight 启动，并等它自行中止，
    // 否则停止会被静默吞掉、启动流程照常 fork 出网关。cancelInFlightStart 仅由外部停止入口传入，
    // 启动流程内部 terminateOldGatewayBeforeStart 调用本函数时不带该标记，避免自我取消。
    if (opts.cancelInFlightStart && !gatewayProcess && gatewayStartInFlight) {
        gatewayStartCancelRequested = true;
        try { await gatewayStartInFlight; } catch (e) {}
        // 启动流程中止后若确实没 fork 出进程，补一次端口清理并推送 stopped
        if (!gatewayProcess) {
            if (process.platform === 'win32') {
                try { await killPidsListeningOnPort(resolveConfiguredGatewayPort(), [process.pid, process.ppid]); } catch (e) {}
            }
            if (mainWindow && !mainWindow.isDestroyed() && !preserveClash) {
                mainWindow.webContents.send('gateway-status', 'stopped');
                mainWindow.webContents.send('gateway-log', '\n[System] 已取消启动，Nexora Agent服务未运行。\n');
            }
            return;
        }
        // 若在等待期间启动流程已 fork 完成，则走下面正常停止逻辑
    }
    if (gatewayProcess) {
        gatewayProcess.isIntentionallyStopped = true; // 标记为主动停止，避免触发意外退出警报
        const pid = gatewayProcess.pid;
        if (process.platform === 'win32') {
            try {
                // 用 strict 版本：taskkill 失败会真的抛错，下面的 SIGKILL 兜底才不是死代码
                if (pid) await execAsyncStrict(`taskkill /pid ${pid} /T /F`, 8000);
            } catch (err) {
                console.warn('[Gateway] taskkill failed, fallback to SIGKILL:', err && err.message);
                try { if (gatewayProcess) gatewayProcess.kill('SIGKILL'); } catch (e) {}
            }
            // 只清本实例端口，避免全机扫 node 卡死
            try {
                const port = resolveConfiguredGatewayPort();
                await killPidsListeningOnPort(port, [process.pid, process.ppid]);
            } catch (err) {}
        } else {
            // mac/linux：先给优雅退出窗口（避免会话/sqlite 半写损坏），仍存活再 SIGKILL；
            // 用负 pid 杀整个进程组，回收网关自己 spawn 的通道 worker（否则成孤儿占端口）
            const proc = gatewayProcess;
            const killTree = (sig) => {
                try { process.kill(-proc.pid, sig); } catch (e) {
                    try { proc.kill(sig); } catch (e2) {}
                }
            };
            killTree('SIGTERM');
            await new Promise((r) => setTimeout(r, 1500));
            let alive = true;
            try { process.kill(proc.pid, 0); } catch (e) { alive = false; }
            if (alive) killTree('SIGKILL');
        }
        // Linkage: Stop Clash (if enabled in settings) when Agent stops — 仅为「真正停止」时联动，启用前清旧进程不关 Clash
        if (!preserveClash) {
            try {
                const st = acceleration.getStatus();
                if (st.enabled) {
                    console.log('[Linkage] Stopping Nexora Clash core on Agent stop...');
                    await acceleration.stopCore();
                    await acceleration.applySystemProxy(false);
                    await applyElectronSessionProxy(false);
                }
            } catch (e) {
                console.warn('[Linkage] Clash stop linkage error:', e.message);
            }
        }

        gatewayProcess = null;
        stopGatewayHttpReadyWatch();
        gatewayHttpReadyNotified = false;
        if (mainWindow && !preserveClash) {
            mainWindow.webContents.send('gateway-status', 'stopped');
            mainWindow.webContents.send('gateway-log', '\n[System] Nexora Agent服务已停止。\n');
            // 不在此处 clear-logs：避免刚写入的停止提示立刻被清空；清屏由下次「启动」或用户手动清空负责
        }
    } else if (process.platform === 'win32') {
        // 无本进程子句柄时，仍尝试清端口孤儿，避免「启用」叠在旧程序上
        try {
            const port = resolveConfiguredGatewayPort();
            await killPidsListeningOnPort(port, [process.pid, process.ppid]);
        } catch (err) {}
    }
}

/** 启用前强制终止旧网关（本进程子进程 + 端口占用），再允许 fork */
async function terminateOldGatewayBeforeStart(port) {
    const targetPort = Number(port) > 0 ? Number(port) : resolveConfiguredGatewayPort();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
            'gateway-log',
            `[System] 启用前先终止旧的 Nexora Agent / 网关进程（端口 ${targetPort}）...\n`
        );
    }
    try {
        await stopGatewayProcess({ preserveClash: true, preserveCrashBudget: true });
    } catch (e) {
        console.warn('[Gateway] terminate old child failed:', e && e.message);
    }
    gatewayProcess = null;
    stopGatewayHttpReadyWatch();
    gatewayHttpReadyNotified = false;

    const instanceId = (global.nexoraInstance && global.nexoraInstance.id) || 1;
    if (process.platform === 'win32' && instanceId <= 1) {
        try {
            const killed = await killPidsListeningOnPort(targetPort, [process.pid, process.ppid]);
            if (killed > 0 && mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(
                    'gateway-log',
                    `[System] 已结束占用端口 ${targetPort} 的 ${killed} 个旧进程。\n`
                );
            }
        } catch (e) {
            console.warn('[Gateway] port reclaim before start failed:', e && e.message);
        }
    }

    // 等待端口真正空闲，避免旧进程未退干净就叠启
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const busy = await probeGatewayPort(targetPort, 400);
        if (!busy) break;
        if (process.platform === 'win32' && instanceId <= 1) {
            try { await killPidsListeningOnPort(targetPort, [process.pid, process.ppid]); } catch (e) {}
        }
        await new Promise((r) => setTimeout(r, 350));
    }
    if (await probeGatewayPort(targetPort, 400)) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
                'gateway-log',
                `[System] 警告：端口 ${targetPort} 仍被占用，将继续尝试启动（若失败请手动结束旧进程）。\n`
            );
        }
    } else if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(
            'gateway-log',
            `[System] 旧进程已清理，端口 ${targetPort} 空闲，开始启用。\n`
        );
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
// 启用（从停止拉起）仅允许：manual（手动）、autostart（设置自动启用）
// reload / update 仅主进程内部热重载/更新流程可用，且必须带内部许可标记
const IPC_GATEWAY_START_SOURCES = new Set(['manual', 'autostart']);
const INTERNAL_GATEWAY_RESTART_SOURCES = new Set(['reload', 'update']);
let gatewayInternalRestartPermit = 0;

async function withGatewayRestartPermit(fn) {
    gatewayInternalRestartPermit += 1;
    try {
        return await fn();
    } finally {
        gatewayInternalRestartPermit = Math.max(0, gatewayInternalRestartPermit - 1);
    }
}

function notifyGatewayStartBlocked(source, detail) {
    const src = String(source || 'unknown');
    const why = detail || src;
    console.warn('[Gateway] start blocked, source=', src);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        mainWindow.webContents.send(
            'gateway-log',
            `\n[System] 已拦截非授权启动（来源: ${why}）。仅允许：左上角手动启动，或系统设置「自动启用 Nexora Agent」。\n`
        );
        mainWindow.webContents.send('gateway-start-blocked', { source: src });
        mainWindow.webContents.send('gateway-status', 'stopped');
    } catch (e) {}
}

async function startGatewayProcess(opts = {}) {
        const source = String((opts && opts.source) || 'unknown');
        if (gatewayStartInFlight) return gatewayStartInFlight;
        // 幂等护栏：任何重复的 start 请求（包括旧版渲染层/托盘/自动启动竞态）
        // 在已有健康子进程时直接复用，绝不再次 terminate + fork 导致会话断流。
        if (
            gatewayProcess
            && !gatewayProcess.killed
            && gatewayProcess.exitCode == null
            && gatewayProcess.signalCode == null
        ) {
            return Promise.resolve(gatewayProcess);
        }

        const ipcOk = IPC_GATEWAY_START_SOURCES.has(source);
        const internalOk = INTERNAL_GATEWAY_RESTART_SOURCES.has(source) && gatewayInternalRestartPermit > 0;
        if (!ipcOk && !internalOk) {
            notifyGatewayStartBlocked(source);
            return;
        }
        // 设置已关时，静默拒绝 autostart（勿弹「被拦截」以免误导手动启动场景）
        if (source === 'autostart' && !isAutoLaunchGatewayEnabled()) {
            return;
        }

        // 手动/设置自启代表用户明确开启新一轮生命周期，应清掉旧的崩溃预算；
        // reload/update（尤其是崩溃自动恢复）必须保留预算，避免无限重启环。
        if (source === 'manual' || source === 'autostart') {
            resetGatewayCrashRestartBudget();
        } else {
            clearGatewayCrashRestartSchedule();
        }
        gatewayStartCancelRequested = false;
        gatewayLastStartSource = source;
        gatewayStartInFlight = (async () => {
        try {
        const preferredGatewayPort = resolveConfiguredGatewayPort();
        const startupStartedAt = Date.now();
        const markStartupPhase = (phase) => {
            const elapsedMs = Date.now() - startupStartedAt;
            console.log(`[GatewayStartup] ${phase} +${elapsedMs}ms`);
            // Keep timing useful without adding synchronous disk I/O to the
            // critical startup path.
            setImmediate(() => appendMainDiagnostic('gateway-start-phase', null, { phase, elapsedMs, source }));
        };
        // 先把 UI 打到 starting，避免清理端口时界面长时间假“空闲/运行中”
        if (mainWindow) {
            mainWindow.webContents.send('gateway-status', 'starting');
            mainWindow.webContents.send('gateway-log', `[System] 正在准备启动 Gateway（端口 ${preferredGatewayPort}，来源: ${source}）...\n`);
        }

        // 启用前必须先终止旧程序（本进程子进程 + 端口孤儿），禁止叠在旧实例上启用
        await withStartupTimeout(
            terminateOldGatewayBeforeStart(preferredGatewayPort),
            20_000,
            '清理旧 Gateway'
        );

        try {
            // Runtime extraction and the bundled Node health probe touch
            // independent paths; run them together so a cold packaged start
            // does not pay both latencies back-to-back.
            await Promise.all([
                withStartupTimeout(waitForGatewayRuntimeReady(), 120_000, '准备 Gateway 运行时'),
                withStartupTimeout(checkAndHealSandboxNode(), 90_000, '检查内置 Node 环境')
            ]);
            markStartupPhase('runtime-preflight-ready');
        } catch (err) {
            console.error('[SandboxCheck] Error during check and heal:', err);
            appendMainDiagnostic('gateway-start-preflight-failed', err, { source });
            if (mainWindow) {
                mainWindow.webContents.send('gateway-status', 'stopped');
                mainWindow.webContents.send('gateway-log', `[System] 环境自愈升级出错: ${err.message}\n`);
            }
            showNotification('环境自愈失败', err.message);
            if (!gatewayStartCancelRequested && !isQuitting) scheduleGatewayCrashRestart(-3);
            return;
        }

        // 多开时：主实例再兜底清一次端口；第 2+ 实例绝不杀其它实例的网关
        const instanceId = (global.nexoraInstance && global.nexoraInstance.id) || 1;
        if (process.platform === 'win32' && instanceId <= 1) {
            try {
                if (await probeGatewayPort(preferredGatewayPort)) {
                    const killed = await killPidsListeningOnPort(
                        preferredGatewayPort,
                        [process.pid, process.ppid]
                    );
                    if (killed > 0 && mainWindow) {
                        mainWindow.webContents.send(
                            'gateway-log',
                            `[System] 启动前再次回收端口 ${preferredGatewayPort} 残留 ${killed} 个进程。\n`
                        );
                    }
                    await new Promise((r) => setTimeout(r, 400));
                }
            } catch (err) {
                console.error('Failed to cleanup leftover gateway port processes:', err);
            }
        }

        // 每次启动前先清空磁盘日志，避免 UI / 诊断读到上一轮残留
        clearGatewayRuntimeLogsForFreshStart();

        if (mainWindow) {
            mainWindow.webContents.send('gateway-status', 'starting');
            mainWindow.webContents.send('gateway-clear-logs');
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
                try { syncActiveRoleToSoulMd(); } catch (e2) {}
            } catch (e) {}

            // 部署补丁到可写目录（Doctor 迁移 / harden 依赖最新脚本）
            try { deployRuntimeArtifacts(); } catch (e) {}
            markStartupPhase('runtime-artifacts-ready');

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
                    writeConfigFileAtomic(JSON.stringify(cfg, null, 2));
                    try { prepareChannelPluginsBeforeGateway(); } catch (e2) {}
                }
            } catch (e) {
                console.warn('[GatewayBoot] harden skipped:', e.message);
            }

            // 部署内置自定义插件到用户状态目录
            seedBundledPlugins({ fast: true });
            markStartupPhase('bundled-plugins-ready');
            // 启动Nexora Agent前再跑一次延迟收紧，确保磁盘上的配置已是“快配置”
            try {
                if (fs.existsSync(CONFIG_PATH)) {
                    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
                    const parsed = JSON.parse(raw);
                    const tuned = ensureLatencySafeConfig(parsed);
                    const vision = ensureVisionModelConfig(tuned.config);
                    const bootCfg = vision.config;
                    if (tuned.changed || vision.changed) {
                        writeConfigFileAtomic(JSON.stringify(bootCfg, null, 2));
                        if (tuned.changed) console.log('[LatencyTune] Pre-gateway:', tuned.changes.join(' | '));
                        if (vision.changed) console.log('[VisionModel] Pre-gateway:', vision.visionModel);
                    }
                    // 小窗口：再压一次 workspace AGENTS.md + 过大会话 / 卡死 compaction
                    // 顺序：先截断（可能切出坏 tool 对/角色错序），再修 tool 回合——反过来截断产生的损伤没人修
                    try {
                        healOllamaContextOverflowOnBoot();
                        healBrokenToolTurnsOnBoot();
                    } catch (e2) {}
                }
            } catch (e) {
                console.warn('[LatencyTune] pre-gateway skipped:', e.message);
            }

            // 最终锁定鉴权（写主配置 + 同步历史双目录）；必须在 fork 之前
            let lockedAuth = lockGatewayAuthBeforeStart();

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
            // 2026.9+ 的共享状态库要求显式 Doctor 迁移；每个内核版本只跑一次，
            // 且始终使用与随后 Gateway 完全相同的 home/state/config 环境。
            if (nodeExePath) {
                const migrationEnv = buildGatewayChildEnv(process.env, {
                    homePath: lockedAuth.homePath,
                    stateDir: lockedAuth.stateDir,
                    token: lockedAuth.token
                });
                const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
                migrationEnv[pathKey] = `${path.dirname(nodeExePath)}${path.delimiter}${process.env[pathKey] || ''}`;
                const migration = await withStartupTimeout(
                    ensureOpenClawPostUpgradeMigration({
                        nodeExePath,
                        openclawEntry,
                        stateDir: lockedAuth.stateDir,
                        env: migrationEnv
                    }),
                    180_000,
                    '迁移 OpenClaw 配置与状态'
                );
                if (migration && migration.migrated) {
                    ensureOpenClawConfigInitialized();
                    lockedAuth = lockGatewayAuthBeforeStart();
                    markStartupPhase('openclaw-post-upgrade-migrated');
                }
            }
            // OpenClaw 2026.9 将共享认证档案迁入 state/openclaw.sqlite。
            // 历史 models.json 中的占位 key 可能已经被迁成 agnes-ai:default，且其
            // 优先级高于当前 provider key；每次 fork 前快速对齐，避免首发 401 后重试。
            try {
                if (fs.existsSync(CONFIG_PATH)) {
                    const authConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
                    const prepared = ensureAgnesAuthProfileConfig(authConfig);
                    if (prepared.changed) {
                        writeConfigFileAtomic(JSON.stringify(authConfig, null, 2));
                        lockedAuth = lockGatewayAuthBeforeStart();
                    }
                    if (prepared.apiKey) {
                        const authSync = syncAgnesAuthProfileToState({
                            stateDir: lockedAuth.stateDir,
                            apiKey: prepared.apiKey
                        });
                        if (authSync.changed) {
                            console.log(`[AgnesAuth] Repaired ${authSync.mode || 'auth-store'} profile fingerprint=${authSync.fingerprint}`);
                            markStartupPhase('agnes-auth-profile-ready');
                        }
                    }
                }
            } catch (e) {
                console.warn('[AgnesAuth] Pre-gateway profile sync skipped:', e.message);
            }
            // 强制子进程继承与主进程完全一致的 OPENCLAW_* + OPENCLAW_GATEWAY_TOKEN，杜绝补丁重算家目录后丢 token
            const childEnv = buildGatewayChildEnv(process.env, {
                homePath: lockedAuth.homePath,
                stateDir: lockedAuth.stateDir,
                token: lockedAuth.token
            });
            // 加速通道开启时为网关注入本地 mihomo 代理；关闭时剥离继承的系统代理
            try { acceleration.applyProxyToEnvObject(childEnv); } catch (e) {}
            // 默认开启 TLS 校验（原先全关 = 网关所有出站可被中间人）。
            // 仅当用户显式设 NEXORA_INSECURE_TLS=1（如自签名的内网中转）时才关闭。
            if (/^(1|true|yes)$/i.test(String(process.env.NEXORA_INSECURE_TLS || ''))) {
                childEnv.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            }
            childEnv.NEXORA_AGENT_PATCH_PATH = patchPath;
            // 显式传入前置的 NODE_OPTIONS (如果想继承其他的，改从 baseEnv 中取)
            childEnv.NODE_OPTIONS = buildPatchedNodeOptions(patchPath, childEnv.NODE_OPTIONS);
            childEnv.NEXORA_AGENT_RUNTIME_DIR = path.dirname(patchPath);
            childEnv.OPENCLAW_SUPPRESS_CRASH_BREAKER = 'true';
            childEnv.OPENCLAW_IGNORE_UNCLEAN_BOOTS = 'true';
            childEnv.OPENCLAW_RESET_RESTART_LOOP = 'true';
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

            // Linkage: Start Clash (if enabled in settings) before starting Agent process
            try {
                const st = acceleration.getStatus();
                if (st.enabled && st.activeProfileId) {
                    console.log('[Linkage] Starting Nexora Clash before gateway fork...');
                    await Promise.race([
                        acceleration.setEnabled(true, st.activeProfileId),
                        new Promise((_, r) => setTimeout(() => r(new Error('Clash startup timeout')), 5000))
                    ]).catch(e => console.warn('[Linkage] Clash startup bypass:', e.message));
                    await applyElectronSessionProxy(true);
                    try { acceleration.applyProxyToEnvObject(childEnv); } catch (e) {}
                }
            } catch (e) {
                console.warn('[Linkage] Clash startup linkage error before gateway fork:', e.message);
            }

            // 强行清除上一次异常退出的网关租期锁，防止第二次启动时卡死在 startup migrations running
            try {
                const sqlitePath = path.join(lockedAuth.stateDir, 'state', 'openclaw.sqlite');
                if (fs.existsSync(sqlitePath)) {
                    execSqliteStatementsWithSandbox(sqlitePath, "DELETE FROM state_leases WHERE scope = 'startup-migrations';");
                    console.log('[TokenGuard] Automatically cleared stale startup-migrations lease lock in SQLite state db.');
                }
            } catch (e) {
                console.warn('[TokenGuard] Failed to clear stale startup-migrations lease lock:', e.message);
            }

            // 自动清除崩塌保护器 (Restart-loop breaker)，保证微信/QQ/飞书通道永远正常唤起启动
            // OpenClaw 真实状态在 gateway_boot_lifecycle（不是 state_leases / kv_store）
            try {
                const stateDir = lockedAuth.stateDir;
                const breakerFiles = [
                    path.join(stateDir, 'stability-breaker.json'),
                    path.join(stateDir, 'crash-loop-breaker.json'),
                    path.join(stateDir, 'restart-loop-breaker.json'),
                    path.join(stateDir, 'unclean-boots.json'),
                    path.join(stateDir, 'state', 'restart-loop.json'),
                    path.join(stateDir, 'state', 'crash-loop-breaker.json')
                ];
                breakerFiles.forEach(f => {
                    if (fs.existsSync(f)) {
                        try { fs.unlinkSync(f); console.log(`[TokenGuard] Reset restart-loop breaker file: ${f}`); } catch (e) {}
                    }
                });

                const sqlitePath = path.join(stateDir, 'state', 'openclaw.sqlite');
                if (fs.existsSync(sqlitePath)) {
                    try {
                        execSqliteStatementsWithSandbox(sqlitePath, [
                            "DELETE FROM gateway_boot_lifecycle",
                            "DELETE FROM state_leases WHERE scope LIKE '%breaker%' OR scope LIKE '%crash%'", 
                            "DELETE FROM kv_store WHERE key LIKE '%restart_loop%' OR key LIKE '%crash_loop%' OR key LIKE '%breaker%'"
                        ]);
                        console.log('[TokenGuard] Reset crash-loop breaker state (gateway_boot_lifecycle cleared).');
                    } catch (e) {}
                }
            } catch (e) {
                console.warn('[TokenGuard] Reset crash loop breaker warning:', e.message);
            }

            // 用户在冗长的启动准备（清端口/自愈/harden，可达 10s+）期间点了停止 → 此处中止，绝不 fork
            if (gatewayStartCancelRequested) {
                console.log('[Gateway] start cancelled before fork by user stop request');
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('gateway-status', 'stopped');
                    mainWindow.webContents.send('gateway-log', '\n[System] 启动已被取消（用户在启动过程中点击了停止）。\n');
                }
                return;
            }

            console.log(`[TokenGuard] Fork gateway home=${lockedAuth.homePath} state=${lockedAuth.stateDir} token_len=${String(lockedAuth.token).length}`);

            // 启动子进程运行Nexora Agent（闭包绑定本代 child，避免旧 exit 误清新进程）
            const child = fork(openclawEntry, ['gateway', 'run', '--force', '--allow-unconfigured'], forkOptions);
            gatewayProcess = child;
            global.__gatewayReclaimAttempts = 0;
            markStartupPhase('gateway-forked');

            // fork 失败会触发 'error' 而非 'exit'；无此处理时 gatewayProcess 仍为真、UI 卡在「running」。
            child.once('error', (err) => {
                console.error('[gateway] fork error:', err && err.message ? err.message : err);
                if (gatewayProcess === child) gatewayProcess = null;
                try { stopGatewayHttpReadyWatch(); } catch (_) {}
                try {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('gateway-status', 'stopped');
                    }
                } catch (_) {}
                try { showNotification('Nexora Agent 启动失败', `内核进程无法启动：${err && err.message || err}`); } catch (_) {}
                scheduleGatewayCrashRestart(-1);
            });

            // 窗口可能在异步启动过程中被关闭（托盘退出）→ 解引用 null 会崩溃
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('gateway-status', 'running');
            }
            showNotification('Nexora Agent已成功启动', 'AI 本地Nexora Agent已在后台运行，开始监听 18789 端口。');

            let watchPort = preferredGatewayPort;
            try {
                watchPort = resolveConfiguredGatewayPort();
            } catch (e) {}
            startGatewayHttpReadyWatch(watchPort);

            // 提取日志及匹配登录二维码的公共处理函数
            let gatewayLogTail = '';
            let pendingGatewayUiLog = '';
            let gatewayUiLogTimer = null;
            const flushGatewayUiLog = () => {
                gatewayUiLogTimer = null;
                if (!pendingGatewayUiLog) return;
                const batch = pendingGatewayUiLog;
                pendingGatewayUiLog = '';
                try {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('gateway-log', batch);
                    }
                } catch (_) {}
            };
            const queueGatewayUiLog = (text) => {
                pendingGatewayUiLog += text;
                if (pendingGatewayUiLog.length > 160000) {
                    pendingGatewayUiLog = pendingGatewayUiLog.slice(-120000);
                }
                if (!gatewayUiLogTimer) gatewayUiLogTimer = setTimeout(flushGatewayUiLog, 60);
            };
            const handleLogData = (data) => {
                let text = data.toString();
                if (text.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
                    text = text.split(/\r?\n/).filter(line => !line.includes('NODE_TLS_REJECT_UNAUTHORIZED') && !line.includes('disabling certificate verification')).join('\n');
                }
                if (!text.trim()) return;

                // OpenClaw 偶发弹出「* Install xxx plugin?」；必须选「用本地内置」而不是 Skip，否则渠道会报 does not support login
                text = filterGatewayLogText(text);
                if (!text) return;

                tryAutoAnswerInstallPluginPrompt(child, text, 'Gateway');
                
                // 实时保存流日志用于诊断（带体积上限，避免长跑无限增长撑满磁盘）。
                // 全部走异步 IO，并用 promise 链串行化以保持写入顺序；避免在主进程事件循环上做同步磁盘读写（UI/IPC 卡顿）。
                try {
                    const logFile = require('path').join(CONFIG_DIR, 'gateway_stdout.log');
                    const fsp = require('fs').promises;
                    global.__gwLogBytes = (global.__gwLogBytes || 0) + Buffer.byteLength(text, 'utf8');
                    const needRollCheck = global.__gwLogBytes > 1024 * 1024;
                    if (needRollCheck) global.__gwLogBytes = 0;
                    global.__gwLogWriteChain = (global.__gwLogWriteChain || Promise.resolve()).then(async () => {
                        try {
                            if (needRollCheck) {
                                try {
                                    const st = await fsp.stat(logFile);
                                    if (st.size > 8 * 1024 * 1024) {
                                        const buf = await fsp.readFile(logFile);
                                        await fsp.writeFile(logFile, buf.slice(buf.length - 2 * 1024 * 1024));
                                    }
                                } catch (_) {}
                            }
                            await fsp.appendFile(logFile, text, 'utf8');
                        } catch (_) {}
                    });
                } catch(e) {}

                // 渠道回复朗读兜底：不依赖 voice-bridge 插件是否成功挂上钩子
                try {
                    voiceRuntime.maybeSpeakChannelReplyFromGatewayLog(text);
                } catch (e) {}

                // 压缩失败只打日志、钩子漏检时：写触发文件，由 session-overflow-rollover 静默归档续聊（不依赖窗口）
                // 用 chunk 入口：内部按行缓冲，避免特征行被 stdout 分块截断漏检、以及跨行错配 sessionKey
                try {
                    const helper = getOverflowRolloverTriggerHelper();
                    const feed = helper && (helper.queueOverflowRolloverFromLogChunk || helper.queueOverflowRolloverFromLog);
                    if (typeof feed === 'function') {
                        const queued = feed(CONFIG_DIR, text);
                        if (queued && queued.queued) {
                            console.log(
                                `[OverflowRollover] queued trigger key=${queued.sessionKey || '(auto)'} from gateway log`
                            );
                        }
                    }
                } catch (e) {}

                if (mainWindow) {
                    queueGatewayUiLog(text);

                    // 日志就绪信号：立刻通知 UI（不依赖 TCP 探测时机）
                    if (/http server listening/i.test(text) || text.includes('[gateway] ready')) {
                        notifyGatewayHttpReady(watchPort);
                    }

                    // 🌟 智能解封：若日志捕获到 crash-loop breaker 抑制通道，自动向 Gateway 发起 override 指令拉起微信/QQ/飞书通道
                    if (text.includes('suppressed by crash-loop breaker') || text.includes('restart-loop breaker tripped')) {
                        console.log('[TokenGuard] Detected crash-loop breaker suppression; auto-triggering channels override...');
                        if (channelBreakerOverrideTimer) clearTimeout(channelBreakerOverrideTimer);
                        channelBreakerOverrideTimer = setTimeout(() => {
                            channelBreakerOverrideTimer = null;
                            try {
                                const http = require('http');
                                const token = lockedAuth.token;
                                const req = http.request({
                                    hostname: '127.0.0.1',
                                    port: watchPort || preferredGatewayPort,
                                    path: '/v1/channels/start',
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'Authorization': `Bearer ${token}`
                                    }
                                }, (res) => {
                                    console.log('[TokenGuard] Channel start override status:', res.statusCode);
                                });
                                req.on('error', () => {});
                                req.write(JSON.stringify({ channel: 'all' }));
                                req.end();
                            } catch (e) {}
                        }, 1200);
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
            child.stdout.on('data', handleLogData);
            child.stderr.on('data', handleLogData);

            // 监听退出（必须绑定本代 child，忽略停启叠车时的旧进程 exit）
            child.on('exit', async (code) => {
                if (gatewayUiLogTimer) clearTimeout(gatewayUiLogTimer);
                flushGatewayUiLog();
                console.log(`Gateway exited with code ${code}`);
                const wasIntentionallyStopped = !!child.isIntentionallyStopped;
                const exitedPort = watchPort;
                if (gatewayProcess !== child) {
                    // 已被更新一代替换：不要清全局状态 / 不要推 stopped
                    return;
                }
                gatewayProcess = null;
                stopGatewayHttpReadyWatch();
                gatewayHttpReadyNotified = false;
                if (!wasIntentionallyStopped && await probeGatewayPort(exitedPort)) {
                    // 子进程没了但端口仍被占用：提示手动处理，禁止自动重拉启用
                    console.warn(`[Gateway] Child exited (${code}) but port ${exitedPort} still listening; no auto-restart`);
                    if (mainWindow && !gatewayStartInFlight) {
                        mainWindow.webContents.send(
                            'gateway-log',
                            `\n[System] 网关未能正常退出：端口 ${exitedPort} 仍被占用。请点击左上角再次启动；若反复失败，请结束占用该端口的进程后重试。\n`
                        );
                        mainWindow.webContents.send('gateway-status', 'stopped');
                    }
                    // 不要发 gateway-start-blocked：那是「设置拦截自动启用」语义，会误导成手动启动被拦
                    global.__gatewayReclaimAttempts = 0;
                    return;
                }
                global.__gatewayReclaimAttempts = 0;
                if (wasIntentionallyStopped || isQuitting) {
                    if (mainWindow && !gatewayStartInFlight) {
                        mainWindow.webContents.send('gateway-status', 'stopped');
                    }
                    return;
                }
                console.error(`[System] Nexora Agent核心进程意外退出，退出码: ${code}`);
                if (!scheduleGatewayCrashRestart(code)) {
                    if (mainWindow && !gatewayStartInFlight) {
                        mainWindow.webContents.send('gateway-status', 'stopped');
                    }
                }
            });

        } catch (e) {
            appendMainDiagnostic('gateway-start-failed', e, { source });
            if (mainWindow) {
                mainWindow.webContents.send('gateway-status', 'stopped');
                mainWindow.webContents.send('gateway-log', `[System] [ERROR] 无法找到内置Nexora Agent模块: ${e.message}\n`);
            }
            if (!gatewayStartCancelRequested && !isQuitting) scheduleGatewayCrashRestart(-4);
        }
        } finally {
            gatewayStartInFlight = null;
        }
        })();

        return gatewayStartInFlight;
}

ipcMain.on('gateway-action', (event, action, opts) => {
    if (action === 'start') {
        const source = (opts && typeof opts === 'object' && opts.source)
            ? String(opts.source)
            : '';
        // 渲染进程 IPC 只能走手动 / 设置自启；禁止伪造 reload/update
        if (!IPC_GATEWAY_START_SOURCES.has(source)) {
            notifyGatewayStartBlocked(source || 'ipc-missing-source');
            return;
        }
        startGatewayProcess({ source });
    } else if (action === 'stop') {
        stopGatewayProcess({ cancelInFlightStart: true });
    } else if (action === 'query-status') {
        if (mainWindow) {
            let st = 'stopped';
            if (gatewayProcess) st = 'running';
            else if (gatewayStartInFlight) st = 'starting';
            mainWindow.webContents.send('gateway-status', st);
        }
    }
});

/** 通讯管理：微信/飞书/QQ 绑定或改配后，由渲染层或主进程统一触发热重载 */
ipcMain.handle('gateway-reload-for-channel', async (event, payload) => {
    const reason = (payload && typeof payload === 'object' && payload.reason)
        || (typeof payload === 'string' ? payload : 'channel-change');
    const startIfStopped = !!(payload && typeof payload === 'object' && payload.startIfStopped);
    scheduleGatewayReloadAfterChannelChange(reason, { startIfStopped });
    return { success: true };
});

ipcMain.on('open-sandbox-terminal', () => {
    const sandboxDir = resolveAppFsPath('.node-sandbox');
    const { spawn } = require('child_process');

    if (process.platform !== 'win32') {
        // mac 打开 Terminal.app，linux 尝试常见终端模拟器
        const cwd = resolveBuiltinTerminalCwd();
        try {
            const child = process.platform === 'darwin'
                ? spawn('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore' })
                : spawn(process.env.TERMINAL || 'x-terminal-emulator', [], { cwd, detached: true, stdio: 'ignore' });
            child.on('error', (e) => console.warn('[SandboxTerminal] open failed:', e && e.message));
            child.unref();
        } catch (e) {
            console.warn('[SandboxTerminal] open failed:', e && e.message);
        }
        return;
    }

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

function killBuiltinPtyProcess() {
    if (!ptyProcess) return;
    const proc = ptyProcess;
    ptyProcess = null; // 先解绑，避免 exit 回调刷「已退出」污染重置后的屏幕
    try { proc.kill(); } catch (e) {}
}

function pushBuiltinTerminalData(text) {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('builtin-terminal-data', text);
        }
    } catch (e) {}
}

function spawnBuiltinPtyProcess(lang) {
    const sandboxDir = resolveAppFsPath('.node-sandbox');
    let pty;
    try {
        pty = require('node-pty');
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        pushBuiltinTerminalData(`\r\n\x1b[31m[内置终端] node-pty 加载失败（打包环境常见于未解包原生模块）\x1b[0m\r\n${msg}\r\n`);
        pushBuiltinTerminalData(`\x1b[33m正在打开外部 PowerShell 沙箱窗口作为后备…\x1b[0m\r\n`);
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
    const isWinTerm = process.platform === 'win32';
    const pathKey = isWinTerm ? 'Path' : 'PATH';
    const childEnv = { ...process.env };
    if (sandboxDir && fs.existsSync(sandboxDir)) {
        childEnv[pathKey] = `${sandboxDir}${path.delimiter}${childEnv[pathKey] || ''}`;
    }

    // Windows 走 PowerShell + EncodedCommand；mac/linux 走用户默认 shell
    const shellFile = isWinTerm
        ? 'powershell.exe'
        : (process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'));
    const shellArgs = isWinTerm
        ? ['-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCmd]
        : [];

    ptyProcess = pty.spawn(shellFile, shellArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
        // 打包后 __dirname 在 app.asar 内，不能当 cwd，否则壳进程起不来、终端空白
        cwd: termCwd,
        env: childEnv,
        useConpty: isWinTerm
    });

    if (!isWinTerm) {
        // 非 Windows 没有 PowerShell 启动横幅，直接向终端视图输出欢迎信息
        pushBuiltinTerminalData([
            '\x1b[32m==========================================================\x1b[0m\r\n',
            `\x1b[32m${bannerTitle}\x1b[0m\r\n`,
            '\x1b[32m==========================================================\x1b[0m\r\n',
            `\x1b[36m${bannerCmds}\x1b[0m\r\n`,
            `${cmdNode}\r\n`,
            `${cmdNpm}\r\n`,
            '\x1b[32m==========================================================\x1b[0m\r\n\r\n'
        ].join(''));
    }

    const spawned = ptyProcess;
    spawned.on('data', function (data) {
        pushBuiltinTerminalData(data);
    });

    spawned.on('exit', () => {
        if (ptyProcess === spawned) {
            ptyProcess = null;
            pushBuiltinTerminalData('\r\n\x1b[33m[内置终端已退出]\x1b[0m\r\n');
        }
    });

    return { ok: true, cwd: termCwd };
}

ipcMain.handle('builtin-terminal-start', (event, lang) => {
    if (ptyProcess) return { ok: true, reused: true };

    try {
        return spawnBuiltinPtyProcess(lang);
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('[BuiltinTerminal] start failed:', msg);
        pushBuiltinTerminalData(`\r\n\x1b[31m[内置终端启动失败]\x1b[0m\r\n${msg}\r\n`);
        pushBuiltinTerminalData(`\x1b[33m正在打开外部 PowerShell 沙箱窗口作为后备…\x1b[0m\r\n`);
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
            spawn('powershell.exe', ['-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCmd], {
                cwd: resolveBuiltinTerminalCwd(),
                detached: true,
                stdio: 'ignore'
            }).unref();
        } catch (e2) {}
        return { ok: false, error: msg, fallback: 'external' };
    }
});

ipcMain.handle('builtin-terminal-reset', (event, lang) => {
    try {
        killBuiltinPtyProcess();
        return spawnBuiltinPtyProcess(lang || 'zh-CN');
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('[BuiltinTerminal] reset failed:', msg);
        pushBuiltinTerminalData(`\r\n\x1b[31m[内置终端重置失败]\x1b[0m\r\n${msg}\r\n`);
        return { ok: false, error: msg };
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

/**
 * openclaw.json 损坏自愈：旧版本非原子写/断电写一半留下的坏 JSON 会让网关永远起不来。
 * 策略：备份坏文件 → 尝试最近可解析的 .bak-* 备份 → 都不行则用模板重建
 *（重建后 ensure* 流程会照常补齐 token/插件 allow，等同全新初始化）。
 */
function recoverCorruptOpenClawConfig(parseErr) {
    console.error('[ConfigRepair] openclaw.json is corrupt:', parseErr && parseErr.message);
    try {
        fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak-corrupt-' + Date.now());
    } catch (e) {}
    try {
        const cands = fs.readdirSync(CONFIG_DIR)
            .filter((n) => n.startsWith('openclaw.json.bak-') && !n.includes('corrupt'))
            .map((n) => path.join(CONFIG_DIR, n))
            .sort((a, b) => {
                try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch (e) { return 0; }
            });
        for (const f of cands.slice(0, 5)) {
            try {
                const cfg = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
                fs.copyFileSync(f, CONFIG_PATH);
                console.warn('[ConfigRepair] Restored openclaw.json from backup:', path.basename(f));
                return cfg;
            } catch (e) {}
        }
    } catch (e) {}
    const examplePath = path.join(__dirname, 'config', 'openclaw.json.example');
    const tpl = JSON.parse(fs.readFileSync(examplePath, 'utf8').replace(/^﻿/, ''));
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(tpl, null, 2), 'utf8');
    } catch (e) {}
    console.warn('[ConfigRepair] Rebuilt openclaw.json from template (corrupt file kept as .bak-corrupt-*)');
    return tpl;
}

// 提取的配置初始化逻辑：确保在 Gateway 启动前就把默认插件（如 health-check 等）写入 allow 列表
function ensureOpenClawConfigInitialized() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            // 从模板初始化
            const examplePath = path.join(__dirname, 'config', 'openclaw.json.example');
            if (fs.existsSync(examplePath)) {
                if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
                fs.copyFileSync(examplePath, CONFIG_PATH);
                try {
                    if (app.isReady()) {
                        setAutoStartEnabled(true);
                    }
                } catch(err) { console.warn('[System] Failed to set initial autostart:', err); }
            } else {
                return;
            }
        }
        let content = fs.readFileSync(CONFIG_PATH, 'utf8');
        content = content.replace(/^\uFEFF/, '');
        let config;
        let needsSave = false;
        try {
            config = JSON.parse(content);
        } catch (parseErr) {
            // 坏配置绝不能让启动流程带病继续（网关会起不来）——就地自愈
            config = recoverCorruptOpenClawConfig(parseErr);
            needsSave = true;
        }
        // 绝不能将自定义根节点 google 写入 openclaw.json（OpenClaw 强 Schema 检查会导致网关无法启动）
        if (config.google) {
            try {
                if (config.google.account && config.google.tokens) {
                    writeGoogleAuthData({
                        loggedIn: true,
                        account: config.google.account,
                        tokens: config.google.tokens
                    });
                }
            } catch (e) {
                console.warn('[System] Failed to migrate legacy google auth data:', e);
            }
            delete config.google;
            needsSave = true;
            console.log('[System] Stripped root "google" key from openclaw.json for Gateway compatibility');
        }

        try {
            if (stripNonSchemaOpenClawConfig(config)) {
                needsSave = true;
                console.log('[ConfigSanitize] Stripped non-schema fields and normalized channel config');
            }
        } catch (e) {}

        // 统一规范化 gateway.auth / controlUi / port（禁止 SecretRef/空值/随机令牌导致面板永登不上）
        {
            const norm = normalizeGatewayAuthConfig(config, NEXORA_AGENT_DEFAULT_GATEWAY_TOKEN);
            config = norm.config;
            if (norm.changed) {
                needsSave = true;
                console.log('[System] Persisted default gateway.auth.token for dashboard auto-login');
            }
        }
        // PDF 解析：内核 pdf 工具对 agnes 走「文本/图像抽取」降级（用已配置的视觉模型），
        // 历史配置误把它 deny 了 → 用户发 PDF 模型无法解析。一次性摘除该 deny 项。
        try {
            const agnesTools = config.tools && config.tools.byProvider && config.tools.byProvider['agnes-ai'];
            if (agnesTools && Array.isArray(agnesTools.deny) && agnesTools.deny.includes('pdf')) {
                agnesTools.deny = agnesTools.deny.filter((t) => t !== 'pdf');
                needsSave = true;
                console.log('[System] Removed pdf from agnes-ai tool deny list (enable PDF analysis)');
            }
        } catch (e) {}

        // 微信入站去抖：500ms 兜不住真人分段打字（一句话拆三四条、间隔一两秒），
        // 会导致「一条一条回」。升到 2000ms 让分段消息合并成一个回合、模型拿到完整意图。
        // 仅当当前值还是旧默认 500（或缺失）时升级——用户自己调过的值不动。
        {
            if (!config.channels) { config.channels = {}; needsSave = true; }
            const wx = config.channels['openclaw-weixin'];
            if (wx && typeof wx === 'object') {
                if (!wx.inbound || typeof wx.inbound !== 'object') {
                    wx.inbound = { debounceMs: 2000 };
                    needsSave = true;
                } else if (wx.inbound.debounceMs === 500 || wx.inbound.debounceMs == null) {
                    wx.inbound.debounceMs = 2000;
                    needsSave = true;
                    console.log('[System] Raised weixin inbound debounce 500 -> 2000ms (merge split-typing bursts)');
                }
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

        // 媒体生成插件：任意电脑开箱必须启用（不受版本 stamp 影响）
        for (const name of BUNDLED_EXTENSION_PLUGINS) {
            if (!config.plugins.entries[name]) {
                config.plugins.entries[name] = {};
                needsSave = true;
            }
            if (config.plugins.entries[name].enabled !== true) {
                config.plugins.entries[name].enabled = true;
                needsSave = true;
            }
            if (!config.plugins.allow.includes(name)) {
                config.plugins.allow.push(name);
                needsSave = true;
            }
        }

        // 会话 tool 配对自愈：必须常开，否则 Gemini 聊着聊着会整段哑火
        {
            const name = 'session-tool-heal';
            if (!config.plugins.entries[name]) {
                config.plugins.entries[name] = {};
                needsSave = true;
            }
            if (config.plugins.entries[name].enabled !== true) {
                config.plugins.entries[name].enabled = true;
                needsSave = true;
            }
            if (!config.plugins.entries[name].hooks) {
                config.plugins.entries[name].hooks = {};
                needsSave = true;
            }
            if (config.plugins.entries[name].hooks.allowConversationAccess !== true) {
                config.plugins.entries[name].hooks.allowConversationAccess = true;
                needsSave = true;
            }
            if (!config.plugins.allow.includes(name)) {
                config.plugins.allow.push(name);
                needsSave = true;
            }
        }

        // 上下文溢出：归档旧会话 + 新会话续答上一问（替代只提示 /new）
        {
            const name = 'session-overflow-rollover';
            if (!config.plugins.entries[name]) {
                config.plugins.entries[name] = {};
                needsSave = true;
            }
            if (config.plugins.entries[name].enabled !== true) {
                config.plugins.entries[name].enabled = true;
                needsSave = true;
            }
            if (!config.plugins.entries[name].hooks) {
                config.plugins.entries[name].hooks = {};
                needsSave = true;
            }
            if (config.plugins.entries[name].hooks.allowConversationAccess !== true) {
                config.plugins.entries[name].hooks.allowConversationAccess = true;
                needsSave = true;
            }
            if (!config.plugins.allow.includes(name)) {
                config.plugins.allow.push(name);
                needsSave = true;
            }
        }

        // 渠道回复朗读：必须允许读取对话钩子，否则 agent_end/llm_output 拿不到正文
        {
            const name = 'voice-bridge';
            if (!config.plugins.entries[name]) {
                config.plugins.entries[name] = {};
                needsSave = true;
            }
            if (config.plugins.entries[name].enabled !== true) {
                config.plugins.entries[name].enabled = true;
                needsSave = true;
            }
            if (!config.plugins.entries[name].hooks) {
                config.plugins.entries[name].hooks = {};
                needsSave = true;
            }
            if (config.plugins.entries[name].hooks.allowConversationAccess !== true) {
                config.plugins.entries[name].hooks.allowConversationAccess = true;
                needsSave = true;
            }
            if (!config.plugins.allow.includes(name)) {
                config.plugins.allow.push(name);
                needsSave = true;
            }
        }

        // OpenClaw 2026.9 只保留正式压缩策略和超时；失败仍由
        // session-overflow-rollover 兜底。
        {
            if (!config.agents) config.agents = {};
            if (!config.agents.defaults) config.agents.defaults = {};
            if (!config.agents.defaults.compaction || typeof config.agents.defaults.compaction !== 'object') {
                config.agents.defaults.compaction = {};
                needsSave = true;
            }
            const compact = config.agents.defaults.compaction;
            if (compact.mode == null) {
                compact.mode = 'safeguard';
                needsSave = true;
            }
            if (!(Number(compact.timeoutSeconds) >= 240)) {
                compact.timeoutSeconds = 240;
                needsSave = true;
            }
        }

        if (ensureMediaAgentDefaults(config)) {
            needsSave = true;
        }

        // 默认启用全部内置自定义插件 (含别人电脑首次安装 / 升级迁移)
        let appVersion = '0.0.0';
        try { appVersion = app.getVersion(); } catch (e) {}
        const stampPath = path.join(CONFIG_DIR, '.claw-bundled-enable-stamp');
        let enableStamp = '';
        try { if (fs.existsSync(stampPath)) enableStamp = fs.readFileSync(stampPath, 'utf8').trim(); } catch (e) {}
        if (enableStamp !== appVersion) {
            for (const name of allBundledManagedPluginIds()) {
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
            console.log(`[PluginSeed] Enabled ${allBundledManagedPluginIds().length} bundled plugins for v${appVersion}`);
        } else {
            // 版本内: 缺失条目仍默认开启; 已有条目尊重用户开关, 但启用态必须进 allow
            for (const name of allBundledManagedPluginIds()) {
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

        try {
            const cleaned = sanitizeNonPluginLibraryConfig(config);
            if (cleaned.changed) {
                needsSave = true;
                console.log('[PluginSeed] Removed non-plugin libraries (e.g. media-core) from plugins config');
            }
        } catch (e) {}

        try {
            if (normalizeWebToolsConfig(config)) {
                needsSave = true;
                console.log('[WebSearch] Normalized tools.web.search/fetch config');
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
                    if (NON_PLUGIN_EXTENSION_DIRS.has(name)) continue; // media-core 等库目录
                    if (BUNDLED_CUSTOM_PLUGINS.includes(name) || BUNDLED_EXTENSION_PLUGINS.includes(name)) continue; // 已在上面处理
                    // 无插件清单的目录不要登记，否则 Gateway 会报 manifest not found
                    if (!fs.existsSync(path.join(pluginDir, 'openclaw.plugin.json'))) continue;
                    if (!config.plugins.entries[name]) {
                        config.plugins.entries[name] = { enabled: false };
                        needsSave = true;
                    }
                }
            } catch (e) {}
        }

        // 内置自定义插件必须进入 load.paths，否则网关不会加载（语音桥接/角色管理会静默失效）
        try {
            if (!config.plugins.load) config.plugins.load = {};
            if (!Array.isArray(config.plugins.load.paths)) config.plugins.load.paths = [];
            const mustLoad = [...allBundledManagedPluginIds(), 'role-manager'];
            for (const name of mustLoad) {
                const pluginDir = path.join(CONFIG_DIR, 'extensions', name);
                if (!fs.existsSync(path.join(pluginDir, 'index.js'))) continue;
                const abs = path.resolve(pluginDir);
                const has = config.plugins.load.paths.some(
                    (p) => typeof p === 'string' && path.resolve(p) === abs
                );
                if (!has) {
                    config.plugins.load.paths.push(abs);
                    needsSave = true;
                }
                if (!config.plugins.entries[name]) {
                    config.plugins.entries[name] = { enabled: true };
                    needsSave = true;
                }
                if (config.plugins.entries[name].enabled === true && !config.plugins.allow.includes(name)) {
                    config.plugins.allow.push(name);
                    needsSave = true;
                }
            }
        } catch (e) {}
        
        // 多用户/云电脑：读配置时也清洗野指针，避免长期保留别人机器的绝对路径
        try {
            const sanitized = applyMachinePluginPathSanitize(config);
            if (sanitized.changed) needsSave = true;
        } catch (e) {}

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
                needsSave = true;
                return false;
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
            // media-core 等是库不是插件
            const low = p.replace(/\\/g, '/').toLowerCase();
            if ([...NON_PLUGIN_EXTENSION_DIRS].some((id) => low.endsWith('/' + id) || low.includes('/extensions/' + id))) {
                needsSave = true;
                return false;
            }
            // 目录存在但没有插件清单 → 不能进 load.paths
            try {
                if (fs.statSync(p).isDirectory() && !fs.existsSync(path.join(p, 'openclaw.plugin.json'))) {
                    needsSave = true;
                    return false;
                }
            } catch (e) {}
            return true;
        });

        // 仅微信等 viaLoadPaths=true 写入 load.paths；飞书/QQ 等走官方 installs
        for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
            if (entry.viaLoadPaths === false) continue;
            const abs = resolveBundledNpmPluginPath(entry);
            if (!abs || !pluginPathUsableOnThisMachine(abs)) {
                console.warn(`[PluginSeed] Bundled npm plugin missing/unusable: ${entry.id}`);
                // Do not silently close configured communication channels.
                continue;
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
                    // Preserve any existing enabled/disabled choice. A transient
                    // seed failure must not mutate the user's channel settings.
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
                    trustedOfficialInstall: true,
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

        // LatencyTune 之后再次钉死云端压缩地板，杜绝被误判小窗压回 8000
        {
            if (!config.agents) config.agents = {};
            if (!config.agents.defaults) config.agents.defaults = {};
            if (!config.agents.defaults.compaction || typeof config.agents.defaults.compaction !== 'object') {
                config.agents.defaults.compaction = {};
            }
            const compact = config.agents.defaults.compaction;
            const primaryRaw = config.agents.defaults.model
                && (typeof config.agents.defaults.model === 'string'
                    ? config.agents.defaults.model
                    : config.agents.defaults.model.primary);
            const cloudPrimary = typeof primaryRaw === 'string'
                && primaryRaw.includes('/')
                && primaryRaw.slice(0, primaryRaw.indexOf('/')).toLowerCase() !== 'ollama';
            if (cloudPrimary) {
                if (!(Number(compact.timeoutSeconds) >= 240)) {
                    compact.timeoutSeconds = 240;
                    needsSave = true;
                }
            }
        }

        try {
            const vision = ensureVisionModelConfig(config);
            if (vision.changed) {
                needsSave = true;
                console.log('[VisionModel] Ensured image understanding:', vision.visionModel);
            }
        } catch (e) {
            console.warn('[VisionModel] skipped:', e.message);
        }

        // 飞书渠道自愈：清除历史写入的空字符串可选凭证（encryptKey/verificationToken/appSecret），
        // 并在已配置账号时补齐渠道启用与开放策略，修复“绑定后收到不回”的问题。
        try {
            if (sanitizeFeishuConfig(config)) {
                needsSave = true;
                console.log('[FeishuFix] Normalized feishu channel config');
            }
        } catch (e) {}

        try {
            if (sanitizeQqbotConfig(config)) {
                needsSave = true;
                console.log('[QqbotFix] Normalized qqbot account ids for outbound media');
            }
        } catch (e) {}

        // 剥离 providers 上的 label/remark（UI 侧车），防止 Gateway Unrecognized key 无法启动
        try {
            if (stripNonSchemaOpenClawConfig(config)) {
                needsSave = true;
                console.log('[ConfigSanitize] Stripped non-schema fields (incl. provider label/remark)');
            }
        } catch (e) {}

        // 技能中心：提案须人工审核；保证 skill_workshop 工具可用
        try {
            const sc = getSkillCenter().ensureWorkshopConfig(config);
            config = sc.config;
            if (sc.changed) {
                needsSave = true;
                console.log('[SkillCenter] Ensured skills.workshop.approvalPolicy=pending + skill_workshop allow');
            }
            try {
                getSkillCenter().ensureSkillWorkshopGuidance(path.join(CONFIG_DIR, 'workspace'));
            } catch (e2) {}
        } catch (e) {}

        if (needsSave) {
            try {
                writeConfigFileAtomic(JSON.stringify(config, null, 2));
                // 切勿因「写了一点 config」就删 openclaw.sqlite（会清空数据中心统计）
            } catch(e) {}
        }
        
        // Return initialized config for callers if needed
        return config;
    } catch (e) {
        console.error('[PluginSeed] ensureOpenClawConfigInitialized failed:', e);
        return null;
    }
}

function resolveWorkspaceSoulPath() {
    return path.join(CONFIG_DIR, 'workspace', 'SOUL.md');
}

function syncActiveRoleToSoulMd(configOverride) {
    try {
        const cfg = configOverride || roleConfig.readRoleConfig(CONFIG_DIR);
        const active = roleConfig.getActiveRole(cfg);
        const wsDir = path.join(CONFIG_DIR, 'workspace');
        fs.mkdirSync(wsDir, { recursive: true });
        const soulPath = resolveWorkspaceSoulPath();
        let existing = '';
        if (fs.existsSync(soulPath)) {
            existing = fs.readFileSync(soulPath, 'utf8').replace(/^\uFEFF/, '');
        } else {
            // 优先用模板，保证首次写入不丢默认 SOUL 结构
            const tplCandidates = [
                path.join(__dirname, 'config', 'openclaw-templates', 'SOUL.md'),
                resolveAppFsPath('config', 'openclaw-templates', 'SOUL.md')
            ];
            for (const tpl of tplCandidates) {
                try {
                    if (fs.existsSync(tpl)) {
                        existing = fs.readFileSync(tpl, 'utf8').replace(/^\uFEFF/, '');
                        break;
                    }
                } catch (e) {}
            }
        }
        const next = roleConfig.applyManagedSoulBlock(existing, active);
        if (next !== existing) {
            fs.writeFileSync(soulPath, next, 'utf8');
        }
        return { success: true, roleId: active && active.id, soulPath };
    } catch (e) {
        console.warn('[RoleConfig] syncActiveRoleToSoulMd failed:', e.message);
        return { success: false, error: e.message };
    }
}

function buildRoleClientPayload() {
    const cfg = roleConfig.readRoleConfig(CONFIG_DIR);
    return roleConfig.toClientPayload(cfg);
}

function broadcastRoleConfigUpdated(payload) {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('role-config-updated', payload);
        }
        BrowserWindow.getAllWindows().forEach((win) => {
            try {
                if (!win || win.isDestroyed()) return;
                if (mainWindow && win.id === mainWindow.id) return;
                win.webContents.send('role-config-updated', payload);
            } catch (e) {}
        });
    } catch (e) {}
}

let __roleConfigWatcher = null;
let __roleConfigWatchTimer = null;
let __roleConfigWatchIgnoreUntil = 0;
let __roleConfigLastSig = '';

function getRoleConfigSignature() {
    try {
        const filePath = roleConfig.resolveRolesPath(CONFIG_DIR);
        if (!fs.existsSync(filePath)) return '';
        const st = fs.statSync(filePath);
        return `${st.mtimeMs}:${st.size}`;
    } catch (e) {
        return '';
    }
}

function watchRoleConfigFile() {
    try {
        if (__roleConfigWatcher) {
            try { __roleConfigWatcher.close(); } catch (e) {}
            __roleConfigWatcher = null;
        }
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        const rolesPath = roleConfig.resolveRolesPath(CONFIG_DIR);
        __roleConfigLastSig = getRoleConfigSignature();
        // 监听目录更稳：Windows 上对尚不存在的单文件 watch 容易失效
        __roleConfigWatcher = fs.watch(CONFIG_DIR, { persistent: false }, (eventType, filename) => {
            try {
                const name = filename ? String(filename) : '';
                if (name && name !== roleConfig.ROLES_FILE_NAME && !name.endsWith(roleConfig.ROLES_FILE_NAME)) {
                    return;
                }
                if (Date.now() < __roleConfigWatchIgnoreUntil) return;
                if (__roleConfigWatchTimer) clearTimeout(__roleConfigWatchTimer);
                __roleConfigWatchTimer = setTimeout(() => {
                    __roleConfigWatchTimer = null;
                    try {
                        const sig = getRoleConfigSignature();
                        if (sig && sig === __roleConfigLastSig) return;
                        __roleConfigLastSig = sig;
                        const cfg = roleConfig.readRoleConfig(CONFIG_DIR);
                        const sync = syncActiveRoleToSoulMd(cfg);
                        const data = roleConfig.toClientPayload(cfg);
                        broadcastRoleConfigUpdated({
                            data,
                            action: 'external',
                            soulSynced: !!(sync && sync.success)
                        });
                        console.log('[RoleConfig] External roles file change synced');
                    } catch (e) {
                        console.warn('[RoleConfig] watch sync failed:', e.message);
                    }
                }, 280);
            } catch (e) {}
        });
    } catch (e) {
        console.warn('[RoleConfig] watchRoleConfigFile failed:', e.message);
    }
}

// 配置文件的读写 IPC
/**
 * 上下文窗口实测（适配任意 OpenAI 兼容自定义服务商）：
 * 1) 报错解析：超长请求被拒时从错误信息提取 "maximum context length is N"（权威、通常不计费）
 * 2) 标记回忆：在填充文本开头埋随机标记让模型复述；静默截断（截头）时必然答不出
 * 不采用「问模型」——模型对自己的部署参数没有可靠认知，答案是幻觉
 */
async function probeModelContextWindow(providerId, modelId, targetTokens) {
    const target = Number(targetTokens) > 0 ? Math.min(Number(targetTokens), 1200000) : 140000;
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
    } catch (e) {
        return { ok: false, error: '读取配置失败: ' + e.message };
    }
    const prov = cfg.models && cfg.models.providers && cfg.models.providers[providerId];
    if (!prov || !prov.baseUrl) return { ok: false, error: '服务商不存在或缺少 baseUrl' };
    const apiType = String(prov.api || 'openai-completions');
    if (!/openai/i.test(apiType)) {
        return { ok: false, error: `暂不支持 ${apiType} 类型服务商的实测（仅 OpenAI 兼容接口）` };
    }
    const envName = String(providerId).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY';
    const key = String((cfg.env && cfg.env[envName]) || prov.apiKey || process.env[envName] || '').trim();
    if (!key) return { ok: false, error: '找不到该服务商的 API Key（env 块与 apiKey 均为空）' };

    const marker = 'MARKER-' + require('crypto').randomBytes(6).toString('hex');
    const filler = 'probe '.repeat(Math.ceil(target / 1.25));
    const body = JSON.stringify({
        model: modelId,
        messages: [{
            role: 'user',
            content: `记住这个标记：${marker}\n下面是无意义的填充文本，请忽略其内容：\n${filler}\n` +
                `填充结束。现在请只回复最开头让你记住的那个标记（MARKER- 开头），不要任何其它文字。`
        }],
        max_tokens: 32,
        temperature: 0
    });
    let url;
    try {
        url = new URL(String(prov.baseUrl).replace(/\/$/, '') + '/chat/completions');
    } catch (e) {
        return { ok: false, error: 'baseUrl 无效: ' + prov.baseUrl };
    }
    const resp = await new Promise((resolve) => {
        const mod = url.protocol === 'http:' ? require('http') : require('https');
        const req = mod.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + key,
                'Content-Length': Buffer.byteLength(body)
            },
            timeout: 120000
        }, (res) => {
            let buf = '';
            res.on('data', (d) => { buf += d; });
            res.on('end', () => resolve({ status: res.statusCode || 0, text: buf }));
        });
        req.on('timeout', () => { req.destroy(new Error('请求超时(120s)')); });
        req.on('error', (e) => resolve({ status: 0, text: String((e && e.message) || e) }));
        req.write(body);
        req.end();
    });

    if (resp.status === 0) return { ok: false, error: '网络错误: ' + resp.text };
    if (resp.status >= 400) {
        const t = String(resp.text || '');
        const m =
            t.match(/maximum context length is[^\d]{0,10}(\d{4,9})/i) ||
            t.match(/context[_\s-]?(?:length|window)[^\d]{0,20}(\d{4,9})/i) ||
            t.match(/(\d{4,9})\s*tokens?[^\n]{0,40}(?:maximum|limit|exceed)/i);
        if (m) return { ok: true, verdict: 'limit', limit: Number(m[1]) };
        return { ok: false, error: `HTTP ${resp.status}: ` + t.replace(/\s+/g, ' ').slice(0, 200) };
    }
    let reply = '';
    try {
        const j = JSON.parse(resp.text);
        reply = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
    } catch (e) {}
    if (reply.includes(marker)) return { ok: true, verdict: 'ge', target };
    return { ok: true, verdict: 'lt', target };
}

ipcMain.handle('model-probe-context', async (event, providerId, modelId, targetTokens) => {
    try {
        return await probeModelContextWindow(String(providerId || ''), String(modelId || ''), targetTokens);
    } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
    }
});

ipcMain.handle('config-read', async () => {
    try {
        // \u8BFB\u64CD\u4F5C\u4E0D\u518D\u89E6\u53D1\u89C4\u8303\u5316\u5199\u76D8\uFF1A\u539F\u5148\u6BCF\u6B21\u6253\u5F00\u8BBE\u7F6E\u9875\u90FD ensureOpenClawConfigInitialized() \u2192 \u6539\u5199 openclaw.json\uFF0C
        // \u653E\u5927\u914D\u7F6E\u6296\u52A8\u4E0E\u548C\u7F51\u5173\u7684 clobber \u7ADE\u4E89\u3002\u5DF2\u5B58\u5728\u914D\u7F6E\u76F4\u63A5\u8BFB\u53D6\uFF1B\u4EC5\u89E3\u6790\u5931\u8D25\u6216\u9996\u6B21\u624D\u8D70\u521D\u59CB\u5316/\u4FEE\u590D\u8DEF\u5F84\u3002
        if (fs.existsSync(CONFIG_PATH)) {
            try {
                const content = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
                return redactBuiltInAgnesCredentials(applyProviderUiMetaToConfig(JSON.parse(content)));
            } catch (parseErr) {
                const repaired = ensureOpenClawConfigInitialized();
                if (repaired) return redactBuiltInAgnesCredentials(applyProviderUiMetaToConfig(repaired));
                return null;
            }
        }
        const config = ensureOpenClawConfigInitialized();
        if (config) return redactBuiltInAgnesCredentials(applyProviderUiMetaToConfig(config));
        return null;
    } catch (e) {
        console.error('Failed to read config:', e);
        return null;
    }
});

// ─── 技能中心（Skill Workshop + 本地 skills）───
ipcMain.handle('skills-list', async () => {
    try {
        return { success: true, skills: getSkillCenter().listInstalledSkills() };
    } catch (e) {
        return { success: false, error: e.message, skills: [] };
    }
});

ipcMain.handle('skills-read', async (_e, name) => {
    try {
        return getSkillCenter().readSkill(name);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('skills-set-enabled', async (_e, payload) => {
    try {
        const name = payload && payload.name;
        const enabled = !!(payload && payload.enabled);
        return getSkillCenter().setSkillEnabled(name, enabled);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('skills-delete', async (_e, name) => {
    try {
        return getSkillCenter().deleteSkill(name);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('skills-open-folder', async (_e, name) => {
    try {
        const r = getSkillCenter().openSkillFolder(name);
        if (r.success && r.path) {
            const { shell } = require('electron');
            shell.openPath(r.path).catch(() => {});
        }
        return r;
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('skills-proposals-list', async (_e, payload) => {
    try {
        const status = payload && payload.status;
        return { success: true, proposals: getSkillCenter().listProposalsFromFs(status || 'pending') };
    } catch (e) {
        return { success: false, error: e.message, proposals: [] };
    }
});

ipcMain.handle('skills-proposals-inspect', async (_e, proposalId) => {
    try {
        return getSkillCenter().inspectProposalFromFs(proposalId);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('skills-proposals-apply', async (_e, proposalId) => {
    try {
        return await getSkillCenter().applyProposal(proposalId);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('skills-proposals-reject', async (_e, payload) => {
    try {
        const id = payload && (payload.proposalId || payload.id);
        return await getSkillCenter().rejectProposal(id, payload && payload.reason);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('skills-proposals-quarantine', async (_e, payload) => {
    try {
        const id = payload && (payload.proposalId || payload.id);
        return await getSkillCenter().quarantineProposal(id, payload && payload.reason);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('skills-clawhub-search', async (_e, payload) => {
    try {
        const q = payload && payload.query;
        const limit = payload && payload.limit;
        return await getSkillCenter().searchClawHub(q, limit);
    } catch (e) {
        return { success: false, error: e.message, results: [] };
    }
});

ipcMain.handle('skills-clawhub-install', async (_e, payload) => {
    try {
        if (!payload || payload.acknowledgedRisk !== true) {
            return { success: false, error: '安装已取消：必须明确确认第三方技能可执行本地代码的风险' };
        }
        const ref = payload && (payload.ref || payload.skillRef || payload.slug);
        return await getSkillCenter().installFromClawHub(ref, {
            force: !!(payload && payload.force),
            version: payload && payload.version
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('role-config-read', async () => {
    try {
        // 确保工作区角色块与当前启用角色一致
        syncActiveRoleToSoulMd();
        return { success: true, data: buildRoleClientPayload() };
    } catch (e) {
        console.error('[RoleConfig] read failed:', e);
        return { success: false, error: e.message, data: roleConfig.toClientPayload(roleConfig.createDefaultConfig()) };
    }
});

// ─── 本地离线语音 ───
ipcMain.handle('voice-get-state', async () => {
    try {
        return { success: true, data: voiceRuntime.getPublicState() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('voice-set-settings', async (event, patch) => {
    try {
        const data = voiceRuntime.setSettings(patch || {});
        return { success: true, data };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('voice-speak', async (event, payload) => {
    try {
        const p = payload && typeof payload === 'object' ? payload : { text: String(payload || '') };
        return voiceRuntime.speak(p.text, {
            source: p.source || 'manual',
            roleId: p.roleId,
            packId: p.packId,
            maxLen: p.maxLen
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('voice-stop', async () => {
    try {
        return voiceRuntime.stop({ clearQueue: true });
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('voice-download-pack', async (event, packId) => {
    try {
        return await voiceRuntime.downloadPack(packId);
    } catch (e) {
        return { success: false, error: e.message };
    }
});
ipcMain.handle('voice-import-custom', async (event) => {
    try {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: '导入自定义语音包',
            properties: ['openFile'],
            filters: [
                { name: 'Sherpa-ONNX Voice Pack', extensions: ['tar.bz2', 'zip'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        if (canceled || filePaths.length === 0) return { success: false, canceled: true };
        
        return await voiceRuntime.importCustomPack(filePaths[0]);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('voice-delete-custom', async (event, packId) => {
    try {
        return await voiceRuntime.deleteCustomPack(packId);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('voice-bind-role', async (event, payload) => {
    try {
        const roleId = payload && payload.roleId;
        const packId = payload && payload.packId;
        return { success: true, data: voiceRuntime.bindRoleVoice(roleId, packId) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('voice-set-listen-status', async (event, status) => {
    try {
        voiceRuntime.setListenStatus(status);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('voice-get-asr-state', async () => {
    try {
        return { success: true, data: voiceRuntime.getAsrState() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('voice-download-asr-model', async () => {
    try {
        return await voiceRuntime.downloadAsrModel();
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('voice-import-asr-model', async () => {
    try {
        const choice = await dialog.showMessageBox({
            type: 'question',
            buttons: ['选择压缩包', '选择文件夹', '取消'],
            defaultId: 0,
            cancelId: 2,
            title: '导入离线语音识别',
            message: '如何导入离线语音识别模型？',
            detail: '推荐文件：sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2\n也可选择已解压目录（需包含 .onnx 与 tokens.txt）。'
        });
        if (choice.response === 2) return { success: false, canceled: true };
        if (choice.response === 1) {
            const dirPick = await dialog.showOpenDialog({
                title: '选择 ASR 模型文件夹',
                properties: ['openDirectory']
            });
            if (dirPick.canceled || !dirPick.filePaths || !dirPick.filePaths.length) {
                return { success: false, canceled: true };
            }
            return await voiceRuntime.importAsrModel(dirPick.filePaths[0]);
        }
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: '选择 ASR 模型压缩包',
            properties: ['openFile'],
            filters: [
                { name: 'Sherpa-ONNX ASR Pack', extensions: ['bz2', 'zip', 'gz', 'tgz', 'tar'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        if (canceled || !filePaths || !filePaths.length) return { success: false, canceled: true };
        return await voiceRuntime.importAsrModel(filePaths[0]);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('voice-recognize-offline', async (event, samples) => {
    try {
        return await voiceRuntime.recognizeOffline(samples);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('role-config-save', async (event, payload) => {
    try {
        const action = payload && payload.action;
        let cfg = roleConfig.readRoleConfig(CONFIG_DIR);
        let result;

        if (action === 'upsert') {
            result = roleConfig.upsertCustomRole(cfg, payload.role || {});
            if (!result.ok) return { success: false, error: result.error };
            cfg = roleConfig.writeRoleConfig(CONFIG_DIR, result.config);
        } else if (action === 'delete') {
            result = roleConfig.deleteCustomRole(cfg, payload.roleId);
            if (!result.ok) return { success: false, error: result.error };
            cfg = roleConfig.writeRoleConfig(CONFIG_DIR, result.config);
        } else if (action === 'activate') {
            result = roleConfig.setActiveRole(cfg, payload.roleId);
            if (!result.ok) return { success: false, error: result.error };
            cfg = roleConfig.writeRoleConfig(CONFIG_DIR, result.config);
        } else if (action === 'reset-active') {
            result = roleConfig.setActiveRole(cfg, roleConfig.DEFAULT_ACTIVE_ROLE_ID);
            if (!result.ok) return { success: false, error: result.error };
            cfg = roleConfig.writeRoleConfig(CONFIG_DIR, result.config);
        } else if (action === 'replace') {
            cfg = roleConfig.writeRoleConfig(CONFIG_DIR, payload.config || {});
        } else {
            return { success: false, error: '未知操作' };
        }

        // 角色自带 voicePackId 时同步到语音绑定表
        try {
            if (action === 'upsert' && result && result.role) {
                const packId = result.role.voicePackId || (result.role.voice && result.role.voice.packId);
                if (packId) voiceRuntime.bindRoleVoice(result.role.id, packId);
            }
            if ((action === 'activate' || action === 'reset-active') && result && result.role) {
                const packId = result.role.voicePackId || (result.role.voice && result.role.voice.packId);
                if (packId) {
                    voiceRuntime.bindRoleVoice(result.role.id, packId);
                    voiceRuntime.setSettings({ activePackId: packId });
                }
            }
        } catch (e) {}

        __roleConfigWatchIgnoreUntil = Date.now() + 800;
        const sync = syncActiveRoleToSoulMd(cfg);
        const data = roleConfig.toClientPayload(cfg);
        __roleConfigLastSig = getRoleConfigSignature();
        broadcastRoleConfigUpdated({
            data,
            action: action || 'replace',
            soulSynced: !!(sync && sync.success)
        });
        return {
            success: true,
            data,
            soulSynced: !!(sync && sync.success)
        };
    } catch (e) {
        console.error('[RoleConfig] save failed:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('persist-media-prefs', async (event, payload) => {
    try {
        const p = payload && typeof payload === 'object' ? payload : {};
        persistMediaGeneratorPrefs(p.imageGenerator, p.videoGenerator);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('verify-builtin-agnes', async (event, payload) => {
    try {
        const mode = payload && payload.mode === 'connection' ? 'connection' : 'key';
        return await verifyBuiltInAgnesRequest(mode);
    } catch (e) {
        return {
            success: false,
            mode: (payload && payload.mode) || 'key',
            keyIndex: null,
            rotated: false,
            attempts: [{ index: 0, status: 0, statusText: '', ok: false, error: e.message || String(e) }]
        };
    }
});

ipcMain.handle('builtin-agnes-request', async (event, payload) => {
    try {
        return await requestBuiltInAgnes(payload || {});
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('config-save', async (event, newConfig) => {
    try {
        let cleanConfig = JSON.parse(JSON.stringify(newConfig));
        const useBuiltInAgnes = cleanConfig.__nexoraUseBuiltIn === true;
        delete cleanConfig.__nexoraUseBuiltIn;
        // 图片/视频配置写入侧车文件，供 media-cli 与插件读取（openclaw.json 不接受这些顶层字段）
        try {
            const imagePrefs = JSON.parse(JSON.stringify(newConfig.imageGenerator || {}));
            const videoPrefs = JSON.parse(JSON.stringify(newConfig.videoGenerator || {}));
            if (useBuiltInAgnes && _AGNES_PRIMARY_KEY) {
                imagePrefs.apiKey = _AGNES_PRIMARY_KEY;
                videoPrefs.apiKey = _AGNES_PRIMARY_KEY;
            }
            persistMediaGeneratorPrefs(imagePrefs, videoPrefs);
        } catch (e) {}
        // 关键防护：移除不在 OpenClaw 网关根 Schema 中的扩展字段，防止网关启动抛出 Unrecognized keys
        delete cleanConfig.videoGenerator;
        delete cleanConfig.imageGenerator;
        if (useBuiltInAgnes && _AGNES_PRIMARY_KEY) {
            if (!cleanConfig.models) cleanConfig.models = {};
            if (!cleanConfig.models.providers) cleanConfig.models.providers = {};
            if (!cleanConfig.models.providers['agnes-ai']) cleanConfig.models.providers['agnes-ai'] = {};
            cleanConfig.models.providers['agnes-ai'].apiKey = _AGNES_PRIMARY_KEY;
        }
        // 主进程是最终写盘边界：拒绝缺少 provider/model、引用不存在厂家、
        // 把图片模型当聊天模型等错误，并清理空/重复备用项。
        normalizeConfigRouting(cleanConfig, {
            allowedProviders: useBuiltInAgnes ? BUILTIN_ALLOWED_PROVIDERS : [],
            inferLegacyRefs: true
        });
        // OpenClaw 2026.9 的 profile 凭据优先于 models.json。把 Agnes 固定为
        // 单一 profile 权威源，并去掉同值 env 副本，避免首发先撞旧 profile 401。
        const agnesAuthConfig = ensureAgnesAuthProfileConfig(cleanConfig);
        // replaceMeta：按本次保存的显示名/备注全量重写侧车（支持随意改、清空、删厂家）
        stripNonSchemaOpenClawConfig(cleanConfig, { replaceProviderUiMeta: true });

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

        try {
            cleanConfig = ensureVisionModelConfig(cleanConfig).config;
        } catch (e) {}

        try {
            if (sanitizeFeishuConfig(cleanConfig)) {
                console.log('[FeishuFix] Sanitized on config-save');
            }
        } catch (e) {}
        try {
            if (sanitizeQqbotConfig(cleanConfig)) {
                console.log('[QqbotFix] Sanitized account ids on config-save');
            }
        } catch (e) {}
        
        // 不再做空白填充防回滚：填充会让配置和守卫基线的体积只增不减（曾膨胀到 159KB），
        // 之后任何合法删减都必然触发 50% 体积骤降判定被整体还原。
        // 现在 writeConfigFileAtomic 会同步 .bak/.last-good 基线，从根上放行合法写入。
        const newJson = JSON.stringify(cleanConfig, null, 2);

        writeConfigFileAtomic(newJson);

        if (agnesAuthConfig.apiKey) {
            try {
                const authSync = syncAgnesAuthProfileToState({
                    stateDir: CONFIG_DIR,
                    apiKey: agnesAuthConfig.apiKey
                });
                if (authSync.changed) {
                    console.log(`[AgnesAuth] Synced ${authSync.mode || 'auth-store'} profile fingerprint=${authSync.fingerprint}`);
                }
            } catch (e) {
                console.warn('[AgnesAuth] Profile sync on config-save skipped:', e.message);
            }
        }

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

        // 返回给面板时合回显示名/备注（侧车），避免保存后 UI 立刻丢 label
        return { success: true, config: redactBuiltInAgnesCredentials(applyProviderUiMetaToConfig(JSON.parse(JSON.stringify(cleanConfig)))) };
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
        writeConfigFileAtomic(JSON.stringify(config, null, 2));
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
        stopActiveChannelLogin({ suppressFail: true });
        clearWeChatQrWaitTimer();
        wechatQrEmitted = false;
        wechatFailEmitted = true;
        if (wechatLoginSuccessWatcher) {
            clearInterval(wechatLoginSuccessWatcher);
            wechatLoginSuccessWatcher = null;
        }
        forceKillWeChatLoginProcess();

        // 1. 如果Nexora Agent运行中，先停止以解除文件夹句柄锁
        stopGatewayProcess();

        // 2. 物理清除微信缓存目录 openclaw-weixin
        const weixinCachePath = path.join(CONFIG_DIR, 'openclaw-weixin');
        if (fs.existsSync(weixinCachePath)) {
            fs.rmSync(weixinCachePath, { recursive: true, force: true });
        }

        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
                if (!config.channels) config.channels = {};
                const wx = config.channels['openclaw-weixin'] && typeof config.channels['openclaw-weixin'] === 'object'
                    ? config.channels['openclaw-weixin']
                    : {};
                wx.enabled = false;
                wx.accounts = [];
                config.channels['openclaw-weixin'] = wx;
                if (config.plugins && config.plugins.entries && config.plugins.entries['openclaw-weixin']) {
                    config.plugins.entries['openclaw-weixin'].enabled = false;
                }
                writeOpenClawConfigObject(config);
            }
        } catch (cfgErr) {
            console.warn('[WeChat Clear] config cleanup failed:', cfgErr.message);
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
function readWeChatAccountIdsFromDisk() {
    try {
        const weixinCachePath = path.join(CONFIG_DIR, 'openclaw-weixin');
        const ids = [];
        const accountsJsonPath = path.join(weixinCachePath, 'accounts.json');
        if (fs.existsSync(accountsJsonPath)) {
            const accounts = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf8'));
            if (Array.isArray(accounts)) {
                for (const accountId of accounts) {
                    const value = String(accountId || '').trim();
                    if (value && !ids.includes(value)) ids.push(value);
                }
            }
        }
        const accountsDir = path.join(weixinCachePath, 'accounts');
        if (fs.existsSync(accountsDir)) {
            for (const fileName of fs.readdirSync(accountsDir)) {
                if (!fileName.endsWith('.json')) continue;
                const accountId = path.basename(fileName, '.json').trim();
                if (accountId && !ids.includes(accountId)) ids.push(accountId);
            }
        }
        return ids;
    } catch (e) {
        return [];
    }
}

function syncWeChatAccountsToConfig(preferredIds) {
    const accountIds = (Array.isArray(preferredIds) && preferredIds.length ? preferredIds : readWeChatAccountIdsFromDisk())
        .map((id) => String(id || '').trim())
        .filter(Boolean);
    if (accountIds.length === 0) return false;
    let config = {};
    if (fs.existsSync(CONFIG_PATH)) {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    }
    if (!config.channels) config.channels = {};
    const wx = config.channels['openclaw-weixin'] && typeof config.channels['openclaw-weixin'] === 'object'
        ? config.channels['openclaw-weixin']
        : {};
    wx.enabled = true;
    wx.autostart = true;
    wx.accounts = accountIds;
    if (!wx.dmPolicy) wx.dmPolicy = 'open';
    if (!wx.groupPolicy) wx.groupPolicy = 'open';
    if (!Array.isArray(wx.allowFrom)) wx.allowFrom = ['*'];
    if (!Array.isArray(wx.groupAllowFrom)) wx.groupAllowFrom = ['*'];
    config.channels['openclaw-weixin'] = wx;
    if (!config.plugins) config.plugins = {};
    if (!config.plugins.entries) config.plugins.entries = {};
    config.plugins.entries['openclaw-weixin'] = { ...(config.plugins.entries['openclaw-weixin'] || {}), enabled: true };
    if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
    if (!config.plugins.allow.includes('openclaw-weixin')) config.plugins.allow.push('openclaw-weixin');
    writeOpenClawConfigObject(config);
    return true;
}

function getWeChatStatus() {
    try {
        const weixinCachePath = path.join(CONFIG_DIR, 'openclaw-weixin');
        let details = null;
        let bound = false;

        const accountsJsonPath = path.join(weixinCachePath, 'accounts.json');
        if (fs.existsSync(accountsJsonPath)) {
            const accounts = readWeChatAccountIdsFromDisk();
            if (accounts.length > 0) {
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
                    try { syncWeChatAccountsToConfig(accounts); } catch (syncErr) { console.warn('[WeChat Status] config sync failed:', syncErr.message); }
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

// 清空本地持久化系统日志（stdout/stderr 等）
ipcMain.handle('clear-system-logs', async () => {
    try {
        clearGatewayRuntimeLogsForFreshStart();
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
            // 非阻塞：execFile 代替 execSync，避免在 UI 线程同步等待 taskkill（可达数百 ms）
            const { execFile } = require('child_process');
            execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
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
    // 标记已取消，并清掉挂起的成功校验计时器——否则取消后 verifyAndNotify 仍会触发，
    // 误报绑定成功、改写配置并热重载网关
    sess.cancelled = true;
    if (sess.verifyTimer) { clearTimeout(sess.verifyTimer); sess.verifyTimer = null; }
    if (sess.verifyTimer2) { clearTimeout(sess.verifyTimer2); sess.verifyTimer2 = null; }
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

    const nodeExePath = getAvailableNodePath();
    if (!nodeExePath) {
        return { success: false, error: '内置 Node 引擎仍在初始化中（或被安全软件拦截）。请等待 10~15 秒环境就绪后重试。' };
    }
    
    const { spawn } = require('child_process');
    // 默认 TLS 校验开启；仅 NEXORA_INSECURE_TLS=1 时关闭（微信登录会把凭据发往 weixin.qq.com）
    const env = { ...process.env };
    if (/^(1|true|yes)$/i.test(String(process.env.NEXORA_INSECURE_TLS || ''))) {
        env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
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
                    if (sess.cancelled) return; // 已取消：不再上报成功
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
                            sess.verifyTimer2 = setTimeout(() => {
                                if (sess.cancelled) return;
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
                    if (sess.cancelled) return; // 已取消：不改配置、不热重载
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
                            writeConfigFileAtomic(JSON.stringify(cfg, null, 2));
                            console.log('[WeChat Login] 已在 openclaw.json channels 中设置 openclaw-weixin.enabled = true');
                        }
                    } catch (cfgErr) {
                        console.warn('[WeChat Login] 更新 channels 配置失败:', cfgErr.message);
                    }
                    // 凭证已落盘：立刻热重载网关，否则运行中的实例收不到微信消息
                    scheduleGatewayReloadAfterChannelChange('wechat-bind', { startIfStopped: true });
                };
                sess.verifyTimer = setTimeout(verifyAndNotify, 500);
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

    // 如果沙箱还没好，阻塞等待它好（最大 20 秒），实现“即点即用，底层自动等待”
    if (!getAvailableNodePath()) {
        const startWait = Date.now();
        while (Date.now() - startWait < 20000) {
            if (getAvailableNodePath()) break;
            await new Promise(r => setTimeout(r, 1000));
        }
    }

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
        NEXORA_AGENT_PATCH_PATH: patchPath
    };
    // 默认 TLS 校验开启；仅 NEXORA_INSECURE_TLS=1 时关闭（渠道登录会传输账号凭据）
    if (/^(1|true|yes)$/i.test(String(process.env.NEXORA_INSECURE_TLS || ''))) {
        cleanEnv.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    for (const key of Object.keys(cleanEnv)) {
        if (key.toLowerCase().includes('proxy')) delete cleanEnv[key];
    }
    cleanEnv.NODE_OPTIONS = buildPatchedNodeOptions(patchPath, '');
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
    if (cleanConfig.google) {
        delete cleanConfig.google;
    }
    const originalBytes = fs.existsSync(CONFIG_PATH) ? fs.statSync(CONFIG_PATH).size : 39500;
    let newJson = JSON.stringify(cleanConfig, null, 2);
    const newBytes = Buffer.byteLength(newJson, 'utf8');
    if (newBytes < originalBytes) {
        const padSize = originalBytes - newBytes;
        newJson = newJson + '\n' + ' '.repeat(Math.max(0, padSize - 1));
    }
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    writeConfigFileAtomic(newJson);
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
    feishu.defaultAccount = accountId;
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
    config.plugins.entries.feishu.enabled = true;

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
                    scheduleGatewayReloadAfterChannelChange('feishu-bind', { startIfStopped: true });
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

// ========== Google Auth 隔离存储 ==========
function getGoogleAuthPath() {
    return path.join(CONFIG_DIR, 'google-auth.json');
}

function readGoogleAuthData() {
    try {
        const p = getGoogleAuthPath();
        if (fs.existsSync(p)) {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (data && data.tokensEncrypted) {
                if (!safeStorage.isEncryptionAvailable()) return { loggedIn: false };
                data.tokens = JSON.parse(safeStorage.decryptString(Buffer.from(String(data.tokensEncrypted), 'base64')));
                delete data.tokensEncrypted;
            } else if (data && data.tokens && safeStorage.isEncryptionAvailable()) {
                // One-time migration from the legacy plaintext token file.
                writeGoogleAuthData(data);
            }
            return data;
        }
    } catch (_) {}
    return { loggedIn: false };
}

function writeGoogleAuthData(data) {
    try {
        if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
        const stored = JSON.parse(JSON.stringify(data || {}));
        if (stored.tokens) {
            if (!safeStorage.isEncryptionAvailable()) throw new Error('System credential encryption is unavailable');
            stored.tokensEncrypted = safeStorage.encryptString(JSON.stringify(stored.tokens)).toString('base64');
            delete stored.tokens;
        }
        fs.writeFileSync(getGoogleAuthPath(), JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
        try { fs.chmodSync(getGoogleAuthPath(), 0o600); } catch (_) {}
        return true;
    } catch (e) {
        console.error('Failed to write google-auth.json:', e);
        return false;
    }
}

function redactCloudConfigSecrets(value) {
    if (Array.isArray(value)) return value.map(redactCloudConfigSecrets);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
        if (/^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|app[-_]?secret|password|authorization)$/i.test(key)
            || /(?:ApiKey|AccessToken|RefreshToken|ClientSecret|AppSecret)$/i.test(key)) continue;
        out[key] = redactCloudConfigSecrets(child);
    }
    return out;
}

// ========== Google OAuth 登录与云同步 ==========
ipcMain.handle('google-login', async () => {
    try {
        const result = await startGoogleLogin();
        if (result.success && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('google-login-success', result.user);
            writeGoogleAuthData({
                loggedIn: true,
                account: result.user,
                tokens: result.tokens
            });
        } else if (!result.success && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('google-login-failed', { error: result.error });
        }
        return result;
    } catch (e) {
        console.error('Google login failed:', e);
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('google-logout', async () => {
    try {
        cancelGoogleLogin();
        writeGoogleAuthData({ loggedIn: false });
        return { success: true };
    } catch (e) {
        console.error('Google logout failed:', e);
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('google-get-status', async () => {
    const authData = readGoogleAuthData();
    if (authData && authData.loggedIn && authData.account) {
        return { loggedIn: true, account: authData.account };
    }
    return { loggedIn: false };
});

/** 获取并自动刷新 Google Access Token */
async function getValidGoogleAccessToken() {
    const authData = readGoogleAuthData();
    if (!authData || !authData.loggedIn || !authData.tokens) {
        throw new Error('未登录 Google 账号');
    }
    const { access_token, refresh_token } = authData.tokens;
    if (access_token) return access_token;
    if (refresh_token) {
        const newTokens = await refreshAccessToken(refresh_token);
        authData.tokens.access_token = newTokens.access_token;
        if (newTokens.refresh_token) authData.tokens.refresh_token = newTokens.refresh_token;
        writeGoogleAuthData(authData);
        return newTokens.access_token;
    }
    throw new Error('Google Token 已失效，请重新登录');
}

ipcMain.handle('google-sync-upload', async () => {
    try {
        const accessToken = await getValidGoogleAccessToken();
        if (!fs.existsSync(CONFIG_PATH)) throw new Error('本地配置文件不存在');
        let configObj = redactCloudConfigSecrets(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')));
        // 确保清除可能存在的非法根节点 google 键
        delete configObj.google;

        // 打包会话归档与历史数据 (agents/main/sessions)
        const sessionsDir = path.join(CONFIG_DIR, 'agents', 'main', 'sessions');
        let sessionHistoryBundle = null;
        if (fs.existsSync(sessionsDir)) {
            sessionHistoryBundle = { files: {} };
            const indexPath = path.join(sessionsDir, 'sessions.json');
            if (fs.existsSync(indexPath)) {
                try {
                    sessionHistoryBundle['sessions.json'] = fs.readFileSync(indexPath, 'utf8');
                } catch (_) {}
            }
            try {
                const jsonlFiles = fs.readdirSync(sessionsDir).filter((n) => /\.jsonl$/i.test(n) && !/\.trajectory\.jsonl$/i.test(n));
                for (const f of jsonlFiles.slice(0, 50)) {
                    try {
                        const fp = path.join(sessionsDir, f);
                        const stat = fs.statSync(fp);
                        if (stat.size < 2 * 1024 * 1024) { // 单个文件 2MB 以内纳入备份
                            sessionHistoryBundle.files[f] = fs.readFileSync(fp, 'utf8');
                        }
                    } catch (_) {}
                }
            } catch (_) {}
        }

        // 打包完整备份（包含 OpenClaw 核心配置、系统偏好设置及会话归档历史）
        const backupBundle = {
            _backupType: 'nexora-full-backup',
            version: '2.0',
            updatedAt: new Date().toISOString(),
            config: configObj,
            systemPrefs: {
                autostart: isAutoStartEnabled(),
                silentStart: isSilentStartEnabled(),
                autoLaunchGateway: isAutoLaunchGatewayEnabled()
            },
            sessionHistory: sessionHistoryBundle
        };

        const configStr = JSON.stringify(backupBundle, null, 2);
        await uploadConfigToDrive(accessToken, configStr);
        return { success: true };
    } catch (e) {
        console.error('Google Drive Upload Failed:', e);
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('google-sync-download', async () => {
    try {
        const accessToken = await getValidGoogleAccessToken();
        const result = await downloadConfigFromDrive(accessToken);
        if (!result || !result.content) {
            return { success: false, error: 'Google 云盘中暂无配置备份' };
        }
        if (Buffer.byteLength(String(result.content), 'utf8') > 25 * 1024 * 1024) {
            throw new Error('云端备份超过 25MB 安全上限');
        }
        // 校验 JSON 格式
        const remoteData = JSON.parse(result.content);
        let remoteConfig = remoteData;

        // 如果是包含系统偏好与会话归档的整合备份包
        if (remoteData && remoteData._backupType === 'nexora-full-backup' && remoteData.config) {
            remoteConfig = remoteData.config;

            // 恢复系统偏好设置
            if (remoteData.systemPrefs) {
                try {
                    if (typeof remoteData.systemPrefs.autostart === 'boolean') {
                        setAutoStartEnabled(remoteData.systemPrefs.autostart);
                    }
                    if (typeof remoteData.systemPrefs.silentStart === 'boolean') {
                        setSilentStartEnabled(remoteData.systemPrefs.silentStart);
                    }
                    if (typeof remoteData.systemPrefs.autoLaunchGateway === 'boolean') {
                        setAutoLaunchGatewayEnabled(remoteData.systemPrefs.autoLaunchGateway);
                    }
                } catch (err) {
                    console.warn('[GoogleSync] Restoring systemPrefs failed:', err);
                }
            }

            // 恢复会话归档历史 (agents/main/sessions)
            if (remoteData.sessionHistory) {
                try {
                    const targetSessionsDir = path.join(CONFIG_DIR, 'agents', 'main', 'sessions');
                    if (!fs.existsSync(targetSessionsDir)) fs.mkdirSync(targetSessionsDir, { recursive: true });

                    if (typeof remoteData.sessionHistory['sessions.json'] === 'string'
                        && Buffer.byteLength(remoteData.sessionHistory['sessions.json'], 'utf8') <= 5 * 1024 * 1024) {
                        fs.writeFileSync(path.join(targetSessionsDir, 'sessions.json'), remoteData.sessionHistory['sessions.json'], 'utf8');
                    }
                    if (remoteData.sessionHistory.files && typeof remoteData.sessionHistory.files === 'object') {
                        Object.entries(remoteData.sessionHistory.files).forEach(([fileName, fileContent]) => {
                            try {
                                if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jsonl$/i.test(fileName)) return;
                                if (typeof fileContent !== 'string' || Buffer.byteLength(fileContent, 'utf8') > 2 * 1024 * 1024) return;
                                const targetPath = path.resolve(targetSessionsDir, fileName);
                                const sessionsRoot = path.resolve(targetSessionsDir) + path.sep;
                                if (!targetPath.startsWith(sessionsRoot)) return;
                                fs.writeFileSync(targetPath, fileContent, 'utf8');
                            } catch (_) {}
                        });
                    }
                    console.log('[GoogleSync] Restored session history successfully');
                } catch (err) {
                    console.warn('[GoogleSync] Restoring sessionHistory failed:', err);
                }
            }
        }

        // 如果云端配置包含非法的根节点 google，自动迁移存入 google-auth.json 并从 openclaw.json 移除
        if (remoteConfig.google) {
            if (remoteConfig.google.account && remoteConfig.google.tokens) {
                writeGoogleAuthData({
                    loggedIn: true,
                    account: remoteConfig.google.account,
                    tokens: remoteConfig.google.tokens
                });
            }
            delete remoteConfig.google;
        }
        // Never re-import secrets from legacy/tampered cloud backups. Account
        // credentials remain local and must be re-entered on a new device.
        remoteConfig = redactCloudConfigSecrets(remoteConfig);
        // 保存规范化后的云端配置到 openclaw.json
        writeOpenClawConfigObject(remoteConfig);
        return { success: true, config: remoteConfig };
    } catch (e) {
        console.error('Google Drive Download Failed:', e);
        return { success: false, error: e.message || String(e) };
    }
});


// 客户端轻量偏好统一落 SQLite。渲染层仍可使用 localStorage 作为同步读取缓存，
// 但数据库是跨重启/升级的权威副本；约定 setting_* 等安全键会自动持久化。
ipcMain.on('client-settings-bootstrap-sync', (event, legacyValues) => {
    try {
        const values = getClientSettingsStore().bootstrap(
            'renderer',
            legacyValues,
            isSafeRendererSettingKey
        );
        const safeValues = Object.create(null);
        for (const [key, value] of Object.entries(values)) {
            if (isSafeRendererSettingKey(key) && typeof value === 'string') safeValues[key] = value;
        }
        event.returnValue = { success: true, values: safeValues };
    } catch (e) {
        console.warn('[ClientSettings] renderer bootstrap failed:', e && e.message);
        event.returnValue = { success: false, values: {}, error: e && e.message };
    }
});

ipcMain.handle('client-settings-set', async (_event, key, value) => {
    if (!isSafeRendererSettingKey(key) || typeof value !== 'string') {
        return { success: false, error: 'unsupported client setting' };
    }
    try {
        getClientSettingsStore().set('renderer', key, value);
        return { success: true };
    } catch (e) {
        return { success: false, error: e && e.message ? e.message : String(e) };
    }
});

ipcMain.handle('client-settings-remove', async (_event, key) => {
    if (!isSafeRendererSettingKey(key)) return { success: false, error: 'unsupported client setting' };
    try {
        getClientSettingsStore().remove('renderer', key);
        return { success: true };
    } catch (e) {
        return { success: false, error: e && e.message ? e.message : String(e) };
    }
});

ipcMain.handle('client-settings-clear', async () => {
    try {
        getClientSettingsStore().clear('renderer');
        return { success: true };
    } catch (e) {
        return { success: false, error: e && e.message ? e.message : String(e) };
    }
});

// 开机自启的设置与获取
// 开机自启：Windows 上 get/set 必须使用相同的 path + args，否则会读成 false
function autoStartSettingsPath() {
    try {
        return path.join(app.getPath('userData'), 'autostart.json');
    } catch (e) {
        return path.join(CONFIG_DIR || process.cwd(), 'autostart.json');
    }
}

function buildLoginItemOptions(enabled) {
    const on = Boolean(enabled);
    const silent = isSilentStartEnabled();
    const opts = {
        openAtLogin: on,
        openAsHidden: on ? silent : false,
        path: process.execPath,
        args: (on && silent) ? ['--silent'] : [],
    };
    try {
        // 固定注册表项名，避免开发版 electron.exe 与安装版同名冲突时读错
        opts.name = String(app.getName() || 'Nexora Agent');
    } catch (_) {}
    return opts;
}

function readPersistedAutoStart() {
    const stored = readClientSystemSetting('autostart', null);
    if (typeof stored === 'boolean') return stored;
    try {
        const p = autoStartSettingsPath();
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(raw);
        if (data && typeof data.enabled === 'boolean') {
            return seedClientSystemSetting('autostart', data.enabled);
        }
    } catch (e) {}
    return null;
}

function writePersistedAutoStart(enabled) {
    const on = Boolean(enabled);
    writeClientSystemSetting('autostart', on);
    const p = autoStartSettingsPath();
    try {
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ enabled: on, updatedAt: Date.now() }, null, 2), 'utf8');
    } catch (e) {
        console.warn('[AutoStart] persist failed:', e && e.message);
    }
    return on;
}

function queryOsAutoStart() {
    try {
        const probeSilent = buildLoginItemOptions(true);
        // 与写入时相同的 path；分别探测带/不带 --silent 的注册项
        const a = app.getLoginItemSettings({
            path: probeSilent.path,
            args: probeSilent.args,
        });
        if (a && a.openAtLogin) return true;
        const b = app.getLoginItemSettings({
            path: process.execPath,
            args: [],
        });
        return !!(b && b.openAtLogin);
    } catch (e) {
        try {
            return !!app.getLoginItemSettings().openAtLogin;
        } catch (_) {
            return false;
        }
    }
}

function isAutoStartEnabled() {
    const persisted = readPersistedAutoStart();
    if (persisted !== null) return persisted;
    return seedClientSystemSetting('autostart', queryOsAutoStart());
}

function setAutoStartEnabled(enabled) {
    const on = writePersistedAutoStart(enabled);
    try {
        app.setLoginItemSettings(buildLoginItemOptions(on));
    } catch (e) {
        console.warn('[AutoStart] setLoginItemSettings failed:', e && e.message);
    }
    return on;
}

/** 启动时把本地偏好重新写回系统登录项，避免 OS 读不一致 */
function syncAutoStartLoginItemFromPersisted() {
    const persisted = readPersistedAutoStart();
    if (persisted === null) return;
    try {
        app.setLoginItemSettings(buildLoginItemOptions(persisted));
    } catch (e) {
        console.warn('[AutoStart] sync failed:', e && e.message);
    }
}

ipcMain.handle('autostart-get', async () => {
    return isAutoStartEnabled();
});

function silentStartSettingsPath() {
    try {
        return path.join(app.getPath('userData'), 'silent-start.json');
    } catch (e) {
        return path.join(CONFIG_DIR || process.cwd(), 'silent-start.json');
    }
}

function isSilentStartEnabled() {
    const stored = readClientSystemSetting('silentStart', null);
    if (typeof stored === 'boolean') return stored;
    try {
        const p = silentStartSettingsPath();
        if (!fs.existsSync(p)) return seedClientSystemSetting('silentStart', false);
        const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(raw);
        return seedClientSystemSetting('silentStart', !!(data && data.enabled === true));
    } catch (e) {
        return seedClientSystemSetting('silentStart', false);
    }
}

function setSilentStartEnabled(enabled) {
    const on = Boolean(enabled);
    writeClientSystemSetting('silentStart', on);
    const p = silentStartSettingsPath();
    try {
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ enabled: on }, null, 2), 'utf8');
    } catch (e) {
        console.warn('[SilentStart] write failed:', e && e.message);
    }
    // 与开机自启配合：静默时带 --silent，便于系统登录项识别
    try {
        if (isAutoStartEnabled()) {
            app.setLoginItemSettings(buildLoginItemOptions(true));
        }
    } catch (e) {}
    return on;
}

ipcMain.handle('silent-start-get', async () => {
    return isSilentStartEnabled();
});

ipcMain.handle('silent-start-set', async (event, enabled) => {
    return setSilentStartEnabled(enabled);
});

function autoLaunchGatewaySettingsPath() {
    try {
        return path.join(app.getPath('userData'), 'auto-launch-gateway.json');
    } catch (e) {
        return path.join(CONFIG_DIR || process.cwd(), 'auto-launch-gateway.json');
    }
}

/** 未写入配置文件时默认关闭（仅左上角手动启用；用户可在系统设置中打开） */
function isAutoLaunchGatewayEnabled() {
    const stored = readClientSystemSetting('autoLaunchGateway', null);
    if (typeof stored === 'boolean') return stored;
    try {
        const p = autoLaunchGatewaySettingsPath();
        if (!fs.existsSync(p)) return seedClientSystemSetting('autoLaunchGateway', false);
        const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(raw);
        return seedClientSystemSetting('autoLaunchGateway', !!(data && data.enabled === true));
    } catch (e) {
        return seedClientSystemSetting('autoLaunchGateway', false);
    }
}

function setAutoLaunchGatewayEnabled(enabled) {
    const on = Boolean(enabled);
    writeClientSystemSetting('autoLaunchGateway', on);
    const p = autoLaunchGatewaySettingsPath();
    try {
        const dir = path.dirname(p);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ enabled: on }, null, 2), 'utf8');
    } catch (e) {
        console.warn('[AutoLaunchGateway] write failed:', e && e.message);
    }
    return on;
}

ipcMain.handle('auto-launch-gateway-get', async () => {
    return isAutoLaunchGatewayEnabled();
});

ipcMain.handle('auto-launch-gateway-set', async (event, enabled) => {
    return setAutoLaunchGatewayEnabled(enabled);
});

function customThemeBgDir() {
    return path.join(app.getPath('userData'), 'custom-theme');
}

function findCustomThemeBackgroundFile() {
    try {
        const dir = customThemeBgDir();
        if (!fs.existsSync(dir)) return null;
        const files = fs.readdirSync(dir).filter((n) => /^background\./i.test(n));
        if (!files.length) return null;
        return path.join(dir, files[0]);
    } catch (e) {
        return null;
    }
}

function mimeForImageExt(ext) {
    const e = String(ext || '').toLowerCase();
    if (e === '.png') return 'image/png';
    if (e === '.webp') return 'image/webp';
    if (e === '.gif') return 'image/gif';
    if (e === '.bmp') return 'image/bmp';
    return 'image/jpeg';
}

/** 转 data URL，避免 file:// 在 Electron 渲染进程 CSS 中被拦截导致“图片不生效” */
function imageFileToDataUrl(filePath) {
    const buf = fs.readFileSync(filePath);
    const mime = mimeForImageExt(path.extname(filePath));
    return `data:${mime};base64,${buf.toString('base64')}`;
}

ipcMain.handle('theme-pick-background', async () => {
    try {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow || undefined, {
            title: '选择自定义主题背景图',
            properties: ['openFile'],
            filters: [
                { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        if (canceled || !filePaths || !filePaths[0]) return { success: false, canceled: true };
        const src = filePaths[0];
        const dir = customThemeBgDir();
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        try {
            for (const name of fs.readdirSync(dir)) {
                if (/^background\./i.test(name)) {
                    try { fs.unlinkSync(path.join(dir, name)); } catch (e) {}
                }
            }
        } catch (e) {}
        let ext = path.extname(src) || '.jpg';
        if (!/^\.(jpe?g|png|webp|gif|bmp)$/i.test(ext)) ext = '.jpg';
        const dest = path.join(dir, 'background' + ext.toLowerCase());
        fs.copyFileSync(src, dest);
        // 用自定义协议，避免 file:// / 超大 data URL 在 CSS 里失效
        return { success: true, fileUrl: `nexora-bg://wallpaper?v=${Date.now()}`, path: dest };
    } catch (e) {
        return { success: false, error: e && e.message ? e.message : String(e) };
    }
});

ipcMain.handle('theme-get-background', async () => {
    try {
        const file = findCustomThemeBackgroundFile();
        if (!file) return { success: true, fileUrl: null };
        const mtime = fs.statSync(file).mtimeMs || Date.now();
        return { success: true, fileUrl: `nexora-bg://wallpaper?v=${Math.floor(mtime)}`, path: file };
    } catch (e) {
        return { success: false, error: e && e.message ? e.message : String(e) };
    }
});

ipcMain.handle('theme-clear-background', async () => {
    try {
        const dir = customThemeBgDir();
        if (fs.existsSync(dir)) {
            for (const name of fs.readdirSync(dir)) {
                if (/^background\./i.test(name)) {
                    try { fs.unlinkSync(path.join(dir, name)); } catch (e) {}
                }
            }
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e && e.message ? e.message : String(e) };
    }
});

// 获取应用当前版本号
ipcMain.handle('get-app-version', async () => {
    return app.getVersion();
});

// 剪贴板原生复制
ipcMain.handle('copy-text', async (event, text) => {
    try {
        if (typeof text === 'string') {
            clipboard.writeText(text);
            return { success: true };
        }
        return { success: false, error: 'invalid_text' };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('autostart-set', async (event, enabled) => {
    return setAutoStartEnabled(!!enabled);
});

// ─── 加速通道（mihomo）───────────────────────────────────────────
async function applyElectronSessionProxy(enabled) {
    try {
        const ses = session.defaultSession;
        if (!ses || !ses.setProxy) return;
        if (enabled) {
            const port = acceleration.MIXED_PORT || 17890;
            await ses.setProxy({
                proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`,
                proxyBypassRules: 'localhost,127.0.0.1,<local>,*.weixin.qq.com,*.qq.com,bots.qq.com,*.feishu.cn,open.feishu.cn,*.larksuite.com,*.agnes-ai.com,apihub.agnes-ai.com'
            });
        } else {
            await ses.setProxy({ mode: 'direct' });
        }
    } catch (e) {
        console.warn('[Acceleration] setProxy failed:', e.message);
    }
}

ipcMain.handle('app-instance-info', async () => {
    const inst = global.nexoraInstance || { id: 1, isPrimary: true, dir: app.getPath('userData') };
    return {
        success: true,
        id: inst.id || 1,
        isPrimary: !!inst.isPrimary,
        userData: inst.dir || app.getPath('userData'),
        gatewayPortHint: inst.gatewayPortHint || 18789
    };
});

ipcMain.handle('acceleration-status', async () => {
    try { return { success: true, ...(await acceleration.getDashboardData()) }; }
    catch (e) { return { success: false, error: e.message || String(e) }; }
});

ipcMain.handle('local-network-address', () => {
    const interfaces = require('os').networkInterfaces();
    for (const addresses of Object.values(interfaces)) {
        for (const address of addresses || []) {
            if (!address.internal && (address.family === 'IPv4' || address.family === 4)) return address.address;
        }
    }
    return '127.0.0.1';
});

ipcMain.handle('acceleration-get-connections', async () => {
    try { return { success: true, ...(await acceleration.getConnections()) }; }
    catch (e) { return { success: false, error: e.message || String(e) }; }
});

ipcMain.handle('acceleration-close-connection', async (event, id) => {
    try { return await acceleration.closeConnection(id); }
    catch (e) { return { success: false, error: e.message || String(e) }; }
});

ipcMain.handle('acceleration-set-enabled', async (event, enabled, profileId) => {
    try {
        if (enabled) __nexoraAccelUsed = true; // 标记用过加速：崩溃时才需应急清代理/杀内核
        const onProgress = (p) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('acceleration-core-progress', p);
            }
        };
        const status = await acceleration.setEnabled(!!enabled, profileId || null, enabled ? onProgress : null);
        await applyElectronSessionProxy(!!status.enabled);
        return { success: true, ...status };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-ensure-core', async () => {
    try {
        const result = await acceleration.ensureCore((p) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('acceleration-core-progress', p);
            }
        });
        return result;
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-add-url', async (event, url, name) => {
    try {
        const profile = await acceleration.addProfileFromUrl(url, name);
        // 只添加，不切换当前使用中的配置、不跳代理页
        return { success: true, profile, ...(await acceleration.getDashboardData()) };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-add-file', async (event, filePath, name) => {
    try {
        const profile = acceleration.addProfileFromFile(filePath, name);
        return { success: true, profile, ...(await acceleration.getDashboardData()) };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-add-content', async (event, content, name) => {
    try {
        const profile = acceleration.addProfileFromContent(content, name, { source: 'qr' });
        return { success: true, profile, ...(await acceleration.getDashboardData()) };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-pick-file', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow || undefined, {
            title: '选择加速配置文件',
            filters: [
                { name: 'Clash / Mihomo', extensions: ['yaml', 'yml', 'txt', 'conf'] },
                { name: 'All', extensions: ['*'] }
            ],
            properties: ['openFile']
        });
        if (result.canceled || !result.filePaths || !result.filePaths[0]) {
            return { success: false, canceled: true };
        }
        const profile = acceleration.addProfileFromFile(result.filePaths[0]);
        return { success: true, profile, ...(await acceleration.getDashboardData()) };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-remove-profile', async (event, id) => {
    try {
        acceleration.removeProfile(id);
        return { success: true, ...(await acceleration.getDashboardData()) };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-rename-profile', async (event, id, name) => {
    try {
        const profile = acceleration.renameProfile(id, name);
        return { success: true, profile, ...(await acceleration.getDashboardData()) };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-update-profile', async (event, id) => {
    try {
        const profile = await acceleration.updateProfileFromUrl(id);
        return { success: true, profile, ...(await acceleration.getDashboardData(id)) };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-select-proxy', async (event, payload) => {
    try {
        const name = typeof payload === 'string' ? payload : (payload && payload.name);
        const group = typeof payload === 'object' && payload ? payload.group : 'GLOBAL';
        if (!name) return { success: false, error: '未指定节点' };
        await acceleration.selectProxy(group || 'GLOBAL', name);
        return { success: true, ...(await acceleration.getDashboardData()) };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-delay-test', async (event, names) => {
    try {
        __nexoraAccelUsed = true; // 测速会拉起临时 mihomo 内核，崩溃时需应急清理
        // 记录用户在测速前是否已手动启用。未启用时 acceleration.delayTest
        // 会使用临时内核，完成后自动关闭，不能改变用户的启用状态。
        const manuallyEnabled = !!acceleration.getStatus().enabled;
        const results = await acceleration.delayTest(names, {
            onProgress: (payload) => {
                try {
                    if (event && event.sender && !event.sender.isDestroyed()) {
                        event.sender.send('acceleration-delay-progress', payload);
                    }
                } catch (e) {}
            }
        });
        const dash = await acceleration.getDashboardData();
        // 双保险：显式把测速结果写回节点，避免被内核 history 虚高值盖住
        if (results && Array.isArray(dash.nodes)) {
            for (const node of dash.nodes) {
                if (Object.prototype.hasOwnProperty.call(results, node.name)) {
                    node.latency = results[node.name];
                }
            }
        }
        return {
            success: true,
            results,
            temporaryTest: !manuallyEnabled,
            ...dash
        };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-detect-ip', async () => {
    console.log('[IPC] Received acceleration-detect-ip call');
    try {
        const res = await acceleration.detectOutboundIp();
        console.log('[IPC] acceleration-detect-ip result:', res);
        return res;
    } catch (e) {
        console.error('[IPC] acceleration-detect-ip failed:', e);
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('acceleration-set-options', async (event, options) => {
    try {
        const status = await acceleration.setOptions(options || {});
        await applyElectronSessionProxy(!!status.enabled);
        const dash = { success: true, ...status };
        if (status && status.warning) dash.warning = status.warning;
        return dash;
    } catch (e) {
        let dash = {};
        try { dash = await acceleration.getDashboardData(); } catch (e2) {}
        return { success: false, error: e.message || String(e), ...dash };
    }
});

ipcMain.handle('acceleration-set-active-profile', async (event, id) => {
    try {
        await acceleration.setActiveProfileId(id);
        const st = acceleration.getStatus();
        if (st.enabled) {
            await acceleration.setEnabled(true, id);
            await applyElectronSessionProxy(true);
        }
        return { success: true, ...(await acceleration.getDashboardData()) };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

// 读取本地真实大模型调用统计 (使用纯原生 Node.js 实现，彻底剔除外部 Python 脚本依赖，实现 100% 开箱即用)
ipcMain.handle('stats-get', async () => {
    try {
        const stats = {
            total_tokens: 0,
            total_requests: 0,
            total_cost: null,
            cost_known: true,
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
                    const providersByModel = new Map();
                    const pricingByRoute = new Map();
                    try {
                        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
                        for (const [providerKey, provider] of Object.entries(cfg && cfg.models && cfg.models.providers || {})) {
                            for (const model of Array.isArray(provider && provider.models) ? provider.models : []) {
                                const modelId = String(model && model.id || '').trim();
                                if (!modelId) continue;
                                const current = providersByModel.get(modelId);
                                providersByModel.set(modelId, current && current !== providerKey ? '' : providerKey);
                                if (model && model.cost && typeof model.cost === 'object') {
                                    pricingByRoute.set(`${providerKey}/${modelId}`, model.cost);
                                }
                            }
                        }
                    } catch (_) {}
                    const toNonNegativeNumber = (value) => {
                        const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
                        return Number.isFinite(n) && n >= 0 ? n : 0;
                    };
                    const resolveTimestamp = (log) => {
                        const direct = Number(log && log.timestamp);
                        if (Number.isFinite(direct) && direct > 0) return direct;
                        const raw = String(log && log.time || '').trim();
                        if (raw) {
                            const parsed = Date.parse(raw.includes('T') || raw.includes('-') ? raw : `${new Date().toISOString().slice(0, 10)}T${raw}`);
                            if (Number.isFinite(parsed)) return parsed;
                        }
                        return 0;
                    };
                    for (const log of realLogs) {
                        const m_name = log.model || 'unknown-model';
                        const legacyClientMarker = ['dialog-test', 'image-gen', 'video-gen'].includes(String(log.provider || ''));
                        const p_name = legacyClientMarker ? (providersByModel.get(m_name) || 'unknown-provider') : (log.provider || 'gateway');
                        const input_t = toNonNegativeNumber(log.input);
                        const output_t = toNonNegativeNumber(log.output);
                        const hit_t = toNonNegativeNumber(log.hit);
                        // Older Nexora builds wrote a fake 3000+500 record for
                        // every gateway console line. Keep the raw file intact
                        // but exclude this unmarked legacy estimate from the
                        // displayed totals so historical dashboards are not
                        // permanently inflated.
                        if (!log.source && input_t === 3000 && output_t === 500 && hit_t === 0) continue;
                        const elapsed_str = log.duration || '1.0s';
                        
                        let elapsed_ms = 1000;
                        try {
                            const parsedElapsed = Number.parseFloat(String(elapsed_str).replace('s', '')) * 1000;
                            if (Number.isFinite(parsedElapsed) && parsedElapsed >= 0) elapsed_ms = parsedElapsed;
                        } catch(e) {}
                        
                        const timestamp = resolveTimestamp(log);
                        // Cached tokens are a subset of input tokens, not an
                        // additional billable quantity. Never add them twice.
                        const total_tokens = input_t + output_t;
                        const explicitCost = log.cost == null ? Number.NaN : Number(log.cost);
                        const pricing = pricingByRoute.get(`${p_name}/${m_name}`);
                        const inputPrice = Number(pricing && pricing.input);
                        const outputPrice = Number(pricing && pricing.output);
                        const cacheReadPrice = Number(pricing && (pricing.cacheRead ?? pricing.cache_read));
                        const computedCost = Number.isFinite(explicitCost) && explicitCost >= 0
                            ? explicitCost
                            : (Number.isFinite(inputPrice) && Number.isFinite(outputPrice)
                                ? ((Math.max(0, input_t - hit_t) * inputPrice + output_t * outputPrice + hit_t * (Number.isFinite(cacheReadPrice) ? cacheReadPrice : inputPrice)) / 1000000)
                                : null);
                        
                        stats.total_tokens += total_tokens;
                        stats.total_requests += 1;
                        stats.sub_input_tokens += input_t;
                        stats.sub_output_tokens += output_t;
                        stats.sub_hit_tokens += hit_t;
                        if (computedCost == null) stats.cost_known = false;
                        else stats.total_cost = (stats.total_cost || 0) + computedCost;
                        
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
                        stats.providers[p_name].tokens += total_tokens;
                        stats.providers[p_name].hit += hit_t;
                        
                        const model_key = `${p_name}/${m_name}`;
                        if (!stats.models[model_key]) {
                            stats.models[model_key] = { provider: p_name, model: m_name, calls: 0, tokens: 0, duration: 0.0, hit: 0 };
                        }
                        stats.models[model_key].calls += 1;
                        stats.models[model_key].tokens += total_tokens;
                        stats.models[model_key].duration += (elapsed_ms / 1000.0);
                        stats.models[model_key].hit += hit_t;
                        
                        const time_str = log.time || (timestamp > 0 ? `${dt.getHours().toString().padStart(2, '0')}:${dt.getMinutes().toString().padStart(2, '0')}:${dt.getSeconds().toString().padStart(2, '0')}` : '未知时间');
                        stats.logs.push({
                            time: time_str,
                            provider: p_name,
                            model: m_name,
                            input: input_t,
                            output: output_t,
                            hit: hit_t,
                            duration: elapsed_str,
                            status: log.status || '成功',
                            timestamp: timestamp,
                            source: log.source || (legacyClientMarker ? 'client' : 'gateway'),
                            isPlugin: log.isPlugin === true,
                            cost: computedCost
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
        
        if (!stats.total_requests) {
            stats.total_cost = 0;
            stats.cost_known = true;
        } else if (!stats.cost_known) {
            stats.total_cost = null;
        }
        
        // 保留全部明细，前端筛选器才能与汇总卡片使用同一数据范围。
        stats.logs.sort((a, b) => b.timestamp - a.timestamp);

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
            let parseFailed = false;
            try {
                const content = fs.readFileSync(realTokensPath, 'utf8');
                realLogs = JSON.parse(content);
            } catch (e) { parseFailed = true; }
            // 解析失败(可能读到网关半截写入)：不要清空重来，避免把网关刚写的历史抹掉；本次直接跳过追加
            if (parseFailed) return true;
            if (!Array.isArray(realLogs)) realLogs = [];

            if (!logEntry.time) {
                const dt = new Date();
                const pad = (n) => n < 10 ? '0' + n : n;
                logEntry.time = `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
            }
            if (!logEntry.timestamp) logEntry.timestamp = Date.now();
            if (!logEntry.status) logEntry.status = '成功';

            realLogs.push(logEntry);
            // Keep newest entries first, matching the gateway writer. This
            // prevents an append from retaining stale rows and dropping the
            // newest usage record when the 1000-row cap is reached.
            realLogs.sort((a, b) => Number(b && b.timestamp || 0) - Number(a && a.timestamp || 0));
            if (realLogs.length > 1000) realLogs = realLogs.slice(0, 1000);
            // 原子写(临时文件 + rename)，避免网关并发读到半截 JSON 而误判损坏后清空
            const tmp = realTokensPath + `.tmp-${process.pid}-${Date.now()}`;
            fs.writeFileSync(tmp, JSON.stringify(realLogs, null, 2), 'utf8');
            fs.renameSync(tmp, realTokensPath);
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

// ─── 数据中心（嵌入 openclaw-dashboard，读 CONFIG_DIR 下 SQLite）───
let dataCenterRuntime = null;
let dataCenterStartPromise = null;

function getDataCenterServerPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'app.asar.unpacked', 'data-center', 'server.js');
    }
    return path.join(__dirname, 'data-center', 'server.js');
}

async function ensureDataCenterServer() {
    if (dataCenterRuntime && dataCenterRuntime.process && !dataCenterRuntime.process.killed) {
        return {
            ok: true,
            url: `${dataCenterRuntime.url}#token=${encodeURIComponent(dataCenterRuntime.accessToken)}`,
            port: dataCenterRuntime.port,
        };
    }

    if (dataCenterStartPromise) return dataCenterStartPromise;

    dataCenterStartPromise = (async () => {
        const serverPath = getDataCenterServerPath();
        if (!fs.existsSync(serverPath)) {
            throw new Error('data-center/server.js missing');
        }
        const nodePath = getAvailableNodePath();
        if (!nodePath) throw new Error('未找到 Node.js 22+，无法启动数据中心隔离进程');
        const accessToken = require('crypto').randomBytes(32).toString('hex');
        const child = fork(serverPath, [], {
            execPath: nodePath,
            cwd: path.dirname(serverPath),
            windowsHide: true,
            env: {
                ...process.env,
                NEXORA_DATA_CENTER_STATE_DIR: CONFIG_DIR,
                NEXORA_DATA_CENTER_PORT: '3210',
                NEXORA_DATA_CENTER_TOKEN: accessToken,
            },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        const runtime = await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                child.removeAllListeners('message');
                child.removeAllListeners('error');
                child.removeAllListeners('exit');
                fn(value);
            };
            const timeout = setTimeout(() => finish(reject, new Error('数据中心启动超时')), 15000);
            child.on('message', (message) => {
                if (message && message.type === 'ready') {
                    finish(resolve, {
                        process: child,
                        port: Number(message.port),
                        url: String(message.url),
                        dbEngine: message.dbEngine,
                        accessToken,
                    });
                } else if (message && message.type === 'error') {
                    finish(reject, new Error(String(message.error || '数据中心启动失败')));
                }
            });
            child.once('error', (error) => finish(reject, error));
            child.once('exit', (code) => finish(reject, new Error(`数据中心进程提前退出 (${code})`)));
        });
        child.once('exit', () => {
            if (dataCenterRuntime && dataCenterRuntime.process === child) dataCenterRuntime = null;
        });
        dataCenterRuntime = runtime;
        return {
            ok: true,
            url: `${runtime.url}#token=${encodeURIComponent(accessToken)}`,
            port: runtime.port,
        };
    })().catch((err) => {
        dataCenterStartPromise = null;
        dataCenterRuntime = null;
        throw err;
    });

    return dataCenterStartPromise;
}

async function stopDataCenterServer() {
    const runtime = dataCenterRuntime;
    dataCenterRuntime = null;
    dataCenterStartPromise = null;
    if (!runtime || !runtime.process) return;
    await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve();
        };
        const timeout = setTimeout(() => {
            try { runtime.process.kill(); } catch (_) {}
            finish();
        }, 1500);
        try {
            runtime.process.once('exit', finish);
            runtime.process.send({ type: 'shutdown' });
        } catch (_) {
            finish();
        }
    });
}

ipcMain.handle('data-center-get-url', async () => {
    try {
        return await ensureDataCenterServer();
    } catch (err) {
        console.error('[DataCenter] start failed:', err);
        return {
            ok: false,
            error: (err && err.message) ? String(err.message) : String(err),
        };
    }
});


function normalizeHistoryText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.map((item) => {
            if (!item) return '';
            if (typeof item === 'string') return item;
            if (item.type === 'text') return item.text || '';
            if (item.text) return item.text;
            if (item.image_url || item.type === 'image_url') return '[图片]';
            return '';
        }).filter(Boolean).join('\n');
    }
    if (typeof value === 'object') return value.text || value.content || '';
    return String(value);
}

function readOpenClawSessionsIndex(sessionsDir) {
    const indexPath = path.join(sessionsDir, 'sessions.json');
    try {
        const raw = fs.readFileSync(indexPath, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return {};
    }
}

function buildSessionIndexById(indexObj) {
    const byId = new Map();
    Object.entries(indexObj || {}).forEach(([key, value]) => {
        if (value && value.sessionId) byId.set(value.sessionId, { key, ...value });
        const ids = Array.isArray(value && value.usageFamilySessionIds) ? value.usageFamilySessionIds : [];
        ids.forEach((id) => {
            if (!byId.has(id)) byId.set(id, { key, ...value, sessionId: id });
        });
    });
    return byId;
}

function parseOpenClawJsonlSession(filePath, indexById) {
    const baseName = path.basename(filePath).replace(/\.jsonl$/i, '');
    let stat;
    try { stat = fs.statSync(filePath); } catch (_) { stat = null; }
    const meta = indexById.get(baseName) || {};
    const messages = [];
    let provider = '';
    let model = '';
    let startedAt = stat ? stat.birthtime.toISOString() : new Date().toISOString();
    let updatedAt = stat ? stat.mtime.toISOString() : startedAt;
    try {
        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
            let entry;
            try { entry = JSON.parse(line); } catch (_) { continue; }
            if (entry.timestamp) {
                if (!startedAt || entry.type === 'session') startedAt = entry.timestamp;
                updatedAt = entry.timestamp;
            }
            if (entry.type === 'model_change') {
                provider = entry.provider || provider;
                model = entry.modelId || model;
            }
            if (entry.type === 'message' && entry.message) {
                const role = entry.message.role === 'assistant' ? 'assistant' : 'user';
                const text = normalizeHistoryText(entry.message.content).trim();
                if (text) messages.push({ id: entry.id || `msg_${messages.length}`, role, content: text, createdAt: entry.timestamp || updatedAt });
            }
        }
    } catch (_) {}
    if (!messages.length) return null;
    const route = meta.route || {};
    const channel = meta.lastChannel || meta.deliveryContext?.channel || route.channel || '';
    const target = meta.origin?.label || meta.lastTo || meta.deliveryContext?.to || route.target?.to || '';
    const firstUser = messages.find((m) => m.role === 'user') || messages[0];
    const titleSource = normalizeHistoryText(firstUser && firstUser.content).trim() || baseName;
    const title = titleSource.length > 28 ? `${titleSource.slice(0, 28)}…` : titleSource;
    const summary = messages.slice(0, 4).map((m) => m.content).filter(Boolean).join(' / ').slice(0, 180);
    const tags = ['OpenClaw历史'];
    if (channel) tags.push(channel.replace(/^openclaw-/, ''));
    if (target) tags.push('通讯渠道');
    return {
        id: `openclaw:${baseName}`,
        source: 'openclaw',
        readOnly: true,
        title,
        summary,
        tags,
        model: [provider, model].filter(Boolean).join('/') || meta.model || 'OpenClaw',
        channel,
        target,
        createdAt: meta.sessionStartedAt ? new Date(meta.sessionStartedAt).toISOString() : startedAt,
        updatedAt: meta.updatedAt ? new Date(meta.updatedAt).toISOString() : updatedAt,
        messages,
        filePath
    };
}

function listUnifiedSessionHistory() {
    const sessionsDir = path.join(CONFIG_DIR, 'agents', 'main', 'sessions');
    const result = [];
    try {
        const indexObj = readOpenClawSessionsIndex(sessionsDir);
        const indexById = buildSessionIndexById(indexObj);
        const files = fs.existsSync(sessionsDir)
            ? fs.readdirSync(sessionsDir).filter((name) => /\.jsonl$/i.test(name) && !/\.trajectory\.jsonl$/i.test(name))
            : [];
        for (const name of files) {
            const item = parseOpenClawJsonlSession(path.join(sessionsDir, name), indexById);
            if (item) result.push(item);
        }
        Object.entries(indexObj || {}).forEach(([key, value]) => {
            if (!value || !value.sessionId) return;
            if (result.some((item) => item.id === `openclaw:${value.sessionId}`)) return;
            const channel = value.lastChannel || value.deliveryContext?.channel || value.route?.channel || '';
            const target = value.origin?.label || value.lastTo || value.deliveryContext?.to || value.route?.target?.to || '';
            if (!channel && !target) return;
            const createdAt = value.sessionStartedAt ? new Date(value.sessionStartedAt).toISOString() : new Date(value.updatedAt || Date.now()).toISOString();
            const updatedAt = value.updatedAt ? new Date(value.updatedAt).toISOString() : createdAt;
            result.push({
                id: `channel:${key}`,
                source: 'channel',
                readOnly: true,
                title: `${channel.replace(/^openclaw-/, '') || '通讯渠道'} · ${target || value.sessionId}`,
                summary: `通讯渠道路由会话：${channel || '-'} / ${target || '-'}`,
                tags: ['通讯渠道', channel.replace(/^openclaw-/, '') || 'channel'],
                model: value.model || 'OpenClaw Channel',
                channel,
                target,
                createdAt,
                updatedAt,
                messages: [],
                route: value.route || null
            });
        });
    } catch (e) {
        console.warn('[SessionHistory] list failed:', e && e.message);
    }
    result.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return result.slice(0, 500);
}

ipcMain.handle('session-history-list', async () => {
    try {
        return { success: true, sessions: listUnifiedSessionHistory() };
    } catch (e) {
        return { success: false, error: e && e.message ? e.message : String(e), sessions: [] };
    }
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

        // 仅允许 http/https，杜绝 file:// 或自定义协议触发本机程序/文件（渲染层被注入时的提权面）
        let scheme = '';
        try { scheme = new URL(String(url)).protocol.toLowerCase(); } catch (_) {}
        if (scheme !== 'http:' && scheme !== 'https:') {
            console.warn('open-external blocked non-web scheme:', url);
            return false;
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
const UPDATE_REPO = '2014-y/NexoraAgent';
const UPDATE_RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`;
const UPDATE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TRUSTED_UPDATE_HOSTS = new Set([
    'api.github.com', 'github.com', 'www.github.com',
    'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com'
]);
let pendingUpdateDownload = null;
let verifiedDownloadedUpdate = null;

function isTrustedUpdateUrl(url) {
    try {
        const parsed = new URL(String(url || ''));
        return parsed.protocol === 'https:' && TRUSTED_UPDATE_HOSTS.has(parsed.hostname.toLowerCase());
    } catch (_) {
        return false;
    }
}

function withGithubMirrors(url) {
    return [url];
}

function httpsRequest(urlStr, { method = 'GET', headers = {}, timeout = 10000, maxRedirects = 5 } = {}) {
    const https = require('https');
    const { URL } = require('url');

    return new Promise((resolve, reject) => {
        let redirects = 0;

        const doRequest = (currentUrl) => {
            let parsed;
            try { parsed = new URL(currentUrl); }
            catch (e) { return reject(e); }
            if (!isTrustedUpdateUrl(parsed.href)) return reject(new Error('更新源不受信任'));

            const req = https.request({
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: parsed.pathname + parsed.search,
                method,
                headers: { 'User-Agent': UPDATE_UA, ...headers },
                timeout,
                // 更新检查必须校验 TLS（更新源证书有效）；否则可被中间人篡改版本/下载地址
                rejectUnauthorized: true
            }, (res) => {
                const status = res.statusCode || 0;
                const location = res.headers.location;

                // 跟随重定向，同时把最终 Location 暴露给调用方做版本解析
                if (status >= 300 && status < 400 && location && redirects < maxRedirects) {
                    redirects++;
                    res.resume();
                    const nextUrl = new URL(location, parsed).href;
                    if (!isTrustedUpdateUrl(nextUrl)) return reject(new Error('更新重定向目标不受信任'));
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

function normalizeNpmCoreVersion(value) {
    return String(value || '').trim().replace(/^v/i, '');
}

function isSameNpmCoreVersion(left, right) {
    return normalizeNpmCoreVersion(left) === normalizeNpmCoreVersion(right);
}

function isNewerVersion(latest, current) {
    // 正确的 semver 预发布优先级：同一核心版本下，「正式版」比「预发布」更新
    // （原实现把 1.2.3-beta 拆成 [1,2,3,0,beta段] 反而判成比 1.2.3 更新，会误报/回退更新）
    const parse = (v) => {
        const s = normalizeNpmCoreVersion(v);
        const dash = s.indexOf('-');
        const core = (dash >= 0 ? s.slice(0, dash) : s).split('.').map((p) => {
            const n = parseInt(p, 10);
            return Number.isFinite(n) ? n : 0;
        });
        return { core, pre: dash >= 0 ? s.slice(dash + 1) : '' };
    };
    const L = parse(latest);
    const C = parse(current);
    const len = Math.max(L.core.length, C.core.length, 3);
    for (let i = 0; i < len; i++) {
        const lv = L.core[i] || 0;
        const cv = C.core[i] || 0;
        if (lv > cv) return true;
        if (lv < cv) return false;
    }
    // 核心版本相等：无预发布后缀者更新
    if (!L.pre && C.pre) return true;
    if (L.pre && !C.pre) return false;
    if (L.pre && C.pre) {
        const lp = L.pre.split('.');
        const cp = C.pre.split('.');
        const n = Math.max(lp.length, cp.length);
        for (let i = 0; i < n; i++) {
            const a = lp[i];
            const b = cp[i];
            if (a === undefined) return false;
            if (b === undefined) return true;
            const an = parseInt(a, 10);
            const bn = parseInt(b, 10);
            const bothNum = String(an) === a && String(bn) === b;
            if (bothNum) { if (an > bn) return true; if (an < bn) return false; }
            else { if (a > b) return true; if (a < b) return false; }
        }
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
    pendingUpdateDownload = null;
    verifiedDownloadedUpdate = null;

    try {
        const result = await fetchLatestReleaseData();
        const redirectTag = result.redirectTag || '';
        const data = result.data;
        const latestVersion = (data ? data.tag_name : redirectTag).replace(/^v/i, '');
        const hasUpdate = isNewerVersion(latestVersion, currentVersion);

        let downloadUrl = '';
        let fileName = '';
        let releaseNotes = '';
        let digest = '';

        if (data) {
            releaseNotes = data.body || '';
            if (Array.isArray(data.assets)) {
                const exeAsset = data.assets.find((asset) => /\.exe$/i.test(asset.name));
                if (exeAsset) {
                    downloadUrl = exeAsset.browser_download_url;
                    fileName = exeAsset.name;
                    digest = typeof exeAsset.digest === 'string' ? exeAsset.digest : '';
                }
            }
            if (!downloadUrl) downloadUrl = data.html_url || UPDATE_RELEASES_PAGE;
        } else {
            releaseNotes = '已通过镜像通道确认版本号，但未能拉取完整更新日志。可继续尝试应用内升级，或前往 Releases 页面手动下载。';
            fileName = `Nexora Agent.Setup.${latestVersion}.exe`;
            const tag = redirectTag || `v${latestVersion}`;
            downloadUrl = `https://github.com/${UPDATE_REPO}/releases/download/${tag}/${fileName}`;
        }

        if (hasUpdate && downloadUrl && /\.exe($|\?)/i.test(downloadUrl) && isTrustedUpdateUrl(downloadUrl)) {
            pendingUpdateDownload = { downloadUrl, fileName, digest };
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
    const { URL } = require('url');
    const crypto = require('crypto');

    if (!pendingUpdateDownload || downloadUrl !== pendingUpdateDownload.downloadUrl) {
        return { success: false, message: '更新链接未经过本次官方检查，已拒绝下载' };
    }
    downloadUrl = pendingUpdateDownload.downloadUrl;
    fileName = pendingUpdateDownload.fileName;
    // Releases 页面不是安装包，交给前端打开浏览器
    if (!/\.exe($|\?)/i.test(downloadUrl) && !/\/releases\/download\//i.test(downloadUrl)) {
        return { success: false, message: '当前链接不是可下载的安装包，请前往 Releases 页面手动下载' };
    }
    // 主机白名单：下载源必须是 GitHub 官方（含其 release 资源 CDN）。
    // 否则被入侵的渲染进程可传入 https://evil.com/x.exe，主进程下载后经 install-update 直接执行 → RCE。
    // 下面的国内镜像代理仅在基址为 github.com 时才由本进程拼接，属可信来源。
    try {
        if (!isTrustedUpdateUrl(downloadUrl)) {
            return { success: false, message: '下载源不受信任，已拒绝（仅允许 GitHub 官方发布源）' };
        }
    } catch (e) {
        return { success: false, message: '无效的下载链接' };
    }

    const candidateUrls = [downloadUrl];

    const tempDir = app.getPath('temp');
    // 净化渲染层传入的文件名：只取 basename、白名单字符、强制 .exe，防目录穿越写到 temp 之外
    let safeName = path.basename(String(fileName || '')).replace(/[^A-Za-z0-9._-]/g, '');
    if (!/\.exe$/i.test(safeName) || safeName.length < 5) safeName = 'NexoraAgent-Setup-Latest.exe';
    const savePath = path.join(tempDir, safeName);

    const downloadOnce = (url) => new Promise((resolve, reject) => {
        let receivedBytes = 0;
        let totalBytes = 0;
        let settled = false;
        let redirectsLeft = 8;
        const hash = crypto.createHash('sha256');
        const expectedDigest = String(pendingUpdateDownload.digest || '').replace(/^sha256:/i, '').toLowerCase();
        const maxDownloadBytes = 1024 * 1024 * 1024;
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
            const actualDigest = hash.digest('hex').toLowerCase();
            if (expectedDigest && actualDigest !== expectedDigest) return fail('安装包 SHA-256 校验失败');
            fileStream.end(() => {
                if (settled) return;
                settled = true;
                resolve({ success: true, savePath, sha256: actualDigest, digestVerified: !!expectedDigest });
            });
        };

        const streamDownload = (currentUrl) => {
            let parsed;
            try { parsed = new URL(currentUrl); }
            catch (e) { return fail(e.message); }
            if (!isTrustedUpdateUrl(parsed.href)) return fail('更新源不受信任');
            const req = https.get({
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: parsed.pathname + parsed.search,
                headers: { 'User-Agent': 'NexoraAgent-Updater' },
                timeout: 30000,
                // 更新包必须校验 TLS：关掉校验会让中间人替换成恶意安装包后被直接执行（RCE）。
                // 更新源（GitHub Releases 等）证书有效，开启校验不影响正常下载。
                rejectUnauthorized: true
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft-- > 0) {
                    res.resume();
                    const next = new URL(res.headers.location, parsed).href;
                    if (!isTrustedUpdateUrl(next)) return fail('更新重定向目标不受信任');
                    return streamDownload(next);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return fail(`下载失败，状态码: ${res.statusCode}`);
                }
                totalBytes = parseInt(res.headers['content-length'], 10) || 0;
                if (totalBytes > maxDownloadBytes) {
                    res.resume();
                    return fail('安装包超过 1GB 安全上限');
                }
                res.on('data', (chunk) => {
                    receivedBytes += chunk.length;
                    if (receivedBytes > maxDownloadBytes) {
                        res.destroy();
                        return fail('安装包超过 1GB 安全上限');
                    }
                    hash.update(chunk);
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
            const result = await downloadOnce(url);
            verifiedDownloadedUpdate = {
                savePath: path.resolve(result.savePath),
                sha256: result.sha256,
                digestVerified: result.digestVerified === true
            };
            return result;
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
    const path = require('path');
    // 只允许执行「本进程写入 temp 目录、且以 .exe 结尾」的安装包，
    // 防止被注入的渲染层传入任意本地路径让主进程去执行（RCE 面）。
    const resolved = path.resolve(String(savePath || ''));
    const tempRoot = path.resolve(app.getPath('temp')).toLowerCase();
    if (!resolved.toLowerCase().startsWith(tempRoot + path.sep) || !/\.exe$/i.test(resolved)) {
        return { success: false, message: '安装包路径不合法' };
    }
    if (!fs.existsSync(resolved)) {
        return { success: false, message: '未找到安装包文件' };
    }
    if (!verifiedDownloadedUpdate || verifiedDownloadedUpdate.savePath !== resolved) {
        return { success: false, message: '安装包不是由本次受信任更新流程下载，已拒绝执行' };
    }
    // Accept either our expected Authenticode publisher or an unsigned asset
    // whose SHA-256 digest was supplied by the checked GitHub release and
    // matched during download. Invalid signatures are never accepted.
    try {
        const signature = await new Promise((resolve) => {
            const ps = require('child_process').spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command',
                '$s=Get-AuthenticodeSignature -LiteralPath $args[0]; [pscustomobject]@{Status=$s.Status.ToString();Subject=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{\'\'}} | ConvertTo-Json -Compress',
                resolved
            ], { windowsHide: true });
            let out = '';
            ps.stdout.on('data', (d) => { out += d.toString(); });
            ps.on('error', () => resolve(null));
            ps.on('close', () => {
                try { resolve(JSON.parse(out.trim())); } catch (_) { resolve(null); }
            });
            setTimeout(() => { try { ps.kill(); } catch (e) {} resolve(null); }, 8000);
        });
        const validPublisher = !!signature && signature.Status === 'Valid' && /(?:^|,)\s*CN=Nexora Agent(?:,|$)/i.test(String(signature.Subject || ''));
        const verifiedUnsignedAsset = !!signature && signature.Status === 'NotSigned' && verifiedDownloadedUpdate.digestVerified === true;
        if (!validPublisher && !verifiedUnsignedAsset) {
            try { fs.unlinkSync(resolved); } catch (_) {}
            verifiedDownloadedUpdate = null;
            return { success: false, message: '安装包既无有效的 Nexora Agent 发布者签名，也无官方 SHA-256 校验，已拒绝执行' };
        }
    } catch (e) {
        try { fs.unlinkSync(resolved); } catch (_) {}
        verifiedDownloadedUpdate = null;
        return { success: false, message: '安装包签名校验失败，已拒绝执行' };
    }
    // 使用 Electron shell 拉起安装程序
    try {
        await shell.openPath(resolved);
        app.quit();
        return { success: true };
    } catch (err) {
        console.error('无法启动安装程序:', err);
        return { success: false, message: `启动安装程序失败: ${err.message}` };
    }
});

// 4. 内置Nexora Agent核心包更新（openclaw npm 包热更新）
async function legacyUpdateOpenclawPackageDisabled(event, { targetVersion }) {
    // 开启全兼容热更新支持：即便在无任何开发环境的电脑上打包运行，也允许通过沙箱进行 OpenClaw 包升级

    const { spawn } = require('child_process');
    const path = require('path');
    const fs = require('fs');

    const appDir = resolveAppFsRoot();
    const ocDir = path.join(appDir, 'node_modules', 'openclaw');
    let ocRollbackDir = null; // 安装失败时用于回滚的旧版核心备份目录
    const log = (msg) => {
        console.log(`[GatewayUpdate] ${msg}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-update-progress', { message: msg });
        }
    };
    const startGatewayBestEffort = async () => {
        try { await withGatewayRestartPermit(() => startGatewayProcess({ source: 'update' })); } catch (_) {}
        await new Promise(r => setTimeout(r, 2500));
        return !!gatewayProcess;
    };

    try {
        // 1) 查询 npm 最新版本
        let version = targetVersion;
        if (!version) {
            log('正在查询 npm 最新版本...');
            try {
                const result = await new Promise((resolve, reject) => {
                    runNpmUpdateCommand(['view', 'openclaw', 'version', '--json'], { cwd: appDir, timeout: 30000 })
                        .then((stdout) => {
                            try { resolve(JSON.parse(stdout.trim())); }
                            catch (e) { resolve(stdout.trim().replace(/"/g, '')); }
                        })
                        .catch(reject);
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
                runNpmUpdateCommand(['view', `openclaw@${version}`, 'engines.node', '--json'], { cwd: appDir, timeout: 15000 })
                    .then((stdout) => {
                        try { resolve(JSON.parse(stdout.trim())); }
                        catch (e) { resolve(stdout.trim().replace(/"/g, '')); }
                    })
                    .catch(() => resolve(null));
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

        // 3.1) 备份当前核心用于失败回滚：改名(快、原子)而非拷贝；npm install 会新建 openclaw 目录。
        //      若后续 npm install / 冒烟测试失败，把备份改名回来 → 网关永不被留在半残状态。
        try {
            if (fs.existsSync(ocDir)) {
                ocRollbackDir = path.join(appDir, 'node_modules', `.openclaw.rollback-${Date.now()}`);
                fs.renameSync(ocDir, ocRollbackDir);
                log('已备份当前核心（用于失败自动回滚）');
            }
        } catch (e) {
            ocRollbackDir = null;
            log('备份当前核心失败，将在无回滚保护下继续: ' + e.message);
        }

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
            let stdout = '';
            let stderr = '';
            runNpmUpdateCommand(npmArgs, {
                cwd: appDir,
                timeout: 120000,
                onStdout: (text) => { stdout += text; log(text.trim()); },
                onStderr: (text) => {
                    stderr += text;
                    const trimmed = text.trim();
                    if (trimmed && !trimmed.startsWith('npm warn')) log(trimmed);
                }
            }).then(resolve).catch((err) => {
                reject(new Error(`npm install 失败: ${err.message}\n${stderr || stdout}`));
            });
            const child = { stdout: null, stderr: null };

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

        // 5.5) 冒烟测试：新核心必须有 dist/index.js 且能被内置 Node require；
        //      不通过则视为安装失败，触发回滚（下方 catch），绝不用半残核心重启。
        const distEntry = path.join(ocDir, 'dist', 'index.js');
        if (!fs.existsSync(distEntry)) {
            throw new Error('新核心缺少 dist/index.js（安装不完整）');
        }
        try {
            const nodeExe = getAvailableNodePath();
            if (nodeExe) {
                require('child_process').execFileSync(
                    nodeExe,
                    ['-e', `require(${JSON.stringify(distEntry)}); process.exit(0);`],
                    { timeout: 30000, windowsHide: true, stdio: 'ignore' }
                );
                log('新核心冒烟测试通过（可正常 require）');
            }
        } catch (smokeErr) {
            throw new Error('新核心冒烟测试失败（无法 require，可能与 Node 版本不兼容）: ' + (smokeErr.message || smokeErr));
        }

        // 安装 + 冒烟均通过：删除回滚备份
        if (ocRollbackDir) {
            try { fs.rmSync(ocRollbackDir, { recursive: true, force: true }); } catch (_) {}
            ocRollbackDir = null;
        }

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
                await withGatewayRestartPermit(() => startGatewayProcess({ source: 'update' }));
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
        // 失败回滚：把可能半残的新核心删掉，改名恢复旧核心，再用旧版重启网关——绝不把用户留在打不开状态
        let rolledBack = false;
        if (ocRollbackDir) {
            try {
                try { if (fs.existsSync(ocDir)) fs.rmSync(ocDir, { recursive: true, force: true }); } catch (_) {}
                fs.renameSync(ocRollbackDir, ocDir);
                rolledBack = true;
                log('安装失败，已回滚到更新前的旧版核心');
            } catch (rbErr) {
                log('回滚失败（旧核心备份仍在 ' + ocRollbackDir + '）: ' + (rbErr.message || rbErr));
            }
        }
        // 无论是否回滚，都尝试把网关重新拉起（回滚成功=旧版，否则=尽力）
        let restarted = false;
        try { gatewayProcess = null; restarted = await startGatewayBestEffort(); } catch (_) {}
        if (!restarted && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-control-trigger', 'start');
        }
        return {
            success: false,
            rolledBack,
            restarted,
            message: `更新失败: ${err.message}` + (rolledBack ? '（已自动回滚到旧版并重启）' : '')
        };
    }
}

// ─── OpenClaw 正式稳定版维护：官方 latest、事务式替换、启动健康检查、失败回滚 ───
let openclawStableUpdateInFlight = null;

function readJsonFileSafe(filePath, fallback = null) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}

function readInstalledOpenclawVersion(runtimeRoot = resolveAppFsRoot()) {
    const pkg = readJsonFileSafe(path.join(runtimeRoot, 'node_modules', 'openclaw', 'package.json'), {});
    return normalizeOpenClawVersion(pkg && pkg.version);
}

function parseNpmJson(stdout, label) {
    const raw = String(stdout || '').trim();
    if (!raw) throw new Error(`${label || 'npm'} 返回空数据`);
    try { return JSON.parse(raw); } catch (_) {
        throw new Error(`${label || 'npm'} 返回的数据不是有效 JSON`);
    }
}

async function queryOpenclawStableRelease(requestedVersion = '') {
    const runtimeRoot = resolveAppFsRoot();
    const currentVersion = readInstalledOpenclawVersion(runtimeRoot);
    const common = [
        `--registry=${OFFICIAL_NPM_REGISTRY}`,
        '--fetch-retries=2',
        '--fetch-retry-mintimeout=1000',
        '--fetch-timeout=20000'
    ];
    const tagsOut = await runNpmUpdateCommand(
        ['view', 'openclaw', 'dist-tags', '--json', ...common],
        { cwd: runtimeRoot, timeout: 45000 }
    );
    const policy = resolveStableTarget(parseNpmJson(tagsOut, 'npm dist-tags'), currentVersion, requestedVersion);
    const target = policy.latestVersion;
    const metaOut = await runNpmUpdateCommand(
        ['view', `openclaw@${target}`, 'version', 'dist.integrity', 'engines.node', '--json', ...common],
        { cwd: runtimeRoot, timeout: 45000 }
    );
    const meta = parseNpmJson(metaOut, 'npm release metadata');
    const publishedVersion = normalizeOpenClawVersion(meta.version);
    if (publishedVersion !== target || !isStableOpenClawVersion(publishedVersion)) {
        throw new Error(`官方元数据版本不一致: latest=${target}, package=${publishedVersion || '(empty)'}`);
    }
    const integrity = normalizeIntegrity(meta['dist.integrity']);
    return {
        ...policy,
        registry: OFFICIAL_NPM_REGISTRY,
        integrity,
        integrityLabel: integrity.slice(0, integrity.indexOf('-') + 1) + integrity.slice(-12),
        nodeRange: String(meta['engines.node'] || '').trim(),
        checkedAt: new Date().toISOString()
    };
}

ipcMain.handle('check-openclaw-stable-update', async () => {
    try {
        await withStartupTimeout(waitForGatewayRuntimeReady(), 120000, '准备 OpenClaw 更新运行时');
        const result = await queryOpenclawStableRelease();
        return { success: true, ...result, integrity: undefined };
    } catch (error) {
        appendMainDiagnostic('openclaw-stable-update-check-failed', error);
        return { success: false, message: `稳定版检查失败: ${error.message || error}` };
    }
});

function collectInstalledRuntimeVersions(runtimeRoot, appPackage) {
    const names = new Set([
        ...Object.keys((appPackage && appPackage.dependencies) || {}),
        ...Object.keys((appPackage && appPackage.optionalDependencies) || {})
    ]);
    const versions = {};
    for (const name of names) {
        const pkgPath = path.join(runtimeRoot, 'node_modules', ...name.split('/'), 'package.json');
        const pkg = readJsonFileSafe(pkgPath, null);
        if (pkg && pkg.version) versions[name] = String(pkg.version);
    }
    return versions;
}

function writeJsonAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    try { fs.renameSync(temp, filePath); } catch (error) {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
        fs.renameSync(temp, filePath);
    }
}

function pathIsInside(parent, candidate) {
    const root = path.resolve(parent) + path.sep;
    return path.resolve(candidate).startsWith(root);
}

function removeManagedUpdatePath(runtimeRoot, target) {
    const resolved = path.resolve(target);
    const base = path.basename(resolved);
    const allowed = base.startsWith('.nexora-openclaw-stage-')
        || base.startsWith('.openclaw.rollback-')
        || base.startsWith('.openclaw.rollback-state-')
        || base.startsWith('.node-sandbox.rollback-');
    if (!allowed || !pathIsInside(runtimeRoot, resolved)) {
        throw new Error(`拒绝清理非更新目录: ${resolved}`);
    }
    if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

function pruneOldOpenclawRollbackCopies(runtimeRoot, keepPaths = []) {
    const keep = new Set(keepPaths.filter(Boolean).map((p) => path.resolve(p).toLowerCase()));
    const entries = fs.readdirSync(runtimeRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && (
            entry.name.startsWith('.openclaw.rollback-')
            || entry.name.startsWith('.openclaw.rollback-state-')
            || entry.name.startsWith('.node-sandbox.rollback-')
            || entry.name.startsWith('.nexora-openclaw-stage-')
        ))
        .map((entry) => path.join(runtimeRoot, entry.name));
    for (const entry of entries) {
        if (keep.has(path.resolve(entry).toLowerCase())) continue;
        try { removeManagedUpdatePath(runtimeRoot, entry); } catch (_) {}
    }
}

function assertOpenclawUpdateDiskSpace(runtimeRoot) {
    if (typeof fs.statfsSync !== 'function') return;
    const stat = fs.statfsSync(runtimeRoot);
    const free = Number(stat.bavail) * Number(stat.bsize);
    const minimum = 900 * 1024 * 1024;
    if (Number.isFinite(free) && free < minimum) {
        throw new Error(`磁盘空间不足：稳定升级至少需要 900 MB 临时空间，当前约 ${Math.floor(free / 1048576)} MB`);
    }
}

function createOpenclawStateSnapshot(runtimeRoot, targetVersion) {
    const stamp = Date.now();
    const snapshotDir = path.join(runtimeRoot, `.openclaw.rollback-state-${stamp}`);
    fs.mkdirSync(snapshotDir, { recursive: true });
    const stateDb = path.join(CONFIG_DIR, 'state', 'openclaw.sqlite');
    const candidates = [
        { name: 'openclaw.json', source: CONFIG_PATH },
        { name: 'openclaw.sqlite', source: stateDb },
        { name: 'openclaw.sqlite-wal', source: `${stateDb}-wal` },
        { name: 'openclaw.sqlite-shm', source: `${stateDb}-shm` }
    ];
    const files = [];
    for (const item of candidates) {
        const existed = fs.existsSync(item.source);
        const backup = path.join(snapshotDir, item.name);
        if (existed) fs.copyFileSync(item.source, backup);
        files.push({ ...item, backup, existed });
    }
    const manifest = {
        targetVersion,
        createdAt: new Date().toISOString(),
        files
    };
    writeJsonAtomic(path.join(snapshotDir, 'snapshot.json'), manifest);
    return { snapshotDir, manifest };
}

function restoreOpenclawStateSnapshot(snapshot) {
    if (!snapshot || !snapshot.manifest) return;
    for (const item of snapshot.manifest.files || []) {
        if (item.existed && fs.existsSync(item.backup)) {
            fs.mkdirSync(path.dirname(item.source), { recursive: true });
            fs.copyFileSync(item.backup, item.source);
        } else if (!item.existed && fs.existsSync(item.source)) {
            fs.rmSync(item.source, { force: true });
        }
    }
    const safeVersion = String(snapshot.manifest.targetVersion || '').replace(/[^a-zA-Z0-9._-]/g, '_');
    const migrationMarker = path.join(CONFIG_DIR, `.nexora-openclaw-migrated-${safeVersion}.json`);
    try { if (fs.existsSync(migrationMarker)) fs.unlinkSync(migrationMarker); } catch (_) {}
}

function waitForGatewayControlUiReady(port = 18789, timeoutMs = 120000) {
    const http = require('http');
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const probe = () => {
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error(`Gateway 在 ${Math.ceil(timeoutMs / 1000)} 秒内未通过 HTTP 健康检查`));
                return;
            }
            let settled = false;
            const retry = () => {
                if (settled) return;
                settled = true;
                setTimeout(probe, 600);
            };
            try {
                const req = http.get({
                    hostname: '127.0.0.1',
                    port,
                    path: '/acp/',
                    timeout: 1000,
                    headers: { Accept: 'text/html,*/*' }
                }, (res) => {
                    if (settled) return;
                    settled = true;
                    try { res.resume(); } catch (_) {}
                    resolve({ statusCode: res.statusCode || 0, elapsedMs: Date.now() - startedAt });
                });
                req.once('error', retry);
                req.once('timeout', () => {
                    try { req.destroy(); } catch (_) {}
                    retry();
                });
            } catch (_) { retry(); }
        };
        probe();
    });
}

async function performOpenclawStableUpdate(options = {}) {
    await withStartupTimeout(waitForGatewayRuntimeReady(), 120000, '准备 OpenClaw 更新运行时');
    const runtimeRoot = resolveAppFsRoot();
    const liveModules = path.join(runtimeRoot, 'node_modules');
    const stamp = Date.now();
    const stageDir = path.join(runtimeRoot, `.nexora-openclaw-stage-${stamp}`);
    const stageModules = path.join(stageDir, 'node_modules');
    const rollbackModules = path.join(runtimeRoot, `.openclaw.rollback-${stamp}`);
    const rollbackSandbox = path.join(runtimeRoot, `.node-sandbox.rollback-${stamp}`);
    const runtimePackagePath = path.join(runtimeRoot, 'package.json');
    const runtimeLockPath = path.join(runtimeRoot, 'package-lock.json');
    let stateSnapshot = null;
    let modulesSwapped = false;
    let sandboxBackedUp = false;
    let gatewayStopped = false;
    const gatewayWasRunning = !!gatewayProcess;
    const previousRuntimePackage = fs.existsSync(runtimePackagePath) ? fs.readFileSync(runtimePackagePath) : null;
    const previousRuntimeLock = fs.existsSync(runtimeLockPath) ? fs.readFileSync(runtimeLockPath) : null;
    const log = (message) => {
        const msg = String(message || '').trim();
        if (!msg) return;
        console.log(`[GatewayUpdate] ${msg}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('gateway-update-progress', { message: msg });
        }
    };

    try {
        log('正在从 npm 官方源查询 latest 正式稳定版...');
        const release = await queryOpenclawStableRelease(options.targetVersion || '');
        log(`当前版本: openclaw@${release.currentVersion || '未知'} | 正式稳定版: openclaw@${release.latestVersion}`);
        log(`官方完整性摘要已确认: ${release.integrityLabel}`);
        if (!release.requestedMatched) {
            log(`已忽略页面传入的 v${release.requestedVersion}，统一采用官方 latest 稳定版 v${release.latestVersion}`);
        }
        if (!release.hasUpdate) {
            return {
                success: true,
                alreadyLatest: true,
                installedVersion: release.currentVersion,
                latestVersion: release.latestVersion,
                restarted: gatewayWasRunning,
                message: `OpenClaw 已是最新正式稳定版 v${release.currentVersion}`
            };
        }

        assertOpenclawUpdateDiskSpace(runtimeRoot);
        pruneOldOpenclawRollbackCopies(runtimeRoot);
        if (!fs.existsSync(liveModules)) throw new Error('当前 Gateway 运行时缺少 node_modules，无法执行安全升级');

        let nodeUpgrade = null;
        if (release.nodeRange) {
            const nodeExe = getAvailableNodePath();
            let currentNode = '';
            if (nodeExe) {
                try {
                    currentNode = require('child_process').execFileSync(nodeExe, ['-v'], {
                        encoding: 'utf8', timeout: 10000, windowsHide: true
                    }).trim().replace(/^v/, '');
                } catch (_) {}
            }
            log(`当前 Node: ${currentNode ? 'v' + currentNode : '未知'} | 新版要求: ${release.nodeRange}`);
            if (!currentNode || !satisfiesNodeRange(currentNode, release.nodeRange)) {
                const currentMajor = currentNode ? parseInt(currentNode.split('.')[0], 10) : 0;
                const targetNode = await resolveBestNodeVersion(release.nodeRange, currentMajor);
                if (!targetNode) throw new Error(`找不到满足 ${release.nodeRange} 的稳定 Node 运行时，已取消升级`);
                nodeUpgrade = targetNode;
                log(`将同步升级内置 Node 到 v${targetNode}`);
            }
        }

        log('正在创建独立候选运行时（当前服务保持运行）...');
        fs.mkdirSync(stageDir, { recursive: true });
        const appPackage = readJsonFileSafe(path.join(__dirname, 'package.json'), {});
        const installedVersions = collectInstalledRuntimeVersions(runtimeRoot, appPackage);
        const runtimeManifest = buildGatewayRuntimeManifest(appPackage, installedVersions);
        runtimeManifest.dependencies.openclaw = release.latestVersion;
        writeJsonAtomic(path.join(stageDir, 'package.json'), runtimeManifest);
        await fs.promises.cp(liveModules, stageModules, {
            recursive: true,
            force: true,
            errorOnExist: false,
            dereference: false
        });

        log(`正在候选环境安装 openclaw@${release.latestVersion}...`);
        await runNpmUpdateCommand([
            'install', `openclaw@${release.latestVersion}`,
            '--save-exact', '--omit=dev', '--install-strategy=shallow',
            '--no-audit', '--fund=false',
            `--registry=${OFFICIAL_NPM_REGISTRY}`,
            '--fetch-retries=2', '--fetch-timeout=30000'
        ], {
            cwd: stageDir,
            timeout: 300000,
            onStdout: (text) => { const line = String(text || '').trim(); if (line) log(line); },
            onStderr: (text) => {
                const line = String(text || '').trim();
                if (line && !/^npm warn config global-style/i.test(line)) log(line);
            }
        });

        const stagedPackage = readJsonFileSafe(path.join(stageModules, 'openclaw', 'package.json'), {});
        const stagedVersion = normalizeOpenClawVersion(stagedPackage.version);
        const stagedEntry = path.join(stageModules, 'openclaw', 'dist', 'index.js');
        if (stagedVersion !== release.latestVersion || !fs.existsSync(stagedEntry)) {
            throw new Error(`候选核心校验失败: expected=${release.latestVersion}, actual=${stagedVersion || 'missing'}`);
        }
        const stagedLock = readJsonFileSafe(path.join(stageDir, 'package-lock.json'), {});
        const lockedOpenclaw = stagedLock && stagedLock.packages && stagedLock.packages['node_modules/openclaw'];
        const lockedIntegrity = normalizeIntegrity(lockedOpenclaw && lockedOpenclaw.integrity);
        if (lockedIntegrity !== release.integrity) {
            throw new Error('候选核心完整性摘要与 npm 官方元数据不一致');
        }
        log('候选核心版本与完整性校验通过');

        log('正在停止 Gateway，准备原子切换...');
        stopGatewayProcess();
        gatewayProcess = null;
        gatewayStopped = true;
        await new Promise((resolve) => setTimeout(resolve, 2000));

        if (nodeUpgrade) {
            const sandboxDir = path.join(runtimeRoot, '.node-sandbox');
            if (!fs.existsSync(sandboxDir)) throw new Error('内置 Node 目录不存在，无法安全升级运行时');
            await fs.promises.cp(sandboxDir, rollbackSandbox, { recursive: true, force: true, dereference: false });
            sandboxBackedUp = true;
            log(`正在安装兼容的 Node v${nodeUpgrade}...`);
            await downloadAndInstallSandboxNode(nodeUpgrade, () => {});
        }

        const smokeNode = getAvailableNodePath();
        if (!smokeNode) throw new Error('内置 Node 运行时不可用');
        require('child_process').execFileSync(
            smokeNode,
            ['-e', `require(${JSON.stringify(stagedEntry)}); process.exit(0);`],
            { timeout: 45000, windowsHide: true, stdio: 'ignore' }
        );
        log('候选核心加载测试通过');

        stateSnapshot = createOpenclawStateSnapshot(runtimeRoot, release.latestVersion);
        log('配置与状态数据库快照已完成');

        fs.renameSync(liveModules, rollbackModules);
        try {
            fs.renameSync(stageModules, liveModules);
            modulesSwapped = true;
        } catch (swapError) {
            fs.renameSync(rollbackModules, liveModules);
            throw swapError;
        }
        fs.copyFileSync(path.join(stageDir, 'package.json'), runtimePackagePath);
        const stagedLockPath = path.join(stageDir, 'package-lock.json');
        if (fs.existsSync(stagedLockPath)) fs.copyFileSync(stagedLockPath, runtimeLockPath);
        log('新旧核心已原子切换，旧核心仍保留用于回滚');

        log('正在运行升级迁移并启动 Gateway...');
        await withGatewayRestartPermit(() => startGatewayProcess({ source: 'update' }));
        const health = await waitForGatewayControlUiReady(resolveConfiguredGatewayPort(), 150000);
        log(`HTTP 健康检查通过（${health.statusCode || 'response'}，${health.elapsedMs}ms）`);

        const installedVersion = readInstalledOpenclawVersion(runtimeRoot);
        if (installedVersion !== release.latestVersion) {
            throw new Error(`启动后的核心版本不一致: ${installedVersion || 'missing'}`);
        }
        log(`OpenClaw v${installedVersion} 正式稳定版升级完成`);

        if (!gatewayWasRunning) {
            stopGatewayProcess();
            gatewayProcess = null;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            log('健康检查完成；已恢复升级前的“服务未启动”状态');
        }

        try { removeManagedUpdatePath(runtimeRoot, stageDir); } catch (_) {}
        if (sandboxBackedUp) {
            try { removeManagedUpdatePath(runtimeRoot, rollbackSandbox); } catch (_) {}
            sandboxBackedUp = false;
        }
        pruneOldOpenclawRollbackCopies(runtimeRoot, [rollbackModules, stateSnapshot && stateSnapshot.snapshotDir]);
        return {
            success: true,
            installedVersion,
            latestVersion: release.latestVersion,
            restarted: gatewayWasRunning,
            validated: true,
            rollbackProtected: true,
            message: gatewayWasRunning
                ? `OpenClaw 已稳定升级到 v${installedVersion}，健康检查通过并已恢复运行。`
                : `OpenClaw 已稳定升级到 v${installedVersion}，健康检查通过。`
        };
    } catch (error) {
        console.error('[GatewayUpdate] 稳定升级失败:', error);
        let rolledBack = false;
        try {
            if (modulesSwapped) {
                try { stopGatewayProcess(); } catch (_) {}
                gatewayProcess = null;
                await new Promise((resolve) => setTimeout(resolve, 1500));
                if (fs.existsSync(liveModules)) fs.rmSync(liveModules, { recursive: true, force: true });
                if (fs.existsSync(rollbackModules)) fs.renameSync(rollbackModules, liveModules);
                restoreOpenclawStateSnapshot(stateSnapshot);
                if (previousRuntimePackage) fs.writeFileSync(runtimePackagePath, previousRuntimePackage);
                else if (fs.existsSync(runtimePackagePath)) fs.unlinkSync(runtimePackagePath);
                if (previousRuntimeLock) fs.writeFileSync(runtimeLockPath, previousRuntimeLock);
                else if (fs.existsSync(runtimeLockPath)) fs.unlinkSync(runtimeLockPath);
                rolledBack = true;
                log('升级未通过健康检查，已恢复旧核心、配置和状态数据库');
            }
            if (sandboxBackedUp && fs.existsSync(rollbackSandbox)) {
                const sandboxDir = path.join(runtimeRoot, '.node-sandbox');
                if (fs.existsSync(sandboxDir)) fs.rmSync(sandboxDir, { recursive: true, force: true });
                fs.renameSync(rollbackSandbox, sandboxDir);
                sandboxBackedUp = false;
                rolledBack = true;
                log('已恢复升级前的 Node 运行时');
            }
        } catch (rollbackError) {
            appendMainDiagnostic('openclaw-stable-update-rollback-failed', rollbackError, {
                originalError: String(error && (error.stack || error.message || error))
            });
            log(`自动回滚异常，保留备份等待人工恢复: ${rollbackError.message || rollbackError}`);
        }

        if ((gatewayWasRunning || gatewayStopped) && !gatewayProcess) {
            try {
                await withGatewayRestartPermit(() => startGatewayProcess({ source: 'update' }));
                await waitForGatewayControlUiReady(resolveConfiguredGatewayPort(), 120000);
                log(rolledBack ? '旧版 Gateway 已恢复运行' : 'Gateway 已恢复运行');
            } catch (restartError) {
                appendMainDiagnostic('openclaw-stable-update-restart-failed', restartError);
            }
        }
        try { if (fs.existsSync(stageDir)) removeManagedUpdatePath(runtimeRoot, stageDir); } catch (_) {}
        appendMainDiagnostic('openclaw-stable-update-failed', error, { rolledBack });
        return {
            success: false,
            rolledBack,
            message: `OpenClaw 稳定升级失败: ${error.message || error}${rolledBack ? '（已自动回滚并恢复旧版）' : ''}`
        };
    }
}

ipcMain.handle('update-openclaw-package', async (event, options = {}) => {
    if (openclawStableUpdateInFlight) {
        return { success: false, busy: true, message: 'OpenClaw 稳定升级正在进行，请勿重复操作。' };
    }
    openclawStableUpdateInFlight = performOpenclawStableUpdate(options);
    try {
        return await openclawStableUpdateInFlight;
    } finally {
        openclawStableUpdateInFlight = null;
    }
});

// 自定义主题背景图 / 本地 MEDIA 预览协议（须在 ready 前声明）
try {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: 'nexora-bg',
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                bypassCSP: true,
                stream: true
            }
        },
        {
            scheme: 'nexora-media',
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                bypassCSP: true,
                stream: true,
                corsEnabled: true
            }
        }
    ]);
} catch (e) {}

// 初始化应用
let gatewayRuntimePreparePromise = null;

function prepareGatewayRuntimeInBackground(bootSplash) {
    if (gatewayRuntimePreparePromise) return gatewayRuntimePreparePromise;
    gatewayRuntimePreparePromise = (async () => {
        let heartbeat = null;
        try {
            let packaged = false;
            try { packaged = !!app.isPackaged; } catch (e) { packaged = false; }
            if (packaged && bootSplash && !bootSplash.isDestroyed()) {
                updateSplashStatus(bootSplash, '正在准备 OpenClaw 运行时…', 5);
                let tick = 8;
                heartbeat = setInterval(() => {
                    tick = Math.min(72, tick + 1.5);
                    updateSplashStatus(bootSplash, '正在后台准备运行时，主界面可先使用…', Math.floor(tick));
                }, 700);
            }
            const runtimeInfo = await ensureGatewayRuntime(app, {
                onProgress: (p) => updateSplashStatus(bootSplash, (p && p.message) || '', p && p.percent)
            });
            markClientBootPhase('runtime-located');
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
                    markClientBootPhase('runtime-hardened');
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
            updateSplashStatus(bootSplash, '运行时就绪…', 100);
            markClientBootPhase('runtime-ready');
            return runtimeInfo;
        } catch (err) {
            console.error('[GatewayRuntime] ensure failed:', err);
            try {
                dialog.showErrorBox(
                    'OpenClaw 运行时未就绪',
                    `无法解压或定位网关运行时。\n\n${err && err.message ? err.message : err}\n\n请重新安装 Nexora Agent，或联系支持。`
                );
            } catch (e) {}
            throw err;
        } finally {
            if (heartbeat) {
                try { clearInterval(heartbeat); } catch (e) {}
            }
        }
    })();
    return gatewayRuntimePreparePromise;
}

async function waitForGatewayRuntimeReady() {
    if (!gatewayRuntimePreparePromise) prepareGatewayRuntimeInBackground(null);
    return await gatewayRuntimePreparePromise;
}

function withStartupTimeout(promise, timeoutMs, label) {
    const ms = Math.max(1000, Number(timeoutMs) || 1000);
    let timer = null;
    return Promise.race([
        Promise.resolve(promise).finally(() => {
            if (timer) clearTimeout(timer);
        }),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label || '启动步骤'}超时（${ms}ms）`)), ms);
        })
    ]);
}

/**
 * OpenClaw can ship SQLite/config migrations that the Gateway intentionally
 * refuses to run implicitly. Run the official repair once per bundled core
 * version, against the same isolated home/state that the Gateway will use.
 */
async function ensureOpenClawPostUpgradeMigration(params) {
    const nodeExePath = params && params.nodeExePath;
    const openclawEntry = params && params.openclawEntry;
    const stateDir = params && params.stateDir;
    const env = { ...((params && params.env) || process.env) };
    if (!nodeExePath || !openclawEntry || !stateDir) {
        return { migrated: false, skipped: 'missing-runtime-paths' };
    }

    let version = 'unknown';
    try {
        version = JSON.parse(
            fs.readFileSync(path.join(path.dirname(openclawEntry), '..', 'package.json'), 'utf8')
        ).version || version;
    } catch (_) {}
    const safeVersion = String(version).replace(/[^a-zA-Z0-9._-]/g, '_');
    const marker = path.join(stateDir, `.nexora-openclaw-migrated-${safeVersion}.json`);
    if (fs.existsSync(marker)) return { migrated: false, skipped: 'already-migrated', version };

    fs.mkdirSync(stateDir, { recursive: true });
    const sqlitePath = path.join(stateDir, 'state', 'openclaw.sqlite');
    if (!fs.existsSync(sqlitePath)) {
        fs.writeFileSync(marker, JSON.stringify({ version, migratedAt: new Date().toISOString(), reason: 'fresh-state' }));
        return { migrated: false, skipped: 'fresh-state', version };
    }

    const backup = `${CONFIG_PATH}.nexora-pre-upgrade-${safeVersion}.bak`;
    const sqliteBackup = `${sqlitePath}.nexora-pre-upgrade-${safeVersion}.bak`;
    if (fs.existsSync(CONFIG_PATH) && !fs.existsSync(backup)) fs.copyFileSync(CONFIG_PATH, backup);
    // The database migration is irreversible; refuse to continue if its
    // pre-upgrade snapshot cannot be created.
    if (!fs.existsSync(sqliteBackup)) fs.copyFileSync(sqlitePath, sqliteBackup);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gateway-log', `[System] 正在迁移 OpenClaw ${version} 配置与状态数据库（仅首次）...\n`);
    }
    delete env.NODE_OPTIONS;
    delete env.NEXORA_AGENT_PATCH_PATH;
    const { spawn } = require('child_process');
    const result = await new Promise((resolve, reject) => {
        const child = spawn(
            nodeExePath,
            [openclawEntry, 'doctor', '--fix', '--non-interactive', '--yes'],
            { cwd: stateDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let output = '';
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            reject(new Error(`OpenClaw ${version} migration timed out`));
        }, 170000);
        const append = (data) => {
            output += String(data || '');
            if (output.length > 200000) output = output.slice(-160000);
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, output });
        });
    });
    if (result.code !== 0) {
        const tail = String(result.output || '').slice(-4000);
        throw new Error(`OpenClaw ${version} migration failed (code=${result.code}, signal=${result.signal || 'none'}): ${tail}`);
    }
    fs.writeFileSync(marker, JSON.stringify({ version, migratedAt: new Date().toISOString() }, null, 2));
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('gateway-log', `[System] OpenClaw ${version} 配置与状态数据库迁移完成。\n`);
    }
    return { migrated: true, version, backup, sqliteBackup };
}

app.whenReady().then(async () => {
    if (!global.nexoraInstance) return;
    markClientBootPhase('electron-ready');
    // 尽早提供启动反馈；主窗口仍等待主文档首次绘制，避免白屏。
    let bootSplash = null;
    if (app.isPackaged) {
        try { bootSplash = createSplashWindow(); } catch (_) {}
    }

    try {
        protocol.registerFileProtocol('nexora-bg', (request, callback) => {
            try {
                const file = findCustomThemeBackgroundFile();
                if (!file || !fs.existsSync(file)) {
                    callback({ error: -6 });
                    return;
                }
                callback({ path: path.normalize(file) });
            } catch (err) {
                callback({ error: -2 });
            }
        });
    } catch (e) {
        console.warn('[Theme] nexora-bg protocol register failed:', e && e.message);
    }

    // OpenClaw 面板 webview：把 MEDIA:本地路径 安全映射为可预览图片
    const registerNexoraMediaProtocol = (prot) => {
        try {
            prot.registerFileProtocol('nexora-media', (request, callback) => {
                try {
                    const u = new URL(request.url);
                    let filePath = '';
                    try { filePath = decodeURIComponent(u.searchParams.get('path') || ''); } catch (e) { filePath = ''; }
                    filePath = String(filePath || '').trim();
                    if (!filePath || filePath.includes('\0') || /\.\.([/\\]|$)/.test(filePath)) {
                        callback({ error: -10 });
                        return;
                    }
                    const resolved = path.resolve(filePath);
                    const stateRoot = path.resolve(
                        process.env.OPENCLAW_STATE_DIR
                        || CONFIG_DIR
                        || path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw')
                    );
                    const allowedSubs = ['screenshots', 'image-output', 'video-output', 'media-output', 'media', 'canvas'];
                    const latestRoot = path.resolve(stateRoot, 'openclaw-screenshot-latest.png');
                    const resolvedLc = resolved.toLowerCase();
                    const okLatest = resolvedLc === latestRoot.toLowerCase();
                    const ok = okLatest || allowedSubs.some((sub) => {
                        const root = path.resolve(stateRoot, sub) + path.sep;
                        return (resolved + path.sep).toLowerCase().startsWith(root.toLowerCase()) || resolvedLc === path.resolve(stateRoot, sub).toLowerCase();
                    });
                    if (!ok || !fs.existsSync(resolved)) {
                        callback({ error: -6 });
                        return;
                    }
                    callback({ path: resolved });
                } catch (err) {
                    callback({ error: -2 });
                }
            });
        } catch (e) {
            console.warn('[Media] nexora-media protocol register failed:', e && e.message);
        }
    };
    try {
        registerNexoraMediaProtocol(protocol);
        const { session } = require('electron');
        const panelSession = session.fromPartition('persist:nexora-agent-openclaw-panel');
        registerNexoraMediaProtocol(panelSession.protocol);
    } catch (e) {
        console.warn('[Media] nexora-media panel session register failed:', e && e.message);
    }

    // 在窗口创建前初始化客户端设置库；后续渲染层同步启动读取不会碰到未建表状态。
    try {
        getClientSettingsStore();
    } catch (e) {
        console.warn('[ClientSettings] initialization failed:', e && e.message);
    }

    // 初始化加速通道目录与状态
    try {
        acceleration.init(app, { settingsStore: getClientSettingsStore() });
        if (typeof acceleration.onStatusChange === 'function') {
            acceleration.onStatusChange((payload) => {
                try {
                    applyElectronSessionProxy(!!(payload && payload.enabled && payload.running)).catch(() => {});
                } catch (_) {}
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('acceleration-status-changed', payload || {});
                }
            });
        }
        const st = acceleration.getStatus();
        if (st.enabled && st.activeProfileId) {
            acceleration.setEnabled(true, st.activeProfileId)
                .then((s) => applyElectronSessionProxy(!!s.enabled))
                .catch((e) => console.warn('[Acceleration] restore failed:', e.message));
        }
    } catch (e) {
        console.warn('[Acceleration] init failed:', e.message);
    }

    // 按本地偏好重新同步开机自启注册项（修复 Windows 读写 path/args 不一致导致开关回弹）
    try {
        syncAutoStartLoginItemFromPersisted();
    } catch (e) {
        console.warn('[AutoStart] sync on ready failed:', e && e.message);
    }

    // 家目录矫正：优先真实用户目录；不可写时改走 AppData\NexoraAgent，禁止落到裸 Temp
    // 多开第 2+ 实例：强制使用本实例 userData 下的隔离 home，避免与主实例抢 .openclaw / 18789
    try {
        const secondaryInstance = global.nexoraInstance && global.nexoraInstance.id > 1;
        if (secondaryInstance) {
            const isolatedHome = path.join(global.nexoraInstance.dir, 'openclaw-home');
            fs.mkdirSync(isolatedHome, { recursive: true });
            applyResolvedOpenClawHome(isolatedHome);
            console.log(`[Instance] #${global.nexoraInstance.id} isolated OpenClaw home: ${isolatedHome}`);
            console.log(`[System] OPENCLAW_HOME=${process.env.OPENCLAW_HOME}`);
            console.log(`[System] OPENCLAW_STATE_DIR=${process.env.OPENCLAW_STATE_DIR}`);
            console.log(`[System] OpenClaw config dir: ${CONFIG_DIR}`);
        } else {
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
        }
    } catch (err) {
        console.error('[System] Failed to resolve true user home:', err.message);
    }

    markClientBootPhase('settings-home-ready');

    // 先出窗口再种插件，避免首启同步拷贝把 UI 卡死
    // CONFIG_DIR 最终确定后再挂载语音运行时（设置文件落在用户 OpenClaw 目录）
    try {
        voiceRuntime.init({
            configDir: CONFIG_DIR,
            settingsStore: getClientSettingsStore(),
            getMainWindow: () => mainWindow
        });
    } catch (e) {
        console.warn('[VoiceRuntime] re-init failed:', e.message);
    }

    try {
        createWindow(bootSplash);
        markClientBootPhase('window-created');
    } catch (err) {
        appendMainDiagnostic('startup-create-window-failed', err);
        try {
            dialog.showErrorBox('Nexora Agent 启动失败', `主窗口创建失败：${err && err.message ? err.message : err}`);
        } catch (_) {}
        app.quit();
        return;
    }
    try {
        createTray();
    } catch (err) {
        // 托盘不是主功能，托盘初始化失败不应让整个应用退出。
        appendMainDiagnostic('startup-tray-failed', err);
        tray = null;
    }
    setImmediate(() => {
        try {
            prepareGatewayRuntimeInBackground(bootSplash)
                .then(() => console.log('[GatewayRuntime] background prepare completed'))
                .catch(e => console.warn('[GatewayRuntime] background prepare failed:', e.message));
        } catch (e) {}
        try { watchRoleConfigFile(); } catch (e) {}
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
}).catch((err) => {
    appendMainDiagnostic('startup-unhandled', err);
    console.error('[Startup] app.whenReady failed:', err && err.stack ? err.stack : err);
    try {
        dialog.showErrorBox('Nexora Agent 启动失败', String(err && (err.stack || err.message) || err));
    } catch (_) {}
    try { app.quit(); } catch (_) {}
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// 应用退出时必须清理本实例内核；系统代理仅在本实例开启过时才关闭（避免多开误关主实例代理）
app.on('will-quit', async (e) => {
    e.preventDefault();
    // 兜底：任一清理步骤(数据中心/加速内核/系统代理)若卡住不 resolve，8 秒后强制退出，避免退不掉
    try { setTimeout(() => { try { app.exit(0); } catch (_) {} }, 8000).unref(); } catch (_) {}
    try {
        voiceRuntime.dispose();
    } catch (err) {}
    try {
        await stopDataCenterServer();
    } catch (err) {}
    try {
        acceleration.setIsQuitting(true);
        const st = acceleration.getStatus();
        await acceleration.stopCore();
        // 同时停掉测速用的临时内核(原先只停主核，临时核会成孤儿占端口)
        try { if (typeof acceleration.stopTempMihomoCore === 'function') await acceleration.stopTempMihomoCore(); } catch (_) {}
        if (st && st.systemProxy) {
            await acceleration.applySystemProxy(false);
        }
    } catch (err) {}
    // 必须停掉网关子进程：否则退出后 node.exe 仍占用 18789、微信/QQ 保持登录，
    // 下次启动又被强杀于半写状态（会话/配置损坏）。await 确保杀干净再退出。
    try {
        await stopGatewayProcess({ reason: 'app-quit' });
    } catch (err) {}
    try {
        if (clientSettingsStore) clientSettingsStore.close();
        clientSettingsStore = null;
    } catch (err) {}
    app.exit(0);
});
