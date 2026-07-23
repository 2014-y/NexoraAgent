// ─── 幂等守卫 ───
// 本补丁会同时通过 execArgv(--require) 与 NODE_OPTIONS(--require) 注入, 以覆盖网关及其 spawn 出的
// 所有子进程/worker。虽然 require 缓存通常保证只执行一次, 但此守卫可彻底杜绝任何环境下的二次包裹
// (二次包裹会导致 fs.mkdir / https.request / fetch 被重复劫持)。
if (globalThis.__TOKENGUARD_PATCHED__) {
    return;
}
globalThis.__TOKENGUARD_PATCHED__ = true;

// ─── 本地模型工具调用防护 ───
// OpenClaw 默认走 Ollama 原生 /api/chat（不是 /v1/chat/completions）。
// 本地小模型看到 tools 后常把 {"name":"tts"| "update_goal", ...} 当正文吐出。
function isLlmProxyPath(pathOrUrl) {
    const s = String(pathOrUrl || '');
    if (s.includes('/api/chat/media/')) return false;
    // OpenClaw→Ollama 默认走原生 /api/chat；也兼容 OpenAI /v1/chat/completions
    return (
        s.includes('/completions') ||
        s.includes('/embeddings') ||
        s.includes('/api/chat')
    );
}

function isLocalModelRequest(model, hostOrUrl) {
    const m = String(model || '').toLowerCase();
    const h = String(hostOrUrl || '').toLowerCase();
    // 仅针对真正运行在 Ollama (11434端口) 或者是以 ollama/ 前缀命名的本地端侧小模型
    const isOllamaPort = h.includes('11434');
    const localName = m.includes('ollama/') || m.startsWith('ollama/');
    return isOllamaPort || localName;
}

function looksLikeRawToolCall(content) {
    if (typeof content !== 'string') return false;
    const t = content.trim();
    if (!t.includes('"name"') || !t.includes('"arguments"')) return false;
    return /^\s*\{[\s\S]*"name"\s*:[\s\S]*"arguments"\s*:/.test(t);
}

function stripDirectiveTags(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/\[\[\s*(?:reply_to_current|reply_to\s*:[^\]\n]+)\s*\]\]/gi, '')
        .replace(/\[\s*(?:reply_to_current|reply_to\s*:[^\]\n]+)\s*\]/gi, '')
        .trim();
}

function sanitizeRawToolCallContent(content) {
    if (typeof content === 'string') {
        content = stripDirectiveTags(content);
    }
    if (!looksLikeRawToolCall(content)) return content;
    const trimmed = content.trim();
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.name === 'string' && parsed.arguments != null) {
            if (parsed.name === 'tts' && parsed.arguments && typeof parsed.arguments.text === 'string') {
                return parsed.arguments.text;
            }
            // 其它工具调用 JSON 转换成自然语言日志说明，防范返回空字符串触发 empty content 警告
            return `[已触发技能 ${parsed.name}]`;
        }
    } catch (e) {
        if (/"name"\s*:\s*"tts"/.test(trimmed)) {
            const textMatch = trimmed.match(/"text"\s*:\s*"([^"]*)"/);
            return (textMatch && textMatch[1]) ? textMatch[1] : '';
        }
        return '[已处理内部工具指令]';
    }
    return content;
}

const LOCAL_MODEL_NO_TOOL_GUARD =
    '[LocalModelGuard] 禁止输出任何函数/工具调用 JSON（例如 {"name":"...","arguments":{...}}）。只用自然语言直接回复用户。不要调用 tts、update_goal 或其它工具。';

const SYSTEM_CAPABILITY_PROMPT =
    '[SystemCapability] 当用户要求你进行屏幕截图（如“截个图”、“截图”等）时，你必须调用 "exec" 工具去执行系统命令 "screen-capture"。你只需在 exec 工具的 command 参数中填入 "screen-capture" 这一个词即可，系统底层会自动接管截图逻辑。绝对不要自己手写任何 powershell、python 或 C# 的截图脚本代码。当工具或插件成功生成/保存图片、视频或文件并返回绝对路径后，你必须在你的文本回复的顶部（第一行），以纯文本、单独成行的格式输出 "MEDIA:<文件的实际绝对路径>"（注意冒号为半角，不要使用 Markdown 语法或代码块包裹，例如：MEDIA:C:/Users/Administrator/.openclaw/video-output/video_123.mp4）。用户说“发我/发给我”时也优先用 MEDIA: 行交付，不要用错误的 user: 目标去调 message。若必须用 message 发 QQ 图：channel=qqbot，target 只能是 qqbot:c2c:<openid> 或 qqbot:group:<id>。随后在下方新起一行再用正常话语告知用户处理结果即可。绝对不能输出 [[image]]、[[video]]、[[image_media]]、[[video_media]] 这类占位符！\n此外，当用户要求你打开浏览器、访问网页、或进行搜索时，你必须调用 "exec" 工具并在 command 参数中指定 "start <URL>" 命令去拉起网页（例如：百度搜索“仙逆”应执行 "start https://www.baidu.com/s?wd=仙逆"；访问“google.com”应执行 "start https://google.com"）。系统会自动在后台安全拉起用户的默认浏览器并直接呈现网页。告知用户已为您拉起浏览器即可。';

/** 清洗历史脏数据 + 对本地模型剥离 tools。返回是否改动过 body。 */
const SYSTEM_CAPABILITY_PROMPT_SAFE =
    '[SystemCapability] When the user asks for a screenshot, call the exec tool with command exactly "screen-capture". Do not write your own screenshot script. The screenshot command only returns a local file path; do not call any message/sendMedia tool for that screenshot. In the final visible reply, put exactly one plain first line "MEDIA:<absolute path returned by this turn>" and then at most one short status sentence. Never emit the same screenshot through both a message tool and MEDIA. Never reuse openclaw-screenshot-latest.png unless it is the only path returned. Never output [[image]], [[video]], [[image_media]], or [[video_media]].\nWhen the user asks to open a browser, visit a webpage, or search, call exec with command "start <URL>" and then briefly say the browser was opened.';

function scrubLocalModelRequestBody(parsedBody, hostOrUrl) {
    let hasModified = false;
    if (!parsedBody || typeof parsedBody !== 'object') return false;

    if (Array.isArray(parsedBody.messages)) {
        const cleanedMessages = [];
        for (let i = 0; i < parsedBody.messages.length; i++) {
            const msg = parsedBody.messages[i];
            if (!msg || typeof msg !== 'object') continue;
            let content = msg.content;
            
            // 毒性幻觉清洗：如果助手回复中包含了假装截图的 [[image]]/[image]，且它并没有进行任何工具调用，这说明是纯文本假截图，会严重污染上下文，必须跳过
            const hasToolCalls = msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
            if (msg.role === 'assistant' && typeof content === 'string' && (content.includes('[[image]]') || content.includes('[image]')) && !hasToolCalls) {
                // 如果发现毒性回复，不仅要删掉这条，还要把前一条 user 请求（比如“截个图”）也一并弹出去，保持对话连贯
                if (cleanedMessages.length > 0 && cleanedMessages[cleanedMessages.length - 1].role === 'user') {
                    cleanedMessages.pop();
                }
                hasModified = true;
                continue;
            }

            if (typeof content === 'string') {
                if (
                    content.includes('None of the functions provided') ||
                    content.includes('None of the functions in the provided list') ||
                    content.includes('None of the functions listed')
                ) {
                    hasModified = true;
                    continue;
                }
                const sanitized = sanitizeRawToolCallContent(content);
                if (sanitized !== content) {
                    hasModified = true;
                    if (!sanitized) continue;
                    msg.content = sanitized;
                }
            }
            cleanedMessages.push(msg);
        }
        if (parsedBody.messages.length !== cleanedMessages.length) hasModified = true;
        parsedBody.messages = cleanedMessages;
    }

    if (isLocalModelRequest(parsedBody.model, hostOrUrl)) {
        if (parsedBody.tools || parsedBody.tool_choice) {
            delete parsedBody.tools;
            delete parsedBody.tool_choice;
            hasModified = true;
        }
        // Ollama 原生 /api/chat 也可能带 format/tools
        if (parsedBody.format === 'json' && Array.isArray(parsedBody.tools)) {
            delete parsedBody.tools;
            hasModified = true;
        }
    } else {
        // 云端模型截图劫持：如果用户说“截图”等，强行注入 tool_choice，迫使 Flash 等模型必须调 exec
        if (Array.isArray(parsedBody.messages)) {
            let lastUserMsg = null;
            for (let i = parsedBody.messages.length - 1; i >= 0; i--) {
                if (parsedBody.messages[i] && parsedBody.messages[i].role === 'user') {
                    lastUserMsg = parsedBody.messages[i];
                    break;
                }
            }
            if (lastUserMsg && typeof lastUserMsg.content === 'string') {
                const lowerText = lastUserMsg.content.toLowerCase();
                const looksLikeScreenshot = lowerText.includes('截图') || lowerText.includes('截个图') || lowerText.includes('截张图');
                const looksLikeBrowser = lowerText.includes('浏览器') || lowerText.includes('百度') || lowerText.includes('搜索') || lowerText.includes('访问') || lowerText.includes('网页') || lowerText.includes('打开网站');
                if (looksLikeScreenshot || looksLikeBrowser) {
                    parsedBody.tool_choice = { type: 'function', function: { name: 'exec' } };
                    hasModified = true;
                }
            }
        }
    }
        // 系统提示处理：仅对真正端侧小模型添加禁用工具警示；给正常云端模型添加截图与浏览器能力支持提示
        if (Array.isArray(parsedBody.messages)) {
            const isLocal = isLocalModelRequest(parsedBody.model, hostOrUrl);
            if (isLocal) {
                const alreadyGuarded = parsedBody.messages.some(
                    (m) => m && m.role === 'system' && typeof m.content === 'string' && m.content.includes('[LocalModelGuard]')
                );
                if (!alreadyGuarded) {
                    parsedBody.messages.unshift({ role: 'system', content: LOCAL_MODEL_NO_TOOL_GUARD });
                    hasModified = true;
                }
            } else {
                const alreadyHasCap = parsedBody.messages.some(
                    (m) => m && m.role === 'system' && typeof m.content === 'string' && m.content.includes('Never emit the same screenshot through both')
                );
                if (!alreadyHasCap) {
                    parsedBody.messages.unshift({ role: 'system', content: SYSTEM_CAPABILITY_PROMPT_SAFE });
                    hasModified = true;
                }
            }

            // 本地小窗：硬裁历史，避免 Preflight compaction 必挂
            // 保留全部 system + 最近若干轮 user/assistant
            const MAX_CHARS = 12000; // ~3k tokens 量级，给 8k 窗留出回复空间
            const msgs = parsedBody.messages;
            let total = 0;
            for (const m of msgs) {
                if (!m) continue;
                if (typeof m.content === 'string') total += m.content.length;
                else if (Array.isArray(m.content)) {
                    for (const part of m.content) {
                        if (part && typeof part.text === 'string') total += part.text.length;
                    }
                }
            }
            if (total > MAX_CHARS && msgs.length > 6) {
                const systems = msgs.filter((m) => m && m.role === 'system');
                const rest = msgs.filter((m) => m && m.role !== 'system');
                // 从尾部往前凑，直到接近上限
                const kept = [];
                let budget = Math.floor(MAX_CHARS * 0.7);
                for (let i = rest.length - 1; i >= 0; i--) {
                    const m = rest[i];
                    let len = 0;
                    if (typeof m.content === 'string') len = m.content.length;
                    else if (Array.isArray(m.content)) {
                        for (const part of m.content) {
                            if (part && typeof part.text === 'string') len += part.text.length;
                        }
                    }
                    if (kept.length >= 8 && budget - len < 0) break;
                    kept.unshift(m);
                    budget -= len;
                    if (budget <= 0 && kept.length >= 4) break;
                }
                parsedBody.messages = [...systems.slice(0, 3), ...kept];
                hasModified = true;
            }
        }

        // 上限与 latency-tune 一致（16384）。旧逻辑压到 8192 会抵消配置侧修复，
        // 导致 OpenClaw 按 16k 预算、Ollama 实际 8k → 必触发 context overflow。
        let ollamaCtxCap = 16384;
        let ollamaMaxTokCap = 1024;
        try {
            const lt = require('./latency-tune');
            if (lt && lt.DEFAULTS) {
                if (Number(lt.DEFAULTS.ollamaNumCtx) > 0) ollamaCtxCap = Number(lt.DEFAULTS.ollamaNumCtx);
                if (Number(lt.DEFAULTS.ollamaMaxTokens) > 0) ollamaMaxTokCap = Number(lt.DEFAULTS.ollamaMaxTokens);
            }
        } catch (e) {}
        if (parsedBody.options && typeof parsedBody.options === 'object') {
            if (Number(parsedBody.options.num_ctx) > ollamaCtxCap) {
                parsedBody.options.num_ctx = ollamaCtxCap;
                hasModified = true;
            }
        }
        if (Number(parsedBody.num_ctx) > ollamaCtxCap) {
            parsedBody.num_ctx = ollamaCtxCap;
            hasModified = true;
        }
        if (Number(parsedBody.max_tokens) > ollamaMaxTokCap) {
            parsedBody.max_tokens = ollamaMaxTokCap;
            hasModified = true;
        }

    if (parsedBody.stream === true) {
        if (!parsedBody.stream_options) {
            parsedBody.stream_options = { include_usage: true };
            hasModified = true;
        } else if (parsedBody.stream_options.include_usage !== true) {
            parsedBody.stream_options.include_usage = true;
            hasModified = true;
        }
    }

    return hasModified;
}

