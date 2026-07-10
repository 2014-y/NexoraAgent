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
    
    // 开机自启
    getAutoStart: () => ipcRenderer.invoke('autostart-get'),
    setAutoStart: (enabled) => ipcRenderer.invoke('autostart-set', enabled),
    
    // 主进程向渲染进程的数据推送回调
    onLogReceived: (callback) => ipcRenderer.on('gateway-log', (event, data) => callback(data)),
    onStatusChanged: (callback) => ipcRenderer.on('gateway-status', (event, status) => callback(status)),
    onQrCodeReceived: (callback) => ipcRenderer.on('gateway-qrcode', (event, url) => callback(url)),
    onControlTriggered: (callback) => ipcRenderer.on('gateway-control-trigger', (event, action) => callback(action))
});
