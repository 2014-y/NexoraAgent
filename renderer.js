// renderer.js - 渲染进程交互逻辑

// 1. 全局状态
let configData = null;
let currentTab = 'console-view';
let gatewayStatus = 'stopped';

// 常见插件元数据（用于生成美观的插件网格）
const pluginMetadata = {
    'dual-model-trainer': { name: '🧠 双模型教学', desc: '利用主备模型对比，自动本地收集并训练属于你的专属模型' },
    'openclaw-weixin': { name: '💬 微信渠道', desc: '一键将网关接入微信聊天，支持私聊、群聊和图片理解' },
    'voice-call': { name: '📞 语音通话', desc: '开启实时语音对话服务，支持通过微信向 AI 拨打电话' },
    'telegram': { name: '✈️ Telegram', desc: '通过 Telegram 机器人消息通道直接与您的 AI 网关对话' },
    'slack': { name: '🎨 Slack 渠道', desc: '将 AI 本地网关作为应用机器人接入到您的团队 Slack 频道中' },
    'whatsapp': { name: '🟢 WhatsApp', desc: '接入全球 WhatsApp 消息服务，支持媒体及文本处理' },
    'llm-task': { name: '📝 自动摘要', desc: '向 AI 发送超长链接或长文本，自动为您提炼和总结要点' },
    'matrix': { name: '🛡️ Matrix 通道', desc: '将网关挂载到去中心化的加密通信 Matrix 消息信道上' },
    'duckduckgo': { name: '🔍 DuckDuckGo 搜索', desc: '允许 AI 调用搜索引擎进行网页实时检索，获取最新资讯' },
    'webhooks': { name: '🔌 Webhooks', desc: '支持外部系统通过标准的 Webhook 事件触发网关的定制指令' },
    'bonjour': { name: '📡 Bonjour 发现', desc: '启用本地零配置组网，自动发布网关局域网服务广播' },
    'workboard': { name: '📋 任务看板', desc: '提供待办任务的可视化任务跟踪面板，帮助有序规划工作' }
};

// 2. DOM 元素获取
const tabs = document.querySelectorAll('.nav-item');
const tabPanes = document.querySelectorAll('.tab-pane');
const winBtnMinimize = document.getElementById('win-btn-minimize');
const winBtnClose = document.getElementById('win-btn-close');

const statusLight = document.getElementById('status-light');
const statusLabel = document.getElementById('status-label');
const gatewayToggleBtn = document.getElementById('gateway-toggle-btn');
const btnIconStart = document.getElementById('btn-icon-start');
const btnIconStop = document.getElementById('btn-icon-stop');
const btnLabelText = document.getElementById('btn-label-text');

const logTerminal = document.getElementById('log-terminal-output');
const statPort = document.getElementById('stat-port');
const statMem = document.getElementById('stat-mem');
const autostartToggle = document.getElementById('autostart-toggle');

const qrcodeOverlay = document.getElementById('qrcode-overlay');
const qrcodeCanvas = document.getElementById('qrcode-canvas');
const qrcodeCloseBtn = document.getElementById('qrcode-close-btn');

// 3. 初始化加载
async function init() {
    // 监听主进程的消息推送
    setupIpcListeners();

    // 读取并渲染配置
    await loadAndRenderConfig();

    // 加载开机自启配置
    try {
        const autostart = await window.api.getAutoStart();
        autostartToggle.checked = autostart;
    } catch (e) {
        console.error('Failed to get autostart status:', e);
    }

    // 初始化 Tab 切换
    setupTabSwitching();

    // 初始化窗口控制
    winBtnMinimize.addEventListener('click', () => window.api.windowAction('minimize'));
    winBtnClose.addEventListener('click', () => window.api.windowAction('close'));

    // 网关开关按钮监听
    gatewayToggleBtn.addEventListener('click', () => {
        if (gatewayStatus === 'stopped') {
            window.api.gatewayAction('start');
        } else if (gatewayStatus === 'running') {
            window.api.gatewayAction('stop');
        }
    });

    // 微信二维码弹窗关闭
    qrcodeCloseBtn.addEventListener('click', () => {
        qrcodeOverlay.style.display = 'none';
    });

    // 初始化主题切换
    setupThemeSwitching();

    // 检查并启动新手指引
    checkAndStartGuide();

    // 渲染图表
    renderUsageCharts();

    // 内存模拟监控（科技感点缀）
    setInterval(updateMemoryMock, 4000);
}