// ─── 全局 API Key 轮询负载均衡器 ───
const BUILT_IN_KEYS = [
    'sk-95sX8HnNOhh8FFfAm3ccOgGFg6MA8yf7zU5PEEQdGxSuKhQY',
    'sk-HV5HINAfAhMJOnYxYp83ZXDLqeudt8ofLtdm9Bj5p9SUOUGh',
    'sk-Y6ORz4nnuXHUpwjdXv2WlmLMwCfPBMtmh69iuXxZkQtZazyV',
    'sk-GhS6TUB6W8LibJT5whDhbUvmYW3csM0HdGDdjotpgadQbd2F'
];

const rotators = new Map();
function getNextKey(rawKey, keys) {
    let idx = rotators.get(rawKey) || 0;
    if (idx >= keys.length) idx = 0;
    const key = keys[idx];
    rotators.set(rawKey, (idx + 1) % keys.length);
    return key;
}

function patchHeadersInArguments(args) {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg && typeof arg === 'object' && arg.headers) {
            // 兼容各种大小写 Authorization 头部
            const authKey = Object.keys(arg.headers).find(k => k.toLowerCase() === 'authorization');
            if (authKey) {
                const authVal = arg.headers[authKey];
                if (typeof authVal === 'string' && authVal.startsWith('Bearer ')) {
                    const rawKey = authVal.substring(7).trim();
                    let keys = [];
                    // 1. 如果使用的是内置核心密钥，自动扩展为 4 个内置高速 Key 组成的轮询池
                    if (rawKey === 'sk-95sX8HnNOhh8FFfAm3ccOgGFg6MA8yf7zU5PEEQdGxSuKhQY') {
                        keys = [...BUILT_IN_KEYS];
                    } else if (rawKey.includes(',')) {
                        // 2. 自定义输入框填入了逗号分隔的多 Key 格式，支持去重合并
                        const rawSplit = rawKey.split(',').map(k => k.trim()).filter(Boolean);
                        // 去重合并：如果用户手动填的 Key 包含了内置 Key，防止其重复执行
                        keys = Array.from(new Set(rawSplit));
                    }
                    
                    if (keys.length > 0) {
                        const selectedKey = getNextKey(rawKey, keys);
                        arg.headers[authKey] = `Bearer ${selectedKey}`;
                        console.log(`[TokenGuard] API Key rotated (index ${keys.indexOf(selectedKey)}): ${selectedKey.substring(0, 12)}...`);
                    }
                }
            }
            // 兼容 api-key 或是 x-api-key 格式
            const apiKeyName = Object.keys(arg.headers).find(k => k.toLowerCase() === 'api-key' || k.toLowerCase() === 'x-api-key');
            if (apiKeyName) {
                const apiVal = arg.headers[apiKeyName];
                if (typeof apiVal === 'string') {
                    let keys = [];
                    if (apiVal === 'sk-95sX8HnNOhh8FFfAm3ccOgGFg6MA8yf7zU5PEEQdGxSuKhQY') {
                        keys = [...BUILT_IN_KEYS];
                    } else if (apiVal.includes(',')) {
                        keys = Array.from(new Set(apiVal.split(',').map(k => k.trim()).filter(Boolean)));
                    }
                    if (keys.length > 0) {
                        const selectedKey = getNextKey(apiVal, keys);
                        arg.headers[apiKeyName] = selectedKey;
                        console.log(`[TokenGuard] API Key rotated (index ${keys.indexOf(selectedKey)}): ${selectedKey.substring(0, 12)}...`);
                    }
                }
            }
            break;
        }
    }
}

function patchFetchHeaders(headersObj) {
    if (!headersObj) return;
    if (typeof headersObj.set === 'function' && typeof headersObj.get === 'function') {
        let authVal = headersObj.get('Authorization');
        if (typeof authVal === 'string' && authVal.startsWith('Bearer ')) {
            const rawKey = authVal.substring(7).trim();
            let keys = [];
            if (rawKey === 'sk-95sX8HnNOhh8FFfAm3ccOgGFg6MA8yf7zU5PEEQdGxSuKhQY') {
                keys = [...BUILT_IN_KEYS];
            } else if (rawKey.includes(',')) {
                keys = Array.from(new Set(rawKey.split(',').map(k => k.trim()).filter(Boolean)));
            }
            if (keys.length > 0) {
                const selectedKey = getNextKey(rawKey, keys);
                headersObj.set('Authorization', `Bearer ${selectedKey}`);
                console.log(`[TokenGuard] Fetch API Key rotated (index ${keys.indexOf(selectedKey)}): ${selectedKey.substring(0, 12)}...`);
            }
        }
        let apiKeyVal = headersObj.get('api-key') || headersObj.get('x-api-key');
        if (typeof apiKeyVal === 'string') {
            let keys = [];
            if (apiKeyVal === 'sk-95sX8HnNOhh8FFfAm3ccOgGFg6MA8yf7zU5PEEQdGxSuKhQY') {
                keys = [...BUILT_IN_KEYS];
            } else if (apiKeyVal.includes(',')) {
                keys = Array.from(new Set(apiKeyVal.split(',').map(k => k.trim()).filter(Boolean)));
            }
            if (keys.length > 0) {
                const selectedKey = getNextKey(apiKeyVal, keys);
                if (headersObj.has('api-key')) headersObj.set('api-key', selectedKey);
                if (headersObj.has('x-api-key')) headersObj.set('x-api-key', selectedKey);
                console.log(`[TokenGuard] Fetch API Key rotated (index ${keys.indexOf(selectedKey)}): ${selectedKey.substring(0, 12)}...`);
            }
        }
    } else {
        const authKey = Object.keys(headersObj).find(k => k.toLowerCase() === 'authorization');
        if (authKey) {
            const authVal = headersObj[authKey];
            if (typeof authVal === 'string' && authVal.startsWith('Bearer ')) {
                const rawKey = authVal.substring(7).trim();
                let keys = [];
                if (rawKey === 'sk-95sX8HnNOhh8FFfAm3ccOgGFg6MA8yf7zU5PEEQdGxSuKhQY') {
                    keys = [...BUILT_IN_KEYS];
                } else if (rawKey.includes(',')) {
                    keys = Array.from(new Set(rawKey.split(',').map(k => k.trim()).filter(Boolean)));
                }
                if (keys.length > 0) {
                    const selectedKey = getNextKey(rawKey, keys);
                    headersObj[authKey] = `Bearer ${selectedKey}`;
                    console.log(`[TokenGuard] Fetch API Key rotated (index ${keys.indexOf(selectedKey)}): ${selectedKey.substring(0, 12)}...`);
                }
            }
        }
        const apiKeyName = Object.keys(headersObj).find(k => k.toLowerCase() === 'api-key' || k.toLowerCase() === 'x-api-key');
        if (apiKeyName) {
            const apiVal = headersObj[apiKeyName];
            if (typeof apiVal === 'string') {
                let keys = [];
                if (apiVal === 'sk-95sX8HnNOhh8FFfAm3ccOgGFg6MA8yf7zU5PEEQdGxSuKhQY') {
                    keys = [...BUILT_IN_KEYS];
                } else if (apiVal.includes(',')) {
                    keys = Array.from(new Set(apiVal.split(',').map(k => k.trim()).filter(Boolean)));
                }
                if (keys.length > 0) {
                    const selectedKey = getNextKey(apiVal, keys);
                    headersObj[apiKeyName] = selectedKey;
                    console.log(`[TokenGuard] Fetch API Key rotated (index ${keys.indexOf(selectedKey)}): ${selectedKey.substring(0, 12)}...`);
                }
            }
        }
    }
}

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const os = require('os');

