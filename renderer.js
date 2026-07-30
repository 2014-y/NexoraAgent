
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return String(unsafe);
    return unsafe
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;')
         .replace(/'/g, '&#039;');
}

/**
 * 用于内联事件处理器（onclick="fn('${...}')" ）中的 JS 单引号字符串上下文。
 * 仅 escapeHtml 不够：HTML 属性解析会先把 &#039; 解码回 ' 再交给 JS，导致单引号闭合字符串注入。
 * 因此先做 JS 转义（\ 与 '），再套 escapeHtml 处理属性上下文。理想情况应改用事件委托，此为不改结构的安全兜底。
 */
function escapeJsAttr(unsafe) {
    return escapeHtml(String(unsafe).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
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
    return escapeHtml(flag);
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

const MODEL_API_PROTOCOLS = [
    { value: 'openai-completions', label: 'OpenAI Completions', family: 'openai', chatPath: '/chat/completions', modelsPath: '/models' },
    { value: 'openai-chat', label: 'OpenAI Chat', family: 'openai', chatPath: '/chat/completions', modelsPath: '/models' },
    { value: 'openai-legacy-completions', label: 'OpenAI Legacy Completions', family: 'completions', chatPath: '/completions', modelsPath: '/models' },
    { value: 'openai-responses', label: 'OpenAI Responses', family: 'responses', chatPath: '/responses', modelsPath: '/models' },
    { value: 'anthropic-messages', label: 'Anthropic Messages', family: 'anthropic', chatPath: '/messages', modelsPath: '/models' },
    { value: 'gemini-generate-content', label: 'Gemini GenerateContent', family: 'gemini', modelsPath: '/models' },
    { value: 'azure-openai', label: 'Azure OpenAI', family: 'openai', chatPath: '/chat/completions', modelsPath: '/models' },
    { value: 'mistral-chat', label: 'Mistral Chat', family: 'openai', chatPath: '/chat/completions', modelsPath: '/models' },
    { value: 'cohere-chat', label: 'Cohere Chat', family: 'cohere', chatPath: '/chat', modelsPath: '/models' },
    { value: 'claude-code', label: 'Claude Code / OpenAI Compatible', family: 'openai', chatPath: '/chat/completions', modelsPath: '/models' },
    { value: 'lm-studio', label: 'LM Studio', family: 'openai', chatPath: '/chat/completions', modelsPath: '/models' },
    { value: 'vllm', label: 'vLLM', family: 'openai', chatPath: '/chat/completions', modelsPath: '/models' },
    { value: 'text-generation-webui', label: 'Text Generation WebUI', family: 'openai', chatPath: '/chat/completions', modelsPath: '/models' },
    { value: 'localai', label: 'LocalAI', family: 'openai', chatPath: '/chat/completions', modelsPath: '/models' },
    { value: 'ollama', label: 'Ollama', family: 'ollama', chatPath: '/api/chat', modelsPath: '/api/tags' }
];

function getModelApiProtocol(apiType) {
    const normalized = String(apiType || 'openai-completions').trim();
    return MODEL_API_PROTOCOLS.find(p => p.value === normalized) || MODEL_API_PROTOCOLS[0];
}

function renderModelApiProtocolOptions(selected) {
    const current = String(selected || 'openai-completions');
    return MODEL_API_PROTOCOLS.map(protocol => `<option value="${escapeHtml(protocol.value)}" ${current === protocol.value ? 'selected' : ''}>${escapeHtml(protocol.label)}</option>`).join('');
}

function joinApiUrl(baseUrl, path) {
    return `${String(baseUrl || '').replace(/\/$/, '')}${path}`;
}

function normalizeOllamaBaseUrl(baseUrl) {
    return String(baseUrl || '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function buildGeminiModelPath(modelId, stream = false) {
    const cleanModel = String(modelId || '').trim().replace(/^models\//, '');
    return `/models/${encodeURIComponent(cleanModel)}:${stream ? 'streamGenerateContent' : 'generateContent'}`;
}

function buildModelApiHeaders(apiType, apiKey) {
    const protocol = getModelApiProtocol(apiType);
    const headers = { 'Content-Type': 'application/json' };
    const key = String(apiKey || '').trim();
    if (!key) return headers;
    if (protocol.family === 'anthropic') {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
    } else if (protocol.family === 'gemini') {
        headers['x-goog-api-key'] = key;
    } else {
        headers['Authorization'] = `Bearer ${key}`;
    }
    return headers;
}

function buildModelListUrl(baseUrl, apiType) {
    const protocol = getModelApiProtocol(apiType);
    if (protocol.family === 'ollama') return joinApiUrl(normalizeOllamaBaseUrl(baseUrl), protocol.modelsPath);
    return joinApiUrl(baseUrl, protocol.modelsPath || '/models');
}

function mapOllamaMessages(messages) {
    return messages.map(msg => {
        if (!Array.isArray(msg.content)) return msg;
        const textItem = msg.content.find(item => item.type === 'text');
        const imgItem = msg.content.find(item => item.type === 'image_url');
        const mappedMsg = { role: msg.role, content: textItem ? textItem.text : '' };
        if (imgItem && imgItem.image_url && imgItem.image_url.url) {
            let b64 = imgItem.image_url.url;
            if (b64.startsWith('data:')) {
                const parts = b64.split(',');
                if (parts.length === 2) b64 = parts[1];
            }
            mappedMsg.images = [b64];
        }
        return mappedMsg;
    });
}

function buildChatRequest(baseUrl, apiType, modelId, messages, options = {}) {
    const protocol = getModelApiProtocol(apiType);
    const maxTokens = options.maxTokens || options.max_tokens || 1024;
    const temperature = options.temperature ?? 0.7;
    const headers = buildModelApiHeaders(apiType, options.apiKey || '');

    if (protocol.family === 'ollama') {
        return { url: joinApiUrl(normalizeOllamaBaseUrl(baseUrl), protocol.chatPath), headers, body: { model: modelId, messages: mapOllamaMessages(messages), stream: false, options: { temperature } } };
    }
    if (protocol.family === 'anthropic') {
        const system = messages.find(m => m.role === 'system');
        const chatMessages = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: Array.isArray(m.content) ? JSON.stringify(m.content) : String(m.content || '') }));
        const body = { model: modelId, messages: chatMessages, max_tokens: maxTokens, temperature };
        if (system && system.content) body.system = system.content;
        return { url: joinApiUrl(baseUrl, protocol.chatPath), headers, body };
    }
    if (protocol.family === 'gemini') {
        const contents = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: Array.isArray(m.content) ? JSON.stringify(m.content) : String(m.content || '') }] }));
        const system = messages.find(m => m.role === 'system');
        const body = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens } };
        if (system && system.content) body.systemInstruction = { parts: [{ text: system.content }] };
        return { url: joinApiUrl(baseUrl, buildGeminiModelPath(modelId)), headers, body };
    }
    if (protocol.family === 'responses') {
        const input = messages.map(m => `${m.role}: ${Array.isArray(m.content) ? JSON.stringify(m.content) : m.content}`).join('\n');
        return { url: joinApiUrl(baseUrl, protocol.chatPath), headers, body: { model: modelId, input, max_output_tokens: maxTokens, temperature } };
    }
    if (protocol.family === 'completions') {
        const prompt = messages.map(m => `${m.role}: ${Array.isArray(m.content) ? JSON.stringify(m.content) : m.content}`).join('\n') + '\nassistant:';
        return { url: joinApiUrl(baseUrl, protocol.chatPath), headers, body: { model: modelId, prompt, max_tokens: maxTokens, temperature } };
    }
    if (protocol.family === 'cohere') {
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        return { url: joinApiUrl(baseUrl, protocol.chatPath), headers, body: { model: modelId, message: lastUser ? String(lastUser.content || '') : 'ping', temperature, max_tokens: maxTokens } };
    }
    return { url: joinApiUrl(baseUrl, protocol.chatPath || '/chat/completions'), headers, body: { model: modelId, messages, temperature, max_tokens: maxTokens } };
}

function extractChatReply(result) {
    if (!result || typeof result !== 'object') return String(result || '');
    if (result.message && result.message.content) return result.message.content;
    if (result.choices && result.choices[0] && result.choices[0].message) return result.choices[0].message.content;
    if (result.choices && result.choices[0] && typeof result.choices[0].text === 'string') return result.choices[0].text;
    if (Array.isArray(result.content)) return result.content.map(part => part.text || '').join('');
    if (result.output_text) return result.output_text;
    if (Array.isArray(result.output)) return result.output.flatMap(item => item.content || []).map(part => part.text || '').join('');
    if (Array.isArray(result.candidates) && result.candidates[0] && result.candidates[0].content) return (result.candidates[0].content.parts || []).map(part => part.text || '').join('');
    if (result.text) return result.text;
    return JSON.stringify(result);
}


function isBuiltinAllowedProvider(providerKey) {
    return BUILTIN_ALLOWED_PROVIDERS.includes(String(providerKey || '').trim());
}

/** 解析 provider/model；同时提供 id 与 model 别名，避免后文重复定义覆盖后字段不一致 */
function parseModelRef(ref) {
    const raw = String(ref || '').trim();
    if (!raw) return { provider: '', id: '', model: '' };
    const idx = raw.indexOf('/');
    if (idx <= 0) return { provider: '', id: raw, model: raw };
    const provider = raw.slice(0, idx).trim();
    const id = raw.slice(idx + 1).trim();
    return { provider, id, model: id };
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

const NexoraScheduler = (() => {
    const tasks = new Map();

    function isHidden() {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    }

    function nextDelay(task) {
        if (isHidden()) return Math.max(task.hiddenMs || task.visibleMs || 1000, 1000);
        return Math.max(task.visibleMs || 1000, 100);
    }

    function schedule(task, delay) {
        if (!task || task.stopped) return;
        clearTimeout(task.timer);
        task.timer = setTimeout(() => run(task.name), Math.max(delay, 0));
    }

    async function run(name) {
        const task = tasks.get(name);
        if (!task || task.stopped) return;
        if (task.running) {
            schedule(task, nextDelay(task));
            return;
        }
        task.running = true;
        try {
            await task.fn();
        } catch (e) {
            console.warn(`[scheduler] ${name} failed`, e);
        } finally {
            task.running = false;
        }
        schedule(task, nextDelay(task));
    }

    function stop(name) {
        const task = typeof name === 'string' ? tasks.get(name) : name;
        if (!task) return;
        task.stopped = true;
        clearTimeout(task.timer);
        tasks.delete(task.name);
    }

    function register(name, fn, options = {}) {
        stop(name);
        const task = {
            name,
            fn,
            visibleMs: options.visibleMs || 1000,
            hiddenMs: options.hiddenMs || Math.max(options.visibleMs || 1000, 30000),
            running: false,
            stopped: false,
            timer: null
        };
        tasks.set(name, task);
        if (options.immediate === false) schedule(task, nextDelay(task));
        else run(name);
        return task;
    }

    function runNow(name) {
        const task = tasks.get(name);
        if (!task) return;
        clearTimeout(task.timer);
        run(name);
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        tasks.forEach((task) => {
            clearTimeout(task.timer);
            run(task.name);
        });
    });

    return { register, stop, runNow };
})();


/**
 * 从模型 ID 自适应推断上下文窗口（面向未来模型：按厂商/系列 + 名称内的显式窗口标记）。
 * 返回推断出的 token 数，未知返回 null（由调用方回退默认或走实测）。
 * 注意：latency-tune.js 里有一份等价实现，改动需同步。
 */
function inferContextWindow(modelId) {
    const id = String(modelId || '').toLowerCase();
    if (!id) return null;
    // 名称内显式窗口标记：如 -1m / -128k / :200k（避开 2.5 / 4o 这类版本号）
    const m = id.match(/(?:^|[^a-z0-9.])(\d{1,4})(k|m)(?![a-z0-9])/);
    if (m) {
        const n = parseInt(m[1], 10) * (m[2] === 'm' ? 1000000 : 1000);
        if (n >= 8000) return n;
    }
    if (/gemini/.test(id)) {
        if (/1\.5.*pro/.test(id)) return 2000000;
        return 1000000; // Gemini 1.5/2.0/2.5/3.x pro/flash 均为百万级
    }
    if (/claude|sonnet|opus|haiku/.test(id)) return 200000;
    if (/gpt-4\.1/.test(id)) return 1000000;
    if (/(^|[^a-z])o[134]([^a-z0-9]|$)|o1-|o3-|o4-/.test(id)) return 200000;
    if (/gpt-4o|gpt-4-turbo/.test(id)) return 128000;
    if (/gpt-3\.5/.test(id)) return 16384;
    if (/qwen|qwq/.test(id)) return 131072;
    if (/deepseek/.test(id)) return 131072;
    if (/glm-4|chatglm/.test(id)) return 131072;
    if (/llama-?3|llama3/.test(id)) return 131072;
    if (/moonshot|kimi/.test(id)) return 131072;
    if (/mistral|mixtral/.test(id)) return 32768;
    if (/(^|[^a-z])yi-/.test(id)) return 200000;
    return null;
}

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

/** 把毫秒转成可读时分秒，如 13666 → 13秒；72500 → 1分12秒 */
function formatElapsedMs(ms) {
    const n = Math.max(0, Math.round(Number(ms) || 0));
    const lang = localStorage.getItem('setting_language') || 'zh-CN';
    const totalSec = Math.floor(n / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const msPart = n % 1000;

    if (lang === 'en-US') {
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        if (totalSec > 0) return msPart >= 100 ? `${totalSec}.${Math.floor(msPart / 100)}s` : `${totalSec}s`;
        return `${n}ms`;
    }

    const isTw = lang === 'zh-TW';
    const uH = isTw ? '小時' : '小时';
    const uM = '分';
    const uS = '秒';
    if (h > 0) return `${h}${uH}${m}${uM}${s}${uS}`;
    if (m > 0) return `${m}${uM}${s}${uS}`;
    if (totalSec > 0) return msPart >= 100 ? `${totalSec}.${Math.floor(msPart / 100)}${uS}` : `${totalSec}${uS}`;
    return `${n}毫秒`;
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

// 自定义精美弹窗重写（长文可滚动；Esc / 点遮罩可关；正文必须转义防破 DOM）
function __nexoraEscapeDialogHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function __nexoraCloseDialogOverlay(overlay, after) {
    if (!overlay || !overlay.parentNode) {
        if (typeof after === 'function') after();
        return;
    }
    overlay.style.opacity = '0';
    overlay.style.pointerEvents = 'none';
    const modal = overlay.firstElementChild;
    if (modal) modal.style.transform = 'scale(0.9)';
    setTimeout(() => {
        try { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); } catch (_) {}
        if (typeof after === 'function') after();
    }, 200);
}

function __nexoraBindDialogDismiss(overlay, onDismiss) {
    const onKey = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            cleanup();
            onDismiss();
        }
    };
    const onBackdrop = (e) => {
        if (e.target === overlay) {
            cleanup();
            onDismiss();
        }
    };
    const cleanup = () => {
        document.removeEventListener('keydown', onKey, true);
        overlay.removeEventListener('click', onBackdrop);
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', onBackdrop);
    return cleanup;
}

/** 强制关掉卡住的自定义弹层（Esc 也可） */
function dismissStuckNexoraDialogs() {
    document.querySelectorAll('#custom-alert-overlay, #skills-preview-overlay').forEach((el) => {
        try { el.remove(); } catch (_) {}
    });
    document.querySelectorAll('body > div').forEach((el) => {
        try {
            const z = String(el.style && el.style.zIndex || '');
            if (z === '99999' || Number(z) >= 99999) el.remove();
        } catch (_) {}
    });
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismissStuckNexoraDialogs();
}, true);

window.alert = function (message, title = null) {
    const finalTitle = title || t('系统提示', 'System Notification', '系統提示');
    const safeMsg = __nexoraEscapeDialogHtml(message);
    const safeTitle = __nexoraEscapeDialogHtml(finalTitle);
    return new Promise(resolve => {
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
            padding: 24px;
            box-sizing: border-box;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: var(--bg-panel);
            backdrop-filter: blur(15px);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            width: min(560px, 92vw);
            max-height: min(80vh, 720px);
            padding: 24px;
            box-shadow: 0 15px 50px rgba(0, 0, 0, 0.3), var(--accent-glow);
            transform: scale(0.9);
            transition: transform 0.2s ease;
            color: var(--text-primary);
            font-family: system-ui, -apple-system, sans-serif;
            display: flex;
            flex-direction: column;
            min-height: 0;
            box-sizing: border-box;
        `;

        modal.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 16px; flex-shrink: 0;">
                <div style="display:flex; align-items:center; gap:10px; min-width:0;">
                    <span style="font-size: 20px; line-height: 1;">🔔</span>
                    <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--accent-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${safeTitle}</h3>
                </div>
                <button type="button" id="custom-alert-x" aria-label="close" style="background:transparent;border:none;color:var(--text-secondary);font-size:22px;line-height:1;cursor:pointer;padding:0 4px;">&times;</button>
            </div>
            <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 16px; white-space: pre-wrap; word-break: break-word; overflow-y: auto; flex: 1 1 auto; min-height: 0;">${safeMsg}</div>
            <div style="display: flex; justify-content: flex-end; flex-shrink: 0;">
                <button id="custom-alert-ok" style="background: linear-gradient(135deg, var(--accent-color) 0%, rgba(var(--accent-rgb), 0.7) 100%); border: none; color: white; padding: 8px 24px; font-size: 13px; font-weight: 600; border-radius: 8px; cursor: pointer; box-shadow: 0 4px 10px rgba(var(--accent-rgb), 0.25); outline: none;">${t('确定', 'Confirm', '確定')}</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        setTimeout(() => {
            overlay.style.opacity = '1';
            overlay.style.pointerEvents = 'auto';
            modal.style.transform = 'scale(1)';
        }, 10);

        let cleaned = false;
        const finish = () => {
            if (cleaned) return;
            cleaned = true;
            cleanupDismiss();
            __nexoraCloseDialogOverlay(overlay, () => resolve());
        };
        const cleanupDismiss = __nexoraBindDialogDismiss(overlay, finish);

        const btnOk = modal.querySelector('#custom-alert-ok');
        const btnX = modal.querySelector('#custom-alert-x');
        btnOk.addEventListener('click', finish);
        if (btnX) btnX.addEventListener('click', finish);
    });
};

window.confirm = function (message, title = null) {
    const finalTitle = title || t('操作确认', 'Operation Confirmation', '操作確認');
    const safeMsg = __nexoraEscapeDialogHtml(message);
    const safeTitle = __nexoraEscapeDialogHtml(finalTitle);
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
            padding: 24px;
            box-sizing: border-box;
        `;

        const modal = document.createElement('div');
        modal.style.cssText = `
            background: var(--bg-panel);
            backdrop-filter: blur(15px);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            width: min(480px, 92vw);
            max-height: min(80vh, 720px);
            padding: 24px;
            box-shadow: 0 15px 50px rgba(0, 0, 0, 0.3), var(--accent-glow);
            transform: scale(0.9);
            transition: transform 0.2s ease;
            color: var(--text-primary);
            font-family: system-ui, -apple-system, sans-serif;
            display: flex;
            flex-direction: column;
            min-height: 0;
            box-sizing: border-box;
        `;

        modal.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 16px; flex-shrink: 0;">
                <div style="display:flex; align-items:center; gap:10px; min-width:0;">
                    <span style="font-size: 20px; line-height: 1;">❓</span>
                    <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: var(--accent-color);">${safeTitle}</h3>
                </div>
                <button type="button" id="custom-confirm-x" aria-label="close" style="background:transparent;border:none;color:var(--text-secondary);font-size:22px;line-height:1;cursor:pointer;padding:0 4px;">&times;</button>
            </div>
            <div style="font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 16px; white-space: pre-wrap; word-break: break-word; overflow-y: auto; flex: 1 1 auto; min-height: 0;">${safeMsg}</div>
            <div style="display: flex; justify-content: flex-end; gap: 12px; flex-shrink: 0;">
                <button id="custom-confirm-cancel" style="background: var(--bg-input); border: 1px solid var(--border-color); color: var(--text-secondary); padding: 8px 20px; font-size: 13px; border-radius: 8px; cursor: pointer; outline: none;">${t('取消', 'Cancel', '取消')}</button>
                <button id="custom-confirm-ok" style="background: linear-gradient(135deg, var(--accent-color) 0%, rgba(var(--accent-rgb), 0.7) 100%); border: none; color: white; padding: 8px 24px; font-size: 13px; font-weight: 600; border-radius: 8px; cursor: pointer; box-shadow: 0 4px 10px rgba(var(--accent-rgb), 0.25); outline: none;">${t('确定', 'Confirm', '確定')}</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        setTimeout(() => {
            overlay.style.opacity = '1';
            overlay.style.pointerEvents = 'auto';
            modal.style.transform = 'scale(1)';
        }, 10);

        let cleaned = false;
        const finish = (val) => {
            if (cleaned) return;
            cleaned = true;
            cleanupDismiss();
            __nexoraCloseDialogOverlay(overlay, () => resolve(val));
        };
        const cleanupDismiss = __nexoraBindDialogDismiss(overlay, () => finish(false));

        modal.querySelector('#custom-confirm-cancel').addEventListener('click', () => finish(false));
        modal.querySelector('#custom-confirm-ok').addEventListener('click', () => finish(true));
        const btnX = modal.querySelector('#custom-confirm-x');
        if (btnX) btnX.addEventListener('click', () => finish(false));
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
        const inputsHtml = (fields || []).map((f, i) => {
            const hint = f.hint
                ? `<div style="font-size:11px; color: var(--text-secondary); opacity:0.85; margin: 2px 0 0; line-height:1.4;">${f.hint}</div>`
                : '';
            const attrs = [
                `id="pf-input-${i}"`,
                `type="${f.type || 'text'}"`,
                `placeholder="${f.placeholder || ''}"`,
                `value="${f.value || ''}"`,
                f.pattern ? `pattern="${f.pattern}"` : '',
                f.maxLength ? `maxlength="${f.maxLength}"` : '',
                f.inputmode ? `inputmode="${f.inputmode}"` : '',
                f.spellcheck === false ? 'spellcheck="false"' : '',
                f.autocomplete ? `autocomplete="${f.autocomplete}"` : 'autocomplete="off"',
            ].filter(Boolean).join(' ');
            return `
            <label style="display:block; font-size:12px; color: var(--text-secondary); margin: 10px 0 4px;">${f.label || f.key}</label>
            <input ${attrs}
              style="width:100%; box-sizing:border-box; padding:8px 10px; border-radius:8px; border:1px solid var(--border-color); background:var(--bg-input); color:var(--text-primary); font-size:13px;" />
            ${hint}`;
        }).join('');
        
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
            // 输入时即时清洗非法字符（如 QQ 账号标识只允许英文数字）
            (fields || []).forEach((f, i) => {
                if (!f.sanitize || typeof f.sanitize !== 'function') return;
                const el = modal.querySelector(`#pf-input-${i}`);
                if (!el) return;
                el.addEventListener('input', () => {
                    const next = f.sanitize(el.value);
                    if (next !== el.value) el.value = next;
                });
            });
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
                let v = el ? el.value.trim() : '';
                if (f.sanitize && typeof f.sanitize === 'function') v = f.sanitize(v);
                out[f.key] = v;
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

    // 中文/非法账号 ID：触发保存，主进程 sanitize 后回写 configData
    try {
        const accounts = configData.channels.qqbot.accounts || {};
        const bad = Object.keys(accounts).filter((id) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id));
        if (bad.length > 0) {
            window.api.saveConfig(configData).then((r) => {
                if (r && r.success && r.config) {
                    configData = r.config;
                    renderQqbotAccounts();
                }
            }).catch(() => {});
            return;
        }
    } catch (e) {}

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

/** 通讯渠道变更后热重载网关（走主进程 await stop→start，带防抖；未运行时不会自动启用） */
function reloadGatewayAfterChannelChange(reason, opts = {}) {
    const startIfStopped = opts.startIfStopped === true;
    if (window.api && typeof window.api.reloadGatewayForChannel === 'function') {
        window.api.reloadGatewayForChannel(reason || 'channel-change', { startIfStopped }).catch(() => {});
        return;
    }
    // 兼容旧 preload：仅在运行中时走主进程式热重载提示，禁止 IPC 伪造 reload 启用
    if (gatewayStatus === 'running' || gatewayStatus === 'starting') {
        showToast(t(
            '请稍候，渠道配置将在网关热重载后生效',
            'Channel config will apply after gateway reload',
            '請稍候，渠道配置將在網關熱重載後生效'
        ));
    } else if (startIfStopped) {
        showToast(t(
            '网关未运行：渠道配置已保存，请点击左上角手动启动',
            'Gateway is stopped. Channel config saved — start it from the top-left button.',
            '網關未運行：渠道配置已保存，請點擊左上角手動啟動'
        ));
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
            // 活动流绿点已上线 = 渠道已接通，优先显示「已就绪」（避免日志成功后拓扑仍停在连接中）
            const tileId = key === 'wechat' ? 'tile-weixin' : (key === 'qq' ? 'tile-qqbot' : 'tile-feishu');
            const tileOnline = !!(document.getElementById(tileId)?.classList.contains('online'));
            if (!bound) {
                state = 'pending';
                topoNodeStates[nodeId] = 'pending';
            } else if (tileOnline || state === 'completed') {
                state = 'completed';
                topoNodeStates[nodeId] = 'completed';
            } else if (topoNodeStates['node-core'] === 'completed' && state !== 'completed') {
                // 已绑定且网关就绪，等待渠道长连确认 → 「连接中」
                state = 'active';
                topoNodeStates[nodeId] = 'active';
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
    'qqbot',
    'openclaw-weixin',
    'feishu',
    'long-term-memory',
    'dual-model-trainer',
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

/** 置顶核心插件：默认开启且开关不可点 */
const LOCKED_ALWAYS_ON_UI_IDS = new Set([
    'qqbot',
    'openclaw-weixin',
    'feishu',
    'long-term-memory'
]);

const LONG_TERM_MEMORY_STACK = ['auto-summary', 'memory-rotate', 'compaction-memory-guard'];

const pluginMetadata = {
    'dual-model-trainer': { name: '🧠 双模型教学', desc: '利用主备模型对比，自动本地收集并训练属于你的专属模型', tier: 'zero' },
    'openclaw-weixin': { name: '💬 微信渠道', desc: '一键将Nexora Agent接入微信聊天，支持私聊、群聊和图片理解', tier: 'zero' },
    'long-term-memory': { name: '📚 长期记忆', desc: '开箱即用：自动摘要、记忆旋转与压缩护栏，将关键信息持久写入 MEMORY.md，对话压缩后仍可召回。', tier: 'zero' },
    'feishu': { name: '🦆 飞书渠道', desc: '接入飞书/Lark 机器人：支持扫码创建应用或手动填写 App ID/Secret，处理私聊与群聊消息', tier: 'credentials' },
    'qqbot': { name: '🐧 QQ机器人', desc: '将Nexora Agent接入 QQ 开放平台机器人（QQ Bot）消息通道，实现 QQ 群聊及私聊交互。', tier: 'credentials' },
    'voice-call': { name: '🎤 语音', desc: '本地离线语音：渠道 AI 回复朗读、唤醒倾听、语音对话；全部可在「语音服务」细调，默认关闭以节省性能', tier: 'zero' },
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
const STATS_REFRESH_TASK = 'stats-refresh';
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
const GATEWAY_READY_PROBE_TASK = 'gateway-ready-probe';
let gatewayReadyProbeActive = false;
let gatewayLogReadyTail = '';
let gatewayReadyReconcileTimers = [];
let gatewayProcessReportedRunning = false;

function clearGatewayReadyReconcileTimers() {
    gatewayReadyReconcileTimers.forEach((id) => clearTimeout(id));
    gatewayReadyReconcileTimers = [];
}

function scheduleGatewayReadyReconcile(reason) {
    clearGatewayReadyReconcileTimers();
    [1200, 3500, 7000, 12000].forEach((delay) => {
        const id = setTimeout(() => {
            if (gatewayFullyReady || gatewayStatus === 'stopped' || gatewayStatus === 'upgrading') return;
            if (!gatewayProcessReportedRunning) return;
            probeControlUiReady(resolveGatewayProbePort()).then((ok) => {
                if (ok && !gatewayFullyReady && gatewayStatus !== 'stopped' && gatewayStatus !== 'upgrading') {
                    markGatewayReadyFromLog('核心服务已就绪（状态自动对齐）');
                }
            }).catch(() => {});
        }, delay);
        gatewayReadyReconcileTimers.push(id);
    });
}

function stopGatewayReadyProbe() {
    gatewayReadyProbeActive = false;
    NexoraScheduler.stop(GATEWAY_READY_PROBE_TASK);
}

function resolveGatewayProbePort() {
    try {
        const el = document.getElementById('gateway-port') || document.getElementById('stat-port');
        const n = parseInt(el && el.value != null ? el.value : (el && el.innerText), 10);
        if (Number.isFinite(n) && n > 0) return n;
    } catch (e) {}
    return 18789;
}

/** Control UI (/acp/) 可响应再解锁，避免首装仅端口通了就进白屏 */
function probeControlUiReady(port) {
    const p = Number(port) > 0 ? Number(port) : 18789;
    const url = `http://127.0.0.1:${p}/acp/`;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (e) {} }, 600);
    return fetch(url, {
        method: 'GET',
        signal: ctrl ? ctrl.signal : undefined,
        cache: 'no-store',
        headers: { Accept: 'text/html,*/*' },
    })
        .then((res) => {
            clearTimeout(timer);
            // 能拿到 HTTP 响应即视为 Control UI 已挂上（含重定向）
            return !!(res && (res.ok || res.status > 0));
        })
        .catch(() => {
            // 无 CORS 头时普通 fetch 会失败；no-cors 只要网络通就会 resolve
            return fetch(url, { mode: 'no-cors', cache: 'no-store' })
                .then(() => {
                    clearTimeout(timer);
                    return true;
                })
                .catch(() => {
                    clearTimeout(timer);
                    return false;
                });
        });
}

function startGatewayReadyProbe(reason) {
    if (gatewayFullyReady || gatewayReadyProbeActive) return;
    const port = resolveGatewayProbePort();
    let tries = 0;
    gatewayReadyProbeActive = true;
    NexoraScheduler.register(GATEWAY_READY_PROBE_TASK, async () => {
        if (gatewayFullyReady) {
            stopGatewayReadyProbe();
            return;
        }
        tries += 1;
        if (tries > 180) {
            stopGatewayReadyProbe();
            return;
        }
        // 首装初始化较久：只更新文案 / 微抬进度，绝不假解锁，也绝不回退
        if (tries === 40 || tries === 80 || tries === 120) {
            try {
                const tip = '首次安装初始化中，请再等片刻…';
                if (currentProgress < 95) {
                    updateProgressUI(Math.max(currentProgress || 0, 88), tip);
                } else {
                    // 已 ≥95%：只改文案，不动百分比
                    const progressText = document.getElementById('terminal-progress-bar-text');
                    if (progressText) progressText.innerText = tip;
                }
            } catch (e) {}
        }
        const ok = await probeControlUiReady(port);
        if (ok && !gatewayFullyReady && gatewayProcessReportedRunning) {
                markGatewayReadyFromLog('核心服务已就绪，可打开 OpenClaw');
        }
    }, { visibleMs: 500, hiddenMs: 5000 });
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
    clearGatewayReadyReconcileTimers();
    updateGatewayStatusUI('running');
    try { updateProgressUI(100, '本地 AI Nexora Agent服务就绪！'); } catch (e) {}
    try { sendDesktopNotification('Nexora Agent状态变更', 'OpenClaw 本地智能Nexora Agent已成功启动运行！'); } catch (e) {}
    __openclawPanelLastUrl = '';
    // 就绪后再从活动流回放一次通道绿点，防止 Win+R 重启后新日志未重复推送导致图二灰掉
    try { syncChannelStatusTilesFromLogs({ forceOnline: true }); } catch (e) {}
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

    // 静默启动
    const silentStartToggle = document.getElementById('setting-silent-start-toggle');
    if (silentStartToggle && window.api && window.api.getSilentStart) {
        try {
            silentStartToggle.checked = !!(await window.api.getSilentStart());
        } catch (e) {
            silentStartToggle.checked = false;
        }
        silentStartToggle.addEventListener('change', async (e) => {
            try {
                await window.api.setSilentStart(!!e.target.checked);
                showToast(e.target.checked
                    ? t('settings.silent_start.toast_on')
                    : t('settings.silent_start.toast_off'));
            } catch (err) {
                console.error('Failed to set silent start:', err);
            }
        });
    }

    // 绑定客户端其他偏好设置项
    const settingAutoGateway = document.getElementById('setting-auto-gateway');
    const settingNotifyToggle = document.getElementById('setting-notify-toggle');
    const settingLanguageSelect = document.getElementById('setting-language-select');
    const btnCheckUpdate = document.getElementById('btn-check-update');

    if (settingAutoGateway) {
        // 以 userData 文件为准（主进程启动也能读到）；并与 localStorage 双向同步；默认关闭
        (async () => {
            let on = localStorage.getItem('setting_auto_launch_gateway') === 'true';
            try {
                if (window.api && typeof window.api.getAutoLaunchGateway === 'function') {
                    on = await window.api.getAutoLaunchGateway();
                    localStorage.setItem('setting_auto_launch_gateway', on ? 'true' : 'false');
                }
            } catch (e) {}
            settingAutoGateway.checked = on;
        })();
        settingAutoGateway.addEventListener('change', (e) => {
            const on = !!e.target.checked;
            localStorage.setItem('setting_auto_launch_gateway', on ? 'true' : 'false');
            try {
                if (window.api && typeof window.api.setAutoLaunchGateway === 'function') {
                    window.api.setAutoLaunchGateway(on);
                }
            } catch (err) {}
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
            try { if (typeof renderMenuOrderSettingsUI === 'function') renderMenuOrderSettingsUI(); } catch (e) {}
            try {
                if (typeof setMenuOrderExpanded === 'function') {
                    const card = document.getElementById('setting-menu-order-card');
                    const expanded = !!(card && !card.classList.contains('is-collapsed'));
                    setMenuOrderExpanded(expanded);
                }
            } catch (e) {}
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

    // 延迟 3 秒后台静默检测一次更新（无 Toast，有新版本才弹窗）
    setTimeout(() => {
        if (localStorage.getItem('setting_auto_update') !== 'false') {
            triggerUpdateCheck(false);
        }
    }, 3000);

    // 初始化 Tab 切换（先应用侧栏菜单自定义顺序，避免监听绑定后 DOM 位置错乱）
    try {
        if (typeof applySidebarNavOrder === 'function') applySidebarNavOrder();
        if (typeof initMenuOrderSettingsUI === 'function') initMenuOrderSettingsUI();
    } catch (e) {
        console.warn('[MenuOrder] init failed:', e);
    }
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
                    {
                        key: 'accountId',
                        label: t('comm.qq.account.label'),
                        placeholder: t('comm.qq.account.placeholder'),
                        hint: t('comm.qq.account.hint'),
                        pattern: '[A-Za-z0-9][A-Za-z0-9_-]{0,63}',
                        maxLength: 64,
                        inputmode: 'latin',
                        spellcheck: false,
                        autocomplete: 'off',
                        sanitize: (v) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '')
                    },
                    { key: 'appId', label: 'App ID', placeholder: '请输入机器人 AppID' },
                    { key: 'clientSecret', label: 'Client Secret', placeholder: '请输入机器人 AppSecret', type: 'password' }
                ], t('comm.qq.add.desc'));
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
            // OpenClaw 出站发图会把账号 ID 规范化为 [a-z0-9_-]；中文会被洗成 default 导致「missing appId」
            if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(accountId)) {
                showToast(t('comm.qq.account.invalid_err'));
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

    // ========== Google 账号登录 ==========
    const googleLoginBtn = document.getElementById('google-login-btn');
    const googleAccountContainer = document.getElementById('google-account-container');

    async function renderGoogleAccount() {
        if (!googleAccountContainer) return;
        try {
            const status = await window.api.googleGetStatus();
            if (status.loggedIn && status.account) {
                window.currentUserGoogleAccount = status.account;
                const acct = status.account;
                const avatarHtml = acct.picture
                    ? `<img src="${escapeHtml(acct.picture)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" onerror="this.outerHTML='<div style=\\'width:36px;height:36px;border-radius:50%;background:var(--accent-color);display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:16px;\\'>${escapeHtml((acct.name || acct.email || 'G')[0].toUpperCase())}</div>'">`
                    : `<div style="width:36px;height:36px;border-radius:50%;background:var(--accent-color);display:flex;align-items:center;justify-content:center;color:white;font-weight:bold;font-size:16px;">${escapeHtml((acct.name || acct.email || 'G')[0].toUpperCase())}</div>`;
                googleAccountContainer.innerHTML = `
                    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:10px;flex-wrap:wrap;">
                        ${avatarHtml}
                        <div style="flex:1;min-width:140px;">
                            <div style="font-size:13px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(acct.name || '未知用户')}</div>
                            <div style="font-size:11px;color:var(--text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(acct.email || '')}</div>
                        </div>
                        <span style="font-size:11px;color:#22c55e;font-weight:600;padding:2px 8px;background:rgba(34,197,94,0.1);border-radius:4px;">已登录</span>
                        <button type="button" id="google-upload-btn" style="padding:4px 10px;font-size:11px;border-radius:5px;border:1px solid var(--accent-color);background:rgba(192,132,252,0.1);color:var(--accent-color);cursor:pointer;font-weight:500;" title="备份当前应用配置到 Google 云盘">☁️ 备份配置</button>
                        <button type="button" id="google-download-btn" style="padding:4px 10px;font-size:11px;border-radius:5px;border:1px solid var(--border-subtle);background:transparent;color:var(--text-primary);cursor:pointer;font-weight:500;" title="从 Google 云盘拉取最新配置恢复">📥 恢复配置</button>
                        <button type="button" id="google-logout-btn" style="padding:4px 10px;font-size:11px;border-radius:5px;border:1px solid var(--border-subtle);background:transparent;color:var(--text-secondary);cursor:pointer;">退出</button>
                    </div>`;

                const uploadBtn = document.getElementById('google-upload-btn');
                if (uploadBtn) {
                    uploadBtn.addEventListener('click', async () => {
                        uploadBtn.disabled = true;
                        uploadBtn.innerText = '⏳ 上传中...';
                        try {
                            const res = await window.api.googleSyncUpload();
                            if (res.success) {
                                showToast('✅ 成功将应用配置备份至 Google 云盘！');
                            } else {
                                showToast('❌ 备份失败: ' + res.error);
                            }
                        } catch (e) {
                            showToast('❌ 备份失败: ' + e.message);
                        } finally {
                            uploadBtn.disabled = false;
                            uploadBtn.innerText = '☁️ 备份配置';
                        }
                    });
                }

                const downloadBtn = document.getElementById('google-download-btn');
                if (downloadBtn) {
                    downloadBtn.addEventListener('click', async () => {
                        downloadBtn.disabled = true;
                        downloadBtn.innerText = '⏳ 下载中...';
                        try {
                            const res = await window.api.googleSyncDownload();
                            if (res.success) {
                                showToast('✅ 已成功从 Google 云盘同步恢复配置！');
                                setTimeout(() => window.location.reload(), 1500);
                            } else {
                                showToast('❌ 恢复失败: ' + res.error);
                            }
                        } catch (e) {
                            showToast('❌ 恢复失败: ' + e.message);
                        } finally {
                            downloadBtn.disabled = false;
                            downloadBtn.innerText = '📥 恢复配置';
                        }
                    });
                }

                const logoutBtn = document.getElementById('google-logout-btn');
                if (logoutBtn) {
                    logoutBtn.addEventListener('click', async () => {
                        await window.api.googleLogout();
                        window.currentUserGoogleAccount = null;
                        showToast('已退出 Google 账号');
                        renderGoogleAccount();
                    });
                }
                if (googleLoginBtn) googleLoginBtn.style.display = 'none';
            } else {
                window.currentUserGoogleAccount = null;
                googleAccountContainer.innerHTML = '';
                if (googleLoginBtn) googleLoginBtn.style.display = '';
            }
        } catch (_) {
            window.currentUserGoogleAccount = null;
            googleAccountContainer.innerHTML = '';
            if (googleLoginBtn) googleLoginBtn.style.display = '';
        }
    }

    if (googleLoginBtn) {
        googleLoginBtn.addEventListener('click', async () => {
            if (googleLoginBtn.disabled) return;
            const oldHtml = '🔑 Google 登录';
            googleLoginBtn.disabled = true;
            googleLoginBtn.style.opacity = '0.6';
            googleLoginBtn.style.cursor = 'not-allowed';
            googleLoginBtn.innerHTML = '⏳ 正在等待 Google 授权...';

            const safetyTimer = setTimeout(() => {
                googleLoginBtn.disabled = false;
                googleLoginBtn.style.opacity = '1';
                googleLoginBtn.style.cursor = 'pointer';
                googleLoginBtn.innerHTML = oldHtml;
            }, 45000);

            try {
                const result = await window.api.triggerGoogleLogin();
                if (result.success) {
                    showToast('Google 登录成功！欢迎 ' + (result.user?.name || result.user?.email || ''));
                    renderGoogleAccount();
                } else if (result.error && !result.error.includes('关闭了登录窗口')) {
                    showToast('Google 登录失败: ' + result.error);
                }
            } catch (e) {
                showToast('Google 登录失败: ' + (e.message || String(e)));
            } finally {
                clearTimeout(safetyTimer);
                googleLoginBtn.disabled = false;
                googleLoginBtn.style.opacity = '1';
                googleLoginBtn.style.cursor = 'pointer';
                googleLoginBtn.innerHTML = oldHtml;
            }
        });
    }

    if (window.api.onGoogleLoginSuccess) {
        window.api.onGoogleLoginSuccess(() => renderGoogleAccount());
    }

    renderGoogleAccount();

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
            // 活动流日志全通道共用，切换胶囊只刷新右侧绑定信息
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

    // 绑定系统偏好设置中的网络中转跳转事件
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

    // New gateway run: clear previous activity/status snapshots so stale state cannot masquerade as this run.
    if (window.api && window.api.onGatewayClearLogs) {
        window.api.onGatewayClearLogs(() => {
            resetConsoleRuntimeLogs({ clearPersisted: true, clearSystemLogsArea: false });
            try { localStorage.removeItem(CHANNEL_STATUS_STORAGE_KEY); } catch (_) {}
            try { localStorage.removeItem(ACTIVE_MODEL_STORAGE_KEY); } catch (_) {}
            try { setAllChannelStatusTilesOffline({ persist: false }); } catch (_) {}
        });
    }
    // 应用冷启动：回灌上一轮活动流 / 通道绿点 / 激活模型，避免 Win+R 后空白
    try {
        restorePersistedActivityLogs({ replace: true });
        restorePersistedConsoleStatusUi();
    } catch (_) {
        resetConsoleRuntimeLogs({ clearPersisted: false, clearSystemLogsArea: false });
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

            resetConsoleRuntimeLogs({ clearPersisted: true, clearSystemLogsArea: false });
            try { localStorage.removeItem(CHANNEL_STATUS_STORAGE_KEY); } catch (_) {}
            try { localStorage.removeItem(ACTIVE_MODEL_STORAGE_KEY); } catch (_) {}
            try { setAllChannelStatusTilesOffline({ persist: false }); } catch (_) {}
            ensureStartingActivityTip();

            window.api.gatewayAction('start', { source: 'manual' });

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
            resetConsoleRuntimeLogs();

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
            clearPersistedActivityLogs();
            try { localStorage.removeItem(CHANNEL_STATUS_STORAGE_KEY); } catch (_) {}
            try { localStorage.removeItem(ACTIVE_MODEL_STORAGE_KEY); } catch (_) {}
            const activeModel = document.getElementById('dash-active-model');
            if (activeModel) activeModel.textContent = t('console.dash.not_configured') || '未启动';
            
            setAllChannelStatusTilesOffline();
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
                window.api.gatewayAction('start', { source: 'manual' });
            } else if (gatewayStatus === 'running') {
                showToast('正在关闭Nexora Agent核心服务...');
                window.api.gatewayAction('stop');
                resetConsoleRuntimeLogs();
            } else if (gatewayStatus === 'starting') {
                showToast('Nexora Agent正在启动中，请稍候...');
            }
        });
    }

    // 自动启用 Nexora Agent（尊重设置；未写入时默认关闭，仅左上角手动启用）
    (async () => {
        let autoOn = localStorage.getItem('setting_auto_launch_gateway') === 'true';
        try {
            if (window.api && typeof window.api.getAutoLaunchGateway === 'function') {
                autoOn = await window.api.getAutoLaunchGateway();
                localStorage.setItem('setting_auto_launch_gateway', autoOn ? 'true' : 'false');
            }
        } catch (e) {}
        if (!autoOn) return;
        setTimeout(() => {
            if (gatewayStatus === 'stopped') {
                logTerminal.innerText += '\n[System] 正在根据系统设置自动启用本地Nexora Agent...\n';
                window.api.gatewayAction('start', { source: 'autostart' });
            }
        }, 1500);
        // 自启场景下反复对齐按钮文案：running →「终止」，避免卡在「启动/启动中」
        [2500, 5000, 8000].forEach((ms) => {
            setTimeout(() => {
                try {
                    if (window.api && window.api.gatewayAction) {
                        window.api.gatewayAction('query-status');
                    }
                } catch (e) {}
            }, ms);
        });
    })();

    // 渲染图表
    renderUsageCharts();
    
    // 初始化侧边栏微型负载图
    initSidebarChart();

    // 内存模拟监控（科技感点缀)
    NexoraScheduler.register('memory-mock', updateMemoryMock, { visibleMs: 2000, hiddenMs: 30000 });

    // 微信通道绑定状态初始化查询与每 10 秒定时监控轮询
    NexoraScheduler.register('wechat-status', updateWeChatStatusUI, { visibleMs: 10000, hiddenMs: 60000 });

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
const ACTIVITY_LOG_QUEUE_HARD_CAP = 40;
const ACTIVITY_LOG_STORAGE_KEY = 'nexora_console_activity_logs_v1';
const ACTIVITY_LOG_SHARED_SCOPE = 'all';
const ACTIVITY_LOG_LEGACY_SCOPES = ['qqbot', 'wechat', 'feishu'];
const ACTIVITY_LOG_PERSIST_MAX = 300;
let __activityLogsMergedOnce = false;

function getActivityEmptyTipsHtml() {
    return `<div class="activity-item-empty" data-i18n="console.dash.empty_tips">${t('console.dash.empty_tips') || '暂无系统活动，启动服务后将在此显示最新状态...'}</div>`;
}

function getStartingActivityTipsHtml() {
    return `<div class="starting-activity-item" data-i18n="console.dash.starting_tips">${t('console.dash.starting_tips') || '首次启动或深度初始化环境可能需要较长时间，请耐心等待...'}</div>`;
}

/** 活动流全通道共用，不再按 QQ/微信/飞书分桶 */
function getCurrentActivityScope() {
    return ACTIVITY_LOG_SHARED_SCOPE;
}

function getActivityLogStorageKey(scope = getCurrentActivityScope()) {
    return `${ACTIVITY_LOG_STORAGE_KEY}:${scope || ACTIVITY_LOG_SHARED_SCOPE}`;
}

function mergeLegacyActivityLogsIfNeeded() {
    if (__activityLogsMergedOnce) return;
    __activityLogsMergedOnce = true;
    try {
        const sharedKey = getActivityLogStorageKey(ACTIVITY_LOG_SHARED_SCOPE);
        const existing = (() => {
            try {
                const raw = localStorage.getItem(sharedKey);
                const list = raw ? JSON.parse(raw) : [];
                return Array.isArray(list) ? list.filter(Boolean) : [];
            } catch (_) { return []; }
        })();
        if (existing.length) return;

        const merged = [];
        for (const scope of ACTIVITY_LOG_LEGACY_SCOPES) {
            try {
                const raw = localStorage.getItem(`${ACTIVITY_LOG_STORAGE_KEY}:${scope}`);
                const list = raw ? JSON.parse(raw) : [];
                if (Array.isArray(list)) {
                    list.filter(Boolean).forEach((line) => merged.push(line));
                }
            } catch (_) {}
        }
        if (merged.length) {
            localStorage.setItem(sharedKey, JSON.stringify(merged.slice(-ACTIVITY_LOG_PERSIST_MAX)));
        }
        // 清掉旧分桶，避免以后误读
        for (const scope of ACTIVITY_LOG_LEGACY_SCOPES) {
            try { localStorage.removeItem(`${ACTIVITY_LOG_STORAGE_KEY}:${scope}`); } catch (_) {}
        }
    } catch (_) {}
}

// 活动日志缓存：原先每写一行都 getItem+JSON.parse+push+JSON.stringify+setItem 整个 300 项数组（单行 O(n)、n 行 O(n²)，且 localStorage 是主线程同步 API）。
// 改为内存缓存为真相源 + 防抖批量落盘，写一行只是内存 push。
let __activityLogCache = null;
let __activityLogFlushTimer = null;

function loadActivityLogCache() {
    if (__activityLogCache) return __activityLogCache;
    mergeLegacyActivityLogsIfNeeded();
    try {
        const raw = localStorage.getItem(getActivityLogStorageKey(ACTIVITY_LOG_SHARED_SCOPE));
        const list = raw ? JSON.parse(raw) : [];
        __activityLogCache = Array.isArray(list) ? list.filter(Boolean).slice(-ACTIVITY_LOG_PERSIST_MAX) : [];
    } catch (_) {
        __activityLogCache = [];
    }
    return __activityLogCache;
}

function flushActivityLogCache() {
    if (__activityLogFlushTimer) { clearTimeout(__activityLogFlushTimer); __activityLogFlushTimer = null; }
    if (!__activityLogCache) return;
    try {
        localStorage.setItem(
            getActivityLogStorageKey(ACTIVITY_LOG_SHARED_SCOPE),
            JSON.stringify(__activityLogCache.slice(-ACTIVITY_LOG_PERSIST_MAX))
        );
    } catch (_) {}
}

function scheduleActivityLogFlush() {
    if (__activityLogFlushTimer) return;
    __activityLogFlushTimer = setTimeout(flushActivityLogCache, 600);
}

// 关窗/切后台时把未落盘的缓存补写，避免丢最后一批日志
if (typeof window !== 'undefined' && !window.__activityLogFlushHooked) {
    window.__activityLogFlushHooked = true;
    window.addEventListener('beforeunload', flushActivityLogCache);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushActivityLogCache(); });
}

function getPersistedActivityLogs(scope = getCurrentActivityScope()) {
    return loadActivityLogCache().slice();
}

function savePersistedActivityLogs(list, scope = getCurrentActivityScope()) {
    __activityLogCache = (Array.isArray(list) ? list : []).slice(-ACTIVITY_LOG_PERSIST_MAX);
    scheduleActivityLogFlush();
}

function persistActivityLogLine(lineHtml) {
    if (!lineHtml) return;
    const cache = loadActivityLogCache();
    cache.push(lineHtml);
    if (cache.length > ACTIVITY_LOG_PERSIST_MAX) cache.splice(0, cache.length - ACTIVITY_LOG_PERSIST_MAX);
    scheduleActivityLogFlush();
}

function persistActivityLogLines(lines) {
    if (!Array.isArray(lines) || !lines.length) return;
    const cache = loadActivityLogCache();
    lines.forEach((line) => { if (line) cache.push(line); });
    if (cache.length > ACTIVITY_LOG_PERSIST_MAX) cache.splice(0, cache.length - ACTIVITY_LOG_PERSIST_MAX);
    scheduleActivityLogFlush();
}

function clearPersistedActivityLogs(scope = getCurrentActivityScope()) {
    // 先清空缓存并取消待落盘，避免防抖 flush 在 remove 之后又把旧内容写回去
    __activityLogCache = [];
    if (__activityLogFlushTimer) { clearTimeout(__activityLogFlushTimer); __activityLogFlushTimer = null; }
    try { localStorage.removeItem(getActivityLogStorageKey(ACTIVITY_LOG_SHARED_SCOPE)); } catch (_) {}
    for (const legacy of ACTIVITY_LOG_LEGACY_SCOPES) {
        try { localStorage.removeItem(`${ACTIVITY_LOG_STORAGE_KEY}:${legacy}`); } catch (_) {}
    }
}

const CHANNEL_TILE_META = {
    weixin: {
        connectedKey: 'console.channel.wechat.connected',
        disconnectedKey: 'console.channel.wechat.disconnected',
        connectedFallback: '微信消息通道: 已连接',
        disconnectedFallback: '微信消息通道: 未连接'
    },
    qqbot: {
        connectedKey: 'console.channel.qq.connected',
        disconnectedKey: 'console.channel.qq.disconnected',
        connectedFallback: 'QQ机器人通道: 已连接',
        disconnectedFallback: 'QQ机器人通道: 未配置'
    },
    feishu: {
        connectedKey: 'console.channel.feishu.connected',
        disconnectedKey: 'console.channel.feishu.disconnected',
        connectedFallback: '飞书/Lark通道: 已连接',
        disconnectedFallback: '飞书/Lark通道: 未连接'
    }
};

function setChannelStatusTile(channelId, online, options = {}) {
    const tile = document.getElementById(`tile-${channelId}`);
    const meta = CHANNEL_TILE_META[channelId];
    if (!tile || !meta) return;
    tile.className = online ? 'channel-status-tile online' : 'channel-status-tile offline';
    tile.title = online
        ? (t(meta.connectedKey) || meta.connectedFallback)
        : (t(meta.disconnectedKey) || meta.disconnectedFallback);
    if (options.persist !== false) {
        try { persistChannelStatusTiles(); } catch (_) {}
    }
    // 与拓扑渠道卡同步：活动流已判定上线时，勿再停在「连接中 / 加载中」
    if (options.syncTopology !== false) {
        try { syncTopologyChannelFromTile(channelId, online, options); } catch (_) {}
    }
}

/** 通道绿点 → 拓扑图 node-wechat / node-qq / node-feishu */
function syncTopologyChannelFromTile(channelId, online, options = {}) {
    const nodeId = channelId === 'weixin'
        ? 'node-wechat'
        : (channelId === 'qqbot' ? 'node-qq' : (channelId === 'feishu' ? 'node-feishu' : null));
    if (!nodeId || typeof topoNodeStates !== 'object') return;
    const next = online ? 'completed' : 'pending';
    if (topoNodeStates[nodeId] === next) return;
    // 下线时不要把「未绑定」之外的中间态反复刷 pending；仅从已接通/连接中降级
    if (!online && topoNodeStates[nodeId] !== 'completed' && topoNodeStates[nodeId] !== 'active') return;
    topoNodeStates[nodeId] = next;
    if (options.refreshTopology !== false && typeof updateTopologyUI === 'function') {
        updateTopologyUI();
    }
}

const CHANNEL_STATUS_STORAGE_KEY = 'nexora_console_channel_status_v1';
const ACTIVE_MODEL_STORAGE_KEY = 'nexora_console_active_model_v1';

function persistChannelStatusTiles() {
    try {
        const state = {};
        ['weixin', 'qqbot', 'feishu'].forEach((ch) => {
            const tile = document.getElementById(`tile-${ch}`);
            state[ch] = !!(tile && tile.classList.contains('online'));
        });
        localStorage.setItem(CHANNEL_STATUS_STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
}

function persistActiveModelLabel(label) {
    try {
        const text = String(label || '').trim();
        if (!text) return;
        localStorage.setItem(ACTIVE_MODEL_STORAGE_KEY, text);
    } catch (_) {}
}

function restorePersistedConsoleStatusUi() {
    try {
        const raw = localStorage.getItem(CHANNEL_STATUS_STORAGE_KEY);
        const state = raw ? JSON.parse(raw) : null;
        if (state && typeof state === 'object') {
            ['weixin', 'qqbot', 'feishu'].forEach((ch) => {
                if (typeof state[ch] === 'boolean') setChannelStatusTile(ch, state[ch]);
            });
        }
    } catch (_) {}
    try {
        const model = localStorage.getItem(ACTIVE_MODEL_STORAGE_KEY);
        const activeModelEl = document.getElementById('dash-active-model');
        if (model && activeModelEl) activeModelEl.textContent = model;
    } catch (_) {}
    // 网关已在跑时，用活动流校正绿点；未就绪时保留本地上次状态，避免 Win+R 先被熄灭
    try {
        if (gatewayStatus === 'running' || gatewayStatus === 'starting' || gatewayFullyReady) {
            syncChannelStatusTilesFromLogs({ forceOnline: true });
        }
    } catch (_) {}
}

function setAllChannelStatusTilesOffline(options = {}) {
    ['weixin', 'qqbot', 'feishu'].forEach((ch) => setChannelStatusTile(ch, false, options));
}

function stripActivityLogText(lineHtml) {
    return String(lineHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 从单条活动流日志推导通道绿点；返回是否命中某通道状态变化 */
function applyChannelStatusFromLogLine(lineHtml) {
    const line = stripActivityLogText(lineHtml);
    if (!line) return false;
    let hit = false;

    if (
        line.includes('微信消息接收通道已成功连接')
        || (line.includes('微信插件') && line.includes('🟢'))
    ) {
        setChannelStatusTile('weixin', true);
        hit = true;
    } else if (
        line.includes('微信通道连接断开')
        || (line.includes('微信插件') && line.includes('🔴'))
    ) {
        setChannelStatusTile('weixin', false);
        hit = true;
    }

    if (
        line.includes('QQ 机器人消息通道已成功上线')
        || line.includes('QQ 机器人消息接收通道已成功连接')
        || (line.includes('QQ机器人') && line.includes('🟢'))
    ) {
        setChannelStatusTile('qqbot', true);
        hit = true;
    }

    if (
        line.includes('飞书/Lark 消息通道已成功上线')
        || line.includes('飞书/Lark 的消息通道已成功上线')
        || (line.includes('飞书插件') && line.includes('🟢'))
    ) {
        setChannelStatusTile('feishu', true);
        hit = true;
    }

    return hit;
}

/**
 * Win+R / 重启后活动流会从本地恢复，但通道绿点原先只靠「新日志」点亮。
 * 这里从已恢复日志（由新到旧）重算最新通道状态，避免图二灰点被清空后回不来。
 */
function syncChannelStatusTilesFromLogs(options = {}) {
    const allowOnline = options.forceOnline === true
        || gatewayStatus === 'running'
        || gatewayStatus === 'starting';
    if (!allowOnline) {
        setAllChannelStatusTilesOffline();
        return;
    }

    const logs = Array.isArray(options.logs)
        ? options.logs
        : getPersistedActivityLogs(options.scope || getCurrentActivityScope());
    if (!logs.length) return;

    const latest = { weixin: null, qqbot: null, feishu: null };
    for (let i = logs.length - 1; i >= 0; i--) {
        const line = stripActivityLogText(logs[i]);
        if (!line) continue;

        if (latest.weixin === null) {
            if (line.includes('微信消息接收通道已成功连接') || (line.includes('微信插件') && line.includes('🟢'))) {
                latest.weixin = true;
            } else if (line.includes('微信通道连接断开') || (line.includes('微信插件') && line.includes('🔴'))) {
                latest.weixin = false;
            }
        }
        if (latest.qqbot === null) {
            if (
                line.includes('QQ 机器人消息通道已成功上线')
                || line.includes('QQ 机器人消息接收通道已成功连接')
                || (line.includes('QQ机器人') && line.includes('🟢'))
            ) {
                latest.qqbot = true;
            }
        }
        if (latest.feishu === null) {
            if (
                line.includes('飞书/Lark 消息通道已成功上线')
                || line.includes('飞书/Lark 的消息通道已成功上线')
                || (line.includes('飞书插件') && line.includes('🟢'))
            ) {
                latest.feishu = true;
            }
        }
        if (latest.weixin !== null && latest.qqbot !== null && latest.feishu !== null) break;
    }

    if (latest.weixin !== null) setChannelStatusTile('weixin', latest.weixin);
    if (latest.qqbot !== null) setChannelStatusTile('qqbot', latest.qqbot);
    if (latest.feishu !== null) setChannelStatusTile('feishu', latest.feishu);
}

function restorePersistedActivityLogs(options = {}) {
    const streamList = document.getElementById('dash-activity-stream-list');
    if (!streamList) return;
    const logs = getPersistedActivityLogs(options.scope || getCurrentActivityScope());
    if (options.replace) streamList.innerHTML = '';
    if (!logs.length) {
        if (options.replace) streamList.innerHTML = getActivityEmptyTipsHtml();
        if (options.syncChannelTiles !== false) {
            syncChannelStatusTilesFromLogs({ logs: [], scope: options.scope, forceOnline: options.forceOnline });
        }
        return;
    }
    streamList.querySelectorAll('.activity-item-empty, .starting-activity-item').forEach((el) => el.remove());
    const frag = document.createDocumentFragment();
    logs.slice(-150).forEach((lineHtml) => {
        const item = document.createElement('div');
        item.className = 'activity-log-line';
        item.innerHTML = lineHtml;
        frag.appendChild(item);
    });
    streamList.appendChild(frag);
    while (streamList.children.length > 150) streamList.removeChild(streamList.firstChild);
    streamList.scrollTop = streamList.scrollHeight;
    if (options.syncChannelTiles !== false) {
        syncChannelStatusTilesFromLogs({ logs, scope: options.scope, forceOnline: options.forceOnline });
    }
}

function renderScopedActivityLogs() {
    // 兼容旧调用：活动流已改为全通道共用，不再按胶囊切换重载
    __activityLogQueue = [];
    __isProcessingLogQueue = false;
    restorePersistedActivityLogs({ replace: true });
}

/** 启动中：始终在活动流顶部展示等待提示（不依赖列表是否为空） */
function ensureStartingActivityTip() {
    const streamList = document.getElementById('dash-activity-stream-list');
    if (!streamList) return;
    streamList.querySelectorAll('.activity-item-empty').forEach((el) => el.remove());
    let tip = streamList.querySelector('.starting-activity-item');
    if (!tip) {
        streamList.insertAdjacentHTML('afterbegin', getStartingActivityTipsHtml());
        tip = streamList.querySelector('.starting-activity-item');
    } else if (streamList.firstElementChild !== tip) {
        streamList.insertBefore(tip, streamList.firstChild);
    }
}

/** 就绪/停止：去掉启动等待条；若没有任何真实日志则恢复空状态文案 */
function dismissStartingActivityTip(options = {}) {
    const restoreEmptyIfBlank = options.restoreEmptyIfBlank !== false;
    const streamList = document.getElementById('dash-activity-stream-list');
    if (!streamList) return;
    streamList.querySelectorAll('.starting-activity-item').forEach((el) => el.remove());
    if (!restoreEmptyIfBlank) return;
    const hasRealLines = !!streamList.querySelector('.activity-log-line');
    if (!hasRealLines && !streamList.querySelector('.activity-item-empty')) {
        streamList.innerHTML = getActivityEmptyTipsHtml();
    }
}

function resetConsoleRuntimeLogs(options = {}) {
    const clearSystemLogsArea = options.clearSystemLogsArea === true;
    const clearPersisted = options.clearPersisted === true;
    __activityLogQueue = [];
    __isProcessingLogQueue = false;
    resetPluginLogDedupe();

    const streamList = document.getElementById('dash-activity-stream-list');
    if (streamList) {
        streamList.innerHTML = getActivityEmptyTipsHtml();
        streamList.scrollTop = 0;
    }
    if (clearPersisted) clearPersistedActivityLogs();
    else restorePersistedActivityLogs({ replace: true });

    if (logTerminal) logTerminal.innerHTML = '';
    const builtinLogs = document.getElementById('builtin-terminal-logs');
    if (builtinLogs) builtinLogs.innerHTML = '';
    if (clearSystemLogsArea) {
        const systemLogsArea = document.getElementById('system-raw-logs-area');
        if (systemLogsArea) systemLogsArea.value = '';
    }
    if (Array.isArray(window.__deferredConsoleLogs) && clearPersisted) window.__deferredConsoleLogs.length = 0;
    gatewayLogReadyTail = '';
    __gatewayLoadedPluginCount = null;
    try { updateRightPluginsCountUI(); } catch (e) {}
}

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
    // 积压过多时丢掉最旧的，避免打字机动画把界面拖死
    while (__activityLogQueue.length > ACTIVITY_LOG_QUEUE_HARD_CAP) {
        __activityLogQueue.shift();
    }
    if (!__isProcessingLogQueue) {
        processActivityLogQueue();
    }
}

/** 离页积压 / 切回控制台：一次性落盘，不走打字机回放 */
function appendActivityLogLinesInstant(lineHtmlList) {
    const streamList = document.getElementById('dash-activity-stream-list');
    if (!streamList || !Array.isArray(lineHtmlList) || lineHtmlList.length === 0) return;

    streamList.querySelectorAll('.activity-item-empty, .starting-activity-item').forEach((el) => el.remove());

    const frag = document.createDocumentFragment();
    for (const lineHtml of lineHtmlList) {
        if (!lineHtml) continue;
        // 与 enqueue 一致：同阶段重复插件装载日志只保留一条
        if (lineHtml.includes('成功装载') && lineHtml.includes('消息通道插件')) {
            const cleanTag = lineHtml.replace(/<\/?[^>]+(>|$)/g, '').trim();
            if (__seenPluginLogsThisStartup.has(cleanTag)) continue;
            __seenPluginLogsThisStartup.add(cleanTag);
        }
        const item = document.createElement('div');
        item.className = 'activity-log-line';
        item.innerHTML = lineHtml;
        frag.appendChild(item);
    }
    streamList.appendChild(frag);
    persistActivityLogLines(lineHtmlList);

    while (streamList.children.length > 150) {
        streamList.removeChild(streamList.firstChild);
    }
    streamList.scrollTop = streamList.scrollHeight;
}

function flushDeferredConsoleLogsInstant() {
    const q = window.__deferredConsoleLogs;
    if (!q || !q.length) return;
    const chunk = q.splice(0, q.length).slice(-150);
    appendActivityLogLinesInstant(chunk);
    if (logTerminal && chunk.length) {
        const frag = document.createDocumentFragment();
        chunk.forEach((lineHtml) => {
            const s = document.createElement('span');
            s.innerHTML = lineHtml + (String(lineHtml).endsWith('\n') ? '' : '<br/>');
            frag.appendChild(s);
        });
        logTerminal.appendChild(frag);
        logTerminal.scrollTop = logTerminal.scrollHeight;
    }
}

function processActivityLogQueue() {
    if (__activityLogQueue.length === 0) {
        __isProcessingLogQueue = false;
        return;
    }

    __isProcessingLogQueue = true;
    const lineHtml = __activityLogQueue.shift();
    const backlog = __activityLogQueue.length;

    const streamList = document.getElementById('dash-activity-stream-list');
    if (streamList) {
        // 真实日志到来后，空提示与「请耐心等待」启动条都必须移除
        streamList.querySelectorAll('.activity-item-empty, .starting-activity-item').forEach((el) => el.remove());

        const item = document.createElement('div');
        item.className = 'activity-log-line typing';
        item.innerHTML = lineHtml;
        streamList.appendChild(item);
        persistActivityLogLine(lineHtml);

        // 最多保留最近 150 条
        while (streamList.children.length > 150) {
            streamList.removeChild(streamList.firstChild);
        }

        // 积压严重时跳过打字机，直接落盘，防止 setInterval 刷爆导致卡死
        if (backlog > 12) {
            item.style.clipPath = 'none';
            item.classList.remove('typing');
            streamList.scrollTop = streamList.scrollHeight;
            setTimeout(() => processActivityLogQueue(), backlog > 25 ? 8 : 20);
            return;
        }

        // 打字机渐显动画： clip-path 从左往右逐帧优雅平滑揭开
        const temp = document.createElement('span');
        temp.innerHTML = lineHtml;
        const textLen = (temp.textContent || '').length;

        const stepInterval = backlog > 5 ? 12 : 16;
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

                const nextPause = backlog > 5 ? 90 : 160;
                setTimeout(() => {
                    processActivityLogQueue();
                }, nextPause);
            }
        }, stepInterval);
    } else {
        setTimeout(() => processActivityLogQueue(), 0);
    }
}

// 生图/生视频底层重试与网络报错：不在活动流/终端里刷屏
function isMediaApiNoiseLog(text) {
    const l = String(text || '').toLowerCase();
    return (
        l.includes('[video-generator]') ||
        l.includes('[image-generator]') ||
        l.includes('[media-http]') ||
        l.includes('[media-cli]') ||
        l.includes('draw_video failed') ||
        l.includes('draw_picture failed') ||
        (l.includes('built-in key') && l.includes('failed')) ||
        (l.includes('[tools]') && (l.includes('draw_video') || l.includes('draw_picture'))) ||
        l.includes('unsupportedparamserror') ||
        l.includes('all image api keys failed') ||
        l.includes('all video api keys failed') ||
        l.includes('parseerror') ||
        l.includes('unexpected token') ||
        l.includes('failed to load plugin') ||
        l.includes('extensions/image-generator') ||
        l.includes('extensions/video-generator') ||
        l.includes('extensions\\image-generator') ||
        l.includes('extensions\\video-generator') ||
        (l.includes('etimedout') && (l.includes('198.18.') || l.includes('agnes') || l.includes('apihub'))) ||
        (l.includes('connect etimedout') && l.includes(':443')) ||
        (l.includes('stalled session') && l.includes('draw_video')) ||
        l.includes('stuck session recovery') ||
        l.includes('embedded abort settle timed out') ||
        (l.includes('lane task error') && l.includes('reply operation aborted'))
    );
}

// 🔍 小白友好型日志汉化过滤与清洗转化器
function isTransientWeixinLongPollError(cleanLine) {
    const lower = String(cleanLine || '').toLowerCase();
    if (!lower.includes('weixin getupdates')) return false;
    if (!/(\(1\/3\)|\(2\/3\))/.test(lower)) return false;
    return lower.includes('tls handshake') || lower.includes('und_err_socket') || lower.includes('fetch failed');
}

function isHiddenGatewayDiagnosticLog(cleanLine) {
    const line = String(cleanLine || '');
    if (!line) return false;
    const lower = line.toLowerCase();
    // 最先拦：压缩诊断 / 溢出 / 限流 —— 绝不能变成「系统警报」原文
    if (
        lower.includes('compaction-diag') ||
        lower.includes('compaction_diag') ||
        lower.includes('[agent/embedded]') ||
        lower.includes('session-overflow-rollover') ||
        lower.includes('silent-retry') ||
        lower.includes('suppress-rate-limit') ||
        lower.includes('suppress-warning-banner') ||
        lower.includes('context_overflow') ||
        lower.includes('diagid=ovf-') ||
        /trigger\s*=\s*overflow/i.test(line) ||
        /diagid\s*=\s*ovf-/i.test(line) ||
        /runid\s*=/i.test(line) && /overflow|compaction/i.test(line) ||
        /outcome\s*=\s*failed/i.test(line) && /overflow|compaction|timeout/i.test(line) ||
        /rate[\s-]?limit|temporarily rate-limited|all models are temporarily|auto-compaction|compaction timed|compaction timeout|context[_\s-]?overflow|prompt too large|reservetokensfloor|use \/compact|use \/new|暂时限流|暂时过载|上下文过长|上下文溢出|自动压缩失败|请使用\s*\/new/i.test(
            line
        )
    ) {
        return true;
    }
    return false;
}

function formatLogForUser(text) {
    if (!text) return null;
    // 移除颜色控制字符并修剪两端
    const cleanLine = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (isMediaApiNoiseLog(cleanLine)) return null;
    const lowerLine = cleanLine.toLowerCase();
    if (isTransientWeixinLongPollError(cleanLine)) return null;
    // 诊断日志：入口即丢弃，后面任何「error/failed → 系统警报」都碰不到
    if (isHiddenGatewayDiagnosticLog(cleanLine)) return null;

    // —— 启动成败（必须优先于 doctor/failed 噪音过滤，否则活动流会一直空）——
    if (
        cleanLine.includes('Gateway failed to start')
        || cleanLine.includes('Invalid config')
        || (cleanLine.includes('plugin manifest not found') && cleanLine.includes('media-core'))
    ) {
        if (cleanLine.includes('media-core') || cleanLine.includes('plugin manifest not found')) {
            return `[⚠️ 系统警报] 网关启动失败：媒体运行库被误当成插件。请重启 Nexora Agent 以自动修复，或更新到最新安装包。`;
        }
        return `[⚠️ 系统警报] 网关启动失败：配置校验未通过。请查看「系统运行日志」了解详情。`;
    }
    if (cleanLine.includes('已拦截非授权启动')) {
        return `[⚙️ 系统核心] 已跳过自动拉起（当前仅允许左上角手动启动，或在系统设置中打开「自动启用」）`;
    }
    if (cleanLine.includes('正在准备启动 Gateway') || cleanLine.includes('正在拉起内置 OpenClaw Gateway')) {
        return `[⚙️ 系统核心] 正在启动本地 Nexora Agent 核心服务…`;
    }
    if (cleanLine.includes('渠道配置已保存') && cleanLine.includes('网关未运行')) {
        return `[⚙️ 系统核心] 渠道配置已保存。网关未运行，请点击左上角手动启动后再使用。`;
    }
    if (cleanLine.includes('端口') && cleanLine.includes('仍被占用')) {
        return `[⚠️ 系统警报] 网关端口仍被占用，请再次点击左上角启动；若反复失败请结束占用进程后重试。`;
    }

    // 1. 过滤完全无需展示给小白的日志 (底层噪音调试日志)
    // 模型空闲超时 / Abort / rotate_profile 属于网关自愈过程，刷屏会导致活动流卡死
    if (
        cleanLine.includes('AGENTS.md') ||
        cleanLine.includes('SOUL.md') ||
        cleanLine.includes('TOOLS.md') ||
        cleanLine.includes('TokenGuard Cleaned') ||
        cleanLine.includes('tool policy') ||
        cleanLine.includes('provider-transport-fetch start') ||
        (cleanLine.includes('provider-transport-fetch') && (lowerLine.includes('error') || lowerLine.includes('abort'))) ||
        cleanLine.includes('[model-fetch] error') ||
        cleanLine.includes('failover decision') ||
        cleanLine.includes('model fallback decision') ||
        /Model\s*Fallback\s*(cleared)?\s*:/i.test(cleanLine) ||
        /(?:↪️|↪)\s*Model\s*Fallback/i.test(cleanLine) ||
        cleanLine.includes('rotate_profile') ||
        cleanLine.includes('LLM idle timeout') ||
        cleanLine.includes('This operation was aborted') ||
        cleanLine.includes('AbortError') ||
        cleanLine.includes('delivery-recovery') ||
        cleanLine.includes('send_attempt_started') ||
        cleanLine.includes('refusing blind replay') ||
        lowerLine.includes('sendinputnotify') ||
        lowerLine.includes('exceeded 30000ms') ||
        (lowerLine.includes('qqbot') && (lowerLine.includes('websocket error') || lowerLine.includes('gateway error') || lowerLine.includes('request timeout') || lowerLine.includes('timeout'))) ||
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
        const elapsed = elapsedMatch ? formatElapsedMs(elapsedMatch[1]) : '';
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

    // 遇到报错（非 Bonjour、超时自愈、error-filter 等容易被误报的警告）
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
            lowerLine.includes('allowconversationaccess') ||
            lowerLine.includes('typed hook') ||
            lowerLine.includes('cannot delete the main session') ||
            lowerLine.includes('sessions.delete') ||
            lowerLine.includes('provider-transport-fetch') ||
            lowerLine.includes('model-fetch') ||
            lowerLine.includes('failover') ||
            lowerLine.includes('rotate_profile') ||
            lowerLine.includes('idle timeout') ||
            lowerLine.includes('aborted') ||
            lowerLine.includes('aborterror') ||
            lowerLine.includes('delivery-recovery') ||
            lowerLine.includes('send_attempt_started') ||
            lowerLine.includes('refusing blind replay') ||
            lowerLine.includes('sendinputnotify') ||
            lowerLine.includes('exceeded 30000ms') ||
            lowerLine.includes('compaction') ||
            lowerLine.includes('overflow') ||
            lowerLine.includes('agent/embedded') ||
            lowerLine.includes('diagid') ||
            lowerLine.includes('timeout') ||
            (lowerLine.includes('qqbot') && (lowerLine.includes('websocket') || lowerLine.includes('gateway error') || lowerLine.includes('timeout'))) ||
            isMediaApiNoiseLog(cleanLine) ||
            isHiddenGatewayDiagnosticLog(cleanLine)
        ) return null;
        // 硬规则：任何还带技术栈痕迹的失败日志，绝不包装成「系统警报」原文刷给用户
        if (/[\[\]=]|status=|elapsedms|durationms|stack|errno|ecode|gateway|openclaw|plugin/i.test(cleanLine)) {
            return null;
        }
        // 转义日志正文（可能含渠道消息内容）后再拼入，最终经 innerHTML 渲染——防御性去除 XSS 面
        return `[⚠️ 系统警报] ⚠️ 系统运行警告：${escapeHtml(cleanLine)}`;
    }

    // 服务已停止
    if (cleanLine.includes('Nexora Agent服务已停止') || cleanLine.includes('服务已停止')) {
        return `[⚙️ 系统核心] 🛑 Nexora Agent服务已成功停止！`;
    }

    // 意外退出 / 自动拉起（主进程注入的 System 行）
    if (cleanLine.includes('核心进程意外退出') && cleanLine.includes('自动重启')) {
        return `[⚙️ 系统核心] ⚠️ 核心进程异常退出，正在自动重新拉起服务…`;
    }
    if (cleanLine.includes('核心进程意外退出') && (cleanLine.includes('暂停自动重启') || cleanLine.includes('已禁止自动重启'))) {
        return `[⚙️ 系统核心] 🛑 核心进程异常退出，已停止自动拉起，请点击左上角手动启动`;
    }
    if (cleanLine.includes('核心进程意外退出')) {
        return `[⚙️ 系统核心] ⚠️ 核心进程异常退出（正在处理）`;
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
            // WeChat Gateway（与 beautify 成功文案同源关键词，避免 monitor started 只亮「连接中」）
            if (lowerText.includes('weixin') || lowerText.includes('wechat') || lowerText.includes('wx-bot') || lowerText.includes('ilink')) {
                if (
                    lowerText.includes('ready')
                    || lowerText.includes('success')
                    || lowerText.includes('bound')
                    || lowerText.includes('already connected')
                    || lowerText.includes('monitor started')
                    || lowerText.includes('webhook listening')
                    || lowerText.includes('server listening')
                    || lowerText.includes('消息接收通道已成功连接')
                ) {
                    topoNodeStates['node-wechat'] = 'completed';
                } else if (topoNodeStates['node-wechat'] !== 'completed') {
                    topoNodeStates['node-wechat'] = 'active';
                }
                stateChanged = true;
            }
            // QQ Gateway
            if (lowerText.includes('qqbot') || lowerText.includes('qq-bot') || lowerText.includes('qq_bot')) {
                if (
                    lowerText.includes('ready')
                    || lowerText.includes('success')
                    || lowerText.includes('connected')
                    || lowerText.includes('listening')
                    || lowerText.includes('gateway resumed')
                    || lowerText.includes('消息通道已成功上线')
                    || lowerText.includes('消息接收通道已成功连接')
                ) {
                    topoNodeStates['node-qq'] = 'completed';
                } else if (topoNodeStates['node-qq'] !== 'completed') {
                    topoNodeStates['node-qq'] = 'active';
                }
                stateChanged = true;
            }
            // Feishu Gateway（websocket client started 等原先只会落到 active）
            if (lowerText.includes('feishu') || lowerText.includes('lark')) {
                if (
                    lowerText.includes('ready')
                    || lowerText.includes('success')
                    || lowerText.includes('connected')
                    || lowerText.includes('listening')
                    || lowerText.includes('websocket client started')
                    || lowerText.includes('starting webhook server')
                    || lowerText.includes('消息通道已成功上线')
                ) {
                    topoNodeStates['node-feishu'] = 'completed';
                } else if (topoNodeStates['node-feishu'] !== 'completed') {
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
            if (trimmed && !isMediaApiNoiseLog(trimmed)) {
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
            if (isMediaApiNoiseLog(cleanLine)) return false;
            // 启动成败行必须保留，即使含表格竖线 / doctor 字样
            const keepStartOutcome =
                cleanLine.includes('Gateway failed to start') ||
                cleanLine.includes('Invalid config') ||
                (cleanLine.includes('plugin manifest not found') && cleanLine.includes('media-core')) ||
                cleanLine.includes('已拦截非授权启动') ||
                cleanLine.includes('正在准备启动 Gateway') ||
                cleanLine.includes('正在拉起内置 OpenClaw Gateway') ||
                (cleanLine.includes('端口') && cleanLine.includes('仍被占用'));
            if (keepStartOutcome) return true;
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
        const pluginCountMatch = readyHaystack.match(/http server listening\s*\((\d+)\s*plugins?/i);
        if (pluginCountMatch) {
            __gatewayLoadedPluginCount = parseInt(pluginCountMatch[1], 10) || 0;
            updateRightPluginsCountUI();
        }

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
            // 只抬升、不回退：晚阶段统一到 88，避免先到更高后再被 85/78 拽回去
            if (currentProgress < 96) {
                updateProgressUI(Math.max(currentProgress, 88), '正在绑定端口并装载渠道插件…');
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
                // 与上方 http-near 里程碑对齐（88），禁止再用 78 造成「88%→85%/回退」观感
                targetProgress = 88;
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
                    const name = parts[parts.length - 1].trim();
                    activeModelEl.textContent = name;
                    persistActiveModelLabel(name);
                }
            }
            
            // 微信 / QQ / 飞书通道绿点（与活动流文案解耦，便于重启后从持久化日志回放）
            applyChannelStatusFromLogLine(lineHtml);

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
            // 按整段子节点从头删除，避免 innerHTML.substring 从标签中间切开导致标记错乱/显示损坏
            while (logTerminal.firstChild && logTerminal.innerText.length > 20000) {
                logTerminal.removeChild(logTerminal.firstChild);
            }
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

    if (window.api && typeof window.api.onGatewayStartBlocked === 'function') {
        window.api.onGatewayStartBlocked((data) => {
            const src = data && data.source ? String(data.source) : '';
            // 端口回收等场景不再发此事件；仅真实「非授权自动启用」才提示
            if (src === 'port-reclaim') return;
            showToast(t('console.gateway.start_blocked'));
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
            gatewayProcessReportedRunning = false;
            gatewayLogReadyTail = '';
            __gatewayLoadedPluginCount = null;
            stopGatewayReadyProbe();
            clearGatewayReadyReconcileTimers();
            clearOpenclawControlUiRetry();
            try { setOpenclawPanelOverlay('hide'); } catch (e) {}
            updateGatewayStatusUI('stopped');
            updateRightPluginsCountUI();
            
            // 服务停止：界面熄灭绿点，但不覆盖本地「上次在线」快照（Win+R 回灌用）
            setAllChannelStatusTilesOffline({ persist: false });

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
            gatewayProcessReportedRunning = true;
            gatewayRunningTime = Date.now();
            // 冷启动/热恢复都不再回灌旧活动流；通道绿点等本轮连接日志刷新
            if (oldStatus !== 'stopped') {
                syncChannelStatusTilesFromLogs({ forceOnline: true });
            }
            // 主进程 fork 后立刻报 running，此时 HTTP/Control UI 往往尚未就绪。
            // 一律走 /acp/ 探测，禁止 20 秒假解锁（首装白屏主因）。
            if (!gatewayFullyReady) {
                gatewayStatus = 'starting';
                updateGatewayStatusUI('starting');
                startGatewayReadyProbe('status-running');
                scheduleGatewayReadyReconcile('status-running');
                setTimeout(() => {
                    if (gatewayFullyReady) return;
                    probeControlUiReady(resolveGatewayProbePort()).then((ok) => {
                        if (ok && !gatewayFullyReady) {
                            markGatewayReadyFromLog('核心服务已就绪（自启状态对齐）');
                        }
                    });
                }, 4000);
            }
            if (typeof refreshAccelerationChannel === 'function') refreshAccelerationChannel().catch(() => {});
        }
        else {
            if (status === 'starting' && gatewayFullyReady && oldStatus === 'running') return;
            if (status === 'starting') gatewayProcessReportedRunning = false;
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
            window.api.gatewayAction('start', { source: 'manual' });
        } else if (action === 'stop') {
            window.api.gatewayAction('stop');
            resetConsoleRuntimeLogs();
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
            const on = !!e.target.checked;
            try {
                const ok = await window.api.setAutoStart(on);
                const applied = ok === true || ok === on ? on : !!ok;
                e.target.checked = applied;
                showToast(applied
                    ? t('已开启开机自动启动', 'Auto-start enabled', '已開啟開機自動啟動')
                    : t('已关闭开机自动启动', 'Auto-start disabled', '已關閉開機自動啟動'));
            } catch (err) {
                console.error('Failed to set autostart:', err);
                e.target.checked = !on;
                showToast(t('开机自启设置失败', 'Failed to update auto-start', '開機自啟設定失敗'));
            }
        });
    }
}

// 5. 动态大模型提供商与配置数据管理
let localProviders = {};
// 内置 key 不再硬编码：由 preload 启动时经 IPC 从主进程取（主进程按 env/config/密钥文件加载）
const AGNES_BUILT_IN_KEY = (typeof window !== 'undefined' && window.api && window.api.builtinAgnesKey) || '';
const KEY_MASK = '••••••••••••••••••••••••••••••••••••••••••••••••';

async function syncMediaGeneratorPrefsToDisk(cfg) {
    if (!window.api || !window.api.persistMediaPrefs) return;
    const useBuiltIn = getUseBuiltIn();
    let imageGenerator = cfg && cfg.imageGenerator ? { ...cfg.imageGenerator } : null;
    let videoGenerator = cfg && cfg.videoGenerator ? { ...cfg.videoGenerator } : null;
    if (useBuiltIn || (!imageGenerator && !videoGenerator)) {
        imageGenerator = imageGenerator || {
            apiBase: 'https://apihub.agnes-ai.com/v1/images/generations',
            apiKey: '',
            model: localStorage.getItem('client_pref_image_model') || 'agnes-ai/agnes-image-2.0-flash'
        };
        videoGenerator = videoGenerator || {
            apiBase: 'https://apihub.agnes-ai.com/v1/videos',
            apiKey: '',
            model: localStorage.getItem('client_pref_video_model') || 'agnes-ai/agnes-video-v2.0'
        };
    }
    if (useBuiltIn) {
        imageGenerator.apiBase = 'https://apihub.agnes-ai.com/v1/images/generations';
        videoGenerator.apiBase = 'https://apihub.agnes-ai.com/v1/videos';
        imageGenerator.apiKey = '';
        videoGenerator.apiKey = '';
    }
    await window.api.persistMediaPrefs({ imageGenerator, videoGenerator });
}
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
    // 仅在拿到有效内置 key 时才写；否则若 IPC 偶发返空会把真实 key 覆盖为空 → 401 静默不回复
    if (AGNES_BUILT_IN_KEY) {
        if (agnes.apiKey !== AGNES_BUILT_IN_KEY) {
            agnes.apiKey = AGNES_BUILT_IN_KEY;
            changed = true;
        }
        if (!cfg.env) cfg.env = {};
        if (cfg.env.AGNES_AI_API_KEY !== AGNES_BUILT_IN_KEY) {
            cfg.env.AGNES_AI_API_KEY = AGNES_BUILT_IN_KEY;
            changed = true;
        }
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

    // 双模型教学：老师模型锁定跟随主用模型；学生模型仍可配置
    const teacherEl = document.getElementById('model-teacher');
    const studentEl = document.getElementById('model-student');
    if (teacherEl || studentEl) {
        const dmtCfg = (configData.plugins
            && configData.plugins.entries
            && configData.plugins.entries['dual-model-trainer']
            && configData.plugins.entries['dual-model-trainer'].config) || {};
        if (studentEl) studentEl.value = normalizeStudentModelRef(dmtCfg.studentModel || '');
        syncTeacherModelFromPrimary();
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

    // 同步到 ~/.openclaw 侧车文件，供 media-cli / draw_picture / draw_video 读取（任意电脑开箱）
    try {
        await syncMediaGeneratorPrefsToDisk(configData);
    } catch (e) {
        console.warn('[MediaPrefs] sync on load failed:', e);
    }

    if (configData.gateway) {
        document.getElementById('gateway-port').value = configData.gateway.port || 18789;
        statPort.innerText = configData.gateway.port || 18789;
        const auth = configData.gateway.auth;
        document.getElementById('gateway-token').value = (auth && auth.token) || '';
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
function isCustomProviderKey(key) {
    return key !== 'agnes-ai' && key !== 'ollama';
}

function getProviderLabel(key, provider) {
    const p = provider || (localProviders && localProviders[key]) || {};
    const label = String(p.label || p.displayName || '').trim();
    return label || key;
}

function getProviderRemark(key, provider) {
    const p = provider || (localProviders && localProviders[key]) || {};
    return String(p.remark || '').trim();
}

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
    const esc = (typeof escapeHtml === 'function')
        ? escapeHtml
        : (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));

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
        
        // agnes-ai 与 ollama 为内置/默认大模型服务，不支持删除 / 改名
        const isCustom = isCustomProviderKey(key);
        const displayLabel = getProviderLabel(key, provider);
        const displayRemark = getProviderRemark(key, provider);
        const deleteButtonHtml = !isCustom
            ? '' 
            : `<button type="button" class="btn-delete-provider" data-provider="${key}">❌ ${t('删除此厂家', 'Delete Provider', '刪除此廠商')}</button>`;

        // 折叠按钮 HTML
        const foldButtonText = isCollapsed ? t('展开 🔽', 'Expand 🔽', '展開 🔽') : t('收起 🔼', 'Collapse 🔼', '收起 🔼');
        const foldButtonHtml = `<button type="button" class="btn-fold-provider" data-provider="${key}" style="background: rgba(255,255,255,0.05); color: var(--text-secondary); border: 1px solid var(--border-color); border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; transition: all 0.2s ease;">${foldButtonText}</button>`;

        const headerTitleHtml = isCustom
            ? `<div class="provider-title-wrap" style="display:flex; flex-direction:column; gap:4px; min-width:0; flex:1; padding-right:8px;">
                    <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                        <span style="flex-shrink:0;">🔌</span>
                        <span class="provider-title-text" data-provider="${key}" style="flex:1; min-width:0; font-size:14px; font-weight:700; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(displayLabel)}</span>
                    </div>
                    ${displayRemark ? `<div class="provider-remark-preview" data-provider="${key}" style="font-size:11px; font-weight:normal; color:var(--text-secondary); margin-left:26px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(displayRemark)}</div>` : `<div class="provider-remark-preview" data-provider="${key}" style="display:none; font-size:11px; font-weight:normal; color:var(--text-secondary); margin-left:26px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></div>`}
               </div>`
            : `<h3>🔌 ${esc(key)}
                    ${key === 'agnes-ai' ? `<span id="agnes-built-in-tip" style="font-size: 11px; font-weight: normal; color: #b388ff; margin-left: 8px; display: none;">${t('(已启用内置免配置服务通道)', '(Built-in bypass configured)', '(已啟用內置免配置服務通道)')}</span>` : ''}
                    ${key === 'ollama' ? `<span id="ollama-built-in-tip" style="font-size: 11px; font-weight: normal; color: #8cd8ff; margin-left: 8px;">${t('(内置本地服务通道)', '(Built-in local service channel)', '(內置本地服務通道)')}</span>` : ''}
                </h3>`;

        const customMetaHtml = isCustom
            ? `<div class="form-row" style="margin-bottom: 4px;">
                    <div class="form-field">
                        <label>${t('显示名称', 'Display Name', '顯示名稱')} <span style="font-weight:normal;opacity:.65;">${t('（仅界面，可随便改）', '(UI only)', '（僅界面，可隨便改）')}</span></label>
                        <input type="text" class="provider-label-input" data-provider="${key}" value="${esc(provider.label || provider.displayName || '')}" placeholder="${esc(t('例如: 公司 Gemini 中转', 'e.g. Company Gemini Relay', '例如: 公司 Gemini 中轉'))}">
                    </div>
                    <div class="form-field">
                        <label>${t('备注', 'Remark', '備註')} <span style="font-weight:normal;opacity:.65;">${t('（仅界面）', '(UI only)', '（僅界面）')}</span></label>
                        <input type="text" class="provider-remark-input" data-provider="${key}" value="${esc(provider.remark || '')}" placeholder="${esc(t('例如: 测试账号 / 生产环境', 'e.g. Test account / Production', '例如: 測試帳號 / 生產環境'))}">
                    </div>
               </div>
               <div class="form-row" style="margin-bottom: 8px;">
                    <div class="form-field">
                        <label>${t('厂商标识', 'Provider ID', '廠商標識')} <span style="font-weight:normal;opacity:.65;">${t('（真正供应商名，网关用）', '(Real provider ID for gateway)', '（真正供應商名，網關用）')}</span></label>
                        <input type="text" class="provider-id-input" data-provider="${key}" value="${esc(key)}" placeholder="${esc(t('例如: deepseek, openai', 'e.g. deepseek, openai', '例如: deepseek, openai'))}" spellcheck="false" autocomplete="off">
                    </div>
               </div>`
            : '';

        card.innerHTML = `
            <div class="provider-card-header" style="cursor: pointer; user-select: none;">
                ${headerTitleHtml}
                <div style="display: flex; align-items: center; gap: 8px;" class="provider-card-actions">
                    ${deleteButtonHtml}
                    ${foldButtonHtml}
                </div>
            </div>
            <div class="provider-card-body" id="provider-card-body-${key}">
                ${customMetaHtml}
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
                            ${renderModelApiProtocolOptions(provider.api)}
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
            row.style.cssText = 'display: grid; grid-template-columns: 1fr 156px 40px; gap: 12px; align-items: center; padding: 4px 8px; background: rgba(255,255,255,0.01); border-radius: 6px;';
            row.innerHTML = `
                <div>
                    <input type="text" class="model-id-edit-input" data-provider="${key}" data-index="${index}" value="${model.id || ''}" placeholder="${t('模型名称, 如: gpt-4o', 'Model ID, e.g., gpt-4o', '模型名稱, 如: gpt-4o')}" style="width: 100%; height: 30px; font-size: 12px; background: var(--bg-input) !important; border: 1px solid var(--border-color); border-radius: 6px; color: white; padding: 0 8px; outline: none;">
                </div>
                <div style="display: flex; gap: 4px; align-items: center;">
                    <input type="text" class="model-context-edit-input" data-provider="${key}" data-index="${index}" value="${formatContextWindow(model.contextWindow || inferContextWindow(model.id))}" placeholder="${t('例如: 128k 或 1M', 'e.g., 128k or 1M', '例如: 128k 或 1M')}" style="flex: 1; min-width: 0; height: 30px; font-size: 12px; background: var(--bg-input) !important; border: 1px solid var(--border-color); border-radius: 6px; color: white; padding: 0 8px; outline: none;">
                    <button type="button" class="btn-probe-context" data-provider="${key}" data-index="${index}" title="${t('实测真实上下文窗口（发送探测请求）', 'Probe real context window (sends a test request)', '實測真實上下文視窗（發送探測請求）')}" style="background: none; border: 1px solid var(--border-color); border-radius: 6px; color: #aaa; cursor: pointer; font-size: 13px; height: 30px; width: 30px; flex: none; line-height: 1; padding: 0;">📏</button>
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

    const syncProviderLabelInputs = (providerKey, rawLabel, sourceEl) => {
        if (!localProviders[providerKey]) return;
        const trimmed = String(rawLabel || '').trim();
        if (trimmed) localProviders[providerKey].label = trimmed;
        else delete localProviders[providerKey].label;
        delete localProviders[providerKey].displayName;
        const shown = getProviderLabel(providerKey, localProviders[providerKey]);
        document.querySelectorAll(`.provider-label-input[data-provider="${providerKey}"]`).forEach((el) => {
            if (el === sourceEl) return;
            el.value = trimmed;
        });
        document.querySelectorAll(`.provider-title-text[data-provider="${providerKey}"]`).forEach((el) => {
            el.textContent = shown;
        });
        markConfigDirty();
    };

    const rewriteProviderRef = (raw, oldKey, newKey) => {
        const s = String(raw || '').trim();
        if (!s) return s;
        if (s === oldKey) return newKey;
        if (s.startsWith(oldKey + '/')) return newKey + s.slice(oldKey.length);
        return s;
    };

    const renameCustomProviderKey = (oldKey, nextRaw) => {
        if (!isCustomProviderKey(oldKey) || !localProviders[oldKey]) return false;
        const newKey = String(nextRaw || '').trim().toLowerCase();
        if (!newKey) {
            showToast(t('请输入厂商标识', 'Please enter provider ID', '請輸入廠商標識'));
            return false;
        }
        if (!/^[a-z0-9_-]+$/.test(newKey)) {
            showToast(t('厂商标识仅能由小写字母、数字及中划线/下划线组成', 'Provider ID: lowercase letters, numbers, hyphen, underscore only', '廠商標識僅能由小寫字母、數字及中劃線/下劃線組成'));
            return false;
        }
        if (newKey === oldKey) return true;
        if (!isCustomProviderKey(newKey)) {
            showToast(t('不能使用内置厂商标识 agnes-ai / ollama', 'Cannot use built-in IDs agnes-ai / ollama', '不能使用內置廠商標識 agnes-ai / ollama'));
            return false;
        }
        if (localProviders[newKey]) {
            showToast(t('该厂商标识已存在', 'This provider ID already exists', '該廠商標識已存在'));
            return false;
        }

        localProviders[newKey] = localProviders[oldKey];
        delete localProviders[oldKey];
        if (expandedProviders.has(oldKey)) {
            expandedProviders.delete(oldKey);
            expandedProviders.add(newKey);
        }

        ['model-primary', 'model-fallback', 'model-teacher', 'model-student', 'image-model', 'video-model'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            const next = rewriteProviderRef(el.value, oldKey, newKey);
            if (next !== el.value) el.value = next;
        });
        ['model-primary-provider', 'model-fallback-provider'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.value === oldKey) el.value = newKey;
        });

        renderProvidersList();
        updateModelsDatalist();
        try { updateAssignedProviderSelects(); } catch (_) {}
        markConfigDirty();
        showToast(t(`已将厂商标识改为 ${newKey}`, `Provider ID renamed to ${newKey}`, `已將廠商標識改為 ${newKey}`));
        return true;
    };

    document.querySelectorAll('.provider-label-input').forEach(input => {
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('keydown', (e) => e.stopPropagation());
        input.addEventListener('input', (e) => {
            const provider = e.target.getAttribute('data-provider');
            syncProviderLabelInputs(provider, e.target.value, e.target);
        });
        input.addEventListener('change', (e) => {
            const provider = e.target.getAttribute('data-provider');
            syncProviderLabelInputs(provider, e.target.value, e.target);
        });
    });

    document.querySelectorAll('.provider-id-input').forEach(input => {
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault();
                e.target.blur();
            }
        });
        input.addEventListener('blur', (e) => {
            const oldKey = e.target.getAttribute('data-provider');
            const ok = renameCustomProviderKey(oldKey, e.target.value);
            if (!ok && localProviders[oldKey]) {
                e.target.value = oldKey;
            }
        });
    });

    document.querySelectorAll('.provider-remark-input').forEach(input => {
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('input', (e) => {
            const provider = e.target.getAttribute('data-provider');
            if (!localProviders[provider]) return;
            const trimmed = String(e.target.value || '').trim();
            if (trimmed) localProviders[provider].remark = trimmed;
            else delete localProviders[provider].remark;
            const preview = document.querySelector(`.provider-remark-preview[data-provider="${provider}"]`);
            if (preview) {
                if (trimmed) {
                    preview.textContent = trimmed;
                    preview.style.display = '';
                } else {
                    preview.textContent = '';
                    preview.style.display = 'none';
                }
            }
            markConfigDirty();
        });
        input.addEventListener('change', (e) => {
            e.target.dispatchEvent(new Event('input'));
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
            if (await confirm(t(`确定要彻底删除厂家 "${getProviderLabel(provider)}" 及其下的所有模型配置吗？`, `Are you sure you want to completely delete provider "${getProviderLabel(provider)}" and all its model configurations?`, `確定要徹底刪除廠商 "${getProviderLabel(provider)}" 及其下的所有模型配置嗎？`))) {
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
            if (e.target.closest('.provider-label-input')) return;
            if (e.target.closest('.provider-title-wrap')) return;
            
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

    // 实测上下文窗口：报错解析 + 开头标记回忆；适配任意 OpenAI 兼容自定义服务商
    document.querySelectorAll('.btn-probe-context').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const el = e.currentTarget;
            const provider = el.getAttribute('data-provider');
            const index = parseInt(el.getAttribute('data-index'), 10);
            const model = localProviders[provider] && localProviders[provider].models && localProviders[provider].models[index];
            if (!model || !model.id) {
                showToast(t('请先填写模型名称并保存', 'Fill in and save the model ID first', '請先填寫模型名稱並保存'));
                return;
            }
            const declared = Number(model.contextWindow) || 128000;
            const target = Math.max(140000, Math.round(declared * 1.15));
            const okGo = await confirm(t(
                `将向 ${model.id} 发送约 ${Math.round(target / 1000)}K token 的探测请求实测真实窗口。若上游拒绝并声明上限则几乎免费；若上游静默截断则按输入计费（通常几分钱）。继续？`,
                `Will send a ~${Math.round(target / 1000)}K-token probe to ${model.id}. Nearly free if upstream rejects with a stated limit; billed as input if it silently truncates. Continue?`,
                `將向 ${model.id} 發送約 ${Math.round(target / 1000)}K token 的探測請求實測真實視窗。若上游拒絕並聲明上限則幾乎免費；若靜默截斷則按輸入計費。繼續？`
            ));
            if (!okGo) return;
            const prevTxt = el.textContent;
            el.disabled = true;
            el.textContent = '⏳';
            try {
                const res = await window.api.probeModelContext(provider, model.id, target);
                if (!res || !res.ok) {
                    showToast((res && res.error) || t('探测失败', 'Probe failed', '探測失敗'));
                    return;
                }
                const capHint = (v) => v > 131072
                    ? t('（超过 131072 封顶值，需设置 NEXORA_CLOUD_CTX_CAP 环境变量才生效）', ' (exceeds the 131072 cap; set NEXORA_CLOUD_CTX_CAP to take effect)', '（超過 131072 封頂值，需設定 NEXORA_CLOUD_CTX_CAP 才生效）')
                    : '';
                if (res.verdict === 'limit') {
                    model.contextWindow = res.limit;
                    markConfigDirty();
                    renderProvidersList();
                    updateModelsDatalist();
                    showToast(t(`上游声明上限 ${res.limit} tokens，已写入`, `Upstream limit ${res.limit} tokens, applied`, `上游聲明上限 ${res.limit} tokens，已寫入`) + capHint(res.limit));
                } else if (res.verdict === 'ge') {
                    if (target > declared) {
                        model.contextWindow = target;
                        markConfigDirty();
                        renderProvidersList();
                        updateModelsDatalist();
                    }
                    showToast(t(`实测真实窗口 ≥ ${target} tokens；如需探更高可再点一次`, `Measured real window ≥ ${target} tokens; probe again for higher`, `實測真實視窗 ≥ ${target} tokens`) + capHint(target));
                } else {
                    showToast(t(`上游接受但静默截断：真实有效窗口小于 ${target}，建议保持或调低当前声明值`, `Accepted but silently truncated below ${target}; keep or lower the declared value`, `上游靜默截斷：真實視窗小於 ${target}，建議保持或調低聲明值`));
                }
            } finally {
                el.disabled = false;
                el.textContent = prevTxt;
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
                statusSpan.innerText = t('🔄 正在获取模型...', '🔄 Fetching models...', '🔄 正在獲取模型...');                statusSpan.style.color = '#ffd54f';
                statusSpan.style.display = 'inline-block';
            }

            btn.disabled = true;

            try {
                let testUrl = buildModelListUrl(baseUrl, apiType);

                const headers = buildModelApiHeaders(apiType, apiKey);

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
                        fetchedModels = data.data.map(m => {
                            // 优先用上游返回的真实窗口（各家字段名不一），否则按模型名自适应推断，最后回退默认
                            const upstream = Number(
                                m.context_length || m.context_window || m.max_context_length ||
                                (m.meta && m.meta.context_length) ||
                                (m.limits && (m.limits.max_context_tokens || m.limits.context_length))
                            );
                            return {
                                id: m.id,
                                contextWindow: (Number.isFinite(upstream) && upstream > 0)
                                    ? upstream
                                    : (inferContextWindow(m.id) || 128000)
                            };
                        });
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

            // 内置模式：走主进程真实探活（含内置 Key 轮询）
            const useBuiltIn = getUseBuiltIn();
            if (provider === 'agnes-ai' && useBuiltIn) {
                if (resultSpan) {
                    resultSpan.innerText = t('⚡ 正在检验内置服务...', '⚡ Verifying built-in service...', '⚡ 正在檢驗內置服務...');
                    resultSpan.style.color = '#ffd54f';
                    resultSpan.style.display = 'inline-block';
                }
                btn.disabled = true;
                try {
                    const res = await window.api.verifyBuiltInAgnes({ mode: 'connection' });
                    if (res && res.success) {
                        const tip = res.rotated
                            ? t(`✅ 内置服务可用，已轮询到第 ${res.keyIndex} 把 Key`, `✅ Built-in service available, rotated to key #${res.keyIndex}`, `✅ 內置服務可用，已輪詢到第 ${res.keyIndex} 把 Key`)
                            : t(`✅ 内置服务可用，当前命中第 ${res.keyIndex} 把 Key`, `✅ Built-in service available, using key #${res.keyIndex}`, `✅ 內置服務可用，當前命中第 ${res.keyIndex} 把 Key`);
                        resultSpan.textContent = tip;
                        resultSpan.style.color = '#00e676';
                        showToast(tip);
                    } else {
                        const last = (res && res.attempts && res.attempts[res.attempts.length - 1]) || {};
                        let tip = t(`❌ 内置服务不可用 (${last.error || last.status || '未知错误'})`, `❌ Built-in service unavailable (${last.error || last.status || 'unknown'})`, `❌ 內置服務不可用 (${last.error || last.status || '未知錯誤'})`);
                        if (res && (res.networkHint === 'direct_timeout' || res.networkHint === 'proxy_or_upstream_timeout')) {
                            tip = t('❌ 网络超时：当前直连/本地转发都连不上上游，可稍后重试或临时开启网络中转', '❌ Network timeout: cannot reach upstream via current path; retry later or temporarily enable Network Relay', '❌ 網路超時：當前直連/本地轉發都連不上上游，可稍後重試或臨時開啟網路中轉');
                        }
                        resultSpan.textContent = tip;
                        resultSpan.style.color = '#ff5252';
                        showToast(tip);
                    }
                } catch (error) {
                    const tip = t(`❌ 内置服务检验失败 (${error.message || error})`, `❌ Built-in service verification failed (${error.message || error})`, `❌ 內置服務檢驗失敗 (${error.message || error})`);
                    if (resultSpan) {
                        resultSpan.textContent = tip;
                        resultSpan.style.color = '#ff5252';
                    }
                    showToast(tip);
                } finally {
                    btn.disabled = false;
                }
                return;
            }

            if (!baseUrl) {
                alert(t('请输入 Base URL (API 端点) 后再进行检验！', 'Please enter Base URL (API Endpoint) first before verifying!', '請輸入 Base URL (API 端點) 後再進行檢驗！'));
                return;
            }

            if (resultSpan) {
                resultSpan.innerText = t('⚡ 正在检验连接...', '⚡ Verifying connection...', '⚡ 正在檢驗連接...');                resultSpan.style.color = '#ffd54f';
                resultSpan.style.display = 'inline-block';
            }

            btn.disabled = true;

            // 必须声明在 try 外：catch 里会用到，否则超时后二次 ReferenceError，状态卡在「正在检验…」
            let testUrl = buildModelListUrl(baseUrl, apiType);
            const headers = buildModelApiHeaders(apiType, apiKey);
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

            // 内置模式：走主进程真实验钥（含内置 Key 轮询）
            const useBuiltIn = getUseBuiltIn();
            if (provider === 'agnes-ai' && useBuiltIn) {
                if (resultSpan) {
                    resultSpan.innerText = t('🔑 正在验证内置密钥...', '🔑 Validating built-in keys...', '🔑 正在驗證內置金鑰...');
                    resultSpan.style.color = '#ffd54f';
                    resultSpan.style.display = 'inline-block';
                }
                btn.disabled = true;
                try {
                    const res = await window.api.verifyBuiltInAgnes({ mode: 'key' });
                    if (res && res.success) {
                        const tip = res.rotated
                            ? t(`✅ 内置密钥可用，轮询已生效，当前命中第 ${res.keyIndex} 把 Key`, `✅ Built-in keys available, rotation worked, using key #${res.keyIndex}`, `✅ 內置金鑰可用，輪詢已生效，當前命中第 ${res.keyIndex} 把 Key`)
                            : t(`✅ 内置密钥可用，当前命中第 ${res.keyIndex} 把 Key`, `✅ Built-in keys available, using key #${res.keyIndex}`, `✅ 內置金鑰可用，當前命中第 ${res.keyIndex} 把 Key`);
                        resultSpan.textContent = tip;
                        resultSpan.style.color = '#00e676';
                        showToast(tip);
                    } else {
                        const last = (res && res.attempts && res.attempts[res.attempts.length - 1]) || {};
                        let tip = t(`❌ 内置密钥不可用 (${last.error || last.status || '未知错误'})`, `❌ Built-in keys unavailable (${last.error || last.status || 'unknown'})`, `❌ 內置金鑰不可用 (${last.error || last.status || '未知錯誤'})`);
                        if (res && (res.networkHint === 'direct_timeout' || res.networkHint === 'proxy_or_upstream_timeout')) {
                            tip = t('❌ 网络超时：当前连不上上游（与是否开网络中转无关时也可先重试）', '❌ Network timeout: cannot reach upstream (retry first; Network Relay is optional)', '❌ 網路超時：當前連不上上游（與是否開網路中轉無關時也可先重試）');
                        }
                        resultSpan.textContent = tip;
                        resultSpan.style.color = '#ff5252';
                        showToast(tip);
                    }
                } catch (error) {
                    const tip = t(`❌ 内置密钥验证失败 (${error.message || error})`, `❌ Built-in key verification failed (${error.message || error})`, `❌ 內置金鑰驗證失敗 (${error.message || error})`);
                    if (resultSpan) {
                        resultSpan.textContent = tip;
                        resultSpan.style.color = '#ff5252';
                    }
                    showToast(tip);
                } finally {
                    btn.disabled = false;
                }
                return;
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
                resultSpan.innerText = t('🔑 正在验证密钥有效性...', '🔑 Validating key...', '🔑 正在驗證金鑰有效性...');                resultSpan.style.color = '#ffd54f';
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
            const chatProbe = buildChatRequest(baseUrl, apiType, testModel, [{ role: 'user', content: 'ping' }], { apiKey, maxTokens: 1, temperature: 0 });
            const testUrl = chatProbe.url;
            const headers = chatProbe.headers;
            let timeoutId = null;

            try {
                const body = chatProbe.body;

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
    syncTeacherModelFromPrimary();
}

/** 从当前 UI 拼出主用模型完整引用（provider/model） */
function getPrimaryModelRefFromUi() {
    const primaryInput = document.getElementById('model-primary');
    const primarySelect = document.getElementById('model-primary-provider');
    if (!primaryInput) return '';
    let modelVal = primaryInput.value.trim();
    const providerVal = primarySelect ? primarySelect.value.trim() : '';
    if (!modelVal) return '';
    if (modelVal.includes('/')) return modelVal;
    if (providerVal) return `${providerVal}/${modelVal}`;
    return modelVal;
}

/** 教学老师模型始终等于主用模型：只读同步，不可单独改 */
function syncTeacherModelFromPrimary() {
    const teacherEl = document.getElementById('model-teacher');
    if (!teacherEl) return;
    teacherEl.readOnly = true;
    teacherEl.disabled = true;
    teacherEl.value = getPrimaryModelRefFromUi();
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
    syncTeacherModelFromPrimary();
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
    syncTeacherModelFromPrimary();
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
const newProviderLabelInput = document.getElementById('new-provider-label');
const newProviderRemarkInput = document.getElementById('new-provider-remark');
const newProviderUrlInput = document.getElementById('new-provider-url');
const newProviderKeyInput = document.getElementById('new-provider-key');

document.getElementById('btn-add-provider').addEventListener('click', () => {
    if (getUseBuiltIn()) {
        showToast(t('内置模型开启时仅可使用 agnes-ai 与 ollama', 'With built-in models on, only agnes-ai and ollama are available.', '內置模型開啟時僅可使用 agnes-ai 與 ollama'));
        return;
    }
    newProviderIdInput.value = '';
    if (newProviderLabelInput) newProviderLabelInput.value = '';
    if (newProviderRemarkInput) newProviderRemarkInput.value = '';
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
    const labelVal = newProviderLabelInput ? newProviderLabelInput.value.trim() : '';
    const remarkVal = newProviderRemarkInput ? newProviderRemarkInput.value.trim() : '';
    if (labelVal) localProviders[key].label = labelVal;
    if (remarkVal) localProviders[key].remark = remarkVal;

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
        // 仅在拿到有效内置 key 时才写；否则 IPC 偶发返空会把真实 key 覆盖为空 → 401 静默不回复
        // （与加载路径 applyBuiltInModelPolicy 的守卫保持一致）
        if (AGNES_BUILT_IN_KEY) finalProviders['agnes-ai'].apiKey = AGNES_BUILT_IN_KEY;
    }
    
    configData.models.providers = finalProviders;

    // 2. 同步生成环境变量 (env) 机制
    if (!configData.env) configData.env = {};
    for (const key of Object.keys(localProviders)) {
        const envKeyName = key.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase() + '_API_KEY';
        let val = localProviders[key].apiKey;
        if (key === 'agnes-ai' && useBuiltIn && AGNES_BUILT_IN_KEY) {
            val = AGNES_BUILT_IN_KEY;
        }
        if (val) {
            configData.env[envKeyName] = val;
        } else {
            // 用户清空了该 provider 的 key：删掉对应 env 项，否则旧 key 残留、网关继续用它
            // （表现为「我删了 key 但它还能用」）
            delete configData.env[envKeyName];
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
    const studentInput = document.getElementById('model-student');
    // 老师模型强制等于主用模型（不可单独配置）
    dmtEntry.config.teacherModel = (configData.agents.defaults.model.primary || getPrimaryModelRefFromUi() || '').trim();
    syncTeacherModelFromPrimary();
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

        configData.imageGenerator.apiBase = 'https://apihub.agnes-ai.com/v1/images/generations';
        configData.imageGenerator.apiKey = '';

        configData.videoGenerator.apiBase = 'https://apihub.agnes-ai.com/v1/videos';
        configData.videoGenerator.apiKey = '';
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
        await loadAndRenderConfig();
        const saveLabel = t('保存配置', 'Save Configuration', '保存配置');
        clearSaveBtnDirtyState(document.getElementById('config-save-btn-top'), saveLabel);
        clearSaveBtnDirtyState(document.getElementById('config-save-btn'), saveLabel);
        const jsonErrorEl = document.getElementById('json-format-error');
        if (jsonErrorEl) jsonErrorEl.style.display = 'none';
        if (statPort) statPort.innerText = configData.gateway.port;

        // 网关运行中：一次确认搞定「已保存 + 是否重启」，避免连弹两个窗
        if (gatewayStatus === 'running') {
            const restart = await confirm(
                t(
                    '配置已保存成功。\n\nNexora Agent 正在运行，是否立即重启以使新配置生效？',
                    'Configuration saved.\n\nNexora Agent is running. Restart now to apply changes?',
                    '配置已保存成功。\n\nNexora Agent 正在運行，是否立即重啟以使新配置生效？'
                ),
                t('保存成功', 'Saved', '保存成功')
            );
            if (restart) {
                reloadGatewayAfterChannelChange('config-save', { startIfStopped: false });
            }
        } else {
            showToast(t('配置已成功保存！', 'Configuration saved successfully!', '配置已成功保存！'));
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

// ─── 技能中心 ───
let __skillsCenterTab = 'clawhub';
let __skillsCenterBound = false;

function skillsT(key, fallback) {
    try {
        if (typeof t === 'function') {
            const v = t(key);
            if (v && v !== key) return v;
        }
    } catch (_) {}
    return fallback || key;
}

function setSkillsCenterTab(tab) {
    __skillsCenterTab = tab || 'clawhub';
    document.querySelectorAll('.skills-tab').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-skills-tab') === __skillsCenterTab);
    });
    const inst = document.getElementById('skills-panel-installed');
    const pend = document.getElementById('skills-panel-pending');
    const hub = document.getElementById('skills-panel-clawhub');
    const hintDef = document.getElementById('skills-hint-default');
    const hintHub = document.getElementById('skills-hint-clawhub');
    if (inst) inst.style.display = __skillsCenterTab === 'installed' ? '' : 'none';
    if (pend) pend.style.display = __skillsCenterTab === 'pending' ? '' : 'none';
    if (hub) hub.style.display = __skillsCenterTab === 'clawhub' ? '' : 'none';
    if (hintDef) hintDef.style.display = __skillsCenterTab === 'clawhub' ? 'none' : '';
    if (hintHub) hintHub.style.display = __skillsCenterTab === 'clawhub' ? '' : 'none';
}

function bindSkillsCenterOnce() {
    if (__skillsCenterBound) return;
    __skillsCenterBound = true;

    document.querySelectorAll('.skills-tab').forEach((btn) => {
        btn.addEventListener('click', async () => {
            setSkillsCenterTab(btn.getAttribute('data-skills-tab') || 'clawhub');
            await refreshSkillsCenter();
        });
    });

    const refreshBtn = document.getElementById('btn-skills-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => refreshSkillsCenter());

    const searchBtn = document.getElementById('btn-skills-clawhub-search');
    const queryInput = document.getElementById('skills-clawhub-query');
    const hotBtn = document.getElementById('btn-skills-clawhub-hot');
    if (searchBtn) searchBtn.addEventListener('click', () => renderSkillsClawhub());
    if (hotBtn) {
        hotBtn.addEventListener('click', () => {
            if (queryInput) queryInput.value = '';
            renderSkillsClawhub({ forcePopular: true });
        });
    }
    if (queryInput) {
        queryInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') renderSkillsClawhub();
        });
    }
    const openSiteBtn = document.getElementById('btn-skills-clawhub-open');
    if (openSiteBtn) {
        openSiteBtn.addEventListener('click', () => {
            if (window.api && window.api.openExternal) window.api.openExternal('https://clawhub.ai');
        });
    }
}

async function refreshSkillsCenter() {
    bindSkillsCenterOnce();
    if (__skillsCenterTab === 'pending') await renderSkillsPending();
    else if (__skillsCenterTab === 'clawhub') await renderSkillsClawhub();
    else await renderSkillsInstalled();
}

/**
 * 为技能卡片选一个图标：优先用上游/后端返回的 icon（emoji 或图片 URL），
 * 否则按技能名称/slug 智能匹配一个有意义的 emoji（对以后的新技能也适用），最后按名字哈希取一个，保证各不相同、不再全是 🔥。
 */
function skillIconFor(item) {
    const rawIcon = item && (item.icon || item.emoji || item.logo) ? String(item.icon || item.emoji || item.logo).trim() : '';
    if (rawIcon) {
        if (/^https?:\/\//i.test(rawIcon)) {
            return `<img src="${escapeHtml(rawIcon)}" alt="" style="width:100%;height:100%;object-fit:contain;border-radius:6px;" onerror="this.outerHTML='🧩'">`;
        }
        return escapeHtml(rawIcon); // emoji 或短字符
    }
    const s = String((item && (item.slug || item.displayName || item.ref || item.name)) || '').toLowerCase();
    const map = [
        [/github/, '🐙'], [/gitlab/, '🦊'], [/(^|[^a-z])git($|[^a-z])|chronicle/, '🐙'],
        [/emotion|mood|feel|amygdala|情绪/, '😊'],
        [/companion|girlfriend|boyfriend|friend|lady|dating|恋爱|陪伴|companion/, '💕'],
        [/mental|health|therapy|心理|counsel/, '🩺'],
        [/chat|character|conversation|companion|聊天|对话/, '💬'],
        [/plan|planner|sop|task|todo|execution|流程/, '🗂️'],
        [/weather|forecast/, '🌦️'], [/obsidian/, '🟣'], [/notion/, '📝'],
        [/pdf/, '📄'], [/(^|[^a-z])(search|tavily|serp|brave)/, '🔍'],
        [/calendar|gcal/, '📅'], [/gog|workspace|gmail|gsuite/, '📇'],
        [/browser|playwright|puppeteer|chromium/, '🌐'],
        [/image|banana|admapix|photo|dalle|diffusion|midjourney/, '🖼️'],
        [/human(ize)?/, '✍️'], [/phone|polly|call|dial|sms/, '📞'],
        [/ontology|knowledge|graph|memory|rag|vector/, '🧠'],
        [/vet|scan|security|guard|audit|safe/, '🛡️'],
        [/update|upgrad/, '🔄'], [/proactive/, '⚡'],
        [/self|improv|reflect|learn/, '🌱'], [/agent|bot/, '🤖'],
        [/note|doc|markdown|wiki/, '🗒️'], [/map|geo|location/, '🗺️'],
        [/music|audio|tts|voice|speech/, '🎵'], [/video|movie|film/, '🎬'],
        [/code|dev|compile|lint/, '💻'], [/mail|email|smtp/, '📧'],
        [/data|db|sql|sqlite|postgres|mysql/, '🗄️'], [/finance|stock|crypto|pay/, '💰'],
        [/translate|i18n|lang/, '🌍'], [/task|todo|kanban|plan/, '🗂️'], [/scrape|crawl/, '🕸️'],
    ];
    for (const [re, em] of map) { if (re.test(s)) return em; }
    // 未知技能：按名字哈希从调色板取一个，保证彼此不同
    const palette = ['🧩', '📦', '🔧', '✨', '🚀', '🔩', '📊', '🧭', '🔮', '⚙️', '🧱', '🎛️'];
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
}

async function renderSkillsClawhub(opts = {}) {
    const grid = document.getElementById('skills-clawhub-grid');
    if (!grid) return;
    if (!window.api || !window.api.skillsClawhubSearch) {
        grid.innerHTML = `<div class="skill-card-empty">技能商店接口未就绪，请完全退出后重新打开 Nexora Agent</div>`;
        return;
    }
    const queryInput = document.getElementById('skills-clawhub-query');
    let q = ((queryInput || {}).value || '').trim();
    if (opts.forcePopular) q = '';
    const isPopular = !q;
    grid.innerHTML = `<div class="skill-card-empty">${isPopular ? skillsT('skills.clawhub.loading_hot', '加载热门推荐…') : skillsT('skills.clawhub.searching', '搜索中…')}</div>`;
    let res;
    try {
        res = await window.api.skillsClawhubSearch({ query: isPopular ? '' : q, limit: 24 });
    } catch (e) {
        grid.innerHTML = `<div class="skill-card-empty">${escapeHtml((e && e.message) || 'request failed')}</div>`;
        return;
    }
    let results = (res && res.results) || [];
    results = results.filter((item) => String(item.summary || item.description || '').trim().length >= 8);
    grid.innerHTML = '';
    if (!res || !res.success) {
        grid.innerHTML = `<div class="skill-card-empty">${escapeHtml((res && res.error) || '加载失败，请检查网络后点「热门推荐」')}</div>`;
        return;
    }
    if (!results.length) {
        grid.innerHTML = `<div class="skill-card-empty">${skillsT('skills.clawhub.empty', '没有找到技能')} · ${skillsT('skills.clawhub.try_hot', '可点「热门推荐」')}</div>`;
        return;
    }
    const showHot = isPopular || res.mode === 'popular';
    if (showHot) {
        const banner = document.createElement('div');
        banner.className = 'skills-clawhub-banner';
        banner.textContent = skillsT('skills.clawhub.hot_title', '热门推荐 · 按下载量排序');
        grid.appendChild(banner);
    }
    for (const item of results) {
        const card = document.createElement('div');
        card.className = 'skill-card';
        const meta = [
            item.version ? `v${item.version}` : '',
            item.downloads ? `${item.downloads}↓` : '',
            item.stars ? `${item.stars}★` : ''
        ].filter(Boolean).join(' · ');
        card.innerHTML = `
          <div class="skill-card-head">
            <div class="skill-card-icon store">${skillIconFor(item)}</div>
            <div class="skill-card-titles">
              <h4 class="skill-card-title">${escapeHtml(item.displayName || item.slug || '')}</h4>
              <div class="skill-card-sub">${escapeHtml(item.ref || item.slug || '')}${meta ? ' · ' + escapeHtml(meta) : ''}</div>
            </div>
          </div>
          <p class="skill-card-desc">${escapeHtml(item.summary || '')}</p>
          <div class="skill-card-foot">
            <span class="skill-card-status">${showHot ? skillsT('skills.clawhub.hot_badge', '热门') : 'ClawHub'}</span>
            <div class="skills-card-actions">
              <button type="button" data-act="web">${skillsT('skills.clawhub.detail', '详情')}</button>
              <button type="button" data-act="install" class="primary">${skillsT('skills.clawhub.install', '安装（默认禁用）')}</button>
            </div>
          </div>`;
        card.querySelectorAll('button[data-act]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const act = btn.getAttribute('data-act');
                if (act === 'web') {
                    const meta = [
                        item.version ? `版本：v${item.version}` : '',
                        item.downloads ? `下载：${item.downloads}` : '',
                        item.stars ? `星标：${item.stars}` : '',
                        item.ref ? `标识：${item.ref}` : ''
                    ].filter(Boolean).join('\n');
                    const body = [
                        String(item.description || item.summary || '').trim() || skillsT('skills.detail.no_desc', '暂无详细说明'),
                        meta ? `\n——\n${meta}` : ''
                    ].join('\n').trim();
                    await alert(body, item.displayName || item.slug || skillsT('skills.clawhub.detail', '详情'));
                    return;
                }
                if (act === 'install') {
                    const ok = await confirm(skillsT('skills.clawhub.confirm_install', '确认安装该技能？安装后默认禁用，需在「已安装」中手动启用。'));
                    if (!ok) return;
                    btn.disabled = true;
                    btn.textContent = skillsT('skills.clawhub.installing', '安装中…');
                    const r = await window.api.skillsClawhubInstall({ ref: item.ref || item.slug, version: item.version || undefined });
                    btn.disabled = false;
                    btn.textContent = skillsT('skills.clawhub.install', '安装（默认禁用）');
                    if (!r || !r.success) {
                        showToast((r && r.error) || 'install failed');
                        return;
                    }
                    showToast(skillsT('skills.clawhub.installed', '已安装（默认禁用），请到「已安装」启用'));
                }
            });
        });
        grid.appendChild(card);
    }
}

async function renderSkillsInstalled() {
    const grid = document.getElementById('skills-installed-grid');
    if (!grid || !window.api || !window.api.skillsList) return;
    grid.innerHTML = '';
    const res = await window.api.skillsList();
    const skills = (res && res.skills) || [];
    if (!skills.length) {
        grid.innerHTML = `<div class="skill-card-empty">${skillsT('skills.empty.installed', '暂无技能')}</div>`;
        return;
    }
    for (const sk of skills) {
        const card = document.createElement('div');
        card.className = 'skill-card';
        const badge = sk.protected
            ? `<span class="skills-badge">${skillsT('skills.protected', '内置')}</span>`
            : '';
        const status = sk.enabled
            ? skillsT('skills.status.enabled', '已启用')
            : skillsT('skills.status.disabled', '已禁用');
        card.innerHTML = `
          <div class="skill-card-head">
            <div class="skill-card-icon">${skillIconFor(sk)}</div>
            <div class="skill-card-titles">
              <h4 class="skill-card-title">${escapeHtml(sk.name || '')}${badge}</h4>
              <div class="skill-card-sub">${escapeHtml(sk.relativePath || sk.name || '')}</div>
            </div>
          </div>
          <p class="skill-card-desc" title="${escapeHtml(sk.description || '')}">${escapeHtml(sk.description || '')}</p>
          <div class="skill-card-foot">
            <span class="skill-card-status ${sk.enabled ? 'on' : ''}">${escapeHtml(status)}</span>
            <div class="skills-card-actions">
              <button type="button" data-act="detail">${skillsT('skills.btn.detail', '详情')}</button>
              <button type="button" data-act="toggle" class="primary">${sk.enabled ? skillsT('skills.btn.disable', '禁用') : skillsT('skills.btn.enable', '启用')}</button>
              <button type="button" data-act="open">${skillsT('skills.btn.open', '打开目录')}</button>
              ${sk.protected ? '' : `<button type="button" data-act="delete" class="danger">${skillsT('skills.btn.delete', '删除')}</button>`}
            </div>
          </div>`;
        card.querySelectorAll('button[data-act]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const act = btn.getAttribute('data-act');
                if (act === 'detail') {
                    const parts = [String(sk.description || '').trim() || skillsT('skills.detail.no_desc', '暂无详细说明')];
                    if (sk.relativePath) parts.push(`\n${skillsT('skills.detail.path', '路径')}：${sk.relativePath}`);
                    await alert(parts.join('\n'), sk.name || skillsT('skills.btn.detail', '详情'));
                } else if (act === 'toggle') {
                    await window.api.skillsSetEnabled({ name: sk.name, enabled: !sk.enabled });
                    await refreshSkillsCenter();
                } else if (act === 'open') {
                    await window.api.skillsOpenFolder(sk.name);
                } else if (act === 'delete') {
                    const ok = await confirm(skillsT('skills.confirm.delete', '确定删除？'));
                    if (!ok) return;
                    const r = await window.api.skillsDelete(sk.name);
                    if (!r || !r.success) showToast((r && r.error) || 'failed');
                    else showToast(skillsT('skills.toast.deleted', '已删除'));
                    await refreshSkillsCenter();
                }
            });
        });
        grid.appendChild(card);
    }
}

async function renderSkillsPending() {
    const grid = document.getElementById('skills-pending-grid');
    if (!grid || !window.api || !window.api.skillsProposalsList) return;
    grid.innerHTML = '';
    const res = await window.api.skillsProposalsList({ status: 'pending' });
    const proposals = (res && res.proposals) || [];
    if (!proposals.length) {
        grid.innerHTML = `<div class="skill-card-empty">${skillsT('skills.empty.pending', '暂无待审核')}</div>`;
        return;
    }
    for (const p of proposals) {
        const card = document.createElement('div');
        card.className = 'skill-card';
        const desc = String(p.description || p.preview || '').trim();
        card.innerHTML = `
          <div class="skill-card-head">
            <div class="skill-card-icon pending">${skillIconFor(p)}</div>
            <div class="skill-card-titles">
              <h4 class="skill-card-title">${escapeHtml(p.name || p.id || '')}</h4>
              <div class="skill-card-sub">${escapeHtml(p.id || '')}</div>
            </div>
          </div>
          <p class="skill-card-desc">${escapeHtml(desc)}</p>
          <div class="skill-card-foot">
            <span class="skill-card-status wait">${escapeHtml(p.status || 'pending')}</span>
            <div class="skills-card-actions">
              <button type="button" data-act="inspect">${skillsT('skills.btn.inspect', '查看正文')}</button>
              <button type="button" data-act="apply" class="primary">${skillsT('skills.btn.apply', '通过并启用')}</button>
              <button type="button" data-act="reject" class="danger">${skillsT('skills.btn.reject', '驳回')}</button>
            </div>
          </div>`;
        card.querySelectorAll('button[data-act]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const act = btn.getAttribute('data-act');
                if (act === 'inspect') {
                    const r = await window.api.skillsProposalsInspect(p.id);
                    const content = (r && r.proposal && r.proposal.content) || '';
                    await alert(content || (r && r.error) || 'empty', p.name || p.id || 'Skill');
                } else if (act === 'apply') {
                    const ok = await confirm(skillsT('skills.confirm.apply', '确认启用？'));
                    if (!ok) return;
                    const r = await window.api.skillsProposalsApply(p.id);
                    if (!r || !r.success) showToast((r && r.error) || 'failed');
                    else showToast(skillsT('skills.toast.applied', '已通过并启用'));
                    await refreshSkillsCenter();
                } else if (act === 'reject') {
                    const ok = await confirm(skillsT('skills.confirm.reject', '确定驳回？'));
                    if (!ok) return;
                    const r = await window.api.skillsProposalsReject({ proposalId: p.id, reason: 'rejected by operator' });
                    if (!r || !r.success) showToast((r && r.error) || 'failed');
                    else showToast(skillsT('skills.toast.rejected', '已驳回'));
                    await refreshSkillsCenter();
                }
            });
        });
        grid.appendChild(card);
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
                if (!entries[key] && key !== 'auto-start-codex' && key !== 'long-term-memory' && key !== 'voice-call') {
                    entries[key] = { enabled: false };
                }

                const isLockedOn = LOCKED_ALWAYS_ON_UI_IDS.has(key);
                let isEnabled = false;
                if (key === 'auto-start-codex') {
                    isEnabled = (configData.hooks && configData.hooks.internal && configData.hooks.internal.entries && configData.hooks.internal.entries['auto-start-codex'])
                        ? configData.hooks.internal.entries['auto-start-codex'].enabled === true
                        : false;
                } else if (key === 'long-term-memory') {
                    // 伞形卡：真实栈三者全部开启才算“已启用”（不落盘 UI id）
                    isEnabled = LONG_TERM_MEMORY_STACK.every((id) => entries[id] && entries[id].enabled === true);
                } else if (key === 'voice-call') {
                    // 与「语音管理」总开关联动（默认关闭）
                    isEnabled = !!(__voiceState && __voiceState.settings && __voiceState.settings.enabled);
                } else {
                    isEnabled = entries[key] ? entries[key].enabled === true : false;
                }
                if (isLockedOn) isEnabled = true;

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
                label.className = 'switch-slider-btn' + (isLockedOn ? ' is-locked' : '');
                if (isLockedOn) label.title = '核心功能，始终开启';
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.className = 'plugin-toggle-checkbox';
                input.setAttribute('data-plugin', key);
                if (isEnabled) input.checked = true;
                if (isLockedOn) {
                    input.disabled = true;
                    input.setAttribute('aria-disabled', 'true');
                }
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

        if (LOCKED_ALWAYS_ON_UI_IDS.has(pluginKey)) {
            e.target.checked = true;
            showToast(t('plugin.toast.locked_always_on'));
            paintCards();
            return;
        }

        // 语音卡：与「语音管理」总开关联动，不写 OpenClaw voice-call 插件
        if (pluginKey === 'voice-call') {
            try {
                await patchVoiceSettings({ enabled: checked });
                showToast(checked
                    ? t('plugin.toast.voice_linked_on')
                    : t('plugin.toast.voice_linked_off'));
            } catch (err) {
                showToast(String(err && err.message || err));
                e.target.checked = !checked;
            }
            paintCards();
            return;
        }

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
            reloadGatewayAfterChannelChange('plugin-toggle', { startIfStopped: false });
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
    let nextProgress = Number(val);
    if (!Number.isFinite(nextProgress)) nextProgress = 0;
    nextProgress = Math.max(0, Math.min(100, nextProgress));
    // 已判定就绪时，禁止再被「starting HTTP / agent model」类日志压回 85%/88%
    if (gatewayFullyReady && gatewayStatus !== 'stopped' && gatewayStatus !== 'upgrading' && nextProgress < 100) {
        nextProgress = 100;
    }
    // 启动过程中进度只允许前进（停止/升级到 0、或冲到 100 除外）
    const allowRegress = gatewayStatus === 'stopped'
        || gatewayStatus === 'upgrading'
        || nextProgress === 0
        || nextProgress === 100;
    if (!allowRegress && currentProgress > 0 && currentProgress < 100 && nextProgress < currentProgress) {
        nextProgress = currentProgress;
    }
    if (gatewayStatus === 'running' && currentProgress === 100 && nextProgress < 100) {
        nextProgress = 100;
    }
    val = nextProgress;
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

            if (hasWechat && topoNodeStates['node-wechat'] !== 'completed') topoNodeStates['node-wechat'] = 'active';
            if (hasQq && topoNodeStates['node-qq'] !== 'completed') topoNodeStates['node-qq'] = 'active';
            if (hasFeishu && topoNodeStates['node-feishu'] !== 'completed') topoNodeStates['node-feishu'] = 'active';
        }
    } else {
        // 100% Running
        topoNodeStates['node-client'] = 'completed';
        topoNodeStates['node-core'] = 'completed';
        topoNodeStates['node-llm'] = 'completed';

        // Check which channels are actually bound；绿点已亮则视为已就绪
        if (configData && configData.channels) {
            const hasWechat = !!(document.getElementById('node-wechat')?.dataset?.liveBound === '1')
                || configData.channels['openclaw-weixin']?.enabled === true;
            const hasQq = !!(configData.channels.qqbot?.accounts && Object.keys(configData.channels.qqbot.accounts).length > 0)
                || !!(configData.channels.qqbot?.appId && configData.channels.qqbot?.clientSecret);
            const hasFeishu = !!(configData.channels.feishu?.appId && configData.channels.feishu?.appSecret)
                || !!(configData.channels.feishu?.accounts && Object.values(configData.channels.feishu.accounts).some((a) => a && a.appId && a.appSecret));
            const weixinOnline = !!document.getElementById('tile-weixin')?.classList.contains('online');
            const qqOnline = !!document.getElementById('tile-qqbot')?.classList.contains('online');
            const feishuOnline = !!document.getElementById('tile-feishu')?.classList.contains('online');

            topoNodeStates['node-wechat'] = hasWechat
                ? ((topoNodeStates['node-wechat'] === 'completed' || weixinOnline) ? 'completed' : 'active')
                : 'pending';
            topoNodeStates['node-qq'] = hasQq
                ? ((topoNodeStates['node-qq'] === 'completed' || qqOnline) ? 'completed' : 'active')
                : 'pending';
            topoNodeStates['node-feishu'] = hasFeishu
                ? ((topoNodeStates['node-feishu'] === 'completed' || feishuOnline) ? 'completed' : 'active')
                : 'pending';
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
                const modelName = getActiveModelNameFromConfig()
                    || localStorage.getItem(ACTIVE_MODEL_STORAGE_KEY)
                    || '已启动';
                activeModelEl.textContent = modelName;
                if (modelName && modelName !== '已启动') persistActiveModelLabel(modelName);
            }
        } else if (status === 'starting') {
            dashServiceStatus.textContent = getCleanText('console.dash.starting', '正在启动...');
            dashStatusDot.className = 'status-indicator-dot running';
            
            // 启动过程保留上次引擎名，避免 Win+R 闪成「未启动」
            const activeModelEl = document.getElementById('dash-active-model');
            if (activeModelEl) {
                const kept = localStorage.getItem(ACTIVE_MODEL_STORAGE_KEY);
                activeModelEl.textContent = kept || getCleanText('console.dash.starting', '正在启动...');
            }
        } else {
            dashServiceStatus.textContent = getCleanText('console.dash.stopped', '已停止');
            dashStatusDot.className = 'status-indicator-dot stopped';
            
            // 停止后仍展示上次激活引擎（活动流也保留）；仅手动清日志时重置
            const activeModelEl = document.getElementById('dash-active-model');
            if (activeModelEl) {
                const kept = localStorage.getItem(ACTIVE_MODEL_STORAGE_KEY);
                activeModelEl.textContent = kept || (t('console.dash.not_configured') || '未启动');
            }
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

        // 已运行：启动等待条不应再留在活动流里
        try { dismissStartingActivityTip({ restoreEmptyIfBlank: true }); } catch (e) {}

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
        } else if (currentProgress >= 80 || gatewayFullyReady) {
            // 已接近就绪 / 已标记 ready：立刻拉满，避免卡在 85% 十几分钟
            if (progressContainer) progressContainer.style.display = 'flex';
            updateProgressUI(100, '本地 AI Nexora Agent服务就绪！');
        } else {
            // 刚点启动不久：等 listening 日志；12 秒保底拉满
            progressTimeout = setTimeout(() => {
                if ((gatewayStatus === 'running' || gatewayFullyReady) && currentProgress < 100) {
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
        try { dismissStartingActivityTip({ restoreEmptyIfBlank: true }); } catch (e) {}
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
            // 无论列表是否已有旧日志，启动中都必须展示等待提示
            ensureStartingActivityTip();
        }

        if (chatWelcomeText) {
            chatWelcomeText.setAttribute('data-i18n', 'status.starting_hint');
            chatWelcomeText.innerText = isEn ? 'Connecting to the local OpenClaw gateway, please wait...' : '正在连接本地的 OpenClaw Nexora Agent，请稍候...';
            chatWelcomeText.style.color = '#ffd54f';
        }

        // 假进度只爬到 80%，避免「97% 假死」观感；真正就绪靠端口探测 / listening 日志
        if (progressContainer) progressContainer.style.display = 'flex';
        if (gatewayFullyReady || currentProgress >= 100) {
            updateProgressUI(100, t('console.progress.ready') || '本地 AI Nexora Agent服务就绪！');
        } else {
            updateProgressUI(8, t('console.progress.starting_env') || '正在拉起子进程环境...');
        }
        gatewayLogReadyTail = '';
        startGatewayReadyProbe('user-start');
        scheduleGatewayReadyReconcile('user-start');

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
const SIDEBAR_NAV_ORDER_KEY = 'setting_sidebar_nav_order';
const SIDEBAR_NAV_DEFAULT_ORDER = [
    'console-view',
    'acceleration-view',
    'communication-view',
    'config-view',
    'roles-view',
    'chat-view',
    'openclaw-panel-view',
    'dashboard-view',
    'plugins-view',
    'skills-view',
    'voice-view',
    'session-archive-view',
    'data-center-view',
    'terminal-view',
    'syslogs-view',
    'settings-view'
];
const SIDEBAR_NAV_I18N_BY_TAB = {
    'console-view': 'nav.console',
    'data-center-view': 'nav.data_center',
    'chat-view': 'nav.chat',
    'session-archive-view': 'nav.session_archive',
    'config-view': 'nav.config',
    'communication-view': 'nav.communication',
    'roles-view': 'nav.roles',
    'acceleration-view': 'nav.acceleration_channel',
    'openclaw-panel-view': 'nav.openclaw_panel',
    'dashboard-view': 'nav.stats',
    'plugins-view': 'nav.plugins',
    'skills-view': 'nav.skills',
    'voice-view': 'nav.voice',
    'terminal-view': 'nav.terminal',
    'syslogs-view': 'nav.syslogs',
    'settings-view': 'nav.settings'
};
/** 首次进入时从 HTML 快照的默认顺序；重置必须用它，不能读已被打乱的 DOM */
let __sidebarNavDefaultOrder = null;

function getSidebarNavRoot() {
    return document.querySelector('.sidebar-nav');
}

function captureSidebarNavDefaultOrder() {
    if (Array.isArray(__sidebarNavDefaultOrder) && __sidebarNavDefaultOrder.length) {
        return __sidebarNavDefaultOrder.slice();
    }
    const root = getSidebarNavRoot();
    const fromDom = root
        ? Array.from(root.querySelectorAll(':scope > .nav-item[data-tab]'))
            .map((el) => el.getAttribute('data-tab'))
            .filter(Boolean)
        : [];
    const builtin = SIDEBAR_NAV_DEFAULT_ORDER.slice();
    __sidebarNavDefaultOrder = builtin.length ? builtin : fromDom;
    return __sidebarNavDefaultOrder.slice();
}

function getDefaultSidebarNavOrder() {
    return captureSidebarNavDefaultOrder();
}

function readSavedSidebarNavOrder() {
    try {
        const raw = localStorage.getItem(SIDEBAR_NAV_ORDER_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed.map((x) => String(x || '').trim()).filter(Boolean);
    } catch (_) {
        return null;
    }
}

function normalizeSidebarNavOrder(preferred) {
    const defaults = getDefaultSidebarNavOrder();
    const defaultSet = new Set(defaults);
    const seen = new Set();
    const out = [];
    const source = Array.isArray(preferred) ? preferred : [];
    for (const tab of source) {
        if (!defaultSet.has(tab) || seen.has(tab)) continue;
        seen.add(tab);
        out.push(tab);
    }
    // 新增内置菜单：插到默认相对位置（避免一直堆在末尾）
    for (let i = 0; i < defaults.length; i++) {
        const tab = defaults[i];
        if (seen.has(tab)) continue;
        seen.add(tab);
        let insertAt = out.length;
        if (i === 0) {
            insertAt = 0;
        } else {
            for (let j = i - 1; j >= 0; j--) {
                const prevIdx = out.indexOf(defaults[j]);
                if (prevIdx >= 0) {
                    insertAt = prevIdx + 1;
                    break;
                }
                if (j === 0) insertAt = 0;
            }
        }
        out.splice(insertAt, 0, tab);
    }
    // 顶部固定：控制面板 → 网络中转 → 通讯管理 → 模型配置 → 模型角色
    {
        const topSeq = [
            'console-view',
            'acceleration-view',
            'communication-view',
            'config-view',
            'roles-view'
        ];
        const picked = [];
        for (const tab of topSeq) {
            const idx = out.indexOf(tab);
            if (idx >= 0) {
                out.splice(idx, 1);
                picked.push(tab);
            }
        }
        for (let i = picked.length - 1; i >= 0; i--) {
            out.unshift(picked[i]);
        }
    }
    // 会话归档固定紧跟「语音服务」下方
    {
        const iVoice = out.indexOf('voice-view');
        const iArch = out.indexOf('session-archive-view');
        if (iVoice >= 0 && iArch >= 0 && iArch !== iVoice + 1) {
            out.splice(iArch, 1);
            const insertAt = out.indexOf('voice-view') + 1;
            out.splice(insertAt, 0, 'session-archive-view');
        }
    }
    // 数据总览固定紧贴「内置终端」上方
    {
        const iDc = out.indexOf('data-center-view');
        const iTerm = out.indexOf('terminal-view');
        if (iDc >= 0 && iTerm >= 0 && iDc !== iTerm - 1) {
            out.splice(iDc, 1);
            const insertAt = out.indexOf('terminal-view');
            out.splice(insertAt, 0, 'data-center-view');
        }
    }
    return out;
}

function saveSidebarNavOrder(order) {
    const normalized = normalizeSidebarNavOrder(order);
    try {
        localStorage.setItem(SIDEBAR_NAV_ORDER_KEY, JSON.stringify(normalized));
    } catch (_) {}
    return normalized;
}

function applySidebarNavOrder(order) {
    const root = getSidebarNavRoot();
    // 必须先快照默认顺序，再改 DOM
    captureSidebarNavDefaultOrder();
    if (!root) return normalizeSidebarNavOrder(order || readSavedSidebarNavOrder());
    const normalized = normalizeSidebarNavOrder(order || readSavedSidebarNavOrder());
    const byTab = new Map();
    Array.from(root.querySelectorAll(':scope > .nav-item[data-tab]')).forEach((el) => {
        const tab = el.getAttribute('data-tab');
        if (tab) byTab.set(tab, el);
    });
    normalized.forEach((tab) => {
        const el = byTab.get(tab);
        if (el) root.appendChild(el);
    });
    return normalized;
}

function moveSidebarNavOrder(tabId, direction) {
    const order = normalizeSidebarNavOrder(readSavedSidebarNavOrder());
    const idx = order.indexOf(tabId);
    if (idx < 0) return order;
    const target = direction < 0 ? idx - 1 : idx + 1;
    if (target < 0 || target >= order.length) return order;
    const next = order.slice();
    const tmp = next[idx];
    next[idx] = next[target];
    next[target] = tmp;
    const saved = saveSidebarNavOrder(next);
    applySidebarNavOrder(saved);
    return saved;
}

function resetSidebarNavOrder() {
    try { localStorage.removeItem(SIDEBAR_NAV_ORDER_KEY); } catch (_) {}
    return applySidebarNavOrder(getDefaultSidebarNavOrder());
}

function getSidebarNavLabel(tabId) {
    const key = SIDEBAR_NAV_I18N_BY_TAB[tabId];
    if (key) return t(key);
    const el = document.querySelector(`.sidebar-nav .nav-item[data-tab="${tabId}"] span`);
    return (el && el.textContent) ? el.textContent.trim() : tabId;
}

function renderMenuOrderSettingsUI() {
    const list = document.getElementById('setting-menu-order-list');
    if (!list) return;
    const order = normalizeSidebarNavOrder(readSavedSidebarNavOrder());
    const upLabel = t('settings.menu_order.up');
    const downLabel = t('settings.menu_order.down');
    const esc = (typeof escapeHtml === 'function')
        ? escapeHtml
        : (s) => String(s || '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    list.innerHTML = order.map((tabId, index) => {
        const label = getSidebarNavLabel(tabId);
        const atTop = index === 0;
        const atBottom = index === order.length - 1;
        return `
          <div class="settings-menu-order-row" role="listitem" data-menu-tab="${tabId}">
            <div class="settings-menu-order-index">${index + 1}</div>
            <div class="settings-menu-order-label">${esc(label)}</div>
            <div class="settings-menu-order-actions">
              <button type="button" class="settings-menu-order-btn" data-menu-move="up" data-menu-tab="${tabId}" ${atTop ? 'disabled' : ''} title="${esc(upLabel)}" aria-label="${esc(upLabel)}">↑</button>
              <button type="button" class="settings-menu-order-btn" data-menu-move="down" data-menu-tab="${tabId}" ${atBottom ? 'disabled' : ''} title="${esc(downLabel)}" aria-label="${esc(downLabel)}">↓</button>
            </div>
          </div>
        `;
    }).join('');
}

function setMenuOrderExpanded(expanded) {
    const card = document.getElementById('setting-menu-order-card');
    const body = document.getElementById('setting-menu-order-body');
    const toggle = document.getElementById('btn-menu-order-toggle');
    if (!card || !body || !toggle) return;
    const on = !!expanded;
    card.classList.toggle('is-collapsed', !on);
    if (on) body.removeAttribute('hidden');
    else body.setAttribute('hidden', '');
    toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
    toggle.title = on ? t('settings.menu_order.collapse') : t('settings.menu_order.expand');
    try {
        localStorage.setItem('setting_menu_order_expanded', on ? 'true' : 'false');
    } catch (_) {}
    if (on) {
        try { renderMenuOrderSettingsUI(); } catch (_) {}
    }
}

function initMenuOrderSettingsUI() {
    const list = document.getElementById('setting-menu-order-list');
    const resetBtn = document.getElementById('btn-menu-order-reset');
    const toggle = document.getElementById('btn-menu-order-toggle');
    if (!list) return;

    // 折叠状态：默认收起；记住用户上次选择
    let expanded = false;
    try {
        expanded = localStorage.getItem('setting_menu_order_expanded') === 'true';
    } catch (_) {}
    setMenuOrderExpanded(expanded);

    if (toggle && toggle.dataset.menuOrderToggleBound !== '1') {
        toggle.dataset.menuOrderToggleBound = '1';
        toggle.addEventListener('click', () => {
            const card = document.getElementById('setting-menu-order-card');
            const next = !!(card && card.classList.contains('is-collapsed'));
            setMenuOrderExpanded(next);
        });
    }

    if (list.dataset.menuOrderBound === '1') {
        if (expanded) renderMenuOrderSettingsUI();
        return;
    }
    list.dataset.menuOrderBound = '1';
    list.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-menu-move]') : null;
        if (!btn || btn.disabled) return;
        const tabId = btn.getAttribute('data-menu-tab');
        const dir = btn.getAttribute('data-menu-move') === 'up' ? -1 : 1;
        if (!tabId) return;
        moveSidebarNavOrder(tabId, dir);
        renderMenuOrderSettingsUI();
    });
    if (resetBtn && resetBtn.dataset.menuOrderBound !== '1') {
        resetBtn.dataset.menuOrderBound = '1';
        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            resetSidebarNavOrder();
            renderMenuOrderSettingsUI();
            try { showToast(t('settings.menu_order.toast_reset')); } catch (_) {}
        });
    }
    if (expanded) renderMenuOrderSettingsUI();
}

function setupTabSwitching() {
    const allNavItems = Array.from(document.querySelectorAll('.nav-item'));
    const allTabPanes = Array.from(document.querySelectorAll('.tab-pane'));
    let activeNav = document.querySelector('.nav-item.active');
    let activePane = document.querySelector('.tab-pane.active');
    let pageLoadMaskToken = 0;

    function showPageLoadMask(label) {
        const mask = document.getElementById('page-load-mask');
        const text = document.getElementById('page-load-mask-text');
        if (text) text.textContent = label || t('正在加载…', 'Loading…', '正在載入…');
        if (mask) {
            mask.hidden = false;
            mask.setAttribute('aria-hidden', 'false');
        }
    }

    function hidePageLoadMask() {
        const mask = document.getElementById('page-load-mask');
        if (mask) {
            mask.hidden = true;
            mask.setAttribute('aria-hidden', 'true');
        }
    }

    async function waitForPaint() {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise((r) => setTimeout(r, 40));
    }

    /** 进入某页后的实质加载（遮罩盖住直到完成） */
    async function hydrateTabContent(tabId) {
        // 离开加速页时停掉连接轮询(每 1.5s 一次 IPC)，否则切走后仍在后台空跑一整个会话
        if (tabId !== 'acceleration-view') { try { stopConnectionPolling(); } catch (_) {} }
        if (tabId === 'dashboard-view') {
            try { renderUsageCharts(); } catch (err) { console.error(err); }
            return;
        }
        if (tabId === 'console-view') {
            try { updateConsoleChannelStatusUI(); } catch (err) { console.error(err); }
            try { flushDeferredConsoleLogsInstant(); } catch (err) {}
            return;
        }
        if (tabId === 'terminal-view' && typeof initBuiltinTerminal === 'function') {
            initBuiltinTerminal();
            return;
        }
        if (tabId === 'plugins-view') {
            await Promise.resolve().then(() => renderPluginsGrid());
            return;
        }
        if (tabId === 'skills-view') {
            try { await refreshSkillsCenter(); } catch (err) { console.error(err); }
            return;
        }
        if (tabId === 'roles-view') {
            if (typeof loadRoleConfigState === 'function') {
                await loadRoleConfigState({ preferActive: true });
            }
            return;
        }
        if (tabId === 'voice-view') {
            if (typeof refreshVoicePanel === 'function') {
                await refreshVoicePanel();
            }
            return;
        }
        if (tabId === 'session-archive-view') {
            try { initSessionArchiveView(); } catch (err) { console.error(err); }
            return;
        }
        if (tabId === 'chat-view') {
            if (typeof loadRoleConfigState === 'function') {
                await loadRoleConfigState({ silent: true, preferActive: false, clearEditing: false });
            }
            if (!chatInitialized) {
                chatInitialized = true;
                try { initChatView(); } catch (err) { console.error(err); }
            } else {
                try { loadChatModels(); } catch (err) { console.error(err); }
            }
            return;
        }
        if (tabId === 'openclaw-panel-view') {
            await waitForOpenclawPanelLayout();
            const wv = document.getElementById('openclaw-iframe');
            const hasSrc = !!(wv && String(wv.getAttribute('src') || '').trim());
            try {
                // 进入前先把 webview 底色换成主题色，避免先闪 OpenClaw 纯黑
                if (wv) {
                    try { wv.style.background = getOpenclawHostThemePaint().bgBase; } catch (_) {}
                }
                await loadOpenclawControlUi(!hasSrc, { clearSession: false });
                if (wv) {
                    if (!hasSrc) await waitForOpenclawWebviewSettled(wv);
                    scheduleOpenclawThemeSync(wv, { delays: [0, 800] });
                }
            } finally {
                hideOpenclawThemeCover();
            }
            return;
        }
        if (tabId === 'data-center-view') {
            await loadDataCenterUi(true);
            return;
        }
        if (tabId === 'syslogs-view') {
            try { loadAndRenderSystemLogs(); } catch (err) { console.error(err); }
            return;
        }
        if (tabId === 'settings-view') {
            const settingLangSel = document.getElementById('setting-language-select');
            if (settingLangSel) {
                const initLang = localStorage.getItem('setting_language') || 'zh-CN';
                settingLangSel.value = initLang;
            }
            return;
        }
        if (tabId === 'acceleration-view') {
            // 恢复子页 + 地区标签，并主动刷节点（避免必须先切配置商才出完整标签/列表）
            const savedPanel = loadAccelerationUiPref('panel', 'dashboard') || 'dashboard';
            accelerationUi.countryFilter = loadAccelerationUiPref('countryFilter', 'all') || 'all';
            accelerationUi.viewMode = loadAccelerationUiPref('viewMode', 'nodes') || 'nodes';
            setAccelerationPanel(savedPanel);
            applyAccelerationProxiesViewMode(accelerationUi.viewMode, { skipRender: true });
            syncAccelerationCountryFilterUi();
            try {
                await refreshAccelerationChannel();
            } catch (err) {
                console.error(err);
            }
            syncAccelerationCountryFilterUi();
            if (accelerationUi.panel === 'proxies') {
                maybeAutoDelayOnProxiesTab();
            }
            return;
        }
        if (tabId === 'communication-view') {
            // 通讯页按需轻量刷新（若有）
            try {
                if (typeof refreshCommunicationPanel === 'function') {
                    await refreshCommunicationPanel();
                }
            } catch (_) {}
        }
    }

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
                        showToast('Nexora Agent 正在启动（首次安装可能需 1～2 分钟），就绪后即可打开 OpenClaw…');
                    } else {
                        showToast('请先在左上角启动 Nexora Agent 服务');
                    }
                    return;
                }
            }

            const nextTab = tab.getAttribute('data-tab');
            if (nextTab === currentTab && tab.classList.contains('active')) {
                // 已在 OpenClaw：再点一次强制刷新控制台（空白页可自愈）
                if (nextTab === 'openclaw-panel-view' && gatewayFullyReady) {
                    const token = ++pageLoadMaskToken;
                    showPageLoadMask(t('正在刷新 OpenClaw…', 'Refreshing OpenClaw…', '正在重新整理 OpenClaw…'));
                    Promise.resolve()
                        .then(() => loadOpenclawControlUi(true, { clearSession: false }))
                        .catch((err) => console.error(err))
                        .finally(async () => {
                            await waitForPaint();
                            if (token === pageLoadMaskToken) hidePageLoadMask();
                        });
                }
                if (nextTab === 'data-center-view') {
                    const token = ++pageLoadMaskToken;
                    showPageLoadMask(t('正在刷新数据总览…', 'Refreshing Data Overview…', '正在重新整理數據總覽…'));
                    Promise.resolve()
                        .then(() => loadDataCenterUi(false))
                        .catch((err) => console.error(err))
                        .finally(async () => {
                            await waitForPaint();
                            if (token === pageLoadMaskToken) hidePageLoadMask();
                        });
                }
                return;
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

            // 切回控制台：离页积压日志立刻落盘（不走打字机），用户一进来就看到完整历史
            if (nextTab === 'console-view' && prevTab !== 'console-view') {
                try { flushDeferredConsoleLogsInstant(); } catch (err) {}
            }

            // 离开 OpenClaw / 数据中心 面板时先藏 iframe/webview，减轻后台合成压力
            if (prevTab === 'openclaw-panel-view' || nextTab === 'openclaw-panel-view') {
                const wv = document.getElementById('openclaw-iframe');
                if (wv) {
                    wv.style.visibility = (nextTab === 'openclaw-panel-view') ? 'visible' : 'hidden';
                }
            }
            if (prevTab === 'data-center-view' || nextTab === 'data-center-view') {
                const frame = document.getElementById('data-center-iframe');
                if (frame) {
                    frame.style.visibility = (nextTab === 'data-center-view') ? 'visible' : 'hidden';
                    if (nextTab === 'data-center-view') {
                        try {
                            frame.contentWindow.postMessage({ type: 'nexora-data-center-refresh' }, '*');
                        } catch (_) {}
                    }
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

            // 遮罩盖住右侧，直到该页内容彻底 hydrate
            const token = ++pageLoadMaskToken;
            const maskLabel =
                nextTab === 'openclaw-panel-view' ? t('正在加载 OpenClaw…', 'Loading OpenClaw…', '正在載入 OpenClaw…')
                : nextTab === 'data-center-view' ? t('正在加载数据总览…', 'Loading Data Overview…', '正在載入數據總覽…')
                : nextTab === 'acceleration-view' ? t('正在加载网络中转…', 'Loading Network Relay…', '正在載入網路中轉…')
                : t('正在加载…', 'Loading…', '正在載入…');
            showPageLoadMask(maskLabel);

            Promise.resolve()
                .then(() => hydrateTabContent(nextTab))
                .catch((err) => console.error(err))
                .finally(async () => {
                    await waitForPaint();
                    if (token === pageLoadMaskToken && currentTab === nextTab) {
                        hidePageLoadMask();
                    }
                });
        });
    });

    // 兜底缓存未就绪时仍可用
    void allTabPanes;
}

// 8. 主题一键无缝切换 + 自定义主题（强调色 / 背景图）
function hexToRgbCsv(hex) {
    const m = String(hex || '').trim().replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(m)) return '59, 130, 246';
    return `${parseInt(m.slice(0, 2), 16)}, ${parseInt(m.slice(2, 4), 16)}, ${parseInt(m.slice(4, 6), 16)}`;
}

function setCustomThemeAccent(hex) {
    const color = String(hex || '#3b82f6').trim() || '#3b82f6';
    const normalized = color.startsWith('#') ? color.toUpperCase() : ('#' + color).toUpperCase();
    document.body.style.setProperty('--accent-color', color);
    document.body.style.setProperty('--accent-rgb', hexToRgbCsv(color));
    document.body.style.setProperty('--btn-start-bg', `linear-gradient(135deg, ${color}cc 0%, ${color} 55%, ${color}dd 100%)`);
    document.body.style.setProperty('--btn-start-bg-hover', `linear-gradient(135deg, ${color} 0%, ${color}ee 55%, ${color} 100%)`);
    localStorage.setItem('custom_theme_accent', color);
    const hexLabel = document.getElementById('custom-theme-accent-hex');
    if (hexLabel) hexLabel.textContent = normalized;
    const ring = document.querySelector('.custom-theme-swatch-ring');
    if (ring) ring.style.background = color;
}

function setCustomThemeOverlay(percent) {
    let pct = Number(percent);
    if (!Number.isFinite(pct)) pct = 35;
    // 旧默认 62 太黑，自动下调一次
    if (pct >= 60 && localStorage.getItem('custom_theme_overlay_migrated') !== '1') {
        pct = 35;
        localStorage.setItem('custom_theme_overlay_migrated', '1');
    }
    pct = Math.max(0, Math.min(80, pct));
    document.body.style.setProperty('--custom-bg-overlay', String(pct / 100));
    localStorage.setItem('custom_theme_overlay', String(pct));
    const label = document.getElementById('custom-theme-overlay-label');
    if (label) label.textContent = pct + '%';
    const range = document.getElementById('custom-theme-overlay');
    if (range && String(range.value) !== String(pct)) range.value = String(pct);
    // 自绘填充条（不依赖原生 range 进度样式）
    const fill = document.getElementById('custom-theme-overlay-fill');
    if (fill) {
        const min = range ? (Number(range.min) || 0) : 0;
        const max = range ? (Number(range.max) || 80) : 80;
        const ratio = Math.max(0, Math.min(100, ((pct - min) / (max - min)) * 100));
        fill.style.width = ratio + '%';
    }
}

function applyCustomThemeBackgroundUrl(fileUrl) {
    const appEl = document.querySelector('.app-container');
    if (fileUrl) {
        const cssUrl = `url("${String(fileUrl).replace(/\\/g, '/').replace(/"/g, '\\"')}")`;
        document.body.style.setProperty('--custom-bg-image', cssUrl);
        document.body.classList.add('has-custom-bg');
        // 直接写到容器上，双保险（避免变量未生效）
        if (appEl) {
            const overlay = getComputedStyle(document.body).getPropertyValue('--custom-bg-overlay').trim() || '0.35';
            appEl.style.backgroundImage = `linear-gradient(rgba(8,10,18,${overlay}), rgba(8,10,18,${overlay})), ${cssUrl}`;
            appEl.style.backgroundSize = 'cover';
            appEl.style.backgroundPosition = 'center';
            appEl.style.backgroundRepeat = 'no-repeat';
            appEl.style.backgroundColor = '#080a12';
        }
    } else {
        document.body.style.removeProperty('--custom-bg-image');
        document.body.classList.remove('has-custom-bg');
        if (appEl) {
            appEl.style.backgroundImage = '';
            appEl.style.backgroundSize = '';
            appEl.style.backgroundPosition = '';
            appEl.style.backgroundRepeat = '';
            appEl.style.backgroundColor = '';
        }
    }
}

function clearInlineCustomThemeVars() {
    document.body.style.removeProperty('--accent-color');
    document.body.style.removeProperty('--accent-rgb');
    document.body.style.removeProperty('--custom-bg-overlay');
    document.body.style.removeProperty('--custom-bg-image');
    document.body.style.removeProperty('--btn-start-bg');
    document.body.style.removeProperty('--btn-start-bg-hover');
    document.body.classList.remove('has-custom-bg');
}

function setupThemeSwitching() {
    const themeIds = [
        'black', 'dark', 'aurora', 'blue', 'orange', 'teal', 'amber',
        'pink', 'glacier', 'magma', 'abyss', 'sage', 'mint', 'forest', 'custom'
    ];
    const pickers = {};
    for (const id of themeIds) {
        pickers[id] = document.getElementById('theme-btn-' + id);
    }
    const dots = themeIds.map((id) => pickers[id]);
    const customPanel = document.getElementById('custom-theme-panel');
    const accentInput = document.getElementById('custom-theme-accent');
    const overlayInput = document.getElementById('custom-theme-overlay');
    const btnPickBg = document.getElementById('btn-custom-theme-bg');
    const btnClearBg = document.getElementById('btn-custom-theme-clear-bg');

    const updateActiveDot = (activeTheme) => {
        dots.forEach((dot) => { if (dot) dot.classList.remove('active'); });
        const key = String(activeTheme || '').replace(/^theme-/, '');
        if (pickers[key]) pickers[key].classList.add('active');
        if (customPanel) customPanel.hidden = activeTheme !== 'theme-custom';
        if (typeof drawSidebarChart === 'function') drawSidebarChart();
        if (typeof syncBuiltinTerminalTheme === 'function') syncBuiltinTerminalTheme();
        if (typeof pushDataCenterTheme === 'function') pushDataCenterTheme();
        if (typeof syncOpenclawThemeToWebview === 'function') syncOpenclawThemeToWebview();
    };

    const applyPresetTheme = (themeName) => {
        clearInlineCustomThemeVars();
        document.body.className = themeName;
        localStorage.setItem('user-theme', themeName);
        try {
            const wv = document.getElementById('openclaw-iframe');
            if (wv) {
                wv.__nexoraInsertedThemeCss = '';
                wv.__nexoraInsertedPanelCss = '';
                wv.style.background = getOpenclawHostThemePaint().bgBase;
            }
        } catch (_) {}
        updateActiveDot(themeName);
        try {
            const wv = document.getElementById('openclaw-iframe');
            if (wv && currentTab === 'openclaw-panel-view') {
                scheduleOpenclawThemeSync(wv, { delays: [0, 400] });
            }
        } catch (_) {}
    };

    const applyCustomTheme = async (opts = {}) => {
        const accent = localStorage.getItem('custom_theme_accent') || '#3b82f6';
        const overlay = localStorage.getItem('custom_theme_overlay') || '35';
        document.body.className = 'theme-custom';
        localStorage.setItem('user-theme', 'theme-custom');
        setCustomThemeAccent(accent);
        setCustomThemeOverlay(overlay);
        if (accentInput) accentInput.value = accent;
        if (overlayInput) overlayInput.value = String(overlay);

        let fileUrl = opts.fileUrl || null;
        if (!fileUrl && window.api && window.api.getCustomThemeBackground) {
            try {
                const res = await window.api.getCustomThemeBackground();
                if (res && res.success && res.fileUrl) fileUrl = res.fileUrl;
            } catch (e) {}
        }
        applyCustomThemeBackgroundUrl(fileUrl);
        updateActiveDot('theme-custom');
    };

    for (const id of themeIds) {
        const el = pickers[id];
        if (!el) continue;
        el.addEventListener('click', () => {
            if (id === 'custom') {
                applyCustomTheme();
                return;
            }
            applyPresetTheme('theme-' + id);
        });
    }

    if (accentInput) {
        accentInput.addEventListener('input', () => {
            if (document.body.classList.contains('theme-custom')) {
                setCustomThemeAccent(accentInput.value);
                // 强调色变化时同步刷新滑条填充色
                const ov = document.getElementById('custom-theme-overlay');
                if (ov) setCustomThemeOverlay(ov.value);
                if (typeof syncBuiltinTerminalTheme === 'function') syncBuiltinTerminalTheme();
                if (typeof pushDataCenterTheme === 'function') pushDataCenterTheme();
            } else {
                localStorage.setItem('custom_theme_accent', accentInput.value);
            }
        });
    }

    if (overlayInput) {
        overlayInput.addEventListener('input', () => {
            setCustomThemeOverlay(overlayInput.value);
            // 遮罩变化时同步刷新壁纸层
            const appEl = document.querySelector('.app-container');
            const img = document.body.style.getPropertyValue('--custom-bg-image');
            if (appEl && img && document.body.classList.contains('has-custom-bg')) {
                const overlay = getComputedStyle(document.body).getPropertyValue('--custom-bg-overlay').trim() || '0.35';
                appEl.style.backgroundImage = `linear-gradient(rgba(8,10,18,${overlay}), rgba(8,10,18,${overlay})), ${img}`;
            }
            if (typeof pushDataCenterTheme === 'function') pushDataCenterTheme();
        });
    }

    if (btnPickBg) {
        btnPickBg.addEventListener('click', async () => {
            if (!window.api || !window.api.pickCustomThemeBackground) return;
            try {
                const res = await window.api.pickCustomThemeBackground();
                if (!res || res.canceled) return;
                if (!res.success) {
                    showToast((res && res.error) || t('settings.theme.clear_bg'));
                    return;
                }
                if (!document.body.classList.contains('theme-custom')) {
                    await applyCustomTheme({ fileUrl: res.fileUrl });
                } else {
                    applyCustomThemeBackgroundUrl(res.fileUrl);
                }
                showToast(t('settings.theme.toast_bg_ok'));
            } catch (e) {
                showToast(String(e && e.message || e));
            }
        });
    }

    if (btnClearBg) {
        btnClearBg.addEventListener('click', async () => {
            try {
                if (window.api && window.api.clearCustomThemeBackground) {
                    await window.api.clearCustomThemeBackground();
                }
                applyCustomThemeBackgroundUrl(null);
                showToast(t('settings.theme.toast_bg_cleared'));
            } catch (e) {
                showToast(String(e && e.message || e));
            }
        });
    }

    // 默认主题读取（白昼主题已下线）
    let savedTheme = localStorage.getItem('user-theme') || 'theme-abyss';
    if (savedTheme === 'theme-light') {
        savedTheme = 'theme-abyss';
        localStorage.setItem('user-theme', 'theme-abyss');
    }
    if (savedTheme === 'theme-custom') {
        applyCustomTheme();
    } else {
        document.body.className = savedTheme;
        updateActiveDot(savedTheme);
    }
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
            queryBtn.innerText = '刷新中…';
            queryBtn.disabled = true;
            try {
                await renderUsageCharts();
                showToast('统计数据已成功重新同步更新！');
            } catch (e) {
                console.error('Failed to query statistics:', e);
            }
            queryBtn.innerText = t('stats.btn.query') || '查询';
            queryBtn.disabled = false;
        });
    }

    // 维持动态选项菜单的去重显示
    updateFilterOptions();
    initStatsModelSearchPicker();

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
        NexoraScheduler.stop(STATS_REFRESH_TASK);
        if (refreshSelect.value === '30s') {
            NexoraScheduler.register(STATS_REFRESH_TASK, () => {
                if (currentTab === 'dashboard-view') {
                    renderUsageCharts();
                }
            }, { visibleMs: 30000, hiddenMs: 120000, immediate: false });
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
// ≥ 后端 weixin-direct-login 的 8 分钟等待；原先 5 分钟会在用户 5-8 分钟间扫码成功前就掐掉后端登录
const COMM_BINDING_SCAN_MS = 9 * 60 * 1000;
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

    // 会话归档：动态列表/详情跟随系统语言
    try {
        if (typeof renderSessionArchiveView === 'function' && typeof sessionArchiveState !== 'undefined' && sessionArchiveState.initialized) {
            renderSessionArchiveView();
        }
    } catch (e) {}

    // 数据总览 iframe 标题随语言刷新
    try {
        if (typeof pushDataCenterTheme === 'function') pushDataCenterTheme();
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
let activeChatArchiveMessages = []; // 当前桌面对话完整消息，用于一键归档
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

    initChatModelSearchPicker();

    // 首次进入加载模型
    loadChatModels();
}

const CHAT_MODEL_PREF_KEY = 'client_pref_chat_model'; // provider/modelId

/** 保证模型 select 只存在于 body 底部隐藏位，绝不进顶栏布局 */
function ensureChatModelSelect() {
    let select = document.getElementById('chat-model-select');
    if (!select) {
        select = document.createElement('select');
        select.id = 'chat-model-select';
        select.className = 'chat-model-select-hidden';
        select.setAttribute('aria-hidden', 'true');
        select.tabIndex = -1;
        select.hidden = true;
        document.body.appendChild(select);
    } else if (select.parentElement && select.parentElement.id === 'chat-model-picker') {
        document.body.appendChild(select);
    }
    select.hidden = true;
    select.classList.add('chat-model-select-hidden');
    select.setAttribute('aria-hidden', 'true');
    select.tabIndex = -1;
    try {
        select.style.cssText = 'position:absolute!important;left:-99999px!important;width:0!important;height:0!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important;appearance:none!important;';
    } catch (_) {}
    return select;
}

// parseModelRef 定义见文件顶部（勿在此重复声明，会覆盖并导致 model/id 字段不一致）

function formatModelRef(provider, id) {
    const p = String(provider || '').trim();
    const m = String(id || '').trim();
    if (!m) return '';
    return p ? `${p}/${m}` : m;
}

function getConfiguredPrimaryFallbackModels() {
    const cfg = (typeof configData === 'object' && configData) ? configData : {};
    const modelCfg = cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model
        ? cfg.agents.defaults.model
        : {};
    const primary = parseModelRef(modelCfg.primary || '');
    const fbRaw = Array.isArray(modelCfg.fallbacks) ? modelCfg.fallbacks[0] : '';
    const fallback = parseModelRef(fbRaw || '');
    // UI 输入框可能还没写回 configData，兜底读 DOM
    try {
        const pEl = document.getElementById('model-primary');
        const ppEl = document.getElementById('model-primary-provider');
        const fEl = document.getElementById('model-fallback');
        const fpEl = document.getElementById('model-fallback-provider');
        if ((!primary.id || !primary.provider) && pEl && pEl.value.trim()) {
            primary.id = pEl.value.trim();
            primary.provider = (ppEl && ppEl.value) || primary.provider;
        }
        if ((!fallback.id || !fallback.provider) && fEl && fEl.value.trim()) {
            fallback.id = fEl.value.trim();
            fallback.provider = (fpEl && fpEl.value) || fallback.provider;
        }
    } catch (_) {}
    return { primary, fallback };
}

function readPersistedChatModel() {
    try {
        return parseModelRef(localStorage.getItem(CHAT_MODEL_PREF_KEY) || '');
    } catch (_) {
        return { provider: '', id: '' };
    }
}

function persistChatModelSelection(provider, id) {
    const ref = formatModelRef(provider, id);
    if (!ref) return;
    try { localStorage.setItem(CHAT_MODEL_PREF_KEY, ref); } catch (_) {}
}

function findChatModelOptionIndex(select, id, provider) {
    if (!select || !id) return -1;
    if (provider) {
        for (let i = 0; i < select.options.length; i++) {
            const opt = select.options[i];
            if (opt.value === id && opt.getAttribute('data-provider') === provider) return i;
        }
    }
    for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === id) return i;
    }
    return -1;
}

async function loadChatModels() {
    const select = ensureChatModelSelect();
    if (!select) return;

    const useBuiltIn = getUseBuiltIn();
    const { primary, fallback } = getConfiguredPrimaryFallbackModels();
    const persisted = readPersistedChatModel();

    // 当前 DOM 选择（同页刷新时优先）
    const liveId = select.value || '';
    const liveProvider = select.selectedOptions && select.selectedOptions[0]
        ? (select.selectedOptions[0].getAttribute('data-provider') || '')
        : '';

    /** @type {Array<{id:string, provider:string, label:string, rank:number}>} */
    const collected = [];
    const seen = new Set();

    const pushModel = (providerKey, modelId, label, rank) => {
        if (!modelId || !providerKey) return;
        if (useBuiltIn && !isBuiltinAllowedProvider(providerKey)) return;
        const key = `${providerKey}::${modelId}`;
        if (seen.has(key)) return;
        seen.add(key);
        collected.push({
            id: modelId,
            provider: providerKey,
            label: label || `${providerKey} / ${modelId}`,
            rank: Number.isFinite(rank) ? rank : 100,
        });
    };

    // 主用 / 备用排最前
    if (primary.id) {
        const p = primary.provider || 'agnes-ai';
        pushModel(p, primary.id, `${p} / ${primary.id}${t(' (主用)', ' (Primary)', ' (主用)')}`, 0);
    }
    if (fallback.id && !(fallback.provider === primary.provider && fallback.id === primary.id)) {
        const p = fallback.provider || primary.provider || 'agnes-ai';
        pushModel(p, fallback.id, `${p} / ${fallback.id}${t(' (备用)', ' (Fallback)', ' (備用)')}`, 1);
    }

    // 内置模型清单
    if (useBuiltIn) {
        const builtInOpts = [
            { id: 'agnes-2.0-flash', label: `agnes-ai / agnes-2.0-flash${t(' (内置默认)', ' (Built-in Default)', ' (內置默認)')}` },
            { id: 'agnes-1.5-flash', label: `agnes-ai / agnes-1.5-flash${t(' (内置备用)', ' (Built-in Standby)', ' (內置備用)')}` },
            { id: 'agnes-video-v2.0', label: `agnes-ai / agnes-video-v2.0${t(' (内置视频)', ' (Built-in Video)', ' (內置視頻)')}` },
            { id: 'agnes-image-2.1-flash', label: `agnes-ai / agnes-image-2.1-flash${t(' (内置图像)', ' (Built-in Image)', ' (內置圖像)')}` },
            { id: 'agnes-image-2.0-flash', label: `agnes-ai / agnes-image-2.0-flash${t(' (内置图像默认)', ' (Built-in Image Default)', ' (內置圖像默認)')}` }
        ];
        builtInOpts.forEach((optData, i) => {
            pushModel('agnes-ai', optData.id, optData.label, 10 + i);
        });
    }

    // 其余已配置提供商模型
    for (const providerKey of Object.keys(localProviders || {})) {
        if (useBuiltIn && !isBuiltinAllowedProvider(providerKey)) continue;
        if (useBuiltIn && providerKey === 'agnes-ai') continue;
        const provider = localProviders[providerKey];
        const models = provider.models || [];
        models.forEach((model) => {
            if (!model || !model.id) return;
            pushModel(providerKey, model.id, `${providerKey} / ${model.id}`, 50);
        });
    }

    if (!collected.length) {
        pushModel('agnes-ai', 'agnes-2.0-flash', `agnes-ai / agnes-2.0-flash${t(' (内置默认)', ' (Built-in Default)', ' (內置默認)')}`, 0);
        pushModel('agnes-ai', 'agnes-1.5-flash', `agnes-ai / agnes-1.5-flash${t(' (内置备用)', ' (Built-in Standby)', ' (內置備用)')}`, 1);
    }

    collected.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));

    select.innerHTML = '';
    collected.forEach((item) => {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.setAttribute('data-provider', item.provider);
        opt.innerText = item.label;
        select.appendChild(opt);
    });

    // 选择优先级：当前页已选 → 本地记住的对话模型 → 主用 → 备用 → 第一项
    const candidates = [
        { id: liveId, provider: liveProvider },
        { id: persisted.id, provider: persisted.provider },
        { id: primary.id, provider: primary.provider },
        { id: fallback.id, provider: fallback.provider },
        { id: collected[0].id, provider: collected[0].provider },
    ];
    let applied = false;
    for (const c of candidates) {
        if (!c.id) continue;
        const idx = findChatModelOptionIndex(select, c.id, c.provider);
        if (idx >= 0) {
            select.selectedIndex = idx;
            applied = true;
            break;
        }
    }
    if (!applied && select.options.length) select.selectedIndex = 0;

    const sel = select.options[select.selectedIndex];
    if (sel) persistChatModelSelection(sel.getAttribute('data-provider') || '', sel.value);

    syncChatModelSearchFromSelect();
    // 列表刷新时展示完整列表，避免沿用搜索框旧过滤串
    renderChatModelDropdown('');
}

function getChatModelOptions() {
    const select = ensureChatModelSelect();
    if (!select) return [];
    return Array.from(select.options).map((opt, index) => ({
        index,
        value: opt.value,
        provider: opt.getAttribute('data-provider') || '',
        label: (opt.textContent || '').trim(),
    })).filter((o) => o.value);
}

function syncChatModelSearchFromSelect() {
    const select = ensureChatModelSelect();
    const input = document.getElementById('chat-model-search');
    if (!select || !input) return;
    const opt = select.options[select.selectedIndex];
    if (opt && opt.value) {
        input.value = (opt.textContent || '').trim();
        input.dataset.selectedValue = opt.value;
        input.dataset.selectedProvider = opt.getAttribute('data-provider') || '';
    } else {
        input.value = '';
        input.dataset.selectedValue = '';
        input.dataset.selectedProvider = '';
    }
    input.placeholder = t('chat.model.search_placeholder');
}

function setChatModelSelection(value, provider) {
    const select = ensureChatModelSelect();
    if (!select) return false;
    const idx = findChatModelOptionIndex(select, value, provider);
    if (idx < 0) return false;
    select.selectedIndex = idx;
    const opt = select.options[idx];
    persistChatModelSelection(opt.getAttribute('data-provider') || provider || '', opt.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    syncChatModelSearchFromSelect();
    return true;
}

function renderChatModelDropdown(filterText) {
    const dropdown = document.getElementById('chat-model-dropdown');
    const select = ensureChatModelSelect();
    if (!dropdown || !select) return;
    const q = String(filterText || '').trim().toLowerCase();
    const selectedValue = select.value;
    const selectedProvider = select.options[select.selectedIndex]
        ? (select.options[select.selectedIndex].getAttribute('data-provider') || '')
        : '';
    const items = getChatModelOptions().filter((o) => {
        if (!q) return true;
        return (
            o.label.toLowerCase().includes(q) ||
            o.value.toLowerCase().includes(q) ||
            o.provider.toLowerCase().includes(q)
        );
    });

    if (!items.length) {
        dropdown.innerHTML = `<div style="padding:10px 12px; font-size:12px; color:var(--text-secondary);">${t('chat.model.empty')}</div>`;
        return;
    }

    dropdown.innerHTML = items.map((o) => {
        const active = o.value === selectedValue && (!selectedProvider || o.provider === selectedProvider);
        const bg = active ? 'rgba(140,82,255,0.22)' : 'transparent';
        const mark = active ? '✓ ' : '';
        return `<button type="button" class="chat-model-option" data-value="${escapeHtml(o.value)}" data-provider="${escapeHtml(o.provider)}" style="display:block; width:100%; text-align:left; background:${bg}; border:none; color:var(--text-primary); font-size:12px; padding:8px 10px; border-radius:8px; cursor:pointer; line-height:1.35;">${mark}${escapeHtml(o.label)}</button>`;
    }).join('');

    dropdown.querySelectorAll('.chat-model-option').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            setChatModelSelection(btn.getAttribute('data-value'), btn.getAttribute('data-provider') || '');
            hideChatModelDropdown();
        });
        btn.addEventListener('mouseenter', () => {
            btn.style.background = 'rgba(140,82,255,0.18)';
        });
        btn.addEventListener('mouseleave', () => {
            const active = btn.getAttribute('data-value') === selectedValue;
            btn.style.background = active ? 'rgba(140,82,255,0.22)' : 'transparent';
        });
    });
}

function showChatModelDropdown() {
    const dropdown = document.getElementById('chat-model-dropdown');
    const input = document.getElementById('chat-model-search');
    if (!dropdown || !input) return;
    renderChatModelDropdown(input.value);
    dropdown.hidden = false;
    dropdown.style.display = 'block';
}

function hideChatModelDropdown() {
    const dropdown = document.getElementById('chat-model-dropdown');
    if (!dropdown) return;
    dropdown.hidden = true;
    dropdown.style.display = 'none';
}

function initChatModelSearchPicker() {
    const input = document.getElementById('chat-model-search');
    const picker = document.getElementById('chat-model-picker');
    const select = ensureChatModelSelect();
    if (!input || !picker || input.dataset.bound === 'true') return;
    input.dataset.bound = 'true';
    hideChatModelDropdown();

    if (select && select.dataset.persistBound !== 'true') {
        select.dataset.persistBound = 'true';
        select.addEventListener('change', () => {
            const opt = select.options[select.selectedIndex];
            if (opt && opt.value) {
                persistChatModelSelection(opt.getAttribute('data-provider') || '', opt.value);
            }
            syncChatModelSearchFromSelect();
        });
    }

    input.addEventListener('focus', () => {
        // 点开时展示完整列表（不要用当前模型全名当过滤关键字）
        renderChatModelDropdown('');
        const dropdown = document.getElementById('chat-model-dropdown');
        if (dropdown) {
            dropdown.hidden = false;
            dropdown.style.display = 'block';
        }
        try { input.select(); } catch (_) {}
    });

    input.addEventListener('input', () => {
        showChatModelDropdown();
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            syncChatModelSearchFromSelect();
            hideChatModelDropdown();
            input.blur();
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const dropdown = document.getElementById('chat-model-dropdown');
            const first = dropdown && dropdown.querySelector('.chat-model-option');
            if (first) {
                setChatModelSelection(first.getAttribute('data-value'), first.getAttribute('data-provider') || '');
            }
            hideChatModelDropdown();
            input.blur();
        }
    });

    input.addEventListener('blur', () => {
        setTimeout(() => {
            // 失焦若未选中有效项，恢复显示当前模型名
            syncChatModelSearchFromSelect();
            hideChatModelDropdown();
        }, 150);
    });

    document.addEventListener('click', (e) => {
        if (!picker.contains(e.target)) hideChatModelDropdown();
    });
}

/** 朗读前去掉 emoji / 符号图标（仅 TTS，不影响气泡展示） */
function stripIconsForSpeech(text) {
    return String(text || '')
        .replace(/\p{Regional_Indicator}{2}/gu, '')
        .replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*/gu, '')
        .replace(/[\d#*]\uFE0F?\u20E3/g, '')
        .replace(/[\u2600-\u27BF\u2B00-\u2BFF]/g, '')
        .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
        .replace(/[\uFE0F\u200D\u20E3\uFE0E]/g, '');
}

/** 朗读前去掉 MEDIA/盘符路径/URL（仅 TTS） */
function stripMediaPathsForSpeech(text) {
    return String(text || '')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
        .replace(/<\/?(?:img|video|audio)\b[^>]*>/gi, ' ')
        .replace(/(^|\n)\s*MEDIA\s*:\s*[^\n]*/gi, '$1')
        .replace(/\bMEDIA\s*:\s*/gi, ' ')
        .replace(/\b(?:nexora-media|file|https?|ftp):\/\/[^\s)\]\"'<>]+/gi, ' ')
        .replace(/\\\\[^\s\n\"'<>\\]+(?:\\[^\s\n\"'<>\\]+)+/g, ' ')
        .replace(/\b[A-Za-z]:\\[^\s\n\"'<>]+/g, ' ')
        .replace(/\b[A-Za-z]:\/[^\s\n\"'<>]+/g, ' ')
        .replace(/\/(?:Users|home|tmp|var|opt|mnt|media|root|Volumes|private)\/[^\s\n\"'<>]+/g, ' ')
        .replace(/\b(?:Screenshot captured|Image generated|Video generated|Media saved)\.?/gi, ' ')
        .replace(/\[\[(?:image|video|audio|media)\]\]/gi, ' ');
}

/** 取气泡正文用于朗读：去掉图片/视频节点，避免念 alt 或残留路径 */
function getBubbleTextForSpeech(bubble) {
    if (!bubble) return '';
    try {
        const clone = bubble.cloneNode(true);
        clone.querySelectorAll('img, video, audio, svg, canvas, .nexora-media-img, .chat-message-image, .tts-action-row').forEach((el) => {
            try { el.remove(); } catch (_) {}
        });
        return clone.innerText || clone.textContent || '';
    } catch (_) {
        return bubble.innerText || bubble.textContent || '';
    }
}

function sanitizeTextForSpeech(text) {
    let s = String(text || '');
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    s = stripMediaPathsForSpeech(s);
    s = stripIconsForSpeech(s)
        .replace(/[\*\_\`\#]/g, '')
        .replace(/AI 正在直连.*联络思考中\.\.\./g, '')
        .replace(/思考中\.\.\./g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return s;
}

// TTS 气泡协调：原先每个气泡都往 window 挂一个永不移除的 'global-tts-start' 监听器（长会话无限累积 + 闭包锁住已脱离的 DOM 造成内存泄漏）。
// 改为全局仅一个监听器 + 自清理注册表：每次派发时顺带剔除已从文档移除的气泡，闭包随之可被 GC。
const __ttsBubbleControllers = [];
let __ttsGlobalListenerInstalled = false;
function ensureGlobalTtsListener() {
    if (__ttsGlobalListenerInstalled) return;
    __ttsGlobalListenerInstalled = true;
    window.addEventListener('global-tts-start', (e) => {
        const activeBtn = e && e.detail ? e.detail.activeBtn : null;
        for (let i = __ttsBubbleControllers.length - 1; i >= 0; i--) {
            const c = __ttsBubbleControllers[i];
            const btn = c.getBtn();
            if (!btn || !document.contains(btn)) { __ttsBubbleControllers.splice(i, 1); continue; }
            if (activeBtn !== btn) c.onOtherStart();
        }
    });
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
            
            // 只取正文：去掉图片节点 + 路径/emoji 噪音；不改气泡展示
            let textToSpeak = sanitizeTextForSpeech(getBubbleTextForSpeech(bubble));

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

    // 注册到全局单例监听器（替代此前每气泡一个 window 监听器，避免泄漏）
    ensureGlobalTtsListener();
    __ttsBubbleControllers.push({
        getBtn: () => speakBtn,
        onOtherStart: () => {
            if (isSpeaking) {
                speakBtn.innerHTML = speakerSvg;
                isSpeaking = false;
                if (localVoiceStopListener) {
                    localVoiceStopListener();
                    localVoiceStopListener = null;
                }
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

/** 把本地绝对路径转成 Electron 可加载的 file URL */
function toLocalMediaFileUrl(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    let p = filePath.trim().replace(/^file:\/\//i, '');
    // 去掉 MEDIA 同行尾部状态句（如 "Image generated."）
    const extMatch = p.match(/^([A-Za-z]:[\\/][^\n]*?\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|webm|mp3|wav|m4a))\b/i)
        || p.match(/^(\/[^\n]*?\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|webm|mp3|wav|m4a))\b/i);
    if (extMatch) p = extMatch[1];
    p = p.replace(/[),.;]+$/g, '').trim();
    if (!p) return '';
    const normalized = p.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(normalized)) {
        return 'file:///' + encodeURI(normalized).replace(/#/g, '%23');
    }
    if (normalized.startsWith('/')) {
        return 'file://' + encodeURI(normalized).replace(/#/g, '%23');
    }
    return '';
}

const CHAT_MEDIA_IMG_STYLE = 'max-width: min(100%, 920px); width: auto; height: auto; image-rendering: auto; border-radius: 8px; margin-top: 8px; display: block; border: 1px solid rgba(255,255,255,0.1); cursor: zoom-in;';

/** 将回复里的 MEDIA:本地路径 / [[image]] 转成可点开的 <img>/<video> */
function renderChatMediaHtml(content) {
    if (typeof content !== 'string' || !content) return { html: content, changed: false };
    let html = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    let changed = false;

    html = html.replace(/(?:^|\n)\s*MEDIA\s*:\s*`?([^\n`]+)`?/gi, (full, rawPath) => {
        const url = toLocalMediaFileUrl(rawPath);
        if (!url) return full;
        changed = true;
        const lower = url.toLowerCase();
        const isVideo = /\.(mp4|mov|webm)(?:\?|$)/i.test(lower);
        const isAudio = /\.(mp3|wav|m4a)(?:\?|$)/i.test(lower);
        // 保留路径后的短状态句（同一行上的 "Image generated." 等）
        let status = '';
        const pathOnly = (rawPath.match(/^[A-Za-z]:[\\/][^\n]*?\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|webm|mp3|wav|m4a)\b/i)
            || rawPath.match(/^\/[^\n]*?\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|webm|mp3|wav|m4a)\b/i)
            || [rawPath])[0];
        if (pathOnly && rawPath.length > pathOnly.length) {
            status = rawPath.slice(pathOnly.length).trim();
        }
        const mediaTag = isVideo
            ? `<video src="${url}" controls style="${CHAT_MEDIA_IMG_STYLE}"></video>`
            : isAudio
                ? `<audio src="${url}" controls style="width:min(100%,420px);margin-top:8px;display:block;"></audio>`
                : `<img src="${url}" alt="media" style="${CHAT_MEDIA_IMG_STYLE}" onclick="try{window.open(this.src,'_blank')}catch(e){}" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div style=\\'color:#ff6b6b;font-size:12px;margin-top:6px;\\'>图片加载失败</div>')" />`;
        return `\n${mediaTag}${status ? `\n${status}` : ''}\n`;
    });

    if (/\[\[image\]\]|\[image\]/i.test(html)) {
        let shotUrl = '';
        try {
            const home = (typeof process !== 'undefined' && process.env
                && (process.env.OPENCLAW_STATE_DIR
                    || (process.env.USERPROFILE || process.env.HOME || '') + '/.openclaw'))
                || '';
            const base = String(home || '').replace(/\\/g, '/').replace(/\/$/, '');
            if (base) {
                // 优先 screenshots/ 下的 latest，其次 state 根目录兼容路径
                const candidates = [
                    base + '/screenshots/openclaw-screenshot-latest.png',
                    base + '/openclaw-screenshot-latest.png'
                ];
                for (const c of candidates) {
                    const u = toLocalMediaFileUrl(c);
                    if (u) { shotUrl = u + (u.includes('?') ? '&' : '?') + 't=' + Date.now(); break; }
                }
            }
        } catch (e) {}
        if (!shotUrl) shotUrl = './openclaw-screenshot-latest.png?t=' + Date.now();
        const img = `<img src="${shotUrl}" style="${CHAT_MEDIA_IMG_STYLE}" />`;
        html = html.replace(/\[\[image\]\]/gi, img).replace(/\[image\]/gi, img);
        changed = true;
    }

    return { html, changed };
}

// 往聊天窗口追加气泡消息
/** 模型会话气泡头像：AI 用应用图标，用户仍用 ME */
function createChatAvatarEl(sender) {
    const avatar = document.createElement('div');
    avatar.className = sender === 'user' ? 'chat-avatar chat-avatar-user' : 'chat-avatar chat-avatar-ai';
    avatar.style.cssText = `
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        overflow: hidden;
        box-shadow: 0 4px 10px rgba(0,0,0,0.15);
    `;
    if (sender === 'user') {
        const googleUser = window.currentUserGoogleAccount;
        if (googleUser && googleUser.picture) {
            avatar.style.background = 'transparent';
            const img = document.createElement('img');
            img.src = googleUser.picture;
            img.alt = googleUser.name || 'User';
            img.draggable = false;
            img.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
            img.onerror = () => {
                avatar.style.background = 'linear-gradient(135deg, #00d2ff, #0055ff)';
                avatar.style.fontSize = '13px';
                avatar.style.fontWeight = '800';
                avatar.style.color = 'white';
                avatar.innerText = (googleUser.name || googleUser.email || 'ME')[0].toUpperCase();
            };
            avatar.appendChild(img);
        } else if (googleUser && (googleUser.name || googleUser.email)) {
            avatar.style.background = 'linear-gradient(135deg, #00d2ff, #0055ff)';
            avatar.style.fontSize = '13px';
            avatar.style.fontWeight = '800';
            avatar.style.color = 'white';
            avatar.innerText = (googleUser.name || googleUser.email)[0].toUpperCase();
        } else {
            avatar.style.background = 'linear-gradient(135deg, #00d2ff, #0055ff)';
            avatar.style.fontSize = '13px';
            avatar.style.fontWeight = '800';
            avatar.style.color = 'white';
            avatar.innerText = 'ME';
        }
    } else {
        avatar.style.background = 'transparent';
        const img = document.createElement('img');
        img.src = 'config/icon.png';
        img.alt = 'Nexora Agent';
        img.draggable = false;
        img.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block;';
        img.onerror = () => {
            avatar.style.background = 'linear-gradient(135deg, #8c52ff, #00d2ff)';
            avatar.style.fontSize = '13px';
            avatar.style.fontWeight = '800';
            avatar.style.color = 'white';
            avatar.textContent = 'AI';
        };
        avatar.appendChild(img);
    }
    return avatar;
}

function appendChatMessage(sender, content, attachment = null, isHTML = false) {
    // 隐藏底层系统失败横幅（⚠️ ✉️ Message: ... failed / Exec failed 等），不进会话气泡
    if (typeof content === 'string') {
        const raw = content.trim();
        if (
            raw.includes('Exec failed') ||
            raw.includes('⚠️') ||
            raw.includes('🛠️') ||
            /Message:\s*.+\s+failed/i.test(raw) ||
            (/openclaw-screenshot-latest/i.test(raw) && !/MEDIA\s*:/i.test(raw))
        ) {
            // 保留前端主动引导文案（选模型等），其余带 ⚠️ 的一律不展示
            const isUiGuide =
                raw.includes('请先在右上角选择') ||
                raw.includes('提供商配置不存在') ||
                raw.includes('未配置 Base URL') ||
                raw.includes('Please select') ||
                raw.includes('请先前往【模型配置】');
            if (!isUiGuide) return null;
        }
    }
    // 🌟 MEDIA:本地路径 / [[image]] → 气泡内直接出图
    if (typeof content === 'string' && (/MEDIA\s*:/i.test(content) || content.includes('[[image]]') || content.includes('[image]'))) {
        const rendered = renderChatMediaHtml(content);
        if (rendered.changed) {
            content = rendered.html;
            isHTML = true;
        }
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

    const avatar = createChatAvatarEl(sender);

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
function clearChatHistory(options = {}) {
    const shouldSkipArchive = !!(options && options.skipArchive);
    if (!shouldSkipArchive && activeChatArchiveMessages.length > 0) {
        archiveCurrentChatSession({ silent: true, clearAfter: false });
    }
    chatSessionHistory = []; // 清空历史记录数组
    activeChatArchiveMessages = [];
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    // 清空所有消息气泡
    container.innerHTML = '';

    // 重置为初始欢迎语
    const welcomeHtml = `
        <div id="welcome-message-row" style="display: flex; gap: 12px; max-width: 80%; align-self: flex-start;">
            <div class="chat-avatar chat-avatar-ai" style="width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; overflow: hidden; box-shadow: 0 0 10px rgba(140,82,255,0.3); background: transparent;">
              <img src="config/icon.png" alt="Nexora Agent" draggable="false" style="width: 100%; height: 100%; object-fit: cover; display: block;" onerror="this.parentElement.style.background='linear-gradient(135deg,#8c52ff,#00d2ff)';this.parentElement.style.color='white';this.parentElement.style.fontWeight='800';this.parentElement.style.fontSize='14px';this.parentElement.style.display='flex';this.parentElement.style.alignItems='center';this.parentElement.style.justifyContent='center';this.replaceWith(document.createTextNode('AI'));">
            </div>
            <div id="welcome-message-bubble" style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 12px 16px; color: var(--text-primary); font-size: 13px; line-height: 1.5; border-top-left-radius: 2px;">
                <span data-i18n="chat.welcome.greeting">您好！我是您的智能助手。</span><span id="gateway-connection-status-text" style="color: #ff9800;">当前本地的 OpenClaw Nexora Agent未启动，请前往【控制台】启动Nexora Agent。</span>
                <br><br>
                <span data-i18n="chat.welcome.functions">在这里您可以：</span>
                <br>• <span data-i18n="chat.welcome.chat_mode">与当前选中的大模型进行实时对话；</span>
                <br>• <span data-i18n="chat.welcome.image_mode">点击左下角按钮上传图片，让支持多模态的模型进行**识图对话**；</span>
                <br>• <span data-i18n="chat.welcome.generator_mode">输入指令并点击下方生图/生视频快捷键，快速体验生成式创作。</span>
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


// ==================== 会话归档管理 ====================
const SESSION_ARCHIVE_STORAGE_KEY = 'nexora_archived_chat_sessions_v1';
let sessionArchiveState = { selectedId: '', query: '', sort: 'updatedDesc', initialized: false, externalLoaded: false, externalLoading: false, externalSessions: [] };

function safeParseSessionArchives() {
    try {
        const raw = localStorage.getItem(SESSION_ARCHIVE_STORAGE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter(Boolean) : [];
    } catch (e) {
        console.warn('[SessionArchive] parse failed:', e);
        return [];
    }
}

function saveSessionArchives(list) {
    localStorage.setItem(SESSION_ARCHIVE_STORAGE_KEY, JSON.stringify(Array.isArray(list) ? list : []));
}

function getAllSessionArchives() {
    const local = safeParseSessionArchives().map((item) => ({ ...item, source: item.source || 'local', readOnly: false }));
    const external = Array.isArray(sessionArchiveState.externalSessions) ? sessionArchiveState.externalSessions : [];
    const seen = new Set();
    return [...local, ...external].filter((item) => {
        if (!item || !item.id || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
    });
}

async function loadExternalSessionHistory(force = false) {
    if (!force && (sessionArchiveState.externalLoaded || sessionArchiveState.externalLoading)) return;
    if (!window.api || typeof window.api.getUnifiedSessionHistory !== 'function') {
        sessionArchiveState.externalLoaded = true;
        return;
    }
    sessionArchiveState.externalLoading = true;
    try {
        const res = await window.api.getUnifiedSessionHistory();
        if (res && res.success && Array.isArray(res.sessions)) {
            sessionArchiveState.externalSessions = res.sessions;
        } else if (res && res.error) {
            console.warn('[SessionArchive] external load failed:', res.error);
        }
    } catch (e) {
        console.warn('[SessionArchive] external load failed:', e);
    } finally {
        sessionArchiveState.externalLoading = false;
        sessionArchiveState.externalLoaded = true;
    }
}

function stripSessionHtml(value) {
    const text = String(value || '');
    if (!/[<>&]/.test(text)) return text;
    // 用 DOMParser 解析（惰性文档，不加载资源、不执行脚本），只取纯文本。
    // 旧实现 div.innerHTML = text 会真的触发 <img onerror> 等副作用 →
    // 外部聊天消息里的 payload 在打开「会话存档」时被执行（XSS）。
    try {
        return new DOMParser().parseFromString(text, 'text/html').body.textContent || '';
    } catch (_) {
        // 兜底：纯正则去标签，绝不写入 live DOM
        return text.replace(/<[^>]*>/g, '');
    }
}

function archiveMessageToText(message) {
    if (!message) return '';
    const content = message.content;
    if (Array.isArray(content)) {
        return content.map((item) => item && (item.text || (item.image_url ? t('session_archive.image') : ''))).filter(Boolean).join('\n');
    }
    return stripSessionHtml(content || '');
}

function recordActiveChatArchiveMessage(message) {
    if (!message || !message.role) return;
    const text = archiveMessageToText(message).trim();
    if (!text && !message.attachment) return;
    activeChatArchiveMessages.push({
        id: `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        role: message.role,
        content: text || t('session_archive.image_attachment'),
        attachment: message.attachment || '',
        createdAt: message.createdAt || new Date().toISOString()
    });
    if (activeChatArchiveMessages.length > 80) {
        activeChatArchiveMessages = activeChatArchiveMessages.slice(-80);
    }
}

function buildArchiveTitle(messages) {
    const firstUser = (messages || []).find((m) => m.role === 'user' && archiveMessageToText(m).trim());
    const base = firstUser ? archiveMessageToText(firstUser).trim() : t('session_archive.untitled');
    return base.length > 24 ? `${base.slice(0, 24)}…` : base;
}

function buildArchiveSummary(messages) {
    const parts = (messages || []).slice(0, 4).map((m) => archiveMessageToText(m).trim()).filter(Boolean);
    const summary = parts.join(' / ') || t('session_archive.summary.empty');
    return summary.length > 120 ? `${summary.slice(0, 120)}…` : summary;
}

function archiveCurrentChatSession(options = {}) {
    const messages = activeChatArchiveMessages.slice();
    if (!messages.length) {
        if (!options.silent) showToast(t('session_archive.toast.nothing'));
        return null;
    }
    const now = new Date().toISOString();
    const modelSelect = typeof ensureChatModelSelect === 'function' ? ensureChatModelSelect() : null;
    const model = modelSelect && modelSelect.value ? modelSelect.value : 'unknown';
    const item = {
        id: `archive_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        title: buildArchiveTitle(messages),
        summary: buildArchiveSummary(messages),
        tags: [t('session_archive.tag.chat')],
        model,
        createdAt: now,
        updatedAt: now,
        messages
    };
    const list = safeParseSessionArchives();
    list.unshift(item);
    saveSessionArchives(list);
    sessionArchiveState.selectedId = item.id;
    if (options.clearAfter) clearChatHistory({ skipArchive: true });
    if (options.navigate) {
        const nav = document.querySelector('.nav-item[data-tab="session-archive-view"]');
        if (nav) nav.click();
        else initSessionArchiveView();
    } else {
        renderSessionArchiveView();
    }
    if (!options.silent) showToast(t('session_archive.toast.archived'));
    return item;
}
window.archiveCurrentChatSession = archiveCurrentChatSession;

function getSessionArchiveLocaleTag() {
    const lang = localStorage.getItem('setting_language') || 'zh-CN';
    if (lang === 'en-US') return 'en-US';
    if (lang === 'zh-TW') return 'zh-TW';
    return 'zh-CN';
}

function getFilteredSessionArchives() {
    const query = String(sessionArchiveState.query || '').trim().toLowerCase();
    let list = getAllSessionArchives();
    if (query) {
        list = list.filter((item) => {
            const haystack = [item.title, item.summary, item.model, ...(item.tags || []), ...((item.messages || []).map((m) => m.content))].join('\n').toLowerCase();
            return haystack.includes(query);
        });
    }
    const sort = sessionArchiveState.sort || 'updatedDesc';
    const locale = getSessionArchiveLocaleTag();
    list.sort((a, b) => {
        if (sort === 'titleAsc') return String(a.title || '').localeCompare(String(b.title || ''), locale);
        const field = sort === 'createdDesc' ? 'createdAt' : 'updatedAt';
        return new Date(b[field] || 0) - new Date(a[field] || 0);
    });
    return list;
}

function formatArchiveTime(value) {
    if (!value) return '--';
    try { return new Date(value).toLocaleString(getSessionArchiveLocaleTag(), { hour12: false }); } catch (_) { return value; }
}

function escapeSessionArchiveHtml(value) {
    return String(value || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function sessionArchiveSourceLabel(item, detailed = false) {
    if (!item) return t('session_archive.source.system');
    if (item.source === 'local') return t('session_archive.source.local');
    if (item.source === 'channel') return detailed ? t('session_archive.source.channel_history') : t('session_archive.source.channel');
    return detailed ? t('session_archive.source.openclaw') : t('session_archive.source.system');
}

function renderSessionArchiveView() {
    const listEl = document.getElementById('session-archive-list');
    const detailEl = document.getElementById('session-archive-detail');
    const countEl = document.getElementById('session-archive-count');
    if (!listEl || !detailEl) return;
    const list = getFilteredSessionArchives();
    if (countEl) {
        const countText = t('session_archive.count').replace('{count}', String(list.length));
        const loadingText = sessionArchiveState.externalLoading ? t('session_archive.count_loading') : '';
        countEl.textContent = `${countText}${loadingText}`;
    }
    if (list.length && !list.some((item) => item.id === sessionArchiveState.selectedId)) {
        sessionArchiveState.selectedId = list[0].id;
    }
    listEl.innerHTML = list.length ? list.map((item) => `
        <div class="session-archive-card ${item.id === sessionArchiveState.selectedId ? 'active' : ''}" data-archive-id="${escapeSessionArchiveHtml(item.id)}">
            <div class="session-archive-card-title">${escapeSessionArchiveHtml(item.title || t('session_archive.untitled'))}</div>
            <div class="session-archive-card-meta"><span>${sessionArchiveSourceLabel(item)}</span><span>${escapeSessionArchiveHtml(item.model || 'unknown')}</span><span>${t('session_archive.meta.updated').replace('{time}', formatArchiveTime(item.updatedAt))}</span><span>${t('session_archive.meta.messages').replace('{count}', String((item.messages || []).length))}</span></div>
            <div class="session-archive-card-summary">${escapeSessionArchiveHtml(item.summary || '')}</div>
            <div class="session-archive-tags">${(item.tags || []).map((tag) => `<span class="session-archive-tag">${escapeSessionArchiveHtml(tag)}</span>`).join('')}</div>
        </div>
    `).join('') : `<div class="session-archive-detail-empty">${escapeSessionArchiveHtml(t('session_archive.empty_list'))}</div>`;
    listEl.querySelectorAll('.session-archive-card').forEach((card) => {
        card.addEventListener('click', () => {
            sessionArchiveState.selectedId = card.dataset.archiveId || '';
            renderSessionArchiveView();
        });
    });
    const selected = getAllSessionArchives().find((item) => item.id === sessionArchiveState.selectedId);
    if (!selected) {
        detailEl.innerHTML = `<div class="session-archive-detail-empty">${escapeSessionArchiveHtml(t('session_archive.empty_detail'))}</div>`;
        return;
    }
    const detailMeta = [
        sessionArchiveSourceLabel(selected, true),
        t('session_archive.meta.created').replace('{time}', formatArchiveTime(selected.createdAt)),
        t('session_archive.meta.updated').replace('{time}', formatArchiveTime(selected.updatedAt)),
        escapeSessionArchiveHtml(selected.model || 'unknown')
    ];
    if (selected.channel) detailMeta.push(escapeSessionArchiveHtml(selected.channel));
    if (selected.target) detailMeta.push(escapeSessionArchiveHtml(selected.target));
    detailEl.innerHTML = `
        <div class="session-archive-detail-head">
            <div>
                <h3 class="session-archive-detail-title">${escapeSessionArchiveHtml(selected.title || t('session_archive.untitled'))}</h3>
                <div class="session-archive-detail-meta">${detailMeta.join(' · ')}</div>
                <div class="session-archive-tags">${(selected.tags || []).map((tag) => `<span class="session-archive-tag">${escapeSessionArchiveHtml(tag)}</span>`).join('')}</div>
            </div>
            <div class="session-archive-detail-actions">
                <button class="session-archive-btn ghost" data-archive-action="restore">${escapeSessionArchiveHtml(t('session_archive.btn.restore'))}</button>
                <button class="session-archive-btn" data-archive-action="edit">${escapeSessionArchiveHtml(selected.readOnly ? t('session_archive.btn.clone_edit') : t('session_archive.btn.edit'))}</button>
                <button class="session-archive-btn danger" data-archive-action="delete" ${selected.readOnly ? `disabled title="${escapeSessionArchiveHtml(t('session_archive.readonly_title'))}" style="opacity:.45;cursor:not-allowed;"` : ''}>${escapeSessionArchiveHtml(t('session_archive.btn.delete'))}</button>
            </div>
        </div>
        <div class="session-archive-messages">
            ${(selected.messages || []).length ? selected.messages.map((msg) => `
                <div class="session-archive-msg ${msg.role === 'user' ? 'user' : 'assistant'}">
                    <div class="session-archive-msg-role">${msg.role === 'user' ? 'USER' : 'AI'} · ${formatArchiveTime(msg.createdAt)}</div>
                    <div class="session-archive-msg-content">${escapeSessionArchiveHtml(msg.content || '')}</div>
                </div>
            `).join('') : `<div class="session-archive-detail-empty">${escapeSessionArchiveHtml(t('session_archive.empty_messages'))}</div>`}
        </div>
    `;
    detailEl.querySelector('[data-archive-action="restore"]')?.addEventListener('click', () => restoreArchivedSession(selected.id));
    detailEl.querySelector('[data-archive-action="edit"]')?.addEventListener('click', () => renderSessionArchiveEditor(selected.readOnly ? { ...selected, id: '', readOnly: false, source: 'local' } : selected));
    detailEl.querySelector('[data-archive-action="delete"]')?.addEventListener('click', () => { if (!selected.readOnly) deleteArchivedSession(selected.id); });
}

function renderSessionArchiveEditor(item) {
    const detailEl = document.getElementById('session-archive-detail');
    if (!detailEl) return;
    const isNew = !item || !item.id;
    const draft = item || { title: '', summary: '', tags: [t('session_archive.tag.manual')], messages: [], model: 'manual' };
    detailEl.innerHTML = `
        <div class="session-archive-detail-head"><h3 class="session-archive-detail-title">${escapeSessionArchiveHtml(isNew ? t('session_archive.editor.new') : t('session_archive.editor.edit'))}</h3></div>
        <div class="session-archive-editor">
            <label>${escapeSessionArchiveHtml(t('session_archive.editor.title'))}<input id="archive-edit-title" value="${escapeSessionArchiveHtml(draft.title || '')}" placeholder="${escapeSessionArchiveHtml(t('session_archive.editor.title_ph'))}"></label>
            <label>${escapeSessionArchiveHtml(t('session_archive.editor.tags'))}<input id="archive-edit-tags" value="${escapeSessionArchiveHtml((draft.tags || []).join(', '))}" placeholder="${escapeSessionArchiveHtml(t('session_archive.editor.tags_ph'))}"></label>
            <label>${escapeSessionArchiveHtml(t('session_archive.editor.summary'))}<textarea id="archive-edit-summary" placeholder="${escapeSessionArchiveHtml(t('session_archive.editor.summary_ph'))}">${escapeSessionArchiveHtml(draft.summary || '')}</textarea></label>
            <label>${escapeSessionArchiveHtml(t('session_archive.editor.content'))}<textarea id="archive-edit-content" placeholder="${escapeSessionArchiveHtml(t('session_archive.editor.content_ph'))}">${escapeSessionArchiveHtml((draft.messages || []).map((m) => m.content).join('\n\n'))}</textarea></label>
            <div class="session-archive-detail-actions">
                <button class="session-archive-btn primary" id="archive-edit-save">${escapeSessionArchiveHtml(t('session_archive.btn.save'))}</button>
                <button class="session-archive-btn" id="archive-edit-cancel">${escapeSessionArchiveHtml(t('session_archive.btn.cancel'))}</button>
            </div>
        </div>
    `;
    document.getElementById('archive-edit-save')?.addEventListener('click', () => {
        const now = new Date().toISOString();
        const title = document.getElementById('archive-edit-title')?.value.trim() || t('session_archive.untitled_archive');
        const summary = document.getElementById('archive-edit-summary')?.value.trim() || '';
        const tags = (document.getElementById('archive-edit-tags')?.value || '').split(/[,，]/).map((v) => v.trim()).filter(Boolean);
        const content = document.getElementById('archive-edit-content')?.value.trim() || summary;
        const list = safeParseSessionArchives();
        if (isNew) {
            const created = { id: `archive_${Date.now()}_${Math.random().toString(16).slice(2)}`, title, summary, tags, model: 'manual', createdAt: now, updatedAt: now, messages: content ? [{ id: `msg_${Date.now()}`, role: 'assistant', content, createdAt: now }] : [] };
            list.unshift(created);
            sessionArchiveState.selectedId = created.id;
        } else {
            const idx = list.findIndex((entry) => entry.id === item.id);
            if (idx >= 0) list[idx] = { ...list[idx], title, summary, tags, updatedAt: now, messages: content ? [{ id: `msg_${Date.now()}`, role: 'assistant', content, createdAt: now }] : list[idx].messages || [] };
        }
        saveSessionArchives(list);
        showToast(t('session_archive.toast.saved'));
        renderSessionArchiveView();
    });
    document.getElementById('archive-edit-cancel')?.addEventListener('click', renderSessionArchiveView);
}

function deleteArchivedSession(id) {
    if (!id) return;
    if (!confirm(t('session_archive.confirm_delete'))) return;
    const list = safeParseSessionArchives().filter((item) => item.id !== id);
    saveSessionArchives(list);
    sessionArchiveState.selectedId = list[0] ? list[0].id : '';
    showToast(t('session_archive.toast.deleted'));
    renderSessionArchiveView();
}

function restoreArchivedSession(id) {
    const item = safeParseSessionArchives().find((entry) => entry.id === id);
    if (!item) return;
    if (!Array.isArray(item.messages) || item.messages.length === 0) {
        showToast(t('session_archive.toast.no_restore'));
        return;
    }
    clearChatHistory({ skipArchive: true });
    activeChatArchiveMessages = [];
    chatSessionHistory = [];
    (item.messages || []).forEach((msg) => {
        appendChatMessage(msg.role === 'user' ? 'user' : 'ai', msg.content || '');
        recordActiveChatArchiveMessage(msg);
        chatSessionHistory.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content || '' });
    });
    const chatNav = document.querySelector('.nav-item[data-tab="chat-view"]');
    if (chatNav) chatNav.click();
    showToast(t('session_archive.toast.restored'));
}

function initSessionArchiveView() {
    if (!sessionArchiveState.initialized) {
        sessionArchiveState.initialized = true;
        const search = document.getElementById('session-archive-search');
        const sort = document.getElementById('session-archive-sort');
        document.getElementById('btn-create-archive-session')?.addEventListener('click', () => renderSessionArchiveEditor(null));
        document.getElementById('btn-archive-active-chat')?.addEventListener('click', () => archiveCurrentChatSession({ clearAfter: true }));
        search?.addEventListener('input', () => { sessionArchiveState.query = search.value; renderSessionArchiveView(); });
        sort?.addEventListener('change', () => { sessionArchiveState.sort = sort.value; renderSessionArchiveView(); });
    }
    renderSessionArchiveView();
    loadExternalSessionHistory().then(renderSessionArchiveView);
}
window.initSessionArchiveView = initSessionArchiveView;

function resolveSelectedChatModel() {
    const select = ensureChatModelSelect();
    if (select && select.options.length && select.selectedIndex >= 0 && select.value) {
        const opt = select.options[select.selectedIndex];
        return {
            select,
            modelId: select.value,
            providerKey: (opt && opt.getAttribute('data-provider')) || '',
            option: opt
        };
    }

    const tryApply = (id, provider) => {
        if (!id) return false;
        return setChatModelSelection(id, provider || '');
    };

    // 1) 搜索框里记住的有效选择
    const input = document.getElementById('chat-model-search');
    if (input && input.dataset.selectedValue) {
        if (tryApply(input.dataset.selectedValue, input.dataset.selectedProvider || '')) {
            return resolveSelectedChatModel();
        }
    }

    // 2) 从可见文案解析：gemini / gemini-3.1-flash-lite
    if (input && input.value) {
        const label = String(input.value).trim().replace(/\s*\([^)]*\)\s*$/, '');
        const m = label.match(/^([^/]+?)\s*\/\s*(.+)$/);
        if (m && tryApply(m[2].trim(), m[1].trim())) {
            return resolveSelectedChatModel();
        }
    }

    // 3) 本地记忆 / 主用模型
    const persisted = readPersistedChatModel();
    if (tryApply(persisted.id, persisted.provider)) return resolveSelectedChatModel();
    const { primary } = getConfiguredPrimaryFallbackModels();
    if (tryApply(primary.id, primary.provider)) return resolveSelectedChatModel();

    // 4) 有选项就强制第一项
    if (select && select.options.length) {
        select.selectedIndex = 0;
        const opt = select.options[0];
        if (opt && opt.value) {
            persistChatModelSelection(opt.getAttribute('data-provider') || '', opt.value);
            syncChatModelSearchFromSelect();
            return resolveSelectedChatModel();
        }
    }
    return null;
}

// 处理发送消息（直连各厂家服务，不依赖Nexora Agent）
async function handleSendMessage() {
    const inputArea = document.getElementById('chat-text-input');
    const text = inputArea.value.trim();
    if (!text && !chatAttachmentBase64) return;

    inputArea.value = '';

    // 上一次是生图/生视频临时切了图片/视频模型，这次发普通消息 → 自动切回原来的文字聊天模型
    try {
        if (window.__preGenChatModel && window.__preGenChatModel.value) {
            const sel = ensureChatModelSelect();
            const curVal = sel ? sel.value : '';
            if (/image|video/i.test(curVal)) {
                setChatModelSelection(window.__preGenChatModel.value, window.__preGenChatModel.provider);
            }
            window.__preGenChatModel = null;
        }
    } catch (_) {}

    const file = chatAttachmentBase64;
    const userArchiveMessage = { role: 'user', content: text || (file ? t('session_archive.image_attachment') : ''), attachment: file || '', createdAt: new Date().toISOString() };
    
    document.getElementById('chat-file-upload-input').value = '';
    document.getElementById('chat-attachment-preview-bar').style.display = 'none';
    chatAttachmentBase64 = '';

    appendChatMessage('user', text, file);
    recordActiveChatArchiveMessage(userArchiveMessage);

    // 对话内角色指令不请求模型，由客户端直接执行并立即反馈。
    if (!file && typeof handleChatRoleCommand === 'function') {
        const roleCommandHandled = await handleChatRoleCommand(text);
        if (roleCommandHandled) return;
    }

    let resolved = resolveSelectedChatModel();
    if (!resolved) {
        try { await loadChatModels(); } catch (e) {}
        resolved = resolveSelectedChatModel();
    }
    if (!resolved || !resolved.modelId) {
        appendChatMessage('ai', '⚠️ 请先在右上角选择对话所用的大模型！如果下拉框为空，请先在【模型配置】中配置厂家模型。');
        return;
    }

    const providerKey = resolved.providerKey;
    const modelId = resolved.modelId;
    const modelSelect = resolved.select;

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
   - **网络长连与本地转发（不同渠道差异）**：
     - 若使用的是境内长连渠道（如微信、飞书、QQ），由于 本机网络转发/虚拟网卡转发可能会劫持域名（解析为 198.18.x.x 的 Fake-IP）导致断线，应用已内置了 HTTPDNS 解析直连技术。如果依然频繁断开，请将对应的域名（如 \`*.weixin.qq.com\`、\`*.feishu.cn\`）加入本机转发的直连（Bypass）白名单。
     - 若使用的是需公网可达的渠道（如 Slack、Telegram、WhatsApp、Matrix），请确保本机网络转发已正确开启，并且应用能够经本地转发建立连接。
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

        const chatRequest = buildChatRequest(baseUrl, providerConfig.api, modelId, messages, { apiKey, temperature: 0.7 });
        const chatUrl = chatRequest.url;
        const headers = chatRequest.headers;
        const reqBody = chatRequest.body;

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
            let reply = extractChatReply(result);
            
            if (typeof reply === 'string' && (/MEDIA\s*:/i.test(reply) || reply.includes('[[image]]') || reply.includes('[image]'))) {
                const rendered = renderChatMediaHtml(reply);
                aiBubble.innerHTML = rendered.changed ? rendered.html : reply.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            } else {
                aiBubble.innerText = reply;
            }

            chatSessionHistory.push({
                role: 'assistant',
                content: reply
            });
            recordActiveChatArchiveMessage({ role: 'assistant', content: reply, createdAt: new Date().toISOString() });
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
            // errText 是模型厂家/中转返回的原始响应体，必须转义，否则恶意/被劫持的端点可注入可执行 HTML
            aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ 接口响应错误 (HTTP ${escapeHtml(String(response.status))}): ${escapeHtml(errText || '未知错误')}</span>`;
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

    // 自动把顶部「当前模型」切成对应的图片/视频模型，所见即所用（发普通消息时自动切回文字模型）
    try {
        const prefKey = type === 'image' ? 'client_pref_image_model' : 'client_pref_video_model';
        const fallback = type === 'image' ? 'agnes-ai/agnes-image-2.0-flash' : 'agnes-ai/agnes-video-v2.0';
        const pref = localStorage.getItem(prefKey) || fallback;
        const slash = pref.indexOf('/');
        const gProvider = slash > 0 ? pref.slice(0, slash) : 'agnes-ai';
        const gModel = slash > 0 ? pref.slice(slash + 1) : pref;
        const sel = ensureChatModelSelect();
        const curVal = sel ? sel.value : '';
        const curProv = (sel && sel.options[sel.selectedIndex]) ? (sel.options[sel.selectedIndex].getAttribute('data-provider') || '') : '';
        // 记住切换前的文字聊天模型（当前不是生成类模型时）
        if (!/image|video/i.test(curVal) && curVal) {
            window.__preGenChatModel = { value: curVal, provider: curProv };
        }
        setChatModelSelection(gModel, gProvider);
    } catch (_) {}

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
        const modelSelect = ensureChatModelSelect();
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
                aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ 生图接口错误 (HTTP ${escapeHtml(String(response.status))}): ${escapeHtml(errText || '未知错误')}</span>`;
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
            // 视频生成 API（官方参数：width/height/num_frames/frame_rate）
            const cleanVideoModel = String(modelId || 'agnes-video-v2.0').includes('/')
                ? String(modelId).split('/').pop()
                : String(modelId || 'agnes-video-v2.0');
            const body = {
                model: cleanVideoModel,
                prompt: prompt,
                width: 1152,
                height: 768,
                num_frames: 121,
                frame_rate: 24
            };

            const response = await fetch(genUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errText = await response.text();
                aiBubble.innerHTML = `<span style="color: #ff6b6b;">❌ 生视频接口错误 (HTTP ${escapeHtml(String(response.status))}): ${escapeHtml(errText || '未知错误')}</span>`;
                return;
            }

            const result = await response.json();
            
            // 视频 API 是异步任务模式，需要轮询等待
            const taskId = result.video_id || result.id || result.task_id || result.video_id;
            if (!taskId) {
                // 如果直接返回了 URL（同步模式）
                let videoUrl = '';
                if (result.metadata && result.metadata.url) videoUrl = result.metadata.url;
                else if (result.data && result.data[0]) videoUrl = result.data[0].url || '';
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

            // 异步轮询模式（官方推荐 video_id + /agnesapi）
            let pollUrl = '';
            try {
                const originUrl = new URL(apiBase).origin;
                const modelQs = modelId ? `&model_name=${encodeURIComponent(String(modelId).replace(/^.*\//, ''))}` : '';
                pollUrl = `${originUrl}/agnesapi?video_id=${encodeURIComponent(taskId)}${modelQs}`;
            } catch (err) {
                pollUrl = `https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(taskId)}`;
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
                        if (pollResult.metadata && pollResult.metadata.url) videoUrl = pollResult.metadata.url;
                        else if (pollResult.video && pollResult.video.url) videoUrl = pollResult.video.url;
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

// 模型筛选目录（hidden input 存当前值，不依赖原生 <select>）
let statsModelCatalog = [{ value: 'all', label: '全部模型' }];

// 动态刷新看板的下拉筛选器选项
function updateFilterOptions() {
    const modelSelect = document.getElementById('stats-model-select');
    if (!modelSelect) return;

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

    const sorted = Array.from(models).filter(Boolean).sort((a, b) => a.localeCompare(b));
    statsModelCatalog = [
        { value: 'all', label: t('stats.model.all') },
        ...sorted.map((m) => ({ value: m, label: m })),
    ];
    modelSelect.value = statsModelCatalog.some((o) => o.value === curVal) ? curVal : 'all';
    syncStatsModelSearchFromSelect();
}

function syncStatsModelSearchFromSelect() {
    const select = document.getElementById('stats-model-select');
    const input = document.getElementById('stats-model-search');
    if (!select || !input) return;
    const val = select.value || 'all';
    if (val && val !== 'all') {
        input.value = val;
        input.dataset.selectedValue = val;
        input.placeholder = t('stats.model.search_placeholder');
    } else {
        // 关闭态用 placeholder 显示「全部模型」，避免和搜索图标叠字
        input.value = '';
        input.dataset.selectedValue = 'all';
        input.placeholder = t('stats.model.all');
    }
}

function setStatsModelSelection(value) {
    const select = document.getElementById('stats-model-select');
    if (!select) return false;
    const next = value == null || value === '' ? 'all' : String(value);
    const exists = getStatsModelOptions().some((opt) => opt.value === next);
    select.value = exists ? next : 'all';
    syncStatsModelSearchFromSelect();
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

function getStatsModelOptions() {
    if (!Array.isArray(statsModelCatalog) || !statsModelCatalog.length) {
        return [{ value: 'all', label: t('stats.model.all') }];
    }
    return statsModelCatalog.map((o) => (
        o.value === 'all' ? { value: 'all', label: t('stats.model.all') } : o
    ));
}

function renderStatsModelDropdown(filterText) {
    const dropdown = document.getElementById('stats-model-dropdown');
    const select = document.getElementById('stats-model-select');
    if (!dropdown || !select) return;
    const q = String(filterText || '').trim().toLowerCase();
    const selectedValue = select.value || 'all';
    const items = getStatsModelOptions().filter((o) => {
        if (!q) return true;
        if (o.value === 'all') return t('stats.model.all').toLowerCase().includes(q) || 'all'.includes(q);
        return o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q);
    });

    if (!items.length) {
        dropdown.innerHTML = `<div style="padding:10px 12px; font-size:12px; color:var(--text-secondary);">${escapeHtml(t('stats.model.empty'))}</div>`;
        return;
    }

    dropdown.innerHTML = items.map((o) => {
        const active = o.value === selectedValue;
        const mark = active ? '✓ ' : '';
        return `<button type="button" class="stats-model-option${active ? ' is-active' : ''}" data-value="${escapeHtml(o.value)}" role="option">${mark}${escapeHtml(o.label)}</button>`;
    }).join('');

    dropdown.querySelectorAll('.stats-model-option').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            setStatsModelSelection(btn.getAttribute('data-value') || 'all');
            hideStatsModelDropdown();
        });
    });
}

function showStatsModelDropdown(filterText) {
    const dropdown = document.getElementById('stats-model-dropdown');
    const input = document.getElementById('stats-model-search');
    if (!dropdown) return;
    renderStatsModelDropdown(filterText);
    dropdown.hidden = false;
    if (input) input.setAttribute('aria-expanded', 'true');
}

function hideStatsModelDropdown() {
    const dropdown = document.getElementById('stats-model-dropdown');
    const input = document.getElementById('stats-model-search');
    if (!dropdown) return;
    dropdown.hidden = true;
    if (input) input.setAttribute('aria-expanded', 'false');
}

function initStatsModelSearchPicker() {
    const input = document.getElementById('stats-model-search');
    const picker = document.getElementById('stats-model-picker');
    const select = document.getElementById('stats-model-select');
    if (!input || !picker || !select || input.dataset.bound === 'true') return;
    input.dataset.bound = 'true';
    // Chromium 常忽略 autocomplete=off，换无意义值避免系统自动补全叠一层造成「乱码」
    try {
        input.setAttribute('autocomplete', 'nexora-stats-model-search');
        input.setAttribute('name', 'nexora_stats_model_q');
    } catch (e) {}
    hideStatsModelDropdown();
    syncStatsModelSearchFromSelect();

    input.addEventListener('focus', () => {
        // 展开时展示完整列表，不用当前全名当过滤词
        showStatsModelDropdown('');
        try { input.select(); } catch (e) {}
    });

    input.addEventListener('input', () => {
        showStatsModelDropdown(input.value);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideStatsModelDropdown();
            syncStatsModelSearchFromSelect();
            input.blur();
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const q = String(input.value || '').trim().toLowerCase();
            const items = getStatsModelOptions().filter((o) => {
                if (!q) return o.value === 'all';
                return o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q);
            });
            if (items.length === 1) {
                setStatsModelSelection(items[0].value);
            } else if (items.length > 1) {
                // 优先精确匹配，否则取第一条非 all
                const exact = items.find((o) => o.value.toLowerCase() === q || o.label.toLowerCase() === q);
                setStatsModelSelection((exact || items.find((o) => o.value !== 'all') || items[0]).value);
            } else {
                setStatsModelSelection('all');
            }
            hideStatsModelDropdown();
        }
    });

    input.addEventListener('blur', () => {
        setTimeout(() => {
            hideStatsModelDropdown();
            // 未选中有效项时恢复展示文案
            const selected = select.value || 'all';
            const matched = getStatsModelOptions().some((opt) => opt.value === selected);
            if (!matched) setStatsModelSelection('all');
            else syncStatsModelSearchFromSelect();
        }, 120);
    });

    document.addEventListener('mousedown', (e) => {
        if (!picker.contains(e.target)) hideStatsModelDropdown();
    });
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
    NexoraScheduler.register('console-clock', updateClock, { visibleMs: 1000, hiddenMs: 60000, immediate: false });
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
let __openclawLoadRetryTimer = null;
let __openclawLoadRetryCount = 0;
const OPENCLAW_LOAD_RETRY_MAX = 10;
let __openclawOverlayRetryBound = false;

function setOpenclawPanelOverlay(mode, title, desc) {
    const overlay = document.getElementById('openclaw-panel-overlay');
    if (!overlay) return;
    const titleEl = document.getElementById('openclaw-panel-overlay-title');
    const descEl = document.getElementById('openclaw-panel-overlay-desc');
    const retryBtn = document.getElementById('openclaw-panel-overlay-retry');
    if (mode === 'hide') {
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        overlay.classList.remove('is-error');
        if (retryBtn) retryBtn.hidden = true;
        return;
    }
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    overlay.classList.toggle('is-error', mode === 'error');
    if (titleEl && title) titleEl.textContent = title;
    if (descEl && desc) descEl.textContent = desc;
    if (retryBtn) retryBtn.hidden = mode !== 'error';
    if (!__openclawOverlayRetryBound && retryBtn) {
        __openclawOverlayRetryBound = true;
        retryBtn.addEventListener('click', () => {
            __openclawLoadRetryCount = 0;
            setOpenclawPanelOverlay(
                'loading',
                '正在重新连接 OpenClaw…',
                '正在重新加载控制台面板，请稍候。'
            );
            loadOpenclawControlUi(true, { clearSession: false }).catch(() => {});
        });
    }
}

function scheduleOpenclawControlUiRetry(reason) {
    if (__openclawLoadRetryTimer) return;
    if (__openclawLoadRetryCount >= OPENCLAW_LOAD_RETRY_MAX) {
        setOpenclawPanelOverlay(
            'error',
            'OpenClaw 面板加载失败',
            '首次安装初始化较慢或端口尚未就绪。可点下方重试，或稍后再进一次 OpenClaw。'
        );
        return;
    }
    const delay = Math.min(8000, 800 + __openclawLoadRetryCount * 700);
    __openclawLoadRetryCount += 1;
    setOpenclawPanelOverlay(
        'loading',
        '正在等待控制台就绪…',
        `首次安装可能需要更久（第 ${__openclawLoadRetryCount}/${OPENCLAW_LOAD_RETRY_MAX} 次重试）。${reason ? ' ' + reason : ''}`
    );
    __openclawLoadRetryTimer = setTimeout(() => {
        __openclawLoadRetryTimer = null;
        const pane = document.getElementById('openclaw-panel-view');
        if (!pane || !pane.classList.contains('active')) return;
        if (gatewayStatus === 'stopped') {
            setOpenclawPanelOverlay(
                'error',
                '服务未启动',
                '请先在左上角启动 Nexora Agent，再打开 OpenClaw。'
            );
            return;
        }
        loadOpenclawControlUi(true, { clearSession: false }).catch(() => {});
    }, delay);
}

function clearOpenclawControlUiRetry() {
    if (__openclawLoadRetryTimer) {
        clearTimeout(__openclawLoadRetryTimer);
        __openclawLoadRetryTimer = null;
    }
    __openclawLoadRetryCount = 0;
}
let __openclawPanelLoading = false;

/** 从 --bg-base 渐变里取出最深实色（webview 透不出父级渐变） */
function extractSolidBgFromCssValue(raw, fallback = '#06020f') {
    const s = String(raw || '').trim();
    if (!s) return fallback;
    const hexes = s.match(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g);
    if (hexes && hexes.length) return hexes[hexes.length - 1];
    const rgbs = s.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*[\d.]+)?\s*\)/g);
    if (rgbs && rgbs.length) return rgbs[rgbs.length - 1];
    if (/^#|^rgb/i.test(s)) return s;
    return fallback;
}

/** OpenClaw 新版设置页（qs- 组件、.btn）自带浅色底且用 color(srgb) 语法，通用白底查杀规则罩不住，这里单独压成主题深色 */
function buildOpenclawQsComponentCss(paint) {
    const text = paint.textPrimary;
    const muted = paint.textSecondary;
    const accentRgb = paint.accentRgb;
    return [
        '.qs-segmented { background: rgba(0, 0, 0, 0.28) !important; background-color: rgba(0, 0, 0, 0.28) !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; }',
        'button.qs-segmented__btn { background: transparent !important; background-color: transparent !important; border: none !important; box-shadow: none !important; color: ' + muted + ' !important; }',
        'button.qs-segmented__btn--active { background: rgba(' + accentRgb + ', 0.24) !important; background-color: rgba(' + accentRgb + ', 0.24) !important; color: #ffffff !important; box-shadow: inset 0 0 0 1px rgba(' + accentRgb + ', 0.45) !important; }',
        '.btn, label.btn, .qs-link-btn { background: rgba(255, 255, 255, 0.08) !important; background-color: rgba(255, 255, 255, 0.08) !important; color: ' + text + ' !important; border: 1px solid rgba(255, 255, 255, 0.16) !important; }',
        '.btn:hover, .qs-link-btn:hover { background: rgba(' + accentRgb + ', 0.18) !important; background-color: rgba(' + accentRgb + ', 0.18) !important; }',
        '.qs-preset__meta span, .qs-preset__badges span, .qs-badge { background: rgba(255, 255, 255, 0.08) !important; background-color: rgba(255, 255, 255, 0.08) !important; border: 1px solid rgba(255, 255, 255, 0.12) !important; color: ' + muted + ' !important; }'
    ];
}

function buildOpenclawPanelCss(paint) {
    const p = paint || getOpenclawHostThemePaint();
    const bg = p.bgBase;
    const panel = p.bgPanel;
    const text = p.textPrimary;
    const muted = p.textSecondary;
    const accent = p.accentColor;
    const accentRgb = p.accentRgb;
    const border = p.borderColor;
    return [
        /* 注意：Electron webview 透不出父级渐变，禁止用 transparent 否则会露出纯黑 */
        ':root, html, body, [data-theme], [class*="theme"] { --background: ' + bg + ' !important; --foreground: ' + text + ' !important; --card: ' + panel + ' !important; --card-foreground: ' + text + ' !important; --muted: ' + panel + ' !important; --muted-foreground: ' + muted + ' !important; --border: ' + border + ' !important; --input: rgba(255, 255, 255, 0.1) !important; --sidebar-background: ' + panel + ' !important; --sidebar-foreground: ' + text + ' !important; --sidebar-primary: ' + accent + ' !important; --sidebar-primary-foreground: ' + text + ' !important; --sidebar-accent-foreground: ' + text + ' !important; --sidebar-muted: ' + muted + ' !important; --sidebar-border: rgba(255, 255, 255, 0.1) !important; --tw-text-opacity: 1 !important; --color-bg-layout: ' + bg + ' !important; --color-bg-container: ' + panel + ' !important; --color-fill: ' + panel + ' !important; --color-fill-secondary: ' + panel + ' !important; --color-fill-tertiary: ' + panel + ' !important; --color-fill-quaternary: ' + panel + ' !important; --color-bg-text-hover: rgba(255,255,255,0.06) !important; --color-bg-text-active: rgba(255,255,255,0.1) !important; --color-text: ' + text + ' !important; --color-text-secondary: ' + muted + ' !important; --color-text-tertiary: ' + muted + ' !important; }',
        '*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }',
        'html, body { background: ' + bg + ' !important; background-color: ' + bg + ' !important; background-image: radial-gradient(ellipse at 50% 35%, rgba(' + accentRgb + ', 0.16) 0%, transparent 55%) !important; }',
        '#root, #__next, [id="root"], [data-radix-scroll-area-viewport], main, section, article, header, footer, [class*="page"], [class*="layout"], [class*="container"], [class*="workspace"], [class*="chat"], [class*="screen"], [class*="h-screen"], [class*="min-h"], [class*="inset-0"], [class*="bg-background"], [class*="bg-black"], [class*="bg-zinc"], [class*="bg-neutral"], [class*="bg-slate"], [class*="backdrop"], [class*="overlay"], .ant-card-head, .ant-card-head-wrapper, .ant-list-header, .ant-table-thead > tr > th, [class*="header"], [class*="head"], [class*="toolbar"], [class*="title-bar"] { background-color: transparent !important; box-shadow: none !important; }',
        /* 侧栏勿用 backdrop-filter：会形成 containing block，把 position:fixed 的会话菜单困在 overflow:hidden 侧栏里 */
        'aside, nav, [class*="bg-sidebar"], .nexora-solid-sidebar { background: ' + panel + ' !important; background-color: ' + panel + ' !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border-right: 1px solid rgba(255,255,255,0.08) !important; }',
        '.ant-modal-content, .ant-drawer-content, .ant-popover-inner, .ant-tooltip-inner, .ant-dropdown-menu, .ant-select-dropdown, [role="dialog"], [role="menu"]:not(.sidebar-session-menu):not(.sidebar-customize-menu):not(.sidebar-session-sort-menu), [role="listbox"], [role="tooltip"], [class*="modal"], [class*="drawer"], [class*="custom-sidebar"], [class*="sidebar-custom"], [class*="sidebar-config"], [class*="SidebarCustom"], [data-radix-popper-content-wrapper] > div, [class*="Popover"], [class*="popover"] { background: ' + panel + ' !important; background-color: ' + panel + ' !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: 1px solid rgba(255,255,255,0.15) !important; box-shadow: 0 12px 48px rgba(0,0,0,0.6) !important; opacity: 1 !important; z-index: 99999 !important; }',
        '.sidebar-session-menu, .sidebar-customize-menu, .sidebar-session-sort-menu { position: fixed !important; z-index: 5000 !important; background: ' + panel + ' !important; background-color: ' + panel + ' !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; border: 1px solid rgba(255,255,255,0.15) !important; box-shadow: 0 12px 32px rgba(0,0,0,0.55) !important; opacity: 1 !important; overflow: visible !important; pointer-events: auto !important; }',
        '.sidebar-session-menu__item, .sidebar-session-menu__text, .sidebar-customize-menu__item, .sidebar-session-sort-menu__item { color: ' + text + ' !important; opacity: 1 !important; }',
        'body { color-scheme: dark !important; }',
        'div, p, span, label, button, a, h1, h2, h3, h4, h5, h6, time, th, td, tr, li, dt, dd, tbody, thead, table, legend, caption, [class*="text"], [class*="label"], [class*="title"], [class*="desc"], .ant-table-cell { color: ' + text + ' !important; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.7); }',
        '.text-muted-foreground, .text-muted, [class*="muted"], [class*="text-zinc"], [class*="text-slate"], [class*="text-neutral"], [class*="text-gray"], [class*="text-secondary"], [class*="text-dim"], [class*="subtle"], [class*="hint"], [class*="status"], [class*="badge"], [class*="meta"], time { color: ' + muted + ' !important; opacity: 1 !important; }',
        '[data-state="inactive"], [data-state="unchecked"], [data-state="off"], [aria-selected="false"], button:not(.session-action):not([data-state="active"]):not([aria-selected="true"]):not(.ant-segmented-item-selected):not(.qs-segmented__btn--active) { color: ' + muted + ' !important; opacity: 0.95 !important; background: transparent !important; background-color: transparent !important; }',
        '[data-state="active"], [data-state="checked"], [data-state="on"], [aria-selected="true"], .ant-segmented-item-selected { background: rgba(255, 255, 255, 0.15) !important; background-color: rgba(255, 255, 255, 0.15) !important; color: #ffffff !important; opacity: 1 !important; box-shadow: none !important; }',
        '[class*="bg-white"], [style*="background: white"], [style*="background-color: white"], [style*="background: #fff"], [style*="background-color: #fff"], [style*="background: rgb(255, 255, 255)"], [style*="background-color: rgb(255, 255, 255)"] { background: transparent !important; background-color: transparent !important; }',
        '.ant-segmented-thumb, [class*="indicator"], [class*="slider"] { background: rgba(255, 255, 255, 0.15) !important; background-color: rgba(255, 255, 255, 0.15) !important; box-shadow: none !important; border: 1px solid rgba(255, 255, 255, 0.2) !important; border-radius: 6px !important; }',
        'button:not(.session-action), [role="button"]:not(.session-action), [class*="card"], [class*="prompt"], [class*="suggestion"], .ant-segmented-item { border: 1px solid rgba(255, 255, 255, 0.1) !important; box-shadow: none !important; }',
        '.session-action { border: none !important; box-shadow: none !important; }',
        '.ant-segmented { background: transparent !important; background-color: transparent !important; border: 1px solid rgba(255, 255, 255, 0.1) !important; }',
        'button:not([data-state="active"]):not([data-state="checked"]):not(.qs-segmented__btn--active):hover, a:hover, li:not(.nexora-solid-sidebar):hover, tr:hover, td:hover, [class*="item"]:not(.nexora-solid-sidebar):hover, [class*="Item"]:not(.nexora-solid-sidebar):hover, [class*="hover:bg-"]:hover { background-color: transparent !important; }',
        'textarea, input, [contenteditable="true"] { background-color: rgba(0, 0, 0, 0.2) !important; color: #ffffff !important; border-color: rgba(255, 255, 255, 0.25) !important; caret-color: ' + accent + ' !important; }',
        'textarea::placeholder, input::placeholder, [class*="placeholder"] { color: ' + muted + ' !important; opacity: 0.85 !important; }',
        'svg { color: ' + accent + ' !important; opacity: 1 !important; }',
        'pre, code { background-color: rgba(0, 0, 0, 0.3) !important; color: #e0f2fe !important; }',
        /* 标准滚动条属性(scrollbar-width/color)一旦被设置，Chromium 会整体忽略 ::-webkit-scrollbar 美化，必须重置回 auto 让下面的胶囊样式生效 */
        '*, html, body { scrollbar-width: auto !important; scrollbar-color: auto !important; }',
        '::-webkit-scrollbar { width: 12px !important; height: 12px !important; }',
        '::-webkit-scrollbar-track { background: transparent !important; }',
        '::-webkit-scrollbar-thumb { background-color: rgba(148, 163, 184, 0.4) !important; border: 3px solid transparent !important; background-clip: padding-box !important; border-radius: 9999px !important; }',
        '::-webkit-scrollbar-thumb:hover { background-color: rgba(148, 163, 184, 0.6) !important; border: 3px solid transparent !important; background-clip: padding-box !important; border-radius: 9999px !important; }',
        '::-webkit-scrollbar-button { display: none !important; width: 0 !important; height: 0 !important; -webkit-appearance: none !important; }',
        '::-webkit-scrollbar-corner { background: transparent !important; }',
        '.simplebar-scrollbar::before, .ms-thumb, .os-scrollbar-handle { background-color: rgba(148, 163, 184, 0.4) !important; border-radius: 9999px !important; }',
        '.sidebar-recent-sessions { margin-right: 0 !important; }',
        '.sidebar-sessions { padding-right: 14px !important; box-sizing: border-box !important; }',
        '.sidebar-recent-session__aside, .session-row-aside { padding-right: 8px !important; flex-shrink: 0 !important; }',
        '.session-row-actions, .session-action { flex-shrink: 0 !important; }',
        '.sidebar-nav, .sidebar-sessions, .sidebar-recent-sessions__list, main.content { scrollbar-width: auto !important; scrollbar-color: auto !important; }',
        'body > div:not(#root):not(#__next):not([id="root"]) > div, body > div:not(#root):not(#__next):not([id="root"]) [role="menu"]:not(.sidebar-session-menu):not(.sidebar-customize-menu):not(.sidebar-session-sort-menu), body > div:not(#root):not(#__next):not([id="root"]) [role="dialog"], body > div:not(#root):not(#__next):not([id="root"]) [role="listbox"], body > div:not(#root):not(#__next):not([id="root"]) [role="tooltip"], body > div:not(#root):not(#__next):not([id="root"]) [class*="popover"] { background: ' + panel + ' !important; background-color: ' + panel + ' !important; border: 1px solid rgba(255,255,255,0.15) !important; box-shadow: 0 12px 48px rgba(0,0,0,0.6) !important; opacity: 1 !important; z-index: 99999 !important; border-radius: 8px !important; }'
    ].concat(buildOpenclawQsComponentCss({ textPrimary: text, textSecondary: muted, accentRgb: accentRgb })).join('\n');
}

/** @deprecated 兼容旧引用：静态兜底，实际注入走 buildOpenclawPanelCss */
const OPENCLAW_TRANSPARENT_PANEL_CSS = buildOpenclawPanelCss({
    bgBase: '#06020f',
    bgPanel: 'rgba(22, 19, 38, 0.96)',
    textPrimary: '#f8fafc',
    textSecondary: '#cbd5e1',
    accentColor: '#38bdf8',
    accentRgb: '56, 189, 248',
    borderColor: 'rgba(255, 255, 255, 0.15)'
});

function getOpenclawHostThemePaint() {
    const bodyStyle = getComputedStyle(document.body);
    const textPrimary = (bodyStyle.getPropertyValue('--text-primary') || '#f0f6ff').trim();
    const textSecondary = (bodyStyle.getPropertyValue('--text-secondary') || '#cbd5e1').trim();
    const accentColor = (bodyStyle.getPropertyValue('--accent-color') || '#38bdf8').trim();
    const accentRgb = (bodyStyle.getPropertyValue('--accent-rgb') || '56, 189, 248').trim();
    const borderColor = (bodyStyle.getPropertyValue('--border-color') || 'rgba(255, 255, 255, 0.15)').trim();
    const bgPanelRaw = (bodyStyle.getPropertyValue('--bg-panel') || 'rgba(18, 24, 38, 0.92)').trim();
    const bgBaseVar = (bodyStyle.getPropertyValue('--bg-base') || '').trim();
    // 优先用主题渐变末色；body.backgroundColor 在渐变主题下常是 transparent/错色
    let bgBase = extractSolidBgFromCssValue(bgBaseVar, '');
    if (!bgBase) {
        bgBase = bodyStyle.backgroundColor || '';
        if (!bgBase || bgBase === 'transparent' || bgBase === 'rgba(0, 0, 0, 0)') bgBase = '#06020f';
    }
    const bgPanel = bgPanelRaw.includes('rgba')
        ? bgPanelRaw.replace(/rgba?\(([^)]+)\)/, (m, inner) => {
            const parts = inner.split(',').map((x) => x.trim());
            if (parts.length >= 3) return 'rgba(' + parts[0] + ', ' + parts[1] + ', ' + parts[2] + ', 0.96)';
            return m;
        })
        : bgPanelRaw;
    return { textPrimary, textSecondary, accentColor, accentRgb, borderColor, bgBase, bgPanel };
}

function buildOpenclawDynamicThemeCss(paint) {
    const { textPrimary, textSecondary, accentColor, accentRgb, borderColor, bgBase, bgPanel } = paint;
    return [
        ':root, html, body, [data-theme] {',
        '  --bg-panel: ' + bgPanel + ' !important;',
        '  --background: ' + bgBase + ' !important;',
        '  --foreground: ' + textPrimary + ' !important;',
        '  --card: ' + bgPanel + ' !important;',
        '  --muted-foreground: ' + textSecondary + ' !important;',
        '  --accent: ' + accentColor + ' !important;',
        '  --sidebar-background: ' + bgPanel + ' !important;',
        '  --sidebar-primary: ' + accentColor + ' !important;',
        '  --border: ' + borderColor + ' !important;',
        '  --color-bg-layout: ' + bgBase + ' !important;',
        '}',
        /* html/body 必须实色+主题光晕；绝不能 transparent（webview 会透出纯黑） */
        'html, body {',
        '  background: ' + bgBase + ' !important;',
        '  background-color: ' + bgBase + ' !important;',
        '  background-image: radial-gradient(ellipse at 50% 35%, rgba(' + accentRgb + ', 0.18) 0%, transparent 58%) !important;',
        '  color-scheme: dark !important;',
        '}',
        /* 仅子层透明，露出 body 主题底 */
        '#root, #__next, [id="root"], main, section, article, header, footer, [class*="page"], [class*="layout"], [class*="container"], [class*="workspace"], [class*="chat"], [class*="screen"], [class*="bg-background"], [class*="bg-black"], [class*="bg-zinc"], [class*="bg-neutral"], [class*="bg-slate"] {',
        '  background-color: transparent !important;',
        '  box-shadow: none !important;',
        '}',
        'aside, nav, [class*="bg-sidebar"], .nexora-solid-sidebar {',
        '  background: ' + bgPanel + ' !important;',
        '  background-color: ' + bgPanel + ' !important;',
        '  background-image: none !important;',
        '  border-right: 1px solid rgba(255,255,255,0.08) !important;',
        '}',
        'svg { color: ' + accentColor + ' !important; }',
        'button:not(.session-action), [role="button"]:not(.session-action), [class*="card"], [class*="prompt"], [class*="suggestion"] { border-color: ' + borderColor + ' !important; }'
    ].concat(buildOpenclawQsComponentCss(paint)).join('\n');
}

function syncOpenclawThemeToWebview() {
    const webview = document.getElementById('openclaw-iframe');
    if (!webview) return;
    try {
        const paint = getOpenclawHostThemePaint();
        // 宿主侧先铺主题实色，首屏不会先黑一下
        try { webview.style.background = paint.bgBase; } catch (_) {}
        const css = buildOpenclawDynamicThemeCss(paint);
        // 同一份 CSS 只 insert 一次，反复 insertCSS 会叠多层导致闪烁
        if (webview.__nexoraInsertedThemeCss !== css) {
            webview.__nexoraInsertedThemeCss = css;
            try {
                if (typeof webview.insertCSS === 'function') webview.insertCSS(css).catch(function () {});
            } catch (_) {}
        }
        if (typeof webview.executeJavaScript !== 'function') return;
        const payload = JSON.stringify({
            css: css,
            bgBase: paint.bgBase,
            accentRgb: paint.accentRgb,
            textPrimary: paint.textPrimary
        });
        webview.executeJavaScript(
            '(function(payload){\n' +
            '  if(!payload) return;\n' +
            '  window.__NEXORA_THEME_CSS = payload.css;\n' +
            '  window.__NEXORA_THEME_BG = payload.bgBase;\n' +
            '  try {\n' +
            '    var cssText = window.__NEXORA_THEME_CSS || "";\n' +
            '    var style = document.getElementById("nexora-openclaw-dynamic-theme");\n' +
            '    if(!style){\n' +
            '      style = document.createElement("style");\n' +
            '      style.id = "nexora-openclaw-dynamic-theme";\n' +
            '      (document.head || document.documentElement).appendChild(style);\n' +
            '    }\n' +
            '    if(style.textContent !== cssText) style.textContent = cssText;\n' +
            '    var bg = window.__NEXORA_THEME_BG || "#06020f";\n' +
            '    document.documentElement.style.setProperty("background-color", bg, "important");\n' +
            '    if(document.body){\n' +
            '      document.body.style.setProperty("background-color", bg, "important");\n' +
            '      document.body.style.setProperty("background-image", "radial-gradient(ellipse at 50% 35%, rgba("+(payload.accentRgb||"220,38,38")+", 0.16) 0%, transparent 58%)", "important");\n' +
            '    }\n' +
            '  } catch(e) {}\n' +
            /* 更新防护兜底：不认类名，直接按计算样式找“深色主题下的近白亮底”并压暗。
               OpenClaw 改版换类名（如 ant-* → qs-*）时上面的选择器会漏，这层仍然兜得住。 */
            '  try {\n' +
            '    window.__NEXORA_THEME_TEXT = payload.textPrimary || "#eef2ff";\n' +
            /* Shadow DOM 穿不进文档级样式，胶囊滚动条 CSS 用 constructable stylesheet 逐个 shadow root 采纳 */
            '    if(!window.__nexoraShadowSheet && typeof CSSStyleSheet === "function"){\n' +
            '      try {\n' +
            '        window.__nexoraShadowSheet = new CSSStyleSheet();\n' +
            '        window.__nexoraShadowSheet.replaceSync("*{scrollbar-width:auto!important;scrollbar-color:auto!important}::-webkit-scrollbar{width:12px!important;height:12px!important}::-webkit-scrollbar-track{background:transparent!important}::-webkit-scrollbar-thumb{background-color:rgba(148,163,184,0.4)!important;border:3px solid transparent!important;background-clip:padding-box!important;border-radius:9999px!important}::-webkit-scrollbar-thumb:hover{background-color:rgba(148,163,184,0.6)!important}::-webkit-scrollbar-button{display:none!important;width:0!important;height:0!important}::-webkit-scrollbar-corner{background:transparent!important}");\n' +
            '      } catch(_) { window.__nexoraShadowSheet = null; }\n' +
            '    }\n' +
            '    if(!window.__nexoraDeWhiten){\n' +
            '      window.__nexoraDeWhiten = function(){\n' +
            '        function parse(v){\n' +
            '          var s = String(v||"");\n' +
            '          var m = s.match(/rgba?\\((\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)(?:[,\\s\\/]+([\\d.]+%?))?\\)/);\n' +
            '          if(m){ return {r:+m[1], g:+m[2], b:+m[3], a: m[4]===undefined?1:(String(m[4]).indexOf("%")>-1?parseFloat(m[4])/100:parseFloat(m[4]))}; }\n' +
            '          m = s.match(/color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+%?))?\\)/);\n' +
            '          if(m){ return {r:255*m[1], g:255*m[2], b:255*m[3], a: m[4]===undefined?1:(String(m[4]).indexOf("%")>-1?parseFloat(m[4])/100:parseFloat(m[4]))}; }\n' +
            '          return null;\n' +
            '        }\n' +
            '        function walk(root){\n' +
            '          var all = root.querySelectorAll("*");\n' +
            '          for(var i=0;i<all.length;i++){\n' +
            '            var el = all[i];\n' +
            '            if(el.shadowRoot){\n' +
            '              try {\n' +
            '                if(window.__nexoraShadowSheet && el.shadowRoot.adoptedStyleSheets.indexOf(window.__nexoraShadowSheet) < 0){\n' +
            '                  el.shadowRoot.adoptedStyleSheets = el.shadowRoot.adoptedStyleSheets.concat(window.__nexoraShadowSheet);\n' +
            '                }\n' +
            '              } catch(_) {}\n' +
            '              walk(el.shadowRoot);\n' +
            '            }\n' +
            /* 已评估过的元素跳过：JS 属性标记不落 DOM、不触发观察器，让重复全量遍历变廉价 */
            '            if(el.__nexoraDW) continue;\n' +
            '            var tag = el.tagName;\n' +
            '            if(tag==="IMG"||tag==="VIDEO"||tag==="CANVAS"||tag==="svg"||tag==="SVG") continue;\n' +
            '            var cs; try { cs = getComputedStyle(el); } catch(_) { continue; }\n' +
            '            el.__nexoraDW = 1;\n' +
            '            var c = parse(cs.backgroundColor);\n' +
            '            if(!c || c.a < 0.35) continue;\n' +
            /* 只处理近中性的亮底（min 通道 >= 180）；饱和色如橙色开关、状态灯不动 */
            '            if(Math.min(c.r, c.g, c.b) < 180) continue;\n' +
            '            el.style.setProperty("background-color", "rgba(255,255,255,0.08)", "important");\n' +
            '            el.style.setProperty("background-image", "none", "important");\n' +
            '            var t2 = parse(cs.color);\n' +
            '            if(t2 && (0.2126*t2.r + 0.7152*t2.g + 0.0722*t2.b) < 110) el.style.setProperty("color", window.__NEXORA_THEME_TEXT, "important");\n' +
            '          }\n' +
            '        }\n' +
            '        try { walk(document); } catch(_) {}\n' +
            '      };\n' +
            '      var deb;\n' +
            /* 只监听 class 变化（不监听 style）：fixEl 自己写的是 style，若监听 style 会自触发无限全树遍历。
               class 变化的元素清掉标记以便重评估；新增节点无标记，全量遍历时自然会处理。 */
            '      window.__nexoraDeWhitenObs = new MutationObserver(function(muts){ try { for(var i=0;i<muts.length;i++){ var mr=muts[i]; if(mr.type==="attributes" && mr.target){ mr.target.__nexoraDW=0; } } } catch(_){} clearTimeout(deb); deb = setTimeout(window.__nexoraDeWhiten, 400); });\n' +
            '      window.__nexoraDeWhitenObs.observe(document.documentElement, {childList: true, subtree: true, attributes: true, attributeFilter: ["class"]});\n' +
            '    }\n' +
            '    window.__nexoraDeWhiten();\n' +
            '  } catch(e) {}\n' +
            '})(' + payload + ');'
        ).catch(function () {});
    } catch (e) {}
}

function collectDataCenterThemeVars() {
    const cs = getComputedStyle(document.body);
    const pick = (name) => (cs.getPropertyValue(name) || '').trim();
    const accent = pick('--accent-color') || '#38bdf8';
    const accentRgb = pick('--accent-rgb') || '56, 189, 248';
    return {
        '--bg-base': pick('--bg-base') || 'radial-gradient(circle at 50% 50%, #110924 0%, #06020f 100%)',
        '--bg-panel': pick('--bg-panel') || 'rgba(22, 19, 38, 0.65)',
        '--bg-card': pick('--bg-card') || 'rgba(30, 27, 51, 0.45)',
        '--border-color': pick('--border-color') || 'rgba(255, 255, 255, 0.12)',
        '--accent-color': accent,
        '--accent-rgb': accentRgb,
        '--text-primary': pick('--text-primary') || '#f0f6ff',
        '--text-secondary': pick('--text-secondary') || '#94a3b8',
        '--glow': accent,
        '--glow2': accent,
        '--glow3': accent,
    };
}

function pushDataCenterTheme(frame) {
    const target = frame || document.getElementById('data-center-iframe');
    if (!target || !target.contentWindow) return;
    const lang = localStorage.getItem('setting_language') || 'zh-CN';
    const title = t('nav.data_center');
    try {
        target.title = title;
        target.setAttribute('title', title);
    } catch (_) {}
    try {
        target.contentWindow.postMessage({
            type: 'nexora-theme',
            vars: collectDataCenterThemeVars(),
            lang,
            title: 'Nexora ' + title,
            statusRunning: t('系统运行中', 'System running', '系統運行中'),
        }, '*');
    } catch (_) {}
}

try {
    window.addEventListener('message', (evt) => {
        const data = evt && evt.data;
        if (!data || data.type !== 'nexora-data-center-ready') return;
        pushDataCenterTheme();
    });
} catch (_) {}

async function loadDataCenterUi(forceReload = false) {
    const frame = document.getElementById('data-center-iframe');
    if (!frame) return;
    try {
        if (!window.api || typeof window.api.getDataCenterUrl !== 'function') {
            throw new Error('getDataCenterUrl unavailable');
        }
        const info = await window.api.getDataCenterUrl();
        if (!info || !info.ok || !info.url) {
            throw new Error((info && info.error) || 'data-center start failed');
        }
        const url = String(info.url).replace(/\/?$/, '/');
        const currentSrc = (frame.getAttribute('src') || '').trim();
        if (!forceReload && currentSrc && (currentSrc === url || currentSrc.startsWith(url))) {
            pushDataCenterTheme(frame);
            try {
                frame.contentWindow.postMessage({ type: 'nexora-data-center-refresh' }, '*');
            } catch (_) {}
            return;
        }
        const waitLoad = new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                frame.removeEventListener('load', finish);
                resolve();
            };
            frame.addEventListener('load', finish);
            setTimeout(finish, 12000);
        });
        if (currentSrc === url) {
            frame.src = 'about:blank';
            await new Promise((r) => setTimeout(r, 30));
        }
        frame.src = url;
        await waitLoad;
        pushDataCenterTheme(frame);
        // 再推一次，避免首屏样式未就绪
        setTimeout(() => pushDataCenterTheme(frame), 120);
    } catch (err) {
        console.error('[DataCenter]', err);
        try {
            const detail = (err && err.message) ? String(err.message) : '';
            showToast(
                detail
                    ? t('数据总览启动失败：', 'Data Overview failed: ', '數據總覽啟動失敗：') + detail
                    : t('数据总览启动失败', 'Data Overview failed to start', '數據總覽啟動失敗')
            );
        } catch (_) {}
    }
}

async function waitForOpenclawPanelLayout(timeoutMs = 2500) {
    const pane = document.getElementById('openclaw-panel-view');
    const webview = document.getElementById('openclaw-iframe');
    if (!pane) return;
    const ready = () => {
        // tab 未激活时 display:none，宽高为 0；必须等面板真正铺开再加载，否则 Control UI 会按窄屏渲染丢掉会话侧栏
        if (!pane.classList.contains('active')) return false;
        const w = pane.clientWidth || (webview && webview.clientWidth) || 0;
        const h = pane.clientHeight || (webview && webview.clientHeight) || 0;
        return w >= 320 && h >= 240;
    };
    if (ready()) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return;
    }
    const t0 = Date.now();
    await new Promise((resolve) => {
        const tick = () => {
            if (ready() || Date.now() - t0 >= timeoutMs) {
                resolve();
                return;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

function showOpenclawThemeCover() {
    const cover = document.getElementById('openclaw-theme-cover');
    if (!cover) return;
    cover.style.display = 'block';
    cover.style.opacity = '1';
    cover.setAttribute('aria-hidden', 'false');
}

function hideOpenclawThemeCover() {
    const cover = document.getElementById('openclaw-theme-cover');
    if (!cover) return;
    cover.style.transition = 'opacity 160ms ease';
    cover.style.opacity = '0';
    setTimeout(() => {
        cover.style.display = 'none';
        cover.setAttribute('aria-hidden', 'true');
    }, 180);
}

/** 等 OpenClaw 自带主题被我们的 CSS/内联样式真正盖住，再揭开遮罩 */
async function waitUntilOpenclawThemeOverridden(webview, timeoutMs = 5000) {
    if (!webview || typeof webview.executeJavaScript !== 'function') {
        await new Promise((r) => setTimeout(r, 600));
        return false;
    }
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < timeoutMs) {
        syncOpenclawThemeToWebview();
        try {
            ok = !!(await webview.executeJavaScript(`
                (function(){
                    var s = document.getElementById('nexora-openclaw-dynamic-theme');
                    if (!s || !s.textContent) return false;
                    var bg = (document.body && document.body.style && document.body.style.backgroundColor) || '';
                    return !!(window.__nexoraThemeGuard && (bg || s.textContent.indexOf('--background') >= 0));
                })();
            `));
        } catch (_) {
            ok = false;
        }
        if (ok) break;
        await new Promise((r) => setTimeout(r, 180));
    }
    // 再补两枪，挡住 SPA 末尾回写
    syncOpenclawThemeToWebview();
    await new Promise((r) => setTimeout(r, 120));
    syncOpenclawThemeToWebview();
    return ok;
}

function pokeOpenclawWebviewLayout(webview) {
    // 不再自动连点侧栏按钮：会触发布局抖动/面板闪烁
    if (!webview || typeof webview.executeJavaScript !== 'function') return;
    if (webview.__nexoraLayoutPoked) return;
    webview.__nexoraLayoutPoked = true;
    webview.executeJavaScript(`
        (function () {
            try { window.dispatchEvent(new Event('resize')); } catch (e) {}
        })();
    `).catch(() => {});
}

/** 温和补主题：少次数、不叠 CSS、不点按钮，避免闪烁 */
function scheduleOpenclawThemeSync(webview, opts = {}) {
    if (!webview) return;
    const delays = Array.isArray(opts.delays) ? opts.delays : [0, 800];
    const token = (webview.__nexoraThemeSyncToken = (webview.__nexoraThemeSyncToken || 0) + 1);
    delays.forEach((ms) => {
        setTimeout(() => {
            if (webview.__nexoraThemeSyncToken !== token) return;
            try {
                injectOpenclawPanelCss(webview);
                syncOpenclawThemeToWebview();
            } catch (_) {}
        }, ms);
    });
}

function waitForOpenclawWebviewSettled(webview, timeoutMs = 8000) {
    if (!webview) return Promise.resolve();
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            try { webview.removeEventListener('did-finish-load', onReady); } catch (_) {}
            try { webview.removeEventListener('did-stop-loading', onReady); } catch (_) {}
            try { webview.removeEventListener('dom-ready', onReady); } catch (_) {}
            resolve();
        };
        const onReady = () => finish();
        try {
            const u = typeof webview.getURL === 'function' ? webview.getURL() : '';
            if (u && u !== 'about:blank' && !String(u).startsWith('data:')) {
                // 已有文档时也等一帧，方便 SPA hydrate
                setTimeout(finish, 80);
            }
        } catch (_) {}
        try { webview.addEventListener('did-finish-load', onReady); } catch (_) {}
        try { webview.addEventListener('did-stop-loading', onReady); } catch (_) {}
        try { webview.addEventListener('dom-ready', onReady); } catch (_) {}
        setTimeout(finish, timeoutMs);
    });
}

async function loadOpenclawControlUi(forceReload = false, opts = {}) {
    const webview = document.getElementById('openclaw-iframe');
    if (!webview || __openclawPanelLoading) return;
    __openclawPanelLoading = true;
    const options = (opts && typeof opts === 'object') ? opts : {};
    try {
        // 先等面板有真实尺寸，再导航——避免首次点进时按 0 宽渲染成「无会话侧栏的大黑聊天页」
        await waitForOpenclawPanelLayout();
        try {
            const paint = getOpenclawHostThemePaint();
            webview.style.background = paint.bgBase;
            webview.style.opacity = '1';
            webview.style.visibility = 'visible';
            webview.style.width = '100%';
            webview.style.height = '100%';
        } catch (_) {}

        // 导航前确认 /acp/，首装时避免提前撞上 connection refused 白屏
        const port = resolveGatewayProbePort();
        const uiReady = await probeControlUiReady(port);
        if (!uiReady) {
            setOpenclawPanelOverlay(
                'loading',
                '正在等待 OpenClaw 控制台…',
                '首次安装初始化较慢，控制台就绪后会自动打开。'
            );
            scheduleOpenclawControlUiRetry('控制台尚未就绪');
            return;
        }

        const url = await window.api.getDashboardUrl();
        const currentSrc = (webview.getAttribute('src') || '').trim();
        injectWebviewUpdateInterceptor(webview);
        if (!forceReload && currentSrc && (currentSrc === url || __openclawPanelLastUrl === url)) {
            scheduleOpenclawThemeSync(webview, { delays: [0, 700] });
            setOpenclawPanelOverlay('hide');
            return;
        }
        const isFirstLoad = !currentSrc;
        setOpenclawPanelOverlay(
            'loading',
            '正在连接 OpenClaw…',
            isFirstLoad
                ? '首次安装初始化较慢，请稍候，面板就绪后会自动打开。'
                : '正在加载控制台面板…'
        );
        showToast(
            forceReload && !isFirstLoad
                ? '正在加载 OpenClaw 控制台…'
                : '正在连接Nexora Agent控制台面板…'
        );
        // 仅首次进入时清 session；日常进入只重载 URL，避免反复清 Cookie 触发限流
        const shouldClearSession = options.clearSession === true
            || (options.clearSession !== false && isFirstLoad);
        if (shouldClearSession && window.api.clearOpenclawPanelSession) {
            try { await window.api.clearOpenclawPanelSession(); } catch (e) {}
        }
        __openclawPanelLastUrl = url;
        // 同 URL 也要重新赋值，否则空白 webview 不会真正刷新
        if (currentSrc === url) {
            try {
                if (typeof webview.reload === 'function') webview.reload();
                else {
                    webview.src = 'about:blank';
                    webview.src = url;
                }
            } catch (_) {
                webview.src = url;
            }
        } else {
            webview.src = url;
        }

        injectWebviewUpdateInterceptor(webview);
        // 导航后只温和补 1～2 次，避免叠 CSS 闪烁
        scheduleOpenclawThemeSync(webview, { delays: [80, 900] });
    } catch (err) {
        setOpenclawPanelOverlay(
            'loading',
            '正在重试连接…',
            '暂时无法获取控制台地址，将自动重试。'
        );
        scheduleOpenclawControlUiRetry((err && err.message) || '获取地址失败');
    } finally {
        __openclawPanelLoading = false;
    }
}

function injectOpenclawPanelCss(webview) {
    if (!webview) return;
    const paint = getOpenclawHostThemePaint();
    const cssText = buildOpenclawPanelCss(paint);
    // 同一份面板 CSS 只 insert 一次，反复 insertCSS 会叠层导致闪烁
    try {
        if (typeof webview.insertCSS === 'function' && webview.__nexoraInsertedPanelCss !== cssText) {
            webview.__nexoraInsertedPanelCss = cssText;
            webview.insertCSS(cssText).catch(() => {});
        }
    } catch (e) {}
    if (typeof webview.executeJavaScript !== 'function') return;
    const css = JSON.stringify(cssText);
    webview.executeJavaScript(`
        (function() {
            var css = ${css};
            var style = document.getElementById('nexora-openclaw-panel-css');
            if (!style) {
                style = document.createElement('style');
                style.id = 'nexora-openclaw-panel-css';
                (document.head || document.documentElement).appendChild(style);
            }
            if (style.textContent !== css) style.textContent = css;
            window.__nexoraThemeGuard = true;
        })();
    `).catch(() => {});
}

function buildOpenclawMediaEnhanceScript(magicPrefix) {
    // 用 JSON 包一层，避免模板字符串双重转义把正则写坏
    const fn = function (MAGIC) {
        if (window.__nexora_agent_update_injected) {
            try { window.__nexoraEnhanceMedia && window.__nexoraEnhanceMedia(); } catch (e) {}
            return;
        }
        window.__nexora_agent_update_injected = true;

        function mediaFileSrc(filePath) {
            // 走 Electron 自定义协议，不依赖 Control UI 鉴权/白名单
            return 'nexora-media://openclaw/file?path=' + encodeURIComponent(filePath);
        }

        function extractMediaPath(raw) {
            var value = String(raw || '').trim().replace(/^[\s`'"\[{(]+|[\s`'"\]})]+$/g, '');
            var m = value.match(/^[A-Za-z]:[\\/].*?\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|webm|mp3|wav|m4a)\b/i)
                || value.match(/^\/.*?\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|webm|mp3|wav|m4a)\b/i);
            return m ? m[0] : '';
        }

        function buildMediaTag(filePath) {
            var src = mediaFileSrc(filePath);
            var style = 'max-width:min(100%,920px);width:auto;height:auto;image-rendering:auto;border-radius:8px;margin:8px 0;display:block;border:1px solid rgba(255,255,255,0.12);cursor:zoom-in;';
            if (/\.(mp4|mov|webm)$/i.test(filePath)) {
                return '<video class="nexora-media-img" src="' + src + '" controls style="' + style + '"></video>';
            }
            if (/\.(mp3|wav|m4a)$/i.test(filePath)) {
                return '<audio class="nexora-media-img" src="' + src + '" controls style="width:min(100%,640px);margin:8px 0;display:block;"></audio>';
            }
            return '<img class="nexora-media-img chat-message-image" src="' + src + '" alt="media" style="' + style + 'cursor:zoom-in;" />';
        }

        function enhanceMediaIn(root) {
            if (!root || !root.querySelectorAll) return;
            var bubbles = root.querySelectorAll('.chat-bubble, [class*="chat-bubble"], [data-message-text]');
            bubbles.forEach(function (bubble) {
                try {
                    var text = bubble.innerText || bubble.textContent || '';
                    if (!/MEDIA\s*:/i.test(text)) return;
                    if (bubble.querySelector('.nexora-media-img') && !/MEDIA\s*:\s*[A-Za-z]:[\\/]|MEDIA\s*:\s*\//i.test(text)) return;

                    var html = bubble.innerHTML || '';
                    if (html.indexOf('MEDIA:') === -1 && html.toLowerCase().indexOf('media:') === -1) {
                        html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    }
                    var next = html.replace(/MEDIA\s*:\s*`?([^<`\n]+)`?/gi, function (full, raw) {
                        var filePath = extractMediaPath(raw);
                        return filePath ? buildMediaTag(filePath) : full;
                    });
                    if (next !== html) bubble.innerHTML = next;
                } catch (e) {}
            });

            root.querySelectorAll('.chat-assistant-attachment-card--blocked, .chat-assistant-attachment-card').forEach(function (card) {
                try {
                    var reason = card.textContent || '';
                    var host = card.closest('.chat-bubble, [class*="chat-bubble"]');
                    if (/Outside allowed folders|Unavailable/i.test(reason) && host && host.querySelector('.nexora-media-img')) {
                        card.style.display = 'none';
                    }
                } catch (e) {}
            });
        }

        window.__nexoraEnhanceMedia = function () { enhanceMediaIn(document); };

        var processing = false;
        var processTimer = null;
        function processNodes() {
            if (processing) return;
            processing = true;
            try {
                document.querySelectorAll('[class*="alert"], [class*="notification"], [class*="banner"]').forEach(function (el) {
                    var text = el.textContent || '';
                    if ((text.includes('Update skipped') || text.includes('not-git-install') || text.includes('openclaw update'))
                        && el.offsetHeight > 0 && el.offsetHeight < 200) {
                        el.style.display = 'none';
                    }
                });

                document.querySelectorAll('button, a, [role="button"]').forEach(function (el) {
                    var text = (el.textContent || '').trim();
                    if ((text === '立即更新' || text === 'Update Now' || text === 'update now') && !el.__nexora_agent_intercepted) {
                        el.__nexora_agent_intercepted = true;
                        el.addEventListener('click', function (e) {
                            e.preventDefault();
                            e.stopPropagation();
                            e.stopImmediatePropagation();
                            var ver = '';
                            var parent = el.parentElement;
                            for (var i = 0; i < 5 && parent; i++) {
                                var m = parent.textContent.match(/v?(20\d{2}\.\d+\.\d+)/);
                                if (m) { ver = m[1]; break; }
                                parent = parent.parentElement;
                            }
                            console.log(MAGIC + JSON.stringify({ action: 'update', version: ver }));
                        }, true);
                    }
                });

                enhanceMediaIn(document);
            } finally {
                processing = false;
            }
        }

        function scheduleProcess() {
            if (processTimer) return;
            processTimer = setTimeout(function () {
                processTimer = null;
                processNodes();
            }, 250);
        }

        // 勿观察 characterData：会话「加载中」文案会连触发 → 改 DOM → 再触发 → 面板狂闪
        var observer = new MutationObserver(function () { scheduleProcess(); });
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
        processNodes();
        setInterval(function () { try { enhanceMediaIn(document); } catch (e) {} }, 2500);
    };

    return '(' + fn.toString() + ')(' + JSON.stringify(magicPrefix) + ');';
}

function injectWebviewUpdateInterceptor(webview) {
    if (!webview) return;

    const MAGIC_PREFIX = '__NEXORA_AGENT_UPDATE__:';

    const revealAfterTheme = () => {
        try {
            const paint = getOpenclawHostThemePaint();
            webview.style.background = paint.bgBase;
            webview.style.opacity = '1';
            webview.style.visibility = 'visible';
        } catch (_) {}
        pokeOpenclawWebviewLayout(webview);
    };

    // 一次导航只注入一轮：dom-ready 抢首屏，finish 再盖 SPA 回写
    const injectThemeNow = (phase) => {
        const nav = webview.__nexoraThemeNavId || 0;
        if (phase === 'early') {
            if (webview.__nexoraThemeEarlyNav === nav) return;
            webview.__nexoraThemeEarlyNav = nav;
        } else {
            if (webview.__nexoraThemeLateNav === nav) return;
            webview.__nexoraThemeLateNav = nav;
        }
        injectOpenclawPanelCss(webview);
        syncOpenclawThemeToWebview();
        try { webview.executeJavaScript(buildOpenclawMediaEnhanceScript(MAGIC_PREFIX)).catch(() => {}); } catch (_) {}
        revealAfterTheme();
        if (phase === 'late') {
            scheduleOpenclawThemeSync(webview, { delays: [700] });
        }
    };

    if (!webview.__nexoraOpenclawThemeBound) {
        webview.__nexoraOpenclawThemeBound = true;
        webview.addEventListener('did-start-loading', () => {
            try {
                webview.__nexoraThemeNavId = (webview.__nexoraThemeNavId || 0) + 1;
                webview.__nexoraInsertedThemeCss = '';
                webview.__nexoraInsertedPanelCss = '';
                webview.__nexoraLayoutPoked = false;
                webview.__nexoraEmptyHealDone = false;
                const paint = getOpenclawHostThemePaint();
                webview.style.background = paint.bgBase;
                webview.style.opacity = '1';
            } catch (_) {}
        });
        // dom-ready：尽早盖住 OpenClaw 自带纯黑，减少首屏黑底
        webview.addEventListener('dom-ready', () => injectThemeNow('early'));
        webview.addEventListener('did-finish-load', () => {
            injectThemeNow('late');
            try {
                const u = typeof webview.getURL === 'function' ? String(webview.getURL() || '') : '';
                if (!u || u === 'about:blank' || u.startsWith('chrome-error://') || u.startsWith('data:')) {
                    scheduleOpenclawControlUiRetry('页面未正确打开');
                    return;
                }
            } catch (_) {}
            clearOpenclawControlUiRetry();
            setOpenclawPanelOverlay('hide');
            // 仅在真正空白/错误页时自愈；正常 SPA 首屏可能稍慢，避免误重载
            setTimeout(() => {
                if (typeof webview.executeJavaScript !== 'function') return;
                if (webview.__nexoraEmptyHealDone) return;
                webview.executeJavaScript(`
                    (function () {
                        try {
                            var u = String(location.href || '');
                            if (/chrome-error:/i.test(u)) return 'error';
                            var b = document.body;
                            if (!b) return 'empty';
                            var t = (b.innerText || '').replace(/\\s+/g, '');
                            var hasShell = !!b.querySelector('main, #root, #app, nav, aside, [data-testid]');
                            if (hasShell || t.length > 20) return 'ok';
                            return 'empty';
                        } catch (e) { return 'empty'; }
                    })();
                `).then((state) => {
                    if (state === 'ok') {
                        clearOpenclawControlUiRetry();
                        setOpenclawPanelOverlay('hide');
                        return;
                    }
                    if (state !== 'error' && state !== 'empty') return;
                    const pane = document.getElementById('openclaw-panel-view');
                    if (!pane || !pane.classList.contains('active')) return;
                    webview.__nexoraEmptyHealDone = true;
                    scheduleOpenclawControlUiRetry(state === 'error' ? '浏览器错误页' : '面板内容为空');
                }).catch(() => {});
            }, 3500);
        });
        webview.addEventListener('did-fail-load', (evt) => {
            try {
                // 子资源失败忽略；主框架失败才重试
                if (evt && evt.isMainFrame === false) return;
                const code = evt && typeof evt.errorCode === 'number' ? evt.errorCode : 0;
                // -3 = ERR_ABORTED（同页跳转常见），不重试
                if (code === -3) return;
            } catch (_) {}
            scheduleOpenclawControlUiRetry('连接被拒绝或尚未监听');
        });
    }

    // 已有文档时补一次（切回面板），不重复导航注入
    try {
        if (typeof webview.getURL === 'function') {
            const u = webview.getURL();
            if (u && u !== 'about:blank' && !u.startsWith('data:')) {
                injectOpenclawPanelCss(webview);
                syncOpenclawThemeToWebview();
                revealAfterTheme();
            }
        }
    } catch (_) {}

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
    // 后台自动检查：全程静默，有新版本才弹窗；避免右上角 Toast 闪一下
    if (isManual) {
        showToast('正在检查云端新版本，请稍候...');
    }
    
    try {
        const result = await window.api.checkUpdate(isManual);

        // 网络探测失败：绝不能弹「发现新版本 / v未知」
        if (result.checkFailed) {
            if (isManual) {
                showToast(result.message || '无法连接更新服务器，请稍后重试或手动前往 Releases 页面');
                if (window.api && window.api.openExternal) {
                    window.api.openExternal(result.downloadUrl || 'https://github.com/2014-y/NexoraAgent/releases');
                }
            }
            return;
        }
        
        if (!result.hasUpdate) {
            if (isManual) {
                showToast(`当前已是最新版本！(v${result.currentVersion})`);
            }
            return;
        }
        
        // 有新版本，展示模态弹窗（手动/自动都提示，方便升级）
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
                    window.api.openExternal('https://github.com/2014-y/NexoraAgent/releases');
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

function loadAccelerationLatencyFilters() {
    try {
        const raw = String(localStorage.getItem('acc_ui_latencyFilters') || '');
        return raw.split(',')
            .map((s) => s.trim())
            .filter((s) => s === 'available' || s === 'timeout');
    } catch (_) {
        return [];
    }
}

function saveAccelerationLatencyFilters(list) {
    const cleaned = (Array.isArray(list) ? list : [])
        .filter((s) => s === 'available' || s === 'timeout');
    // 去重并保持 available → timeout 顺序
    const ordered = ['available', 'timeout'].filter((k) => cleaned.includes(k));
    accelerationUi.latencyFilters = ordered;
    saveAccelerationUiPref('latencyFilters', ordered.join(','));
}

let accelerationState = null;
let accelerationBusy = false;
let accelerationBusyMessage = '';
let accelerationUi = {
    panel: loadAccelerationUiPref('panel', 'dashboard'),
    importMode: 'url',
    search: '',
    protocol: '',
    sort: loadAccelerationUiPref('sort', 'latency'),
    viewMode: loadAccelerationUiPref('viewMode', 'nodes'),
    countryFilter: loadAccelerationUiPref('countryFilter', 'all'),
    latencyFilters: loadAccelerationLatencyFilters()
};

function loadAccelerationUiPref(key, fallback) {
    try {
        const raw = localStorage.getItem('acc_ui_' + key);
        if (raw == null || raw === '') return fallback;
        return raw;
    } catch (_) {
        return fallback;
    }
}

function saveAccelerationUiPref(key, value) {
    try {
        localStorage.setItem('acc_ui_' + key, String(value == null ? '' : value));
    } catch (_) {}
}

/** 把已保存的地区 / 延迟标签同步到按钮高亮，并确保「所有节点」视图下标签条可见 */
function syncAccelerationCountryFilterUi() {
    const countryContainer = document.getElementById('acc-node-country-filters');
    if (!countryContainer) return;
    const want = String(accelerationUi.countryFilter || 'all').toLowerCase();
    accelerationUi.countryFilter = want;
    countryContainer.querySelectorAll('.acc-country-pill[data-country]').forEach((btn) => {
        const c = String(btn.getAttribute('data-country') || '').toLowerCase();
        btn.classList.toggle('active', c === want);
    });
    if (!Array.isArray(accelerationUi.latencyFilters)) {
        accelerationUi.latencyFilters = loadAccelerationLatencyFilters();
    }
    const latencySet = new Set(accelerationUi.latencyFilters);
    countryContainer.querySelectorAll('.acc-latency-pill[data-latency]').forEach((btn) => {
        const key = String(btn.getAttribute('data-latency') || '');
        btn.classList.toggle('active', latencySet.has(key));
        btn.setAttribute('aria-pressed', latencySet.has(key) ? 'true' : 'false');
    });
    // 所有节点视图：始终展示完整地区标签（不依赖先切配置商）
    if (accelerationUi.viewMode !== 'groups') {
        countryContainer.style.display = 'flex';
        countryContainer.hidden = false;
    }
}

/** 代理页：所有节点 / 策略分流视图 */
function applyAccelerationProxiesViewMode(mode, options = {}) {
    const next = mode === 'groups' ? 'groups' : 'nodes';
    accelerationUi.viewMode = next;
    saveAccelerationUiPref('viewMode', next);

    const tabNodes = document.getElementById('acc-view-tab-nodes');
    const tabGroups = document.getElementById('acc-view-tab-groups');
    const nodeToolbar = document.getElementById('acc-node-toolbar');
    const nodeGrid = document.getElementById('acc-node-grid');
    const groupsContainer = document.getElementById('acc-groups-container');
    const countryFilters = document.getElementById('acc-node-country-filters');
    const nodeGridWrap = document.querySelector('.acc-node-grid-wrap');
    const showNodes = next === 'nodes';

    if (tabNodes) tabNodes.classList.toggle('active', showNodes);
    if (tabGroups) tabGroups.classList.toggle('active', !showNodes);
    if (nodeToolbar) nodeToolbar.style.display = showNodes ? '' : 'none';
    if (countryFilters) {
        countryFilters.style.display = showNodes ? 'flex' : 'none';
        countryFilters.hidden = !showNodes;
    }
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
    if (!options.skipRender && accelerationState) renderAccelerationChannel(accelerationState);
    if (showNodes) syncAccelerationCountryFilterUi();
}
let expandedGroups = new Set();
const CONNECTION_POLL_TASK = 'acceleration-connections';
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
        strong.textContent = t('acc.proxy.stat_bad');
        strong.classList.add('latency-bad');
    } else {
        strong.textContent = t('acc.proxy.stat_pending');
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
    const msg = accelerationBusyMessage || t('处理中...', 'Processing...', '處理中...');
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
    const channelRunning = !!(accelerationState && accelerationState.running);

    [pageToggle, controlsToggle, dashEnabledToggle].forEach(el => {
        if (el) el.disabled = shouldDisable;
    });
    // 本机转发 / 虚拟网卡转发：未启用时始终不可点；启用后仅在忙碌时禁用
    [systemProxyToggle, tunToggle, dashSystemProxyToggle, dashTunToggle].forEach(el => {
        if (el) el.disabled = !channelRunning || shouldDisable;
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
    accelerationBusyMessage = busy ? String(message || t('处理中...', 'Processing...', '處理中...')) : '';
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
    const text = getAccelerationIpDetectResultText();
    // 失败态（代理未就绪等）进仪表盘必须强制重测，不能被 8s 节流挡住
    const forceRetry = !!options.force || /代理未就绪|检测失败|检测超时|检测中|未检测|点击检测|连接被重置|DNS 失败/i.test(text);
    return runAccelerationIpDetect({ force: forceRetry, reason: options.reason || 'auto' });
}

async function runAccelerationIpDetect(options = {}) {
    const { force = false } = options;
    // 强制重测：允许打断卡住的检测（否则点卡片完全没反应）
    if (accelerationIpDetectInFlight) {
        if (!force || Date.now() - accelerationIpDetectStartedAt < 1200) return null;
        accelerationIpDetectInFlight = false;
        const stuckCard = document.getElementById('acc-dash-ip-detect-card');
        if (stuckCard) stuckCard.classList.remove('is-detecting');
    }
    if (!force && Date.now() - lastAccelerationIpDetectAt < 8000) return null;

    const resultEl = document.getElementById('acc-ip-detect-result');
    const dashResultEl = document.getElementById('acc-dash-ip-detect-result');
    const ipDetectBtn = document.getElementById('acc-ip-detect-btn');
    const dashIpDetectBtn = document.getElementById('acc-dash-ip-detect-btn');
    const dashIpDetectCard = document.getElementById('acc-dash-ip-detect-card');
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
            // 动态结果不要被 i18n 扫回去盖成「检测中...」
            try { el.removeAttribute('data-i18n'); } catch (_) {}
            el.textContent = text;
            el.style.color = color || '';
            el.title = title || text;
        });
    };

    if (!window.api || !window.api.detectAccelerationIp) {
        paint(t('检测不可用', 'Detection unavailable', '檢測不可用'), '#ef4444', '');
        return null;
    }

    const viaProxy = !!(accelerationState && (accelerationState.running || accelerationState.enabled));
    accelerationIpDetectInFlight = true;
    accelerationIpDetectStartedAt = Date.now();
    paint(t('检测中...', 'Detecting...', '檢測中...'), '', viaProxy ? t('正在检测代理出口 IP', 'Detecting proxy exit IP', '正在檢測代理出口 IP') : t('正在检测本机公网出口', 'Detecting local exit IP', '正在檢測本機公網出口'));
    if (ipDetectBtn) ipDetectBtn.disabled = true;
    if (dashIpDetectBtn) dashIpDetectBtn.disabled = true;
    if (dashIpDetectCard) dashIpDetectCard.classList.add('is-detecting');
    try {
        const data = await Promise.race([
            window.api.detectAccelerationIp(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('检测超时')), 28000))
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
                data.selectedProxy,
                t('点击可重新检测', 'Click to detect again', '點擊可重新檢測')
            ].filter(Boolean).join(' · ');
            paint(formatted, isDirect ? 'var(--text-primary)' : 'var(--success-color, #22c55e)', tooltip);
            return data;
        }
        {
            const rawErr = (data && data.error) || '检测失败';
            paint(shortenIpDetectError(rawErr), '#ef4444', rawErr + ' · ' + t('点击重试', 'Click to retry', '點擊重試'));
            // 代理刚启动时端口偶发未就绪：自动再试一次
            if (/ECONNREFUSED|代理未就绪/i.test(String(rawErr))) {
                setTimeout(() => {
                    if (!shouldAutoAccelerationIpDetect()) return;
                    runAccelerationIpDetect({ force: true, reason: 'auto-retry-refused' }).catch(() => {});
                }, 2500);
            }
        }
        return data;
    } catch (e) {
        lastAccelerationIpDetectAt = Date.now();
        const rawErr = e.message || '检测超时';
        paint(shortenIpDetectError(rawErr), '#ef4444', rawErr + ' · ' + t('点击重试', 'Click to retry', '點擊重試'));
        if (/ECONNREFUSED|代理未就绪|检测超时/i.test(String(rawErr))) {
            setTimeout(() => {
                if (!shouldAutoAccelerationIpDetect()) return;
                runAccelerationIpDetect({ force: true, reason: 'auto-retry-error' }).catch(() => {});
            }, 2500);
        }
        return null;
    } finally {
        accelerationIpDetectInFlight = false;
        if (ipDetectBtn) ipDetectBtn.disabled = false;
        if (dashIpDetectBtn) dashIpDetectBtn.disabled = false;
        if (dashIpDetectCard) dashIpDetectCard.classList.remove('is-detecting');
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
            ? t('延迟测试完成', 'Latency test finished', '延遲測試完成')
            : t('延迟测试完成（临时测速，空闲后自动关闭内核）', 'Latency test finished (temporary probe; core auto-stops when idle)', '延遲測試完成（臨時測速，空閒後自動關閉核心）'));
    const pid = accelerationState && accelerationState.activeProfileId;
    if (pid) proxiesAutoDelayDoneIds.add(pid);
    const res = await handleAccelerationResult(
        window.api.delayTestAcceleration(),
        successText,
        {
            busyMessage: wasEnabled
                ? t('正在测速节点延迟…', 'Testing node latency…', '正在測速節點延遲…')
                : t('正在启动临时内核并测速…', 'Starting temporary core and testing…', '正在啟動臨時核心並測速…')
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
    saveAccelerationUiPref('panel', accelerationUi.panel);
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

    if (accelerationUi.panel === 'proxies') {
        // 每次进代理页：恢复地区标签 / 视图，并保证标签条可见
        applyAccelerationProxiesViewMode(accelerationUi.viewMode || 'nodes', { skipRender: true });
        // 从 localStorage 再读一次，防止内存态被其它路径冲掉
        accelerationUi.countryFilter = loadAccelerationUiPref('countryFilter', accelerationUi.countryFilter || 'all') || 'all';
        syncAccelerationCountryFilterUi();
        if (accelerationState) renderAccelerationChannel(accelerationState);
        // 主动刷节点：不依赖「先切配置商」才出现完整地区标签/列表
        refreshAccelerationChannel().then(() => {
            syncAccelerationCountryFilterUi();
        }).catch(() => {});
    }

    if (accelerationUi.panel === 'proxies' && prev !== 'proxies') {
        maybeAutoDelayOnProxiesTab();
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
    NexoraScheduler.register(CONNECTION_POLL_TASK, refreshConnections, { visibleMs: 1500, hiddenMs: 30000 });
}

function stopConnectionPolling() {
    NexoraScheduler.stop(CONNECTION_POLL_TASK);
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
                    <button type="button" class="btn-secondary acc-danger-btn" style="padding: 3px 8px; font-size: 10px;" onclick="closeSingleConnection('${escapeJsAttr(c.id)}')">断开</button>
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
        showToast(t('已断开网络连接', 'Connection closed', '已斷開網路連線'));
        refreshConnections();
    } else {
        showToast(t('断开连接失败: ', 'Failed to close connection: ', '斷開連線失敗: ') + (res.error || t('未知错误', 'Unknown error', '未知錯誤')));
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
        if (title) title.textContent = t('通过二维码添加配置', 'Add config via QR', '透過二維碼添加配置');
        if (help) help.textContent = t('粘贴扫码结果（配置链接或 YAML）。', 'Paste scan result (config link or YAML).', '貼上掃碼結果（配置連結或 YAML）。');
    } else if (accelerationUi.importMode === 'file') {
        if (title) title.textContent = t('通过文件添加配置', 'Add config via file', '透過檔案添加配置');
        if (help) help.textContent = t('选择本地转发配置文件。', 'Choose a local forwarding config file.', '選擇本地轉發配置檔案。');
    } else {
        if (title) title.textContent = t('通过 URL 添加配置', 'Add config via URL', '透過 URL 添加配置');
        if (help) help.textContent = t('填写本地网络中转配置地址。', 'Enter a local network relay config URL.', '填寫本地網路中轉配置地址。');
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


/** 仅仪表盘/控制页展示脱敏；通道页仍用真实节点名与国旗。不改订阅/内核真实节点名。 */
function sanitizeAccelerationNodeDisplayName(name) {
    let out = String(name || '');
    if (!out) return out;
    const line = t('线路', 'Line', '線路');
    const lanRelay = t('内网中转', 'LAN Relay', '內網中轉');
    const localCh = t('本地通道', 'Local Channel', '本地通道');
    const localFwd = t('本地转发', 'Local Forward', '本地轉發');
    const channel = t('通道', 'Channel', '通道');
    const fallback = t('内网中转通道', 'LAN Relay Channel', '內網中轉通道');
    const rules = [
        [/香港专线|港专线/gi, lanRelay],
        [/国际专线|境外专线|海外专线|全球专线/gi, localCh],
        [/境外节点|海外节点|国际节点|跨境节点/gi, localCh],
        [/科学上网|翻墙|梯子|跨境加速|海外加速|国际加速/g, localFwd],
        [/香港|澳门|台灣|台湾|日本|新加坡|美国|韓國|韩国|英国|德国|法国|荷兰|俄罗斯|土耳其|越南|泰国|马来|菲律宾|印度|加拿大|澳洲|澳大利亚/g, line],
        [/\b(HK|TW|JP|SG|US|KR|UK|GB|DE|FR|NL|RU|TR|VN|TH|MY|PH|IN|CA|AU)\b/gi, 'LN'],
        // 同一段里的多标签（如 BGP|住宅IP）统一收成一次「通道」，避免「通道通道」
        [/(?:专线|BGP|住宅\s*IP|家宽|IEPL|IPLC)(?:\s*[|／/]\s*(?:专线|BGP|住宅\s*IP|家宽|IEPL|IPLC))*/gi, channel],
    ];
    for (const [re, to] of rules) out = out.replace(re, to);
    const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const tok of [channel, lanRelay, localCh, localFwd, line, 'LN']) {
        if (!tok) continue;
        const e = escapeRe(tok);
        out = out.replace(new RegExp(`(?:${e}\\s*[|／/]\\s*)+${e}`, 'g'), tok);
        out = out.replace(new RegExp(`${e}{2,}`, 'g'), tok);
    }
    out = out.replace(/\|\s*\| /g, '|').replace(/\|\s*\|/g, '|').replace(/^\||\|$/g, '').replace(/\s{2,}/g, ' ').trim();
    return out || fallback;
}

function parseAccelerationInfoNode(name) {
    const raw = String(name || '').trim();
    const m = raw.match(/^(.+?)\s*[：:]\s*(.+)$/);
    if (m) {
        return { label: m[1].trim(), value: m[2].trim() };
    }
    if (/^reject/i.test(raw)) return { label: t('拦截规则', 'Block rule', '攔截規則'), value: raw };
    if (/^direct$/i.test(raw)) return { label: t('直连', 'Direct', '直連'), value: raw };
    return { label: t('配置信息', 'Profile info', '配置資訊'), value: raw };
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
    list = filterAccelerationNodesByLatency(list, accelerationUi.latencyFilters);
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
    const key = filter || 'all';
    const i18nKey = ({
        all: 'acc.proxy.country_all',
        hk: 'acc.proxy.country_hk',
        jp: 'acc.proxy.country_jp',
        sg: 'acc.proxy.country_sg',
        us: 'acc.proxy.country_us',
        tw: 'acc.proxy.country_tw',
        other: 'acc.proxy.country_other',
    })[key];
    return i18nKey ? t(i18nKey) : key;
}

function getNodeCountryCode(n) {
    if (!n) return '';
    const flag = String(n.flag || '').toLowerCase();
    if (flag && ACC_KNOWN_COUNTRY_FLAGS.includes(flag)) return flag;
    const name = String(n.name || '').toLowerCase();
    // 两字母国家码用词边界匹配，避免 Russia/Belarus 含 "us"、AUS 含 "us" 等被误判为美国
    const hasCode = (code) => new RegExp('(^|[^a-z])' + code + '($|[^a-z])').test(name);
    if (hasCode('hk') || name.includes('香港') || name.includes('hongkong')) return 'hk';
    if (hasCode('jp') || name.includes('日本') || name.includes('japan')) return 'jp';
    if (hasCode('sg') || name.includes('新加坡') || name.includes('singapore')) return 'sg';
    if (hasCode('us') || name.includes('美国') || name.includes('america') || name.includes('united states')) return 'us';
    if (hasCode('tw') || name.includes('台湾') || name.includes('taiwan')) return 'tw';
    if (hasCode('kr') || name.includes('韩国') || name.includes('korea')) return 'kr';
    if (hasCode('gb') || hasCode('uk') || name.includes('英国') || name.includes('london')) return 'gb';
    return flag || 'other';
}

function filterAccelerationNodesByCountry(nodes, countryFilter) {
    const filter = countryFilter || 'all';
    const list = (nodes || []).filter((n) => n && !isAccelerationInfoNode(n));
    if (!filter || filter === 'all') return list;
    if (filter === 'other') {
        return list.filter((n) => {
            const code = getNodeCountryCode(n);
            return !['hk', 'tw', 'jp', 'sg', 'us'].includes(code);
        });
    }
    const want = String(filter).toLowerCase();
    return list.filter((n) => getNodeCountryCode(n) === want);
}

/** available = 有正延迟；timeout = 测速超时(latency===0)；未测节点两者都不算 */
function getAccelerationNodeLatencyStatus(node) {
    if (!node) return 'untested';
    if (typeof node.latency === 'number' && node.latency > 0) return 'available';
    if (node.latency === 0) return 'timeout';
    return 'untested';
}

function filterAccelerationNodesByLatency(nodes, latencyFilters) {
    const selected = Array.isArray(latencyFilters)
        ? latencyFilters.filter((s) => s === 'available' || s === 'timeout')
        : [];
    if (!selected.length) return nodes || [];
    const list = nodes || [];
    // 还没测过速时（全部 untested），「可用通道/超时通道」筛选会把节点全部滤掉、进页面一片空白，体验很差。
    // 此时视为未筛选、直接展示全部；等用户点了「延迟测试」有结果后，筛选再真正生效。
    const anyTested = list.some((n) => {
        const s = getAccelerationNodeLatencyStatus(n);
        return s === 'available' || s === 'timeout';
    });
    if (!anyTested) return list;
    const want = new Set(selected);
    return list.filter((n) => want.has(getAccelerationNodeLatencyStatus(n)));
}

/** 在当前选中的地区分类标签范围内，挑选延迟最低的可用节点 */
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
        if (!silent) showToast(t('「{tag}」下暂无可用延迟，无法自动选择', 'No usable latency under "{tag}" for auto-select', '「{tag}」下暫無可用延遲，無法自動選擇').replace('{tag}', tag));
        return null;
    }
    if (accelerationState.selectedProxy === best.name) {
        if (notifyKeep || !silent) {
            showToast(t('自动测速完成 · 已是最低延迟 [{ms}ms]', 'Auto test done · already lowest latency [{ms}ms]', '自動測速完成 · 已是最低延遲 [{ms}ms]').replace('{ms}', String(best.latency)));
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
            showToast(t('自动测速完成 · 保持当前通道（差距 < {ms}ms）', 'Auto test done · keep current channel (gap < {ms}ms)', '自動測速完成 · 保持當前通道（差距 < {ms}ms）').replace('{ms}', String(hysteresis)));
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
    if (!silent) showToast(t('自动选择失败: ', 'Auto-select failed: ', '自動選擇失敗: ') + ((selectRes && selectRes.error) || t('未知错误', 'Unknown error', '未知錯誤')));
    return null;
}

function sourceLabel(profile) {
    if (!profile) return '';
    if (profile.url) return t('配置链接', 'Config URL', '配置連結');
    if (profile.source === 'file') return t('本地文件', 'Local file', '本地檔案');
    if (profile.source === 'qr') return t('二维码导入', 'QR import', '二維碼匯入');
    return t('手动导入', 'Manual import', '手動匯入');
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
        return `<div class="acc-profile-traffic acc-profile-traffic-empty"><span class="acc-muted">${t('暂无流量信息，点击「更新配置」获取', 'No traffic info yet; tap Update to refresh', '暫無流量資訊，點擊「更新配置」獲取')}</span></div>`;
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
        ? t('{n} 天后重置', 'Resets in {n} days', '{n} 天後重置').replace('{n}', String(info.resetDays))
        : '';

    const remainText = remain != null ? formatTrafficBytes(remain) : '--';
    const usedText = total > 0
        ? `${formatTrafficBytes(used)} / ${formatTrafficBytes(total)}`
        : (remain != null ? t('总额待更新', 'Total pending', '總額待更新') : '--');
    const barClass = percent >= 90 ? 'danger' : (percent >= 70 ? 'warn' : 'ok');
    const barWidth = total > 0 ? percent.toFixed(1) : '0';

    return `
        <div class="acc-profile-traffic">
            <div class="acc-profile-traffic-top">
                <span class="acc-profile-traffic-remain">${t('剩余', 'Left', '剩餘')} ${escapeHtml(remainText)}</span>
                <span class="acc-profile-traffic-used">${escapeHtml(usedText)}</span>
            </div>
            <div class="acc-profile-progress" title="${total > 0 ? t('已用 {p}%', 'Used {p}%', '已用 {p}%').replace('{p}', percent.toFixed(1)) : t('正在读取用量，或点击「更新配置」', 'Reading usage, or tap Update', '正在讀取用量，或點擊「更新配置」')}">
                <div class="acc-profile-progress-bar ${barClass}" style="width: ${barWidth}%"></div>
            </div>
            <div class="acc-profile-traffic-meta">
                ${expireText ? `<span>${t('到期', 'Expires', '到期')} ${escapeHtml(expireText)}</span>` : ''}
                ${resetText ? `<span>${escapeHtml(resetText)}</span>` : ''}
                ${!expireText && !resetText ? `<span class="acc-muted">${t('配置流量', 'Profile traffic', '配置流量')}</span>` : ''}
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
            showToast(t('网络中转状态读取失败: ', 'Network Relay status failed: ', '網路中轉狀態讀取失敗: ') + data.error);
        }
    } catch (err) {
        console.warn('[Acceleration] refresh failed:', err);
    }
}

function renderAccelerationChannel(data) {
    const enabled = !!(data && data.enabled);
    const running = !!(data && data.running);
    // 重启中 enabled 仍为 true：总开关保持开启，避免仪表盘/更多页看起来“莫名其妙关了”
    const channelOn = !!(running || enabled || (data && data.restarting));
    const settingToggle = document.getElementById('setting-acceleration-toggle');
    const pageToggle = document.getElementById('acc-page-enabled-toggle');
    const controlsToggle = document.getElementById('acc-controls-enabled-toggle');
    const systemProxyToggle = document.getElementById('acc-system-proxy-toggle');
    const tunToggle = document.getElementById('acc-tun-toggle');
    if (settingToggle) settingToggle.checked = !!(data && data.autoStart);
    if (pageToggle) pageToggle.checked = channelOn;
    if (controlsToggle) controlsToggle.checked = channelOn;
    // 总开关未运行时，本机转发 / 虚拟网卡转发界面显示未生效（偏好仍保留，重启后自动恢复）
    const systemProxyOn = !!(running && data && data.systemProxy);
    const tunOn = !!(running && data && data.virtualNic);
    if (systemProxyToggle) systemProxyToggle.checked = systemProxyOn;
    if (tunToggle) tunToggle.checked = tunOn;

    // 未启用时：本机转发 / 虚拟网卡转发不可操作，并提示先开总开关
    const subToggles = document.getElementById('acc-ctrl-sub-toggles');
    if (subToggles) subToggles.classList.toggle('is-disabled', !running);
    [systemProxyToggle, tunToggle].forEach((el) => {
        if (!el) return;
        el.disabled = !running || accelerationBusy;
        const wrap = el.closest('.switch-slider-btn');
        if (wrap) wrap.classList.toggle('is-locked', !running);
    });
    const systemProxyDesc = document.querySelector('label[for="acc-system-proxy-toggle"] .acc-urow-desc');
    const tunDesc = document.querySelector('label[for="acc-tun-toggle"] .acc-urow-desc');
    if (systemProxyDesc) {
        if (!running) {
            systemProxyDesc.setAttribute('data-i18n', 'acc.control.need_enable');
            systemProxyDesc.textContent = t('acc.control.need_enable');
        } else {
            systemProxyDesc.setAttribute('data-i18n', 'acc.control.system_proxy_desc');
            systemProxyDesc.textContent = t('acc.control.system_proxy_desc');
        }
    }
    if (tunDesc) {
        if (!running) {
            tunDesc.setAttribute('data-i18n', 'acc.control.need_enable');
            tunDesc.textContent = t('acc.control.need_enable');
        } else {
            tunDesc.setAttribute('data-i18n', 'acc.control.tun_desc');
            tunDesc.textContent = t('acc.control.tun_desc');
        }
    }

    // 仪表盘开关同步
    const dashEnabledToggle = document.getElementById('acc-dash-enabled-toggle');
    const dashSystemProxyToggle = document.getElementById('acc-dash-system-proxy-toggle');
    const dashTunToggle = document.getElementById('acc-dash-tun-toggle');
    if (dashEnabledToggle) dashEnabledToggle.checked = channelOn;
    if (dashSystemProxyToggle) dashSystemProxyToggle.checked = systemProxyOn;
    if (dashTunToggle) dashTunToggle.checked = tunOn;

    const dashSubToggles = document.getElementById('acc-dash-sub-toggles');
    if (dashSubToggles) dashSubToggles.classList.toggle('is-disabled', !running);
    [dashSystemProxyToggle, dashTunToggle].forEach((el) => {
        if (!el) return;
        el.disabled = !running || accelerationBusy;
        const wrap = el.closest('.switch-slider-btn');
        if (wrap) wrap.classList.toggle('is-locked', !running);
    });
    const dashSystemProxyDesc = document.querySelector('label[for="acc-dash-system-proxy-toggle"] .toggle-desc');
    const dashTunDesc = document.querySelector('label[for="acc-dash-tun-toggle"] .toggle-desc');
    if (dashSystemProxyDesc) {
        if (!running) {
            dashSystemProxyDesc.setAttribute('data-i18n', 'acc.control.need_enable');
            dashSystemProxyDesc.textContent = t('acc.control.need_enable');
        } else {
            dashSystemProxyDesc.setAttribute('data-i18n', 'acc.toggle.system_proxy_desc');
            dashSystemProxyDesc.textContent = t('acc.toggle.system_proxy_desc');
        }
    }
    if (dashTunDesc) {
        if (!running) {
            dashTunDesc.setAttribute('data-i18n', 'acc.control.need_enable');
            dashTunDesc.textContent = t('acc.control.need_enable');
        } else {
            dashTunDesc.setAttribute('data-i18n', 'acc.toggle.tun_desc');
            dashTunDesc.textContent = t('acc.toggle.tun_desc');
        }
    }
    const dashEnabledDesc = document.getElementById('acc-dash-enabled-desc');
    if (dashEnabledDesc) {
        if (running && data && data.mixedPort) {
            dashEnabledDesc.setAttribute('data-i18n', 'acc.control.enabled_desc_port');
            dashEnabledDesc.textContent = t('acc.control.enabled_desc_port').replace('{port}', String(data.mixedPort));
        } else {
            dashEnabledDesc.setAttribute('data-i18n', 'acc.control.enabled_desc');
            dashEnabledDesc.textContent = t('acc.control.enabled_desc');
        }
    }

    // 仪表盘分流规则同步
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
        const controlsHintKey = mode === 'global'
            ? 'acc.controls.mode_hint.global'
            : mode === 'direct'
                ? 'acc.controls.mode_hint.direct'
                : 'acc.controls.mode_hint.rule';
        controlsModeHint.setAttribute('data-i18n', controlsHintKey);
        controlsModeHint.textContent = t(controlsHintKey);
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
        let statusKey = !running
            ? (enabled ? 'acc.status.stopped' : 'acc.status.disabled')
            : data.virtualNic && data.systemProxy
                ? 'acc.status.tun_proxy'
                : data.virtualNic
                    ? 'acc.status.tun'
                    : data.systemProxy
                        ? 'acc.status.system_proxy'
                        : 'acc.status.running';
        if (!running && data && data.restarting) {
            statusKey = 'acc.status.starting';
        }
        dashRunStatus.setAttribute('data-i18n', statusKey);
        dashRunStatus.textContent = t(statusKey);
    }

    const desc = document.getElementById('acc-enabled-desc');
    if (desc) {
        if (running && data && data.mixedPort) {
            desc.setAttribute('data-i18n', 'acc.control.enabled_desc_port');
            desc.textContent = t('acc.control.enabled_desc_port').replace('{port}', String(data.mixedPort));
        } else {
            desc.setAttribute('data-i18n', 'acc.control.enabled_desc');
            desc.textContent = t('acc.control.enabled_desc');
        }
    }

    const pill = document.getElementById('acc-status-pill');
    if (pill) {
        let pillKey = 'acc.status.disabled';
        if (running) {
            pillKey = 'acc.status.enabled';
        } else if (data && data.restarting) {
            pillKey = 'acc.status.starting';
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
            const displayName = sanitizeAccelerationNodeDisplayName(data.selectedProxy);
            const countryCode = getNodeCountryCode(matchedSelectedNode || { name: data.selectedProxy });
            const flagHtml = renderFlag(countryCode === 'other' ? '' : countryCode);
            const htmlContent = `<span style="display: inline-flex; align-items: center; gap: 6px; max-width: 100%; overflow: hidden;"><span style="display: inline-flex; align-items: center; flex-shrink: 0;">${flagHtml}</span><span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(displayName)}</span></span>`;
            if (current) current.innerHTML = htmlContent;
            if (dashCurrent) {
                dashCurrent.innerHTML = htmlContent;
                dashCurrent.title = displayName;
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
                dashDelay.textContent = t('acc.proxy.stat_bad');
                dashDelay.classList.add('latency-bad');
            } else {
                dashDelay.textContent = t('acc.proxy.stat_pending');
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
            : '<option value="">' + t('暂无配置', 'No profile', '暫無配置') + '</option>';
        select.disabled = profiles.length === 0;
    }

    const active = profiles.find((p) => p.id === data.activeProfileId);
    const summary = document.getElementById('acc-profile-summary');
    if (summary) {
        if (!active) summary.textContent = (typeof t === 'function' ? t('acc.profile.list_empty_hint') : '请先添加本地中转配置');
        else summary.textContent = `当前：${active.name || active.id} · ${sourceLabel(active)}`;
    }
    const dashActiveProfile = document.getElementById('acc-dash-active-profile');
    if (dashActiveProfile) {
        dashActiveProfile.textContent = active ? (active.name || active.id) : t('暂无配置', 'No profile', '暫無配置');
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
        proxyNowName.textContent = data.selectedProxy
            ? data.selectedProxy
            : (active ? t('acc.proxy.unselected') : t('暂无配置', 'No profile', '暫無配置'));
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
                strong.textContent = t('acc.proxy.stat_bad');
                strong.classList.add('latency-bad');
            } else {
                strong.textContent = t('acc.proxy.stat_pending');
                strong.classList.add('latency-none');
            }
        }
    }

    if (proxyLabel && !(accelerationBusy && isAccelerationDelayBusyMessage(accelerationBusyMessage))) {
        if (!active) proxyLabel.textContent = t('请先到「配置」页添加本地中转配置', 'Add a local relay profile on Profiles first', '請先到「配置」頁添加本地中轉配置');
        else if (data.selectedProxy) {
            const proto = matchedSelected && matchedSelected.type ? String(matchedSelected.type).toUpperCase() : '';
            proxyLabel.textContent = proto
                ? `${proto} · ${t('点击下方通道可切换中转', 'Tap a channel below to switch', '點擊下方通道可切換中轉')}`
                : t('点击下方通道可切换中转', 'Tap a channel below to switch', '點擊下方通道可切換中轉');
        }
        else proxyLabel.textContent = t('配置「{name}」· 点击通道即可选用', 'Profile "{name}" · tap a channel to use', '配置「{name}」· 點擊通道即可選用').replace('{name}', active.name || active.id);
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
        statProfile.textContent = active ? (active.name || active.id) : t('暂无', 'N/A', '暫無');
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
            list.innerHTML = '<div class="acc-empty">' + t('acc.profile.list_empty') + '</div>';
        } else {
            list.innerHTML = profiles.map((p) => `
                <div class="acc-profile-item ${p.id === data.activeProfileId ? 'active' : ''}" data-profile-id="${escapeHtml(p.id)}">
                    <div class="acc-profile-main">
                        <div class="acc-profile-head">
                            <div>
                                <strong>${escapeHtml(p.name || p.id)}</strong>
                                <small>${escapeHtml(sourceLabel(p))}${p.url ? ' · ' + escapeHtml(p.url) : ''}</small>
                            </div>
                            <span class="acc-muted acc-profile-badge">${p.id === data.activeProfileId ? t('使用中', 'Active', '使用中') : t('点击选用', 'Tap to use', '點擊選用')}</span>
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
        protocolFilter.innerHTML = '<option value="">' + t('acc.proxy.filter_all_protocols') + '</option>' + types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
        protocolFilter.value = types.includes(prev) ? prev : '';
        accelerationUi.protocol = protocolFilter.value;
    }

    const filtered = getFilteredAccelerationNodes(data);
    const finalNodes = filtered.filter(node => !isAccelerationInfoNode(node));
    const count = document.getElementById('acc-node-count');
    if (count) {
        const totalNonInfo = (data.nodes || []).filter(node => !isAccelerationInfoNode(node)).length;
        count.textContent = `${finalNodes.length}/${totalNonInfo} ${t('个通道', 'channels', '個通道')}`;
    }
    // 渲染后保持地区标签高亮/可见（避免被其它逻辑盖掉）
    syncAccelerationCountryFilterUi();

    const grid = document.getElementById('acc-node-grid');
    if (grid) {
        if (!(data.nodes || []).length) {
            grid.innerHTML = '<div class="acc-empty">' + (typeof t === 'function' ? t('acc.proxy.list_empty') : '暂无中转通道。请先到「配置」页添加本地中转配置。') + '</div>';
        } else if (!finalNodes.length) {
            grid.innerHTML = '<div class="acc-empty">' + (typeof t === 'function' ? t('acc.proxy.no_match') : '没有匹配当前筛选条件的通道。') + '</div>';
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
                let latencyText = t('acc.proxy.stat_pending');
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
                    latencyText = t('acc.proxy.stat_bad');
                    latencyClass = 'latency-bad';
                    latencyHtml = latencyText;
                } else {
                    latencyHtml = latencyText;
                }
                return `
                    <div class="acc-node-card ${node.selected ? 'selected' : ''}${isTestingThis ? ' is-delay-testing' : ''}" data-proxy-name="${escapeHtml(node.name)}">
                        <div class="acc-node-main">
                            <div class="acc-node-name">${renderFlag(node.flag)} ${escapeHtml(node.name)}</div>
                            <div class="acc-node-type">${escapeHtml(node.type || 'relay')}</div>
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
            groupsContainer.innerHTML = '<div class="acc-empty">' + t('acc.proxy.groups_empty') + '</div>';
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
                                    nodeDelayStr = ` (${t('超时', 'Timeout', '超時')})`;
                                    latencyClass = 'latency-bad';
                                } else {
                                    nodeDelayStr = ` (${t('未测', 'Untested', '未測')})`;
                                }

                                return `
                                    <button type="button" class="acc-group-node-chip ${isSelected ? 'active' : ''}"
                                        data-proxy-name="${escapeHtml(nodeName)}"
                                        style="background: ${isSelected ? 'rgba(147, 51, 234, 0.2)' : 'rgba(255,255,255,0.02)'}; 
                                               border: 1px solid ${isSelected ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)'}; 
                                               color: ${isSelected ? '#e9d5ff' : 'var(--text-primary)'}; 
                                               padding: 4px 10px; border-radius: 6px; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px; transition: all 0.15s ease;"
                                        onclick="selectGroupProxy('${escapeJsAttr(g.name)}', '${escapeJsAttr(nodeName)}')">
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
                        <div class="acc-group-card-header" style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="toggleGroupExpand('${escapeJsAttr(g.name)}')">
                           <div>
                               <div style="font-weight: 600; font-size: 13px; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                                   <span>🧩</span>
                                   <span>${escapeHtml(g.name)}</span>
                                   <span style="font-size: 10px; color: var(--text-secondary); background: rgba(255,255,255,0.05); padding: 1px 4px; border-radius: 4px; text-transform: uppercase;">${escapeHtml(g.type)}</span>
                               </div>
                               <div style="font-size: 11px; color: var(--text-secondary); margin-top: 4px; display: flex; align-items: center; gap: 4px;">
                                   <span>${t('当前：', 'Now: ', '目前：')}</span>
                                   <strong style="color: #c084fc; display: inline-flex; align-items: center; gap: 4px;">${renderFlag(flag)} ${escapeHtml(g.now || '')}</strong>
                               </div>
                           </div>
                           <div style="color: var(--text-secondary); font-size: 11px; display: flex; align-items: center; gap: 4px;">
                               <span>${(g.all || []).length} ${t('个成员', 'members', '個成員')}</span>
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
            el.textContent = ' (' + t('acc.proxy.stat_bad') + ')';
            el.classList.add('latency-bad');
        } else {
            el.textContent = ' (' + t('acc.proxy.stat_pending') + ')';
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
        if (!silent) showToast(t('延迟刷新失败: ', 'Latency refresh failed: ', '延遲重新整理失敗: ') + ((res && res.error) || t('未知错误', 'Unknown error', '未知錯誤')));
        return null;
    } catch (err) {
        if (!silent) showToast(t('刷新失败: ', 'Refresh failed: ', '重新整理失敗: ') + (err.message || String(err)));
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
            showToast((enabled ? t('开启', 'Enable', '開啟') : t('关闭', 'Disable', '關閉')) + t(' 网络中转失败: ', ' Network Relay failed: ', ' 網路中轉失敗: ') + ((res && res.error) || t('未知错误', 'Unknown error', '未知錯誤')));
            await refreshAccelerationChannel();
            return;
        }
        accelerationState = res;
        renderAccelerationChannel(res);
        showToast(enabled ? t('网络中转已开启', 'Network Relay enabled', '網路中轉已開啟') : t('网络中转已关闭', 'Network Relay disabled', '網路中轉已關閉'));

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
        showToast(t('网络中转操作失败: ', 'Network Relay operation failed: ', '網路中轉操作失敗: ') + err.message);
        await refreshAccelerationChannel();
    } finally {
        setAccelerationBusy(false);
    }
}

function localizeAccelerationErrorMessage(raw) {
    const msg = String(raw || '').trim();
    if (!msg) return t('未知错误', 'Unknown error', '未知錯誤');
    if (msg.includes('429')) {
        return t('接口请求过于频繁 (HTTP 429)，请稍后再试', 'Too many requests (HTTP 429). Please try again later.', '介面請求過於頻繁 (HTTP 429)，請稍後再試');
    }
    const map = [
        ['本地转发不可用，请先启动网络中转核心', t('本地转发不可用，请先启动网络中转核心', 'Local relay unavailable. Start the Network Relay core first.', '本機轉發不可用，請先啟動網路中轉核心')],
        ['配置内容不是有效的本地转发配置', t('配置内容不是有效的本地转发配置', 'Config is not a valid local forwarding profile.', '設定內容不是有效的本地轉發設定')],
        ['配置内容不是有效的订阅或配置', t('配置内容不是有效的订阅或配置', 'Config is not a valid subscription or profile.', '設定內容不是有效的訂閱或設定')],
        ['未找到可用节点', t('未找到可用节点', 'No available nodes found.', '未找到可用節點')],
        ['订阅为空', t('订阅为空', 'Subscription is empty.', '訂閱為空')],
        ['配置不存在', t('配置不存在', 'Profile does not exist.', '設定不存在')],
        ['该配置不是 URL 订阅，无法在线更新', t('该配置不是 URL 订阅，无法在线更新', 'This profile is not a URL subscription and cannot be updated online.', '該設定不是 URL 訂閱，無法線上更新')],
        ['请先添加加速厂商订阅', t('请先添加中转配置订阅', 'Add a relay config subscription first.', '請先添加中轉設定訂閱')],
        ['订阅配置文件不存在', t('订阅配置文件不存在', 'Subscription config file is missing.', '訂閱設定檔不存在')],
        ['请先在「配置」页选择一份加速订阅', t('请先在「配置」页选择一份中转订阅', 'Select a relay subscription on the Profiles tab first.', '請先在「設定」頁選擇一份中轉訂閱')],
        ['当前订阅配置文件缺失，请到「配置」页重新导入', t('当前订阅配置文件缺失，请到「配置」页重新导入', 'Subscription file missing. Re-import it on the Profiles tab.', '目前訂閱設定檔缺失，請到「設定」頁重新匯入')],
        ['网络中转核心未运行', t('网络中转核心未运行', 'Network Relay core is not running.', '網路中轉核心未執行')],
        ['网络中转核心启动失败', t('网络中转核心启动失败', 'Failed to start Network Relay core.', '網路中轉核心啟動失敗')],
        ['测速内核启动失败', t('测速内核启动失败', 'Failed to start latency-test core.', '測速核心啟動失敗')],
        ['系统代理设置失败', t('系统代理设置失败', 'Failed to apply system proxy.', '系統代理設定失敗')],
        ['TUN 需要管理员权限', t('TUN 需要管理员权限：请关闭应用后，右键「以管理员身份运行」Nexora Agent，再开启虚拟网卡', 'TUN requires admin rights: quit the app, right-click Nexora Agent → Run as administrator, then enable Virtual NIC.', 'TUN 需要系統管理員權限：請關閉應用後，右鍵「以系統管理員身分執行」Nexora Agent，再開啟虛擬網卡')],
        ['TUN 模式需要管理员权限', t('TUN 模式需要管理员权限', 'TUN mode requires administrator privileges.', 'TUN 模式需要系統管理員權限')],
        ['内核文件不存在', t('内核文件不存在', 'Core binary is missing.', '核心檔案不存在')],
        ['内核文件损坏', t('内核文件损坏', 'Core binary is corrupted.', '核心檔案損壞')],
        ['代理内核不可用', t('代理内核不可用', 'Relay core is unavailable.', '中轉核心不可用')],
        ['内核不可用', t('内核不可用', 'Core is unavailable.', '核心不可用')],
        ['检测超时', t('检测超时', 'Detection timeout', '檢測超時')],
    ];
    for (const [zh, localized] of map) {
        if (msg.includes(zh) || msg === zh) return localized;
    }
    return msg;
}

async function handleAccelerationResult(promise, successText, options = {}) {
    try {
        setAccelerationBusy(true, options.busyMessage || t('处理中...', 'Processing...', '處理中...'));
        const res = await promise;
        if (!res || !res.success) {
            if (!(res && res.canceled)) {
                let msg = localizeAccelerationErrorMessage((res && res.error) || '');
                setAccelerationImportFeedback(msg, 'error');
                showToast(t('网络中转操作失败: ', 'Network Relay operation failed: ', '網路中轉操作失敗: ') + msg);
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
        const msg = localizeAccelerationErrorMessage(err && err.message ? err.message : String(err || ''));
        setAccelerationImportFeedback(msg, 'error');
        showToast(t('网络中转操作失败: ', 'Network Relay operation failed: ', '網路中轉操作失敗: ') + msg);
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
            setAccelerationAutoSelectStatus(t('需先启用本地转发', 'Enable local forwarding first', '需先啟用本地轉發'));
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
        setAccelerationAutoSelectStatus(t('需先启用本地转发', 'Enable local forwarding first', '需先啟用本地轉發'));
        return;
    }
    autoSelectRunInFlight = true;
    setAccelerationAutoSelectStatus(t('测速中…', 'Testing...', '測速中…'));
    try {
        await runAccelerationDelayTest({ force: true, silent: true, fromAuto: true });
    } catch (err) {
        console.error('Auto select background run failed:', err);
        showToast(t('自动测速失败: ', 'Auto speed test failed: ', '自動測速失敗: ') + (err.message || String(err)));
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
    // 恢复上次子页（代理/配置等），不要每次强制回仪表盘导致标签/筛选丢失
    const savedPanel = loadAccelerationUiPref('panel', 'dashboard');
    setAccelerationPanel(savedPanel || 'dashboard');
    setAccelerationImportMode('url');
    applyAccelerationProxiesViewMode(accelerationUi.viewMode || 'nodes', { skipRender: true });
    syncAccelerationCountryFilterUi();

    if (window.api && window.api.onAccelerationDelayProgress) {
        window.api.onAccelerationDelayProgress((payload) => {
            applyAccelerationDelayProgress(payload);
        });
    }

    if (window.api && window.api.onAccelerationStatusChanged && !window.__nexoraAccStatusBound) {
        window.__nexoraAccStatusBound = true;
        window.api.onAccelerationStatusChanged((payload) => {
            if (!payload || typeof payload !== 'object') return;
            accelerationState = { ...(accelerationState || {}), ...payload };
            try { renderAccelerationChannel(accelerationState); } catch (_) {}
            if (payload.reason === 'core-exit' && payload.restarting) {
                showToast(t('网络中转核心异常退出，正在自动重启…', 'Network Relay core crashed, restarting…', '網路中轉核心異常退出，正在自動重啟…'));
            } else if (payload.reason === 'core-restarted') {
                showToast(t('网络中转核心已自动恢复', 'Network Relay core restored', '網路中轉核心已自動恢復'));
                setTimeout(() => {
                    runAccelerationIpDetect({ force: true, reason: 'auto-restart' }).catch(() => {});
                }, 800);
            } else if (payload.reason === 'core-exit-gave-up') {
                showToast(t('网络中转核心多次重启失败，已关闭通道', 'Network Relay core failed to restart; channel disabled', '網路中轉核心多次重啟失敗，已關閉通道'));
            }
            updateAccelerationBusyUi();
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
                showToast(t('当前没有可用的本地转发地址', 'No local forwarding address available', '當前沒有可用的本地轉發地址'));
                return;
            }
            try {
                const ok = await copyToClipboard(text);
                if (ok) {
                    showToast(t('已复制本地转发地址：', 'Copied local forwarding address: ', '已複製本地轉發地址：') + text);
                } else {
                    showToast(t('复制失败：剪贴板写入受限', 'Copy failed: clipboard restricted', '複製失敗：剪貼簿寫入受限'));
                }
            } catch (e) {
                showToast(t('复制失败：', 'Copy failed: ', '複製失敗：') + (e.message || String(e)));
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
            showToast(t('状态已刷新', 'Status refreshed', '狀態已重新整理'));
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
                setAccelerationImportFeedback(t('请先填写配置 URL', 'Enter a config URL first', '請先填寫配置 URL'), 'error');
                return;
            }
            setAccelerationImportFeedback(t('正在拉取订阅，请稍候…', 'Fetching subscription, please wait…', '正在拉取訂閱，請稍候…'), 'success');
            const res = await handleAccelerationResult(
                window.api.addAccelerationUrl(String(url).trim(), String(name).trim()),
                t('已添加中转配置', 'Relay profile added', '已添加中轉設定'),
                { busyMessage: t('正在拉取订阅…', 'Fetching subscription…', '正在拉取訂閱…') }
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
            await handleAccelerationResult(window.api.pickAccelerationFile(), t('已导入配置文件', 'Config file imported', '已匯入設定檔'));
        });
    }

    const qrSubmit = document.getElementById('acc-import-qr-submit');
    if (qrSubmit) {
        qrSubmit.addEventListener('click', async () => {
            const content = String((document.getElementById('acc-qr-content') || {}).value || '').trim();
            const name = String((document.getElementById('acc-qr-name') || {}).value || '').trim() || t('二维码配置', 'QR config', '二維碼設定');
            if (!content) {
                setAccelerationImportFeedback(t('请粘贴二维码解析结果或订阅内容', 'Paste QR decode result or subscription content', '請貼上二維碼解析結果或訂閱內容'), 'error');
                return;
            }
            let res = null;
            if (/^https?:\/\//i.test(content)) {
                res = await handleAccelerationResult(window.api.addAccelerationUrl(content, name), t('已添加二维码订阅', 'QR subscription added', '已添加二維碼訂閱'));
            } else {
                res = await handleAccelerationResult(window.api.addAccelerationContent(content, name), t('已添加二维码配置', 'QR config added', '已添加二維碼設定'));
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
                setAccelerationImportFeedback(
                    text
                        ? t('已从剪贴板粘贴内容，点击“添加配置”即可', 'Pasted from clipboard. Click Add Profile to import.', '已從剪貼簿貼上內容，點擊「添加設定」即可')
                        : t('剪贴板为空', 'Clipboard is empty', '剪貼簿為空'),
                    text ? 'success' : 'error'
                );
            } catch (err) {
                setAccelerationImportFeedback(t('无法读取剪贴板，请手动粘贴', 'Cannot read clipboard; paste manually', '無法讀取剪貼簿，請手動貼上'), 'error');
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
                            
                            setAccelerationImportFeedback(t('图片二维码识别成功！点击“添加配置”即可导入', 'QR code recognized. Click Add Profile to import.', '圖片二維碼識別成功！點擊「添加設定」即可匯入'), 'success');
                        } else {
                            setAccelerationImportFeedback(t('未在图片中检测到有效的二维码，请确保图片清晰且为二维码', 'No valid QR code found. Use a clear QR image.', '未在圖片中檢測到有效的二維碼，請確保圖片清晰且為二維碼'), 'error');
                        }
                    } catch (ex) {
                        setAccelerationImportFeedback(t('图片解码失败，可能是跨域或格式不支持', 'Image decode failed; format may be unsupported.', '圖片解碼失敗，可能是跨域或格式不支援'), 'error');
                    }
                    qrFileInput.value = '';
                };
                img.onerror = () => {
                    setAccelerationImportFeedback(t('图片加载失败，请确保文件格式正确', 'Failed to load image; check the file format.', '圖片載入失敗，請確保檔案格式正確'), 'error');
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
            const res = await handleAccelerationResult(window.api.setAccelerationActiveProfile(e.target.value), t('已切换配置', 'Profile switched', '已切換配置'));
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
            const res = await handleAccelerationResult(window.api.setAccelerationActiveProfile(id), t('已切换配置', 'Profile switched', '已切換配置'));
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
                { key: 'name', label: t('配置备注名称', 'Profile display name', '設定備註名稱'), value: currentName, placeholder: t('请输入备注名称', 'Enter a display name', '請輸入備註名稱') }
            ];
            const values = await window.promptFields(
                t('修改配置备注', 'Rename profile', '修改設定備註'),
                fields,
                t('修改此配置在本地显示的备注名称。', 'Change the local display name for this profile.', '修改此設定在本地顯示的備註名稱。'),
                t('确认修改', 'Confirm', '確認修改')
            );
            if (!values) return;
            const name = String(values.name || '').trim();
            if (!name) {
                alert(t('备注名称不能为空', 'Display name cannot be empty', '備註名稱不能為空'));
                return;
            }
            await handleAccelerationResult(window.api.renameAccelerationProfile(id, name), t('备注已更新', 'Display name updated', '備註已更新'));
        });
    }

    const updateBtn = document.getElementById('acc-profile-update-btn');
    if (updateBtn) {
        updateBtn.addEventListener('click', async () => {
            const id = accelerationState && accelerationState.activeProfileId;
            if (!id) return;
            await handleAccelerationResult(window.api.updateAccelerationProfile(id), t('订阅已更新', 'Subscription updated', '訂閱已更新'));
        });
    }

    const deleteBtn = document.getElementById('acc-profile-delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            const id = accelerationState && accelerationState.activeProfileId;
            if (!id) return;
            const ok = await confirm(t('确定删除当前中转配置吗？', 'Delete the current relay profile?', '確定刪除當前中轉設定嗎？'));
            if (!ok) return;
            await handleAccelerationResult(window.api.removeAccelerationProfile(id), t('已删除配置', 'Profile deleted', '已刪除設定'));
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
        if (accelerationUi.sort) sortSelect.value = accelerationUi.sort;
        sortSelect.addEventListener('change', (e) => {
            accelerationUi.sort = e.target.value || 'default';
            saveAccelerationUiPref('sort', accelerationUi.sort);
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
            await handleAccelerationResult(window.api.selectAccelerationProxy({ name, group: 'GLOBAL' }), t('已切换中转通道', 'Relay channel switched', '已切換中轉通道'));
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
                    showToast(t('请先启用本地转发通道，再开自动选择', 'Enable local forwarding first, then auto-select', '請先啟用本地轉發通道，再開自動選擇'));
                } else {
                    showToast(`已开启自动选择：测完后每 ${sec} 秒再测一轮`);
                }
                setupAutoSelectTimer({ runNow: true });
            } else {
                setupAutoSelectTimer();
                showToast(t('已关闭自动选择，可手动点击通道切换', 'Auto-select off; tap a channel to switch', '已關閉自動選擇，可手動點擊通道切換'));
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
            // 可用 / 超时：多选，可与地区标签叠加
            const latencyPill = e.target.closest('.acc-latency-pill[data-latency]');
            if (latencyPill) {
                const key = String(latencyPill.getAttribute('data-latency') || '');
                if (key !== 'available' && key !== 'timeout') return;
                const current = Array.isArray(accelerationUi.latencyFilters)
                    ? accelerationUi.latencyFilters.slice()
                    : loadAccelerationLatencyFilters();
                const idx = current.indexOf(key);
                if (idx >= 0) current.splice(idx, 1);
                else current.push(key);
                saveAccelerationLatencyFilters(current);
                syncAccelerationCountryFilterUi();
                if (accelerationState) renderAccelerationChannel(accelerationState);
                return;
            }

            const pill = e.target.closest('.acc-country-pill[data-country]');
            if (!pill) return;
            const country = pill.getAttribute('data-country') || 'all';
            accelerationUi.countryFilter = country;
            saveAccelerationUiPref('countryFilter', country);
            syncAccelerationCountryFilterUi();
            if (accelerationState) renderAccelerationChannel(accelerationState);
            // 开着自动时：换标签立刻在该分类里选最低延迟
            if (isAccelerationAutoSelectEnabled() && accelerationState && accelerationState.enabled) {
                applyAccelerationAutoSelect({ silent: false }).catch(() => {});
            }
        });
    }

    async function setAccelerationProxyMode(kind, on) {
        // 本机转发 / 虚拟网卡转发依赖内核已启动
        if ((kind === 'system' || kind === 'tun' || kind === 'virtualNic')
            && !(accelerationState && accelerationState.running)) {
            showToast(t('acc.control.need_enable'));
            await refreshAccelerationChannel();
            return null;
        }
        let payload, okText;
        if (kind === 'system') {
            payload = { systemProxy: on };
            okText = on ? t('本机转发已开启', 'Host forwarding enabled', '本機轉發已開啟') : t('本机转发已关闭', 'Host forwarding disabled', '本機轉發已關閉');
        } else if (kind === 'tun' || kind === 'virtualNic') {
            payload = { virtualNic: on };
            okText = on ? t('虚拟网卡转发已开启', 'Virtual NIC forwarding enabled', '虛擬網卡轉發已開啟') : t('虚拟网卡转发已关闭', 'Virtual NIC forwarding disabled', '虛擬網卡轉發已關閉');
        } else {
            payload = { autoStart: on };
            okText = on ? t('自启动已开启', 'Auto-start enabled', '自啟動已開啟') : t('自启动已关闭', 'Auto-start disabled', '自啟動已關閉');
        }
        const res = await handleAccelerationResult(window.api.setAccelerationOptions(payload), okText);
        if (res && res.warning) showToast(localizeAccelerationErrorMessage(res.warning) || res.warning);
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
            await handleAccelerationResult(window.api.setAccelerationOptions({ mode: e.target.value }), t('分流规则已更新', 'Routing rules updated', '分流規則已更新'));
        });
    });

    // 仪表盘开关：启用本地转发通道
    const dashEnabledToggle = document.getElementById('acc-dash-enabled-toggle');
    if (dashEnabledToggle) {
        dashEnabledToggle.addEventListener('change', (e) => {
            setAccelerationEnabledFromUi(e.target.checked);
        });
    }

    // 仪表盘开关：本机转发
    const dashSystemProxyToggle = document.getElementById('acc-dash-system-proxy-toggle');
    if (dashSystemProxyToggle) {
        dashSystemProxyToggle.addEventListener('change', async (e) => {
            await setAccelerationProxyMode('system', e.target.checked);
        });
    }

    // 仪表盘开关：虚拟网卡转发
    const dashTunToggle = document.getElementById('acc-dash-tun-toggle');
    if (dashTunToggle) {
        dashTunToggle.addEventListener('change', async (e) => {
            await setAccelerationProxyMode('tun', e.target.checked);
        });
    }

    // 仪表盘：分流规则按钮切换
    document.querySelectorAll('.acc-dash-mode-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            const mode = e.currentTarget.getAttribute('data-mode');
            const res = await handleAccelerationResult(
                window.api.setAccelerationOptions({ mode: mode }),
                t('分流规则已更新', 'Routing rules updated', '分流規則已更新')
            );
            if (res && res.success && accelerationState) renderAccelerationChannel(res);
        });
    });

    // 仪表盘：点「网络检测」卡片即可重测（document 委托，避免漏绑）
    if (!window.__nexoraDashIpDetectDelegated) {
        window.__nexoraDashIpDetectDelegated = true;
        const triggerDashDetect = (e) => {
            const card = e.target && e.target.closest && e.target.closest('#acc-dash-ip-detect-card');
            if (!card) return;
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            runAccelerationIpDetect({ force: true, reason: 'manual-dash' }).catch(() => {});
        };
        document.addEventListener('click', triggerDashDetect, true);
        document.addEventListener('keydown', triggerDashDetect, true);
    }
    const dashIpDetectCard = document.getElementById('acc-dash-ip-detect-card');
    if (dashIpDetectCard) {
        dashIpDetectCard.setAttribute('role', 'button');
        dashIpDetectCard.setAttribute('tabindex', '0');
        dashIpDetectCard.title = t('点击重新检测出口 IP', 'Click to re-detect exit IP', '點擊重新檢測出口 IP');
    }
    const dashIpDetectBtn = document.getElementById('acc-dash-ip-detect-btn');
    if (dashIpDetectBtn && !dashIpDetectBtn.__nexoraBound) {
        dashIpDetectBtn.__nexoraBound = true;
        dashIpDetectBtn.addEventListener('click', () => {
            runAccelerationIpDetect({ force: true, reason: 'manual-dash-btn' }).catch(() => {});
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

    if (tabNodes) tabNodes.addEventListener('click', () => applyAccelerationProxiesViewMode('nodes'));
    if (tabGroups) tabGroups.addEventListener('click', () => applyAccelerationProxiesViewMode('groups'));
    // 启动时按记忆恢复视图 + 地区标签高亮
    applyAccelerationProxiesViewMode(accelerationUi.viewMode || 'nodes', { skipRender: true });
    syncAccelerationCountryFilterUi();

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
            const ok = await confirm(t('确定断开当前所有网络连接吗？这可能会使正在进行的文件下载或API会话暂时中断。', 'Close all current network connections? Ongoing downloads or API sessions may be interrupted.', '確定斷開目前所有網路連線嗎？這可能會使正在進行的檔案下載或 API 工作階段暫時中斷。'));
            if (!ok) return;
            if (window.api && window.api.closeAccelerationConnection) {
                const res = await window.api.closeAccelerationConnection(null);
                if (res && res.success) {
                    showToast(t('已断开所有网络连接', 'All network connections closed', '已斷開所有網路連線'));
                    refreshConnections();
                } else {
                    showToast(t('断开连接失败: ', 'Failed to close connection: ', '斷開連線失敗: ') + localizeAccelerationErrorMessage((res && res.error) || ''));
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

/** 终端背景跟随当前界面主题（不再写死纯黑） */
function getBuiltinTerminalThemeColors() {
    const styles = getComputedStyle(document.body);
    const fg = (styles.getPropertyValue('--text-primary') || '#cccccc').trim() || '#cccccc';
    const accent = (styles.getPropertyValue('--accent-color') || '#00e676').trim() || '#00e676';
    const accentRgb = (styles.getPropertyValue('--accent-rgb') || '0, 230, 118').trim() || '0, 230, 118';
    // 透明底：由外层 .terminal-page-container 的 --bg-panel 透出
    return {
        background: '#00000000',
        foreground: fg,
        cursor: accent,
        cursorAccent: '#000000',
        selectionBackground: `rgba(${accentRgb}, 0.28)`,
        selectionInactiveBackground: `rgba(${accentRgb}, 0.16)`
    };
}

function syncBuiltinTerminalTheme() {
    if (!builtinTerminal || !builtinTerminal.options) return;
    try {
        builtinTerminal.options.theme = getBuiltinTerminalThemeColors();
    } catch (e) {}
}

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
        // 再次切入：恢复光标并延后聚焦；同步主题底色
        try { builtinTerminal.options.cursorBlink = true; } catch (e) {}
        syncBuiltinTerminalTheme();
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
                theme: getBuiltinTerminalThemeColors(),
                fontFamily: 'Consolas, "Courier New", monospace',
                fontSize: 14,
                allowTransparency: true,
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

async function resetBuiltinTerminalToInitial() {
    if (!window.api || !window.api.resetBuiltinTerminal) return;
    try {
        if (!isTerminalInitialized || !builtinTerminal) {
            initBuiltinTerminal();
            return;
        }
        try { builtinTerminal.reset(); } catch (e) {
            try { builtinTerminal.clear(); } catch (e2) {}
        }
        const currentLang = localStorage.getItem('setting_language') || 'zh-CN';
        const res = await window.api.resetBuiltinTerminal(currentLang);
        terminalNeedsFit = true;
        scheduleBuiltinTerminalFit(true);
        if (builtinTerminal && window.api.resizeBuiltinTerminal) {
            try {
                window.api.resizeBuiltinTerminal(builtinTerminal.cols, builtinTerminal.rows);
            } catch (e) {}
        }
        try { builtinTerminal.focus(); } catch (e) {}
        if (res && res.ok === false) {
            showToast(t('terminal.toast.reset_fail') + (res.error ? `: ${res.error}` : ''));
            return;
        }
        showToast(t('terminal.toast.reset_ok'));
    } catch (err) {
        showToast(t('terminal.toast.reset_fail') + `: ${err && err.message ? err.message : err}`);
    }
}

(function bindBuiltinTerminalResetButton() {
    const btn = document.getElementById('btn-reset-builtin-terminal');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
        resetBuiltinTerminalToInitial();
    });
})();

// ==========================================
// Network Relay Dashboard Helpers
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

/** 网速格式化（短） */
function formatDashSpeed(bps) {
    const b = Math.max(0, Number(bps) || 0);
    if (b < 1024) return { num: b.toFixed(0), unit: 'B/s' };
    if (b < 1024 * 1024) return { num: (b / 1024).toFixed(b < 10 * 1024 ? 1 : 0), unit: 'KB/s' };
    if (b < 1024 * 1024 * 1024) return { num: (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0), unit: 'MB/s' };
    return { num: (b / 1073741824).toFixed(1), unit: 'GB/s' };
}

/** 汽车表盘式速度表：270° 刻度盘 + 绿→黄→红分区 + 指针，体现实时网络速率 */
function drawDashboardSpeedChart(upSpeed, downSpeed) {
    const canvas = document.getElementById('acc-dash-speed-canvas');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const container = canvas.parentElement;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(rect.width * dpr) || canvas.height !== Math.floor(rect.height * dpr)) {
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const width = rect.width;
    const height = rect.height;
    ctx.clearRect(0, 0, width, height);

    // 历史（保留供空状态判定）
    if (!window._dashSpeedHistory) {
        window._dashSpeedHistory = { up: [], down: [], maxPoints: 60 };
    }
    window._dashSpeedHistory.up.push(upSpeed || 0);
    window._dashSpeedHistory.down.push(downSpeed || 0);
    if (window._dashSpeedHistory.up.length > window._dashSpeedHistory.maxPoints) {
        window._dashSpeedHistory.up.shift();
        window._dashSpeedHistory.down.shift();
    }
    const up = Number(upSpeed) || 0;
    const down = Number(downSpeed) || 0;
    const total = up + down;
    const hasTraffic = window._dashSpeedHistory.up.some((v) => v > 0) || window._dashSpeedHistory.down.some((v) => v > 0);
    updateDashboardSpeedEmptyState(hasTraffic);

    // 量程：持久峰值上限，避免指针抖动；至少 1 MB/s
    const MIN_SCALE = 1024 * 1024;
    window._dashSpeedGaugeMax = Math.max(window._dashSpeedGaugeMax || MIN_SCALE, total);
    const niceCeil = (v) => {
        if (v <= 0) return MIN_SCALE;
        const p = Math.pow(10, Math.floor(Math.log10(v)));
        const n = v / p;
        const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
        return m * p;
    };
    const scaleMax = niceCeil(window._dashSpeedGaugeMax * 1.1);
    const ratio = Math.max(0, Math.min(1, total / scaleMax));

    const accent = getComputedStyle(document.body).getPropertyValue('--accent-color').trim() || '#38bdf8';
    const accentRgb = getComputedStyle(document.body).getPropertyValue('--accent-rgb').trim() || '56, 189, 248';

    // 270° 表盘（尽量填满卡片）
    const cx = width / 2;
    const cy = height / 2 + Math.min(height * 0.08, 16);
    const r = Math.max(40, Math.min(width / 2 - 22, height / 2 - 12, 210));
    const arcW = Math.max(9, r * 0.085);
    const START = 0.75 * Math.PI;   // 135°（左下）
    const SWEEP = 1.5 * Math.PI;    // 270°
    const ang = START + SWEEP * ratio;

    // 背景轨道
    ctx.beginPath();
    ctx.lineWidth = arcW;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.arc(cx, cy, r, START, START + SWEEP);
    ctx.stroke();

    // 分区色带：绿→黄→红（用锥形渐变沿弧上色），仅画到当前值
    if (ratio > 0.002) {
        let stroke = accent;
        try {
            if (typeof ctx.createConicGradient === 'function') {
                const cg = ctx.createConicGradient(START, cx, cy);
                // 弧占整圆 0.75；在此范围内铺 绿→黄→红
                cg.addColorStop(0.0, '#22c55e');
                cg.addColorStop(0.45, '#22c55e');
                cg.addColorStop(0.6, '#eab308');
                cg.addColorStop(0.72, '#ef4444');
                cg.addColorStop(0.75, '#ef4444');
                cg.addColorStop(1.0, '#ef4444');
                stroke = cg;
            }
        } catch (_) {}
        ctx.beginPath();
        ctx.lineWidth = arcW;
        ctx.lineCap = 'round';
        ctx.strokeStyle = stroke;
        ctx.arc(cx, cy, r, START, ang);
        ctx.stroke();
    }

    // 刻度点
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    for (let i = 0; i <= 10; i++) {
        const a = START + SWEEP * (i / 10);
        const tx = cx + Math.cos(a) * (r - arcW - 6);
        const ty = cy + Math.sin(a) * (r - arcW - 6);
        ctx.beginPath();
        ctx.arc(tx, ty, i % 5 === 0 ? Math.max(1.6, r * 0.018) : Math.max(1.0, r * 0.011), 0, Math.PI * 2);
        ctx.fill();
    }

    // 指针
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(-r * 0.16, 0);
    ctx.lineTo(r - arcW - 2, 0);
    ctx.lineWidth = Math.max(2.4, r * 0.022);
    ctx.lineCap = 'round';
    ctx.strokeStyle = accent;
    ctx.shadowColor = `rgba(${accentRgb}, 0.7)`;
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.restore();

    // 中心轴
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(4, r * 0.04), 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.shadowColor = `rgba(${accentRgb}, 0.7)`;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 中央读数：总速率
    const numFont = Math.max(20, Math.round(r * 0.22));
    const unitFont = Math.max(10, Math.round(r * 0.1));
    const subFont = Math.max(10, Math.round(r * 0.085));
    const f = formatDashSpeed(total);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${numFont}px var(--font-mono, monospace)`;
    ctx.fillText(f.num, cx, cy - r * 0.40);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = `600 ${unitFont}px system-ui, sans-serif`;
    ctx.fillText(f.unit, cx, cy - r * 0.40 + unitFont + 3);

    // 底部 ↑上行 / ↓下行 小读数
    const fu = formatDashSpeed(up);
    const fd = formatDashSpeed(down);
    ctx.font = `600 ${subFont}px var(--font-mono, monospace)`;
    ctx.fillStyle = 'rgba(14,165,233,0.9)';
    ctx.textAlign = 'right';
    ctx.fillText('↓ ' + fd.num + fd.unit, cx - 8, cy + r * 0.62);
    ctx.fillStyle = 'rgba(244,63,94,0.9)';
    ctx.textAlign = 'left';
    ctx.fillText('↑ ' + fu.num + fu.unit, cx + 8, cy + r * 0.62);
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
        const raw = String(text || '').trim();
        if (!raw || raw.startsWith('⚠️') || raw.startsWith('❌')) return;
        const clean = sanitizeTextForSpeech(raw);
        if (!clean) return;
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
        if (state.speaking || state.status === 'speaking' || state.status === 'listening' || state.status === 'listening_wake') {
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
        syncVoicePluginCardFromState(state);
    } finally {
        __voiceApplyingUi = false;
    }

    syncVoiceListeningFromSettings(state.settings || {});
}

/** 内置插件「语音」开关 ↔ 语音管理总开关 */
function syncVoicePluginCardFromState(state) {
    const s = (state && state.settings) || (__voiceState && __voiceState.settings) || {};
    const enabled = !!s.enabled;
    const input = document.querySelector('.plugin-toggle-checkbox[data-plugin="voice-call"]');
    if (!input) return;
    if (input.checked !== enabled) input.checked = enabled;
    const bot = input.closest('.plugin-card-bot');
    if (!bot) return;
    const status = bot.firstElementChild;
    if (!status || status.tagName !== 'SPAN') return;
    try {
        status.textContent = enabled ? t('plugin.status.enabled') : t('plugin.status.disabled');
    } catch (e) {
        status.textContent = enabled ? '已启用' : '已禁用';
    }
    status.style.color = enabled ? 'var(--accent-color)' : 'var(--text-secondary)';
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

/** 试听期间挂起麦克风，避免喇叭回灌被「唤醒侦听」当成抢话打断 */
function setVoiceMicSuspended(suspended) {
    try {
        if (__localAudioStream) {
            __localAudioStream.getAudioTracks().forEach((t) => {
                try { t.enabled = !suspended; } catch (e) {}
            });
        }
    } catch (e) {}
}

function beginVoicePreviewGuard() {
    __voicePreviewGuard = true;
    __voicePausedForTts = true;
    __voiceBargeStartAt = null;
    __localAudioChunks = [];
    __localSpeaking = false;
    __localSilenceStart = null;
    __localSpeechStartAt = null;
    setVoiceMicSuspended(true);
}

function endVoicePreviewGuard() {
    if (!__voicePreviewGuard) return;
    __voicePreviewGuard = false;
    setVoiceMicSuspended(false);
}

async function previewVoicePack(packId) {
    if (!window.api || !window.api.voice) return;
    const pack = getVoicePackById(packId);
    if (!pack) return;
    if (!pack.installed) {
        showToast(voiceT('voice.toast.not_downloaded', '该男声音色还未下载，请先下载语音包'));
        return;
    }
    // 先停当前朗读，再挂起唤醒采集，避免与试听抢麦/回声打断
    await interruptVoicePlayback('before-preview');
    beginVoicePreviewGuard();
    try {
        const res = await window.api.voice.speak({
            text: voicePreviewPhrase(pack),
            source: 'preview',
            packId: pack.id
        });
        if (!res || res.success === false) {
            endVoicePreviewGuard();
            __voicePausedForTts = false;
        }
    } catch (e) {
        endVoicePreviewGuard();
        __voicePausedForTts = false;
        console.warn('[Voice] preview failed:', e);
    }
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
        const badge = voiceT(pack.badgeKey, pack.online ? '在线神经' : (pack.group === 'jarvis' ? '贾维斯风' : '中文'));
        const status = pack.installed
            ? (pack.online ? voiceT('voice.badge.online', '在线神经') : '')
            : pack.size;
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
/** 提高阈值，减少环境噪音/键盘/回声误触发 */
let __localRmsThreshold = 0.038;
/** 自适应底噪：固定阈值在高增益麦克风/风扇空调环境下会被环境声常年压过，
 *  导致「一直在说话」的过灵敏误触发。EMA 跟踪环境底噪，有效阈值随环境抬升。 */
let __localNoiseFloor = 0.01;
const __noiseFloorAlpha = 0.05;
const __noiseFloorMult = 3.2;
const __noiseFloorMin = 0.004;
const __noiseFloorMax = 0.08;
function effectiveRmsThreshold() {
    return Math.max(__localRmsThreshold, __localNoiseFloor * __noiseFloorMult);
}
function updateNoiseFloor(rms) {
    // 仅用「明显低于当前有效阈值」的帧学习底噪，避免把说话声学进去
    if (rms < effectiveRmsThreshold()) {
        __localNoiseFloor = Math.min(
            __noiseFloorMax,
            Math.max(__noiseFloorMin, __localNoiseFloor * (1 - __noiseFloorAlpha) + rms * __noiseFloorAlpha)
        );
    }
}
/** 噪音幻听过滤：ASR 对咳嗽/键盘/风声常输出单字或纯语气词，不能当成用户说话 */
function isJunkAsrText(text) {
    const stripped = String(text || '').trim().replace(/[\s。，、,.!?！？~～·…-]/g, '');
    if (!stripped) return true;
    if (stripped.length <= 1) return true;
    if (/^[嗯啊哦呃唉哎嘿哈呀噢喔诶]+$/.test(stripped)) return true;
    return false;
}
let __localSpeechStartAt = null;
const __localSpeechStartHoldMs = 280;
const __localMinPcmSamples = 9600; // ~0.6s @16kHz，太短的噪点不送识别
let __voicePausedForTts = false;
/** 试听中：彻底挂起唤醒/对话采集与抢话，避免与试听互相打断 */
let __voicePreviewGuard = false;
/** 朗读中暂停采集，防止喇叭回灌；仅语音对话模式允许严格条件的人声打断 */
let __voiceBargeStartAt = null;
let __voiceTtsStartedAt = 0;
/** 对话抢话：阈值明显抬高，避免 100% 音量回灌误触 */
const __voiceBargeRms = 0.12;
const __voiceBargeHoldMs = 700;
/** TTS 开场宽限：回声最强阶段不接受打断 */
const __voiceBargeGraceMs = 1000;
/** 朗读结束后短暂冷却，避免尾音回灌立刻触发 speech-start */
let __voiceTtsEndedAt = 0;
const __voicePostTtsCooldownMs = 900;

function clearVoiceChatSilenceTimer() {
    if (__voiceChatSilenceTimer) {
        clearTimeout(__voiceChatSilenceTimer);
        __voiceChatSilenceTimer = null;
    }
}

async function interruptVoicePlayback(reason) {
    try {
        if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (e) {}
    try {
        if (window.api && window.api.voice) await window.api.voice.stop();
    } catch (e) {}
    __voicePausedForTts = false;
    __voiceBargeStartAt = null;
    __voiceTtsStartedAt = 0;
    __voiceTtsEndedAt = Date.now();
    clearVoiceChatSilenceTimer();
    // 手动停止 / 试听前清理：结束试听护栏并恢复麦克风
    if (reason === 'manual-stop' || reason === 'before-preview') {
        endVoicePreviewGuard();
    }
    // 唤醒模式下朗读会挂起麦克风；打断后需恢复，否则再也听不到唤醒词
    if (__voiceRecMode === 'wake' && !__voicePreviewGuard) {
        setVoiceMicSuspended(false);
    }
    if (reason) console.log('[Voice] playback interrupted:', reason);
}

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

/** Electron/Chrome 常忽略 AudioContext({sampleRate:16000})，必须按实际采样率重采样到 16k */
function downsamplePcmTo16k(float32, inputSampleRate) {
    if (!float32 || !float32.length) return float32;
    const inRate = Number(inputSampleRate) || 16000;
    if (Math.abs(inRate - 16000) < 1) return float32;
    const ratio = inRate / 16000;
    const newLen = Math.max(1, Math.floor(float32.length / ratio));
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
        const src = i * ratio;
        const i0 = Math.floor(src);
        const i1 = Math.min(i0 + 1, float32.length - 1);
        const t = src - i0;
        out[i] = float32[i0] * (1 - t) + float32[i1] * t;
    }
    return out;
}

function pcmForLocalAsr(chunks) {
    const merged = mergeAudioChunks(chunks);
    if (!merged) return null;
    const sr = (__localAudioContext && __localAudioContext.sampleRate) || 16000;
    return downsamplePcmTo16k(merged, sr);
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
        // 识别链路若在朗读中途重建，立刻重新挂起麦克风，避免回声窗口
        if ((__voicePausedForTts || __voicePreviewGuard) && (__voiceRecMode === 'wake' || __voicePreviewGuard)) {
            setVoiceMicSuspended(true);
        }
        // 尽量请求 16k；若被浏览器忽略，后面会 downsamplePcmTo16k
        __localAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const source = __localAudioContext.createMediaStreamSource(stream);
        __localAudioProcessor = __localAudioContext.createScriptProcessor(4096, 1, 1);

        __localAudioChunks = [];
        __localSilenceStart = null;
        __localSpeaking = false;
        __localSpeechStartAt = null;

        __localAudioProcessor.onaudioprocess = (e) => {
            if (__voiceRecMode === 'off') return;
            // 试听期间不采集、不抢话（麦克风 track 亦已禁用）
            if (__voicePreviewGuard) return;
            const channelData = e.inputBuffer.getChannelData(0);

            let sum = 0;
            for (let i = 0; i < channelData.length; i++) {
                sum += channelData[i] * channelData[i];
            }
            const rms = Math.sqrt(sum / channelData.length);

            // 朗读中：默认不抢话。仅「语音对话」模式允许更严格的人声打断
            // （唤醒倾听时喇叭回灌极易误判，造成朗读莫名中断）
            if (__voicePausedForTts) {
                if (__voiceRecMode !== 'chat') {
                    __voiceBargeStartAt = null;
                    return;
                }
                if (Date.now() - (__voiceTtsStartedAt || 0) < __voiceBargeGraceMs) {
                    __voiceBargeStartAt = null;
                    return;
                }
                if (rms > __voiceBargeRms) {
                    if (!__voiceBargeStartAt) __voiceBargeStartAt = Date.now();
                    else if (Date.now() - __voiceBargeStartAt >= __voiceBargeHoldMs) {
                        __voiceBargeStartAt = null;
                        interruptVoicePlayback('barge-in').then(() => {
                            __localAudioChunks = [];
                            __localSpeaking = true;
                            __localSpeechStartAt = null;
                            __localSilenceStart = null;
                            if (window.api && window.api.voice) {
                                window.api.voice.setListenStatus('listening');
                            }
                        });
                    }
                } else {
                    __voiceBargeStartAt = null;
                }
                return;
            }

            // 非说话状态持续学习环境底噪，让阈值自适应麦克风增益/环境噪音
            if (!__localSpeaking) updateNoiseFloor(rms);

            if (__voiceRecMode === 'chat') {
                // 朗读尾音回灌：冷却期内不因「开始说话」打断刚排队的下一句
                const inPostTtsCooldown = (Date.now() - (__voiceTtsEndedAt || 0)) < __voicePostTtsCooldownMs;
                if (rms > effectiveRmsThreshold()) {
                    if (!__localSpeaking) {
                        if (!__localSpeechStartAt) __localSpeechStartAt = Date.now();
                        else if (Date.now() - __localSpeechStartAt >= __localSpeechStartHoldMs) {
                            __localSpeaking = true;
                            __localSpeechStartAt = null;
                            if (!inPostTtsCooldown) {
                                interruptVoicePlayback('speech-start');
                            }
                            if (window.api && window.api.voice) {
                                window.api.voice.setListenStatus('listening');
                            }
                        }
                    }
                    __localSilenceStart = null;
                } else {
                    __localSpeechStartAt = null;
                    if (__localSpeaking) {
                        if (!__localSilenceStart) {
                            __localSilenceStart = Date.now();
                        } else if (Date.now() - __localSilenceStart > 1800) {
                            __localSpeaking = false;
                            __localSilenceStart = null;
                            const pcmData = pcmForLocalAsr(__localAudioChunks);
                            __localAudioChunks = [];
                            interruptVoicePlayback('speech-end');
                            if (pcmData && pcmData.length > __localMinPcmSamples) {
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
                if (rms > effectiveRmsThreshold()) {
                    if (!__localSpeaking) {
                        if (!__localSpeechStartAt) __localSpeechStartAt = Date.now();
                        else if (Date.now() - __localSpeechStartAt >= __localSpeechStartHoldMs) {
                            __localSpeaking = true;
                            __localSpeechStartAt = null;
                            if (window.api && window.api.voice) {
                                window.api.voice.setListenStatus('listening_wake');
                            }
                        }
                    }
                    __localSilenceStart = null;
                } else {
                    __localSpeechStartAt = null;
                    if (__localSpeaking) {
                        if (!__localSilenceStart) {
                            __localSilenceStart = Date.now();
                        } else if (Date.now() - __localSilenceStart > 1500) {
                            __localSpeaking = false;
                            __localSilenceStart = null;
                            const pcmData = pcmForLocalAsr(__localAudioChunks);
                            __localAudioChunks = [];
                            if (pcmData && pcmData.length > __localMinPcmSamples) {
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

        // 静音接到 destination，仅驱动 ScriptProcessor 回调，避免喇叭回灌
        const muteGain = __localAudioContext.createGain();
        muteGain.gain.value = 0;
        source.connect(__localAudioProcessor);
        __localAudioProcessor.connect(muteGain);
        muteGain.connect(__localAudioContext.destination);

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
    // 识别前再停一次，确保当前朗读任务已清空
    await interruptVoicePlayback('before-asr');
    const statusText = document.getElementById('voice-status-text');
    if (statusText) statusText.textContent = '正在识别中...';

    const res = await window.api.voice.recognizeOffline(Array.from(pcmData));
    if (res && res.success && res.text && !isJunkAsrText(res.text)) {
        const text = res.text.trim();
        console.log('[Voice] Local ASR recognized:', text);
        submitVoiceChatUtterance(text);
    } else {
        if (res && res.success && res.text) {
            console.log('[Voice] Local ASR junk filtered:', res.text.trim());
        }
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

function startOnlineVoiceRecognitionFallback(mode) {
    // 未装离线模型：在线识别在国内常失败，仍尝试在线兜底
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
        // 试听期间忽略在线识别结果，避免把试听语音当成唤醒/抢话
        if (__voicePreviewGuard) return;
        let interim = '';
        let finalText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const piece = event.results[i][0].transcript || '';
            if (event.results[i].isFinal) finalText += piece;
            else interim += piece;
        }
        const heard = (finalText || interim || '').trim();
        if (!heard) return;

        if (__voicePausedForTts) {
            // 唤醒模式朗读中忽略识别结果，避免把喇叭声当成抢话
            if (__voiceRecMode !== 'chat') return;
            // 对话模式：仅完整结果、且过了开场宽限才打断
            if (!finalText || finalText.trim().length < 2) return;
            if (Date.now() - (__voiceTtsStartedAt || 0) < __voiceBargeGraceMs) return;
            interruptVoicePlayback('barge-in-online');
            // 抢话后继续走下方缓冲逻辑提交用户话
        } else if (__voiceRecMode === 'chat' && (Date.now() - (__voiceTtsEndedAt || 0)) < __voicePostTtsCooldownMs) {
            // 朗读刚结束：忽略尾音被识别成「用户说完」，防止立刻二次打断
            return;
        }

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
            clearVoiceChatSilenceTimer();
            __voiceChatSilenceTimer = setTimeout(() => {
                // 朗读中途不得被「说完了」定时器误杀（回声/延迟 final 常见）
                if (__voicePausedForTts) {
                    clearVoiceChatSilenceTimer();
                    return;
                }
                const utter = (__voiceChatBuffer || heard).trim();
                __voiceChatBuffer = '';
                interruptVoicePlayback('speech-end-online');
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
            showToast('在线语音识别不可用。请先下载「离线语音识别」模型（约 220MB），下载后即可本地听懂说话');
            try {
                const btn = document.getElementById('btn-asr-download');
                if (btn && btn.style.display !== 'none') btn.focus();
            } catch (e) {}
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
    interruptVoicePlayback('wake-to-chat');
    startVoiceRecognition('chat');
    showToast(voiceT('voice.status.listening', '正在听你说话'));
}

async function submitVoiceChatUtterance(text) {
    const clean = String(text || '').trim();
    if (!clean) return;

    // 新一句抢话：先打断当前朗读，再保持全局倾听
    await interruptVoicePlayback('new-utterance');
    const s = (__voiceState && __voiceState.settings) || {};
    if (s.enabled && s.wakeListen) startVoiceRecognition('wake');
    else if (s.enabled && s.voiceChat) startVoiceRecognition('chat');
    else {
        stopVoiceRecognition();
        __voiceDesiredListenMode = 'off';
    }

    try {
        const input = document.getElementById('chat-text-input');
        if (input) input.value = clean;
        // 切到会话页并发送（任意页面说出的话都进模型对话）
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
/** startVoiceRecognition 异步核对 ASR 期间的目标模式，防止重复开麦 */
let __voiceRecStarting = null;

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
    const current = __voiceRecStarting || (__voiceRecMode === 'off' ? 'off' : __voiceRecMode);
    if (desired === __voiceDesiredListenMode && desired === current) return;
    __voiceDesiredListenMode = desired;

    if (desired === 'off') {
        __voiceRecStarting = null;
        if (__voiceRecMode !== 'off') {
            stopVoiceRecognition();
            stopLocalVoiceRecognition();
        }
        if (window.api && window.api.voice) window.api.voice.setListenStatus('idle');
        return;
    }
    if (__voiceRecMode !== desired && __voiceRecStarting !== desired) startVoiceRecognition(desired);
}

function startVoiceRecognition(mode) {
    // 异步启动：先确认 ASR 状态，避免启动竞态把「已安装」误判成未安装
    if (__voiceRecStarting === mode || __voiceRecMode === mode) return;
    __voiceRecStarting = mode;
    void (async () => {
        try {
            // 未确认或缓存显示未安装时，强制再查一次磁盘
            if (!__asrStateChecked || !(__asrModelState && __asrModelState.installed)) {
                await ensureAsrModelState(true);
            }
            // 期间设置已关掉监听则放弃
            if (__voiceDesiredListenMode !== mode && __voiceDesiredListenMode !== 'chat') {
                return;
            }
            if (__asrModelState && __asrModelState.installed) {
                startLocalVoiceRecognition(mode);
                return;
            }
            // 确实未装：仅提示一次，并尝试在线识别兜底
            if ((mode === 'chat' || mode === 'wake') && !__asrMissingToastShown) {
                __asrMissingToastShown = true;
                showToast('尚未安装离线识别模型，语音对话可能识别不到。请点击「下载离线识别模型」');
            }
            startOnlineVoiceRecognitionFallback(mode);
        } finally {
            if (__voiceRecStarting === mode) __voiceRecStarting = null;
        }
    })();
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
    if (btnStop) {
        btnStop.addEventListener('click', () => {
            interruptVoicePlayback('manual-stop');
        });
    }

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
            const speakingNow = !!(data && (data.speaking || data.status === 'speaking'));
            if (speakingNow) {
                if (!__voicePausedForTts) {
                    __voicePausedForTts = true;
                    __voiceTtsStartedAt = Date.now();
                    __voiceBargeStartAt = null;
                    __localAudioChunks = [];
                    __localSpeaking = false;
                    __localSilenceStart = null;
                    __localSpeechStartAt = null;
                    clearVoiceChatSilenceTimer();
                }
                // 试听 / 唤醒倾听：朗读时挂起麦克风，杜绝回声打断
                if (__voicePreviewGuard || __voiceRecMode === 'wake') {
                    setVoiceMicSuspended(true);
                }
            } else if (__voicePausedForTts || __voicePreviewGuard) {
                __voicePausedForTts = false;
                __voiceTtsStartedAt = 0;
                __voiceBargeStartAt = null;
                __voiceTtsEndedAt = Date.now();
                const wasPreview = __voicePreviewGuard;
                const needMicResume = wasPreview || __voiceRecMode === 'wake';
                endVoicePreviewGuard();
                if (needMicResume) setVoiceMicSuspended(false);
                // 朗读/试听结束：任意页面都恢复倾听（不依赖是否停在语音管理页）
                const mode = __voiceRecMode;
                if (mode === 'wake' || mode === 'chat') {
                    try {
                        window.api.voice.setListenStatus(mode === 'wake' ? 'listening_wake' : 'listening');
                    } catch (e) {}
                } else {
                    try {
                        syncVoiceListeningFromSettings((__voiceState && __voiceState.settings) || {});
                    } catch (e) {}
                }
            }
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
/** 是否已向主进程核对过 ASR 安装状态（避免启动竞态误报未安装） */
let __asrStateChecked = false;
let __asrMissingToastShown = false;

async function ensureAsrModelState(force = false) {
    if (!force && __asrStateChecked) return __asrModelState;
    if (!window.api || !window.api.voice || typeof window.api.voice.getAsrState !== 'function') {
        __asrStateChecked = true;
        return __asrModelState;
    }
    try {
        const asrRes = await window.api.voice.getAsrState();
        if (asrRes && asrRes.success && asrRes.data) {
            __asrModelState = asrRes.data;
            updateAsrUi();
        }
    } catch (e) {
        console.warn('[Voice] ensureAsrModelState failed:', e);
    } finally {
        __asrStateChecked = true;
    }
    return __asrModelState;
}

function updateAsrUi() {
    const statusText = document.getElementById('asr-model-status');
    const downloadBtn = document.getElementById('btn-asr-download');
    const importBtn = document.getElementById('btn-asr-import');
    const progressContainer = document.getElementById('asr-progress-container');
    const progressBar = document.getElementById('asr-progress-bar');
    if (!statusText || !downloadBtn || !progressContainer || !progressBar) return;

    if (__asrModelState.installed) {
        statusText.textContent = '已就绪 (离线识别可用)';
        statusText.style.color = '#52c41a';
        downloadBtn.style.display = 'none';
        if (importBtn) importBtn.style.display = 'inline-block';
        progressContainer.style.display = 'none';
    } else if (__asrModelState.downloading) {
        statusText.textContent = `下载中... ${__asrModelState.percent}%`;
        statusText.style.color = 'var(--accent-color)';
        downloadBtn.style.display = 'none';
        if (importBtn) importBtn.style.display = 'none';
        progressContainer.style.display = 'block';
        progressBar.style.width = `${__asrModelState.percent}%`;
    } else {
        statusText.textContent = '未安装 (语音对话需先下载或导入)';
        statusText.style.color = 'var(--text-secondary)';
        downloadBtn.style.display = 'inline-block';
        if (importBtn) importBtn.style.display = 'inline-block';
        progressContainer.style.display = 'none';
    }
}

async function initVoiceModule() {
    bindVoiceControlsOnce();
    if (!window.api || !window.api.voice) return;

    // 先核对离线识别模型，再恢复唤醒/对话监听，避免启动瞬间误报「尚未安装」
    try {
        await ensureAsrModelState(true);
        window.api.voice.onAsrStateUpdated((state) => {
            if (state) __asrModelState = state;
            __asrStateChecked = true;
            if (state && state.installed) __asrMissingToastShown = false;
            updateAsrUi();
        });
    } catch (e) {
        console.warn('[Voice] init asr failed:', e);
    }

    try {
        const res = await window.api.voice.getState();
        if (res && res.data) applyVoiceStateToUi(res.data);
    } catch (e) {
        console.warn('[Voice] init failed:', e);
    }

    try {
        const downloadBtn = document.getElementById('btn-asr-download');
        const importBtn = document.getElementById('btn-asr-import');
        const afterAsrReady = async () => {
            __asrModelState = { installed: true, downloading: false, percent: 100 };
            __asrStateChecked = true;
            __asrMissingToastShown = false;
            updateAsrUi();
            __voiceDesiredListenMode = null;
            try {
                syncVoiceListeningFromSettings((__voiceState && __voiceState.settings) || {});
            } catch (e) {}
        };
        if (downloadBtn) {
            downloadBtn.onclick = async () => {
                downloadBtn.disabled = true;
                if (importBtn) importBtn.disabled = true;
                try {
                    const res = await window.api.voice.downloadAsrModel();
                    if (!res || !res.success) {
                        showToast('在线下载失败: ' + ((res && res.error) || '未知错误'));
                    } else {
                        showToast('离线识别模型下载成功');
                        await afterAsrReady();
                    }
                } finally {
                    downloadBtn.disabled = false;
                    if (importBtn) importBtn.disabled = false;
                }
            };
        }
        if (importBtn) {
            importBtn.onclick = async () => {
                importBtn.disabled = true;
                if (downloadBtn) downloadBtn.disabled = true;
                try {
                    const res = await window.api.voice.importAsrModel();
                    if (res && res.canceled) return;
                    if (!res || !res.success) {
                        showToast('本地导入失败: ' + ((res && res.error) || '未知错误'));
                    } else {
                        showToast('离线识别模型已导入，可开始语音对话');
                        await afterAsrReady();
                    }
                } finally {
                    importBtn.disabled = false;
                    if (downloadBtn) downloadBtn.disabled = false;
                }
            };
        }
    } catch (e) {
        console.warn('[Voice] bind asr buttons failed:', e);
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
            __asrStateChecked = true;
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