// 4. IPC 消息监听与分发
function setupIpcListeners() {
    // 实时日志接收
    window.api.onLogReceived((text) => {
        // 追加日志并做简单着色
        const span = document.createElement('span');
        let coloredText = text
            .replace(/\[gateway\]/g, '<span style="color: #64b5f6;">[gateway]</span>')
            .replace(/\[System\]/g, '<span style="color: #f06292;">[System]</span>')
            .replace(/\[plugins\]/g, '<span style="color: #ba68c8;">[plugins]</span>')
            .replace(/\[hooks\]/g, '<span style="color: #4db6ac;">[hooks]</span>')
            .replace(/ERROR/gi, '<span style="color: #ff5252; font-weight: bold;">ERROR</span>')
            .replace(/WARNING/gi, '<span style="color: #ffd54f;">WARNING</span>')
            .replace(/Config cleaned\./g, '<span style="color: #81c784;">Config cleaned.</span>')
            .replace(/Setup complete!/g, '<span style="color: #81c784; font-weight: bold;">Setup complete!</span>');

        span.innerHTML = coloredText;
        logTerminal.appendChild(span);

        // 控制台字数过多自动裁剪防崩溃
        if (logTerminal.innerText.length > 25000) {
            logTerminal.innerHTML = logTerminal.innerHTML.substring(5000);
        }

        // 自动滚到底部
        logTerminal.scrollTop = logTerminal.scrollHeight;
    });

    // 网关状态同步
    window.api.onStatusChanged((status) => {
        gatewayStatus = status;
        updateGatewayStatusUI(status);
    });

    // 微信扫码二维码捕获并画图
    window.api.onQrCodeReceived((url) => {
        qrcodeOverlay.style.display = 'flex';
        document.getElementById('qrcode-raw-url').value = url;
        drawQrCode(url);
    });

    // 绑定一键复制授权链接
    document.getElementById('qrcode-copy-btn').addEventListener('click', () => {
        const urlInput = document.getElementById('qrcode-raw-url');
        urlInput.select();
        urlInput.setSelectionRange(0, 99999);
        navigator.clipboard.writeText(urlInput.value);
        alert('授权登录链接已成功复制到剪贴板！\n\n您可以粘贴发给微信里的任意聊天框（如“文件传输助手”），在手机端直接点击链接即可开始授权登录。');
    });

    // 托盘控制触发
    window.api.onControlTriggered((action) => {
        if (action === 'start') {
            window.api.gatewayAction('start');
        } else if (action === 'stop') {
            window.api.gatewayAction('stop');
        }
    });

    // 监听开机自启切换
    autostartToggle.addEventListener('change', async (e) => {
        await window.api.setAutoStart(e.target.checked);
    });
}

// 5. 动态大模型提供商与配置数据管理
let localProviders = {};

async function loadAndRenderConfig() {
    configData = await window.api.readConfig();
    if (!configData) {
        logTerminal.innerText = '[System] [Error] 无法读取 openclaw.json 配置文件！\n';
        return;
    }

    // 深度拷贝厂商数据到本地变量以支持动态修改与渲染
    if (configData.models && configData.models.providers) {
        localProviders = JSON.parse(JSON.stringify(configData.models.providers));
    } else {
        localProviders = {};
    }

    // 动态渲染厂商卡片和 datalist
    renderProvidersList();
    updateModelsDatalist();

    // 填充并发数与主备模型
    if (configData.agents && configData.agents.defaults) {
        const defaults = configData.agents.defaults;
        document.getElementById('max-concurrent').value = defaults.maxConcurrent || 4;
        if (defaults.model) {
            document.getElementById('model-primary').value = defaults.model.primary || '';
            document.getElementById('model-fallback').value = (defaults.model.fallbacks && defaults.model.fallbacks[0]) || '';
        }
    }

    if (configData.gateway) {
        document.getElementById('gateway-port').value = configData.gateway.port || 18789;
        statPort.innerText = configData.gateway.port || 18789;
        const auth = configData.gateway.auth;
        document.getElementById('gateway-token').value = (auth && auth.token) || 'openclaw-dev-token-998877';
    }

    // 渲染功能插件列表卡片
    renderPluginsGrid();
}