// ─── 终极 homedir 矫正劫持 ───
// 兼容家用电脑 + 无影云电脑/RDS：家目录锁定逻辑与主进程共用（openclaw-state.js），
// 禁止子进程把普通 %TEMP% 误判成云桌面后改写 OPENCLAW_*，导致 token/配置分叉。
const originalHomedir = os.homedir;
const {
    isTempLikePath: isTempLikeHomePath,
    resolveLockedOpenClawHome
} = (() => {
    try {
        return require('./openclaw-state');
    } catch (e) {
        try {
            const alt = process.env.NEXORA_AGENT_RUNTIME_DIR
                ? path.join(process.env.NEXORA_AGENT_RUNTIME_DIR, 'openclaw-state.js')
                : '';
            if (alt && fs.existsSync(alt)) return require(alt);
        } catch (e2) {}
        // 极端兜底：保持旧行为安全子集（只认 OPENCLAW_HOME，绝不信普通 TEMP）
        return {
            isTempLikePath: (p) => {
                const n = String(p || '').toLowerCase().replace(/\//g, '\\');
                return n.includes('\\temp\\') || n.includes('\\tmp\\') || n.includes('\\appdata\\local\\temp');
            },
            resolveLockedOpenClawHome: (env) => {
                const preset = (env.OPENCLAW_HOME || env.REAL_USER_HOME || env.USERPROFILE || '').trim();
                if (preset) return path.resolve(preset);
                try { return originalHomedir(); } catch (e3) { return process.cwd(); }
            }
        };
    }
})();

const realHome = resolveLockedOpenClawHome(process.env, {
    originalHomedir: () => {
        try { return originalHomedir(); } catch (e) { return ''; }
    }
});
if (isTempLikeHomePath(process.env.REAL_USER_HOME || '') && !isTempLikeHomePath(realHome)) {
    console.warn(`[System] Corrected Temp OpenClaw home -> ${realHome}`);
}
os.homedir = function() {
    return realHome;
};
process.env.USERPROFILE = realHome;
process.env.HOME = realHome;
process.env.REAL_USER_HOME = realHome;
process.env.OPENCLAW_HOME = realHome;
process.env.OPENCLAW_STATE_DIR = path.join(realHome, '.openclaw');

// ─── worker_threads.Worker 孙子线程补丁传播 ───
try {
    const worker_threads = require('worker_threads');
    const OriginalWorker = worker_threads.Worker;
    worker_threads.Worker = function(filename, options) {
        let newOptions = options || {};
        let execArgv = Array.isArray(newOptions.execArgv) ? [...newOptions.execArgv] : [];
        const injected = (process.env.NEXORA_AGENT_PATCH_PATH
            || (typeof __filename === 'string' ? __filename : '')
            || require('path').join(process.env.OPENCLAW_STATE_DIR || '', 'patch_gateway.js')
        ).replace(/\\/g, '/');
        const hasRequire = execArgv.some((arg, index) => arg === '--require' && execArgv[index + 1] && execArgv[index + 1].includes('patch_gateway.js'));
        if (!hasRequire && injected) {
            execArgv.push('--require', injected);
        }
        newOptions.execArgv = execArgv;
        return new OriginalWorker(filename, newOptions);
    };
    worker_threads.Worker.prototype = OriginalWorker.prototype;
    Object.setPrototypeOf(worker_threads.Worker, OriginalWorker);
} catch (e) {}

// ─── Windows 命令行防御性纠正过滤 ───
function fixWindowsHeredoc(cmdStr) {
    if (typeof cmdStr !== 'string') return cmdStr;
    const heredocRegex = /powershell.*-File\s+-\s+<<'?PS1'([\s\S]*?)PS1/i;
    const match = cmdStr.match(heredocRegex);
    if (match) {
        const realScript = match[1].trim();
        const wrappedScript = `try {\n${realScript}\n} catch {}`;
        const base64 = Buffer.from(wrappedScript, 'utf16le').toString('base64');
        const corrected = `powershell -ExecutionPolicy Bypass -NoProfile -EncodedCommand ${base64}`;
        return cmdStr.replace(match[0], corrected);
    }
    return cmdStr;
}

function resolveCaptureDesktopScriptPath() {
    const pathMod = require('path');
    const fsMod = require('fs');
    const candidates = [
        process.env.NEXORA_AGENT_RUNTIME_DIR && pathMod.join(process.env.NEXORA_AGENT_RUNTIME_DIR, 'capture-desktop.ps1'),
        pathMod.join(process.env.OPENCLAW_STATE_DIR || '', 'capture-desktop.ps1'),
        pathMod.join(process.env.OPENCLAW_HOME || '', '.openclaw', 'capture-desktop.ps1'),
        pathMod.join(process.env.OPENCLAW_HOME || '', 'capture-desktop.ps1'),
        pathMod.join(process.env.REAL_USER_HOME || '', '.openclaw', 'capture-desktop.ps1'),
        pathMod.join(process.env.ProgramData || 'C:\\ProgramData', 'Nexora Agent', 'runtime', 'capture-desktop.ps1'),
        pathMod.join(process.env.PUBLIC || 'C:\\Users\\Public', 'NexoraAgent', 'runtime', 'capture-desktop.ps1'),
        pathMod.join(__dirname, 'capture-desktop.ps1')
    ];
    // When patch is loaded via --require, also try beside the resolved patch file.
    try {
        if (typeof __filename === 'string' && __filename) {
            candidates.unshift(pathMod.join(pathMod.dirname(__filename), 'capture-desktop.ps1'));
        }
        if (process.env.NEXORA_AGENT_PATCH_PATH) {
            candidates.unshift(pathMod.join(pathMod.dirname(process.env.NEXORA_AGENT_PATCH_PATH), 'capture-desktop.ps1'));
        }
    } catch (e) {}
    for (const p of candidates) {
        if (!p) continue;
        try {
            const resolved = pathMod.resolve(p);
            if (fsMod.existsSync(resolved)) return resolved.replace(/\\/g, '/');
        } catch (e) {}
    }
    return pathMod.join(process.env.TEMP || process.env.TMP || require('os').tmpdir(), 'capture-desktop.ps1').replace(/\\/g, '/');
}

function fixWindowsScreenshotCommand(cmdStr) {
    if (typeof cmdStr !== 'string') return cmdStr;
    const s = cmdStr.toLowerCase();
    const looksLikeCapture =
        s.includes('screen-capture') ||
        s.includes('capture-desktop') ||
        s.includes('screenshot') ||
        s.includes('copyfromscreen') ||
        s.includes('imageformat') ||
        s.includes('system.windows') ||
        s.includes('outputpath') ||
        s.includes('dispose()') ||
        (s.includes('add-type') && (s.includes('drawing') || s.includes('graphics') || s.includes('bitmap') || s.includes('windows') || s.includes('forms')));
    if (!looksLikeCapture) return cmdStr;
    // Write screenshots to a fresh path for every capture; keep latest only for local preview.
    const stateDir = process.env.OPENCLAW_STATE_DIR || require('path').join(require('os').homedir(), '.openclaw');
    const pathMod = require('path');
    const fsMod = require('fs');
    const destDir = pathMod.join(stateDir, 'screenshots');
    try { fsMod.mkdirSync(destDir, { recursive: true }); } catch (e) {}
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = Math.random().toString(36).slice(2, 8);
    const destPathRaw = pathMod.join(destDir, `openclaw-screenshot-${stamp}-${suffix}.png`);
    const latestPathRaw = pathMod.join(stateDir, 'openclaw-screenshot-latest.png');
    const destPath = destPathRaw.replace(/\\/g, '/').replace(/'/g, "''");
    const latestPath = latestPathRaw.replace(/\\/g, '/').replace(/'/g, "''");
    const scriptPath = resolveCaptureDesktopScriptPath().replace(/'/g, "''");
    const psScript = [
        `$ProgressPreference = 'SilentlyContinue'`,
        'try {',
        `& powershell -ExecutionPolicy Bypass -NoProfile -File '${scriptPath}' -OutPath '${destPath}' | Out-Null`,
        `if (Test-Path -LiteralPath '${destPath}') {`,
        `  Copy-Item -LiteralPath '${destPath}' -Destination '${latestPath}' -Force`,
        `  Write-Output '${destPath}'`,
        '} else {',
        `  Write-Output '${destPath}'`,
        '}',
        '} catch {',
        `  Write-Output '${destPath}'`,
        '}'
    ].join('; ');
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    return `powershell -ExecutionPolicy Bypass -NoProfile -EncodedCommand ${encoded}`;
}

function defensiveCommandFilter(cmdStr) {
    let result = cmdStr;
    result = fixWindowsHeredoc(result);
    result = fixWindowsScreenshotCommand(result);
    return result;
}

// ─── child_process.spawn, spawnSync 和 fork 孙子进程补丁传播 ───
const originalSpawn = child_process.spawn;
const originalSpawnSync = child_process.spawnSync;
const originalFork = child_process.fork;
const patchPath = (process.env.NEXORA_AGENT_PATCH_PATH
    || (typeof __filename === 'string' ? __filename : '')
    || require('path').join(process.env.OPENCLAW_STATE_DIR || '', 'patch_gateway.js')
).replace(/\\/g, '/');

child_process.spawn = function(command, args, options) {
    let newArgs = args;
    let newOptions = options || {};
    
    // Windows 平台下防御性纠正
    if (process.platform === 'win32' && Array.isArray(newArgs)) {
        newArgs = newArgs.map(arg => {
            if (typeof arg === 'string') {
                return defensiveCommandFilter(arg);
            }
            return arg;
        });
    }
    
    // 1. 无差别强制注入 env.NODE_OPTIONS，广播到所有后代进程 (非 Node 进程忽略，Node 进程强制加载)
    const env = { ...(newOptions.env || process.env) };
    const injected = `--require "${patchPath}" --dns-result-order=ipv4first --no-warnings`;
    const existing = (env.NODE_OPTIONS || '').trim();
    if (!existing.includes(patchPath)) {
        env.NODE_OPTIONS = existing ? `${injected} ${existing}` : injected;
    }
    newOptions.env = env;
    
    // 2. 对于显式判定为 Node 进程的，强行在 args 前部插入 --require 作为启动保障
    const cmdStr = (command || '').toLowerCase();
    const isNode = cmdStr.includes('node') || 
                   cmdStr.includes('node_modules') || 
                   cmdStr.includes('openclaw') ||
                   (Array.isArray(newArgs) && newArgs.some(arg => typeof arg === 'string' && (arg.endsWith('.js') || arg.endsWith('.mjs') || arg.includes('index.js'))));
    if (isNode && Array.isArray(newArgs)) {
        const hasRequire = newArgs.some((arg, index) => arg === '--require' && newArgs[index + 1] && newArgs[index + 1].includes('patch_gateway.js'));
        if (!hasRequire) {
            newArgs = ['--require', patchPath, ...newArgs];
        }
    }
    
    return originalSpawn.call(this, command, newArgs, newOptions);
};

child_process.spawnSync = function(command, args, options) {
    let newArgs = args;
    let newOptions = options || {};
    
    // Windows 平台下防御性纠正
    if (process.platform === 'win32' && Array.isArray(newArgs)) {
        newArgs = newArgs.map(arg => {
            if (typeof arg === 'string') {
                return defensiveCommandFilter(arg);
            }
            return arg;
        });
    }
    
    // 1. 无差别强制注入 env.NODE_OPTIONS
    const env = { ...(newOptions.env || process.env) };
    const injected = `--require "${patchPath}" --dns-result-order=ipv4first --no-warnings`;
    const existing = (env.NODE_OPTIONS || '').trim();
    if (!existing.includes(patchPath)) {
        env.NODE_OPTIONS = existing ? `${injected} ${existing}` : injected;
    }
    newOptions.env = env;
    
    // 2. 对于显式判定为 Node 进程的，强行在 args 前部插入 --require
    const cmdStr = (command || '').toLowerCase();
    const isNode = cmdStr.includes('node') || 
                   cmdStr.includes('node_modules') || 
                   cmdStr.includes('openclaw') ||
                   (Array.isArray(newArgs) && newArgs.some(arg => typeof arg === 'string' && (arg.endsWith('.js') || arg.endsWith('.mjs') || arg.includes('index.js'))));
    if (isNode && Array.isArray(newArgs)) {
        const hasRequire = newArgs.some((arg, index) => arg === '--require' && newArgs[index + 1] && newArgs[index + 1].includes('patch_gateway.js'));
        if (!hasRequire) {
            newArgs = ['--require', patchPath, ...newArgs];
        }
    }
    
    return originalSpawnSync.call(this, command, newArgs, newOptions);
};

child_process.fork = function(modulePath, args, options) {
    let newArgs = args;
    let newOptions = options || {};
    
    // 1. 无差别强制注入 env.NODE_OPTIONS
    const env = { ...(newOptions.env || process.env) };
    const injected = `--require "${patchPath}" --dns-result-order=ipv4first --no-warnings`;
    const existing = (env.NODE_OPTIONS || '').trim();
    if (!existing.includes(patchPath)) {
        env.NODE_OPTIONS = existing ? `${injected} ${existing}` : injected;
    }
    newOptions.env = env;
    
    // 2. 强行在 fork 的 execArgv 中注入 --require 作为核心保障
    let execArgv = Array.isArray(newOptions.execArgv) ? [...newOptions.execArgv] : [];
    const hasRequire = execArgv.some((arg, index) => arg === '--require' && execArgv[index + 1] && execArgv[index + 1].includes('patch_gateway.js'));
    if (!hasRequire) {
        execArgv.push('--require', patchPath);
    }
    newOptions.execArgv = execArgv;
    
    return originalFork.call(this, modulePath, newArgs, newOptions);
};

// ─── HTTPDNS DNS 劫持补丁 (完美绕过 Clash / Surge 等代理软件的 Fake-IP 域名劫持) ───
// 背景: 开启 Clash 增强/TUN 模式的机器, 系统 DNS 会把 *.weixin.qq.com 解析到 198.18.x.x 的
// Fake-IP 段。当我们的登录进程剥离了代理环境变量直连时, 直连这个假 IP 会握手挂起, 表现为
// "fetch failed (Connect Timeout, attempted address: ilinkai.weixin.qq.com:443)"。
// 解决: 对关键域名(以及任何被解析到 Fake-IP 的域名)统一改用公网 HTTPDNS 拿真实 IP。
const dns = require('dns');
const net = require('net');
const originalLookup = dns.lookup;

// Clash / Surge Fake-IP 默认地址池 198.18.0.0/15 (含 198.18.x.x 与 198.19.x.x)
const FAKE_IP_RE = /^198\.(1[89])\./;

// 强制走 HTTPDNS 的关键域名后缀 (微信 iLink 机器人相关全部走真实 IP, 避免 CNAME 到别的子域漏网)
const FORCE_HTTPDNS_SUFFIX = ['.weixin.qq.com', '.qq.com'];

// 公网 HTTPDNS 端点 (全部使用纯 IP 直连, 绝不触发域名递归解析)
const HTTPDNS_ENDPOINTS = [
    'https://223.5.5.5/resolve',   // 阿里 AliDNS
    'https://223.6.6.6/resolve',   // 阿里 AliDNS 备
    'https://120.53.53.53/resolve' // 腾讯 DNSPod
];

// 简单的解析结果缓存 (host -> { ips, expire })
const dnsCache = new Map();
const DNS_CACHE_TTL = 60 * 1000;

function isForceHttpDns(hostname) {
    const h = (hostname || '').toLowerCase();
    return FORCE_HTTPDNS_SUFFIX.some(suffix => h === suffix.slice(1) || h.endsWith(suffix));
}

function httpDnsQueryOnce(endpoint, hostname) {
    return new Promise((resolve, reject) => {
        const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=1`;
        const options = {
            rejectUnauthorized: false,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/dns-json' },
            timeout: 2500
        };
        const req = https.get(url, options, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP status ${res.statusCode}`));
            }
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed && Array.isArray(parsed.Answer)) {
                        // 只取最终 A 记录 (type === 1), 自动穿透 CNAME 链
                        const aRecords = parsed.Answer
                            .filter(ans => ans.type === 1 && ans.data && net.isIPv4(ans.data))
                            .map(r => r.data)
                            .filter(ip => !FAKE_IP_RE.test(ip));
                        if (aRecords.length > 0) return resolve(aRecords);
                    }
                    reject(new Error('No A records found'));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

async function resolveViaHttpDns(hostname) {
    const cached = dnsCache.get(hostname);
    if (cached && cached.expire > Date.now() && cached.ips.length > 0) {
        return cached.ips;
    }
    for (const endpoint of HTTPDNS_ENDPOINTS) {
        try {
            const ips = await httpDnsQueryOnce(endpoint, hostname);
            if (ips && ips.length > 0) {
                dnsCache.set(hostname, { ips, expire: Date.now() + DNS_CACHE_TTL });
                return ips;
            }
        } catch (e) { /* 尝试下一个 HTTPDNS 端点 */ }
    }
    return null;
}

dns.lookup = function(hostname, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    if (typeof options === 'number') {
        options = { family: options };
    }
    options = options || {};
    const wantAll = !!options.all;

    const deliver = (ips) => {
        if (wantAll) {
            callback(null, ips.map(ip => ({ address: ip, family: 4 })));
        } else {
            callback(null, ips[0], 4);
        }
    };

    // 纯 IP / localhost / IPv6 显式请求 → 走原生解析, 避免 HTTPDNS 递归与误伤
    if (!hostname || net.isIP(hostname) || hostname === 'localhost' || options.family === 6) {
        return originalLookup(hostname, options, callback);
    }

    originalLookup(hostname, options, (err, address, family) => {
        let sysIps = [];
        if (!err) {
            if (wantAll && Array.isArray(address)) {
                sysIps = address.map(a => a.address).filter(Boolean);
            } else if (address) {
                sysIps = [address];
            }
        }
        const allFake = sysIps.length > 0 && sysIps.every(ip => FAKE_IP_RE.test(ip));
        const needHttpDns = isForceHttpDns(hostname) || !!err || allFake;

        // 系统解析正常且不是假 IP → 直接透传原生结果 (零额外开销)
        if (!needHttpDns && sysIps.length > 0) {
            return callback(err, address, family);
        }

        resolveViaHttpDns(hostname)
            .then(ips => {
                if (ips && ips.length > 0) return deliver(ips);
                // HTTPDNS 也失败: 尽量返回系统结果 (哪怕是假 IP), 否则返回原始错误
                return callback(err, address, family);
            })
            .catch(() => callback(err, address, family));
    });
};

// ─── fs.mkdir / fs.mkdirSync Windows EPERM 补丁 (跨机器加固版) ───
// 现象: 在部分机器上 (尤其开启 Windows Defender 实时防护 / 受控文件夹访问 / OneDrive 同步 /
// 第三方杀软的机器) 递归创建 ~/.openclaw/agents/main/sessions/skills-prompts/sha256/xx
// 会随机抛 EPERM。原因是目录刚被创建就被安全软件短暂加锁扫描。原来的 5 次 * 20ms 重试
// 在这些机器上不够。这里改为: 原生递归优先 → 失败后逐级手动创建 + 更长指数退避重试。
const nodePath = path; // 顶层 path 模块引用 (下方补丁函数的形参会遮蔽 path, 故在此固定引用)
const originalMkdirSync = fs.mkdirSync;
const originalPromisesMkdir = fs.promises.mkdir;

const MKDIR_MAX_ATTEMPTS = 30;
function mkdirBackoffMs(i) { return Math.min(15 + i * 12, 200); }
// 需要走"逐级手动创建"兜底的错误码: EPERM(被锁) / EEXIST(已存在或同名文件) / ENOTDIR(某级父目录被文件占位)
function isRetriableMkdirErr(code) { return code === 'EPERM' || code === 'EEXIST' || code === 'ENOTDIR'; }

function dirExistsSync(p) {
    try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}
async function dirExistsAsync(p) {
    try { return (await fs.promises.stat(p)).isDirectory(); } catch (e) { return false; }
}
function splitPathSegments(target) {
    const resolved = nodePath.resolve(target);
    const parsed = nodePath.parse(resolved);
    const parts = resolved.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
    const segs = [];
    let cur = parsed.root;
    for (const part of parts) {
        cur = nodePath.join(cur, part);
        segs.push(cur);
    }
    return segs;
}

// 创建单级目录 (父目录必须已存在), 针对 EPERM/EEXIST 做退避重试
function ensureSegmentSync(dir) {
    for (let i = 0; i < MKDIR_MAX_ATTEMPTS; i++) {
        try { originalMkdirSync(dir); return; }
        catch (e) {
            if (dirExistsSync(dir)) return;
            if (isRetriableMkdirErr(e.code)) {
                // 存在同名文件占位 → 删除后重试
                try { if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) fs.unlinkSync(dir); } catch (_) {}
                const start = Date.now(); const w = mkdirBackoffMs(i);
                while (Date.now() - start < w) {}
                continue;
            }
            throw e;
        }
    }
    if (dirExistsSync(dir)) return;
    try {
        originalMkdirSync(dir); // 最后一次尝试
    } catch (e) {
        if (e && (e.code === 'EPERM' || e.code === 'EACCES') && String(dir).includes('.openclaw')) {
            try {
                console.warn(`[System] EPERM on mkdirSync: ${dir}. Escalating to powershell...`);
                require('child_process').execSync(`powershell -ExecutionPolicy Bypass -NoProfile -Command "New-Item -Path '${dir}' -ItemType Directory -Force"`, { windowsHide: true, stdio: 'ignore' });
                return;
            } catch (pwErr) {
                console.warn(`[System] Powershell also failed for mkdirSync: ${dir}`);
            }
        }
        throw e;
    }
}

fs.mkdirSync = function(target, options) {
    try { return originalMkdirSync(target, options); }
    catch (e) {
        if (!isRetriableMkdirErr(e.code)) throw e;
        if (dirExistsSync(target)) return undefined;
    }
    for (const seg of splitPathSegments(target)) {
        if (!dirExistsSync(seg)) ensureSegmentSync(seg);
    }
    return undefined;
};

async function ensureSegmentAsync(dir) {
    for (let i = 0; i < MKDIR_MAX_ATTEMPTS; i++) {
        try { await originalPromisesMkdir(dir); return; }
        catch (e) {
            if (await dirExistsAsync(dir)) return;
            if (isRetriableMkdirErr(e.code)) {
                try {
                    if (fs.existsSync(dir) && !(await fs.promises.stat(dir)).isDirectory()) {
                        await fs.promises.unlink(dir);
                    }
                } catch (_) {}
                await new Promise(r => setTimeout(r, mkdirBackoffMs(i)));
                continue;
            }
            throw e;
        }
    }
    if (await dirExistsAsync(dir)) return;
    try {
        await originalPromisesMkdir(dir);
    } catch (e) {
        if (e && (e.code === 'EPERM' || e.code === 'EACCES') && String(dir).includes('.openclaw')) {
            try {
                console.warn(`[System] EPERM on promises.mkdir: ${dir}. Escalating to powershell...`);
                require('child_process').execSync(`powershell -ExecutionPolicy Bypass -NoProfile -Command "New-Item -Path '${dir}' -ItemType Directory -Force"`, { windowsHide: true, stdio: 'ignore' });
                return;
            } catch (pwErr) {
                console.warn(`[System] Powershell also failed for promises.mkdir: ${dir}`);
            }
        }
        throw e;
    }
}

async function robustMkdirAsync(target, options) {
    try { return await originalPromisesMkdir(target, options); }
    catch (e) {
        if (!isRetriableMkdirErr(e.code)) throw e;
        if (await dirExistsAsync(target)) return undefined;
    }
    for (const seg of splitPathSegments(target)) {
        if (!(await dirExistsAsync(seg))) await ensureSegmentAsync(seg);
    }
    return undefined;
}

fs.promises.mkdir = function(target, options) {
    return robustMkdirAsync(target, options);
};

fs.mkdir = function(target, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = undefined;
    }
    robustMkdirAsync(target, options)
        .then(result => { if (callback) callback(null, result); })
        .catch(err => { if (callback) callback(err); });
};

// 用量库路径：与 Electron 主进程 CONFIG_DIR 对齐（优先 OPENCLAW_STATE_DIR）
function resolveTokenLogPaths() {
    const stateDir =
        process.env.OPENCLAW_STATE_DIR ||
        (process.env.OPENCLAW_HOME ? path.join(process.env.OPENCLAW_HOME, '.openclaw') : null) ||
        path.join(os.homedir(), '.openclaw');
    const logDir = path.join(stateDir, 'persistent_logs');
    return { stateDir, logDir, tokenDbPath: path.join(logDir, 'real_tokens.json') };
}

// 强制清理可能损坏的技能缓存文件或目录 (解决 EPERM 文件夹被文件占用的骨灰级顽疾)
// 仅在根网关进程执行一次: 通过环境变量标记, 避免 openclaw 派生的每个子进程都重复删除,
// 否则会与正在写缓存的父进程产生 delete/recreate 竞争, 反而诱发 EPERM。
// 且只在缓存"损坏"(被同名文件占位, 而非正常目录)时才删除, 尽量不打扰正常缓存。
if (!process.env.__TOKENGUARD_CLEANED) {
    process.env.__TOKENGUARD_CLEANED = '1';
    try {
        const { stateDir } = resolveTokenLogPaths();
        const promptsCachePath = path.join(stateDir, 'agents', 'main', 'sessions', 'skills-prompts');
        if (fs.existsSync(promptsCachePath) && !fs.statSync(promptsCachePath).isDirectory()) {
            fs.rmSync(promptsCachePath, { recursive: true, force: true });
            console.log('[TokenGuard] Removed corrupted (non-directory) skills-prompts placeholder.');
        }
    } catch (cleanupErr) {
        console.error('[TokenGuard] Failed to clean skills-prompts cache:', cleanupErr);
    }
}

/** 从 LLM 回包文本提取 usage（兼容 OpenAI / Ollama 原生 / Gemini / SSE） */
function parseUsageFromLlmBody(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') return null;
    let inputTokens = 0;
    let outputTokens = 0;
    let hitTokens = 0;

    // OpenAI / Claude / 常见兼容：prompt_tokens / completion_tokens / input_tokens / output_tokens
    const inMatch = [...bodyText.matchAll(/"(?:prompt_tokens|promptTokenCount|input_tokens|prompt_eval_count)"\s*:\s*(\d+)/gi)];
    if (inMatch.length > 0) inputTokens = parseInt(inMatch[inMatch.length - 1][1], 10) || 0;

    const outMatch = [...bodyText.matchAll(/"(?:completion_tokens|candidatesTokenCount|output_tokens|eval_count)"\s*:\s*(\d+)/gi)];
    if (outMatch.length > 0) outputTokens = parseInt(outMatch[outMatch.length - 1][1], 10) || 0;

    const hitMatch = [...bodyText.matchAll(/"(?:cached_tokens|cache_read_input_tokens|prompt_eval_count_cached)"\s*:\s*(\d+)/gi)];
    if (hitMatch.length > 0) hitTokens = parseInt(hitMatch[hitMatch.length - 1][1], 10) || 0;

    // Ollama 原生流式 NDJSON：最后一行 done:true 才有计数；上面已用 matchAll 取末次
    // 若仍为 0，尝试从最后一个完整 JSON 对象再读一次
    if (inputTokens === 0 && outputTokens === 0) {
        try {
            const lines = bodyText.split(/\r?\n/).map((l) => l.replace(/^data:\s*/, '').trim()).filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i];
                if (line === '[DONE]') continue;
                try {
                    const obj = JSON.parse(line);
                    const u = obj.usage || obj;
                    const inn = u.prompt_tokens ?? u.promptTokenCount ?? u.input_tokens ?? u.prompt_eval_count;
                    const out = u.completion_tokens ?? u.candidatesTokenCount ?? u.output_tokens ?? u.eval_count;
                    if (Number(inn) > 0 || Number(out) > 0) {
                        inputTokens = Number(inn) || 0;
                        outputTokens = Number(out) || 0;
                        hitTokens = Number(u.cached_tokens || u.cache_read_input_tokens || 0) || 0;
                        break;
                    }
                } catch (e) { /* keep scanning */ }
            }
        } catch (e) {}
    }

    if (inputTokens <= 0 && outputTokens <= 0) return null;
    return { prompt_tokens: inputTokens, completion_tokens: outputTokens, hit_tokens: hitTokens };
}
let _providerMapCache = null;
let _providerMapCacheTime = 0;

