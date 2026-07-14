// main.js - Electron 主进程入口
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const {
    isTempLikePath,
    probeOpenClawHomeWritable,
    resolveStableOpenClawHome: resolveStableOpenClawHomeCore,
    applyOpenClawHomeEnv,
    detectRestrictedDesktop,
    writeHomeHealthMarker
} = require('./home-resolve');
const { ensureLatencySafeConfig } = require('./latency-tune');
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
process.on('uncaughtException', (err) => {
    try {
        const logPath = path.join(process.env.USERPROFILE || process.env.HOME || process.env.APPDATA || 'C:\\', '.openclaw', 'main_error.log');
        fs.writeFileSync(logPath, err.stack || err.message, 'utf8');
    } catch(e) {}
});
process.on('unhandledRejection', (reason) => {
    try {
        const logPath = path.join(process.env.USERPROFILE || process.env.HOME || process.env.APPDATA || 'C:\\', '.openclaw', 'main_error.log');
        fs.writeFileSync(logPath, String(reason), 'utf8');
    } catch(e) {}
});

// 获取可用的 Node 可执行文件路径
function getAvailableNodePath() {
    const sandboxPath = path.join(__dirname, '.node-sandbox', 'node.exe');
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
            const req = https.get(u, { headers: { 'User-Agent': 'ClawAI-Updater' } }, (res) => {
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
    const sandboxDir = path.join(__dirname, '.node-sandbox');
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
                    const req = https.get(u, { headers: { 'User-Agent': 'ClawAI-Updater' } }, (res) => {
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
let isQuitting = false;
let isMaximizedState = false;
let normalBounds = null;
const appStartTime = Date.now();
global.latestAcpDashboardUrl = '';

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
                title: health.title || 'ClawAI 存储提醒',
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
    if (!isTempLikePath(fromHome)) return;
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

// 统一公共补丁位置 (绝对无空格路径，杜绝 Windows 空格解析 Bug)
const PUBLIC_PATCH_PATH = 'C:\\Users\\Public\\patch_gateway.js';
// (Copy logic moved to startGateway to ensure no file locking from zombie processes)

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

// 随安装包一起交付的 npm 渠道插件（写进 plugins.load.paths，别人电脑无需再 npm install）
const BUNDLED_NPM_CHANNEL_PLUGINS = [
    { id: 'openclaw-weixin', candidates: [path.join('node_modules', '@tencent-weixin', 'openclaw-weixin')] },
    { id: 'qqbot', candidates: [path.join('node_modules', '@openclaw', 'qqbot')] },
    { id: 'feishu', candidates: [path.join('node_modules', '@openclaw', 'feishu')] },
    // voice-call 不要写入 load.paths：以 load.paths 加载会被当成非官方插件，
    // OpenClaw 2026.7+ 会拒绝 openKeyedStore（通话记录 SQLite），报 trusted plugins 错误。
    // 保留 package.json 依赖以随包交付；运行时走 AppData 里的官方 npm 安装记录。
    { id: 'slack', candidates: [path.join('node_modules', '@openclaw', 'slack')] },
    { id: 'whatsapp', candidates: [path.join('node_modules', '@openclaw', 'whatsapp')] },
    { id: 'matrix', candidates: [path.join('node_modules', '@openclaw', 'matrix')] }
];

function resolveBundledNpmPluginPath(entry) {
    const candidates = entry.candidates || [];
    for (const rel of candidates) {
        const abs = path.isAbsolute(rel) ? rel : path.join(__dirname, rel);
        if (fs.existsSync(abs)) return abs;
    }
    // 开发树缺包时，回退到已安装产品目录（用户当前卡在 Install Weixin? 的常见原因）
    const fallbackRoots = [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClawAI', 'resources', 'app'),
        path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ClawAI', 'resources', 'app')
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

    let srcVersion = '';
    try {
        srcVersion = JSON.parse(fs.readFileSync(path.join(bundledSrc, 'package.json'), 'utf8')).version || '';
    } catch (e) {}

    const projectDir = path.join(
        CONFIG_DIR,
        'npm',
        'projects',
        encodeOpenClawNpmProjectDirName(packageName)
    );
    const installPath = path.join(projectDir, 'node_modules', ...packageName.split('/'));
    const destPkgPath = path.join(installPath, 'package.json');

    let needCopy = !fs.existsSync(destPkgPath);
    if (!needCopy && srcVersion) {
        try {
            const destVersion = JSON.parse(fs.readFileSync(destPkgPath, 'utf8')).version || '';
            if (destVersion && destVersion !== srcVersion) needCopy = true;
        } catch (e) {
            needCopy = true;
        }
    }

    if (needCopy) {
        fs.mkdirSync(path.dirname(installPath), { recursive: true });
        fs.cpSync(bundledSrc, installPath, { recursive: true, force: true });
        console.log(`[PluginSeed] Official npm seed: ${pluginId} → ${installPath}`);
    }

    // 项目级 package.json，供 OpenClaw buildRecoveredManagedNpmInstallRecords 扫描
    const projectPkgPath = path.join(projectDir, 'package.json');
    const depSpec = srcVersion || '2026.7.1';
    let projectPkg = { private: true, dependencies: {} };
    try {
        if (fs.existsSync(projectPkgPath)) {
            projectPkg = JSON.parse(fs.readFileSync(projectPkgPath, 'utf8')) || projectPkg;
        }
    } catch (e) {}
    if (!projectPkg.dependencies) projectPkg.dependencies = {};
    if (projectPkg.dependencies[packageName] !== depSpec) {
        projectPkg.private = true;
        projectPkg.dependencies[packageName] = depSpec;
        fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(projectPkgPath, JSON.stringify(projectPkg, null, 2) + '\n', 'utf8');
    }

    return { seeded: true, installPath, version: srcVersion || depSpec };
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
    }

    return changed;
}

// 通过 NODE_OPTIONS 把 patch_gateway.js 传播到ClawAI及其 spawn 出的所有子进程/worker。
function buildPatchedNodeOptions(patchPath) {
    const targetPath = 'C:/Users/Public/patch_gateway.js';
    const injected = `--require "${targetPath}" --dns-result-order=ipv4first --no-warnings`;
    const existing = (process.env.NODE_OPTIONS || '').trim();
    if (existing.includes(targetPath)) return existing;
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
- 由 ClawAI「长期记忆」插件栈自动维护（摘要 / 旋转归档 / 压缩护栏）。
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

        seedFromRoot(path.join(__dirname, 'plugins'));
        seedFromRoot(path.join(__dirname, 'extensions'));

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
    const config = JSON.parse(raw);
    let needsSave = false;

    if (!config.plugins) { config.plugins = {}; needsSave = true; }
    if (!config.plugins.entries) { config.plugins.entries = {}; needsSave = true; }
    if (!config.plugins.allow) { config.plugins.allow = []; needsSave = true; }
    if (!config.plugins.load) { config.plugins.load = {}; needsSave = true; }
    if (!Array.isArray(config.plugins.load.paths)) { config.plugins.load.paths = []; needsSave = true; }
    if (!config.plugins.installs) { config.plugins.installs = {}; needsSave = true; }

    const wantById = {};
    for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
        const abs = resolveBundledNpmPluginPath(entry);
        if (abs) wantById[entry.id] = path.resolve(abs);
    }

    const channelPathMatchers = [
        { id: 'openclaw-weixin', re: /(?:^|[\\/])openclaw-weixin(?:[\\/]|$)/i },
        { id: 'feishu', re: /[\\/]@openclaw[\\/]feishu(?:[\\/]|$)/i },
        { id: 'qqbot', re: /[\\/]@openclaw[\\/]qqbot(?:[\\/]|$)/i },
        { id: 'slack', re: /[\\/]@openclaw[\\/]slack(?:[\\/]|$)/i },
        { id: 'whatsapp', re: /[\\/]@openclaw[\\/]whatsapp(?:[\\/]|$)/i },
        { id: 'matrix', re: /[\\/]@openclaw[\\/]matrix(?:[\\/]|$)/i }
    ];

    const filteredPaths = [];
    for (const p of config.plugins.load.paths) {
        if (typeof p !== 'string') { needsSave = true; continue; }
        let drop = false;
        for (const m of channelPathMatchers) {
            if (!m.re.test(p)) continue;
            const want = wantById[m.id];
            if (!want || path.resolve(p) !== want) {
                drop = true;
                needsSave = true;
            }
            break;
        }
        if (drop) continue;
        try {
            if (!fs.existsSync(p)) {
                needsSave = true;
                continue;
            }
        } catch (e) {
            needsSave = true;
            continue;
        }
        filteredPaths.push(p);
    }

    for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
        const abs = resolveBundledNpmPluginPath(entry);
        if (!abs) {
            console.warn(`[PluginSeed] Pre-gateway missing bundled: ${entry.id}`);
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

    for (const item of [
        { pluginId: 'openclaw-weixin', packageName: '@tencent-weixin/openclaw-weixin' },
        { pluginId: 'feishu', packageName: '@openclaw/feishu' },
        { pluginId: 'qqbot', packageName: '@openclaw/qqbot' },
    ]) {
        try {
            const seed = ensureOfficialExternalNpmPluginSeeded(item);
            if (!seed.seeded) {
                console.warn(`[PluginSeed] Pre-gateway ${item.pluginId}:`, seed.reason);
                continue;
            }
            const prev = config.plugins.installs[item.pluginId] || {};
            const ver = seed.version || prev.resolvedVersion || '0.0.0';
            const next = {
                ...prev,
                source: 'npm',
                spec: `${item.packageName}@${ver}`,
                installPath: seed.installPath,
                resolvedName: item.packageName,
                resolvedVersion: ver,
                resolvedSpec: `${item.packageName}@${ver}`,
                version: ver,
                installedAt: prev.installedAt || new Date().toISOString()
            };
            if (JSON.stringify(prev) !== JSON.stringify(next)) {
                config.plugins.installs[item.pluginId] = next;
                needsSave = true;
            }
        } catch (e) {
            console.warn(`[PluginSeed] Pre-gateway ${item.pluginId} failed:`, e.message);
        }
    }

    if (needsSave) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        console.log('[PluginSeed] Pre-gateway channel trust records synced');
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
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function createWindow() {
    // ------------------- Splash Screen -------------------
    const splash = new BrowserWindow({
        width: 400,
        height: 300,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        center: true,
        show: true,
        backgroundColor: '#00000000' // 透明背景，交由 splash.html 样式控制
    });
    splash.loadFile('splash.html');
    // 主窗口保持隐藏，待渲染完成后一次性弹出
    mainWindow = new BrowserWindow({
        width: 1120,
        height: 760,
        minWidth: 1120,
        minHeight: 760,
        frame: false,
        resizable: true,
        maximizable: true,
        show: false,
        backgroundColor: '#0d0b18',
        icon: path.join(__dirname, 'config', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: false,
            allowRunningInsecureContent: true,
            webviewTag: true
        }
    });
    // 每次启动清除渲染进程缓存，确保 HTML/CSS/JS 修改立即生效
    session.defaultSession.clearCache().catch(() => {});

    mainWindow.loadFile('index.html');
    // 当渲染进程首次绘制完成后，关闭 splash 并展示主窗口
    mainWindow.once('ready-to-show', () => {
        splash.destroy();
        mainWindow.show();
    });
    // Duplicate mainWindow creation removed


    // Duplicate window init block removed

    mainWindow.webContents.on('did-finish-load', async () => {
        try {
            const html = await mainWindow.webContents.executeJavaScript("document.body.innerHTML");
            const logPath = path.join(process.env.USERPROFILE || process.env.HOME || process.env.APPDATA || 'C:\\', '.openclaw', 'actual_rendered_html.log');
            require('fs').writeFileSync(logPath, html, 'utf8');
        } catch (e) {
            try {
                const logPath = path.join(process.env.USERPROFILE || process.env.HOME || process.env.APPDATA || 'C:\\', '.openclaw', 'actual_rendered_html.log');
                require('fs').writeFileSync(logPath, `Error executing script: ${e.message}`, 'utf8');
            } catch (err) {}
        }
    });

    // 拦截本地ClawAI面板的 HTTP 响应头，移除 X-Frame-Options 限制，防止内置 iframe 跨域白屏/黑屏拒绝渲染
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
            showNotification('ClawAI助手已最小化', 'ClawAI服务在后台持续运行，可通过右下角托盘图标唤醒。');
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
                mainWindow.show();
                mainWindow.focus();
            } 
        },
        { type: 'separator' },
        { 
            label: '启动ClawAI', 
            click: () => {
                if (mainWindow) mainWindow.webContents.send('gateway-control-trigger', 'start');
            } 
        },
        { 
            label: '停止ClawAI', 
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
    tray.setToolTip('ClawAI');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
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

// 停止后台ClawAI子进程
async function stopGatewayProcess() {
    if (gatewayProcess) {
        gatewayProcess.isIntentionallyStopped = true; // 标记为主动停止，避免触发意外退出警报
        if (process.platform === 'win32') {
            try {
                // 精准物理强杀所有可能遗留的旧沙箱 node.exe 僵尸进程，彻底杜绝多实例抢占和日志刷屏
                const killCmd = `powershell -ExecutionPolicy Bypass -NoProfile -Command "try { Get-CimInstance Win32_Process -Filter \\"Name = 'node.exe'\\" | Where-Object { $_.ExecutablePath -like '*ClawAI*' -or $_.CommandLine -like '*openclaw*' -or $_.ExecutablePath -like '*.node-sandbox*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } } catch {}; exit 0"`;
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
        if (mainWindow) {
            mainWindow.webContents.send('gateway-status', 'stopped');
            mainWindow.webContents.send('gateway-log', '\n[System] ClawAI服务已停止。\n');
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

// 启动后台ClawAI进程
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

        // 每次拉起ClawAI前，先物理强制杀掉任何霸占 18789 端口的残留进程，确保新实例完美就绪
        if (process.platform === 'win32') {
            try {
                // 精准物理强杀所有可能遗留的旧沙箱 node.exe 僵尸进程，彻底杜绝多实例抢占和日志刷屏
                const killCmd = `powershell -ExecutionPolicy Bypass -NoProfile -Command "try { Get-CimInstance Win32_Process -Filter \\"Name = 'node.exe'\\" | Where-Object { $_.ExecutablePath -like '*ClawAI*' -or $_.CommandLine -like '*openclaw*' -or $_.ExecutablePath -like '*.node-sandbox*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } } catch {}; exit 0"`;
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
            // 终极物理自愈：强行清理可能引发 EPERM 的 skills-prompts 缓存（不管它是文件还是损坏目录）
            const cleanupPaths = [
                path.join(process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\admin', '.openclaw', 'agents', 'main', 'sessions', 'skills-prompts'),
                'C:\\Users\\admin\\.openclaw\\agents\\main\\sessions\\skills-prompts',
                'C:\\Users\\Yuan\\.openclaw\\agents\\main\\sessions\\skills-prompts'
            ];
            cleanupPaths.forEach(p => {
                try {
                    if (fs.existsSync(p)) {
                        fs.rmSync(p, { recursive: true, force: true });
                        console.log(`[TokenGuard] Force cleaned prompts cache at: ${p}`);
                    }
                } catch(e) {
                    console.error(`[TokenGuard] Failed to clean ${p}:`, e.message);
                }
            });

            // 部署内置自定义插件到用户状态目录, 确保打包后在别人电脑上插件也能被 openclaw 发现并加载
            seedBundledPlugins();

            // 每次启动 Gateway 前强制同步渠道插件信任记录（load.paths + plugins.installs），
            // 避免仅打开状态页不读配置时仍卡在「* Install Weixin plugin?」
            try {
                prepareChannelPluginsBeforeGateway();
            } catch (e) {
                console.warn('[PluginSeed] pre-gateway prepare skipped:', e.message);
            }

            // 启动ClawAI前再跑一次延迟收紧，确保磁盘上的配置已是“快配置”
            try {
                if (fs.existsSync(CONFIG_PATH)) {
                    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
                    const parsed = JSON.parse(raw);
                    const tuned = ensureLatencySafeConfig(parsed);
                    if (tuned.changed) {
                        fs.writeFileSync(CONFIG_PATH, JSON.stringify(tuned.config, null, 2), 'utf8');
                        console.log('[LatencyTune] Pre-gateway:', tuned.changes.join(' | '));
                    }
                }
            } catch (e) {
                console.warn('[LatencyTune] pre-gateway skipped:', e.message);
            }

            // 在杀掉所有可能锁定补丁的僵尸进程后，安全地拷贝最新的 patch_gateway.js 与截图脚本
            try {
                const localPatch = path.join(__dirname, 'patch_gateway.js');
                if (fs.existsSync(localPatch)) {
                    fs.copyFileSync(localPatch, PUBLIC_PATCH_PATH);
                    console.log(`[TokenGuard] Copied public patch to ${PUBLIC_PATCH_PATH} successfully after cleanup.`);
                }
                const localTokenParse = path.join(__dirname, 'token-usage-parse.js');
                if (fs.existsSync(localTokenParse)) {
                    try {
                        fs.copyFileSync(localTokenParse, 'C:\\Users\\Public\\token-usage-parse.js');
                    } catch (e) {}
                }
                const localCapture = path.join(__dirname, 'capture-desktop.ps1');
                const publicCapture = 'C:\\Users\\Public\\capture-desktop.ps1';
                if (fs.existsSync(localCapture)) {
                    fs.copyFileSync(localCapture, publicCapture);
                    // 同步一份到 OPENCLAW_STATE_DIR / 家目录，方便手工与无影环境定位
                    const altDirs = [
                        process.env.OPENCLAW_STATE_DIR,
                        process.env.OPENCLAW_HOME && path.join(process.env.OPENCLAW_HOME, '.openclaw'),
                        CONFIG_DIR
                    ].filter(Boolean);
                    for (const dir of altDirs) {
                        try {
                            fs.mkdirSync(dir, { recursive: true });
                            fs.copyFileSync(localCapture, path.join(dir, 'capture-desktop.ps1'));
                        } catch (e) {}
                    }
                    console.log(`[TokenGuard] Copied capture-desktop.ps1 to ${publicCapture}`);
                }
            } catch (e) {
                console.error('[TokenGuard] Failed to copy public patch after cleanup:', e.message);
            }

            // 优先通过物理路径直接定位（完美避开打包后 Node.js 模块 exports 对子路径文件的加载限制）
            let openclawEntry = path.join(__dirname, 'node_modules', 'openclaw', 'dist', 'index.js');
            if (!fs.existsSync(openclawEntry)) {
                openclawEntry = require.resolve('openclaw/dist/index.js');
            }
            
            // 优先使用打包内置的或系统全局符合版本要求的 Node 运行时
            const nodeExePath = getAvailableNodePath();
            const patchPath = 'C:/Users/Public/patch_gateway.js';
            const forkOptions = {
                cwd: CONFIG_DIR,
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                execArgv: ['--require', patchPath, '--no-warnings', '--dns-result-order=ipv4first'],
                // NODE_OPTIONS 确保补丁被继承到 openclaw 派生的所有后代 node 进程 (修复子进程 EPERM 顽疾)
                env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_OPTIONS: buildPatchedNodeOptions(patchPath) }
            };
            if (nodeExePath) {
                forkOptions.execPath = nodeExePath;
                const sandboxDir = path.dirname(nodeExePath);
                const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
                const originalPath = process.env[pathKey] || '';
                forkOptions.env[pathKey] = `${sandboxDir}${path.delimiter}${originalPath}`;
            }

            // 启动子进程运行ClawAI
            gatewayProcess = fork(openclawEntry, ['gateway', 'run', '--force', '--allow-unconfigured'], forkOptions);

            mainWindow.webContents.send('gateway-status', 'running');
            showNotification('ClawAI已成功启动', 'AI 本地ClawAI已在后台运行，开始监听 18789 端口。');

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
                    
                    // 拦截带动态密钥的控制台免密登录 URL
                    const acpMatch = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/acp\/[^\s"'\n]+/);
                    if (acpMatch) {
                        global.latestAcpDashboardUrl = acpMatch[0].trim();
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
                if (mainWindow) {
                    mainWindow.webContents.send('gateway-status', 'stopped');
                    if (!wasIntentionallyStopped) {
                        console.error(`[System] ClawAI核心进程意外退出，退出码: ${code}`);
                    }
                }
            });

        } catch (e) {
            if (mainWindow) {
                mainWindow.webContents.send('gateway-status', 'stopped');
                mainWindow.webContents.send('gateway-log', `[System] [ERROR] 无法找到内置ClawAI模块: ${e.message}\n`);
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
    const sandboxDir = path.join(__dirname, '.node-sandbox');
    const { spawn } = require('child_process');
    
    // 终极无痛方案：使用 PowerShell 的 -EncodedCommand 特性！
    // 将整个包含特殊字符、中文、和环境变量的脚本打包为 Base64 传递，彻底避开 CMD 的单双引号解析、吃字符以及防病毒脚本策略的拦截。
    const initScript = [
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
        `$env:Path = "${sandboxDir.replace(/\\/g, '\\\\')};" + $env:Path`,
        `Clear-Host`,
        `Write-Host "==========================================================" -ForegroundColor Green`,
        `Write-Host "         ClawAI 绿色沙箱开发终端 (PowerShell)             " -ForegroundColor Green`,
        `Write-Host "==========================================================" -ForegroundColor Green`,
        `Write-Host "  * 内置 Node 运行时已成功注入环境变量 PATH 最前面。" -ForegroundColor Cyan`,
        `Write-Host "  * 您可以直接在此处执行以下命令：" -ForegroundColor Cyan`,
        `Write-Host "      - node -v            (查看内置沙箱 Node 版本)" -ForegroundColor White`,
        `Write-Host "      - npm -v             (查看内置沙箱 npm 版本)" -ForegroundColor White`,
        `Write-Host "      - npx openclaw doctor (执行ClawAI CLI 诊断自检)" -ForegroundColor White`,
        `Write-Host "==========================================================" -ForegroundColor Green`,
        `Write-Host ""`
    ].join('\r\n');

    // 必须转换为 UTF-16LE 编码的 Buffer，然后再转 Base64 才能被 PowerShell 正确识别
    const encodedCmd = Buffer.from(initScript, 'utf16le').toString('base64');
    
    // 现在调用的命令行里，只有绝对安全的英文字母 Base64 字符串，不可能再有任何解析边界和乱码问题！
    const cmdLine = `start powershell -NoExit -ExecutionPolicy Bypass -EncodedCommand ${encodedCmd}`;

    spawn('cmd.exe', ['/c', cmdLine], {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore'
    }).unref();
});

let ptyProcess = null;

ipcMain.handle('builtin-terminal-start', (event, lang) => {
    if (ptyProcess) return; // 已经存在则不重复创建
    const sandboxDir = path.join(__dirname, '.node-sandbox');
    const pty = require('node-pty');
    
    const isEn = lang === 'en-US';
    const isTw = lang === 'zh-TW';
    
    const bannerTitle = isEn 
        ? "         ClawAI Built-in Sandbox Terminal (node-pty)      " 
        : (isTw ? "         ClawAI 內置沙箱開發終端 (node-pty)               " : "         ClawAI 内置沙箱开发终端 (node-pty)               ");
        
    const bannerCmds = isEn 
        ? "  * You can execute the following commands directly here:" 
        : (isTw ? "  * 您可以直接在此處執行以下命令：" : "  * 您可以直接在此处执行以下命令：");
        
    const cmdNode = isEn 
        ? "      - node -v            (Show sandbox Node version)" 
        : (isTw ? "      - node -v            (查看內置沙箱 Node 版本)" : "      - node -v            (查看内置沙箱 Node 版本)");
        
    const cmdNpm = isEn 
        ? "      - npm -v             (Show sandbox npm version)" 
        : (isTw ? "      - npm -v             (查看內置沙箱 npm 版本)" : "      - npm -v             (查看内置沙箱 npm 版本)");
    
    const initScript = [
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`,
        `$env:Path = "${sandboxDir.replace(/\\/g, '\\\\')};" + $env:Path`,
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
    
    ptyProcess = pty.spawn('powershell.exe', ['-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCmd], {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
        cwd: __dirname,
        env: process.env
    });
    
    ptyProcess.on('data', function(data) {
        if (mainWindow) {
            mainWindow.webContents.send('builtin-terminal-data', data);
        }
    });
    
    ptyProcess.on('exit', () => {
        ptyProcess = null;
    });
    return true;
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

// 配置文件的读写 IPC
ipcMain.handle('config-read', async () => {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            // 从模板初始化
            const examplePath = path.join(__dirname, 'config', 'openclaw.json.example');
            if (fs.existsSync(examplePath)) {
                if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
                fs.copyFileSync(examplePath, CONFIG_PATH);
            } else {
                return null;
            }
        }
        let content = fs.readFileSync(CONFIG_PATH, 'utf8');
        content = content.replace(/^\uFEFF/, '');
        const config = JSON.parse(content);
        // 自动补全 ui.assistant 头像配置，以及 gateway.controlUi.basePath (修复面板侧边栏破图问题)
        let needsSave = false;
        if (!config.ui) { config.ui = {}; needsSave = true; }
        if (!config.ui.assistant) { config.ui.assistant = {}; needsSave = true; }
        if (!config.ui.assistant.avatar) {
            config.ui.assistant.avatar = '🤖';
            config.ui.assistant.name = config.ui.assistant.name || 'ClawAI';
            needsSave = true;
        }
        if (!config.gateway) { config.gateway = {}; needsSave = true; }
        if (!config.gateway.controlUi) { config.gateway.controlUi = {}; needsSave = true; }
        if (config.gateway.controlUi.basePath !== '/acp') {
            config.gateway.controlUi.basePath = '/acp';
            needsSave = true;
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
        // 用独立戳文件保证每个版本只强制开启一次, 之后用户在 UI 里关闭会被尊重
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
        
        const weixinPluginPath = path.join(__dirname, 'node_modules', '@tencent-weixin', 'openclaw-weixin');
        // 当前安装目录下随包渠道插件的权威绝对路径（别人电脑 / 换安装位置后必须重写）
        const bundledChannelAbsById = {};
        for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
            const abs = resolveBundledNpmPluginPath(entry);
            if (abs) bundledChannelAbsById[entry.id] = path.resolve(abs);
        }
        const originalPaths = config.plugins.load.paths || [];
        const filteredPaths = originalPaths.filter(p => {
            if (typeof p !== 'string') return false;
            // 迁移：剔除 load.paths 里的 voice-call，避免 trusted store 被拒
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
            // 飞书 / QQ / Slack / WhatsApp / Matrix：剔除其它机器或其它安装目录遗留的绝对路径
            const channelPathMatchers = [
                { id: 'feishu', re: /[\\/]@openclaw[\\/]feishu(?:[\\/]|$)/i },
                { id: 'qqbot', re: /[\\/]@openclaw[\\/]qqbot(?:[\\/]|$)/i },
                { id: 'slack', re: /[\\/]@openclaw[\\/]slack(?:[\\/]|$)/i },
                { id: 'whatsapp', re: /[\\/]@openclaw[\\/]whatsapp(?:[\\/]|$)/i },
                { id: 'matrix', re: /[\\/]@openclaw[\\/]matrix(?:[\\/]|$)/i }
            ];
            for (const m of channelPathMatchers) {
                if (!m.re.test(p)) continue;
                const want = bundledChannelAbsById[m.id];
                if (!want || path.resolve(p) !== want) {
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

        // 把随包 npm 渠道插件（微信 / QQ / 飞书 / Slack / WhatsApp / Matrix）注入 load.paths，
        // 保证别人电脑开箱即用，不依赖 openclaw plugins install / 联网下载。
        for (const entry of BUNDLED_NPM_CHANNEL_PLUGINS) {
            const abs = resolveBundledNpmPluginPath(entry);
            if (!abs) {
                console.warn(`[PluginSeed] Bundled npm plugin missing: ${entry.id}`);
                continue;
            }
            const resolvedPath = path.resolve(abs);
            const hasPath = filteredPaths.some(p => typeof p === 'string' && path.resolve(p) === resolvedPath);
            if (!hasPath) {
                filteredPaths.push(abs);
                needsSave = true;
            }
            // 确保配置里有 entry + allow（凭证类不强行写 enabled，尊重现有；缺省创建 enabled）
            if (!config.plugins.entries[entry.id]) {
                config.plugins.entries[entry.id] = { enabled: true };
                needsSave = true;
            }
            if (config.plugins.entries[entry.id].enabled === true && !config.plugins.allow.includes(entry.id)) {
                config.plugins.allow.push(entry.id);
                needsSave = true;
            }
        }

        // voice-call：不走 load.paths；离线种进官方 npm/projects，别人电脑也能 trusted + 开通话记录库
        try {
            const voiceSeed = ensureOfficialExternalNpmPluginSeeded({
                pluginId: 'voice-call',
                packageName: '@openclaw/voice-call'
            });
            if (!voiceSeed.seeded) {
                console.warn('[PluginSeed] voice-call official seed skipped:', voiceSeed.reason);
            } else if (voiceSeed.installPath) {
                if (!config.plugins.installs) config.plugins.installs = {};
                const prev = config.plugins.installs['voice-call'] || {};
                const next = {
                    ...prev,
                    source: 'npm',
                    spec: `@openclaw/voice-call@${voiceSeed.version || '2026.7.1'}`,
                    installPath: voiceSeed.installPath,
                    resolvedName: '@openclaw/voice-call',
                    resolvedVersion: voiceSeed.version || prev.resolvedVersion || '2026.7.1',
                    resolvedSpec: `@openclaw/voice-call@${voiceSeed.version || '2026.7.1'}`,
                    version: voiceSeed.version || prev.version || '2026.7.1',
                    installedAt: prev.installedAt || new Date().toISOString()
                };
                if (JSON.stringify(prev) !== JSON.stringify(next)) {
                    config.plugins.installs['voice-call'] = next;
                    needsSave = true;
                }
            }
        } catch (e) {
            console.warn('[PluginSeed] voice-call seed failed:', e.message);
        }
        if (!config.plugins.entries['voice-call']) {
            config.plugins.entries['voice-call'] = { enabled: true };
            needsSave = true;
        }
        if (config.plugins.entries['voice-call'].enabled === true && !config.plugins.allow.includes('voice-call')) {
            config.plugins.allow.push('voice-call');
            needsSave = true;
        }

        // 微信 / 飞书 / QQ：同步官方 npm installs，避免网关启动时卡在「Install xxx plugin?」交互问答
        for (const item of [
            { pluginId: 'openclaw-weixin', packageName: '@tencent-weixin/openclaw-weixin' },
            { pluginId: 'feishu', packageName: '@openclaw/feishu' },
            { pluginId: 'qqbot', packageName: '@openclaw/qqbot' },
        ]) {
            try {
                const seed = ensureOfficialExternalNpmPluginSeeded(item);
                if (!seed.seeded) {
                    console.warn(`[PluginSeed] ${item.pluginId} official seed skipped:`, seed.reason);
                } else if (seed.installPath) {
                    if (!config.plugins.installs) config.plugins.installs = {};
                    const prev = config.plugins.installs[item.pluginId] || {};
                    const ver = seed.version || prev.resolvedVersion || '2026.6.11';
                    const next = {
                        ...prev,
                        source: 'npm',
                        spec: `${item.packageName}@${ver}`,
                        installPath: seed.installPath,
                        resolvedName: item.packageName,
                        resolvedVersion: ver,
                        resolvedSpec: `${item.packageName}@${ver}`,
                        version: ver,
                        installedAt: prev.installedAt || new Date().toISOString()
                    };
                    if (JSON.stringify(prev) !== JSON.stringify(next)) {
                        config.plugins.installs[item.pluginId] = next;
                        needsSave = true;
                    }
                }
            } catch (e) {
                console.warn(`[PluginSeed] ${item.pluginId} seed failed:`, e.message);
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
            try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8'); } catch(e) {}
        }
        return config;
    } catch (e) {
        console.error('Failed to read config:', e);
        return null;
    }
});

ipcMain.handle('config-save', async (event, newConfig) => {
    try {
        const cleanConfig = JSON.parse(JSON.stringify(newConfig));
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
        // 1. 如果ClawAI运行中，先停止以解除文件夹句柄锁
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
 * 通用内置渠道 login。新增扫码插件：在 ASYNC_CHANNEL_LOGIN 登记，或 IPC 传 openclawChannel/label。
 * 统一：信任预同步、跳过 Install?、出码超时、失败事件、可取消。
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

    const openclawEntry = path.join(__dirname, 'node_modules', 'openclaw', 'dist', 'index.js');
    if (!fs.existsSync(openclawEntry)) {
        return { success: false, error: '内置 OpenClaw 模块缺失，无法唤醒绑定' };
    }

    const nodeExePath = getAvailableNodePath();
    const patchPath = path.join(__dirname, 'patch_gateway.js');
    const cleanEnv = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' };
    for (const key of Object.keys(cleanEnv)) {
        if (key.toLowerCase().includes('proxy')) delete cleanEnv[key];
    }
    cleanEnv.NODE_OPTIONS = buildPatchedNodeOptions(patchPath);
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
                `${sess.label}渠道当前无法登录（插件未正确加载）。请停止后再启动 ClawAI，然后重试扫码绑定。`);
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
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ClawAI', '.openclaw', 'persistent_logs', 'real_tokens.json') : null
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

// 获取本地最新的带 token 的ClawAI面板 URL
ipcMain.handle('get-dashboard-url', async () => {
    if (global.latestAcpDashboardUrl && global.latestAcpDashboardUrl.includes('?token=')) {
        return global.latestAcpDashboardUrl;
    }
    try {
        const logPath = path.join(CONFIG_DIR, 'gateway_stdout.log');
        if (fs.existsSync(logPath)) {
            const logContent = fs.readFileSync(logPath, 'utf8');
            const matches = logContent.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/acp\/[^\s"'\n]+/g);
            if (matches && matches.length > 0) {
                const latestUrl = matches[matches.length - 1].trim();
                global.latestAcpDashboardUrl = latestUrl;
                return latestUrl;
            }
        }
    } catch (e) {
        console.error('Failed to parse gateway log for dashboard url:', e);
    }
    
    // 降级读取 openclaw.json 的 token 拼接成免密 URL
    let fallbackToken = '';
    try {
        const configPath = path.join(CONFIG_DIR, 'openclaw.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config.gateway && config.gateway.auth && config.gateway.auth.token) {
                fallbackToken = config.gateway.auth.token;
            }
        }
    } catch (err) {}
    
    return fallbackToken 
        ? `http://127.0.0.1:18789/acp/?token=${fallbackToken}`
        : 'http://127.0.0.1:18789/acp/';
});

// 一键拉起外部浏览器链接 (用于免密 ACP 控制台跳转)
ipcMain.handle('open-external', async (event, url) => {
    try {
        const { shell } = require('electron');
        
        // 特殊处理：如果是打开 OpenClaw 控制面板，我们通过官方 dashboard 命令动态获取带最新令牌的免密 URL
        if (url === 'openclaw-dashboard') {
            if (global.latestAcpDashboardUrl) {
                shell.openExternal(global.latestAcpDashboardUrl);
                return true;
            }

            // 次优先：从本地持久化日志流中扫描是否有最近一次ClawAI启动时输出的免密登录链接
            try {
                const logPath = path.join(CONFIG_DIR, 'gateway_stdout.log');
                if (fs.existsSync(logPath)) {
                    const logContent = fs.readFileSync(logPath, 'utf8');
                    const matches = logContent.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/acp\/[^\s"'\n]+/g);
                    if (matches && matches.length > 0) {
                        const latestUrl = matches[matches.length - 1].trim();
                        global.latestAcpDashboardUrl = latestUrl;
                        shell.openExternal(latestUrl);
                        return true;
                    }
                }
            } catch (e) {
                console.error('Failed to parse gateway log URL fallback:', e);
            }

            const { fork } = require('child_process');
            
            let openclawEntry = path.join(__dirname, 'node_modules', 'openclaw', 'dist', 'index.js');
            if (!require('fs').existsSync(openclawEntry)) {
                try {
                    openclawEntry = require.resolve('openclaw/dist/index.js');
                } catch(e) {
                    // 降级使用全局 openclaw 命令定位，不使用硬编码路径
                    openclawEntry = 'openclaw';
                }
            }

            return new Promise((resolve) => {
                const nodeExePath = getAvailableNodePath();
                const forkOptions = {
                    stdio: 'pipe',
                    execArgv: ['--no-warnings', '--dns-result-order=ipv4first'],
                    env: {
                        ...process.env,
                        NODE_TLS_REJECT_UNAUTHORIZED: '0'
                    }
                };
                if (nodeExePath) {
                    forkOptions.execPath = nodeExePath;
                    const sandboxDir = path.dirname(nodeExePath);
                    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
                    const originalPath = process.env[pathKey] || '';
                    forkOptions.env[pathKey] = `${sandboxDir}${path.delimiter}${originalPath}`;
                }
                const child = fork(openclawEntry, ['dashboard', '--no-open'], forkOptions);

                let resolved = false;
                const handleData = (data) => {
                    const text = data.toString();
                    // 正则提取含 token/key 且包含 127.0.0.1 或 localhost 的 URL 链接
                    const urlMatch = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s]+/);
                    if (urlMatch && !resolved) {
                        resolved = true;
                        shell.openExternal(urlMatch[0].trim());
                        child.kill();
                        resolve(true);
                    }
                };

                child.stdout.on('data', handleData);
                child.stderr.on('data', handleData);

                // 5秒超时安全退出
                setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        child.kill();
                        shell.openExternal("http://127.0.0.1:18789/acp/chat?token=openclaw-dev-token-998877&key=openclaw-dev-token-998877&apiKey=openclaw-dev-token-998877&session=main");
                        resolve(false);
                    }
                }, 5000);

                child.on('exit', () => {
                    if (!resolved) {
                        resolved = true;
                        shell.openExternal("http://127.0.0.1:18789/acp/chat?token=openclaw-dev-token-998877&key=openclaw-dev-token-998877&apiKey=openclaw-dev-token-998877&session=main");
                        resolve(false);
                    }
                });
            });
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
const UPDATE_REPO = '2014-y/ClawAI';
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
            fileName = `ClawAI.Setup.${latestVersion}.exe`;
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
    const savePath = path.join(tempDir, fileName || 'ClawAI-Setup-Latest.exe');

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
                headers: { 'User-Agent': 'ClawAI-Updater' },
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

// 4. 内置ClawAI核心包更新（openclaw npm 包热更新）
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

        // 3) 停止ClawAI（同时释放 node.exe 文件句柄，便于随后替换）
        log('正在停止ClawAI...');
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

        // 7) 自动重启ClawAI（直接在主进程内拉起并校验，避免 IPC 往返 + 端口/文件句柄未释放导致的重启失败）
        log('正在重启ClawAI...');

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
            // 等待ClawAI进程真正就绪（若入口缺失或崩溃，exit 回调会把 gatewayProcess 复位为 null）
            await new Promise(r => setTimeout(r, 2500));
            if (gatewayProcess) { restarted = true; break; }
            if (attempt < maxAttempts) {
                log(`ClawAI尚未就绪，正在重试 (${attempt}/${maxAttempts})...`);
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        if (restarted) {
            log('ClawAI已重启成功');
        } else {
            log('ClawAI自动重启失败，请手动点击右侧「启动ClawAI」按钮');
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
                ? `ClawAI核心已成功更新到 openclaw@${installedVersion}，ClawAI已重启完成。`
                : `ClawAI核心已更新到 openclaw@${installedVersion}，但自动重启失败，请手动点击「启动ClawAI」。`
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
app.whenReady().then(() => {
    // 家目录矫正：优先真实用户目录；不可写时改走 AppData\ClawAI，禁止落到裸 Temp
    try {
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
            if (mustLeaveTemp && envHome) {
                migrateOpenClawDataIfNeeded(envHome, homePath);
            } else if (!preferredWritable && preferredHome) {
                try {
                    const srcCfg = path.join(preferredHome, '.openclaw', 'openclaw.json');
                    const dstCfg = path.join(homePath, '.openclaw', 'openclaw.json');
                    if (fs.existsSync(srcCfg) && !fs.existsSync(dstCfg)) {
                        fs.mkdirSync(path.dirname(dstCfg), { recursive: true });
                        fs.copyFileSync(srcCfg, dstCfg);
                    }
                } catch (e) {}
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
                actions: ['将 ClawAI 加入受控文件夹访问排除项', '重启 ClawAI']
            }, homePath));
        }
    } catch (err) {
        console.error('[System] Failed to resolve true user home:', err.message);
    }

    // 尽早部署插件, 确保首次读配置 / 启动ClawAI前 ~/.openclaw/extensions 已就绪
    try { seedBundledPlugins(); } catch (e) {}
    createWindow();
    createTray();

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
