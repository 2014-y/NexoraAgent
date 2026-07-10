/**
 * key-rotator-proxy - API key rotation proxy for OpenClaw
 * 监听本地端口，自动轮换 API key
 * 当收到 429 时自动切换到下一个 key
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const KEYS = [
    'sk-z2NHJlR99oODMYvS9C5u8qLMNf6hmc9vRm5JenvHHStTfxZn',
    'sk-ct7MSvbC8LqL1gGqJuoVCKgjtecXwbjIUZhXQ0gITEaksCS0',
    'sk-nZtkk9AAyZl3sbkv8Gw4R1R99NnkgUWhRGL4Cp0Dl7LSPsUu',
    'sk-Y6ORz4nnuXHUpwjdXv2WlmLMwCfPBMtmh69iuXxZkQtZazyV',
    'sk-GhS6TUB6W8LibJT5whDhbUvmYW3csM0HdGDdjotpgadQbd2F',
    'sk-HV5HINAfAhMJOnYxYp83ZXDLqeudt8ofLtdm9Bj5p9SUOUGh',
    'sk-95sX8HnNOhh8FFfAm3ccOgGFg6MA8yf7zU5PEEQdGxSuKhQY',
];

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
