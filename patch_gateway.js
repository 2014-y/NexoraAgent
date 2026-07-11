const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// 统一日志写入数据库路径 (自适应获取用户主目录，解决硬编码用户名 Yuan 导致别人的白机用量失效的重大 Bug)
const homeDir = process.env.USERPROFILE || process.env.HOME || (process.env.HOMEDRIVE + process.env.HOMEPATH) || 'C:\\';
const logDir = path.join(homeDir, '.openclaw', 'persistent_logs');
const tokenDbPath = path.join(logDir, 'real_tokens.json');

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
        
        // 1. 正则匹配 prompt_tokens 和 completion_tokens (兼容流式和非流式)
        const matchAlt = /"prompt_tokens"\s*:\s*(\d+)\s*,\s*"completion_tokens"\s*:\s*(\d+)/i;
        const matchAltRes = bodyText.match(matchAlt);
        if (matchAltRes) {
            usage = {
                prompt_tokens: parseInt(matchAltRes[1]),
                completion_tokens: parseInt(matchAltRes[2])
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
        
        if (isCompletions) {
            try {
                const response = await originalFetch.apply(this, arguments);
                const contentType = response.headers.get('content-type') || '';
                if (!contentType.includes('text/event-stream')) {
                    const cloneRes = response.clone();
                    const elapsed = Date.now() - startMs;
                    
                    cloneRes.text().then(bodyText => {
                        parseAndSaveCompletionsLog(bodyText, url, elapsed);
                    }).catch(() => {});
                }
                
                return response;
            } catch (err) {
                throw err;
            }
        }
        return originalFetch.apply(this, arguments);
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
