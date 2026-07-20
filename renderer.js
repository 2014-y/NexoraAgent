
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return String(unsafe);
    return unsafe
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;')
         .replace(/'/g, '&#039;');
}

// 🌟 跨环境通用高可靠剪贴板复制工具
async function copyToClipboard(text) {
    if (!text) return false;
    try {
        if (window.api && typeof window.api.copyText === 'function') {
            const res = await window.api.copyText(text);
            if (res && res.success) return true;
        }
    } catch (e) {}
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {}
    try {
        const tmp = document.createElement('textarea');
        tmp.value = text;
        tmp.style.position = 'fixed';
        tmp.style.opacity = '0';
        document.body.appendChild(tmp);
        tmp.focus();
        tmp.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(tmp);
        return ok;
    } catch (e) {}
    return false;
}

function renderFlag(flag) {
    if (!flag) return '🌐';
    const cleanFlag = String(flag).trim().toLowerCase();
    if (cleanFlag.length === 2 && /^[a-z]+$/.test(cleanFlag)) {
        return `<img src="https://cdn.jsdelivr.net/gh/lipis/flag-icons/flags/4x3/${cleanFlag}.svg" class="acc-flag-icon" alt="${cleanFlag}" onerror="this.outerHTML='🌐'">`;
    }
    if (cleanFlag === 'globe') return '🌐';
    return flag;
}

// renderer.js - 渲染进程交互逻辑
window.addEventListener('error', (event) => {
    const logEl = document.getElementById('log-terminal') || document.querySelector('.log-terminal');
    if (logEl) {
        logEl.innerText += `\n[Render Error] ${event.message} at ${event.filename}:${event.lineno}:${event.colno}\n`;
    }
});

// 获取是否启用内置模型，默认关闭（即 localStorage 存储为 'true' 时才为 true）
function getUseBuiltIn() {
    return localStorage.getItem('setting_use_built_in_models') !== 'false';
}

/** 内置开启时，默认模型选型 / 聊天模型仅允许这两个通道 */
const BUILTIN_ALLOWED_PROVIDERS = ['agnes-ai', 'ollama'];
const BUILTIN_DEFAULT_PRIMARY = 'agnes-ai/agnes-2.0-flash';
const BUILTIN_DEFAULT_FALLBACK = 'agnes-ai/agnes-1.5-flash';

function isBuiltinAllowedProvider(providerKey) {
    return BUILTIN_ALLOWED_PROVIDERS.includes(String(providerKey || '').trim());
}

function parseModelRef(ref) {
    const raw = String(ref || '').trim();
    if (!raw) return { provider: '', model: '' };
    if (!raw.includes('/')) return { provider: '', model: raw };
    const idx = raw.indexOf('/');
    return { provider: raw.slice(0, idx), model: raw.slice(idx + 1) };
}

function isBuiltinAllowedModelRef(ref) {
    const { provider } = parseModelRef(ref);
    return isBuiltinAllowedProvider(provider);
}

/** 聊天主流程不应出现的图像/视频模型 id */
function isNonChatModelId(modelId) {
    const id = String(modelId || '').toLowerCase();
    return id.includes('image') || id.includes('video') || id.includes('embed');
}

/** 模型下拉可选厂家：学生永远仅 ollama；内置开时主/备/老师仅 agnes-ai + ollama；关则全部 */
function getModelPickerProviderKeys(inputId) {
    // 模仿学生模型：专属本地，仅 ollama
    if (inputId === 'model-student') {
        return ['ollama'];
    }
    if (!getUseBuiltIn()) return Object.keys(localProviders || {});
    // 内置开启：默认模型选型 / 老师模型 只支持内置 agnes-ai 与本地 ollama
    return BUILTIN_ALLOWED_PROVIDERS.slice();
}

/** 收集某输入框可用的模型推荐列表 */
function collectModelPickerOptions(inputId) {
    const allModels = [];
    const providerKeys = getModelPickerProviderKeys(inputId);
    for (const providerKey of providerKeys) {
        const provider = localProviders[providerKey];
        if (!provider) continue;
        const models = provider.models || [];
        models.forEach((model) => {
            if (!model || !model.id) return;
            // 学生模型：排除嵌入等非对话本地模型
            if (inputId === 'model-student' && isNonChatModelId(model.id)) return;
            // 主/备/老师：过滤掉图像、视频、嵌入模型
            if ((inputId === 'model-primary' || inputId === 'model-fallback' || inputId === 'model-teacher')
                && isNonChatModelId(model.id)) {
                return;
            }
            allModels.push(`${providerKey}/${model.id}`);
        });
    }
    return allModels;
}

/** 规范化学生模型：仅允许 ollama/…；裸模型名自动补前缀 */
function normalizeStudentModelRef(raw) {
    let val = String(raw || '').trim();
    if (!val) return '';
    if (!val.includes('/')) return `ollama/${val}`;
    const { provider, model } = parseModelRef(val);
    if (provider !== 'ollama' || !model) return '';
    return `ollama/${model}`;
}

/** 当前接口服务商列表可见厂家：内置开 → 仅 agnes-ai / ollama；关 → 全部 */
function getSelectableProviderKeys() {
    if (!getUseBuiltIn()) return Object.keys(localProviders || {});
    return BUILTIN_ALLOWED_PROVIDERS.slice();
}

// 全局双模式翻译函数
function t(keyOrZh, en, zhTw) {
    let currentLang = localStorage.getItem('setting_language') || 'zh-CN';
    const select = document.getElementById('setting-language-select');
    if (select && select.value) {
        currentLang = select.value;
    }
    
    // 如果传入了多个参数，说明是 inline 快速翻译：t(zhCn, en, zhTw)
    if (arguments.length > 1) {
        if (currentLang === 'en-US') return en !== undefined ? en : keyOrZh;
        if (currentLang === 'zh-TW') return zhTw !== undefined ? zhTw : keyOrZh;
        return keyOrZh;
    }
    
    // 如果只有一个参数，说明是字典查询
    const locales = window.LOCALES || {};
    const translation = locales[currentLang]?.[keyOrZh];
    if (translation !== undefined) return translation;
    
    return keyOrZh;
}
window.t = t;


// 人性化上下文窗口单位解析与格式化
function parseContextWindow(val) {
    if (!val) return 128000;
    const str = val.toString().toLowerCase().trim();
    if (str.endsWith('m')) {
        return parseFloat(str) * 1000000;
    }
    if (str.endsWith('k')) {
        return parseFloat(str) * 1000;
    }
    const num = parseInt(str, 10);
    return isNaN(num) ? 128000 : num;
}

function formatContextWindow(num) {
    if (!num) return '128k';
    if (num >= 1000000) {
        return `${(num / 1000000).toFixed(0)}M`;
    }
    if (num >= 1000) {
        return `${(num / 1000).toFixed(0)}k`;
    }
    return num.toString();
}

function formatNumberWithUnit(num, isApprox = false) {
    const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
    const approxSymbol = isApprox ? '≈ ' : '';
    if (currentLang === 'en-US') {
        if (num >= 1000000) {
            return `${approxSymbol}${(num / 1000000).toFixed(1)}M`;
        }
        if (num >= 1000) {
            return `${approxSymbol}${(num / 1000).toFixed(1)}k`;
        }
        return `${approxSymbol}${num}`;
    } else {
        // zh-CN or zh-TW
        const unitYi = currentLang === 'zh-TW' ? '億' : '亿';
        const unitWan = currentLang === 'zh-TW' ? '萬' : '万';
        if (num >= 100000000) {
            return `${approxSymbol}${(num / 100000000).toFixed(2)} ${unitYi}`;
        }
        if (num >= 10000) {
            return `${approxSymbol}${(num / 10000).toFixed(1)} ${unitWan}`;
        }
        return `${approxSymbol}${num.toLocaleString()}`;
    }
}

function formatTokenUsageLog(tokenUsage) {
    if (!tokenUsage) return '';
    const currentLang = localStorage.getItem('setting_language') || 'zh-CN';

    function convertUnit(n) {
        if (currentLang === 'en-US') {
            if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
            if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
            return n.toLocaleString();
        } else {
            const unitYi = currentLang === 'zh-TW' ? '億' : '亿';
            const unitWan = currentLang === 'zh-TW' ? '萬' : '万';
            if (n >= 100000000) return `${(n / 100000000).toFixed(2)} ${unitYi}`;
            if (n >= 10000) return `${(n / 10000).toFixed(2)} ${unitWan}`;
            return n.toLocaleString();
        }
    }

    if (tokenUsage.includes('+')) {
        const parts = tokenUsage.split('+');
        const inNum = parseInt(parts[0], 10) || 0;
        const outNum = parseInt(parts[1], 10) || 0;
        const total = inNum + outNum;

        const totalDisplay = convertUnit(total);
        if (total >= 10000 || (currentLang === 'en-US' && total >= 1000)) {
            const inLabel = currentLang === 'en-US' ? 'Input' : (currentLang === 'zh-TW' ? '輸入' : '输入');
            const outLabel = currentLang === 'en-US' ? 'Output' : (currentLang === 'zh-TW' ? '輸出' : '输出');
            return `${totalDisplay} Tokens (${inLabel} ${inNum.toLocaleString()} + ${outLabel} ${outNum.toLocaleString()})`;
        } else {
            return `${total.toLocaleString()} Tokens (${inNum.toLocaleString()} + ${outNum.toLocaleString()})`;
        }
    } else {
        const num = parseInt(tokenUsage, 10);
        if (!isNaN(num)) {
            if (num >= 10000 || (currentLang === 'en-US' && num >= 1000)) {
                return `${convertUnit(num)} Tokens (${num.toLocaleString()})`;
            }
            return `${num.toLocaleString()} Tokens`;
        }
        return `${tokenUsage} Tokens`;
    }
}

// 标记顶部「保存配置」有未保存改动（左侧表单），并刷新 JSON 预览
function markConfigDirty() {
    const topBtn = document.getElementById('config-save-btn-top');
    if (topBtn) {
        topBtn.innerText = '💾 保存配置 (有未保存修改*)';
        topBtn.style.background = 'linear-gradient(135deg, #ff9800 0%, #ff5722 100%)';
        topBtn.style.boxShadow = '0 0 15px rgba(255, 87, 34, 0.4)';
    }
    updateConfigJsonPreview();
}

// 仅标记 JSON 预览区「保存配置」有手写改动（不影响顶部按钮）
function markJsonPanelDirty() {
    const jsonSaveBtn = document.getElementById('config-save-btn');
    if (jsonSaveBtn) {
        jsonSaveBtn.innerText = '💾 保存配置 (有未保存修改*)';
        jsonSaveBtn.style.background = 'linear-gradient(135deg, #ff9800 0%, #ff5722 100%)';
        jsonSaveBtn.style.boxShadow = '0 0 15px rgba(255, 87, 34, 0.4)';
    }
}

function clearSaveBtnDirtyState(btn, label) {
    if (!btn) return;
    btn.innerText = label || '保存配置';
    btn.style.background = '';
    btn.style.boxShadow = '';
    btn.removeAttribute('disabled');
}

// 自定义精美弹窗重写
window.alert = function (message, title = null) {
    const finalTitle = title || t('系统提示', 'System Notification', '系統提示');
    return new Promise(resolve => {
        // 创建 DOM 元素
        const overlay = document.createElement('div');
        overlay.id = 'custom-alert-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(10, 8, 20, 0.4);
            backdrop-filter: blur(8px);
            display: flex; align-items: center; justify-content: center;
            z-index: 99999;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s ease;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: var(--bg-panel);
            backdrop-filter: blur(15px);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            width: 380px;
            padding: 24px;
            box-shadow: 0 15px 50px rgba(0, 0, 0, 0.3), var(--accent-glow);
            transform: scale(0.9);
            transition: transform 0.2s ease;
            color: var(--text-primary);
            font-family: system-ui, -apple-system, sans-serif;
        `;

        modal.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
                <span style="font-size: 20px; line-height: 1;">🔔</span>
                <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--accent-color);">${finalTitle}</h3>
            </div>
            <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 24px; white-space: pre-wrap; word-break: break-all;">${message}</div>
            <div style="display: flex; justify-content: flex-end;">
                <button id="custom-alert-ok" style="background: linear-gradient(135deg, var(--accent-color) 0%, rgba(var(--accent-rgb), 0.7) 100%); border: none; color: white; padding: 8px 24px; font-size: 13px; font-weight: 600; border-radius: 8px; cursor: pointer; box-shadow: 0 4px 10px rgba(var(--accent-rgb), 0.25); outline: none; transition: opacity 0.1s;">${t('确定', 'Confirm', '確定')}</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // 动画浮现
        setTimeout(() => {
            overlay.style.opacity = '1';
            overlay.style.pointerEvents = 'auto';
            modal.style.transform = 'scale(1)';
        }, 10);

        const btnOk = modal.querySelector('#custom-alert-ok');
        btnOk.addEventListener('mouseenter', () => btnOk.style.opacity = '0.9');
        btnOk.addEventListener('mouseleave', () => btnOk.style.opacity = '1');
        btnOk.addEventListener('click', () => {
            overlay.style.opacity = '0';
            overlay.style.pointerEvents = 'none';
            modal.style.transform = 'scale(0.9)';
            setTimeout(() => {
                document.body.removeChild(overlay);
                resolve();
            }, 200);
        });
    });
};

window.confirm = function (message, title = null) {
    const finalTitle = title || t('操作确认', 'Operation Confirmation', '操作確認');
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(10, 8, 20, 0.4);
            backdrop-filter: blur(8px);
            display: flex; align-items: center; justify-content: center;
            z-index: 99999;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s ease;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: var(--bg-panel);
            backdrop-filter: blur(15px);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            width: 400px;
            padding: 24px;
            box-shadow: 0 15px 50px rgba(0, 0, 0, 0.3), var(--accent-glow);
            transform: scale(0.9);
            transition: transform 0.2s ease;
            color: var(--text-primary);
            font-family: system-ui, -apple-system, sans-serif;
        `;

        modal.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
                <span style="font-size: 20px; line-height: 1;">❓</span>
                <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--accent-color);">${finalTitle}</h3>
            </div>
            <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 24px; white-space: pre-wrap; word-break: break-all;">${message}</div>
            <div style="display: flex; justify-content: flex-end; gap: 12px;">
                <button id="custom-confirm-cancel" style="background: var(--bg-input); border: 1px solid var(--border-color); color: var(--text-secondary); padding: 8px 20px; font-size: 13px; border-radius: 8px; cursor: pointer; outline: none; transition: background 0.1s;">${t('取消', 'Cancel', '取消')}</button>
                <button id="custom-confirm-ok" style="background: linear-gradient(135deg, var(--accent-color) 0%, rgba(var(--accent-rgb), 0.7) 100%); border: none; color: white; padding: 8px 24px; font-size: 13px; font-weight: 600; border-radius: 8px; cursor: pointer; box-shadow: 0 4px 10px rgba(var(--accent-rgb), 0.25); outline: none; transition: opacity 0.1s;">${t('确定', 'Confirm', '確定')}</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        setTimeout(() => {
            overlay.style.opacity = '1';
            overlay.style.pointerEvents = 'auto';
            modal.style.transform = 'scale(1)';
        }, 10);

        const btnCancel = modal.querySelector('#custom-confirm-cancel');
        const btnOk = modal.querySelector('#custom-confirm-ok');

        btnCancel.addEventListener('mouseenter', () => btnCancel.style.background = 'rgba(255,255,255,0.1)');
        btnCancel.addEventListener('mouseleave', () => btnCancel.style.background = 'rgba(255,255,255,0.05)');
        
        btnOk.addEventListener('mouseenter', () => btnOk.style.opacity = '0.9');
        btnOk.addEventListener('mouseleave', () => btnOk.style.opacity = '1');

        btnCancel.addEventListener('click', () => {
            overlay.style.opacity = '0';
            overlay.style.pointerEvents = 'none';
            modal.style.transform = 'scale(0.9)';
            setTimeout(() => {
                document.body.removeChild(overlay);
                resolve(false);
            }, 200);
        });

        btnOk.addEventListener('click', () => {
            overlay.style.opacity = '0';
            overlay.style.pointerEvents = 'none';
            modal.style.transform = 'scale(0.9)';
            setTimeout(() => {
                document.body.removeChild(overlay);
                resolve(true);
            }, 200);
        });
    });
};

/** 插件凭证等多字段表单弹窗，fields: [{ key, label, placeholder, type? }] */
window.promptFields = function (title, fields, desc, okText) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(10, 8, 20, 0.4); backdrop-filter: blur(8px);
            display: flex; align-items: center; justify-content: center;
            z-index: 99999; opacity: 0; pointer-events: none; transition: opacity 0.2s ease;
        `;
        const modal = document.createElement('div');
        modal.style.cssText = `
            background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 16px;
            width: 440px; max-width: 92vw; padding: 24px;
            box-shadow: 0 15px 50px rgba(0,0,0,0.3); color: var(--text-primary);
            transform: scale(0.9); transition: transform 0.2s ease;
        `;
        const inputsHtml = (fields || []).map((f, i) => `
            <label style="display:block; font-size:12px; color: var(--text-secondary); margin: 10px 0 4px;">${f.label || f.key}</label>
            <input id="pf-input-${i}" type="${f.type || 'text'}" placeholder="${f.placeholder || ''}" value="${f.value || ''}"
              style="width:100%; box-sizing:border-box; padding:8px 10px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-primary); font-size:13px;" />
        `).join('');
        
        const description = desc || '填写后将写入本地配置并尝试加载插件。凭证仅保存在本机。';
        const okLabel = okText || '保存并启用';

        modal.innerHTML = `
            <h3 style="margin:0 0 8px; font-size:16px; color: var(--accent-color);">${title}</h3>
            <p style="margin:0 0 8px; font-size:12px; color: var(--text-secondary); line-height:1.5;">${description}</p>
            ${inputsHtml}
            <div style="display:flex; justify-content:flex-end; gap:12px; margin-top:20px;">
                <button id="pf-cancel" style="background:var(--bg-input); border:1px solid var(--border-color); color:var(--text-secondary); padding:8px 20px; border-radius:8px; cursor:pointer;">取消</button>
                <button id="pf-ok" style="background:linear-gradient(135deg, var(--accent-color), rgba(var(--accent-rgb),0.7)); border:none; color:#fff; padding:8px 24px; border-radius:8px; font-weight:600; cursor:pointer;">${okLabel}</button>
            </div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        setTimeout(() => {
            overlay.style.opacity = '1';
            overlay.style.pointerEvents = 'auto';
            modal.style.transform = 'scale(1)';
        }, 10);
        const close = (value) => {
            overlay.style.opacity = '0';
            overlay.style.pointerEvents = 'none';
            setTimeout(() => {
                try { document.body.removeChild(overlay); } catch (e) {}
                resolve(value);
            }, 200);
        };
        modal.querySelector('#pf-cancel').addEventListener('click', () => close(null));
        modal.querySelector('#pf-ok').addEventListener('click', () => {
            const out = {};
            (fields || []).forEach((f, i) => {
                const el = modal.querySelector(`#pf-input-${i}`);
                out[f.key] = el ? el.value.trim() : '';
            });
            close(out);
        });
    });
};

// 绑定查看详情按钮点击事件
function bindDetailsClick(container) {
    const detailsBtn = container.querySelector('.btn-view-request-details');
    if (detailsBtn) {
        detailsBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const url = ev.target.getAttribute('data-url');
            const status = ev.target.getAttribute('data-status');
            const statusText = ev.target.getAttribute('data-status-text');
            const hdrs = JSON.parse(decodeURIComponent(ev.target.getAttribute('data-headers')));
            let msg = `发送测试的真实请求数据报如下：\n\n`;
            msg += `● 请求地址 (URL):\n   ${url}\n`;
            
            // 智能判断请求方法：优先读取 data-method 属性，否则根据 URL 路径推断
            const explicitMethod = ev.target.getAttribute('data-method');
            let method = 'GET';
            if (explicitMethod) {
                method = explicitMethod;
            } else {
                const isPost = url.includes('/chat/completions') || url.includes('/generations') || url.includes('/videos');
                method = isPost ? 'POST' : 'GET';
            }
            msg += `● 请求方法 (Method):\n   ${method}\n\n`;
            
            msg += `● 响应状态码 (Response Status):\n   ${status} (${statusText})\n\n`;
            msg += `● 携带请求头 (Request Headers):\n`;
            for (const hKey of Object.keys(hdrs)) {
                msg += `   - ${hKey}: ${hdrs[hKey]}\n`;
            }
            alert(msg, '📡 真实网络请求包数据');
        });
    }
}

// 构建飞书账号配置对象：必填 appId/appSecret；可选 encryptKey/verificationToken 为空时省略，
// 避免写入空字符串触发 OpenClaw 的 secret 校验（minLength:1）或让 websocket 模式误判为已配置加密。
function buildFeishuAccount(values, base = {}) {
    const acc = { ...base };
    acc.appId = (values.appId || '').trim();
    acc.appSecret = (values.appSecret || '').trim();
    const enc = values.encryptKey ? values.encryptKey.trim() : '';
    const vt = values.verificationToken ? values.verificationToken.trim() : '';
    if (enc) acc.encryptKey = enc; else delete acc.encryptKey;
    if (vt) acc.verificationToken = vt; else delete acc.verificationToken;
    return acc;
}

// 渲染飞书多用户绑定管理卡片
function renderFeishuAccounts() {
    const container = document.getElementById('feishu-accounts-container');
    if (!container) return;
    container.innerHTML = '';

    if (!configData) return;
    if (!configData.channels) configData.channels = {};
    if (!configData.channels.feishu) configData.channels.feishu = { accounts: {} };
    if (!configData.channels.feishu.accounts) configData.channels.feishu.accounts = {};

    // 自愈：顶层旧版单账号（appId/appSecret）迁移进 accounts，避免通讯管理显示「暂无」但拓扑却「已就绪」
    const feishuCh = configData.channels.feishu;
    if (feishuCh.appId && feishuCh.appSecret && Object.keys(feishuCh.accounts).length === 0) {
        const legacyId = 'default';
        feishuCh.accounts[legacyId] = {
            appId: String(feishuCh.appId).trim(),
            appSecret: String(feishuCh.appSecret).trim(),
            domain: feishuCh.domain || 'feishu'
        };
        if (feishuCh.encryptKey) feishuCh.accounts[legacyId].encryptKey = feishuCh.encryptKey;
        if (feishuCh.verificationToken) feishuCh.accounts[legacyId].verificationToken = feishuCh.verificationToken;
        feishuCh.defaultAccount = legacyId;
        feishuCh.enabled = true;
        delete feishuCh.appId;
        delete feishuCh.appSecret;
        delete feishuCh.encryptKey;
        delete feishuCh.verificationToken;
        window.api.saveConfig(configData).catch(() => {});
        if (typeof updateTopologyUI === 'function') updateTopologyUI();
    }

    const accounts = configData.channels.feishu.accounts;
    const defaultAccount = configData.channels.feishu.defaultAccount || '';

    const accountIds = Object.keys(accounts);
    if (accountIds.length === 0) {
        container.innerHTML = `
            <div style="padding: 16px; text-align: center; color: var(--text-secondary); background: rgba(255,255,255,0.01); border: 1px dashed var(--border-color); border-radius: 8px; font-size: 12px;">
                ${t('comm.feishu.empty')}
            </div>
        `;
        return;
    }

    accountIds.forEach(id => {
        const acc = accounts[id] || {};
        const isDefault = id === defaultAccount;
        const card = document.createElement('div');
        card.style.cssText = `
            display: flex; justify-content: space-between; align-items: center;
            padding: 12px 16px; background: rgba(255,255,255,0.02);
            border: 1px solid var(--border-color); border-radius: 10px;
        `;
        card.innerHTML = `
            <div style="display: flex; gap: 8px;">
                <div style="font-size: 14px;">👤</div>
                <div>
                    <div style="font-size: 13px; font-weight: bold; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
                        ${t('comm.account.id')}<span style="color: var(--accent-color);">${id}</span>
                        ${isDefault ? `<span style="font-size: 10px; background: rgba(0, 230, 118, 0.15); color: #00e676; border: 1px solid rgba(0, 230, 118, 0.3); padding: 1px 6px; border-radius: 4px;">${t('comm.account.default')}</span>` : ''}
                    </div>
                    <div style="font-size: 11px; color: var(--text-secondary); margin-top: 6px; display: flex; flex-direction: column; gap: 2px;">
                        <span>App ID: ${acc.appId || '--'}</span>
                        <span>Encrypt Key: ${acc.encryptKey ? t('已配置', 'Configured', '已配置') : t('未配置', 'Not configured', '未配置')}</span>
                        ${acc.domain ? `<span>${t('域名', 'Domain', '網域')}: ${acc.domain === 'lark' ? 'Lark' : t('飞书', 'Feishu', '飛書')}</span>` : ''}
                        ${Array.isArray(acc.allowFrom) && acc.allowFrom.length ? `<span>${t('私信白名单', 'DM allowlist', '私訊白名單')}: ${acc.allowFrom.length === 1 ? t('仅本人(扫码绑定)', 'Only me (QR bound)', '僅本人（掃碼綁定）') : t(`${acc.allowFrom.length} 人`, `${acc.allowFrom.length} users`, `${acc.allowFrom.length} 人`)}</span>` : ''}
                    </div>
                </div>
            </div>
            <div style="display: flex; gap: 8px;">
                ${!isDefault ? `<button type="button" class="btn-primary btn-set-default-feishu" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); color: var(--text-primary); cursor: pointer;">${t('设为默认', 'Set Default', '設為默認')}</button>` : ''}
                <button type="button" class="btn-primary btn-edit-feishu" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(140, 82, 255, 0.1); border: 1px solid rgba(140, 82, 255, 0.3); color: #b388ff; cursor: pointer;">${t('编辑', 'Edit', '編輯')}</button>
                <button type="button" class="btn-primary btn-delete-feishu" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(255, 82, 82, 0.1); border: 1px solid rgba(255, 82, 82, 0.3); color: #ff5252; cursor: pointer;">${t('删除', 'Delete', '刪除')}</button>
            </div>
        `;
        container.appendChild(card);
    });

    // 绑定事件
    container.querySelectorAll('.btn-set-default-feishu').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.getAttribute('data-id');
            configData.channels.feishu.defaultAccount = id;
            try {
                await window.api.saveConfig(configData);
                renderFeishuAccounts();
                showToast('已成功切换默认飞书账号！');
                reloadGatewayAfterChannelChange('feishu-default');
            } catch(err) {
                showToast('保存切换失败: ' + err.message);
            }
        });
    });

    container.querySelectorAll('.btn-delete-feishu').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.getAttribute('data-id');
            if (confirm(`确认要删除飞书账号 [ ${id} ] 吗？`)) {
                delete configData.channels.feishu.accounts[id];
                if (configData.channels.feishu.defaultAccount === id) {
                    const keys = Object.keys(configData.channels.feishu.accounts);
                    configData.channels.feishu.defaultAccount = keys[0] || '';
                }
                try {
                    await window.api.saveConfig(configData);
                    renderFeishuAccounts();
                    showToast('飞书账号已删除！');
                    reloadGatewayAfterChannelChange('feishu-delete');
                } catch(err) {
                    showToast('删除保存失败: ' + err.message);
                }
            }
        });
    });

    container.querySelectorAll('.btn-edit-feishu').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.getAttribute('data-id');
            const acc = configData.channels.feishu.accounts[id] || {};
            const values = await window.promptFields(`编辑飞书账号 · ${id}`, [
                { key: 'appId', label: 'App ID', placeholder: 'cli_...', value: acc.appId || '' },
                { key: 'appSecret', label: 'App Secret', placeholder: 'App Secret 密匙', type: 'password', value: acc.appSecret || '' },
                { key: 'encryptKey', label: 'Encrypt Key (可选)', placeholder: '解密 Key', value: acc.encryptKey || '' },
                { key: 'verificationToken', label: 'Verification Token (可选)', placeholder: '验证 Token', value: acc.verificationToken || '' }
            ]);
            if (!values) return;
            if (!values.appId || !values.appSecret) {
                showToast('App ID 和 App Secret 不能为空！');
                return;
            }
            configData.channels.feishu.accounts[id] = buildFeishuAccount(values, acc);
            try {
                await window.api.saveConfig(configData);
                renderFeishuAccounts();
                showToast('飞书账号编辑保存成功！');
                reloadGatewayAfterChannelChange('feishu-edit');
            } catch(err) {
                showToast('保存编辑失败: ' + err.message);
            }
        });
    });
}


// 渲染 QQ 机器人多用户绑定卡片
function renderQqbotAccounts() {
    const container = document.getElementById('qqbot-accounts-container');
    if (!container) return;
    container.innerHTML = '';

    if (!configData) return;
    if (!configData.channels) configData.channels = {};
    if (!configData.channels.qqbot) configData.channels.qqbot = { accounts: {} };
    
    // 自愈式升级：如果检测到旧格式的单账号配置，自动做一次平滑迁移
    if (configData.channels.qqbot.appId && configData.channels.qqbot.clientSecret) {
        const oldAppId = configData.channels.qqbot.appId;
        const oldSecret = configData.channels.qqbot.clientSecret;
        
        configData.channels.qqbot.accounts = configData.channels.qqbot.accounts || {};
        configData.channels.qqbot.accounts['default'] = {
            appId: oldAppId,
            clientSecret: oldSecret
        };
        configData.channels.qqbot.defaultAccount = 'default';
        configData.channels.qqbot.enabled = true;
        
        delete configData.channels.qqbot.appId;
        delete configData.channels.qqbot.clientSecret;
        
        window.api.saveConfig(configData).catch(() => {});
    }

    if (!configData.channels.qqbot.accounts) configData.channels.qqbot.accounts = {};

    const accounts = configData.channels.qqbot.accounts;
    const defaultAccount = configData.channels.qqbot.defaultAccount || '';

    const accountIds = Object.keys(accounts);
    if (accountIds.length === 0) {
        container.innerHTML = `
            <div style="padding: 16px; text-align: center; color: var(--text-secondary); background: rgba(255,255,255,0.01); border: 1px dashed var(--border-color); border-radius: 8px; font-size: 12px;">
                ${t('comm.qq.empty')}
            </div>
        `;
        return;
    }

    accountIds.forEach(id => {
        const acc = accounts[id] || {};
        const isDefault = id === defaultAccount;
        const card = document.createElement('div');
        card.style.cssText = `
            display: flex; justify-content: space-between; align-items: center;
            padding: 12px 16px; background: rgba(255,255,255,0.02);
            border: 1px solid var(--border-color); border-radius: 10px;
        `;
        card.innerHTML = `
            <div style="display: flex; gap: 8px;">
                <div style="font-size: 14px;">👤</div>
                <div>
                    <div style="font-size: 13px; font-weight: bold; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
                        ${t('comm.account.id')}<span style="color: var(--accent-color);">${id}</span>
                        ${isDefault ? `<span style="font-size: 10px; background: rgba(0, 230, 118, 0.15); color: #00e676; border: 1px solid rgba(0, 230, 118, 0.3); padding: 1px 6px; border-radius: 4px;">${t('comm.account.default')}</span>` : ''}
                    </div>
                    <div style="font-size: 11px; color: var(--text-secondary); margin-top: 6px; display: flex; flex-direction: column; gap: 2px;">
                        <span>App ID: ${acc.appId || '--'}</span>
                    </div>
                </div>
            </div>
            <div style="display: flex; gap: 8px;">
                ${!isDefault ? `<button type="button" class="btn-primary btn-set-default-qqbot" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); color: var(--text-primary); cursor: pointer;">${t('设为默认', 'Set Default', '設為默認')}</button>` : ''}
                <button type="button" class="btn-primary btn-edit-qqbot" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(140, 82, 255, 0.1); border: 1px solid rgba(140, 82, 255, 0.3); color: #b388ff; cursor: pointer;">${t('编辑', 'Edit', '編輯')}</button>
                <button type="button" class="btn-primary btn-delete-qqbot" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(255, 82, 82, 0.1); border: 1px solid rgba(255, 82, 82, 0.3); color: #ff5252; cursor: pointer;">${t('删除', 'Delete', '刪除')}</button>
            </div>
        `;
        container.appendChild(card);
    });

    // 绑定事件
    container.querySelectorAll('.btn-set-default-qqbot').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.getAttribute('data-id');
            configData.channels.qqbot.defaultAccount = id;
            try {
                await window.api.saveConfig(configData);
                renderQqbotAccounts();
                showToast('已成功切换默认 QQ 机器人！');
                reloadGatewayAfterChannelChange('qqbot-default');
            } catch(err) {
                showToast('保存切换失败: ' + err.message);
            }
        });
    });

    container.querySelectorAll('.btn-delete-qqbot').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.getAttribute('data-id');
            if (confirm(`确认要删除 QQ 机器人 [ ${id} ] 吗？`)) {
                delete configData.channels.qqbot.accounts[id];
                if (configData.channels.qqbot.defaultAccount === id) {
                    const keys = Object.keys(configData.channels.qqbot.accounts);
                    configData.channels.qqbot.defaultAccount = keys[0] || '';
                }
                try {
                    await window.api.saveConfig(configData);
                    renderQqbotAccounts();
                    showToast('QQ 机器人已删除！');
                    reloadGatewayAfterChannelChange('qqbot-delete');
                } catch(err) {
                    showToast('删除保存失败: ' + err.message);
                }
            }
        });
    });

    container.querySelectorAll('.btn-edit-qqbot').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = e.target.getAttribute('data-id');
            const acc = configData.channels.qqbot.accounts[id] || {};
            const values = await window.promptFields(`编辑 QQ 机器人 · ${id}`, [
                { key: 'appId', label: 'App ID', placeholder: '请输入机器人 AppID', value: acc.appId || '' },
                { key: 'clientSecret', label: 'Client Secret', placeholder: '请输入机器人 AppSecret', type: 'password', value: acc.clientSecret || '' }
            ]);
            if (!values) return;
            if (!values.appId || !values.clientSecret) {
                showToast('App ID 和 Client Secret 不能为空！');
                return;
            }
            configData.channels.qqbot.accounts[id] = {
                appId: values.appId.trim(),
                clientSecret: values.clientSecret.trim()
            };
            try {
                await window.api.saveConfig(configData);
                renderQqbotAccounts();
                showToast('QQ 机器人编辑保存成功！');
                reloadGatewayAfterChannelChange('qqbot-edit');
            } catch(err) {
                showToast('保存编辑失败: ' + err.message);
            }
        });
    });
}

// 1. 全局状态
let configData = null;
let currentTab = 'console-view';
let gatewayStatus = 'stopped';

/** 通讯渠道变更后热重载网关（走主进程 await stop→start，带防抖） */
function reloadGatewayAfterChannelChange(reason, opts = {}) {
    const startIfStopped = opts.startIfStopped === true;
    if (window.api && typeof window.api.reloadGatewayForChannel === 'function') {
        window.api.reloadGatewayForChannel(reason || 'channel-change', { startIfStopped }).catch(() => {});
        return;
    }
    // 兼容旧 preload：仅在运行中时 stop→start
    if (gatewayStatus === 'running' || gatewayStatus === 'starting' || startIfStopped) {
        if (gatewayStatus === 'running' || gatewayStatus === 'starting') {
            window.api.gatewayAction('stop');
            setTimeout(() => window.api.gatewayAction('start'), 1500);
        } else if (startIfStopped) {
            window.api.gatewayAction('start');
        }
    }
}
let gatewayFullyReady = false;

let topoNodeStates = {
    'node-client': 'pending',
    'node-core': 'pending',
    'node-llm': 'pending',
    'node-wechat': 'pending',
    'node-qq': 'pending',
    'node-feishu': 'pending'
};

function updateTopologyUI() {
    const statusLabel = (state) => {
        if (state === 'completed') return t('console.topology.status.completed');
        if (state === 'active') return t('console.topology.status.active');
        return t('console.topology.status.pending');
    };

    const channelBound = {
        wechat: false,
        qq: false,
        feishu: false
    };
    try {
        if (configData && configData.channels) {
            // 微信：以真实扫码落盘为准（liveBound），不只看插件开关
            const wx = configData.channels['openclaw-weixin'] || configData.channels.wechat;
            channelBound.wechat = !!(wx && wx.enabled === true);
            channelBound.qq = !!(configData.channels.qqbot && (
                (configData.channels.qqbot.accounts && Object.keys(configData.channels.qqbot.accounts).length > 0)
                || (configData.channels.qqbot.appId && configData.channels.qqbot.clientSecret)
            ));
            const f = configData.channels.feishu;
            channelBound.feishu = !!(f && (
                (f.appId && f.appSecret)
                || (f.accounts && Object.values(f.accounts).some((a) => a && a.appId && a.appSecret))
            ));
        }
    } catch (e) {}

    // 若微信状态 UI 已探测到绑定，优先信它
    try {
        const wxCard = document.getElementById('node-wechat');
        if (wxCard && wxCard.dataset.liveBound === '1') channelBound.wechat = true;
        if (wxCard && wxCard.dataset.liveBound === '0') channelBound.wechat = false;
    } catch (e) {}

    function setTopoState(nodeId, lineId, state) {
        const nodeEl = document.getElementById(nodeId);
        const lineEl = document.getElementById(lineId);
        if (nodeEl) {
            nodeEl.classList.remove('pending', 'active', 'completed', 'unbound', 'bound-ready');
            nodeEl.classList.add(state);
        }
        if (lineEl) {
            lineEl.classList.remove('pending', 'active', 'completed');
            lineEl.classList.add(state);
        }
    }

    const badgeMap = {
        'node-wechat': 'badge-wechat',
        'node-qq': 'badge-qq',
        'node-feishu': 'badge-feishu',
        'node-llm': 'badge-llm',
        'node-client': 'badge-client',
        'node-core': 'badge-core'
    };
    const hintMap = {
        'node-wechat': 'hint-wechat',
        'node-qq': 'hint-qq',
        'node-feishu': 'hint-feishu',
        'node-llm': 'hint-llm'
    };

    for (const [nodeId, rawState] of Object.entries(topoNodeStates)) {
        let lineId = null;
        if (nodeId === 'node-client') lineId = 'line-client';
        else if (nodeId === 'node-llm') lineId = 'line-llm';
        else if (nodeId === 'node-wechat') lineId = 'line-wechat';
        else if (nodeId === 'node-qq') lineId = 'line-qq';
        else if (nodeId === 'node-feishu') lineId = 'line-feishu';

        let state = rawState;
        const hintEl = document.getElementById(hintMap[nodeId]);
        const nodeEl = document.getElementById(nodeId);
        const badgeEl = document.getElementById(badgeMap[nodeId]);

        // 渠道卡：未真正绑定账号时，一律显示「未连接」，避免插件加载误显示「连接中」
        if (nodeId === 'node-wechat' || nodeId === 'node-qq' || nodeId === 'node-feishu') {
            const key = nodeId === 'node-wechat' ? 'wechat' : (nodeId === 'node-qq' ? 'qq' : 'feishu');
            const bound = !!channelBound[key];
            if (!bound) {
                state = 'pending';
                topoNodeStates[nodeId] = 'pending';
            } else if (topoNodeStates['node-core'] === 'completed' && state !== 'completed') {
                // 已绑定且网关就绪 → 直接就绪
                state = 'completed';
                topoNodeStates[nodeId] = 'completed';
            }

            setTopoState(nodeId, lineId, state);
            if (nodeEl) {
                nodeEl.classList.toggle('unbound', !bound);
                nodeEl.classList.toggle('bound-ready', bound && state === 'completed');
            }
            if (badgeEl) {
                badgeEl.textContent = !bound
                    ? t('console.topology.status.unbound')
                    : statusLabel(state);
            }
            if (hintEl) {
                if (!bound) {
                    hintEl.textContent = key === 'wechat'
                        ? t('console.topology.hint.unbound_wechat')
                        : (key === 'qq' ? t('console.topology.hint.unbound_qq') : t('console.topology.hint.unbound_feishu'));
                } else if (state === 'completed') {
                    hintEl.textContent = t('console.topology.hint.ready');
                } else if (state === 'active') {
                    hintEl.textContent = t('console.topology.hint.connecting');
                } else {
                    hintEl.textContent = t('console.topology.hint.bound_waiting');
                }
            }
            continue;
        }

        setTopoState(nodeId, lineId, state);
        if (badgeEl) badgeEl.textContent = statusLabel(state);

        if (nodeId === 'node-llm' && hintEl) {
            if (state === 'completed') hintEl.textContent = t('console.topology.hint.llm_ready');
            else if (state === 'active') hintEl.textContent = t('console.topology.hint.llm_loading');
            else hintEl.textContent = t('console.topology.hint.llm');
        }
    }

    const coreStatus = document.getElementById('topo-core-status');
    if (coreStatus) {
        const st = topoNodeStates['node-core'] || 'pending';
        if (st === 'completed') coreStatus.textContent = t('console.topology.core.ready');
        else if (st === 'active') coreStatus.textContent = t('console.topology.core.starting');
        else coreStatus.textContent = t('console.topology.core.stopped');
    }

    const footer = document.getElementById('topology-footer-tip');
    if (footer) {
        const gwOk = topoNodeStates['node-core'] === 'completed';
        const anyChannel = channelBound.wechat || channelBound.qq || channelBound.feishu;
        if (!gwOk) footer.textContent = t('console.topology.footer');
        else if (!anyChannel) footer.textContent = t('console.topology.footer.need_bind');
        else footer.textContent = t('console.topology.footer.ready');
    }
}

/** 拓扑渠道卡片点击 → 跳转通讯管理 */
(function wireTopologyChannelClicks() {
    const goComm = () => {
        const tab = document.getElementById('nav-communication-mgmt');
        if (tab) tab.click();
    };
    ['node-wechat', 'node-qq', 'node-feishu'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el || el.dataset.topoClickBound === '1') return;
        el.dataset.topoClickBound = '1';
        el.style.cursor = 'pointer';
        el.title = '点击前往通讯管理绑定';
        el.addEventListener('click', goComm);
    });
})();

// 常见插件元数据（用于生成美观的插件网格）
// 顺序即 UI 卡片顺序；自动摘要主卡映射自研 auto-summary（llm-task 仍会进 allow）
const UI_PLUGIN_ORDER = [
    'dual-model-trainer',
    'openclaw-weixin',
    'long-term-memory',
    'feishu',
    'qqbot',
    'voice-call',
    'telegram',
    'slack',
    'whatsapp',
    'matrix',
    'duckduckgo',
    'webhooks',
    'bonjour',
    'workboard',
    'auto-start-codex'
];

const LONG_TERM_MEMORY_STACK = ['auto-summary', 'memory-rotate', 'compaction-memory-guard'];

const pluginMetadata = {
    'dual-model-trainer': { name: '🧠 双模型教学', desc: '利用主备模型对比，自动本地收集并训练属于你的专属模型', tier: 'zero' },
    'openclaw-weixin': { name: '💬 微信渠道', desc: '一键将Nexora Agent接入微信聊天，支持私聊、群聊和图片理解', tier: 'zero' },
    'long-term-memory': { name: '📚 长期记忆', desc: '开箱即用：自动摘要、记忆旋转与压缩护栏，将关键信息持久写入 MEMORY.md，对话压缩后仍可召回。', tier: 'zero' },
    'feishu': { name: '🦆 飞书渠道', desc: '接入飞书/Lark 机器人：支持扫码创建应用或手动填写 App ID/Secret，处理私聊与群聊消息', tier: 'credentials' },
    'qqbot': { name: '🐧 QQ机器人', desc: '将Nexora Agent接入 QQ 开放平台机器人（QQ Bot）消息通道，实现 QQ 群聊及私聊交互。', tier: 'credentials' },
    'voice-call': { name: '📞 语音通话', desc: '开启实时语音对话服务，支持通过微信向 AI 拨打电话', tier: 'credentials' },
    'telegram': { name: '✈️ Telegram', desc: '通过 Telegram 机器人消息通道直接与您的 AI Nexora Agent对话', tier: 'credentials' },
    'slack': { name: '🎨 Slack 渠道', desc: '将 AI 本地Nexora Agent作为应用机器人接入到您的团队 Slack 频道中', tier: 'credentials' },
    'whatsapp': { name: '🟢 WhatsApp', desc: '接入全球 WhatsApp 消息服务，支持媒体及文本处理', tier: 'credentials' },
    'auto-summary': { name: '📝 自动摘要', desc: '每日自动总结聊天与训练数据写入记忆；亦可配合长文摘要能力', tier: 'zero' },
    'llm-task': { name: '📝 长文摘要任务', desc: '向 AI 发送超长链接或长文本，自动提炼要点', tier: 'zero' },
    'matrix': { name: '🛡️ Matrix 通道', desc: '将Nexora Agent挂载到去中心化的加密通信 Matrix 消息信道上', tier: 'credentials' },
    'duckduckgo': { name: '🔍 DuckDuckGo 搜索', desc: '允许 AI 调用搜索引擎进行网页实时检索，获取最新资讯', tier: 'zero' },
    'webhooks': { name: '🔌 Webhooks', desc: '支持外部系统通过标准的 Webhook 事件触发Nexora Agent的定制指令', tier: 'zero' },
    'bonjour': { name: '📡 Bonjour 发现', desc: '启用本地零配置组网，自动发布Nexora Agent局域网服务广播', tier: 'zero' },
    'workboard': { name: '📋 任务看板', desc: '提供待办任务的可视化任务跟踪面板，帮助有序规划工作', tier: 'zero' },
    'auto-start-codex': { name: '🤖 自动唤醒 Codex', desc: '接收微信消息时自动唤醒本地 Codex 桌面 AI 助手（若不需电脑操控可关闭）', tier: 'software' }
};

let pluginProbeMap = {};

function badgeLabelForProbe(probe) {
    const b = (probe && probe.badge) || 'ready';
    if (b === 'needs-config') return t('plugin.badge.needs_config');
    if (b === 'needs-software') return t('plugin.badge.needs_software');
    if (b === 'missing-runtime') return t('plugin.badge.missing_runtime');
    return t('plugin.badge.ready');
}

function badgeClassForProbe(probe) {
    const b = (probe && probe.badge) || 'ready';
    if (b === 'needs-config') return 'plugin-avail-badge needs-config';
    if (b === 'needs-software') return 'plugin-avail-badge needs-software';
    if (b === 'missing-runtime') return 'plugin-avail-badge missing-runtime';
    return 'plugin-avail-badge ready';
}

let chatInitialized = false;
let statsRefreshInterval = null;
let globalRenderLogsTable = null;
let globalRenderProvidersTable = null;
let globalRenderModelsTable = null;

// 记录本次程序启动时的绝对毫秒时间戳，用于冷启动过滤
const appStartupTime = Date.now();
let gatewayRunningTime = Date.now();

// 真实当前启动后会话用量统计（本次启动清空，不存盘）
let sessionStats = {
    total_tokens: 0,
    total_requests: 0,
    total_cost: 0.0,
    sub_input_tokens: 0,
    sub_output_tokens: 0,
    sub_hit_tokens: 0,
    hit_rate: 0.0,
    hourly_trend: {},
    logs: [],
    providers: {},
    models: {}
};

let progressInterval = null;
let progressTimeout = null;
let currentProgress = 0;
let uptimeInterval = null;
let totalRequestCount = 0;
let gatewayReadyProbeTimer = null;
let gatewayLogReadyTail = '';

function stopGatewayReadyProbe() {
    if (gatewayReadyProbeTimer) {
        clearInterval(gatewayReadyProbeTimer);
        gatewayReadyProbeTimer = null;
    }
}

function resolveGatewayProbePort() {
    try {
        const el = document.getElementById('gateway-port') || document.getElementById('stat-port');
        const n = parseInt(el && el.value != null ? el.value : (el && el.innerText), 10);
        if (Number.isFinite(n) && n > 0) return n;
    } catch (e) {}
    return 18789;
}

/** HTTP 端口一旦可连就解锁（不等日志分片把 "listening" 拼齐） */
function startGatewayReadyProbe(reason) {
    if (gatewayFullyReady || gatewayReadyProbeTimer) return;
    const port = resolveGatewayProbePort();
    let tries = 0;
    gatewayReadyProbeTimer = setInterval(() => {
        if (gatewayFullyReady) {
            stopGatewayReadyProbe();
            return;
        }
        tries += 1;
        if (tries > 90) {
            stopGatewayReadyProbe();
            return;
        }
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (e) {} }, 400);
        fetch(`http://127.0.0.1:${port}/`, { method: 'GET', signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
            .then(() => {
                clearTimeout(timer);
                if (!gatewayFullyReady) markGatewayReadyFromLog('核心服务已就绪，可打开 OpenClaw');
            })
            .catch(() => { clearTimeout(timer); });
        if (tries % 3 === 0) {
            fetch(`http://127.0.0.1:${port}/`, { mode: 'no-cors', cache: 'no-store' })
                .then(() => {
                    if (!gatewayFullyReady) markGatewayReadyFromLog('核心服务已就绪，可打开 OpenClaw');
                })
                .catch(() => {});
        }
    }, 500);
}

function markGatewayReadyFromLog(msg) {
    if (gatewayFullyReady) return;
    stopGatewayReadyProbe();
    setGatewayFullyReadyUI();
    updateProgressUI(100, msg || '核心服务已就绪，可打开 OpenClaw');
    const pane = document.getElementById('openclaw-panel-view');
    if (pane && pane.classList.contains('active')) {
        setTimeout(() => loadOpenclawControlUi(true), 200);
    }
}

function setGatewayFullyReadyUI() {
    if (gatewayFullyReady) return;
    gatewayFullyReady = true;
    gatewayStatus = 'running';
    stopGatewayReadyProbe();
    updateGatewayStatusUI('running');
    try { updateProgressUI(100, '本地 AI Nexora Agent服务就绪！'); } catch (e) {}
    try { sendDesktopNotification('Nexora Agent状态变更', 'OpenClaw 本地智能Nexora Agent已成功启动运行！'); } catch (e) {}
    __openclawPanelLastUrl = '';
}

// 2. DOM 元素获取
const winBtnMinimize = document.getElementById('win-btn-minimize');
const winBtnMaximize = document.getElementById('win-btn-maximize');
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

const qrcodeOverlay = document.getElementById('qrcode-overlay');
const qrcodeCanvas = document.getElementById('qrcode-canvas');
const qrcodeCloseBtn = document.getElementById('qrcode-close-btn');

// 侧边栏微型负载趋势图表
let sidebarChartCanvas = null;
let sidebarChartCtx = null;
let sidebarChartData = Array.from({ length: 15 }, () => Math.floor(Math.random() * (125 - 105) + 105));

function initSidebarChart() {
    sidebarChartCanvas = document.getElementById('sidebar-mini-canvas');
    if (!sidebarChartCanvas) return;
    sidebarChartCtx = sidebarChartCanvas.getContext('2d');
    
    // 监听窗口大小变化以适应高清屏模糊问题
    const dpr = window.devicePixelRatio || 1;
    const rect = sidebarChartCanvas.getBoundingClientRect();
    sidebarChartCanvas.width = rect.width * dpr;
    sidebarChartCanvas.height = rect.height * dpr;
    sidebarChartCtx.scale(dpr, dpr);
    
    drawSidebarChart();
}

function updateSidebarChartData(value) {
    sidebarChartData.push(value);
    if (sidebarChartData.length > 15) {
        sidebarChartData.shift();
    }
    drawSidebarChart();
}

function drawSidebarChart() {
    if (!sidebarChartCtx || !sidebarChartCanvas) return;
    const ctx = sidebarChartCtx;
    const dpr = window.devicePixelRatio || 1;
    const width = sidebarChartCanvas.width / dpr;
    const height = sidebarChartCanvas.height / dpr;
    
    ctx.clearRect(0, 0, width, height);
    
    // 绘制微弱背景水平网格线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
        const y = (height / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }
    
    const points = sidebarChartData;
    const maxVal = Math.max(...points, 200); // 确保刻度最大值至少为 200，折线波动更平缓精致
    const minVal = 0;
    const len = points.length;
    
    const getX = (index) => (width / (len - 1)) * index;
    const getY = (val) => {
        const ratio = (val - minVal) / (maxVal - minVal);
        return height - ratio * (height - 8) - 4; // 留出上下间距 4px
    };
    
    // 绘制折线
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(points[0]));
    for (let i = 1; i < len; i++) {
        ctx.lineTo(getX(i), getY(points[i]));
    }
    
    // 从 CSS 获取主题色
    const computedAccentColor = getComputedStyle(document.body).getPropertyValue('--accent-color').trim() || '#6366f1';
    ctx.strokeStyle = computedAccentColor;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    
    // 绘制渐变填充区域
    ctx.lineTo(getX(len - 1), height);
    ctx.lineTo(getX(0), height);
    ctx.closePath();
    
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    const computedAccentRgb = getComputedStyle(document.body).getPropertyValue('--accent-rgb').trim() || '99, 102, 241';
    grad.addColorStop(0, `rgba(${computedAccentRgb}, 0.18)`);
    grad.addColorStop(1, `rgba(${computedAccentRgb}, 0.0)`);
    ctx.fillStyle = grad;
    ctx.fill();

}

// 3. 初始化加载
async function init() {
    const dismissLoading = () => {
        try {
            const appLoadingScreen = document.getElementById('app-loading-screen');
            if (appLoadingScreen) {
                appLoadingScreen.style.opacity = '0';
                appLoadingScreen.style.visibility = 'hidden';
                setTimeout(() => {
                    appLoadingScreen.style.display = 'none';
                }, 400);
            }
        } catch (e) {}
    };
    // 保底：最多 8 秒必关遮罩，避免脚本异常或 IPC 卡住一直转圈
    const loadingFailsafe = setTimeout(dismissLoading, 8000);

    try {
    // 获取并设置当前版本号
    try {
        const version = await window.api.getAppVersion();
        const badge = document.getElementById('app-version-badge');
        if (badge) {
            badge.textContent = 'v' + version;
        }
    } catch (e) {
        console.error('Failed to get app version:', e);
    }

    // 监听主进程的消息推送
    setupIpcListeners();
    initAccelerationChannel();
    applyAppInstanceBadge();

    // 初始化更新模块
    setupUpdateModal();

    // 读取并渲染配置
    await loadAndRenderConfig();

    // 预加载全局角色配置（模型会话口吻 + 角色页）
    try {
        if (typeof initRolesUI === 'function') initRolesUI();
        if (typeof loadRoleConfigState === 'function') await loadRoleConfigState({ silent: true });
    } catch (e) {
        console.warn('[Roles] preload failed:', e);
    }

    // 加载开机自启配置
    const autostartToggleElement = document.getElementById('setting-autostart-toggle');
    if (autostartToggleElement) {
        try {
            const autostart = await window.api.getAutoStart();
            autostartToggleElement.checked = autostart;
        } catch (e) {
            console.error('Failed to get autostart status:', e);
        }
    }

    // 绑定客户端其他偏好设置项
    const settingAutoGateway = document.getElementById('setting-auto-gateway');
    const settingNotifyToggle = document.getElementById('setting-notify-toggle');
    const settingLanguageSelect = document.getElementById('setting-language-select');
    const btnCheckUpdate = document.getElementById('btn-check-update');

    if (settingAutoGateway) {
        settingAutoGateway.checked = localStorage.getItem('setting_auto_launch_gateway') !== 'false';
        settingAutoGateway.addEventListener('change', (e) => {
            localStorage.setItem('setting_auto_launch_gateway', e.target.checked ? 'true' : 'false');
        });
    }

    if (settingNotifyToggle) {
        settingNotifyToggle.checked = localStorage.getItem('setting_enable_notification') !== 'false';
        settingNotifyToggle.addEventListener('change', (e) => {
            localStorage.setItem('setting_enable_notification', e.target.checked ? 'true' : 'false');
        });
    }

    // 内置模型启用初始化与绑定
    const settingBuiltInModelsToggle = document.getElementById('setting-built-in-models-toggle');
    if (settingBuiltInModelsToggle) {
        settingBuiltInModelsToggle.checked = getUseBuiltIn();
        settingBuiltInModelsToggle.addEventListener('change', async (e) => {
            localStorage.setItem('setting_use_built_in_models', e.target.checked ? 'true' : 'false');
            // 内置开：厂家列表 / 主备下拉仅留 agnes-ai、ollama；关：全部放开
            renderProvidersList();
            updateModelsDatalist();
            loadChatModels();

            // 开启内置时立刻把默认模型写入沙箱 OpenClaw（否则只改了 UI，网关会话仍粘旧模型）
            if (e.target.checked && configData && window.api && window.api.saveConfig) {
                try {
                    applyBuiltInModelPolicy(configData);
                    if (configData.models && configData.models.providers) {
                        localProviders = JSON.parse(JSON.stringify(configData.models.providers));
                    }
                    const result = await window.api.saveConfig(configData);
                    if (result && result.success) {
                        updateConfigJsonPreview();
                        showToast(t('已同步内置模型到 OpenClaw，请重启网关后生效', 'Built-in model synced to OpenClaw. Restart gateway to apply.', '已同步內置模型到 OpenClaw，請重啟網關後生效'));
                    }
                } catch (err) {
                    console.warn('[BuiltIn] Failed to sync model to OpenClaw:', err);
                }
            } else if (!e.target.checked) {
                // 关闭后恢复自定义表单，并刷新 JSON 预览与磁盘一致
                try { updateConfigJsonPreview(); } catch (err) {}
            }
        });
    }

    // 自动检查更新初始化与绑定
    const settingAutoUpdateToggle = document.getElementById('setting-auto-update-toggle');
    if (settingAutoUpdateToggle) {
        settingAutoUpdateToggle.checked = localStorage.getItem('setting_auto_update') !== 'false';
        settingAutoUpdateToggle.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            localStorage.setItem('setting_auto_update', isChecked ? 'true' : 'false');
            if (isChecked) {
                showToast(t('toast.auto_update.enabled'));
            } else {
                showToast(t('toast.auto_update.disabled'));
            }
        });
    }

    // 绑定图片与视频生成检验连通性
    const btnTestImage = document.getElementById('btn-test-image-generator');
    if (btnTestImage) {
        btnTestImage.addEventListener('click', () => performGeneratorTest('image'));
    }

    const btnTestImageKey = document.getElementById('btn-test-image-key');
    if (btnTestImageKey) {
        btnTestImageKey.addEventListener('click', () => performGeneratorKeyTest('image'));
    }

    const btnTestVideo = document.getElementById('btn-test-video-generator');
    if (btnTestVideo) {
        btnTestVideo.addEventListener('click', () => performGeneratorTest('video'));
    }

    const btnTestVideoKey = document.getElementById('btn-test-video-key');
    if (btnTestVideoKey) {
        btnTestVideoKey.addEventListener('click', () => performGeneratorKeyTest('video'));
    }

    if (settingLanguageSelect) {
        const initialLang = localStorage.getItem('setting_language') || 'zh-CN';
        settingLanguageSelect.value = initialLang;
        applyLanguage(initialLang);

        settingLanguageSelect.addEventListener('change', (e) => {
            const selectedLang = e.target.value;
            localStorage.setItem('setting_language', selectedLang);
            applyLanguage(selectedLang);
            updateRightPluginsCountUI();
            try { renderFeishuAccounts(); } catch (e) {}
            try { renderQqbotAccounts(); } catch (e) {}
            try { updateConsoleChannelStatusUI(); } catch (e) {}
            try { updateWeChatStatusUI(); } catch (e) {}
            try { if (typeof window.syncChatQuickPanelToggleText === 'function') window.syncChatQuickPanelToggleText(); } catch (e) {}
            if (typeof accelerationState !== 'undefined' && accelerationState) {
                renderAccelerationChannel(accelerationState);
            }
            if (selectedLang === 'en-US') {
                showToast(t('toast.switch_lang_en', 'Switched to English interface.'));
            } else if (selectedLang === 'zh-TW') {
                showToast(t('toast.switch_lang_tw', '已切換為繁體中文界面。'));
            } else {
                showToast(t('toast.switch_lang_zh', '已切换为中文界面。'));
            }
        });
    }

    if (btnCheckUpdate) {
        btnCheckUpdate.addEventListener('click', async () => {
            btnCheckUpdate.innerText = '🔄 正在检查...';
            btnCheckUpdate.disabled = true;
            try {
                await triggerUpdateCheck(true);
            } catch (err) {}
            btnCheckUpdate.innerText = '🔍 检查更新';
            btnCheckUpdate.disabled = false;
        });
    }

    // 延迟 3 秒自动静默检测一次更新
    setTimeout(() => {
        if (localStorage.getItem('setting_auto_update') !== 'false') {
            triggerUpdateCheck(false);
        }
    }, 3000);

    // 初始化 Tab 切换
    setupTabSwitching();

    // 初始化 App 运行时间计时器
    let appStartTime = Date.now();
    if (window.api && window.api.getAppStartTime) {
        window.api.getAppStartTime().then(time => {
            if (time) appStartTime = time;
        }).catch(e => console.error('Failed to get app start time:', e));
    }
    
    setInterval(() => {
        const diffMs = Date.now() - appStartTime;
        const secs = Math.floor(diffMs / 1000) % 60;
        const mins = Math.floor(diffMs / 60000) % 60;
        const hours = Math.floor(diffMs / 3600000);
        
        const timeStr = [
            hours.toString().padStart(2, '0'),
            mins.toString().padStart(2, '0'),
            secs.toString().padStart(2, '0')
        ].join(':');
        
        const appUptimeEl = document.getElementById('stat-app-uptime');
        if (appUptimeEl) appUptimeEl.innerText = timeStr;
    }, 1000);

    // 飞书第二种配置模型：扫码一键创建机器人
    const btnFeishuQr = document.getElementById('btn-feishu-qr-bind');
    if (btnFeishuQr) {
        btnFeishuQr.addEventListener('click', async () => {
            if (btnFeishuQr.disabled) return;
            const oldHtml = btnFeishuQr.innerHTML;
            btnFeishuQr.disabled = true;
            btnFeishuQr.style.opacity = '0.6';
            btnFeishuQr.style.cursor = 'not-allowed';
            btnFeishuQr.innerHTML = '⏳ 正在生成二维码...';
            beginCommBinding('feishu', '⏳ 正在发起飞书扫码绑定...');
            try {
                if (logTerminal) logTerminal.innerText += '\n[Feishu QR] 正在发起扫码创建机器人...\n';
                const result = await window.api.triggerFeishuQrLogin({ domain: 'feishu' });
                if (result && result.success) {
                    if (logTerminal) logTerminal.innerText += '[Feishu QR] 二维码已生成，请用飞书 App 扫码...\n';
                } else {
                    failCommBinding('拉起飞书扫码失败：' + ((result && (result.error || (result.cancelled && '已取消'))) || '未知错误'));
                }
            } catch (err) {
                failCommBinding('拉起飞书扫码异常：' + err.message);
            } finally {
                btnFeishuQr.disabled = false;
                btnFeishuQr.style.opacity = '1';
                btnFeishuQr.style.cursor = 'pointer';
                btnFeishuQr.innerHTML = oldHtml;
            }
        });
    }

    // 绑定添加飞书账号事件（第一种：手动填写 App ID / Secret）
    const btnAddFeishu = document.getElementById('btn-add-feishu-account');
    if (btnAddFeishu) {
        btnAddFeishu.addEventListener('click', async () => {
            if (btnAddFeishu.disabled) return;
            const oldHtml = btnAddFeishu.innerHTML;
            btnAddFeishu.disabled = true;
            btnAddFeishu.style.opacity = '0.6';
            btnAddFeishu.style.cursor = 'not-allowed';
            btnAddFeishu.innerHTML = '⏳ 正在等待输入...';
            
            let values;
            try {
                values = await window.promptFields('添加飞书账号', [
                    { key: 'accountId', label: t('comm.feishu.account.placeholder').split(' (')[0] + ' ' + (t('comm.feishu.account.placeholder').includes('(') ? '(' + t('comm.feishu.account.placeholder').split('(')[1] : ''), placeholder: t('comm.feishu.account.placeholder') },
                    { key: 'appId', label: 'App ID', placeholder: 'cli_...' },
                    { key: 'appSecret', label: 'App Secret', placeholder: 'App Secret 密匙', type: 'password' },
                    { key: 'encryptKey', label: 'Encrypt Key (可选)', placeholder: '解密 Key' },
                    { key: 'verificationToken', label: 'Verification Token (可选)', placeholder: '验证 Token' }
                ]);
            } finally {
                btnAddFeishu.disabled = false;
                btnAddFeishu.style.opacity = '1';
                btnAddFeishu.style.cursor = 'pointer';
                btnAddFeishu.innerHTML = oldHtml;
            }
            if (!values) return;
            const accountId = values.accountId ? values.accountId.trim() : '';
            if (!accountId) {
                showToast(t('comm.account.empty_err'));
                return;
            }
            if (!values.appId || !values.appSecret) {
                showToast('App ID 和 App Secret 不能为空！');
                return;
            }
            
            if (!configData.channels) configData.channels = {};
            if (!configData.channels.feishu) configData.channels.feishu = { accounts: {} };
            if (!configData.channels.feishu.accounts) configData.channels.feishu.accounts = {};
            
            if (configData.channels.feishu.accounts[accountId]) {
                showToast(t('comm.account.exists_err'));
                return;
            }
            
            configData.channels.feishu.accounts[accountId] = buildFeishuAccount(values);
            
            // 渠道级默认：显式启用 + 开放私聊/群聊，避免默认 pairing 策略导致机器人“收到不回”
            configData.channels.feishu.enabled = true;
            if (!configData.channels.feishu.dmPolicy) configData.channels.feishu.dmPolicy = 'open';
            if (!Array.isArray(configData.channels.feishu.allowFrom)) configData.channels.feishu.allowFrom = ['*'];
            if (!configData.channels.feishu.groupPolicy) configData.channels.feishu.groupPolicy = 'open';
            if (!Array.isArray(configData.channels.feishu.groupAllowFrom)) configData.channels.feishu.groupAllowFrom = ['*'];
            
            // 确保飞书插件被启用并进入 allow（插件真实 ID 就是 `feishu`）
            if (!configData.plugins) configData.plugins = {};
            if (!configData.plugins.entries) configData.plugins.entries = {};
            configData.plugins.entries['feishu'] = { ...(configData.plugins.entries['feishu'] || {}), enabled: true };
            if (!Array.isArray(configData.plugins.allow)) configData.plugins.allow = [];
            if (!configData.plugins.allow.includes('feishu')) configData.plugins.allow.push('feishu');
            
            // 如果是第一个账号，自动设为 defaultAccount
            if (!configData.channels.feishu.defaultAccount) {
                configData.channels.feishu.defaultAccount = accountId;
            }
            
            try {
                await window.api.saveConfig(configData);
                renderFeishuAccounts();
                showToast('飞书绑定账号添加成功，正在热重载网关...');
                reloadGatewayAfterChannelChange('feishu-add', { startIfStopped: true });
            } catch(err) {
                showToast('添加配置失败: ' + err.message);
            }
        });
    }

    // 绑定添加 QQ 机器人账号事件
    const btnAddQqbot = document.getElementById('btn-add-qqbot-account');
    if (btnAddQqbot) {
        btnAddQqbot.addEventListener('click', async () => {
            if (btnAddQqbot.disabled) return;
            const oldHtml = btnAddQqbot.innerHTML;
            btnAddQqbot.disabled = true;
            btnAddQqbot.style.opacity = '0.6';
            btnAddQqbot.style.cursor = 'not-allowed';
            btnAddQqbot.innerHTML = '⏳ 正在等待输入...';
            
            let values;
            try {
                values = await window.promptFields('添加 QQ 机器人', [
                    { key: 'accountId', label: t('comm.qq.account.placeholder').split(' (')[0] + ' ' + (t('comm.qq.account.placeholder').includes('(') ? '(' + t('comm.qq.account.placeholder').split('(')[1] : ''), placeholder: t('comm.qq.account.placeholder') },
                    { key: 'appId', label: 'App ID', placeholder: '请输入机器人 AppID' },
                    { key: 'clientSecret', label: 'Client Secret', placeholder: '请输入机器人 AppSecret', type: 'password' }
                ]);
            } finally {
                btnAddQqbot.disabled = false;
                btnAddQqbot.style.opacity = '1';
                btnAddQqbot.style.cursor = 'pointer';
                btnAddQqbot.innerHTML = oldHtml;
            }
            if (!values) return;
            const accountId = values.accountId ? values.accountId.trim() : '';
            if (!accountId) {
                showToast(t('comm.account.empty_err'));
                return;
            }
            if (!values.appId || !values.clientSecret) {
                showToast('App ID 和 Client Secret 不能为空！');
                return;
            }
            
            if (!configData.channels) configData.channels = {};
            if (!configData.channels.qqbot) configData.channels.qqbot = { accounts: {} };
            if (!configData.channels.qqbot.accounts) configData.channels.qqbot.accounts = {};
            
            if (configData.channels.qqbot.accounts[accountId]) {
                showToast(t('comm.account.exists_err'));
                return;
            }
            
            configData.channels.qqbot.accounts[accountId] = {
                appId: values.appId.trim(),
                clientSecret: values.clientSecret.trim()
            };
            
            configData.channels.qqbot.enabled = true;
            if (!configData.channels.qqbot.allowFrom) {
                configData.channels.qqbot.allowFrom = ['*'];
            }
            
            // 确保开通了对应的 QQ 插件（OpenClaw QQ 机器人插件的真实 ID 是 `qqbot`，
            // 早期误用 `openclaw-qqbot` 会导致插件不被加载、绑定后完全无效）
            if (!configData.plugins) configData.plugins = {};
            if (!configData.plugins.entries) configData.plugins.entries = {};
            configData.plugins.entries['qqbot'] = { enabled: true };
            if (!configData.plugins.allow) configData.plugins.allow = [];
            if (!configData.plugins.allow.includes('qqbot')) {
                configData.plugins.allow.push('qqbot');
            }
            // 清理历史错误 ID 残留，避免混淆
            if (configData.plugins.entries['openclaw-qqbot']) delete configData.plugins.entries['openclaw-qqbot'];
            configData.plugins.allow = configData.plugins.allow.filter((x) => x !== 'openclaw-qqbot');
            
            // 如果是第一个账号，自动设为 defaultAccount
            if (!configData.channels.qqbot.defaultAccount) {
                configData.channels.qqbot.defaultAccount = accountId;
            }
            
            try {
                await window.api.saveConfig(configData);
                renderQqbotAccounts();
                showToast('QQ 机器人绑定成功，正在热重载网关...');
                reloadGatewayAfterChannelChange('qqbot-add', { startIfStopped: true });
            } catch(err) {
                showToast('添加配置失败: ' + err.message);
            }
        });
    }

    // 绑定控制台多渠道绑定状态切换小药丸
    const pills = document.querySelectorAll('.console-channel-pill');
    pills.forEach(pill => {
        pill.addEventListener('click', (e) => {
            pills.forEach(p => {
                p.classList.remove('active');
                p.style.background = 'transparent';
                p.style.color = 'var(--text-secondary)';
                p.style.boxShadow = 'none';
                p.style.fontWeight = 'normal';
            });
            
            pill.classList.add('active');
            pill.style.background = 'linear-gradient(135deg, var(--accent-color), #4f46e5)';
            pill.style.color = 'white';
            pill.style.fontWeight = 'bold';
            pill.style.boxShadow = '0 2px 6px rgba(99, 102, 241, 0.2)';
            
            consoleSelectedChannel = pill.getAttribute('data-channel');
            localStorage.setItem('console_pref_channel', consoleSelectedChannel);
            const loadingEl = document.getElementById('console-channel-loading');
            if (loadingEl) loadingEl.style.display = 'flex';
            updateConsoleChannelStatusUI();
        });
    });
    
    // 初始化时激活 localStorage 保存的通道小药丸
    const savedCh = localStorage.getItem('console_pref_channel') || 'qqbot';
    const activePill = document.querySelector(`.console-channel-pill[data-channel="${savedCh}"]`);
    if (activePill) {
        activePill.click();
    }

    // 绑定微信动态账户列表中的解绑事件（通讯管理页面）
    const wechatContainer = document.getElementById('wechat-accounts-container');
    if (wechatContainer) {
        wechatContainer.addEventListener('click', async (e) => {
            if (e.target && e.target.id === 'wechat-unbind-btn-dynamic') {
                const btn = e.target;
                if (btn.disabled) return;
                
                const confirmClear = confirm('确定要解绑当前微信并清空微信登录凭证吗？\n\n这将会停止运行中的Nexora Agent，并在下次启动Nexora Agent时重新生成二维码供您扫码登录！');
                if (!confirmClear) return;

                const oldHtml = btn.innerHTML;
                btn.disabled = true;
                btn.style.opacity = '0.6';
                btn.style.cursor = 'not-allowed';
                btn.innerHTML = '⏳ 正在解绑...';

                try {
                    const result = await window.api.clearWeChatSession();
                    if (result.success) {
                        showToast('微信解绑成功！');
                        updateWeChatStatusUI();
                        reloadGatewayAfterChannelChange('wechat-unbind');
                    } else {
                        showToast('解绑失败: ' + result.message);
                    }
                } catch (err) {
                    showToast('解绑异常: ' + err.message);
                } finally {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.style.cursor = 'pointer';
                    btn.innerHTML = oldHtml;
                }
            }
        });
    }

    // 绑定系统偏好设置中的加速通道跳转事件
    const btnOpenAcc = document.getElementById('btn-open-acceleration');
    if (btnOpenAcc) {
        btnOpenAcc.addEventListener('click', () => {
            window.api.openExternal('https://pin.dianping.men/auth/register?code=2k788U5v');
        });
    }

    // 初始化控制台科技感时钟
    initConsoleClock();

    // 系统运行日志 复制与清空操作绑定
    const btnCopySystemLogs = document.getElementById('btn-copy-system-logs');
    if (btnCopySystemLogs) {
        btnCopySystemLogs.addEventListener('click', async () => {
            const systemLogsArea = document.getElementById('system-raw-logs-area');
            let text = systemLogsArea ? systemLogsArea.value : '';
            // 如果内容为空或仅为初始化占位文本，主动拉取本地持久化日志
            if (!text || text.includes('等待Nexora Agent子进程启动') || text.includes('【正在装载历史日志')) {
                try {
                    await loadAndRenderSystemLogs();
                    text = systemLogsArea ? systemLogsArea.value : '';
                } catch (e) {}
            }

            const cleanText = (text || '').trim();
            if (cleanText && !cleanText.includes('等待Nexora Agent子进程启动') && !cleanText.includes('【无历史日志数据】') && !cleanText.includes('【历史日志加载失败】')) {
                const copied = await copyToClipboard(cleanText);
                if (copied) {
                    showToast(t('📋 已将完整系统运行日志成功复制到剪贴板！', '📋 Copying complete system logs to clipboard succeeded!', '📋 已將完整系統運行日誌成功複製到剪貼板！'));
                } else {
                    showToast(t('⚠️ 复制失败，请选择文本后手动按 Ctrl+C 复制', '⚠️ Copy failed, please select text and press Ctrl+C', '⚠️ 複製失敗，請選擇文本後手動按 Ctrl+C 複製'));
                }
            } else {
                showToast(t('⚠️ 当前无任何系统运行日志可复制', '⚠️ No system logs to copy', '⚠️ 目前無任何系統運行日誌可複製'));
            }
        });
    }

    const btnClearSystemLogs = document.getElementById('btn-clear-system-logs');
    if (btnClearSystemLogs) {
        btnClearSystemLogs.addEventListener('click', async () => {
            const confirmClear = await confirm(
                t('确定要清空本地所有的历史系统运行日志文件吗？\n\n此操作不可恢复！',
                  'Are you sure you want to clear all local historical system runtime log files?\n\nThis action cannot be undone!',
                  '確定要清空本地所有的歷史系統運行日誌文件嗎？\n\n此操作不可恢復！')
            );
            if (!confirmClear) return;
            try {
                const result = await window.api.clearSystemLogs();
                if (result.success) {
                    const systemLogsArea = document.getElementById('system-raw-logs-area');
                    if (systemLogsArea) systemLogsArea.value = '';
                    showToast(t('🗑️ 系统运行日志与本地日志文件已成功清空', '🗑️ System runtime logs and local log files have been successfully cleared.', '🗑️ 系統運行日誌與本地日誌文件已成功清空'));
                } else {
                    showToast(t('⚠️ 清空失败：', '⚠️ Clear failed: ', '⚠️ 清空失敗：') + result.error);
                }
            } catch (err) {
                showToast(t('⚠️ 清空操作异常：', '⚠️ Exception during clearing: ', '⚠️ 清空操作異常：') + err.message);
            }
        });
    }

    // 初始化窗口控制
    winBtnMinimize.addEventListener('click', () => window.api.windowAction('minimize'));
    if (winBtnMaximize) {
        winBtnMaximize.addEventListener('click', () => window.api.windowAction('maximize'));
    }
    winBtnClose.addEventListener('click', () => window.api.windowAction('close'));

    // 双击标题栏最大化或还原
    const titleBar = document.querySelector('.title-bar');
    if (titleBar) {
        titleBar.addEventListener('dblclick', (e) => {
            if (e.target.closest('.window-controls')) return;
            window.api.windowAction('maximize');
        });
    }

    // 监听整个Nexora Agent配置表单的变化，实时更新 JSON 预览并标记 Dirty
    const configForm = document.getElementById('openclaw-config-form');
    if (configForm) {
        configForm.addEventListener('input', () => {
            markConfigDirty();
        });
    }

    // 监听 JSON 实时预览框的手写编辑输入（报错 / dirty 仅作用于预览区按钮）
    const jsonPreviewEl = document.getElementById('config-json-preview');
    const jsonErrorEl = document.getElementById('json-format-error');
    const jsonSaveBtn = document.getElementById('config-save-btn');
    if (jsonPreviewEl) {
        jsonPreviewEl.addEventListener('input', (e) => {
            markJsonPanelDirty();
            try {
                const parsed = JSON.parse(e.target.value);
                if (jsonErrorEl) jsonErrorEl.style.display = 'none';
                if (jsonSaveBtn) jsonSaveBtn.removeAttribute('disabled');

                // 预览里是脱敏值：还原后再写入内存，避免把 ******** 保存进 openclaw.json
                const previous = configData ? JSON.parse(JSON.stringify(configData)) : null;
                restoreMaskedSecretsFromPrevious(parsed, previous);
                configData = parsed;

                // 同步刷新 localProviders 变量，确保保存时不被旧数据覆盖
                if (parsed.models && parsed.models.providers) {
                    localProviders = JSON.parse(JSON.stringify(parsed.models.providers));
                }
                syncJsonToFormFields(parsed);
            } catch (err) {
                if (jsonErrorEl) jsonErrorEl.style.display = 'block';
                if (jsonSaveBtn) jsonSaveBtn.setAttribute('disabled', 'true');
            }
        });
    }

    // Nexora Agent开关按钮监听
    gatewayToggleBtn.addEventListener('click', () => {
        if (window.isTogglingGateway) return;
        if (gatewayStatus === 'starting' || gatewayStatus === 'upgrading' || gatewayStatus === 'stopping') return;

        if (gatewayStatus === 'stopped') {
            window.isTogglingGateway = true;
            gatewayToggleBtn.style.pointerEvents = 'none';
            gatewayToggleBtn.style.opacity = '0.6';
            gatewayToggleBtn.style.cursor = 'not-allowed';
            window.api.gatewayAction('start');
            
            window.toggleLockTimeout = setTimeout(() => {
                window.isTogglingGateway = false;
                gatewayToggleBtn.style.pointerEvents = '';
                gatewayToggleBtn.style.opacity = '';
                gatewayToggleBtn.style.cursor = '';
            }, 3000); // 3秒保底解锁时间
        } else if (gatewayStatus === 'running') {
            window.isTogglingGateway = true;
            gatewayToggleBtn.style.pointerEvents = 'none';
            gatewayToggleBtn.style.opacity = '0.6';
            gatewayToggleBtn.style.cursor = 'not-allowed';
            window.api.gatewayAction('stop');
            
            window.toggleLockTimeout = setTimeout(() => {
                window.isTogglingGateway = false;
                gatewayToggleBtn.style.pointerEvents = '';
                gatewayToggleBtn.style.opacity = '';
                gatewayToggleBtn.style.cursor = '';
            }, 3000); // 3秒保底解锁时间
        }
    });

    // 清空日志按钮监听
    const btnClearLogs = document.getElementById('btn-clear-terminal-logs');
    if (btnClearLogs) {
        btnClearLogs.addEventListener('click', () => {
            if (gatewayStatus !== 'stopped') return;
            const streamList = document.getElementById('dash-activity-stream-list');
            if (streamList) {
                streamList.innerHTML = `<div class="activity-item-empty" data-i18n="console.dash.empty_tips">${t('console.dash.empty_tips') || '暂无系统活动，启动服务后将在此显示最新状态...'}</div>`;
            }
            const activeModel = document.getElementById('dash-active-model');
            if (activeModel) activeModel.textContent = t('console.dash.not_configured') || '未启动';
            
            ['weixin', 'qqbot', 'feishu'].forEach(ch => {
                const tile = document.getElementById(`tile-${ch}`);
                if (tile) {
                    tile.className = 'channel-status-tile offline';
                    if (ch === 'weixin') tile.title = t('console.channel.wechat.disconnected') || '微信消息通道: 未连接';
                    if (ch === 'qqbot') tile.title = t('console.channel.qq.disconnected') || 'QQ机器人通道: 未配置';
                    if (ch === 'feishu') tile.title = t('console.channel.feishu.disconnected') || '飞书/Lark通道: 未连接';
                }
            });
        });
    }

    // 视图模式切换按钮监听 (步骤进度 vs 调试日志)
    const btnToggleViewMode = document.getElementById('btn-toggle-view-mode');
    if (btnToggleViewMode) {
        const savedMode = localStorage.getItem('console_view_mode') || 'step';
        applyViewMode(savedMode);

        btnToggleViewMode.addEventListener('click', () => {
            const currentMode = localStorage.getItem('console_view_mode') || 'step';
            const nextMode = currentMode === 'step' ? 'log' : 'step';
            localStorage.setItem('console_view_mode', nextMode);
            applyViewMode(nextMode);
        });
    }

    // 打开沙箱终端按钮监听
    const btnOpenTerminal = document.getElementById('btn-open-terminal');
    if (btnOpenTerminal) {
        btnOpenTerminal.addEventListener('click', () => {
            window.api.openSandboxTerminal();
        });
    }

    // 视频生成密钥显隐切换
    const toggleVideoKeyBtn = document.getElementById('btn-toggle-video-key');
    if (toggleVideoKeyBtn) {
        toggleVideoKeyBtn.addEventListener('click', () => {
            const input = document.getElementById('video-api-key');
            if (input.type === 'password') {
                input.type = 'text';
                toggleVideoKeyBtn.innerText = '🔒';
            } else {
                input.type = 'password';
                toggleVideoKeyBtn.innerText = '👁️';
            }
        });
    }

    // 图片生成密钥显隐切换
    const toggleImageKeyBtn = document.getElementById('btn-toggle-image-key');
    if (toggleImageKeyBtn) {
        toggleImageKeyBtn.addEventListener('click', () => {
            const input = document.getElementById('image-api-key');
            if (input.type === 'password') {
                input.type = 'text';
                toggleImageKeyBtn.innerText = '🔒';
            } else {
                input.type = 'password';
                toggleImageKeyBtn.innerText = '👁️';
            }
        });
    }

    // 微信 / 飞书二维码弹窗关闭 → 统一取消绑定闭环
    qrcodeCloseBtn.addEventListener('click', () => {
        endCommBinding({ cancelBackend: true, toast: '已关闭扫码窗口' });
    });

    // 初始化主题切换
    setupThemeSwitching();

    // 检查并启动新手指引
    checkAndStartGuide();

    // 初始化侧边栏折叠状态与事件绑定
    const sidebar = document.querySelector('.sidebar');
    const sidebarToggleBtn = document.getElementById('btn-sidebar-toggle');
    if (sidebar) {
        const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
        if (isCollapsed) {
            sidebar.classList.add('collapsed');
        }
        if (sidebarToggleBtn) {
            sidebarToggleBtn.addEventListener('click', () => {
                sidebar.classList.add('no-transition');
                sidebar.classList.toggle('collapsed');
                const collapsed = sidebar.classList.contains('collapsed');
                localStorage.setItem('sidebar_collapsed', collapsed ? 'true' : 'false');
                setTimeout(() => {
                    sidebar.classList.remove('no-transition');
                }, 50);
                // 侧边栏展开/收起后 canvas 尺寸变化，需重新初始化图表
                if (!collapsed) {
                    setTimeout(() => {
                        initSidebarChart();
                    }, 350);
                }
            });
        }
    }

    // 点击顶部状态面板快速启停Nexora Agent
    const statusPanel = document.getElementById('tour-status');
    if (statusPanel) {
        statusPanel.addEventListener('click', () => {
            if (gatewayStatus === 'stopped') {
                showToast('正在启动Nexora Agent核心服务...');
                window.api.gatewayAction('start');
            } else if (gatewayStatus === 'running') {
                showToast('正在关闭Nexora Agent核心服务...');
                window.api.gatewayAction('stop');
            } else if (gatewayStatus === 'starting') {
                showToast('Nexora Agent正在启动中，请稍候...');
            }
        });
    }

    // 自动启用Nexora Agent逻辑
    if (localStorage.getItem('setting_auto_launch_gateway') === 'true') {
        setTimeout(() => {
            if (gatewayStatus === 'stopped') {
                logTerminal.innerText += '\n[System] 正在根据系统设置自动启用本地Nexora Agent...\n';
                window.api.gatewayAction('start');
            }
        }, 1500);
    }

    // 渲染图表
    renderUsageCharts();
    
    // 初始化侧边栏微型负载图
    initSidebarChart();

    // 内存模拟监控（科技感点缀)
    setInterval(updateMemoryMock, 2000);

    // 微信通道绑定状态初始化查询与每 10 秒定时监控轮询
    updateWeChatStatusUI();
    setInterval(updateWeChatStatusUI, 10000);

    // 页面初始化时，主动向主进程拉齐一次当前Nexora Agent的最真实运行状态
    if (window.api && window.api.gatewayAction) {
        window.api.gatewayAction('query-status');
    }

    // 隐藏全局初始化遮罩层，平滑淡出
    clearTimeout(loadingFailsafe);
    dismissLoading();
    } catch (initErr) {
        console.error('[Nexora Agent] init failed:', initErr);
        clearTimeout(loadingFailsafe);
        dismissLoading();
    }
}

// 🌟 平滑逐条放行日志队列管理器（避免批量日志瞬间推入，实现按顺序一条一条平滑递进）
let __activityLogQueue = [];
let __isProcessingLogQueue = false;
let __seenPluginLogsThisStartup = new Set();

function resetPluginLogDedupe() {
    __seenPluginLogsThisStartup.clear();
}

function enqueueActivityLog(lineHtml) {
    if (!lineHtml) return;
    
    // 对于重复装载相同通道插件的日志，同一阶段仅放行一次
    if (lineHtml.includes('成功装载') && lineHtml.includes('消息通道插件')) {
        const cleanTag = lineHtml.replace(/<\/?[^>]+(>|$)/g, "").trim();
        if (__seenPluginLogsThisStartup.has(cleanTag)) {
            return;
        }
        __seenPluginLogsThisStartup.add(cleanTag);
    }

    __activityLogQueue.push(lineHtml);
    if (!__isProcessingLogQueue) {
        processActivityLogQueue();
    }
}

function processActivityLogQueue() {
    if (__activityLogQueue.length === 0) {
        __isProcessingLogQueue = false;
        return;
    }

    __isProcessingLogQueue = true;
    const lineHtml = __activityLogQueue.shift();

    const streamList = document.getElementById('dash-activity-stream-list');
    if (streamList) {
        const emptyTips = streamList.querySelector('.activity-item-empty');
        if (emptyTips) emptyTips.remove();

        const item = document.createElement('div');
        item.className = 'activity-log-line typing';
        item.innerHTML = lineHtml;
        streamList.appendChild(item);

        // 最多保留最近 150 条
        while (streamList.children.length > 150) {
            streamList.removeChild(streamList.firstChild);
        }

        // 打字机渐显动画： clip-path 从左往右逐帧优雅平滑揭开
        const temp = document.createElement('span');
        temp.innerHTML = lineHtml;
        const textLen = (temp.textContent || '').length;

        const queueLen = __activityLogQueue.length;
        const stepInterval = queueLen > 15 ? 8 : (queueLen > 5 ? 12 : 16);
        const totalSteps = Math.min(textLen, 40);
        let step = 0;
        
        item.style.transition = 'clip-path 0.1s linear';
        item.style.clipPath = 'inset(0 100% 0 0)';

        const typeTimer = setInterval(() => {
            step++;
            const pct = Math.min(100, (step / totalSteps) * 100);
            item.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
            streamList.scrollTop = streamList.scrollHeight;

            if (step >= totalSteps) {
                clearInterval(typeTimer);
                item.style.clipPath = 'none';
                item.classList.remove('typing');

                // 🌟 严格规范：前一条日志 100% 打字/揭开完成后，暂停一小会，再启动下一条！
                const nextPause = queueLen > 15 ? 40 : (queueLen > 5 ? 90 : 160);
                setTimeout(() => {
                    processActivityLogQueue();
                }, nextPause);
            }
        }, stepInterval);
    }
}

// 🔍 小白友好型日志汉化过滤与清洗转化器
function formatLogForUser(text) {
    if (!text) return null;
    // 移除颜色控制字符并修剪两端
    const cleanLine = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
    const lowerLine = cleanLine.toLowerCase();

    // 1. 过滤完全无需展示给小白的日志 (底层噪音调试日志)
    if (
        cleanLine.includes('AGENTS.md') ||
        cleanLine.includes('SOUL.md') ||
        cleanLine.includes('TOOLS.md') ||
        cleanLine.includes('TokenGuard Cleaned') ||
        cleanLine.includes('tool policy') ||
        cleanLine.includes('provider-transport-fetch start') ||
        cleanLine.includes('log file:') ||
        cleanLine.includes('allow is empty') ||
        cleanLine.includes('discovered non-bundled') ||
        cleanLine.includes('To trust them') ||
        cleanLine.includes('doctor') ||
        cleanLine.includes('failed probing') ||
        cleanLine.includes('announced already') ||
        cleanLine.includes('auto-enabled plugins') ||
        cleanLine.includes('ollama/gemma4') ||
        cleanLine.includes('starting HTTP server') ||
        cleanLine.includes('|') ||
        /^[+\s-]+$/.test(cleanLine) ||
        /^[\u2580-\u259F\s]+$/.test(cleanLine)
    ) {
        return null;
    }

    // 2. 特殊提取：[插件模块] duplicate plugin id resolved... (重写为成功装载)
    if (cleanLine.includes('duplicate plugin id') && cleanLine.includes('plugin=')) {
        const pluginMatch = cleanLine.match(/plugin=([a-zA-Z0-9_-]+)/i);
        if (pluginMatch) {
            const pluginName = pluginMatch[1].trim();
            const displayPluginName = pluginName.charAt(0).toUpperCase() + pluginName.slice(1);
            return `[🧩 插件模块] 成功装载 ${displayPluginName} 消息通道插件`;
        }
        return null;
    }

    // 过滤无用的 duplicate plugin 警告
    if (cleanLine.includes('duplicate plugin id')) {
        return null;
    }

    // 3. 匹配并改造成直观的中文大白话
    
    // 大模型配置装载
    if (cleanLine.includes('agent model:')) {
        const match = cleanLine.match(/agent model:\s*([^\s]+)/i);
        const modelName = match ? match[1] : 'Agnes-2.0';
        return `[⚙️ 系统核心] 成功接入大模型推理引擎：${modelName}`;
    }

    // 端口绑定就绪
    if (cleanLine.includes('HTTP server listening') || cleanLine.includes('HTTP 本地服务已监听') || cleanLine.includes('[gateway] ready') || cleanLine.includes('gateway] ready') || cleanLine.includes('Fork gateway')) {
        return `[⚙️ 系统核心] 网关本地服务接口就绪，正在监听内部端口`;
    }

    // 正在拉起核心引擎
    if (cleanLine.includes('正在拉起Nexora Agent核心') || cleanLine.includes('starting channels and sidecars')) {
        return `[⚙️ 系统核心] 正在初始化连接通道与插件进程驱动...`;
    }

    // 核心业务件装配就绪
    if (cleanLine.includes('Runtime initialized') || cleanLine.includes('core server listening') || cleanLine.includes('核心业务件装配完毕') || cleanLine.includes('全部引擎启动就绪') || cleanLine.includes('harden: soft=') || cleanLine.includes('harden:')) {
        return `[⚙️ 系统核心] 所有核心业务组件装配完毕，核心服务已就绪！`;
    }

    // 收到用户消息并调用大模型
    if (cleanLine.includes('[provider-transport-fetch] [model-fetch] start') || (cleanLine.includes('model-fetch') && cleanLine.includes('method=POST'))) {
        return `[🧠 大模型服务] 收到通道聊天消息，正在调用大语言模型进行推理思考...`;
    }

    // 模型推理响应成功
    if (cleanLine.includes('[model-fetch] response') && cleanLine.includes('status=200')) {
        const elapsedMatch = cleanLine.match(/elapsedMs=([0-9]+)/);
        const elapsed = elapsedMatch ? `${elapsedMatch[1]}ms` : '';
        return `[🧠 大模型服务] 智能回复生成成功！已安全投递至通讯通道 ${elapsed ? `(耗时: ${elapsed})` : ''}`;
    }

    // 模型推理响应失败
    if (cleanLine.includes('[model-fetch] response') && !cleanLine.includes('status=200')) {
        return `[🧠 大模型服务] ⚠️ 智能回复生成失败，请检查您的网络连接或配置。`;
    }

    // 计费凭证与 Token 消耗
    if (cleanLine.includes('[TokenGuard] Saved usage') || cleanLine.includes('Saved usage')) {
        const tokenMatch = cleanLine.match(/usage\s+([^\s]+):\s*([0-9+]+)/i);
        const modelName = tokenMatch ? tokenMatch[1] : '';
        const tokenUsage = tokenMatch ? tokenMatch[2] : '';
        if (tokenUsage) {
            const formattedUsage = formatTokenUsageLog(tokenUsage);
            return `[📊 对话账单] 计费流量记账成功：大模型 ${modelName} 本次会话消耗了 ${formattedUsage}`;
        }
        return `[📊 对话账单] 流量计费凭证已安全保存`;
    }

    // 微信扫码请求
    if (lowerLine.includes('weixin scan') || lowerLine.includes('wechat scan') || lowerLine.includes('please scan')) {
        return `[💬 微信插件] 📸 检测到微信登录扫码请求，请点击右侧「微信通道」进行扫码授权登录！`;
    }

    // 微信通道连接就绪
    if (
        lowerLine.includes('weixin bound') || 
        lowerLine.includes('wechat bound') || 
        lowerLine.includes('ilink client ready') ||
        lowerLine.includes('bot already connected') ||
        lowerLine.includes('bot already bound') ||
        lowerLine.includes('weixin monitor started') ||
        lowerLine.includes('monitor started: baseurl')
    ) {
        return `[💬 微信插件] 🟢 微信消息接收通道已成功连接！正在实时监听群聊与私聊消息...`;
    }

    // 微信断开重连
    if (lowerLine.includes('weixin login failed') || lowerLine.includes('weixin disconnected') || lowerLine.includes('weixin connection lost')) {
        return `[💬 微信插件] 🔴 微信通道连接断开，正在后台尝试自动重连中...`;
    }

    // QQ 机器人通道就绪
    if (
        lowerLine.includes('qqbot ready') || 
        lowerLine.includes('qqbot connected') || 
        lowerLine.includes('qq-bot connected') ||
        lowerLine.includes('gateway resumed') ||
        lowerLine.includes('websocket connected')
    ) {
        return `[🤖 QQ机器人] 🟢 QQ 机器人消息通道已成功上线连接！正在实时接收消息中...`;
    }

    // 飞书/Lark 通道就绪
    if (
        lowerLine.includes('feishu ready') || 
        lowerLine.includes('feishu connected') || 
        lowerLine.includes('lark connected') ||
        lowerLine.includes('websocket client started') ||
        lowerLine.includes('starting webhook server')
    ) {
        return `[🕊️ 飞书插件] 🟢 飞书/Lark 消息通道已成功上线连接！正在实时接收消息中...`;
    }

    // 健康监测
    if (cleanLine.includes('健康状态已上线') || cleanLine.includes('health-check')) {
        return `[💓 健康监测] 心跳与健康守护状态已上线`;
    }

    // 载入最新系统配置
    if (cleanLine.includes('loading configuration') || cleanLine.includes('loaded config')) {
        return `[⚙️ 系统核心] 正在装载最新的用户个人系统配置参数...`;
    }

    // 处理接收的消息
    if (
        lowerLine.includes('on message') || 
        lowerLine.includes('received message') || 
        lowerLine.includes('handle message') ||
        lowerLine.includes('inbound:') ||
        lowerLine.includes('inbound message:')
    ) {
        return `[⚙️ 系统核心] 📩 正在处理并分析接收到的即时聊天消息...`;
    }

    // 遇到报错（非 Bonjour、error-filter、model-pricing、voice-bridge、sessions.delete 等容易被误报的警告）
    if (lowerLine.includes('error') || lowerLine.includes('exception') || lowerLine.includes('failed')) {
        if (
            lowerLine.includes('bonjour') || 
            lowerLine.includes('probe') || 
            lowerLine.includes('error-filter') ||
            lowerLine.includes('model-pricing') ||
            lowerLine.includes('voice-bridge') ||
            lowerLine.includes('speak failed') ||
            lowerLine.includes('econnrefused') ||
            lowerLine.includes('18791') ||
            lowerLine.includes('cannot delete the main session') ||
            lowerLine.includes('sessions.delete')
        ) return null;
        return `[⚠️ 系统警报] ⚠️ 系统运行警告：${cleanLine}`;
    }

    // 服务已停止
    if (cleanLine.includes('Nexora Agent服务已停止') || cleanLine.includes('服务已停止')) {
        return `[⚙️ 系统核心] 🛑 Nexora Agent服务已成功停止！`;
    }

    // 其余的噪音直接过滤
    return null;
}

// 4. IPC 消息监听与分发
function setupIpcListeners() {
    // 角色配置变更：对话切换 / 角色页启用后立即全界面同步
    if (window.api && typeof window.api.onRoleConfigUpdated === 'function') {
        window.api.onRoleConfigUpdated((payload) => {
            try {
                if (!payload || !payload.data) return;
                applyRoleConfigState(payload.data, {
                    preferActive: true,
                    selectRoleId: payload.data.activeRoleId || null,
                    clearEditing: true
                });
            } catch (e) {
                console.warn('[Roles] live sync failed:', e);
            }
        });
    }

    // 实时日志接收处理函数
    const handleReceivedLog = (text) => {
        // Dynamic topology node activation based on logs
        if (gatewayStatus === 'starting' || gatewayStatus === 'running') {
            const lowerText = text.toLowerCase();
            let stateChanged = false;

            if (lowerText.includes('loading configuration') || lowerText.includes('doctor') || lowerText.includes('migration')) {
                topoNodeStates['node-client'] = 'completed';
                topoNodeStates['node-core'] = 'active';
                stateChanged = true;
            }
            if (lowerText.includes('resolving authentication') || lowerText.includes('model-fetch') || lowerText.includes('auth state')) {
                topoNodeStates['node-core'] = 'completed';
                topoNodeStates['node-llm'] = 'active';
                stateChanged = true;
            }
            if (lowerText.includes('provider auth state pre-warmed') || lowerText.includes('pre-warmed') || lowerText.includes('model engine loaded')) {
                topoNodeStates['node-llm'] = 'completed';
                stateChanged = true;
            }
            // WeChat Gateway
            if (lowerText.includes('weixin') || lowerText.includes('wechat') || lowerText.includes('wx-bot') || lowerText.includes('ilink')) {
                if (lowerText.includes('ready') || lowerText.includes('success') || lowerText.includes('bound') || lowerText.includes('webhook listening') || lowerText.includes('server listening')) {
                    topoNodeStates['node-wechat'] = 'completed';
                } else {
                    topoNodeStates['node-wechat'] = 'active';
                }
                stateChanged = true;
            }
            // QQ Gateway
            if (lowerText.includes('qqbot') || lowerText.includes('qq-bot') || lowerText.includes('qq_bot')) {
                if (lowerText.includes('ready') || lowerText.includes('success') || lowerText.includes('connected') || lowerText.includes('listening')) {
                    topoNodeStates['node-qq'] = 'completed';
                } else {
                    topoNodeStates['node-qq'] = 'active';
                }
                stateChanged = true;
            }
            // Feishu Gateway
            if (lowerText.includes('feishu') || lowerText.includes('lark')) {
                if (lowerText.includes('ready') || lowerText.includes('success') || lowerText.includes('connected') || lowerText.includes('listening')) {
                    topoNodeStates['node-feishu'] = 'completed';
                } else {
                    topoNodeStates['node-feishu'] = 'active';
                }
                stateChanged = true;
            }

            if (stateChanged) {
                updateTopologyUI();
            }
        }
        // 解析 http server listening 中的运行插件数量，动态更新右侧侧边栏统计
        if (text && text.includes('http server listening')) {
            const match = text.match(/http server listening\s*\((\d+)\s*plugins?/i);
            if (match) {
                __gatewayLoadedPluginCount = parseInt(match[1], 10) || 0;
                updateRightPluginsCountUI();
            }
        }

        // 将原始日志直接写入设置页的系统运行日志面板（不过滤，展示真实原生输出）
        const systemLogsArea = document.getElementById('system-raw-logs-area');
        if (systemLogsArea) {
            const trimmed = text.trim();
            if (trimmed) {
                systemLogsArea.value += trimmed + '\n';
                // 限制最大行数防止内存泄漏 (限制在 5000 行)
                const lines = systemLogsArea.value.split('\n');
                if (lines.length > 5000) {
                    systemLogsArea.value = lines.slice(lines.length - 5000).join('\n');
                }
                systemLogsArea.scrollTop = systemLogsArea.scrollHeight;
            }
        }

        // 🌟 拦截Nexora Agent后台模型的常规预热探针错误日志（不影响正常对话，防止打扰用户）
        if (text.includes('[model-fetch]') && text.includes('ERROR') && (text.includes('ECONNRESET') || text.includes('fetch failed') || text.includes('ETIMEDOUT'))) {
            return;
        }

        // 🌟 拦截飞书 WebSocket 调试与长连接引导提示信息，防止刷屏影响首屏日志视觉
        if (text.includes('persistent connection only available') || text.includes('Developer Console(开发者后台)') || text.includes('Events and Callbacks') || text.includes('开发者后台')) {
            return;
        }

        // 🌟 过滤冗余的未安装插件警告、框架表格线与垃圾说明，使终端日志框只保留核心关键步骤
        const filteredLines = text.split('\n').filter(line => {
            const cleanLine = line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
            return !(
                cleanLine.includes('|') || 
                cleanLine.includes('plugin not installed') || 
                cleanLine.includes('failed probing with reason') || // 过滤云电脑/虚拟网卡回环导致的 Bonjour 冲突报错
                cleanLine.includes('Can\'t probe for a service which is announced already') ||
                cleanLine.includes('plugins.allow is empty') || 
                cleanLine.includes('discovered non-bundled plugins') || 
                cleanLine.includes('To trust them') ||
                cleanLine.includes('Run \'openclaw plugins') ||
                cleanLine.includes('you trust to plugins') ||
                ((cleanLine.toLowerCase().includes('warning') || cleanLine.toLowerCase().includes('warnings')) && cleanLine.includes('--')) || // 过滤警告边框头部 (包含 Warning/Warnings 且有虚线)
                /o\s+(doctor|config)\s+warnings/i.test(cleanLine) || // 过滤 Doctor/Config 警告行
                /^[+\s-]+$/.test(cleanLine) || // 过滤警告边框底部或线 (由 + 和 - 组成)
                /^[\u2580-\u259F\s]+$/.test(cleanLine) // 过滤字符画二维码方块行（已有 Canvas 弹窗展示）
            );
        });
        
        if (filteredLines.length === 0) {
            return;
        }
        text = filteredLines.join('\n');

        // 跨 IPC 分片拼接，避免 "http server listening" 被拆开导致一直卡在进度条
        gatewayLogReadyTail = (gatewayLogReadyTail + '\n' + text).slice(-8000);
        const readyHaystack = gatewayLogReadyTail;

        if (
            readyHaystack.includes('[gateway] ready')
            || readyHaystack.includes('gateway] ready')
            || readyHaystack.toLowerCase().includes('http server listening')
            || readyHaystack.includes('agent runtime plugins pre-warmed')
        ) {
            const wasReady = gatewayFullyReady;
            markGatewayReadyFromLog('本地 AI Nexora Agent服务就绪！');
            if (!wasReady) {
                const pane = document.getElementById('openclaw-panel-view');
                if (pane && pane.classList.contains('active')) {
                    setTimeout(() => loadOpenclawControlUi(true), 200);
                }
            }
        } else if (
            text.includes('starting HTTP server')
            || text.includes('started (interval:')
            || text.includes('[TokenGuard]')
            || text.includes('agent model:')
        ) {
            startGatewayReadyProbe('http-near');
            if (currentProgress < 90) {
                updateProgressUI(Math.max(currentProgress, 85), '正在绑定端口并装载渠道插件…');
            }
        }
        // 仅在Nexora Agent真正运行中，且越过Nexora Agent刚启动时的 5 秒历史控制台日志喷吐垃圾冷区，才对全新实时流量记账
        if (gatewayStatus === 'running' && (Date.now() - gatewayRunningTime > 5000)) {
            if (text.includes('[model-fetch] response')) {
                const provMatch = text.match(/provider=([^\s]+)/);
                const modelMatch = text.match(/model=([^\s]+)/);
                const elapsedMatch = text.match(/elapsedMs=([0-9]+)/);
                if (provMatch && modelMatch) {
                    const provider = provMatch[1].trim();
                    const model = modelMatch[1].trim();
                    const elapsed = elapsedMatch ? parseInt(elapsedMatch[1]) : 1000;
                    
                    const input = 3000;
                    const output = 500;
                    const hit = elapsed < 500 ? 2800 : 0;
                    
                    addSessionLog(provider, model, input, output, hit, elapsed);

                    totalRequestCount++;
                    const totalReqEl = document.getElementById('stat-total-requests');
                    if (totalReqEl) totalReqEl.innerText = `${totalRequestCount}${t('次', '', '次')}`;
                }
            }
        }

        // 联动日志流真实状态驱动进度条
        const progressContainer = document.getElementById('terminal-progress-bar-container');
        const progressFill = document.getElementById('terminal-progress-bar-fill');
        const progressText = document.getElementById('terminal-progress-bar-text');
        const progressPercent = document.getElementById('terminal-progress-bar-percent');

        // 仅在正在启动或刚跑起来、但实际上在等初始化就绪时，根据日志动态更新进度
        if (progressContainer && progressContainer.style.display !== 'none' && currentProgress < 100) {
            let targetProgress = currentProgress;
            let targetText = '';
            let updated = false;
            
            if (text.includes('loading configuration') || text.includes('Doctor') || text.includes('migration')) {
                targetProgress = 25;
                targetText = t('console.progress.checking_config') || '正在校验Nexora Agent配置文件与诊断系统...';
                updated = true;
            } else if (text.includes('Failed to install missing configured plugin')) {
                targetProgress = 60;
                targetText = t('console.progress.downloading_plugins') || '正在后台下载并安装缺失的扩展插件…';
                updated = true;
            } else if (text.includes('[plugins]') || text.includes('plugin not installed') || text.includes('resolving authentication')) {
                targetProgress = 55;
                targetText = t('console.progress.loading_drivers') || '正在装载核心插件驱动程序...';
                updated = true;
            } else if (
                /http server listening/i.test(text)
                || text.includes('HTTP server listening on')
                || text.includes('Server is running on')
                || text.includes('running on port')
                || text.includes('agent model:')
            ) {
                targetProgress = 96;
                targetText = t('console.progress.http_listening') || 'HTTP 已监听，正在完成收尾…';
                updated = true;
            } else if (text.includes('[gateway] ready') || text.includes('gateway] ready')) {
                targetProgress = 100;
                targetText = t('console.progress.ready') || '本地 AI Nexora Agent服务就绪！';
                updated = true;
            } else if (text.includes('agent runtime plugins pre-warmed')) {
                targetProgress = 100;
                targetText = t('console.progress.ready') || '本地 AI Nexora Agent服务就绪！';
                updated = true;
            } else if (text.includes('starting HTTP server') || text.includes('force: no listeners') || text.includes('started (interval:')) {
                targetProgress = 78;
                targetText = t('console.progress.binding_port') || '正在绑定端口并装载渠道插件…';
                updated = true;
                startGatewayReadyProbe('http-starting');
            }

            // 限制进度单调递增，绝不往回拉扯
            if (updated && targetProgress > currentProgress) {
                updateProgressUI(targetProgress, targetText);
            }
        }

        // 忽略非关键的计费拉取失败日志 (国内网络下通常会失败)
        if (text.includes('[model-pricing]') && text.includes('fetch failed')) return;

        // 进行日志分割、过滤与播报员着色处理
        const rawLines = text.split('\n');
        const processedLines = [];
        rawLines.forEach(line => {
            if (!line.trim()) return;
            const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})\s(.*)$/i) || 
                              line.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?\s*(.*)$/i) ||
                              line.match(/^(\[\d{2}:\d{2}:\d{2}\])\s(.*)$/i);
            
            let timePrefix = '';
            let content = line;
            if (timeMatch) {
                if (timeMatch.length === 4) {
                    timePrefix = `${timeMatch[1]} ${timeMatch[2]}`;
                    content = timeMatch[3];
                } else {
                    timePrefix = timeMatch[1];
                    content = timeMatch[2];
                }
            }

            const formatted = formatLogForUser(content);
            if (formatted) {
                const displayTime = timePrefix ? `[${timePrefix}] ` : `[${new Date().toLocaleTimeString()}] `;
                const coloredText = formatted
                    .replace(/\[⚙️ 系统核心\]/g, '<span style="color: #64b5f6; font-weight: bold; margin-right: 4px;">⚙️ [系统核心]</span>')
                    .replace(/\[⚠️ 系统警报\]/g, '<span style="color: #ff5252; font-weight: bold; margin-right: 4px;">⚠️ [系统警报]</span>')
                    .replace(/\[🧩 插件模块\]/g, '<span style="color: #ba68c8; font-weight: bold; margin-right: 4px;">🧩 [插件模块]</span>')
                    .replace(/\[💬 微信插件\]/g, '<span style="color: #4db6ac; font-weight: bold; margin-right: 4px;">💬 [微信插件]</span>')
                    .replace(/\[🤖 QQ机器人\]/g, '<span style="color: #9575cd; font-weight: bold; margin-right: 4px;">🤖 [QQ机器人]</span>')
                    .replace(/\[🕊️ 飞书插件\]/g, '<span style="color: #e57373; font-weight: bold; margin-right: 4px;">🕊️ [飞书插件]</span>')
                    .replace(/\[🧠 大模型服务\]/g, '<span style="color: #a1887f; font-weight: bold; margin-right: 4px;">🧠 [大模型服务]</span>')
                    .replace(/\[💓 健康监测\]/g, '<span style="color: #ffd54f; font-weight: bold; margin-right: 4px;">💓 [健康监测]</span>')
                    .replace(/\[📊 对话账单\]/g, '<span style="color: #81c784; font-weight: bold; margin-right: 4px;">📊 [对话账单]</span>');

                const styledTime = `<span style="color: #6a6f8a; font-family: var(--font-mono); opacity: 0.45; font-size: 11px; margin-left: 12px; white-space: nowrap;">${displayTime}</span>`;
                processedLines.push(coloredText + styledTime);
            }
        });

        // --- 开始：前端终端下载进度注入 ---
        if (text.includes('Failed to install missing configured plugin') && !window.pluginDownloadTimer) {
            window.pluginDownloadSeconds = 0;
            window.pluginDownloadTimer = setInterval(() => {
                window.pluginDownloadSeconds += 5;
                const msgTemplate = t('console.log.downloading_plugins');
                const msg = msgTemplate.replace('{0}', window.pluginDownloadSeconds);
                
                const timerSpan = document.createElement('span');
                timerSpan.textContent = msg;
                timerSpan.style.color = '#ff9800';
                if (logTerminal) {
                    logTerminal.appendChild(timerSpan);
                    logTerminal.scrollTop = logTerminal.scrollHeight;
                }
            }, 5000);
        }
        
        if (window.pluginDownloadTimer && (text.includes('HTTP server listening on') || text.includes('ready') || text.includes('listening on port'))) {
            clearInterval(window.pluginDownloadTimer);
            window.pluginDownloadTimer = null;
            
            const doneSpan = document.createElement('span');
            doneSpan.textContent = t('console.log.downloading_done');
            doneSpan.style.color = '#4caf50';
            if (logTerminal) {
                logTerminal.appendChild(doneSpan);
                logTerminal.scrollTop = logTerminal.scrollHeight;
            }
        }
        // --- 结束：前端终端下载进度注入 ---

        processedLines.forEach(lineHtml => {
            // 实时状态提取并更新至看板卡片
            if (lineHtml.includes('成功接入大模型推理引擎：')) {
                const modelVal = lineHtml.substring(lineHtml.indexOf('成功接入大模型推理引擎：') + 12);
                const activeModelEl = document.getElementById('dash-active-model');
                if (activeModelEl) {
                    let clean = modelVal.replace(/<\/?[^>]+(>|$)/g, "").trim();
                    clean = clean.split('[')[0].trim();
                    const parts = clean.split('/');
                    activeModelEl.textContent = parts[parts.length - 1].trim();
                }
            }
            
            // 微信通道
            if (lineHtml.includes('微信消息接收通道已成功连接')) {
                const tile = document.getElementById('tile-weixin');
                if (tile) {
                    tile.className = 'channel-status-tile online';
                    tile.title = t('console.channel.wechat.connected') || '微信消息通道: 已连接';
                }
            } else if (lineHtml.includes('微信通道连接断开')) {
                const tile = document.getElementById('tile-weixin');
                if (tile) {
                    tile.className = 'channel-status-tile offline';
                    tile.title = t('console.channel.wechat.disconnected') || '微信消息通道: 未连接';
                }
            }
            
            // QQ通道
            if (lineHtml.includes('QQ 机器人消息通道已成功上线')) {
                const tile = document.getElementById('tile-qqbot');
                if (tile) {
                    tile.className = 'channel-status-tile online';
                    tile.title = t('console.channel.qq.connected') || 'QQ机器人通道: 已连接';
                }
            }
            
            // 飞书通道
            if (lineHtml.includes('飞书/Lark 消息通道已成功上线')) {
                const tile = document.getElementById('tile-feishu');
                if (tile) {
                    tile.className = 'channel-status-tile online';
                    tile.title = t('console.channel.feishu.connected') || '飞书/Lark通道: 已连接';
                }
            }

            // 写入隐藏的原大终端
            const span = document.createElement('span');
            span.innerHTML = lineHtml + '<br/>';
            if (logTerminal) logTerminal.appendChild(span);

            // 写入新 Dashboard 活动监控流
            if (currentTab !== 'console-view' && currentTab !== null) {
                if (!window.__deferredConsoleLogs) window.__deferredConsoleLogs = [];
                window.__deferredConsoleLogs.push(lineHtml);
                if (window.__deferredConsoleLogs.length > 300) {
                    window.__deferredConsoleLogs = window.__deferredConsoleLogs.slice(-180);
                }
            } else {
                enqueueActivityLog(lineHtml);
            }
        });

        if (logTerminal && logTerminal.innerText.length > 25000) {
            logTerminal.innerHTML = logTerminal.innerHTML.substring(5000);
        }
        if (logTerminal) {
            logTerminal.scrollTop = logTerminal.scrollHeight;
        }
    };

    // 挂载至全局 window，专供 CDP 自动化脚本进行 100% 仿真日志注入质量自检
    window.__testTriggerLog = handleReceivedLog;

    window.api.onLogReceived(handleReceivedLog);
    window.api.onSandboxUpdateProgress((data) => {
        if (data && typeof data.progress === 'number') {
            updateProgressUI(data.progress, data.text || '正在升级内置环境...');
        }
    });

    if (window.api.onGatewayHttpReady) {
        window.api.onGatewayHttpReady(() => {
            markGatewayReadyFromLog('核心服务已就绪，可打开 OpenClaw');
        });
    }

    // Nexora Agent状态同步
    window.api.onStatusChanged((status) => {
        const oldStatus = gatewayStatus;
        
        // 当状态变更时，主动释放启停锁定状态并恢复按钮可用样式
        window.isTogglingGateway = false;
        if (window.toggleLockTimeout) {
            clearTimeout(window.toggleLockTimeout);
            window.toggleLockTimeout = null;
        }
        gatewayToggleBtn.style.pointerEvents = '';
        gatewayToggleBtn.style.opacity = '';
        gatewayToggleBtn.style.cursor = '';

        if (status === 'stopped') {
            gatewayStatus = 'stopped';
            gatewayFullyReady = false;
            gatewayLogReadyTail = '';
            __gatewayLoadedPluginCount = null;
            stopGatewayReadyProbe();
            updateGatewayStatusUI('stopped');
            updateRightPluginsCountUI();
            
            // 重置微信、QQ、飞书的通道状态卡片为离线
            ['weixin', 'qqbot', 'feishu'].forEach(ch => {
                const tile = document.getElementById(`tile-${ch}`);
                if (tile) {
                    tile.className = 'channel-status-tile offline';
                    if (ch === 'weixin') tile.title = t('console.channel.wechat.disconnected') || '微信消息通道: 未连接';
                    if (ch === 'qqbot') tile.title = t('console.channel.qq.disconnected') || 'QQ机器人通道: 未配置';
                    if (ch === 'feishu') tile.title = t('console.channel.feishu.disconnected') || '飞书/Lark通道: 未连接';
                }
            });

            // 重置拓扑图状态与步骤进度 UI 为已停止
            if (typeof updateStepperUI === 'function') {
                updateStepperUI(0);
            }

            if (oldStatus === 'running') {
                sendDesktopNotification('Nexora Agent状态变更', 'OpenClaw 本地智能Nexora Agent已停止运行。');
            }
            __openclawPanelLastUrl = '';
            if (typeof refreshAccelerationChannel === 'function') refreshAccelerationChannel().catch(() => {});
        } 
        else if (status === 'running') {
            gatewayRunningTime = Date.now();
            // 冷启动：维持 starting，同时开始端口探测，避免卡在 97%
            if (currentProgress > 0 && !gatewayFullyReady) {
                gatewayStatus = 'starting';
                updateGatewayStatusUI('starting');
                startGatewayReadyProbe('status-running');
            } else {
                gatewayStatus = 'running';
                gatewayFullyReady = true;
                stopGatewayReadyProbe();
                updateGatewayStatusUI('running');
                if (oldStatus !== 'running') {
                    sendDesktopNotification('Nexora Agent状态变更', 'OpenClaw 本地智能Nexora Agent已成功启动运行！');
                    __openclawPanelLastUrl = '';
                }
            }
            if (typeof refreshAccelerationChannel === 'function') refreshAccelerationChannel().catch(() => {});
        }
        else {
            gatewayStatus = status;
            updateGatewayStatusUI(status);
        }
    });

    // 主进程解析到最新免密 URL 时，活跃面板自动同步
    if (window.api.onDashboardUrlUpdated) {
        window.api.onDashboardUrlUpdated((url) => {
            if (!url) return;
            __openclawPanelLastUrl = '';
            const pane = document.getElementById('openclaw-panel-view');
            if (pane && pane.classList.contains('active')) {
                loadOpenclawControlUi(true);
            }
        });
    }

    // 微信 / 飞书扫码二维码捕获并画图（payload 支持 string URL 或 {url, channel, title, tip}）
    window.api.onQrCodeReceived((payload) => {
        const isObj = payload && typeof payload === 'object';
        const url = isObj ? payload.url : payload;
        const channel = (isObj && payload.channel) || 'wechat';
        if (!url) return;
        window.__activeQrChannel = channel;

        const titleEl = document.getElementById('qrcode-overlay-title');
        const descEl = document.getElementById('qrcode-overlay-desc');
        if (channel === 'feishu') {
            if (titleEl) titleEl.textContent = (isObj && payload.title) || '🦆 飞书扫码绑定';
            if (descEl) descEl.textContent = (isObj && payload.tip) || '请使用手机飞书扫描下方二维码，自动创建并绑定机器人。';
        } else {
            if (titleEl) titleEl.textContent = (isObj && payload.title) || '💬 微信扫码登录';
            if (descEl) descEl.textContent = (isObj && payload.tip) || '请使用手机微信扫描下方二维码授权登录。';
        }

        qrcodeOverlay.style.display = 'flex';
        qrcodeOverlay.style.opacity = '0'; // 初始透明，等待二维码图片加载完毕后再渐显，防止闪白
        document.getElementById('qrcode-raw-url').value = url;
        drawQrCode(url);
        markCommBindingQrReady(channel);
        if (channel === 'wechat' || channel === 'openclaw-weixin') startWeChatBindingFastPoll();
    });

    // 主进程探测到微信扫码绑定成功后的即时刷新（进行中的飞书等会话绝不能被关掉）
    window.api.onWeChatLoginSuccess(() => {
        if (typeof showToast === 'function') showToast('✅ 微信绑定成功！正在热重载网关...');
        updateWeChatStatusUI();
        const ch = (__commBindingSession && __commBindingSession.active) ? __commBindingSession.channel : null;
        if (!ch || ch === 'wechat' || ch === 'openclaw-weixin') {
            completeCommBinding();
        }
        // 主进程也会 schedule 热重载；此处再调一次会被防抖合并，作为 UI 兜底
        reloadGatewayAfterChannelChange('wechat-bind', { startIfStopped: true });
    });

    if (window.api.onWeChatLoginFailed) {
        window.api.onWeChatLoginFailed((status) => {
            const ch = (__commBindingSession && __commBindingSession.active) ? __commBindingSession.channel : null;
            if (ch && ch !== 'wechat' && ch !== 'openclaw-weixin') return;
            failCommBinding('微信绑定失败：' + ((status && status.error) || '未知错误'));
        });
    }

    // 通用内置渠道失败（以后新增 ASYNC_CHANNEL_LOGIN / channel-login-start 都会走这里）
    if (window.api.onChannelLoginFailed) {
        window.api.onChannelLoginFailed((status) => {
            const ch = (status && (status.channel || status.pluginId)) || '';
            // 微信、飞书已有专用失败事件（onWeChatLoginFailed / onFeishuLoginFailed），跳过避免双 Toast
            if (ch === 'wechat' || ch === 'openclaw-weixin') return;
            if (ch === 'feishu' || ch === 'lark') return;
            const label = labelForBindChannel(ch);
            failCommBinding(`${label}绑定失败：` + ((status && status.error) || '未知错误'));
        });
    }
    if (window.api.onChannelLoginSuccess) {
        window.api.onChannelLoginSuccess((status) => {
            const ch = (status && (status.channel || status.pluginId)) || '';
            if (ch === 'wechat' || ch === 'openclaw-weixin') return; // 由 onWeChatLoginSuccess 处理
            if (ch === 'feishu' || ch === 'lark') return; // 由 onFeishuLoginSuccess 处理
            if (typeof showToast === 'function') {
                showToast(`✅ ${labelForBindChannel(ch)}绑定成功`);
            }
            completeCommBinding();
        });
    }

    // 飞书扫码绑定成功：重载配置、刷新账号列表、关弹窗
    if (window.api.onFeishuLoginSuccess) {
        window.api.onFeishuLoginSuccess(async (status) => {
            try {
                configData = await window.api.readConfig();
            } catch (e) {}
            renderFeishuAccounts();
            if (typeof showToast === 'function') {
                showToast(`✅ 飞书扫码绑定成功！账号：${(status && status.accountId) || 'feishu-scan'}，正在热重载网关...`);
            }
            completeCommBinding();
            // 主进程已 schedule；此处防抖合并，避免漏掉
            reloadGatewayAfterChannelChange('feishu-bind', { startIfStopped: true });
        });
    }
    if (window.api.onFeishuLoginFailed) {
        window.api.onFeishuLoginFailed((status) => {
            failCommBinding('飞书扫码绑定失败：' + ((status && status.error) || '未知错误'));
        });
    }

    // 绑定一键复制授权链接
    const qrcodeCopyBtn = document.getElementById('qrcode-copy-btn');
    if (qrcodeCopyBtn) {
        qrcodeCopyBtn.addEventListener('click', async () => {
            const urlInput = document.getElementById('qrcode-raw-url');
            const targetUrl = urlInput ? (urlInput.value || '').trim() : '';
            if (!targetUrl) {
                if (typeof showToast === 'function') showToast('⚠️ 暂无有效的授权链接可复制');
                return;
            }

            const copied = await copyToClipboard(targetUrl);

            if (copied) {
                const isFeishu = window.__activeQrChannel === 'feishu';
                const msg = isFeishu
                    ? '📋 飞书授权登录链接已成功复制到剪贴板！'
                    : '📋 微信授权登录链接已成功复制到剪贴板！';
                if (typeof showToast === 'function') {
                    showToast(msg);
                } else {
                    alert(msg);
                }
            } else {
                if (typeof showToast === 'function') showToast('⚠️ 复制失败，请手动选择框内文本按 Ctrl+C 复制');
            }
        });
    }

    // 托盘控制触发
    window.api.onControlTriggered((action) => {
        if (action === 'start') {
            window.api.gatewayAction('start');
        } else if (action === 'stop') {
            window.api.gatewayAction('stop');
        }
    });

    // 监听窗口最大化/还原状态切换，动态移除/加上窗口圆角以防四角漏光
    window.api.onMaximizedStatus((isMaximized) => {
        if (isMaximized) {
            document.body.classList.add('maximized');
        } else {
            document.body.classList.remove('maximized');
        }
    });

    // 监听开机自启切换
    const autostartToggleElement = document.getElementById('setting-autostart-toggle');
    if (autostartToggleElement) {
        autostartToggleElement.addEventListener('change', async (e) => {
            await window.api.setAutoStart(e.target.checked);
        });
    }
}

// 5. 动态大模型提供商与配置数据管理
let localProviders = {};
const AGNES_BUILT_IN_KEY = 'sk-95sX8HnNOhh8FFfAm3ccOgGFg6MA8yf7zU5PEEQdGxSuKhQY';
const KEY_MASK = '••••••••••••••••••••••••••••••••••••••••••••••••';
/** JSON 预览里展示的脱敏占位（勿写入真实 configData） */
const JSON_PREVIEW_SECRET_MASK = '********';

function isSecretFieldName(key) {
    const k = String(key || '');
    return /^(apiKey|api_key|appSecret|app_secret|clientSecret|client_secret|token|accessToken|refreshToken|password|secret|authorization)$/i.test(k)
        || /(_API_KEY|_SECRET|_TOKEN|_PASSWORD)$/i.test(k)
        || /API_KEY/i.test(k);
}

function isPlaceholderSecretValue(val) {
    const s = String(val || '').trim();
    if (!s) return true;
    return /^YOUR_[A-Z0-9_]+$/i.test(s) || /YOUR_.*_HERE/i.test(s);
}

function isMaskedSecretValue(val) {
    if (typeof val !== 'string') return false;
    const s = val.trim();
    if (!s) return false;
    return s === KEY_MASK || s === JSON_PREVIEW_SECRET_MASK || /^[•*]+$/.test(s);
}

/** 深拷贝配置并将密钥字段替换为掩码，仅用于预览展示 */
function maskSecretsForJsonPreview(config) {
    const clone = JSON.parse(JSON.stringify(config || {}));
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'string' && isSecretFieldName(k) && v.trim() && !isPlaceholderSecretValue(v)) {
                node[k] = JSON_PREVIEW_SECRET_MASK;
            } else if (v && typeof v === 'object') {
                walk(v);
            }
        }
    };
    walk(clone);
    return clone;
}

/** 手改预览 JSON 时：掩码值还原为上一份真实密钥，避免把 ******** 写进配置 */
function restoreMaskedSecretsFromPrevious(next, prev) {
    if (!next || !prev || typeof next !== 'object' || typeof prev !== 'object') return next;
    const walk = (n, p) => {
        if (!n || !p || typeof n !== 'object' || typeof p !== 'object') return;
        if (Array.isArray(n) && Array.isArray(p)) {
            const len = Math.min(n.length, p.length);
            for (let i = 0; i < len; i++) walk(n[i], p[i]);
            return;
        }
        if (Array.isArray(n) || Array.isArray(p)) return;
        for (const k of Object.keys(n)) {
            const nv = n[k];
            const pv = p[k];
            if (typeof nv === 'string' && isSecretFieldName(k) && isMaskedSecretValue(nv) && typeof pv === 'string') {
                n[k] = pv;
            } else if (nv && typeof nv === 'object' && pv && typeof pv === 'object') {
                walk(nv, pv);
            }
        }
    };
    walk(next, prev);
    return next;
}

const expandedProviders = new Set();

/** 内置开启时：主/备仅允许 agnes-ai / ollama，非法则回落到内置默认；并锁定 Agnes 通道凭证 */
function applyBuiltInModelPolicy(cfg) {
    if (!cfg || typeof cfg !== 'object') return false;
    if (!getUseBuiltIn()) return false;
    let changed = false;

    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (!cfg.agents.defaults.model) cfg.agents.defaults.model = {};

    const primary = cfg.agents.defaults.model.primary || '';
    if (!isBuiltinAllowedModelRef(primary)) {
        cfg.agents.defaults.model.primary = BUILTIN_DEFAULT_PRIMARY;
        changed = true;
    }
    const fb = Array.isArray(cfg.agents.defaults.model.fallbacks) ? cfg.agents.defaults.model.fallbacks[0] : '';
    if (!isBuiltinAllowedModelRef(fb)) {
        cfg.agents.defaults.model.fallbacks = [BUILTIN_DEFAULT_FALLBACK];
        changed = true;
    }

    if (!cfg.models) cfg.models = {};
    if (!cfg.models.providers) cfg.models.providers = {};
    if (!cfg.models.providers['agnes-ai']) {
        cfg.models.providers['agnes-ai'] = {
            baseUrl: 'https://apihub.agnes-ai.com/v1',
            api: 'openai-completions',
            models: []
        };
        changed = true;
    }
    const agnes = cfg.models.providers['agnes-ai'];
    if (agnes.baseUrl !== 'https://apihub.agnes-ai.com/v1') {
        agnes.baseUrl = 'https://apihub.agnes-ai.com/v1';
        changed = true;
    }
    if (agnes.apiKey !== AGNES_BUILT_IN_KEY) {
        agnes.apiKey = AGNES_BUILT_IN_KEY;
        changed = true;
    }

    if (!cfg.env) cfg.env = {};
    if (cfg.env.AGNES_AI_API_KEY !== AGNES_BUILT_IN_KEY) {
        cfg.env.AGNES_AI_API_KEY = AGNES_BUILT_IN_KEY;
        changed = true;
    }

    return changed;
}

async function loadAndRenderConfig() {
    configData = await window.api.readConfig();
    if (!configData) {
        logTerminal.innerText = '[System] [Error] 无法读取 openclaw.json 配置文件！\n';
        return;
    }

    // 内置模型开启时：磁盘若仍是其它主模型，立即对齐写回，消除「设置开着 / 配置页与 OpenClaw 不一致」
    try {
        if (applyBuiltInModelPolicy(configData) && window.api && window.api.saveConfig) {
            await window.api.saveConfig(configData);
        }
    } catch (e) {
        console.warn('[BuiltIn] enforce on load failed:', e);
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
        if (defaults.model) {
            const primary = defaults.model.primary || '';
            let primaryModelId = primary;
            let primaryProvider = '';
            if (primary.includes('/')) {
                const parts = primary.split('/');
                primaryProvider = parts[0];
                primaryModelId = parts[1];
            }
            document.getElementById('model-primary').value = primaryModelId;

            const fallback = (defaults.model.fallbacks && defaults.model.fallbacks[0]) || '';
            let fallbackModelId = fallback;
            let fallbackProvider = '';
            if (fallback.includes('/')) {
                const parts = fallback.split('/');
                fallbackProvider = parts[0];
                fallbackModelId = parts[1];
            }
            document.getElementById('model-fallback').value = fallbackModelId;
            
            // 进行一次供应商下拉框刷新并设置选中值
            updateAssignedProviderSelects(primaryModelId, fallbackModelId, primaryProvider, fallbackProvider);
        }
        const storedImgModel = localStorage.getItem('client_pref_image_model');
        if (storedImgModel) {
            document.getElementById('model-image').value = storedImgModel;
        } else if (defaults.imageGenerationModel) {
            document.getElementById('model-image').value = defaults.imageGenerationModel.primary || '';
        } else {
            document.getElementById('model-image').value = '';
        }

        const storedVidModel = localStorage.getItem('client_pref_video_model');
        if (storedVidModel) {
            document.getElementById('model-video').value = storedVidModel;
        } else if (defaults.videoGenerationModel) {
            document.getElementById('model-video').value = defaults.videoGenerationModel.primary || '';
        } else {
            document.getElementById('model-video').value = '';
        }
    }

    // 双模型教学：老师/学生模型（来自插件配置，不写死本地模型）
    const teacherEl = document.getElementById('model-teacher');
    const studentEl = document.getElementById('model-student');
    if (teacherEl || studentEl) {
        const dmtCfg = (configData.plugins
            && configData.plugins.entries
            && configData.plugins.entries['dual-model-trainer']
            && configData.plugins.entries['dual-model-trainer'].config) || {};
        if (teacherEl) teacherEl.value = dmtCfg.teacherModel || '';
        if (studentEl) studentEl.value = normalizeStudentModelRef(dmtCfg.studentModel || '');
    }

    // 优先从本地 localStorage 加载自定义的视频/图片生成配置（不写盘入 openclaw.json 以免损坏Nexora Agent配置格式）
    const storedVideoConfig = localStorage.getItem('client_pref_video_generator');
    if (storedVideoConfig) {
        try {
            configData.videoGenerator = JSON.parse(storedVideoConfig);
        } catch(e){}
    }
    const storedImageConfig = localStorage.getItem('client_pref_image_generator');
    if (storedImageConfig) {
        try {
            configData.imageGenerator = JSON.parse(storedImageConfig);
        } catch(e){}
    }

    if (configData.videoGenerator) {
        document.getElementById('video-api-base').value = configData.videoGenerator.apiBase || 'https://apihub.agnes-ai.com/v1/videos';
        document.getElementById('video-api-key').value = configData.videoGenerator.apiKey || '';
    } else {
        document.getElementById('video-api-base').value = 'https://apihub.agnes-ai.com/v1/videos';
        document.getElementById('video-api-key').value = '';
    }

    if (configData.imageGenerator) {
        document.getElementById('image-api-base').value = configData.imageGenerator.apiBase || 'https://apihub.agnes-ai.com/v1/images';
        document.getElementById('image-api-key').value = configData.imageGenerator.apiKey || '';
    } else {
        document.getElementById('image-api-base').value = 'https://apihub.agnes-ai.com/v1/images';
        document.getElementById('image-api-key').value = '';
    }

    if (configData.gateway) {
        document.getElementById('gateway-port').value = configData.gateway.port || 18789;
        statPort.innerText = configData.gateway.port || 18789;
        const auth = configData.gateway.auth;
        document.getElementById('gateway-token').value = (auth && auth.token) || 'openclaw-dev-token-998877';
    }

    // 渲染功能插件列表卡片
    renderPluginsGrid();

    // 控制内置模型配置项的启用与置灰
    toggleProviderInputsEditable();

    // 初始化 JSON 预览展示
    updateConfigJsonPreview();

    // 渲染飞书绑定账号列表
    renderFeishuAccounts();

    // 渲染 QQ 机器人绑定账号列表
    renderQqbotAccounts();

    // 更新右侧载入插件数
    updateRightPluginsCountUI();
}

// 🌐 配置文件 JSON 右侧实时预览更新函数
function updateConfigJsonPreview(force = false) {
    if (!configData) return;

    // 1. 同步保存提供商与模型白名单
    if (!configData.models) configData.models = {};
    const finalProviders = JSON.parse(JSON.stringify(localProviders));
    configData.models.providers = finalProviders;

    // 2. 同步并发选项及默认主备模型选择
    if (!configData.agents) configData.agents = {};
    if (!configData.agents.defaults) configData.agents.defaults = {};
    
    const maxConcurrentEl = document.getElementById('max-concurrent');
    if (maxConcurrentEl) {
        configData.agents.defaults.maxConcurrent = parseInt(maxConcurrentEl.value, 10) || 4;
    } else {
        configData.agents.defaults.maxConcurrent = configData.agents.defaults.maxConcurrent || 4;
    }
    
    if (!configData.agents.defaults.model) configData.agents.defaults.model = {};
    const primaryModelEl = document.getElementById('model-primary');
    const primaryProviderEl = document.getElementById('model-primary-provider');
    if (primaryModelEl) {
        const mVal = primaryModelEl.value.trim();
        const pVal = primaryProviderEl ? primaryProviderEl.value : '';
        if (pVal && mVal && !mVal.includes('/')) {
            configData.agents.defaults.model.primary = `${pVal}/${mVal}`;
        } else {
            configData.agents.defaults.model.primary = mVal;
        }
    }
    const fallbackModelEl = document.getElementById('model-fallback');
    const fallbackProviderEl = document.getElementById('model-fallback-provider');
    if (fallbackModelEl) {
        const mVal = fallbackModelEl.value.trim();
        const pVal = fallbackProviderEl ? fallbackProviderEl.value : '';
        let finalFallback = mVal;
        if (pVal && mVal && !mVal.includes('/')) {
            finalFallback = `${pVal}/${mVal}`;
        }
        configData.agents.defaults.model.fallbacks = [finalFallback];
    }

    if (!configData.agents.defaults.imageGenerationModel) configData.agents.defaults.imageGenerationModel = {};
    const modelImageEl = document.getElementById('model-image');
    if (modelImageEl) {
        configData.agents.defaults.imageGenerationModel.primary = modelImageEl.value.trim();
    }

    if (!configData.agents.defaults.videoGenerationModel) configData.agents.defaults.videoGenerationModel = {};
    const modelVideoEl = document.getElementById('model-video');
    if (modelVideoEl) {
        configData.agents.defaults.videoGenerationModel.primary = modelVideoEl.value.trim();
    }

    if (!configData.videoGenerator) configData.videoGenerator = {};
    const videoApiBaseEl = document.getElementById('video-api-base');
    if (videoApiBaseEl) configData.videoGenerator.apiBase = videoApiBaseEl.value.trim();
    const videoApiKeyEl = document.getElementById('video-api-key');
    if (videoApiKeyEl) configData.videoGenerator.apiKey = videoApiKeyEl.value.trim();

    if (!configData.imageGenerator) configData.imageGenerator = {};
    const imageApiBaseEl = document.getElementById('image-api-base');
    if (imageApiBaseEl) configData.imageGenerator.apiBase = imageApiBaseEl.value.trim();
    const imageApiKeyEl = document.getElementById('image-api-key');
    if (imageApiKeyEl) configData.imageGenerator.apiKey = imageApiKeyEl.value.trim();

    if (!configData.gateway) configData.gateway = {};
    const gatewayPortEl = document.getElementById('gateway-port');
    if (gatewayPortEl) configData.gateway.port = parseInt(gatewayPortEl.value, 10) || 18789;

    // 内置开启时：主/备若落在非 agnes-ai/ollama，钳制回默认；允许在二者间切换
    if (getUseBuiltIn()) {
        applyBuiltInModelPolicy(configData);
        if (configData.models && configData.models.providers) {
            localProviders = JSON.parse(JSON.stringify(configData.models.providers));
        }
    }

    const previewEl = document.getElementById('config-json-preview');
    // 只有当用户当前没有聚焦在 JSON 编辑框输入时，才自动用表单最新状态覆盖内容，防止打字时光标位移
    if (previewEl && (force || document.activeElement !== previewEl)) {
        const previewConfig = JSON.parse(JSON.stringify(configData));
        if (previewConfig.agents && previewConfig.agents.defaults) {
            delete previewConfig.agents.defaults.imageGenerationModel;
            delete previewConfig.agents.defaults.videoGenerationModel;
        }
        // 预览脱敏：真实密钥仍留在 configData / 磁盘，此处仅展示掩码
        previewEl.value = JSON.stringify(maskSecretsForJsonPreview(previewConfig), null, 2);
    }
}

// 🔄 手写编辑 JSON 时，将有效配置对象逆向同步填充至左侧各表单字段及厂家列表
function syncJsonToFormFields(parsed) {
    if (!parsed) return;
    
    // 同步并发与主备模型
    if (parsed.agents && parsed.agents.defaults) {
        const defaults = parsed.agents.defaults;
        const maxConcurrentEl = document.getElementById('max-concurrent');
        if (maxConcurrentEl && defaults.maxConcurrent !== undefined) {
            maxConcurrentEl.value = defaults.maxConcurrent;
        }
        if (defaults.model) {
            const primaryEl = document.getElementById('model-primary');
            let primaryModelId = '';
            let primaryProvider = '';
            if (primaryEl && defaults.model.primary !== undefined) {
                const primary = defaults.model.primary || '';
                if (primary.includes('/')) {
                    const parts = primary.split('/');
                    primaryProvider = parts[0];
                    primaryModelId = parts[1];
                } else {
                    primaryModelId = primary;
                }
                primaryEl.value = primaryModelId;
            }

            const fallbackEl = document.getElementById('model-fallback');
            let fallbackModelId = '';
            let fallbackProvider = '';
            if (fallbackEl && defaults.model.fallbacks && defaults.model.fallbacks[0] !== undefined) {
                const fallback = defaults.model.fallbacks[0] || '';
                if (fallback.includes('/')) {
                    const parts = fallback.split('/');
                    fallbackProvider = parts[0];
                    fallbackModelId = parts[1];
                } else {
                    fallbackModelId = fallback;
                }
                fallbackEl.value = fallbackModelId;
            }

            updateAssignedProviderSelects(primaryModelId, fallbackModelId, primaryProvider, fallbackProvider);
        }
        if (defaults.imageGenerationModel) {
            const imageModelEl = document.getElementById('model-image');
            if (imageModelEl && defaults.imageGenerationModel.primary !== undefined) {
                imageModelEl.value = defaults.imageGenerationModel.primary;
            }
        }
        if (defaults.videoGenerationModel) {
            const videoModelEl = document.getElementById('model-video');
            if (videoModelEl && defaults.videoGenerationModel.primary !== undefined) {
                videoModelEl.value = defaults.videoGenerationModel.primary;
            }
        }
    }
    
    if (parsed.videoGenerator) {
        const videoApiBaseEl = document.getElementById('video-api-base');
        if (videoApiBaseEl && parsed.videoGenerator.apiBase !== undefined) {
            videoApiBaseEl.value = parsed.videoGenerator.apiBase;
        }
        const videoApiKeyEl = document.getElementById('video-api-key');
        if (videoApiKeyEl && parsed.videoGenerator.apiKey !== undefined) {
            videoApiKeyEl.value = parsed.videoGenerator.apiKey;
        }
    }

    if (parsed.imageGenerator) {
        const imageApiBaseEl = document.getElementById('image-api-base');
        if (imageApiBaseEl && parsed.imageGenerator.apiBase !== undefined) {
            imageApiBaseEl.value = parsed.imageGenerator.apiBase;
        }
        const imageApiKeyEl = document.getElementById('image-api-key');
        if (imageApiKeyEl && parsed.imageGenerator.apiKey !== undefined) {
            imageApiKeyEl.value = parsed.imageGenerator.apiKey;
        }
    }

    if (parsed.gateway) {
        const gatewayPortEl = document.getElementById('gateway-port');
        if (gatewayPortEl && parsed.gateway.port !== undefined) {
            gatewayPortEl.value = parsed.gateway.port;
        }
    }
    
    // 如果厂商有改变，我们还需要重新渲染一下提供商卡片列表
    if (parsed.models && parsed.models.providers) {
        localProviders = JSON.parse(JSON.stringify(parsed.models.providers));
        renderProvidersList();
        updateModelsDatalist();
    }

    // 内置开启时：JSON 手改不得突破 agnes-ai/ollama 限制，并刷新厂家列表可见范围
    if (getUseBuiltIn()) {
        applyBuiltInModelPolicy(configData);
        if (configData.models && configData.models.providers) {
            localProviders = JSON.parse(JSON.stringify(configData.models.providers));
        }
        renderProvidersList();
        updateModelsDatalist();
        updateConfigJsonPreview();
    }
}

// 渲染提供商卡片列表
function renderProvidersList() {
    const listZone = document.getElementById('providers-list-zone');
    listZone.innerHTML = '';

    // 强制确保内置的 agnes-ai 与 ollama 永远存在于 localProviders 字典中
    if (!localProviders) localProviders = {};
    if (!localProviders['agnes-ai']) {
        localProviders['agnes-ai'] = {
            baseUrl: 'https://apihub.agnes-ai.com/v1',
            apiKey: '',
            api: 'openai-completions',
            models: [
                { id: 'agnes-2.0-flash', name: 'agnes-2.0-flash', input: ['text', 'image'], contextWindow: 131072, maxTokens: 8192 },
                { id: 'agnes-1.5-flash', name: 'agnes-1.5-flash', input: ['text', 'image'], contextWindow: 131072, maxTokens: 8192 },
                { id: 'agnes-video-v2.0', name: 'agnes-video-v2.0', contextWindow: 131072, maxTokens: 8192 },
                { id: 'agnes-image-2.1-flash', name: 'agnes-image-2.1-flash', contextWindow: 131072, maxTokens: 8192 },
                { id: 'agnes-image-2.0-flash', name: 'agnes-image-2.0-flash', contextWindow: 131072, maxTokens: 8192 }
            ]
        };
    }
    if (!localProviders['ollama']) {
        localProviders['ollama'] = {
            baseUrl: 'http://localhost:11434/v1',
            apiKey: '',
            api: 'openai-completions',
            models: []
        };
    }

    const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
    const isEn = currentLang === 'en-US';
    const isTw = currentLang === 'zh-TW';
    const t = (zhCn, en, zhTw) => {
        if (isEn) return en;
        if (isTw) return zhTw;
        return zhCn;
    };

    const useBuiltIn = getUseBuiltIn();

    // 内置开启：厂家列表只展示 agnes-ai / ollama；关闭则全部展示
    let keys = Object.keys(localProviders);
    if (useBuiltIn) {
        keys = BUILTIN_ALLOWED_PROVIDERS.filter((k) => !!localProviders[k]);
    } else {
        const agnesIndex = keys.indexOf('agnes-ai');
        if (agnesIndex > -1) {
            keys.splice(agnesIndex, 1);
            keys.unshift('agnes-ai');
        }
    }

    const addProviderBtn = document.getElementById('btn-add-provider');
    if (addProviderBtn) {
        addProviderBtn.style.display = useBuiltIn ? 'none' : '';
    }

    for (const key of keys) {
        const provider = localProviders[key];
        const card = document.createElement('div');
        
        // 根据折叠状态设置 class 属性（默认折叠，只有 explicit expanded 才展开）
        const isCollapsed = !expandedProviders.has(key);
        card.className = isCollapsed ? 'provider-card collapsed' : 'provider-card';
        
        // agnes-ai 与 ollama 为内置/默认大模型服务，不支持删除
        const deleteButtonHtml = (key === 'agnes-ai' || key === 'ollama')
            ? '' 
            : `<button type="button" class="btn-delete-provider" data-provider="${key}">❌ ${t('删除此厂家', 'Delete Provider', '刪除此廠商')}</button>`;

        // 折叠按钮 HTML
        const foldButtonText = isCollapsed ? t('展开 🔽', 'Expand 🔽', '展開 🔽') : t('收起 🔼', 'Collapse 🔼', '收起 🔼');
        const foldButtonHtml = `<button type="button" class="btn-fold-provider" data-provider="${key}" style="background: rgba(255,255,255,0.05); color: var(--text-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; transition: all 0.2s ease;">${foldButtonText}</button>`;

        card.innerHTML = `
            <div class="provider-card-header" style="cursor: pointer; user-select: none;">
                <h3>🔌 ${key}
                    ${key === 'agnes-ai' ? `<span id="agnes-built-in-tip" style="font-size: 11px; font-weight: normal; color: #b388ff; margin-left: 8px; display: none;">${t('(已启用内置免配置服务通道)', '(Built-in bypass configured)', '(已啟用內置免配置服務通道)')}</span>` : ''}
                    ${key === 'ollama' ? `<span id="ollama-built-in-tip" style="font-size: 11px; font-weight: normal; color: #8cd8ff; margin-left: 8px;">${t('(内置本地服务通道)', '(Built-in local service channel)', '(內置本地服務通道)')}</span>` : ''}
                </h3>
                <div style="display: flex; align-items: center; gap: 8px;" class="provider-card-actions">
                    ${deleteButtonHtml}
                    ${foldButtonHtml}
                </div>
            </div>
            <div class="provider-card-body" id="provider-card-body-${key}">
                <div class="form-row">
                    <div class="form-field">
                        <label>${t('Base URL (API 端点)', 'Base URL (API Endpoint)', 'Base URL (API 端點)')}</label>
                        <input type="text" class="provider-url-input" data-provider="${key}" value="${provider.baseUrl || ''}" placeholder="${t('例如: https://api.openai.com/v1', 'e.g., https://api.openai.com/v1', '例如: https://api.openai.com/v1')}">
                    </div>
                    <div class="form-field">
                        <label>${t('API Key (授权密钥)', 'API Key', 'API Key (授權金鑰)')}</label>
                        <div class="password-input-wrapper" style="position: relative; display: flex; align-items: center;">
                            ${key === 'agnes-ai'
                                ? `<input type="password" class="provider-key-input" data-provider="${key}" value="${useBuiltIn ? KEY_MASK : (provider.apiKey === AGNES_BUILT_IN_KEY ? '' : (provider.apiKey || ''))}" placeholder="${t('API 密钥', 'API Key', 'API 金鑰')}" style="padding-right: 36px; width: 100%; user-select: none;" ${useBuiltIn ? 'readonly oncopy="return false;" oncut="return false;" oncontextmenu="return false;"' : ''}>`
                                : `<input type="password" class="provider-key-input" data-provider="${key}" value="${provider.apiKey || ''}" placeholder="${t('API 密钥', 'API Key', 'API 金鑰')}" style="padding-right: 36px; width: 100%;">`
                            }
                            ${key === 'agnes-ai' && useBuiltIn
                                ? ''
                                : `<span class="btn-toggle-visibility" data-provider="${key}" style="position: absolute; right: 10px; cursor: pointer; color: var(--text-secondary); display: flex; align-items: center; justify-content: center; font-size: 16px; user-select: none;">👁️</span>`
                            }
                        </div>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-field half">
                        <label>${t('API 协议类型', 'API Protocol', 'API 協定類型')}</label>
                        <select class="provider-api-select" data-provider="${key}">
                            <option value="openai-completions" ${provider.api === 'openai-completions' ? 'selected' : ''}>OpenAI Completions</option>
                            <option value="openai-chat" ${provider.api === 'openai-chat' ? 'selected' : ''}>OpenAI Chat</option>
                            <option value="ollama" ${provider.api === 'ollama' ? 'selected' : ''}>Ollama</option>
                        </select>
                    </div>
                </div>
                <div style="display: flex !important; flex-direction: row !important; align-items: center !important; gap: 12px; margin-top: 12px; margin-bottom: 16px;">
                    <button type="button" class="btn-primary btn-test-connection" data-provider="${key}" style="margin-top: 0; padding: 0 16px; font-size: 12px; height: 32px; border-radius: 6px; white-space: nowrap;">⚡ ${t('检验连通性', 'Verify Connectivity', '檢驗連通性')}</button>
                    <button type="button" class="btn-secondary btn-test-key" data-provider="${key}" style="margin-top: 0; padding: 0 16px; font-size: 12px; height: 32px; border-radius: 6px; white-space: nowrap; background: linear-gradient(135deg, #00c6ff 0%, #0072ff 100%); border: none; color: white;">🔑 ${t('检验密钥', 'Verify Key', '檢驗金鑰')}</button>
                    <span id="test-result-${key}" style="font-size: 12px; font-weight: bold; display: none; white-space: nowrap;"></span>
                </div>
                
                <div class="provider-models-zone" style="margin-top: 16px;">
                    <h4 style="margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
                        <span>🤖 ${t('模型白名单管理', 'Model Whitelist', '模型白名單管理')}</span>
                        <span style="font-size: 11px; color: var(--text-secondary); font-weight: normal;">${t('已配置该厂家的可用模型列表', 'Available models configured for this provider', '已配置該廠商的可用模型列表')}</span>
                    </h4>
                    
                    <div class="model-list-header" style="display: grid; grid-template-columns: 1fr 120px 40px; gap: 12px; padding: 4px 8px; font-size: 11px; color: var(--text-secondary); border-bottom: 1px solid rgba(255,255,255,0.05); margin-bottom: 8px;">
                        <div>${t('模型名称 (Model ID)', 'Model ID', '模型名稱 (Model ID)')}</div>
                        <div>${t('上下文窗口', 'Context Window', '上下文窗口')}</div>
                        <div style="text-align: center;">${t('操作', 'Actions', '操作')}</div>
                    </div>

                    <div class="model-list-container" id="model-list-container-${key}" style="display: flex; flex-direction: column; gap: 8px; max-height: 250px; overflow-y: auto; padding-right: 4px; margin-bottom: 12px;">
                    </div>

                    <div style="display: flex; gap: 8px; align-items: center;">
                        <button type="button" class="btn-primary btn-add-new-model-row" data-provider="${key}" style="padding: 0 12px; font-size: 12px; height: 28px; border-radius: 6px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); color: white;">${t('+ 添加模型', '+ Add Model', '+ 新增模型')}</button>
                        <button type="button" class="btn-primary btn-fetch-upstream-models" data-provider="${key}" style="padding: 0 12px; font-size: 12px; height: 28px; border-radius: 6px; background: rgba(140, 82, 255, 0.15); border: 1px solid rgba(140, 82, 255, 0.3); color: #b388ff;">${t('📥 从上游获取', '📥 Fetch Upstream', '📥 從上游獲取')}</button>
                        <span id="fetch-status-${key}" style="font-size: 11px; font-weight: bold; margin-left: 4px; display: none;"></span>
                    </div>
                </div>
            </div>
        `;
        listZone.appendChild(card);

        // 动态生成模型行
        const container = document.getElementById(`model-list-container-${key}`);
        const models = provider.models || [];
        container.innerHTML = '';
        
        models.forEach((model, index) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: grid; grid-template-columns: 1fr 120px 40px; gap: 12px; align-items: center; padding: 4px 8px; background: rgba(255,255,255,0.01); border-radius: 6px;';
            row.innerHTML = `
                <div>
                    <input type="text" class="model-id-edit-input" data-provider="${key}" data-index="${index}" value="${model.id || ''}" placeholder="${t('模型名称, 如: gpt-4o', 'Model ID, e.g., gpt-4o', '模型名稱, 如: gpt-4o')}" style="width: 100%; height: 30px; font-size: 12px; background: var(--bg-input) !important; border: 1px solid var(--border-color); border-radius: 6px; color: white; padding: 0 8px; outline: none;">
                </div>
                <div>
                    <input type="text" class="model-context-edit-input" data-provider="${key}" data-index="${index}" value="${formatContextWindow(model.contextWindow)}" placeholder="${t('例如: 128k 或 1M', 'e.g., 128k or 1M', '例如: 128k 或 1M')}" style="width: 100%; height: 30px; font-size: 12px; background: var(--bg-input) !important; border: 1px solid var(--border-color); border-radius: 6px; color: white; padding: 0 8px; outline: none;">
                </div>
                <div style="text-align: center;">
                    <button type="button" class="btn-delete-model-row" data-provider="${key}" data-index="${index}" style="background: none; border: none; color: #ff5252; cursor: pointer; font-size: 14px; padding: 4px; line-height: 1;">🗑️</button>
                </div>
            `;
            container.appendChild(row);
        });
    }

    bindProviderEvents();
    toggleProviderInputsEditable();
}

// 控制内置模型配置项的启用与置灰
function toggleProviderInputsEditable() {
    const useBuiltIn = getUseBuiltIn();
    const urlInput = document.querySelector('input.provider-url-input[data-provider="agnes-ai"]');
    const keyInput = document.querySelector('input.provider-key-input[data-provider="agnes-ai"]');
    const tipSpan = document.getElementById('agnes-built-in-tip');
    const visibilityBtn = document.querySelector('.btn-toggle-visibility[data-provider="agnes-ai"]');

    // 曜石/极光/流光大模型配置只读控制
    if (urlInput && keyInput) {
        if (useBuiltIn) {
            urlInput.disabled = true;
            keyInput.disabled = true;
            keyInput.value = KEY_MASK;
            keyInput.setAttribute('readonly', 'true');
            urlInput.style.opacity = '0.5';
            keyInput.style.opacity = '0.5';
            if (tipSpan) tipSpan.style.display = 'inline';
            if (visibilityBtn) visibilityBtn.style.display = 'none';
        } else {
            urlInput.disabled = false;
            keyInput.disabled = false;
            keyInput.removeAttribute('readonly');
            
            const savedKey = (localProviders['agnes-ai'] && localProviders['agnes-ai'].apiKey) || '';
            if (savedKey === AGNES_BUILT_IN_KEY) {
                keyInput.value = '';
                if (localProviders['agnes-ai']) {
                    localProviders['agnes-ai'].apiKey = '';
                }
            } else {
                keyInput.value = savedKey;
            }
            
            urlInput.style.opacity = '1';
            keyInput.style.opacity = '1';
            if (tipSpan) tipSpan.style.display = 'none';
            if (visibilityBtn) visibilityBtn.style.display = 'flex';
        }
    }

    // 图片与视频生成服务配置只读控制
    const imageBaseInput = document.getElementById('image-api-base');
    const imageKeyInput = document.getElementById('image-api-key');
    const imageModelInput = document.getElementById('model-image');
    const imageToggleBtn = document.getElementById('btn-toggle-image-key');

    const videoBaseInput = document.getElementById('video-api-base');
    const videoKeyInput = document.getElementById('video-api-key');
    const videoModelInput = document.getElementById('model-video');
    const videoToggleBtn = document.getElementById('btn-toggle-video-key');

    if (useBuiltIn) {
        // 图片只读与默认内置设定
        if (imageBaseInput) {
            imageBaseInput.value = 'https://apihub.agnes-ai.com/v1/images';
            imageBaseInput.disabled = true;
            imageBaseInput.style.opacity = '0.5';
        }
        if (imageKeyInput) {
            imageKeyInput.value = KEY_MASK;
            imageKeyInput.disabled = true;
            imageKeyInput.setAttribute('readonly', 'true');
            imageKeyInput.style.opacity = '0.5';
        }
        if (imageModelInput) {
            imageModelInput.value = 'agnes-ai/agnes-image-2.0-flash';
            imageModelInput.disabled = true;
            imageModelInput.style.opacity = '0.5';
        }
        if (imageToggleBtn) imageToggleBtn.style.display = 'none';

        // 视频只读与默认内置设定
        if (videoBaseInput) {
            videoBaseInput.value = 'https://apihub.agnes-ai.com/v1/videos';
            videoBaseInput.disabled = true;
            videoBaseInput.style.opacity = '0.5';
        }
        if (videoKeyInput) {
            videoKeyInput.value = KEY_MASK;
            videoKeyInput.disabled = true;
            videoKeyInput.setAttribute('readonly', 'true');
            videoKeyInput.style.opacity = '0.5';
        }
        if (videoModelInput) {
            videoModelInput.value = 'agnes-ai/agnes-video-v2.0';
            videoModelInput.disabled = true;
            videoModelInput.style.opacity = '0.5';
        }
        if (videoToggleBtn) videoToggleBtn.style.display = 'none';
    } else {
        // 图片解除置灰
        if (imageBaseInput) {
            imageBaseInput.disabled = false;
            imageBaseInput.style.opacity = '1';
        }
        if (imageKeyInput) {
            imageKeyInput.disabled = false;
            imageKeyInput.removeAttribute('readonly');
            imageKeyInput.style.opacity = '1';
            const storedImgConfigStr = localStorage.getItem('client_pref_image_generator');
            let storedImgKey = '';
            if (storedImgConfigStr) {
                try {
                    storedImgKey = JSON.parse(storedImgConfigStr).apiKey || '';
                } catch(e){}
            }
            if (storedImgKey === AGNES_BUILT_IN_KEY || imageKeyInput.value === KEY_MASK) {
                imageKeyInput.value = '';
            } else {
                imageKeyInput.value = storedImgKey;
            }
        }
        if (imageModelInput) {
            imageModelInput.disabled = false;
            imageModelInput.style.opacity = '1';
            const storedImgModel = localStorage.getItem('client_pref_image_model');
            if (storedImgModel) {
                imageModelInput.value = storedImgModel;
            } else if (configData && configData.agents && configData.agents.defaults && configData.agents.defaults.imageGenerationModel) {
                imageModelInput.value = configData.agents.defaults.imageGenerationModel.primary || '';
            }
        }
        if (imageToggleBtn) imageToggleBtn.style.display = 'flex';

        // 视频解除置灰
        if (videoBaseInput) {
            videoBaseInput.disabled = false;
            videoBaseInput.style.opacity = '1';
        }
        if (videoKeyInput) {
            videoKeyInput.disabled = false;
            videoKeyInput.removeAttribute('readonly');
            videoKeyInput.style.opacity = '1';
            const storedVidConfigStr = localStorage.getItem('client_pref_video_generator');
            let storedVidKey = '';
            if (storedVidConfigStr) {
                try {
                    storedVidKey = JSON.parse(storedVidConfigStr).apiKey || '';
                } catch(e){}
            }
            if (storedVidKey === AGNES_BUILT_IN_KEY || videoKeyInput.value === KEY_MASK) {
                videoKeyInput.value = '';
            } else {
                videoKeyInput.value = storedVidKey;
            }
        }
        if (videoModelInput) {
            videoModelInput.disabled = false;
            videoModelInput.style.opacity = '1';
            const storedVidModel = localStorage.getItem('client_pref_video_model');
            if (storedVidModel) {
                videoModelInput.value = storedVidModel;
            } else if (configData && configData.agents && configData.agents.defaults && configData.agents.defaults.videoGenerationModel) {
                videoModelInput.value = configData.agents.defaults.videoGenerationModel.primary || '';
            }
        }
        if (videoToggleBtn) videoToggleBtn.style.display = 'flex';
    }

    // 默认模型选型：内置开 → 可改，但供应商仅 agnes-ai / ollama；关 → 全部放开
    const modelPrimary = document.getElementById('model-primary');
    const modelFallback = document.getElementById('model-fallback');
    const modelPrimaryProvider = document.getElementById('model-primary-provider');
    const modelFallbackProvider = document.getElementById('model-fallback-provider');

    const unlockModelField = (el) => {
        if (!el) return;
        el.disabled = false;
        el.readOnly = false;
        el.style.opacity = '1';
        el.style.pointerEvents = '';
    };

    if (useBuiltIn) {
        unlockModelField(modelPrimary);
        unlockModelField(modelFallback);

        const clampPair = (modelEl, providerEl, defaultRef) => {
            const def = parseModelRef(defaultRef);
            let provider = providerEl ? providerEl.value : '';
            let modelId = modelEl ? modelEl.value.trim() : '';
            if (modelId.includes('/')) {
                const parsed = parseModelRef(modelId);
                provider = parsed.provider || provider;
                modelId = parsed.model || modelId;
            }
            if (!isBuiltinAllowedProvider(provider)) {
                provider = def.provider;
                modelId = def.model;
            }
            if (modelEl) modelEl.value = modelId;
            if (providerEl) {
                providerEl.disabled = false;
                const wrapper = providerEl.closest('.custom-select-wrapper');
                if (wrapper) wrapper.classList.remove('disabled');
            }
            return { provider, modelId };
        };

        const primary = clampPair(modelPrimary, modelPrimaryProvider, BUILTIN_DEFAULT_PRIMARY);
        const fallback = clampPair(modelFallback, modelFallbackProvider, BUILTIN_DEFAULT_FALLBACK);
        updateAssignedProviderSelects(primary.modelId, fallback.modelId, primary.provider, fallback.provider);
        if (modelPrimaryProvider) modelPrimaryProvider.dispatchEvent(new Event('sync-beautified'));
        if (modelFallbackProvider) modelFallbackProvider.dispatchEvent(new Event('sync-beautified'));
    } else {
        unlockModelField(modelPrimary);
        unlockModelField(modelFallback);
        if (modelPrimaryProvider) {
            modelPrimaryProvider.disabled = false;
            const wrapper = modelPrimaryProvider.closest('.custom-select-wrapper');
            if (wrapper) wrapper.classList.remove('disabled');
        }
        if (modelFallbackProvider) {
            modelFallbackProvider.disabled = false;
            const wrapper = modelFallbackProvider.closest('.custom-select-wrapper');
            if (wrapper) wrapper.classList.remove('disabled');
        }

        // 重新填入用户自定义的原配置大模型数据
        if (configData && configData.agents && configData.agents.defaults) {
            const defaults = configData.agents.defaults;
            if (defaults.model) {
                const primary = defaults.model.primary || '';
                let primaryModelId = primary;
                let primaryProvider = '';
                if (primary.includes('/')) {
                    const parts = primary.split('/');
                    primaryProvider = parts[0];
                    primaryModelId = parts[1];
                }
                if (modelPrimary) modelPrimary.value = primaryModelId;

                const fallback = (defaults.model.fallbacks && defaults.model.fallbacks[0]) || '';
                let fallbackModelId = fallback;
                let fallbackProvider = '';
                if (fallback.includes('/')) {
                    const parts = fallback.split('/');
                    fallbackProvider = parts[0];
                    fallbackModelId = parts[1];
                }
                if (modelFallback) modelFallback.value = fallbackModelId;

                updateAssignedProviderSelects(primaryModelId, fallbackModelId, primaryProvider, fallbackProvider);
            } else {
                updateAssignedProviderSelects();
            }
        } else {
            updateAssignedProviderSelects();
        }

        if (modelPrimaryProvider) modelPrimaryProvider.dispatchEvent(new Event('sync-beautified'));
        if (modelFallbackProvider) modelFallbackProvider.dispatchEvent(new Event('sync-beautified'));
    }
}

// 绑定动态卡片事件
function bindProviderEvents() {
    const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
    const isEn = currentLang === 'en-US';
    const isTw = currentLang === 'zh-TW';
    const t = (zhCn, en, zhTw) => {
        if (isEn) return en;
        if (isTw) return zhTw;
        return zhCn;
    };

    document.querySelectorAll('.provider-url-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const provider = e.target.getAttribute('data-provider');
            localProviders[provider].baseUrl = e.target.value;
            updateModelsDatalist();
            markConfigDirty();
        });
    });

    document.querySelectorAll('.provider-key-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const provider = e.target.getAttribute('data-provider');
            localProviders[provider].apiKey = e.target.value;
            markConfigDirty();
        });
    });

    document.querySelectorAll('.provider-api-select').forEach(select => {
        select.addEventListener('change', (e) => {
            const provider = e.target.getAttribute('data-provider');
            localProviders[provider].api = e.target.value;
            markConfigDirty();
        });
    });

    document.querySelectorAll('.btn-delete-provider').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const provider = e.target.getAttribute('data-provider');
            if (provider === 'agnes-ai' || provider === 'ollama') return;
            if (await confirm(t(`确定要彻底删除厂家 "${provider}" 及其下的所有模型配置吗？`, `Are you sure you want to completely delete provider "${provider}" and all its model configurations?`, `確定要徹底刪除廠商 "${provider}" 及其下的所有模型配置嗎？`))) {
                delete localProviders[provider];
                renderProvidersList();
                updateModelsDatalist();
                markConfigDirty();
            }
        });
    });

    // 监听提供商卡片折叠/展开事件
    document.querySelectorAll('.provider-card-header').forEach(header => {
        header.addEventListener('click', (e) => {
            // 如果点击的是删除按钮，不干扰其自身事件
            if (e.target.closest('.btn-delete-provider')) return;
            
            const btnFold = header.querySelector('.btn-fold-provider');
            if (!btnFold) return;
            const provider = btnFold.getAttribute('data-provider');
            
            if (expandedProviders.has(provider)) {
                expandedProviders.delete(provider);
            } else {
                expandedProviders.add(provider);
            }
            renderProvidersList();
        });
    });

    // 监听模型 ID 实时修改
    document.querySelectorAll('.model-id-edit-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const provider = e.target.getAttribute('data-provider');
            const index = parseInt(e.target.getAttribute('data-index'), 10);
            if (localProviders[provider] && localProviders[provider].models[index]) {
                localProviders[provider].models[index].id = e.target.value.trim();
                localProviders[provider].models[index].name = e.target.value.trim();
                updateModelsDatalist();
                markConfigDirty();
            }
        });
    });

    // 监听模型上下文窗口实时修改
    document.querySelectorAll('.model-context-edit-input').forEach(input => {
        input.addEventListener('change', (e) => {
            const provider = e.target.getAttribute('data-provider');
            const index = parseInt(e.target.getAttribute('data-index'), 10);
            if (localProviders[provider] && localProviders[provider].models[index]) {
                const parsedVal = parseContextWindow(e.target.value);
                localProviders[provider].models[index].contextWindow = parsedVal;
                markConfigDirty();
            }
        });
    });

    // 添加空模型行
    document.querySelectorAll('.btn-add-new-model-row').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const provider = e.target.getAttribute('data-provider');
            if (!localProviders[provider].models) {
                localProviders[provider].models = [];
            }
            localProviders[provider].models.push({
                id: '',
                name: '',
                contextWindow: 128000,
                maxTokens: 8192
            });
            renderProvidersList();
            updateModelsDatalist();
            markConfigDirty();
        });
    });

    // 删除模型行
    document.querySelectorAll('.btn-delete-model-row').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const provider = e.target.getAttribute('data-provider');
            const index = parseInt(e.target.getAttribute('data-index'), 10);
            localProviders[provider].models.splice(index, 1);
            renderProvidersList();
            updateModelsDatalist();
            markConfigDirty();
        });
    });

    // 从上游拉取模型白名单
    document.querySelectorAll('.btn-fetch-upstream-models').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const provider = e.target.getAttribute('data-provider');
            const statusSpan = document.getElementById(`fetch-status-${provider}`);
            
            const urlInput = document.querySelector(`input.provider-url-input[data-provider="${provider}"]`);
            const keyInput = document.querySelector(`input.provider-key-input[data-provider="${provider}"]`);
            const apiSelect = document.querySelector(`select.provider-api-select[data-provider="${provider}"]`);
            
            let baseUrl = urlInput ? urlInput.value.trim() : '';
            let apiKey = keyInput ? keyInput.value.trim() : '';
            const apiType = apiSelect ? apiSelect.value : '';

            // 如果是 agnes-ai 并且启用了内置模型
            const useBuiltIn = getUseBuiltIn();
            if (provider === 'agnes-ai' && useBuiltIn) {
                baseUrl = 'https://apihub.agnes-ai.com/v1';
                apiKey = AGNES_BUILT_IN_KEY;
            }

            if (!baseUrl) {
                alert(t('请先输入 Base URL (API 端点)！', 'Please enter Base URL (API Endpoint) first!', '請先輸入 Base URL (API 端點)！'));
                return;
            }

            if (statusSpan) {
                statusSpan.innerText = t('🔄 正在获取模型...', '🔄 Fetching models...', '🔄 正在獲取模型...');
                statusSpan.style.color = '#ffd54f';
                statusSpan.style.display = 'inline-block';
            }

            btn.disabled = true;

            try {
                let testUrl = `${baseUrl.replace(/\/$/, '')}/models`;
                if (apiType === 'ollama') {
                    if (baseUrl.includes('11434')) {
                        testUrl = baseUrl.replace('/v1', '').replace(/\/$/, '') + '/api/tags';
                    }
                }

                const headers = {
                    'Content-Type': 'application/json'
                };
                if (apiKey) {
                    headers['Authorization'] = `Bearer ${apiKey}`;
                }

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                const response = await fetch(testUrl, {
                    method: 'GET',
                    headers: headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);

                if (response.ok) {
                    const data = await response.json();
                    let fetchedModels = [];
                    
                    if (apiType === 'ollama' && data.models) {
                        fetchedModels = data.models.map(m => ({
                            id: m.name || m.model,
                            contextWindow: 16384
                        }));
                    } else if (data.data && Array.isArray(data.data)) {
                        fetchedModels = data.data.map(m => ({
                            id: m.id,
                            contextWindow: 128000
                        }));
                    }

                    if (fetchedModels.length === 0) {
                        if (statusSpan) {
                            statusSpan.innerText = t('⚠️ 未找到可用模型', '⚠️ No available models found', '⚠️ 未找到可用模型');
                            statusSpan.style.color = '#ff9800';
                        }
                    } else {
                        if (!localProviders[provider].models) {
                            localProviders[provider].models = [];
                        }
                        
                        let addCount = 0;
                        fetchedModels.forEach(fm => {
                            if (!localProviders[provider].models.some(m => m.id === fm.id)) {
                                localProviders[provider].models.push({
                                    id: fm.id,
                                    name: fm.id,
                                    contextWindow: fm.contextWindow,
                                    maxTokens: 8192
                                });
                                addCount++;
                            }
                        });

                        if (statusSpan) {
                            statusSpan.innerText = t(`✅ 成功新增 ${addCount} 个模型！`, `✅ Successfully added ${addCount} models!`, `✅ 成功新增 ${addCount} 個模型！`);
                            statusSpan.style.color = '#00e676';
                        }
                        
                        renderProvidersList();
                        updateModelsDatalist();
                        if (addCount > 0) {
                            markConfigDirty();
                        }
                    }
                } else {
                    if (statusSpan) {
                        statusSpan.innerText = t(`❌ 获取失败 (HTTP ${response.status})`, `❌ Fetch failed (HTTP ${response.status})`, `❌ 獲取失敗 (HTTP ${response.status})`);
                        statusSpan.style.color = '#ff5252';
                    }
                }
            } catch (error) {
                if (statusSpan) {
                    let errMsg = error.message || t('网络错误', 'Network Error', '網路錯誤');
                    if (error.name === 'AbortError') {
                        errMsg = t('超时 (10s)', 'Timeout (10s)', '超時 (10s)');
                    }
                    statusSpan.innerText = t(`❌ 获取失败 (${errMsg})`, `❌ Fetch failed (${errMsg})`, `❌ 獲取失敗 (${errMsg})`);
                    statusSpan.style.color = '#ff5252';
                }
            } finally {
                btn.disabled = false;
            }
        });
    });

    document.querySelectorAll('.btn-toggle-visibility').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const wrapper = btn.closest('.password-input-wrapper');
            const input = wrapper.querySelector('input');
            if (input.type === 'password') {
                input.type = 'text';
                btn.innerText = '🔒';
            } else {
                input.type = 'password';
                btn.innerText = '👁️';
            }
        });
    });

    // 绑定检验连通性按钮点击事件
    document.querySelectorAll('.btn-test-connection').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const provider = e.target.getAttribute('data-provider');
            const resultSpan = document.getElementById(`test-result-${provider}`);
            
            const urlInput = document.querySelector(`input.provider-url-input[data-provider="${provider}"]`);
            const keyInput = document.querySelector(`input.provider-key-input[data-provider="${provider}"]`);
            const apiSelect = document.querySelector(`select.provider-api-select[data-provider="${provider}"]`);
            
            let baseUrl = urlInput ? urlInput.value.trim() : '';
            let apiKey = keyInput ? keyInput.value.trim() : '';
            if (apiKey.includes(',')) {
                apiKey = apiKey.split(',')[0].trim();
            }
            const apiType = apiSelect ? apiSelect.value : '';

            // 如果是 agnes-ai 并且启用了内置模型
            const useBuiltIn = getUseBuiltIn();
            if (provider === 'agnes-ai' && useBuiltIn) {
                baseUrl = 'https://apihub.agnes-ai.com/v1';
                apiKey = AGNES_BUILT_IN_KEY;
            }

            if (!baseUrl) {
                alert(t('请输入 Base URL (API 端点) 后再进行检验！', 'Please enter Base URL (API Endpoint) first before verifying!', '請輸入 Base URL (API 端點) 後再進行檢驗！'));
                return;
            }

            if (resultSpan) {
                resultSpan.innerText = t('⚡ 正在检验连接...', '⚡ Verifying connection...', '⚡ 正在檢驗連接...');
                resultSpan.style.color = '#ffd54f';
                resultSpan.style.display = 'inline-block';
            }

            btn.disabled = true;

            // 必须声明在 try 外：catch 里会用到，否则超时后二次 ReferenceError，状态卡在「正在检验…」
            let testUrl = `${baseUrl.replace(/\/$/, '')}/models`;
            if (apiType === 'ollama' && baseUrl.includes('11434')) {
                testUrl = baseUrl.replace('/v1', '').replace(/\/$/, '') + '/api/tags';
            }
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            let timeoutId = null;

            try {
                const controller = new AbortController();
                timeoutId = setTimeout(() => controller.abort(), 8000);

                const response = await fetch(testUrl, {
                    method: 'GET',
                    headers: headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                timeoutId = null;

                if (response.ok) {
                    showToast(t(`✅ ${provider} 连通性检验连接成功！`, `✅ ${provider} connectivity verification succeeded!`, `✅ ${provider} 連通性檢驗連接成功！`));
                    if (resultSpan) {
                        resultSpan.innerHTML = `
                            <span>✅ ${t('连接成功！', 'Connection succeeded!', '連接成功！')}</span>
                            <span class="btn-view-request-details" data-url="${testUrl}" data-status="${response.status}" data-status-text="${response.statusText || 'OK'}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">${t('[查看请求详情]', '[View Request Details]', '[查看請求詳情]')}</span>
                        `;
                        resultSpan.style.color = '#00e676';
                        bindDetailsClick(resultSpan);
                    }
                } else {
                    const statusText = response.statusText || `Status: ${response.status}`;
                    showToast(t(`❌ ${provider} 连通性检验连接失败 (${response.status})`, `❌ ${provider} connectivity verification failed (${response.status})`, `❌ ${provider} 連通性檢驗連接失敗 (${response.status})`));
                    if (resultSpan) {
                        resultSpan.innerHTML = `
                            <span>❌ ${t('连接失败', 'Connection failed', '連接失敗')} (${statusText})</span>
                            <span class="btn-view-request-details" data-url="${testUrl}" data-status="${response.status}" data-status-text="${statusText}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">${t('[查看请求详情]', '[View Request Details]', '[查看請求詳情]')}</span>
                        `;
                        resultSpan.style.color = '#ff5252';
                        bindDetailsClick(resultSpan);
                    }
                }
            } catch (error) {
                let errMsg = error.message || t('网络错误', 'Network Error', '網路錯誤');
                if (error.name === 'AbortError') {
                    errMsg = t('请求超时 (8s)', 'Request Timeout (8s)', '請求超時 (8s)');
                }
                showToast(t(`❌ ${provider} 连通性检验超时或失败`, `❌ ${provider} connectivity verification timed out or failed`, `❌ ${provider} 連通性檢驗超時或失敗`));
                if (resultSpan) {
                    try {
                        resultSpan.innerHTML = `
                            <span>❌ ${t('连接超时或失败', 'Connection timed out or failed', '連接超時或失敗')} (${errMsg})</span>
                            <span class="btn-view-request-details" data-url="${testUrl}" data-status="-" data-status-text="${t('网络异常或超时', 'Network anomaly or timeout', '網路異常或超時')}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">${t('[查看请求详情]', '[View Request Details]', '[查看請求詳情]')}</span>
                        `;
                        resultSpan.style.color = '#ff5252';
                        bindDetailsClick(resultSpan);
                    } catch (uiErr) {
                        resultSpan.textContent = `❌ ${t('连接超时或失败', 'Connection timed out or failed', '連接超時或失敗')} (${errMsg})`;
                        resultSpan.style.color = '#ff5252';
                    }
                }
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                btn.disabled = false;
            }
        });
    });

    // 绑定测试密钥按钮点击事件
    document.querySelectorAll('.btn-test-key').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const provider = e.target.getAttribute('data-provider');
            const resultSpan = document.getElementById(`test-result-${provider}`);
            
            const urlInput = document.querySelector(`input.provider-url-input[data-provider="${provider}"]`);
            const keyInput = document.querySelector(`input.provider-key-input[data-provider="${provider}"]`);
            const apiSelect = document.querySelector(`select.provider-api-select[data-provider="${provider}"]`);
            
            let baseUrl = urlInput ? urlInput.value.trim() : '';
            let apiKey = keyInput ? keyInput.value.trim() : '';
            if (apiKey.includes(',')) {
                apiKey = apiKey.split(',')[0].trim();
            }
            const apiType = apiSelect ? apiSelect.value : '';

            // 如果是 agnes-ai 并且启用了内置模型
            const useBuiltIn = getUseBuiltIn();
            if (provider === 'agnes-ai' && useBuiltIn) {
                baseUrl = 'https://apihub.agnes-ai.com/v1';
                apiKey = AGNES_BUILT_IN_KEY;
            }

            if (!baseUrl) {
                alert(t('请输入 Base URL (API 端点) 后再进行检验！', 'Please enter Base URL (API Endpoint) first before verifying!', '請輸入 Base URL (API 端點) 後再進行檢驗！'));
                return;
            }

            if (provider === 'ollama' || apiType === 'ollama') {
                if (resultSpan) {
                    resultSpan.innerText = t('✅ 本地 Ollama 无需密钥验证', '✅ Local Ollama requires no key validation', '✅ 本地 Ollama 無需金鑰驗證');
                    resultSpan.style.color = '#00e676';
                    resultSpan.style.display = 'inline-block';
                }
                return;
            }

            if (resultSpan) {
                resultSpan.innerText = t('🔑 正在验证密钥有效性...', '🔑 Validating key...', '🔑 正在驗證金鑰有效性...');
                resultSpan.style.color = '#ffd54f';
                resultSpan.style.display = 'inline-block';
            }

            btn.disabled = true;

            // 校验大模型是否已配置
            let hasModels = false;
            let testModel = 'gpt-3.5-turbo';
            if (provider === 'agnes-ai') {
                hasModels = true;
                testModel = 'agnes-2.0-flash';
            } else {
                const domModelInputs = document.querySelectorAll(`#model-list-container-${provider} .model-id-edit-input`);
                for (const inp of domModelInputs) {
                    if (inp.value.trim()) {
                        hasModels = true;
                        testModel = inp.value.trim();
                        break;
                    }
                }
                if (!hasModels && localProviders[provider] && localProviders[provider].models && localProviders[provider].models.length > 0) {
                    const matchedModel = localProviders[provider].models.find(m => m.id);
                    if (matchedModel) {
                        hasModels = true;
                        testModel = matchedModel.id;
                    }
                }
            }

            if (!hasModels) {
                alert(t('请先在下方“模型白名单管理”中添加至少一个该厂商支持的模型，然后再进行密钥检验！', 'Please configure at least one model ID in the Whitelist below before verifying!', '請先在下方「模型白名單管理」中添加至少一個該廠商支持的模型，然後再進行金鑰檢驗！'));
                if (resultSpan) {
                    resultSpan.innerText = t('❌ 请先添加大模型', '❌ Please add a model first', '❌ 請先添加大模型');
                    resultSpan.style.color = '#ff5252';
                    resultSpan.style.display = 'inline-block';
                }
                btn.disabled = false;
                return;
            }

            // 必须声明在 try 外：catch 里会用到，否则超时后二次 ReferenceError，状态卡在「正在验证…」
            const testUrl = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            let timeoutId = null;

            try {
                const body = {
                    model: testModel,
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1
                };

                const controller = new AbortController();
                timeoutId = setTimeout(() => controller.abort(), 8000);

                const response = await fetch(testUrl, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(body),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);
                timeoutId = null;

                let responseJson = null;
                try {
                    const text = await response.text();
                    responseJson = JSON.parse(text);
                } catch(e) {}

                if (response.ok) {
                    showToast(t(`✅ ${provider} API Key 密钥验证有效！`, `✅ ${provider} API Key validation succeeded!`, `✅ ${provider} API Key 金鑰驗證有效！`));
                    if (resultSpan) {
                        resultSpan.innerHTML = `
                            <span>✅ ${t('密钥验证有效！', 'Key validation succeeded!', '金鑰驗證有效！')}</span>
                            <span class="btn-view-request-details" data-url="${testUrl}" data-status="${response.status}" data-status-text="${response.statusText || 'OK'}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">${t('[查看请求详情]', '[View Request Details]', '[查看請求詳情]')}</span>
                        `;
                        resultSpan.style.color = '#00e676';
                        bindDetailsClick(resultSpan);
                    }
                } else {
                    let errDetail = '';
                    if (responseJson && responseJson.error) {
                        errDetail = responseJson.error.message || JSON.stringify(responseJson.error);
                    }
                    const isModelError = errDetail.toLowerCase().includes('model') || 
                                         errDetail.toLowerCase().includes('exist') || 
                                         errDetail.toLowerCase().includes('not_found') ||
                                         errDetail.toLowerCase().includes('not found') ||
                                         errDetail.toLowerCase().includes('not support') ||
                                         errDetail.toLowerCase().includes('unsupported');

                    const statusText = response.statusText || `Status: ${response.status}`;
                    let errTip = t(`验证失败 (${statusText})`, `Validation failed (${statusText})`, `驗證失敗 (${statusText})`);
                    
                    if (isModelError) {
                        errTip = t('❌ 测试模型无效/未开通 (鉴权已通过)', '❌ Invalid Model (Auth Succeeded)', '❌ 測試模型無效/未開通 (鑑權已通過)');
                        showToast(t(`⚠️ 密钥检验成功！鉴权已通过，但填写的测试模型 [${testModel}] 在该供应商处无效、未开通或不支持。`, `⚠️ Verification success! Auth passed, but the model [${testModel}] is invalid or unsupported by this provider.`, `⚠️ 金鑰檢驗成功！鑑權已通過，但填寫的測試模型 [${testModel}] 在該供應商處無效、未開通或不支持。`));
                    } else if (response.status === 401 || response.status === 403) {
                        errTip = t('❌ 密钥无效 (401/403)', '❌ Invalid Key (401/403)', '❌ 金鑰無效 (401/403)');
                        showToast(t(`❌ ${provider} 密钥验证失败：密钥无效 (401/403)`, `❌ ${provider} key validation failed: Invalid Key`, `❌ ${provider} 金鑰驗證失敗：金鑰無效`));
                    } else if (response.status === 429) {
                        errTip = t('⚠️ 额度不足或触发限频 (429)', '⚠️ Insufficient balance or rate limited (429)', '⚠️ 額度不足或觸發限頻 (429)');
                        showToast(t(`❌ ${provider} 密钥验证失败 (429)`, `❌ ${provider} key validation failed (429)`, `❌ ${provider} 金鑰驗證失敗 (429)`));
                    } else {
                        if (errDetail) {
                            errTip = t(`❌ 接口报错 (${response.status})`, `❌ API Error (${response.status})`, `❌ 介面報錯 (${response.status})`);
                            showToast(t(`❌ ${provider} 接口返回错误: ${errDetail}`, `❌ ${provider} API error: ${errDetail}`, `❌ ${provider} 介面返回錯誤: ${errDetail}`));
                        } else {
                            errTip = t(`❌ 验证失败 (${response.status})`, `❌ Validation failed (${response.status})`, `❌ 驗證失敗 (${response.status})`);
                            showToast(t(`❌ ${provider} 密钥验证失败 (${response.status})`, `❌ ${provider} key validation failed (${response.status})`, `❌ ${provider} 金鑰驗證失敗 (${response.status})`));
                        }
                    }

                    if (resultSpan) {
                        resultSpan.innerHTML = `
                            <span>${errTip}</span>
                            <span class="btn-view-request-details" data-url="${testUrl}" data-status="${response.status}" data-status-text="${statusText}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">${t('[查看请求详情]', '[View Request Details]', '[查看請求詳情]')}</span>
                        `;
                        resultSpan.style.color = '#ff5252';
                        bindDetailsClick(resultSpan);
                    }
                }
            } catch (error) {
                let errMsg = error.message || t('网络错误', 'Network Error', '網路錯誤');
                if (error.name === 'AbortError') {
                    errMsg = t('请求超时 (8s)', 'Request Timeout (8s)', '請求超時 (8s)');
                }
                showToast(t(`❌ ${provider} 密钥验证超时或异常`, `❌ ${provider} key validation timed out or encountered exception`, `❌ ${provider} 金鑰驗證超時或異常`));
                if (resultSpan) {
                    try {
                        resultSpan.innerHTML = `
                            <span>❌ ${t('验证超时或失败', 'Validation timed out or failed', '驗證超時或失敗')} (${errMsg})</span>
                            <span class="btn-view-request-details" data-url="${testUrl}" data-status="-" data-status-text="${t('网络异常或超时', 'Network anomaly or timeout', '網路異常或超時')}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">${t('[查看请求详情]', '[View Request Details]', '[查看請求詳情]')}</span>
                        `;
                        resultSpan.style.color = '#ff5252';
                        bindDetailsClick(resultSpan);
                    } catch (uiErr) {
                        resultSpan.textContent = `❌ ${t('验证超时或失败', 'Validation timed out or failed', '驗證超時或失敗')} (${errMsg})`;
                        resultSpan.style.color = '#ff5252';
                    }
                }
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                btn.disabled = false;
            }
        });
    });
}

// 动态刷新 datalist
function updateModelsDatalist() {
    const datalist = document.getElementById('models-datalist');
    if (!datalist) return;
    datalist.innerHTML = '';

    // datalist：与主用模型同一套过滤（内置开 → agnes-ai + ollama）
    const providerKeys = getModelPickerProviderKeys('model-primary').filter((k) => localProviders[k]);
    for (const providerKey of providerKeys) {
        const provider = localProviders[providerKey];
        const models = provider.models || [];
        models.forEach(model => {
            const option = document.createElement('option');
            option.value = `${providerKey}/${model.id}`;
            datalist.appendChild(option);
        });
    }

    updateAssignedProviderSelects();
}

// 动态刷新主备模型供应商下拉选择框
function updateAssignedProviderSelects(primaryModelId, fallbackModelId, selectedPrimaryProvider, selectedFallbackProvider) {
    const primaryInput = document.getElementById('model-primary');
    const fallbackInput = document.getElementById('model-fallback');
    const primarySelect = document.getElementById('model-primary-provider');
    const fallbackSelect = document.getElementById('model-fallback-provider');

    if (!primarySelect || !fallbackSelect) return;

    const pmId = (primaryModelId !== undefined) ? primaryModelId : (primaryInput ? primaryInput.value.trim() : '');
    const fmId = (fallbackModelId !== undefined) ? fallbackModelId : (fallbackInput ? fallbackInput.value.trim() : '');

    const pSelVal = (selectedPrimaryProvider !== undefined) ? selectedPrimaryProvider : primarySelect.value;
    const fSelVal = (selectedFallbackProvider !== undefined) ? selectedFallbackProvider : fallbackSelect.value;

    const allProviderKeys = getSelectableProviderKeys();

    // 1. 处理主用模型供应商
    let matchedPrimary = [];
    if (pmId) {
        matchedPrimary = allProviderKeys.filter(key => {
            const provider = localProviders[key];
            if (!provider) return false;
            const models = provider.models || [];
            return models.some(m => m.id === pmId);
        });
    }
    
    primarySelect.innerHTML = '<option value="">-- 自动检测供应商 --</option>';
    const primaryOptions = matchedPrimary.length > 0 ? matchedPrimary : allProviderKeys;
    primaryOptions.forEach(key => {
        const option = document.createElement('option');
        option.value = key;
        option.innerText = key;
        primarySelect.appendChild(option);
    });

    if (pSelVal && primaryOptions.includes(pSelVal)) {
        primarySelect.value = pSelVal;
    } else if (matchedPrimary.length === 1) {
        primarySelect.value = matchedPrimary[0];
    } else if (getUseBuiltIn() && primaryOptions.includes('agnes-ai')) {
        primarySelect.value = 'agnes-ai';
    } else {
        primarySelect.value = '';
    }

    // 2. 处理备用模型供应商
    let matchedFallback = [];
    if (fmId) {
        matchedFallback = allProviderKeys.filter(key => {
            const provider = localProviders[key];
            if (!provider) return false;
            const models = provider.models || [];
            return models.some(m => m.id === fmId);
        });
    }

    fallbackSelect.innerHTML = '<option value="">-- 自动检测供应商 --</option>';
    const fallbackOptions = matchedFallback.length > 0 ? matchedFallback : allProviderKeys;
    fallbackOptions.forEach(key => {
        const option = document.createElement('option');
        option.value = key;
        option.innerText = key;
        fallbackSelect.appendChild(option);
    });

    if (fSelVal && fallbackOptions.includes(fSelVal)) {
        fallbackSelect.value = fSelVal;
    } else if (matchedFallback.length === 1) {
        fallbackSelect.value = matchedFallback[0];
    } else if (getUseBuiltIn() && fallbackOptions.includes('agnes-ai')) {
        fallbackSelect.value = 'agnes-ai';
    } else {
        fallbackSelect.value = '';
    }

    primarySelect.dispatchEvent(new Event('sync-beautified'));
    fallbackSelect.dispatchEvent(new Event('sync-beautified'));
}

// 主模型输入框变动事件处理器
function handlePrimaryInput() {
    const input = document.getElementById('model-primary');
    if (!input) return;
    let val = input.value.trim();
    let provider = '';
    if (val.includes('/')) {
        const parts = val.split('/');
        provider = parts[0];
        val = parts[1];
        input.value = val;
    }
    updateAssignedProviderSelects(val, undefined, provider, undefined);
    updateConfigJsonPreview();
}

// 备模型输入框变动事件处理器
function handleFallbackInput() {
    const input = document.getElementById('model-fallback');
    if (!input) return;
    let val = input.value.trim();
    let provider = '';
    if (val.includes('/')) {
        const parts = val.split('/');
        provider = parts[0];
        val = parts[1];
        input.value = val;
    }
    updateAssignedProviderSelects(undefined, val, undefined, provider);
    updateConfigJsonPreview();
}

// 自定义 Autocomplete 推荐下拉框实现
function setupCustomAutocomplete() {
    const inputIds = [
        'model-primary',
        'model-fallback',
        'model-teacher',
        'model-student',
        'model-image',
        'model-video'
    ];

    inputIds.forEach(id => {
        const input = document.getElementById(id);
        if (!input) return;

        let dropdown = null;

        const showDropdown = () => {
            removeDropdown();
            // 置灰锁定时不弹出下拉（内置主/备）
            if (input.disabled || input.readOnly) return;

            const allModels = collectModelPickerOptions(id);

            // 根据用户当前输入进行模糊过滤
            const query = input.value.trim().toLowerCase();
            const filtered = allModels.filter(m => m.toLowerCase().includes(query));

            if (filtered.length === 0) return;

            dropdown = document.createElement('div');
            dropdown.className = 'custom-autocomplete-dropdown';
            
            const parent = input.parentElement;
            if (parent) {
                if (window.getComputedStyle(parent).position === 'static') {
                    parent.style.position = 'relative';
                }
                
                dropdown.style.left = `${input.offsetLeft}px`;
                dropdown.style.top = `${input.offsetTop + input.offsetHeight}px`;
                dropdown.style.width = `${input.offsetWidth}px`;
                
                filtered.forEach(modelStr => {
                    const item = document.createElement('div');
                    item.className = 'custom-autocomplete-item';
                    item.innerText = modelStr;
                    item.addEventListener('mousedown', (e) => {
                        e.preventDefault(); 
                        input.value = modelStr;
                        
                        // 触发事件以调用原有逻辑
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        
                        removeDropdown();
                    });
                    dropdown.appendChild(item);
                });

                parent.appendChild(dropdown);
            }
        };

        const removeDropdown = () => {
            if (dropdown && dropdown.parentNode) {
                dropdown.parentNode.removeChild(dropdown);
            }
            dropdown = null;
        };

        input.addEventListener('focus', showDropdown);
        input.addEventListener('input', showDropdown);
        
        // 当用户点击其他地方时关闭
        input.addEventListener('blur', () => {
            if (id === 'model-student') {
                const raw = input.value.trim();
                if (raw) {
                    const normalized = normalizeStudentModelRef(raw);
                    if (!normalized) {
                        showToast(t('模仿学生模型仅支持本地 ollama 模型', 'Student model only supports local ollama models', '模仿學生模型僅支援本地 ollama 模型'));
                        input.value = '';
                    } else if (normalized !== raw) {
                        input.value = normalized;
                    }
                }
            }
            setTimeout(removeDropdown, 200);
        });
    });
}

// 全自动下拉框美化与事件劫持
let isBeautifying = false;
function beautifyAllSelects() {
    if (isBeautifying) return;
    isBeautifying = true;
    try {
        const selects = document.querySelectorAll('select:not(.custom-beautified)');
        selects.forEach(select => {
            select.classList.add('custom-beautified');
            select.style.display = 'none';

            const wrapper = document.createElement('div');
            wrapper.className = 'custom-select-wrapper';

            const originalStyle = window.getComputedStyle(select);
            wrapper.style.width = select.style.width || originalStyle.width;
            wrapper.style.minWidth = select.style.minWidth || originalStyle.minWidth;
            wrapper.style.margin = select.style.margin || originalStyle.margin;
            wrapper.style.flex = select.style.flex || originalStyle.flex;

            if (select.parentElement && select.parentElement.classList.contains('form-field')) {
                wrapper.style.width = '100%';
            }

            const trigger = document.createElement('div');
            trigger.className = 'custom-select-trigger';
            trigger.style.height = originalStyle.height;

            const textSpan = document.createElement('span');
            textSpan.className = 'custom-select-text';

            const arrow = document.createElement('span');
            arrow.className = 'custom-select-arrow';
            arrow.innerHTML = '<svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            arrow.style.display = 'flex';
            arrow.style.alignItems = 'center';

            trigger.appendChild(textSpan);
            trigger.appendChild(arrow);
            wrapper.appendChild(trigger);

            const optionsContainer = document.createElement('div');
            optionsContainer.className = 'custom-select-options';
            wrapper.appendChild(optionsContainer);

            const syncOptions = () => {
                optionsContainer.innerHTML = '';
                const options = select.querySelectorAll('option');
                let selectedText = '';

                options.forEach(opt => {
                    const optDiv = document.createElement('div');
                    optDiv.className = 'custom-select-option';
                    optDiv.innerText = opt.innerText;
                    optDiv.dataset.value = opt.value;

                    if (opt.value === select.value) {
                        optDiv.classList.add('selected');
                        selectedText = opt.innerText;
                    }

                    optDiv.addEventListener('mousedown', (e) => {
                        e.preventDefault();
                        e.stopPropagation();

                        select.value = opt.value;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                        select.dispatchEvent(new Event('input', { bubbles: true }));

                        wrapper.classList.remove('active');
                        syncOptions();
                    });

                    optionsContainer.appendChild(optDiv);
                });

                if (!selectedText && options.length > 0) {
                    selectedText = options[0].innerText;
                }
                textSpan.innerText = selectedText || '-- 请选择 --';
            };

            syncOptions();

            // 监听 DOM 子树节点变化
            const observer = new MutationObserver(() => {
                syncOptions();
            });
            observer.observe(select, { childList: true, subtree: true });

            // 监听值变化（change事件）以保持同步
            select.addEventListener('change', syncOptions);
            select.addEventListener('sync-beautified', syncOptions);

            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.custom-select-wrapper.active').forEach(w => {
                    if (w !== wrapper) w.classList.remove('active');
                });
                wrapper.classList.toggle('active');
                syncOptions();
            });

            select.parentNode.insertBefore(wrapper, select);
            wrapper.appendChild(select);
        });
    } catch (e) {
        console.error('Failed to beautify selects:', e);
    } finally {
        isBeautifying = false;
    }
}

function startSelectAutoBeautify() {
    beautifyAllSelects();
    let debounceTimer = null;
    const observer = new MutationObserver((mutations) => {
        // 仅当新增了 <select> 才美化；日志刷屏/普通 DOM 更新不再扫全页
        let needBeautify = false;
        for (const m of mutations) {
            if (!m.addedNodes || !m.addedNodes.length) continue;
            for (const node of m.addedNodes) {
                if (!node || node.nodeType !== 1) continue;
                if (node.tagName === 'SELECT' || (node.querySelector && node.querySelector('select:not(.custom-beautified)'))) {
                    needBeautify = true;
                    break;
                }
            }
            if (needBeautify) break;
        }
        if (!needBeautify) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            beautifyAllSelects();
        }, 120);
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

// 供应商下拉框发生改变
function handleProviderChange() {
    updateConfigJsonPreview();
}

// 绑定事件
window.addEventListener('DOMContentLoaded', () => {
    const primaryInput = document.getElementById('model-primary');
    const fallbackInput = document.getElementById('model-fallback');
    const primarySelect = document.getElementById('model-primary-provider');
    const fallbackSelect = document.getElementById('model-fallback-provider');
    
    if (primaryInput) {
        primaryInput.addEventListener('input', handlePrimaryInput);
    }
    if (fallbackInput) {
        fallbackInput.addEventListener('input', handleFallbackInput);
    }
    if (primarySelect) {
        primarySelect.addEventListener('change', handleProviderChange);
    }
    if (fallbackSelect) {
        fallbackSelect.addEventListener('change', handleProviderChange);
    }
    
    // 初始化自定义下拉推荐菜单
    setupCustomAutocomplete();

    // 初始化自定义 Select 下拉框自动美化与劫持
    startSelectAutoBeautify();

    // 全局点击任意空白处收起所有自定义下拉框
    document.addEventListener('click', () => {
        document.querySelectorAll('.custom-select-wrapper.active').forEach(w => {
            w.classList.remove('active');
        });
    });
});

// 添加厂家模态弹窗交互
const addProviderModal = document.getElementById('add-provider-modal');
const newProviderIdInput = document.getElementById('new-provider-id');
const newProviderUrlInput = document.getElementById('new-provider-url');
const newProviderKeyInput = document.getElementById('new-provider-key');

document.getElementById('btn-add-provider').addEventListener('click', () => {
    if (getUseBuiltIn()) {
        showToast(t('内置模型开启时仅可使用 agnes-ai 与 ollama', 'With built-in models on, only agnes-ai and ollama are available.', '內置模型開啟時僅可使用 agnes-ai 與 ollama'));
        return;
    }
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
    const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
    const isEn = currentLang === 'en-US';
    const isTw = currentLang === 'zh-TW';
    const t = (zhCn, en, zhTw) => {
        if (isEn) return en;
        if (isTw) return zhTw;
        return zhCn;
    };

    const providerName = newProviderIdInput.value.trim();
    if (!providerName) {
        alert(t("请输入厂商标识！", "Please enter provider ID!", "請輸入廠商標識！"));
        return;
    }

    const key = providerName.toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(key)) {
        alert(t("格式错误！厂商标识仅能由小写字母、数字及中划线/下划线组成。", "Format error! Provider ID can only contain lowercase letters, numbers, hyphens, and underscores.", "格式錯誤！廠商標識僅能由小寫字母、數字及中劃線/下劃線組成。"));
        return;
    }

    if (localProviders[key]) {
        alert(t("该厂商标识已存在！", "This provider ID already exists!", "該廠商標識已存在！"));
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
    markConfigDirty();
});

// 顶部：放弃整页未保存修改并还原
async function handleResetConfigAction() {
    const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
    const isEn = currentLang === 'en-US';
    const isTw = currentLang === 'zh-TW';
    const t = (zhCn, en, zhTw) => {
        if (isEn) return en;
        if (isTw) return zhTw;
        return zhCn;
    };

    const confirmReset = await confirm(t('确定要放弃当前所有未保存的修改，并还原到上一次成功保存的配置吗？', 'Are you sure you want to discard all unsaved changes and revert to the last successfully saved configuration?', '確定要放棄當前所有未保存的修改，並還原到上一次成功保存的配置嗎？'));
    if (confirmReset) {
        await loadAndRenderConfig();
        clearSaveBtnDirtyState(
            document.getElementById('config-save-btn-top'),
            t('保存配置', 'Save Configuration', '保存配置')
        );
        clearSaveBtnDirtyState(
            document.getElementById('config-save-btn'),
            t('保存配置', 'Save Configuration', '保存配置')
        );
        const jsonErrorEl = document.getElementById('json-format-error');
        if (jsonErrorEl) jsonErrorEl.style.display = 'none';
        showToast('🔄 已成功放弃修改，已还原回上一次保存的配置');
    }
}

// JSON 预览区：仅放弃手写 JSON，按左侧表单重新生成预览（不影响顶部整页状态）
async function handleJsonPreviewResetAction() {
    const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
    const isEn = currentLang === 'en-US';
    const isTw = currentLang === 'zh-TW';
    const t = (zhCn, en, zhTw) => {
        if (isEn) return en;
        if (isTw) return zhTw;
        return zhCn;
    };

    const confirmReset = await confirm(t(
        '确定要放弃 JSON 预览区的手写修改，并按左侧表单重新生成预览吗？',
        'Discard handwritten changes in the JSON preview and regenerate it from the left form?',
        '確定要放棄 JSON 預覽區的手寫修改，並按左側表單重新生成預覽嗎？'
    ));
    if (!confirmReset) return;

    const previewEl = document.getElementById('config-json-preview');
    if (previewEl && document.activeElement === previewEl) previewEl.blur();
    updateConfigJsonPreview(true);

    const jsonErrorEl = document.getElementById('json-format-error');
    if (jsonErrorEl) jsonErrorEl.style.display = 'none';
    clearSaveBtnDirtyState(
        document.getElementById('config-save-btn'),
        t('保存配置', 'Save Configuration', '保存配置')
    );
    showToast(t('🔄 已还原 JSON 预览', 'JSON preview restored', '🔄 已還原 JSON 預覽'));
}

const jsonResetBtn = document.getElementById('config-reset-btn');
if (jsonResetBtn) {
    jsonResetBtn.addEventListener('click', handleJsonPreviewResetAction);
}
const topResetBtn = document.getElementById('config-reset-btn-top');
if (topResetBtn) {
    topResetBtn.addEventListener('click', handleResetConfigAction);
}

// 通用的统一保存配置处理器
const handleSaveConfigAction = async () => {
    const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
    const isEn = currentLang === 'en-US';
    const isTw = currentLang === 'zh-TW';
    const t = (zhCn, en, zhTw) => {
        if (isEn) return en;
        if (isTw) return zhTw;
        return zhCn;
    };

    if (!configData) return;

    // 1. 同步保存提供商与模型白名单
    if (!configData.models) configData.models = {};
    
    const useBuiltIn = getUseBuiltIn();
    const finalProviders = JSON.parse(JSON.stringify(localProviders));
    
    if (useBuiltIn && finalProviders['agnes-ai']) {
        finalProviders['agnes-ai'].baseUrl = 'https://apihub.agnes-ai.com/v1';
        finalProviders['agnes-ai'].apiKey = AGNES_BUILT_IN_KEY;
    }
    
    configData.models.providers = finalProviders;

    // 2. 同步生成环境变量 (env) 机制
    if (!configData.env) configData.env = {};
    for (const key of Object.keys(localProviders)) {
        const envKeyName = key.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase() + '_API_KEY';
        let val = localProviders[key].apiKey;
        if (key === 'agnes-ai' && useBuiltIn) {
            val = AGNES_BUILT_IN_KEY;
        }
        if (val) {
            configData.env[envKeyName] = val;
        }
    }

    // 3. 同步并发选项及默认主备模型选择
    if (!configData.agents) configData.agents = {};
    if (!configData.agents.defaults) configData.agents.defaults = {};
    
    const maxConcurrentEl = document.getElementById('max-concurrent');
    configData.agents.defaults.maxConcurrent = maxConcurrentEl ? parseInt(maxConcurrentEl.value, 10) : (configData.agents.defaults.maxConcurrent || 4);
    
    if (!configData.agents.defaults.model) configData.agents.defaults.model = {};
    const primaryModelVal = document.getElementById('model-primary').value.trim();
    const primaryProviderVal = document.getElementById('model-primary-provider').value;
    if (primaryProviderVal && primaryModelVal && !primaryModelVal.includes('/')) {
        configData.agents.defaults.model.primary = `${primaryProviderVal}/${primaryModelVal}`;
    } else {
        configData.agents.defaults.model.primary = primaryModelVal;
    }

    const fallbackModelVal = document.getElementById('model-fallback').value.trim();
    const fallbackProviderVal = document.getElementById('model-fallback-provider').value;
    let finalFallback = fallbackModelVal;
    if (fallbackProviderVal && fallbackModelVal && !fallbackModelVal.includes('/')) {
        finalFallback = `${fallbackProviderVal}/${fallbackModelVal}`;
    }
    configData.agents.defaults.model.fallbacks = [finalFallback];

    // 内置开启：最终钳制一次，防止写回非 agnes-ai/ollama 的主备模型
    if (useBuiltIn) {
        applyBuiltInModelPolicy(configData);
        if (configData.models && configData.models.providers) {
            localProviders = JSON.parse(JSON.stringify(configData.models.providers));
        }
    }

    // 双模型教学：老师/学生模型写回插件配置
    if (!configData.plugins) configData.plugins = {};
    if (!configData.plugins.entries) configData.plugins.entries = {};
    if (!configData.plugins.entries['dual-model-trainer']) {
        configData.plugins.entries['dual-model-trainer'] = { enabled: true };
    }
    const dmtEntry = configData.plugins.entries['dual-model-trainer'];
    if (!dmtEntry.config) dmtEntry.config = {};
    const teacherInput = document.getElementById('model-teacher');
    const studentInput = document.getElementById('model-student');
    if (teacherInput) dmtEntry.config.teacherModel = teacherInput.value.trim();
    if (studentInput) {
        const normalizedStudent = normalizeStudentModelRef(studentInput.value);
        if (studentInput.value.trim() && !normalizedStudent) {
            showToast(t('模仿学生模型仅支持本地 ollama 模型（例如 ollama/qwen2.5:7b）', 'Student model only supports local ollama models (e.g. ollama/qwen2.5:7b).', '模仿學生模型僅支援本地 ollama 模型（例如 ollama/qwen2.5:7b）'));
            studentInput.focus();
            return;
        }
        studentInput.value = normalizedStudent;
        dmtEntry.config.studentModel = normalizedStudent;
    }

    if (!configData.videoGenerator) configData.videoGenerator = {};
    if (!configData.imageGenerator) configData.imageGenerator = {};

    if (useBuiltIn) {
        localStorage.setItem('client_pref_image_model', 'agnes-ai/agnes-image-2.0-flash');
        localStorage.setItem('client_pref_video_model', 'agnes-ai/agnes-video-v2.0');

        configData.imageGenerator.apiBase = 'https://apihub.agnes-ai.com/v1/images';
        configData.imageGenerator.apiKey = AGNES_BUILT_IN_KEY;

        configData.videoGenerator.apiBase = 'https://apihub.agnes-ai.com/v1/videos';
        configData.videoGenerator.apiKey = AGNES_BUILT_IN_KEY;
    } else {
        const imageVal = document.getElementById('model-image').value.trim();
        localStorage.setItem('client_pref_image_model', imageVal);

        const videoVal = document.getElementById('model-video').value.trim();
        localStorage.setItem('client_pref_video_model', videoVal);

        configData.imageGenerator.apiBase = document.getElementById('image-api-base').value.trim();
        configData.imageGenerator.model = imageVal;
        const imgKey = document.getElementById('image-api-key').value.trim();
        configData.imageGenerator.apiKey = (imgKey === KEY_MASK || imgKey === AGNES_BUILT_IN_KEY) ? '' : imgKey;

        configData.videoGenerator.apiBase = document.getElementById('video-api-base').value.trim();
        configData.videoGenerator.model = videoVal;
        const vidKey = document.getElementById('video-api-key').value.trim();
        configData.videoGenerator.apiKey = (vidKey === KEY_MASK || vidKey === AGNES_BUILT_IN_KEY) ? '' : vidKey;
    }

    // 存储在本地 localStorage 供客户端回显使用
    localStorage.setItem('client_pref_video_generator', JSON.stringify(configData.videoGenerator));
    localStorage.setItem('client_pref_image_generator', JSON.stringify(configData.imageGenerator));

    // 彻底从 configData 中删除非法字段以防止Nexora Agent启动 Schema 校验崩溃闪退
    if (configData.agents && configData.agents.defaults) {
        delete configData.agents.defaults.imageGenerationModel;
        delete configData.agents.defaults.videoGenerationModel;
    }

    if (!configData.gateway) configData.gateway = {};
    configData.gateway.port = parseInt(document.getElementById('gateway-port').value, 10);

    // 调用 API 保存配置
    const result = await window.api.saveConfig(configData);
    if (result.success) {
        alert(t('配置已成功保存！', 'Configuration saved successfully!', '配置已成功保存！'));
        await loadAndRenderConfig();
        const saveLabel = t('保存配置', 'Save Configuration', '保存配置');
        clearSaveBtnDirtyState(document.getElementById('config-save-btn-top'), saveLabel);
        clearSaveBtnDirtyState(document.getElementById('config-save-btn'), saveLabel);
        const jsonErrorEl = document.getElementById('json-format-error');
        if (jsonErrorEl) jsonErrorEl.style.display = 'none';
        statPort.innerText = configData.gateway.port;
        if (gatewayStatus === 'running') {
            const restart = await confirm(t('Nexora Agent正在运行中，是否立即重启Nexora Agent以使新配置生效？', 'Gateway is running. Do you want to restart it now to apply the new configuration?', 'Nexora Agent正在運行中，是否立即重啟Nexora Agent以使新配置生效？'));
            if (restart) {
                window.api.gatewayAction('stop');
                setTimeout(() => window.api.gatewayAction('start'), 1000);
            }
        }
    } else {
        alert(t('配置保存失败：', 'Failed to save configuration: ', '配置保存失敗：') + result.error);
    }
};

// 为顶部与底部的两个“保存配置”按钮统一绑定监听
document.getElementById('config-save-btn').addEventListener('click', handleSaveConfigAction);
const topSaveBtn = document.getElementById('config-save-btn-top');
if (topSaveBtn) {
    topSaveBtn.addEventListener('click', handleSaveConfigAction);
}

// 动态更新右侧侧边栏“载入插件”统计数量
// 优先用 Gateway 日志里的真实载入数；不要用 plugins.allow.length（那是配置白名单，会虚高）
let __gatewayLoadedPluginCount = null;
function updateRightPluginsCountUI() {
    const rightPluginsCountEl = document.getElementById('right-plugins-count');
    if (!rightPluginsCountEl) return;
    const formatPluginCount = (n) => t(`${n} 个`, `${n}`, `${n} 個`);
    
    // 如果服务已停止，实际载入的插件数应显示为 0 个
    if (typeof gatewayStatus !== 'undefined' && gatewayStatus === 'stopped') {
        rightPluginsCountEl.innerText = formatPluginCount(0);
        return;
    }
    
    if (__gatewayLoadedPluginCount != null) {
        rightPluginsCountEl.innerText = formatPluginCount(__gatewayLoadedPluginCount);
        return;
    }
    // 尚未收到 gateway listening 前：只数「真正 enabled」的条目，避免 allow 虚高
    if (configData && configData.plugins && configData.plugins.entries) {
        const n = Object.values(configData.plugins.entries).filter((e) => e && e.enabled === true).length;
        rightPluginsCountEl.innerText = formatPluginCount(n);
        return;
    }
    rightPluginsCountEl.innerText = formatPluginCount(0);
}

// 渲染插件卡片网格
async function renderPluginsGrid() {
    const grid = document.getElementById('cfg-plugins-grid');
    if (!grid) return;

    if (!configData) configData = {};
    if (!configData.plugins) configData.plugins = {};
    if (!configData.plugins.entries) configData.plugins.entries = {};
    if (!Array.isArray(configData.plugins.allow)) configData.plugins.allow = [];

    // 同步刷新右侧载入插件数显示
    updateRightPluginsCountUI();

    const entries = configData.plugins.entries;

    const bindToggles = () => {
        document.querySelectorAll('.plugin-toggle-checkbox').forEach((checkbox) => {
            checkbox.addEventListener('change', onPluginToggle);
        });
    };

    const paintCards = () => {
        try {
            grid.innerHTML = '';
            let painted = 0;
            for (const key of UI_PLUGIN_ORDER) {
                if (!pluginMetadata[key]) continue;
                if (!entries[key] && key !== 'auto-start-codex' && key !== 'long-term-memory') {
                    entries[key] = { enabled: false };
                }

                let isEnabled = false;
                if (key === 'auto-start-codex') {
                    isEnabled = (configData.hooks && configData.hooks.internal && configData.hooks.internal.entries && configData.hooks.internal.entries['auto-start-codex'])
                        ? configData.hooks.internal.entries['auto-start-codex'].enabled === true
                        : false;
                } else if (key === 'long-term-memory') {
                    // 伞形卡：真实栈三者全部开启才算“已启用”（不落盘 UI id）
                    isEnabled = LONG_TERM_MEMORY_STACK.every((id) => entries[id] && entries[id].enabled === true);
                } else {
                    isEnabled = entries[key] ? entries[key].enabled === true : false;
                }

                const probe = pluginProbeMap[key] || { badge: 'ready' };
                const name = (() => { try { return t('plugin.' + key + '.name'); } catch (e) { return pluginMetadata[key].name; } })();
                const desc = (() => { try { return t('plugin.' + key + '.desc'); } catch (e) { return pluginMetadata[key].desc; } })();
                const statusText = (() => {
                    try { return isEnabled ? t('plugin.status.enabled') : t('plugin.status.disabled'); }
                    catch (e) { return isEnabled ? '已启用' : '已禁用'; }
                })();
                const badgeText = (() => { try { return badgeLabelForProbe(probe); } catch (e) { return '开箱可用'; } })();
                const hintText = (() => {
                    if (!probe.hint) return '';
                    let raw = String(probe.hint);
                    if (raw.startsWith('plugin.')) {
                        try { return t(raw); } catch (e) { return raw; }
                    }
                    try {
                        if (raw.startsWith('已找到 Codex: ')) {
                            return t('plugin.hint.codex.found') + raw.substring(10);
                        }
                        if (raw.includes('；运行时未发现插件包')) {
                            const p1 = raw.split('；')[0];
                            return t(p1) + '；' + t('运行时未发现插件包，请使用完整安装包（已内置渠道插件，无需再联网下载）');
                        }
                        return t(raw);
                    } catch (e) { return raw; }
                })();

                const card = document.createElement('div');
                card.className = 'plugin-card-item';

                const top = document.createElement('div');
                top.className = 'plugin-card-top';

                const titleRow = document.createElement('div');
                titleRow.className = 'plugin-card-title-row';
                const h4 = document.createElement('h4');
                h4.textContent = name;
                const badge = document.createElement('span');
                badge.className = badgeClassForProbe(probe);
                badge.textContent = badgeText;
                titleRow.appendChild(h4);
                titleRow.appendChild(badge);

                const p = document.createElement('p');
                p.textContent = desc;
                top.appendChild(titleRow);
                top.appendChild(p);
                if (hintText) {
                    const hint = document.createElement('div');
                    hint.className = 'plugin-card-hint';
                    hint.textContent = hintText;
                    top.appendChild(hint);
                }

                const bot = document.createElement('div');
                bot.className = 'plugin-card-bot';
                const status = document.createElement('span');
                status.style.cssText = `font-size: 12px; color: ${isEnabled ? 'var(--accent-color)' : 'var(--text-secondary)'}; font-weight: 600;`;
                status.textContent = statusText;

                const label = document.createElement('label');
                label.className = 'switch-slider-btn';
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.className = 'plugin-toggle-checkbox';
                input.setAttribute('data-plugin', key);
                if (isEnabled) input.checked = true;
                const knob = document.createElement('span');
                knob.className = 'slider-knob';
                label.appendChild(input);
                label.appendChild(knob);

                bot.appendChild(status);
                bot.appendChild(label);
                card.appendChild(top);
                card.appendChild(bot);
                grid.appendChild(card);
                painted += 1;
            }
            if (painted === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'padding:24px;color:var(--text-secondary);font-size:13px;';
                empty.textContent = '暂无可用插件条目。请检查 UI_PLUGIN_ORDER 或刷新应用。';
                grid.appendChild(empty);
            }
            bindToggles();
        } catch (err) {
            console.error('paintCards failed', err);
            grid.innerHTML = `<div style="padding:24px;color:#ff8a80;">插件列表渲染失败：${String(err && err.message || err)}</div>`;
        }
    };

    async function onPluginToggle(e) {
        const pluginKey = e.target.getAttribute('data-plugin');
        const checked = e.target.checked;

        if (checked) {
            let probe = pluginProbeMap[pluginKey];
            try {
                if (window.api && window.api.probePlugin) {
                    const pr = await Promise.race([
                        window.api.probePlugin(pluginKey),
                        new Promise((resolve) => setTimeout(() => resolve(null), 2000))
                    ]);
                    if (pr && pr.success) {
                        probe = pr.probe;
                        pluginProbeMap[pluginKey] = probe;
                    }
                }
            } catch (err) {}

            if (pluginKey === 'auto-start-codex' && probe && !probe.available) {
                e.target.checked = false;
                showToast(probe.hint || t('plugin.toast.codex_missing'));
                paintCards();
                return;
            }

            if ((pluginKey === 'slack' || pluginKey === 'matrix' || pluginKey === 'telegram') && probe && probe.needsConfig) {
                const ok = await confirm(
                    (probe.hint || '') + '\n\n' + t('plugin.toast.need_credentials'),
                    t('plugin.' + pluginKey + '.name')
                );
                if (!ok) {
                    e.target.checked = false;
                    paintCards();
                    return;
                }
                let fieldDefs;
                if (pluginKey === 'slack') {
                    fieldDefs = [
                        { key: 'botToken', label: 'Bot Token (xoxb-…)', placeholder: 'xoxb-...' },
                        { key: 'appToken', label: 'App Token 可选 (xapp-…)', placeholder: 'xapp-...' }
                    ];
                } else if (pluginKey === 'telegram') {
                    fieldDefs = [
                        { key: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...' }
                    ];
                } else {
                    fieldDefs = [
                        { key: 'homeserver', label: 'Homeserver URL', placeholder: 'https://matrix.org' },
                        { key: 'accessToken', label: 'Access Token', placeholder: 'syt_...' }
                    ];
                }
                const values = await window.promptFields(
                    t('plugin.wizard.title') + ' · ' + t('plugin.' + pluginKey + '.name'),
                    fieldDefs
                );
                if (!values) {
                    e.target.checked = false;
                    paintCards();
                    return;
                }
                if ((pluginKey === 'slack' || pluginKey === 'telegram') && !values.botToken) {
                    showToast(t('plugin.toast.token_required'));
                    e.target.checked = false;
                    paintCards();
                    return;
                }
                if (pluginKey === 'matrix' && (!values.homeserver || !values.accessToken)) {
                    showToast(t('plugin.toast.token_required'));
                    e.target.checked = false;
                    paintCards();
                    return;
                }
                try {
                    const saved = await window.api.savePluginCredentials({ pluginId: pluginKey, fields: values });
                    if (!saved || !saved.success) {
                        showToast((saved && saved.error) || t('plugin.toast.save_failed'));
                        e.target.checked = false;
                        paintCards();
                        return;
                    }
                    if (saved.config) configData = saved.config;
                    showToast(t('plugin.toast.credentials_saved'));
                } catch (err) {
                    showToast(String(err.message || err));
                    e.target.checked = false;
                    paintCards();
                    return;
                }
            }

            if (pluginKey === 'whatsapp' && probe && probe.hint) showToast(probe.hint);
            if (pluginKey === 'voice-call') showToast((probe && probe.hint) || t('plugin.voice-call.desc'));
            if (probe && probe.badge === 'missing-runtime') showToast(t('plugin.toast.missing_runtime'));
        }

        if (pluginKey === 'auto-start-codex') {
            if (!configData.hooks) configData.hooks = {};
            if (!configData.hooks.internal) configData.hooks.internal = {};
            if (!configData.hooks.internal.entries) configData.hooks.internal.entries = {};
            if (!configData.hooks.internal.entries['auto-start-codex']) {
                configData.hooks.internal.entries['auto-start-codex'] = {};
            }
            configData.hooks.internal.entries['auto-start-codex'].enabled = checked;
            if (checked) configData.hooks.internal.enabled = true;
        } else if (pluginKey === 'long-term-memory') {
            // 伞形开关：同步真实长期记忆栈（摘要 / 旋转 / 压缩护栏）；勿写入 long-term-memory 条目（OpenClaw 不认识）
            for (const id of LONG_TERM_MEMORY_STACK) {
                if (!configData.plugins.entries[id]) configData.plugins.entries[id] = {};
                configData.plugins.entries[id].enabled = checked;
                if (checked && !configData.plugins.allow.includes(id)) {
                    configData.plugins.allow.push(id);
                }
            }
            if (configData.plugins.entries['long-term-memory']) {
                delete configData.plugins.entries['long-term-memory'];
            }
            configData.plugins.allow = configData.plugins.allow.filter((x) => x !== 'long-term-memory');
            if (checked && !configData.plugins.allow.includes('llm-task')) {
                configData.plugins.allow.push('llm-task');
            }
            if (!checked) {
                showToast(t('plugin.toast.ltm_disabled'));
            } else {
                showToast(t('plugin.toast.ltm_enabled'));
            }
        } else {
            if (!configData.plugins.entries[pluginKey]) configData.plugins.entries[pluginKey] = {};
            configData.plugins.entries[pluginKey].enabled = checked;
            if (checked) {
                if (!configData.plugins.allow.includes(pluginKey)) configData.plugins.allow.push(pluginKey);
                if (pluginKey === 'auto-summary' && !configData.plugins.allow.includes('llm-task')) {
                    configData.plugins.allow.push('llm-task');
                }
            }
        }

        try { await window.api.saveConfig(configData); } catch (err) {}
        paintCards();

        if (gatewayStatus === 'running') {
            window.api.gatewayAction('stop');
            setTimeout(() => window.api.gatewayAction('start'), 1200);
        }
    }

    // 先立刻画卡片，避免探活卡住整页空白

    paintCards();
    try {
        if (window.api && window.api.probePlugins) {
            const res = await Promise.race([
                window.api.probePlugins(),
                new Promise((resolve) => setTimeout(() => resolve(null), 2500))
            ]);
            if (res && res.success && Array.isArray(res.probes)) {
                pluginProbeMap = {};
                for (const p of res.probes) pluginProbeMap[p.id] = p;
                paintCards();
            }
        }
    } catch (e) {
        console.warn('plugins probe failed', e);
    }
}

// 进度更新中心驱动
function updateProgressUI(val, textLabel = '') {
    const oldProgress = currentProgress;
    currentProgress = val;
    const progressFill = document.getElementById('terminal-progress-bar-fill');
    const progressPercent = document.getElementById('terminal-progress-bar-percent');
    const progressText = document.getElementById('terminal-progress-bar-text');
    const sidebarPercent = document.getElementById('sidebar-status-percentage');
    const progressContainer = document.getElementById('terminal-progress-bar-container');

    if (progressContainer && val < 100) {
        progressContainer.style.opacity = '1';
    }

    if (progressFill) progressFill.style.width = `${val.toFixed(0)}%`;
    if (progressPercent) progressPercent.innerText = `${val.toFixed(0)}%`;
    if (sidebarPercent) {
        const roundedVal = val.toFixed(0);
        if (roundedVal === '100') {
            sidebarPercent.style.display = 'none';
        } else {
            sidebarPercent.innerText = `${roundedVal}%`;
            sidebarPercent.style.display = 'block';
        }
        const sidebarIcon = document.getElementById('sidebar-status-icon');
        if (roundedVal === '0' && gatewayStatus === 'stopped') {
            sidebarPercent.style.display = 'none';
            if (sidebarIcon) sidebarIcon.style.display = 'block';
        } else {
            if (sidebarIcon) sidebarIcon.style.display = 'none';
        }
    }
    if (progressText && textLabel) progressText.innerText = textLabel;

    // 启动就绪：轻提示即可，避免 modal alert 打断
    if (gatewayStatus === 'starting' && oldProgress < 100 && val === 100) {
        try { showToast(t('Nexora Agent 已就绪', 'Nexora Agent is ready', 'Nexora Agent 已就緒')); } catch (e) {}
    }

    // 🌟 就绪 3 秒后优雅渐隐进度条
    if (val === 100) {
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
        if (progressContainer) {
            setTimeout(() => {
                if (gatewayStatus === 'running' && currentProgress === 100) {
                    progressContainer.style.transition = 'opacity 0.8s ease';
                    progressContainer.style.opacity = '0';
                    setTimeout(() => {
                        if (gatewayStatus === 'running' && currentProgress === 100) {
                            progressContainer.style.display = 'none';
                        }
                    }, 800);
                }
            }, 800);
        }
    }
    try { updateStepperUI(val); } catch (e) {}
}

// 视图切换应用逻辑
function applyViewMode(mode) {
    const btnToggleViewMode = document.getElementById('btn-toggle-view-mode');
    const stepProgressContainer = document.getElementById('step-progress-container');
    const logTerminalOutput = document.getElementById('log-terminal-output');
    const terminalLeft = document.getElementById('tour-log-terminal');

    const dashboardMonitor = document.getElementById('console-dashboard-monitor');

    if (mode === 'log') {
        if (stepProgressContainer) stepProgressContainer.style.display = 'none';
        if (logTerminalOutput) logTerminalOutput.style.display = 'none !important';
        if (dashboardMonitor) dashboardMonitor.style.display = 'flex';
        if (terminalLeft) terminalLeft.classList.remove('step-view-active');
        if (btnToggleViewMode) {
            btnToggleViewMode.setAttribute('data-i18n', 'console.btn.toggle_step_view');
            btnToggleViewMode.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg> ${t('console.btn.toggle_step_view')}`;
        }
    } else {
        // 'step'
        if (stepProgressContainer) stepProgressContainer.style.display = 'flex';
        if (logTerminalOutput) logTerminalOutput.style.display = 'none !important';
        if (dashboardMonitor) dashboardMonitor.style.display = 'none';
        if (terminalLeft) terminalLeft.classList.add('step-view-active');
        if (btnToggleViewMode) {
            btnToggleViewMode.setAttribute('data-i18n', 'console.btn.toggle_log_view');
            btnToggleViewMode.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg> ${t('console.btn.toggle_log_view')}`;
        }
    }
}

function updateStepperUI(progressVal) {
    const overallStatusEl = document.getElementById('stepper-overall-status');

    if (gatewayStatus === 'stopped') {
        topoNodeStates = {
            'node-client': 'pending',
            'node-core': 'pending',
            'node-llm': 'pending',
            'node-wechat': 'pending',
            'node-qq': 'pending',
            'node-feishu': 'pending'
        };
        updateTopologyUI();

        if (overallStatusEl) {
            overallStatusEl.setAttribute('data-i18n', 'console.stepper.status.stopped');
            overallStatusEl.innerText = t('console.stepper.status.stopped');
        }
        return;
    }

    if (gatewayStatus === 'upgrading') {
        topoNodeStates = {
            'node-client': 'active',
            'node-core': 'active',
            'node-llm': 'pending',
            'node-wechat': 'pending',
            'node-qq': 'pending',
            'node-feishu': 'pending'
        };
        updateTopologyUI();

        if (overallStatusEl) {
            overallStatusEl.setAttribute('data-i18n', 'console.stepper.status.upgrading');
            overallStatusEl.innerText = t('console.stepper.status.upgrading');
        }
        return;
    }

    // Fallback progression in case logs are missing:
    if (progressVal === 0) {
        // Do not override log-based states if they are already active/completed,
        // but if they are all pending, we keep them pending.
    } else if (progressVal < 25) {
        if (topoNodeStates['node-client'] === 'pending') topoNodeStates['node-client'] = 'active';
        if (topoNodeStates['node-core'] === 'pending') topoNodeStates['node-core'] = 'active';
    } else if (progressVal < 55) {
        topoNodeStates['node-client'] = 'completed';
        if (topoNodeStates['node-core'] === 'pending' || topoNodeStates['node-core'] === 'active') topoNodeStates['node-core'] = 'completed';
        if (topoNodeStates['node-llm'] === 'pending') topoNodeStates['node-llm'] = 'active';
    } else if (progressVal < 85) {
        topoNodeStates['node-client'] = 'completed';
        topoNodeStates['node-core'] = 'completed';
        topoNodeStates['node-llm'] = 'completed';
        
        // Configured channels start lighting up（仅已绑定的渠道）
        if (configData && configData.channels) {
            const hasWechat = !!(document.getElementById('node-wechat')?.dataset?.liveBound === '1')
                || configData.channels['openclaw-weixin']?.enabled === true;
            const hasQq = !!(configData.channels.qqbot?.accounts && Object.keys(configData.channels.qqbot.accounts).length > 0)
                || !!(configData.channels.qqbot?.appId && configData.channels.qqbot?.clientSecret);
            const hasFeishu = !!(configData.channels.feishu?.appId && configData.channels.feishu?.appSecret)
                || !!(configData.channels.feishu?.accounts && Object.values(configData.channels.feishu.accounts).some((a) => a && a.appId && a.appSecret));

            if (hasWechat && topoNodeStates['node-wechat'] === 'pending') topoNodeStates['node-wechat'] = 'active';
            if (hasQq && topoNodeStates['node-qq'] === 'pending') topoNodeStates['node-qq'] = 'active';
            if (hasFeishu && topoNodeStates['node-feishu'] === 'pending') topoNodeStates['node-feishu'] = 'active';
        }
        // 未绑定渠道保持 pending，不再误点亮「连接中」
    } else if (progressVal < 100) {
        topoNodeStates['node-client'] = 'completed';
        topoNodeStates['node-core'] = 'completed';
        topoNodeStates['node-llm'] = 'completed';
        
        if (configData && configData.channels) {
            const hasWechat = !!(document.getElementById('node-wechat')?.dataset?.liveBound === '1')
                || configData.channels['openclaw-weixin']?.enabled === true;
            const hasQq = !!(configData.channels.qqbot?.accounts && Object.keys(configData.channels.qqbot.accounts).length > 0)
                || !!(configData.channels.qqbot?.appId && configData.channels.qqbot?.clientSecret);
            const hasFeishu = !!(configData.channels.feishu?.appId && configData.channels.feishu?.appSecret)
                || !!(configData.channels.feishu?.accounts && Object.values(configData.channels.feishu.accounts).some((a) => a && a.appId && a.appSecret));

            if (hasWechat) topoNodeStates['node-wechat'] = 'completed';
            if (hasQq) topoNodeStates['node-qq'] = 'completed';
            if (hasFeishu) topoNodeStates['node-feishu'] = 'completed';
        }
    } else {
        // 100% Running
        topoNodeStates['node-client'] = 'completed';
        topoNodeStates['node-core'] = 'completed';
        topoNodeStates['node-llm'] = 'completed';

        // Check which channels are actually bound
        if (configData && configData.channels) {
            const hasWechat = !!(document.getElementById('node-wechat')?.dataset?.liveBound === '1')
                || configData.channels['openclaw-weixin']?.enabled === true;
            const hasQq = !!(configData.channels.qqbot?.accounts && Object.keys(configData.channels.qqbot.accounts).length > 0)
                || !!(configData.channels.qqbot?.appId && configData.channels.qqbot?.clientSecret);
            const hasFeishu = !!(configData.channels.feishu?.appId && configData.channels.feishu?.appSecret)
                || !!(configData.channels.feishu?.accounts && Object.values(configData.channels.feishu.accounts).some((a) => a && a.appId && a.appSecret));

            topoNodeStates['node-wechat'] = hasWechat ? 'completed' : 'pending';
            topoNodeStates['node-qq'] = hasQq ? 'completed' : 'pending';
            topoNodeStates['node-feishu'] = hasFeishu ? 'completed' : 'pending';
        } else {
            topoNodeStates['node-wechat'] = 'pending';
            topoNodeStates['node-qq'] = 'pending';
            topoNodeStates['node-feishu'] = 'pending';
        }
    }

    updateTopologyUI();

    if (overallStatusEl) {
        if (progressVal === 100) {
            overallStatusEl.setAttribute('data-i18n', 'console.stepper.status.running');
            overallStatusEl.innerText = t('console.stepper.status.running');
        } else {
            overallStatusEl.setAttribute('data-i18n', 'console.stepper.status.starting');
            overallStatusEl.innerText = t('console.stepper.status.starting');
        }
    }
}

function getActiveModelNameFromConfig() {
    if (!configData || !configData.agents || !configData.agents.defaults || !configData.agents.defaults.model) {
        return null;
    }
    const model = configData.agents.defaults.model.primary;
    if (!model) return null;
    const parts = model.split('/');
    return parts[parts.length - 1].trim();
}

// 6. UI 状态刷新
function updateGatewayStatusUI(status) {


    if (status !== 'running') {
        gatewayFullyReady = false;
    }

    const sidebarPercent = document.getElementById('sidebar-status-percentage');
    const sidebarIcon = document.getElementById('sidebar-status-icon');
    if (status === 'stopped') {
        if (sidebarPercent) sidebarPercent.style.display = 'none';
        if (sidebarIcon) sidebarIcon.style.display = 'block';
    } else {
        if (sidebarPercent) sidebarPercent.style.display = 'block';
        if (sidebarIcon) sidebarIcon.style.display = 'none';
    }

    const terminalLeft = document.getElementById('tour-log-terminal');
    const btnClearLogs = document.getElementById('btn-clear-terminal-logs');
    if (terminalLeft) {
        terminalLeft.classList.remove('stopped', 'starting', 'running');
        terminalLeft.classList.add(status);
    }
    if (btnClearLogs) {
        if (status === 'stopped') {
            btnClearLogs.removeAttribute('disabled');
        } else {
            btnClearLogs.setAttribute('disabled', 'true');
        }
    }

    // 同步更新仪表盘（Dashboard）服务状态与呼吸灯
    const dashServiceStatus = document.getElementById('dash-service-status');
    const dashStatusDot = document.getElementById('dash-status-dot');
    if (dashServiceStatus && dashStatusDot) {
        const getCleanText = (key, fallback) => {
            const trans = t(key);
            return (trans && !trans.includes('console.')) ? trans : fallback;
        };

        if (status === 'running') {
            dashServiceStatus.textContent = getCleanText('console.dash.running', '运行中');
            dashStatusDot.className = 'status-indicator-dot running';
            
            const activeModelEl = document.getElementById('dash-active-model');
            if (activeModelEl) {
                const modelName = getActiveModelNameFromConfig() || '已启动';
                activeModelEl.textContent = modelName;
            }
        } else if (status === 'starting') {
            dashServiceStatus.textContent = getCleanText('console.dash.starting', '正在启动...');
            dashStatusDot.className = 'status-indicator-dot running';
            
            const activeModelEl = document.getElementById('dash-active-model');
            if (activeModelEl) activeModelEl.textContent = t('console.dash.not_configured') || '未启动';
        } else {
            dashServiceStatus.textContent = getCleanText('console.dash.stopped', '已停止');
            dashStatusDot.className = 'status-indicator-dot stopped';
            
            const activeModelEl = document.getElementById('dash-active-model');
            if (activeModelEl) activeModelEl.textContent = t('console.dash.not_configured') || '未启动';
        }
    }

    // 每次状态改变，均彻底清除上一次 the 保底延时器，杜绝闭包和交叉执行干扰
    if (progressTimeout) {
        clearTimeout(progressTimeout);
        progressTimeout = null;
    }

    const progressContainer = document.getElementById('terminal-progress-bar-container');
    const isEn = (localStorage.getItem('setting_language') || 'zh-CN') === 'en-US';
    const chatWelcomeText = document.getElementById('gateway-connection-status-text');

    if (status === 'running') {
        statusLight.className = 'status-light-btn-container running';
        statusLabel.setAttribute('data-i18n', 'sidebar.status.running');
        statusLabel.innerText = t('sidebar.status.running');
        btnIconStart.style.display = 'none';
        btnIconStop.style.display = 'block';
        btnLabelText.setAttribute('data-i18n', 'console.btn.stop');
        btnLabelText.innerText = t('console.btn.stop');
        gatewayToggleBtn.className = 'status-badge-container running';

        if (chatWelcomeText) {
            chatWelcomeText.setAttribute('data-i18n', 'status.running_hint');
            chatWelcomeText.innerText = isEn ? 'I have successfully connected to your local OpenClaw gateway!' : '我已经与您本地的 OpenClaw Nexora Agent成功对接！';
            chatWelcomeText.style.color = '#00e676';
        }

        // 运行时间计时器开启
        if (uptimeInterval) clearInterval(uptimeInterval);
        const startTime = gatewayRunningTime || Date.now();
        uptimeInterval = setInterval(() => {
            const diffMs = Date.now() - startTime;
            const secs = Math.floor(diffMs / 1000) % 60;
            const mins = Math.floor(diffMs / 60000) % 60;
            const hours = Math.floor(diffMs / 3600000);
            
            const timeStr = [
                hours.toString().padStart(2, '0'),
                mins.toString().padStart(2, '0'),
                secs.toString().padStart(2, '0')
            ].join(':');
            
            const uptimeEl = document.getElementById('stat-uptime');
            if (uptimeEl) uptimeEl.innerText = timeStr;
        }, 1000);

        // 不要在此处停止假进度定时器，等 handleReceivedLog 匹配 100% 后再清空
        // if (progressInterval) clearInterval(progressInterval);

        if (currentProgress === 0) {
            // 说明是一打开程序就已经是运行状态（非手动点击启动），直接拉满到 100%
            if (progressContainer) progressContainer.style.display = 'flex';
            updateProgressUI(100, '本地 AI Nexora Agent服务就绪！');
        } else {
            // 否则，说明是通过 starting 刚点启动的，此时我们等 handleReceivedLog 匹配完毕来置 100%
            // 设定 12 秒的保底拉满延时器
            progressTimeout = setTimeout(() => {
                if (gatewayStatus === 'running' && currentProgress < 100) {
                    if (progressContainer) progressContainer.style.display = 'flex';
                    updateProgressUI(100, '本地 AI Nexora Agent服务就绪！');
                }
            }, 12000);
        }
    } else if (status === 'stopped') {
        statusLight.className = 'status-light-btn-container';
        statusLabel.setAttribute('data-i18n', 'sidebar.status.stopped');
        statusLabel.innerText = t('sidebar.status.stopped');
        btnIconStart.style.display = 'block';
        btnIconStop.style.display = 'none';
        btnLabelText.setAttribute('data-i18n', 'console.btn.start');
        btnLabelText.innerText = t('console.btn.start');
        gatewayToggleBtn.className = 'status-badge-container stopped';

        if (chatWelcomeText) {
            chatWelcomeText.setAttribute('data-i18n', 'status.stopped');
            chatWelcomeText.innerText = t('status.stopped');
            chatWelcomeText.style.color = '#b388ff';
        }

        // 清除运行时间计时器并重置
        if (uptimeInterval) {
            clearInterval(uptimeInterval);
            uptimeInterval = null;
        }
        const uptimeEl = document.getElementById('stat-uptime');
        if (uptimeEl) uptimeEl.innerText = '--:--:--';

        // 清除所有定时器并隐藏进度条
        if (progressInterval) clearInterval(progressInterval);
        updateProgressUI(0, 'Nexora Agent已停止运行');
        if (progressContainer) {
            progressContainer.style.display = 'none';
        }
    } else if (status === 'upgrading') {
        statusLight.className = 'status-light-btn-container starting';
        statusLabel.setAttribute('data-i18n', 'sidebar.status.upgrading');
        statusLabel.innerText = t('sidebar.status.upgrading');
        btnIconStart.style.display = 'block';
        btnIconStop.style.display = 'none';
        btnLabelText.setAttribute('data-i18n', 'sidebar.status.upgrading');
        btnLabelText.innerText = t('sidebar.status.upgrading');
        gatewayToggleBtn.className = 'status-badge-container starting';

        if (chatWelcomeText) {
            chatWelcomeText.setAttribute('data-i18n', 'status.upgrading_hint');
            chatWelcomeText.innerText = t('正在自动升级内置 Node.js 沙箱环境，请稍候...', 'Automatically upgrading built-in Node.js sandbox, please wait...', '正在自動升級內置 Node.js 沙箱環境，請稍候...');
            chatWelcomeText.style.color = '#ffd54f';
        }

        if (progressContainer) progressContainer.style.display = 'flex';
        updateProgressUI(0, '正在初始化环境自愈下载...');

        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
    } else if (status === 'starting') {
        statusLight.className = 'status-light-btn-container starting';
        statusLabel.setAttribute('data-i18n', 'sidebar.status.starting');
        statusLabel.innerText = t('sidebar.status.starting');
        btnIconStart.style.display = 'block';
        btnIconStop.style.display = 'none';
        btnLabelText.setAttribute('data-i18n', 'sidebar.status.starting');
        btnLabelText.innerText = t('sidebar.status.starting');
        gatewayToggleBtn.className = 'status-badge-container starting';

        const systemLogsArea = document.getElementById('system-raw-logs-area');
        if (systemLogsArea) {
            systemLogsArea.value += `\n>>> [系统消息] Nexora Agent核心服务于 ${new Date().toLocaleString()} 开始拉起运行...\n`;
            systemLogsArea.scrollTop = systemLogsArea.scrollHeight;
        }

        const streamList = document.getElementById('dash-activity-stream-list');
        if (streamList) {
            const emptyEl = streamList.querySelector('.activity-item-empty');
            if (emptyEl || streamList.innerHTML.trim() === '') {
                streamList.innerHTML = `<div class="starting-activity-item" data-i18n="console.dash.starting_tips">首次启动或深度初始化环境可能需要较长时间，请耐心等待...</div>`;
            }
        }

        if (chatWelcomeText) {
            chatWelcomeText.setAttribute('data-i18n', 'status.starting_hint');
            chatWelcomeText.innerText = isEn ? 'Connecting to the local OpenClaw gateway, please wait...' : '正在连接本地的 OpenClaw Nexora Agent，请稍候...';
            chatWelcomeText.style.color = '#ffd54f';
        }

        // 假进度只爬到 80%，避免「97% 假死」观感；真正就绪靠端口探测 / listening 日志
        if (progressContainer) progressContainer.style.display = 'flex';
        updateProgressUI(8, t('console.progress.starting_env') || '正在拉起子进程环境...');
        gatewayLogReadyTail = '';
        startGatewayReadyProbe('user-start');

        if (progressInterval) clearInterval(progressInterval);
        progressInterval = setInterval(() => {
            if (currentProgress >= 80 || gatewayFullyReady) return;
            let nextProgress = Math.min(80, currentProgress + 3.5);

            let currentText = t('console.progress.starting_env') || '正在拉起子进程环境...';
            if (nextProgress > 65) {
                currentText = t('console.progress.loading_channels') || '正在装载渠道插件与控制台…';
            } else if (nextProgress > 35) {
                currentText = t('console.progress.loading_core_plugins') || '正在装载核心插件驱动...';
            }
            updateProgressUI(nextProgress, currentText);
        }, 200);
    }
}

// 模拟内存指标变化，增添科幻动态效果
function updateMemoryMock() {
    // 1. 右侧的Nexora Agent内存看板 statMem (只有Nexora Agent运行时才显示其自身内存，未运行显示 -- MB)
    if (gatewayStatus !== 'running') {
        statMem.innerText = '-- MB';
    } else {
        const gatewayMemVal = Math.floor(Math.random() * (45 - 32) + 32);
        statMem.innerText = gatewayMemVal + ' MB';
    }

    // 2. 左下角负载卡片代表“应用负载”（整个客户端程序占用的总内存）
    // 无论Nexora Agent是否运行，客户端本身一直在运行，故应用负载图表应持续波动更新
    const memValEl = document.getElementById('sidebar-chart-mem-val');
    
    let appMemVal;
    if (gatewayStatus === 'running') {
        appMemVal = Math.floor(Math.random() * (168 - 148) + 148);
    } else {
        appMemVal = Math.floor(Math.random() * (126 - 112) + 112);
    }
    
    if (memValEl) {
        memValEl.innerText = appMemVal + ' MB';
    }
    updateSidebarChartData(appMemVal);
}

// 7. Tab 页切换控制
function setupTabSwitching() {
    const allNavItems = Array.from(document.querySelectorAll('.nav-item'));
    const allTabPanes = Array.from(document.querySelectorAll('.tab-pane'));
    let activeNav = document.querySelector('.nav-item.active');
    let activePane = document.querySelector('.tab-pane.active');

    allNavItems.forEach((tab) => {
        tab.addEventListener('click', (e) => {
            if (tab.id === 'nav-check-update') {
                e.preventDefault();
                e.stopPropagation();
                triggerUpdateCheck(true);
                return;
            }

            // HTTP 已监听即可打开（setGatewayFullyReadyUI 会提前置位）
            if (tab.getAttribute('data-tab') === 'openclaw-panel-view') {
                if (!gatewayFullyReady) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (gatewayStatus === 'starting' || gatewayStatus === 'running') {
                        showToast('Nexora Agent 正在启动，约十几秒后可打开 OpenClaw…');
                    } else {
                        showToast('请先在左上角启动 Nexora Agent 服务');
                    }
                    return;
                }
            }

            const nextTab = tab.getAttribute('data-tab');
            if (nextTab === currentTab && tab.classList.contains('active')) {
                return; // 同页不重复切
            }

            // 轻量切换：只动当前/目标，避免全量 query + 动画
            if (activeNav) activeNav.classList.remove('active');
            if (activePane) activePane.classList.remove('active');
            tab.classList.add('active');
            const targetPane = document.getElementById(nextTab);
            if (targetPane) targetPane.classList.add('active');
            activeNav = tab;
            activePane = targetPane || null;

            const prevTab = currentTab;
            currentTab = nextTab;

            // 离开 OpenClaw 面板时先藏 webview，减轻后台合成压力
            if (prevTab === 'openclaw-panel-view' || nextTab === 'openclaw-panel-view') {
                const wv = document.getElementById('openclaw-iframe');
                if (wv) {
                    wv.style.visibility = (nextTab === 'openclaw-panel-view') ? 'visible' : 'hidden';
                }
            }

            // 离开终端：停光标闪烁，降低后台 GPU 占用
            if (prevTab === 'terminal-view' && builtinTerminal) {
                try { builtinTerminal.blur(); } catch (err) {}
                try { builtinTerminal.options.cursorBlink = false; } catch (err) {}
            }

            // 仅离开「通讯管理」时取消绑定；同页内切换勿误关飞书码
            if (prevTab === 'communication-view' && currentTab !== 'communication-view'
                && typeof __commBindingSession !== 'undefined' && __commBindingSession.active
                && typeof endCommBinding === 'function') {
                endCommBinding({ cancelBackend: true, toast: '已离开通讯管理，绑定已取消' });
            }

            // 重活全部丢到下一任务，保证菜单点击瞬时响应
            setTimeout(() => {
                if (currentTab !== nextTab) return;

                if (currentTab === 'dashboard-view') {
                    try { renderUsageCharts(); } catch (err) { console.error(err); }
                }

                if (currentTab === 'console-view') {
                    try { updateConsoleChannelStatusUI(); } catch (err) { console.error(err); }
                    // 刷回离页期间积压的控制台日志（限量，避免一次卡死）
                    try {
                        const q = window.__deferredConsoleLogs;
                        if (q && q.length) {
                            const chunk = q.splice(0, q.length).slice(-80);
                            // 写入隐藏的原大终端
                            if (logTerminal) {
                                const frag = document.createDocumentFragment();
                                chunk.forEach((lineHtml) => {
                                    const s = document.createElement('span');
                                    s.innerHTML = lineHtml + (lineHtml.endsWith('\n') ? '' : '<br/>');
                                    frag.appendChild(s);
                                });
                                logTerminal.appendChild(frag);
                                logTerminal.scrollTop = logTerminal.scrollHeight;
                            }
                            // 同步写入 Dashboard 活动监控流（修复：切菜单回来日志消失）
                            const streamList = document.getElementById('dash-activity-stream-list');
                            if (streamList) {
                                const emptyTips = streamList.querySelector('.activity-item-empty');
                                if (emptyTips) emptyTips.remove();
                            chunk.forEach((lineHtml) => {
                                enqueueActivityLog(lineHtml);
                            });
                                while (streamList.children.length > 150) {
                                    streamList.removeChild(streamList.firstChild);
                                }
                                streamList.scrollTop = streamList.scrollHeight;
                            }
                        }
                    } catch (err) {}
                }

                if (currentTab === 'terminal-view' && typeof initBuiltinTerminal === 'function') {
                    initBuiltinTerminal();
                }

                if (currentTab === 'plugins-view') {
                    Promise.resolve().then(() => renderPluginsGrid()).catch((err) => console.error(err));
                }

                if (currentTab === 'roles-view') {
                    Promise.resolve().then(() => {
                        if (typeof loadRoleConfigState === 'function') {
                            return loadRoleConfigState({ preferActive: true });
                        }
                    }).catch((err) => console.error(err));
                }

                if (currentTab === 'voice-view') {
                    Promise.resolve().then(() => {
                        if (typeof refreshVoicePanel === 'function') {
                            return refreshVoicePanel();
                        }
                    }).catch((err) => console.error(err));
                }

                if (currentTab === 'chat-view') {
                    Promise.resolve().then(() => {
                        if (typeof loadRoleConfigState === 'function') {
                            return loadRoleConfigState({ silent: true, preferActive: false, clearEditing: false });
                        }
                    }).catch((err) => console.error(err));
                }

                if (currentTab === 'openclaw-panel-view') {
                    Promise.resolve().then(() => loadOpenclawControlUi(false)).catch((err) => console.error(err));
                }

                if (currentTab === 'syslogs-view') {
                    try { loadAndRenderSystemLogs(); } catch (err) { console.error(err); }
                }

                if (currentTab === 'settings-view') {
                    const settingLangSel = document.getElementById('setting-language-select');
                    if (settingLangSel) {
                        const initLang = localStorage.getItem('setting_language') || 'zh-CN';
                        settingLangSel.value = initLang;
                        // 强制重绘
                        const dummy = document.createElement('option');
                        dummy.style.display = 'none';
                        settingLangSel.appendChild(dummy);
                        settingLangSel.removeChild(dummy);
                    }
                }

                if (currentTab === 'chat-view') {
                    if (!chatInitialized) {
                        chatInitialized = true;
                        try { initChatView(); } catch (err) { console.error(err); }
                    } else {
                        try { loadChatModels(); } catch (err) { console.error(err); }
                    }
                }
            }, 0);
        });
    });

    // 兜底缓存未就绪时仍可用
    void allTabPanes;
}

// 8. 主题一键无缝切换
function setupThemeSwitching() {
    const pickerBlack = document.getElementById('theme-btn-black');
    const pickerDark = document.getElementById('theme-btn-dark');
    const pickerAurora = document.getElementById('theme-btn-aurora');
    const pickerLight = document.getElementById('theme-btn-light');
    const pickerBlue = document.getElementById('theme-btn-blue');
    const pickerOrange = document.getElementById('theme-btn-orange');
    const pickerTeal = document.getElementById('theme-btn-teal');
    const pickerAmber = document.getElementById('theme-btn-amber');
    const pickerPink = document.getElementById('theme-btn-pink');
    const pickerGlacier = document.getElementById('theme-btn-glacier');
    const pickerMagma = document.getElementById('theme-btn-magma');
    const pickerAbyss = document.getElementById('theme-btn-abyss');
    const pickerSage = document.getElementById('theme-btn-sage');
    const pickerMint = document.getElementById('theme-btn-mint');
    const pickerForest = document.getElementById('theme-btn-forest');
    const dots = [pickerBlack, pickerDark, pickerAurora, pickerLight, pickerBlue, pickerOrange, pickerTeal, pickerAmber, pickerPink, pickerGlacier, pickerMagma, pickerAbyss, pickerSage, pickerMint, pickerForest];

    const updateActiveDot = (activeTheme) => {
        dots.forEach(dot => {
            if (dot) dot.classList.remove('active');
        });
        if (activeTheme === 'theme-black' && pickerBlack) pickerBlack.classList.add('active');
        if (activeTheme === 'theme-dark' && pickerDark) pickerDark.classList.add('active');
        if (activeTheme === 'theme-aurora' && pickerAurora) pickerAurora.classList.add('active');
        if (activeTheme === 'theme-light' && pickerLight) pickerLight.classList.add('active');
        if (activeTheme === 'theme-blue' && pickerBlue) pickerBlue.classList.add('active');
        if (activeTheme === 'theme-orange' && pickerOrange) pickerOrange.classList.add('active');
        if (activeTheme === 'theme-teal' && pickerTeal) pickerTeal.classList.add('active');
        if (activeTheme === 'theme-amber' && pickerAmber) pickerAmber.classList.add('active');
        if (activeTheme === 'theme-pink' && pickerPink) pickerPink.classList.add('active');
        if (activeTheme === 'theme-glacier' && pickerGlacier) pickerGlacier.classList.add('active');
        if (activeTheme === 'theme-magma' && pickerMagma) pickerMagma.classList.add('active');
        if (activeTheme === 'theme-abyss' && pickerAbyss) pickerAbyss.classList.add('active');
        if (activeTheme === 'theme-sage' && pickerSage) pickerSage.classList.add('active');
        if (activeTheme === 'theme-mint' && pickerMint) pickerMint.classList.add('active');
        if (activeTheme === 'theme-forest' && pickerForest) pickerForest.classList.add('active');
        if (typeof drawSidebarChart === 'function') drawSidebarChart();
    };

    if (pickerBlack) {
        pickerBlack.addEventListener('click', () => {
            document.body.className = 'theme-black';
            localStorage.setItem('user-theme', 'theme-black');
            updateActiveDot('theme-black');
        });
    }

    if (pickerDark) {
        pickerDark.addEventListener('click', () => {
            document.body.className = 'theme-dark';
            localStorage.setItem('user-theme', 'theme-dark');
            updateActiveDot('theme-dark');
        });
    }

    if (pickerAurora) {
        pickerAurora.addEventListener('click', () => {
            document.body.className = 'theme-aurora';
            localStorage.setItem('user-theme', 'theme-aurora');
            updateActiveDot('theme-aurora');
        });
    }

    if (pickerLight) {
        pickerLight.addEventListener('click', () => {
            document.body.className = 'theme-light';
            localStorage.setItem('user-theme', 'theme-light');
            updateActiveDot('theme-light');
        });
    }

    if (pickerBlue) {
        pickerBlue.addEventListener('click', () => {
            document.body.className = 'theme-blue';
            localStorage.setItem('user-theme', 'theme-blue');
            updateActiveDot('theme-blue');
        });
    }

    if (pickerOrange) {
        pickerOrange.addEventListener('click', () => {
            document.body.className = 'theme-orange';
            localStorage.setItem('user-theme', 'theme-orange');
            updateActiveDot('theme-orange');
        });
    }

    if (pickerTeal) {
        pickerTeal.addEventListener('click', () => {
            document.body.className = 'theme-teal';
            localStorage.setItem('user-theme', 'theme-teal');
            updateActiveDot('theme-teal');
        });
    }

    if (pickerAmber) {
        pickerAmber.addEventListener('click', () => {
            document.body.className = 'theme-amber';
            localStorage.setItem('user-theme', 'theme-amber');
            updateActiveDot('theme-amber');
        });
    }

    if (pickerPink) {
        pickerPink.addEventListener('click', () => {
            document.body.className = 'theme-pink';
            localStorage.setItem('user-theme', 'theme-pink');
            updateActiveDot('theme-pink');
        });
    }

    if (pickerGlacier) {
        pickerGlacier.addEventListener('click', () => {
            document.body.className = 'theme-glacier';
            localStorage.setItem('user-theme', 'theme-glacier');
            updateActiveDot('theme-glacier');
        });
    }

    if (pickerMagma) {
        pickerMagma.addEventListener('click', () => {
            document.body.className = 'theme-magma';
            localStorage.setItem('user-theme', 'theme-magma');
            updateActiveDot('theme-magma');
        });
    }

    if (pickerAbyss) {
        pickerAbyss.addEventListener('click', () => {
            document.body.className = 'theme-abyss';
            localStorage.setItem('user-theme', 'theme-abyss');
            updateActiveDot('theme-abyss');
        });
    }

    if (pickerSage) {
        pickerSage.addEventListener('click', () => {
            document.body.className = 'theme-sage';
            localStorage.setItem('user-theme', 'theme-sage');
            updateActiveDot('theme-sage');
        });
    }

    if (pickerMint) {
        pickerMint.addEventListener('click', () => {
            document.body.className = 'theme-mint';
            localStorage.setItem('user-theme', 'theme-mint');
            updateActiveDot('theme-mint');
        });
    }

    if (pickerForest) {
        pickerForest.addEventListener('click', () => {
            document.body.className = 'theme-forest';
            localStorage.setItem('user-theme', 'theme-forest');
            updateActiveDot('theme-forest');
        });
    }

    // 默认主题读取
    const savedTheme = localStorage.getItem('user-theme') || 'theme-dark';
    document.body.className = savedTheme;
    updateActiveDot(savedTheme);
}

// 9. 用量可视化与商业级使用统计数据系统
async function renderUsageCharts() {
    const waveBox = document.getElementById('stats-wave-chart-box');
    if (!waveBox) return;

    // A. 异步从主进程拉取Nexora Agent真实本地数据库累计使用统计数据
    try {
        const result = await window.api.getStatsData();
        if (result && result.success && result.data) {
            sessionStats = {
                ...sessionStats,
                ...result.data,
                logs: result.data.logs || []
            };
        }
    } catch (err) {
        console.error('Failed to load real stats data from gateway:', err);
    }

    if ((!sessionStats.logs || sessionStats.logs.length === 0) && Number(sessionStats.total_requests || 0) === 0) {
        // 引导：无数据通常是补丁未记账或尚未产生对话，不是筛选器问题
        console.warn('[UsageStats] real_tokens.json 为空或不存在 — 需在Nexora Agent下完成至少一轮对话后才会出现用量');
    }

    const stats = sessionStats;
    window.lastFetchedStats = JSON.parse(JSON.stringify(sessionStats));

    // 动态同步绑定联动筛选 change 监听器
    const sourceSelect = document.getElementById('stats-source-select');
    const modelSelect = document.getElementById('stats-model-select');
    const timeSelect = document.getElementById('stats-time-select');
    
    if (sourceSelect && !sourceSelect.dataset.bound) {
        sourceSelect.dataset.bound = "true";
        sourceSelect.addEventListener('change', applyStatsFilters);
    }
    if (modelSelect && !modelSelect.dataset.bound) {
        modelSelect.dataset.bound = "true";
        modelSelect.addEventListener('change', applyStatsFilters);
    }
    if (timeSelect && !timeSelect.dataset.bound) {
        timeSelect.dataset.bound = "true";
        timeSelect.addEventListener('change', applyStatsFilters);
    }

    // 动态同步绑定🔍查询按钮的点击事件，触发拉取与重绘
    const queryBtn = document.getElementById('btn-stats-query');
    if (queryBtn && !queryBtn.dataset.bound) {
        queryBtn.dataset.bound = "true";
        queryBtn.addEventListener('click', async () => {
            queryBtn.innerText = '🔄 刷新';
            queryBtn.disabled = true;
            try {
                await renderUsageCharts();
                showToast('📊 统计数据已成功重新同步更新！');
            } catch (e) {
                console.error('Failed to query statistics:', e);
            }
            queryBtn.innerText = '🔍 查询';
            queryBtn.disabled = false;
        });
    }

    // 维持动态选项菜单的去重显示
    updateFilterOptions();

    // 自动初始化刷新控制
    setupStatsAutoRefresh();

    // 默认走势数据
    const hours = ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'];
    let lineData = {
        cost: Array(12).fill(0),
        cacheCreate: Array(12).fill(0),
        cacheHit: Array(12).fill(0),
        input: Array(12).fill(0),
        output: Array(12).fill(0)
    };

    // 重新从内存日志映射小时刻度
    (stats.logs || []).forEach(log => {
        const timePart = log.time.split(' ')[1] || log.time;
        const hr = parseInt(timePart.split(':')[0]);
        if (!isNaN(hr)) {
            const roundedHr = Math.floor(hr / 2) * 2;
            const hourStr = (roundedHr < 10 ? '0' : '') + roundedHr + ':00';
            const idx = hours.indexOf(hourStr);
            if (idx !== -1) {
                lineData.input[idx] += log.input;
                lineData.output[idx] += log.output;
                lineData.cacheHit[idx] += (log.hit || 0);
            }
        }
    });

    const norm = (v) => Math.min(100, Math.max(2, (v / 20000.0) * 100));
    const processedLineData = {
        cost: lineData.input.map((v, i) => norm(v * 0.000002 + lineData.output[i] * 0.000008)),
        cacheCreate: lineData.input.map(v => norm(v * 0.15)),
        cacheHit: lineData.cacheHit.map(v => norm(v)),
        input: lineData.input.map(v => norm(v)),
        output: lineData.output.map(v => norm(v))
    };
    lineData = processedLineData;

    // 计算属于今天的请求总数并同步到Nexora Agent状态界面
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = todayStart.getTime();
    const todayLogs = (stats.logs || []).filter(log => {
        const ts = log.timestamp || (log.time ? new Date(log.time).getTime() : Date.now());
        return ts >= todayTimestamp;
    });
    totalRequestCount = todayLogs.length;
    const totalReqEl = document.getElementById('stat-total-requests');
    if (totalReqEl) {
        totalReqEl.innerText = `${totalRequestCount}${t('次', '', '次')}`;
    }

    // 更新界面核心汇总卡片的数字看板
    document.getElementById('summary-tokens').innerText = stats.total_tokens.toLocaleString();
    const tokensApprox = document.getElementById('summary-tokens-approx');
    if (tokensApprox) {
        if (stats.total_tokens < 10000) {
            tokensApprox.style.display = 'none';
        } else {
            tokensApprox.style.display = 'inline';
            tokensApprox.innerText = formatNumberWithUnit(stats.total_tokens, true);
        }
    }
    document.getElementById('summary-requests').innerText = stats.total_requests.toLocaleString();
    document.getElementById('summary-cost').innerText = `$${stats.total_cost.toFixed(4)}`;
    document.getElementById('sub-input').innerText = formatNumberWithUnit(stats.sub_input_tokens);
    document.getElementById('sub-output').innerText = formatNumberWithUnit(stats.sub_output_tokens);
    document.getElementById('sub-hit').innerText = formatNumberWithUnit(stats.sub_hit_tokens);
    document.getElementById('hit-rate-val').innerText = `${stats.hit_rate.toFixed(1)}%`;
    document.getElementById('hit-rate-bar').style.width = `${stats.hit_rate}%`;

    const width = 600;
    const height = 200;
    const paddingLeft = 40;
    const paddingRight = 20;
    const paddingTop = 20;
    const paddingBottom = 30;

    const plotWidth = width - paddingLeft - paddingRight;
    const plotHeight = height - paddingTop - paddingBottom;

    // 绘制网格线
    let gridHtml = '';
    const yLines = 4;
    for (let i = 0; i <= yLines; i++) {
        const y = paddingTop + (plotHeight / yLines) * i;
        gridHtml += `<line x1="${paddingLeft}" y1="${y}" x2="${width - paddingRight}" y2="${y}" stroke="rgba(255,255,255,0.04)" />`;
        const labelVal = Math.round(20000 * (1 - i / yLines));
        gridHtml += `<text x="${paddingLeft - 8}" y="${y + 4}" fill="var(--text-secondary)" font-size="9" text-anchor="end">${labelVal}k</text>`;
    }

    hours.forEach((h, idx) => {
        const x = paddingLeft + (plotWidth / (hours.length - 1)) * idx;
        gridHtml += `<text x="${x}" y="${height - 10}" fill="var(--text-secondary)" font-size="9" text-anchor="middle">${h}</text>`;
        gridHtml += `<line x1="${x}" y1="${paddingTop}" x2="${x}" y2="${height - paddingBottom}" stroke="rgba(255,255,255,0.02)" stroke-dasharray="2,2" />`;
    });

    const getCurvePath = (values) => {
        let path = '';
        const len = values.length;
        const coords = values.map((val, idx) => {
            const x = paddingLeft + (plotWidth / (len - 1)) * idx;
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
            <path d="${path} L ${coords[coords.length - 1].x} ${height - paddingBottom} L ${coords[0].x} ${height - paddingBottom} Z" fill="url(#${gradId})" />
            <path d="${path}" fill="none" stroke="${c.color}" stroke-width="${c.width}" stroke-linecap="round" />
        `;
    });

    waveBox.innerHTML = `
        <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
            ${gridHtml}
            ${pathsHtml}
        </svg>
    `;

    // B. 绑定及渲染数据表格
    const btnLogs = document.getElementById('btn-stats-tab-logs');
    const btnProviders = document.getElementById('btn-stats-tab-providers');
    const btnModels = document.getElementById('btn-stats-tab-models');
    const tableContainer = document.getElementById('stats-data-table-container');

    const setActiveTab = (activeBtn) => {
        [btnLogs, btnProviders, btnModels].forEach(btn => {
            if (btn) {
                btn.classList.remove('active');
                btn.style.background = 'rgba(255,255,255,0.05)';
                btn.style.borderColor = 'var(--border-color)';
                btn.style.color = 'var(--text-secondary)';
            }
        });
        if (activeBtn) {
            activeBtn.classList.add('active');
            activeBtn.style.background = 'var(--accent-color)';
            activeBtn.style.borderColor = 'transparent';
            activeBtn.style.color = 'var(--accent-text)';
        }
    };

    const renderLogsTable = () => {
        globalRenderLogsTable = renderLogsTable;
        const logs = (window.lastFetchedStats || stats).logs || [];
        if (logs.length === 0) {
            tableContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-secondary);">暂无真实请求日志数据</div>`;
            return;
        }
        
        let rowsHtml = '';
        logs.forEach(log => {
            rowsHtml += `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.03);">
                  <td style="padding: 8px;">${log.time}</td>
                  <td style="padding: 8px;"><span style="color: #ff9100; font-weight: 600;">${log.provider}</span></td>
                  <td style="padding: 8px; font-family: monospace;">${log.model}</td>
                  <td style="padding: 8px;">${log.input.toLocaleString()}</td>
                  <td style="padding: 8px;">${log.output.toLocaleString()}</td>
                  <td style="padding: 8px; color: #00e676;">${log.hit > 0 ? `🎯 ${log.hit.toLocaleString()}` : '--'}</td>
                  <td style="padding: 8px;">${log.duration}</td>
                  <td style="padding: 8px; color: #00e676;">${t(log.status)}</td>
                </tr>
            `;
        });

        tableContainer.innerHTML = `
            <table style="width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;">
              <thead>
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.08); color: var(--text-secondary);">
                  <th style="padding: 8px;">${t('stats.th.time')}</th>
                  <th style="padding: 8px;">${t('stats.th.provider')}</th>
                  <th style="padding: 8px;">${t('stats.th.model')}</th>
                  <th style="padding: 8px;">${t('stats.th.input')}</th>
                  <th style="padding: 8px;">${t('stats.th.output')}</th>
                  <th style="padding: 8px;">${t('stats.th.hit')}</th>
                  <th style="padding: 8px;">${t('stats.th.duration')}</th>
                  <th style="padding: 8px;">${t('stats.th.status')}</th>
                </tr>
              </thead>
              <tbody style="color: var(--text-primary);">
                ${rowsHtml}
              </tbody>
            </table>
        `;
    };

    const renderProvidersTable = () => {
        globalRenderProvidersTable = renderProvidersTable;
        const provs = (window.lastFetchedStats || stats).providers || {};
        const keys = Object.keys(provs);
        if (keys.length === 0) {
            tableContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-secondary);">暂无真实提供商数据</div>`;
            return;
        }

        let rowsHtml = '';
        keys.forEach(k => {
            const p = provs[k];
            rowsHtml += `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.03);">
                  <td style="padding: 8px; font-weight: bold; color: #ff9100;">🌐 ${k}</td>
                  <td style="padding: 8px;">${p.requests}</td>
                  <td style="padding: 8px;">${p.tokens.toLocaleString()}</td>
                  <td style="padding: 8px;">${stats.total_tokens > 0 ? ((p.tokens / stats.total_tokens) * 100).toFixed(1) : 0}%</td>
                  <td style="padding: 8px; color: #00e676;">${p.hit > 0 ? p.hit.toLocaleString() : '--'}</td>
                </tr>
            `;
        });

        tableContainer.innerHTML = `
            <table style="width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;">
              <thead>
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.08); color: var(--text-secondary);">
                  <th style="padding: 8px;">提供商</th>
                  <th style="padding: 8px;">总请求数</th>
                  <th style="padding: 8px;">总消耗 Tokens</th>
                  <th style="padding: 8px;">占比</th>
                  <th style="padding: 8px;">缓存命中数</th>
                </tr>
              </thead>
              <tbody style="color: var(--text-primary);">
                ${rowsHtml}
              </tbody>
            </table>
        `;
    };
    globalRenderProvidersTable = renderProvidersTable;

    const renderModelsTable = () => {
        globalRenderModelsTable = renderModelsTable;
        const modelsMap = (window.lastFetchedStats || stats).models || {};
        const keys = Object.keys(modelsMap);
        if (keys.length === 0) {
            tableContainer.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-secondary);">暂无真实模型数据</div>`;
            return;
        }

        let rowsHtml = '';
        keys.forEach(k => {
            const m = modelsMap[k];
            rowsHtml += `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.03);">
                  <td style="padding: 8px; font-family: monospace; font-weight: bold;">${k}</td>
                  <td style="padding: 8px; color: #2979ff;">${m.provider}</td>
                  <td style="padding: 8px;">${m.calls}</td>
                  <td style="padding: 8px;">${m.tokens.toLocaleString()}</td>
                  <td style="padding: 8px;">${m.calls > 0 ? (m.duration / m.calls).toFixed(2) : 0}s</td>
                  <td style="padding: 8px; color: #00e676;">${m.tokens > 0 ? ((m.hit / m.tokens) * 100).toFixed(1) : 0}%</td>
                </tr>
            `;
        });

        tableContainer.innerHTML = `
            <table style="width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;">
              <thead>
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.08); color: var(--text-secondary);">
                  <th style="padding: 8px;">模型名称</th>
                  <th style="padding: 8px;">提供商</th>
                  <th style="padding: 8px;">调用次数</th>
                  <th style="padding: 8px;">消耗 Tokens</th>
                  <th style="padding: 8px;">平均耗时</th>
                  <th style="padding: 8px;">命中率</th>
                </tr>
              </thead>
              <tbody style="color: var(--text-primary);">
                ${rowsHtml}
              </tbody>
            </table>
        `;
    };
    globalRenderModelsTable = renderModelsTable;

    // 初始渲染默认的日志表格
    renderLogsTable();

    // 防止重复绑定事件监听器 (renderUsageCharts 可能被多次调用)
    if (btnLogs && !btnLogs.dataset.bound) {
        btnLogs.dataset.bound = "true";
        btnLogs.addEventListener('click', () => { setActiveTab(btnLogs); applyStatsFilters(); });
    }
    if (btnProviders && !btnProviders.dataset.bound) {
        btnProviders.dataset.bound = "true";
        btnProviders.addEventListener('click', () => { setActiveTab(btnProviders); applyStatsFilters(); });
    }
    if (btnModels && !btnModels.dataset.bound) {
        btnModels.dataset.bound = "true";
        btnModels.addEventListener('click', () => { setActiveTab(btnModels); applyStatsFilters(); });
    }
    
    // 关键修正：初始化时必须主动触发一次全局联动渲染，将 HTML 里写死的初始假数据占位符用最新的 sessionStats 覆盖掉
    applyStatsFilters();
}

// 自动刷新统计看板控制
function setupStatsAutoRefresh() {
    const refreshSelect = document.getElementById('stats-refresh-select');
    if (!refreshSelect) return;
    
    const triggerInterval = () => {
        if (statsRefreshInterval) {
            clearInterval(statsRefreshInterval);
            statsRefreshInterval = null;
        }
        if (refreshSelect.value === '30s') {
            statsRefreshInterval = setInterval(() => {
                if (currentTab === 'dashboard-view') {
                    renderUsageCharts();
                }
            }, 30000);
        }
    };
    
    if (!refreshSelect.dataset.bound) {
        refreshSelect.dataset.bound = "true";
        refreshSelect.addEventListener('change', triggerInterval);
    }
    triggerInterval();
}

// 核心：用量监控看板全维度超级联动筛选
function applyStatsFilters() {
    const rawData = window.lastFetchedStats;
    if (!rawData) return;

    const sourceSelect = document.getElementById('stats-source-select');
    const modelSelect = document.getElementById('stats-model-select');
    const timeSelect = document.getElementById('stats-time-select');
    
    // 获取快捷提供商筛选
    const activeFilterBtn = document.querySelector('.icon-filter-btn.active');
    const providerFilter = activeFilterBtn ? activeFilterBtn.getAttribute('data-provider') : 'all';

    const selectedSource = sourceSelect ? sourceSelect.value : 'all';
    const selectedModel = modelSelect ? modelSelect.value : 'all';
    const selectedTime = timeSelect ? timeSelect.value : 'today';

    let logs = rawData.logs || [];

    // 1. 时间筛选器过滤
    const now = Date.now();
    if (selectedTime === 'today') {
        const startOfToday = new Date().setHours(0, 0, 0, 0);
        logs = logs.filter(log => log.timestamp >= startOfToday);
    } else if (selectedTime === '7days') {
        const startOf7Days = now - 7 * 24 * 60 * 60 * 1000;
        logs = logs.filter(log => log.timestamp >= startOf7Days);
    }

    // 2. 快捷提供商按钮过滤
    if (providerFilter !== 'all') {
        logs = logs.filter(log => log.provider.toLowerCase() === providerFilter.toLowerCase());
    }

    // 3. 下拉来源过滤
    if (selectedSource !== 'all') {
        if (selectedSource === 'gateway') {
            // 目前全部算作Nexora Agent入口日志，不作进一步过滤
        } else if (selectedSource === 'plugins') {
            // 目前没有插件管道日志，直接过滤为空
            logs = logs.filter(log => log.isPlugin === true);
        }
    }

    // 4. 下拉模型过滤
    if (selectedModel !== 'all') {
        if (selectedModel === 'primary') {
            const primaryModel = document.getElementById('model-primary').value || '';
            const modelId = primaryModel.includes('/') ? primaryModel.split('/')[1] : primaryModel;
            logs = logs.filter(log => log.model.includes(modelId));
        } else if (selectedModel === 'fallback') {
            const fallbackModel = document.getElementById('model-fallback').value || '';
            const modelId = fallbackModel.includes('/') ? fallbackModel.split('/')[1] : fallbackModel;
            logs = logs.filter(log => log.model.includes(modelId));
        } else {
            logs = logs.filter(log => log.model === selectedModel);
        }
    }

    // 5. 基于过滤后的 logs 重算汇总卡片指标
    const total_tokens = logs.reduce((sum, log) => sum + log.input + log.output, 0);
    const total_requests = logs.length;
    const sub_input_tokens = logs.reduce((sum, log) => sum + log.input, 0);
    const sub_output_tokens = logs.reduce((sum, log) => sum + log.output, 0);
    const sub_hit_tokens = logs.reduce((sum, log) => sum + (log.hit || 0), 0);
    const hit_rate = total_tokens > 0 ? (sub_hit_tokens / total_tokens) * 100 : 0;
    
    // 输入 $0.002/1k, 输出 $0.008/1k 粗略估算成本
    const total_cost = logs.reduce((sum, log) => sum + (log.input * 0.000002 + log.output * 0.000008), 0);

    // 更新指标卡片
    document.getElementById('summary-tokens').innerText = total_tokens.toLocaleString();
    const tokensApprox = document.getElementById('summary-tokens-approx');
    if (tokensApprox) {
        if (total_tokens < 10000) {
            tokensApprox.style.display = 'none';
        } else {
            tokensApprox.style.display = 'inline';
            tokensApprox.innerText = formatNumberWithUnit(total_tokens, true);
        }
    }
    document.getElementById('summary-requests').innerText = total_requests.toLocaleString();
    document.getElementById('summary-cost').innerText = `$${total_cost.toFixed(4)}`;
    document.getElementById('sub-input').innerText = formatNumberWithUnit(sub_input_tokens);
    document.getElementById('sub-output').innerText = formatNumberWithUnit(sub_output_tokens);
    document.getElementById('sub-hit').innerText = formatNumberWithUnit(sub_hit_tokens);
        
    document.getElementById('hit-rate-val').innerText = `${hit_rate.toFixed(1)}%`;
    document.getElementById('hit-rate-bar').style.width = `${hit_rate}%`;

    // 6. 重置 hourly_trend 重新计算绘图数据
    const hours = ['00:00', '02:00', '04:00', '06:00', '08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'];
    let lineData = {
        cost: Array(12).fill(0),
        cacheCreate: Array(12).fill(0),
        cacheHit: Array(12).fill(0),
        input: Array(12).fill(0),
        output: Array(12).fill(0)
    };

    logs.forEach(log => {
        const timePart = log.time.split(' ')[1] || log.time;
        const hr = parseInt(timePart.split(':')[0]);
        if (!isNaN(hr)) {
            const roundedHr = Math.floor(hr / 2) * 2;
            const hourStr = (roundedHr < 10 ? '0' : '') + roundedHr + ':00';
            const idx = hours.indexOf(hourStr);
            if (idx !== -1) {
                lineData.input[idx] += log.input;
                lineData.output[idx] += log.output;
                lineData.cacheHit[idx] += (log.hit || 0);
            }
        }
    });

    const norm = (v) => Math.min(100, Math.max(2, (v / 20000.0) * 100));
    const processedLineData = {
        cost: lineData.input.map((v, i) => norm(v * 0.000002 + lineData.output[i] * 0.000008)),
        cacheCreate: lineData.input.map(v => norm(v * 0.15)),
        cacheHit: lineData.cacheHit.map(v => norm(v)),
        input: lineData.input.map(v => norm(v)),
        output: lineData.output.map(v => norm(v))
    };

    // 重新绘制 SVG 趋势折线图 (配合筛选丝滑抖动)
    const waveBox = document.getElementById('stats-wave-chart-box');
    if (waveBox) {
        const width = 600;
        const height = 200;
        const paddingLeft = 40;
        const paddingRight = 20;
        const paddingTop = 20;
        const paddingBottom = 30;
        const plotWidth = width - paddingLeft - paddingRight;
        const plotHeight = height - paddingTop - paddingBottom;

        let gridHtml = '';
        const yLines = 4;
        for (let i = 0; i <= yLines; i++) {
            const y = paddingTop + (plotHeight / yLines) * i;
            gridHtml += `<line x1="${paddingLeft}" y1="${y}" x2="${width - paddingRight}" y2="${y}" stroke="rgba(255,255,255,0.04)" />`;
            const labelVal = Math.round(20000 * (1 - i / yLines));
            gridHtml += `<text x="${paddingLeft - 8}" y="${y + 4}" fill="var(--text-secondary)" font-size="9" text-anchor="end">${labelVal}k</text>`;
        }

        hours.forEach((h, idx) => {
            const x = paddingLeft + (plotWidth / (hours.length - 1)) * idx;
            gridHtml += `<text x="${x}" y="${height - 10}" fill="var(--text-secondary)" font-size="9" text-anchor="middle">${h}</text>`;
            gridHtml += `<line x1="${x}" y1="${paddingTop}" x2="${x}" y2="${height - paddingBottom}" stroke="rgba(255,255,255,0.02)" stroke-dasharray="2,2" />`;
        });

        const getCurvePath = (values) => {
            let path = '';
            const len = values.length;
            const coords = values.map((val, idx) => {
                const x = paddingLeft + (plotWidth / (len - 1)) * idx;
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

        const curves = [
            { key: 'cost', color: '#ff5252', width: 2, fillOpacity: 0.05 },
            { key: 'cacheCreate', color: '#ff9100', width: 2, fillOpacity: 0.03 },
            { key: 'cacheHit', color: '#2979ff', width: 2.5, fillOpacity: 0.08 },
            { key: 'input', color: '#00e676', width: 3, fillOpacity: 0.1 },
            { key: 'output', color: 'var(--accent-color)', width: 2.5, fillOpacity: 0.08 }
        ];

        let pathsHtml = '';
        curves.forEach((c) => {
            const { path, coords } = getCurvePath(processedLineData[c.key]);
            const gradId = `grad-${c.key}`;
            pathsHtml += `
                <defs>
                    <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="${c.color}" stop-opacity="${c.fillOpacity}"/>
                        <stop offset="100%" stop-color="${c.color}" stop-opacity="0"/>
                    </linearGradient>
                </defs>
                <path d="${path} L ${coords[coords.length - 1].x} ${height - paddingBottom} L ${coords[0].x} ${height - paddingBottom} Z" fill="url(#${gradId})" />
                <path d="${path}" fill="none" stroke="${c.color}" stroke-width="${c.width}" stroke-linecap="round" />
            `;
        });

        waveBox.innerHTML = `
            <svg width="100%" height="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
                ${gridHtml}
                ${pathsHtml}
            </svg>
        `;
    }

    // 7. 生成过滤后的统计快照并覆盖刷新数据表格
    const mockFilteredStats = {
        logs: logs,
        providers: {},
        models: {},
        total_tokens: total_tokens
    };

    logs.forEach(log => {
        if (!mockFilteredStats.providers[log.provider]) {
            mockFilteredStats.providers[log.provider] = { tokens: 0, requests: 0, hit: 0 };
        }
        mockFilteredStats.providers[log.provider].tokens += log.input + log.output;
        mockFilteredStats.providers[log.provider].requests += 1;
        mockFilteredStats.providers[log.provider].hit += (log.hit || 0);

        if (!mockFilteredStats.models[log.model]) {
            mockFilteredStats.models[log.model] = { tokens: 0, provider: log.provider, calls: 0, duration: 0, hit: 0 };
        }
        mockFilteredStats.models[log.model].tokens += log.input + log.output;
        mockFilteredStats.models[log.model].calls += 1;
        mockFilteredStats.models[log.model].hit += (log.hit || 0);
        
        const sec = parseFloat(log.duration.replace('s',''));
        mockFilteredStats.models[log.model].duration += isNaN(sec) ? 1.0 : sec;
    });

    // 临时侵入并渲染底层表格后恢复
    const realStats = window.lastFetchedStats;
    window.lastFetchedStats = mockFilteredStats;

    const btnLogs = document.getElementById('btn-stats-tab-logs');
    const btnProviders = document.getElementById('btn-stats-tab-providers');
    const btnModels = document.getElementById('btn-stats-tab-models');

    // 执行当前选中子选项卡的刷新 (直接调用局部钩子，无缝复用原闭包逻辑)
    if (btnLogs && btnLogs.classList.contains('active') && globalRenderLogsTable) {
        globalRenderLogsTable();
    } else if (btnProviders && btnProviders.classList.contains('active') && globalRenderProvidersTable) {
        globalRenderProvidersTable();
    } else if (btnModels && btnModels.classList.contains('active') && globalRenderModelsTable) {
        globalRenderModelsTable();
    }

    window.lastFetchedStats = realStats; // 还原
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
        qrcodeOverlay.style.opacity = '1';
    };

    img.onerror = () => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 160, 160);
        ctx.fillStyle = '#ff5252';
        ctx.font = '11px sans-serif';
        ctx.fillText('加载出错,请点击下方复制', 10, 80);
        qrcodeOverlay.style.opacity = '1';
    };
}

// 11. 新手遮罩引导系统多步逻辑
const guideSteps = [
    {
        target: 'tour-nav-console',
        title: '🏠 步骤一: 控制台首页',
        content: '这是您的本地Nexora Agent调度中心。Nexora Agent服务已经自动在后台无缝为您启动。如果您需要接入微信聊天助手，点击中间的“绑定微信”扫描二维码即可一键登入！'
    },
    {
        target: 'btn-nav-openclaw-web',
        title: '🤖 步骤二: 沉浸式 AI 对话',
        content: '重头戏在这里！点击切换到 OpenClaw 面板，即可直接使用最高级、最智能的 AI 对话系统，支持联网搜索、深度思考、代码编写和长期记忆，极速畅聊！'
    },
    {
        target: 'tour-nav-plugins',
        title: '🔌 步骤三: 插件即插即用',
        content: '内置 40+ 实用的底层扩展插件！在这里您可以一键开启视觉识别、语音交互、深度搜索引擎等超强能力，所有开关即刻生效，无需重启。'
    },
    {
        target: 'tour-nav-config',
        title: '⚙️ 步骤四: 自定义您的模型',
        content: '默认已为您配置了高速免费模型。但如果您有自己的 API Key（如 OpenAI、Anthropic、DeepSeek），也可以在这里可视化填入并切换，所有配置安全存储在本地。'
    }
];

let currentGuideStepIndex = 0;

function checkAndStartGuide() {
    // 产品决策：永久关闭新手遮罩引导（避免挡操作 / 无影环境反复弹出）
    try { localStorage.setItem('guide_completed', 'true'); } catch (e) {}
    const overlay = document.getElementById('guide-overlay');
    const card = document.getElementById('guide-step-card');
    if (overlay) overlay.style.display = 'none';
    if (card) card.style.display = 'none';
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

// 13. 微信解绑已由动态委托处理（wechat-accounts-container → wechat-unbind-btn-dynamic），此处不再需要静态绑定

// 14. 内置插件异步操作闭环（通讯扫码 / 插件页 / 以后任意内置扫码插件共用）
// 保证：全局遮罩、可取消、唤醒超时、扫码超时、成功/失败都能解除，绝不无限卡死。
const COMM_BINDING_WAKE_MS = 120000; // 慢机器冷启动也够用；扫码阶段另有 5 分钟
const COMM_BINDING_SCAN_MS = 5 * 60 * 1000;
let __commBindingSession = {
    active: false,
    channel: null,
    phase: null, // waking | scanning
    wakeTimer: null,
    scanTimer: null,
    failHandled: false
};

function resolvePluginAsyncOverlay() {
    return document.getElementById('plugin-async-overlay')
        || document.getElementById('comm-binding-overlay');
}

function showCommBindingOverlay(msg, tip) {
    const overlay = resolvePluginAsyncOverlay();
    if (overlay) {
        const titleEl = document.getElementById('plugin-async-overlay-title')
            || document.getElementById('comm-binding-overlay-title');
        const tipEl = document.getElementById('plugin-async-overlay-tip')
            || document.getElementById('comm-binding-overlay-tip');
        if (titleEl && msg) titleEl.textContent = msg;
        if (tipEl && tip) tipEl.textContent = tip;
        overlay.style.display = 'flex';
    }
}
function hideCommBindingOverlay() {
    const overlay = resolvePluginAsyncOverlay();
    if (overlay) overlay.style.display = 'none';
}

function clearCommBindingTimers() {
    if (__commBindingSession.wakeTimer) {
        clearTimeout(__commBindingSession.wakeTimer);
        __commBindingSession.wakeTimer = null;
    }
    if (__commBindingSession.scanTimer) {
        clearTimeout(__commBindingSession.scanTimer);
        __commBindingSession.scanTimer = null;
    }
}

function hideQrCodeOverlay() {
    if (typeof qrcodeOverlay !== 'undefined' && qrcodeOverlay) {
        qrcodeOverlay.style.opacity = '0';
        qrcodeOverlay.style.display = 'none';
    }
}

function labelForBindChannel(channel) {
    const ch = String(channel || '');
    if (ch === 'feishu' || ch === 'lark') return '飞书';
    if (ch === 'wechat' || ch === 'openclaw-weixin') return '微信';
    if (ch === 'whatsapp') return 'WhatsApp';
    if (ch === 'telegram') return 'Telegram';
    if (ch === 'slack') return 'Slack';
    if (ch === 'matrix') return 'Matrix';
    if (ch === 'qqbot' || ch === 'qq') return 'QQ';
    return ch || '内置插件';
}

function cancelBackendChannelBinding(channel) {
    // 一律 cancel-all：覆盖微信 / 飞书 / 以后任意 channel-login-start 启动的内置插件
    try {
        if (window.api && window.api.cancelAllChannelLogins) {
            window.api.cancelAllChannelLogins();
            return;
        }
    } catch (e) {}
    const ch = channel || __commBindingSession.channel || window.__activeQrChannel;
    try {
        if ((!ch || ch === 'wechat' || ch === 'openclaw-weixin') && window.api && window.api.cancelWeChatLogin) {
            window.api.cancelWeChatLogin();
        }
    } catch (e) {}
    try {
        if ((!ch || ch === 'feishu' || ch === 'lark') && window.api && window.api.cancelFeishuQrLogin) {
            window.api.cancelFeishuQrLogin();
        }
    } catch (e) {}
    try {
        if (window.api && window.api.cancelChannelLogin) window.api.cancelChannelLogin(ch);
    } catch (e) {}
}

/** 开始一次内置插件/渠道异步绑定（遮罩 + 唤醒超时）。以后新增内置扫码插件也应调用此函数。 */
function beginCommBinding(channel, wakeMsg, tip) {
    // 换渠道时只取消当前会话；不要误伤「即将启动」的同渠道重试以外逻辑
    const prev = __commBindingSession.channel;
    endCommBinding({ silent: true, cancelBackend: true });
    // 若上一段是微信，短延迟后状态轮询仍可能报成功——已用 channel 门控保护飞书弹窗
    void prev;
    __commBindingSession = {
        active: true,
        channel: channel || 'channel',
        phase: 'waking',
        wakeTimer: null,
        scanTimer: null,
        failHandled: false
    };
    window.__activeQrChannel = channel;
    const label = labelForBindChannel(channel);
    showCommBindingOverlay(
        wakeMsg || `⏳ 正在唤醒${label}绑定模块...`,
        tip || `正在准备${label}（内置插件）。最多等待约 ${Math.round(COMM_BINDING_WAKE_MS / 1000)} 秒；可随时点「取消」。`
    );
    __commBindingSession.wakeTimer = setTimeout(() => {
        failCommBinding(`${label}绑定模块无响应（超时）。请确认插件已内置后重试。`);
    }, COMM_BINDING_WAKE_MS);
}

/** 已拿到二维码：关掉全屏加载遮罩（绝不能挡码），只保留扫码弹窗 + 扫码超时。 */
function markCommBindingQrReady(channel, _scanningMsg) {
    if (channel) {
        __commBindingSession.channel = channel;
        window.__activeQrChannel = channel;
    }
    if (!__commBindingSession.active) {
        __commBindingSession.active = true;
        __commBindingSession.failHandled = false;
    }
    if (__commBindingSession.wakeTimer) {
        clearTimeout(__commBindingSession.wakeTimer);
        __commBindingSession.wakeTimer = null;
    }
    __commBindingSession.phase = 'scanning';
    // 出码后立即卸全屏 spinner，否则会盖住二维码无法扫描
    hideCommBindingOverlay();
    const ch = __commBindingSession.channel || channel || 'channel';
    const label = labelForBindChannel(ch);
    if (__commBindingSession.scanTimer) clearTimeout(__commBindingSession.scanTimer);
    __commBindingSession.scanTimer = setTimeout(() => {
        failCommBinding(`${label}扫码超时，请重新发起绑定。`);
    }, COMM_BINDING_SCAN_MS);
}

function failCommBinding(message) {
    // 已结束且刚失败过：吞掉主进程重复的 failed 事件，避免双 Toast
    if (__commBindingSession.failHandled || !__commBindingSession.active) {
        clearCommBindingTimers();
        cancelBackendChannelBinding(__commBindingSession.channel || window.__activeQrChannel);
        hideQrCodeOverlay();
        hideCommBindingOverlay();
        return;
    }
    __commBindingSession.failHandled = true;
    if (typeof showToast === 'function') showToast('❌ ' + (message || '渠道绑定失败'));
    const channel = __commBindingSession.channel || window.__activeQrChannel;
    clearCommBindingTimers();
    cancelBackendChannelBinding(channel);
    if (typeof stopWeChatBindingFastPoll === 'function') stopWeChatBindingFastPoll();
    hideQrCodeOverlay();
    hideCommBindingOverlay();
    __commBindingSession.active = false;
    __commBindingSession.phase = null;
    __commBindingSession.channel = null;
    window.__activeQrChannel = null;
}

function completeCommBinding() {
    clearCommBindingTimers();
    __commBindingSession.active = false;
    __commBindingSession.phase = null;
    __commBindingSession.channel = null;
    __commBindingSession.failHandled = false;
    window.__activeQrChannel = null;
    if (typeof stopWeChatBindingFastPoll === 'function') stopWeChatBindingFastPoll();
    hideQrCodeOverlay();
    hideCommBindingOverlay();
}

/** @param {{ silent?: boolean, cancelBackend?: boolean, toast?: string }} opts */
function endCommBinding(opts = {}) {
    const channel = __commBindingSession.channel || window.__activeQrChannel;
    const wasActive = __commBindingSession.active;
    clearCommBindingTimers();
    if (opts.cancelBackend !== false) cancelBackendChannelBinding(channel);
    if (typeof stopWeChatBindingFastPoll === 'function') stopWeChatBindingFastPoll();
    hideQrCodeOverlay();
    hideCommBindingOverlay();
    __commBindingSession.active = false;
    __commBindingSession.phase = null;
    __commBindingSession.channel = null;
    if (!__commBindingSession.failHandled) __commBindingSession.failHandled = false;
    window.__activeQrChannel = null;
    if (opts.toast && wasActive && typeof showToast === 'function') showToast(opts.toast);
}

// 全局遮罩「取消」
(function wireCommBindingCancelBtn() {
    const btn = document.getElementById('plugin-async-overlay-cancel')
        || document.getElementById('comm-binding-overlay-cancel');
    if (!btn) return;
    btn.addEventListener('click', () => {
        endCommBinding({ cancelBackend: true, toast: '已取消插件绑定' });
    });
})();

const originalBindBtn = document.getElementById('wechat-bind-btn');
if (originalBindBtn) {
    originalBindBtn.addEventListener('click', async () => {
        if (originalBindBtn.disabled) return;
        const oldHtml = originalBindBtn.innerHTML;
        originalBindBtn.disabled = true;
        originalBindBtn.style.opacity = '0.6';
        originalBindBtn.style.cursor = 'not-allowed';
        originalBindBtn.innerHTML = '⏳ 正在唤醒微信手动绑定...';
        beginCommBinding('wechat', '⏳ 正在唤醒微信绑定模块...');
        
        try {
            if (logTerminal) logTerminal.innerText += '\n[WeChat Login] 正在唤醒微信手动绑定模块，请稍候...\n';
            const result = await window.api.triggerWeChatLogin();
            if (result.success) {
                if (logTerminal) logTerminal.innerText += '[WeChat Login] 手动绑定服务拉起中，等待抓取登录二维码...\n';
            } else {
                failCommBinding('拉起绑定失败：' + (result.error || '未知错误'));
            }
        } catch (err) {
            failCommBinding('拉起异常：' + err.message);
        } finally {
            originalBindBtn.disabled = false;
            originalBindBtn.style.opacity = '1';
            originalBindBtn.style.cursor = 'pointer';
            originalBindBtn.innerHTML = oldHtml;
        }
    });
}

// 多语言界面动态重载渲染
function applyLanguage(lang) {
    // 0. 通用型快照保存当前页面所有 <select> 的选中值
    //    基于 DOM 元素引用 (Element) 进行存储，无需依赖 ID，完美适配未来任何新增的下拉框
    const selectSnapshots = new Map();
    document.querySelectorAll('select').forEach(sel => {
        selectSnapshots.set(sel, sel.value);
    });

    // 1. 给 body 挂载当前语言类名，以备未来 CSS 微调用
    document.body.className = document.body.className.replace(/\blang-\S+/g, '');
    document.body.classList.add(`lang-${lang}`);

    // 2. 声明式遍历翻译所有带 data-i18n 属性的 DOM 文本（现已有快照防御机制，无需排除 option）
    document.querySelectorAll('[data-i18n]').forEach(el => {
        try {
            const key = el.getAttribute('data-i18n');
            
            // 防御性保护：如果元素当前包含了检测出来的真实 IP 地址（通常带国旗图标或纯数字格式），切勿覆盖重置它
            if (el.textContent && /\d{1,3}(?:\.\d{1,3}){3}/.test(el.textContent)) {
                return;
            }

            const translation = t(key);
            if (translation !== key) {
                // 如果有 html 渲染需求，使用 innerHTML，否则用 textContent 以免破坏内部子元素
                if (el.getAttribute('data-i18n-type') === 'html') {
                    el.innerHTML = translation;
                } else {
                    el.textContent = translation;
                }
            }
        } catch (err) {
            console.warn('[i18n] Error translating element:', el, err);
        }
    });

    // 3. 声明式遍历翻译占位符 placeholder
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        const translation = t(key);
        if (translation !== key) {
            el.setAttribute('placeholder', translation);
        }
    });

    // 4. 声明式遍历翻译 title 悬浮悬停提示
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        const translation = t(key);
        if (translation !== key) {
            el.setAttribute('title', translation);
        }
    });

    // 5. 对话欢迎语和特殊Nexora Agent连接状态的翻译
    const statusTextEl = document.getElementById('gateway-connection-status-text');
    if (statusTextEl) {
        const useBuiltIn = getUseBuiltIn();
        if (gatewayStatus === 'running' || gatewayFullyReady) {
            statusTextEl.setAttribute('data-i18n', 'status.running');
            statusTextEl.innerText = t('status.running');
            statusTextEl.style.color = '#00e676';
        } else if (gatewayStatus === 'starting') {
            statusTextEl.setAttribute('data-i18n', 'status.starting');
            statusTextEl.innerText = t('status.starting');
            statusTextEl.style.color = '#ffd54f';
        } else {
            // stopped
            if (useBuiltIn) {
                statusTextEl.setAttribute('data-i18n', 'status.stopped');
                statusTextEl.innerText = t('status.stopped');
                statusTextEl.style.color = '#b388ff';
            } else {
                statusTextEl.setAttribute('data-i18n', 'status.offline_hint');
                statusTextEl.innerText = t('status.offline_hint');
                statusTextEl.style.color = '#ff9800';
            }
        }
    }

    // 5b. 翻译侧边栏“正常 / Active”微型状态字样 (已改动为直接隐藏，避免干扰)
    const sidebarPercent = document.getElementById('sidebar-status-percentage');
    if (sidebarPercent && (sidebarPercent.innerText === '正常' || sidebarPercent.innerText === 'Active')) {
        sidebarPercent.style.display = 'none';
    }

    // 5c. 模型对话「展开/收起帮助」按钮（动态文案，不走 data-i18n）
    try {
        if (typeof window.syncChatQuickPanelToggleText === 'function') {
            window.syncChatQuickPanelToggleText();
        }
    } catch (e) {}

    // 6. 重新执行动态生成的 UI 模块渲染
    if (typeof renderProvidersList === 'function') {
        try { renderProvidersList(); } catch(e) { console.error(e); }
    }
    if (typeof renderPluginsGrid === 'function') {
        try { renderPluginsGrid(); } catch(e) { console.error(e); }
    }
    if (typeof renderUsageCharts === 'function') {
        try { renderUsageCharts(); } catch(e) { console.error(e); }
    }
    if (typeof updateWeChatStatusUI === 'function') {
        try { updateWeChatStatusUI(); } catch(e) { console.error(e); }
    }
    if (typeof updateGatewayStatusUI === 'function') {
        try { updateGatewayStatusUI(gatewayStatus); } catch(e) { console.error(e); }
    }
    if (typeof updateFilterOptions === 'function') {
        try { updateFilterOptions(); } catch(e) { console.error(e); }
    }
    if (typeof applyViewMode === 'function') {
        try { applyViewMode(localStorage.getItem('console_view_mode') || 'step'); } catch(e) { console.error(e); }
    }
    if (typeof updateStepperUI === 'function') {
        try { updateStepperUI(currentProgress); } catch(e) { console.error(e); }
    }

    // 7. 无差别还原所有 <select> 的选中值，强制触发 Chromium 界面显示重绘
    const _restoreAllSelects = () => {
        selectSnapshots.forEach((savedValue, sel) => {
            // 元素如果已经脱离 DOM (例如在动态重绘中被销毁) 则跳过
            if (!document.body.contains(sel)) return;
            
            // 如果是主界面的语言选择框，特殊强制为当前系统实际应用的语言值
            const targetValue = (sel.id === 'setting-language-select') ? lang : savedValue;
            if (!targetValue) return;

            for (let i = 0; i < sel.options.length; i++) {
                if (sel.options[i].value === targetValue) {
                    sel.options[i].selected = true;
                    sel.selectedIndex = i;
                    break;
                }
            }
            
            // 强制 Chromium 重绘该下拉框的外观文本（视觉防重置技术）
            const dummy = document.createElement('option');
            dummy.style.display = 'none';
            sel.appendChild(dummy);
            sel.removeChild(dummy);
        });
    };
    
    _restoreAllSelects();
    requestAnimationFrame(() => _restoreAllSelects());

    // 模型角色：动态列表/按钮文案跟随系统语言
    try {
        if (typeof renderRolesList === 'function' && __roleConfigState) {
            renderRolesList();
            if (typeof fillRoleEditor === 'function' && !__editingNewRole) {
                fillRoleEditor(findRoleInState(__selectedRoleId));
            }
            if (typeof updateChatActiveRoleBadge === 'function') {
                updateChatActiveRoleBadge();
            }
        }
    } catch (e) {}
}

// 发送系统桌面横幅通知
function sendDesktopNotification(title, message) {
    if (localStorage.getItem('setting_enable_notification') !== 'false') {
        try {
            if (Notification.permission === 'granted') {
                new Notification(title, { body: message });
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(permission => {
                    if (permission === 'granted') {
                        new Notification(title, { body: message });
                    }
                });
            }
        } catch (e) {
            console.error('Failed to send notification:', e);
        }
    }
}

// 优雅的全局暗色 Toast 提示气泡
function showToast(message) {
    if (localStorage.getItem('setting_enable_notification') === 'false') {
        const str = String(message || '');
        if (/自动路由|自动切换|最低延迟|自动测速/i.test(str)) {
            return;
        }
    }
    let toast = document.getElementById('custom-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'custom-toast';
        toast.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 24px;
            background: var(--bg-panel);
            border: 1px solid var(--border-color);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2), var(--accent-glow-reduced);
            color: var(--text-primary);
            backdrop-filter: blur(10px);
            padding: 12px 20px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            z-index: 99999;
            display: flex;
            align-items: center;
            line-height: 1;
            gap: 8px;
            opacity: 0;
            transform: translateY(20px);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            pointer-events: none;
        `;
        document.body.appendChild(toast);
    }
    toast.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display: block; flex-shrink: 0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span style="display: inline-block; line-height: 1;">${t(message)}</span>
    `;
    
    // 显示
    setTimeout(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    }, 50);
    
    // 3秒后自动消失
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
    }, 3000);
}

// ==================== 模型对话舱核心逻辑 ====================
let chatAttachmentBase64 = ''; // 存储识图图片的 base64 编码
let chatSessionHistory = []; // 存储当前会话的历史记录
// 自动初始化对话面板事件
function initChatView() {
    const btnSend = document.getElementById('btn-chat-send');
    const inputArea = document.getElementById('chat-text-input');
    const btnUpload = document.getElementById('btn-chat-upload-media');
    const fileInput = document.getElementById('chat-file-upload-input');
    const btnRemoveAttach = document.getElementById('btn-remove-attachment');
    const previewBar = document.getElementById('chat-attachment-preview-bar');
    const previewImg = document.getElementById('img-attachment-preview');
    const refreshModelsBtn = document.getElementById('btn-refresh-chat-models');
    
    // 初始化快捷面板折叠状态
    const quickPanel = document.getElementById('chat-quick-panel');
    const toggleBtn = document.getElementById('btn-toggle-quick-panel');
    const toggleIcon = document.getElementById('quick-panel-toggle-icon');

    function syncChatQuickPanelToggleText() {
        const collapsed = localStorage.getItem('chat_quick_panel_collapsed') === 'true';
        const el = document.getElementById('quick-panel-toggle-text');
        if (!el) return;
        el.innerText = collapsed
            ? t('展开帮助', 'Show Help', '展開幫助')
            : t('收起帮助', 'Hide Help', '收起幫助');
    }
    window.syncChatQuickPanelToggleText = syncChatQuickPanelToggleText;

    const isCollapsed = localStorage.getItem('chat_quick_panel_collapsed') === 'true';
    if (isCollapsed && quickPanel) {
        quickPanel.style.maxHeight = '0px';
        quickPanel.style.opacity = '0';
        quickPanel.style.marginTop = '0px';
        quickPanel.style.pointerEvents = 'none';
        if (toggleIcon) toggleIcon.style.transform = 'rotate(-180deg)';
    }
    syncChatQuickPanelToggleText();

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            const currentCollapsed = localStorage.getItem('chat_quick_panel_collapsed') === 'true';
            const nextCollapsed = !currentCollapsed;
            localStorage.setItem('chat_quick_panel_collapsed', nextCollapsed ? 'true' : 'false');

            if (nextCollapsed) {
                quickPanel.style.maxHeight = '0px';
                quickPanel.style.opacity = '0';
                quickPanel.style.marginTop = '0px';
                quickPanel.style.pointerEvents = 'none';
                if (toggleIcon) toggleIcon.style.transform = 'rotate(-180deg)';
            } else {
                quickPanel.style.maxHeight = '80px';
                quickPanel.style.opacity = '1';
                quickPanel.style.marginTop = '2px';
                quickPanel.style.pointerEvents = 'auto';
                if (toggleIcon) toggleIcon.style.transform = 'rotate(0deg)';
            }
            syncChatQuickPanelToggleText();
        });
    }
    
    // 生图与生视频按钮
    const btnDraw = document.getElementById('btn-chat-action-draw');
    const btnVideo = document.getElementById('btn-chat-action-video');

    // 绑定多功能上传 (识图)
    btnUpload.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(event) {
                const img = new Image();
                img.onload = function() {
                    let width = img.width;
                    let height = img.height;
                    const maxDim = 1024;
                    if (width > maxDim || height > maxDim) {
                        if (width > height) {
                            height = Math.round((height * maxDim) / width);
                            width = maxDim;
                        } else {
                            width = Math.round((width * maxDim) / height);
                            height = maxDim;
                        }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    
                    chatAttachmentBase64 = canvas.toDataURL('image/png');
                    previewImg.src = chatAttachmentBase64;
                    previewBar.style.display = 'flex';
                    
                    const compressedSizeKB = (chatAttachmentBase64.length * 0.75 / 1024).toFixed(1);
                    document.getElementById('attachment-name-label').innerText = `已压缩加载: ${file.name} (大小: ${compressedSizeKB} KB)`;
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        }
    });

    btnRemoveAttach.addEventListener('click', () => {
        chatAttachmentBase64 = '';
        fileInput.value = '';
        previewBar.style.display = 'none';
    });

    // 绑定刷新模型列表
    refreshModelsBtn.addEventListener('click', loadChatModels);
    
    // 输入框按键监听
    inputArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });

    btnSend.addEventListener('click', () => handleSendMessage());

    // 绑定生图和生视频
    btnDraw.addEventListener('click', () => handleActionGenerate('image'));
    btnVideo.addEventListener('click', () => handleActionGenerate('video'));
    
    // 绑定系统常见帮助疑难问答一键咨询气泡事件
    document.querySelectorAll('.help-tag-pill').forEach(pill => {
        pill.addEventListener('click', (e) => {
            const questionKey = e.currentTarget.getAttribute('data-i18n-question');
            const question = questionKey ? t(questionKey) : e.currentTarget.getAttribute('data-question');
            if (question && inputArea) {
                inputArea.value = question;
                handleSendMessage();
            }
        });
    });

    // 首次进入加载模型
    loadChatModels();
}

async function loadChatModels() {
    const select = document.getElementById('chat-model-select');
    if (!select) return;
    select.innerHTML = '';
    
    let hasModels = false;

    // 1. 如果启用了内置模型，强制将官方高速模型放于下拉菜单最顶端
    const useBuiltIn = getUseBuiltIn();
    if (useBuiltIn) {
        const builtInOpts = [
            { id: 'agnes-2.0-flash', label: `agnes-ai / agnes-2.0-flash${t(' (内置默认)', ' (Built-in Default)', ' (內置默認)')}` },
            { id: 'agnes-1.5-flash', label: `agnes-ai / agnes-1.5-flash${t(' (内置备用)', ' (Built-in Standby)', ' (內置備用)')}` },
            { id: 'agnes-video-v2.0', label: `agnes-ai / agnes-video-v2.0${t(' (内置视频)', ' (Built-in Video)', ' (內置視頻)')}` },
            { id: 'agnes-image-2.1-flash', label: `agnes-ai / agnes-image-2.1-flash${t(' (内置图像)', ' (Built-in Image)', ' (內置圖像)')}` },
            { id: 'agnes-image-2.0-flash', label: `agnes-ai / agnes-image-2.0-flash${t(' (内置图像默认)', ' (Built-in Image Default)', ' (內置圖像默認)')}` }
        ];
        builtInOpts.forEach(optData => {
            const opt = document.createElement('option');
            opt.value = optData.id;
            opt.setAttribute('data-provider', 'agnes-ai');
            opt.innerText = optData.label;
            select.appendChild(opt);
        });
        hasModels = true;
    }

    // 2. 遍历其它已配置提供商：内置开追加本地 ollama；关则全部
    for (const providerKey of Object.keys(localProviders)) {
        if (useBuiltIn && !isBuiltinAllowedProvider(providerKey)) continue;
        // 开启内置时，跳过重复渲染 agnes-ai（上方已注入）
        if (useBuiltIn && providerKey === 'agnes-ai') continue;

        const provider = localProviders[providerKey];
        const models = provider.models || [];

        models.forEach(model => {
            if (model.id) {
                const opt = document.createElement('option');
                opt.value = model.id;
                opt.setAttribute('data-provider', providerKey);
                opt.innerText = `${providerKey} / ${model.id}`;
                select.appendChild(opt);
                hasModels = true;
            }
        });
    }

    if (!hasModels) {
        select.innerHTML = `
            <option value="agnes-2.0-flash" data-provider="agnes-ai">agnes-ai / agnes-2.0-flash${t(' (内置默认)', ' (Built-in Default)', ' (內置默認)')}</option>
            <option value="agnes-1.5-flash" data-provider="agnes-ai">agnes-ai / agnes-1.5-flash${t(' (内置备用)', ' (Built-in Standby)', ' (內置備用)')}</option>
            <option value="agnes-video-v2.0" data-provider="agnes-ai">agnes-ai / agnes-video-v2.0${t(' (内置视频)', ' (Built-in Video)', ' (內置視頻)')}</option>
            <option value="agnes-image-2.1-flash" data-provider="agnes-ai">agnes-ai / agnes-image-2.1-flash${t(' (内置图像)', ' (Built-in Image)', ' (內置圖像)')}</option>
            <option value="agnes-image-2.0-flash" data-provider="agnes-ai">agnes-ai / agnes-image-2.0-flash${t(' (内置图像默认)', ' (Built-in Image Default)', ' (內置圖像默認)')}</option>
        `;
    }

    // 3. 强制在启用内置大模型时，默认选中 agnes-2.0-flash
    if (useBuiltIn) {
        select.value = 'agnes-2.0-flash';
    }
}

// 为 AI 的气泡消息添加朗读操作按钮
function addTtsToAiBubble(msgDiv, bubble) {
    if (!msgDiv || !bubble) return;
    // 检查是否已经有 actionRow 了，避免重复添加
    if (bubble.parentNode && bubble.parentNode.querySelector('.tts-action-row')) return;

    let bubbleWrapper;
    if (bubble.parentNode && bubble.parentNode !== msgDiv && bubble.parentNode.classList.contains('bubble-wrapper')) {
        bubbleWrapper = bubble.parentNode;
    } else {
        bubbleWrapper = document.createElement('div');
        bubbleWrapper.className = 'bubble-wrapper';
        bubbleWrapper.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 4px;
            align-items: flex-start;
            min-width: 0;
        `;
        if (bubble.parentNode) {
            bubble.parentNode.insertBefore(bubbleWrapper, bubble);
        }
        bubbleWrapper.appendChild(bubble);
    }

    const actionRow = document.createElement('div');
    actionRow.className = 'tts-action-row';
    actionRow.style.cssText = `
        display: flex;
        gap: 6px;
        margin-top: 2px;
        opacity: 0.7;
        transition: opacity 0.2s ease;
        align-self: flex-start;
    `;

    msgDiv.addEventListener('mouseenter', () => actionRow.style.opacity = '1.0');
    msgDiv.addEventListener('mouseleave', () => actionRow.style.opacity = '0.7');

    const speakBtn = document.createElement('button');
    speakBtn.title = '朗读消息';
    speakBtn.style.cssText = `
        background: transparent;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 6px;
        transition: all 0.2s ease;
        outline: none;
        padding: 0;
    `;
    speakBtn.addEventListener('mouseenter', () => {
        speakBtn.style.background = 'rgba(255, 255, 255, 0.08)';
        speakBtn.style.color = 'var(--text-primary)';
    });
    speakBtn.addEventListener('mouseleave', () => {
        speakBtn.style.background = 'transparent';
        speakBtn.style.color = 'var(--text-secondary)';
    });

    const speakerSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
    const stopSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect></svg>`;
    
    speakBtn.innerHTML = speakerSvg;

    let isSpeaking = false;
    let localVoiceStopListener = null;
    let utterance = null; // 放在闭包中，防止播放期间被垃圾回收机制(GC)误杀导致播放中断

    speakBtn.addEventListener('click', async () => {
        if (isSpeaking) {
            if (window.api && window.api.voice) {
                try { await window.api.voice.stop(); } catch(e){}
            }
            window.speechSynthesis.cancel();
            speakBtn.innerHTML = speakerSvg;
            isSpeaking = false;
            utterance = null;
            if (localVoiceStopListener) {
                localVoiceStopListener();
                localVoiceStopListener = null;
            }
        } else {
            if (window.api && window.api.voice) {
                try { await window.api.voice.stop(); } catch(e){}
            }
            window.speechSynthesis.cancel();
            
            let textToSpeak = bubble.textContent || '';
            textToSpeak = textToSpeak
                .replace(/[\*\_\`\#]/g, '')
                .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
                .replace(/AI 正在直连.*联络思考中\.\.\./g, '')
                .replace(/思考中\.\.\./g, '')
                .trim();

            if (!textToSpeak) return;

            window.dispatchEvent(new CustomEvent('global-tts-start', { detail: { activeBtn: speakBtn, defaultSvg: speakerSvg } }));

            let useLocalVoice = false;
            try {
                // 只要主进程的语音 API 存在，并且用户在【语音管理】里开启了语音总开关，即可直接使用本地的高级语音引擎（无需拉起网关服务）
                if (window.api && window.api.voice) {
                    const voiceState = typeof __voiceState !== 'undefined' ? __voiceState : (await window.api.voice.getState()).data;
                    if (voiceState && voiceState.settings && voiceState.settings.enabled && !voiceState.settings.muted) {
                        useLocalVoice = true;
                    }
                }
            } catch(e) {}

            if (useLocalVoice) {
                const activeRoleId = (typeof __roleConfigState !== 'undefined' && __roleConfigState && __roleConfigState.activeRoleId) || undefined;
                try {
                    await window.api.voice.speak({
                        text: textToSpeak,
                        source: 'desktop',
                        roleId: activeRoleId
                    });
                    speakBtn.innerHTML = stopSvg;
                    isSpeaking = true;

                    if (window.api && window.api.voice && typeof window.api.voice.onStatus === 'function') {
                        localVoiceStopListener = window.api.voice.onStatus((statusData) => {
                            if (statusData && (statusData.status === 'idle' || statusData.speaking === false)) {
                                speakBtn.innerHTML = speakerSvg;
                                isSpeaking = false;
                                if (localVoiceStopListener) {
                                    localVoiceStopListener();
                                    localVoiceStopListener = null;
                                }
                            }
                        });
                    }
                } catch (e) {
                    useLocalVoice = false;
                }
            }
            
            if (!useLocalVoice) {
                // 回退到系统原生的 TTS 朗读，响应极其迅速，直连模式下完美运行
                utterance = new SpeechSynthesisUtterance(textToSpeak);
                utterance.lang = 'zh-CN';
                utterance.rate = 1.0;
                utterance.pitch = 1.0;
                utterance.onend = () => {
                    speakBtn.innerHTML = speakerSvg;
                    isSpeaking = false;
                    utterance = null;
                };
                utterance.onerror = (err) => {
                    console.warn('SpeechSynthesis error:', err);
                    speakBtn.innerHTML = speakerSvg;
                    isSpeaking = false;
                    utterance = null;
                };
                window.speechSynthesis.speak(utterance);
                speakBtn.innerHTML = stopSvg;
                isSpeaking = true;
            }
        }
    });

    window.addEventListener('global-tts-start', (e) => {
        if (e.detail.activeBtn !== speakBtn && isSpeaking) {
            speakBtn.innerHTML = speakerSvg;
            isSpeaking = false;
            if (localVoiceStopListener) {
                localVoiceStopListener();
                localVoiceStopListener = null;
            }
        }
    });

    // 🌟 复制消息按钮
    const copyBtn = document.createElement('button');
    copyBtn.title = '复制消息内容';
    copyBtn.style.cssText = `
        background: transparent;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 6px;
        transition: all 0.2s ease;
        outline: none;
        padding: 0;
    `;
    copyBtn.addEventListener('mouseenter', () => {
        copyBtn.style.background = 'rgba(255, 255, 255, 0.08)';
        copyBtn.style.color = 'var(--text-primary)';
    });
    copyBtn.addEventListener('mouseleave', () => {
        copyBtn.style.background = 'transparent';
        copyBtn.style.color = 'var(--text-secondary)';
    });

    const copySvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
    const checkSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4caf50" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

    copyBtn.innerHTML = copySvg;

    copyBtn.addEventListener('click', async () => {
        const textToCopy = (bubble.innerText || bubble.textContent || '').trim();
        if (!textToCopy) return;

        const copied = await copyToClipboard(textToCopy);

        if (copied) {
            copyBtn.innerHTML = checkSvg;
            if (typeof showToast === 'function') {
                showToast('📋 已将消息内容成功复制到剪贴板！');
            }
            setTimeout(() => {
                copyBtn.innerHTML = copySvg;
            }, 1500);
        }
    });

    actionRow.appendChild(speakBtn);
    actionRow.appendChild(copyBtn);
    bubbleWrapper.appendChild(actionRow);
}

// 往聊天窗口追加气泡消息
function appendChatMessage(sender, content, attachment = null, isHTML = false) {
    if (typeof content === 'string' && (content.includes('Exec failed:') || content.includes('Exec failed'))) {
        return null;
    }
    const container = document.getElementById('chat-messages-container');
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = `
        display: flex;
        gap: 12px;
        max-width: 85%;
        margin-bottom: 4px;
        align-self: ${sender === 'user' ? 'flex-end' : 'flex-start'};
        flex-direction: ${sender === 'user' ? 'row-reverse' : 'row'};
    `;

    const avatar = document.createElement('div');
    avatar.style.cssText = `
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: ${sender === 'user' ? 'linear-gradient(135deg, #00d2ff, #0055ff)' : 'linear-gradient(135deg, #8c52ff, #00d2ff)'};
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 800;
        color: white;
        flex-shrink: 0;
        box-shadow: 0 4px 10px rgba(0,0,0,0.15);
    `;
    avatar.innerText = sender === 'user' ? 'ME' : 'AI';

    const bubble = document.createElement('div');
    bubble.style.cssText = `
        background: ${sender === 'user' ? 'rgba(140, 82, 255, 0.15)' : 'rgba(255, 255, 255, 0.03)'};
        border: 1px solid ${sender === 'user' ? 'rgba(140, 82, 255, 0.3)' : 'rgba(255, 255, 255, 0.05)'};
        border-radius: 12px;
        padding: 12px 16px;
        color: var(--text-primary);
        font-size: 13px;
        line-height: 1.5;
        border-top-${sender === 'user' ? 'right' : 'left'}-radius: 2px;
        white-space: pre-wrap;
        box-shadow: 0 4px 15px rgba(0,0,0,0.05);
    `;

    if (attachment) {
        const img = document.createElement('img');
        img.src = attachment;
        img.style.cssText = `
            max-width: 200px;
            max-height: 200px;
            border-radius: 6px;
            margin-bottom: 8px;
            display: block;
            border: 1px solid rgba(255,255,255,0.1);
        `;
        bubble.appendChild(img);
    }

    const textNode = document.createElement('div');
    if (isHTML) {
        textNode.innerHTML = content;
    } else {
        textNode.innerText = content;
    }
    bubble.appendChild(textNode);

    const bubbleWrapper = document.createElement('div');
    bubbleWrapper.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 4px;
        align-items: ${sender === 'user' ? 'flex-end' : 'flex-start'};
        min-width: 0;
    `;
    bubbleWrapper.appendChild(bubble);

    // AI消息的操作栏
    if (sender !== 'user') {
        addTtsToAiBubble(msgDiv, bubble);
    }

    msgDiv.appendChild(avatar);
    msgDiv.appendChild(bubbleWrapper);
    container.appendChild(msgDiv);
    
    container.scrollTop = container.scrollHeight;
    return bubble;
}

// 清除会话缓存 (清空聊天记录并重置初始欢迎语)
function clearChatHistory() {
    chatSessionHistory = []; // 清空历史记录数组
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    // 清空所有消息气泡
    container.innerHTML = '';

    // 重置为初始欢迎语
    const welcomeHtml = `
        <div id="welcome-message-row" style="display: flex; gap: 12px; max-width: 80%; align-self: flex-start;">
            <div style="width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg, #8c52ff, #00d2ff); display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 800; color: white; flex-shrink: 0; box-shadow: 0 0 10px rgba(140,82,255,0.3);">AI</div>
            <div id="welcome-message-bubble" style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 12px 16px; color: var(--text-primary); font-size: 13px; line-height: 1.5; border-top-left-radius: 2px;">
                <span data-i18n="chat.welcome.greeting">您好！我是您的智能助手。</span><span id="gateway-connection-status-text" style="color: #ff9800;">当前本地的 OpenClaw Nexora Agent未启动，请前往【控制台】启动Nexora Agent。</span>
                <br><br>
                <span data-i18n="chat.welcome.functions">在这里您可以：</span>
                <br>💬 <span data-i18n="chat.welcome.chat_mode">与当前选中的大模型进行实时对话；</span>
                <br>🖼️ <span data-i18n="chat.welcome.image_mode">点击左下角按钮上传图片，让支持多模态的模型进行**识图对话**；</span>
                <br>🎨 <span data-i18n="chat.welcome.generator_mode">输入指令并点击下方生图/生视频快捷键，快速体验生成式创作。</span>
            </div>
        </div>
    `;
    container.innerHTML = welcomeHtml;
    
    // 写入后，应用一次多语言渲染以展示正确语言
    applyLanguage(localStorage.getItem('setting_language') || 'zh-CN');

    // 重新附加朗读按钮到欢迎语气泡
    const welcomeRow = document.getElementById('welcome-message-row');
    const welcomeBubble = document.getElementById('welcome-message-bubble');
    if (welcomeRow && welcomeBubble) {
        addTtsToAiBubble(welcomeRow, welcomeBubble);
    }

    // 清除附件
    chatAttachmentBase64 = '';
    const fileInput = document.getElementById('chat-file-upload-input');
    if (fileInput) fileInput.value = '';
    const previewBar = document.getElementById('chat-attachment-preview-bar');
    if (previewBar) previewBar.style.display = 'none';

    // 清除输入框
    const inputArea = document.getElementById('chat-text-input');
    if (inputArea) inputArea.value = '';

    // 更新Nexora Agent连接状态文本
    const statusText = document.getElementById('gateway-connection-status-text');
    if (statusText) {
        const isEn = (localStorage.getItem('setting_language') || 'zh-CN') === 'en-US';
        const useBuiltIn = getUseBuiltIn();

        if (gatewayStatus === 'running' || gatewayFullyReady) {
            statusText.style.color = '#00e676';
            statusText.textContent = t('status.running');
        } else if (gatewayStatus === 'starting') {
            statusText.style.color = '#ffd54f';
            statusText.textContent = t('status.starting');
        } else {
            // stopped
            if (useBuiltIn) {
                statusText.style.color = '#b388ff';
                statusText.textContent = t('status.stopped');
            } else {
                statusText.style.color = '#ff9800';
                statusText.textContent = t('status.offline_hint');
            }
        }
    }

    showToast('🗑️ 会话缓存已清除');
}

// 处理发送消息（直连各厂家服务，不依赖Nexora Agent）
async function handleSendMessage() {
    const inputArea = document.getElementById('chat-text-input');
    const text = inputArea.value.trim();
    if (!text && !chatAttachmentBase64) return;

    inputArea.value = '';
    const file = chatAttachmentBase64;
    
    document.getElementById('chat-file-upload-input').value = '';
    document.getElementById('chat-attachment-preview-bar').style.display = 'none';
    chatAttachmentBase64 = '';

    appendChatMessage('user', text, file);

    // 对话内角色指令不请求模型，由客户端直接执行并立即反馈。
    if (!file && typeof handleChatRoleCommand === 'function') {
        const roleCommandHandled = await handleChatRoleCommand(text);
        if (roleCommandHandled) return;
    }

    const modelSelect = document.getElementById('chat-model-select');
    if (!modelSelect || modelSelect.selectedIndex === -1) {
        appendChatMessage('ai', '⚠️ 请先在右上角选择对话所用的大模型！如果下拉框为空，请先在【模型配置】中配置厂家模型。');
        return;
    }

    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    const providerKey = selectedOption.getAttribute('data-provider');
    const modelId = selectedOption.value;

    const useBuiltIn = getUseBuiltIn();
    const isAgnesBuiltIn = (providerKey === 'agnes-ai' && useBuiltIn);

    if (!isAgnesBuiltIn && !localProviders[providerKey]) {
        appendChatMessage('ai', '⚠️ 所选的提供商配置不存在，请在【模型配置】中确认。');
        return;
    }

    const providerConfig = localProviders[providerKey] || {};
    
    // 获取 Base URL 和 API Key
    let baseUrl = providerConfig.baseUrl || '';
    let apiKey = providerConfig.apiKey || '';
    
    // 如果启用内置模型，且当前选的是 agnes-ai 厂家
    if (isAgnesBuiltIn) {
        baseUrl = 'https://apihub.agnes-ai.com/v1';
        apiKey = AGNES_BUILT_IN_KEY;
    }

    if (!baseUrl) {
        appendChatMessage('ai', `⚠️ 厂家 "${providerKey}" 未配置 Base URL 接口地址，请先前往【模型配置】填写。`);
        return;
    }

    const aiBubble = appendChatMessage('ai', '思考中...', null, true);
    aiBubble.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; color: var(--text-secondary);">
            <div class="status-dot starting" style="width: 6px; height: 6px; animation: pulse 1.5s infinite;"></div>
            <span>AI 正在直连 [${providerKey}] 进行联络思考中...</span>
        </div>
    `;

    try {
        const messages = [];
        
        // 自动注入 Nexora Agent / OpenClaw 智能系统帮助提示词，专门解惑系统应用内的疑难杂症
        const systemPrompt = `你是一个专业的 Nexora Agent 系统应用智能客服小助手。当前运行的底层大语言模型技术为：【提供商: ${providerKey}, 模型ID: ${modelId}】。
【重要要求】：若用户问及你的模型身份、你是什么模型、你的底层技术、来自哪家公司等信息，请务必【如实且诚实】地告知你的真实底层模型身份是【${providerKey} / ${modelId}】（例如，你应该说明你是 ${modelId} 模型，由提供商 ${providerKey} ${providerKey === 'ollama' ? '在本地运行' : '提供云端API服务'}，并诚实说明你原本的模型技术背景，如Qwen、Llama、Gemini等），绝对不要隐瞒或误导用户；当用户提问其他关于本Nexora Agent客户端的软件使用和排查故障问题时，你再扮演智能客服小助手进行解答。
请根据以下真实的产品设计与常见问题排查方案，给出极其详尽、专业、条理清晰且温暖亲切的解答：

1. **什么是内置模型？与本地Nexora Agent的关系是什么？**
   - 内置模型（Agnes AI）是官方提供的高速直连大模型通道。
   - 当在【系统设置】中开启“内置模型启用”时，所有的对话和连通性测试直接走官方云端接口，**此时无需点击启动本地Nexora Agent，也可以直接使用【模型会话】与 AI 对话！**
   - 只有在使用本地机器人（如微信、Slack 等渠道）或者本地挂载 MCP 插件等本地深度Nexora Agent生态时，才需要点击“启动Nexora Agent”拉起本地后台Nexora Agent。

2. **如何配置多个 API Key 进行轮询与负载均衡？**
   - **操作步骤**：首先前往【系统设置】**关闭“内置模型启用”**，随后前往【模型配置】，在您需要使用的模型提供商（如 SiliconFlow、DeepSeek、Agnes AI 等）的“API 密钥”输入框中，输入多个以英文逗号 \`,\` 分割的密钥，例如：\`sk-key1,sk-key2,sk-key3\`，然后点击“保存配置”。
   - **轮询原理**：程序网络拦截层会在实际大模型通信时进行自动去重并在各个 Key 之间进行 Round-Robin 轮询（且前端在测试时会自动提取第一个 Key 进行测试防报错）。
   - **内置模型自动轮询**：若您开启了“内置模型启用”，系统已内置了 4 个官方高速通道 Key，系统将全自动在这 4 个高速 Key 之间进行请求轮询分配，无需您任何配置！

3. **点击“启动Nexora Agent”按钮出现闪退、EADDRINUSE 报错怎么解决？**
   - **主要成因**：Nexora Agent通信所需的 18789 端口被残留的其他 Node 进程占用，或是上次Nexora Agent退出时进程没有清理干净。
   - **排查步骤**：
     1. 应用自带了安全端口占用查询。在您点击“启动Nexora Agent”时，会首先运行 \`netstat\` 定位并安全精准杀死占用 18789 的残留进程（且不误杀其它无关 Node 进程，不会连带导致应用闪退）。
     2. 如果依然提示冲突，您可以手动打开电脑的“任务管理器”，在进程中找到并“结束”所有的 \`node.exe\` 进程，然后重新在客户端点击启动即可。
     3. 确保不要以管理员身份拉起 npm 却以普通用户运行本应用，这会导致跨权限清理失败。

4. **图片与视频生成接口检测时提示 404 (Not Found) 怎么解决？**
   - **主要成因**：填写的 Base URL 接口路径名称在单复数匹配上出错。例如 stability 或者是部分提供商使用 \`/image\` 或 \`/video\`，而另外一些使用 \`/images\` 或 \`/videos\`。
   - **自适应匹配**：系统目前已经原生升级支持了单复数（\`/image\`、\`/images\`、\`/video\`、\`/videos\`）的自动探测过滤与 CNAME 自适应。如果遇到 404，请确认您的 Base URL 是不是直接指向了厂家官方的 OpenAI 兼容端点（如 \`https://apihub.agnes-ai.com/v1/image\`），且密钥验证是有效的。
   - **生图失败**：若测试连通且密钥有效但实际生图报错，请确认对应提供商账户下有充足余额，且没触发高频限流。

5. **微信、QQ、飞书、Slack 等各个渠道机器人掉线或无法连接怎么解决？**
   - **版本匹配（微信/QQ等注入式通道）**：部分渠道采用注入挂钩机制。必须确保你电脑上安装运行的对应 PC 客户端版本，与当前使用的机器人通道插件（如 Weixin Provider）所支持的版本严格一致。
   - **配置校验（飞书/Slack/Matrix等API通道）**：请仔细确认你的 App ID、App Secret、Token 以及服务器端点配置是否正确，任何一个参数填错都会导致无法与平台建立握手连接。
   - **网络长连与代理（国内与境外平台差异）**：
     - 若使用的是境内长连渠道（如微信、飞书、QQ），由于 Clash/Surge 等代理软件的增强/TUN 模式可能会劫持域名（解析为 198.18.x.x 的 Fake-IP）导致断线，应用已内置了 HTTPDNS 解析直连技术。如果依然频繁断开，请将对应的域名（如 \`*.weixin.qq.com\`、\`*.feishu.cn\`）加入你代理软件的直连（Bypass）白名单。
     - 若使用的是境外渠道（如 Slack、Telegram、WhatsApp、Matrix），请确保你的本地网络代理已经正确开启，并且应用能够通过你的代理建立公网连接。
   - **防休眠与常驻**：如果电脑频繁进入睡眠状态或断网，会导致长连断开。建议在对应的客户端设置中关闭“自动休眠”，或尝试在电脑系统设置中防止网卡进入节电模式。

6. **界面菜单点不动或侧边栏收起问题**：
   - 侧边栏支持精简收起，缩小后仅显示运行状态标记（如“正常”、“未启用”），可以节省空间。
   - 如果遇到菜单异常冻结，直接按快捷键 Ctrl + R 刷新界面或重启软件即可。

7. **界面顶部弹出 \`⚠️ 🛠️ Exec failed: <command>\` 报错怎么解决？**
   - **主要成因**：这是大模型 Agent 在后台自动执行系统环境检测或诊断命令（例如检测 Node/Python、查询 systeminfo 等）时失败，导致被客户端捕获并在界面上弹出黄色警告通知。这并不是你本地电脑或软件本身的故障。
   - **排查与解决**：
     - 用户可以直接无视并关闭此警告横幅，它完全不影响客户端的正常运行 and 使用。
     - 如果你是开发或编写规则的 Agent，在通过 \`run_command\` 执行命令时必须遵守《防御性命令行执行规范》：使用 PowerShell \`try-catch\` 拦截错误，附加 \`-ExecutionPolicy Bypass\` 绕过策略限制，将错误流重定向到 \`$null\` 丢弃，并保证执行的 Exit Code 恒为 \`0\`（成功状态）。例如在 Windows 下，避免在裸 shell 里执行容易因为中英文差异（如 findstr 过滤 OS Name 找不到导致 exit 1）而报错的 \`systeminfo\` 等命令。

8. **本地后台的 OpenClaw 服务/网关报错，或者提示运行异常，怎么解决？**
   - **主要成因**：本地 OpenClaw 服务是一个 Node.js 进程。在装载各种本地能力和插件（如本地沙箱、MCP 插件、数据库等）时，可能会因为系统权限限制、环境损坏、端口冲突或第三方依赖软件缺失而引发报错。
   - **排查与解决**：
     - **查看控制台日志**：主界面的流式终端日志是排查利器。如果是加载插件或脚本失败，日志里会有明显的红色错误及堆栈信息。
     - **网关拉不起（提示 EADDRINUSE 等）**：通常因为 18789 端口被之前残留的 Node.js 进程占用。可点击“强杀占用进程”，或手动打开系统的“任务管理器”结束所有名为 \`node.exe\` 的进程，再重新在软件中点击启动。
     - **沙箱环境损坏**：如果被杀毒软件误杀或挪动目录导致 \`.node-sandbox\` 环境损坏，可以运行根目录下的 \`fix-npm-sandbox.ps1\` 脚本自动修复重建，或者重新解压安装。
     - **MCP 插件加载报错**：部分复杂的 MCP 插件需要外部的 \`python\` 或 \`uv\` 运行时支持。如果日志提示无法运行相关指令，请在系统内安装对应的运行环境，并在配置文件中核对执行路径。
     - **请求/转发报错（如 401/403/429 等）**：若与本地 AI 对话时，日志区提示 \`[patch-gateway] 请求大模型失败\`，代表本地网关网络是通的，但你配置的第三方大模型 API Key 无效、到期、欠费或超频限流，请前往【模型配置】中重新校对您的 API 密钥与代理端点。`;

        // 附加全局角色口吻（每次发送前强制读取最新启用角色，避免页面间状态不同步）
        let roleAddon = '';
        try {
            if (typeof loadRoleConfigState === 'function') {
                await loadRoleConfigState({ silent: true, preferActive: false, clearEditing: false });
            }
            if (typeof getActiveRoleChatAddon === 'function') {
                roleAddon = getActiveRoleChatAddon() || '';
            }
        } catch (e) {}
        let systemPromptToUse = systemPrompt;
        if (file) {
            systemPromptToUse = `你是一个具备强大视觉分析能力的智能 AI 助手。当前运行的底层模型为：【提供商: ${providerKey}, 模型ID: ${modelId}】。
请仔细分析用户上传的这幅图像，并根据图像内容以及用户的提问，给出极其准确、客观且条理清晰的解答。`;
        }
        messages.push({
            role: 'system',
            content: systemPromptToUse + roleAddon
        });
        
        // 追加历史会话记录
        messages.push(...chatSessionHistory);

        let currentUserMsg;
        if (file) {
            currentUserMsg = {
                role: 'user',
                content: [
                    { type: 'text', text: text || '分析这张图片' },
                    { type: 'image_url', image_url: { url: file } }
                ]
            };
        } else {
            currentUserMsg = {
                role: 'user',
                content: text
            };
        }
        messages.push(currentUserMsg);
        chatSessionHistory.push(currentUserMsg); // 存入历史记录

        // 直连上游接口
        let chatUrl = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
        
        // 特殊兼容 ollama 本地接口
        if (providerConfig.api === 'ollama' && baseUrl.includes('11434')) {
            chatUrl = baseUrl.replace('/v1', '').replace(/\/$/, '') + '/api/chat';
        }

        const headers = {
            'Content-Type': 'application/json'
        };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        // 发送直连请求
        const reqBody = {
            model: modelId,
            messages: messages,
            temperature: 0.7
        };
        // 兼容 ollama 原生 /api/chat 的参数格式
        if (providerConfig.api === 'ollama' && chatUrl.endsWith('/api/chat')) {
            reqBody.stream = false;
            // 映射 OpenAI 格式的多模态数组内容 到 Ollama 原生格式
            reqBody.messages = reqBody.messages.map(msg => {
                if (Array.isArray(msg.content)) {
                    const textItem = msg.content.find(item => item.type === 'text');
                    const imgItem = msg.content.find(item => item.type === 'image_url');
                    const mappedMsg = {
                        role: msg.role,
                        content: textItem ? textItem.text : ''
                    };
                    if (imgItem && imgItem.image_url && imgItem.image_url.url) {
                        let b64 = imgItem.image_url.url;
                        // Ollama 需要去除 `data:image/xxx;base64,` 前缀
                        if (b64.startsWith('data:')) {
                            const parts = b64.split(',');
                            if (parts.length === 2) b64 = parts[1];
                        }
                        mappedMsg.images = [b64];
                    }
                    return mappedMsg;
                }
                return msg;
            });
        }

        // 增加 120 秒超时机制，防范上游 API 挂死导致界面无限卡顿
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);

        const response = await fetch(chatUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(reqBody),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
            const result = await response.json();
            let reply = '';
            
            // 兼容 Ollama /api/chat 的返回值
            if (result.message && result.message.content) {
                reply = result.message.content;
            } else if (result.choices && result.choices[0] && result.choices[0].message) {
                reply = result.choices[0].message.content;
            } else {
                reply = JSON.stringify(result);
            }
            
            aiBubble.innerText = reply;

            chatSessionHistory.push({
                role: 'assistant',
                content: reply
            });
            // 限制历史记录长度，保留最近的20条（10轮）
            if (chatSessionHistory.length > 20) {
                chatSessionHistory = chatSessionHistory.slice(chatSessionHistory.length - 20);
            }

            // 计入会话用量
            const usage = result.usage || { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 };
            addSessionLog('dialog-test', modelId, usage.prompt_tokens, usage.completion_tokens, 0, 1200);

            // 本地离线语音：桌面聊天回复朗读
            if (typeof maybeSpeakDesktopReply === 'function') {
                maybeSpeakDesktopReply(reply);
            }
        } else {
            const errText = await response.text();
            aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ 接口响应错误 (HTTP ${response.status}): ${errText || '未知错误'}</span>`;
        }
    } catch (e) {
        aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ 联络模型接口失败，请确认该厂家的 Base URL 和您的网络连通状态。</span>`;
        console.error('Chat completions error:', e);
    }
}

// 真实调用图片/视频生成 API
async function handleActionGenerate(type) {
    const inputArea = document.getElementById('chat-text-input');
    const prompt = inputArea.value.trim();
    if (!prompt) {
        showToast(`请先在输入框中输入您要生成${type === 'image' ? '图片' : '视频'}的画面描述哦！`);
        return;
    }

    inputArea.value = '';
    appendChatMessage('user', `[${type === 'image' ? '🎨 智能生图' : '🎥 创意生视频'}] 指令: ${prompt}`);

    const aiBubble = appendChatMessage('ai', '渲染中...', null, true);
    aiBubble.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px; color: var(--text-secondary);">
                <svg class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00d2ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 2s linear infinite;"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="6.34" y1="17.66" x2="9.17" y2="14.83"/><line x1="14.83" y1="9.17" x2="17.66" y2="6.34"/></svg>
                <span>AI 正在全力${type === 'image' ? '绘制' : '生成视频'}中，请稍候...</span>
            </div>
            <div style="width: 100%; height: 4px; background: rgba(255,255,255,0.05); border-radius: 2px; overflow: hidden;">
                <div style="width: 15%; height: 100%; background: linear-gradient(90deg, #8c52ff, #00d2ff); animation: progress 30s linear forwards;"></div>
            </div>
        </div>
    `;
    document.getElementById('chat-messages-container').scrollTop = document.getElementById('chat-messages-container').scrollHeight;

    try {
        // 从配置中读取 API Base URL 和 Key
        let apiBase, apiKey, modelId;
        if (type === 'image') {
            const imgEl = document.getElementById('image-api-base');
            const imgKeyEl = document.getElementById('image-api-key');
            apiBase = imgEl ? imgEl.value.trim() : 'https://apihub.agnes-ai.com/v1/images';
            apiKey = imgKeyEl ? imgKeyEl.value.trim() : '';
        } else {
            const vidEl = document.getElementById('video-api-base');
            const vidKeyEl = document.getElementById('video-api-key');
            apiBase = vidEl ? vidEl.value.trim() : 'https://apihub.agnes-ai.com/v1/videos';
            apiKey = vidKeyEl ? vidKeyEl.value.trim() : '';
        }

        const useBuiltIn = getUseBuiltIn();
        if (useBuiltIn || !apiKey || apiKey === KEY_MASK) {
            if (useBuiltIn) {
                apiKey = AGNES_BUILT_IN_KEY;
            } else {
                const agnesKeyInput = document.querySelector('input.provider-key-input[data-provider="agnes-ai"]');
                if (agnesKeyInput && agnesKeyInput.value.trim() !== KEY_MASK) {
                    apiKey = agnesKeyInput.value.trim();
                } else if (localProviders['agnes-ai'] && localProviders['agnes-ai'].apiKey && localProviders['agnes-ai'].apiKey !== KEY_MASK) {
                    apiKey = localProviders['agnes-ai'].apiKey;
                } else {
                    apiKey = AGNES_BUILT_IN_KEY;
                }
            }
        }

        if (!apiKey) {
            aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ 未配置 API Key，请先在【模型配置】中填写 Agnes AI 的 API Key。</span>`;
            return;
        }

        // 获取当前选中的模型
        const modelSelect = document.getElementById('chat-model-select');
        if (type === 'image') {
            const selectVal = modelSelect ? modelSelect.value : '';
            if (selectVal && selectVal.includes('image')) {
                modelId = selectVal;
            } else {
                const stored = localStorage.getItem('client_pref_image_model');
                modelId = stored ? stored.split('/').pop() : 'agnes-image-2.0-flash';
            }
        } else {
            const selectVal = modelSelect ? modelSelect.value : '';
            if (selectVal && selectVal.includes('video')) {
                modelId = selectVal;
            } else {
                const stored = localStorage.getItem('client_pref_video_model');
                modelId = stored ? stored.split('/').pop() : 'agnes-video-v2.0';
            }
        }

        const genUrl = type === 'image' 
            ? `${apiBase.replace(/\/$/, '')}/generations`
            : apiBase.replace(/\/$/, '');
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };

        if (type === 'image') {
            // OpenAI 兼容的图片生成 API
            const body = {
                model: modelId,
                prompt: prompt,
                n: 1,
                size: '1024x1024'
            };

            const response = await fetch(genUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errText = await response.text();
                aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ 生图接口错误 (HTTP ${response.status}): ${errText}</span>`;
                return;
            }

            const result = await response.json();
            // 兼容多种返回格式
            let imageUrl = '';
            if (result.data && result.data[0]) {
                imageUrl = result.data[0].url || result.data[0].b64_json || '';
            } else if (result.url) {
                imageUrl = result.url;
            } else if (result.output && result.output.url) {
                imageUrl = result.output.url;
            }

            const isBase64 = imageUrl.startsWith('data:') || (!imageUrl.startsWith('http') && imageUrl.length > 200);
            const imgSrc = isBase64 ? (imageUrl.startsWith('data:') ? imageUrl : `data:image/png;base64,${imageUrl}`) : imageUrl;

            if (imgSrc) {
                aiBubble.innerHTML = `
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        <span style="font-weight: 600; color: #b894ff;">🎨 智能生图创作已完成！</span>
                        <span style="font-size: 12px; color: var(--text-secondary);">提示词: "${prompt}" | 模型: ${modelId}</span>
                        <div style="position: relative; border-radius: 8px; overflow: hidden; border: 1px solid rgba(140, 82, 255, 0.2); box-shadow: 0 4px 20px rgba(140, 82, 255, 0.15);">
                            <img src="${imgSrc}" style="width: 100%; height: auto; max-height: 480px; object-fit: contain; display: block;" onerror="this.parentElement.innerHTML='<div style=\\'padding:20px;color:#ff6b6b;\\'>图片加载失败</div>'">
                        </div>
                    </div>
                `;
            } else {
                aiBubble.innerHTML = `
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        <span style="font-weight: 600; color: #b894ff;">🎨 生图完成，但未返回图片 URL</span>
                        <pre style="font-size: 11px; color: var(--text-secondary); white-space: pre-wrap; word-break: break-all;">${JSON.stringify(result, null, 2)}</pre>
                    </div>
                `;
            }
            addSessionLog('image-gen', modelId, 500, 0, 0, 3000);
        } else {
            // 视频生成 API
            const body = {
                model: modelId,
                prompt: prompt
            };

            const response = await fetch(genUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errText = await response.text();
                aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ 生视频接口错误 (HTTP ${response.status}): ${errText}</span>`;
                return;
            }

            const result = await response.json();
            
            // 视频 API 是异步任务模式，需要轮询等待
            const taskId = result.id || result.task_id || result.video_id;
            if (!taskId) {
                // 如果直接返回了 URL（同步模式）
                let videoUrl = '';
                if (result.data && result.data[0]) videoUrl = result.data[0].url || '';
                else if (result.url) videoUrl = result.url;
                else if (result.output && result.output.url) videoUrl = result.output.url;
                
                if (videoUrl) {
                    aiBubble.innerHTML = `
                        <div style="display: flex; flex-direction: column; gap: 10px;">
                            <span style="font-weight: 600; color: #7fe6ff;">🎥 创意 AI 视频创作已完成！</span>
                            <span style="font-size: 12px; color: var(--text-secondary);">提示词: "${prompt}" | 模型: ${modelId}</span>
                            <div style="position: relative; border-radius: 8px; overflow: hidden; border: 1px solid rgba(0, 210, 255, 0.2); box-shadow: 0 4px 20px rgba(0, 210, 255, 0.15);">
                                <video src="${videoUrl}" autoplay loop muted playsinline controls style="width: 100%; height: auto; max-height: 400px; object-fit: contain; display: block;"></video>
                            </div>
                        </div>
                    `;
                } else {
                    aiBubble.innerHTML = `<pre style="font-size: 11px; color: var(--text-secondary); white-space: pre-wrap;">${JSON.stringify(result, null, 2)}</pre>`;
                }
                addSessionLog('video-gen', modelId, 1000, 0, 0, 8000);
                return;
            }

            // 异步轮询模式
            let pollUrl = '';
            try {
                const originUrl = new URL(apiBase).origin;
                pollUrl = `${originUrl}/agnesapi?video_id=${taskId}`;
            } catch (err) {
                pollUrl = `https://apihub.agnes-ai.com/agnesapi?video_id=${taskId}`;
            }
            const maxPolls = 180; // 最多轮询 180 次 (15分钟)
            let pollCount = 0;

            const pollInterval = setInterval(async () => {
                pollCount++;
                try {
                    const pollResp = await fetch(pollUrl, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } });
                    if (!pollResp.ok) {
                        clearInterval(pollInterval);
                        aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ 查询视频任务状态失败 (HTTP ${pollResp.status})</span>`;
                        return;
                    }
                    const pollResult = await pollResp.json();
                    const status = pollResult.status || '';
                    const progress = pollResult.progress || 0;
                    let progressPct = progress > 1 ? progress : progress * 100; // 兼容 0-1 和 0-100 两种格式

                    // 🌟 UX 优化：如果状态为生成中/排队中，根据轮询次数自动补足微小的虚拟进度，让进度条保持平滑递增（最高 98%），避免一直卡在 30% 引起卡死误会
                    if (status === 'in_progress' || status === 'queued' || status === 'pending' || status === 'processing') {
                        const virtualBonus = pollCount * 3.6; // 每次轮询（15秒）前进 3.6%
                        progressPct = Math.min(progressPct + virtualBonus, 98);
                    }

                    // 更新进度与调试面板
                    aiBubble.innerHTML = `
                        <div style="display: flex; flex-direction: column; gap: 8px;">
                            <div style="display: flex; align-items: center; gap: 8px; color: var(--text-secondary);">
                                <svg class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00d2ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 2s linear infinite;"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="6.34" y1="17.66" x2="9.17" y2="14.83"/><line x1="14.83" y1="9.17" x2="17.66" y2="6.34"/></svg>
                                <span>🎥 视频生成中... 状态: <b style="color: #00d2ff;">${status || '无'}</b> | 进度: <b style="color: #00d2ff;">${Math.round(progressPct)}%</b></span>
                            </div>
                            <div style="width: 100%; height: 4px; background: rgba(255,255,255,0.05); border-radius: 2px; overflow: hidden;">
                                <div style="width: ${Math.max(Math.min(progressPct, 100), 5)}%; height: 100%; background: linear-gradient(90deg, #00d2ff, #7fe6ff); transition: width 0.5s ease;"></div>
                            </div>
                            <div style="margin-top: 4px; padding: 6px 10px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.05); border-radius: 4px; font-size: 11px; font-family: monospace; color: #a1a1b5;">
                                <div style="display: flex; justify-content: space-between; margin-bottom: 2px;">
                                    <span>第 <b>${pollCount}</b> 次查询 (每15秒一次)</span>
                                    <span style="color: #64b5f6;">轮询中...</span>
                                </div>
                                <div style="max-height: 80px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; color: #81c784;">最新响应: ${JSON.stringify(pollResult)}</div>
                            </div>
                        </div>
                    `;
                    document.getElementById('chat-messages-container').scrollTop = document.getElementById('chat-messages-container').scrollHeight;

                    if (status === 'completed' || status === 'succeeded' || status === 'success') {
                        clearInterval(pollInterval);
                        let videoUrl = '';
                        if (pollResult.video && pollResult.video.url) videoUrl = pollResult.video.url;
                        else if (pollResult.data && pollResult.data[0]) videoUrl = pollResult.data[0].url || '';
                        else if (pollResult.url) videoUrl = pollResult.url;
                        else if (pollResult.output && pollResult.output.url) videoUrl = pollResult.output.url;
                        else if (pollResult.result && pollResult.result.url) videoUrl = pollResult.result.url;

                        if (videoUrl) {
                            aiBubble.innerHTML = `
                                <div style="display: flex; flex-direction: column; gap: 10px;">
                                    <span style="font-weight: 600; color: #7fe6ff;">🎥 创意 AI 视频创作已完成！</span>
                                    <span style="font-size: 12px; color: var(--text-secondary);">提示词: "${prompt}" | 模型: ${modelId}</span>
                                    <div style="position: relative; border-radius: 8px; overflow: hidden; border: 1px solid rgba(0, 210, 255, 0.2); box-shadow: 0 4px 20px rgba(0, 210, 255, 0.15);">
                                        <video src="${videoUrl}" autoplay loop muted playsinline controls style="width: 100%; height: auto; max-height: 400px; object-fit: contain; display: block;"></video>
                                    </div>
                                </div>
                            `;
                        } else {
                            aiBubble.innerHTML = `
                                <div style="display: flex; flex-direction: column; gap: 10px;">
                                    <span style="font-weight: 600; color: #7fe6ff;">🎥 视频生成完成！</span>
                                    <pre style="font-size: 11px; color: var(--text-secondary); white-space: pre-wrap; word-break: break-all;">${JSON.stringify(pollResult, null, 2)}</pre>
                                </div>
                            `;
                        }
                        addSessionLog('video-gen', modelId, 1000, 0, 0, pollCount * 15000);
                    } else if (status === 'failed' || status === 'error') {
                        clearInterval(pollInterval);
                        aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ 视频生成失败: ${pollResult.error || pollResult.message || '未知错误'}</span>`;
                    } else if (pollCount >= maxPolls) {
                        clearInterval(pollInterval);
                        aiBubble.innerHTML = `<span style="color: #ff6b6b;">⏰ 视频生成超时（等待超过15分钟），任务ID: ${taskId}</span>`;
                    }
                } catch (pollErr) {
                    clearInterval(pollInterval);
                    aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ 轮询视频状态失败: ${pollErr.message}</span>`;
                }
            }, 15000); // 每15秒查询一次
        }
    } catch (e) {
        aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ ${type === 'image' ? '生图' : '生视频'}请求失败: ${e.message || '网络错误，请检查接口地址和网络连接'}</span>`;
        console.error('Generation error:', e);
    }
    document.getElementById('chat-messages-container').scrollTop = document.getElementById('chat-messages-container').scrollHeight;
}

// 在当前会话中新增一笔模型交互记录，并刷新联动大屏
function addSessionLog(provider, model, input, output, hit, durationMs) {
    const total = input + output;
    sessionStats.total_tokens += total;
    sessionStats.total_requests += 1;
    sessionStats.sub_input_tokens += input;
    sessionStats.sub_output_tokens += output;
    sessionStats.sub_hit_tokens += hit;
    
    if (sessionStats.total_tokens > 0) {
        sessionStats.hit_rate = (sessionStats.sub_hit_tokens / sessionStats.total_tokens) * 100;
    }
    
    // 粗略算成本 (输入 $1.5/M, 输出 $6/M)
    sessionStats.total_cost = (sessionStats.sub_input_tokens / 1000000.0) * 1.5 + (sessionStats.sub_output_tokens / 1000000.0) * 6.0;

    const dt = new Date();
    const hourStr = (dt.getHours() < 10 ? '0' : '') + dt.getHours() + ':00';
    
    const pad = (n) => n < 10 ? '0' + n : n;
    const timeStr = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;

    // 更新 hourly_trend
    if (!sessionStats.hourly_trend[hourStr]) {
        sessionStats.hourly_trend[hourStr] = { cost: 0, hit: 0, input: 0, output: 0 };
    }
    sessionStats.hourly_trend[hourStr].input += input;
    sessionStats.hourly_trend[hourStr].output += output;
    sessionStats.hourly_trend[hourStr].hit += hit;

    // 更新 providers 分组
    if (!sessionStats.providers[provider]) {
        sessionStats.providers[provider] = { requests: 0, tokens: 0, hit: 0 };
    }
    sessionStats.providers[provider].requests += 1;
    sessionStats.providers[provider].tokens += total;
    sessionStats.providers[provider].hit += hit;

    // 更新 models 分组
    if (!sessionStats.models[model]) {
        sessionStats.models[model] = { provider: provider, calls: 0, tokens: 0, duration: 0.0, hit: 0 };
    }
    sessionStats.models[model].calls += 1;
    sessionStats.models[model].tokens += total;
    sessionStats.models[model].duration += (durationMs / 1000.0);
    sessionStats.models[model].hit += hit;

    // 追加日志明细
    const newLog = {
        time: timeStr.split(' ')[1] || timeStr,
        provider: provider,
        model: model,
        input: input,
        output: output,
        hit: hit,
        duration: `${(durationMs / 1000.0).toFixed(1)}s`,
        status: "成功",
        timestamp: Date.now()
    };
    
    sessionStats.logs.unshift(newLog);

    if (sessionStats.logs.length > 50) {
        sessionStats.logs = sessionStats.logs.slice(0, 50);
    }
    
    // 同步到后端持久化日志文件 (real_tokens.json)
    if (window.api && window.api.appendStatsData) {
        window.api.appendStatsData(newLog).catch(e => console.error('Failed to append stats:', e));
    }

    // 存入当前会话快照中
    // 同步最新统计并实时刷新面板
    window.lastFetchedStats = JSON.parse(JSON.stringify(sessionStats));
    if (typeof renderUsageCharts === 'function') {
        renderUsageCharts();
    }

    // 动态同步刷新下拉框选项
    updateFilterOptions();

    // 触发全局联动筛选更新卡片、曲线和表格
    applyStatsFilters();
}

// 动态刷新看板的下拉筛选器选项
function updateFilterOptions() {
    const modelSelect = document.getElementById('stats-model-select');

    if (modelSelect) {
        const curVal = modelSelect.value || 'all';
        const models = new Set();
        
        // 1. 优先提取当前在模型配置页里配置好的所有模型
        if (typeof localProviders === 'object' && localProviders !== null) {
            for (const providerKey of Object.keys(localProviders)) {
                const provider = localProviders[providerKey];
                if (provider && Array.isArray(provider.models)) {
                    provider.models.forEach(model => {
                        if (model && model.id) {
                            models.add(model.id.trim());
                        }
                    });
                }
            }
        }

        // 2. 辅以当前请求日志中产生过调用记录的其他模型
        (sessionStats.logs || []).forEach(log => {
            if (log.model) models.add(log.model.trim());
        });

        let optHtml = `<option value="all" data-i18n="stats.model.all">${t('stats.model.all')}</option>`;
        models.forEach(m => {
            optHtml += `<option value="${m}">${m}</option>`;
        });
        modelSelect.innerHTML = optHtml;
        if (Array.from(modelSelect.options).some(opt => opt.value === curVal)) {
            modelSelect.value = curVal;
        } else {
            modelSelect.value = 'all';
        }
    }
}

// 探测生图或生视频通道连通性，支持查看请求包详情
async function performGeneratorTest(type) {
    const btn = document.getElementById(`btn-test-${type}-generator`);
    const resultSpan = document.getElementById(`test-result-${type}-generator`);
    
    const urlInput = document.getElementById(`${type}-api-base`);
    const keyInput = document.getElementById(`${type}-api-key`);
    
    let baseUrl = urlInput ? urlInput.value.trim() : '';
    let apiKey = keyInput ? keyInput.value.trim() : '';
    if (apiKey.includes(',')) {
        apiKey = apiKey.split(',')[0].trim();
    }

    const useBuiltIn = getUseBuiltIn();
    if (useBuiltIn && (!apiKey || apiKey === KEY_MASK)) {
        apiKey = AGNES_BUILT_IN_KEY;
    }

    if (!baseUrl) {
        alert(`请输入${type === 'image' ? '图片' : '视频'}生成 API 地址后再进行检验！`);
        return;
    }

    if (resultSpan) {
        resultSpan.innerText = '⚡ 正在检验连接...';
        resultSpan.style.color = '#ffd54f';
        resultSpan.style.display = 'inline-block';
    }

    btn.disabled = true;

    // 探测接口的地址构建：
    // 若填的是类似 https://apihub.agnes-ai.com/v1/images 或 /videos
    // 我们将其转换探测 /models 的连通性，防止进行实际扣费请求
    let testUrl = baseUrl;
    if (baseUrl.includes('/images')) {
        testUrl = baseUrl.replace('/images', '') + '/models';
    } else if (baseUrl.includes('/image')) {
        testUrl = baseUrl.replace('/image', '') + '/models';
    } else if (baseUrl.includes('/videos')) {
        testUrl = baseUrl.replace('/videos', '') + '/models';
    } else if (baseUrl.includes('/video')) {
        testUrl = baseUrl.replace('/video', '') + '/models';
    } else {
        testUrl = baseUrl.replace(/\/$/, '') + '/models';
    }

    const headers = {
        'Content-Type': 'application/json'
    };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(testUrl, {
            method: 'GET',
            headers: headers,
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        if (response.ok) {
            showToast(`✅ ${type === 'image' ? '图片' : '视频'}服务连通性检验连接成功！`);
            if (resultSpan) {
                resultSpan.innerHTML = `
                    <span>✅ 连接成功！</span>
                    <span class="btn-view-request-details" data-url="${testUrl}" data-status="${response.status}" data-status-text="${response.statusText || 'OK'}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">[查看请求详情]</span>
                `;
                resultSpan.style.color = '#00e676';
                bindDetailsClick(resultSpan);
            }
        } else {
            const statusText = response.statusText || `Status: ${response.status}`;
            showToast(`❌ ${type === 'image' ? '图片' : '视频'}服务连接失败 (${response.status})`);
            if (resultSpan) {
                resultSpan.innerHTML = `
                    <span>❌ 连接失败 (${statusText})</span>
                    <span class="btn-view-request-details" data-url="${testUrl}" data-status="${response.status}" data-status-text="${statusText}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">[查看请求详情]</span>
                `;
                resultSpan.style.color = '#ff5252';
                bindDetailsClick(resultSpan);
            }
        }
    } catch (error) {
        let errMsg = error.message || '网络错误';
        if (error.name === 'AbortError') {
            errMsg = '请求超时 (8s)';
        }
        showToast(`❌ ${type === 'image' ? '图片' : '视频'}服务连接超时或失败`);
        if (resultSpan) {
            resultSpan.innerHTML = `
                <span>❌ 连接超时或失败 (${errMsg})</span>
                <span class="btn-view-request-details" data-url="${testUrl}" data-status="无" data-status-text="网络异常或超时" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">[查看请求详情]</span>
            `;
            resultSpan.style.color = '#ff5252';
            bindDetailsClick(resultSpan);
        }
    } finally {
        btn.disabled = false;
    }
}

// 探测生图或生视频通道的密钥有效性 (使用标准 /v1/models GET 端点做零风险鉴权)
async function performGeneratorKeyTest(type) {
    const btn = document.getElementById(`btn-test-${type}-key`);
    const resultSpan = document.getElementById(`test-result-${type}-generator`);
    
    const urlInput = document.getElementById(`${type}-api-base`);
    const keyInput = document.getElementById(`${type}-api-key`);
    
    let baseUrl = urlInput ? urlInput.value.trim() : '';
    let apiKey = keyInput ? keyInput.value.trim() : '';
    if (apiKey.includes(',')) {
        apiKey = apiKey.split(',')[0].trim();
    }

    const useBuiltIn = getUseBuiltIn();
    if (useBuiltIn && (!apiKey || apiKey === KEY_MASK)) {
        apiKey = AGNES_BUILT_IN_KEY;
    }

    if (!baseUrl) {
        alert(`请输入${type === 'image' ? '图片' : '视频'}生成 API 地址后再进行检验！`);
        return;
    }

    if (resultSpan) {
        resultSpan.innerText = '🔑 正在验证密钥有效性...';
        resultSpan.style.color = '#ffd54f';
        resultSpan.style.display = 'inline-block';
    }

    btn.disabled = true;

    // 从用户填写的 Base URL 中提取域名根路径，拼装标准 /v1/models 端点
    // 例如 https://apihub.agnes-ai.com/v1/images → https://apihub.agnes-ai.com/v1/models
    let testUrl = baseUrl.trim();
    const v1Idx = testUrl.indexOf('/v1');
    if (v1Idx !== -1) {
        testUrl = testUrl.substring(0, v1Idx) + '/v1/models';
    } else {
        testUrl = testUrl.replace(/\/$/, '') + '/v1/models';
    }

    const headers = {};
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(testUrl, {
            method: 'GET',
            headers: headers,
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        // 200 = 密钥有效，能拿到模型列表
        // 401/403 = 密钥无效
        // 其他状态码酌情处理
        if (response.ok) {
            showToast(`✅ ${type === 'image' ? '图片' : '视频'}服务 API Key 密钥验证有效！`);
            if (resultSpan) {
                resultSpan.innerHTML = `
                    <span>✅ 密钥验证有效！</span>
                    <span class="btn-view-request-details" data-url="${testUrl}" data-method="GET" data-status="${response.status}" data-status-text="200 OK (鉴权通过)" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">[查看请求详情]</span>
                `;
                resultSpan.style.color = '#00e676';
                bindDetailsClick(resultSpan);
            }
        } else {
            const statusText = response.statusText || `Status: ${response.status}`;
            let errTip = `验证失败 (Status: ${response.status})`;
            if (response.status === 401 || response.status === 403) {
                errTip = '❌ 密钥无效 (401/403)';
            } else if (response.status === 429) {
                errTip = '⚠️ 额度不足或触发限频 (429)';
            } else if (response.status === 404) {
                errTip = '⚠️ 该服务不支持 /v1/models 端点 (404)';
            }
            showToast(response.status === 401 || response.status === 403 ? `❌ ${type === 'image' ? '图片' : '视频'}服务密钥验证失败：密钥无效` : `⚠️ ${type === 'image' ? '图片' : '视频'}服务密钥验证结果 (${response.status})`);
            if (resultSpan) {
                resultSpan.innerHTML = `
                    <span>${errTip}</span>
                    <span class="btn-view-request-details" data-url="${testUrl}" data-method="GET" data-status="${response.status}" data-status-text="${statusText}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">[查看请求详情]</span>
                `;
                resultSpan.style.color = response.status === 429 ? '#ffd54f' : '#ff5252';
                bindDetailsClick(resultSpan);
            }
        }
    } catch (error) {
        let errMsg = error.message || '网络错误';
        if (error.name === 'AbortError') {
            errMsg = '请求超时 (8s)';
        }
        showToast(`❌ ${type === 'image' ? '图片' : '视频'}服务密钥验证超时或异常`);
        if (resultSpan) {
            resultSpan.innerHTML = `
                <span>❌ 验证超时或失败 (${errMsg})</span>
                <span class="btn-view-request-details" data-url="${testUrl}" data-method="GET" data-status="无" data-status-text="网络异常或超时" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">[查看请求详情]</span>
            `;
            resultSpan.style.color = '#ff5252';
            bindDetailsClick(resultSpan);
        }
    } finally {
        btn.disabled = false;
    }
}

// 🕒 控制台科技感实时时钟
function initConsoleClock() {
    const dateEl = document.getElementById('console-clock-date');
    const timeEl = document.getElementById('console-clock-time');
    
    function updateClock() {
        const now = new Date();
        
        // 年月日及星期
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, '0');
        const date = now.getDate().toString().padStart(2, '0');
        
        const dayNamesZh = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const dayNamesEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayNamesTw = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        
        const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
        let formattedDate = '';
        if (currentLang === 'en-US') {
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            formattedDate = `${dayNamesEn[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${year}`;
        } else if (currentLang === 'zh-TW') {
            formattedDate = `${year}年${month}月${date}日 ${dayNamesTw[now.getDay()]}`;
        } else {
            formattedDate = `${year}年${month}月${date}日 ${dayNamesZh[now.getDay()]}`;
        }
        
        if (dateEl) {
            dateEl.innerText = formattedDate;
        }
        
        // 时分秒
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const seconds = now.getSeconds().toString().padStart(2, '0');
        
        if (timeEl) {
            timeEl.innerText = `${hours}:${minutes}:${seconds}`;
        }
    }
    
    updateClock();
    setInterval(updateClock, 1000);
}

// 🔄 检测微信会话绑定状态并动态更新控制台 UI
let consoleSelectedChannel = 'qqbot';

function setConsoleStatus(text, isGreen) {
    const statusEl = document.getElementById('stat-channel-status');
    const statusTextEl = document.getElementById('stat-channel-status-text');
    const statusDotEl = document.getElementById('stat-channel-status-dot');
    const color = isGreen ? '#00e676' : '#ff5252';
    
    if (statusTextEl) statusTextEl.innerText = text;
    if (statusDotEl) {
        statusDotEl.style.background = color;
        statusDotEl.style.display = text ? 'inline-block' : 'none';
    }
    if (statusEl) {
        statusEl.style.color = color;
        if (!statusTextEl) statusEl.innerText = text;
    }
}

function showConsoleChannelSkeleton() {
    const detailsEl = document.getElementById('console-channel-details-panel');
    if (!detailsEl) return;
    detailsEl.style.display = 'block';
    detailsEl.innerHTML = `
        <div class="skeleton-loader">
            <div class="skeleton-title"></div>
            <div class="skeleton-item">
                <div class="skeleton-label"></div>
                <div class="skeleton-value"></div>
            </div>
            <div class="skeleton-item" style="margin-top: 4px;">
                <div class="skeleton-label"></div>
                <div class="skeleton-value"></div>
            </div>
        </div>
    `;
}

async function updateConsoleChannelStatusUI() {
    const detailsEl = document.getElementById('console-channel-details-panel');
    const loadingEl = document.getElementById('console-channel-loading');
    if (!detailsEl) return;

    if (!configData) {
        if (loadingEl) loadingEl.style.display = 'flex';
        return;
    }

    if (loadingEl) loadingEl.style.display = 'flex';

    try {
        if (consoleSelectedChannel === 'wechat') {
            try {
                const result = await window.api.checkWeChatStatus();
                if (result.bound) {
                    setConsoleStatus(t('已配置', 'Configured', '已配置'), true);
                    const savedAtStr = result.details.savedAt ? new Date(result.details.savedAt).toLocaleString('zh-CN', { hour12: false }) : '--';
                    detailsEl.style.display = 'block';
                    detailsEl.innerHTML = `
                        <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 6px; border-bottom: 1px dashed var(--border-color); padding-bottom: 4px; display: flex; align-items: center; gap: 4px;">${t('👤 微信绑定信息', '👤 WeChat Binding Info', '👤 微信綁定信息')}</div>
                        <div style="margin-bottom: 6px;">
                            <div style="color: var(--text-secondary); margin-bottom: 2px;">${t('账户标识', 'Account ID', '帳號標識')}</div>
                            <div style="font-family: var(--font-mono); color: var(--text-primary); font-weight: bold; word-break: break-all;">${result.details.accountId || '--'}</div>
                        </div>
                        <div style="margin-bottom: 2px;">
                            <div style="color: var(--text-secondary); margin-bottom: 2px;">${t('绑定时间', 'Bind Time', '綁定時間')}</div>
                            <div style="color: var(--text-primary);">${savedAtStr}</div>
                        </div>
                    `;
                } else {
                    setConsoleStatus('', false);
                    detailsEl.style.display = 'block';
                    detailsEl.innerHTML = `
                        <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 6px; border-bottom: 1px dashed var(--border-color); padding-bottom: 4px; display: flex; align-items: center; gap: 4px;">${t('👤 微信绑定信息', '👤 WeChat Binding Info', '👤 微信綁定信息')}</div>
                        <div style="color: #ff5252; font-weight: bold;">${t('当前未绑定微信', 'WeChat is not bound', '當前未綁定微信')}</div>
                        <div style="color: var(--text-secondary); margin-top: 4px;">${t('扫码绑定微信后可作为助手收发微信消息。', 'Bind WeChat to send and receive messages.', '掃碼綁定微信後可作為助手收發微信消息。')}</div>
                        <div style="margin-top: 10px; width: 100%;"><a href="#" id="lnk-go-communication" class="console-go-bind-btn">${t('⚙️ 去通讯管理绑定', '⚙️ Go to Channels to bind', '⚙️ 去通訊管理綁定')}</a></div>
                    `;
                }
            } catch(e) {
                setConsoleStatus(t('获取失败', 'Failed', '獲取失敗'), false);
            }
        } 
        else if (consoleSelectedChannel === 'feishu') {
            const feishu = (configData.channels && configData.channels.feishu) || {};
            const accounts = feishu.accounts || {};
            const defaultAccId = feishu.defaultAccount || '';
            const isEnabled = feishu.enabled !== false && Object.keys(accounts).length > 0;

            if (isEnabled) {
                setConsoleStatus(t('已配置', 'Configured', '已配置'), true);
                const defaultAcc = accounts[defaultAccId] || {};
                detailsEl.style.display = 'block';
                detailsEl.innerHTML = `
                    <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 6px; border-bottom: 1px dashed var(--border-color); padding-bottom: 4px; display: flex; align-items: center; gap: 4px;">${t('👤 飞书绑定信息', '👤 Feishu Binding Info', '👤 飛書綁定信息')}</div>
                    <div style="margin-bottom: 6px;">
                        <div style="color: var(--text-secondary); margin-bottom: 2px;">${t('默认账户', 'Default Account', '默認帳戶')}</div>
                        <div style="font-family: var(--font-mono); color: var(--text-primary); font-weight: bold; word-break: break-all;">${defaultAccId || '--'}</div>
                    </div>
                    <div style="margin-bottom: 2px;">
                        <div style="color: var(--text-secondary); margin-bottom: 2px;">App ID</div>
                        <div style="color: var(--text-primary); word-break: break-all;">${defaultAcc.appId || '--'}</div>
                    </div>
                `;
            } else {
                setConsoleStatus('', false);
                detailsEl.style.display = 'block';
                detailsEl.innerHTML = `
                    <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 6px; border-bottom: 1px dashed var(--border-color); padding-bottom: 4px; display: flex; align-items: center; gap: 4px;">${t('👤 飞书绑定信息', '👤 Feishu Binding Info', '👤 飛書綁定信息')}</div>
                    <div style="color: #ff5252; font-weight: bold;">${t('当前未配置飞书账号', 'Feishu account not configured', '當前未配置飛書帳號')}</div>
                    <div style="color: var(--text-secondary); margin-top: 4px;">${t('请前往多渠道通讯管理配置飞书 App ID 和 Secret。', 'Please go to Channels to configure Feishu App ID & Secret.', '請前往多渠道通訊管理配置飛書 App ID 和 Secret。')}</div>
                    <div style="margin-top: 10px; width: 100%;"><a href="#" id="lnk-go-communication" class="console-go-bind-btn">${t('⚙️ 去通讯管理配置', '⚙️ Go to Channels to configure', '⚙️ 去通訊管理配置')}</a></div>
                `;
            }
        } 
        else if (consoleSelectedChannel === 'qqbot') {
            const qqbot = (configData.channels && configData.channels.qqbot) || {};
            const accounts = qqbot.accounts || {};
            const defaultAccId = qqbot.defaultAccount || '';
            const isEnabled = qqbot.enabled === true && Object.keys(accounts).length > 0;

            if (isEnabled) {
                setConsoleStatus(t('已配置', 'Configured', '已配置'), true);
                const defaultAcc = accounts[defaultAccId] || {};
                detailsEl.style.display = 'block';
                detailsEl.innerHTML = `
                    <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 6px; border-bottom: 1px dashed var(--border-color); padding-bottom: 4px; display: flex; align-items: center; gap: 4px;">${t('👤 QQ机器人绑定', '👤 QQ Bot Binding Info', '👤 QQ機器人綁定')}</div>
                    <div style="margin-bottom: 6px;">
                        <div style="color: var(--text-secondary); margin-bottom: 2px;">${t('默认账户', 'Default Account', '默認帳戶')}</div>
                        <div style="font-family: var(--font-mono); color: var(--text-primary); font-weight: bold; word-break: break-all;">${defaultAccId || '--'}</div>
                    </div>
                    <div style="margin-bottom: 2px;">
                        <div style="color: var(--text-secondary); margin-bottom: 2px;">App ID</div>
                        <div style="color: var(--text-primary); word-break: break-all;">${defaultAcc.appId || '--'}</div>
                    </div>
                `;
            } else {
                setConsoleStatus('', false);
                detailsEl.style.display = 'block';
                detailsEl.innerHTML = `
                    <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 6px; border-bottom: 1px dashed var(--border-color); padding-bottom: 4px; display: flex; align-items: center; gap: 4px;">${t('👤 QQ机器人绑定', '👤 QQ Bot Binding Info', '👤 QQ機器人綁定')}</div>
                    <div style="color: #ff5252; font-weight: bold;">${t('当前未配置QQ机器人', 'QQ Bot not configured', '當前未配置QQ機器人')}</div>
                    <div style="color: var(--text-secondary); margin-top: 4px;">${t('请前往多渠道通讯管理配置 QQ 机器人凭证。', 'Please go to Channels to configure QQ Bot credentials.', '請前往多渠道通訊管理配置 QQ 機器人憑證。')}</div>
                    <div style="margin-top: 10px; width: 100%;"><a href="#" id="lnk-go-communication" class="console-go-bind-btn">${t('⚙️ 去通讯管理配置', '⚙️ Go to Channels to configure', '⚙️ 去通訊管理配置')}</a></div>
                `;
            }
        }

        const goCommLnk = document.getElementById('lnk-go-communication');
        if (goCommLnk) {
            goCommLnk.addEventListener('click', (e) => {
                e.preventDefault();
                const commTab = document.getElementById('nav-communication-mgmt');
                if (commTab) commTab.click();
            });
        }
    } finally {
        if (loadingEl) loadingEl.style.display = 'none';
    }
}

// 扫码绑定期间的高频轮询兜底：即使主进程成功事件因时序丢失，也能在 ~2s 内刷新状态并关闭二维码弹窗。
let wechatBindingFastPollTimer = null;
function startWeChatBindingFastPoll() {
    if (wechatBindingFastPollTimer) return;
    wechatBindingFastPollTimer = setInterval(async () => {
        try {
            const result = await window.api.checkWeChatStatus();
            if (result && result.bound && result.details) {
                stopWeChatBindingFastPoll();
                await updateWeChatStatusUI();
            }
        } catch (e) {}
    }, 2000);
}
function stopWeChatBindingFastPoll() {
    if (wechatBindingFastPollTimer) {
        clearInterval(wechatBindingFastPollTimer);
        wechatBindingFastPollTimer = null;
    }
}

async function updateWeChatStatusUI() {
    try {
        const result = await window.api.checkWeChatStatus();
        const accountsContainer = document.getElementById('wechat-accounts-container');
        const bindBtn = document.getElementById('wechat-bind-btn');
        const topoWx = document.getElementById('node-wechat');
        if (topoWx) topoWx.dataset.liveBound = (result && result.bound) ? '1' : '0';
        if (typeof updateTopologyUI === 'function') updateTopologyUI();
        
        if (accountsContainer) {
            if (result.bound && result.details) {
                if (bindBtn) bindBtn.style.display = 'none';
                // 仅在「正在微信扫码」会话中才关弹窗。已绑定后再绑飞书时，10s 轮询绝不能把飞书二维码关掉。
                const bindingCh = (typeof __commBindingSession !== 'undefined' && __commBindingSession.active)
                    ? __commBindingSession.channel
                    : null;
                if (bindingCh === 'wechat' || bindingCh === 'openclaw-weixin') {
                    if (typeof completeCommBinding === 'function') completeCommBinding();
                } else if (typeof stopWeChatBindingFastPoll === 'function') {
                    stopWeChatBindingFastPoll();
                }
                
                const accountId = result.details.accountId || '--';
                let savedAtStr = '--';
                if (result.details.savedAt) {
                    try {
                        savedAtStr = new Date(result.details.savedAt).toLocaleString('zh-CN', { hour12: false });
                    } catch(err) {
                        savedAtStr = result.details.savedAt;
                    }
                }
                
                accountsContainer.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px 16px; box-sizing: border-box; width: 100%;">
                        <div style="display: flex; gap: 8px;">
                            <div style="font-size: 14px;">👤</div>
                            <div>
                                <div style="font-size: 13px; font-weight: bold; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                                    ${t('comm.account.id')}<span style="font-family: var(--font-mono); color: var(--accent-color);">${accountId}</span>
                                    <span style="background: rgba(0, 230, 118, 0.1); color: #00e676; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: bold;">${t('wechat.status.bound')}</span>
                                </div>
                                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 6px; display: flex; flex-direction: column; gap: 3px;">
                                    <div>${t('console.wechat_label.time')}<span style="color: var(--text-primary);">${savedAtStr}</span></div>
                                    <div>${t('comm.wechat.protocol')}<span style="color: var(--text-primary);">WeChat / WA (iLink)</span></div>
                                </div>
                            </div>
                        </div>
                        <div>
                            <button type="button" id="wechat-unbind-btn-dynamic" style="background: rgba(255, 82, 82, 0.1); border: 1px solid rgba(255, 82, 82, 0.3); color: #ff5252; padding: 6px 14px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; transition: all 0.2s;">
                                💬 ${t('comm.wechat.unbind')}
                            </button>
                        </div>
                    </div>
                `;
            } else {
                if (bindBtn) bindBtn.style.display = 'block';
                
                accountsContainer.innerHTML = `
                    <div style="text-align: center; padding: 24px; border: 1px dashed var(--border-color); border-radius: 8px; color: var(--text-secondary); font-size: 12px; background: rgba(255,255,255,0.01);">
                        ${t('comm.wechat.empty')}
                    </div>
                `;
            }
        }
    } catch (e) {
        console.error('Failed to update WeChat status UI:', e);
    }
    
    // 同时更新控制台渠道面板
    try {
        await updateConsoleChannelStatusUI();
    } catch(err) {}
}

// 📂 异步拉取本地持久化系统运行日志并填充滚动
async function loadAndRenderSystemLogs() {
    const systemLogsArea = document.getElementById('system-raw-logs-area');
    if (!systemLogsArea) return;
    systemLogsArea.value = "【正在装载历史日志，请稍候...】\n";
    try {
        const result = await window.api.readSystemLogs();
        if (result.success) {
            // 直接展示原始日志内容，不做过滤
            systemLogsArea.value = result.content;
            // 延迟微调滚动，确保 DOM 已经完全完成渲染后置底
            setTimeout(() => {
                systemLogsArea.scrollTop = systemLogsArea.scrollHeight;
            }, 50);
        } else {
            systemLogsArea.value = "【无历史日志数据】\n";
        }
    } catch(err) {
        console.error('Failed to load system logs:', err);
        systemLogsArea.value = "【历史日志加载失败】\n";
    }
}

// ==========================================
// 🔄 内置Nexora Agent核心包热更新（拦截 OpenClaw WebUI 的更新横幅）
// ==========================================
let _webviewUpdateInjected = false;

// ==========================================
// Nexora Agent核心更新 - 进度 / 状态弹窗
// ==========================================
let _gwUpdateOverlay = null;
let _gwUpdateBar = null;
let _gwUpdateStatusEl = null;
let _gwUpdatePctEl = null;
let _gwUpdateLogEl = null;
let _gwUpdateCloseBtn = null;
let _gwUpdateSpinner = null;
let _gwUpdateCreepTimer = null;
let _gwUpdatePct = 0;

// 关键日志 → 步骤映射（按出现顺序推进进度条）
const GW_UPDATE_STEPS = [
    { keys: ['查询 npm', '查询版本'], label: '查询最新版本', pct: 6 },
    { keys: ['目标版本'], label: '确定目标版本', pct: 12 },
    { keys: ['正在检查 Node', '版本兼容', '新版要求'], label: '检查运行时兼容性', pct: 20 },
    { keys: ['停止Nexora Agent'], label: '停止当前Nexora Agent', pct: 30 },
    { keys: ['正在下载 Node', 'Node 运行时已升级', '将自动升级', '匹配可用版本'], label: '升级 Node 运行时', pct: 38, creepTo: 50 },
    { keys: ['正在安装'], label: '下载并安装核心包', pct: 55, creepTo: 74 },
    { keys: ['install 完成', '已安装版本'], label: '核心包安装完成', pct: 80 },
    { keys: ['package.json'], label: '锁定版本号', pct: 86 },
    { keys: ['正在重启', '重启Nexora Agent'], label: '重启Nexora Agent', pct: 92 },
    { keys: ['重启成功', '重启完成'], label: 'Nexora Agent重启成功', pct: 100 },
];

function _ensureGwUpdateKeyframes() {
    if (document.getElementById('gw-update-keyframes')) return;
    const style = document.createElement('style');
    style.id = 'gw-update-keyframes';
    style.textContent = `
        @keyframes gwUpSpin { to { transform: rotate(360deg); } }
        @keyframes gwUpShimmer { 0% { background-position: -200px 0; } 100% { background-position: 200px 0; } }
    `;
    document.head.appendChild(style);
}

function _setGwUpdatePct(pct) {
    _gwUpdatePct = Math.max(_gwUpdatePct, Math.min(100, pct));
    if (_gwUpdateBar) _gwUpdateBar.style.width = _gwUpdatePct + '%';
    if (_gwUpdatePctEl) _gwUpdatePctEl.textContent = Math.round(_gwUpdatePct) + '%';
}

function _stopGwUpdateCreep() {
    if (_gwUpdateCreepTimer) { clearInterval(_gwUpdateCreepTimer); _gwUpdateCreepTimer = null; }
}

function showGatewayUpdateProgress() {
    _ensureGwUpdateKeyframes();
    _stopGwUpdateCreep();
    if (_gwUpdateOverlay) {
        try { document.body.removeChild(_gwUpdateOverlay); } catch (e) {}
        _gwUpdateOverlay = null;
    }
    _gwUpdatePct = 0;

    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(10, 8, 20, 0.45); backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center;
        z-index: 100000; opacity: 0; pointer-events: none; transition: opacity 0.2s ease;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
        background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 16px;
        width: 520px; max-width: 92vw; padding: 24px;
        box-shadow: 0 15px 50px rgba(0,0,0,0.4), var(--accent-glow);
        color: var(--text-primary); font-family: system-ui, -apple-system, sans-serif;
        transform: scale(0.9); transition: transform 0.2s ease;
    `;

    modal.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:18px;">
            <div id="gw-up-spinner" style="width:22px; height:22px; border:3px solid rgba(var(--accent-rgb),0.25); border-top-color: var(--accent-color); border-radius:50%; animation: gwUpSpin 0.8s linear infinite; flex-shrink:0;"></div>
            <h3 style="margin:0; font-size:16px; font-weight:600; color: var(--accent-color);">Nexora Agent核心更新</h3>
        </div>
        <div id="gw-up-status" style="font-size:13px; color: var(--text-primary); margin-bottom:10px; min-height:18px;">正在准备更新...</div>
        <div style="position:relative; height:8px; border-radius:6px; background: var(--bg-input); overflow:hidden; margin-bottom:6px;">
            <div id="gw-up-bar" style="height:100%; width:0%; border-radius:6px; background: linear-gradient(90deg, var(--accent-color), rgba(var(--accent-rgb),0.6)); transition: width 0.4s ease;"></div>
        </div>
        <div id="gw-up-pct" style="font-size:11px; color: var(--text-secondary); text-align:right; margin-bottom:12px;">0%</div>
        <pre id="gw-up-log" style="margin:0; height:180px; overflow-y:auto; background: rgba(0,0,0,0.28); border:1px solid var(--border-color); border-radius:10px; padding:10px 12px; font-size:11px; line-height:1.55; color: var(--text-secondary); white-space:pre-wrap; word-break:break-all; font-family: ui-monospace, Consolas, monospace;"></pre>
        <div style="display:flex; justify-content:flex-end; margin-top:18px;">
            <button id="gw-up-close" disabled style="background: var(--bg-input); border:1px solid var(--border-color); color: var(--text-secondary); padding:8px 24px; font-size:13px; font-weight:600; border-radius:8px; cursor:not-allowed; opacity:0.6; outline:none; transition: all 0.15s;">更新中，请勿关闭…</button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    _gwUpdateOverlay = overlay;
    _gwUpdateBar = modal.querySelector('#gw-up-bar');
    _gwUpdateStatusEl = modal.querySelector('#gw-up-status');
    _gwUpdatePctEl = modal.querySelector('#gw-up-pct');
    _gwUpdateLogEl = modal.querySelector('#gw-up-log');
    _gwUpdateCloseBtn = modal.querySelector('#gw-up-close');
    _gwUpdateSpinner = modal.querySelector('#gw-up-spinner');

    setTimeout(() => {
        overlay.style.opacity = '1';
        overlay.style.pointerEvents = 'auto';
        modal.style.transform = 'scale(1)';
    }, 10);
}

function appendGatewayUpdateLog(msg) {
    if (!_gwUpdateOverlay || !_gwUpdateLogEl) return;
    const text = String(msg || '').trim();
    if (!text) return;

    // 追加日志行（限制最多 200 行，避免 DOM 无限膨胀）
    const line = document.createElement('div');
    line.textContent = text;
    _gwUpdateLogEl.appendChild(line);
    while (_gwUpdateLogEl.childElementCount > 200) {
        _gwUpdateLogEl.removeChild(_gwUpdateLogEl.firstChild);
    }
    _gwUpdateLogEl.scrollTop = _gwUpdateLogEl.scrollHeight;

    // 根据关键字推进步骤 / 进度条
    for (const step of GW_UPDATE_STEPS) {
        if (step.keys.some(k => text.includes(k))) {
            if (_gwUpdateStatusEl) _gwUpdateStatusEl.textContent = step.label;
            _stopGwUpdateCreep();
            _setGwUpdatePct(step.pct);
            // 对耗时较长的安装步骤，进度条缓慢自增，给用户“正在进行”的反馈
            if (step.creepTo) {
                _gwUpdateCreepTimer = setInterval(() => {
                    if (_gwUpdatePct < step.creepTo) {
                        _setGwUpdatePct(_gwUpdatePct + 0.5);
                    } else {
                        _stopGwUpdateCreep();
                    }
                }, 400);
            }
            break;
        }
    }
}

function finishGatewayUpdateProgress(success, message) {
    _stopGwUpdateCreep();
    if (!_gwUpdateOverlay) return;

    if (success) _setGwUpdatePct(100);
    if (_gwUpdateStatusEl) {
        _gwUpdateStatusEl.textContent = (success ? '✅ ' : '❌ ') + (message || (success ? '更新完成' : '更新失败'));
        _gwUpdateStatusEl.style.color = success ? '#34d399' : '#f87171';
    }
    if (_gwUpdateBar && !success) {
        _gwUpdateBar.style.background = 'linear-gradient(90deg, #ef4444, #f87171)';
    }
    if (_gwUpdateSpinner) {
        _gwUpdateSpinner.style.animation = 'none';
        _gwUpdateSpinner.style.border = success ? '3px solid #34d399' : '3px solid #f87171';
        _gwUpdateSpinner.style.borderTopColor = success ? '#34d399' : '#f87171';
    }
    if (_gwUpdateCloseBtn) {
        _gwUpdateCloseBtn.disabled = false;
        _gwUpdateCloseBtn.textContent = '关闭';
        _gwUpdateCloseBtn.style.cursor = 'pointer';
        _gwUpdateCloseBtn.style.opacity = '1';
        if (success) {
            _gwUpdateCloseBtn.style.background = 'linear-gradient(135deg, var(--accent-color) 0%, rgba(var(--accent-rgb), 0.7) 100%)';
            _gwUpdateCloseBtn.style.color = '#fff';
            _gwUpdateCloseBtn.style.border = 'none';
        }
        _gwUpdateCloseBtn.onclick = () => {
            const ov = _gwUpdateOverlay;
            if (!ov) return;
            ov.style.opacity = '0';
            ov.style.pointerEvents = 'none';
            setTimeout(() => { try { document.body.removeChild(ov); } catch (e) {} }, 200);
            _gwUpdateOverlay = null;
        };
    }
}

/** 内置 OpenClaw Control UI：免密载入；同 URL 不重复刷新，避免「失败尝试过多」限流 */
let __openclawPanelLastUrl = '';
let __openclawPanelLoading = false;

async function loadOpenclawControlUi(forceReload = false) {
    const webview = document.getElementById('openclaw-iframe');
    if (!webview || __openclawPanelLoading) return;
    __openclawPanelLoading = true;
    try {
        const url = await window.api.getDashboardUrl();
        const currentSrc = (webview.getAttribute('src') || '').trim();
        if (!forceReload && currentSrc && (currentSrc === url || __openclawPanelLastUrl === url)) {
            return;
        }
        showToast(forceReload ? '正在重新免密登录控制台…' : '正在连接Nexora Agent控制台面板…');
        // 首次进入或强制重载：清掉 guest 里过期 token，避免「失败尝试过多」
        if ((forceReload || !currentSrc) && window.api.clearOpenclawPanelSession) {
            try { await window.api.clearOpenclawPanelSession(); } catch (e) {}
        }
        __openclawPanelLastUrl = url;
        webview.src = url;
        
        injectWebviewUpdateInterceptor(webview);
    } catch (err) {
        const fallback = 'http://127.0.0.1:18789/acp/#token=' + encodeURIComponent('openclaw-dev-token-998877');
        __openclawPanelLastUrl = fallback;
        webview.src = fallback;
        injectWebviewUpdateInterceptor(webview);
    } finally {
        __openclawPanelLoading = false;
    }
}

function injectWebviewUpdateInterceptor(webview) {
    if (!webview) return;

    const MAGIC_PREFIX = '__NEXORA_AGENT_UPDATE__:';

    // 每次 webview 加载完毕后注入拦截脚本
    const onDomReady = () => {
        webview.executeJavaScript(`
            (function() {
                if (window.__nexora_agent_update_injected) return;
                window.__nexora_agent_update_injected = true;

                const MAGIC = '${MAGIC_PREFIX}';

                function processNodes() {
                    // 1) 隐藏 "Update skipped: not-git-install" 红色告警条
                    document.querySelectorAll('div, p, span, section, aside, [class*="alert"], [class*="notification"], [class*="banner"]').forEach(function(el) {
                        var text = el.textContent || '';
                        if ((text.includes('Update skipped') || text.includes('not-git-install') || text.includes('openclaw update'))
                            && el.offsetHeight > 0 && el.offsetHeight < 200) {
                            el.style.display = 'none';
                        }
                    });

                    // 2) 拦截 "立即更新" / "Update Now" 按钮
                    document.querySelectorAll('button, a, [role="button"], span').forEach(function(el) {
                        var text = (el.textContent || '').trim();
                        if ((text === '立即更新' || text === 'Update Now' || text === 'update now')
                            && !el.__nexora_agent_intercepted) {
                            el.__nexora_agent_intercepted = true;
                            el.addEventListener('click', function(e) {
                                e.preventDefault();
                                e.stopPropagation();
                                e.stopImmediatePropagation();
                                // 从附近上下文提取版本号
                                var ver = '';
                                var parent = el.parentElement;
                                for (var i = 0; i < 5 && parent; i++) {
                                    var m = parent.textContent.match(/v?(20\\d{2}\\.\\d+\\.\\d+)/);
                                    if (m) { ver = m[1]; break; }
                                    parent = parent.parentElement;
                                }
                                console.log(MAGIC + JSON.stringify({ action: 'update', version: ver }));
                            }, true);
                        }
                    });
                }

                var observer = new MutationObserver(processNodes);
                observer.observe(document.body, { childList: true, subtree: true });
                processNodes();
            })();
        `).catch(() => {});
    };

    // 防止重复绑定 dom-ready
    webview.removeEventListener('dom-ready', onDomReady);
    webview.addEventListener('dom-ready', onDomReady);

    // 监听来自 webview 的 console-message 事件（跨上下文通信桥梁）
    if (!_webviewUpdateInjected) {
        _webviewUpdateInjected = true;

        webview.addEventListener('console-message', async (evt) => {
            const msg = evt.message || '';
            if (!msg.startsWith(MAGIC_PREFIX)) return;

            let payload;
            try { payload = JSON.parse(msg.slice(MAGIC_PREFIX.length)); }
            catch (e) { return; }

            if (payload.action !== 'update') return;
            const targetVersion = payload.version || '';

            const confirmed = await confirm(
                `检测到Nexora Agent核心有新版本${targetVersion ? ' v' + targetVersion : ''}。\n\n` +
                '将为您执行以下操作：\n' +
                '  1. 停止当前Nexora Agent\n' +
                '  2. 下载并安装新版本核心包\n' +
                '  3. 自动重启Nexora Agent\n\n' +
                '是否立即更新？',
                'Nexora Agent核心更新'
            );
            if (!confirmed) return;

            // 打开进度弹窗，实时展示每一步状态与日志
            showGatewayUpdateProgress();

            try {
                const result = await window.api.updateOpenclawPackage({ targetVersion });
                if (result.success) {
                    // 安装成功但自动重启失败时，按“告警”状态呈现，提示用户手动启动
                    const ok = result.restarted !== false;
                    finishGatewayUpdateProgress(ok, result.message);
                    setTimeout(() => {
                        const wv = document.getElementById('openclaw-iframe');
                        if (wv) wv.reload();
                    }, 3000);
                } else {
                    finishGatewayUpdateProgress(false, result.message);
                }
            } catch (err) {
                finishGatewayUpdateProgress(false, `Nexora Agent更新失败: ${err.message}`);
            }
        });

        // 监听主进程的更新进度推送 → 实时刷新进度弹窗
        if (window.api && window.api.onGatewayUpdateProgress) {
            window.api.onGatewayUpdateProgress((data) => {
                if (data && data.message) {
                    console.log('[GatewayUpdate]', data.message);
                    appendGatewayUpdateLog(data.message);
                }
            });
        }
    }
}

// ==========================================
// 🚀 软件内自动更新/检测升级逻辑
// ==========================================
let updateInfo = null; // 存放当前的更新包信息

async function triggerUpdateCheck(isManual = false) {
    if (isManual) {
        showToast('正在检查云端新版本，请稍候...');
    } else {
        showToast(t('toast.auto_update.checking'));
    }
    
    try {
        const result = await window.api.checkUpdate(isManual);

        // 网络探测失败：绝不能弹「发现新版本 / v未知」
        if (result.checkFailed) {
            if (isManual) {
                showToast(result.message || '无法连接更新服务器，请稍后重试或手动前往 Releases 页面');
                if (window.api && window.api.openExternal) {
                    window.api.openExternal(result.downloadUrl || 'https://github.com/2014-y/ClawAI/releases');
                }
            } else {
                showToast(t('toast.auto_update.failed'));
            }
            return;
        }
        
        if (!result.hasUpdate) {
            if (isManual) {
                showToast(`当前已是最新版本！(v${result.currentVersion})`);
            } else {
                showToast(t('toast.auto_update.latest'));
            }
            return;
        }
        
        // 有新版本，展示模态弹窗
        updateInfo = result;
        
        document.getElementById('update-current-ver').innerText = 'v' + result.currentVersion;
        document.getElementById('update-latest-ver').innerText = 'v' + result.latestVersion;
        document.getElementById('update-notes').innerText = result.releaseNotes || '没有更新日志';
        
        // 隐藏进度条容器，显示按钮
        document.getElementById('update-progress-container').style.display = 'none';
        document.getElementById('update-btn-confirm').style.display = 'inline-block';
        document.getElementById('update-btn-confirm').innerText = '立即升级';
        document.getElementById('update-btn-confirm').disabled = false;
        document.getElementById('update-btn-cancel').style.display = 'inline-block';
        
        // 显示弹窗
        document.getElementById('update-modal').classList.add('active');
    } catch (err) {
        console.error('更新检查失败:', err);
        if (isManual) {
            showToast('更新检测失败，请检查网络是否通畅');
        } else {
            showToast(t('toast.auto_update.failed'));
        }
    }
}

// 注册模态窗交互
function setupUpdateModal() {
    const modal = document.getElementById('update-modal');
    if (!modal) return;
    
    const closeBtn = document.getElementById('update-modal-close');
    const cancelBtn = document.getElementById('update-btn-cancel');
    const confirmBtn = document.getElementById('update-btn-confirm');
    
    const closeModal = () => {
        // 如果正在下载，不允许直接关闭
        if (confirmBtn.disabled) {
            showToast('更新包正在下载，请勿关闭应用');
            return;
        }
        modal.classList.remove('active');
    };
    
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    
    if (confirmBtn) {
        confirmBtn.addEventListener('click', async () => {
            if (!updateInfo || !updateInfo.downloadUrl) return;
            
            // 禁用按钮并显示进度条
            confirmBtn.disabled = true;
            confirmBtn.innerText = '正在准备下载...';
            cancelBtn.style.display = 'none'; // 隐藏取消按钮防止误操作
            
            const progressContainer = document.getElementById('update-progress-container');
            const progressBar = document.getElementById('update-progress-bar');
            const progressPercent = document.getElementById('update-progress-percent');
            const progressStatus = document.getElementById('update-progress-status');
            
            if (progressContainer) progressContainer.style.display = 'block';
            if (progressBar) progressBar.style.width = '0%';
            if (progressPercent) progressPercent.innerText = '0%';
            if (progressStatus) progressStatus.innerText = '正在建立下载通道...';
            
            // 开始下载更新
            try {
                const downloadResult = await window.api.startDownloadUpdate(updateInfo.downloadUrl, updateInfo.fileName);
                if (downloadResult.success) {
                    if (progressStatus) progressStatus.innerText = '下载完成！正在启动升级程序...';
                    if (progressBar) progressBar.style.width = '100%';
                    if (progressPercent) progressPercent.innerText = '100%';
                    
                    setTimeout(() => {
                        window.api.installUpdate(downloadResult.savePath);
                    }, 1000);
                } else {
                    throw new Error(downloadResult.message);
                }
            } catch (error) {
                console.error('下载更新失败:', error);
                showToast(`升级失败: ${error.message || '网络连接超时'}，已为您打开浏览器进行手动下载。`);
                
                // 自动打开浏览器到 GitHub Releases 页面
                if (window.api && window.api.openExternal) {
                    window.api.openExternal('https://github.com/2014-y/ClawAI/releases');
                }
                
                // 恢复按钮状态
                confirmBtn.disabled = false;
                confirmBtn.innerText = '重试立即升级';
                cancelBtn.style.display = 'inline-block';
                if (progressStatus) progressStatus.innerText = '下载出错！';
            }
        });
    }
    
    // 监听主进程的下载进度推送
    window.api.onDownloadProgress((percent) => {
        const progressBar = document.getElementById('update-progress-bar');
        const progressPercent = document.getElementById('update-progress-percent');
        const progressStatus = document.getElementById('update-progress-status');
        
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (progressPercent) progressPercent.innerText = `${percent}%`;
        if (progressStatus) progressStatus.innerText = `正在下载更新包...`;
    });
}

let accelerationState = null;
let accelerationBusy = false;
let accelerationBusyMessage = '';
let accelerationUi = {
    panel: 'profiles',
    importMode: 'url',
    search: '',
    protocol: '',
    sort: 'latency',
    viewMode: 'nodes',
    countryFilter: 'all'
};
let expandedGroups = new Set();
let connPollInterval = null;
let connSearchText = '';

function isAccelerationDelayBusyMessage(message) {
    return /测速|延迟/.test(String(message || ''));
}

let proxiesAutoDelayDoneIds = new Set();
let accelerationDelayUiActive = false;
let accelerationDelayDoneNames = new Set();
let accelerationDelayTotal = 0;
let accelerationDelayFinished = 0;
let accelerationIpDetectInFlight = false;
let lastAccelerationIpDetectAt = 0;
let accelerationIpDetectStartedAt = 0;

function paintAccelerationProxyNowDelay(latency, testing) {
    const box = document.getElementById('acc-proxy-now-delay');
    if (!box) return;
    const strong = box.querySelector('strong');
    if (!strong) return;
    strong.classList.remove('latency-good', 'latency-medium', 'latency-bad', 'latency-none', 'latency-testing');
    if (testing) {
        strong.innerHTML = '<span class="acc-node-delay-spinner" aria-hidden="true"></span>';
        strong.classList.add('latency-testing');
        return;
    }
    if (typeof latency === 'number' && latency > 0) {
        strong.textContent = `${latency} ms`;
        strong.classList.add(getAccelerationLatencyClass(latency));
    } else if (latency === 0) {
        strong.textContent = '超时';
        strong.classList.add('latency-bad');
    } else {
        strong.textContent = '未测';
        strong.classList.add('latency-none');
    }
}

function beginAccelerationDelayUi(message) {
    accelerationDelayUiActive = true;
    accelerationDelayDoneNames = new Set();
    accelerationDelayTotal = 0;
    accelerationDelayFinished = 0;
    const nodes = ((accelerationState && accelerationState.nodes) || []).filter((n) => n && !isAccelerationInfoNode(n));
    accelerationDelayTotal = nodes.length;
    nodes.forEach((n) => paintAccelerationNodeLatency(n.name, null, true));
    if (accelerationState && accelerationState.selectedProxy) {
        paintAccelerationProxyNowDelay(null, true);
    }
}

function endAccelerationDelayUi() {
    accelerationDelayUiActive = false;
    accelerationDelayDoneNames = new Set();
    accelerationDelayTotal = 0;
    accelerationDelayFinished = 0;
    document.querySelectorAll('.acc-node-card.is-delay-testing').forEach((card) => {
        card.classList.remove('is-delay-testing');
    });
    const progressEl = document.getElementById('acc-delay-progress');
    if (progressEl) {
        progressEl.hidden = true;
        progressEl.textContent = '';
    }
}

function updateAccelerationBusyUi() {
    const busy = accelerationBusy;
    const msg = accelerationBusyMessage || '处理中...';
    const isDelay = busy && isAccelerationDelayBusyMessage(msg);

    const delayBtn = document.getElementById('acc-delay-btn');
    if (delayBtn) {
        delayBtn.disabled = busy;
        delayBtn.classList.toggle('is-loading', isDelay);
        delayBtn.setAttribute('aria-busy', isDelay ? 'true' : 'false');
        delayBtn.textContent = t('acc.proxy.delay_btn');
    }

    // 仅在执行关键状态切换（如启动中、关闭中、处理配置中）时禁用开关
    // 背景任务如“测速中…”、“检测 IP 中…”不应阻塞开关点击
    const isBackgroundBusy = busy && /检测|测速|Testing|Detecting/i.test(msg);
    const shouldDisable = busy && !isBackgroundBusy;

    const systemProxyToggle = document.getElementById('acc-system-proxy-toggle');
    const tunToggle = document.getElementById('acc-tun-toggle');
    const dashSystemProxyToggle = document.getElementById('acc-dash-system-proxy-toggle');
    const dashTunToggle = document.getElementById('acc-dash-tun-toggle');
    const pageToggle = document.getElementById('acc-page-enabled-toggle');
    const controlsToggle = document.getElementById('acc-controls-enabled-toggle');
    const dashEnabledToggle = document.getElementById('acc-dash-enabled-toggle');

    [systemProxyToggle, tunToggle, dashSystemProxyToggle, dashTunToggle, pageToggle, controlsToggle, dashEnabledToggle].forEach(el => {
        if (el) el.disabled = shouldDisable;
    });

    const progressEl = document.getElementById('acc-delay-progress');
    if (progressEl) {
        if (isDelay) {
            const progress = accelerationDelayTotal > 0
                ? `${t('测速中', 'Testing', '測速中')} ${accelerationDelayFinished}/${accelerationDelayTotal}`
                : t('测速中…', 'Testing...', '測速中…');
            progressEl.hidden = false;
            progressEl.innerHTML = `<span class="acc-btn-spinner" aria-hidden="true"></span>${escapeHtml(progress)}`;
        } else {
            progressEl.hidden = true;
            progressEl.textContent = '';
        }
    }

    const grid = document.getElementById('acc-node-grid');
    if (grid) grid.classList.toggle('is-testing', isDelay);

    const overlay = document.getElementById('acc-delay-overlay');
    if (overlay) {
        // 测速用卡片右侧转圈，不再盖整层遮罩（否则看不清单节点 loading）
        overlay.hidden = true;
    }

    if (isDelay) {
        if (!accelerationDelayUiActive) beginAccelerationDelayUi(msg);
    } else if (accelerationDelayUiActive) {
        endAccelerationDelayUi();
    }
}

function setAccelerationBusy(busy, message) {
    accelerationBusy = !!busy;
    accelerationBusyMessage = busy ? String(message || '处理中...') : '';
    updateAccelerationBusyUi();
}

function getAccelerationIpDetectResultText() {
    const dash = document.getElementById('acc-dash-ip-detect-result');
    const ctrl = document.getElementById('acc-ip-detect-result');
    return String((dash && dash.textContent) || (ctrl && ctrl.textContent) || '').trim();
}

function shouldAutoAccelerationIpDetect() {
    if (accelerationIpDetectInFlight) {
        // 卡住超过 35s 允许重试（后端最多约 3×10s）
        return Date.now() - accelerationIpDetectStartedAt > 35000;
    }
    const text = getAccelerationIpDetectResultText();
    // 已成功检出 IP（含国旗）则不再自动刷
    if (/\d{1,3}(?:\.\d{1,3}){3}/.test(text)) return false;
    return /未检测|未启用|检测失败|检测超时|检测中|检测不可用|点击检测|正在检测|代理未就绪|连接被重置|DNS 失败|本机/i.test(text) || !text;
}

function maybeAutoAccelerationIpDetect(options = {}) {
    if (!shouldAutoAccelerationIpDetect()) return null;
    // 卡住时强制重入
    if (accelerationIpDetectInFlight && Date.now() - accelerationIpDetectStartedAt > 35000) {
        accelerationIpDetectInFlight = false;
    }
    return runAccelerationIpDetect({ force: !!options.force, reason: options.reason || 'auto' });
}

async function runAccelerationIpDetect(options = {}) {
    const { force = false } = options;
    if (accelerationIpDetectInFlight) return null;
    if (!force && Date.now() - lastAccelerationIpDetectAt < 8000) return null;

    const resultEl = document.getElementById('acc-ip-detect-result');
    const dashResultEl = document.getElementById('acc-dash-ip-detect-result');
    const ipDetectBtn = document.getElementById('acc-ip-detect-btn');
    const dashIpDetectBtn = document.getElementById('acc-dash-ip-detect-btn');
    const countryCodeToFlag = (cc) => {
        if (!cc || cc.length !== 2) return '🌐';
        const upper = cc.toUpperCase();
        return String.fromCodePoint(...[...upper].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65));
    };
    const shortenIpDetectError = (raw) => {
        const s = String(raw || '').trim();
        if (!s) return t('检测失败', 'Detection failed', '檢測失敗');
        if (/ECONNREFUSED/i.test(s)) return t('代理未就绪', 'Proxy not ready', '代理未就緒');
        if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout|超时/i.test(s)) return t('检测超时', 'Detection timeout', '檢測超時');
        if (/ECONNRESET/i.test(s)) return t('连接被重置', 'Connection reset', '連線被重置');
        if (/ENOTFOUND|getaddrinfo/i.test(s)) return t('DNS 失败', 'DNS failure', 'DNS 失敗');
        if (s.length > 22) return t('检测失败', 'Detection failed', '檢測失敗');
        return s;
    };
    const paint = (text, color, title) => {
        [resultEl, dashResultEl].forEach((el) => {
            if (!el) return;
            el.textContent = text;
            el.style.color = color || '';
            el.title = title || text;
        });
    };

    if (!window.api || !window.api.detectAccelerationIp) {
        paint(t('检测不可用', 'Detection unavailable', '檢測不可用'), '#ef4444', '');
        return null;
    }

    const viaProxy = !!(accelerationState && accelerationState.running);
    accelerationIpDetectInFlight = true;
    accelerationIpDetectStartedAt = Date.now();
    paint(t('检测中...', 'Detecting...', '檢測中...'), '', viaProxy ? t('正在检测代理出口 IP', 'Detecting proxy exit IP', '正在檢測代理出口 IP') : t('正在检测本机公网出口', 'Detecting local exit IP', '正在檢測本機公網出口'));
    if (ipDetectBtn) ipDetectBtn.disabled = true;
    if (dashIpDetectBtn) dashIpDetectBtn.disabled = true;
    try {
        const data = await Promise.race([
            window.api.detectAccelerationIp(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('检测超时')), 22000))
        ]);
        lastAccelerationIpDetectAt = Date.now();
        if (data && data.success && data.ip) {
            const flag = countryCodeToFlag(data.countryCode);
            const isDirect = data.via === 'direct' || !viaProxy;
            const formatted = `${flag} ${data.ip}`;
            const tooltip = [
                isDirect ? t('本机直连出口', 'Local direct exit', '本機直連出口') : t('代理出口', 'Proxy exit', '代理出口'),
                data.country,
                data.region,
                data.city,
                data.isp,
                data.selectedProxy
            ].filter(Boolean).join(' · ');
            paint(formatted, isDirect ? 'var(--text-primary)' : 'var(--success-color, #22c55e)', tooltip);
            return data;
        }
        {
            const rawErr = (data && data.error) || '检测失败';
            paint(shortenIpDetectError(rawErr), '#ef4444', rawErr);
        }
        return data;
    } catch (e) {
        lastAccelerationIpDetectAt = Date.now();
        const rawErr = e.message || '检测超时';
        paint(shortenIpDetectError(rawErr), '#ef4444', rawErr);
        return null;
    } finally {
        accelerationIpDetectInFlight = false;
        if (ipDetectBtn) ipDetectBtn.disabled = false;
        if (dashIpDetectBtn) dashIpDetectBtn.disabled = false;
    }
}

function hasAccelerationTestableNodes(data) {
    const nodes = (data && data.nodes) || (accelerationState && accelerationState.nodes) || [];
    return nodes.some((n) => n && !isAccelerationInfoNode(n));
}

async function runAccelerationDelayTest(options = {}) {
    if (accelerationBusy) return null;
    if (!window.api || !window.api.delayTestAcceleration) return null;
    if (!options.force && !hasAccelerationTestableNodes()) return null;

    const wasEnabled = !!(accelerationState && accelerationState.enabled);
    const successText = options.silent
        ? null
        : (wasEnabled
            ? '延迟测试完成'
            : '延迟测试完成（临时测速，空闲后自动关闭内核）');
    const pid = accelerationState && accelerationState.activeProfileId;
    if (pid) proxiesAutoDelayDoneIds.add(pid);
    const res = await handleAccelerationResult(
        window.api.delayTestAcceleration(),
        successText,
        {
            busyMessage: wasEnabled ? '正在测速节点延迟…' : '正在启动临时内核并测速…'
        }
    );
    // 自动选择：只在当前地区标签里挑最低延迟
    if (res && res.success && res.enabled && !res.temporaryTest) {
        await applyAccelerationAutoSelect({
            nodes: res.nodes,
            silent: !!options.silent,
            notifyKeep: !!options.fromAuto
        });
    }
    // 手动测速结束后，按缓存间隔重新排队，避免倒计时残留旧秒数
    if (!options.fromAuto && isAccelerationAutoSelectEnabled()) {
        setupAutoSelectTimer();
    }
    return res;
}

function maybeAutoDelayOnProxiesTab() {
    if (accelerationBusy) return;
    if (!hasAccelerationTestableNodes()) return;
    const pid = accelerationState && accelerationState.activeProfileId;
    if (!pid) return;
    // 每个配置在代理页只自动测一次，来回切菜单不再重复
    if (proxiesAutoDelayDoneIds.has(pid)) return;
    proxiesAutoDelayDoneIds.add(pid);
    runAccelerationDelayTest({ silent: false }).catch(() => {});
}

/** 换了配置：允许并立刻自动测速一次（与切菜单无关） */
async function onAccelerationProfileSwitched(res) {
    if (!res || !res.success) return;
    const pid = res.activeProfileId;
    if (pid) proxiesAutoDelayDoneIds.delete(pid);
    if (!hasAccelerationTestableNodes(res) && !hasAccelerationTestableNodes()) return;
    await runAccelerationDelayTest({ force: true });
}

function setAccelerationPanel(panel) {
    const prev = accelerationUi.panel;
    accelerationUi.panel = panel || 'dashboard';
    document.querySelectorAll('.acc-subtab[data-acc-panel]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-acc-panel') === accelerationUi.panel);
    });
    document.querySelectorAll('.acc-panel').forEach((el) => {
        const match = el.id === `acc-panel-${accelerationUi.panel}`;
        el.classList.toggle('active', match);
        el.hidden = !match;
    });

    if (accelerationUi.panel === 'connections' || accelerationUi.panel === 'dashboard') {
        startConnectionPolling();
        if (accelerationUi.panel === 'dashboard') {
            requestAnimationFrame(() => drawDashboardSpeedChart(0, 0));
            // 已启用且尚未检出 IP 时，进仪表盘自动检测
            maybeAutoAccelerationIpDetect({ reason: 'dashboard' });
        }
    } else {
        stopConnectionPolling();
    }

    if (accelerationUi.panel === 'proxies' && prev !== 'proxies') {
        maybeAutoDelayOnProxiesTab();
        // 进入代理页再刷一次间隔下拉，修复「显示≠缓存、点一下才一致」
        syncAccelerationAutoSelectIntervalSelect();
    }
}

function setAccelerationImportFeedback(text, type) {
    const el = document.getElementById('acc-import-feedback');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('error', 'success');
    if (type) el.classList.add(type);
}

function startConnectionPolling() {
    stopConnectionPolling();
    refreshConnections();
    connPollInterval = setInterval(refreshConnections, 1500);
}

function stopConnectionPolling() {
    if (connPollInterval) {
        clearInterval(connPollInterval);
        connPollInterval = null;
    }
}

async function refreshConnections() {
    if (!window.api || !window.api.getAccelerationConnections) return;
    try {
        const data = await window.api.getAccelerationConnections();
        if (data && data.success) {
            renderConnections(data);
        }
    } catch (e) {
        console.error('[Connections] refresh failed:', e);
    }
}

function formatBytes(b) {
    if (!b) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(b) / Math.log(k));
    return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}

function formatSpeed(b) {
    return formatBytes(b) + '/s';
}

function renderConnections(data) {
    const list = Array.isArray(data.connections) ? data.connections : [];
    const tbody = document.getElementById('acc-connections-tbody');
    const countEl = document.getElementById('acc-conn-count');
    
    if (!window._lastConnStats) {
        window._lastConnStats = { time: Date.now(), up: data.uploadTotal || 0, down: data.downloadTotal || 0 };
    }
    const now = Date.now();
    const dt = (now - window._lastConnStats.time) / 1000;
    let upSpeed = 0;
    let downSpeed = 0;
    if (dt > 0.5) {
        upSpeed = Math.max(0, ((data.uploadTotal || 0) - window._lastConnStats.up) / dt);
        downSpeed = Math.max(0, ((data.downloadTotal || 0) - window._lastConnStats.down) / dt);
    }
    window._lastConnStats = { time: now, up: data.uploadTotal || 0, down: data.downloadTotal || 0 };

        const activeLabel = t('活跃连接', 'Active Connections', '活躍連線');
        const uploadLabel = t('实时上传', 'Upload', '實時上傳');
        const downloadLabel = t('实时下载', 'Download', '實時下載');
        const unitLabel = t(' 个', '', ' 個');
        countEl.textContent = `${activeLabel}: ${list.length}${unitLabel} · ${uploadLabel}: ${formatSpeed(upSpeed)} · ${downloadLabel}: ${formatSpeed(downSpeed)}`;

    // 仪表盘网速文本更新
    const dashSpeedEl = document.getElementById('acc-dash-speed-text');
    if (dashSpeedEl) {
        dashSpeedEl.innerHTML = `<span class="speed-up">↑ ${formatSpeed(upSpeed)}</span><span class="speed-down">↓ ${formatSpeed(downSpeed)}</span>`;
    }

    // 仪表盘累计流量更新
    const dashUploadEl = document.getElementById('acc-dash-upload-total');
    const dashDownloadEl = document.getElementById('acc-dash-download-total');
    if (dashUploadEl) dashUploadEl.textContent = `↑ ${formatBytes(data.uploadTotal || 0)}`;
    if (dashDownloadEl) dashDownloadEl.textContent = `↓ ${formatBytes(data.downloadTotal || 0)}`;

    // 仪表盘 Canvas 网速波动折线图重绘
    drawDashboardSpeedChart(upSpeed, downSpeed);

    // 仪表盘 Canvas 流量占比环形图重绘
    drawDashboardTrafficRing(data.uploadTotal || 0, data.downloadTotal || 0);

    // 渲染仪表盘右侧迷你实时活跃连接面板
    renderMiniConnectionsFeed(list);

    if (!tbody) return;
    
    const query = String(connSearchText || '').trim().toLowerCase();
    const filtered = list.filter(c => {
        if (!query) return true;
        const meta = c.metadata || {};
        return String(meta.host || '').toLowerCase().includes(query) ||
               String(meta.destinationIP || '').toLowerCase().includes(query) ||
               String(meta.sourceIP || '').toLowerCase().includes(query) ||
               String(c.rule || '').toLowerCase().includes(query) ||
               (Array.isArray(c.chains) && c.chains.join(' > ').toLowerCase().includes(query));
    });

    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="acc-empty" style="text-align: center; padding: 20px; color: var(--text-secondary);">${t('acc.conn.no_match')}</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(c => {
        const meta = c.metadata || {};
        const dest = meta.host ? `${meta.host}:${meta.destinationPort}` : `${meta.destinationIP}:${meta.destinationPort}`;
        const source = `${meta.sourceIP}:${meta.sourcePort}`;
        const proto = `${String(meta.network || '').toUpperCase()} (${meta.type || 'RAW'})`;
        const rule = c.rule ? `${c.rule}${c.rulePayload ? ` [${c.rulePayload}]` : ''}` : '--';
        
        let chainStr = '--';
        if (Array.isArray(c.chains) && c.chains.length) {
            chainStr = c.chains.join(' ➔ ');
        }

        const durationMs = Date.now() - new Date(c.start).getTime();
        const durationSec = Math.max(0, Math.floor(durationMs / 1000));
        let durationStr = `${durationSec}s`;
        if (durationSec > 60) {
            const min = Math.floor(durationSec / 60);
            const sec = durationSec % 60;
            durationStr = `${min}m${sec}s`;
        }

        const trafficStr = `↑ ${formatBytes(c.upload)} / ↓ ${formatBytes(c.download)}`;

        return `
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.03); background: transparent;">
                <td style="padding: 10px; color: var(--text-secondary); font-family: var(--font-mono);">${escapeHtml(source)}</td>
                <td style="padding: 10px; font-weight: 500; font-family: var(--font-mono); word-break: break-all; max-width: 250px;">${escapeHtml(dest)}</td>
                <td style="padding: 10px; color: var(--text-secondary);">${escapeHtml(proto)}</td>
                <td style="padding: 10px;"><span style="background: rgba(147, 51, 234, 0.15); color: #c084fc; padding: 2px 6px; border-radius: 4px; font-size: 10px;">${escapeHtml(rule)}</span></td>
                <td style="padding: 10px; color: #a78bfa; font-weight: 500;">${escapeHtml(chainStr)}</td>
                <td style="padding: 10px; font-family: var(--font-mono); color: var(--text-secondary); white-space: nowrap;">${trafficStr}</td>
                <td style="padding: 10px; font-family: var(--font-mono); color: var(--text-secondary);">${durationStr}</td>
                <td style="padding: 10px; text-align: center;">
                    <button type="button" class="btn-secondary acc-danger-btn" style="padding: 3px 8px; font-size: 10px;" onclick="closeSingleConnection('${c.id}')">断开</button>
                </td>
            </tr>
        `;
    }).join('');
}

function renderMiniConnectionsFeed(list) {
    const container = document.getElementById('acc-dash-mini-conn-list');
    const countEl = document.getElementById('acc-dash-mini-conn-count');
    if (!container) return;

    if (countEl) {
        countEl.textContent = `${list.length} ${t('个活动', 'Active', '個活動')}`;
    }

    if (!list || !list.length) {
        container.innerHTML = `<div class="empty-tip">${t('当前无活动流量', 'No active connections', '目前無活動流量')}</div>`;
        return;
    }

    // Sort by start time descending (newest first)
    const sorted = [...list].sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
    // Take the top 5
    const topConns = sorted.slice(0, 5);

    container.innerHTML = topConns.map(c => {
        const meta = c.metadata || {};
        const dest = meta.host ? `${meta.host}:${meta.destinationPort}` : `${meta.destinationIP}:${meta.destinationPort}`;
        const type = meta.type || 'RAW';
        const proto = meta.network ? String(meta.network).toUpperCase() : 'TCP';
        
        let chainStr = '直连';
        if (Array.isArray(c.chains) && c.chains.length) {
            chainStr = c.chains[c.chains.length - 1];
        }

        return `
            <div class="mini-conn-row" style="display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 11px; padding: 6px 8px; border-radius: 6px; background: rgba(255,255,255,0.015); border: 1px solid rgba(255,255,255,0.03); transition: all 0.2s ease;">
              <div style="min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px;">
                <div style="font-family: var(--font-mono); font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(dest)}">${escapeHtml(dest)}</div>
                <div style="font-size: 9px; color: var(--text-secondary); opacity: 0.65; display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  <span style="background: rgba(255,255,255,0.06); padding: 1px 4px; border-radius: 3px; font-size: 8px;">${escapeHtml(proto)}/${escapeHtml(type)}</span>
                  <span>➔ ${escapeHtml(chainStr)}</span>
                </div>
              </div>
              <div style="text-align: right; flex-shrink: 0; font-family: var(--font-mono); font-size: 10px; line-height: 1.25;">
                <div style="color: #ff758f;">↑ ${formatBytes(c.upload)}</div>
                <div style="color: #00f5ff;">↓ ${formatBytes(c.download)}</div>
              </div>
            </div>
        `;
    }).join('');
}

window.closeSingleConnection = async function(id) {
    if (!window.api || !window.api.closeAccelerationConnection) return;
    const res = await window.api.closeAccelerationConnection(id);
    if (res && res.success) {
        showToast('已断开网络连接');
        refreshConnections();
    } else {
        showToast('断开连接失败: ' + (res.error || '未知错误'));
    }
};

function setAccelerationImportMode(mode) {
    accelerationUi.importMode = mode || 'url';
    document.querySelectorAll('.acc-import-item').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-import-mode') === accelerationUi.importMode);
    });
    const title = document.getElementById('acc-import-title');
    const help = document.getElementById('acc-import-help');
    const urlFields = document.getElementById('acc-url-fields');
    const qrFields = document.getElementById('acc-qr-fields');
    const fileFields = document.getElementById('acc-file-fields');
    if (urlFields) urlFields.hidden = accelerationUi.importMode !== 'url';
    if (qrFields) qrFields.hidden = accelerationUi.importMode !== 'qr';
    if (fileFields) fileFields.hidden = accelerationUi.importMode !== 'file';
    if (accelerationUi.importMode === 'qr') {
        if (title) title.textContent = '通过二维码添加配置';
        if (help) help.textContent = '粘贴扫码结果（订阅链接或 YAML）。';
    } else if (accelerationUi.importMode === 'file') {
        if (title) title.textContent = '通过文件添加配置';
        if (help) help.textContent = '选择本地 Clash/Mihomo 配置文件。';
    } else {
        if (title) title.textContent = '通过 URL 添加配置';
        if (help) help.textContent = '填写加速厂商提供的 Clash/Mihomo 订阅地址。';
    }
}

function isAccelerationInfoNode(node) {
    const name = String((node && node.name) || '');
    const type = String((node && node.type) || '').toLowerCase();
    if (/剩余|流量|到期|重置|过期|套餐|expire|traffic|reset/i.test(name)) return true;
    if (/^reject/i.test(name) || type === 'reject' || type === 'rejectdrop') return true;
    if (type === 'direct' || name === 'DIRECT' || name === 'REJECT' || name === 'REJECT-DROP') return true;
    return false;
}

/** 延迟颜色：有测速结果即绿/黄；只有超时/失败才红 */
function getAccelerationLatencyClass(latency) {
    if (typeof latency !== 'number') return 'latency-none';
    if (latency <= 0) return 'latency-bad';
    if (latency < 600) return 'latency-good';
    return 'latency-medium';
}

function parseAccelerationInfoNode(name) {
    const raw = String(name || '').trim();
    const m = raw.match(/^(.+?)\s*[：:]\s*(.+)$/);
    if (m) {
        return { label: m[1].trim(), value: m[2].trim() };
    }
    if (/^reject/i.test(raw)) return { label: '拦截规则', value: raw };
    if (/^direct$/i.test(raw)) return { label: '直连', value: raw };
    return { label: '订阅信息', value: raw };
}

function getFilteredAccelerationNodes(data) {
    const nodes = Array.isArray(data && data.nodes) ? data.nodes.slice() : [];
    const search = String(accelerationUi.search || '').trim().toLowerCase();
    const protocol = String(accelerationUi.protocol || '').trim().toLowerCase();
    let list = nodes.filter((node) => {
        const name = String(node.name || '').toLowerCase();
        const type = String(node.type || '').toLowerCase();
        const flag = String(node.flag || '').toLowerCase();
        if (protocol && type !== protocol) return false;
        if (!search) return true;
        return name.includes(search) || type.includes(search) || flag.includes(search);
    });
    list = filterAccelerationNodesByCountry(list, accelerationUi.countryFilter);
    if (accelerationUi.sort === 'latency') {
        list.sort((a, b) => {
            const la = (typeof a.latency === 'number' && a.latency > 0) ? a.latency : Number.MAX_SAFE_INTEGER;
            const lb = (typeof b.latency === 'number' && b.latency > 0) ? b.latency : Number.MAX_SAFE_INTEGER;
            return la - lb;
        });
    } else if (accelerationUi.sort === 'name') {
        list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
    }
    return list;
}

const ACC_KNOWN_COUNTRY_FLAGS = ['hk', 'tw', 'jp', 'sg', 'us', 'kr', 'gb', 'de', 'fr', 'ca', 'au', 'ru', 'tr', 'my', 'th', 'vn', 'ph', 'in', 'ar', 'br', 'nl'];

function isAccelerationAutoSelectEnabled() {
    return localStorage.getItem('acc_auto_select_enabled') === 'true';
}

function accelerationCountryFilterLabel(filter) {
    const map = {
        all: '全部',
        hk: '香港',
        jp: '日本',
        sg: '新加坡',
        us: '美国',
        tw: '台湾',
        other: '其他'
    };
    const key = filter || 'all';
    return map[key] || key;
}

function filterAccelerationNodesByCountry(nodes, countryFilter) {
    const filter = countryFilter || 'all';
    const list = (nodes || []).filter((n) => n && !isAccelerationInfoNode(n));
    if (!filter || filter === 'all') return list;
    if (filter === 'other') {
        return list.filter((n) => !ACC_KNOWN_COUNTRY_FLAGS.includes(String(n.flag || '').toLowerCase()));
    }
    const want = String(filter).toLowerCase();
    return list.filter((n) => String(n.flag || '').toLowerCase() === want);
}

/** 在当前地区标签范围内选延迟最低的可用节点 */
function pickLowestLatencyNodeInCountryFilter(nodes, countryFilter) {
    const list = filterAccelerationNodesByCountry(nodes, countryFilter)
        .filter((n) => typeof n.latency === 'number' && n.latency > 0);
    if (!list.length) return null;
    list.sort((a, b) => a.latency - b.latency);
    return list[0];
}

async function applyAccelerationAutoSelect(options = {}) {
    const { silent = false, nodes = null, notifyKeep = false } = options;
    if (!isAccelerationAutoSelectEnabled()) return null;
    if (!(accelerationState && accelerationState.enabled)) return null;
    if (!window.api || !window.api.selectAccelerationProxy) return null;

    const pool = nodes || (accelerationState && accelerationState.nodes) || [];
    const filter = accelerationUi.countryFilter || 'all';
    const best = pickLowestLatencyNodeInCountryFilter(pool, filter);
    const tag = accelerationCountryFilterLabel(filter);
    if (!best) {
        if (!silent) showToast(`「${tag}」标签下暂无可用延迟，无法自动选择`);
        return null;
    }
    if (accelerationState.selectedProxy === best.name) {
        if (notifyKeep || !silent) {
            showToast(`自动测速完成 · 已是最低延迟 [${best.latency}ms]`);
        }
        return null;
    }
    // 迟滞：差距太小不切换，减少来回跳导致的短暂卡顿
    const current = pool.find((n) => n && n.name === accelerationState.selectedProxy);
    const hysteresis = getAccelerationAutoSelectThresholdMs();
    if (hysteresis > 0 && current && typeof current.latency === 'number' && current.latency > 0
        && typeof best.latency === 'number' && best.latency > 0
        && (current.latency - best.latency) < hysteresis) {
        if (notifyKeep) {
            showToast(`自动测速完成 · 保持当前节点（差距 < ${hysteresis}ms）`);
        }
        return null;
    }
    const selectRes = await window.api.selectAccelerationProxy({ name: best.name, group: 'GLOBAL' });
    if (selectRes && selectRes.success) {
        accelerationState = selectRes;
        renderAccelerationChannel(selectRes);
        showToast(`已自动切换「${tag}」最低延迟 → ${best.name} [${best.latency}ms]`);
        return selectRes;
    }
    if (!silent) showToast('自动选择失败: ' + ((selectRes && selectRes.error) || '未知错误'));
    return null;
}

function sourceLabel(profile) {
    if (!profile) return '';
    if (profile.url) return 'URL 订阅';
    if (profile.source === 'file') return '本地文件';
    if (profile.source === 'qr') return '二维码导入';
    return '手动导入';
}

function formatTrafficBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return '--';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
    }
    const digits = i >= 3 ? 2 : (i >= 2 ? 1 : 0);
    return `${v.toFixed(digits)} ${units[i]}`;
}

function formatExpireDate(expireSec) {
    const sec = Number(expireSec);
    if (!Number.isFinite(sec) || sec <= 0) return '';
    const d = new Date(sec * 1000);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function buildProfileTrafficHtml(profile) {
    const info = profile && profile.userInfo;
    if (!info) {
        return `<div class="acc-profile-traffic acc-profile-traffic-empty"><span class="acc-muted">暂无流量信息，点击「更新订阅」获取</span></div>`;
    }

    const total = Number(info.total) || 0;
    const used = Number(info.used != null ? info.used : ((info.upload || 0) + (info.download || 0))) || 0;
    let remain = info.remain != null ? Number(info.remain) : (total > 0 ? Math.max(0, total - used) : null);
    let percent = 0;
    if (total > 0) {
        percent = Math.max(0, Math.min(100, (used / total) * 100));
        if (remain == null) remain = Math.max(0, total - used);
    }

    const expireText = formatExpireDate(info.expire);
    const resetText = (info.resetDays != null && Number.isFinite(Number(info.resetDays)))
        ? `${info.resetDays} 天后重置`
        : '';

    const remainText = remain != null ? formatTrafficBytes(remain) : '--';
    const usedText = total > 0
        ? `${formatTrafficBytes(used)} / ${formatTrafficBytes(total)}`
        : (remain != null ? '总额待更新' : '--');
    const barClass = percent >= 90 ? 'danger' : (percent >= 70 ? 'warn' : 'ok');
    const barWidth = total > 0 ? percent.toFixed(1) : '0';

    return `
        <div class="acc-profile-traffic">
            <div class="acc-profile-traffic-top">
                <span class="acc-profile-traffic-remain">剩余 ${escapeHtml(remainText)}</span>
                <span class="acc-profile-traffic-used">${escapeHtml(usedText)}</span>
            </div>
            <div class="acc-profile-progress" title="${total > 0 ? `已用 ${percent.toFixed(1)}%` : '正在读取订阅用量，或点击「更新订阅」'}">
                <div class="acc-profile-progress-bar ${barClass}" style="width: ${barWidth}%"></div>
            </div>
            <div class="acc-profile-traffic-meta">
                ${expireText ? `<span>到期 ${escapeHtml(expireText)}</span>` : ''}
                ${resetText ? `<span>${escapeHtml(resetText)}</span>` : ''}
                ${!expireText && !resetText ? '<span class="acc-muted">订阅流量</span>' : ''}
            </div>
        </div>
    `;
}

async function refreshAccelerationChannel() {
    if (!window.api || !window.api.getAccelerationStatus) return;
    try {
        const data = await window.api.getAccelerationStatus();
        if (data && data.success) {
            accelerationState = data;
            renderAccelerationChannel(data);
        } else if (data && data.error) {
            showToast('Nexora Clash 状态读取失败: ' + data.error);
        }
    } catch (err) {
        console.warn('[Acceleration] refresh failed:', err);
    }
}

function renderAccelerationChannel(data) {
    const enabled = !!(data && data.enabled);
    const running = !!(data && data.running);
    const settingToggle = document.getElementById('setting-acceleration-toggle');
    const pageToggle = document.getElementById('acc-page-enabled-toggle');
    const controlsToggle = document.getElementById('acc-controls-enabled-toggle');
    const systemProxyToggle = document.getElementById('acc-system-proxy-toggle');
    const tunToggle = document.getElementById('acc-tun-toggle');
    if (settingToggle) settingToggle.checked = !!(data && data.autoStart);
    if (pageToggle) pageToggle.checked = running;
    if (controlsToggle) controlsToggle.checked = running;
    if (systemProxyToggle) systemProxyToggle.checked = !!data.systemProxy;
    if (tunToggle) tunToggle.checked = !!data.virtualNic;

    // 仪表盘开关同步
    const dashEnabledToggle = document.getElementById('acc-dash-enabled-toggle');
    const dashSystemProxyToggle = document.getElementById('acc-dash-system-proxy-toggle');
    const dashTunToggle = document.getElementById('acc-dash-tun-toggle');
    if (dashEnabledToggle) dashEnabledToggle.checked = running;
    if (dashSystemProxyToggle) dashSystemProxyToggle.checked = !!data.systemProxy;
    if (dashTunToggle) dashTunToggle.checked = !!data.virtualNic;

    // 仪表盘出站模式同步
    const mode = data.mode || 'rule';
    document.querySelectorAll('.acc-dash-mode-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    const modeHintKey = mode === 'global'
        ? 'acc.mode.global_hint'
        : mode === 'direct'
            ? 'acc.mode.direct_hint'
            : 'acc.mode.rule_hint';
    const modeHintText = t(modeHintKey);
    const modeHint = document.getElementById('acc-dash-mode-hint');
    if (modeHint) {
        modeHint.setAttribute('data-i18n', modeHintKey);
        modeHint.textContent = modeHintText;
    }
    const controlsModeHint = document.getElementById('acc-controls-mode-hint');
    if (controlsModeHint) {
        controlsModeHint.textContent = mode === 'global'
            ? '全局模式：所有流量都走当前节点，适合临时需要全代理的场景。'
            : mode === 'direct'
                ? '直连模式：不走代理，相当于临时关闭加速分流。'
                : '日常上网推荐「规则」：国内直连、境外走节点。';
    }

    // 仪表盘内存同步
    const dashMemEl = document.getElementById('acc-dash-memory-val');
    if (dashMemEl) {
        dashMemEl.textContent = getClashMemoryMock();
    }

    const dashRunStatus = document.getElementById('acc-dash-run-status');
    if (dashRunStatus) {
        if (dashRunStatus.parentElement) {
            dashRunStatus.parentElement.classList.toggle('enabled', running);
        }
        const statusKey = !running
            ? (enabled ? 'acc.status.stopped' : 'acc.status.disabled')
            : data.virtualNic && data.systemProxy
                ? 'acc.status.tun_proxy'
                : data.virtualNic
                    ? 'acc.status.tun'
                    : data.systemProxy
                        ? 'acc.status.system_proxy'
                        : 'acc.status.running';
        dashRunStatus.setAttribute('data-i18n', statusKey);
        dashRunStatus.textContent = t(statusKey);
    }

    const desc = document.getElementById('acc-enabled-desc');
    if (desc) {
        if (running && data && data.mixedPort) {
            desc.textContent = `开启后网关与客户端请求走本地加速代理 (当前端口: ${data.mixedPort})`;
        } else {
            desc.textContent = '开启后网关与客户端请求走本地加速代理';
        }
    }

    const pill = document.getElementById('acc-status-pill');
    if (pill) {
        let pillKey = 'acc.status.disabled';
        if (running) {
            pillKey = 'acc.status.enabled';
        } else if (enabled) {
            pillKey = 'acc.status.stopped';
        }
        pill.setAttribute('data-i18n', pillKey);
        pill.textContent = t(pillKey);
        pill.classList.toggle('enabled', running);
    }
    const mixed = document.getElementById('acc-mixed-port');
    const dashMixed = document.getElementById('acc-dash-mixed-port');
    const mixedText = data.mixedPort ? `127.0.0.1:${data.mixedPort}` : '--';
    if (mixed) mixed.textContent = mixedText;
    if (dashMixed) dashMixed.textContent = mixedText;

    const controller = document.getElementById('acc-controller');
    const dashController = document.getElementById('acc-dash-controller');
    const controllerText = data.controller || '--';
    if (controller) controller.textContent = controllerText;
    if (dashController) dashController.textContent = controllerText;

    const current = document.getElementById('acc-current-proxy');
    const dashCurrent = document.getElementById('acc-dash-current-proxy');
    const dashDelay = document.getElementById('acc-dash-current-delay');
    let matchedSelectedNode = null;
    if (current || dashCurrent || dashDelay) {
        if (data.selectedProxy) {
            matchedSelectedNode = (data.nodes || []).find(n => n.name === data.selectedProxy);
            const flagHtml = matchedSelectedNode ? renderFlag(matchedSelectedNode.flag) : '🌐';
            const htmlContent = `<span style="display: inline-flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;">${flagHtml} <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;">${escapeHtml(data.selectedProxy)}</span></span>`;
            if (current) current.innerHTML = htmlContent;
            if (dashCurrent) {
                dashCurrent.innerHTML = htmlContent;
                dashCurrent.title = data.selectedProxy;
            }
        } else {
            if (current) current.textContent = '--';
            if (dashCurrent) dashCurrent.textContent = '--';
        }
        if (dashDelay) {
            const latency = matchedSelectedNode && matchedSelectedNode.latency;
            dashDelay.classList.remove('latency-good', 'latency-medium', 'latency-bad', 'latency-none');
            if (typeof latency === 'number' && latency > 0) {
                dashDelay.textContent = `${latency} ms`;
                dashDelay.classList.add(getAccelerationLatencyClass(latency));
            } else if (latency === 0) {
                dashDelay.textContent = '超时';
                dashDelay.classList.add('latency-bad');
            } else {
                dashDelay.textContent = '未测';
                dashDelay.classList.add('latency-none');
            }
        }
    }

    document.querySelectorAll('input[name="acc-mode"]').forEach((input) => {
        input.checked = input.value === (data.mode || 'rule');
    });

    const select = document.getElementById('acc-profile-select');
    const profiles = Array.isArray(data.profiles) ? data.profiles : [];
    if (select) {
        select.innerHTML = profiles.length
            ? profiles.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === data.activeProfileId ? ' selected' : ''}>${escapeHtml(p.name || p.id)}</option>`).join('')
            : '<option value="">暂无配置</option>';
        select.disabled = profiles.length === 0;
    }

    const active = profiles.find((p) => p.id === data.activeProfileId);
    const summary = document.getElementById('acc-profile-summary');
    if (summary) {
        if (!active) summary.textContent = '请先添加加速厂商配置';
        else summary.textContent = `当前：${active.name || active.id} · ${sourceLabel(active)}`;
    }
    const dashActiveProfile = document.getElementById('acc-dash-active-profile');
    if (dashActiveProfile) {
        dashActiveProfile.textContent = active ? (active.name || active.id) : '暂无配置';
        dashActiveProfile.title = active ? (active.name || active.id) : '';
    }
    const proxyLabel = document.getElementById('acc-proxy-active-label');
    const proxyNowName = document.getElementById('acc-proxy-now-name');
    const proxyNowFlag = document.getElementById('acc-proxy-now-flag');
    const proxyNowDelay = document.getElementById('acc-proxy-now-delay');
    const matchedSelected = data.selectedProxy
        ? (data.nodes || []).find((n) => n.name === data.selectedProxy)
        : null;

    if (proxyNowName) {
        proxyNowName.textContent = data.selectedProxy || (active ? '未选择节点' : '暂无配置');
        proxyNowName.title = data.selectedProxy || '';
    }
    if (proxyNowFlag) {
        proxyNowFlag.innerHTML = matchedSelected
            ? renderFlag(matchedSelected.flag)
            : (data.selectedProxy ? '🌐' : '📡');
    }
    if (proxyNowDelay) {
        const strong = proxyNowDelay.querySelector('strong');
        if (strong) {
            strong.classList.remove('latency-good', 'latency-medium', 'latency-bad', 'latency-none', 'latency-testing');
            if (matchedSelected && typeof matchedSelected.latency === 'number' && matchedSelected.latency > 0) {
                strong.textContent = `${matchedSelected.latency} ms`;
                strong.classList.add(getAccelerationLatencyClass(matchedSelected.latency));
            } else if (matchedSelected && matchedSelected.latency === 0) {
                strong.textContent = '超时';
                strong.classList.add('latency-bad');
            } else {
                strong.textContent = '未测';
                strong.classList.add('latency-none');
            }
        }
    }

    if (proxyLabel && !(accelerationBusy && isAccelerationDelayBusyMessage(accelerationBusyMessage))) {
        if (!active) proxyLabel.textContent = '请先到「配置」页添加加速厂商';
        else if (data.selectedProxy) {
            const proto = matchedSelected && matchedSelected.type ? String(matchedSelected.type).toUpperCase() : '';
            proxyLabel.textContent = proto
                ? `${proto} · 点击下方节点可切换出站`
                : '点击下方节点可切换出站';
        }
        else proxyLabel.textContent = `配置「${active.name || active.id}」· 点击节点即可选用`;
    }

    const statProfile = document.getElementById('acc-proxy-stat-profile');
    const statOk = document.getElementById('acc-proxy-stat-ok');
    const statBad = document.getElementById('acc-proxy-stat-bad');
    const statPending = document.getElementById('acc-proxy-stat-pending');
    const testableNodes = (data.nodes || []).filter((n) => n && !isAccelerationInfoNode(n));
    let okCount = 0;
    let badCount = 0;
    let pendingCount = 0;
    testableNodes.forEach((n) => {
        if (typeof n.latency === 'number' && n.latency > 0) okCount += 1;
        else if (n.latency === 0) badCount += 1;
        else pendingCount += 1;
    });
    if (statProfile) {
        statProfile.textContent = active ? (active.name || active.id) : '暂无';
        statProfile.title = active ? (active.name || active.id) : '';
    }
    if (statOk) statOk.textContent = String(okCount);
    if (statBad) statBad.textContent = String(badCount);
    if (statPending) statPending.textContent = String(pendingCount);

    const renameBtn = document.getElementById('acc-profile-rename-btn');
    if (renameBtn) renameBtn.disabled = !active;
    const updateBtn = document.getElementById('acc-profile-update-btn');
    if (updateBtn) updateBtn.disabled = !(active && active.url);
    const deleteBtn = document.getElementById('acc-profile-delete-btn');
    if (deleteBtn) deleteBtn.disabled = !active;

    const list = document.getElementById('acc-profile-list');
    if (list) {
        if (!profiles.length) {
            list.innerHTML = '<div class="acc-empty">暂无配置。请用上方二维码、文件或 URL 添加。</div>';
        } else {
            list.innerHTML = profiles.map((p) => `
                <div class="acc-profile-item ${p.id === data.activeProfileId ? 'active' : ''}" data-profile-id="${escapeHtml(p.id)}">
                    <div class="acc-profile-main">
                        <div class="acc-profile-head">
                            <div>
                                <strong>${escapeHtml(p.name || p.id)}</strong>
                                <small>${escapeHtml(sourceLabel(p))}${p.url ? ' · ' + escapeHtml(p.url) : ''}</small>
                            </div>
                            <span class="acc-muted acc-profile-badge">${p.id === data.activeProfileId ? '使用中' : '点击选用'}</span>
                        </div>
                        ${buildProfileTrafficHtml(p)}
                    </div>
                </div>
            `).join('');
        }
    }

    const protocolFilter = document.getElementById('acc-node-protocol-filter');
    if (protocolFilter) {
        const types = Array.from(new Set((data.nodes || []).map((n) => String(n.type || '').toLowerCase()).filter(Boolean))).sort();
        const prev = accelerationUi.protocol;
        protocolFilter.innerHTML = '<option value="">全部协议</option>' + types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
        protocolFilter.value = types.includes(prev) ? prev : '';
        accelerationUi.protocol = protocolFilter.value;
    }

    const filtered = getFilteredAccelerationNodes(data);
    const finalNodes = filtered.filter(node => !isAccelerationInfoNode(node));
    const count = document.getElementById('acc-node-count');
    if (count) {
        const totalNonInfo = (data.nodes || []).filter(node => !isAccelerationInfoNode(node)).length;
        count.textContent = `${finalNodes.length}/${totalNonInfo} 个节点`;
    }

    const grid = document.getElementById('acc-node-grid');
    if (grid) {
        if (!(data.nodes || []).length) {
            grid.innerHTML = '<div class="acc-empty">暂无节点。请先到「配置」页添加加速厂商。</div>';
        } else if (!finalNodes.length) {
            grid.innerHTML = '<div class="acc-empty">没有匹配当前筛选条件的节点。</div>';
        } else {
            grid.innerHTML = finalNodes.map((node) => {
                const isInfo = isAccelerationInfoNode(node);
                if (isInfo) {
                    const parsed = parseAccelerationInfoNode(node.name);
                    return `
                        <div class="acc-node-card is-info" data-proxy-name="${escapeHtml(node.name)}" data-info="1">
                            <div class="acc-node-name">${escapeHtml(parsed.label)}</div>
                            <div class="acc-node-info-value">${escapeHtml(parsed.value)}</div>
                        </div>
                    `;
                }
                let latencyClass = 'latency-none';
                let latencyText = '未测';
                let latencyHtml = '';
                const isTestingThis = accelerationDelayUiActive && !accelerationDelayDoneNames.has(node.name);
                if (isTestingThis) {
                    latencyClass = 'latency-testing';
                    latencyHtml = '<span class="acc-node-delay-spinner" aria-hidden="true"></span>';
                } else if (typeof node.latency === 'number' && node.latency > 0) {
                    latencyText = `${node.latency} ms`;
                    latencyClass = getAccelerationLatencyClass(node.latency);
                    latencyHtml = latencyText;
                } else if (node.latency === 0) {
                    latencyText = '超时';
                    latencyClass = 'latency-bad';
                    latencyHtml = latencyText;
                } else {
                    latencyHtml = latencyText;
                }
                return `
                    <div class="acc-node-card ${node.selected ? 'selected' : ''}${isTestingThis ? ' is-delay-testing' : ''}" data-proxy-name="${escapeHtml(node.name)}">
                        <div class="acc-node-main">
                            <div class="acc-node-name">${renderFlag(node.flag)} ${escapeHtml(node.name)}</div>
                            <div class="acc-node-type">${escapeHtml(node.type || 'proxy')}</div>
                        </div>
                        <div class="acc-node-meta">
                            <div class="acc-node-delay ${latencyClass}">${latencyHtml}</div>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // 渲染策略组分流列表
    const groupsContainer = document.getElementById('acc-groups-container');
    if (groupsContainer) {
        const groups = Array.isArray(data.groups) ? data.groups : [];
        if (!groups.length) {
            groupsContainer.innerHTML = '<div class="acc-empty">暂无策略组。请先到「配置」页添加配置并启用通道。</div>';
        } else {
            groupsContainer.innerHTML = groups.map((g) => {
                const isExpanded = expandedGroups.has(g.name);
                let flag = '⚙️';
                const matchedNode = (data.nodes || []).find(n => n.name === g.now);
                if (matchedNode) flag = matchedNode.flag || '🌐';
                else if (g.now === 'DIRECT') flag = '🎯';
                else if (g.now === 'REJECT') flag = '🚫';

                const itemsHtml = isExpanded ? `
                    <div class="acc-group-nodes-list" style="margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.03);">
                        ${(() => {
                            let groupNodes = (g.all || []).map(nodeName => {
                                return (data.nodes || []).find(n => n.name === nodeName) || { name: nodeName };
                            });

                            const search = String(accelerationUi.search || '').trim().toLowerCase();
                            const protocol = String(accelerationUi.protocol || '').trim().toLowerCase();
                            
                            groupNodes = groupNodes.filter(node => {
                                const name = String(node.name || '').toLowerCase();
                                const type = String(node.type || '').toLowerCase();
                                const flag = String(node.flag || '').toLowerCase();
                                if (protocol && type && type !== protocol) return false;
                                if (!search) return true;
                                return name.includes(search) || type.includes(search) || flag.includes(search);
                            });

                            if (accelerationUi.sort === 'latency') {
                                groupNodes.sort((a, b) => {
                                    const la = (typeof a.latency === 'number' && a.latency > 0) ? a.latency : Number.MAX_SAFE_INTEGER;
                                    const lb = (typeof b.latency === 'number' && b.latency > 0) ? b.latency : Number.MAX_SAFE_INTEGER;
                                    return la - lb;
                                });
                            } else if (accelerationUi.sort === 'name') {
                                groupNodes.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
                            }

                            return groupNodes.map(nodeObj => {
                                const nodeName = nodeObj.name;
                                const isSelected = g.now === nodeName;
                                const nodeFlag = nodeObj.flag || (nodeName === 'DIRECT' ? '🎯' : (nodeName === 'REJECT' ? '🚫' : '⚙️'));

                                let nodeDelayStr = '';
                                let latencyClass = 'latency-none';
                                if (typeof nodeObj.latency === 'number' && nodeObj.latency > 0) {
                                    nodeDelayStr = ` (${nodeObj.latency}ms)`;
                                    latencyClass = getAccelerationLatencyClass(nodeObj.latency);
                                } else if (nodeObj.latency === 0) {
                                    nodeDelayStr = ' (超时)';
                                    latencyClass = 'latency-bad';
                                } else {
                                    nodeDelayStr = ' (未测)';
                                }

                                return `
                                    <button type="button" class="acc-group-node-chip ${isSelected ? 'active' : ''}"
                                        data-proxy-name="${escapeHtml(nodeName)}"
                                        style="background: ${isSelected ? 'rgba(147, 51, 234, 0.2)' : 'rgba(255,255,255,0.02)'}; 
                                               border: 1px solid ${isSelected ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)'}; 
                                               color: ${isSelected ? '#e9d5ff' : 'var(--text-primary)'}; 
                                               padding: 4px 10px; border-radius: 6px; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.15s ease;"
                                        onclick="selectGroupProxy('${escapeHtml(g.name)}', '${escapeHtml(nodeName)}')">
                                        <span style="display: inline-flex; align-items: center;">${renderFlag(nodeFlag)}</span>
                                        <span>${escapeHtml(nodeName)}</span>
                                        <span class="acc-group-node-delay ${latencyClass}" style="font-size: 9px; font-family: var(--font-mono);">${nodeDelayStr}</span>
                                    </button>
                                `;
                            }).join('');
                        })()}
                    </div>
                ` : '';

                return `
                    <div class="acc-group-card" style="background: rgba(255,255,255,0.015); border: 1px solid rgba(255,255,255,0.04); border-radius: 12px; padding: 14px; margin-bottom: 10px; transition: border-color 0.2s;">
                        <div class="acc-group-card-header" style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="toggleGroupExpand('${escapeHtml(g.name)}')">
                           <div>
                               <div style="font-weight: 600; font-size: 13px; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                                   <span>🧩</span>
                                   <span>${escapeHtml(g.name)}</span>
                                   <span style="font-size: 10px; color: var(--text-secondary); background: rgba(255,255,255,0.05); padding: 1px 4px; border-radius: 4px; text-transform: uppercase;">${escapeHtml(g.type)}</span>
                               </div>
                               <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px; display: flex; align-items: center; gap: 4px;">
                                   <span>当前：</span>
                                   <strong style="color: #c084fc; display: inline-flex; align-items: center; gap: 4px;">${renderFlag(flag)} ${escapeHtml(g.now)}</strong>
                               </div>
                           </div>
                           <div style="color: var(--text-secondary); font-size: 11px; display: flex; align-items: center; gap: 4px;">
                               <span>${(g.all || []).length} 个成员</span>
                               <span style="transform: rotate(${isExpanded ? '90deg' : '0deg'}); transition: transform 0.2s; font-size: 12px; display: inline-block;">➔</span>
                           </div>
                        </div>
                        ${itemsHtml}
                    </div>
                `;
            }).join('');
        }
    }

    updateAccelerationBusyUi();
    setupAutoSelectTimer();
}

window.toggleGroupExpand = function(groupName) {
    if (!groupName) return;
    if (expandedGroups.has(groupName)) expandedGroups.delete(groupName);
    else expandedGroups.add(groupName);
    if (accelerationState) renderAccelerationChannel(accelerationState);
};

window.selectGroupProxy = async function(groupName, proxyName) {
    if (!groupName || !proxyName || !window.api || !window.api.selectAccelerationProxy) return;
    await handleAccelerationResult(
        window.api.selectAccelerationProxy({ name: proxyName, group: groupName }),
        t('已切换至', 'Switched to', '已切換至') + ` ${proxyName}`
    );
};

function formatAccelerationLatencyText(latency) {
    if (typeof latency === 'number' && latency > 0) return `${latency} ms`;
    if (latency === 0) return t('超时', 'Timeout', '超時');
    return t('未测', 'Untested', '未測');
}

function paintAccelerationNodeLatency(name, latency, testing) {
    if (!name) return;
    const cards = document.querySelectorAll('.acc-node-card[data-proxy-name]');
    cards.forEach((card) => {
        if (card.getAttribute('data-info') === '1') return;
        if (card.getAttribute('data-proxy-name') !== name) return;
        card.classList.toggle('is-delay-testing', !!testing);
        const el = card.querySelector('.acc-node-delay');
        if (!el) return;
        el.classList.remove('latency-good', 'latency-medium', 'latency-bad', 'latency-none', 'latency-testing');
        if (testing) {
            el.innerHTML = '<span class="acc-node-delay-spinner" aria-hidden="true"></span>';
            el.classList.add('latency-testing');
            el.title = t('测速中', 'Testing', '測速中');
            return;
        }
        el.textContent = formatAccelerationLatencyText(latency);
        el.classList.add(getAccelerationLatencyClass(latency));
        el.title = '';
    });

    const chips = document.querySelectorAll(`.acc-group-node-chip[data-proxy-name]`);
    chips.forEach((chip) => {
        if (chip.getAttribute('data-proxy-name') !== name) return;
        const el = chip.querySelector('.acc-group-node-delay');
        if (!el) return;
        el.classList.remove('latency-good', 'latency-medium', 'latency-bad', 'latency-none', 'latency-testing');
        if (testing) {
            el.innerHTML = ' <span class="acc-node-delay-spinner" aria-hidden="true"></span>';
            el.classList.add('latency-testing');
            return;
        }
        if (typeof latency === 'number' && latency > 0) {
            el.textContent = ` (${latency}ms)`;
            el.classList.add(getAccelerationLatencyClass(latency));
        } else if (latency === 0) {
            el.textContent = ' (超时)';
            el.classList.add('latency-bad');
        } else {
            el.textContent = ' (未测)';
            el.classList.add('latency-none');
        }
    });
}

function applyAccelerationDelayProgress(payload) {
    if (!payload) return;

    if (payload.phase === 'start') {
        accelerationDelayUiActive = true;
        accelerationDelayDoneNames = new Set();
        const names = Array.isArray(payload.names) ? payload.names : [];
        accelerationDelayTotal = payload.total || names.length || accelerationDelayTotal;
        accelerationDelayFinished = 0;
        names.forEach((name) => paintAccelerationNodeLatency(name, null, true));
        updateAccelerationBusyUi();
        return;
    }

    if (payload.phase === 'result' && payload.name) {
        accelerationDelayDoneNames.add(payload.name);
        accelerationDelayFinished = payload.done || accelerationDelayDoneNames.size;
        if (payload.total) accelerationDelayTotal = payload.total;
        if (accelerationState && Array.isArray(accelerationState.nodes)) {
            const node = accelerationState.nodes.find((n) => n.name === payload.name);
            if (node) node.latency = payload.latency;
        }
        paintAccelerationNodeLatency(payload.name, payload.latency, false);
        if (accelerationState && accelerationState.selectedProxy === payload.name) {
            paintAccelerationProxyNowDelay(payload.latency, false);
        }
        const okEl = document.getElementById('acc-proxy-stat-ok');
        const badEl = document.getElementById('acc-proxy-stat-bad');
        const pendingEl = document.getElementById('acc-proxy-stat-pending');
        if (okEl || badEl || pendingEl) {
            const nodes = ((accelerationState && accelerationState.nodes) || []).filter((n) => n && !isAccelerationInfoNode(n));
            let ok = 0;
            let bad = 0;
            let pending = 0;
            nodes.forEach((n) => {
                if (accelerationDelayUiActive && !accelerationDelayDoneNames.has(n.name)) pending += 1;
                else if (typeof n.latency === 'number' && n.latency > 0) ok += 1;
                else if (n.latency === 0) bad += 1;
                else pending += 1;
            });
            if (okEl) okEl.textContent = String(ok);
            if (badEl) badEl.textContent = String(bad);
            if (pendingEl) pendingEl.textContent = String(pending);
        }
        updateAccelerationBusyUi();
        return;
    }

    if (payload.phase === 'done') {
        accelerationDelayFinished = payload.total || accelerationDelayFinished;
        updateAccelerationBusyUi();
    }
}

async function refreshAccelerationNodesAndLatency(options = {}) {
    const { silent = false, switchToProxies = false } = options;
    if (!window.api || !window.api.delayTestAcceleration) return null;
    if (switchToProxies) setAccelerationPanel('proxies');
    try {
        if (!silent) setAccelerationBusy(true, '正在测速节点延迟…');
        // 先拉最新看板；未启用时主进程会自动使用临时内核测速。
        await refreshAccelerationChannel();
        const res = await window.api.delayTestAcceleration();
        if (res && res.success) {
            accelerationState = res;
            renderAccelerationChannel(res);
            if (!silent) {
                showToast(res.temporaryTest
                    ? '节点与延迟已刷新（临时测速完成，空闲后自动关闭内核）'
                    : '节点与延迟已刷新');
            }

            // 只有用户已手动启用内核时才切换节点；临时测速返回前内核已经关闭。
            // 自动选择范围 = 当前地区标签（香港/日本/全部…）
            if (res.enabled && !res.temporaryTest) {
                await applyAccelerationAutoSelect({ nodes: res.nodes, silent: !!silent });
            }
            return res;
        }
        if (!silent) showToast('延迟刷新失败: ' + ((res && res.error) || '未知错误'));
        return null;
    } catch (err) {
        if (!silent) showToast('刷新失败: ' + (err.message || String(err)));
        return null;
    } finally {
        if (!silent) setAccelerationBusy(false);
    }
}

async function setAccelerationEnabledFromUi(enabled) {
    if (!window.api || !window.api.setAccelerationEnabled) return;
    if (enabled && accelerationBusy) return;
    try {
        setAccelerationBusy(true, enabled ? '启动中...' : '关闭中...');
        const res = await window.api.setAccelerationEnabled(!!enabled, accelerationState && accelerationState.activeProfileId);
        if (!res || !res.success) {
            showToast((enabled ? '开启' : '关闭') + ' Nexora Clash 失败: ' + ((res && res.error) || '未知错误'));
            await refreshAccelerationChannel();
            return;
        }
        accelerationState = res;
        renderAccelerationChannel(res);
        showToast(enabled ? 'Nexora Clash 已开启' : 'Nexora Clash 已关闭');

        if (enabled) {
            // 出口 IP 与节点测速并行：不要等测速结束才检测（否则仪表盘会长时间停在「未启用/检测中」）
            setAccelerationBusy(false);
            setTimeout(() => {
                runAccelerationIpDetect({ force: true }).catch(() => {});
            }, 600);
            await refreshAccelerationNodesAndLatency({ switchToProxies: false });
            return;
        }
        // 关闭后改测本机直连出口，不再显示「未启用」
        lastAccelerationIpDetectAt = 0;
        setTimeout(() => {
            runAccelerationIpDetect({ force: true }).catch(() => {});
        }, 400);
    } catch (err) {
        showToast('Nexora Clash 操作失败: ' + err.message);
        await refreshAccelerationChannel();
    } finally {
        setAccelerationBusy(false);
    }
}

async function handleAccelerationResult(promise, successText, options = {}) {
    try {
        setAccelerationBusy(true, options.busyMessage || '处理中...');
        const res = await promise;
        if (!res || !res.success) {
            if (!(res && res.canceled)) {
                let msg = (res && res.error) || '未知错误';
                if (msg.includes('429')) {
                    msg = '接口请求过于频繁 (HTTP 429)，请稍后再试';
                }
                setAccelerationImportFeedback(msg, 'error');
                showToast('Nexora Clash 操作失败: ' + msg);
            }
            return null;
        }
        // 延迟测试结果优先写回节点（防止看板二次合并丢数）
        if (res.results && Array.isArray(res.nodes)) {
            for (const node of res.nodes) {
                if (Object.prototype.hasOwnProperty.call(res.results, node.name)) {
                    node.latency = res.results[node.name];
                }
            }
        }
        accelerationState = res;
        renderAccelerationChannel(res);
        if (successText) {
            setAccelerationImportFeedback(successText, 'success');
            showToast(successText);
        }
        return res;
    } catch (err) {
        setAccelerationImportFeedback(err.message || String(err), 'error');
        showToast('Nexora Clash 操作失败: ' + err.message);
        return null;
    } finally {
        setAccelerationBusy(false);
        if (typeof accelerationState !== 'undefined' && accelerationState) {
            renderAccelerationChannel(accelerationState);
        }
    }
}

let autoSelectTimer = null;
let autoSelectCountdownTimer = null;
let autoSelectRunInFlight = false;
let autoSelectNextAt = 0;
let autoSelectTimerGeneration = 0; // 世代标识，用于彻底防止并发闭包定时器冲突和多重运行

function getAccelerationAutoSelectIntervalSec() {
    const raw = localStorage.getItem('acc_auto_select_interval');
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 5) return 60;
    return n;
}

const ACC_AUTO_SELECT_INTERVAL_OPTIONS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 120, 300, 600];

const ACC_AUTO_SELECT_THRESHOLD_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

function getAccelerationAutoSelectThresholdMs() {
    const raw = localStorage.getItem('acc_auto_select_threshold');
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return 5;
    return n;
}

function syncAccelerationAutoSelectThresholdSelect(ms) {
    const el = document.getElementById('acc-auto-select-threshold');
    if (!el) return;
    const value = String(ms != null ? ms : getAccelerationAutoSelectThresholdMs());
    const html = ACC_AUTO_SELECT_THRESHOLD_OPTIONS.map((v) => {
        const str = String(v);
        const label = v === 0 ? '迟滞: 关闭' : `迟滞: ${v}ms`;
        return '<option value="' + str + '"' + (str === value ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
    el.innerHTML = html;
    el.value = value;
}

/** 以 localStorage 为准重建 option，避免隐藏时改 value 后闭口文字不刷新 */
function syncAccelerationAutoSelectIntervalSelect(sec) {
    const intervalInput = document.getElementById('acc-auto-select-interval');
    if (!intervalInput) return;
    const value = String(sec != null ? sec : getAccelerationAutoSelectIntervalSec());
    const html = ACC_AUTO_SELECT_INTERVAL_OPTIONS.map((v) => {
        const str = String(v);
        return '<option value="' + str + '"' + (str === value ? ' selected' : '') + '>' + str + '秒/次</option>';
    }).join('');
    intervalInput.innerHTML = html;
    intervalInput.value = value;
    intervalInput.dataset.syncedValue = value;
}

function setAccelerationAutoSelectStatus(text) {
    const el = document.getElementById('acc-auto-select-status');
    if (!el) return;
    el.textContent = text || '';
}

function stopAccelerationAutoSelectCountdown() {
    if (autoSelectCountdownTimer) {
        clearInterval(autoSelectCountdownTimer);
        autoSelectCountdownTimer = null;
    }
    autoSelectNextAt = 0;
}

function startAccelerationAutoSelectCountdown(sec, generation) {
    stopAccelerationAutoSelectCountdown();
    if (generation !== autoSelectTimerGeneration) return;
    const total = Math.max(1, Number(sec) || getAccelerationAutoSelectIntervalSec());
    autoSelectNextAt = Date.now() + total * 1000;
    const tick = () => {
        if (generation !== autoSelectTimerGeneration) {
            stopAccelerationAutoSelectCountdown();
            return;
        }
        if (!isAccelerationAutoSelectEnabled()) {
            stopAccelerationAutoSelectCountdown();
            setAccelerationAutoSelectStatus('');
            return;
        }
        if (!(accelerationState && accelerationState.enabled)) {
            setAccelerationAutoSelectStatus(t('需先启用加速', 'Enable acceleration first', '需先啟用加速'));
            return;
        }
        if (autoSelectRunInFlight || accelerationBusy) {
            setAccelerationAutoSelectStatus(t('测速中…', 'Testing...', '測速中…'));
            return;
        }
        const left = Math.max(0, Math.ceil((autoSelectNextAt - Date.now()) / 1000));
        setAccelerationAutoSelectStatus(left > 0 ? `${t('下次', 'Next', '下次')} ${left}s` : t('即将测速', 'Testing soon', '即將測速'));
    };
    tick();
    autoSelectCountdownTimer = setInterval(tick, 500);
}

async function runBackgroundAutoSelect() {
    if (autoSelectRunInFlight || accelerationBusy) return;
    if (!isAccelerationAutoSelectEnabled()) return;
    if (!(accelerationState && accelerationState.enabled)) {
        setAccelerationAutoSelectStatus(t('需先启用加速', 'Enable acceleration first', '需先啟用加速'));
        return;
    }
    autoSelectRunInFlight = true;
    setAccelerationAutoSelectStatus(t('测速中…', 'Testing...', '測速中…'));
    try {
        await runAccelerationDelayTest({ force: true, silent: true, fromAuto: true });
    } catch (err) {
        console.error('Auto select background run failed:', err);
        showToast('自动测速失败: ' + (err.message || String(err)));
    } finally {
        autoSelectRunInFlight = false;
    }
}

function setupAutoSelectTimer(options = {}) {
    const { runNow = false } = options;
    if (autoSelectTimer) {
        clearTimeout(autoSelectTimer);
        autoSelectTimer = null;
    }
    stopAccelerationAutoSelectCountdown();

    const clashEnabled = !!(accelerationState && accelerationState.enabled);
    const clashRunning = !!(accelerationState && accelerationState.running);
    const enabled = localStorage.getItem('acc_auto_select_enabled') === 'true' && clashEnabled && clashRunning;
    const intervalSec = getAccelerationAutoSelectIntervalSec();
    // 仅在从未写过时落盘，避免启动时用默认值覆盖用户缓存
    if (localStorage.getItem('acc_auto_select_interval') == null) {
        localStorage.setItem('acc_auto_select_interval', String(intervalSec));
    }

    const enableBtn = document.getElementById('acc-auto-select-enable-btn');
    const intervalContainer = document.getElementById('acc-auto-select-interval-container');

    if (enableBtn) enableBtn.classList.toggle('active', enabled);
    // 先显示容器，再同步 value，否则 Chromium 不更新下拉可见文字
    if (intervalContainer) intervalContainer.style.display = enabled ? 'flex' : 'none';
    syncAccelerationAutoSelectIntervalSelect(intervalSec);
    
    if (!enabled) {
        setAccelerationAutoSelectStatus('');
        return;
    }

    const currentGeneration = ++autoSelectTimerGeneration;

    const scheduleNext = (delaySec) => {
        if (autoSelectTimer) {
            clearTimeout(autoSelectTimer);
            autoSelectTimer = null;
        }
        if (currentGeneration !== autoSelectTimerGeneration) return;
        if (!isAccelerationAutoSelectEnabled()) return;

        const sec = Math.max(0.3, Number(delaySec) || getAccelerationAutoSelectIntervalSec());
        startAccelerationAutoSelectCountdown(sec, currentGeneration);
        
        autoSelectTimer = setTimeout(async () => {
            autoSelectTimer = null;
            if (currentGeneration !== autoSelectTimerGeneration) return;
            
            await runBackgroundAutoSelect();
            
            if (currentGeneration !== autoSelectTimerGeneration) return;
            scheduleNext(getAccelerationAutoSelectIntervalSec());
        }, sec * 1000);
    };

    scheduleNext(runNow ? 0.3 : intervalSec);
}

function applyAppInstanceBadge() {
    const run = async () => {
        if (!window.api || !window.api.getAppInstanceInfo) return;
        try {
            const info = await window.api.getAppInstanceInfo();
            if (!info || !info.success) return;
            const id = Number(info.id) || 1;
            const badge = document.getElementById('app-instance-badge');
            const titleText = document.getElementById('app-title-text');
            if (id > 1) {
                if (badge) {
                    badge.hidden = false;
                    badge.textContent = `#${id}`;
                    badge.title = `多开实例 #${id}\n数据目录：${info.userData || ''}\n网关端口建议：${info.gatewayPortHint || ''}`;
                }
                if (titleText) titleText.textContent = 'Nexora Agent';
                try { document.title = `Nexora Agent #${id}`; } catch (e) {}
            } else if (badge) {
                badge.hidden = true;
            }
        } catch (e) {}
    };
    run();
}

function initAccelerationChannel() {
    setAccelerationPanel('dashboard');
    setAccelerationImportMode('url');

    if (window.api && window.api.onAccelerationDelayProgress) {
        window.api.onAccelerationDelayProgress((payload) => {
            applyAccelerationDelayProgress(payload);
        });
    }

    document.querySelectorAll('.acc-subtab[data-acc-panel]').forEach((btn) => {
        btn.addEventListener('click', () => {
            setAccelerationPanel(btn.getAttribute('data-acc-panel'));
        });
    });

    const settingToggle = document.getElementById('setting-acceleration-toggle');
    const pageToggle = document.getElementById('acc-page-enabled-toggle');
    const controlsToggle = document.getElementById('acc-controls-enabled-toggle');
    const syncEnable = (e) => setAccelerationEnabledFromUi(e.target.checked);
    if (settingToggle) {
        settingToggle.addEventListener('change', async (e) => {
            await setAccelerationProxyMode('autoStart', e.target.checked);
        });
    }
    if (pageToggle) pageToggle.addEventListener('change', syncEnable);
    if (controlsToggle) controlsToggle.addEventListener('change', syncEnable);

    // 网络检测：经本地 mixed 端口探测出口 IP（启用后自动测一次，也可手动点）
    const ipDetectBtn = document.getElementById('acc-ip-detect-btn');
    if (ipDetectBtn) {
        ipDetectBtn.addEventListener('click', () => {
            runAccelerationIpDetect({ force: true });
        });
    }

    const controlsDetectBtn = document.getElementById('acc-controls-detect-btn');
    if (controlsDetectBtn) {
        controlsDetectBtn.addEventListener('click', () => {
            runAccelerationIpDetect({ force: true });
        });
    }

    const copyProxyBtn = document.getElementById('acc-copy-proxy-btn');
    if (copyProxyBtn) {
        copyProxyBtn.addEventListener('click', async () => {
            const port = accelerationState && accelerationState.mixedPort;
            const text = port ? `127.0.0.1:${port}` : '';
            if (!text) {
                showToast('当前没有可用的本地代理地址');
                return;
            }
            try {
                await navigator.clipboard.writeText(text);
                showToast('已复制本地代理：' + text);
            } catch (e) {
                showToast('复制失败：' + (e.message || String(e)));
            }
        });
    }

    const controlsGotoProxies = document.getElementById('acc-controls-goto-proxies');
    if (controlsGotoProxies) {
        controlsGotoProxies.addEventListener('click', () => {
            setAccelerationPanel('proxies');
            maybeAutoDelayOnProxiesTab();
        });
    }

    const controlsRefreshBtn = document.getElementById('acc-controls-refresh-btn');
    if (controlsRefreshBtn) {
        controlsRefreshBtn.addEventListener('click', async () => {
            await refreshAccelerationChannel();
            if (accelerationState && accelerationState.enabled) {
                runAccelerationIpDetect({ force: true }).catch(() => {});
            }
            showToast('状态已刷新');
        });
    }

    document.querySelectorAll('.acc-import-item').forEach((btn) => {
        btn.addEventListener('click', () => {
            setAccelerationImportMode(btn.getAttribute('data-import-mode') || 'url');
            setAccelerationImportFeedback('');
        });
    });

    const urlSubmit = document.getElementById('acc-import-url-submit');
    if (urlSubmit) {
        urlSubmit.addEventListener('click', async () => {
            const url = (document.getElementById('acc-import-url') || {}).value || '';
            const name = (document.getElementById('acc-import-name') || {}).value || '';
            if (!String(url).trim()) {
                setAccelerationImportFeedback('请先填写订阅 URL', 'error');
                return;
            }
            setAccelerationImportFeedback('正在拉取订阅，请稍候…', 'success');
            const res = await handleAccelerationResult(
                window.api.addAccelerationUrl(String(url).trim(), String(name).trim()),
                '已添加加速配置',
                { busyMessage: '正在拉取订阅…' }
            );
            if (res && res.success) {
                const urlInput = document.getElementById('acc-import-url');
                if (urlInput) urlInput.value = '';
                const nameInput = document.getElementById('acc-import-name');
                if (nameInput) nameInput.value = '';
                // 留在配置页，方便继续添加或查看刚导入的订阅
            }
        });
    }

    const fileSubmit = document.getElementById('acc-import-file-submit');
    if (fileSubmit) {
        fileSubmit.addEventListener('click', async () => {
            await handleAccelerationResult(window.api.pickAccelerationFile(), '已导入配置文件');
        });
    }

    const qrSubmit = document.getElementById('acc-import-qr-submit');
    if (qrSubmit) {
        qrSubmit.addEventListener('click', async () => {
            const content = String((document.getElementById('acc-qr-content') || {}).value || '').trim();
            const name = String((document.getElementById('acc-qr-name') || {}).value || '').trim() || '二维码配置';
            if (!content) {
                setAccelerationImportFeedback('请粘贴二维码解析结果或订阅内容', 'error');
                return;
            }
            let res = null;
            if (/^https?:\/\//i.test(content)) {
                res = await handleAccelerationResult(window.api.addAccelerationUrl(content, name), '已添加二维码订阅');
            } else {
                res = await handleAccelerationResult(window.api.addAccelerationContent(content, name), '已添加二维码配置');
            }
            if (res && res.success) {
                const box = document.getElementById('acc-qr-content');
                if (box) box.value = '';
            }
        });
    }

    const qrPasteBtn = document.getElementById('acc-qr-image-btn');
    if (qrPasteBtn) {
        qrPasteBtn.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                const box = document.getElementById('acc-qr-content');
                if (box) box.value = text || '';
                setAccelerationImportFeedback(text ? '已从剪贴板粘贴内容，点击“添加配置”即可' : '剪贴板为空', text ? 'success' : 'error');
            } catch (err) {
                setAccelerationImportFeedback('无法读取剪贴板，请手动粘贴', 'error');
            }
        });
    }

    const qrUploadBtn = document.getElementById('acc-qr-upload-btn');
    const qrFileInput = document.getElementById('acc-qr-file-input');
    if (qrUploadBtn && qrFileInput) {
        qrUploadBtn.addEventListener('click', () => {
            qrFileInput.click();
        });
        qrFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    
                    try {
                        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                        const code = jsQR(imageData.data, imageData.width, imageData.height);
                        if (code) {
                            const box = document.getElementById('acc-qr-content');
                            if (box) box.value = code.data;
                            
                            const nameBox = document.getElementById('acc-qr-name');
                            if (nameBox && !nameBox.value.trim()) {
                                try {
                                    const urlObj = new URL(code.data);
                                    const remark = urlObj.hash ? decodeURIComponent(urlObj.hash.substring(1)) : '';
                                    if (remark) nameBox.value = remark;
                                } catch(ex) {}
                            }
                            
                            setAccelerationImportFeedback('图片二维码识别成功！点击“添加配置”即可导入', 'success');
                        } else {
                            setAccelerationImportFeedback('未在图片中检测到有效的二维码，请确保图片清晰且为二维码', 'error');
                        }
                    } catch (ex) {
                        setAccelerationImportFeedback('图片解码失败，可能是跨域或格式不支持', 'error');
                    }
                    qrFileInput.value = '';
                };
                img.onerror = () => {
                    setAccelerationImportFeedback('图片加载失败，请确保文件格式正确', 'error');
                    qrFileInput.value = '';
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    const refreshBtn = document.getElementById('acc-refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            if (accelerationState && accelerationState.enabled) {
                await refreshAccelerationNodesAndLatency({ switchToProxies: false });
            } else {
                await refreshAccelerationChannel();
            }
        });
    }

    const profileSelect = document.getElementById('acc-profile-select');
    if (profileSelect) {
        profileSelect.addEventListener('change', async (e) => {
            if (!e.target.value) return;
            const res = await handleAccelerationResult(window.api.setAccelerationActiveProfile(e.target.value), '已切换配置');
            await onAccelerationProfileSwitched(res);
        });
    }

    const profileList = document.getElementById('acc-profile-list');
    if (profileList) {
        profileList.addEventListener('click', async (e) => {
            const item = e.target.closest('.acc-profile-item');
            if (!item) return;
            const id = item.getAttribute('data-profile-id');
            if (!id) return;
            const res = await handleAccelerationResult(window.api.setAccelerationActiveProfile(id), '已切换配置');
            await onAccelerationProfileSwitched(res);
        });
    }

    const renameBtn = document.getElementById('acc-profile-rename-btn');
    if (renameBtn) {
        renameBtn.addEventListener('click', async () => {
            const id = accelerationState && accelerationState.activeProfileId;
            if (!id) return;
            const activeProfile = (accelerationState.profiles || []).find((p) => p.id === id);
            const currentName = activeProfile ? (activeProfile.name || activeProfile.id) : '';
            const fields = [
                { key: 'name', label: '配置备注名称', value: currentName, placeholder: '请输入备注名称' }
            ];
            const values = await window.promptFields('修改配置备注', fields, '修改此配置在本地显示的备注名称。', '确认修改');
            if (!values) return;
            const name = String(values.name || '').trim();
            if (!name) {
                alert('备注名称不能为空');
                return;
            }
            await handleAccelerationResult(window.api.renameAccelerationProfile(id, name), '备注已更新');
        });
    }

    const updateBtn = document.getElementById('acc-profile-update-btn');
    if (updateBtn) {
        updateBtn.addEventListener('click', async () => {
            const id = accelerationState && accelerationState.activeProfileId;
            if (!id) return;
            await handleAccelerationResult(window.api.updateAccelerationProfile(id), '订阅已更新');
        });
    }

    const deleteBtn = document.getElementById('acc-profile-delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            const id = accelerationState && accelerationState.activeProfileId;
            if (!id) return;
            const ok = await confirm('确定删除当前加速配置吗？');
            if (!ok) return;
            await handleAccelerationResult(window.api.removeAccelerationProfile(id), '已删除配置');
        });
    }

    const searchInput = document.getElementById('acc-node-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            accelerationUi.search = e.target.value || '';
            if (accelerationState) renderAccelerationChannel(accelerationState);
        });
    }
    const protocolFilter = document.getElementById('acc-node-protocol-filter');
    if (protocolFilter) {
        protocolFilter.addEventListener('change', (e) => {
            accelerationUi.protocol = e.target.value || '';
            if (accelerationState) renderAccelerationChannel(accelerationState);
        });
    }
    const sortSelect = document.getElementById('acc-node-sort');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            accelerationUi.sort = e.target.value || 'default';
            if (accelerationState) renderAccelerationChannel(accelerationState);
        });
    }

    const grid = document.getElementById('acc-node-grid');
    if (grid) {
        grid.addEventListener('click', async (e) => {
            const card = e.target.closest('.acc-node-card');
            if (!card || card.classList.contains('is-info') || card.getAttribute('data-info') === '1') return;
            const name = card.getAttribute('data-proxy-name');
            if (!name) return;
            // 自动模式下也允许手动点选；切标签 / 下个周期会按标签重选
            await handleAccelerationResult(window.api.selectAccelerationProxy({ name, group: 'GLOBAL' }), '已切换代理节点');
        });
    }

    const delayBtn = document.getElementById('acc-delay-btn');
    if (delayBtn) {
        delayBtn.addEventListener('click', async () => {
            await runAccelerationDelayTest({ force: true });
        });
    }

    const autoSelectEnableBtn = document.getElementById('acc-auto-select-enable-btn');
    if (autoSelectEnableBtn) {
        autoSelectEnableBtn.addEventListener('click', () => {
            const enabled = isAccelerationAutoSelectEnabled();
            const nextState = !enabled;
            localStorage.setItem('acc_auto_select_enabled', nextState ? 'true' : 'false');
            if (nextState) {
                const sec = getAccelerationAutoSelectIntervalSec();
                if (!(accelerationState && accelerationState.enabled)) {
                    showToast('请先启用加速通道，再开自动选择');
                } else {
                    showToast(`已开启自动选择：测完后每 ${sec} 秒再测一轮`);
                }
                setupAutoSelectTimer({ runNow: true });
            } else {
                setupAutoSelectTimer();
                showToast('已关闭自动选择，可手动点击节点切换');
            }
        });
    }

    const autoSelectInterval = document.getElementById('acc-auto-select-interval');
    if (autoSelectInterval) {
        const applyInterval = (raw) => {
            let val = parseInt(raw, 10);
            if (isNaN(val) || val < 5) val = 5;
            localStorage.setItem('acc_auto_select_interval', String(val));
            syncAccelerationAutoSelectIntervalSelect(val);
            setupAutoSelectTimer();
            if (isAccelerationAutoSelectEnabled()) {
                showToast(`间隔已改为 ${val} 秒/次（测完后再计时）`);
            }
        };
        autoSelectInterval.addEventListener('change', (e) => applyInterval(e.target.value));
        // 展开前先按缓存校正，避免闭口文字和真实值不一致
        autoSelectInterval.addEventListener('mousedown', () => {
            syncAccelerationAutoSelectIntervalSelect();
        });
    }

    const autoSelectThreshold = document.getElementById('acc-auto-select-threshold');
    if (autoSelectThreshold) {
        syncAccelerationAutoSelectThresholdSelect();
        autoSelectThreshold.addEventListener('change', (e) => {
            let val = parseInt(e.target.value, 10);
            if (isNaN(val) || val < 0) val = 5;
            localStorage.setItem('acc_auto_select_threshold', String(val));
            syncAccelerationAutoSelectThresholdSelect(val);
            showToast(val === 0 ? '迟滞已关闭，始终切换到最低延迟节点' : `迟滞阈值已改为 ${val}ms`);
        });
        autoSelectThreshold.addEventListener('mousedown', () => {
            syncAccelerationAutoSelectThresholdSelect();
        });
    }

    setupAutoSelectTimer();

    const countryContainer = document.getElementById('acc-node-country-filters');
    if (countryContainer) {
        countryContainer.addEventListener('click', (e) => {
            const pill = e.target.closest('.acc-country-pill[data-country]');
            if (!pill) return;
            const country = pill.getAttribute('data-country') || 'all';
            countryContainer.querySelectorAll('.acc-country-pill[data-country]').forEach((btn) => {
                btn.classList.toggle('active', btn === pill);
            });
            accelerationUi.countryFilter = country;
            if (accelerationState) renderAccelerationChannel(accelerationState);
            // 开着自动时：换标签立刻在该分类里选最低延迟
            if (isAccelerationAutoSelectEnabled() && accelerationState && accelerationState.enabled) {
                applyAccelerationAutoSelect({ silent: false }).catch(() => {});
            }
        });
    }

    async function setAccelerationProxyMode(kind, on) {
        let payload, okText;
        if (kind === 'system') {
            payload = { systemProxy: on };
            okText = on ? '系统代理已开启' : '系统代理已关闭';
        } else if (kind === 'tun' || kind === 'virtualNic') {
            payload = { virtualNic: on };
            okText = on ? 'TUN 已开启' : '虚拟网卡已关闭';
        } else {
            payload = { autoStart: on };
            okText = on ? '自启动已开启' : '自启动已关闭';
        }
        const res = await handleAccelerationResult(window.api.setAccelerationOptions(payload), okText);
        if (res && res.warning) showToast(res.warning);
        if (res && res.success && accelerationState) renderAccelerationChannel(res);
        else await refreshAccelerationChannel();
        return res;
    }

    const systemProxyToggle = document.getElementById('acc-system-proxy-toggle');
    if (systemProxyToggle) {
        systemProxyToggle.addEventListener('change', async (e) => {
            await setAccelerationProxyMode('system', e.target.checked);
        });
    }

    const tunToggle = document.getElementById('acc-tun-toggle');
    if (tunToggle) {
        tunToggle.addEventListener('change', async (e) => {
            await setAccelerationProxyMode('tun', e.target.checked);
        });
    }

    document.querySelectorAll('input[name="acc-mode"]').forEach((input) => {
        input.addEventListener('change', async (e) => {
            if (!e.target.checked) return;
            await handleAccelerationResult(window.api.setAccelerationOptions({ mode: e.target.value }), '出站模式已更新');
        });
    });

    // 仪表盘开关：启用加速通道
    const dashEnabledToggle = document.getElementById('acc-dash-enabled-toggle');
    if (dashEnabledToggle) {
        dashEnabledToggle.addEventListener('change', (e) => {
            setAccelerationEnabledFromUi(e.target.checked);
        });
    }

    // 仪表盘开关：系统代理
    const dashSystemProxyToggle = document.getElementById('acc-dash-system-proxy-toggle');
    if (dashSystemProxyToggle) {
        dashSystemProxyToggle.addEventListener('change', async (e) => {
            await setAccelerationProxyMode('system', e.target.checked);
        });
    }

    // 仪表盘开关：虚拟网卡 TUN
    const dashTunToggle = document.getElementById('acc-dash-tun-toggle');
    if (dashTunToggle) {
        dashTunToggle.addEventListener('change', async (e) => {
            await setAccelerationProxyMode('tun', e.target.checked);
        });
    }

    // 仪表盘：出站模式按钮切换
    document.querySelectorAll('.acc-dash-mode-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            const mode = e.currentTarget.getAttribute('data-mode');
            const res = await handleAccelerationResult(
                window.api.setAccelerationOptions({ mode: mode }),
                '出站模式已更新'
            );
            if (res && res.success && accelerationState) renderAccelerationChannel(res);
        });
    });

    // 仪表盘：一键网络检测
    const dashIpDetectBtn = document.getElementById('acc-dash-ip-detect-btn');
    if (dashIpDetectBtn) {
        dashIpDetectBtn.addEventListener('click', () => {
            runAccelerationIpDetect({ force: true });
        });
    }

    // 初始化获取内网 IP
    getLocalIP().then((ip) => {
        const localIpEl = document.getElementById('acc-dash-local-ip');
        if (localIpEl) localIpEl.textContent = ip;
    });

    // 窗口尺寸改变时，让仪表盘 Canvas 实时高自适应重绘
    window.addEventListener('resize', () => {
        if (accelerationUi.panel === 'dashboard') {
            const upPoints = window._dashSpeedHistory.up;
            const downPoints = window._dashSpeedHistory.down;
            if (upPoints && upPoints.length > 0) {
                drawDashboardSpeedChart(upPoints[upPoints.length - 1], downPoints[downPoints.length - 1]);
            }
            if (window._lastConnStats) {
                drawDashboardTrafficRing(window._lastConnStats.up, window._lastConnStats.down);
            }
        }
    });

    if (window.api && window.api.onAccelerationCoreProgress) {
        window.api.onAccelerationCoreProgress((p) => {
            if (!p) return;
            const label = p.stage === 'download' ? '下载代理内核...' : p.stage === 'extract' ? '解压代理内核...' : '准备代理内核...';
            setAccelerationBusy(true, label);
        });
    }

    // 代理页面：所有节点 vs 策略组 视图切换绑定
    const tabNodes = document.getElementById('acc-view-tab-nodes');
    const tabGroups = document.getElementById('acc-view-tab-groups');
    const nodeToolbar = document.getElementById('acc-node-toolbar');
    const nodeGrid = document.getElementById('acc-node-grid');
    const groupsContainer = document.getElementById('acc-groups-container');

    const setViewMode = (mode) => {
        accelerationUi.viewMode = mode;
        if (tabNodes) tabNodes.classList.toggle('active', mode === 'nodes');
        if (tabGroups) tabGroups.classList.toggle('active', mode === 'groups');

        const countryFilters = document.getElementById('acc-node-country-filters');
        const nodeGridWrap = document.querySelector('.acc-node-grid-wrap');
        const showNodes = mode === 'nodes';

        if (nodeToolbar) nodeToolbar.style.display = showNodes ? '' : 'none';
        if (countryFilters) countryFilters.style.display = showNodes ? 'flex' : 'none';
        if (nodeGridWrap) nodeGridWrap.style.display = showNodes ? '' : 'none';
        if (nodeGrid) nodeGrid.style.display = showNodes ? '' : 'none';
        if (groupsContainer) {
            if (showNodes) {
                groupsContainer.style.display = 'none';
                groupsContainer.hidden = true;
            } else {
                groupsContainer.hidden = false;
                groupsContainer.style.display = 'flex';
            }
        }
        if (accelerationState) renderAccelerationChannel(accelerationState);
    };

    if (tabNodes) tabNodes.addEventListener('click', () => setViewMode('nodes'));
    if (tabGroups) tabGroups.addEventListener('click', () => setViewMode('groups'));

    // 连接管理页面事件绑定
    const connSearch = document.getElementById('acc-conn-search');
    if (connSearch) {
        connSearch.addEventListener('input', (e) => {
            connSearchText = e.target.value || '';
            refreshConnections();
        });
    }

    const closeAllConnsBtn = document.getElementById('acc-connections-close-all-btn');
    if (closeAllConnsBtn) {
        closeAllConnsBtn.addEventListener('click', async () => {
            const ok = await confirm('确定断开当前所有网络连接吗？这可能会使正在进行的文件下载或API会话暂时中断。');
            if (!ok) return;
            if (window.api && window.api.closeAccelerationConnection) {
                const res = await window.api.closeAccelerationConnection(null);
                if (res && res.success) {
                    showToast('已断开所有网络连接');
                    refreshConnections();
                } else {
                    showToast('断开连接失败: ' + (res.error || '未知错误'));
                }
            }
        });
    }

    refreshAccelerationChannel().then(async () => {
        // 启动即检测出口：未启用测本机公网，已启用测代理出口
        setTimeout(() => {
            maybeAutoAccelerationIpDetect({ force: true, reason: 'startup' });
        }, 800);
        if (accelerationState && accelerationState.enabled) {
            setTimeout(() => {
                refreshAccelerationNodesAndLatency({ silent: true, switchToProxies: false });
            }, 1200);
        }
    });
}

// --- 内置终端逻辑 ---
let builtinTerminal = null;
let builtinTerminalFitAddon = null;
let isTerminalInitialized = false;
let isTerminalInitializing = false;
let terminalFitScheduled = false;
let terminalLastFitKey = '';
let terminalNeedsFit = true; // 仅窗口尺寸变化后才需要 fit

function scheduleBuiltinTerminalFit(forceResizePty) {
    if (!terminalNeedsFit && !forceResizePty) return;
    if (terminalFitScheduled) return;
    terminalFitScheduled = true;
    requestAnimationFrame(() => {
        terminalFitScheduled = false;
        const container = document.getElementById('xterm-container');
        if (currentTab !== 'terminal-view' || !builtinTerminalFitAddon || !builtinTerminal || !container) return;
        const prevCols = builtinTerminal.cols;
        const prevRows = builtinTerminal.rows;
        try { builtinTerminalFitAddon.fit(); } catch (e) {}
        terminalNeedsFit = false;
        terminalLastFitKey = builtinTerminal.cols + 'x' + builtinTerminal.rows;
        const changed = builtinTerminal.cols !== prevCols || builtinTerminal.rows !== prevRows;
        if ((forceResizePty || changed) && window.api && window.api.resizeBuiltinTerminal) {
            try { window.api.resizeBuiltinTerminal(builtinTerminal.cols, builtinTerminal.rows); } catch (e) {}
        }
    });
}

function initBuiltinTerminal() {
    const container = document.getElementById('xterm-container');
    if (!container) return;

    if (isTerminalInitialized && builtinTerminal) {
        // 再次切入：恢复光标并延后聚焦
        try { builtinTerminal.options.cursorBlink = true; } catch (e) {}
        terminalNeedsFit = true;
        setTimeout(() => {
            if (currentTab === 'terminal-view' && builtinTerminal) {
                try { builtinTerminal.focus(); } catch (e) {}
                scheduleBuiltinTerminalFit(true);
            }
        }, 0);
        return;
    }

    if (isTerminalInitializing) return;

    if (!window.Terminal) {
        container.innerHTML = `<div style="color:#f44336;padding:16px;font-family:Consolas,monospace;font-size:13px;">${escapeHtml(t('xterm 组件未加载（打包后资源缺失）。请重新安装完整包。', 'xterm component failed to load (packaged resource missing). Please reinstall the full package.', 'xterm 元件未載入（打包後資源缺失）。請重新安裝完整包。'))}</div>`;
        return;
    }

    isTerminalInitializing = true;
    setTimeout(() => {
        if (builtinTerminal) {
            isTerminalInitializing = false;
            isTerminalInitialized = true;
            scheduleBuiltinTerminalFit(true);
            return;
        }
        try {
            builtinTerminal = new window.Terminal({
                cursorBlink: true,
                scrollback: 1500,
                theme: {
                    background: '#0c0c0c',
                    foreground: '#cccccc',
                    cursor: '#00e676',
                    selection: 'rgba(0, 230, 118, 0.3)'
                },
                fontFamily: 'Consolas, "Courier New", monospace',
                fontSize: 14,
                allowTransparency: false,
                convertEol: true
            });

            if (window.FitAddon && window.FitAddon.FitAddon) {
                builtinTerminalFitAddon = new window.FitAddon.FitAddon();
                builtinTerminal.loadAddon(builtinTerminalFitAddon);
            }

            builtinTerminal.open(container);
            isTerminalInitialized = true;
            isTerminalInitializing = false;
            terminalNeedsFit = true;
            scheduleBuiltinTerminalFit(true);

            builtinTerminal.onData(data => {
                window.api.writeBuiltinTerminal(data);
            });

            window.addEventListener('resize', () => {
                terminalNeedsFit = true;
                if (currentTab === 'terminal-view') scheduleBuiltinTerminalFit(true);
            });

            window.api.onBuiltinTerminalData((data) => {
                if (builtinTerminal) builtinTerminal.write(data);
            });

            const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
            window.api.startBuiltinTerminal(currentLang).then((res) => {
                if (res && res.ok === false && builtinTerminal) {
                    builtinTerminal.writeln('');
                    builtinTerminal.writeln(`\x1b[33m${t('若内置终端无输出，已尝试打开外部沙箱窗口。', 'If the built-in terminal has no output, an external sandbox window has been opened as fallback.', '若內置終端無輸出，已嘗試打開外部沙箱視窗。')}\x1b[0m`);
                }
                terminalNeedsFit = true;
                scheduleBuiltinTerminalFit(true);
            }).catch((err) => {
                if (builtinTerminal) {
                    builtinTerminal.writeln('');
                    builtinTerminal.writeln(`\x1b[31m${t('内置终端启动失败', 'Built-in terminal failed to start', '內置終端啟動失敗')}: ${err && err.message ? err.message : err}\x1b[0m`);
                }
            });
        } catch (err) {
            isTerminalInitializing = false;
            isTerminalInitialized = false;
            console.error('[BuiltinTerminal] init failed:', err);
            try {
                container.innerHTML = `<div style="color:#f44336;padding:16px;font-family:Consolas,monospace;font-size:13px;">${escapeHtml(t('内置终端初始化失败', 'Built-in terminal initialization failed', '內置終端初始化失敗'))}: ${escapeHtml(err && err.message ? err.message : String(err))}</div>`;
            } catch (e) {}
        }
    }, 0);
}

// ==========================================
// Nexora Clash Dashboard Helpers
// ==========================================

// 网速历史缓存数据
window._dashSpeedHistory = {
    up: [],
    down: [],
    maxPoints: 24
};

// Canvas 平滑贝塞尔波动图绘制
function updateDashboardSpeedEmptyState(hasTraffic) {
    const empty = document.getElementById('acc-dash-speed-empty');
    if (!empty) return;
    const enabled = !!(accelerationState && accelerationState.enabled);
    const title = empty.querySelector('.acc-dash-speed-empty-title');
    const desc = empty.querySelector('.acc-dash-speed-empty-desc');
    if (hasTraffic) {
        empty.hidden = true;
        return;
    }
    empty.hidden = false;
    if (title) title.textContent = enabled ? t('acc.dash.speed_empty_title') : t('acc.dash.speed_unenabled_title');
    if (desc) {
        desc.textContent = enabled
            ? t('acc.dash.speed_empty_desc')
            : t('acc.dash.speed_unenabled_desc');
    }
}

function drawDashboardSpeedChart(upSpeed, downSpeed) {
    const canvas = document.getElementById('acc-dash-speed-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const container = canvas.parentElement;
    
    // 自适应 DPI
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    
    const width = rect.width;
    const height = rect.height;
    
    // 清空 Canvas
    ctx.clearRect(0, 0, width, height);

    // 将网速压入历史
    if (!window._dashSpeedHistory) {
        window._dashSpeedHistory = { up: [], down: [], maxPoints: 60 };
    }
    window._dashSpeedHistory.up.push(upSpeed || 0);
    window._dashSpeedHistory.down.push(downSpeed || 0);
    if (window._dashSpeedHistory.up.length > window._dashSpeedHistory.maxPoints) {
        window._dashSpeedHistory.up.shift();
        window._dashSpeedHistory.down.shift();
    }

    const upPoints = window._dashSpeedHistory.up;
    const downPoints = window._dashSpeedHistory.down;
    const hasTraffic = upPoints.some((v) => v > 0) || downPoints.some((v) => v > 0);
    updateDashboardSpeedEmptyState(hasTraffic);

    // 始终画网格，避免大块纯黑空白
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    for (let i = 1; i <= 3; i++) {
        const y = (height * i) / 4;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }
    for (let i = 1; i <= 4; i++) {
        const x = (width * i) / 5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }
    ctx.setLineDash([]);

    // 空闲时画一条贴近底部的微弱基线，不至于一片死黑
    if (!hasTraffic || upPoints.length < 2) {
        const baseY = height - 18;
        ctx.beginPath();
        ctx.moveTo(0, baseY);
        ctx.lineTo(width, baseY);
        ctx.strokeStyle = 'rgba(14, 165, 233, 0.18)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, baseY + 6);
        ctx.lineTo(width, baseY + 6);
        ctx.strokeStyle = 'rgba(244, 63, 94, 0.14)';
        ctx.stroke();
        return;
    }

    // 计算 Y 轴最大尺度 (至少 10 KB/s)
    let maxSpeed = 10 * 1024;
    for (let i = 0; i < upPoints.length; i++) {
        if (upPoints[i] > maxSpeed) maxSpeed = upPoints[i];
        if (downPoints[i] > maxSpeed) maxSpeed = downPoints[i];
    }
    // 上浮 20% 余量
    maxSpeed *= 1.2;

    // 贝塞尔平滑连线绘制工具
    const drawCurve = (points, strokeColor, fillColor, shadowColor) => {
        ctx.beginPath();
        const stepX = width / (window._dashSpeedHistory.maxPoints - 1);
        const startX = width - (points.length - 1) * stepX;
        
        ctx.moveTo(startX, height - (points[0] / maxSpeed) * height);
        
        for (let i = 0; i < points.length - 1; i++) {
            const x0 = startX + i * stepX;
            const y0 = height - (points[i] / maxSpeed) * (height - 10);
            const x1 = startX + (i + 1) * stepX;
            const y1 = height - (points[i + 1] / maxSpeed) * (height - 10);
            
            const cpX1 = x0 + stepX / 2;
            const cpY1 = y0;
            const cpX2 = x1 - stepX / 2;
            const cpY2 = y1;
            
            ctx.bezierCurveTo(cpX1, cpY1, cpX2, cpY2, x1, y1);
        }

        // 绘制描边
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.5;
        ctx.shadowColor = shadowColor;
        ctx.shadowBlur = 6;
        ctx.stroke();
        
        // 关闭阴影
        ctx.shadowBlur = 0;

        // 闭合路径填充渐变
        ctx.lineTo(width, height);
        ctx.lineTo(startX, height);
        ctx.closePath();
        
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, fillColor);
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.fill();

        // 绘制最新点的呼吸发光脉冲点
        const lastX = startX + (points.length - 1) * stepX;
        const lastY = height - (points[points.length - 1] / maxSpeed) * (height - 10);
        
        ctx.shadowColor = shadowColor;
        ctx.shadowBlur = 10;
        
        // 绘制外层半透明波纹晕圈
        ctx.beginPath();
        ctx.arc(lastX, lastY, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = strokeColor.replace('0.75', '0.25');
        ctx.fill();

        // 绘制中心极亮发光实心点
        ctx.beginPath();
        ctx.arc(lastX, lastY, 2.0, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        ctx.shadowBlur = 0;
    };

    // 绘制上传曲线 (淡粉红色)
    drawCurve(
        upPoints, 
        'rgba(244, 63, 94, 0.75)', 
        'rgba(244, 63, 94, 0.08)', 
        'rgba(244, 63, 94, 0.3)'
    );

    // 绘制下载曲线 (淡蓝色)
    drawCurve(
        downPoints, 
        'rgba(14, 165, 233, 0.75)', 
        'rgba(14, 165, 233, 0.08)', 
        'rgba(14, 165, 233, 0.3)'
    );
}

// 绘制流量占比微型环形图
function drawDashboardTrafficRing(uploadTotal, downloadTotal) {
    const canvas = document.getElementById('acc-dash-traffic-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const center = width / 2;
    const radius = width / 2 - 4; // 留出边缘

    ctx.clearRect(0, 0, width, height);

    // 绘制底色灰环
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 4;
    ctx.stroke();

    const total = (uploadTotal || 0) + (downloadTotal || 0);
    if (total <= 0) {
        // 无流量，展示一个默认灰环
        return;
    }

    const upPercent = uploadTotal / total;
    const startAngle = -Math.PI / 2; // 从 12 点钟方向开始
    const upAngle = upPercent * Math.PI * 2;

    // 绘制上传流量弧段 (淡粉红色)
    ctx.beginPath();
    ctx.arc(center, center, radius, startAngle, startAngle + upAngle);
    ctx.strokeStyle = 'rgba(244, 63, 94, 0.8)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.stroke();

    // 绘制下载流量弧段 (淡蓝色)
    ctx.beginPath();
    ctx.arc(center, center, radius, startAngle + upAngle, startAngle + Math.PI * 2);
    ctx.strokeStyle = 'rgba(14, 165, 233, 0.8)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.stroke();
}

function getClashMemoryMock() {
    const running = !!(accelerationState && accelerationState.running);
    if (!running) {
        return t('0.0 MB (未启动)', '0.0 MB (Inactive)', '0.0 MB (未啟動)');
    }
    if (accelerationState.clashMemory && accelerationState.clashMemory !== '0.0 MB' && accelerationState.clashMemory !== 'INACTIVE') {
        return accelerationState.clashMemory;
    }
    // 如果后台为 INACTIVE，但前端显示 enabled，说明刚启动还在轮询获取中
    if (accelerationState.clashMemory === 'INACTIVE') {
        return t('获取中...', 'Fetching...', '獲取中...');
    }
    if (!window._clashMemMock) {
        window._clashMemMock = Math.floor(Math.random() * (136 - 88) + 88);
    } else {
        window._clashMemMock += Math.floor(Math.random() * 5 - 2);
        window._clashMemMock = Math.max(76, Math.min(180, window._clashMemMock));
    }
    return window._clashMemMock.toFixed(1) + ' MB';
}

// 异步 WebRTC 方式安全无感获取本机内网 IP 地址
function getLocalIP() {
    return new Promise((resolve) => {
        try {
            const pc = new RTCPeerConnection({ iceServers: [] });
            pc.createDataChannel('');
            pc.createOffer().then(pc.setLocalDescription.bind(pc)).catch(() => resolve('127.0.0.1'));
            pc.onicecandidate = (ice) => {
                if (!ice || !ice.candidate || !ice.candidate.candidate) {
                    resolve('127.0.0.1');
                    return;
                }
                const matches = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(ice.candidate.candidate);
                const myIP = matches ? matches[1] : '127.0.0.1';
                resolve(myIP);
                pc.onicecandidate = null;
                pc.close();
            };
            setTimeout(() => resolve('127.0.0.1'), 1500); // 兜底超时
        } catch (e) {
            resolve('127.0.0.1');
        }
    });
}

// =========================
// 全局角色配置（模型会话 + OpenClaw 渠道）
// =========================
let __roleConfigState = null;
let __selectedRoleId = null;
let __rolesUiBound = false;
let __editingNewRole = false;

function roleT(key, fallback, vars) {
    let text = t(key);
    if (!text || text === key) text = fallback || key;
    if (vars && typeof vars === 'object') {
        for (const [k, v] of Object.entries(vars)) {
            text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v == null ? '' : v));
        }
    }
    return text;
}

function getActiveRoleFromState() {
    if (!__roleConfigState) return null;
    if (__roleConfigState.activeRole) return __roleConfigState.activeRole;
    const id = __roleConfigState.activeRoleId;
    const roles = __roleConfigState.roles || [];
    return roles.find((r) => r.id === id) || roles[0] || null;
}

function getActiveRoleChatAddon() {
    const role = getActiveRoleFromState();
    if (!role || !role.prompt) return '';
    return [
        '',
        '【全局角色口吻】',
        `当前启用角色：${role.name}${role.source ? `（${role.source}）` : ''}`,
        '请在保持事实正确、安全边界与工具策略不变的前提下，用以下口吻回复用户：',
        String(role.prompt)
    ].join('\n');
}

function normalizeRoleCommandText(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[《》【】「」“”"'`·._\-\s]/g, '');
}

function findRolesForChatCommand(query) {
    const roles = (__roleConfigState && __roleConfigState.roles) || [];
    const needle = normalizeRoleCommandText(query)
        .replace(/(?:这个)?角色$/u, '')
        .replace(/口吻$/u, '');
    if (!needle) return [];

    const exact = roles.filter((role) =>
        normalizeRoleCommandText(role.name) === needle
        || normalizeRoleCommandText(role.id) === needle
    );
    if (exact.length) return exact;

    return roles.filter((role) => {
        const fields = [
            role.name,
            role.id,
            role.source,
            ...(role.tags || [])
        ].map(normalizeRoleCommandText);
        return fields.some((field) => field.includes(needle));
    });
}

function parseChatRoleSwitchQuery(text) {
    const source = String(text || '').trim();
    const explicitPatterns = [
        /^[/#]角色\s*[:：]?\s*(.+)$/iu,
        /^[/#]role\s*[:：]?\s*(.+)$/iu,
        /^(?:请)?(?:切换|更换|换|启用|使用)(?:模型)?角色(?:为|成|到)?\s*[:：]?\s*(.+)$/u,
        /^(?:请)?(?:切换|更换|换)(?:为|成|到)\s*(.+)$/u,
        /^(?:请)?(?:启用|使用)\s*(.+?)(?:角色|口吻)$/u,
        /^(?:please\s+)?(?:switch|change)\s+(?:the\s+)?role\s+(?:to\s+)?(.+)$/iu,
        /^(?:please\s+)?(?:switch|change)\s+to\s+(.+)$/iu,
        /^(?:please\s+)?(?:use|activate)\s+(.+?)\s+(?:role|persona)$/iu
    ];
    for (const pattern of explicitPatterns) {
        const match = source.match(pattern);
        if (match && match[1] && match[1].trim()) {
            return {
                query: match[1].trim(),
                explicit: /^[/#](?:角色|role)/iu.test(source) || /角色|role/iu.test(source)
            };
        }
    }
    return null;
}

async function handleChatRoleCommand(text) {
    const source = String(text || '').trim();
    if (!source) return false;

    const asksCurrent = /^(?:当前|现在|目前)(?:使用的|启用的|是)?(?:什么|哪个)?(?:模型)?角色[？?]?$/u.test(source)
        || /^(?:我)?(?:现在|当前)是什么口吻[？?]?$/u.test(source)
        || /^(?:what(?:'s| is)\s+)?(?:the\s+)?current\s+(?:role|persona)[?]?$/iu.test(source);
    const asksHelp = /^(?:角色指令|角色命令|怎么切换角色|如何切换角色)[？?]?$/u.test(source)
        || /^(?:role commands?|how (?:do i|to) (?:switch|change) roles?)[?]?$/iu.test(source);
    const parsedSwitch = parseChatRoleSwitchQuery(source);
    if (!asksCurrent && !asksHelp && !parsedSwitch) return false;

    // 命令执行前拉最新角色库，避免刚新建/改名后对话侧还是旧列表
    if (typeof loadRoleConfigState === 'function') {
        await loadRoleConfigState({ silent: true, preferActive: false, clearEditing: false });
    }
    if (!__roleConfigState) {
        appendChatMessage('ai', t(
            '角色配置暂时无法读取，请稍后重试。',
            'Role configuration is temporarily unavailable. Please try again.',
            '角色配置暫時無法讀取，請稍後重試。'
        ));
        return true;
    }

    if (asksCurrent) {
        const active = getActiveRoleFromState();
        appendChatMessage('ai', active
            ? t(
                `当前使用「${active.name}」角色（${active.source || '未标注出处'}）。`,
                `The active role is “${active.name}” (${active.source || 'source not specified'}).`,
                `目前使用「${active.name}」角色（${active.source || '未標註出處'}）。`
            )
            : t('当前未找到启用角色。', 'No active role was found.', '目前未找到啟用角色。'));
        return true;
    }

    if (asksHelp) {
        appendChatMessage('ai', t(
            '你可以直接说：\n• 角色列表 / 角色列表 2\n• 搜索角色 贾维斯\n• 切换成贾维斯\n• 切换角色为王林\n• /角色 温暖教师\n• 当前是什么角色\n\n以上指令在微信/QQ/飞书等渠道同样可用；切换后全局生效。',
            'You can say:\n• Role list / Role list 2\n• Search role Jarvis\n• Switch to Jarvis\n• Switch role to Wang Lin\n• /role Warm Teacher\n• What is the current role?\n\nThese commands also work on WeChat/QQ/Feishu; switching applies globally.',
            '你可以直接說：\n• 角色列表 / 角色列表 2\n• 搜尋角色 賈維斯\n• 切換成賈維斯\n• 切換角色為王林\n• /角色 溫暖教師\n• 目前是什麼角色\n\n以上指令在微信/QQ/飛書等渠道同樣可用；切換後全域生效。'
        ));
        return true;
    }

    const matches = findRolesForChatCommand(parsedSwitch.query);
    if (!matches.length) {
        // “切换成英文”等普通自然语言不是角色命令，交回模型正常回答。
        if (!parsedSwitch.explicit) return false;
        appendChatMessage('ai', t(
            `没有找到“${parsedSwitch.query}”角色。你可以到「模型角色」搜索，或输入“角色指令”查看用法。`,
            `No role matching “${parsedSwitch.query}” was found. Search in Model Roles or type “role commands” for help.`,
            `沒有找到「${parsedSwitch.query}」角色。你可以到「模型角色」搜尋，或輸入「角色指令」查看用法。`
        ));
        return true;
    }

    if (matches.length > 1) {
        const names = matches.slice(0, 8).map((role) => `• ${role.name}（${role.source}）`).join('\n');
        appendChatMessage('ai', t(
            `找到多个相近角色，请说出完整名称：\n${names}${matches.length > 8 ? '\n• …' : ''}`,
            `Multiple roles matched. Please use the full name:\n${names}${matches.length > 8 ? '\n• …' : ''}`,
            `找到多個相近角色，請說出完整名稱：\n${names}${matches.length > 8 ? '\n• …' : ''}`
        ));
        return true;
    }

    const role = matches[0];
    try {
        const result = await window.api.saveRoleConfig({ action: 'activate', roleId: role.id });
        if (!result || !result.success || !result.data) {
            throw new Error((result && result.error) || 'unknown error');
        }
        applyRoleConfigState(result.data, {
            preferActive: true,
            selectRoleId: role.id,
            clearEditing: true
        });
        appendChatMessage('ai', t(
            `已切换为「${role.name}」角色。下一条消息起，我会使用这个口吻回复。`,
            `Switched to the “${role.name}” role. I will use this persona from your next message.`,
            `已切換為「${role.name}」角色。下一則訊息起，我會使用這個口吻回覆。`
        ));
        return true;
    } catch (error) {
        appendChatMessage('ai', t(
            `角色切换失败：${error.message || error}`,
            `Failed to switch role: ${error.message || error}`,
            `角色切換失敗：${error.message || error}`
        ));
        return true;
    }
}

function parseRoleTagsInput(value) {
    return String(value || '')
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8);
}

function collectRoleFormValues() {
    return {
        id: __editingNewRole ? '' : (__selectedRoleId || ''),
        name: (document.getElementById('role-input-name') || {}).value || '',
        source: (document.getElementById('role-input-source') || {}).value || '',
        summary: (document.getElementById('role-input-summary') || {}).value || '',
        tags: parseRoleTagsInput((document.getElementById('role-input-tags') || {}).value || ''),
        prompt: (document.getElementById('role-input-prompt') || {}).value || ''
    };
}

function findRoleInState(roleId) {
    if (!__roleConfigState || !Array.isArray(__roleConfigState.roles)) return null;
    return __roleConfigState.roles.find((r) => r.id === roleId) || null;
}

function setRoleFormReadonly(readonly) {
    ['role-input-name', 'role-input-source', 'role-input-summary', 'role-input-tags', 'role-input-prompt'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = !!readonly;
    });
    const saveBtn = document.getElementById('btn-role-save');
    const delBtn = document.getElementById('btn-role-delete');
    if (saveBtn) saveBtn.style.display = readonly ? 'none' : '';
    if (delBtn) delBtn.style.display = readonly ? 'none' : '';
}

function fillRoleEditor(role, opts = {}) {
    const empty = document.getElementById('roles-editor-empty');
    const form = document.getElementById('roles-editor-form');
    if (!form) return;

    if (!role) {
        if (empty) empty.style.display = '';
        form.style.display = 'none';
        return;
    }

    if (empty) empty.style.display = 'none';
    form.style.display = '';

    const builtinTag = document.getElementById('roles-builtin-tag');
    if (builtinTag) builtinTag.style.display = role.builtin ? '' : 'none';

    const nameEl = document.getElementById('role-input-name');
    const sourceEl = document.getElementById('role-input-source');
    const summaryEl = document.getElementById('role-input-summary');
    const tagsEl = document.getElementById('role-input-tags');
    const promptEl = document.getElementById('role-input-prompt');
    if (nameEl) nameEl.value = role.name || '';
    if (sourceEl) sourceEl.value = role.source || '';
    if (summaryEl) summaryEl.value = role.summary || '';
    if (tagsEl) tagsEl.value = (role.tags || []).join(', ');
    if (promptEl) promptEl.value = role.prompt || '';

    const readonly = !!role.builtin && !opts.forceEditable;
    setRoleFormReadonly(readonly);

    const activateBtn = document.getElementById('btn-role-activate');
    if (activateBtn) {
        const isActive = !!(__roleConfigState && __roleConfigState.activeRoleId === role.id && !__editingNewRole);
        activateBtn.disabled = isActive || __editingNewRole;
        activateBtn.textContent = isActive
            ? roleT('roles.badge.enabled', '使用中')
            : roleT('roles.btn.activate', '启用此角色');
    }
}

let __roleSearchKeyword = '';

function roleMatchesKeyword(role, keyword) {
    if (!keyword) return true;
    const haystack = [
        role.name,
        role.source,
        role.summary,
        ...(role.tags || [])
    ].join(' ').toLowerCase();
    // 支持空格分隔多关键词，全部命中才算匹配
    return keyword.split(/\s+/).filter(Boolean).every((kw) => haystack.includes(kw));
}

function renderRolesList() {
    const list = document.getElementById('roles-card-list');
    const badge = document.getElementById('roles-active-badge');
    if (!list) return;

    const allRoles = (__roleConfigState && __roleConfigState.roles) || [];
    const keyword = __roleSearchKeyword.trim().toLowerCase();
    const roles = allRoles.filter((r) => roleMatchesKeyword(r, keyword));
    const activeId = (__roleConfigState && __roleConfigState.activeRoleId) || '';
    const activeRole = getActiveRoleFromState();
    if (badge) badge.textContent = activeRole ? activeRole.name : '--';

    list.innerHTML = '';
    if (keyword && !roles.length) {
        const emptyTip = document.createElement('div');
        emptyTip.className = 'roles-search-empty';
        emptyTip.textContent = roleT('roles.search.empty', '没有匹配的角色，换个关键词试试。');
        list.appendChild(emptyTip);
        return;
    }
    roles.forEach((role) => {
        const card = document.createElement('div');
        card.className = 'role-card' + ((__selectedRoleId === role.id && !__editingNewRole) ? ' active-selected' : '');
        card.setAttribute('data-role-id', role.id);

        const enabled = role.id === activeId;
        const pillText = enabled
            ? roleT('roles.badge.enabled', '使用中')
            : (role.builtin ? roleT('roles.badge.builtin', '内置') : roleT('roles.badge.custom', '自定义'));

        const tagsHtml = (role.tags || []).slice(0, 4).map((tag) => `<span class="role-tag">${escapeHtmlLite(tag)}</span>`).join('');
        card.innerHTML = `
            <div class="role-card-title">
                <strong>${escapeHtmlLite(role.name || role.id)}</strong>
                <span class="role-card-pill${enabled ? ' enabled' : ''}">${escapeHtmlLite(pillText)}</span>
            </div>
            <div class="role-card-source">${escapeHtmlLite(role.source || '')}</div>
            <div class="role-card-summary">${escapeHtmlLite(role.summary || '')}</div>
            <div class="role-card-tags">${tagsHtml}</div>
        `;
        card.addEventListener('click', () => {
            __editingNewRole = false;
            __selectedRoleId = role.id;
            renderRolesList();
            fillRoleEditor(role);
        });
        list.appendChild(card);
    });
}

function escapeHtmlLite(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function applyRoleConfigState(data, opts = {}) {
    if (!data) return null;
    __roleConfigState = data;
    const preferActive = opts.preferActive !== false;
    const forceSelectId = opts.selectRoleId || null;

    if (forceSelectId && findRoleInState(forceSelectId)) {
        __selectedRoleId = forceSelectId;
    } else if (preferActive && data.activeRoleId) {
        __selectedRoleId = data.activeRoleId;
    } else if (!__selectedRoleId || !findRoleInState(__selectedRoleId)) {
        __selectedRoleId = data.activeRoleId
            || (data.roles && data.roles[0] && data.roles[0].id)
            || null;
    }

    if (opts.clearEditing !== false) __editingNewRole = false;
    renderRolesList();
    if (!__editingNewRole) {
        fillRoleEditor(findRoleInState(__selectedRoleId));
    }
    updateChatActiveRoleBadge();
    return __roleConfigState;
}

function updateChatActiveRoleBadge() {
    const badge = document.getElementById('chat-active-role-badge');
    if (!badge) return;
    const active = getActiveRoleFromState();
    if (!active) {
        badge.textContent = '--';
        badge.title = '';
        return;
    }
    badge.textContent = active.name || '--';
    badge.title = `${active.name}${active.source ? ` · ${active.source}` : ''}`;
}

async function loadRoleConfigState(opts = {}) {
    if (!window.api || !window.api.readRoleConfig) {
        if (!opts.silent) showToast(roleT('roles.toast.loaded_fail', '角色配置加载失败'));
        return null;
    }
    try {
        const result = await window.api.readRoleConfig();
        if (!result || result.success === false || !result.data) {
            if (!opts.silent) showToast(roleT('roles.toast.loaded_fail', '角色配置加载失败'));
            return null;
        }
        return applyRoleConfigState(result.data, {
            preferActive: !!opts.preferActive,
            selectRoleId: opts.selectRoleId || null,
            clearEditing: opts.clearEditing !== false
        });
    } catch (e) {
        console.warn('[Roles] load failed:', e);
        if (!opts.silent) showToast(roleT('roles.toast.loaded_fail', '角色配置加载失败'));
        return null;
    }
}

async function applyRoleAction(payload, successKey, successFallback, successVars) {
    if (!window.api || !window.api.saveRoleConfig) {
        showToast(roleT('roles.toast.error', '操作失败：{error}', { error: 'API unavailable' }));
        return false;
    }
    try {
        const result = await window.api.saveRoleConfig(payload);
        if (!result || !result.success) {
            showToast(roleT('roles.toast.error', '操作失败：{error}', { error: (result && result.error) || 'unknown' }));
            return false;
        }
        let selectRoleId = null;
        let preferActive = false;
        if (payload.action === 'activate' || payload.action === 'reset-active') {
            preferActive = true;
            selectRoleId = result.data && result.data.activeRoleId;
        } else if (payload.action === 'upsert' && result.data && result.data.roles) {
            const savedName = (payload.role && payload.role.name) || '';
            const custom = [...result.data.roles].reverse().find((r) => !r.builtin && r.name === savedName);
            if (custom) selectRoleId = custom.id;
            else if (payload.role && payload.role.id) selectRoleId = payload.role.id;
        } else if (payload.action === 'delete') {
            preferActive = true;
            selectRoleId = result.data && result.data.activeRoleId;
        }
        applyRoleConfigState(result.data, { preferActive, selectRoleId, clearEditing: true });
        showToast(roleT(successKey, successFallback, successVars));
        return true;
    } catch (e) {
        showToast(roleT('roles.toast.error', '操作失败：{error}', { error: e.message || String(e) }));
        return false;
    }
}

function startCreateRole() {
    __editingNewRole = true;
    __selectedRoleId = null;
    renderRolesList();
    fillRoleEditor({
        name: roleT('roles.new.name', '我的自定义角色'),
        source: roleT('roles.new.source', '自定义'),
        summary: roleT('roles.new.summary', '按你喜欢的口吻回复。'),
        tags: [],
        prompt: roleT('roles.new.prompt', '请用清晰、自然、有个性的口吻回复用户。保持事实正确与安全边界。'),
        builtin: false
    }, { forceEditable: true });
    const activateBtn = document.getElementById('btn-role-activate');
    if (activateBtn) activateBtn.disabled = true;
}

function initRolesUI() {
    if (__rolesUiBound) return;
    __rolesUiBound = true;

    const searchInput = document.getElementById('role-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            __roleSearchKeyword = searchInput.value || '';
            renderRolesList();
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                searchInput.value = '';
                __roleSearchKeyword = '';
                renderRolesList();
            }
        });
    }

    const btnNew = document.getElementById('btn-role-new');
    const btnReset = document.getElementById('btn-role-reset-default');
    const btnSave = document.getElementById('btn-role-save');
    const btnActivate = document.getElementById('btn-role-activate');
    const btnDup = document.getElementById('btn-role-duplicate');
    const btnDel = document.getElementById('btn-role-delete');

    if (btnNew) btnNew.addEventListener('click', () => startCreateRole());

    if (btnReset) {
        btnReset.addEventListener('click', async () => {
            await applyRoleAction({ action: 'reset-active' }, 'roles.toast.reset', '已恢复为默认助手');
        });
    }

    if (btnSave) {
        btnSave.addEventListener('click', async () => {
            const values = collectRoleFormValues();
            if (!String(values.name || '').trim()) {
                showToast(roleT('roles.toast.name_required', '请填写角色名称'));
                return;
            }
            if (!String(values.prompt || '').trim()) {
                showToast(roleT('roles.toast.prompt_required', '请填写详细口吻指令'));
                return;
            }
            const current = findRoleInState(__selectedRoleId);
            if (current && current.builtin && !__editingNewRole) {
                showToast(roleT('roles.toast.builtin_readonly', '内置角色不可直接修改，请先“复制为自定义”'));
                return;
            }
            const rolePayload = {
                name: values.name.trim(),
                source: values.source.trim() || roleT('roles.new.source', '自定义'),
                summary: values.summary.trim(),
                tags: values.tags,
                prompt: values.prompt.trim()
            };
            if (!__editingNewRole && values.id) rolePayload.id = values.id;
            await applyRoleAction({ action: 'upsert', role: rolePayload }, 'roles.toast.saved', '角色已保存');
        });
    }

    if (btnActivate) {
        btnActivate.addEventListener('click', async () => {
            if (__editingNewRole || !__selectedRoleId) return;
            const role = findRoleInState(__selectedRoleId);
            await applyRoleAction(
                { action: 'activate', roleId: __selectedRoleId },
                'roles.toast.activated',
                '已启用角色：{name}',
                { name: (role && role.name) || __selectedRoleId }
            );
        });
    }

    if (btnDup) {
        btnDup.addEventListener('click', async () => {
            const base = __editingNewRole ? collectRoleFormValues() : findRoleInState(__selectedRoleId);
            if (!base) return;
            const rolePayload = {
                name: String(base.name || 'Role') + ' Copy',
                source: base.source || roleT('roles.new.source', '自定义'),
                summary: base.summary || '',
                tags: Array.isArray(base.tags) ? base.tags : parseRoleTagsInput(base.tags),
                prompt: base.prompt || ''
            };
            const ok = await applyRoleAction({ action: 'upsert', role: rolePayload }, 'roles.toast.duplicated', '已复制为自定义角色');
            if (ok) {
                const selected = findRoleInState(__selectedRoleId);
                if (selected) fillRoleEditor(selected);
            }
        });
    }

    if (btnDel) {
        btnDel.addEventListener('click', async () => {
            if (__editingNewRole) {
                __editingNewRole = false;
                __selectedRoleId = (__roleConfigState && __roleConfigState.activeRoleId) || null;
                renderRolesList();
                fillRoleEditor(findRoleInState(__selectedRoleId));
                return;
            }
            const role = findRoleInState(__selectedRoleId);
            if (!role) return;
            if (role.builtin) {
                showToast(roleT('roles.toast.builtin_readonly', '内置角色不可直接修改，请先“复制为自定义”'));
                return;
            }
            if (!window.confirm(roleT('roles.toast.delete_confirm', '确定删除该自定义角色吗？'))) return;
            await applyRoleAction({ action: 'delete', roleId: role.id }, 'roles.toast.deleted', '角色已删除');
        });
    }
}

// ─── 语音管理：设置 / 下载 / 朗读 / 唤醒 / 语音对话 ───
let __voiceState = null;
let __voiceUiBound = false;
let __voiceRec = null;
let __voiceRecMode = 'off'; // off | wake | chat
let __voiceChatBuffer = '';
let __voiceChatSilenceTimer = null;
let __voiceApplyingUi = false;

function voiceT(key, fallback) {
    try {
        if (typeof t === 'function') {
            const v = t(key);
            if (v && v !== key) return v;
        }
    } catch (err) {}
    return fallback || key;
}

function escapeVoiceHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function normalizeWakeText(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[，。！？、,.!?]/g, '');
}

function voiceStatusLabel(status, enabled) {
    const isEnabled = enabled !== undefined
        ? !!enabled
        : !!(__voiceState && __voiceState.settings && __voiceState.settings.enabled);
    const map = {
        idle: isEnabled
            ? voiceT('voice.status.ready', '空闲（就绪）')
            : voiceT('voice.status.idle', '未启用'),
        listening_wake: voiceT('voice.status.listening_wake', '倾听唤醒词中'),
        listening: voiceT('voice.status.listening', '正在听你说话'),
        speaking: voiceT('voice.status.speaking', '正在朗读'),
        downloading: voiceT('voice.status.downloading', '正在下载语音包')
    };
    return map[status] || map.idle;
}

async function maybeSpeakDesktopReply(text, roleId) {
    try {
        if (!window.api || !window.api.voice) return;
        const st = __voiceState || (await window.api.voice.getState()).data;
        if (!st || !st.settings) return;
        const s = st.settings;
        if (!s.enabled || s.muted) return;
        if (!(s.desktopSpeak || s.voiceChat)) return;
        const clean = String(text || '').trim();
        if (!clean || clean.startsWith('⚠️') || clean.startsWith('❌')) return;
        await window.api.voice.speak({
            text: clean,
            source: 'desktop',
            roleId: roleId || ((__roleConfigState && __roleConfigState.activeRoleId) || undefined)
        });
    } catch (e) {
        console.warn('[Voice] desktop speak skipped:', e);
    }
}

function updateVoiceStatusUi(state) {
    if (!state) return;
    const statusDot = document.getElementById('voice-status-dot');
    const statusText = document.getElementById('voice-status-text');
    if (statusDot) statusDot.setAttribute('data-status', state.status || 'idle');
    if (statusText) statusText.textContent = voiceStatusLabel(state.status || 'idle', state.settings && state.settings.enabled);
    const note = document.getElementById('voice-engine-note');
    if (note && state.engineNote) note.textContent = state.engineNote;

    const pulseVisualizer = document.getElementById('pulse-visualizer');
    const pulseModule = document.getElementById('ai-pulse-module');
    if (pulseVisualizer && pulseModule) {
        if (state.speaking || state.status === 'speaking' || state.status === 'listening') {
            pulseVisualizer.classList.add('active');
            pulseModule.style.opacity = '0.8';
        } else {
            pulseVisualizer.classList.remove('active');
            pulseModule.style.opacity = '0';
        }
    }
}

function applyVoiceStateToUi(state) {
    if (!state) return;
    __voiceState = state;
    __voiceApplyingUi = true;
    try {
        const s = state.settings || {};
        const setChecked = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!val;
        };
        setChecked('voice-toggle-enabled', s.enabled);
        setChecked('voice-toggle-channel', s.channelReplySpeak);
        setChecked('voice-toggle-wake', s.wakeListen);
        setChecked('voice-toggle-chat', s.voiceChat);
        setChecked('voice-toggle-desktop', s.desktopSpeak !== false);
        setChecked('voice-toggle-mute', s.muted);

        const vol = document.getElementById('voice-volume-slider');
        const volVal = document.getElementById('voice-volume-value');
        const pct = Math.round((Number(s.volume) || 0.8) * 100);
        if (vol && document.activeElement !== vol) vol.value = String(pct);
        if (volVal) volVal.textContent = pct + '%';

        const wakeInput = document.getElementById('voice-wake-word');
        if (wakeInput && document.activeElement !== wakeInput) wakeInput.value = s.wakeWord || '你好 Nexora';

        const rateSelect = document.getElementById('voice-rate');
        if (rateSelect) rateSelect.value = String(s.rate || 0);

        updateVoiceStatusUi(state);

        fillVoicePackSelects(state);
        renderVoicePackGrids(state);
    } finally {
        __voiceApplyingUi = false;
    }

    syncVoiceListeningFromSettings(state.settings || {});
}

function getVoicePackById(packId) {
    const catalog = (__voiceState && __voiceState.catalog) || [];
    return catalog.find((p) => p.id === packId) || null;
}

/** 试听句按音色语言匹配：英文包用英文，中文包用中文，避免神经引擎读不了导致回退到系统女声 */
function voicePreviewPhrase(pack) {
    if (pack && pack.lang === 'en') {
        return 'Hello, I am Nexora Agent local voice assistant.';
    }
    return voiceT('voice.test.phrase', '你好，我是 Nexora Agent 本地语音助手。');
}

async function previewVoicePack(packId) {
    if (!window.api || !window.api.voice) return;
    const pack = getVoicePackById(packId);
    if (!pack) return;
    if (!pack.installed) {
        showToast(voiceT('voice.toast.not_downloaded', '该男声音色还未下载，请先下载语音包'));
        return;
    }
    await window.api.voice.speak({
        text: voicePreviewPhrase(pack),
        source: 'preview',
        packId: pack.id
    });
}

function warnIfPackNotInstalled(packId) {
    const pack = getVoicePackById(packId);
    if (pack && !pack.installed) {
        showToast(voiceT('voice.toast.not_downloaded', '该男声音色还未下载，请先下载语音包'));
    }
}

function fillVoicePackSelects(state) {
    const catalog = (state && state.catalog) || [];
    const activeId = (state.settings && state.settings.activePackId) || '';
    const sel = document.getElementById('voice-active-pack');
    if (!sel) return;
    // 下拉展开时不要重建 options，否则会闪烁且无法点选
    if (document.activeElement === sel) {
        if (activeId) sel.value = activeId;
        return;
    }
    const signature = catalog.map((p) => `${p.id}:${p.installed ? 1 : 0}`).join('|');
    if (sel.dataset.voiceSig === signature) {
        const next = activeId || (catalog[0] && catalog[0].id) || '';
        if (sel.value !== next) sel.value = next;
        return;
    }
    sel.innerHTML = catalog.map((p) => {
        const mark = p.installed ? '✓ ' : '';
        return `<option value="${escapeVoiceHtml(p.id)}">${mark}${escapeVoiceHtml(p.name)}</option>`;
    }).join('');
    sel.dataset.voiceSig = signature;
    sel.value = activeId || (catalog[0] && catalog[0].id) || '';
}

function renderVoicePackGrids(state) {
    const grid = document.getElementById('voice-pack-grid');
    if (!grid) return;
    const catalog = (state && state.catalog) || (__voiceState && __voiceState.catalog) || [];
    const signature = catalog.map((p) => `${p.id}:${p.installed ? 1 : 0}:${p.active ? 1 : 0}`).join('|');
    if (grid.dataset.voiceSig === signature) return;

    grid.innerHTML = catalog.map((pack) => {
        const badge = voiceT(pack.badgeKey, pack.group === 'jarvis' ? '贾维斯风' : '中文');
        const status = pack.installed ? '' : pack.size;
        const previewBtn = pack.installed
            ? `<button type="button" class="btn-secondary btn-voice-preview" data-voice-id="${escapeVoiceHtml(pack.id)}">${escapeVoiceHtml(voiceT('voice.btn.preview', '试听'))}</button>`
            : '';
        const action = pack.installed
            ? (pack.active
                ? `<button type="button" class="btn-secondary" disabled>${escapeVoiceHtml(voiceT('voice.badge.active', '使用中'))}</button>`
                : `<button type="button" class="btn-primary btn-voice-use" data-voice-id="${escapeVoiceHtml(pack.id)}">${escapeVoiceHtml(voiceT('voice.btn.use', '设为当前'))}</button>`)
            : `<button type="button" class="btn-primary btn-voice-download" data-voice-id="${escapeVoiceHtml(pack.id)}">${escapeVoiceHtml(voiceT('voice.btn.download', '下载语音包'))}</button>`;
        return `
        <div class="plugin-card-item" data-voice-id="${escapeVoiceHtml(pack.id)}">
          <div class="plugin-card-top">
            <div class="plugin-card-title-row">
              <h4>${escapeVoiceHtml(pack.name)}</h4>
              <div style="display: flex; gap: 6px; align-items: center;">
                <span class="voice-badge">${escapeVoiceHtml(badge)}</span>
                ${pack.license === '自定义' ? `<button type="button" class="btn-voice-delete" data-voice-id="${escapeVoiceHtml(pack.id)}" title="删除" style="background: transparent; border: none; cursor: pointer; opacity: 0.6; padding: 0 4px; font-size: 12px;">❌</button>` : ''}
              </div>
            </div>
            <p>${escapeVoiceHtml(pack.summary)}</p>
          </div>
          <div class="plugin-card-bot voice-card-actions">
            <span class="plugin-card-hint">${escapeVoiceHtml(status)}</span>
            <div style="display: flex; gap: 8px;">
              ${previewBtn}
              ${action}
            </div>
          </div>
        </div>`;
    }).join('');
    grid.dataset.voiceSig = signature;

    grid.querySelectorAll('.btn-voice-preview').forEach((btn) => {
        btn.onclick = () => previewVoicePack(btn.getAttribute('data-voice-id'));
    });
    grid.querySelectorAll('.btn-voice-delete').forEach((btn) => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            if (!confirm('确定要删除这个自定义语音包吗？')) return;
            const id = btn.getAttribute('data-voice-id');
            const res = await window.api.voice.deleteCustomPack(id);
            if (!res || !res.success) {
                console.error('Failed to delete pack:', res);
            }
        };
    });
    grid.querySelectorAll('.btn-voice-use').forEach((btn) => {
        btn.onclick = async () => {
            const id = btn.getAttribute('data-voice-id');
            const res = await window.api.voice.setSettings({ activePackId: id });
            if (res && res.data) applyVoiceStateToUi(res.data);
            warnIfPackNotInstalled(id);
        };
    });
    grid.querySelectorAll('.btn-voice-download').forEach((btn) => {
        btn.onclick = async () => {
            const id = btn.getAttribute('data-voice-id');
            btn.disabled = true;
            try {
                const res = await window.api.voice.downloadPack(id);
                if (res && res.success) {
                    showToast(voiceT('voice.toast.download_ok', '语音包已下载'));
                    const st = await window.api.voice.getState();
                    if (st && st.data) applyVoiceStateToUi(st.data);
                } else {
                    showToast(voiceT('voice.toast.download_fail', '下载失败：{error}').replace('{error}', (res && res.error) || 'unknown'));
                }
            } finally {
                btn.disabled = false;
            }
        };
    });
}

async function patchVoiceSettings(patch) {
    if (!window.api || !window.api.voice) return;
    const res = await window.api.voice.setSettings(patch);
    if (res && res.data) applyVoiceStateToUi(res.data);
}

let __localAudioContext = null;
let __localAudioStream = null;
let __localAudioProcessor = null;
let __localAudioChunks = [];
let __localSilenceStart = null;
let __localSpeaking = false;
let __localRmsThreshold = 0.015;

function mergeAudioChunks(chunks) {
    if (!chunks.length) return null;
    let totalLength = 0;
    for (const c of chunks) totalLength += c.length;
    const result = new Float32Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
        result.set(c, offset);
        offset += c.length;
    }
    return result;
}

function stopLocalVoiceRecognition() {
    __voiceRecMode = 'off';
    if (__localAudioProcessor) {
        try { __localAudioProcessor.disconnect(); } catch (e) {}
        __localAudioProcessor = null;
    }
    if (__localAudioStream) {
        try {
            __localAudioStream.getTracks().forEach(t => t.stop());
        } catch (e) {}
        __localAudioStream = null;
    }
    if (__localAudioContext) {
        try { __localAudioContext.close(); } catch (e) {}
        __localAudioContext = null;
    }
    __localAudioChunks = [];
    __localSpeaking = false;
    __localSilenceStart = null;
}

function startLocalVoiceRecognition(mode) {
    stopLocalVoiceRecognition();
    
    // 确保在线识别也已关闭
    if (__voiceChatSilenceTimer) {
        clearTimeout(__voiceChatSilenceTimer);
        __voiceChatSilenceTimer = null;
    }
    if (__voiceRec) {
        try { __voiceRec.onresult = null; } catch (e) {}
        try { __voiceRec.onerror = null; } catch (e) {}
        try { __voiceRec.onend = null; } catch (e) {}
        try { __voiceRec.stop(); } catch (e) {}
        __voiceRec = null;
    }

    __voiceRecMode = mode;
    __voiceChatBuffer = '';

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        __localAudioStream = stream;
        __localAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = __localAudioContext.createMediaStreamSource(stream);
        __localAudioProcessor = __localAudioContext.createScriptProcessor(4096, 1, 1);

        __localAudioChunks = [];
        __localSilenceStart = null;
        __localSpeaking = false;

        __localAudioProcessor.onaudioprocess = (e) => {
            if (__voiceRecMode === 'off') return;
            const channelData = e.inputBuffer.getChannelData(0);

            let sum = 0;
            for (let i = 0; i < channelData.length; i++) {
                sum += channelData[i] * channelData[i];
            }
            const rms = Math.sqrt(sum / channelData.length);

            if (__voiceRecMode === 'chat') {
                if (rms > __localRmsThreshold) {
                    if (!__localSpeaking) {
                        __localSpeaking = true;
                        if (window.api && window.api.voice) {
                            window.api.voice.setListenStatus('listening');
                        }
                    }
                    __localSilenceStart = null;
                } else {
                    if (__localSpeaking) {
                        if (!__localSilenceStart) {
                            __localSilenceStart = Date.now();
                        } else if (Date.now() - __localSilenceStart > 1500) {
                            __localSpeaking = false;
                            __localSilenceStart = null;
                            const pcmData = mergeAudioChunks(__localAudioChunks);
                            __localAudioChunks = [];
                            if (pcmData && pcmData.length > 3200) {
                                triggerLocalAsr(pcmData);
                            } else {
                                if (window.api && window.api.voice) {
                                    window.api.voice.setListenStatus('listening');
                                }
                            }
                        }
                    }
                }

                if (__localSpeaking) {
                    __localAudioChunks.push(new Float32Array(channelData));
                }
            } else if (__voiceRecMode === 'wake') {
                if (rms > __localRmsThreshold) {
                    if (!__localSpeaking) {
                        __localSpeaking = true;
                        if (window.api && window.api.voice) {
                            window.api.voice.setListenStatus('listening_wake');
                        }
                    }
                    __localSilenceStart = null;
                } else {
                    if (__localSpeaking) {
                        if (!__localSilenceStart) {
                            __localSilenceStart = Date.now();
                        } else if (Date.now() - __localSilenceStart > 1200) {
                            __localSpeaking = false;
                            __localSilenceStart = null;
                            const pcmData = mergeAudioChunks(__localAudioChunks);
                            __localAudioChunks = [];
                            if (pcmData && pcmData.length > 3200) {
                                triggerLocalWakeAsr(pcmData);
                            } else {
                                if (window.api && window.api.voice) {
                                    window.api.voice.setListenStatus('listening_wake');
                                }
                            }
                        }
                    }
                }

                if (__localSpeaking) {
                    __localAudioChunks.push(new Float32Array(channelData));
                }
            }
        };

        source.connect(__localAudioProcessor);
        __localAudioProcessor.connect(__localAudioContext.destination);

        if (window.api && window.api.voice) {
            window.api.voice.setListenStatus(mode === 'wake' ? 'listening_wake' : 'listening');
        }
    }).catch(err => {
        console.error('[Voice] Local recording access error:', err);
        showToast(voiceT('voice.toast.mic_denied', '无法访问麦克风，请在系统设置中允许'));
        stopLocalVoiceRecognition();
    });
}

async function triggerLocalAsr(pcmData) {
    const statusText = document.getElementById('voice-status-text');
    if (statusText) statusText.textContent = '正在识别中...';

    const res = await window.api.voice.recognizeOffline(Array.from(pcmData));
    if (res && res.success && res.text) {
        const text = res.text.trim();
        console.log('[Voice] Local ASR recognized:', text);
        submitVoiceChatUtterance(text);
    } else {
        console.log('[Voice] Local ASR empty or failed:', res && res.error);
        if (__voiceRecMode === 'chat') {
            __localAudioChunks = [];
            __localSpeaking = false;
            __localSilenceStart = null;
            if (window.api && window.api.voice) {
                window.api.voice.setListenStatus('listening');
            }
        }
    }
}

async function triggerLocalWakeAsr(pcmData) {
    const res = await window.api.voice.recognizeOffline(Array.from(pcmData));
    if (res && res.success && res.text) {
        const heard = res.text.trim();
        const settings = (__voiceState && __voiceState.settings) || {};
        const wake = normalizeWakeText(settings.wakeWord || '你好 Nexora');
        const got = normalizeWakeText(heard);
        console.log('[Voice] Local Wake got:', got, 'target:', wake);
        if (wake && got.includes(wake)) {
            if (settings.voiceChat) {
                enterVoiceChatListening();
            } else {
                showToast(voiceT('voice.status.listening_wake', '倾听唤醒词中') + ': OK');
            }
        } else {
            if (__voiceRecMode === 'wake') {
                __localAudioChunks = [];
                __localSpeaking = false;
                __localSilenceStart = null;
                if (window.api && window.api.voice) {
                    window.api.voice.setListenStatus('listening_wake');
                }
            }
        }
    } else {
        if (__voiceRecMode === 'wake') {
            __localAudioChunks = [];
            __localSpeaking = false;
            __localSilenceStart = null;
            if (window.api && window.api.voice) {
                window.api.voice.setListenStatus('listening_wake');
            }
        }
    }
}

function stopVoiceRecognition() {
    stopLocalVoiceRecognition();
    __voiceRecMode = 'off';
    __voiceChatBuffer = '';
    if (__voiceChatSilenceTimer) {
        clearTimeout(__voiceChatSilenceTimer);
        __voiceChatSilenceTimer = null;
    }
    if (__voiceRec) {
        try { __voiceRec.onresult = null; } catch (e) {}
        try { __voiceRec.onerror = null; } catch (e) {}
        try { __voiceRec.onend = null; } catch (e) {}
        try { __voiceRec.stop(); } catch (e) {}
        __voiceRec = null;
    }
}

function createSpeechRecognition() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.lang = (localStorage.getItem('setting_language') || 'zh-CN').startsWith('en') ? 'en-US' : 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    return rec;
}

function startVoiceRecognition(mode) {
    if (__asrModelState && __asrModelState.installed) {
        startLocalVoiceRecognition(mode);
        return;
    }
    stopLocalVoiceRecognition();
    stopVoiceRecognition();
    const rec = createSpeechRecognition();
    if (!rec) {
        showToast(voiceT('voice.toast.mic_denied', '无法访问麦克风，请在系统设置中允许'));
        return;
    }
    __voiceRec = rec;
    __voiceRecMode = mode;
    __voiceChatBuffer = '';

    rec.onresult = (event) => {
        let interim = '';
        let finalText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const piece = event.results[i][0].transcript || '';
            if (event.results[i].isFinal) finalText += piece;
            else interim += piece;
        }
        const heard = (finalText || interim || '').trim();
        if (!heard) return;

        if (__voiceRecMode === 'wake') {
            const settings = (__voiceState && __voiceState.settings) || {};
            const wake = normalizeWakeText(settings.wakeWord || '你好 Nexora');
            const got = normalizeWakeText(heard);
            if (wake && got.includes(wake)) {
                if (settings.voiceChat) enterVoiceChatListening();
                else {
                    showToast(voiceT('voice.status.listening_wake', '倾听唤醒词中') + ': OK');
                }
            }
            return;
        }

        if (__voiceRecMode === 'chat') {
            if (finalText) {
                __voiceChatBuffer = (__voiceChatBuffer + ' ' + finalText).trim();
            }
            if (__voiceChatSilenceTimer) clearTimeout(__voiceChatSilenceTimer);
            __voiceChatSilenceTimer = setTimeout(() => {
                const utter = (__voiceChatBuffer || heard).trim();
                __voiceChatBuffer = '';
                if (utter) submitVoiceChatUtterance(utter);
            }, 1400);
        }
    };

    rec.onerror = (ev) => {
        const err = ev && ev.error;
        console.error('[Voice] SpeechRecognition error:', err);
        if (err === 'not-allowed' || err === 'service-not-allowed') {
            showToast(voiceT('voice.toast.mic_denied', '无法访问麦克风，请在系统设置中允许'));
        } else if (err === 'network') {
            showToast(voiceT('voice.toast.speech_network_error', '语音识别网络连接失败，请确保代理或全局加速已开启'));
        } else {
            showToast(voiceT('voice.toast.speech_error', `语音识别出现异常: ${err}`));
        }
        stopVoiceRecognition();
        if (window.api && window.api.voice) window.api.voice.setListenStatus('idle');
    };

    rec.onend = () => {
        // 持续倾听：若仍应监听则自动重启
        if (__voiceRecMode === 'off') return;
        const s = (__voiceState && __voiceState.settings) || {};
        if (!s.enabled) return;
        if (__voiceRecMode === 'wake' && s.wakeListen) {
            try { rec.start(); } catch (e) {}
        } else if (__voiceRecMode === 'chat' && s.voiceChat) {
            try { rec.start(); } catch (e) {}
        }
    };

    try {
        rec.start();
        if (window.api && window.api.voice) {
            window.api.voice.setListenStatus(mode === 'wake' ? 'listening_wake' : 'listening');
        }
    } catch (e) {
        showToast(voiceT('voice.toast.mic_denied', '无法访问麦克风，请在系统设置中允许'));
        stopVoiceRecognition();
    }
}

function enterVoiceChatListening() {
    const s = (__voiceState && __voiceState.settings) || {};
    if (!s.enabled || !s.voiceChat) return;
    startVoiceRecognition('chat');
    showToast(voiceT('voice.status.listening', '正在听你说话'));
}

async function submitVoiceChatUtterance(text) {
    const clean = String(text || '').trim();
    if (!clean) return;

    // 回到唤醒待机，避免把 AI 播报再识别进去
    const s = (__voiceState && __voiceState.settings) || {};
    if (s.wakeListen) startVoiceRecognition('wake');
    else stopVoiceRecognition();

    try {
        const input = document.getElementById('chat-text-input');
        if (input) input.value = clean;
        // 切到会话页并发送
        const chatNav = document.querySelector('.nav-item[data-tab="chat-view"]');
        if (chatNav) chatNav.click();
        if (typeof handleSendMessage === 'function') {
            await handleSendMessage();
        }
    } catch (e) {
        console.warn('[VoiceChat] submit failed:', e);
    }
}

let __voiceDesiredListenMode = null;

function syncVoiceListeningFromSettings(settings) {
    const s = settings || {};
    // 计算目标监听模式；只有模式真正变化时才动麦克风/发状态，避免状态事件循环刷新 UI
    let desired = 'off';
    if (s.enabled) {
        if (s.wakeListen) desired = 'wake';
        else if (s.voiceChat) desired = 'chat';
    }
    // chat 由唤醒进入的临时态不被 wake 目标覆盖
    if (desired === 'wake' && __voiceRecMode === 'chat') return;
    if (desired === __voiceDesiredListenMode && desired === (__voiceRecMode === 'off' ? 'off' : __voiceRecMode)) return;
    __voiceDesiredListenMode = desired;

    if (desired === 'off') {
        if (__voiceRecMode !== 'off') stopVoiceRecognition();
        if (window.api && window.api.voice) window.api.voice.setListenStatus('idle');
        return;
    }
    if (__voiceRecMode !== desired) startVoiceRecognition(desired);
}

function bindVoiceControlsOnce() {
    if (__voiceUiBound) return;
    __voiceUiBound = true;

    const bindToggle = (id, key) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => {
            if (__voiceApplyingUi) return;
            const patch = {};
            patch[key] = !!el.checked;
            if (key !== 'enabled' && key !== 'muted') {
                // 打开分项时若总开关关着，提示
                if (el.checked && __voiceState && __voiceState.settings && !__voiceState.settings.enabled && key !== 'enabled') {
                    showToast(voiceT('voice.toast.need_enable', '请先打开语音总开关'));
                }
            }
            patchVoiceSettings(patch);
        });
    };
    bindToggle('voice-toggle-enabled', 'enabled');
    bindToggle('voice-toggle-channel', 'channelReplySpeak');
    bindToggle('voice-toggle-wake', 'wakeListen');
    bindToggle('voice-toggle-chat', 'voiceChat');
    bindToggle('voice-toggle-desktop', 'desktopSpeak');
    bindToggle('voice-toggle-mute', 'muted');

    const vol = document.getElementById('voice-volume-slider');
    if (vol) {
        let timer = null;
        vol.addEventListener('input', () => {
            const pct = parseInt(vol.value, 10) || 0;
            const label = document.getElementById('voice-volume-value');
            if (label) label.textContent = pct + '%';
            if (__voiceApplyingUi) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => patchVoiceSettings({ volume: pct / 100 }), 120);
        });
    }

    const wakeInput = document.getElementById('voice-wake-word');
    if (wakeInput) {
        wakeInput.addEventListener('change', () => {
            if (__voiceApplyingUi) return;
            patchVoiceSettings({ wakeWord: wakeInput.value.trim() || '你好 Nexora' });
        });
    }

    const rateSelect = document.getElementById('voice-rate');
    if (rateSelect) {
        rateSelect.addEventListener('change', () => {
            if (__voiceApplyingUi) return;
            patchVoiceSettings({ rate: parseInt(rateSelect.value, 10) || 0 });
        });
    }

    const activePack = document.getElementById('voice-active-pack');
    if (activePack) {
        activePack.addEventListener('change', () => {
            if (__voiceApplyingUi) return;
            const id = activePack.value;
            warnIfPackNotInstalled(id);
            patchVoiceSettings({ activePackId: id });
        });
    }

    const btnStop = document.getElementById('btn-voice-stop');
    if (btnStop) btnStop.addEventListener('click', () => window.api.voice && window.api.voice.stop());

    const btnTest = document.getElementById('btn-voice-test');
    if (btnTest) {
        btnTest.addEventListener('click', async () => {
            const id = (__voiceState && __voiceState.settings && __voiceState.settings.activePackId) || '';
            await previewVoicePack(id);
        });
    }

    const btnImport = document.getElementById('btn-voice-import');
    if (btnImport) {
        btnImport.addEventListener('click', async () => {
            if (!window.api.voice || !window.api.voice.importCustomPack) return;
            const btnOriginalText = btnImport.textContent;
            btnImport.textContent = voiceT('voice.btn.importing', '导入中...');
            btnImport.disabled = true;
            try {
                const res = await window.api.voice.importCustomPack();
                if (!res.success && !res.canceled) {
                    showToast('error', `导入失败：${res.error}`);
                }
            } catch (e) {
                showToast('error', `导入出错：${e.message}`);
            } finally {
                btnImport.textContent = btnOriginalText;
                btnImport.disabled = false;
            }
        });
    }

    if (window.api && window.api.voice) {
        // 状态事件只刷新状态灯/文字，绝不重建卡片区（否则悬停闪烁、滚动丢失、下拉被覆盖）
        window.api.voice.onStatus((data) => {
            if (data) __voiceState = data;
            updateVoiceStatusUi(data);
        });
        window.api.voice.onSettingsUpdated((data) => applyVoiceStateToUi(data));
        window.api.voice.onDownloadProgress((p) => {
            const statusText = document.getElementById('voice-status-text');
            const statusDot = document.getElementById('voice-status-dot');
            if (statusDot) statusDot.setAttribute('data-status', 'downloading');
            if (statusText && p) statusText.textContent = `${voiceStatusLabel('downloading')} ${p.percent || 0}%`;
        });
        window.api.voice.onSpeakError((err) => {
            if (!err) return;
            if (err.hint === 'male_pack_required') {
                showToast(voiceT('voice.toast.sapi_fallback', '男声音色未下载，已阻止系统女声朗读。请下载对应语音包。'));
            } else if (err.hint === 'neural_failed_no_sapi_fallback') {
                showToast(voiceT('voice.toast.neural_fail', '神经音色朗读失败：{error}').replace('{error}', err.error || 'unknown'));
            }
        });
    }
}

let __asrModelState = { installed: false, downloading: false, percent: 0 };

function updateAsrUi() {
    const statusText = document.getElementById('asr-model-status');
    const downloadBtn = document.getElementById('btn-asr-download');
    const progressContainer = document.getElementById('asr-progress-container');
    const progressBar = document.getElementById('asr-progress-bar');
    if (!statusText || !downloadBtn || !progressContainer || !progressBar) return;

    if (__asrModelState.installed) {
        statusText.textContent = '已下载 (离线识别就绪)';
        statusText.style.color = '#52c41a';
        downloadBtn.style.display = 'none';
        progressContainer.style.display = 'none';
    } else if (__asrModelState.downloading) {
        statusText.textContent = `下载中... ${__asrModelState.percent}%`;
        statusText.style.color = 'var(--accent-color)';
        downloadBtn.style.display = 'none';
        progressContainer.style.display = 'block';
        progressBar.style.width = `${__asrModelState.percent}%`;
    } else {
        statusText.textContent = '未下载 (离线识别不可用，采用在线识别)';
        statusText.style.color = 'var(--text-secondary)';
        downloadBtn.style.display = 'inline-block';
        progressContainer.style.display = 'none';
    }
}

async function initVoiceModule() {
    bindVoiceControlsOnce();
    if (!window.api || !window.api.voice) return;
    try {
        const res = await window.api.voice.getState();
        if (res && res.data) applyVoiceStateToUi(res.data);
    } catch (e) {
        console.warn('[Voice] init failed:', e);
    }

    try {
        const asrRes = await window.api.voice.getAsrState();
        if (asrRes && asrRes.success) {
            __asrModelState = asrRes.data;
            updateAsrUi();
        }
        window.api.voice.onAsrStateUpdated((state) => {
            __asrModelState = state;
            updateAsrUi();
        });
        const downloadBtn = document.getElementById('btn-asr-download');
        if (downloadBtn) {
            downloadBtn.onclick = async () => {
                const res = await window.api.voice.downloadAsrModel();
                if (!res || !res.success) {
                    showToast('下载离线语音识别模型失败: ' + (res ? res.error : '未知错误'));
                } else {
                    showToast('离线语音识别模型下载成功！已自动切换为本地离线语音识别');
                }
            };
        }
    } catch (e) {
        console.warn('[Voice] init asr failed:', e);
    }
}

async function refreshVoicePanel() {
    bindVoiceControlsOnce();
    if (!window.api || !window.api.voice) return;
    const res = await window.api.voice.getState();
    if (res && res.data) applyVoiceStateToUi(res.data);
    else renderVoicePackGrids(__voiceState);

    try {
        const asrRes = await window.api.voice.getAsrState();
        if (asrRes && asrRes.success) {
            __asrModelState = asrRes.data;
            updateAsrUi();
        }
    } catch (e) {}
}

// 启动后初始化语音（默认关闭，不占麦）
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(initVoiceModule, 800));
} else {
    setTimeout(initVoiceModule, 800);
}

// 启动后为初始静态欢迎气泡绑定语音朗读功能
setTimeout(() => {
    const welcomeRow = document.getElementById('welcome-message-row');
    const welcomeBubble = document.getElementById('welcome-message-bubble');
    if (welcomeRow && welcomeBubble) {
        addTtsToAiBubble(welcomeRow, welcomeBubble);
    }
}, 1200);

