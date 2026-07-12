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

let mainWindow = null;
let tray = null;
let gatewayProcess = null;
let isQuitting = false;
let isMaximizedState = false;
let normalBounds = null;
const appStartTime = Date.now();
global.latestAcpDashboardUrl = '';

const CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.openclaw');
const CONFIG_PATH = path.join(CONFIG_DIR, 'openclaw.json');

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
    mainWindow = new BrowserWindow({
        width: 1120,
        height: 760,
        frame: false, // 无边框窗口
        resizable: true, // 允许用户自定义拖拽放大缩小窗口
        maximizable: true, // 允许最大化
        show: false, // 默认隐藏，在 ready-to-show 时一次性优雅展出，防止启动黑屏闪烁
        backgroundColor: '#0d0b18', // 曜石黑暗色底底色，平滑窗口拉起首屏加载
        icon: path.join(__dirname, 'config', 'icon.png'), // 窗口图标
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

    const resolvedPath = path.resolve(__dirname, 'index.html');

    mainWindow.loadFile('index.html');

    // 🌟 在 Chromium 首屏完全解析并绘制就绪后才弹出，实现 100% 无黑屏白屏瞬间秒开！
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

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
                    try {
                        execSync(`taskkill /pid ${pid} /F /T`);
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
            // 优先通过物理路径直接定位（完美避开打包后 Node.js 模块 exports 对子路径文件的加载限制）
            let openclawEntry = path.join(__dirname, 'node_modules', 'openclaw', 'dist', 'index.js');
            if (!fs.existsSync(openclawEntry)) {
                openclawEntry = require.resolve('openclaw/dist/index.js');
            }
            
            // 强制使用打包内置的原生独立 Node 运行时（实现 100% 闭环，免装全局 Node 依赖）
            const nodeExePath = path.join(__dirname, '.node-sandbox', 'node.exe');
            const patchPath = path.join(__dirname, 'patch_gateway.js');
            const forkOptions = {
                cwd: CONFIG_DIR,
                stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
                execArgv: ['--require', patchPath, '--no-warnings', '--dns-result-order=ipv4first'],
                env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } // 拷贝当前环境变量以便注入沙箱路径
            };
            if (fs.existsSync(nodeExePath)) {
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
                const text = data.toString();
                
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
        
        Object.keys(config.plugins.entries).forEach(pluginName => {
            if (config.plugins.entries[pluginName].enabled === true) {
                if (!config.plugins.allow.includes(pluginName)) {
                    config.plugins.allow.push(pluginName);
                    needsSave = true;
                }
            }
        });

        // 自动注入微信插件加载路径，解决新电脑或免安装运行时找不到插件导致提示“Install Weixin plugin?”的问题
        if (!config.plugins.load) { config.plugins.load = {}; needsSave = true; }
        if (!config.plugins.load.paths) { config.plugins.load.paths = []; needsSave = true; }
        
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
        const nodeExePath = path.join(__dirname, '.node-sandbox', 'node.exe');
        const patchPath = path.join(__dirname, 'patch_gateway.js');
        const forkOptions = {
            cwd: CONFIG_DIR,
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            execArgv: ['--require', patchPath, '--no-warnings', '--dns-result-order=ipv4first'],
            env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
        };
        if (fs.existsSync(nodeExePath)) {
            forkOptions.execPath = nodeExePath;
            const sandboxDir = path.dirname(nodeExePath);
            const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
            const originalPath = process.env[pathKey] || '';
            forkOptions.env[pathKey] = `${sandboxDir}${path.delimiter}${originalPath}`;
        }

        // 启动 login 指令进程以触发扫码
        wechatLoginProcess = fork(openclawEntry, ['channels', 'login', '--channel', 'openclaw-weixin'], forkOptions);

        const handleLoginLog = (data) => {
            const text = data.toString();
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
        
        // 按时间戳降序排列，取最近 50 条
        stats.logs.sort((a, b) => b.timestamp - a.timestamp);
        stats.logs = stats.logs.slice(0, 50);

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
                const nodeExePath = path.join(__dirname, '.node-sandbox', 'node.exe');
                const forkOptions = {
                    stdio: 'pipe',
                    execArgv: ['--no-warnings', '--dns-result-order=ipv4first'],
                    env: {
                        ...process.env,
                        NODE_TLS_REJECT_UNAUTHORIZED: '0'
                    }
                };
                if (fs.existsSync(nodeExePath)) {
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

// 辅助函数：发起 HTTPS GET 请求获取 JSON 数据
function httpsGetJson(url) {
    const https = require('https');
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/vnd.github.v3+json'
            },
            timeout: 10000 // 10秒超时
        };
        https.get(url, options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                // 处理重定向
                httpsGetJson(res.headers.location).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`请求失败，状态码: ${res.statusCode}`));
                return;
            }
            let rawData = '';
            res.on('data', (chunk) => { rawData += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(rawData);
                    resolve(parsedData);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}

// 辅助函数：版本号比对 (latest > current)
function isNewerVersion(latest, current) {
    const lParts = latest.split('.').map(Number);
    const cParts = current.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const lVal = isNaN(lParts[i]) ? 0 : lParts[i];
        const cVal = isNaN(cParts[i]) ? 0 : cParts[i];
        if (lVal > cVal) return true;
        if (lVal < cVal) return false;
    }
    return false;
}

// 辅助函数：通过 HEAD 请求 latest 页面获取重定向的真实 tag_name
function getLatestVersionFromRedirect(url) {
    const https = require('https');
    const urlModule = require('url');
    return new Promise((resolve, reject) => {
        const parsedUrl = urlModule.parse(url);
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.path,
            method: 'HEAD',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 8000
        };
        const req = https.request(options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                const location = res.headers.location;
                // 从重定向的 URL (如 /releases/tag/v1) 里匹配 tag_name
                const match = location.match(/\/releases\/tag\/(v?[0-9a-zA-Z.-]+)/);
                if (match) {
                    resolve(match[1]);
                } else {
                    reject(new Error('未在重定向目标中找到版本号'));
                }
            } else {
                reject(new Error(`请求未发生重定向，状态码: ${res.statusCode}`));
            }
        });
        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('请求超时'));
        });
        req.end();
    });
}

