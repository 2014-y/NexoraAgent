/**
 * 每日自动总结插件 v3
 *
 * - 每 N 轮对话后写一次 MEMORY.md
 * - LLM 可用时生成结构化总结；不可用时写入轻量兜底摘要，保证开箱仍生效
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PLUGIN_NAME = 'auto-summary';
const HOME = os.homedir();
const MEMORY_FILE = path.join(HOME, '.openclaw', 'workspace', 'MEMORY.md');
const LEARNING_DATA = path.join(HOME, 'glm4_finetune', 'learning_data', 'learning_log.jsonl');
const MEMORY_DIR = path.join(HOME, '.openclaw', 'workspace', 'memory');
const SUMMARIZE_EVERY = 10;
let conversationCount = 0;

export default function createPlugin(runtime) {
  console.log(`[${PLUGIN_NAME}] 📅 长期记忆·自动摘要已加载`);

  function readMemoryFile(dateStr) {
    try {
      const fp = path.join(MEMORY_DIR, `${dateStr}.md`);
      if (fs.existsSync(fp)) return fs.readFileSync(fp, 'utf-8');
    } catch {}
    return '';
  }

  function readRecentMemories(days) {
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      const c = readMemoryFile(ds);
      if (c) out.push(`## ${ds}\n${c}`);
    }
    return out.join('\n\n---\n\n');
  }

  function readTrainingData(count = 10) {
    try {
      if (!fs.existsSync(LEARNING_DATA)) return '';
      const lines = fs.readFileSync(LEARNING_DATA, 'utf-8').split('\n').filter(l => l.trim());
      const recent = lines.slice(-count);
      return recent.map(l => {
        try {
          const r = JSON.parse(l);
          return `问题: ${r.question}\n老师: ${r.teacherAnswer || '(无)'}\n学生: ${r.studentAnswer || '(无)'}\n模式: ${r.mode}`;
        } catch { return l; }
      }).join('\n\n---\n\n');
    } catch { return ''; }
  }

  function readCurrentMemory() {
    try {
      if (fs.existsSync(MEMORY_FILE)) return fs.readFileSync(MEMORY_FILE, 'utf-8');
    } catch {}
    return '';
  }

  function buildPrompt(memories, training, currentMem) {
    return `你是AI助手的记忆整理系统。请对以下内容进行结构化总结：

## 近期聊天记录（最近3天）
${memories || '(无)'}

## 教学训练数据（最近10条）
${training || '(无)'}

## 当前长期记忆
${currentMem || '(无)'}

## 任务
生成一份简洁的每日总结，包含：
1. 今日重点对话摘要（3-5条）
2. 用户偏好更新
3. 学习收获
4. 待办/提醒

要求：每条3行以内，用中文，不重复已有内容。`;
  }

  function appendSummary(summary) {
    try {
      const dir = path.dirname(MEMORY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(MEMORY_FILE)) fs.writeFileSync(MEMORY_FILE, '# MEMORY.md\n\n', 'utf-8');
      const dateStr = new Date().toISOString().split('T')[0];
      const header = `\n---\n## ${dateStr} 自动总结\n\n${summary}\n`;
      fs.appendFileSync(MEMORY_FILE, header, 'utf-8');
      console.log(`[${PLUGIN_NAME}] ✅ 总结已写入 MEMORY.md`);
    } catch (e) {
      console.error(`[${PLUGIN_NAME}] ❌ 写入失败: ${e.message}`);
    }
  }

  function buildFallbackSummary(memories, training, context) {
    const bits = [];
    bits.push('- 本轮自动摘要：LLM 不可用，已写入轻量兜底记录（长期记忆链路仍生效）。');
    if (context?.sessionFile) bits.push(`- 会话文件: ${path.basename(String(context.sessionFile))}`);
    if (memories) bits.push('- 近3天会话日志：已检测到本地 memory/*.md 内容。');
    if (training) bits.push('- 训练日志：已检测到 learning_log.jsonl 近期条目。');
    if (!memories && !training) bits.push('- 暂无额外会话/训练素材，仅记录心跳摘要。');
    return bits.join('\n');
  }

  function resolveSummaryModel() {
    try {
      const cfg = runtime?.config || runtime?.cfg || {};
      const primary = cfg?.agents?.defaults?.model?.primary;
      if (typeof primary === 'string' && primary.trim()) return primary.trim();
    } catch {}
    // 不再硬编码 yitong：别人电脑未必有该供应商
    return null;
  }

  async function runSummary(context) {
    console.log(`[${PLUGIN_NAME}] 🔄 开始自动总结...`);
    try {
      const memories = readRecentMemories(3);
      const training = readTrainingData(10);
      const currentMem = readCurrentMemory();
      const prompt = buildPrompt(memories, training, currentMem);
      const messages = [
        { role: 'system', content: '你是AI助手的记忆整理系统。请将聊天记录和训练数据归纳为结构化的每日总结。只输出总结内容。' },
        { role: 'user', content: prompt },
      ];

      let summary = '';
      const model = resolveSummaryModel();
      try {
        if (runtime?.llm?.complete && model) {
          const result = await runtime.llm.complete({ model, messages, maxTokens: 2048 });
          summary = result?.content || result?.text || '';
        } else if (runtime?.llm?.complete) {
          const result = await runtime.llm.complete({ messages, maxTokens: 2048 });
          summary = result?.content || result?.text || '';
        }
      } catch (llmErr) {
        console.warn(`[${PLUGIN_NAME}] LLM 总结失败，改用兜底:`, llmErr?.message || llmErr);
      }

      if (!summary || /总结生成失败/.test(summary)) {
        summary = buildFallbackSummary(memories, training, context);
      }
      appendSummary(summary);
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] ❌ 总结异常: ${error?.message || String(error)}`);
      try {
        appendSummary(buildFallbackSummary('', '', context));
      } catch {}
    }
  }

  return {
    name: PLUGIN_NAME,

    async onAfterResponse(context) {
      conversationCount++;
      if (conversationCount >= SUMMARIZE_EVERY) {
        conversationCount = 0;
        await runSummary(context);
      }
    },

    async onShutdown() {
      console.log(`[${PLUGIN_NAME}] 📊 对话轮数: ${conversationCount}`);
    },
  };
}
