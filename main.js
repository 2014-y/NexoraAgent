// main.js - Electron 主进程入口
const { app, BrowserWindow, ipcMain, Tray, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

let mainWindow = null;
let tray = null;
let gatewayProcess = null;
let isQuitting = false;

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
        resizable: false,
        maximizable: false,
        transparent: true, // 半透明支持
        icon: path.join(__dirname, 'config', 'icon.jpg'), // 窗口图标
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile('index.html');

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
            // 找到内置的 openclaw 运行入口
            const openclawEntry = require.resolve('openclaw/dist/index.js');
            
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

            // 监听 stdout
            gatewayProcess.stdout.on('data', (data) => {
                const text = data.toString();
                if (mainWindow) {
                    mainWindow.webContents.send('gateway-log', text);
                    
                    // 自动匹配微信扫码登录 URL (含 login.weixin.qq.com/l/)
                    const qrMatch = text.match(/https?:\/\/(?:login\.)?weixin\.qq\.com\/l\/[^\s"']+/);
                    if (qrMatch) {
                        mainWindow.webContents.send('gateway-qrcode', qrMatch[0]);
                    }
                }
            });

            // 监听 stderr
            gatewayProcess.stderr.on('data', (data) => {
                if (mainWindow) mainWindow.webContents.send('gateway-log', data.toString());
            });

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