// 1. 检查更新
ipcMain.handle('check-update', async (event, isManual) => {
    const currentVersion = app.getVersion();
    const repoUrl = 'https://api.github.com/repos/2014-y/ClawAI/releases/latest';
    const redirectUrl = 'https://github.com/2014-y/ClawAI/releases/latest';
    
    let latestVersion = '';
    let hasUpdate = false;
    let data = null;
    let errorMsg = '';
    let redirectTag = '';
    
    // 优先尝试请求 API
    try {
        data = await httpsGetJson(repoUrl);
        latestVersion = data.tag_name.replace(/^v/, '');
        hasUpdate = isNewerVersion(latestVersion, currentVersion);
    } catch (err) {
        console.error('API 检查更新出错，尝试通过网页重定向获取版本号:', err.message);
        errorMsg = err.message;
        
        // API 失败，进入备选的 HEAD 重定向方案
        try {
            redirectTag = await getLatestVersionFromRedirect(redirectUrl);
            latestVersion = redirectTag.replace(/^v/, '');
            hasUpdate = isNewerVersion(latestVersion, currentVersion);
        } catch (redirectErr) {
            console.error('重定向方式获取版本号也失败:', redirectErr.message);
        }
    }
    
    // 如果我们成功拿到了最新版本号
    if (latestVersion) {
        let downloadUrl = '';
        let fileName = '';
        let releaseNotes = '';
        
        if (data) {
            // API 请求成功的情况
            releaseNotes = data.body || '';
            if (data.assets && Array.isArray(data.assets)) {
                const exeAsset = data.assets.find(asset => asset.name.endsWith('.exe'));
                if (exeAsset) {
                    downloadUrl = exeAsset.browser_download_url;
                    fileName = exeAsset.name;
                }
            }
            if (!downloadUrl) {
                downloadUrl = data.html_url;
            }
        } else {
            // API 请求失败，但是重定向成功拿到版本号的情况
            releaseNotes = `由于网络限制（GitHub API 访问受限），未能加载详细的更新日志。\n\n你可以尝试点击【立即升级】进行软件内自动升级，或在浏览器中打开主页手动下载安装包。\n\n错误信息：${errorMsg}`;
            // 构造默认的下载文件名与地址 (使用点号命名以匹配 GitHub 线上附件格式)
            fileName = `ClawAI.Setup.${latestVersion}.exe`;
            const tag = redirectTag || `v${latestVersion}`;
            downloadUrl = `https://github.com/2014-y/ClawAI/releases/download/${tag}/${fileName}`;
        }
        
        return {
            hasUpdate,
            latestVersion,
            currentVersion,
            releaseNotes,
            downloadUrl,
            fileName
        };
    }
    
    // 如果两种方案都彻底失败了，进入终极备选
    if (!isManual) {
        throw new Error('后台自动检查更新失败：网络受限');
    }
    
    return {
        hasUpdate: true,
        latestVersion: '未知',
        currentVersion,
        releaseNotes: '由于 GitHub 接口访问受限（如 IP 请求次数超限或网络无法直连），且重定向检测也失败，无法自动下载安装包。\n\n建议点击下方按钮，直接在您的浏览器中打开项目主页进行手动下载与升级。',
        downloadUrl: 'https://github.com/2014-y/ClawAI/releases',
        fileName: ''
    };
});

