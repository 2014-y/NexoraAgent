'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PAGE_SIZE = 15;
const SEARCH_LIMIT = 12;
const MAX_REPLY_CHARS = 1800;

function resolveStateDir(explicit) {
  if (explicit) return String(explicit);
  return process.env.OPENCLAW_STATE_DIR
    || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(), '.openclaw');
}

function loadRoleConfigModule(baseDir) {
  const candidates = [
    path.join(baseDir || __dirname, 'role-config.js'),
    path.join(__dirname, 'role-config.js'),
    path.join(__dirname, '..', '..', 'role-config.js')
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return require(file);
    } catch (e) {}
  }
  throw new Error('role-config.js not found');
}

function normalizeRoleCommandText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[“”"']/g, '');
}

function findRolesForQuery(roles, query) {
  const needle = normalizeRoleCommandText(query)
    .replace(/(?:这个)?角色$/u, '')
    .replace(/口吻$/u, '');
  if (!needle) return [];

  const exact = roles.filter((role) =>
    normalizeRoleCommandText(role.name) === needle
    || normalizeRoleCommandText(role.id) === needle
  );
  if (exact.length) return exact;

  return roles.filter((role) => {
    const fields = [
      role.name,
      role.id,
      role.source,
      ...(role.tags || [])
    ].map(normalizeRoleCommandText);
    return fields.some((field) => field.includes(needle));
  });
}

