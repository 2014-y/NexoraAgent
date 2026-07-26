/**
 * key-rotator-proxy - API key rotation proxy for OpenClaw
 * 监听本地端口，自动轮换 API key
 * 当收到 429 时自动切换到下一个 key
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Agnes API 密钥加载器。
 * 安全警告：历史内联的 sk- 密钥已泄露（COMPROMISED），已移出源码，用户必须尽快轮换/吊销。
 * 加载优先级：env AGNES_API_KEYS(逗号分隔)/AGNES_API_KEY
 *   → ~/.openclaw/openclaw.json (models.providers.agnes-ai.apiKey)
 *   → 本地兜底文件 media-cli/media-core/.agnes-keys.json
 */
function loadAgnesApiKeys() {
    // 1) 环境变量
    const envList = process.env.AGNES_API_KEYS || process.env.AGNES_API_KEY;
    if (envList) {
        const keys = String(envList).split(',').map(s => s.trim()).filter(Boolean);
        if (keys.length) return keys;
    }
    // 2) openclaw.json 配置
    try {
        const cfgPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const p = cfg && cfg.models && cfg.models.providers && cfg.models.providers['agnes-ai'];
        const apiKey = p && p.apiKey;
        if (Array.isArray(apiKey)) {
            const keys = apiKey.map(s => String(s).trim()).filter(Boolean);
            if (keys.length) return keys;
        } else if (apiKey && String(apiKey).trim()) {
            return [String(apiKey).trim()];
        }
    } catch (e) { /* 忽略：配置不存在或无效 */ }
    // 3) 本地兜底文件（密钥已泄露，仅兜底；兼容直挂与嵌套目录两种布局）
    const candidates = [
        path.join(__dirname, '.agnes-keys.json'),
        path.join(__dirname, '..', '..', 'media-cli', 'media-core', '.agnes-keys.json'),
        path.join(__dirname, '..', '..', '..', 'media-cli', 'media-core', '.agnes-keys.json'),
    ];
    for (const filePath of candidates) {
        try {
            const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (Array.isArray(arr)) {
                const keys = arr.map(s => String(s).trim()).filter(Boolean);
                if (keys.length) return keys;
            }
        } catch (e) { /* 忽略 */ }
    }
    return [];
}

const KEYS = loadAgnesApiKeys();

const BASE_URL = 'https://apihub.agnes-ai.com';
const LOCAL_PORT = 18790;

let currentIndex = 0;
let failureCounts = {};
KEYS.forEach((_, i) => { failureCounts[i] = 0; });

function getNextKey() {
    for (let i = 0; i < KEYS.length; i++) {
        const idx = (currentIndex + i) % KEYS.length;
        if ((failureCounts[idx] || 0) < 3) {
            currentIndex = idx;
            return idx;
        }
    }
    KEYS.forEach((_, i) => { failureCounts[i] = 0; });
    currentIndex = 0;
    return 0;
}

function recordSuccess(keyIdx) { failureCounts[keyIdx] = 0; }
function recordFailure(keyIdx) { failureCounts[keyIdx] = (failureCounts[keyIdx] || 0) + 1; }

const server = http.createServer((req, res) => {
    const keyIdx = getNextKey();
    const key = KEYS[keyIdx];
    
    const upstreamUrl = new URL(req.url, BASE_URL);
    const transport = upstreamUrl.protocol === 'https:' ? https : http;
    
    const options = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || 443,
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: req.method,
        headers: {
            ...req.headers,
            authorization: 'Bearer ' + key,
            host: upstreamUrl.hostname,
            'content-length': req.headers['content-length'] ? parseInt(req.headers['content-length']) : 0,
        },
        rejectUnauthorized: true,
    };

    const proxyReq = transport.request(options, (proxyRes) => {
        if (proxyRes.statusCode === 429) {
            recordFailure(keyIdx);
            console.log('[proxy] 429 on key #' + (keyIdx+1) + ' (fails: ' + failureCounts[keyIdx] + '), rotating...');
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            let body = '';
            proxyRes.on('data', chunk => body += chunk);
            proxyRes.on('end', () => res.end(body));
        } else {
            recordSuccess(keyIdx);
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        }
    });

    proxyReq.on('error', (err) => {
        recordFailure(keyIdx);
        console.log('[proxy] Error on key #' + (keyIdx+1) + ': ' + err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error', key: keyIdx + 1 }));
    });

    req.pipe(proxyReq);
});

server.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log('[proxy] Listening on http://127.0.0.1:' + LOCAL_PORT);
    console.log('[proxy] ' + KEYS.length + ' keys configured');
    console.log('[proxy] Auto-rotate on 429 (max 3 failures per key)');
});
