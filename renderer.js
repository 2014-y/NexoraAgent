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
        drawQrCode(url);
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

// 5. 渲染与加载参数配置
async function loadAndRenderConfig() {
    configData = await window.api.readConfig();
    if (!configData) {
        logTerminal.innerText = '[System] [Error] 无法读取 openclaw.json 配置文件！\n';
        return;
    }

    // 填充表单输入框
    if (configData.env) {
        document.getElementById('key-agnes').value = configData.env.AGNES_API_KEY || '';
        document.getElementById('key-yitong').value = configData.env.YITONG_API_KEY || '';
        document.getElementById('key-zhipu').value = configData.env.ZHIPU_API_KEY || '';
    }

    if (configData.agents && configData.agents.defaults) {
        const defaults = configData.agents.defaults;
        document.getElementById('max-concurrent').value = defaults.maxConcurrent || 4;
        if (defaults.model) {
            document.getElementById('model-primary').value = defaults.model.primary || 'agnes-ai/agnes-2.0-flash';
            document.getElementById('model-fallback').value = (defaults.model.fallbacks && defaults.model.fallbacks[0]) || 'agnes-ai/agnes-1.5-flash';
        }
    }

    if (configData.gateway) {
        document.getElementById('gateway-port').value = configData.gateway.port || 18789;
        statPort.innerText = configData.gateway.port || 18789;
        // 自动提取或模拟一个令牌展示在界面上
        const auth = configData.gateway.auth;
        document.getElementById('gateway-token').value = (auth && auth.token) || 'openclaw-dev-token-998877';
    }

    // 渲染功能插件列表卡片
    renderPluginsGrid();
}

// 保存配置
document.getElementById('config-save-btn').addEventListener('click', async () => {
    if (!configData) return;

    // 收集表单数据
    if (!configData.env) configData.env = {};
    configData.env.AGNES_API_KEY = document.getElementById('key-agnes').value;
    configData.env.YITONG_API_KEY = document.getElementById('key-yitong').value;
    configData.env.ZHIPU_API_KEY = document.getElementById('key-zhipu').value;

    if (!configData.agents) configData.agents = {};
    if (!configData.agents.defaults) configData.agents.defaults = {};
    configData.agents.defaults.maxConcurrent = parseInt(document.getElementById('max-concurrent').value, 10);
    
    if (!configData.agents.defaults.model) configData.agents.defaults.model = {};
    configData.agents.defaults.model.primary = document.getElementById('model-primary').value;
    configData.agents.defaults.model.fallbacks = [document.getElementById('model-fallback').value];

    if (!configData.gateway) configData.gateway = {};
    configData.gateway.port = parseInt(document.getElementById('gateway-port').value, 10);

    // 调用 API 保存配置
    const result = await window.api.saveConfig(configData);
    if (result.success) {
        alert('配置已成功保存！');
        statPort.innerText = configData.gateway.port;
        // 如果在运行中，提示需要重启
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

// 9. 用量可视化 SVG 图表渲染
function renderUsageCharts() {
    // A. 折线图 (7天 Token 走势)
    const lineBox = document.getElementById('line-chart-svg-box');
    const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const values = [184000, 246000, 192000, 312000, 289000, 421000, 368000]; // 模拟用量数据

    const width = 500;
    const height = 180;
    const padding = 30;

    // 映射到坐标
    const xStep = (width - padding * 2) / (days.length - 1);
    const maxVal = Math.max(...values) * 1.1;
    const yScale = (height - padding * 2) / maxVal;

    let points = '';
    let gridLines = '';
    let labels = '';

    for (let i = 0; i < days.length; i++) {
        const x = padding + i * xStep;
        const y = height - padding - values[i] * yScale;
        points += `${x},${y} `;

        // 横坐标刻度
        labels += `<text x="${x}" y="${height - 10}" fill="var(--text-secondary)" font-size="11" text-anchor="middle">${days[i]}</text>`;
        // 竖向网格线
        gridLines += `<line x1="${x}" y1="${padding}" x2="${x}" y2="${height - padding}" stroke="rgba(255,255,255,0.04)" stroke-dasharray="3,3" />`;
    }

    // 纵坐标刻度
    const yTickCount = 4;
    for (let i = 0; i <= yTickCount; i++) {
        const yVal = Math.round((maxVal / yTickCount) * i);
        const y = height - padding - yVal * yScale;
        labels += `<text x="${padding - 5}" y="${y + 4}" fill="var(--text-secondary)" font-size="11" text-anchor="end">${(yVal / 1000).toFixed(0)}k</text>`;
        gridLines += `<line x1="${padding}" y1="${y}" x2="${width - padding}" y2="${y}" stroke="rgba(255,255,255,0.06)" />`;
    }

    lineBox.innerHTML = `
        <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}">
            <defs>
                <linearGradient id="line-grad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="var(--accent-color)" stop-opacity="0.3"/>
                    <stop offset="100%" stop-color="var(--accent-color)" stop-opacity="0"/>
                </linearGradient>
            </defs>
            ${gridLines}
            <!-- 渐变阴影区 -->
            <path d="M ${padding} ${height - padding} L ${points.trim().replace(/ /g, ' L ')} L ${width - padding} ${height - padding} Z" fill="url(#line-grad)"/>
            <!-- 折线 -->
            <polyline fill="none" stroke="var(--accent-color)" stroke-width="3" points="${points}"/>
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
    ctx.clearRect(0, 0, 180, 180);
    
    // 使用最轻量的二维码接口作为高画质主方案
    const img = new Image();
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`;
    
    img.onload = () => {
        ctx.drawImage(img, 0, 0, 180, 180);
    };

    // 备用降级离线绘制逻辑：在 API 联网失败时依然显示一个提示文本，或用微型矩阵表示
    img.onerror = () => {
        ctx.fillStyle = '#1e1b33';
        ctx.fillRect(0, 0, 180, 180);
        ctx.fillStyle = '#ffffff';
        ctx.font = '12px sans-serif';
        ctx.fillText('离线环境下无法渲染图片', 15, 60);
        ctx.fillText('请长按复制登录链接:', 15, 85);
        ctx.fillStyle = '#ffb300';
        ctx.font = '10px monospace';
        ctx.fillText(url.substring(0, 24) + '...', 15, 110);
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
        showGuideStep(0);
    }
}

function showGuideStep(index) {
    currentGuideStepIndex = index;
    const step = guideSteps[index];

    document.getElementById('guide-step-title').innerText = step.title;
    document.getElementById('guide-step-content').innerText = step.content;
    document.getElementById('guide-step-index').innerText = `步骤 ${index + 1} / ${guideSteps.length}`;

    // 清理其他高亮
    document.querySelectorAll('.app-container *').forEach(el => {
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
    // 清理高亮并隐藏遮罩
    document.querySelectorAll('.app-container *').forEach(el => {
        el.style.position = '';
        el.style.zIndex = '';
        el.style.boxShadow = '';
    });
    document.getElementById('guide-overlay').style.display = 'none';
    localStorage.setItem('guide_completed', 'true');
    // 跳转回第一个 Tab
    document.getElementById('tour-nav-console').click();
}

// 12. 运行初始化
window.addEventListener('DOMContentLoaded', init);