function parseRoleSwitchQuery(text) {
  const source = String(text || '').trim();
  const explicitPatterns = [
    /^[/#]角色\s*[:：]?\s*(.+)$/iu,
    /^[/#]role\s*[:：]?\s*(.+)$/iu,
    /^(?:请)?(?:切换|更换|换|启用|使用)(?:模型)?角色(?:为|成|到)?\s*[:：]?\s*(.+)$/u,
    /^(?:请)?(?:切换|更换|换)(?:为|成|到)\s*(.+)$/u,
    /^(?:请)?(?:启用|使用)\s*(.+?)(?:角色|口吻)$/u,
    /^(?:please\s+)?(?:switch|change)\s+(?:the\s+)?role\s+(?:to\s+)?(.+)$/iu,
    /^(?:please\s+)?(?:switch|change)\s+to\s+(.+)$/iu,
    /^(?:please\s+)?(?:use|activate)\s+(.+?)\s+(?:role|persona)$/iu
  ];
  for (const pattern of explicitPatterns) {
    const match = source.match(pattern);
    if (match && match[1] && match[1].trim()) {
      return {
        query: match[1].trim(),
        explicit: /^[/#](?:角色|role)/iu.test(source) || /角色|role/iu.test(source)
      };
    }
  }
  return null;
}

function parseRoleCommand(text) {
  const source = String(text || '').trim();
  if (!source) return null;

  if (/^(?:当前|现在|目前)(?:使用的|启用的|是)?(?:什么|哪个)?(?:模型)?角色[？?]?$/u.test(source)
    || /^(?:我)?(?:现在|当前)是什么口吻[？?]?$/u.test(source)
    || /^(?:what(?:'s| is)\s+)?(?:the\s+)?current\s+(?:role|persona)[?]?$/iu.test(source)) {
    return { type: 'current' };
  }

  if (/^(?:角色指令|角色命令|怎么切换角色|如何切换角色|角色帮助)[？?]?$/u.test(source)
    || /^(?:role commands?|how (?:do i|to) (?:switch|change) roles?)[?]?$/iu.test(source)) {
    return { type: 'help' };
  }

  let match = source.match(/^(?:角色列表|列出角色|角色清单)(?:\s*[第]?\s*(\d+)\s*[页]?)?$/u)
    || source.match(/^role\s*list(?:\s+(\d+))?$/iu)
    || source.match(/^\/roles?(?:\s+(\d+))?$/iu);
  if (match) {
    const page = Math.max(1, parseInt(match[1] || '1', 10) || 1);
    return { type: 'list', page };
  }

  match = source.match(/^(?:搜索|查找|检索)角色\s+(.+)$/u)
    || source.match(/^(?:角色搜索|角色查找)\s+(.+)$/u)
    || source.match(/^search\s+roles?\s+(.+)$/iu)
    || source.match(/^\/(?:searchrole|findrole)\s+(.+)$/iu);
  if (match && match[1].trim()) {
    return { type: 'search', query: match[1].trim() };
  }

  const switchQuery = parseRoleSwitchQuery(source);
  if (switchQuery) {
    return { type: 'switch', query: switchQuery.query, explicit: switchQuery.explicit };
  }

  return null;
}

function formatRoleLine(role, index) {
  const tags = (role.tags || []).slice(0, 3).join('/');
  const tagPart = tags ? ` · ${tags}` : '';
  return `${index}. ${role.name}（${role.source || '未标注'}${tagPart}）`;
}

function formatListPage(roles, page, pageSize = PAGE_SIZE) {
  const total = roles.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  const slice = roles.slice(start, start + pageSize);
  const lines = [
    `角色列表（共 ${total} 个，第 ${safePage}/${totalPages} 页）`,
    ...slice.map((role, i) => formatRoleLine(role, start + i + 1)),
    '',
    safePage < totalPages
      ? `下一页：角色列表 ${safePage + 1}`
      : '已到最后一页。可用「搜索角色 关键词」精确查找。'
  ];
  return trimReply(lines.join('\n'));
}

function formatSearchResults(query, matches, limit = SEARCH_LIMIT) {
  if (!matches.length) {
    return `没有找到与「${query}」匹配的角色。可发送「角色列表」浏览，或「角色指令」查看用法。`;
  }
  const shown = matches.slice(0, limit);
  const lines = [
    `搜索「${query}」：找到 ${matches.length} 个角色`,
    ...shown.map((role, i) => formatRoleLine(role, i + 1)),
    '',
    matches.length > limit ? `仅显示前 ${limit} 个，请用更具体的名称切换。` : '切换示例：/角色 贾维斯'
  ];
  return trimReply(lines.join('\n'));
}

function formatHelp() {
  return [
    '角色指令（微信/QQ/飞书等全渠道可用）：',
    '• 角色列表 / 角色列表 2',
    '• 搜索角色 贾维斯',
    '• 当前角色',
    '• /角色 温暖教师',
    '• 切换角色为王林',
    '',
    '切换后为全局生效，所有渠道从下一条消息起使用新口吻。'
  ].join('\n');
}

function trimReply(text) {
  const body = String(text || '').trim();
  if (body.length <= MAX_REPLY_CHARS) return body;
  return body.slice(0, MAX_REPLY_CHARS - 12).trimEnd() + '\n…(已截断)';
}

function syncSoulMd(configDir, role, roleConfig) {
  const wsDir = path.join(configDir, 'workspace');
  fs.mkdirSync(wsDir, { recursive: true });
  const soulPath = path.join(wsDir, 'SOUL.md');
  let existing = '';
  if (fs.existsSync(soulPath)) {
    existing = fs.readFileSync(soulPath, 'utf8').replace(/^\uFEFF/, '');
  }
  const next = roleConfig.applyManagedSoulBlock(existing, role);
  if (next !== existing) {
    fs.writeFileSync(soulPath, next, 'utf8');
  }
  return soulPath;
}

function handleRoleCommand(text, opts = {}) {
  const parsed = parseRoleCommand(text);
  if (!parsed) return { handled: false };

  const configDir = resolveStateDir(opts.configDir);
  const roleConfig = opts.roleConfig || loadRoleConfigModule(opts.moduleDir);
  const cfg = roleConfig.readRoleConfig(configDir);
  const roles = roleConfig.listAllRoles(cfg);

  if (parsed.type === 'current') {
    const active = roleConfig.getActiveRole(cfg);
    return {
      handled: true,
      text: active
        ? `当前全局角色：${active.name}（${active.source || '未标注出处'}）\n简介：${active.summary || '无'}`
        : '当前未找到启用角色。'
    };
  }

  if (parsed.type === 'help') {
    return { handled: true, text: formatHelp() };
  }

  if (parsed.type === 'list') {
    return { handled: true, text: formatListPage(roles, parsed.page) };
  }

  if (parsed.type === 'search') {
    const matches = findRolesForQuery(roles, parsed.query);
    return { handled: true, text: formatSearchResults(parsed.query, matches) };
  }

  if (parsed.type === 'switch') {
    const matches = findRolesForQuery(roles, parsed.query);
    if (!matches.length) {
      if (!parsed.explicit) return { handled: false };
      return {
        handled: true,
        text: `没有找到「${parsed.query}」角色。可发送「搜索角色 ${parsed.query}」或「角色列表」。`
      };
    }
    if (matches.length > 1) {
      const names = matches.slice(0, 8).map((role) => `• ${role.name}（${role.source}）`).join('\n');
      return {
        handled: true,
        text: trimReply(`找到多个相近角色，请说出完整名称：\n${names}${matches.length > 8 ? '\n• …' : ''}`)
      };
    }

    const role = matches[0];
    const activated = roleConfig.setActiveRole(cfg, role.id);
    if (!activated.ok) {
      return { handled: true, text: `角色切换失败：${activated.error || '未知错误'}` };
    }
    const saved = roleConfig.writeRoleConfig(configDir, activated.config);
    try {
      syncSoulMd(configDir, activated.role, roleConfig);
    } catch (e) {
      return {
        handled: true,
        text: `已写入角色「${role.name}」，但同步 SOUL.md 失败：${e.message || e}`
      };
    }
    return {
      handled: true,
      text: `已切换为「${role.name}」角色（${role.source || '未标注'}）。所有渠道从下一条消息起使用该口吻。`,
      role: activated.role,
      config: saved
    };
  }

  return { handled: false };
}

module.exports = {
  PAGE_SIZE,
  SEARCH_LIMIT,
  MAX_REPLY_CHARS,
  resolveStateDir,
  loadRoleConfigModule,
  normalizeRoleCommandText,
  findRolesForQuery,
  parseRoleSwitchQuery,
  parseRoleCommand,
  formatListPage,
  formatSearchResults,
  formatHelp,
  syncSoulMd,
  handleRoleCommand
};
