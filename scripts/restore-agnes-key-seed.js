'use strict';

// 从用户明确指定的旧配置中恢复 Agnes 凭证种子。
// 不打印、不复制密钥到源码；正式 openclaw.json 仍由应用 config-save 原子写入。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const source = path.resolve(String(process.argv[2] || ''));
const stateDir = path.resolve(
  String(process.argv[3] || process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw'))
);

if (!source || !fs.existsSync(source)) throw new Error('A readable source config is required');

const config = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
const key = String(config?.models?.providers?.['agnes-ai']?.apiKey || '').trim();
if (key.length < 30 || /YOUR_|PLACEHOLDER|CHANGE_ME/i.test(key)) {
  throw new Error('Source config does not contain a usable Agnes credential');
}

fs.mkdirSync(stateDir, { recursive: true });
const target = path.join(stateDir, '.agnes-keys.json');
const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
fs.writeFileSync(temp, JSON.stringify([key], null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
fs.renameSync(temp, target);
try { fs.chmodSync(target, 0o600); } catch (_) {}

const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
console.log(`[restore-agnes-key-seed] restored 1 key to ${target} (sha256:${fingerprint})`);
