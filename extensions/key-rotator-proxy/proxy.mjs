/**
 * key-rotator-proxy - API key rotation proxy for OpenClaw
 *
 * 监听 18790 端口，自动轮换 API key
 * 任何错误（非 2xx）都会切换到下一个 key
 * 所有 key 都失败时返回错误（不再降级到写死的本地模型）
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

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
    // 全部失败超过3次，重置
    KEYS.forEach((_, i) => { failureCounts[i] = 0; });
    currentIndex = 0;
    return 0;
}

function recordSuccess(keyIdx) {
    failureCounts[keyIdx] = 0;
}

function recordFailure(keyIdx) {
    failureCounts[keyIdx] = (failureCounts[keyIdx] || 0) + 1;
    console.log(`[key-rotator] Key #${keyIdx + 1} failed (failures: ${failureCounts[keyIdx]})`);
}

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
            authorization: `Bearer ${key}`,
            host: upstreamUrl.hostname,
            'content-length': req.headers['content-length'] ? parseInt(req.headers['content-length']) : 0,
        },
        rejectUnauthorized: true,
    };

    const proxyReq = transport.request(options, (proxyRes) => {
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
            recordSuccess(keyIdx);
            proxyRes.pipe(res);
        } else {
            // 任何非成功状态码都记录失败并切换 key
            recordFailure(keyIdx);
            console.log(`[key-rotator] Status ${proxyRes.statusCode} on key #${keyIdx + 1}, rotating...`);

            // 尝试下一个 key
            const nextIdx = getNextKey();
            const nextKey = KEYS[nextIdx];
            const nextUrl = new URL(req.url, BASE_URL);

            const retryOptions = {
                hostname: nextUrl.hostname,
                port: nextUrl.port || 443,
                path: nextUrl.pathname + nextUrl.search,
                method: req.method,
                headers: {
                    ...req.headers,
                    authorization: `Bearer ${nextKey}`,
                    host: nextUrl.hostname,
                    'content-length': req.headers['content-length'] ? parseInt(req.headers['content-length']) : 0,
                },
                rejectUnauthorized: true,
            };

            const retryTransport = nextUrl.protocol === 'https:' ? https : http;
            const retryReq = retryTransport.request(retryOptions, (retryRes) => {
                if (retryRes.statusCode >= 200 && retryRes.statusCode < 300) {
                    recordSuccess(nextIdx);
                    retryRes.pipe(res);
                } else {
                    recordFailure(nextIdx);
                    console.log(`[key-rotator] Retry also failed on key #${nextIdx + 1} (${retryRes.statusCode}), giving up`);
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'All keys exhausted',
                        triedKeys: [keyIdx + 1, nextIdx + 1],
                    }));
                }
            });

            retryReq.on('error', (err) => {
                recordFailure(nextIdx);
                console.log(`[key-rotator] Retry error on key #${nextIdx + 1}: ${err.message}`);
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Proxy error', triedKeys: [keyIdx + 1, nextIdx + 1] }));
            });

            // 转发原始请求体
            req.pipe(retryReq);
        }
    });

    proxyReq.on('error', (err) => {
        recordFailure(keyIdx);
        console.log(`[key-rotator] Connection error on key #${keyIdx + 1}: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error', key: keyIdx + 1, detail: err.message }));
    });

    req.pipe(proxyReq);
});

server.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log(`[key-rotator] Listening on http://127.0.0.1:${LOCAL_PORT}`);
    console.log(`[key-rotator] ${KEYS.length} keys configured`);
    console.log(`[key-rotator] Auto-rotate on any non-2xx status or error`);
});
