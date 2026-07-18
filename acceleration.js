'use strict';
/**
 * 加速通道：基于 mihomo (Clash Meta) 内核的本地代理管理。
 * 支持订阅 URL / 本地文件导入，节点选择，启停后为网关注入 HTTP(S)_PROXY。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');
const crypto = require('crypto');
const zlib = require('zlib');
const net = require('net');
const accelerationCoreConfig = require('./config/acceleration-core.json');

let MIXED_PORT = 17890;
const CONTROLLER_HOST = '127.0.0.1';
let CONTROLLER_PORT = 19090;
const CONTROLLER_SECRET = 'nexora-acc-secret';
const MIHOMO_VERSION = accelerationCoreConfig.mihomoVersion;

const NO_PROXY_LIST = [
    'localhost',
    '127.0.0.1',
    '::1',
    '0.0.0.0',
    '.weixin.qq.com',
    '.qq.com',
    '.wechat.com',
    '.feishu.cn',
    '.feishu.net',
    '.larksuite.com',
    '.dingtalk.com'
].join(',');

let appRef = null;
let mihomoProc = null;
let lastMihomoMemoryText = 'INACTIVE';
let mihomoMemoryTimer = null;
let tempMihomoProc = null;
let tempCoreProfileId = null;
let tempCoreIdleTimer = null;
let lastDelayTestResults = null;
let state = {
    enabled: false,
    activeProfileId: null,
    selectedProxy: null,
    selectedGroup: 'GLOBAL',
    mode: 'rule',
    systemProxy: false,
    virtualNic: false
};

function getRootDir() {
    const base = appRef && appRef.getPath
        ? appRef.getPath('userData')
        : path.join(process.env.APPDATA || process.cwd(), 'Nexora Agent');
    return path.join(base, 'acceleration');
}

function getProfilesDir() {
    return path.join(getRootDir(), 'profiles');
}

function getCoreDir() {
    return path.join(getRootDir(), 'core');
}

function getBundledCoreDir() {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const relative = path.join('acceleration-core', `${process.platform}-${arch}`);
    const candidates = [
        path.join(process.resourcesPath || '', relative),
        path.join(__dirname, 'build-resources', relative)
    ];
    return candidates.find((candidate) => {
        try {
            return candidate && fs.existsSync(path.join(candidate, 'core-manifest.json'));
        } catch (e) {
            return false;
        }
    }) || null;
}

function fileSha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copyBundledFileIfNeeded(source, destination, expectedSha256, minSize) {
    try {
        if (!fs.existsSync(source)) return false;
        const sourceStat = fs.statSync(source);
        if (!sourceStat.isFile() || sourceStat.size < minSize) return false;
        const sourceHash = expectedSha256 || fileSha256(source);
        if (expectedSha256 && sourceHash !== expectedSha256) {
            throw new Error(`内置文件校验失败: ${path.basename(source)}`);
        }
        if (fs.existsSync(destination)) {
            try {
                const destinationStat = fs.statSync(destination);
                if (destinationStat.isFile()
                    && destinationStat.size >= minSize
                    && fileSha256(destination) === sourceHash) {
                    return true;
                }
            } catch (e) {}
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.bundled.tmp`;
        fs.copyFileSync(source, temporary);
        fs.renameSync(temporary, destination);
        return true;
    } catch (e) {
        try { fs.rmSync(`${destination}.bundled.tmp`, { force: true }); } catch (ignored) {}
        console.warn('[Acceleration] bundled core copy failed:', e && e.message);
        return false;
    }
}

/** 安装包随附内核：首次启动复制到可写 userData，联网下载只作为兜底。 */
function installBundledCore() {
    ensureDirs();
    const bundledDir = getBundledCoreDir();
    if (!bundledDir) return { success: false, bundled: false };
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(bundledDir, 'core-manifest.json'), 'utf8'));
        const mihomo = manifest.files && manifest.files.mihomo;
        const wintun = manifest.files && manifest.files.wintun;
        const geoip = manifest.files && manifest.files.geoip;
        const geosite = manifest.files && manifest.files.geosite;
        const coreReady = mihomo && copyBundledFileIfNeeded(
            path.join(bundledDir, mihomo.name || 'mihomo.exe'),
            getMihomoPath(),
            mihomo.sha256,
            1024 * 1024
        );
        const wintunReady = process.platform !== 'win32' || (wintun && copyBundledFileIfNeeded(
            path.join(bundledDir, wintun.name || 'wintun.dll'),
            getWintunPath(),
            wintun.sha256,
            32 * 1024
        ));
        if (wintunReady && process.platform === 'win32') {
            try { fs.copyFileSync(getWintunPath(), path.join(getRootDir(), 'wintun.dll')); } catch (e) {}
        }
        // mihomo -d 工作目录读取 geoip.dat / geosite.dat；内置后无需联网下载
        if (geoip) {
            copyBundledFileIfNeeded(
                path.join(bundledDir, geoip.name || 'geoip.dat'),
                path.join(getRootDir(), 'geoip.dat'),
                geoip.sha256,
                Number(geoip.minSize) || 1024 * 1024
            );
        }
        if (geosite) {
            copyBundledFileIfNeeded(
                path.join(bundledDir, geosite.name || 'geosite.dat'),
                path.join(getRootDir(), 'geosite.dat'),
                geosite.sha256,
                Number(geosite.minSize) || 100 * 1024
            );
        }
        return { success: !!coreReady, bundled: true, wintunReady: !!wintunReady };
    } catch (e) {
        console.warn('[Acceleration] bundled core manifest invalid:', e && e.message);
        return { success: false, bundled: true, error: e.message || String(e) };
    }
}

function stripYamlTopLevelBlocks(body, dropKeys, blockDropKeys) {
    let inBlock = false;
    const lines = String(body || '').split(/\r?\n/).filter((line) => {
        const trimmed = line.trim();
        if (dropKeys.some((re) => re.test(trimmed))) return false;
        if (blockDropKeys.some((re) => re.test(line))) {
            inBlock = true;
            return false;
        }
        if (inBlock) {
            if (/^\s+/.test(line) || trimmed === '') return false;
            inBlock = false;
        }
        return true;
    });
    return lines.join('\n');
}

function getStatePath() {
    return path.join(getRootDir(), 'state.json');
}

function getRuntimeConfigPath() {
    return path.join(getRootDir(), 'runtime-config.yaml');
}

function ensureDirs() {
    for (const d of [getRootDir(), getProfilesDir(), getCoreDir()]) {
        try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
    }
}

function init(electronApp) {
    appRef = electronApp;
    ensureDirs();
    installBundledCore();
    bootstrapSecondaryAccelerationFromPrimary();
    loadState();
}

/** 多开第 2+ 实例：从主实例拷贝订阅与内核，避免空白起步 */
function bootstrapSecondaryAccelerationFromPrimary() {
    try {
        const inst = (typeof global !== 'undefined' && global.nexoraInstance) ? global.nexoraInstance : null;
        if (!inst || inst.id <= 1 || !inst.primaryUserData) return;
        const primaryRoot = path.join(inst.primaryUserData, 'acceleration');
        const myRoot = getRootDir();
        if (!fs.existsSync(primaryRoot)) return;

        const copyFileIfMissing = (rel) => {
            const src = path.join(primaryRoot, rel);
            const dst = path.join(myRoot, rel);
            if (!fs.existsSync(src) || fs.existsSync(dst)) return;
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
        };
        const copyDirIfMissing = (rel) => {
            const src = path.join(primaryRoot, rel);
            const dst = path.join(myRoot, rel);
            if (!fs.existsSync(src)) return;
            if (fs.existsSync(dst)) {
                try {
                    if (fs.readdirSync(dst).length > 0) return;
                } catch (e) {}
            }
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
        };

        copyFileIfMissing('profiles.json');
        copyDirIfMissing('profiles');
        copyDirIfMissing('core');
        // 不复制 state.json / runtime-config：端口与启用状态各自独立
    } catch (e) {
        console.warn('[Acceleration] secondary bootstrap skipped:', e && e.message);
    }
}

function loadState() {
    try {
        const p = getStatePath();
        if (!fs.existsSync(p)) return;
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        state = { ...state, ...raw };
    } catch (e) {}
}

function saveState() {
    ensureDirs();
    try {
        fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {}
}

function getMihomoExeName() {
    return process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
}

function getMihomoPath() {
    return path.join(getCoreDir(), getMihomoExeName());
}

/** 打包后内核落在 userData（可写），绝不依赖 asar 内路径 */
function assertCoreRunnable() {
    const exe = getMihomoPath();
    if (!fs.existsSync(exe)) return { ok: false, error: '内核文件不存在' };
    try {
        const st = fs.statSync(exe);
        if (!st.isFile() || st.size < 1024) return { ok: false, error: '内核文件损坏' };
    } catch (e) {
        return { ok: false, error: e.message || String(e) };
    }
    // 防止落在只读 asar 路径（异常配置时）
    if (exe.includes('app.asar') && !exe.includes('app.asar.unpacked')) {
        return { ok: false, error: '内核路径不可执行（asar），请重新下载内核' };
    }
    return { ok: true, path: exe };
}

function isCoreReady() {
    try {
        return assertCoreRunnable().ok;
    } catch (e) {
        return false;
    }
}

function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const follow = (currentUrl, redirects) => {
            if (redirects > 8) return reject(new Error('Too many redirects'));
            let parsed;
            try { parsed = new URL(currentUrl); } catch (e) { return reject(e); }
            const lib = parsed.protocol === 'https:' ? https : http;
            const req = lib.get(currentUrl, {
                headers: { 'User-Agent': 'NexoraAgent/2.0', Accept: '*/*' },
                timeout: 120000
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    const next = new URL(res.headers.location, currentUrl).toString();
                    return follow(next, redirects + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    try {
                        fs.writeFileSync(destPath, Buffer.concat(chunks));
                        resolve(destPath);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Download timeout'));
            });
        };
        follow(url, 0);
    });
}

function getWintunPath() {
    return path.join(getCoreDir(), 'wintun.dll');
}

function isWintunReady() {
    try {
        return fs.existsSync(getWintunPath()) && fs.statSync(getWintunPath()).size > 1024;
    } catch (e) {
        return false;
    }
}