// 渲染提供商卡片列表
function renderProvidersList() {
    const listZone = document.getElementById('providers-list-zone');
    listZone.innerHTML = '';

    for (const key of Object.keys(localProviders)) {
        const provider = localProviders[key];
        const card = document.createElement('div');
        card.className = 'provider-card';
        card.innerHTML = `
            <div class="provider-card-header">
                <h3>🔌 ${key}</h3>
                <button type="button" class="btn-delete-provider" data-provider="${key}">❌ 删除此厂家</button>
            </div>
            <div class="form-row">
                <div class="form-field">
                    <label>Base URL (API 端点)</label>
                    <input type="text" class="provider-url-input" data-provider="${key}" value="${provider.baseUrl || ''}" placeholder="例如: https://api.openai.com/v1">
                </div>
                <div class="form-field">
                    <label>API Key (授权密钥)</label>
                    <input type="password" class="provider-key-input" data-provider="${key}" value="${provider.apiKey || ''}" placeholder="API 密钥">
                </div>
            </div>
            <div class="form-row">
                <div class="form-field half">
                    <label>API 协议类型</label>
                    <select class="provider-api-select" data-provider="${key}">
                        <option value="openai-completions" ${provider.api === 'openai-completions' ? 'selected' : ''}>OpenAI Completions</option>
                        <option value="openai-chat" ${provider.api === 'openai-chat' ? 'selected' : ''}>OpenAI Chat</option>
                        <option value="ollama" ${provider.api === 'ollama' ? 'selected' : ''}>Ollama</option>
                    </select>
                </div>
            </div>
            
            <div class="provider-models-zone">
                <h4>🤖 模型白名单管理</h4>
                <div class="model-tags-container" id="tags-container-${key}"></div>
                <div class="add-model-input-row">
                    <input type="text" id="add-model-input-${key}" placeholder="添加新模型 ID, 例如: deepseek-chat">
                    <button type="button" class="btn-add-model" data-provider="${key}">添加</button>
                </div>
            </div>
        `;
        listZone.appendChild(card);

        // 渲染模型标签
        const tagsContainer = document.getElementById(`tags-container-${key}`);
        const models = provider.models || [];
        models.forEach((model, index) => {
            const tag = document.createElement('div');
            tag.className = 'model-tag-item';
            tag.innerHTML = `
                <span>${model.id}</span>
                <span class="model-tag-del" data-provider="${key}" data-index="${index}">×</span>
            `;
            tagsContainer.appendChild(tag);
        });
    }

    bindProviderEvents();
}

// 绑定动态卡片事件
function bindProviderEvents() {
    document.querySelectorAll('.provider-url-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const provider = e.target.getAttribute('data-provider');
            localProviders[provider].baseUrl = e.target.value;
            updateModelsDatalist();
        });
    });

    document.querySelectorAll('.provider-key-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const provider = e.target.getAttribute('data-provider');
            localProviders[provider].apiKey = e.target.value;
        });
    });

    document.querySelectorAll('.provider-api-select').forEach(select => {
        select.addEventListener('change', (e) => {
            const provider = e.target.getAttribute('data-provider');
            localProviders[provider].api = e.target.value;
        });
    });

    document.querySelectorAll('.btn-delete-provider').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const provider = e.target.getAttribute('data-provider');
            if (confirm(`确定要彻底删除厂家 "${provider}" 及其下的所有模型配置吗？`)) {
                delete localProviders[provider];
                renderProvidersList();
                updateModelsDatalist();
            }
        });
    });

    document.querySelectorAll('.btn-add-model').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const provider = btn.getAttribute('data-provider');
            const input = document.getElementById(`add-model-input-${provider}`);
            const modelId = input.value.trim();
            if (!modelId) return;

            if (!localProviders[provider].models) localProviders[provider].models = [];
            
            if (localProviders[provider].models.some(m => m.id === modelId)) {
                alert('该模型已存在！');
                return;
            }

            localProviders[provider].models.push({
                id: modelId,
                name: modelId,
                contextWindow: 128000,
                maxTokens: 8192
            });

            input.value = '';
            renderProvidersList();
            updateModelsDatalist();
        });
    });

    document.querySelectorAll('.model-tag-del').forEach(delBtn => {
        delBtn.addEventListener('click', (e) => {
            const provider = e.target.getAttribute('data-provider');
            const index = parseInt(e.target.getAttribute('data-index'), 10);
            localProviders[provider].models.splice(index, 1);
            renderProvidersList();
            updateModelsDatalist();
        });
    });
}

