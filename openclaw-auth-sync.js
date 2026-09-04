const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AGNES_PROVIDER_ID = 'agnes-ai';
const AGNES_PROFILE_ID = 'agnes-ai:default';
const INLINE_AGNES_USAGE_ID = 'inline-api-key:agnes-ai';

function normalizeApiKey(value) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!key || /^(YOUR_|PLACEHOLDER|CHANGE_ME)/i.test(key)) return '';
    if (key === AGNES_PROFILE_ID) return '';
    if (/^(secretref-|\$\{|env:)/i.test(key)) return '';
    return key;
}

function getConfiguredAgnesApiKey(config) {
    return normalizeApiKey(
        config
        && config.models
        && config.models.providers
        && config.models.providers[AGNES_PROVIDER_ID]
        && config.models.providers[AGNES_PROVIDER_ID].apiKey
    );
}

function ensureAgnesAuthProfileConfig(config) {
    const apiKey = getConfiguredAgnesApiKey(config);
    if (!apiKey || !config || typeof config !== 'object') {
        return { changed: false, apiKey: '' };
    }

    let changed = false;
    if (!config.auth || typeof config.auth !== 'object' || Array.isArray(config.auth)) {
        config.auth = {};
        changed = true;
    }
    if (!config.auth.profiles || typeof config.auth.profiles !== 'object' || Array.isArray(config.auth.profiles)) {
        config.auth.profiles = {};
        changed = true;
    }
    const expected = { provider: AGNES_PROVIDER_ID, mode: 'api_key' };
    const current = config.auth.profiles[AGNES_PROFILE_ID];
    if (!current || current.provider !== expected.provider || current.mode !== expected.mode) {
        config.auth.profiles[AGNES_PROFILE_ID] = expected;
        changed = true;
    }

    // A duplicated config env value creates a second auth candidate in OpenClaw
    // 2026.9. Keep one authoritative profile-backed credential instead.
    const env = config.env;
    if (env && typeof env === 'object' && !Array.isArray(env)) {
        if (env.AGNES_AI_API_KEY === apiKey) {
            delete env.AGNES_AI_API_KEY;
            changed = true;
        }
        if (env.vars && typeof env.vars === 'object' && env.vars.AGNES_AI_API_KEY === apiKey) {
            delete env.vars.AGNES_AI_API_KEY;
            changed = true;
            if (Object.keys(env.vars).length === 0) delete env.vars;
        }
        if (Object.keys(env).length === 0) delete config.env;
    }

    return { changed, apiKey };
}

function repairAuthPayloads(store, state, apiKey) {
    const normalizedKey = normalizeApiKey(apiKey);
    if (!normalizedKey) return { changed: false, credentialChanged: false, cooldownCleared: false };

    const nextStore = store && typeof store === 'object' && !Array.isArray(store)
        ? JSON.parse(JSON.stringify(store))
        : { version: 1, profiles: {} };
    if (!nextStore.version) nextStore.version = 1;
    if (!nextStore.profiles || typeof nextStore.profiles !== 'object' || Array.isArray(nextStore.profiles)) {
        nextStore.profiles = {};
    }

    const current = nextStore.profiles[AGNES_PROFILE_ID];
    const credentialChanged = !current
        || current.type !== 'api_key'
        || current.provider !== AGNES_PROVIDER_ID
        || current.key !== normalizedKey;
    if (credentialChanged) {
        nextStore.profiles[AGNES_PROFILE_ID] = {
            type: 'api_key',
            provider: AGNES_PROVIDER_ID,
            key: normalizedKey
        };
    }

    const nextState = state && typeof state === 'object' && !Array.isArray(state)
        ? JSON.parse(JSON.stringify(state))
        : { version: 1 };
    let cooldownCleared = false;
    if (credentialChanged && nextState.usageStats && typeof nextState.usageStats === 'object') {
        for (const id of [AGNES_PROFILE_ID, INLINE_AGNES_USAGE_ID]) {
            if (Object.prototype.hasOwnProperty.call(nextState.usageStats, id)) {
                delete nextState.usageStats[id];
                cooldownCleared = true;
            }
        }
        if (Object.keys(nextState.usageStats).length === 0) delete nextState.usageStats;
    }

    return {
        changed: credentialChanged || cooldownCleared,
        credentialChanged,
        cooldownCleared,
        store: nextStore,
        state: nextState
    };
}

