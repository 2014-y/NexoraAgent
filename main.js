// main.js - Electron 主进程入口
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

let mainWindow = null;
let tray = null;
let gatewayProcess = null;
let isQuitting = false;
let isMaximizedState = false;
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
        transparent: true, // 半透明支持
        icon: path.join(__dirname, 'config', 'icon.jpg'), // 窗口图标
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('index.html');

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
    tray = new Tray(path.join(__dirname, 'config', 'icon.jpg')); // 使用机器人高级图标
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
    tray.setToolTip('AI小助理 本地助手');
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
        gatewayProcess.kill('SIGTERM');
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
        if (isMaximizedState) {
            mainWindow.unmaximize();
        } else {
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
            const forkOptions = {
                cwd: CONFIG_DIR,
                stdio: ['pipe', 'pipe', 'pipe', 'ipc']
            };
            if (fs.existsSync(nodeExePath)) {
                forkOptions.execPath = nodeExePath;
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
                        require('path').join(__dirname, 'gateway_stdout.log'),
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
                gatewayProcess = null;
                if (mainWindow) {
                    mainWindow.webContents.send('gateway-status', 'stopped');
                    mainWindow.webContents.send('gateway-log', `\n[System] 网关核心进程意外退出，退出码: ${code}\n`);
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
        return JSON.parse(content);
    } catch (e) {
        console.error('Failed to read config:', e);
        return null;
    }
});

ipcMain.handle('config-save', async (event, newConfig) => {
    try {
        // 读取原本的文件尺寸
        const originalBytes = fs.existsSync(CONFIG_PATH) ? fs.statSync(CONFIG_PATH).size : 39500;
        
        let newJson = JSON.stringify(newConfig, null, 2);
        
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

let wechatLoginProcess = null;

// 在后台启动独立的微信扫码登录进程
ipcMain.handle('wechat-login', async () => {
    try {
        if (wechatLoginProcess) {
            try {
                wechatLoginProcess.kill();
            } catch (err) {}
            wechatLoginProcess = null;
        }

        const openclawEntry = path.join(__dirname, 'node_modules', 'openclaw', 'dist', 'index.js');
        const nodeExePath = path.join(__dirname, '.node-sandbox', 'node.exe');
        const forkOptions = {
            cwd: CONFIG_DIR,
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        };
        if (fs.existsSync(nodeExePath)) {
            forkOptions.execPath = nodeExePath;
        }

        // 启动 login 指令进程以触发扫码
        wechatLoginProcess = fork(openclawEntry, ['channels', 'login', '--channel', 'openclaw-weixin'], forkOptions);

        const handleLoginLog = (data) => {
            const text = data.toString();
            if (mainWindow) {
                // 直接发送原始文本以保证控制台字符画二维码排版不受破坏
                mainWindow.webContents.send('gateway-log', text);
                
                // 自动匹配微信扫码登录 URL (支持 weixin.qq.com 各种子路径二级域(如 liteapp/login) 或者是 wechaty.js.org 专属二维码链接)
                const qrMatch = text.match(/https?:\/\/[^\s"'\n]*weixin\.qq\.com\/[^\s"'\n]+/) || 
                                text.match(/https?:\/\/wechaty\.js\.org\/qrcode\/[^\s"'\n]+/);
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

// 读取本地真实大模型调用统计
ipcMain.handle('stats-get', async () => {
    return new Promise((resolve) => {
        const statsPyPath = path.join(__dirname, 'inspect_stats.py');
        const { exec } = require('child_process');
        
        exec(`python "${statsPyPath}"`, { encoding: 'utf8' }, (error, stdout, stderr) => {
            if (error) {
                console.error('Failed to execute inspect_stats.py:', error, stderr);
                resolve({ success: false, error: error.message });
                return;
            }
            try {
                const data = JSON.parse(stdout);
                resolve({ success: true, data });
            } catch (err) {
                console.error('Failed to parse stats JSON:', err, stdout);
                resolve({ success: false, error: 'JSON解析错误' });
            }
        });
    });
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
                const logPath = path.join(__dirname, 'gateway_stdout.log');
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
                    openclawEntry = "C:\\Users\\Yuan\\AppData\\Roaming\\nvm\\v24.13.0\\node_modules\\openclaw\\dist\\index.js";
                }
            }

            return new Promise((resolve) => {
                const child = fork(openclawEntry, ['dashboard', '--no-open'], {
                    stdio: 'pipe',
                    env: {
                        ...process.env,
                        PATH: "C:\\Users\\Yuan\\AppData\\Roaming\\nvm\\v24.13.0;" + process.env.PATH
                    }
                });

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
