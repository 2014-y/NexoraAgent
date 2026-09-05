import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { syncBundledPluginRegistry } = require('../openclaw-plugin-registry');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-install-registry-'));
let db;
const newPeerLinks = [];
try {
    const config = { plugins: { entries: {}, allow: [] } };
    const seeds = {};
    for (const name of ['@tencent-weixin/openclaw-weixin', '@tencent-connect/openclaw-qqbot', '@openclaw/feishu', '@openclaw/voice-call', '@openclaw/slack', '@openclaw/whatsapp', '@openclaw/matrix']) {
        const installPath = path.join(root, 'node_modules', ...name.split('/'));
        const pkg = JSON.parse(fs.readFileSync(path.join(installPath, 'package.json')));
        const { id } = JSON.parse(fs.readFileSync(path.join(installPath, 'openclaw.plugin.json')));
        const peerLink = path.join(installPath, 'node_modules', 'openclaw');
        if (!fs.existsSync(peerLink)) newPeerLinks.push(peerLink);
        seeds[id] = { source: 'npm', installPath, spec: `${name}@${pkg.version}`, resolvedName: name, resolvedVersion: pkg.version, resolvedSpec: `${name}@${pkg.version}`, version: pkg.version };
        config.plugins.entries[id] = { enabled: id !== 'matrix' };
        config.plugins.allow.push(id);
    }
    fs.writeFileSync(path.join(stateDir, 'openclaw.json'), JSON.stringify(config));
    const options = { nodeExePath: process.execPath, runtimeRoot: root, stateDir, config, seeds,
        env: { ...process.env, OPENCLAW_HOME: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json') } };
    const first = await syncBundledPluginRegistry(options);
    assert.equal(first.changed, true, 'fresh installs must persist all bundled records');
    const dbPath = path.join(stateDir, 'state', 'openclaw.sqlite');
    db = new DatabaseSync(dbPath);
    const read = () => JSON.parse(db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.installedIndex'").get().value_json).index;
    const index = read();
    for (const id of Object.keys(seeds)) {
        assert.ok(index.installRecords[id]);
        assert.equal(index.plugins.filter(p => p.pluginId === id).length, 1, `${id} must be discovered exactly once`);
        assert.equal(fs.realpathSync(path.join(seeds[id].installPath, 'node_modules', 'openclaw')), fs.realpathSync(path.join(root, 'node_modules', 'openclaw')));
    }
    assert.equal(index.plugins.find(p => p.pluginId === 'matrix').enabled, false, 'registration must preserve disabled policy');
    const { forceDisableUninstalledChannelPlugins } = require('../gateway-boot-harden.js');
    forceDisableUninstalledChannelPlugins(config, { runtimeRoot: root });
    assert.equal(config.plugins.entries.matrix.enabled, false, 'later startup hardening must preserve disabled policy too');
    db.exec('CREATE TABLE nexora_guard_data (value TEXT); INSERT INTO nexora_guard_data VALUES (\'keep-me\');');
    const subset = { ...options, seeds: { feishu: seeds.feishu } };
    const second = await syncBundledPluginRegistry(subset);
    assert.equal(second.changed, false, 'repeat registration must be idempotent');
    assert.deepEqual(read().installRecords, index.installRecords, 'keep records outside the supplied seed set');
    assert.equal(db.prepare('SELECT value FROM nexora_guard_data').get().value, 'keep-me', 'retain other state tables');
    db.close();
    db = null;
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'openclaw.json'))).plugins.installs, undefined);
    console.log('Plugin registry: fresh SQLite install, dedupe, disabled policy, idempotence and state preservation passed');
} finally {
    if (db) db.close();
    for (const peerLink of newPeerLinks) {
        assert.ok(path.resolve(peerLink).startsWith(root + path.sep));
        if (fs.lstatSync(peerLink, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(peerLink);
    }
    assert.ok(path.resolve(stateDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(stateDir, { recursive: true, force: true });
}