// 2. 开始下载更新
ipcMain.handle('start-download-update', async (event, { downloadUrl, fileName }) => {
    const https = require('https');
    const fs = require('fs');
    const path = require('path');
    
    if (!downloadUrl) return { success: false, message: '无效的下载链接' };
    
    // 使用国内最新稳定镜像加速下载
    let finalUrl = downloadUrl;
    if (downloadUrl.startsWith('https://github.com')) {
        finalUrl = 'https://ghproxy.net/' + downloadUrl;
    }
    
    const tempDir = app.getPath('temp');
    const savePath = path.join(tempDir, fileName || 'ClawAI-Setup-Latest.exe');
    
    if (fs.existsSync(savePath)) {
        try {
            fs.unlinkSync(savePath);
        } catch (e) {}
    }
    
    return new Promise((resolve) => {
        let currentFileStream = fs.createWriteStream(savePath);
        let receivedBytes = 0;
        let totalBytes = 0;
        let hasRetried = false;
        
        function download(url, fileStream) {
            const options = {
                headers: {
                    'User-Agent': 'ClawAI-Updater'
                },
                timeout: 30000 // 30秒超时
            };
            
            const req = https.get(url, options, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    let redirectUrl = res.headers.location;
                    if (redirectUrl.startsWith('https://github.com')) {
                        redirectUrl = 'https://ghproxy.net/' + redirectUrl;
                    }
                    download(redirectUrl, fileStream);
                    return;
                }
                
                if (res.statusCode !== 200) {
                    if (!hasRetried && url.includes('ghproxy.net')) {
                        hasRetried = true;
                        try {
                            fileStream.close();
                            fs.unlinkSync(savePath);
                        } catch(e) {}
                        const newFileStream = fs.createWriteStream(savePath);
                        receivedBytes = 0;
                        download(downloadUrl, newFileStream);
                        return;
                    }
                    fileStream.close();
                    resolve({ success: false, message: `下载失败，状态码: ${res.statusCode}` });
                    return;
                }
                
                totalBytes = parseInt(res.headers['content-length'], 10) || 0;
                
                res.on('data', (chunk) => {
                    receivedBytes += chunk.length;
                    fileStream.write(chunk);
                    
                    if (totalBytes > 0) {
                        const progress = Math.round((receivedBytes / totalBytes) * 100);
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('download-progress', progress);
                        }
                    }
                });
                
                res.on('end', () => {
                    fileStream.end();
                    resolve({ success: true, savePath });
                });
                
                res.on('error', (err) => {
                    if (!hasRetried && url.includes('ghproxy.net')) {
                        hasRetried = true;
                        try {
                            fileStream.close();
                            fs.unlinkSync(savePath);
                        } catch(e) {}
                        const newFileStream = fs.createWriteStream(savePath);
                        receivedBytes = 0;
                        download(downloadUrl, newFileStream);
                        return;
                    }
                    fileStream.close();
                    resolve({ success: false, message: `下载数据流出错: ${err.message}` });
                });
            });
            
            req.on('error', (err) => {
                if (!hasRetried && url.includes('ghproxy.net')) {
                    hasRetried = true;
                    try {
                        fileStream.close();
                        fs.unlinkSync(savePath);
                    } catch(e) {}
                    const newFileStream = fs.createWriteStream(savePath);
                    receivedBytes = 0;
                    download(downloadUrl, newFileStream);
                    return;
                }
                fileStream.close();
                resolve({ success: false, message: `请求出错: ${err.message}` });
            });
            
            req.on('timeout', () => {
                req.destroy();
                if (!hasRetried && url.includes('ghproxy.net')) {
                    hasRetried = true;
                    try {
                        fileStream.close();
                        fs.unlinkSync(savePath);
                    } catch(e) {}
                    const newFileStream = fs.createWriteStream(savePath);
                    receivedBytes = 0;
                    download(downloadUrl, newFileStream);
                    return;
                }
                fileStream.close();
                resolve({ success: false, message: '下载请求超时' });
            });
        }
        
        download(finalUrl, currentFileStream);
    });
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
