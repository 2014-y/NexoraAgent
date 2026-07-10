/**
 * context-router 插件 — 上下文按需分发
 *
 * 问题：
 * - skills content: ~20KB（29个技能描述全部塞进每次请求）
 * - tools definitions: ~37KB（32个工具全部塞进每次请求）
 * - systemPrompt: ~28KB（所有文件内容嵌入）
 * - 总计 ~100KB ≈ 70K tokens，使用率 47%
 * - 一旦消息历史增长，很容易突破 128K 窗口导致 400 错误
 *
 * 解决方案：
 * 1. 技能按需加载 — 只加载当前对话相关的技能描述
 * 2. 工具按需注册 — 根据用户意图选择需要的工具
 * 3. 文件内容懒加载 — 不一次性嵌入所有文件，按需读取
 * 4. 上下文压缩 — 自动裁剪冗余的系统提示
 *
 * 效果：将基础上下文从 ~100KB 降到 ~15-25KB（减少 75-85%）
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── 常量 ───
const PROFILE = process.env.USERPROFILE || require('os').homedir();
const CACHE_DIR = path.join(PROFILE, '.openclaw', 'workspace', '.desktop-cache');
const CONTEXT_LOG_PATH = path.join(PROFILE, '.openclaw', 'logs', 'context-router.jsonl');

// ─── 技能分类索引 ───
// 将技能按领域分组，按需加载
const SKILL_CATEGORIES = {
  messaging: ['openclaw-weixin', 'whatsapp', 'discord', 'slack', 'telegram', 'signal', 'imsg', 'googlechat'],
  browser: ['browser', 'google', 'duckduckgo', 'searxng'],
  desktop: ['talon', 'canvas', 'device-pair'],
  memory: ['memory-core', 'active-memory', 'memory-wiki', 'amygdala-memory'],
  voice: ['voice-call', 'talk-voice', 'sherpa-onnx-tts', 'openai-whisper', 'openai-whisper-api'],
  coding: ['coding-agent', 'python-debugpy', 'github', 'gh-issues'],
  productivity: ['1password', 'notion', 'trello', 'obsidian', 'bear-notes', 'apple-notes', 'apple-reminders', 'things-mac'],
  media: ['camsnap', 'peekaboo', 'video-frames', 'spotify-player', 'songsee'],
  smart_home: ['openhue', 'sonoscli'],
  utility: ['summarize', 'oracle', 'sag', 'mcporter', 'blucli', 'eightctl', 'clawnected', 'de-ai-ify', 'gmail'],
  emotion: ['emotion-state', 'emotion-memory-assistant', 'girlfriend-simulator', 'mens-mental-health', 'moodcast', 'elicitation'],
  finance: ['food-order', 'ordercli', 'gog'],
};

// 构建反向索引：技能ID -> 类别
const SKILL_TO_CATEGORY = {};
for (const [category, skills] of Object.entries(SKILL_CATEGORIES)) {
  for (const skill of skills) {
    SKILL_TO_CATEGORY[skill] = category;
  }
}

// ─── 意图识别关键词 ───
const INTENT_KEYWORDS = {
  messaging: ['微信', 'whatsapp', 'discord', '发送', '消息', '聊天', '群', '朋友', '好友', 'contact', 'message', 'chat', 'send', 'reply'],
  browser: ['浏览器', '网页', '网站', '打开', 'chrome', 'edge', 'firefox', '搜索', 'google', 'bing', 'web', 'browse', 'url', 'link'],
  desktop: ['屏幕', '窗口', '应用', '点击', '键盘', '鼠标', '亮度', '音量', '截图', 'control', 'screen', 'window', 'app', 'brightness', 'volume'],
  memory: ['记忆', '之前', '历史', 'remember', 'memory', 'recall', 'forget'],
  voice: ['语音', '录音', '说话', '听', 'voice', 'audio', 'speak', 'listen', 'call', '通话'],
  coding: ['代码', '编程', 'git', 'github', 'repo', 'bug', 'debug', 'file', '开发', '开发'],
  productivity: ['笔记', '待办', 'todo', '任务', '日历', 'password', '密码', 'notion', 'trello', 'obsidian'],
  emotion: ['心情', '情绪', '感情', '感觉', 'happy', 'sad', 'angry', 'mood', 'emotion'],
  media: ['音乐', '图片', '照片', '视频', 'music', 'photo', 'picture', 'video', 'song'],
  smart_home: ['灯', '智能家居', 'hue', 'sonos', 'smart home'],
};

/** 根据用户消息识别意图 */
function detectIntent(message) {
  const msg = (message || '').toLowerCase();
  const scores = {};

  for (const [category, keywords] of Object.entries(INTENT_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (msg.includes(kw.toLowerCase())) {
        score++;
      }
    }
    if (score > 0) scores[category] = score;
  }

  // 返回得分最高的前2个类别
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([cat]) => cat);
}

