// main.js - Electron 主进程入口
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
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

// 通过 NODE_OPTIONS 把 patch_gateway.js 传播到网关及其 spawn 出的所有子进程/worker。
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

function seedBundledPlugins() {
    try {
        const destRoot = path.join(CONFIG_DIR, 'extensions');
        fs.mkdirSync(destRoot, { recursive: true });
        try {
            fs.mkdirSync(path.join(CONFIG_DIR, 'workspace', 'memory'), { recursive: true });
            const memFile = path.join(CONFIG_DIR, 'workspace', 'MEMORY.md');
            if (!fs.existsSync(memFile)) fs.writeFileSync(memFile, '', 'utf8');
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

    // 拦截本地网关面板的 HTTP 响应头，移除 X-Frame-Options 限制，防止内置 iframe 跨域白屏/黑屏拒绝渲染
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
            showNotification('网关助手已最小化', '网关服务在后台持续运行，可通过右下角托盘图标唤醒。');
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
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
            label: '启动网关', 
            click: () => {
                if (mainWindow) mainWindow.webContents.send('gateway-control-trigger', 'start');
            } 
        },
        { 
            label: '停止网关', 
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

// 停止后台网关子进程
function stopGatewayProcess() {
    if (gatewayProcess) {
        gatewayProcess.isIntentionallyStopped = true; // 标记为主动停止，避免触发意外退出警报
        if (process.platform === 'win32') {
            try {
                const { execSync } = require('child_process');
                execSync(`taskkill /pid ${gatewayProcess.pid} /T /F`);
            } catch (err) {
                try { gatewayProcess.kill('SIGKILL'); } catch (e) {}
            }
            // 保底物理清除霸占端口 18789 的残留
            try {
                const { execSync } = require('child_process');
                const netstatOut = execSync('netstat -ano').toString();
                const lines = netstatOut.split('\n');
                lines.forEach(line => {
                    if (line.includes(':18789') && line.includes('LISTENING')) {
                        const parts = line.trim().split(/\s+/);
                        const pid = parts[parts.length - 1];
                        if (pid && parseInt(pid) > 0) {
                            try { execSync(`taskkill /pid ${pid} /F /T`); } catch(e) {}
                        }
                    }
                });
            } catch(err) {}
        } else {
            gatewayProcess.kill('SIGTERM');
        }
        gatewayProcess = null;
        if (mainWindow) {
            mainWindow.webContents.send('gateway-status', 'stopped');
            mainWindow.webContents.send('gateway-log', '\n[System] 网关服务已停止。\n');
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

// 启动后台网关进程
ipcMain.on('gateway-action', (event, action) => {
    if (action === 'start') {
        if (gatewayProcess) return;

        // 每次拉起网关前，先物理强制杀掉任何霸占 18789 端口的残留进程，确保新实例完美就绪
        if (process.platform === 'win32') {
            try {
                const { execSync } = require('child_process');
                const currentPid = process.pid;
                const parentPid = process.ppid;
                const netstatOut = execSync('netstat -ano').toString();
                const lines = netstatOut.split('\n');
                const pidsToKill = new Set();
                lines.forEach(line => {
                    if (line.includes(':18789') && line.includes('LISTENING')) {
                        const parts = line.trim().split(/\s+/);
                        const pid = parts[parts.length - 1];
                        if (pid && parseInt(pid) > 0) {
                            pidsToKill.add(pid);
                        }
                    }
                });
                pidsToKill.forEach(pid => {
                    if (pid === currentPid.toString() || pid === parentPid.toString()) return;
                    try {
                        execSync(`taskkill /pid ${pid} /F`);
                        console.log(`Successfully killed leftover gateway process occupying port 18789, PID: ${pid}`);
                    } catch(e) {}
                });
            } catch(err) {
                console.error('Failed to cleanup leftover port 18789 processes:', err);
            }
        }

        if (mainWindow) {
            mainWindow.webContents.send('gateway-status', 'starting');
            mainWindow.webContents.send('gateway-log', '[System] 正在拉起内置 OpenClaw Gateway 核心...\n');
        }

        try {
            // 物理强杀所有后台遗存的 node.exe 僵尸进程，彻底释放可能死锁的 skills-prompts 目录和 18789 端口
            if (process.platform === 'win32') {
                try {
                    const { execSync } = require('child_process');
                    const currentPid = process.pid;
                    const parentPid = process.ppid;
                    const netstatOut = execSync('netstat -ano').toString();
                    const lines = netstatOut.split('\n');
                    const gatewayLine = lines.find(line => line.includes('18789') && line.includes('LISTENING'));
                    if (gatewayLine) {
                        const match = gatewayLine.trim().split(/\s+/);
                        const pid = match[match.length - 1];
                        if (pid && pid !== '0' && pid !== currentPid.toString() && pid !== parentPid.toString()) {
                            // 安全强杀：绝不加 /T 参数，避免误杀 npm/electron 祖先进程引发大面积应用闪退
                            try { execSync(`taskkill /pid ${pid} /F`); } catch(e) {}
                        }
                    }
                } catch(err) {
                    console.error('Failed to cleanup node zombie processes:', err);
                }
            }

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

            // 在杀掉所有可能锁定补丁的僵尸进程后，安全地拷贝最新的 patch_gateway.js 补丁
            try {
                const localPatch = path.join(__dirname, 'patch_gateway.js');
                if (fs.existsSync(localPatch)) {
                    fs.copyFileSync(localPatch, PUBLIC_PATCH_PATH);
                    console.log(`[TokenGuard] Copied public patch to ${PUBLIC_PATCH_PATH} successfully after cleanup.`);
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

            // 启动子进程运行网关
            gatewayProcess = fork(openclawEntry, ['gateway', 'run', '--force', '--allow-unconfigured'], forkOptions);

            mainWindow.webContents.send('gateway-status', 'running');
            showNotification('网关已成功启动', 'AI 本地网关已在后台运行，开始监听 18789 端口。');

            // 提取日志及匹配登录二维码的公共处理函数
            const handleLogData = (data) => {
                let text = data.toString();
                if (text.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
                    text = text.split(/\r?\n/).filter(line => !line.includes('NODE_TLS_REJECT_UNAUTHORIZED') && !line.includes('disabling certificate verification')).join('\n');
                }
                if (!text.trim()) return;
                
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

                    // 自动匹配微信扫码登录 URL (支持 weixin.qq.com 或者是 wechaty.js.org 专属二维码链接)
                    const qrMatch = text.match(/https?:\/\/(?:login\.)?weixin\.qq\.com\/l\/[^\s"'\n]+/) || 
                                    text.match(/https?:\/\/wechaty\.js\.org\/qrcode\/[^\s"'\n]+/);
                    if (qrMatch) {
                        mainWindow.webContents.send('gateway-qrcode', qrMatch[0]);
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
                        console.error(`[System] 网关核心进程意外退出，退出码: ${code}`);
                    }
                }
            });

        } catch (e) {
            if (mainWindow) {
                mainWindow.webContents.send('gateway-status', 'stopped');
                mainWindow.webContents.send('gateway-log', `[System] [ERROR] 无法找到内置网关模块: ${e.message}\n`);
            }
        }
    } else if (action === 'stop') {
        stopGatewayProcess();
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
            if (config.plugins.entries[pluginName].enabled === true) {
                if (!config.plugins.allow.includes(pluginName)) {
                    config.plugins.allow.push(pluginName);
                    needsSave = true;
                }
            }
        });

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
        const originalPaths = config.plugins.load.paths || [];
        const filteredPaths = originalPaths.filter(p => {
            if (typeof p !== 'string') return false;
            // 过滤掉所有不一致的微信插件旧路径
            if (p.endsWith('openclaw-weixin') && path.resolve(p) !== path.resolve(weixinPluginPath)) {
                return false;
            }
            return true;
        });
        
        if (fs.existsSync(weixinPluginPath)) {
            const resolvedPath = path.resolve(weixinPluginPath);
            const hasPath = filteredPaths.some(p => typeof p === 'string' && path.resolve(p) === resolvedPath);
            if (!hasPath) {
                filteredPaths.push(weixinPluginPath);
            }
        }
        
        if (JSON.stringify(config.plugins.load.paths) !== JSON.stringify(filteredPaths)) {
            config.plugins.load.paths = filteredPaths;
            needsSave = true;
        }
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

// 清理微信登录态凭证实现彻底解绑
ipcMain.handle('wechat-clear', async () => {
    try {
        // 1. 如果网关运行中，先停止以解除文件夹句柄锁
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
ipcMain.handle('wechat-check-status', async () => {
    try {
        const weixinCachePath = path.join(CONFIG_DIR, 'openclaw-weixin');
        const exists = fs.existsSync(weixinCachePath) && fs.readdirSync(weixinCachePath).length > 0;
        
        let details = null;
        if (exists) {
            const accountsJsonPath = path.join(weixinCachePath, 'accounts.json');
            if (fs.existsSync(accountsJsonPath)) {
                try {
                    const accounts = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf8'));
                    if (accounts && accounts.length > 0) {
                        const accountId = accounts[0];
                        const accountDetailPath = path.join(weixinCachePath, 'accounts', `${accountId}.json`);
                        if (fs.existsSync(accountDetailPath)) {
                            const accountDetail = JSON.parse(fs.readFileSync(accountDetailPath, 'utf8'));
                            details = {
                                accountId: accountId.split('-')[0], // 简化标识名
                                savedAt: accountDetail.savedAt,
                                userId: accountDetail.userId ? accountDetail.userId.split('@')[0] : 'WeChat Bot'
                            };
                        }
                    }
                } catch (err) {}
            }
        }
        
        return { success: true, bound: exists, details };
    } catch (e) {
        return { success: false, bound: false, details: null, error: e.message };
    }
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

// 取消并强制杀死挂起的微信扫码登录进程
ipcMain.handle('wechat-login-cancel', async () => {
    if (wechatLoginProcess) {
        try {
            if (process.platform === 'win32') {
                const { execSync } = require('child_process');
                execSync(`taskkill /pid ${wechatLoginProcess.pid} /T /F`);
            } else {
                wechatLoginProcess.kill();
            }
        } catch (e) {}
        wechatLoginProcess = null;
    }
    return { success: true };
});

// 在后台启动独立的微信扫码登录进程
ipcMain.handle('wechat-login', async () => {
    try {
        if (wechatLoginProcess) {
            try {
                if (process.platform === 'win32') {
                    const { execSync } = require('child_process');
                    execSync(`taskkill /pid ${wechatLoginProcess.pid} /T /F`);
                } else {
                    wechatLoginProcess.kill();
                }
            } catch (err) {}
            wechatLoginProcess = null;
        }

        const openclawEntry = path.join(__dirname, 'node_modules', 'openclaw', 'dist', 'index.js');
        const nodeExePath = getAvailableNodePath();
        const patchPath = path.join(__dirname, 'patch_gateway.js');
        const cleanEnv = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' };
        for (const key of Object.keys(cleanEnv)) {
            if (key.toLowerCase().includes('proxy')) {
                delete cleanEnv[key];
            }
        }
        // 补丁传播到登录进程派生的所有子进程 (HTTPDNS 绕过 Fake-IP + mkdir 加固)
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
            const originalPath = process.env[pathKey] || '';
            forkOptions.env[pathKey] = `${sandboxDir}${path.delimiter}${originalPath}`;
        }

        // 启动 login 指令进程以触发扫码
        wechatLoginProcess = fork(openclawEntry, ['channels', 'login', '--channel', 'openclaw-weixin'], forkOptions);

        const handleLoginLog = (data) => {
            let text = data.toString();
            if (text.includes('NODE_TLS_REJECT_UNAUTHORIZED')) {
                text = text.split(/\r?\n/).filter(line => !line.includes('NODE_TLS_REJECT_UNAUTHORIZED') && !line.includes('disabling certificate verification')).join('\n');
            }
            if (!text.trim()) return;
            if (mainWindow) {
                // 直接发送原始文本以保证控制台字符画二维码排版不受破坏
                mainWindow.webContents.send('gateway-log', text);
                
                // 自动匹配微信扫码登录 URL (支持 weixin.qq.com 各种子路径二级域(如 liteapp/login) 或者是 wechaty.js.org 专属二维码链接)
                const cleanText = text.replace(/\x1B\[[0-9;]*m/g, '');
                const qrMatch = cleanText.match(/https?:\/\/[^\s"'\n]*weixin\.qq\.com\/[^\s"'\n]+/) || 
                                cleanText.match(/https?:\/\/wechaty\.js\.org\/qrcode\/[^\s"'\n]+/);
                if (qrMatch) {
                    mainWindow.webContents.send('gateway-qrcode', qrMatch[0]);
                }
            }
        };

        wechatLoginProcess.stdout.on('data', handleLoginLog);
        wechatLoginProcess.stderr.on('data', handleLoginLog);

        wechatLoginProcess.on('exit', (code) => {
            console.log(`WeChat Login process exited with code ${code}`);
            wechatLoginProcess = null;
        });

        return { success: true };
    } catch (e) {
        console.error('Failed to start WeChat login process:', e);
        return { success: false, error: e.message };
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

        const persistentDir = path.join(CONFIG_DIR, 'persistent_logs');
        const realTokensPath = path.join(persistentDir, 'real_tokens.json');

        if (fs.existsSync(realTokensPath)) {
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

// 获取本地最新的带 token 的网关面板 URL
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

            // 次优先：从本地持久化日志流中扫描是否有最近一次网关启动时输出的免密登录链接
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

// 初始化应用
app.whenReady().then(() => {
    // 🌟 终极家目录矫正与受控安全降级自愈
    try {
        let homePath = app.getPath('home');
        if (homePath) {
            // 物理探测最深处报错的缓存目录是否具备正常的可写权限，以精准捕获云桌面安全锁定
            const testDir = path.join(homePath, '.openclaw', 'agents', 'main', 'sessions', 'skills-prompts');
            const testFile = path.join(testDir, '.write-test-' + Date.now());
            let isWritable = true;
            try {
                if (!fs.existsSync(testDir)) {
                    fs.mkdirSync(testDir, { recursive: true });
                }
                fs.writeFileSync(testFile, 'test-write', 'utf8');
                fs.unlinkSync(testFile);
            } catch (writeErr) {
                isWritable = false;
                console.error(`[System] Deep prompts cache directory is NOT writable: ${writeErr.message}`);
            }

            // 若被云桌面拦截或不可写，强行平滑重定向至操作系统原生临时目录 os.tmpdir()
            if (!isWritable) {
                const tmpDir = require('os').tmpdir();
                console.warn(`[System] Controlled Folder Protection active. Redirecting homedir to tmpdir: ${tmpDir}`);
                homePath = tmpDir;
            }

            console.log(`[System] Final resolved user home: ${homePath}`);
            process.env.USERPROFILE = homePath;
            process.env.HOME = homePath;
            process.env.REAL_USER_HOME = homePath;
            
            // 重新计算相关的全局配置路径
            CONFIG_DIR = path.join(homePath, '.openclaw');
            CONFIG_PATH = path.join(CONFIG_DIR, 'openclaw.json');
        }
    } catch (err) {
        console.error('[System] Failed to resolve true user home:', err.message);
    }

    // 尽早部署插件, 确保首次读配置 / 启动网关前 ~/.openclaw/extensions 已就绪
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