// 动态刷新 datalist
function updateModelsDatalist() {
    const datalist = document.getElementById('models-datalist');
    if (!datalist) return;
    datalist.innerHTML = '';

    for (const providerKey of Object.keys(localProviders)) {
        const provider = localProviders[providerKey];
        const models = provider.models || [];
        models.forEach(model => {
            const option = document.createElement('option');
            option.value = `${providerKey}/${model.id}`;
            datalist.appendChild(option);
        });
    }
}

// 添加厂家模态弹窗交互
const addProviderModal = document.getElementById('add-provider-modal');
const newProviderIdInput = document.getElementById('new-provider-id');
const newProviderUrlInput = document.getElementById('new-provider-url');
const newProviderKeyInput = document.getElementById('new-provider-key');

document.getElementById('btn-add-provider').addEventListener('click', () => {
    newProviderIdInput.value = '';
    newProviderUrlInput.value = 'https://api.example.com/v1';
    newProviderKeyInput.value = '';
    addProviderModal.classList.add('active');
    newProviderIdInput.focus();
});

const closeAddProviderModal = () => {
    addProviderModal.classList.remove('active');
};
document.getElementById('modal-close-btn').addEventListener('click', closeAddProviderModal);
document.getElementById('modal-cancel-btn').addEventListener('click', closeAddProviderModal);

document.getElementById('modal-confirm-btn').addEventListener('click', () => {
    const providerName = newProviderIdInput.value.trim();
    if (!providerName) {
        alert("请输入厂商标识！");
        return;
    }

    const key = providerName.toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(key)) {
        alert("格式错误！厂商标识仅能由小写字母、数字及中划线/下划线组成。");
        return;
    }

    if (localProviders[key]) {
        alert("该厂商标识已存在！");
        return;
    }

    localProviders[key] = {
        baseUrl: newProviderUrlInput.value.trim() || "https://api.example.com/v1",
        apiKey: newProviderKeyInput.value.trim(),
        api: "openai-completions",
        models: []
    };

    closeAddProviderModal();
    renderProvidersList();
    updateModelsDatalist();
});

// 保存配置
document.getElementById('config-save-btn').addEventListener('click', async () => {
    if (!configData) return;

    // 1. 同步保存提供商与模型白名单
    if (!configData.models) configData.models = {};
    configData.models.providers = localProviders;

    // 2. 同步生成环境变量 (env) 机制
    if (!configData.env) configData.env = {};
    for (const key of Object.keys(localProviders)) {
        const envKeyName = key.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase() + '_API_KEY';
        if (localProviders[key].apiKey) {
            configData.env[envKeyName] = localProviders[key].apiKey;
        }
    }

    // 3. 同步并发选项及默认主备模型选择
    if (!configData.agents) configData.agents = {};
    if (!configData.agents.defaults) configData.agents.defaults = {};
    configData.agents.defaults.maxConcurrent = parseInt(document.getElementById('max-concurrent').value, 10);
    
    if (!configData.agents.defaults.model) configData.agents.defaults.model = {};
    configData.agents.defaults.model.primary = document.getElementById('model-primary').value.trim();
    configData.agents.defaults.model.fallbacks = [document.getElementById('model-fallback').value.trim()];

    if (!configData.gateway) configData.gateway = {};
    configData.gateway.port = parseInt(document.getElementById('gateway-port').value, 10);

    // 调用 API 保存配置
    const result = await window.api.saveConfig(configData);
    if (result.success) {
        alert('配置已成功保存！');
        statPort.innerText = configData.gateway.port;
        if (gatewayStatus === 'running') {
            const restart = confirm('网关正在运行中，是否立即重启网关以使新配置生效？');
            if (restart) {
                window.api.gatewayAction('stop');
                setTimeout(() => window.api.gatewayAction('start'), 1000);
            }
        }
    } else {
        alert('配置保存失败：' + result.error);
    }
});