function isProcessElevated() {
    if (process.platform !== 'win32') return true;
    try {
        execSync('net session', { stdio: 'ignore', windowsHide: true });
        return true;
    } catch (e) {
        return false;
    }
}

async function ensureWintun(onProgress) {
    if (process.platform !== 'win32') return { success: true, skipped: true };
    ensureDirs();
    if (isWintunReady()) return { success: true, path: getWintunPath() };
    installBundledCore();
    if (isWintunReady()) return { success: true, path: getWintunPath(), bundled: true };

    const zipUrl = 'https://www.wintun.net/builds/wintun-0.14.1.zip';
    const mirrors = [
        zipUrl,
        `https://ghproxy.net/${zipUrl}`,
        `https://mirror.ghproxy.com/${zipUrl}`
    ];
    const tmpZip = path.join(getCoreDir(), 'wintun-0.14.1.zip');
    let lastErr = null;
    for (const url of mirrors) {
        try {
            if (typeof onProgress === 'function') onProgress({ stage: 'download', url, label: 'wintun' });
            await downloadFile(url, tmpZip);
            lastErr = null;
            break;
        } catch (e) {
            lastErr = e;
        }
    }
    if (lastErr) {
        return { success: false, error: `下载 wintun.dll 失败: ${lastErr.message || lastErr}` };
    }

    try {
        if (typeof onProgress === 'function') onProgress({ stage: 'extract', label: 'wintun' });
        const extractDir = path.join(getCoreDir(), '_wintun_extract');
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
        fs.mkdirSync(extractDir, { recursive: true });
        await extractZipWindows(tmpZip, extractDir);

        const archDir = process.arch === 'arm64' ? 'arm64' : 'amd64';
        const walk = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    const hit = walk(full);
                    if (hit) return hit;
                } else if (/^wintun\.dll$/i.test(ent.name) && full.toLowerCase().includes(path.join('bin', archDir).toLowerCase())) {
                    return full;
                }
            }
            // fallback: any wintun.dll under arch folder name
            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    const hit = walk(full);
                    if (hit) return hit;
                } else if (/^wintun\.dll$/i.test(ent.name) && full.toLowerCase().includes(archDir)) {
                    return full;
                }
            }
            return null;
        };
        let dllSrc = walk(extractDir);
        if (!dllSrc) {
            // last resort: first wintun.dll found
            const walkAny = (dir) => {
                for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, ent.name);
                    if (ent.isDirectory()) {
                        const hit = walkAny(full);
                        if (hit) return hit;
                    } else if (/^wintun\.dll$/i.test(ent.name)) return full;
                }
                return null;
            };
            dllSrc = walkAny(extractDir);
        }
        if (!dllSrc) return { success: false, error: 'wintun 压缩包内未找到 wintun.dll' };
        fs.copyFileSync(dllSrc, getWintunPath());
        // 工作目录也可能被内核检索
        try { fs.copyFileSync(dllSrc, path.join(getRootDir(), 'wintun.dll')); } catch (e) {}
        try { fs.unlinkSync(tmpZip); } catch (e) {}
        try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
        if (!isWintunReady()) return { success: false, error: 'wintun.dll 安装失败' };
        return { success: true, path: getWintunPath() };
    } catch (e) {
        return { success: false, error: `安装 wintun 失败: ${e.message || e}` };
    }
}

async function probeTunActuallyOn() {
    try {
        const cfg = await controllerRequest('GET', '/configs');
        return !!(cfg && cfg.tun && cfg.tun.enable);
    } catch (e) {
        return false;
    }
}

async function assertTunPrerequisites() {
    if (process.platform !== 'win32') return { ok: true };
    const wintun = await ensureWintun();
    if (!wintun.success) {
        return { ok: false, error: wintun.error || '缺少 wintun.dll，无法开启 TUN' };
    }
    if (!isProcessElevated()) {
        return {
            ok: false,
            error: 'TUN 需要管理员权限：请关闭应用后，右键「以管理员身份运行」Nexora Agent，再开启虚拟网卡'
        };
    }
    return { ok: true };
}

async function ensureCore(onProgress) {
    ensureDirs();
    if (isCoreReady()) return { success: true, path: getMihomoPath() };
    installBundledCore();
    if (isCoreReady()) return { success: true, path: getMihomoPath(), bundled: true };

    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const zipName = process.platform === 'win32'
        ? `mihomo-windows-${arch}-${MIHOMO_VERSION}.zip`
        : process.platform === 'darwin'
            ? `mihomo-darwin-${arch}-${MIHOMO_VERSION}.gz`
            : `mihomo-linux-${arch}-${MIHOMO_VERSION}.gz`;
    const githubUrl = `https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${zipName}`;
    const mirrors = [
        githubUrl,
        `https://ghproxy.net/${githubUrl}`,
        `https://mirror.ghproxy.com/${githubUrl}`
    ];

    const tmpPath = path.join(getCoreDir(), zipName);
    let lastErr = null;
    for (const url of mirrors) {
        try {
            if (typeof onProgress === 'function') onProgress({ stage: 'download', url });
            await downloadFile(url, tmpPath);
            lastErr = null;
            break;
        } catch (e) {
            lastErr = e;
        }
    }
    if (lastErr) {
        return { success: false, error: `下载代理内核失败: ${lastErr.message || lastErr}` };
    }

    try {
        if (typeof onProgress === 'function') onProgress({ stage: 'extract' });
        if (zipName.endsWith('.zip')) {
            await extractZipWindows(tmpPath, getCoreDir());
        } else {
            const gunzipped = zlib.gunzipSync(fs.readFileSync(tmpPath));
            fs.writeFileSync(getMihomoPath(), gunzipped);
            try { fs.chmodSync(getMihomoPath(), 0o755); } catch (e) {}
        }
        try { fs.unlinkSync(tmpPath); } catch (e) {}
        if (!isCoreReady()) {
            // zip 内可能带版本号文件名，扫描目录
            const files = fs.readdirSync(getCoreDir());
            const hit = files.find((f) => /^mihomo/i.test(f) && (f.endsWith('.exe') || !f.includes('.')));
            if (hit) {
                const src = path.join(getCoreDir(), hit);
                if (src !== getMihomoPath()) {
                    try { fs.renameSync(src, getMihomoPath()); } catch (e) {
                        fs.copyFileSync(src, getMihomoPath());
                    }
                }
            }
        }
        if (!isCoreReady()) {
            return { success: false, error: '内核解压后未找到 mihomo 可执行文件' };
        }
        // Windows TUN 依赖同目录 wintun.dll
        if (process.platform === 'win32') {
            try { await ensureWintun(onProgress); } catch (e) {}
        }
        return { success: true, path: getMihomoPath() };
    } catch (e) {
        return { success: false, error: `解压内核失败: ${e.message || e}` };
    }
}

