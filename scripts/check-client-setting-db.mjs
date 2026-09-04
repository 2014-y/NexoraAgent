import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ClientSettingsStore } = require('../client-settings-store.js');
const databasePath = process.env.NEXORA_SETTINGS_DB;
const scope = process.env.NEXORA_SETTING_SCOPE || 'renderer';
const key = process.env.NEXORA_SETTING_KEY;
const expected = process.env.NEXORA_SETTING_EXPECTED;
const removeAfterCheck = process.env.NEXORA_SETTING_REMOVE === '1';
if (!databasePath || !key) throw new Error('NEXORA_SETTINGS_DB and NEXORA_SETTING_KEY are required');

const store = new ClientSettingsStore(databasePath);
try {
  const actual = store.get(scope, key, null);
  if (expected === '__ABSENT__') assert.equal(actual, null);
  else if (expected !== undefined) assert.equal(String(actual), String(expected));
  if (removeAfterCheck) store.remove(scope, key);
  console.log(JSON.stringify({ success: true, scope, key, present: actual !== null }));
} finally {
  store.close();
}