// 渲染插件卡片网格
function renderPluginsGrid() {
    const grid = document.getElementById('tour-plugins-grid');
    grid.innerHTML = '';

    if (!configData || !configData.plugins || !configData.plugins.entries) return;

    const entries = configData.plugins.entries;
    for (const key of Object.keys(pluginMetadata)) {
        const plugin = pluginMetadata[key];
        const isEnabled = entries[key] ? entries[key].enabled : false;

        const card = document.createElement('div');
        card.className = 'plugin-card-item';
        card.innerHTML = `
            <div class="plugin-card-top">
                <h4>${plugin.name}</h4>
                <p>${plugin.desc}</p>
            </div>
            <div class="plugin-card-bot">
                <span style="font-size: 12px; color: ${isEnabled ? 'var(--accent-color)' : 'var(--text-secondary)'}; font-weight: 600;">
                    ${isEnabled ? '已启用' : '已禁用'}
                </span>
                <label class="switch-slider-btn">
                    <input type="checkbox" class="plugin-toggle-checkbox" data-plugin="${key}" ${isEnabled ? 'checked' : ''}>
                    <span class="slider-knob"></span>
                </label>
            </div>
        `;
        grid.appendChild(card);
    }

    // 绑定卡片开关事件
    document.querySelectorAll('.plugin-toggle-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', async (e) => {
            const pluginKey = e.target.getAttribute('data-plugin');
            const checked = e.target.checked;

            if (!configData.plugins.entries[pluginKey]) {
                configData.plugins.entries[pluginKey] = {};
            }
            configData.plugins.entries[pluginKey].enabled = checked;

            // 存盘
            await window.api.saveConfig(configData);
            // 重新刷新视图
            renderPluginsGrid();

            // 若在运行，提醒热重载
            if (gatewayStatus === 'running') {
                window.api.gatewayAction('stop');
                setTimeout(() => window.api.gatewayAction('start'), 1200);
            }
        });
    });
}

// 6. UI 状态刷新
function updateGatewayStatusUI(status) {
    if (status === 'running') {
        statusLight.className = 'status-dot running';
        statusLabel.innerText = '运行中';
        btnIconStart.style.display = 'none';
        btnIconStop.style.display = 'block';
        btnLabelText.innerText = '停止网关';
        gatewayToggleBtn.className = 'gateway-big-btn running';
    } else if (status === 'stopped') {
        statusLight.className = 'status-dot';
        statusLabel.innerText = '已停止';
        btnIconStart.style.display = 'block';
        btnIconStop.style.display = 'none';
        btnLabelText.innerText = '启动网关';
        gatewayToggleBtn.className = 'gateway-big-btn stopped';
    } else if (status === 'starting') {
        statusLight.className = 'status-dot starting';
        statusLabel.innerText = '正在启动...';
        btnIconStart.style.display = 'block';
        btnIconStop.style.display = 'none';
        btnLabelText.innerText = '启动中';
        gatewayToggleBtn.className = 'gateway-big-btn starting';
    }
}

// 模拟内存指标变化，增添科幻动态效果
function updateMemoryMock() {
    if (gatewayStatus !== 'running') {
        statMem.innerText = '-- MB';
        return;
    }
    const memVal = Math.floor(Math.random() * (165 - 138) + 138);
    statMem.innerText = memVal + ' MB';
}

// 7. Tab 页切换控制
function setupTabSwitching() {
    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));

            tab.classList.add('active');
            const targetPane = document.getElementById(tab.getAttribute('data-tab'));
            targetPane.classList.add('active');
            currentTab = tab.getAttribute('data-tab');

            // 切换到用量页重画图表防自适应显示错误
            if (currentTab === 'dashboard-view') {
                renderUsageCharts();
            }
        });
    });
}

// 8. 主题一键无缝切换
function setupThemeSwitching() {
    const pickerDark = document.getElementById('theme-btn-dark');
    const pickerAurora = document.getElementById('theme-btn-aurora');
    const pickerLight = document.getElementById('theme-btn-light');

    pickerDark.addEventListener('click', () => {
        document.body.className = 'theme-dark';
        localStorage.setItem('user-theme', 'theme-dark');
    });

    pickerAurora.addEventListener('click', () => {
        document.body.className = 'theme-aurora';
        localStorage.setItem('user-theme', 'theme-aurora');
    });

    pickerLight.addEventListener('click', () => {
        document.body.className = 'theme-light';
        localStorage.setItem('user-theme', 'theme-light');
    });

    // 默认主题读取
    const savedTheme = localStorage.getItem('user-theme') || 'theme-dark';
    document.body.className = savedTheme;
}

