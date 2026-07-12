const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const os = require('os');

// ─── fs.mkdir / fs.mkdirSync Windows EPERM Race Condition 补丁 ───
// 解决高并发时，Node.js 在 Windows 上递归创建目录可能导致的 EPERM 报错
const originalMkdirSync = fs.mkdirSync;
fs.mkdirSync = function(path, options) {
    try {
        return originalMkdirSync(path, options);
    } catch (e) {
        if (e.code === 'EPERM' || e.code === 'EEXIST') {
            try {
                const stat = fs.statSync(path);
                if (stat.isDirectory()) return undefined;
                // If it's a file blocking the directory, delete it and retry
                fs.unlinkSync(path);
                return originalMkdirSync(path, options);
            } catch (statErr) {
                // If ENOENT, maybe parent is a file or locked. Fall through.
            }
        }
        throw e;
    }
};

const originalPromisesMkdir = fs.promises.mkdir;
fs.promises.mkdir = async function(path, options) {
    try {
        return await originalPromisesMkdir(path, options);
    } catch (e) {
        if (e.code === 'EPERM' || e.code === 'EEXIST') {
            try {
                const stat = await fs.promises.stat(path);
                if (stat.isDirectory()) return undefined;
                await fs.promises.unlink(path);
                return await originalPromisesMkdir(path, options);
            } catch (statErr) {}
        }
        throw e;
    }
};

const originalMkdir = fs.mkdir;
fs.mkdir = function(path, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = undefined;
    }
    originalMkdir(path, options, function(err, result) {
        if (err && (err.code === 'EPERM' || err.code === 'EEXIST')) {
            fs.stat(path, function(statErr, stat) {
                if (!statErr && stat.isDirectory()) {
                    if (callback) callback(null, undefined);
                } else if (!statErr && !stat.isDirectory()) {
                    fs.unlink(path, function() {
                        originalMkdir(path, options, callback);
                    });
                } else {
                    if (callback) callback(err);
                }
            });
            return;
        }
        if (callback) callback(err, result);
    });
};

// 统一日志写入数据库路径 (自适应获取用户主目录，解决硬编码用户名 Yuan 导致别人的白机用量失效的重大 Bug)
const homeDir = os.homedir();
const logDir = path.join(homeDir, '.openclaw', 'persistent_logs');
const tokenDbPath = path.join(logDir, 'real_tokens.json');

// 强制清理可能损坏的技能缓存文件或目录 (解决 EPERM 文件夹被文件占用的骨灰级顽疾)
try {
    const promptsCachePath = path.join(homeDir, '.openclaw', 'agents', 'main', 'sessions', 'skills-prompts');
    if (fs.existsSync(promptsCachePath)) {
        fs.rmSync(promptsCachePath, { recursive: true, force: true });
        console.log('[TokenGuard] Cleared potentially corrupted skills-prompts cache.');
    }
} catch (cleanupErr) {
    console.error('[TokenGuard] Failed to clear skills-prompts cache:', cleanupErr);
}

// 辅助写入本地 real_tokens.json 数据库
function saveRealToken(logEntry) {
    try {
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        let logs = [];
        if (fs.existsSync(tokenDbPath)) {
            try {
                logs = JSON.parse(fs.readFileSync(tokenDbPath, 'utf8'));
            } catch(e) {
                logs = [];
            }
        }
        logs.unshift(logEntry);
        // 保留最近 1000 条
        if (logs.length > 1000) logs = logs.slice(0, 1000);
        fs.writeFileSync(tokenDbPath, JSON.stringify(logs, null, 2), 'utf8');
        console.log(`[TokenGuard] Successfully saved real token log: ${logEntry.model} (${logEntry.input} + ${logEntry.output} tokens)`);
    } catch(err) {
        console.error('[TokenGuard] Failed to save real token:', err);
    }
}

