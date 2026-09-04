import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ClientSettingsStore,
  isSafeRendererSettingKey
} = require('../client-settings-store.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-client-settings-'));
try {
  const databasePath = path.join(tempDir, 'client-settings.sqlite');
  let store = new ClientSettingsStore(databasePath);

  assert.equal(store.get('system', 'missing', 'fallback'), 'fallback');
  store.set('system', 'autostart', true);
  store.set('system', 'accelerationState', { enabled: true, mode: 'rule' });
  assert.equal(store.get('system', 'autostart'), true);
  assert.deepEqual(store.get('system', 'accelerationState'), { enabled: true, mode: 'rule' });

  const first = store.bootstrap('renderer', {
    setting_language: 'zh-CN',
    'user-theme': 'theme-abyss',
    client_pref_image_generator: '{"apiKey":"must-not-migrate"}'
  }, isSafeRendererSettingKey);
  assert.equal(first.setting_language, 'zh-CN');
  assert.equal(first['user-theme'], 'theme-abyss');
  assert.equal(first.client_pref_image_generator, undefined, 'credential-bearing generator config must not enter the settings db');

  store.set('renderer', 'setting_language', 'en-US');
  const second = store.bootstrap('renderer', { setting_language: 'zh-TW' }, isSafeRendererSettingKey);
  assert.equal(second.setting_language, 'en-US', 'database value must win over stale localStorage');
  assert.equal(store.remove('renderer', 'setting_language'), true);
  assert.equal(store.get('renderer', 'setting_language', null), null);
  store.close();

  store = new ClientSettingsStore(databasePath);
  assert.equal(store.get('system', 'autostart'), true, 'settings must survive reopen');
  assert.deepEqual(store.get('system', 'accelerationState'), { enabled: true, mode: 'rule' });
  store.close();

  assert.equal(isSafeRendererSettingKey('setting_future_option'), true);
  assert.equal(isSafeRendererSettingKey('acc_ui_sort'), true);
  assert.equal(isSafeRendererSettingKey('setting_api_key'), false);
  assert.equal(isSafeRendererSettingKey('chat_history'), false);

  const corruptPath = path.join(tempDir, 'corrupt.sqlite');
  fs.writeFileSync(corruptPath, 'not a sqlite database');
  const recovered = new ClientSettingsStore(corruptPath);
  recovered.set('system', 'recovered', true);
  assert.equal(recovered.get('system', 'recovered'), true);
  recovered.close();
  assert.ok(
    fs.readdirSync(tempDir).some((name) => /^corrupt\.sqlite\.corrupt-\d+\.bak$/.test(name)),
    'corrupt settings database must be retained as a backup'
  );
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('client settings store tests passed');