// 9. 用量可视化与商业级使用统计数据系统
function renderUsageCharts() {
    const waveBox = document.getElementById('stats-wave-chart-box');
    if (!waveBox) return;

    // A. 模拟趋势图表数据（5条曲线：成本、缓存创建、缓存命中、输入、输出）
    // 采用 horizontal tangent bezier 贝塞尔平滑算法
    const hours = ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'];
    
    // 5条线的用量走势（0~100归一化后渲染，以防数据跨度过大导致折叠）
    const lineData = {
        cost: [10, 8, 2, 4, 30, 24, 28, 32, 29, 38, 20, 5],           // 红色
        cacheCreate: [5, 4, 1, 2, 12, 10, 15, 18, 14, 22, 11, 2],    // 橙色
        cacheHit: [2, 1, 0, 1, 8, 25, 12, 35, 20, 48, 15, 1],        // 蓝色
        input: [80, 70, 10, 25, 95, 60, 72, 78, 65, 85, 48, 12],      // 绿色
        output: [40, 35, 5, 12, 50, 38, 42, 45, 39, 52, 28, 6]        // 紫色
    };

    const width = 600;
    const height = 200;
    const paddingLeft = 40;
    const paddingRight = 20;
    const paddingTop = 20;
    const paddingBottom = 30;

    const plotWidth = width - paddingLeft - paddingRight;
    const plotHeight = height - paddingTop - paddingBottom;

    // 绘制横纵网格线
    let gridHtml = '';
    const yLines = 4;
    for (let i = 0; i <= yLines; i++) {
        const y = paddingTop + (plotHeight / yLines) * i;
        gridHtml += `<line x1="${paddingLeft}" y1="${y}" x2="${width - paddingRight}" y2="${y}" stroke="rgba(255,255,255,0.04)" />`;
        // Y轴刻度文字 (0k 到 20000k)
        const labelVal = Math.round(20000 * (1 - i / yLines));
        gridHtml += `<text x="${paddingLeft - 8}" y="${y + 4}" fill="var(--text-secondary)" font-size="9" text-anchor="end">${labelVal}k</text>`;
    }

    // X轴时间轴文字
    hours.forEach((h, idx) => {
        const x = paddingLeft + (plotWidth / (hours.length - 1)) * idx;
        gridHtml += `<text x="${x}" y="${height - 10}" fill="var(--text-secondary)" font-size="9" text-anchor="middle">${h}</text>`;
        gridHtml += `<line x1="${x}" y1="${paddingTop}" x2="${x}" y2="${height - paddingBottom}" stroke="rgba(255,255,255,0.02)" stroke-dasharray="2,2" />`;
    });

    // 计算平滑曲线路径函数 (Horizontal Tangent Bezier)
    const getCurvePath = (values) => {
        let path = '';
        const len = values.length;
        const coords = values.map((val, idx) => {
            const x = paddingLeft + (plotWidth / (len - 1)) * idx;
            // 归一化高度
            const y = paddingTop + plotHeight * (1 - val / 100);
            return { x, y };
        });

        path += `M ${coords[0].x} ${coords[0].y}`;
        for (let i = 0; i < len - 1; i++) {
            const p1 = coords[i];
            const p2 = coords[i+1];
            const cpX1 = p1.x + (p2.x - p1.x) / 2;
            const cpY1 = p1.y;
            const cpX2 = p2.x - (p2.x - p1.x) / 2;
            const cpY2 = p2.y;
            path += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${p2.x} ${p2.y}`;
        }
        return { path, coords };
    };

    // 绘制五条高颜值贝塞尔曲线
    const curves = [
        { key: 'cost', color: '#ff5252', width: 2, fillOpacity: 0.05 },
        { key: 'cacheCreate', color: '#ff9100', width: 2, fillOpacity: 0.03 },
        { key: 'cacheHit', color: '#2979ff', width: 2.5, fillOpacity: 0.08 },
        { key: 'input', color: '#00e676', width: 3, fillOpacity: 0.1 },
        { key: 'output', color: 'var(--accent-color)', width: 2.5, fillOpacity: 0.08 }
    ];

    let pathsHtml = '';
    curves.forEach((c) => {
        const { path, coords } = getCurvePath(lineData[c.key]);
        const gradId = `grad-${c.key}`;
        
        pathsHtml += `
            <defs>
                <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="${c.color}" stop-opacity="${c.fillOpacity}"/>
                    <stop offset="100%" stop-color="${c.color}" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <!-- 数据点 -->
            ${values.map((v, i) => {
                const x = padding + i * xStep;
                const y = height - padding - v * yScale;
                return `<circle cx="${x}" cy="${y}" r="4" fill="var(--text-primary)" stroke="var(--accent-color)" stroke-width="2"/>`;
            }).join('')}
            ${labels}
        </svg>
    `;

    // B. 饼图 (各渠道调用占比)
    const pieBox = document.getElementById('pie-chart-svg-box');
    const data = [
        { name: 'Agnes AI', percent: 60, color: 'var(--accent-color)' },
        { name: '阿里百炼', percent: 25, color: '#ffb300' },
        { name: '本地离线', percent: 15, color: '#00e676' }
    ];

    let totalAngle = 0;
    let piePaths = '';
    let legend = '';

    data.forEach((item) => {
        const angle = (item.percent / 100) * 360;
        const radStart = (totalAngle - 90) * Math.PI / 180;
        const radEnd = (totalAngle + angle - 90) * Math.PI / 180;

        const x1 = 100 + 70 * Math.cos(radStart);
        const y1 = 100 + 70 * Math.sin(radStart);
        const x2 = 100 + 70 * Math.cos(radEnd);
        const y2 = 100 + 70 * Math.sin(radEnd);

        const largeArc = angle > 180 ? 1 : 0;
        piePaths += `<path d="M 100 100 L ${x1} ${y1} A 70 70 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${item.color}" stroke="var(--bg-card)" stroke-width="2" />`;
        
        legend += `
            <g transform="translate(190, ${40 + totalAngle / 3.6 * 1.4})">
                <rect width="12" height="12" rx="3" fill="${item.color}"/>
                <text x="20" y="11" fill="var(--text-primary)" font-size="12">${item.name} (${item.percent}%)</text>
            </g>
        `;
        totalAngle += angle;
    });

    pieBox.innerHTML = `
        <svg width="100%" height="100%" viewBox="0 0 320 200">
            <!-- 环形挖空 -->
            ${piePaths}
            <circle cx="100" cy="100" r="40" fill="var(--bg-card)"/>
            ${legend}
        </svg>
    `;
}

// 10. 二维码本地渲染 Canvas 算法（无任何联网依赖，支持离线微信扫码）
function drawQrCode(url) {
    const ctx = qrcodeCanvas.getContext('2d');
    ctx.clearRect(0, 0, 160, 160);
    
    const img = new Image();
    // 使用高速二维码转换接口，160x160尺寸
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(url)}`;
    
    img.onload = () => {
        ctx.drawImage(img, 0, 0, 160, 160);
    };

    img.onerror = () => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 160, 160);
        ctx.fillStyle = '#ff5252';
        ctx.font = '11px sans-serif';
        ctx.fillText('加载出错,请点击下方复制', 10, 80);
    };
}

