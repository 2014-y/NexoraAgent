/**
 * Disk Compact Plugin v1.0
 * 
 * 核心机制：在上下文爆炸之前，主动把对话摘要写入磁盘文件，
 * 然后从会话中移除旧消息。这样永远不会触发 "context too large" 错误。
 * 
 * 工作流程：
 * 1. 每次收到回复后检查会话大小
 * 2. 超过阈值时，提取关键对话摘要写入磁盘
 * 3. 标记需要 compact 的会话
 * 4. 保留身份、偏好、记忆等关键信息
 */

import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_NAME = 'disk-compact';
const COMPACT_DIR = '$env:USERPROFILE\\.openclaw\\workspace\\compact-history';
const TOKEN_THRESHOLD = 20000;       // 达到此 token 数就开始压缩
const SAFE_THRESHOLD = 15000;        // 目标 token 数
const IDENTITY_SNAPSHOT = '$env:USERPROFILE\\.openclaw\\workspace\\compact-history\\identity.json';

// 确保目录存在
function ensureDir() {
  if (!fs.existsSync(COMPACT_DIR)) {
    fs.mkdirSync(COMPACT_DIR, { recursive: true });
  }
}

// 读取当前会话文件
function readSession(sessionFile) {
  try {
    if (!sessionFile || !fs.existsSync(sessionFile)) return [];
    const content = fs.readFileSync(sessionFile, 'utf-8');
    return content.split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// 估算 JSON 行的 token 数（粗略：每 4 字符 ≈ 1 token）
function estimateTokens(lines) {
  let totalChars = 0;
  for (const line of lines) {
    totalChars += line.length;
  }
  return Math.ceil(totalChars / 4);
}

// 提取用户偏好和身份信息（永不删除）
function extractIdentity(lines) {
  const identity = {
    systemPrompts: [],
    userMessages: [],
    keyDecisions: [],
    metadata: {}
  };

  for (const line of lines) {
    if (line.type === 'session') {
      identity.metadata = { ...line };
    }
    if (line.type === 'message' && line.message?.role === 'user') {
      const content = line.message.content;
      const text = typeof content === 'string' ? content : 
        (Array.isArray(content) ? content.map(c => c.text || '').join('') : '');
      
      // 识别身份相关消息
      if (/^(我叫|我的名字|我是|你是谁|你叫什么|你的身份)/.test(text)) {
        identity.keyDecisions.push({ type: 'identity', text });
      }
      // 识别偏好相关消息
      if (/^(记住|偏好|设置|规则|不要|禁止|喜欢|不喜欢)/.test(text)) {
        identity.keyDecisions.push({ type: 'preference', text });
      }
    }
  }
  return identity;
}

// 生成紧凑摘要并写入磁盘
function writeCompactSummary(lines, sessionKey) {
  ensureDir();
  
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  const summaryFile = path.join(COMPACT_DIR, `${sessionKey}_${dateStr}_${timeStr}.md`);
  
  // 提取最近的有效对话
  const recentConversations = [];
  let currentQ = null;
  
  for (const line of lines) {
    if (line.type !== 'message') continue;
    const msg = line.message;
    if (!msg?.content) continue;
    
    const text = typeof msg.content === 'string' ? msg.content :
      (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '');
    
    if (msg.role === 'user' && text.length > 5) {
      currentQ = { role: 'user', text: text.substring(0, 500) };
    } else if (msg.role === 'assistant' && currentQ && text.length > 5) {
      currentQ.response = text.substring(0, 500);
      recentConversations.push(currentQ);
      currentQ = null;
    }
  }

  // 写入摘要文件
  const summary = [
    `# 对话摘要 - ${dateStr} ${timeStr}`,
    ``,
    `## 关键决策与偏好`,
    ...extractIdentity(lines).keyDecisions.map(d => `- [${d.type}] ${d.text.substring(0, 200)}`),
    ``,
    `## 对话记录`,
    ...recentConversations.map((c, i) => 
      `### Q${i+1}\n- **问**: ${c.text.substring(0, 300)}\n- **答**: ${c.response?.substring(0, 300) || '(无)'}`
    ),
    ``,
    `## 统计`,
    `- 对话轮数: ${recentConversations.length}`,
    `- 生成时间: ${now.toISOString()}`,
  ].join('\n');

  try {
    fs.writeFileSync(summaryFile, summary, 'utf-8');
    console.log(`[disk-compact] 💾 摘要已保存到: ${summaryFile}`);
    return summaryFile;
  } catch (e) {
    console.error(`[disk-compact] ❌ 写入失败: ${e.message}`);
    return null;
  }
}

// 读取身份快照
function readIdentitySnapshot() {
  try {
    if (fs.existsSync(IDENTITY_SNAPSHOT)) {
      return JSON.parse(fs.readFileSync(IDENTITY_SNAPSHOT, 'utf-8'));
    }
  } catch {}
  return null;
}

// 保存身份快照
function saveIdentitySnapshot(identity) {
  ensureDir();
  try {
    fs.writeFileSync(IDENTITY_SNAPSHOT, JSON.stringify(identity, null, 2), 'utf-8');
  } catch {}
}

export default function createPlugin(runtime) {
  console.log(`[${PLUGIN_NAME}] 磁盘压缩插件已加载 (阈值: ${TOKEN_THRESHOLD})`);
  ensureDir();

  // 启动时恢复身份快照
  const snapshot = readIdentitySnapshot();
  if (snapshot) {
    console.log(`[${PLUGIN_NAME}] 已加载身份快照 (${snapshot.conversationCount} 次压缩)`);
  }

  let lastTokenCount = 0;
  let compactCounter = 0;

  return {
    name: PLUGIN_NAME,

    // 每次收到回复后检查上下文大小
    async onAfterResponse(context) {
      try {
        const sessionFile = context?.sessionFile;
        if (!sessionFile) return;

        const lines = readSession(sessionFile);
        const tokenCount = estimateTokens(lines);
        
        // Token 数没有变化，跳过
        if (Math.abs(tokenCount - lastTokenCount) < 500) return;
        lastTokenCount = tokenCount;

        // 超过阈值，触发压缩
        if (tokenCount > TOKEN_THRESHOLD) {
          console.log(`[${PLUGIN_NAME}] ⚠️ 上下文过大 (${tokenCount} tokens)，触发磁盘压缩...`);
          
          // 1. 提取身份信息
          const identity = extractIdentity(lines);
          saveIdentitySnapshot({
            ...identity,
            conversationCount: (snapshot?.conversationCount || 0) + 1,
            lastCompactAt: new Date().toISOString()
          });

          // 2. 写入磁盘摘要
          const sessionKey = context?.sessionId || 'unknown';
          const summaryFile = writeCompactSummary(lines, sessionKey);

          // 3. 保留最近的对话 + 身份信息，截断旧的
          const recentLines = lines.slice(-30); // 只保留最近 30 条记录
          
          // 4. 写回会话文件
          fs.writeFileSync(sessionFile, recentLines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
          
          compactCounter++;
          console.log(`[${PLUGIN_NAME}] ✅ 压缩完成 (第 ${compactCounter} 次)，剩余 ${recentLines.length} 条记录`);
        }
      } catch (e) {
        // 静默失败，不影响正常对话
        console.error(`[${PLUGIN_NAME}] 压缩异常: ${e.message}`);
      }
    },

    // 插件卸载时保存统计
    async onShutdown() {
      console.log(`[${PLUGIN_NAME}] 已停止，共压缩 ${compactCounter} 次`);
    },
  };
}