function extractZipWindows(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${destDir.replace(/'/g, "''")}')
`;
        const child = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', ps], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let err = '';
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(err || `unzip exit ${code}`));
        });
        child.on('error', reject);
    });
}

function fetchText(url, redirects = 0) {
    return fetchSubscription(url, redirects).then((r) => r.content);
}

function isPortProbablyOpen(port, host = '127.0.0.1', timeoutMs = 400) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port, timeout: timeoutMs }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('error', () => resolve(false));
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
    });
}

function formatSubscriptionFetchError(err) {
    const msg = String((err && err.message) || err || '');
    if (/ETIMEDOUT|timeout|超时/i.test(msg)) {
        return '订阅地址连接超时。该订阅可能需走代理才能访问：请先启用已有配置后再添加，或改用「文件」导入';
    }
    if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|connect/i.test(msg)) {
        return '无法连接订阅服务器。请检查网络，或先启用已有加速配置后再添加';
    }
    if (/代理 CONNECT/i.test(msg)) {
        return '本地代理不可用，无法拉取订阅。请先启用 Nexora Clash，或改用文件导入';
    }
    return msg || '拉取订阅失败';
}

function parseFetchedSubscriptionBody(buf, headers) {
    let text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    const trimmed = text.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length > 80) {
        try {
            const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
            if (decoded.includes('proxies:') || decoded.includes('proxy-groups:') || decoded.includes('port:')) {
                text = decoded;
            }
        } catch (e) {}
    }
    const headerRaw = getResponseHeader(headers, 'subscription-userinfo');
    const headerInfo = parseSubscriptionUserInfo(headerRaw);
    const yamlInfo = parseUserInfoFromYaml(text);
    return {
        content: text,
        userInfo: mergeUserInfo(headerInfo, yamlInfo),
        headers: headers || {}
    };
}

function fetchSubscriptionDirect(url, redirects, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (redirects > 8) return reject(new Error('Too many redirects'));
        let parsed;
        try { parsed = new URL(url); } catch (e) { return reject(e); }
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.get(url, {
            headers: {
                'User-Agent': 'ClashMetaForAndroid/2.11.1',
                Accept: '*/*'
            },
            timeout: timeoutMs
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return fetchSubscriptionDirect(new URL(res.headers.location, url).toString(), redirects + 1, timeoutMs).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    resolve(parseFetchedSubscriptionBody(Buffer.concat(chunks), res.headers));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('请求超时'));
        });
    });
}

function fetchSubscriptionViaProxy(url, proxyPort, redirects, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (redirects > 8) return reject(new Error('Too many redirects'));
        let parsed;
        try { parsed = new URL(url); } catch (e) { return reject(e); }
        const targetPort = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
        const connectReq = http.request({
            host: '127.0.0.1',
            port: proxyPort,
            method: 'CONNECT',
            path: `${parsed.hostname}:${targetPort}`,
            timeout: timeoutMs,
            headers: {
                Host: `${parsed.hostname}:${targetPort}`,
                'User-Agent': 'ClashMetaForAndroid/2.11.1',
                'Proxy-Connection': 'keep-alive'
            }
        });
        connectReq.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                return reject(new Error(`代理 CONNECT 失败 HTTP ${res.statusCode}`));
            }
            const finishWithSocket = (transport) => {
                const pathAndQuery = parsed.pathname + (parsed.search || '');
                const reqHeaders = [
                    `GET ${pathAndQuery} HTTP/1.1`,
                    `Host: ${parsed.host}`,
                    'User-Agent: ClashMetaForAndroid/2.11.1',
                    'Accept: */*',
                    'Connection: close',
                    '',
                    ''
                ].join('\r\n');
                const chunks = [];
                let settled = false;
                const done = (err, result) => {
                    if (settled) return;
                    settled = true;
                    try { transport.destroy(); } catch (e) {}
                    if (err) reject(err);
                    else resolve(result);
                };
                const timer = setTimeout(() => done(new Error('请求超时')), timeoutMs);
                transport.on('error', (e) => {
                    clearTimeout(timer);
                    done(e);
                });
                let buffer = Buffer.alloc(0);
                let headerEnd = -1;
                let statusCode = 0;
                let responseHeaders = {};
                transport.on('data', (c) => {
                    buffer = Buffer.concat([buffer, c]);
                    if (headerEnd < 0) {
                        headerEnd = buffer.indexOf('\r\n\r\n');
                        if (headerEnd < 0) return;
                        const head = buffer.slice(0, headerEnd).toString('utf8');
                        const lines = head.split('\r\n');
                        const m = /^HTTP\/\d\.\d\s+(\d+)/i.exec(lines[0] || '');
                        statusCode = m ? parseInt(m[1], 10) : 0;
                        responseHeaders = {};
                        for (let i = 1; i < lines.length; i++) {
                            const idx = lines[i].indexOf(':');
                            if (idx < 0) continue;
                            const k = lines[i].slice(0, idx).trim().toLowerCase();
                            const v = lines[i].slice(idx + 1).trim();
                            responseHeaders[k] = v;
                        }
                        buffer = buffer.slice(headerEnd + 4);
                    }
                });
                transport.on('end', () => {
                    clearTimeout(timer);
                    if (statusCode >= 300 && statusCode < 400 && responseHeaders.location) {
                        return fetchSubscriptionViaProxy(new URL(responseHeaders.location, url).toString(), proxyPort, redirects + 1, timeoutMs).then(
                            (r) => done(null, r),
                            (e) => done(e)
                        );
                    }
                    if (statusCode !== 200) {
                        return done(new Error(`HTTP ${statusCode || '未知'}`));
                    }
                    try {
                        done(null, parseFetchedSubscriptionBody(buffer, responseHeaders));
                    } catch (e) {
                        done(e);
                    }
                });
                transport.write(reqHeaders);
            };

            if (parsed.protocol === 'https:') {
                const tlsSocket = tls.connect({
                    socket,
                    servername: parsed.hostname,
                    rejectUnauthorized: false
                }, () => finishWithSocket(tlsSocket));
                tlsSocket.on('error', reject);
            } else {
                finishWithSocket(socket);
            }
        });
        connectReq.on('error', reject);
        connectReq.on('timeout', () => {
            connectReq.destroy();
            reject(new Error('请求超时'));
        });
        connectReq.end();
    });
}

async function resolveSubscriptionProxyPort() {
    if ((state.enabled && mihomoProc) || (tempMihomoProc && !tempMihomoProc.killed)) {
        if (MIXED_PORT > 0 && await isPortProbablyOpen(MIXED_PORT)) return MIXED_PORT;
    }
    for (const port of [7890, 7897, 7891, 10809]) {
        if (await isPortProbablyOpen(port)) return port;
    }
    return null;
}

async function fetchSubscription(url, redirects = 0) {
    const timeoutMs = 20000;
    let lastErr = null;
    try {
        return await fetchSubscriptionDirect(url, redirects, timeoutMs);
    } catch (e) {
        lastErr = e;
    }

    let proxyPort = await resolveSubscriptionProxyPort();
    let startedTempForFetch = false;
    if (!proxyPort && state.activeProfileId && !state.enabled) {
        try {
            const started = await startTempMihomoCore();
            if (started && started.ok && MIXED_PORT > 0) {
                proxyPort = MIXED_PORT;
                startedTempForFetch = true;
            }
        } catch (e) {}
    }
    if (proxyPort) {
        try {
            return await fetchSubscriptionViaProxy(url, proxyPort, redirects, timeoutMs);
        } catch (e) {
            lastErr = e;
        } finally {
            if (startedTempForFetch) scheduleTempCoreIdleStop();
        }
    }
    throw new Error(formatSubscriptionFetchError(lastErr));
}

function getResponseHeader(headers, name) {
    if (!headers) return '';
    const key = String(name || '').toLowerCase();
    const raw = headers[key] || headers[name];
    if (Array.isArray(raw)) return String(raw[0] || '').trim();
    return String(raw || '').trim();
}

function parseSubscriptionUserInfo(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const map = {};
    for (const part of text.split(/[;\n]/)) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const key = part.slice(0, idx).trim().toLowerCase();
        const val = Number(part.slice(idx + 1).trim());
        if (key && Number.isFinite(val)) map[key] = val;
    }
    const upload = map.upload || 0;
    const download = map.download || 0;
    const total = map.total || 0;
    const expire = map.expire || 0;
    if (!upload && !download && !total && !expire) return null;
    const used = upload + download;
    return {
        upload,
        download,
        total,
        expire,
        used,
        remain: total > 0 ? Math.max(0, total - used) : null,
        updatedAt: Date.now(),
        fromHeader: true
    };
}

function parseUserInfoFromYaml(yamlText) {
    const text = String(yamlText || '');
    let remainBytes = null;
    let expireMs = null;
    let resetDays = null;

    const remainMatch = text.match(/剩余流量\s*[：:]\s*([\d.]+)\s*(TB|GB|MB|KB)?/i);
    if (remainMatch) {
        const n = parseFloat(remainMatch[1]);
        const unit = (remainMatch[2] || 'GB').toUpperCase();
        if (Number.isFinite(n)) {
            const mul = unit === 'TB' ? 1024 ** 4 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : 1024 ** 3;
            remainBytes = Math.round(n * mul);
        }
    }
    const expireMatch = text.match(/套餐到期\s*[：:]\s*(\d{4}-\d{1,2}-\d{1,2})/i)
        || text.match(/到期\s*[：:]\s*(\d{4}-\d{1,2}-\d{1,2})/i);
    if (expireMatch) {
        const t = Date.parse(expireMatch[1].replace(/-/g, '/'));
        if (Number.isFinite(t)) expireMs = t;
    }
    const resetMatch = text.match(/距离下次重置剩余\s*[：:]\s*(\d+)\s*天/i)
        || text.match(/重置剩余\s*[：:]\s*(\d+)\s*天/i);
    if (resetMatch) resetDays = parseInt(resetMatch[1], 10);

    if (remainBytes == null && expireMs == null && resetDays == null) return null;
    return {
        upload: 0,
        download: 0,
        total: 0,
        expire: expireMs ? Math.floor(expireMs / 1000) : 0,
        used: 0,
        remain: remainBytes,
        resetDays: Number.isFinite(resetDays) ? resetDays : null,
        updatedAt: Date.now(),
        fromNodes: true
    };
}

/** 合并订阅头与节点名信息：头负责 total/已用，节点名可补 remain/重置天数 */
function mergeUserInfo(primary, secondary) {
    if (!primary && !secondary) return null;
    const a = primary || {};
    const b = secondary || {};
    const upload = Number(a.upload) || Number(b.upload) || 0;
    const download = Number(a.download) || Number(b.download) || 0;
    const total = Number(a.total) || Number(b.total) || 0;
    let used = a.used != null ? Number(a.used) : (b.used != null ? Number(b.used) : null);
    if (!(used > 0) && (upload > 0 || download > 0)) used = upload + download;
    if (!(used >= 0)) used = 0;
    let remain = a.remain != null ? Number(a.remain) : (b.remain != null ? Number(b.remain) : null);
    if (remain == null && total > 0) remain = Math.max(0, total - used);
    const expire = Number(a.expire) || Number(b.expire) || 0;
    const resetDays = a.resetDays != null ? a.resetDays : b.resetDays;
    return {
        upload,
        download,
        total,
        expire,
        used,
        remain,
        resetDays: resetDays != null && Number.isFinite(Number(resetDays)) ? Number(resetDays) : null,
        updatedAt: Date.now(),
        fromHeader: !!(a.fromHeader || b.fromHeader || total > 0),
        fromNodes: !!(a.fromNodes || b.fromNodes)
    };
}

function enrichProfileUserInfo(profile) {
    if (!profile || !profile.id) return profile;
    try {
        const content = getProfileContent(profile.id);
        const yamlInfo = content ? parseUserInfoFromYaml(content) : null;
        if (profile.userInfo || yamlInfo) {
            profile.userInfo = mergeUserInfo(profile.userInfo, yamlInfo);
        }
    } catch (e) {}
    return profile;
}

let lastIncompleteUserInfoRefreshAt = 0;
const INCOMPLETE_USERINFO_REFRESH_MS = 10 * 60 * 1000;

async function refreshIncompleteProfileUserInfo(list) {
    const now = Date.now();
    if (now - lastIncompleteUserInfoRefreshAt < INCOMPLETE_USERINFO_REFRESH_MS) {
        return Array.isArray(list) ? list : listProfiles();
    }
    const profiles = Array.isArray(list) ? list : listProfiles();
    const need = profiles.filter((p) => p && p.url && !(p.userInfo && Number(p.userInfo.total) > 0));
    if (!need.length) {
        lastIncompleteUserInfoRefreshAt = now;
        return profiles;
    }
    lastIncompleteUserInfoRefreshAt = now;
    let changed = false;
    for (const p of need) {
        try {
            const fetched = await fetchSubscription(String(p.url).trim());
            const yamlInfo = parseUserInfoFromYaml(fetched.content);
            const merged = mergeUserInfo(fetched.userInfo, yamlInfo);
            if (merged && (merged.total > 0 || merged.remain != null)) {
                p.userInfo = merged;
                changed = true;
            }
        } catch (e) {}
    }
    if (changed) {
        try { saveProfilesMeta(profiles); } catch (e) {}
    }
    return profiles;
}

function sanitizeProfileName(name) {
    const n = String(name || '订阅').trim().slice(0, 48) || '订阅';
    return n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

function listProfiles() {
    ensureDirs();
    const metaPath = path.join(getRootDir(), 'profiles.json');
    let list = [];
    try {
        if (fs.existsSync(metaPath)) list = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {}
    if (!Array.isArray(list)) list = [];
    let changed = false;
    const out = list.filter((p) => p && p.id && fs.existsSync(path.join(getProfilesDir(), `${p.id}.yaml`))).map((p) => {
        const before = p.userInfo ? JSON.stringify(p.userInfo) : '';
        enrichProfileUserInfo(p);
        const after = p.userInfo ? JSON.stringify(p.userInfo) : '';
        if (before !== after) changed = true;
        return p;
    });
    if (changed) {
        try { saveProfilesMeta(out); } catch (e) {}
    }
    return out;
}

function saveProfilesMeta(list) {
    ensureDirs();
    fs.writeFileSync(path.join(getRootDir(), 'profiles.json'), JSON.stringify(list, null, 2), 'utf8');
}

function writeProfileYaml(id, content) {
    ensureDirs();
    const file = path.join(getProfilesDir(), `${id}.yaml`);
    fs.writeFileSync(file, content, 'utf8');
    return file;
}

function buildTempRuntimeYaml(profileContent, tempControllerPort, mixedPort = 0) {
    let body = String(profileContent || '').replace(/^\uFEFF/, '');
    // 临时测速：不联网拉 Geo，也不走规则匹配；只保留节点，供 /proxies/*/delay 使用。
    const dropKeys = [
        /^mixed-port\s*:/i,
        /^port\s*:/i,
        /^socks-port\s*:/i,
        /^redir-port\s*:/i,
        /^tproxy-port\s*:/i,
        /^external-controller\s*:/i,
        /^secret\s*:/i,
        /^allow-lan\s*:/i,
        /^bind-address\s*:/i,
        /^external-ui\s*:/i,
        /^mode\s*:/i,
        /^log-level\s*:/i,
        /^ipv6\s*:/i,
        /^unified-delay\s*:/i,
        /^tcp-concurrent\s*:/i,
        /^geodata-mode\s*:/i,
        /^geo-auto-update\s*:/i,
        /^geo-update-interval\s*:/i,
        /^find-process-mode\s*:/i
    ];
    const blockDropKeys = [/^tun\s*:/i, /^dns\s*:/i, /^geox-url\s*:/i];
    body = stripYamlTopLevelBlocks(body, dropKeys, blockDropKeys);

    const port = Number(mixedPort) > 0 ? Number(mixedPort) : 0;
    const header = [
        `mixed-port: ${port}`,
        'allow-lan: false',
        'ipv6: false',
        'unified-delay: true',
        'mode: global',
        'log-level: warning',
        'geodata-mode: true',
        'geo-auto-update: false',
        `external-controller: 127.0.0.1:${tempControllerPort}`,
        `secret: "${CONTROLLER_SECRET}"`,
        'tun:',
        '  enable: false',
        'dns:',
        '  enable: true',
        '  ipv6: false',
        '  enhanced-mode: fake-ip',
        '  fake-ip-range: 198.18.0.1/16',
        '  default-nameserver:',
        '    - 223.5.5.5',
        '  nameserver:',
        '    - 223.5.5.5',
        '    - 119.29.29.29',
        ''
    ].join('\n');
    return header + body;
}

function forceSoftSwitchInProxyGroups(yamlText) {
    let text = String(yamlText || '');
    // 订阅里若写 true，切节点会掐断现有 TCP，体感就是「断网一下」
    text = text.replace(/interrupt-exist-connections\s*:\s*true/gi, 'interrupt-exist-connections: false');

    const lines = text.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        out.push(line);
        const m = line.match(/^(\s*)type:\s*(select|url-test|fallback|load-balance)\s*$/i);
        if (!m) continue;
        const fieldIndent = m[1] || '';
        let hasField = false;
        for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
            const next = lines[j];
            if (!next.trim()) continue;
            // 下一个列表项 / 顶层键：结束本组
            if (/^\s*-\s/.test(next) && next.indexOf('-') <= fieldIndent.length) break;
            if (/^\S/.test(next)) break;
            if (/interrupt-exist-connections\s*:/i.test(next)) {
                hasField = true;
                break;
            }
            // 遇到同级其它 type，也结束
            if (new RegExp('^' + fieldIndent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'type\\s*:', 'i').test(next)) break;
        }
        if (!hasField) {
            out.push(`${fieldIndent}interrupt-exist-connections: false`);
        }
    }
    return out.join('\n');
}

function buildRuntimeYaml(profileContent) {
    let body = String(profileContent || '').replace(/^\uFEFF/, '');
    // 去掉可能冲突的端口/控制器配置行，统一由我们注入
    const dropKeys = [
        /^mixed-port\s*:/i,
        /^port\s*:/i,
        /^socks-port\s*:/i,
        /^redir-port\s*:/i,
        /^tproxy-port\s*:/i,
        /^external-controller\s*:/i,
        /^secret\s*:/i,
        /^allow-lan\s*:/i,
        /^bind-address\s*:/i,
        /^external-ui\s*:/i,
        /^mode\s*:/i,
        /^log-level\s*:/i,
        /^ipv6\s*:/i,
        /^unified-delay\s*:/i,
        /^tcp-concurrent\s*:/i,
        /^find-process-mode\s*:/i,
        /^geodata-mode\s*:/i,
        /^geo-auto-update\s*:/i,
        /^geo-update-interval\s*:/i
    ];

    // 需要整块剔除的顶层 YAML 节点（包含其所有缩进子行）
    const blockDropKeys = [/^tun\s*:/i, /^geox-url\s*:/i, /^dns\s*:/i];
    body = stripYamlTopLevelBlocks(body, dropKeys, blockDropKeys);
    body = forceSoftSwitchInProxyGroups(body);

    const mode = ['rule', 'global', 'direct'].includes(state.mode) ? state.mode : 'rule';
    // 性能相关：tcp-concurrent / unified-delay 显著降低“延迟低但网页慢”
    // Geo 使用安装包内置的本地 dat，禁止启动时联网下载（云电脑常卡死）
    const header = [
        `mixed-port: ${MIXED_PORT}`,
        'allow-lan: false',
        `mode: ${mode}`,
        'log-level: warning',
        `external-controller: ${CONTROLLER_HOST}:${CONTROLLER_PORT}`,
        `secret: "${CONTROLLER_SECRET}"`,
        'ipv6: false',
        // 展示延迟贴近 FlClash：开启 unified-delay 使测速反映真实 TCP 握手延迟
        'unified-delay: true',
        // 'tcp-concurrent: true',
        'find-process-mode: off',
        'geodata-mode: true',
        'geo-auto-update: false',
        'tun:',
        `  enable: ${state.virtualNic ? 'true' : 'false'}`,
        '  stack: mixed',
        '  auto-route: true',
        '  auto-detect-interface: true',
        '  strict-route: false',
        '  dns-hijack:',
        '    - any:53',
        'dns:',
        '  enable: true',
        '  listen: 0.0.0.0:1053',
        '  ipv6: false',
        '  enhanced-mode: fake-ip',
        '  fake-ip-range: 198.18.0.1/16',
        '  use-hosts: true',
        '  fake-ip-filter:',
        '    - "*.lan"',
        '    - "*.local"',
        '    - localhost',
        '    - "time.*.com"',
        '    - "ntp.*.com"',
        '    - "+.market.xiaomi.com"',
        '  default-nameserver:',
        '    - 223.5.5.5',
        '    - 119.29.29.29',
        '  nameserver:',
        '    - 223.5.5.5',
        '    - 119.29.29.29',
        '  proxy-server-nameserver:',
        '    - 223.5.5.5',
        '    - 119.29.29.29',
        '  fallback:',
        '    - tls://8.8.8.8:853',
        '    - tls://1.1.1.1:853',
        '  fallback-filter:',
        '    geoip: true',
        '    geoip-code: CN',
        '    ipcidr:',
        '      - 240.0.0.0/4',
        ''
    ].join('\n');

    return header + body;
}

async function addProfileFromUrl(url, name) {
    const fetched = await fetchSubscription(String(url).trim());
    const content = fetched.content;
    if (!content || (!content.includes('proxies') && !content.includes('proxy-providers'))) {
        throw new Error('订阅内容不是有效的 Clash/Mihomo 配置');
    }
    return addProfileFromContent(content, name || guessNameFromUrl(url), {
        source: 'url',
        url: String(url).trim(),
        userInfo: fetched.userInfo || null
    });
}

function guessNameFromUrl(url) {
    try {
        const u = new URL(url);
        return sanitizeProfileName(u.hostname || 'URL订阅');
    } catch (e) {
        return 'URL订阅';
    }
}

function addProfileFromContent(content, name, meta = {}) {
    ensureDirs();
    const id = crypto.randomBytes(6).toString('hex');
    writeProfileYaml(id, content);
    const list = listProfiles();
    const userInfo = mergeUserInfo(meta.userInfo, parseUserInfoFromYaml(content));
    const profile = {
        id,
        name: sanitizeProfileName(name),
        createdAt: Date.now(),
        ...meta,
        userInfo
    };
    list.push(profile);
    saveProfilesMeta(list);
    if (!state.activeProfileId) {
        state.activeProfileId = id;
        saveState();
    }
    return profile;
}

function addProfileFromFile(filePath, name) {
    const content = fs.readFileSync(filePath, 'utf8');
    const base = path.basename(filePath, path.extname(filePath));
    return addProfileFromContent(content, name || base, { source: 'file', file: filePath });
}

function removeProfile(id) {
    const list = listProfiles().filter((p) => p.id !== id);
    saveProfilesMeta(list);
    try { fs.unlinkSync(path.join(getProfilesDir(), `${id}.yaml`)); } catch (e) {}
    if (state.activeProfileId === id) {
        state.activeProfileId = list[0] ? list[0].id : null;
        saveState();
    }
    return list;
}

function renameProfile(id, newName) {
    const list = listProfiles();
    const profile = list.find((p) => p.id === id);
    if (!profile) throw new Error('配置不存在');
    profile.name = String(newName || '').trim() || profile.id;
    saveProfilesMeta(list);
    return profile;
}

async function updateProfileFromUrl(id) {
    const list = listProfiles();
    const profile = list.find((p) => p.id === id);
    if (!profile) throw new Error('配置不存在');
    if (!profile.url) throw new Error('该配置不是 URL 订阅，无法在线更新');
    const fetched = await fetchSubscription(String(profile.url).trim());
    const content = fetched.content;
    if (!content || (!content.includes('proxies') && !content.includes('proxy-providers'))) {
        throw new Error('订阅内容不是有效的 Clash/Mihomo 配置');
    }
    writeProfileYaml(id, content);
    profile.updatedAt = Date.now();
    profile.userInfo = mergeUserInfo(fetched.userInfo, parseUserInfoFromYaml(content));
    saveProfilesMeta(list);
    if (state.enabled && state.activeProfileId === id) {
        await startCore(id);
    }
    return profile;
}

function getProfileContent(id) {
    const file = path.join(getProfilesDir(), `${id}.yaml`);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
}

function parseProxiesFromYaml(yamlText) {
    const text = String(yamlText || '');
    const proxies = [];
    const lines = text.split(/\r?\n/);
    let inProxies = false;
    let current = null;

    const flush = () => {
        if (current && current.name) {
            proxies.push({
                name: current.name,
                type: (current.type || 'unknown').toLowerCase(),
                latency: null
            });
        }
        current = null;
    };

    // 辅助状态机解析 Flow Style 内联 YAML
    const parseInlineLine = (line) => {
        let clean = line.trim();
        if (clean.startsWith('-')) {
            clean = clean.substring(1).trim();
        }
        if (clean.startsWith('{') && clean.endsWith('}')) {
            clean = clean.substring(1, clean.length - 1).trim();
        } else {
            if (clean.startsWith('{')) clean = clean.substring(1).trim();
            if (clean.endsWith('}')) clean = clean.substring(0, clean.length - 1).trim();
        }

        const res = {};
        let i = 0;
        while (i < clean.length) {
            while (i < clean.length && /\s/.test(clean[i])) i++;
            if (i >= clean.length) break;

            let keyStart = i;
            while (i < clean.length && clean[i] !== ':') i++;
            if (i >= clean.length) break;
            const key = clean.substring(keyStart, i).trim();
            i++; // 跳过 ':'

            while (i < clean.length && /\s/.test(clean[i])) i++;
            if (i >= clean.length) break;

            let val = '';
            if (clean[i] === '"' || clean[i] === "'") {
                const quote = clean[i];
                i++; // 跳过引言号
                let valStart = i;
                while (i < clean.length) {
                    if (clean[i] === quote) {
                        if (clean[i - 1] === '\\') {
                            i++;
                            continue;
                        }
                        break;
                    }
                    i++;
                }
                val = clean.substring(valStart, i);
                if (i < clean.length) i++; // 跳过引言号

                while (i < clean.length && clean[i] !== ',') i++;
                if (i < clean.length) i++; // 跳过逗号
            } else {
                let valStart = i;
                while (i < clean.length && clean[i] !== ',') i++;
                val = clean.substring(valStart, i).trim();
                if (i < clean.length) i++; // 跳过逗号
            }
            res[key.toLowerCase()] = val;
        }
        return res;
    };

    for (const raw of lines) {
        const line = raw.replace(/\t/g, '  ');
        if (/^proxies\s*:/.test(line.trim())) {
            inProxies = true;
            continue;
        }
        if (inProxies && /^[A-Za-z0-9_-]+\s*:/.test(line) && !/^\s/.test(line)) {
            flush();
            inProxies = false;
            continue;
        }
        if (!inProxies) continue;

        // 如果是内联多字段 YAML
        if (line.includes('name:') && (line.includes('{') || line.includes(',') || line.includes('type:') || line.includes('server:'))) {
            flush();
            try {
                const inlineData = parseInlineLine(line);
                if (inlineData.name) {
                    proxies.push({
                        name: inlineData.name,
                        type: (inlineData.type || 'unknown').toLowerCase(),
                        latency: null
                    });
                }
            } catch (e) {
                console.warn('[Acceleration] parse inline line failed:', e.message);
            }
            continue;
        }

        const nameMatch = line.match(/^\s*-\s*name\s*:\s*(.+)$/i)
            || line.match(/^\s*name\s*:\s*(.+)$/i);
        const typeMatch = line.match(/^\s*type\s*:\s*(.+)$/i);
        const newItem = /^\s*-\s+/.test(line);

        if (newItem && /name\s*:/i.test(line)) {
            flush();
            current = {};
            const m = line.match(/name\s*:\s*(.+)$/i);
            if (m) current.name = stripYamlScalar(m[1]);
            const tm = line.match(/type\s*:\s*(\S+)/i);
            if (tm) current.type = stripYamlScalar(tm[1]);
            continue;
        }
        if (newItem && current) {
            flush();
            current = {};
        }
        if (nameMatch) {
            if (!current) current = {};
            current.name = stripYamlScalar(nameMatch[1]);
        }
        if (typeMatch && current) {
            current.type = stripYamlScalar(typeMatch[1]);
        }
    }
    flush();
    return proxies;
}

function stripYamlScalar(v) {
    let s = String(v || '').trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1);
    }
    return s.trim();
}

function guessFlag(name) {
    const n = String(name || '');
    if (/香港|HK|Hong\s*Kong/i.test(n)) return 'hk';
    if (/台湾|TW|Taiwan/i.test(n)) return 'tw';
    if (/日本|JP|Japan|东京|大阪/i.test(n)) return 'jp';
    if (/新加坡|SG|Singapore/i.test(n)) return 'sg';
    if (/美国|US|USA|United\s*States|洛杉矶|硅谷/i.test(n)) return 'us';
    if (/韩国|KR|Korea|首尔/i.test(n)) return 'kr';
    if (/英国|UK|Britain|伦敦/i.test(n)) return 'gb';
    if (/德国|DE|Germany/i.test(n)) return 'de';
    if (/法国|FR|France/i.test(n)) return 'fr';
    if (/加拿大|CA|Canada/i.test(n)) return 'ca';
    if (/澳大利亚|AU|Australia|悉尼/i.test(n)) return 'au';
    if (/俄罗斯|RU|Russia/i.test(n)) return 'ru';
    if (/土耳其|TR|Turkey/i.test(n)) return 'tr';
    if (/马来|MY|Malaysia/i.test(n)) return 'my';
    if (/泰国|TH|Thailand/i.test(n)) return 'th';
    if (/越南|VN|Vietnam/i.test(n)) return 'vn';
    if (/菲律宾|PH|Philippines/i.test(n)) return 'ph';
    if (/印度|IN|India/i.test(n)) return 'in';
    if (/阿根廷|AR|Argentina/i.test(n)) return 'ar';
    if (/巴西|BR|Brazil/i.test(n)) return 'br';
    if (/荷兰|NL|Netherlands/i.test(n)) return 'nl';
    return 'globe';
}

function controllerRequest(method, apiPath, bodyObj, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const payload = bodyObj != null ? JSON.stringify(bodyObj) : null;
        const req = http.request({
            host: CONTROLLER_HOST,
            port: CONTROLLER_PORT,
            path: apiPath,
            method,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${CONTROLLER_SECRET}`,
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            },
            timeout: Math.max(1000, Number(timeoutMs) || 15000)
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = null;
                try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
                else reject(new Error(`Controller ${res.statusCode}: ${text.slice(0, 200)}`));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Controller timeout'));
        });
        if (payload) req.write(payload);
        req.end();
    });
}

