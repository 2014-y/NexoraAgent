'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const roleCommands = require('../plugins/role-manager/role-commands.cjs');
const roleConfig = require('../role-config');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-role-cmd-'));
}

test('非角色命令放行', () => {
  const dir = makeTempDir();
  const result = roleCommands.handleRoleCommand('今天天气怎么样', {
    configDir: dir,
    roleConfig
  });
  assert.equal(result.handled, false);
});

test('角色列表分页与总数', () => {
  const dir = makeTempDir();
  const page1 = roleCommands.handleRoleCommand('角色列表', { configDir: dir, roleConfig });
  assert.equal(page1.handled, true);
  assert.match(page1.text, /共 \d+ 个/);
  assert.match(page1.text, /第 1\//);
  assert.match(page1.text, /Nexora 助手/);

  const page2 = roleCommands.handleRoleCommand('角色列表 2', { configDir: dir, roleConfig });
  assert.equal(page2.handled, true);
  assert.match(page2.text, /第 2\//);
});

test('搜索角色可命中名称与标签', () => {
  const dir = makeTempDir();
  const byName = roleCommands.handleRoleCommand('搜索角色 贾维斯', { configDir: dir, roleConfig });
  assert.equal(byName.handled, true);
  assert.match(byName.text, /贾维斯/);

  const byTag = roleCommands.handleRoleCommand('搜索角色 漫威', { configDir: dir, roleConfig });
  assert.equal(byTag.handled, true);
  assert.match(byTag.text, /贾维斯|星期五/);
});

test('当前角色与帮助', () => {
  const dir = makeTempDir();
  const current = roleCommands.handleRoleCommand('当前角色', { configDir: dir, roleConfig });
  assert.equal(current.handled, true);
  assert.match(current.text, /Nexora 助手/);

  const help = roleCommands.handleRoleCommand('角色指令', { configDir: dir, roleConfig });
  assert.equal(help.handled, true);
  assert.match(help.text, /角色列表/);
  assert.match(help.text, /\/角色/);
});

test('精确切换会写配置并同步 SOUL', () => {
  const dir = makeTempDir();
  const result = roleCommands.handleRoleCommand('/角色 贾维斯', { configDir: dir, roleConfig });
  assert.equal(result.handled, true);
  assert.match(result.text, /已切换为「贾维斯」/);

  const cfg = roleConfig.readRoleConfig(dir);
  assert.equal(cfg.activeRoleId, 'jarvis');

  const soulPath = path.join(dir, 'workspace', 'SOUL.md');
  assert.ok(fs.existsSync(soulPath));
  const soul = fs.readFileSync(soulPath, 'utf8');
  assert.match(soul, /贾维斯/);
  assert.match(soul, /NEXORA_ROLE_BEGIN/);
});

test('模糊多命中不擅自切换', () => {
  const dir = makeTempDir();
  const result = roleCommands.handleRoleCommand('切换角色为医生', { configDir: dir, roleConfig });
  assert.equal(result.handled, true);
  assert.match(result.text, /多个相近角色|找到/);
  const cfg = roleConfig.readRoleConfig(dir);
  assert.equal(cfg.activeRoleId, roleConfig.DEFAULT_ACTIVE_ROLE_ID);
});

test('显式未知角色返回提示；非显式自然语言放行', () => {
  const dir = makeTempDir();
  const explicit = roleCommands.handleRoleCommand('/角色 不存在的角色XYZ', {
    configDir: dir,
    roleConfig
  });
  assert.equal(explicit.handled, true);
  assert.match(explicit.text, /没有找到/);

  const natural = roleCommands.handleRoleCommand('切换成英文', {
    configDir: dir,
    roleConfig
  });
  assert.equal(natural.handled, false);
});

test('parseRoleCommand 识别常用写法', () => {
  assert.equal(roleCommands.parseRoleCommand('角色列表 3').type, 'list');
  assert.equal(roleCommands.parseRoleCommand('角色列表 3').page, 3);
  assert.equal(roleCommands.parseRoleCommand('search role jarvis').type, 'search');
  assert.equal(roleCommands.parseRoleCommand('切换成王林').type, 'switch');
  assert.equal(roleCommands.parseRoleCommand('hello'), null);
});