function parseJson(value, fallback) {
    try {
        const parsed = JSON.parse(String(value || ''));
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

function hasTable(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function syncMachineStateStore(db, apiKey) {
    const storeRow = db.prepare('SELECT value_json FROM config_machine_state WHERE state_key = ?').get('authProfiles.store');
    const stateRow = db.prepare('SELECT value_json FROM config_machine_state WHERE state_key = ?').get('authProfiles.state');
    const repaired = repairAuthPayloads(
        parseJson(storeRow && storeRow.value_json, { version: 1, profiles: {} }),
        parseJson(stateRow && stateRow.value_json, { version: 1 }),
        apiKey
    );
    if (!repaired.changed) return repaired;

    const now = Date.now();
    const upsert = db.prepare(
        'INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?) '
        + 'ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms'
    );
    db.exec('BEGIN IMMEDIATE');
    try {
        upsert.run('authProfiles.store', JSON.stringify(repaired.store), now);
        upsert.run('authProfiles.state', JSON.stringify(repaired.state), now);
        db.exec('COMMIT');
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw error;
    }
    return repaired;
}

function syncLegacyAgentStore(db, apiKey) {
    const storeRow = db.prepare('SELECT store_json FROM auth_profile_store WHERE store_key = ?').get('primary');
    const stateRow = db.prepare('SELECT state_json FROM auth_profile_state WHERE state_key = ?').get('primary');
    const repaired = repairAuthPayloads(
        parseJson(storeRow && storeRow.store_json, { version: 1, profiles: {} }),
        parseJson(stateRow && stateRow.state_json, { version: 1 }),
        apiKey
    );
    if (!repaired.changed) return repaired;

    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare(
            'INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?) '
            + 'ON CONFLICT(store_key) DO UPDATE SET store_json = excluded.store_json, updated_at = excluded.updated_at'
        ).run('primary', JSON.stringify(repaired.store), now);
        db.prepare(
            'INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?) '
            + 'ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at'
        ).run('primary', JSON.stringify(repaired.state), now);
        db.exec('COMMIT');
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        throw error;
    }
    return repaired;
}

function syncAgnesAuthProfileToState(options = {}) {
    const stateDir = path.resolve(String(options.stateDir || ''));
    const apiKey = normalizeApiKey(options.apiKey);
    if (!stateDir || !apiKey) return { changed: false, skipped: 'missing-input' };

    const DatabaseSync = options.DatabaseSync || require('node:sqlite').DatabaseSync;
    const stateDbPath = path.join(stateDir, 'state', 'openclaw.sqlite');
    const legacyDbPath = path.join(stateDir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
    let dbPath = '';
    let mode = '';

    if (fs.existsSync(stateDbPath)) {
        const probe = new DatabaseSync(stateDbPath, { readOnly: true });
        try {
            if (hasTable(probe, 'config_machine_state')) {
                const owner = probe.prepare('SELECT value_json FROM config_machine_state WHERE state_key = ?').get('auth.sharedStore');
                const location = parseJson(owner && owner.value_json, { location: 'legacy-main' }).location;
                const hasStateStore = Boolean(probe.prepare('SELECT 1 FROM config_machine_state WHERE state_key = ?').get('authProfiles.store'));
                if (location === 'state-db' || hasStateStore) {
                    dbPath = stateDbPath;
                    mode = 'state-db';
                }
            }
        } finally {
            probe.close();
        }
    }
    if (!dbPath && fs.existsSync(legacyDbPath)) {
        dbPath = legacyDbPath;
        mode = 'legacy-main';
    }
    if (!dbPath) return { changed: false, skipped: 'auth-store-not-created' };

    const db = new DatabaseSync(dbPath);
    try {
        db.exec('PRAGMA busy_timeout = 5000');
        const repaired = mode === 'state-db'
            ? syncMachineStateStore(db, apiKey)
            : hasTable(db, 'auth_profile_store') && hasTable(db, 'auth_profile_state')
                ? syncLegacyAgentStore(db, apiKey)
                : { changed: false, skipped: 'auth-tables-not-created' };
        return {
            ...repaired,
            mode,
            fingerprint: crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 12)
        };
    } finally {
        db.close();
    }
}

module.exports = {
    AGNES_PROFILE_ID,
    getConfiguredAgnesApiKey,
    ensureAgnesAuthProfileConfig,
    repairAuthPayloads,
    syncAgnesAuthProfileToState
};