async function waitControllerReady(timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            await controllerRequest('GET', '/version');
            return true;
        } catch (e) {
            await new Promise((r) => setTimeout(r, 300));
        }
    }
    return false;
}

async function stopCore() {
    const proc = mihomoProc;
    mihomoProc = null;
    if (mihomoMemoryTimer) {
        clearInterval(mihomoMemoryTimer);
        mihomoMemoryTimer = null;
    }
    lastMihomoMemoryText = 'INACTIVE';
    if (proc) {
        const pid = proc.pid;
        try {
            // 只杀本实例内核，绝不能 taskkill /IM mihomo.exe（会误杀多开的其它实例）
            if (process.platform === 'win32' && pid) {
                try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 2000 }); } catch (e) {}
            } else {
                try { proc.kill('SIGKILL'); } catch (e) {}
            }
        } catch (e) {
            try { proc.kill(); } catch (e2) {}
        }
        // 给系统一点微小的时间来释放端口描述符
        await new Promise((r) => setTimeout(r, 200));
    }
}

function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => {
            resolve(false);
        });
        server.once('listening', () => {
            server.close(() => {
                resolve(true);
            });
        });
        server.listen(port, '127.0.0.1');
    });
}

async function getNextAvailablePort(startPort) {
    let port = startPort;
    while (port < 65535) {
        if (await isPortAvailable(port)) {
            return port;
        }
        port++;
    }
    return startPort;
}

