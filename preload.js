// preload.js - Electron 安全桥接器
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // 窗口控制
    windowAction: (action) => ipcRenderer.send('window-action', action),
    
    // 网关控制
    gatewayAction: (action) => ipcRenderer.send('gateway-action', action),
    
    // 配置读写
    readConfig: () => ipcRenderer.invoke('config-read'),
    saveConfig: (newConfig) => ipcRenderer.invoke('config-save', newConfig),
    clearWeChatSession: () => ipcRenderer.invoke('wechat-clear'),
    checkWeChatStatus: () => ipcRenderer.invoke('wechat-check-status'),
    triggerWeChatLogin: () => ipcRenderer.invoke('wechat-login'),
    cancelWeChatLogin: () => ipcRenderer.invoke('wechat-login-cancel'),
    triggerFeishuQrLogin: (opts) => ipcRenderer.invoke('feishu-qr-login', opts || {}),
    cancelFeishuQrLogin: () => ipcRenderer.invoke('feishu-qr-login-cancel'),
    /** 通用内置扫码插件 login：传 pluginId 或 { pluginId, openclawChannel, label } */
    triggerChannelLogin: (opts) => ipcRenderer.invoke('channel-login-start', opts),
    cancelChannelLogin: (pluginId) => ipcRenderer.invoke('channel-login-cancel', pluginId),
    cancelAllChannelLogins: () => ipcRenderer.invoke('channel-login-cancel-all'),
    readSystemLogs: () => ipcRenderer.invoke('read-system-logs'),
    clearSystemLogs: () => ipcRenderer.invoke('clear-system-logs'),
    getStatsData: () => ipcRenderer.invoke('stats-get'),
    probePlugins: () => ipcRenderer.invoke('plugins-probe'),
    probePlugin: (pluginId) => ipcRenderer.invoke('plugin-probe', pluginId),
    savePluginCredentials: (payload) => ipcRenderer.invoke('plugin-save-credentials', payload),
    promptPluginCredentials: (pluginId) => ipcRenderer.invoke('plugin-prompt-credentials', pluginId),
    
    // 开机自启
    getAutoStart: () => ipcRenderer.invoke('autostart-get'),
    setAutoStart: (enabled) => ipcRenderer.invoke('autostart-set', enabled),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    getDashboardUrl: () => ipcRenderer.invoke('get-dashboard-url'),
    
    // 软件更新相关接口
    checkUpdate: (isManual) => ipcRenderer.invoke('check-update', isManual),
    startDownloadUpdate: (downloadUrl, fileName) => ipcRenderer.invoke('start-download-update', { downloadUrl, fileName }),
    installUpdate: (savePath) => ipcRenderer.invoke('install-update', savePath),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (event, progress) => callback(progress)),
    
    // 内置网关核心包热更新
    updateOpenclawPackage: (opts) => ipcRenderer.invoke('update-openclaw-package', opts || {}),
    onGatewayUpdateProgress: (callback) => ipcRenderer.on('gateway-update-progress', (event, data) => callback(data)),
    onSandboxUpdateProgress: (callback) => ipcRenderer.on('sandbox-upgrade-progress', (event, data) => callback(data)),
    
    // 主进程向渲染进程的数据推送回调
    onLogReceived: (callback) => ipcRenderer.on('gateway-log', (event, data) => callback(data)),
    onStatusChanged: (callback) => ipcRenderer.on('gateway-status', (event, status) => callback(status)),
    onQrCodeReceived: (callback) => ipcRenderer.on('gateway-qrcode', (event, payload) => callback(payload)),
    onWeChatLoginSuccess: (callback) => ipcRenderer.on('wechat-login-success', (event, status) => callback(status)),
    onWeChatLoginFailed: (callback) => ipcRenderer.on('wechat-login-failed', (event, status) => callback(status)),
    onFeishuLoginSuccess: (callback) => ipcRenderer.on('feishu-login-success', (event, status) => callback(status)),
    onFeishuLoginFailed: (callback) => ipcRenderer.on('feishu-login-failed', (event, status) => callback(status)),
    onChannelLoginSuccess: (callback) => ipcRenderer.on('channel-login-success', (event, status) => callback(status)),
    onChannelLoginFailed: (callback) => ipcRenderer.on('channel-login-failed', (event, status) => callback(status)),
    onControlTriggered: (callback) => ipcRenderer.on('gateway-control-trigger', (event, action) => callback(action)),
    onMaximizedStatus: (callback) => ipcRenderer.on('window-maximized-status', (event, isMaximized) => callback(isMaximized)),
    getAppStartTime: () => ipcRenderer.invoke('get-app-start-time'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    openSandboxTerminal: () => ipcRenderer.send('open-sandbox-terminal'),

    // 内置沙箱终端交互
    startBuiltinTerminal: (lang) => ipcRenderer.invoke('builtin-terminal-start', lang),
    resizeBuiltinTerminal: (cols, rows) => ipcRenderer.send('builtin-terminal-resize', { cols, rows }),
    writeBuiltinTerminal: (data) => ipcRenderer.send('builtin-terminal-write', data),
    onBuiltinTerminalData: (callback) => {
        ipcRenderer.on('builtin-terminal-data', (event, data) => callback(data));
    }
});
