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
  const approvalSentinel = 'openclaw:approval-disabled';
  const preferredDefault = typeof qq.defaultAccount === 'string' ? qq.defaultAccount : '';

  if (!qq.accounts || typeof qq.accounts !== 'object' || Array.isArray(qq.accounts)) {
    qq.accounts = {};
    changed = true;
  }

  // Tencent QQBot 2.0 stores the default account on the channel root.  Older
  // Nexora builds moved it to accounts.default/defaultAccount, which OpenClaw
  // now treats as a legacy shape and refuses until doctor migrates it.
  const legacyDefault = qq.accounts.default;
  if (legacyDefault && typeof legacyDefault === 'object') {
    for (const [key, value] of Object.entries(legacyDefault)) {
      if (key !== 'accounts' && qq[key] === undefined) qq[key] = value;
    }
    delete qq.accounts.default;
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(qq, 'defaultAccount')) {
    delete qq.defaultAccount;
    changed = true;
  }
  if (qq.appSecret && !qq.clientSecret) {
    qq.clientSecret = String(qq.appSecret).trim();
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(qq, 'appSecret')) {
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
  }

  // The official 2.0 host schema no longer accepts defaultAccount. Preserve
  // legacy intent by moving the selected named account to insertion position 1.
  const wanted = renameMap[preferredDefault] || preferredDefault;
  if (wanted && wanted !== 'default' && qq.accounts[wanted]) {
    const reordered = { [wanted]: qq.accounts[wanted] };
    for (const [id, account] of Object.entries(qq.accounts)) {
      if (id !== wanted) reordered[id] = account;
    }
    qq.accounts = reordered;
    changed = true;
  }

  for (const account of Object.values(qq.accounts)) {
    if (!account || typeof account !== 'object') continue;
    if (!Array.isArray(account.allowFrom) || account.allowFrom.length === 0 || account.allowFrom.includes('*')) {
      const explicit = Array.isArray(account.allowFrom)
        ? account.allowFrom.filter((entry) => String(entry).trim() && entry !== '*')
        : [];
      account.allowFrom = explicit.length > 0 ? explicit : [approvalSentinel];
      changed = true;
    }
  }

  const accountIds = Object.keys(qq.accounts);
  if (accountIds.length > 0) {
    if (qq.enabled !== true) { qq.enabled = true; changed = true; }
    if (!qq.dmPolicy) { qq.dmPolicy = 'open'; changed = true; }
    if (!qq.groupPolicy) { qq.groupPolicy = 'allowlist'; changed = true; }
  }

  // In Tencent QQBot 2.0, dmPolicy controls chat access while allowFrom is the
  // native approval-operator list. A wildcard is deliberately invalid because
  // it would grant approval authority to every sender. Keep approvals locked
  // until the user explicitly supplies concrete QQ OpenIDs.
  if (!Array.isArray(qq.allowFrom) || qq.allowFrom.length === 0 || qq.allowFrom.includes('*')) {
    const explicit = Array.isArray(qq.allowFrom)
      ? qq.allowFrom.filter((entry) => String(entry).trim() && entry !== '*')
      : [];
    qq.allowFrom = explicit.length > 0 ? explicit : [approvalSentinel];
    changed = true;
  }

  return changed;
}

module.exports = {
  OPENCLAW_ACCOUNT_ID_RE,
  openclawNormalizeAccountId,
  allocateQqbotAccountId,
  sanitizeQqbotConfig
};