async function startCore(profileId, onProgress) {
    const id = profileId || state.activeProfileId;
    if (!id) throw new Error('请先添加加速厂商订阅');
    const content = getProfileContent(id);
    if (!content) throw new Error('订阅配置文件不存在');

    const ensured = await ensureCore(onProgress);
    if (!ensured.success) throw new Error(ensured.error || '内核不可用');
    const runnable = assertCoreRunnable();
    if (!runnable.ok) throw new Error(runnable.error || '代理内核不可用');

    if (state.virtualNic) {
        const pre = await assertTunPrerequisites();
        if (!pre.ok) {
            // 不带半残 TUN 启动，避免路由被改坏导致其它软件断网
            state.virtualNic = false;
            saveState();
            throw new Error(pre.error || 'TUN 无法开启');
        }
    }

    // 正式启用前先停掉临时测速内核，避免双实例抢端口
    await stopTempMihomoCore();
    await stopCore();

    // 自动检测并避让占用端口
    MIXED_PORT = await getNextAvailablePort(17890);
    CONTROLLER_PORT = await getNextAvailablePort(19090);
    console.log(`[Acceleration] Auto allocated MIXED_PORT=${MIXED_PORT}, CONTROLLER_PORT=${CONTROLLER_PORT}`);

    const runtimeYaml = buildRuntimeYaml(content);
    fs.writeFileSync(getRuntimeConfigPath(), runtimeYaml, 'utf8');

    mihomoProc = spawn(getMihomoPath(), ['-d', getRootDir(), '-f', getRuntimeConfigPath()], {
        cwd: getRootDir(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    if (mihomoMemoryTimer) clearInterval(mihomoMemoryTimer);
    mihomoMemoryTimer = setInterval(updateMihomoMemory, 3000);
    setTimeout(updateMihomoMemory, 1000);

    let bootLog = '';
    const appendBootLog = (buf) => {
        try {
            bootLog += Buffer.from(buf).toString('utf8');
            if (bootLog.length > 8000) bootLog = bootLog.slice(-8000);
        } catch (e) {}
    };
    if (mihomoProc.stdout) mihomoProc.stdout.on('data', appendBootLog);
    if (mihomoProc.stderr) mihomoProc.stderr.on('data', appendBootLog);

    mihomoProc.on('exit', (code) => {
        mihomoProc = null;
        if (mihomoMemoryTimer) {
            clearInterval(mihomoMemoryTimer);
            mihomoMemoryTimer = null;
        }
        lastMihomoMemoryText = 'INACTIVE';
        if (state.enabled) {
            state.enabled = false;
            saveState();
            // 内核意外退出时，必须立即清理系统代理，否则用户会断网
            applySystemProxy(false).catch(() => {});
            console.log(`[Acceleration] mihomo exited unexpectedly (code=${code}), system proxy cleared`);
            if (bootLog.trim()) console.log(`[Acceleration] mihomo log:\n${bootLog.trim().slice(-1500)}`);
        }
    });

    const ready = await waitControllerReady(30000);
    if (!ready) {
        const hint = bootLog.trim() ? bootLog.trim().slice(-500) : '';
        await stopCore();
        await applySystemProxy(false);
        throw new Error(hint
            ? `代理内核启动失败：${hint.replace(/\s+/g, ' ').slice(0, 240)}`
            : '代理内核启动超时，请检查订阅配置是否有效');
    }

    state.activeProfileId = id;
    state.enabled = true;
    saveState();
    await applySystemProxy(state.systemProxy);

    if (state.selectedProxy) {
        try { await selectProxy(state.selectedGroup || 'GLOBAL', state.selectedProxy); } catch (e) {}
    }

    // 核对 TUN 是否真的起来了（开关开着但缺权限/缺 dll 时配置仍可能写 true）
    if (state.virtualNic) {
        await new Promise((r) => setTimeout(r, 800));
        const tunOn = await probeTunActuallyOn();
        if (!tunOn) {
            state.virtualNic = false;
            saveState();
            // 无 TUN 再拉起，避免半残路由把其它软件（如 Antigravity）搞断网
            const dash = await startCore(id, onProgress);
            if (dash && typeof dash === 'object') {
                dash.warning = 'TUN 未生效，已自动回退。请右键「以管理员身份运行」Nexora Agent 后再开虚拟网卡。';
            }
            return dash;
        }
    }

    return getDashboardData(id);
}

async function setEnabled(enabled, profileId, onProgress) {
    if (enabled) {
        return startCore(profileId || state.activeProfileId, onProgress);
    }
    await stopCore();
    await applySystemProxy(false);
    state.enabled = false;
    saveState();
    return getDashboardData();
}

function powershell(script) {
    return new Promise((resolve) => {
        const child = spawn('powershell.exe', ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', `${script}; exit 0`], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            try { child.kill(); } catch (e) {}
            resolve({ out, err: 'timeout' });
        }, 5000);
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('close', () => {
            clearTimeout(timer);
            resolve({ out, err });
        });
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ out, err: e.message });
        });
    });
}