function getConfiguredProviders() {
    try {
        const now = Date.now();
        if (_providerMapCache && (now - _providerMapCacheTime < 60000)) {
            return _providerMapCache;
        }
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
        
        if (fs.existsSync(cfgPath)) {
            const data = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            if (data && data.models && data.models.providers) {
                _providerMapCache = data.models.providers;
                _providerMapCacheTime = now;
                return _providerMapCache;
            }
        }
    } catch(e) {}
    return null;
}

function inferProviderName(hostOrUrl, modelName) {
    const cleanUrl = String(hostOrUrl || '').toLowerCase();
    const model = String(modelName || '').toLowerCase();

    const userProviders = getConfiguredProviders();
    if (userProviders) {
        for (const pKey of Object.keys(userProviders)) {
            const pConfig = userProviders[pKey];
            if (pConfig && pConfig.baseUrl) {
                const bUrl = pConfig.baseUrl.toLowerCase();
                try {
                    const u1 = new URL(bUrl);
                    const u2 = new URL(cleanUrl.startsWith('http') ? cleanUrl : `https://${cleanUrl}`);
                    if (u1.host && u1.host === u2.host) {
                        return pKey;
                    }
                } catch(e) {}
                
                if (cleanUrl.includes(bUrl) || bUrl.includes(cleanUrl)) {
                    return pKey;
                }
            }
        }
    }

    if (cleanUrl.includes('11434') || model.startsWith('ollama/') ||
        ((cleanUrl.includes('localhost') || cleanUrl.includes('127.0.0.1') || cleanUrl.includes('[::1]')) && cleanUrl.includes('/api/chat'))) {
        return 'ollama';
    }
    if (cleanUrl.includes('agnes')) return 'agnes-ai';
    if (cleanUrl.includes('siliconflow')) return 'siliconflow';
    if (cleanUrl.includes('deepseek')) return 'deepseek';
    if (cleanUrl.includes('openai') || cleanUrl.includes('api.openai')) return 'openai';
    if (cleanUrl.includes('yitong') || cleanUrl.includes('bigmodel') || cleanUrl.includes('zhipu')) return 'yitong';
    try {
        const hostMatch = cleanUrl.match(/https?:\/\/([^/:]+)/);
        const host = hostMatch ? hostMatch[1] : cleanUrl;
        if (host.includes('127.0.0.1') || host.includes('localhost')) return 'ollama';
        return host.split('.')[0] || 'gateway';
    } catch (e) {
        return 'gateway';
    }
}