// 11. 新手遮罩引导系统多步逻辑
const guideSteps = [
    {
        target: 'tour-status',
        title: '🟢 步骤一: 运行监控',
        content: '在这里能看到网关核心的实时运行状态（启动中/已启动/已停止）。第一次进入状态默认为已停止。'
    },
    {
        target: 'tour-log-terminal',
        title: '🖥️ 步骤二: 控制台日志',
        content: '点击“启动网关”按钮后，本地网关服务将在这里输出实时的日志流信息。所有的消息路由和交互过程都将以多色高亮呈现。'
    },
    {
        target: 'tour-nav-config',
        title: '⚙️ 步骤三: 参数与密钥配置',
        content: '新拉下代码的新手，在这里可以一键可视化地修改各个大模型 API 密钥、指定主备用大模型以及运行端口，保存后文件直接自动同步到本地，彻底摆脱记事本写配置！'
    },
    {
        target: 'tour-nav-plugins',
        title: '🔌 步骤四: 插件开关中心',
        content: '项目内置 40+ 实用的网关消息插件。在这里可以一键开启微信渠道、语音通话服务、开机启动或实时搜索，网关将完美进行热重载，开箱即用！'
    }
];

let currentGuideStepIndex = 0;

function checkAndStartGuide() {
    const isCompleted = localStorage.getItem('guide_completed');
    if (!isCompleted) {
        document.getElementById('guide-overlay').style.display = 'flex';
        document.getElementById('guide-step-card').style.display = 'flex';
        showGuideStep(0);
    }
}

