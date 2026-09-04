'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;
const MAX_KEY_LENGTH = 160;
const MAX_VALUE_BYTES = 512 * 1024;
const BLOCKED_KEY_PARTS = /(api[-_]?key|secret|password|credential|access[-_]?token|refresh[-_]?token)/i;
const RENDERER_SETTING_PREFIXES = [
    'setting_',
    'custom_theme_',
    'acc_ui_',
    'acc_auto_select_'
];
const RENDERER_SETTING_KEYS = new Set([
    'user-theme',
    'sidebar_collapsed',
    'console_pref_channel',
    'console_view_mode',
    'chat_quick_panel_collapsed',
    'guide_completed',
    'client_pref_image_model',
    'client_pref_video_model'
]);

function isSafeRendererSettingKey(value) {
    const key = String(value || '').trim();
    if (!key || key.length > MAX_KEY_LENGTH || BLOCKED_KEY_PARTS.test(key)) return false;
    return RENDERER_SETTING_KEYS.has(key)
        || RENDERER_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function normalizeScope(value) {
    const scope = String(value || '').trim();
    if (!/^[a-z][a-z0-9._-]{0,63}$/i.test(scope)) throw new Error('invalid client setting scope');
    return scope;
}

function normalizeKey(value) {
    const key = String(value || '').trim();
    if (!key || key.length > MAX_KEY_LENGTH || /[\0\r\n]/.test(key)) {
        throw new Error('invalid client setting key');
    }
    return key;
}

function encodeValue(value) {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') throw new Error('client setting value is not serializable');
    if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) throw new Error('client setting value is too large');
    return json;
}

function decodeValue(json) {
    try { return JSON.parse(String(json)); } catch (_) { return undefined; }
}

class ClientSettingsStore {
    constructor(databasePath) {
        this.databasePath = path.resolve(String(databasePath || ''));
        if (!this.databasePath) throw new Error('client settings database path is required');
        this.db = null;
        this.open();
    }

    open() {
        fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
        try {
            this.db = new DatabaseSync(this.databasePath);
            this.initializeSchema();
        } catch (error) {
            try { if (this.db) this.db.close(); } catch (_) {}
            this.db = null;
            if (fs.existsSync(this.databasePath)) {
                const backup = `${this.databasePath}.corrupt-${Date.now()}.bak`;
                try { fs.renameSync(this.databasePath, backup); } catch (_) {}
                for (const suffix of ['-wal', '-shm']) {
                    try { fs.rmSync(`${this.databasePath}${suffix}`, { force: true }); } catch (_) {}
                }
            }
            this.db = new DatabaseSync(this.databasePath);
            this.initializeSchema();
            console.warn('[ClientSettings] Recreated an unreadable settings database:', error && error.message);
        }
    }

    initializeSchema() {
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 3000;
            CREATE TABLE IF NOT EXISTS client_settings (
                scope TEXT NOT NULL,
                key TEXT NOT NULL,
                value_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (scope, key)
            ) STRICT;
            CREATE INDEX IF NOT EXISTS idx_client_settings_updated_at
                ON client_settings(updated_at);
            PRAGMA user_version = ${SCHEMA_VERSION};
        `);
    }

    get(scope, key, fallback = undefined) {
        const row = this.db.prepare(
            'SELECT value_json FROM client_settings WHERE scope = ? AND key = ?'
        ).get(normalizeScope(scope), normalizeKey(key));
        if (!row) return fallback;
        const value = decodeValue(row.value_json);
        return value === undefined ? fallback : value;
    }

    getAll(scope) {
        const rows = this.db.prepare(
            'SELECT key, value_json FROM client_settings WHERE scope = ? ORDER BY key'
        ).all(normalizeScope(scope));
        const result = Object.create(null);
        for (const row of rows) {
            const value = decodeValue(row.value_json);
            if (value !== undefined) result[row.key] = value;
        }
        return result;
    }

    set(scope, key, value) {
        const normalizedScope = normalizeScope(scope);
        const normalizedKey = normalizeKey(key);
        const json = encodeValue(value);
        this.db.prepare(`
            INSERT INTO client_settings(scope, key, value_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(scope, key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
        `).run(normalizedScope, normalizedKey, json, Date.now());
        return value;
    }

    setIfAbsent(scope, key, value) {
        const normalizedScope = normalizeScope(scope);
        const normalizedKey = normalizeKey(key);
        const json = encodeValue(value);
        const result = this.db.prepare(`
            INSERT OR IGNORE INTO client_settings(scope, key, value_json, updated_at)
            VALUES (?, ?, ?, ?)
        `).run(normalizedScope, normalizedKey, json, Date.now());
        return Number(result.changes || 0) > 0;
    }

    remove(scope, key) {
        const result = this.db.prepare(
            'DELETE FROM client_settings WHERE scope = ? AND key = ?'
        ).run(normalizeScope(scope), normalizeKey(key));
        return Number(result.changes || 0) > 0;
    }

    clear(scope) {
        const result = this.db.prepare('DELETE FROM client_settings WHERE scope = ?')
            .run(normalizeScope(scope));
        return Number(result.changes || 0);
    }

    bootstrap(scope, legacyValues, filter = null) {
        const normalizedScope = normalizeScope(scope);
        const entries = Object.entries(legacyValues && typeof legacyValues === 'object' ? legacyValues : {})
            .filter(([key]) => !filter || filter(key));
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const [key, value] of entries) {
                this.setIfAbsent(normalizedScope, key, value);
            }
            this.db.exec('COMMIT');
        } catch (error) {
            try { this.db.exec('ROLLBACK'); } catch (_) {}
            throw error;
        }
        return this.getAll(normalizedScope);
    }

    close() {
        if (!this.db) return;
        try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) {}
        try { this.db.close(); } catch (_) {}
        this.db = null;
    }
}

module.exports = {
    ClientSettingsStore,
    isSafeRendererSettingKey,
    RENDERER_SETTING_PREFIXES,
    RENDERER_SETTING_KEYS,
    MAX_VALUE_BYTES
};