// 辅助写入本地 real_tokens.json 数据库
function saveRealToken(logEntry) {
    try {
        const { logDir, tokenDbPath } = resolveTokenLogPaths();
        // 确保目录存在
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        // 读取已有日志，容错处理 JSON 解析错误
        let logs = [];
        if (fs.existsSync(tokenDbPath)) {
            try {
                const raw = fs.readFileSync(tokenDbPath, 'utf8');
                logs = JSON.parse(raw);
                if (!Array.isArray(logs)) logs = [];
            } catch (e) {
                console.warn('[TokenGuard] real_tokens.json 损坏，已重置。');
                logs = [];
            }
        }
        // 新日志写入头部
        logs.unshift(logEntry);
        // 保留最近 1000 条记录
        if (logs.length > 1000) logs = logs.slice(0, 1000);
        // 使用临时文件写入，防止写入过程中出现中断导致文件损坏
        const tmpPath = tokenDbPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(logs, null, 2), 'utf8');
        fs.renameSync(tmpPath, tokenDbPath);
        console.log(`[TokenGuard] Saved usage ${logEntry.provider}/${logEntry.model}: ${logEntry.input}+${logEntry.output} -> ${tokenDbPath}`);
    } catch (err) {
        console.error('[TokenGuard] Failed to save real token (non‑fatal):', err);
        // 仅记录错误，不抛出，防止网关进程因写入错误崩溃
    }
}

