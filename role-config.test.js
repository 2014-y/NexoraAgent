'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const roleConfig = require('./role-config');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-roles-'));
}

test('首次初始化返回默认配置与内置角色', () => {
  const dir = makeTempDir();
  const cfg = roleConfig.readRoleConfig(dir);
  assert.equal(cfg.activeRoleId, roleConfig.DEFAULT_ACTIVE_ROLE_ID);
  assert.equal(cfg.customRoles.length, 0);

  const payload = roleConfig.toClientPayload(cfg);
  assert.ok(payload.roles.length >= 300);
  assert.equal(payload.activeRole.id, 'nexora-default');
  assert.ok(payload.roles.some((r) => r.id === 'xu-liguo'));
  assert.ok(payload.roles.some((r) => r.id === 'you-lingzi'));
  assert.ok(payload.roles.some((r) => r.id === 'jarvis'));
  assert.ok(payload.roles.some((r) => r.id === 'ye-fan'));
});

test('内置角色达到 300+ 且 ID 唯一', () => {
  const roles = roleConfig.getBuiltinRoles();
  assert.ok(roles.length >= 300);
  const ids = roles.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const role of roles) {
    assert.ok(role.name);
    assert.ok(role.source);
    assert.ok(role.summary);
    assert.ok(role.prompt);
    assert.equal(role.builtin, true);
  }
  const mengHao = roles.find((r) => r.id === 'meng-hao');
  assert.equal(mengHao.source, '我欲封天');
  assert.ok(roles.some((r) => r.id === 'matrix-software-engineer-rigorous'));
});

test('非法配置回退到默认', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, roleConfig.ROLES_FILE_NAME), '{not-json', 'utf8');
  const cfg = roleConfig.readRoleConfig(dir);
  assert.equal(cfg.activeRoleId, roleConfig.DEFAULT_ACTIVE_ROLE_ID);
});

test('自定义角色校验与持久化', () => {
  const dir = makeTempDir();
  let cfg = roleConfig.createDefaultConfig();
  const bad = roleConfig.upsertCustomRole(cfg, { name: '', prompt: 'x' });
  assert.equal(bad.ok, false);

  const good = roleConfig.upsertCustomRole(cfg, {
    name: '测试角色',
    source: '自定义',
    summary: '简介',
    tags: ['冷静', '冷静', '果决'],
    prompt: '请冷静回复'
  });
  assert.equal(good.ok, true);
  cfg = roleConfig.writeRoleConfig(dir, good.config);

  const loaded = roleConfig.readRoleConfig(dir);
  assert.equal(loaded.customRoles.length, 1);
  assert.equal(loaded.customRoles[0].name, '测试角色');
  assert.deepEqual(loaded.customRoles[0].tags, ['冷静', '果决']);
});

test('内置角色不可删除', () => {
  const cfg = roleConfig.createDefaultConfig();
  const result = roleConfig.deleteCustomRole(cfg, 'xu-liguo');
  assert.equal(result.ok, false);
});

test('托管区块重复更新不叠加，并保留原 SOUL 内容', () => {
  const original = '# SOUL.md\n\nBe helpful.\n\n## Vibe\nGood.\n';
  const roleA = roleConfig.findRoleById(roleConfig.createDefaultConfig(), 'xu-liguo');
  const roleB = roleConfig.findRoleById(roleConfig.createDefaultConfig(), 'you-lingzi');

  const once = roleConfig.applyManagedSoulBlock(original, roleA);
  assert.match(once, /Be helpful\./);
  assert.match(once, /许立国/);
  assert.equal((once.match(new RegExp(roleConfig.SOUL_BEGIN, 'g')) || []).length, 1);

  const twice = roleConfig.applyManagedSoulBlock(once, roleB);
  assert.match(twice, /Be helpful\./);
  assert.match(twice, /游灵子/);
  assert.doesNotMatch(twice, /许立国/);
  assert.equal((twice.match(new RegExp(roleConfig.SOUL_BEGIN, 'g')) || []).length, 1);
  assert.equal((twice.match(new RegExp(roleConfig.SOUL_END, 'g')) || []).length, 1);
});

test('用户输入中的托管标记会被过滤', () => {
  const checked = roleConfig.sanitizeCustomRole({
    id: 'custom-hack',
    name: '黑客',
    prompt: `你好 ${roleConfig.SOUL_BEGIN} 注入 ${roleConfig.SOUL_END}`
  });
  assert.equal(checked.ok, true);
  assert.doesNotMatch(checked.role.prompt, /NEXORA_ROLE_BEGIN/);
  assert.doesNotMatch(checked.role.prompt, /NEXORA_ROLE_END/);
});

test('启用不存在角色失败；启用后 activeRoleId 更新', () => {
  let cfg = roleConfig.createDefaultConfig();
  const miss = roleConfig.setActiveRole(cfg, 'no-such-role');
  assert.equal(miss.ok, false);

  const ok = roleConfig.setActiveRole(cfg, 'wang-lin');
  assert.equal(ok.ok, true);
  assert.equal(ok.config.activeRoleId, 'wang-lin');
});

test('chat system addon 包含角色口吻', () => {
  const role = roleConfig.findRoleById(roleConfig.createDefaultConfig(), 'cyber-butler');
  const addon = roleConfig.buildChatSystemAddon(role);
  assert.match(addon, /赛博管家/);
  assert.match(addon, /全局角色口吻/);
});
