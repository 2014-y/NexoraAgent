'use strict';
/**
 * 渠道配置自愈：保证打包到新机后 QQ/飞书账号 ID 与 OpenClaw 出站规范一致。
 * OpenClaw normalizeAccountId 只保留 [a-z0-9_-]；中文 ID 会被洗成 "default"，
 * 导致 sendMedia 报 missing appId/clientSecret（入站仍正常）。
 */

const OPENCLAW_ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function openclawNormalizeAccountId(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return 'default';
  if (OPENCLAW_ACCOUNT_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  const scrubbed = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return scrubbed || 'default';
}

function allocateQqbotAccountId(preferred, account, used) {
  const tryId = (raw) => {
    const id = String(raw || '').toLowerCase().slice(0, 64);
    if (!id || !OPENCLAW_ACCOUNT_ID_RE.test(id) || used.has(id)) return null;
    return id;
  };
  let id = tryId(preferred);
  if (id && id !== 'default') return id;
  const appId = account && account.appId
    ? String(account.appId).replace(/[^a-zA-Z0-9]/g, '')
    : '';
  if (appId) {
    id = tryId(`qq-${appId}`);
    if (id) return id;
  }
  let n = 1;
  while (used.has(`qqbot-${n}`)) n += 1;
  return `qqbot-${n}`;
}

function sanitizeQqbotConfig(config) {
  if (!config || !config.channels || !config.channels.qqbot) return false;
  const qq = config.channels.qqbot;
  if (typeof qq !== 'object' || Array.isArray(qq)) return false;
  let changed = false;

  if (!qq.accounts || typeof qq.accounts !== 'object') qq.accounts = {};

  if (qq.appId && (qq.clientSecret || qq.appSecret)) {
    if (Object.keys(qq.accounts).length === 0) {
      qq.accounts.default = {
        appId: String(qq.appId).trim(),
        clientSecret: String(qq.clientSecret || qq.appSecret).trim()
      };
      if (!qq.defaultAccount) qq.defaultAccount = 'default';
      changed = true;
    }
    delete qq.appId;
    delete qq.clientSecret;
    delete qq.appSecret;
    changed = true;
  }

  const oldAccounts = qq.accounts;
  const nextAccounts = {};
  const used = new Set();
  const renameMap = {};

  for (const oldId of Object.keys(oldAccounts)) {
    const account = oldAccounts[oldId];
    if (!account || typeof account !== 'object') continue;
    const normalized = openclawNormalizeAccountId(oldId);
    if (OPENCLAW_ACCOUNT_ID_RE.test(String(oldId).trim())) {
      let keep = String(oldId).trim().toLowerCase();
      if (used.has(keep)) keep = allocateQqbotAccountId(`${keep}-x`, account, used);
      nextAccounts[keep] = account;
      used.add(keep);
      if (keep !== oldId) {
        renameMap[oldId] = keep;
        changed = true;
      }
      continue;
    }
    const neu = allocateQqbotAccountId(normalized, account, used);
    nextAccounts[neu] = account;
    used.add(neu);
    renameMap[oldId] = neu;
    changed = true;
  }

  if (changed) {
    qq.accounts = nextAccounts;
    if (qq.defaultAccount && renameMap[qq.defaultAccount]) {
      qq.defaultAccount = renameMap[qq.defaultAccount];
    }
  }

  const accountIds = Object.keys(qq.accounts);
  if (accountIds.length > 0) {
    if (!qq.defaultAccount || !qq.accounts[qq.defaultAccount]) {
      qq.defaultAccount = accountIds[0];
      changed = true;
    } else if (!OPENCLAW_ACCOUNT_ID_RE.test(String(qq.defaultAccount))) {
      const fixed = renameMap[qq.defaultAccount] || openclawNormalizeAccountId(qq.defaultAccount);
      qq.defaultAccount = (fixed && qq.accounts[fixed]) ? fixed : accountIds[0];
      changed = true;
    }
    if (qq.enabled !== true) { qq.enabled = true; changed = true; }
    if (!qq.dmPolicy) { qq.dmPolicy = 'open'; changed = true; }
    if (!Array.isArray(qq.allowFrom)) { qq.allowFrom = ['*']; changed = true; }
    if (!qq.groupPolicy) { qq.groupPolicy = 'open'; changed = true; }
  }

  return changed;
}

module.exports = {
  OPENCLAW_ACCOUNT_ID_RE,
  openclawNormalizeAccountId,
  allocateQqbotAccountId,
  sanitizeQqbotConfig
};