/** 获取默认技能列表（无意图匹配时） */
function getDefaultSkills() {
  return ['coding-agent', 'memory-core', 'browser'];
}

/** 构建精简版系统提示 */
function buildLeanSystemPrompt(basePrompt, intentCategories) {
  // 移除冗余部分，只保留核心指令
  const sections = [];

  // 身份
  sections.push('# Identity');
  sections.push('AI Assistant for desktop control and automation.');

  // 核心规则（从 basePrompt 中提取）
  if (basePrompt) {
    const coreRules = extractCoreRules(basePrompt);
    if (coreRules) {
      sections.push(coreRules);
    }
  }

  // 按需加载的技能提示
  if (intentCategories.length > 0) {
    sections.push('# Active Skills');
    for (const cat of intentCategories) {
      const skills = SKILL_CATEGORIES[cat];
      if (skills) {
        sections.push(`- Domain: ${cat}`);
        sections.push(`  Skills: ${skills.join(', ')}`);
      }
    }
  }

  return sections.join('\n\n');
}

/** 从完整系统提示中提取核心规则 */
function extractCoreRules(fullPrompt) {
  // 查找 SYSTEM_RULES 或类似的核心规则部分
  const rulesPatterns = [
    /# ?SYSTEM RULES.*?(?=# |\n## |$)/gis,
    /# ?核心规则.*?(?=# |\n## |$)/gis,
    /# ?权限说明.*?(?=# |\n## |$)/gis,
    /# ?绝对禁止.*?(?=# |\n## |$)/gis,
  ];

  for (const pattern of rulesPatterns) {
    const match = fullPrompt.match(pattern);
    if (match && match[0].length > 50) {
      return match[0].substring(0, 2000); // 截断到 2KB
    }
  }

  // 如果没有匹配到，返回前 2KB
  return fullPrompt.substring(0, 2000);
}

/** 按需加载文件内容 */
function loadRelevantFiles(intentCategories) {
  const files = {};

  // 始终加载 AGENTS.md（核心指令）
  try {
    const agentsPath = path.join(CACHE_DIR, '..', 'AGENTS.md');
    if (fs.existsSync(agentsPath)) {
      files['AGENTS.md'] = fs.readFileSync(agentsPath, 'utf-8');
    }
  } catch (e) {}

  // 根据意图加载相关文件
  if (intentCategories.includes('desktop') || intentCategories.includes('browser')) {
    try {
      const capsPath = path.join(CACHE_DIR, 'capabilities.json');
      if (fs.existsSync(capsPath)) {
        const caps = JSON.parse(fs.readFileSync(capsPath, 'utf-8'));
        // 只保留关键信息，不要整个文件
        files['capabilities-summary'] = JSON.stringify({
          passed: caps.summary?.passed || 0,
          total: caps.summary?.total || 0,
          availableCommands: caps.availableCommands || [],
          unavailableCommands: caps.unavailableCommands || [],
        }, null, 2);
      }
    } catch (e) {}

    try {
      const summaryPath = path.join(CACHE_DIR, 'capabilities-summary.md');
      if (fs.existsSync(summaryPath)) {
        files['capabilities-summary-md'] = fs.readFileSync(summaryPath, 'utf-8');
      }
    } catch (e) {}
  }

  return files;
}

/** 计算上下文大小 */
function calcContextSize(systemPrompt, tools, skills, messages) {
  let total = 0;
  total += systemPrompt.length;
  total += JSON.stringify(tools || []).length;
  total += JSON.stringify(skills || []).length;
  if (messages) {
    for (const msg of messages) {
      total += msg.content ? String(msg.content).length : 0;
    }
  }
  return total;
}

/** 生成上下文报告 */
function logContextReport(before, after) {
  try {
    const report = {
      ts: new Date().toISOString(),
      before: { chars: before, tokens: Math.round(before * 0.7) },
      after: { chars: after, tokens: Math.round(after * 0.7) },
      reduction: before > 0 ? Math.round((1 - after / before) * 100) : 0,
    };
    const logDir = path.dirname(CONTEXT_LOG_PATH);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(CONTEXT_LOG_PATH, JSON.stringify(report) + '\n', 'utf-8');
  } catch (e) {}
}