async function applySystemProxy(enabled) {
    if (process.platform !== 'win32') return { success: true, skipped: true };
    const key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    if (enabled) {
        await powershell(`try { Set-ItemProperty -Path '${key}' -Name ProxyEnable -Type DWord -Value 1; Set-ItemProperty -Path '${key}' -Name ProxyServer -Type String -Value '127.0.0.1:${MIXED_PORT}'; Set-ItemProperty -Path '${key}' -Name ProxyOverride -Type String -Value 'localhost;127.*;<local>' } catch {}`);
    } else {
        await powershell(`try { Set-ItemProperty -Path '${key}' -Name ProxyEnable -Type DWord -Value 0 } catch {}`);
    }
    return { success: true };
}

async function setOptions(options = {}) {
    let restart = false;
    if (['rule', 'global', 'direct'].includes(options.mode) && options.mode !== state.mode) {
        state.mode = options.mode;
        restart = true;
    }
    if (typeof options.virtualNic === 'boolean' && options.virtualNic !== state.virtualNic) {
        if (options.virtualNic) {
            const pre = await assertTunPrerequisites();
            if (!pre.ok) {
                state.virtualNic = false;
                saveState();
                const dash = await getDashboardData();
                const err = new Error(pre.error || 'TUN 无法开启');
                err.dashboard = dash;
                throw err;
            }
        }
        state.virtualNic = options.virtualNic;
        restart = true;
    }
    if (typeof options.systemProxy === 'boolean') {
        state.systemProxy = options.systemProxy;
        if (state.enabled) await applySystemProxy(state.systemProxy);
    }
    saveState();
    if (restart && state.enabled && state.activeProfileId) {
        await startCore(state.activeProfileId);
    }
    return getDashboardData();
}

function getProxyEnv() {
    if (!state.enabled) return null;
    const proxyUrl = `http://127.0.0.1:${MIXED_PORT}`;
    return {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        ALL_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        all_proxy: proxyUrl,
        NO_PROXY: NO_PROXY_LIST,
        no_proxy: NO_PROXY_LIST
    };
}

function applyProxyToEnvObject(envObj) {
    const proxyEnv = getProxyEnv();
    if (!proxyEnv) {
        // 加速关闭时清掉可能继承的系统代理，避免污染
        for (const key of Object.keys(envObj || {})) {
            if (key.toLowerCase().includes('proxy')) delete envObj[key];
        }
        return envObj;
    }
    Object.assign(envObj, proxyEnv);
    return envObj;
}

async function getProxiesFromController() {
    try {
        const data = await controllerRequest('GET', '/proxies');
        return data && data.proxies ? data.proxies : {};
    } catch (e) {
        return null;
    }
}

const PROXY_GROUP_TYPES = new Set([
    'selector', 'urltest', 'fallback', 'loadbalance', 'relay', 'compatible'
]);
const PROXY_SKIP_TYPES = new Set([
    'direct', 'reject', 'pass', 'compatible', 'selector', 'urltest',
    'fallback', 'loadbalance', 'relay'
]);

function isInfoProxyName(name) {
    return /剩余|流量|到期|重置|过期|套餐|到期时间|距离|下次重置/i.test(String(name || ''));
}

function buildNodeList(profileId) {
    const id = profileId || state.activeProfileId;
    const content = id ? getProfileContent(id) : null;
    const parsed = content ? parseProxiesFromYaml(content) : [];
    return parsed.map((p) => ({
        ...p,
        flag: guessFlag(p.name),
        selected: state.selectedProxy === p.name
    }));
}

function buildNodeListFromController(proxies) {
    if (!proxies || typeof proxies !== 'object') return [];
    const nodes = [];
    for (const [name, info] of Object.entries(proxies)) {
        if (!info || !name) continue;
        const type = String(info.type || '').toLowerCase();
        if (PROXY_SKIP_TYPES.has(type)) continue;
        let latency = null;
        if (Array.isArray(info.history) && info.history.length) {
            const last = info.history[info.history.length - 1];
            if (last && typeof last.delay === 'number') {
                latency = last.delay > 0 ? last.delay : 0;
            }
        }
        nodes.push({
            name,
            type: type || 'unknown',
            latency,
            flag: guessFlag(name),
            selected: state.selectedProxy === name
        });
    }
    return nodes;
}

async function enrichNodesWithLatency(nodes) {
    if (!state.enabled) return nodes;
    const proxies = await getProxiesFromController();
    if (!proxies) return nodes;
    return nodes.map((n) => {
        const info = proxies[n.name];
        let latency = null;
        if (info && Array.isArray(info.history) && info.history.length) {
            const last = info.history[info.history.length - 1];
            if (last && typeof last.delay === 'number') {
                latency = last.delay > 0 ? last.delay : 0;
            }
        }
        return { ...n, type: (info && info.type) ? String(info.type).toLowerCase() : n.type, latency };
    });
}

/** 使用 IP 地址测速，彻底避开本地 DNS 解析导致的 Anycast 绕路和墙内 IP 阻断问题 */
const DELAY_TEST_URL = 'http://www.gstatic.com/generate_204';
const DELAY_TEST_TIMEOUT_MS = 10000;
const DELAY_TEST_RETRY_TIMEOUT_MS = 10000;
const DELAY_TEST_CONCURRENCY = 8;
/** 临时测速内核测完后保留一会儿（不接管系统代理），二次测速免去冷启动 */
const TEMP_CORE_IDLE_MS = 3 * 60 * 1000;

async function selectProxy(group, name) {
    const g = group || 'GLOBAL';
    await controllerRequest('PUT', `/proxies/${encodeURIComponent(g)}`, { name });
    // 软切换：只同步少量主 Selector，不强行改 URLTest/Fallback
    // （批量改组会触发更多路由重建，更容易感觉「切一下就断一下」）
    try {
        const proxies = await getProxiesFromController();
        if (proxies) {
            const primaryName = /^(GLOBAL|PROXY|Proxy|代理|节点选择|手动选择|SELECT|选择节点)$/i;
            for (const [key, val] of Object.entries(proxies)) {
                if (key === g) continue;
                if (!val || String(val.type) !== 'Selector') continue;
                if (!Array.isArray(val.all) || !val.all.includes(name)) continue;
                if (!primaryName.test(key) && key !== state.selectedGroup) continue;
                try {
                    await controllerRequest('PUT', `/proxies/${encodeURIComponent(key)}`, { name });
                } catch (e) {}
            }
        }
    } catch (e) {}
    // 明确不调用 DELETE /connections：旧连接继续走原节点直到自然结束，新连接走新节点
    state.selectedProxy = name;
    state.selectedGroup = g;
    saveState();
    return { success: true };
}

function pickDelayTestGroups(proxies, targetNames) {
    if (!proxies) return [];
    const targets = new Set(targetNames || []);
    const scored = [];
    for (const [name, val] of Object.entries(proxies)) {
        if (!val || !PROXY_GROUP_TYPES.has(String(val.type || '').toLowerCase())) continue;
        const all = Array.isArray(val.all) ? val.all : [];
        if (!all.length) continue;
        let hit = 0;
        for (const n of all) {
            if (targets.has(n)) hit += 1;
        }
        // 优先覆盖目标节点多、且为 url-test / 自动选择 的组（与 FlClash 一致）
        const typeBonus = String(val.type).toLowerCase() === 'urltest' ? 1000 : 0;
        const nameBonus = /自动选择|auto|url.?test|测速/i.test(name) ? 500 : 0;
        scored.push({ name, hit, score: hit + typeBonus + nameBonus, all });
    }
    scored.sort((a, b) => b.score - a.score || b.hit - a.hit);
    const picked = [];
    const covered = new Set();
    for (const g of scored) {
        if (g.hit <= 0 && targets.size) continue;
        let newCover = 0;
        for (const n of g.all) {
            if (targets.has(n) && !covered.has(n)) newCover += 1;
        }
        if (!targets.size || newCover > 0) {
            picked.push(g.name);
            for (const n of g.all) covered.add(n);
        }
        if (targets.size && [...targets].every((n) => covered.has(n) || isInfoProxyName(n))) break;
        if (picked.length >= 3) break;
    }
    return picked;
}

