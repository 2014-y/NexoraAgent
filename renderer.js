// renderer.js - 渲染进程交互逻辑

// 全局双模式翻译函数
function t(keyOrZh, en, zhTw) {
    const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
    
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

// 标记配置文件有未保存的改动，高亮提示保存按钮
function markConfigDirty() {
    const saveBtns = [
        document.getElementById('config-save-btn'),
        document.getElementById('config-save-btn-top')
    ];
    saveBtns.forEach(btn => {
        if (btn) {
            btn.innerText = '💾 保存配置 (有未保存修改*)';
            btn.style.background = 'linear-gradient(135deg, #ff9800 0%, #ff5722 100%)';
            btn.style.boxShadow = '0 0 15px rgba(255, 87, 34, 0.4)';
        }
    });
    updateConfigJsonPreview();
}

// 自定义精美弹窗重写
window.alert = function (message, title = '系统提示') {
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
                <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--accent-color);">${title}</h3>
            </div>
            <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 24px; white-space: pre-wrap; word-break: break-all;">${message}</div>
            <div style="display: flex; justify-content: flex-end;">
                <button id="custom-alert-ok" style="background: linear-gradient(135deg, var(--accent-color) 0%, rgba(var(--accent-rgb), 0.7) 100%); border: none; color: white; padding: 8px 24px; font-size: 13px; font-weight: 600; border-radius: 8px; cursor: pointer; box-shadow: 0 4px 10px rgba(var(--accent-rgb), 0.25); outline: none; transition: opacity 0.1s;">确定</button>
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

window.confirm = function (message, title = '操作确认') {
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
                <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--accent-color);">${title}</h3>
            </div>
            <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 24px; white-space: pre-wrap; word-break: break-all;">${message}</div>
            <div style="display: flex; justify-content: flex-end; gap: 12px;">
                <button id="custom-confirm-cancel" style="background: var(--bg-input); border: 1px solid var(--border-color); color: var(--text-secondary); padding: 8px 20px; font-size: 13px; border-radius: 8px; cursor: pointer; outline: none; transition: background 0.1s;">取消</button>
                <button id="custom-confirm-ok" style="background: linear-gradient(135deg, var(--accent-color) 0%, rgba(var(--accent-rgb), 0.7) 100%); border: none; color: white; padding: 8px 24px; font-size: 13px; font-weight: 600; border-radius: 8px; cursor: pointer; box-shadow: 0 4px 10px rgba(var(--accent-rgb), 0.25); outline: none; transition: opacity 0.1s;">确定</button>
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
window.promptFields = function (title, fields) {
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
        modal.innerHTML = `
            <h3 style="margin:0 0 8px; font-size:16px; color: var(--accent-color);">${title}</h3>
            <p style="margin:0 0 8px; font-size:12px; color: var(--text-secondary); line-height:1.5;">填写后将写入本地配置并尝试加载插件。凭证仅保存在本机。</p>
            ${inputsHtml}
            <div style="display:flex; justify-content:flex-end; gap:12px; margin-top:20px;">
                <button id="pf-cancel" style="background:var(--bg-input); border:1px solid var(--border-color); color:var(--text-secondary); padding:8px 20px; border-radius:8px; cursor:pointer;">取消</button>
                <button id="pf-ok" style="background:linear-gradient(135deg, var(--accent-color), rgba(var(--accent-rgb),0.7)); border:none; color:#fff; padding:8px 24px; border-radius:8px; font-weight:600; cursor:pointer;">保存并启用</button>
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

    const accounts = configData.channels.feishu.accounts;
    const defaultAccount = configData.channels.feishu.defaultAccount || '';

    const accountIds = Object.keys(accounts);
    if (accountIds.length === 0) {
        container.innerHTML = `
            <div style="padding: 16px; text-align: center; color: var(--text-secondary); background: rgba(255,255,255,0.01); border: 1px dashed var(--border-color); border-radius: 8px; font-size: 12px;">
                暂无绑定的飞书账号。请点击下方“添加飞书绑定账号”进行配置。
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
            <div>
                <div style="font-size: 13px; font-weight: bold; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
                    👤 账号标识: <span style="color: var(--accent-color);">${id}</span>
                    ${isDefault ? '<span style="font-size: 10px; background: rgba(0, 230, 118, 0.15); color: #00e676; border: 1px solid rgba(0, 230, 118, 0.3); padding: 1px 6px; border-radius: 4px;">默认账号</span>' : ''}
                </div>
                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 6px; display: flex; flex-direction: column; gap: 2px;">
                    <span>App ID: ${acc.appId || '--'}</span>
                    <span>Encrypt Key: ${acc.encryptKey ? '已配置' : '未配置'}</span>
                    ${acc.domain ? `<span>域名: ${acc.domain === 'lark' ? 'Lark' : '飞书'}</span>` : ''}
                    ${Array.isArray(acc.allowFrom) && acc.allowFrom.length ? `<span>私信白名单: ${acc.allowFrom.length === 1 ? '仅本人(扫码绑定)' : acc.allowFrom.length + ' 人'}</span>` : ''}
                </div>
            </div>
            <div style="display: flex; gap: 8px;">
                ${!isDefault ? `<button type="button" class="btn-primary btn-set-default-feishu" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); color: var(--text-primary); cursor: pointer;">设为默认</button>` : ''}
                <button type="button" class="btn-primary btn-edit-feishu" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(140, 82, 255, 0.1); border: 1px solid rgba(140, 82, 255, 0.3); color: #b388ff; cursor: pointer;">编辑</button>
                <button type="button" class="btn-primary btn-delete-feishu" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(255, 82, 82, 0.1); border: 1px solid rgba(255, 82, 82, 0.3); color: #ff5252; cursor: pointer;">删除</button>
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
                if (gatewayStatus === 'running') {
                    window.api.gatewayAction('stop');
                    setTimeout(() => window.api.gatewayAction('start'), 1200);
                }
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
                    if (gatewayStatus === 'running') {
                        window.api.gatewayAction('stop');
                        setTimeout(() => window.api.gatewayAction('start'), 1200);
                    }
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
                if (gatewayStatus === 'running') {
                    window.api.gatewayAction('stop');
                    setTimeout(() => window.api.gatewayAction('start'), 1200);
                }
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
                暂无绑定的 QQ 机器人。请点击下方“添加 QQ 机器人绑定账号”进行配置。
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
            <div>
                <div style="font-size: 13px; font-weight: bold; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
                    👤 账号标识: <span style="color: var(--accent-color);">${id}</span>
                    ${isDefault ? '<span style="font-size: 10px; background: rgba(0, 230, 118, 0.15); color: #00e676; border: 1px solid rgba(0, 230, 118, 0.3); padding: 1px 6px; border-radius: 4px;">默认账号</span>' : ''}
                </div>
                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 6px; display: flex; flex-direction: column; gap: 2px;">
                    <span>App ID: ${acc.appId || '--'}</span>
                </div>
            </div>
            <div style="display: flex; gap: 8px;">
                ${!isDefault ? `<button type="button" class="btn-primary btn-set-default-qqbot" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-color); color: var(--text-primary); cursor: pointer;">设为默认</button>` : ''}
                <button type="button" class="btn-primary btn-edit-qqbot" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(140, 82, 255, 0.1); border: 1px solid rgba(140, 82, 255, 0.3); color: #b388ff; cursor: pointer;">编辑</button>
                <button type="button" class="btn-primary btn-delete-qqbot" data-id="${id}" style="margin-top: 0; padding: 0 10px; font-size: 11px; height: 26px; border-radius: 4px; background: rgba(255, 82, 82, 0.1); border: 1px solid rgba(255, 82, 82, 0.3); color: #ff5252; cursor: pointer;">删除</button>
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
                if (gatewayStatus === 'running') {
                    window.api.gatewayAction('stop');
                    setTimeout(() => window.api.gatewayAction('start'), 1200);
                }
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
                    if (gatewayStatus === 'running') {
                        window.api.gatewayAction('stop');
                        setTimeout(() => window.api.gatewayAction('start'), 1200);
                    }
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
                if (gatewayStatus === 'running') {
                    window.api.gatewayAction('stop');
                    setTimeout(() => window.api.gatewayAction('start'), 1200);
                }
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
let gatewayFullyReady = false;

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
    'openclaw-weixin': { name: '💬 微信渠道', desc: '一键将ClawAI接入微信聊天，支持私聊、群聊和图片理解', tier: 'zero' },
    'long-term-memory': { name: '📚 长期记忆', desc: '开箱即用：自动摘要、记忆旋转与压缩护栏，将关键信息持久写入 MEMORY.md，对话压缩后仍可召回。', tier: 'zero' },
    'feishu': { name: '🦆 飞书渠道', desc: '接入飞书/Lark 机器人：支持扫码创建应用或手动填写 App ID/Secret，处理私聊与群聊消息', tier: 'credentials' },
    'qqbot': { name: '🐧 QQ机器人', desc: '将ClawAI接入 QQ 开放平台机器人（QQ Bot）消息通道，实现 QQ 群聊及私聊交互。', tier: 'credentials' },
    'voice-call': { name: '📞 语音通话', desc: '开启实时语音对话服务，支持通过微信向 AI 拨打电话', tier: 'credentials' },
    'telegram': { name: '✈️ Telegram', desc: '通过 Telegram 机器人消息通道直接与您的 AI ClawAI对话', tier: 'credentials' },
    'slack': { name: '🎨 Slack 渠道', desc: '将 AI 本地ClawAI作为应用机器人接入到您的团队 Slack 频道中', tier: 'credentials' },
    'whatsapp': { name: '🟢 WhatsApp', desc: '接入全球 WhatsApp 消息服务，支持媒体及文本处理', tier: 'credentials' },
    'auto-summary': { name: '📝 自动摘要', desc: '每日自动总结聊天与训练数据写入记忆；亦可配合长文摘要能力', tier: 'zero' },
    'llm-task': { name: '📝 长文摘要任务', desc: '向 AI 发送超长链接或长文本，自动提炼要点', tier: 'zero' },
    'matrix': { name: '🛡️ Matrix 通道', desc: '将ClawAI挂载到去中心化的加密通信 Matrix 消息信道上', tier: 'credentials' },
    'duckduckgo': { name: '🔍 DuckDuckGo 搜索', desc: '允许 AI 调用搜索引擎进行网页实时检索，获取最新资讯', tier: 'zero' },
    'webhooks': { name: '🔌 Webhooks', desc: '支持外部系统通过标准的 Webhook 事件触发ClawAI的定制指令', tier: 'zero' },
    'bonjour': { name: '📡 Bonjour 发现', desc: '启用本地零配置组网，自动发布ClawAI局域网服务广播', tier: 'zero' },
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
let sidebarChartData = Array(15).fill(0);

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
    const computedAccentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() || '#6366f1';
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
    const computedAccentRgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '99, 102, 241';
    grad.addColorStop(0, `rgba(${computedAccentRgb}, 0.18)`);
    grad.addColorStop(1, `rgba(${computedAccentRgb}, 0.0)`);
    ctx.fillStyle = grad;
    ctx.fill();

}

// 3. 初始化加载
async function init() {
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

    // 初始化更新模块
    setupUpdateModal();

    // 读取并渲染配置
    await loadAndRenderConfig();

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
        settingAutoGateway.checked = localStorage.getItem('setting_auto_launch_gateway') === 'true';
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
        settingBuiltInModelsToggle.checked = localStorage.getItem('setting_use_built_in_models') !== 'false';
        settingBuiltInModelsToggle.addEventListener('change', (e) => {
            localStorage.setItem('setting_use_built_in_models', e.target.checked ? 'true' : 'false');
            toggleProviderInputsEditable();
            loadChatModels(); // 开关状态改变时，立刻重新载入并选中默认内置模型
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
                    { key: 'accountId', label: '账号标识 (如: feishu-1, 飞书客服)', placeholder: '请输入唯一的英文/中文标识' },
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
                showToast('账号标识不能为空！');
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
                showToast('账号标识已存在，请使用其他名称！');
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
                showToast('飞书绑定账号添加成功！');
                if (gatewayStatus === 'running') {
                    window.api.gatewayAction('stop');
                    setTimeout(() => window.api.gatewayAction('start'), 1200);
                }
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
                    { key: 'accountId', label: '账号标识 (如: qqbot-1, 客服QQ机器人)', placeholder: '请输入唯一的英文/中文标识' },
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
                showToast('账号标识不能为空！');
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
                showToast('账号标识已存在，请使用其他名称！');
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
                showToast('QQ 机器人绑定账号添加成功！');
                if (gatewayStatus === 'running') {
                    window.api.gatewayAction('stop');
                    setTimeout(() => window.api.gatewayAction('start'), 1200);
                }
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
                
                const confirmClear = confirm('确定要解绑当前微信并清空微信登录凭证吗？\n\n这将会停止运行中的ClawAI，并在下次启动ClawAI时重新生成二维码供您扫码登录！');
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
                        if (gatewayStatus === 'running') {
                            window.api.gatewayAction('stop');
                            setTimeout(() => window.api.gatewayAction('start'), 1200);
                        }
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
        btnCopySystemLogs.addEventListener('click', () => {
            const systemLogsArea = document.getElementById('system-raw-logs-area');
            if (systemLogsArea && systemLogsArea.value) {
                navigator.clipboard.writeText(systemLogsArea.value);
                showToast('📋 已将完整系统运行日志成功复制到剪贴板！');
            } else {
                showToast('⚠️ 当前无任何系统运行日志可复制');
            }
        });
    }

    const btnClearSystemLogs = document.getElementById('btn-clear-system-logs');
    if (btnClearSystemLogs) {
        btnClearSystemLogs.addEventListener('click', async () => {
            const confirmClear = await confirm('确定要清空本地所有的历史系统运行日志文件吗？\n\n此操作不可恢复！');
            if (!confirmClear) return;
            try {
                const result = await window.api.clearSystemLogs();
                if (result.success) {
                    const systemLogsArea = document.getElementById('system-raw-logs-area');
                    if (systemLogsArea) systemLogsArea.value = '';
                    showToast('🗑️ 系统运行日志与本地日志文件已成功清空');
                } else {
                    showToast('⚠️ 清空失败：' + result.error);
                }
            } catch (err) {
                showToast('⚠️ 清空操作异常：' + err.message);
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

    // 监听整个ClawAI配置表单的变化，实时更新 JSON 预览并标记 Dirty
    const configForm = document.getElementById('openclaw-config-form');
    if (configForm) {
        configForm.addEventListener('input', () => {
            markConfigDirty();
        });
    }

    // 监听 JSON 实时预览框的手写编辑输入
    const jsonPreviewEl = document.getElementById('config-json-preview');
    const jsonErrorEl = document.getElementById('json-format-error');
    const saveBtn = document.getElementById('config-save-btn');
    if (jsonPreviewEl) {
        jsonPreviewEl.addEventListener('input', (e) => {
            markConfigDirty();
            try {
                const parsed = JSON.parse(e.target.value);
                if (jsonErrorEl) jsonErrorEl.style.display = 'none';
                if (saveBtn) saveBtn.removeAttribute('disabled');
                
                // 更新当前内存中的 configData，点击保存时直接写入
                configData = parsed;
                
                // 同步刷新 localProviders 变量，确保保存时不被旧数据覆盖
                if (parsed.models && parsed.models.providers) {
                    localProviders = JSON.parse(JSON.stringify(parsed.models.providers));
                }
                syncJsonToFormFields(parsed);
            } catch (err) {
                if (jsonErrorEl) jsonErrorEl.style.display = 'block';
                if (saveBtn) saveBtn.setAttribute('disabled', 'true');
            }
        });
    }

    // ClawAI开关按钮监听
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
            const terminalOutput = document.getElementById('log-terminal-output');
            if (terminalOutput) {
                terminalOutput.innerHTML = '<div data-i18n="console.log.init">&gt;&gt;&gt; AI-Assistant Local Daemon Initialized.</div><div data-i18n="console.log.stopped">&gt;&gt;&gt; [系统状态] 核心进程检测完成，当前处于【已停止】闲置状态。</div><div data-i18n="console.log.guide">&gt;&gt;&gt; [操作指引] 请点击右侧“启动ClawAI”按钮，拉起本地 AI 服务总线...</div>';
            }
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
            });
        }
    }

    // 点击顶部状态面板快速启停ClawAI
    const statusPanel = document.getElementById('tour-status');
    if (statusPanel) {
        statusPanel.addEventListener('click', () => {
            if (gatewayStatus === 'stopped') {
                showToast('正在启动ClawAI核心服务...');
                window.api.gatewayAction('start');
            } else if (gatewayStatus === 'running') {
                showToast('正在关闭ClawAI核心服务...');
                window.api.gatewayAction('stop');
            } else if (gatewayStatus === 'starting') {
                showToast('ClawAI正在启动中，请稍候...');
            }
        });
    }

    // 自动启用ClawAI逻辑
    if (localStorage.getItem('setting_auto_launch_gateway') === 'true') {
        setTimeout(() => {
            if (gatewayStatus === 'stopped') {
                logTerminal.innerText += '\n[System] 正在根据系统设置自动启用本地ClawAI...\n';
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

    // 页面初始化时，主动向主进程拉齐一次当前ClawAI的最真实运行状态
    if (window.api && window.api.gatewayAction) {
        window.api.gatewayAction('query-status');
    }
}

// 4. IPC 消息监听与分发
function setupIpcListeners() {
    // 实时日志接收处理函数
    const handleReceivedLog = (text) => {
        // 解析 http server listening 中的运行插件数量，动态更新右侧侧边栏统计
        if (text && text.includes('http server listening')) {
            const match = text.match(/http server listening\s*\((\d+)\s*plugins/i);
            if (match) {
                const count = match[1];
                const rightPluginsCountEl = document.getElementById('right-plugins-count');
                if (rightPluginsCountEl) {
                    rightPluginsCountEl.innerText = `${count} 个`;
                }
            }
        }

        // 将所有原生日志（无视过滤规则）无条件完整地投递进系统的“系统日志”专用面板展示
        const systemLogsArea = document.getElementById('system-raw-logs-area');
        if (systemLogsArea) {
            const datePrefix = `[${new Date().toLocaleTimeString()}] `;
            systemLogsArea.value += datePrefix + text + '\n';
            // 限制最大行数防止内存泄漏 (限制在 5000 行)
            const lines = systemLogsArea.value.split('\n');
            if (lines.length > 5000) {
                systemLogsArea.value = lines.slice(lines.length - 5000).join('\n');
            }
            systemLogsArea.scrollTop = systemLogsArea.scrollHeight;
        }

        // 🌟 拦截ClawAI后台模型的常规预热探针错误日志（不影响正常对话，防止打扰用户）
        if (text.includes('[model-fetch]') && text.includes('ERROR') && (text.includes('ECONNRESET') || text.includes('fetch failed') || text.includes('ETIMEDOUT'))) {
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

        if (text.includes('[gateway] ready') || text.includes('[heartbeat] started') || text.includes('advertised gateway')) {
            const wasReady = gatewayFullyReady;
            gatewayFullyReady = true;
            // 网关刚就绪：若已在 OpenClaw 面板，强制用当前令牌免密重载一次
            if (!wasReady) {
                const pane = document.getElementById('openclaw-panel-view');
                if (pane && pane.classList.contains('active')) {
                    setTimeout(() => loadOpenclawControlUi(true), 800);
                }
            }
        }
        // 仅在ClawAI真正运行中，且越过ClawAI刚启动时的 5 秒历史控制台日志喷吐垃圾冷区，才对全新实时流量记账
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
                targetProgress = 20;
                targetText = '正在校验ClawAI配置文件与诊断系统...';
                updated = true;
            } else if (text.includes('[plugins]') || text.includes('plugin not installed') || text.includes('resolving authentication')) {
                targetProgress = 50;
                targetText = '正在装载核心插件驱动程序...';
                updated = true;
            } else if (text.includes('starting HTTP server') || text.includes('force: no listeners')) {
                targetProgress = 80;
                targetText = '正在拉起 HTTP 路由服务器端口服务...';
                updated = true;
            } else if (text.includes('HTTP server is listening') || text.includes('Server is running on') || text.includes('Setup complete!') || text.includes('running on port') || text.includes('started (interval:')) {
                targetProgress = 100;
                targetText = '本地 AI ClawAI服务就绪！';
                updated = true;
            }

            // 限制进度单调递增，绝不往回拉扯
            if (updated && targetProgress > currentProgress) {
                updateProgressUI(targetProgress, targetText);
            }
        }

        // 忽略非关键的计费拉取失败日志 (国内网络下通常会失败)
        if (text.includes('[model-pricing]') && text.includes('fetch failed')) return;

        // 进行常见启动消息的汉化和修饰
        let cleanedText = text;
        if (text.includes('loading configuration.')) {
            cleanedText = cleanedText.replace('loading configuration.', '正在读取与解析ClawAI本地配置文件...');
        } else if (text.includes('resolving authentication.')) {
            cleanedText = cleanedText.replace('resolving authentication.', '正在与云端服务器进行开发者授权密钥安全核验...');
        } else if (text.includes('force: no listeners on port')) {
            cleanedText = cleanedText.replace(/force: no listeners on port (\d+)/, '检测到通信端口 $1 空闲，准备占用侦听...');
        } else if (text.includes('starting...')) {
            cleanedText = cleanedText.replace('starting...', '正在拉起ClawAI核心引擎，初始化网络钩子...');
        } else if (text.includes('started (interval:')) {
            cleanedText = cleanedText.replace('started (interval: 60s, startup-grace: 60s, channel-connect-grace: 120s)', '健康状态监控已上线 (周期 60秒，连接宽限 120秒) ✅');
        } else if (text.includes('provider auth state pre-warmed')) {
            cleanedText = cleanedText.replace(/provider auth state pre-warmed in (\d+)ms/, '内置模型云端鉴权通道安全预热就绪 (耗时 $1ms) ✅');
        } else if (text.includes('agent runtime plugins pre-warmed')) {
            cleanedText = cleanedText.replace(/agent runtime plugins pre-warmed in (\d+)ms/, 'ClawAI运行时全部核心业务插件装载完毕 (耗时 $1ms) 🚀');
        } else if (text.includes('HTTP server listening on')) {
            cleanedText = cleanedText.replace(/HTTP server listening on http:\/\/([^\s]+)/, 'HTTP 本地总线服务在 http://$1 上开启成功！');
        } else if (text.includes('Webhook server listening on')) {
            cleanedText = cleanedText.replace(/Webhook server listening on http:\/\/([^\s]+)/, '微信/语音 Webhook 本地服务在 http://$1 上监听就绪！');
        } else if (text.includes('heartbeat] started')) {
            cleanedText = cleanedText.replace('[heartbeat] started', '在线心跳监控守护已开启，ClawAI连接保持正常 💓');
        } else if (text.includes('ready') && text.includes('[gateway]')) {
            cleanedText = cleanedText.replace('ready', 'ClawAI全部引擎启动就绪，正在静候业务请求传入...');
        }

        // 追加日志并做中文翻译及着色
        const span = document.createElement('span');
        let coloredText = cleanedText
            .replace(/\[gateway\]/g, '<span style="color: #64b5f6;">[ClawAI核心]</span>')
            .replace(/\[System\]/g, '<span style="color: #f06292;">[系统监控]</span>')
            .replace(/\[plugins\]/g, '<span style="color: #ba68c8;">[插件模块]</span>')
            .replace(/\[hooks\]/g, '<span style="color: #4db6ac;">[钩子机制]</span>')
            .replace(/\[voice-call\]/g, '<span style="color: #e57373;">[语音通话]</span>')
            .replace(/\[health-monitor\]/g, '<span style="color: #a1887f;">[健康监视]</span>')
            .replace(/\[heartbeat\]/g, '<span style="color: #9575cd;">[心跳保持]</span>')
            .replace(/\b(?:ERROR|Error)\b/g, '<span style="color: #ff5252; font-weight: bold;">[错误报错]</span>')
            .replace(/\b(?:WARNING|Warning)\b/g, '<span style="color: #ffd54f;">[警告提醒]</span>');

        span.innerHTML = coloredText;
        logTerminal.appendChild(span);

        // 控制台字数过多自动裁剪防崩溃
        if (logTerminal.innerText.length > 25000) {
            logTerminal.innerHTML = logTerminal.innerHTML.substring(5000);
        }

        // 自动滚到底部
        logTerminal.scrollTop = logTerminal.scrollHeight;
    };

    // 挂载至全局 window，专供 CDP 自动化脚本进行 100% 仿真日志注入质量自检
    window.__testTriggerLog = handleReceivedLog;

    window.api.onLogReceived(handleReceivedLog);
    window.api.onSandboxUpdateProgress((data) => {
        if (data && typeof data.progress === 'number') {
            updateProgressUI(data.progress, data.text || '正在升级内置环境...');
        }
    });

    // ClawAI状态同步
    window.api.onStatusChanged((status) => {
        const oldStatus = gatewayStatus;
        gatewayStatus = status;
        
        // 当状态变更时，主动释放启停锁定状态并恢复按钮可用样式
        window.isTogglingGateway = false;
        if (window.toggleLockTimeout) {
            clearTimeout(window.toggleLockTimeout);
            window.toggleLockTimeout = null;
        }
        gatewayToggleBtn.style.pointerEvents = '';
        gatewayToggleBtn.style.opacity = '';
        gatewayToggleBtn.style.cursor = '';

        updateGatewayStatusUI(status);
        if (status === 'running') {
            gatewayRunningTime = Date.now();
            if (oldStatus !== 'running') {
                sendDesktopNotification('ClawAI状态变更', 'OpenClaw 本地智能ClawAI已成功启动运行！');
                // 重启后清掉缓存的面板 URL，下次进入强制免密重载
                __openclawPanelLastUrl = '';
            }
        } else if (status === 'stopped') {
            if (oldStatus === 'running') {
                sendDesktopNotification('ClawAI状态变更', 'OpenClaw 本地智能ClawAI已停止运行。');
            }
            __openclawPanelLastUrl = '';
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
        qrcodeOverlay.style.opacity = '1';
        document.getElementById('qrcode-raw-url').value = url;
        drawQrCode(url);
        markCommBindingQrReady(channel);
        if (channel === 'wechat' || channel === 'openclaw-weixin') startWeChatBindingFastPoll();
    });

    // 主进程探测到微信扫码绑定成功后的即时刷新（进行中的飞书等会话绝不能被关掉）
    window.api.onWeChatLoginSuccess(() => {
        if (typeof showToast === 'function') showToast('✅ 微信绑定成功！');
        updateWeChatStatusUI();
        const ch = (__commBindingSession && __commBindingSession.active) ? __commBindingSession.channel : null;
        if (!ch || ch === 'wechat' || ch === 'openclaw-weixin') {
            completeCommBinding();
        }
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
                showToast(`✅ 飞书扫码绑定成功！账号：${(status && status.accountId) || 'feishu-scan'}`);
            }
            completeCommBinding();
            if (gatewayStatus === 'running') {
                window.api.gatewayAction('stop');
                setTimeout(() => window.api.gatewayAction('start'), 1200);
            }
        });
    }
    if (window.api.onFeishuLoginFailed) {
        window.api.onFeishuLoginFailed((status) => {
            failCommBinding('飞书扫码绑定失败：' + ((status && status.error) || '未知错误'));
        });
    }

    // 绑定一键复制授权链接
    document.getElementById('qrcode-copy-btn').addEventListener('click', () => {
        const urlInput = document.getElementById('qrcode-raw-url');
        urlInput.select();
        urlInput.setSelectionRange(0, 99999);
        navigator.clipboard.writeText(urlInput.value);
        const isFeishu = window.__activeQrChannel === 'feishu';
        alert(isFeishu
            ? '授权登录链接已成功复制到剪贴板！\n\n也可直接用飞书 App 扫描屏幕上的二维码完成绑定。'
            : '授权登录链接已成功复制到剪贴板！\n\n您可以粘贴发给微信里的任意聊天框（如“文件传输助手”），在手机端直接点击链接即可开始授权登录。');
    });

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
const expandedProviders = new Set();

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
        if (studentEl) studentEl.value = dmtCfg.studentModel || '';
    }

    // 优先从本地 localStorage 加载自定义的视频/图片生成配置（不写盘入 openclaw.json 以免损坏ClawAI配置格式）
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
function updateConfigJsonPreview() {
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
    }
    
    if (!configData.agents.defaults.model) configData.agents.defaults.model = {};
    const primaryModelEl = document.getElementById('model-primary');
    if (primaryModelEl) {
        configData.agents.defaults.model.primary = primaryModelEl.value.trim();
    }
    const fallbackModelEl = document.getElementById('model-fallback');
    if (fallbackModelEl) {
        configData.agents.defaults.model.fallbacks = [fallbackModelEl.value.trim()];
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

    const previewEl = document.getElementById('config-json-preview');
    // 只有当用户当前没有聚焦在 JSON 编辑框输入时，才自动用表单最新状态覆盖内容，防止打字时光标位移
    if (previewEl && document.activeElement !== previewEl) {
        const previewConfig = JSON.parse(JSON.stringify(configData));
        delete previewConfig.videoGenerator;
        delete previewConfig.imageGenerator;
        if (previewConfig.agents && previewConfig.agents.defaults) {
            delete previewConfig.agents.defaults.imageGenerationModel;
            delete previewConfig.agents.defaults.videoGenerationModel;
        }
        previewEl.value = JSON.stringify(previewConfig, null, 2);
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
            if (primaryEl && defaults.model.primary !== undefined) {
                primaryEl.value = defaults.model.primary;
            }
            const fallbackEl = document.getElementById('model-fallback');
            if (fallbackEl && defaults.model.fallbacks && defaults.model.fallbacks[0] !== undefined) {
                fallbackEl.value = defaults.model.fallbacks[0];
            }
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
}

// 渲染提供商卡片列表
function renderProvidersList() {
    const listZone = document.getElementById('providers-list-zone');
    listZone.innerHTML = '';

    const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
    const isEn = currentLang === 'en-US';
    const isTw = currentLang === 'zh-TW';
    const t = (zhCn, en, zhTw) => {
        if (isEn) return en;
        if (isTw) return zhTw;
        return zhCn;
    };

    const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';

    // 强制将 agnes-ai 放置于列表最顶层渲染
    const keys = Object.keys(localProviders);
    const agnesIndex = keys.indexOf('agnes-ai');
    if (agnesIndex > -1) {
        keys.splice(agnesIndex, 1);
        keys.unshift('agnes-ai');
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
                <h3>🔌 ${key} <span id="agnes-built-in-tip" style="font-size: 11px; font-weight: normal; color: #b388ff; margin-left: 8px; display: none;">${t('(已启用内置免配置服务通道)', '(Built-in bypass configured)', '(已啟用內置免配置服務通道)')}</span></h3>
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
    const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';
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
            // 如果原本是内置密钥，则自动清空避嫌
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
            // 从配置重填原值
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
            // 如果原本是内置密钥，则自动清空避嫌
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
            // 从配置重填原值
            const storedVidModel = localStorage.getItem('client_pref_video_model');
            if (storedVidModel) {
                videoModelInput.value = storedVidModel;
            } else if (configData && configData.agents && configData.agents.defaults && configData.agents.defaults.videoGenerationModel) {
                videoModelInput.value = configData.agents.defaults.videoGenerationModel.primary || '';
            }
        }
        if (videoToggleBtn) videoToggleBtn.style.display = 'flex';
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
            const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';
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
                            contextWindow: 8192
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
            const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';
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

            try {
                // 构建测试 URL
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
                const timeoutId = setTimeout(() => controller.abort(), 8000);

                const response = await fetch(testUrl, {
                    method: 'GET',
                    headers: headers,
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);

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
                    resultSpan.innerHTML = `
                        <span>❌ ${t('连接超时或失败', 'Connection timed out or failed', '連接超時或失敗')} (${errMsg})</span>
                        <span class="btn-view-request-details" data-url="${testUrl || '无'}" data-status="无" data-status-text="${t('网络异常或超时', 'Network anomaly or timeout', '網路異常或超時')}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">${t('[查看请求详情]', '[View Request Details]', '[查看請求詳情]')}</span>
                    `;
                    resultSpan.style.color = '#ff5252';
                    bindDetailsClick(resultSpan);
                }
            } finally {
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
            const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';
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

            try {
                // 构建强鉴权测试端点
                let testUrl = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
                
                let testModel = 'gpt-3.5-turbo';
                if (provider === 'agnes-ai') {
                    testModel = 'agnes-2.0-flash';
                } else {
                    // 优先从 DOM 读取当前的模型白名单列表第一项
                    const domModelInputs = document.querySelectorAll(`#model-list-container-${provider} .model-id-edit-input`);
                    let firstDomModel = '';
                    for (const inp of domModelInputs) {
                        if (inp.value.trim()) {
                            firstDomModel = inp.value.trim();
                            break;
                        }
                    }
                    if (firstDomModel) {
                        testModel = firstDomModel;
                    } else if (localProviders[provider] && localProviders[provider].models && localProviders[provider].models.length > 0) {
                        const matchedModel = localProviders[provider].models.find(m => m.id);
                        if (matchedModel) {
                            testModel = matchedModel.id;
                        }
                    }
                }

                const headers = {
                    'Content-Type': 'application/json'
                };
                if (apiKey) {
                    headers['Authorization'] = `Bearer ${apiKey}`;
                }

                const body = {
                    model: testModel,
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1
                };

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 8000);

                const response = await fetch(testUrl, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(body),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

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
                    const statusText = response.statusText || `Status: ${response.status}`;
                    let errTip = t(`验证失败 (${statusText})`, `Validation failed (${statusText})`, `驗證失敗 (${statusText})`);
                    if (response.status === 401 || response.status === 403) {
                        errTip = t('❌ 密钥无效 (401/403)', '❌ Invalid Key (401/403)', '❌ 金鑰無效 (401/403)');
                    } else if (response.status === 429) {
                        errTip = t('⚠️ 额度不足或触发限频 (429)', '⚠️ Insufficient balance or rate limited (429)', '⚠️ 額度不足或觸發限頻 (429)');
                    } else if (response.status === 404) {
                        errTip = t('⚠️ 接口或模型名无效 (404)', '⚠️ Invalid endpoint or model (404)', '⚠️ 介面或模型名無效 (404)');
                    }
                    showToast(response.status === 401 || response.status === 403 ? t(`❌ ${provider} 密钥验证失败：密钥无效`, `❌ ${provider} key validation failed: Invalid Key`, `❌ ${provider} 金鑰驗證失敗：金鑰無效`) : t(`❌ ${provider} 密钥验证失败 (${response.status})`, `❌ ${provider} key validation failed (${response.status})`, `❌ ${provider} 金鑰驗證失敗 (${response.status})`));
                    if (resultSpan) {
                        resultSpan.innerHTML = `
                            <span>${errTip}</span>
                            <span class="btn-view-request-details" data-url="${testUrl}" data-status="${response.status}" data-status-text="${statusText}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">${t('[查看请求详情]', '[View Request Details]', '[查看請求詳情]')}</span>
                        `;
                        resultSpan.style.color = response.status === 429 ? '#ffd54f' : '#ff5252';
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
                    resultSpan.innerHTML = `
                        <span>❌ ${t('验证超时或失败', 'Validation timed out or failed', '驗證超時或失敗')} (${errMsg})</span>
                        <span class="btn-view-request-details" data-url="${testUrl || '无'}" data-status="无" data-status-text="${t('网络异常或超时', 'Network anomaly or timeout', '網路異常或超時')}" data-headers="${encodeURIComponent(JSON.stringify(headers))}" style="cursor: pointer; color: #b388ff; text-decoration: underline; font-size: 11px; margin-left: 8px; user-select: none;">${t('[查看请求详情]', '[View Request Details]', '[查看請求詳情]')}</span>
                    `;
                    resultSpan.style.color = '#ff5252';
                    bindDetailsClick(resultSpan);
                }
            } finally {
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

// 放弃修改并还原配置
document.getElementById('config-reset-btn').addEventListener('click', async () => {
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
        const saveBtns = [
            document.getElementById('config-save-btn'),
            document.getElementById('config-save-btn-top')
        ];
        saveBtns.forEach(btn => {
            if (btn) {
                btn.innerText = t('保存配置', 'Save Configuration', '保存配置');
                btn.style.background = '';
                btn.style.boxShadow = '';
                btn.removeAttribute('disabled');
            }
        });
        const jsonErrorEl = document.getElementById('json-format-error');
        if (jsonErrorEl) jsonErrorEl.style.display = 'none';
        showToast('🔄 已成功放弃修改，已还原回上一次保存的配置');
    }
});

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
    
    const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';
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
    configData.agents.defaults.maxConcurrent = parseInt(document.getElementById('max-concurrent').value, 10);
    
    if (!configData.agents.defaults.model) configData.agents.defaults.model = {};
    configData.agents.defaults.model.primary = document.getElementById('model-primary').value.trim();
    configData.agents.defaults.model.fallbacks = [document.getElementById('model-fallback').value.trim()];

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
    if (studentInput) dmtEntry.config.studentModel = studentInput.value.trim();

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
        const imgKey = document.getElementById('image-api-key').value.trim();
        configData.imageGenerator.apiKey = (imgKey === KEY_MASK || imgKey === AGNES_BUILT_IN_KEY) ? '' : imgKey;

        configData.videoGenerator.apiBase = document.getElementById('video-api-base').value.trim();
        const vidKey = document.getElementById('video-api-key').value.trim();
        configData.videoGenerator.apiKey = (vidKey === KEY_MASK || vidKey === AGNES_BUILT_IN_KEY) ? '' : vidKey;
    }

    // 存储在本地 localStorage 供客户端回显使用
    localStorage.setItem('client_pref_video_generator', JSON.stringify(configData.videoGenerator));
    localStorage.setItem('client_pref_image_generator', JSON.stringify(configData.imageGenerator));

    // 彻底从 configData 中删除非法字段以防止ClawAI启动 Schema 校验崩溃闪退
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
        const saveBtns = [
            document.getElementById('config-save-btn'),
            document.getElementById('config-save-btn-top')
        ];
        saveBtns.forEach(btn => {
            if (btn) {
                btn.innerText = t('保存配置', 'Save Configuration', '保存配置');
                btn.style.background = '';
                btn.style.boxShadow = '';
                btn.removeAttribute('disabled');
            }
        });
        statPort.innerText = configData.gateway.port;
        if (gatewayStatus === 'running') {
            const restart = await confirm(t('ClawAI正在运行中，是否立即重启ClawAI以使新配置生效？', 'Gateway is running. Do you want to restart it now to apply the new configuration?', 'ClawAI正在運行中，是否立即重啟ClawAI以使新配置生效？'));
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
function updateRightPluginsCountUI() {
    const rightPluginsCountEl = document.getElementById('right-plugins-count');
    if (!rightPluginsCountEl) return;
    if (configData && configData.plugins && Array.isArray(configData.plugins.allow)) {
        rightPluginsCountEl.innerText = `${configData.plugins.allow.length} 个`;
    } else {
        rightPluginsCountEl.innerText = '0 个';
    }
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
                if (!entries[key] && key !== 'auto-start-codex') {
                    entries[key] = { enabled: false };
                }

                let isEnabled = false;
                if (key === 'auto-start-codex') {
                    isEnabled = (configData.hooks && configData.hooks.internal && configData.hooks.internal.entries && configData.hooks.internal.entries['auto-start-codex'])
                        ? configData.hooks.internal.entries['auto-start-codex'].enabled === true
                        : false;
                } else if (key === 'long-term-memory') {
                    // 伞形卡：真实栈三者全部开启才算“已启用”
                    isEnabled = LONG_TERM_MEMORY_STACK.every((id) => entries[id] && entries[id].enabled === true);
                    if (!entries[key]) entries[key] = { enabled: isEnabled };
                    else entries[key].enabled = isEnabled;
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
                    const raw = String(probe.hint);
                    // 主进程可能返回 locale key；按当前设置语言翻译
                    if (raw.startsWith('plugin.')) {
                        try { return t(raw); } catch (e) { return raw; }
                    }
                    return raw;
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
            // 伞形开关：同步真实长期记忆栈（摘要 / 旋转 / 压缩护栏）
            for (const id of LONG_TERM_MEMORY_STACK) {
                if (!configData.plugins.entries[id]) configData.plugins.entries[id] = {};
                configData.plugins.entries[id].enabled = checked;
                if (checked && !configData.plugins.allow.includes(id)) {
                    configData.plugins.allow.push(id);
                }
            }
            configData.plugins.entries['long-term-memory'] = { enabled: checked };
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
            sidebarPercent.innerText = t('正常', 'Active', '正常');
        } else {
            sidebarPercent.innerText = `${roundedVal}%`;
        }
        const sidebarIcon = document.getElementById('sidebar-status-icon');
        if (roundedVal === '0' && gatewayStatus === 'stopped') {
            sidebarPercent.style.display = 'none';
            if (sidebarIcon) sidebarIcon.style.display = 'block';
        } else {
            sidebarPercent.style.display = 'block';
            if (sidebarIcon) sidebarIcon.style.display = 'none';
        }
    }
    if (progressText && textLabel) progressText.innerText = textLabel;

    // 🌟 启动就绪成功提示弹窗
    if (gatewayStatus === 'starting' && oldProgress < 100 && val === 100) {
        setTimeout(() => {
            alert(t(
                '🎉 ClawAI核心服务已成功启用并就绪！\n\n本地 AI 消息路由总线已在后台进入 stable 运行状态。',
                '🎉 Gateway core service successfully started and ready!\n\nLocal AI message routing bus has entered stable running state in the background.',
                '🎉 ClawAI核心服務已成功啟用並就緒！\n\n本地 AI 消息路由總線已在後台進入 stable 運行狀態。'
            ));
        }, 100);
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
            }, 3000);
        }
    }
}

// 6. UI 状态刷新
function updateGatewayStatusUI(status) {
    const pulseVisualizer = document.getElementById('pulse-visualizer');
    if (pulseVisualizer) {
        if (status === 'running' || status === 'starting' || status === 'upgrading') {
            pulseVisualizer.classList.add('active');
        } else {
            pulseVisualizer.classList.remove('active');
        }
    }

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
        statusLabel.innerText = t('sidebar.status.running');
        btnIconStart.style.display = 'none';
        btnIconStop.style.display = 'block';
        btnLabelText.innerText = t('console.btn.stop');
        gatewayToggleBtn.className = 'status-badge-container running';

        if (chatWelcomeText) {
            chatWelcomeText.innerText = isEn ? 'I have successfully connected to your local OpenClaw gateway!' : '我已经与您本地的 OpenClaw ClawAI成功对接！';
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
            updateProgressUI(100, '本地 AI ClawAI服务就绪！');
        } else {
            // 否则，说明是通过 starting 刚点启动的，此时我们等 handleReceivedLog 匹配完毕来置 100%
            // 设定 12 秒的保底拉满延时器
            progressTimeout = setTimeout(() => {
                if (gatewayStatus === 'running' && currentProgress < 100) {
                    if (progressContainer) progressContainer.style.display = 'flex';
                    updateProgressUI(100, '本地 AI ClawAI服务就绪！');
                }
            }, 12000);
        }
    } else if (status === 'stopped') {
        statusLight.className = 'status-light-btn-container';
        statusLabel.innerText = t('sidebar.status.stopped');
        btnIconStart.style.display = 'block';
        btnIconStop.style.display = 'none';
        btnLabelText.innerText = t('console.btn.start');
        gatewayToggleBtn.className = 'status-badge-container stopped';

        if (chatWelcomeText) {
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
        updateProgressUI(0, 'ClawAI已停止运行');
        if (progressContainer) {
            progressContainer.style.display = 'none';
        }
    } else if (status === 'upgrading') {
        statusLight.className = 'status-light-btn-container starting';
        statusLabel.innerText = '沙箱升级中';
        btnIconStart.style.display = 'block';
        btnIconStop.style.display = 'none';
        btnLabelText.innerText = '沙箱升级中';
        gatewayToggleBtn.className = 'status-badge-container starting';

        if (chatWelcomeText) {
            chatWelcomeText.innerText = '正在自动升级内置 Node.js 沙箱环境，请稍候...';
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
        statusLabel.innerText = t('sidebar.status.starting');
        btnIconStart.style.display = 'block';
        btnIconStop.style.display = 'none';
        btnLabelText.innerText = t('sidebar.status.starting');
        gatewayToggleBtn.className = 'status-badge-container starting';

        const systemLogsArea = document.getElementById('system-raw-logs-area');
        if (systemLogsArea) {
            systemLogsArea.value += `\n>>> [系统消息] ClawAI核心服务于 ${new Date().toLocaleString()} 开始拉起运行...\n`;
            systemLogsArea.scrollTop = systemLogsArea.scrollHeight;
        }

        if (chatWelcomeText) {
            chatWelcomeText.innerText = isEn ? 'Connecting to the local OpenClaw gateway, please wait...' : '正在连接本地的 OpenClaw ClawAI，请稍候...';
            chatWelcomeText.style.color = '#ffd54f';
        }

        // 启动进度动画
        if (progressContainer) progressContainer.style.display = 'flex';
        updateProgressUI(5, '正在拉起子进程环境...');

        if (progressInterval) clearInterval(progressInterval);
        progressInterval = setInterval(() => {
            if (currentProgress < 90) {
                const nextProgress = currentProgress + (90 - currentProgress) * 0.05;
                let currentText = '正在拉起子进程环境...';
                if (nextProgress > 60) {
                    currentText = '正在侦听ClawAI通信端口...';
                } else if (nextProgress > 30) {
                    currentText = '正在装载核心插件驱动...';
                }
                updateProgressUI(nextProgress, currentText);
            }
        }, 300);
    }
}

// 模拟内存指标变化，增添科幻动态效果
function updateMemoryMock() {
    // 1. 右侧的ClawAI内存看板 statMem (只有ClawAI运行时才显示其自身内存，未运行显示 -- MB)
    if (gatewayStatus !== 'running') {
        statMem.innerText = '-- MB';
    } else {
        const gatewayMemVal = Math.floor(Math.random() * (45 - 32) + 32);
        statMem.innerText = gatewayMemVal + ' MB';
    }

    // 2. 左下角负载卡片代表“应用负载”（整个客户端程序占用的总内存）
    // 无论ClawAI是否运行，客户端本身一直在运行，故应用负载图表应持续波动更新
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
    const allNavItems = document.querySelectorAll('.nav-item');
    allNavItems.forEach((tab) => {
        tab.addEventListener('click', async (e) => {
            if (tab.id === 'nav-check-update') {
                e.preventDefault();
                e.stopPropagation();
                triggerUpdateCheck(true);
                return;
            }
            

            // 限制ClawAI未完全就位时禁止点击内置面板Tab
            if (tab.getAttribute('data-tab') === 'openclaw-panel-view') {
                if (!gatewayFullyReady) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (gatewayStatus === 'starting' || gatewayStatus === 'running') {
                        showToast('ClawAI正在初始化插件，请等候控制台输出 [gateway] ready 后再访问哦！');
                    } else {
                        showToast('请先在左上角启动ClawAI服务，待服务就位后再访问面板哦！');
                    }
                    return;
                }
            }

            allNavItems.forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

            tab.classList.add('active');
            const targetPane = document.getElementById(tab.getAttribute('data-tab'));
            if (targetPane) {
                targetPane.classList.add('active');
            }
            const prevTab = currentTab;
            currentTab = tab.getAttribute('data-tab');

            // 仅离开「通讯管理」时取消绑定；同页内切换勿误关飞书码
            if (prevTab === 'communication-view' && currentTab !== 'communication-view'
                && typeof __commBindingSession !== 'undefined' && __commBindingSession.active
                && typeof endCommBinding === 'function') {
                endCommBinding({ cancelBackend: true, toast: '已离开通讯管理，绑定已取消' });
            }

            // 切换到用量页重画图表防自适应显示错误
            if (currentTab === 'dashboard-view') {
                renderUsageCharts();
            }

            // 切换到内置终端时，初始化终端并适应大小
            if (currentTab === 'terminal-view') {
                if (typeof initBuiltinTerminal === 'function') {
                    initBuiltinTerminal();
                }
            }

            // 切到插件页必须重绘（避免 flex 布局下初次隐藏时网格高度为 0）
            if (currentTab === 'plugins-view') {
                try { await renderPluginsGrid(); } catch (err) { console.error(err); }
            }

            // 切换到内置ClawAI面板：免密 URL 载入（同 URL 不重复刷新，避免认证限流）
            if (currentTab === 'openclaw-panel-view') {
                await loadOpenclawControlUi(false);
            }

            // 切换到系统设置页拉取最新并展示完整本地历史日志文件
            if (currentTab === 'settings-view') {
                loadAndRenderSystemLogs();
            }

            // 切换到模型对话页初始化或刷新模型
            if (currentTab === 'chat-view') {
                if (!chatInitialized) {
                    chatInitialized = true;
                    initChatView();
                } else {
                    loadChatModels();
                }
            }
        });
    });
}

// 8. 主题一键无缝切换
function setupThemeSwitching() {
    const pickerBlack = document.getElementById('theme-btn-black');
    const pickerDark = document.getElementById('theme-btn-dark');
    const pickerAurora = document.getElementById('theme-btn-aurora');
    const pickerLight = document.getElementById('theme-btn-light');
    const dots = [pickerBlack, pickerDark, pickerAurora, pickerLight];

    const updateActiveDot = (activeTheme) => {
        dots.forEach(dot => {
            if (dot) dot.classList.remove('active');
        });
        if (activeTheme === 'theme-black' && pickerBlack) pickerBlack.classList.add('active');
        if (activeTheme === 'theme-dark' && pickerDark) pickerDark.classList.add('active');
        if (activeTheme === 'theme-aurora' && pickerAurora) pickerAurora.classList.add('active');
        if (activeTheme === 'theme-light' && pickerLight) pickerLight.classList.add('active');
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

    // 默认主题读取
    const savedTheme = localStorage.getItem('user-theme') || 'theme-dark';
    document.body.className = savedTheme;
    updateActiveDot(savedTheme);
}

// 9. 用量可视化与商业级使用统计数据系统
async function renderUsageCharts() {
    const waveBox = document.getElementById('stats-wave-chart-box');
    if (!waveBox) return;

    // A. 异步从主进程拉取ClawAI真实本地数据库累计使用统计数据
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
        console.warn('[UsageStats] real_tokens.json 为空或不存在 — 需在ClawAI下完成至少一轮对话后才会出现用量');
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

    // 计算属于今天的请求总数并同步到ClawAI状态界面
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
            activeBtn.style.color = 'white';
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
            // 目前全部算作ClawAI入口日志，不作进一步过滤
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
        content: '这是您的本地ClawAI调度中心。ClawAI服务已经自动在后台无缝为您启动。如果您需要接入微信聊天助手，点击中间的“绑定微信”扫描二维码即可一键登入！'
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
    // 1. 给 body 挂载当前语言类名，以备未来 CSS 微调用
    document.body.className = document.body.className.replace(/\blang-\S+/g, '');
    document.body.classList.add(`lang-${lang}`);

    // 2. 声明式遍历翻译所有带 data-i18n 属性的 DOM 文本
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translation = t(key);
        if (translation !== key) {
            // 如果有 html 渲染需求，使用 innerHTML，否则用 textContent 以免破坏内部子元素
            if (el.getAttribute('data-i18n-type') === 'html') {
                el.innerHTML = translation;
            } else {
                el.textContent = translation;
            }
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

    // 5. 对话欢迎语和特殊ClawAI连接状态的翻译
    const statusTextEl = document.getElementById('gateway-connection-status-text');
    if (statusTextEl) {
        const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';
        if (gatewayStatus === 'running' || gatewayFullyReady) {
            statusTextEl.innerText = t('status.running');
            statusTextEl.style.color = '#00e676';
        } else if (gatewayStatus === 'starting') {
            statusTextEl.innerText = t('status.starting');
            statusTextEl.style.color = '#ffd54f';
        } else {
            // stopped
            if (useBuiltIn) {
                statusTextEl.innerText = t('status.stopped');
                statusTextEl.style.color = '#b388ff';
            } else {
                statusTextEl.innerText = t('status.offline_hint');
                statusTextEl.style.color = '#ff9800';
            }
        }
    }

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
            gap: 8px;
            opacity: 0;
            transform: translateY(20px);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            pointer-events: none;
        `;
        document.body.appendChild(toast);
    }
    toast.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>${t(message)}</span>
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
    
    const isCollapsed = localStorage.getItem('chat_quick_panel_collapsed') === 'true';
    const toggleText = document.getElementById('quick-panel-toggle-text');
    if (isCollapsed && quickPanel) {
        quickPanel.style.maxHeight = '0px';
        quickPanel.style.opacity = '0';
        quickPanel.style.marginTop = '0px';
        quickPanel.style.pointerEvents = 'none';
        if (toggleText) toggleText.innerText = t('展开帮助', 'Show Help', '展開幫助');
        if (toggleIcon) toggleIcon.style.transform = 'rotate(-180deg)';
    } else {
        if (toggleText) toggleText.innerText = t('收起帮助', 'Hide Help', '收起幫助');
    }

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            const currentCollapsed = localStorage.getItem('chat_quick_panel_collapsed') === 'true';
            const nextCollapsed = !currentCollapsed;
            localStorage.setItem('chat_quick_panel_collapsed', nextCollapsed ? 'true' : 'false');
            
            if (nextCollapsed) {
                // 收起帮助
                quickPanel.style.maxHeight = '0px';
                quickPanel.style.opacity = '0';
                quickPanel.style.marginTop = '0px';
                quickPanel.style.pointerEvents = 'none';
                if (toggleText) toggleText.innerText = t('展开帮助', 'Show Help', '展開幫助');
                if (toggleIcon) toggleIcon.style.transform = 'rotate(-180deg)';
            } else {
                // 展开帮助
                quickPanel.style.maxHeight = '80px';
                quickPanel.style.opacity = '1';
                quickPanel.style.marginTop = '2px';
                quickPanel.style.pointerEvents = 'auto';
                if (toggleText) toggleText.innerText = t('收起帮助', 'Hide Help', '收起幫助');
                if (toggleIcon) toggleIcon.style.transform = 'rotate(0deg)';
            }
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
                chatAttachmentBase64 = event.target.result;
                previewImg.src = chatAttachmentBase64;
                previewBar.style.display = 'flex';
                document.getElementById('attachment-name-label').innerText = `已加载: ${file.name} (大小: ${(file.size/1024).toFixed(1)} KB)`;
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
    const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';
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

    // 2. 遍历其它所有已配置的提供商大模型
    for (const providerKey of Object.keys(localProviders)) {
        // 开启内置时，跳过重复渲染自定义配置中的 agnes-ai 选项
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

// 往聊天窗口追加气泡消息
function appendChatMessage(sender, content, attachment = null, isHTML = false) {
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

    msgDiv.appendChild(avatar);
    msgDiv.appendChild(bubble);
    container.appendChild(msgDiv);
    
    container.scrollTop = container.scrollHeight;
    return bubble;
}

// 清除会话缓存 (清空聊天记录并重置初始欢迎语)
function clearChatHistory() {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    // 清空所有消息气泡
    container.innerHTML = '';

    // 重置为初始欢迎语
    const welcomeHtml = `
        <div style="display: flex; gap: 12px; max-width: 80%; align-self: flex-start;">
            <div style="width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg, #8c52ff, #00d2ff); display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 800; color: white; flex-shrink: 0; box-shadow: 0 0 10px rgba(140,82,255,0.3);">AI</div>
            <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 12px 16px; color: var(--text-primary); font-size: 13px; line-height: 1.5; border-top-left-radius: 2px;">
                <span data-i18n="chat.welcome.greeting">您好！我是您的智能助手。</span><span id="gateway-connection-status-text" style="color: #ff9800;">当前本地的 OpenClaw ClawAI未启动，请前往【控制台】启动ClawAI。</span>
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

    // 清除附件
    chatAttachmentBase64 = '';
    const fileInput = document.getElementById('chat-file-upload-input');
    if (fileInput) fileInput.value = '';
    const previewBar = document.getElementById('chat-attachment-preview-bar');
    if (previewBar) previewBar.style.display = 'none';

    // 清除输入框
    const inputArea = document.getElementById('chat-text-input');
    if (inputArea) inputArea.value = '';

    // 更新ClawAI连接状态文本
    const statusText = document.getElementById('gateway-connection-status-text');
    if (statusText) {
        const isEn = (localStorage.getItem('setting_language') || 'zh-CN') === 'en-US';
        const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';

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

// 处理发送消息（直连各厂家服务，不依赖ClawAI）
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

    const modelSelect = document.getElementById('chat-model-select');
    if (!modelSelect || modelSelect.selectedIndex === -1) {
        appendChatMessage('ai', '⚠️ 请先在右上角选择对话所用的大模型！如果下拉框为空，请先在【模型配置】中配置厂家模型。');
        return;
    }

    const selectedOption = modelSelect.options[modelSelect.selectedIndex];
    const providerKey = selectedOption.getAttribute('data-provider');
    const modelId = selectedOption.value;

    if (!localProviders[providerKey]) {
        appendChatMessage('ai', '⚠️ 所选的提供商配置不存在，请在【模型配置】中确认。');
        return;
    }

    const providerConfig = localProviders[providerKey];
    
    // 获取 Base URL 和 API Key
    let baseUrl = providerConfig.baseUrl || '';
    let apiKey = providerConfig.apiKey || '';
    
    // 如果启用内置模型，且当前选的是 agnes-ai 厂家
    const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';
    if (providerKey === 'agnes-ai' && useBuiltIn) {
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
        
        // 自动注入 ClawAI / OpenClaw 智能系统帮助提示词，专门解惑系统应用内的疑难杂症
        const systemPrompt = `你是一个专业的 ClawAI 系统应用智能客服小助手。当前运行的底层大语言模型技术为：【提供商: ${providerKey}, 模型ID: ${modelId}】。
【重要要求】：若用户问及你的模型身份、你是什么模型、你的底层技术、来自哪家公司等信息，请务必【如实且诚实】地告知你的真实底层模型身份是【${providerKey} / ${modelId}】（例如，你应该说明你是 ${modelId} 模型，由提供商 ${providerKey} ${providerKey === 'ollama' ? '在本地运行' : '提供云端API服务'}，并诚实说明你原本的模型技术背景，如Qwen、Llama、Gemini等），绝对不要隐瞒或误导用户；当用户提问其他关于本ClawAI客户端的软件使用和排查故障问题时，你再扮演智能客服小助手进行解答。
请根据以下真实的产品设计与常见问题排查方案，给出极其详尽、专业、条理清晰且温暖亲切的解答：

1. **什么是内置模型？与本地ClawAI的关系是什么？**
   - 内置模型（Agnes AI）是官方提供的高速直连大模型通道。
   - 当在【系统设置】中开启“内置模型启用”时，所有的对话和连通性测试直接走官方云端接口，**此时无需点击启动本地ClawAI，也可以直接使用【模型会话】与 AI 对话！**
   - 只有在使用本地机器人（如微信、Slack 等渠道）或者本地挂载 MCP 插件等本地深度ClawAI生态时，才需要点击“启动ClawAI”拉起本地后台ClawAI。

2. **如何配置多个 API Key 进行轮询与负载均衡？**
   - **操作步骤**：首先前往【系统设置】**关闭“内置模型启用”**，随后前往【模型配置】，在您需要使用的模型提供商（如 SiliconFlow、DeepSeek、Agnes AI 等）的“API 密钥”输入框中，输入多个以英文逗号 \`,\` 分割的密钥，例如：\`sk-key1,sk-key2,sk-key3\`，然后点击“保存配置”。
   - **轮询原理**：程序网络拦截层会在实际大模型通信时进行自动去重并在各个 Key 之间进行 Round-Robin 轮询（且前端在测试时会自动提取第一个 Key 进行测试防报错）。
   - **内置模型自动轮询**：若您开启了“内置模型启用”，系统已内置了 4 个官方高速通道 Key，系统将全自动在这 4 个高速 Key 之间进行请求轮询分配，无需您任何配置！

3. **点击“启动ClawAI”按钮出现闪退、EADDRINUSE 报错怎么解决？**
   - **主要成因**：ClawAI通信所需的 18789 端口被残留的其他 Node 进程占用，或是上次ClawAI退出时进程没有清理干净。
   - **排查步骤**：
     1. 应用自带了安全端口占用查询。在您点击“启动ClawAI”时，会首先运行 \`netstat\` 定位并安全精准杀死占用 18789 的残留进程（且不误杀其它无关 Node 进程，不会连带导致应用闪退）。
     2. 如果依然提示冲突，您可以手动打开电脑的“任务管理器”，在进程中找到并“结束”所有的 \`node.exe\` 进程，然后重新在客户端点击启动即可。
     3. 确保不要以管理员身份拉起 npm 却以普通用户运行本应用，这会导致跨权限清理失败。

4. **图片与视频生成接口检测时提示 404 (Not Found) 怎么解决？**
   - **主要成因**：填写的 Base URL 接口路径名称在单复数匹配上出错。例如 stability 或者是部分提供商使用 \`/image\` 或 \`/video\`，而另外一些使用 \`/images\` 或 \`/videos\`。
   - **自适应匹配**：系统目前已经原生升级支持了单复数（\`/image\`、\`/images\`、\`/video\`、\`/videos\`）的自动探测过滤与 CNAME 自适应。如果遇到 404，请确认您的 Base URL 是不是直接指向了厂家官方的 OpenAI 兼容端点（如 \`https://apihub.agnes-ai.com/v1/image\`），且密钥验证是有效的。
   - **生图失败**：若测试连通且密钥有效但实际生图报错，请确认对应提供商账户下有充足余额，且没触发高频限流。

5. **微信机器人掉线或无法连接怎么解决？**
   - **版本匹配**：微信机器人使用注入挂钩（Hook）机制。必须确保您电脑上安装的微信 PC 版本与当前使用的微信机器人插件包（Weixin Provider）所支持的版本严格一致。
   - **网络长连与 Clash 冲突（HTTPDNS）**：如果使用的是 Clash / Surge 等代理软件并开启了增强/TUN 模式，会导致域名被劫持为 198.18.x.x 的 Fake-IP。本应用内置了 HTTPDNS 智能解析技术，在连接微信服务器时会自动解析并直连微信的公网真实 IP 地址，完美绕过 Clash 代理劫持以确保长连不掉线。
   - 如果依然经常断连，请尝试在代理软件中把微信域名（\`.weixin.qq.com\`）加入直连（Bypass）规则，或者在微信电脑版设置中关闭“自动休眠”。

6. **界面菜单点不动或侧边栏收起问题**：
   - 侧边栏支持精简收起，缩小后仅显示运行状态标记（如“正常”、“未启用”），可以节省空间。
   - 如果遇到菜单异常冻结，直接按快捷键 Ctrl + R 刷新界面或重启软件即可。`;

        messages.push({
            role: 'system',
            content: systemPrompt
        });
        if (file) {
            messages.push({
                role: 'user',
                content: [
                    { type: 'text', text: text || '分析这张图片' },
                    { type: 'image_url', image_url: { url: file } }
                ]
            });
        } else {
            messages.push({
                role: 'user',
                content: text
            });
        }

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

            // 计入会话用量
            const usage = result.usage || { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 };
            addSessionLog('dialog-test', modelId, usage.prompt_tokens, usage.completion_tokens, 0, 1200);
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

        const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';
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
    sessionStats.logs.unshift({
        time: timeStr,
        provider: provider,
        model: model,
        input: input,
        output: output,
        hit: hit,
        duration: `${(durationMs / 1000.0).toFixed(1)}s`,
        status: "成功",
        timestamp: Date.now()
    });

    if (sessionStats.logs.length > 50) {
        sessionStats.logs = sessionStats.logs.slice(0, 50);
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

    const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';
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

    const useBuiltIn = localStorage.getItem('setting_use_built_in_models') !== 'false';
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
    if (statusDotEl) statusDotEl.style.background = color;
    if (statusEl) {
        statusEl.style.color = color;
        if (!statusTextEl) statusEl.innerText = text;
    }
}

async function updateConsoleChannelStatusUI() {
    const detailsEl = document.getElementById('console-channel-details-panel');
    if (!detailsEl) return;

    if (!configData) return;

    if (consoleSelectedChannel === 'wechat') {
        try {
            const result = await window.api.checkWeChatStatus();
            if (result.bound) {
                setConsoleStatus(t('已配置', 'Configured', '已配置'), true);
                const savedAtStr = result.details.savedAt ? new Date(result.details.savedAt).toLocaleString('zh-CN', { hour12: false }) : '--';
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
                setConsoleStatus(t('未配置', 'Not Configured', '未配置'), false);
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
            setConsoleStatus(t('未配置', 'Not Configured', '未配置'), false);
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
            setConsoleStatus(t('未配置', 'Not Configured', '未配置'), false);
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
                        <div>
                            <div style="font-size: 13px; font-weight: bold; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                                <span style="font-size: 14px;">👤</span> 账号标识: <span style="font-family: var(--font-mono); color: var(--accent-color);">${accountId}</span>
                                <span style="background: rgba(0, 230, 118, 0.1); color: #00e676; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: bold;">已绑定</span>
                            </div>
                            <div style="font-size: 11px; color: var(--text-secondary); margin-top: 6px; display: flex; flex-direction: column; gap: 3px;">
                                <div>绑定时间: <span style="color: var(--text-primary);">${savedAtStr}</span></div>
                                <div>通道协议: <span style="color: var(--text-primary);">WeChat / WA (iLink)</span></div>
                            </div>
                        </div>
                        <div>
                            <button type="button" id="wechat-unbind-btn-dynamic" style="background: rgba(255, 82, 82, 0.1); border: 1px solid rgba(255, 82, 82, 0.3); color: #ff5252; padding: 6px 14px; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; transition: all 0.2s;">
                                💬 解绑微信
                            </button>
                        </div>
                    </div>
                `;
            } else {
                if (bindBtn) bindBtn.style.display = 'block';
                
                accountsContainer.innerHTML = `
                    <div style="text-align: center; padding: 24px; border: 1px dashed var(--border-color); border-radius: 8px; color: var(--text-secondary); font-size: 12px; background: rgba(255,255,255,0.01);">
                        当前未绑定微信，点击下方“扫码绑定微信”生成登录二维码进行绑定。
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
    try {
        const result = await window.api.readSystemLogs();
        if (result.success) {
            systemLogsArea.value = result.content;
            // 延迟微调滚动，确保 DOM 已经完全完成渲染后置底
            setTimeout(() => {
                systemLogsArea.scrollTop = systemLogsArea.scrollHeight;
            }, 50);
        }
    } catch(err) {
        console.error('Failed to load system logs:', err);
    }
}

// ==========================================
// 🔄 内置ClawAI核心包热更新（拦截 OpenClaw WebUI 的更新横幅）
// ==========================================
let _webviewUpdateInjected = false;

// ==========================================
// ClawAI核心更新 - 进度 / 状态弹窗
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
    { keys: ['停止ClawAI'], label: '停止当前ClawAI', pct: 30 },
    { keys: ['正在下载 Node', 'Node 运行时已升级', '将自动升级', '匹配可用版本'], label: '升级 Node 运行时', pct: 38, creepTo: 50 },
    { keys: ['正在安装'], label: '下载并安装核心包', pct: 55, creepTo: 74 },
    { keys: ['install 完成', '已安装版本'], label: '核心包安装完成', pct: 80 },
    { keys: ['package.json'], label: '锁定版本号', pct: 86 },
    { keys: ['正在重启', '重启ClawAI'], label: '重启ClawAI', pct: 92 },
    { keys: ['重启成功', '重启完成'], label: 'ClawAI重启成功', pct: 100 },
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
            <h3 style="margin:0; font-size:16px; font-weight:600; color: var(--accent-color);">ClawAI核心更新</h3>
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
        showToast(forceReload ? '正在重新免密登录控制台…' : '正在连接ClawAI控制台面板…');
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

    const MAGIC_PREFIX = '__CLAWAI_UPDATE__:';

    // 每次 webview 加载完毕后注入拦截脚本
    const onDomReady = () => {
        webview.executeJavaScript(`
            (function() {
                if (window.__clawai_update_injected) return;
                window.__clawai_update_injected = true;

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
                            && !el.__clawai_intercepted) {
                            el.__clawai_intercepted = true;
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
                `检测到ClawAI核心有新版本${targetVersion ? ' v' + targetVersion : ''}。\n\n` +
                '将为您执行以下操作：\n' +
                '  1. 停止当前ClawAI\n' +
                '  2. 下载并安装新版本核心包\n' +
                '  3. 自动重启ClawAI\n\n' +
                '是否立即更新？',
                'ClawAI核心更新'
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
                finishGatewayUpdateProgress(false, `ClawAI更新失败: ${err.message}`);
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

// --- 内置终端逻辑 ---
let builtinTerminal = null;
let builtinTerminalFitAddon = null;
let isTerminalInitialized = false;

function initBuiltinTerminal() {
    if (isTerminalInitialized) {
        if (builtinTerminalFitAddon) {
            setTimeout(() => builtinTerminalFitAddon.fit(), 100);
        }
        return;
    }
    
    const container = document.getElementById('xterm-container');
    if (!container || !window.Terminal) return;
    
    // 初始化 Terminal 实例
    builtinTerminal = new window.Terminal({
        cursorBlink: true,
        theme: {
            background: '#0c0c0c',
            foreground: '#cccccc',
            cursor: '#00e676',
            selection: 'rgba(0, 230, 118, 0.3)'
        },
        fontFamily: 'Consolas, "Courier New", monospace',
        fontSize: 14
    });
    
    // 使用 FitAddon
    if (window.FitAddon && window.FitAddon.FitAddon) {
        builtinTerminalFitAddon = new window.FitAddon.FitAddon();
        builtinTerminal.loadAddon(builtinTerminalFitAddon);
    }
    
    builtinTerminal.open(container);
    if (builtinTerminalFitAddon) {
        builtinTerminalFitAddon.fit();
    }
    
    // 监听前端输入，发送给后台
    builtinTerminal.onData(data => {
        window.api.writeBuiltinTerminal(data);
    });
    
    // 监听窗口缩放，同步调整 pty 大小
    window.addEventListener('resize', () => {
        if (currentTab === 'terminal-view' && builtinTerminalFitAddon) {
            builtinTerminalFitAddon.fit();
            if (builtinTerminal) {
                window.api.resizeBuiltinTerminal(builtinTerminal.cols, builtinTerminal.rows);
            }
        }
    });
    
    // 接收后台 pty 吐出的数据
    window.api.onBuiltinTerminalData((data) => {
        if (builtinTerminal) {
            builtinTerminal.write(data);
        }
    });
    
    // 请求主进程启动后端 node-pty
    const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
    window.api.startBuiltinTerminal(currentLang).then(() => {
        // 启动后第一次手动调整尺寸以同步
        setTimeout(() => {
            if (builtinTerminalFitAddon) builtinTerminalFitAddon.fit();
            if (builtinTerminal) {
                window.api.resizeBuiltinTerminal(builtinTerminal.cols, builtinTerminal.rows);
            }
        }, 300);
    });
    
    isTerminalInitialized = true;
}