// 统一解析并保存大模型 completions / embeddings 的回包日志
function parseAndSaveCompletionsLog(bodyText, hostOrUrl, elapsedMs) {
    try {
        if (!bodyText) return;
        const usage = parseUsageFromLlmBody(bodyText);
        if (!usage) return;

        let modelName = 'unknown-model';
        const modelMatch = [...bodyText.matchAll(/"model"\s*:\s*"([^"]+)"/g)];
        if (modelMatch.length > 0) {
            modelName = modelMatch[modelMatch.length - 1][1];
        }

        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
        const provName = inferProviderName(hostOrUrl, modelName);

        const logEntry = {
            time: timeStr,
            provider: provName,
            model: modelName,
            input: usage.prompt_tokens,
            output: usage.completion_tokens,
            hit: usage.hit_tokens || 0,
            duration: `${(elapsedMs / 1000.0).toFixed(1)}s`,
            status: '成功',
            timestamp: Date.now()
        };
        saveRealToken(logEntry);
    } catch (err) {
        console.error('[TokenGuard] Error parsing completions response:', err);
    }
}

// ─── 代理 1：http/https.request 拦截通道 ───
function wrapRequest(originalRequest, defaultProto) {
    return function(options, callback) {
        try {
            patchHeadersInArguments(arguments);
        } catch (e) {
            console.error('[TokenGuard] Error in patchHeadersInArguments:', e);
        }
        let host = '';
        let pathStr = '';
        let startMs = Date.now();

        if (typeof options === 'string') {
            try {
                const parsed = new URL(options);
                host = parsed.hostname;
                pathStr = parsed.pathname;
            } catch(e) {}
        } else if (options) {
            host = options.hostname || options.host || '';
            pathStr = options.path || options.pathname || '';
        }

        const isCompletions = isLlmProxyPath(pathStr);
        let clientRequest = originalRequest.apply(this, arguments);

        if (isCompletions) {
            // ─── A. 请求体干预 (剔除本地模型的 tools 并清洗上下文) ───
            let requestChunks = [];
            const originalWrite = clientRequest.write;
            const originalEnd = clientRequest.end;
            
            clientRequest.write = function(chunk, encoding, callback) {
                if (chunk) {
                    requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
                }
                return true;
            };
            
            clientRequest.end = function(chunk, encoding, callback) {
                if (chunk) {
                    requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
                }
                
                let finalBuffer = Buffer.concat(requestChunks);
                try {
                    let bodyStr = finalBuffer.toString('utf8');
                    let parsedBody = JSON.parse(bodyStr);
                    const hostHint = `${host || ''}${pathStr || ''}`;
                    if (scrubLocalModelRequestBody(parsedBody, hostHint)) {
                        const newBodyStr = JSON.stringify(parsedBody);
                        finalBuffer = Buffer.from(newBodyStr, 'utf8');
                        clientRequest.setHeader('Content-Length', finalBuffer.length);
                        console.log(`[TokenGuard] Cleaned messages and stripped tools in http.request for model: ${parsedBody.model}`);
                    }
                } catch (e) {}
                
                if (finalBuffer.length > 0) {
                    originalWrite.call(clientRequest, finalBuffer);
                }
                return originalEnd.call(clientRequest, null, null, callback);
            };

            // ─── B. 响应体无损旁路监听 (统计 Token) ───
            clientRequest.on('response', (res) => {
                let chunks = [];
                const originalEmit = res.emit;
                res.emit = function(event, ...args) {
                    if (event === 'data') {
                        const chunk = args[0];
                        if (chunk) {
                            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                        }
                    } else if (event === 'end' || event === 'close') {
                        if (!res.__COMPLETIONS_PARSED__) {
                            res.__COMPLETIONS_PARSED__ = true;
                            const elapsed = Date.now() - startMs;
                            process.nextTick(() => {
                                try {
                                    const buffer = Buffer.concat(chunks);
                                    let bodyText = '';
                                    const encoding = res.headers['content-encoding'];
                                    try {
                                        if (encoding === 'gzip') {
                                            bodyText = require('zlib').gunzipSync(buffer).toString('utf8');
                                        } else if (encoding === 'br') {
                                            bodyText = require('zlib').brotliDecompressSync(buffer).toString('utf8');
                                        } else if (encoding === 'deflate') {
                                            bodyText = require('zlib').inflateSync(buffer).toString('utf8');
                                        } else {
                                            bodyText = buffer.toString('utf8');
                                        }
                                    } catch (decompressErr) {
                                        bodyText = buffer.toString('utf8');
                                    }
                                    parseAndSaveCompletionsLog(bodyText, host || defaultProto, elapsed);
                                } catch(err) {}
                            });
                        }
                    }
                    return originalEmit.apply(this, arguments);
                };
            });
        }
        return clientRequest;
    };
}

http.request = wrapRequest(http.request, 'http');
https.request = wrapRequest(https.request, 'https');

// npm view/install 子进程也会 --require 本补丁；刷屏 TokenGuard 横幅会把 Doctor 日志淹没
function __nexoraTokenGuardQuiet() {
    try {
        if (process.env.NEXORA_TOKENGUARD_QUIET === '1') return true;
        const argv = (process.argv || []).join(' ');
        if (/npm-cli\.js|npm-prefix\.js|[\\/]npm\.cmd/i.test(argv)) return true;
        if (process.env.npm_command || process.env.npm_lifecycle_event) return true;
    } catch (e) {}
    return false;
}
function __tgInfo(msg) {
    if (__nexoraTokenGuardQuiet()) return;
    console.error(msg);
}
__tgInfo('[TokenGuard] Transparent HTTP/HTTPS request hooks successfully loaded.');

// ─── 代理 2：fetch / globalThis.fetch 拦截通道 (Node 18+ 闭环) ───
function wrapFetch(originalFetch) {
    return async function(input, init) {
        try {
            if (init && init.headers) {
                patchFetchHeaders(init.headers);
            } else if (input && input.headers) {
                patchFetchHeaders(input.headers);
            }
        } catch (e) {
            console.error('[TokenGuard] Error in patchFetchHeaders:', e);
        }
        let url = '';
        if (typeof input === 'string') {
            url = input;
        } else if (input && input.url) {
            url = input.url;
        }
        
        const isCompletions = isLlmProxyPath(url);
        const startMs = Date.now();
        
        // 自动干预大模型请求，剔除本地模型的 tools 并清洗上下文脏数据
        if (isCompletions && init && init.body) {
            try {
                let bodyStr = null;
                if (typeof init.body === 'string') bodyStr = init.body;
                else if (Buffer.isBuffer(init.body)) bodyStr = init.body.toString('utf8');
                else if (init.body instanceof Uint8Array) bodyStr = Buffer.from(init.body).toString('utf8');

                if (bodyStr) {
                    let parsedBody = JSON.parse(bodyStr);
                    if (scrubLocalModelRequestBody(parsedBody, url)) {
                        const newBodyStr = JSON.stringify(parsedBody);
                        if (Buffer.isBuffer(init.body)) init.body = Buffer.from(newBodyStr, 'utf8');
                        else if (init.body instanceof Uint8Array) init.body = new Uint8Array(Buffer.from(newBodyStr, 'utf8'));
                        else init.body = newBodyStr;
                        console.log(`[TokenGuard] Cleaned messages and stripped tools in fetch for model: ${parsedBody.model}`);
                    }
                    // Debug: 强制 dump 下来让我们可以分析它到底发了什么
                }
            } catch (err) {
                // 仅作防爆，解析失败不阻断请求
            }
        }
        
        try {
            if (isCompletions) {
                const response = await originalFetch.apply(this, arguments);
                const cloneRes = response.clone();
                const elapsed = Date.now() - startMs;
                
                cloneRes.text().then(bodyText => {
                    parseAndSaveCompletionsLog(bodyText, url, elapsed);
                }).catch(() => {});
                
                return response;
            }
            return await originalFetch.apply(this, arguments);
        } catch (e) {
            return await originalFetch.apply(this, arguments);
        }
    };
}

