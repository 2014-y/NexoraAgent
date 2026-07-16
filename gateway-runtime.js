'use strict';
/**
 * 网关运行时定位与首次解压（兼容开发态 / 旧 asar.unpacked 安装包）。
 * 解压必须异步：spawnSync 会冻死 Electron 主进程（“未响应”）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let cachedRoot = null;

function getDevProjectRoot() {
    return path.resolve(__dirname);
}

function getPackagedRuntimeRoot(app) {
    const localBase = process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'NexoraAgent')
        : null;
    if (localBase) return path.join(localBase, 'gateway-runtime');
    try {
        return path.join(app.getPath('userData'), 'gateway-runtime');
    } catch (e) {
        return path.join(getDevProjectRoot(), 'gateway-runtime');
    }
}

function getGatewayRuntimeRoot(app) {
    if (cachedRoot) return cachedRoot;
    let packaged = false;
    try { packaged = !!(app && app.isPackaged); } catch (e) { packaged = false; }
    if (!packaged) {
        cachedRoot = getDevProjectRoot();
        return cachedRoot;
    }
    cachedRoot = getPackagedRuntimeRoot(app);
    return cachedRoot;
}

function setGatewayRuntimeRoot(root) {
    cachedRoot = root ? path.resolve(root) : null;
}

function runtimeLooksReady(root, version) {
    if (!root) return false;
    const entry = path.join(root, 'node_modules', 'openclaw', 'dist', 'index.js');
    if (!fs.existsSync(entry)) return false;
    const stamp = path.join(root, '.runtime-version');
    if (!fs.existsSync(stamp)) return false;
    try {
        return fs.readFileSync(stamp, 'utf8').trim() === String(version || '');
    } catch (e) {
        return false;
    }
}

function findGatewayRuntimeZip(app) {
    const candidates = [];
    try {
        if (process.resourcesPath) {
            candidates.push(path.join(process.resourcesPath, 'gateway-runtime.zip'));
        }
    } catch (e) {}
    try {
        const appPath = app.getAppPath();
        candidates.push(path.join(path.dirname(appPath), 'gateway-runtime.zip'));
        candidates.push(path.join(appPath, 'gateway-runtime.zip'));
    } catch (e) {}
    candidates.push(path.join(getDevProjectRoot(), 'build-resources', 'gateway-runtime.zip'));

    for (const p of candidates) {
        try {
            if (p && fs.existsSync(p)) return p;
        } catch (e) {}
    }
    return null;
}

function findLegacyUnpackedRoot(app) {
    try {
        const appPath = app.getAppPath();
        const unpacked = String(appPath || '').replace(/app\.asar$/i, 'app.asar.unpacked');
        if (unpacked && unpacked !== appPath) {
            const entry = path.join(unpacked, 'node_modules', 'openclaw', 'dist', 'index.js');
            if (fs.existsSync(entry)) return unpacked;
        }
    } catch (e) {}
    return null;
}

function runSpawn(cmd, args) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = spawn(cmd, args, {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe']
        });
        let errBuf = '';
        if (child.stderr) {
            child.stderr.on('data', (d) => {
                if (errBuf.length < 2000) errBuf += String(d);
            });
        }
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited ${code}${errBuf ? ': ' + errBuf.slice(0, 400) : ''}`));
        });
    });
}

/** 异步解压，不堵主线程事件循环 */
async function extractZip(zipPath, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    try {
        await runSpawn('tar', ['-xf', zipPath, '-C', destDir]);
        return;
    } catch (e) {
        // fallback Expand-Archive
    }

    const zipLit = String(zipPath).replace(/'/g, "''");
    const destLit = String(destDir).replace(/'/g, "''");
    await runSpawn('powershell', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${zipLit}' -DestinationPath '${destLit}' -Force`
    ]);
}

/** 后台删目录，避免主线程同步 rm 数万文件 */
function deferRmTree(dir) {
    if (!dir) return;
    setImmediate(() => {
        try {
            if (process.platform === 'win32') {
                const child = spawn('cmd.exe', ['/c', 'rmdir', '/s', '/q', dir], {
                    windowsHide: true,
                    detached: true,
                    stdio: 'ignore'
                });
                child.unref();
            } else {
                fs.rm(dir, { recursive: true, force: true }, () => {});
            }
        } catch (e) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e2) {}
        }
    });
}

/**
 * 确保打包环境下网关运行时已解压到用户目录。
 * 开发态直接返回工程根目录。
 * @returns {Promise<object>}
 */
async function ensureGatewayRuntime(app, opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    let packaged = false;
    try { packaged = !!(app && app.isPackaged); } catch (e) { packaged = false; }

    if (!packaged) {
        const root = getDevProjectRoot();
        setGatewayRuntimeRoot(root);
        return { root, extracted: false, ready: true, mode: 'dev' };
    }

    const version = (() => {
        try { return app.getVersion(); } catch (e) { return '0.0.0'; }
    })();
    const root = getPackagedRuntimeRoot(app);

    if (runtimeLooksReady(root, version)) {
        setGatewayRuntimeRoot(root);
        return { root, extracted: false, ready: true, mode: 'cached' };
    }

    const zip = findGatewayRuntimeZip(app);
    if (!zip) {
        const legacy = findLegacyUnpackedRoot(app);
        if (legacy) {
            setGatewayRuntimeRoot(legacy);
            return { root: legacy, extracted: false, ready: true, mode: 'legacy-unpacked' };
        }
        throw new Error('缺少 gateway-runtime.zip，且未找到旧版 app.asar.unpacked 运行时');
    }

    onProgress({ phase: 'extract', percent: 10, message: '正在覆盖安装 OpenClaw 运行时…' });

    // 全面覆盖：直接解压到目标目录，不先整树删除（删几万文件极慢）
    fs.mkdirSync(root, { recursive: true });
    try {
        await extractZip(zip, root);
        onProgress({ phase: 'extract', percent: 90, message: '正在写入版本信息…' });
        fs.writeFileSync(path.join(root, '.runtime-version'), String(version), 'utf8');
    } catch (e) {
        throw e;
    }

    setGatewayRuntimeRoot(root);
    onProgress({ phase: 'done', percent: 100, message: '运行时就绪' });
    return { root, extracted: true, ready: true, mode: 'extracted' };
}

module.exports = {
    getGatewayRuntimeRoot,
    setGatewayRuntimeRoot,
    ensureGatewayRuntime,
    runtimeLooksReady,
    findGatewayRuntimeZip,
    findLegacyUnpackedRoot,
    deferRmTree
};