async function delayTestSingle(name, timeoutMs) {
    const data = await controllerRequest(
        'GET',
        `/proxies/${encodeURIComponent(name)}/delay?timeout=${timeoutMs}&url=${encodeURIComponent(DELAY_TEST_URL)}`,
        null,
        timeoutMs + 5000
    );
    if (data && typeof data.delay === 'number' && data.delay > 0) return data.delay;
    return null;
}

async function startTempMihomoCore() {
    try {
        const id = state.activeProfileId;
        if (!id) {
            return { ok: false, error: '请先在「配置」页选择一份加速订阅' };
        }

        if (tempMihomoProc && !tempMihomoProc.killed) {
            // 仅复用「同一配置」的临时内核；换订阅必须重建，否则代理页会混进旧节点
            let stale = tempCoreProfileId !== id;
            try {
                const yaml = fs.readFileSync(getRuntimeConfigPath(), 'utf8');
                if (/testingcf\.jsdelivr\.net/i.test(yaml) || (/mixed-port:\s*0/.test(yaml) && /^mode:\s*global/m.test(yaml))) {
                    stale = true;
                }
            } catch (e) {
                stale = true;
            }
            if (!stale) {
                try {
                    await controllerRequest('GET', '/version');
                    return { ok: true };
                } catch (e) {
                    await stopTempMihomoCore();
                }
            } else {
                await stopTempMihomoCore();
            }
        }

        const content = getProfileContent(id);
        if (!content) {
            return { ok: false, error: '当前订阅配置文件缺失，请到「配置」页重新导入' };
        }

        const ensured = await ensureCore();
        if (!ensured.success) {
            return { ok: false, error: ensured.error || '代理内核不可用（内置复制或下载失败）' };
        }
        const runnable = assertCoreRunnable();
        if (!runnable.ok) {
            return { ok: false, error: runnable.error || '代理内核不可用' };
        }

        // 临时测速内核，使用动态生成的端口避让
        MIXED_PORT = await getNextAvailablePort(17890);
        CONTROLLER_PORT = await getNextAvailablePort(19090);

        const runtimeYaml = buildTempRuntimeYaml(content, CONTROLLER_PORT, MIXED_PORT);
        fs.writeFileSync(getRuntimeConfigPath(), runtimeYaml, 'utf8');

        let bootLog = '';
        const appendBootLog = (buf) => {
            try {
                bootLog += Buffer.from(buf).toString('utf8');
                if (bootLog.length > 8000) bootLog = bootLog.slice(-8000);
            } catch (e) {}
        };

        tempMihomoProc = spawn(getMihomoPath(), ['-d', getRootDir(), '-f', getRuntimeConfigPath()], {
            cwd: getRootDir(),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        tempCoreProfileId = id;
        if (tempMihomoProc.stdout) tempMihomoProc.stdout.on('data', appendBootLog);
        if (tempMihomoProc.stderr) tempMihomoProc.stderr.on('data', appendBootLog);
        tempMihomoProc.on('error', (err) => {
            appendBootLog(String((err && err.message) || err));
            tempMihomoProc = null;
            tempCoreProfileId = null;
        });
        tempMihomoProc.on('exit', () => {
            tempMihomoProc = null;
            tempCoreProfileId = null;
        });

        const ready = await waitControllerReady(15000);
        if (!ready) {
            const hint = bootLog.trim()
                ? bootLog.trim().replace(/\s+/g, ' ').slice(0, 180)
                : '';
            await stopTempMihomoCore();
            return {
                ok: false,
                error: hint
                    ? `测速内核启动失败：${hint}`
                    : '测速内核启动超时（可能被杀毒软件拦截 mihomo.exe，请放行后重试）'
            };
        }
        // 临时内核刚起来时代理列表可能尚未完全就绪，稍等再测
        for (let i = 0; i < 8; i++) {
            const proxies = await getProxiesFromController();
            if (proxies && Object.keys(proxies).length > 5) {
                await new Promise((r) => setTimeout(r, 200));
                return { ok: true };
            }
            await new Promise((r) => setTimeout(r, 200));
        }
        return { ok: true };
    } catch (e) {
        console.error('[TempCore] start failed:', e);
        return { ok: false, error: e.message || String(e) };
    }
}

function scheduleTempCoreIdleStop() {
    if (tempCoreIdleTimer) {
        clearTimeout(tempCoreIdleTimer);
        tempCoreIdleTimer = null;
    }
    tempCoreIdleTimer = setTimeout(() => {
        stopTempMihomoCore().catch(() => {});
    }, TEMP_CORE_IDLE_MS);
}

async function stopTempMihomoCore() {
    if (tempCoreIdleTimer) {
        clearTimeout(tempCoreIdleTimer);
        tempCoreIdleTimer = null;
    }
    if (tempMihomoProc) {
        try {
            tempMihomoProc.kill();
        } catch (e) {}
        tempMihomoProc = null;
        tempCoreProfileId = null;
        // 等端口释放，避免紧接着再次测速冲突
        await new Promise((r) => setTimeout(r, 200));
    } else {
        tempCoreProfileId = null;
    }
}

async function runDelayQueue(names, timeoutMs, results, errors, concurrency, onProgress) {
    const queue = names.slice();
    const total = names.length;
    let finished = 0;
    const workersN = Math.min(
        typeof concurrency === 'number' && concurrency > 0 ? concurrency : DELAY_TEST_CONCURRENCY,
        Math.max(1, queue.length)
    );
    const workers = Array.from({ length: workersN }, async () => {
        while (queue.length) {
            const name = queue.shift();
            let latency = 0;
            try {
                const delay = await delayTestSingle(name, timeoutMs);
                // 超过超时阈值的异常值按失败处理
                if (typeof delay === 'number' && delay > 0 && delay <= timeoutMs) {
                    const prev = results[name];
                    if (!(typeof prev === 'number' && prev > 0) || delay < prev) {
                        results[name] = delay;
                    }
                    latency = results[name];
                    delete errors[name];
                } else if (!(typeof results[name] === 'number' && results[name] > 0)) {
                    results[name] = 0;
                    latency = 0;
                } else {
                    latency = results[name];
                }
            } catch (e) {
                if (!(typeof results[name] === 'number' && results[name] > 0)) {
                    results[name] = 0;
                    latency = 0;
                    errors[name] = e.message || String(e);
                } else {
                    latency = results[name];
                }
            }
            finished += 1;
            if (typeof onProgress === 'function') {
                try {
                    onProgress({
                        phase: 'result',
                        name,
                        latency,
                        done: finished,
                        total,
                        results: { ...results }
                    });
                } catch (e) {}
            }
        }
    });
    await Promise.all(workers);
}

async function delayTest(names, options = {}) {
    const onProgress = options && typeof options.onProgress === 'function' ? options.onProgress : null;
    let usedTempCore = false;
    if (!state.enabled) {
        const started = await startTempMihomoCore();
        if (!started || !started.ok) {
            throw new Error((started && started.error) || '测速内核启动失败');
        }
        usedTempCore = true;
    }

    const results = {};
    const errors = {};

    try {
        const proxies = await getProxiesFromController();
        let list = Array.isArray(names) && names.length
            ? names.slice()
            : buildNodeList().map((n) => n.name);

        // 内核已加载时，补全 YAML 解析可能漏掉的节点（proxy-providers 等）
        if (proxies) {
            const fromCore = buildNodeListFromController(proxies).map((n) => n.name);
            const seen = new Set(list);
            for (const n of fromCore) {
                if (!seen.has(n)) {
                    list.push(n);
                    seen.add(n);
                }
            }
        }

        const pending = [];
        for (const name of list) {
            if (isInfoProxyName(name) || /^PASS/i.test(name) || /^REJECT/i.test(name) || name === 'DIRECT') {
                results[name] = null;
                continue;
            }
            pending.push(name);
        }

        if (typeof onProgress === 'function') {
            try {
                onProgress({
                    phase: 'start',
                    names: pending.slice(),
                    done: 0,
                    total: pending.length,
                    results: {}
                });
            } catch (e) {}
        }

        // FlClash 风格：按节点并发探测，测完一个立刻回调刷新 UI（不再整组卡死等结果）
        if (pending.length) {
            await runDelayQueue(
                pending,
                DELAY_TEST_TIMEOUT_MS,
                results,
                errors,
                DELAY_TEST_CONCURRENCY,
                onProgress
            );
        }

        lastDelayTestResults = results;
        try {
            const okCount = Object.values(results).filter((v) => typeof v === 'number' && v > 0).length;
            fs.writeFileSync(path.join(getRootDir(), 'delay_debug.json'), JSON.stringify({
                results,
                errors,
                pending,
                okCount,
                failCount: pending.length - okCount,
                state_enabled: state.enabled,
                temporary: usedTempCore,
                controller_port: CONTROLLER_PORT,
                timestamp: new Date().toISOString()
            }, null, 2), 'utf8');
        } catch (e) {}

        if (typeof onProgress === 'function') {
            try {
                onProgress({
                    phase: 'done',
                    done: pending.length,
                    total: pending.length,
                    results: { ...results }
                });
            } catch (e) {}
        }
        return results;
    } finally {
        if (usedTempCore) {
            // 不立刻杀掉：保留热缓存，下次测速更接近 FlClash；空闲 3 分钟后自动关
            scheduleTempCoreIdleStop();
        }
    }
}

async function setActiveProfileId(id) {
    const next = id || null;
    const changed = state.activeProfileId !== next;
    state.activeProfileId = next;
    lastDelayTestResults = null;
    if (changed) {
        state.selectedProxy = null;
        // 旧临时内核属于上一份订阅，必须停掉，否则代理页会合并出多套节点
        await stopTempMihomoCore();
    }
    saveState();
    return state.activeProfileId;
}

function updateMihomoMemory() {
    if (!mihomoProc || mihomoProc.killed) {
        lastMihomoMemoryText = 'INACTIVE';
        return;
    }
    const pid = mihomoProc.pid;
    if (!pid) return;

    // 根据 Windows 平台特性使用 Get-Process 进程查询
    // 防御性原则：PowerShell try-catch 拦截，2>$null，静默保证零崩溃
    const cmd = `powershell -ExecutionPolicy Bypass -NoProfile -Command "try { (Get-Process -Id ${pid}).WorkingSet64 } catch { 0 }"`;
    const { exec } = require('child_process');
    exec(cmd, (err, stdout) => {
        if (err || !stdout) return;
        const bytes = parseInt(stdout.trim(), 10);
        if (bytes && bytes > 0) {
            lastMihomoMemoryText = (bytes / 1024 / 1024).toFixed(1) + ' MB';
        }
    });
}

function getStatus() {
    const inst = (typeof global !== 'undefined' && global.nexoraInstance) ? global.nexoraInstance : null;
    return {
        enabled: !!state.enabled,
        coreReady: isCoreReady(),
        activeProfileId: state.activeProfileId,
        selectedProxy: state.selectedProxy,
        mode: state.mode || 'rule',
        systemProxy: !!state.systemProxy,
        virtualNic: !!state.virtualNic,
        mixedPort: MIXED_PORT,
        controller: `${CONTROLLER_HOST}:${CONTROLLER_PORT}`,
        profiles: listProfiles(),
        running: !!mihomoProc,
        instanceId: inst && inst.id ? inst.id : 1,
        instancePrimary: !(inst && inst.id > 1),
        clashMemory: lastMihomoMemoryText
    };
}

async function getDashboardData(profileId) {
    // 缺 total 的订阅自动补拉 subscription-userinfo，避免一直「已用占比未知」
    try { await refreshIncompleteProfileUserInfo(); } catch (e) {}
    const status = getStatus();
    const pid = profileId || status.activeProfileId;
    let nodes = buildNodeList(pid);
    let proxies = null;
    const tempCoreAlive = !!(tempMihomoProc && !tempMihomoProc.killed);
    // 只读「当前这份配置」对应的内核；禁止把别的订阅临时内核节点合并进来
    const coreMatchesProfile = !!(pid && (
        (status.enabled && mihomoProc && status.activeProfileId === pid)
        || (tempCoreAlive && tempCoreProfileId === pid)
    ));
    if (coreMatchesProfile) {
        try { proxies = await getProxiesFromController(); } catch (e) {}
    }
    if (proxies) {
        const fromCore = buildNodeListFromController(proxies);
        if (fromCore.length) {
            // 以当前配置内核为准；仅额外保留 YAML 信息节点（流量/到期）
            const byName = new Map(fromCore.map((n) => [n.name, n]));
            for (const n of nodes) {
                if (isInfoProxyName(n.name) && !byName.has(n.name)) {
                    byName.set(n.name, n);
                }
            }
            nodes = Array.from(byName.values());
        } else {
            try { nodes = await enrichNodesWithLatency(nodes); } catch (e) {}
        }
    }
    if (lastDelayTestResults) {
        for (const node of nodes) {
            if (Object.prototype.hasOwnProperty.call(lastDelayTestResults, node.name)) {
                node.latency = lastDelayTestResults[node.name];
            }
        }
    }
    const groups = [];
    if (proxies) {
        for (const [name, val] of Object.entries(proxies)) {
            const type = val && val.type ? String(val.type) : '';
            if (val && (type === 'Selector' || type === 'URLTest' || type === 'Fallback' || type === 'LoadBalance')) {
                groups.push({
                    name,
                    type: val.type,
                    now: val.now,
                    all: val.all || []
                });
            }
        }
    }
    return { ...status, nodes, groups, profileId: pid, tempCoreAlive: coreMatchesProfile && tempCoreAlive };
}

async function getConnections() {
    if (!state.enabled) return { connections: [], downloadTotal: 0, uploadTotal: 0 };
    try {
        const data = await controllerRequest('GET', '/connections');
        return data || { connections: [], downloadTotal: 0, uploadTotal: 0 };
    } catch (e) {
        return { connections: [], downloadTotal: 0, uploadTotal: 0 };
    }
}

async function closeConnection(id) {
    if (!state.enabled) return { success: false };
    try {
        if (id) {
            await controllerRequest('DELETE', `/connections/${encodeURIComponent(id)}`);
        } else {
            await controllerRequest('DELETE', '/connections');
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

function httpGetAbsolute(url, options = {}) {
    const timeoutMs = options.timeoutMs || 10000;
    const viaProxy = !!options.viaProxy;
    return new Promise((resolve, reject) => {
        let parsed;
        try { parsed = new URL(url); } catch (e) {
            reject(e);
            return;
        }
        if (parsed.protocol !== 'http:') {
            reject(new Error('仅支持 HTTP 探测地址'));
            return;
        }
        const reqOpts = viaProxy
            ? {
                host: '127.0.0.1',
                port: MIXED_PORT,
                path: url,
                method: 'GET',
                headers: {
                    Host: parsed.host,
                    'User-Agent': 'NexoraAgent/1.0',
                    Accept: 'application/json,text/plain,*/*'
                }
            }
            : {
                host: parsed.hostname,
                port: parsed.port || 80,
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: {
                    Host: parsed.host,
                    'User-Agent': 'NexoraAgent/1.0',
                    Accept: 'application/json,text/plain,*/*'
                }
            };

        let active = true;
        const timer = setTimeout(() => {
            if (!active) return;
            active = false;
            try { req.destroy(); } catch (e) {}
            reject(new Error('timeout'));
        }, timeoutMs);

        const req = http.request(reqOpts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                if (!active) return;
                active = false;
                clearTimeout(timer);
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(text);
                else reject(new Error(`HTTP ${res.statusCode}`));
            });
        });
        req.on('error', (err) => {
            if (!active) return;
            active = false;
            clearTimeout(timer);
            reject(err);
        });
        req.end();
    });
}

function parseOutboundIpPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    // Cloudflare trace: ip=x.x.x.x / loc=XX
    if (raw.includes('ip=') && !raw.startsWith('{')) {
        const ip = (raw.match(/(?:^|\n)ip=([^\n]+)/) || [])[1];
        const loc = (raw.match(/(?:^|\n)loc=([^\n]+)/) || [])[1];
        if (ip) {
            return {
                ip: ip.trim(),
                countryCode: loc ? loc.trim() : '',
                country: '',
                region: '',
                city: '',
                isp: ''
            };
        }
    }
    try {
        const data = JSON.parse(raw);
        const ip = data.query || data.ip || data.origin || data.address || '';
        if (!ip) return null;
        return {
            ip: String(ip).split(',')[0].trim(),
            country: data.country || data.country_name || '',
            countryCode: data.countryCode || data.country_code || data.country_code2 || '',
            region: data.regionName || data.region || '',
            city: data.city || '',
            isp: data.isp || data.org || data.organization || ''
        };
    } catch (e) {
        // plain IP
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) {
            return { ip: raw, country: '', countryCode: '', region: '', city: '', isp: '' };
        }
        // myip.ipip.net: 当前 IP：x.x.x.x  来自于：中国 浙江 杭州  电信
        const ipip = raw.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
        if (ipip) {
            const loc = (raw.match(/来自于[：:]\s*(.+)$/m) || [])[1] || '';
            const parts = loc.trim().split(/\s+/).filter(Boolean);
            const country = parts[0] || '';
            const countryCode = /中国|中华人民共和国/i.test(country) ? 'CN' : '';
            return {
                ip: ipip[1],
                country,
                countryCode,
                region: parts[1] || '',
                city: parts[2] || '',
                isp: parts.slice(3).join(' ') || ''
            };
        }
        return null;
    }
}