if (typeof globalThis === 'object' && globalThis.fetch) {
    globalThis.fetch = wrapFetch(globalThis.fetch);
    __tgInfo('[TokenGuard] Transparent globalThis.fetch hook successfully loaded.');
}

// ─── 代理 3：天罗地网 (拦截基于 Require 的第三方底层网络库) ───
const Module = require('module');
const originalLoad = Module._load;

function isStartupPluginNpmRepairFailure(err) {
    const msg = String((err && err.message) || err || '');
    if (!msg.includes('startup migrations did not complete cleanly')) return false;
    return /npm (view|install) failed|npm-cli\.js|npm-prefix\.js|MODULE_NOT_FOUND/i.test(msg)
        || /Failed to install missing configured plugin/i.test(msg);
}

Module._load = function(request, parent, isMain) {
    const exports = originalLoad.apply(this, arguments);

    // Soft-skip：沙箱缺 npm / 离线时 Doctor 插件修复失败不应阻断 Gateway ready
    try {
        if (typeof request === 'string' && /doctor-config-preflight/i.test(request) && exports && typeof exports === 'object') {
            for (const key of Object.keys(exports)) {
                const fn = exports[key];
                if (typeof fn !== 'function' || fn.__NEXORA_SOFT_MIGRATION__) continue;
                // 只包异步 preflight；同步 helper（如 shouldSkipPluginValidation）不能改成 async
                if (fn.constructor.name !== 'AsyncFunction') continue;
                const wrapped = async function(options) {
                    try {
                        return await fn.apply(this, arguments);
                    } catch (err) {
                        if (!isStartupPluginNpmRepairFailure(err)) throw err;
                        console.error('[NexoraAgent] Soft-skipping startup plugin npm repair failure; continuing gateway boot.');
                        console.error(String(err && err.message || err).split('\n').slice(0, 6).join('\n'));
                        return await fn.call(this, Object.assign({}, options || {}, { requireStartupMigrationCheckpoint: false }));
                    }
                };
                wrapped.__NEXORA_SOFT_MIGRATION__ = true;
                exports[key] = wrapped;
            }
        }
    } catch (e) {}
    
    // 1. 拦截 Undici (被 langchain 等高级 AI 框架内置使用，会绕过所有常规拦截)
    if (request === 'undici' || request.endsWith('/undici/index.js')) {
        if (exports && !exports.__TOKENGUARD_PATCHED__) {
            try {
                Object.defineProperty(exports, '__TOKENGUARD_PATCHED__', { value: true, writable: true });
                if (typeof exports.fetch === 'function') {
                    exports.fetch = wrapFetch(exports.fetch);
                }
                if (typeof exports.request === 'function') {
                    const origReq = exports.request;
                    exports.request = async function(url, options) {
                        let urlStr = '';
                        if (typeof url === 'string') urlStr = url;
                        else if (url && url.url) urlStr = url.url;
                        else if (url && url.href) urlStr = url.href;
                        
                        if (isLlmProxyPath(urlStr) && options && options.body) {
                            try {
                                let bodyStr = null;
                                if (typeof options.body === 'string') bodyStr = options.body;
                                else if (Buffer.isBuffer(options.body)) bodyStr = options.body.toString('utf8');
                                else if (options.body instanceof Uint8Array) bodyStr = Buffer.from(options.body).toString('utf8');

                                if (bodyStr) {
                                    let parsedBody = JSON.parse(bodyStr);
                                    if (scrubLocalModelRequestBody(parsedBody, urlStr)) {
                                        const newBodyStr = JSON.stringify(parsedBody);
                                        if (Buffer.isBuffer(options.body)) options.body = Buffer.from(newBodyStr, 'utf8');
                                        else if (options.body instanceof Uint8Array) options.body = new Uint8Array(Buffer.from(newBodyStr, 'utf8'));
                                        else options.body = newBodyStr;
                                        console.log(`[TokenGuard] Cleaned messages and stripped tools in undici.request for model: ${parsedBody.model}`);
                                    }
                                }
                            } catch(e) {}
                        }

                        const startMs = Date.now();
                        const res = await origReq.apply(this, arguments);
                        // undici.request 过去只 scrub 请求、不记账；补上响应旁路
                        if (isLlmProxyPath(urlStr) && res && res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
                            try {
                                const chunks = [];
                                for await (const chunk of res.body) {
                                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                                }
                                const buf = Buffer.concat(chunks);
                                const elapsed = Date.now() - startMs;
                                try {
                                    parseAndSaveCompletionsLog(buf.toString('utf8'), urlStr, elapsed);
                                } catch (e) {}
                                const { Readable } = require('stream');
                                return Object.assign({}, res, { body: Readable.from([buf]) });
                            } catch (e) {
                                return res;
                            }
                        }
                        return res;
                    };
                }
                __tgInfo('[TokenGuard] Transparent undici module hook successfully loaded.');
            } catch (e) {}
        }
    }
    
    // 2. 拦截 node-fetch
    if (request === 'node-fetch' || request.endsWith('node-fetch/lib/index.js')) {
        if (exports && !exports.__TOKENGUARD_PATCHED__) {
            try {
                Object.defineProperty(exports, '__TOKENGUARD_PATCHED__', { value: true, writable: true });
                if (typeof exports === 'function') {
                    const newExport = wrapFetch(exports);
                    Object.assign(newExport, exports);
                    __tgInfo('[TokenGuard] node-fetch module hook successfully loaded.');
                    return newExport;
                }
            } catch(e) {}
        }
    }
    
    return exports;
};
if (typeof global === 'object' && global.fetch && global.fetch !== (globalThis && globalThis.fetch)) {
    global.fetch = wrapFetch(global.fetch);
    __tgInfo('[TokenGuard] Transparent global.fetch hook successfully loaded.');
}

// ─── fs.writeFileSync 防爆盾 ───
const originalFsWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function(file, data, options) {
    try { return originalFsWriteFileSync.apply(this, arguments); }
    catch (e) {
        if (e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ENOENT') && String(file).includes('.openclaw')) {
            try {
                console.warn('[System] ' + e.code + ' on writeFileSync: ' + file + '. Escalating to powershell...');
                const base64Data = Buffer.from(data).toString('base64');
                require('child_process').execSync(`powershell -ExecutionPolicy Bypass -NoProfile -Command "[IO.File]::WriteAllBytes('${file}', [Convert]::FromBase64String('${base64Data}'))"`, { windowsHide: true, stdio: 'ignore' });
                return;
            } catch (pwErr) {
                console.warn('[System] Powershell write also failed for: ' + file);
            }
        }
        throw e;
    }
};
const originalFsWriteFile = fs.writeFile;
fs.writeFile = function(file, data, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    originalFsWriteFile(file, data, options, (err) => {
        if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOENT') && String(file).includes('.openclaw')) {
            try {
                console.warn('[System] ' + err.code + ' on writeFile: ' + file + '. Escalating to powershell...');
                const base64Data = Buffer.from(data).toString('base64');
                require('child_process').execSync(`powershell -ExecutionPolicy Bypass -NoProfile -Command "[IO.File]::WriteAllBytes('${file}', [Convert]::FromBase64String('${base64Data}'))"`, { windowsHide: true, stdio: 'ignore' });
                if (callback) callback(null);
            } catch (pwErr) {
                if (callback) callback(null);
            }
        } else {
            if (callback) callback(err);
        }
    });
};
if (fs.promises && fs.promises.writeFile) {
    const originalPromisesWriteFile = fs.promises.writeFile;
    fs.promises.writeFile = async function(file, data, options) {
        try { return await originalPromisesWriteFile.apply(this, arguments); }        catch (e) {
            if (e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'ENOENT') && String(file).includes('.openclaw')) {
                try {
                    console.warn('[System] ' + e.code + ' on promises.writeFile: ' + file + '. Escalating to powershell...');
                    const base64Data = Buffer.from(data).toString('base64');
                    require('child_process').execSync(`powershell -ExecutionPolicy Bypass -NoProfile -Command "[IO.File]::WriteAllBytes('${file}', [Convert]::FromBase64String('${base64Data}'))"`, { windowsHide: true, stdio: 'ignore' });
                    return;
                } catch (pwErr) {
                    console.warn('[System] Powershell write also failed for: ' + file);
                }
            }
            throw e;
        }
    };
}



// ─── Surgical Virtual Memory FS for skills-prompts ───
// 热路径默认静默：每次 ENOENT 都 console.warn 会堵日志管道并拖慢 Gateway Ready
globalThis.__SURGICAL_CACHE__ = globalThis.__SURGICAL_CACHE__ || {};
const __VMFS_DEBUG__ = process.env.NEXORA_AGENT_VMFS_DEBUG === '1';
function vmfsLog() {
    if (!__VMFS_DEBUG__) return;
    try { console.warn.apply(console, arguments); } catch (e) {}
}

const createFakeStats = function(file) {
    const data = globalThis.__SURGICAL_CACHE__[file];
    const size = data ? Buffer.from(data).length : 0;
    return {
        isDirectory: function() { return false; },
        isFile: function() { return true; },
        isSymbolicLink: function() { return false; },
        size: size,
        mtimeMs: Date.now(),
        ctimeMs: Date.now(),
        birthtimeMs: Date.now()
    };
};

// 1. mkdir patches
const originalMkdirSyncNew = fs.mkdirSync;
fs.mkdirSync = function(target, options) {
    try { return originalMkdirSyncNew.apply(this, arguments); }
    catch (e) {
        if (e && String(target).includes('skills-prompts')) {
            vmfsLog('[VM-FS] Intercepted mkdirSync: ' + target);
            return undefined;
        }
        throw e;
    }
};

const originalMkdirNew = fs.mkdir;
fs.mkdir = function(target, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    originalMkdirNew(target, options, function(err, result) {
        if (err && String(target).includes('skills-prompts')) {
            vmfsLog('[VM-FS] Intercepted mkdir: ' + target);
            if (callback) callback(null, result);
        } else {
            if (callback) callback(err, result);
        }
    });
};