// ─── 插件入口 ---
export default function createContextRouterPlugin(runtime) {
  const pluginName = 'context-router';

  console.log(`[${pluginName}] 上下文路由插件正在初始化...`);

  let originalSystemPrompt = null;
  let originalTools = null;
  let originalSkills = null;

  return {
    name: pluginName,

    /** 在系统提示构建后拦截并精简 */
    async onBeforeCompile(context) {
      if (!originalSystemPrompt) {
        originalSystemPrompt = context.systemPrompt || '';
        originalTools = context.tools || [];
        originalSkills = context.skills || [];
      }

      // 获取最后一条用户消息来识别意图
      const messages = context.messages || [];
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';

      // 识别意图
      const intents = detectIntent(lastUserMsg);
      const activeCategories = intents.length > 0 ? intents : getDefaultSkills().map(() => 'utility');

      // 加载相关文件
      const relevantFiles = loadRelevantFiles(activeCategories);

      // 构建精简系统提示
      let leanPrompt = originalSystemPrompt;

      // 如果原始提示太长，裁剪掉冗余部分
      if (leanPrompt.length > 15000) {
        leanPrompt = buildLeanSystemPrompt(leanPrompt, activeCategories);
      }

      // 附加相关文件内容
      const fileContents = Object.entries(relevantFiles)
        .map(([name, content]) => `--- ${name} ---\n${content.substring(0, 2000)}`)
        .join('\n\n');

      if (fileContents) {
        leanPrompt += '\n\n--- Relevant Files ---\n' + fileContents;
      }

      // 精简工具列表：只保留当前意图相关的工具
      let leanTools = originalTools;
      if (originalTools && originalTools.length > 10) {
        // 对于 desktop/browser 意图，只保留相关工具
        if (activeCategories.includes('desktop')) {
          leanTools = originalTools.filter(t =>
            t.name && (
              t.name.includes('exec') ||
              t.name.includes('desktop') ||
              t.name.includes('screen') ||
              t.name.includes('mouse') ||
              t.name.includes('keyboard') ||
              t.name.includes('volume') ||
              t.name.includes('brightness') ||
              t.name.includes('app') ||
              t.name.includes('cache')
            )
          );
        }
      }

      // 精简技能列表：只保留相关类别
      let leanSkills = originalSkills;
      if (originalSkills && originalSkills.length > 10) {
        const relevantSkillIds = new Set();
        for (const cat of activeCategories) {
          if (SKILL_CATEGORIES[cat]) {
            for (const skill of SKILL_CATEGORIES[cat]) {
              relevantSkillIds.add(skill);
            }
          }
        }
        // 至少保留基础技能
        for (const s of getDefaultSkills()) {
          relevantSkillIds.add(s);
        }
        leanSkills = originalSkills.filter(s => relevantSkillIds.has(s.name || s.id));
      }

      // 计算优化前后的大小
      const beforeSize = calcContextSize(originalSystemPrompt, originalTools, originalSkills, messages);
      const afterSize = calcContextSize(leanPrompt, leanTools, leanSkills, messages);

      // 记录优化报告
      logContextReport(beforeSize, afterSize);

      console.log(`[${pluginName}] 上下文优化: ${Math.round(beforeSize/1024)}KB → ${Math.round(afterSize/1024)}KB (${Math.round((1-afterSize/beforeSize)*100)}% 减少)`);

      // 返回精简后的上下文
      return {
        ...context,
        systemPrompt: leanPrompt,
        tools: leanTools,
        skills: leanSkills,
      };
    },

    /** 提供手动触发上下文优化的方法 */
    async optimizeContext(context) {
      return this.onBeforeCompile(context);
    },

    /** 获取当前优化统计 */
    getStats() {
      try {
        const logLines = fs.readFileSync(CONTEXT_LOG_PATH, 'utf-8').split('\n').filter(Boolean);
        const stats = {
          totalOptimizations: logLines.length,
          avgReduction: 0,
          totalSaved: 0,
        };
        if (logLines.length > 0) {
          const reductions = logLines.map(l => {
            try { return JSON.parse(l).reduction; } catch { return 0; }
          });
          stats.avgReduction = Math.round(reductions.reduce((a, b) => a + b, 0) / reductions.length);
          stats.totalSaved = reductions.reduce((a, b) => a + b, 0);
        }
        return stats;
      } catch {
        return { totalOptimizations: 0, avgReduction: 0 };
      }
    },
  };
}
