'use strict';

const { execFile } = require('child_process');

// Run in the bundled Node runtime: Electron's Node/SQLite ABI is different.
async function registryWorker() {
    const fs = require('fs');
    const path = require('path');
    const { pathToFileURL } = require('url');
    const { isDeepStrictEqual } = require('util');
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const { runtimeRoot, config, seeds } = JSON.parse(input);
    const dist = path.join(runtimeRoot, 'node_modules', 'openclaw', 'dist');
    const hostRoot = fs.realpathSync(path.dirname(dist));
    const modulesRoot = path.resolve(runtimeRoot, 'node_modules') + path.sep;
    for (const [id, seed] of Object.entries(seeds)) {
        if (!path.resolve(seed.installPath).startsWith(modulesRoot)) continue;
        const pkg = JSON.parse(fs.readFileSync(path.join(seed.installPath, 'package.json'), 'utf8'));
        if (!pkg.peerDependencies?.openclaw && !pkg.dependencies?.openclaw) continue;
        // OpenClaw audits a plugin-local host link even when npm hoisting can
        // resolve the same SDK. Create it on the destination machine.
        const localModules = path.join(seed.installPath, 'node_modules');
        const peerLink = path.join(localModules, 'openclaw');
        try { if (fs.realpathSync(peerLink) === hostRoot) continue; } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
        let existing;
        try { existing = fs.lstatSync(peerLink); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (existing) {
            if (!existing.isSymbolicLink()) throw new Error(`Bundled plugin has a conflicting host dependency: ${id}`);
            fs.unlinkSync(peerLink);
        }
        fs.mkdirSync(localModules, { recursive: true });
        fs.symlinkSync(hostRoot, peerLink, process.platform === 'win32' ? 'junction' : 'dir');
    }
    async function loadApi(prefix, name) {
        for (const file of fs.readdirSync(dist).filter(f => f.startsWith(prefix) && f.endsWith('.js'))) {
            const source = fs.readFileSync(path.join(dist, file), 'utf8');
            const namedExport = [...source.matchAll(/export\s*\{([^}]+)\}/g)]
                .some(match => match[1].split(',').some(entry => entry.trim() === name));
            if (!namedExport) continue;
            const api = await import(pathToFileURL(path.join(dist, file)).href);
            if (typeof api[name] === 'function') return api[name];
        }
        throw new Error(`Bundled OpenClaw is missing ${name}`);
    }
    const loadRecords = await loadApi('installed-plugin-index-records-', 'loadInstalledPluginIndexInstallRecords');
    const previous = JSON.parse(JSON.stringify(await loadRecords()));
    const next = { ...previous };
    for (const [id, seed] of Object.entries(seeds)) {
        if (!fs.existsSync(path.join(seed.installPath, 'package.json'))) {
            throw new Error(`Bundled plugin package missing: ${id}`);
        }
        next[id] = {
            ...previous[id],
            ...seed,
            installedAt: previous[id]?.installedAt || seed.installedAt || new Date().toISOString()
        };
    }
    const changed = !isDeepStrictEqual(previous, next);
    if (changed) {
        const commit = await loadApi('install-record-commit-', 'commitPluginInstallRecordsOnly');
        await commit({ nextConfig: config, nextInstallRecords: next });
    }
    process.stdout.write(JSON.stringify({ changed, registered: Object.keys(seeds) }));
}

function syncBundledPluginRegistry({ nodeExePath, runtimeRoot, stateDir, config, seeds, env = process.env }) {
    return new Promise((resolve, reject) => {
        const childEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
        delete childEnv.NODE_OPTIONS;
        const child = execFile(nodeExePath, ['-e', `(${registryWorker.toString()})().catch(e => { console.error(e.message); process.exitCode = 1; });`], {
            env: childEnv,
            windowsHide: true,
            // Fresh Windows installs also scan/compile the core's ESM graph.
            // Keep this async and allow the same cold-start budget as runtime setup.
            timeout: 120000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8'
        }, (error, stdout, stderr) => {
            if (error) return reject(new Error(`插件登记失败: ${error.killed ? '内置插件初始化超过 120 秒，请稍后重试' : String(stderr || error.message).trim().slice(-1200)}`));
            try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('插件登记结果无效')); }
        });
        child.stdin.on('error', () => {}); // execFile reports early child exits.
        child.stdin.end(JSON.stringify({ runtimeRoot, config, seeds }));
    });
}

module.exports = { syncBundledPluginRegistry };