// 统一解析并保存大模型 completions / embeddings 的回包日志
function parseAndSaveCompletionsLog(bodyText, hostOrUrl, elapsedMs) {
    try {
        if (!bodyText) return;
        
        let usage = null;
        
        let inputTokens = 0;
        let outputTokens = 0;
        
        const inMatch = [...bodyText.matchAll(/"(?:prompt_tokens|promptTokenCount|input_tokens)"\s*:\s*(\d+)/gi)];
        if (inMatch.length > 0) inputTokens = parseInt(inMatch[inMatch.length - 1][1]);
        
        const outMatch = [...bodyText.matchAll(/"(?:completion_tokens|candidatesTokenCount|output_tokens)"\s*:\s*(\d+)/gi)];
        if (outMatch.length > 0) outputTokens = parseInt(outMatch[outMatch.length - 1][1]);

        if (inputTokens > 0 || outputTokens > 0) {
            usage = {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens
            };
        }
        
        if (usage) {
            let modelName = 'unknown-model';
            const modelMatch = bodyText.match(/"model"\s*:\s*"([^"]+)"/);
            if (modelMatch) {
                modelName = modelMatch[1];
            }
            
            const now = new Date();
            const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
            
            // 友好商户分类显示
            let provName = 'gateway';
            const cleanUrl = (hostOrUrl || '').toLowerCase();
            if (cleanUrl.includes('siliconflow')) {
                provName = 'siliconflow';
            } else if (cleanUrl.includes('deepseek')) {
                provName = 'deepseek';
            } else if (cleanUrl.includes('openai')) {
                provName = 'openai';
            } else {
                // 从域名中提炼服务商前缀
                try {
                    const hostMatch = cleanUrl.match(/https?:\/\/([^/:]+)/);
                    const host = hostMatch ? hostMatch[1] : cleanUrl;
                    provName = host.split('.')[0] || 'gateway';
                } catch(e) {
                    provName = 'gateway';
                }
            }

            const logEntry = {
                time: timeStr,
                provider: provName,
                model: modelName,
                input: usage.prompt_tokens,
                output: usage.completion_tokens,
                hit: 0,
                duration: `${(elapsedMs / 1000.0).toFixed(1)}s`,
                status: '成功',
                timestamp: Date.now()
            };
            saveRealToken(logEntry);
        }
    } catch (err) {
        console.error('[TokenGuard] Error parsing completions response:', err);
    }
}

// ─── 代理 1：http/https.request 拦截通道 ───
function wrapRequest(originalRequest, defaultProto) {
    return function(options, callback) {
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

        const isCompletions = pathStr.includes('/completions') || pathStr.includes('/embeddings');
        let clientRequest = originalRequest.apply(this, arguments);

        if (isCompletions) {
            clientRequest.on('response', (res) => {
                let chunks = [];
                res.on('data', (chunk) => {
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    const elapsed = Date.now() - startMs;
                    try {
                        const buffer = Buffer.concat(chunks);
                        const bodyText = buffer.toString('utf8');
                        parseAndSaveCompletionsLog(bodyText, host || defaultProto, elapsed);
                    } catch(err) {}
                });
            });
        }
        return clientRequest;
    };
}

http.request = wrapRequest(http.request, 'http');
https.request = wrapRequest(https.request, 'https');
console.log('[TokenGuard] Transparent HTTP/HTTPS request hooks successfully loaded.');

// ─── 代理 2：fetch / globalThis.fetch 拦截通道 (Node 18+ 闭环) ───
function wrapFetch(originalFetch) {
    return async function(input, init) {
        let url = '';
        if (typeof input === 'string') {
            url = input;
        } else if (input && input.url) {
            url = input.url;
        }
        
        const isCompletions = url.includes('/completions') || url.includes('/embeddings');
        const startMs = Date.now();
        
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
        } catch (err) {
            if (url && url.includes('ilinkai')) {
                console.error(`[FetchError] Failed to fetch ${url}. Cause:`, err.cause || err);
            }
            throw err;
        }
    };
}

if (typeof globalThis === 'object' && globalThis.fetch) {
    globalThis.fetch = wrapFetch(globalThis.fetch);
    console.log('[TokenGuard] Transparent globalThis.fetch hook successfully loaded.');
}
if (typeof global === 'object' && global.fetch && global.fetch !== (globalThis && globalThis.fetch)) {
    global.fetch = wrapFetch(global.fetch);
    console.log('[TokenGuard] Transparent global.fetch hook successfully loaded.');
}