/**
 * 出口 IP 检测：
 * - 已启用加速：经本地 mixed 端口走当前节点
 * - 未启用：直连探测本机公网出口（国内 IP 也正常显示）
 */
async function detectOutboundIp() {
    const viaProxy = !!state.enabled;
    const endpoints = viaProxy
        ? [
            'http://1.1.1.1/cdn-cgi/trace',
            'http://ip-api.com/json/?lang=zh-CN&fields=status,message,country,countryCode,regionName,city,isp,query',
            'http://api.ipify.org?format=json'
        ]
        : [
            // 未启用时优先国内可达源，拿本机真实出口
            'http://ip-api.com/json/?lang=zh-CN&fields=status,message,country,countryCode,regionName,city,isp,query',
            'http://ip.3322.net/',
            'http://myip.ipip.net/',
            'http://api.ipify.org?format=json',
            'http://1.1.1.1/cdn-cgi/trace'
        ];
    let lastError = '检测超时';
    for (const url of endpoints) {
        try {
            const text = await httpGetAbsolute(url, { viaProxy, timeoutMs: viaProxy ? 6000 : 5000 });
            const parsed = parseOutboundIpPayload(text);
            if (parsed && parsed.ip) {
                return {
                    success: true,
                    ...parsed,
                    via: viaProxy ? 'proxy' : 'direct',
                    selectedProxy: viaProxy ? (state.selectedProxy || null) : null
                };
            }
            lastError = '未解析到 IP';
        } catch (e) {
            lastError = e.message || String(e);
        }
    }
    return { success: false, error: lastError === 'timeout' ? '检测超时' : lastError, via: viaProxy ? 'proxy' : 'direct' };
}

module.exports = {
    get MIXED_PORT() { return MIXED_PORT; },
    init,
    ensureCore,
    isCoreReady,
    listProfiles,
    addProfileFromUrl,
    addProfileFromFile,
    addProfileFromContent,
    removeProfile,
    renameProfile,
    updateProfileFromUrl,
    getProfileContent,
    setActiveProfileId,
    setOptions,
    applySystemProxy,
    setEnabled,
    startCore,
    stopCore,
    getStatus,
    getDashboardData,
    selectProxy,
    delayTest,
    detectOutboundIp,
    getProxyEnv,
    applyProxyToEnvObject,
    buildNodeList,
    guessFlag,
    getConnections,
    closeConnection
};