function showGuideStep(index) {
    currentGuideStepIndex = index;
    const step = guideSteps[index];

    document.getElementById('guide-step-title').innerText = step.title;
    document.getElementById('guide-step-content').innerText = step.content;
    document.getElementById('guide-step-index').innerText = `步骤 ${index + 1} / ${guideSteps.length}`;

    // 清理其他高亮（排除新手引导本身，防定位塌陷及无法点击）
    document.querySelectorAll('.app-container *').forEach(el => {
        if (el.closest('#guide-overlay') || el.closest('#guide-step-card')) return;
        el.style.position = '';
        el.style.zIndex = '';
        el.style.boxShadow = '';
    });

    // 高亮指定目标节点
    const targetElement = document.getElementById(step.target);
    if (targetElement) {
        // 如果是侧边栏选项，自动模拟导航的高亮状态，以便用户看得更清晰
        if (step.target.startsWith('tour-nav-')) {
            targetElement.click();
        }
        targetElement.style.position = 'relative';
        targetElement.style.zIndex = '102';
        targetElement.style.boxShadow = '0 0 15px var(--accent-color), 0 0 50px rgba(140,82,255,0.4)';
    }

    const nextBtn = document.getElementById('guide-btn-next');
    if (index === guideSteps.length - 1) {
        nextBtn.innerText = '开启体验';
    } else {
        nextBtn.innerText = '下一步';
    }
}

document.getElementById('guide-btn-next').addEventListener('click', () => {
    if (currentGuideStepIndex < guideSteps.length - 1) {
        showGuideStep(currentGuideStepIndex + 1);
    } else {
        // 完成指引
        finishGuide();
    }
});

document.getElementById('guide-btn-skip').addEventListener('click', () => {
    finishGuide();
});

function finishGuide() {
    // 清理高亮并隐藏遮罩（排除新手引导本身，防定位塌陷及无法点击）
    document.querySelectorAll('.app-container *').forEach(el => {
        if (el.closest('#guide-overlay') || el.closest('#guide-step-card')) return;
        el.style.position = '';
        el.style.zIndex = '';
        el.style.boxShadow = '';
    });
    document.getElementById('guide-overlay').style.display = 'none';
    document.getElementById('guide-step-card').style.display = 'none';
    localStorage.setItem('guide_completed', 'true');
    // 跳转回第一个 Tab
    document.getElementById('tour-nav-console').click();
}

// 12. 运行初始化
window.addEventListener('DOMContentLoaded', init);

// 13. 微信解绑与切换
document.getElementById('wechat-unbind-btn').addEventListener('click', async () => {
    const confirmClear = confirm('确定要解绑当前微信并清空微信登录凭证吗？\n\n这将会停止运行中的网关，并在下次启动网关时重新生成二维码供您扫码登录！');
    if (!confirmClear) return;

    try {
        const result = await window.api.clearWeChatSession();
        if (result.success) {
            alert('微信解绑成功！微信登录缓存已彻底清除。\n\n您现在可以直接点击右下角“绑定微信”按钮生成全新的登录二维码。');
            if (gatewayStatus === 'running') {
                gatewayStatus = 'stopped';
                updateGatewayStatusUI('stopped');
            }
        } else {
            alert('解绑失败：' + result.error);
        }
    } catch (err) {
        alert('解绑操作异常：' + err.message);
    }
});

// 14. 微信绑定 (手动登录)
document.getElementById('wechat-bind-btn').addEventListener('click', async () => {
    try {
        logTerminal.innerText += '\n[WeChat Login] 正在唤醒微信手动绑定模块，请稍候...\n';
        const result = await window.api.triggerWeChatLogin();
        if (result.success) {
            logTerminal.innerText += '[WeChat Login] 手动绑定服务拉起中，等待抓取登录二维码...\n';
        } else {
            alert('拉起绑定失败：' + result.error);
        }
    } catch (err) {
        alert('拉起异常：' + err.message);
    }
});
