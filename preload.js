// preload.js - Electron 安全桥接器
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // 窗口控制
    windowAction: (action) => ipcRenderer.send('window-action', action),
    
    // 网关控制
    gatewayAction: (action) => ipcRenderer.send('gateway-action', action),
    /** 渠道绑定/改配后热重载网关；opts.startIfStopped=true 时未运行也会拉起 */
    reloadGatewayForChannel: (reason, opts) => ipcRenderer.invoke('gateway-reload-for-channel', {
        reason: reason || 'channel-change',
        startIfStopped: !!(opts && opts.startIfStopped)
    }),
    onChannelGatewayReloading: (callback) => ipcRenderer.on('channel-gateway-reloading', (event, data) => callback(data)),
    
    // 配置读写
    readConfig: () => ipcRenderer.invoke('config-read'),
    saveConfig: (newConfig) => ipcRenderer.invoke('config-save', newConfig),
    readRoleConfig: () => ipcRenderer.invoke('role-config-read'),
    saveRoleConfig: (payload) => ipcRenderer.invoke('role-config-save', payload),
    onRoleConfigUpdated: (callback) => {
        const listener = (event, data) => callback(data);
        ipcRenderer.on('role-config-updated', listener);
        return () => ipcRenderer.removeListener('role-config-updated', listener);
    },
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
    appendStatsData: (logEntry) => ipcRenderer.invoke('stats-append', logEntry),
    probePlugins: () => ipcRenderer.invoke('plugins-probe'),
    probePlugin: (pluginId) => ipcRenderer.invoke('plugin-probe', pluginId),
    savePluginCredentials: (payload) => ipcRenderer.invoke('plugin-save-credentials', payload),
    promptPluginCredentials: (pluginId) => ipcRenderer.invoke('plugin-prompt-credentials', pluginId),
    
    // 开机自启
    getAutoStart: () => ipcRenderer.invoke('autostart-get'),
    setAutoStart: (enabled) => ipcRenderer.invoke('autostart-set', enabled),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    getAccelerationStatus: () => ipcRenderer.invoke('acceleration-status'),
    getAppInstanceInfo: () => ipcRenderer.invoke('app-instance-info'),
    getAccelerationConnections: () => ipcRenderer.invoke('acceleration-get-connections'),
    closeAccelerationConnection: (id) => ipcRenderer.invoke('acceleration-close-connection', id),
    setAccelerationEnabled: (enabled, profileId) => ipcRenderer.invoke('acceleration-set-enabled', enabled, profileId),
    ensureAccelerationCore: () => ipcRenderer.invoke('acceleration-ensure-core'),
    addAccelerationUrl: (url, name) => ipcRenderer.invoke('acceleration-add-url', url, name),
    addAccelerationFile: (filePath, name) => ipcRenderer.invoke('acceleration-add-file', filePath, name),
    addAccelerationContent: (content, name) => ipcRenderer.invoke('acceleration-add-content', content, name),
    pickAccelerationFile: () => ipcRenderer.invoke('acceleration-pick-file'),
    removeAccelerationProfile: (id) => ipcRenderer.invoke('acceleration-remove-profile', id),
    renameAccelerationProfile: (id, name) => ipcRenderer.invoke('acceleration-rename-profile', id, name),
    updateAccelerationProfile: (id) => ipcRenderer.invoke('acceleration-update-profile', id),
    selectAccelerationProxy: (payload) => ipcRenderer.invoke('acceleration-select-proxy', payload),
    delayTestAcceleration: (names) => ipcRenderer.invoke('acceleration-delay-test', names),
    detectAccelerationIp: () => ipcRenderer.invoke('acceleration-detect-ip'),
    setAccelerationOptions: (options) => ipcRenderer.invoke('acceleration-set-options', options),
    setAccelerationActiveProfile: (id) => ipcRenderer.invoke('acceleration-set-active-profile', id),
    onAccelerationCoreProgress: (callback) => ipcRenderer.on('acceleration-core-progress', (event, data) => callback(data)),
    onAccelerationDelayProgress: (callback) => {
        const listener = (event, data) => callback(data);
        ipcRenderer.on('acceleration-delay-progress', listener);
        return () => ipcRenderer.removeListener('acceleration-delay-progress', listener);
    },
    getDashboardUrl: () => ipcRenderer.invoke('get-dashboard-url'),
    clearOpenclawPanelSession: () => ipcRenderer.invoke('clear-openclaw-panel-session'),
    onDashboardUrlUpdated: (callback) => ipcRenderer.on('dashboard-url-updated', (event, url) => callback(url)),
    
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
    onGatewayHttpReady: (callback) => ipcRenderer.on('gateway-http-ready', (event, data) => callback(data)),
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
    },

    // 本地离线语音
    voice: {
        getState: () => ipcRenderer.invoke('voice-get-state'),
        setSettings: (patch) => ipcRenderer.invoke('voice-set-settings', patch),
        speak: (payload) => ipcRenderer.invoke('voice-speak', payload),
        stop: () => ipcRenderer.invoke('voice-stop'),
        downloadPack: (packId) => ipcRenderer.invoke('voice-download-pack', packId),
        importCustomPack: () => ipcRenderer.invoke('voice-import-custom'),
        deleteCustomPack: (packId) => ipcRenderer.invoke('voice-delete-custom', packId),
        bindRole: (payload) => ipcRenderer.invoke('voice-bind-role', payload),
        setListenStatus: (status) => ipcRenderer.invoke('voice-set-listen-status', status),
        onStatus: (callback) => {
            const listener = (event, data) => callback(data);
            ipcRenderer.on('voice-status', listener);
            return () => ipcRenderer.removeListener('voice-status', listener);
        },
        onSettingsUpdated: (callback) => {
            const listener = (event, data) => callback(data);
            ipcRenderer.on('voice-settings-updated', listener);
            return () => ipcRenderer.removeListener('voice-settings-updated', listener);
        },
        onDownloadProgress: (callback) => {
            const listener = (event, data) => callback(data);
            ipcRenderer.on('voice-download-progress', listener);
            return () => ipcRenderer.removeListener('voice-download-progress', listener);
        },
        onSpeakError: (callback) => {
            const listener = (event, data) => callback(data);
            ipcRenderer.on('voice-speak-error', listener);
            return () => ipcRenderer.removeListener('voice-speak-error', listener);
        }
    }
});
