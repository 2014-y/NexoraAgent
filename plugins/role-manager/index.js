/**
 * role-manager — 全渠道角色查询 / 切换
 *
 * 通过 OpenClaw inbound_claim / before_dispatch 拦截角色命令，
 * 直接回复而不消耗模型调用。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const roleCommands = require('./role-commands.cjs');

const PLUGIN_ID = 'role-manager';

function extractMessageText(event) {
  if (!event || typeof event !== 'object') return '';
  const candidates = [
    event.content,
    event.body,
    event.Body,
    event.bodyForAgent,
    event.BodyForAgent,
    event.commandBody,
    event.CommandBody,
    event.rawBody,
    event.RawBody
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function handleInboundRoleCommand(event) {
  const text = extractMessageText(event);
  if (!text) return undefined;
  try {
    const result = roleCommands.handleRoleCommand(text, { moduleDir: __dirname });
    if (!result || !result.handled) return undefined;
    return result;
  } catch (err) {
    return {
      handled: true,
      text: `角色命令处理失败：${err && err.message ? err.message : String(err)}`
    };
  }
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: 'Role Manager',
  description: 'List, search, and switch global AI roles from any channel.',
  register(api) {
    api.logger?.info?.('[role-manager] loaded');

    api.on(
      'inbound_claim',
      (event) => {
        const result = handleInboundRoleCommand(event);
        if (!result) return undefined;
        return {
          handled: true,
          reply: { text: result.text }
        };
      },
      { priority: 90 }
    );

    api.on(
      'before_dispatch',
      (event) => {
        const result = handleInboundRoleCommand(event);
        if (!result) return undefined;
        return {
          handled: true,
          text: result.text
        };
      },
      { priority: 90 }
    );
  }
});