if (fs.promises && fs.promises.mkdir) {
    const originalPromisesMkdirNew = fs.promises.mkdir;
    fs.promises.mkdir = async function(target, options) {
        try { return await originalPromisesMkdirNew.apply(this, arguments); }
        catch (e) {
            if (e && String(target).includes('skills-prompts')) {
                vmfsLog('[VM-FS] Intercepted promises.mkdir: ' + target);
                return undefined;
            }
            throw e;
        }
    };
}

// 2. write patches (Save to Memory Cache)
const originalWriteFileSyncNew = fs.writeFileSync;
fs.writeFileSync = function(file, data, options) {
    if (String(file).includes('skills-prompts')) {
        globalThis.__SURGICAL_CACHE__[file] = data;
        vmfsLog('[VM-FS] Saved sync cache for: ' + file);
        try { return originalWriteFileSyncNew.apply(this, arguments); }
        catch (e) {
            vmfsLog('[VM-FS] Swallowed writeFileSync error for: ' + file);
            return undefined;
        }
    }
    return originalWriteFileSyncNew.apply(this, arguments);
};

const originalWriteFileNew = fs.writeFile;
fs.writeFile = function(file, data, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (String(file).includes('skills-prompts')) {
        globalThis.__SURGICAL_CACHE__[file] = data;
        vmfsLog('[VM-FS] Saved async cache for: ' + file);
        originalWriteFileNew(file, data, options, function(err) {
            if (err) {
                vmfsLog('[VM-FS] Swallowed writeFile error for: ' + file);
                if (callback) callback(null);
            } else {
                if (callback) callback(null);
            }
        });
        return;
    }
    originalWriteFileNew(file, data, options, callback);
};

if (fs.promises && fs.promises.writeFile) {
    const originalPromisesWriteFileNew = fs.promises.writeFile;
    fs.promises.writeFile = async function(file, data, options) {
        if (String(file).includes('skills-prompts')) {
            globalThis.__SURGICAL_CACHE__[file] = data;
            vmfsLog('[VM-FS] Saved promises cache for: ' + file);
            try { return await originalPromisesWriteFileNew.apply(this, arguments); }
            catch (e) {
                vmfsLog('[VM-FS] Swallowed promises.writeFile error for: ' + file);
                return undefined;
            }
        }
        return originalPromisesWriteFileNew.apply(this, arguments);
    };
}

// 3. read patches (Load from Memory Cache)
const originalReadFileSyncNew = fs.readFileSync;
fs.readFileSync = function(file, options) {
    if (String(file).includes('skills-prompts')) {
        if (globalThis.__SURGICAL_CACHE__[file] !== undefined) {
            vmfsLog('[VM-FS] Read sync cache hit for: ' + file);
            const val = globalThis.__SURGICAL_CACHE__[file];
            return typeof val === 'string' && (!options || typeof options === 'string' && options.includes('utf')) ? val : Buffer.from(val);
        }
        try { return originalReadFileSyncNew.apply(this, arguments); }
        catch (e) {
            if (e && e.code === 'ENOENT') {
                vmfsLog('[VM-FS] Read sync cache miss & ENOENT for: ' + file);
                return options && typeof options === 'string' && options.includes('utf') ? '' : Buffer.alloc(0);
            }
            throw e;
        }
    }
    return originalReadFileSyncNew.apply(this, arguments);
};

const originalReadFileNew = fs.readFile;
fs.readFile = function(file, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (String(file).includes('skills-prompts')) {
        if (globalThis.__SURGICAL_CACHE__[file] !== undefined) {
            vmfsLog('[VM-FS] Read async cache hit for: ' + file);
            const val = globalThis.__SURGICAL_CACHE__[file];
            const res = typeof val === 'string' && (!options || typeof options === 'string' && options.includes('utf')) ? val : Buffer.from(val);
            if (callback) callback(null, res);
            return;
        }
        originalReadFileNew(file, options, function(err, data) {
            if (err && err.code === 'ENOENT') {
                vmfsLog('[VM-FS] Read async cache miss & ENOENT for: ' + file);
                const res = options && typeof options === 'string' && options.includes('utf') ? '' : Buffer.alloc(0);
                if (callback) callback(null, res);
            } else {
                if (callback) callback(err, data);
            }
        });
        return;
    }
    originalReadFileNew(file, options, callback);
};

if (fs.promises && fs.promises.readFile) {
    const originalPromisesReadFileNew = fs.promises.readFile;
    fs.promises.readFile = async function(file, options) {
        if (String(file).includes('skills-prompts')) {
            if (globalThis.__SURGICAL_CACHE__[file] !== undefined) {
                vmfsLog('[VM-FS] Read promises cache hit for: ' + file);
                const val = globalThis.__SURGICAL_CACHE__[file];
                return typeof val === 'string' && (!options || typeof options === 'string' && options.includes('utf')) ? val : Buffer.from(val);
            }
            try { return await originalPromisesReadFileNew.apply(this, arguments); }
            catch (e) {
                if (e && e.code === 'ENOENT') {
                    vmfsLog('[VM-FS] Read promises cache miss & ENOENT for: ' + file);
                    return options && typeof options === 'string' && options.includes('utf') ? '' : Buffer.alloc(0);
                }
                throw e;
            }
        }
        return originalPromisesReadFileNew.apply(this, arguments);
    };
}

// 4. existsSync patch
const originalExistsSyncNew = fs.existsSync;
fs.existsSync = function(file) {
    if (String(file).includes('skills-prompts')) {
        if (globalThis.__SURGICAL_CACHE__[file] !== undefined) {
            return true;
        }
    }
    return originalExistsSyncNew.apply(this, arguments);
};

// 5. stat & lstat patches
['lstatSync', 'statSync'].forEach(function(m) {
    if (!fs[m]) return;
    const orig = fs[m];
    fs[m] = function(p) {
        if (String(p).includes('skills-prompts') && globalThis.__SURGICAL_CACHE__[p] !== undefined) {
            return createFakeStats(p);
        }
        try { return orig.apply(this, arguments); }
        catch (e) {
            if (e && e.code === 'ENOENT' && String(p).includes('skills-prompts')) {
                vmfsLog('[VM-FS] Intercepted ' + m + ' ENOENT for: ' + p);
                return createFakeStats(p);
            }
            throw e;
        }
    };
});

['lstat', 'stat'].forEach(function(m) {
    if (!fs[m]) return;
    const orig = fs[m];
    fs[m] = function() {
        const args = Array.prototype.slice.call(arguments);
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        if (String(args[0]).includes('skills-prompts') && globalThis.__SURGICAL_CACHE__[args[0]] !== undefined) {
            if (cb) cb(null, createFakeStats(args[0]));
            return;
        }
        args.push(function(err, stats) {
            if (err && err.code === 'ENOENT' && String(args[0]).includes('skills-prompts')) {
                vmfsLog('[VM-FS] Intercepted ' + m + ' for: ' + args[0]);
                if (cb) cb(null, createFakeStats(args[0]));
            } else {
                if (cb) cb(err, stats);
            }
        });
        orig.apply(this, args);
    };
});

if (fs.promises) {
    ['lstat', 'stat'].forEach(function(m) {
        if (!fs.promises[m]) return;
        const orig = fs.promises[m];
        fs.promises[m] = async function(p) {
            if (String(p).includes('skills-prompts') && globalThis.__SURGICAL_CACHE__[p] !== undefined) {
                return createFakeStats(p);
            }
            try { return await orig.apply(this, arguments); }
            catch (e) {
                if (e && e.code === 'ENOENT' && String(p).includes('skills-prompts')) {
                    vmfsLog('[VM-FS] Intercepted promises.' + m + ' for: ' + p);
                    return createFakeStats(p);
                }
                throw e;
            }
        };
    });
}

// 6. rename & unlink patches
['renameSync', 'unlinkSync'].forEach(function(m) {
    if (!fs[m]) return;
    const orig = fs[m];
    fs[m] = function(p1, p2) {
        if (String(p1).includes('skills-prompts')) {
            if (m === 'unlinkSync') delete globalThis.__SURGICAL_CACHE__[p1];
            if (m === 'renameSync') {
                globalThis.__SURGICAL_CACHE__[p2] = globalThis.__SURGICAL_CACHE__[p1];
                delete globalThis.__SURGICAL_CACHE__[p1];
            }
            try { return orig.apply(this, arguments); }
            catch (e) {
                vmfsLog('[VM-FS] Swallowed ' + m + ' for: ' + p1);
                return;
            }
        }
        return orig.apply(this, arguments);
    };
});

['rename', 'unlink'].forEach(function(m) {
    if (!fs[m]) return;
    const orig = fs[m];
    fs[m] = function() {
        const args = Array.prototype.slice.call(arguments);
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        const p1 = args[0];
        if (String(p1).includes('skills-prompts')) {
            if (m === 'unlink') delete globalThis.__SURGICAL_CACHE__[p1];
            if (m === 'rename') {
                const p2 = args[1];
                globalThis.__SURGICAL_CACHE__[p2] = globalThis.__SURGICAL_CACHE__[p1];
                delete globalThis.__SURGICAL_CACHE__[p1];
            }
            args.push(function(err) {
                if (err) {
                    vmfsLog('[VM-FS] Swallowed ' + m + ' error for: ' + p1);
                    if (cb) cb(null);
                } else {
                    if (cb) cb(null);
                }
            });
            orig.apply(this, args);
            return;
        }
        orig.apply(this, arguments);
    };
});

if (fs.promises) {
    ['rename', 'unlink'].forEach(function(m) {
        if (!fs.promises[m]) return;
        const orig = fs.promises[m];
        fs.promises[m] = async function(p1, p2) {
            if (String(p1).includes('skills-prompts')) {
                if (m === 'unlink') delete globalThis.__SURGICAL_CACHE__[p1];
                if (m === 'rename') {
                    globalThis.__SURGICAL_CACHE__[p2] = globalThis.__SURGICAL_CACHE__[p1];
                    delete globalThis.__SURGICAL_CACHE__[p1];
                }
                try { return await orig.apply(this, arguments); }
                catch (e) {
                    vmfsLog('[VM-FS] Swallowed promises.' + m + ' for: ' + p1);
                    return;
                }
            }
            return orig.apply(this, arguments);
        };
    });
}
