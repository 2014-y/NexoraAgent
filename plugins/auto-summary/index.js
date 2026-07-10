/**
 * 每日自动总结插件 v2
 * 
 * 利用 onAfterResponse 钩子，每次对话结束后自动触发总结。
 * 当累积一定数量的对话后，用老师模型生成结构化总结写入 MEMORY.md。
 */

import fs from 'node:fs';

const PLUGIN_NAME = 'auto-summary';
const SUMMARY_MODEL = 'yitong/qwen3-max';
const MEMORY_FILE = '$env:USERPROFILE\\.openclaw\\workspace\\MEMORY.md';
const LEARNING_DATA = '$env:USERPROFILE\\glm4_finetune\\learning_data\\learning_log.jsonl';
const MEMORY_DIR = '$env:USERPROFILE\\.openclaw\\workspace\\memory';
const SUMMARIZE_EVERY = 10; // 每10轮对话触发一次总结
let conversationCount = 0;

export default function createPlugin(runtime) {
  console.log(`[${PLUGIN_NAME}] 📅 每日自动总结插件已加载`);

  /** 读取 memory 日志 */
  function readMemoryFile(dateStr) {
    try {
      const fp = `${MEMORY_DIR}\\${dateStr}.md`;
      if (fs.existsSync(fp)) return fs.readFileSync(fp, 'utf-8');
    } catch {}
    return '';
  }

  /** 读取最近 N 天的 memory */
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

  /** 读取训练数据 */
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

  /** 读取当前 MEMORY.md */
  function readCurrentMemory() {
    try {
      if (fs.existsSync(MEMORY_FILE)) return fs.readFileSync(MEMORY_FILE, 'utf-8');
    } catch {}
    return '';
  }

  /** 构建总结提示词 */
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

  /** 写入总结 */
  function appendSummary(summary) {
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const header = `\n---\n## ${dateStr} 自动总结\n\n${summary}`;
      fs.appendFileSync(MEMORY_FILE, header, 'utf-8');
      console.log(`[${PLUGIN_NAME}] ✅ 总结已写入 MEMORY.md`);
    } catch (e) {
      console.error(`[${PLUGIN_NAME}] ❌ 写入失败: ${e.message}`);
    }
  }

  /** 核心：执行总结 */
  async function runSummary() {
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

      let result;
      if (runtime?.llm) {
        result = await runtime.llm.complete({ model: SUMMARY_MODEL, messages, maxTokens: 4096 });
      }

      const summary = result?.content || result?.text || '（总结生成失败）';
      appendSummary(summary);
    } catch (error) {
      console.error(`[${PLUGIN_NAME}] ❌ 总结异常: ${error?.message || String(error)}`);
    }
  }

  return {
    name: PLUGIN_NAME,

    /** 每10轮对话触发一次自动总结 */
    async onAfterResponse(context) {
      conversationCount++;
      if (conversationCount >= SUMMARIZE_EVERY) {
        conversationCount = 0;
        await runSummary();
      }
    },

    /** 插件卸载时输出统计 */
    async onShutdown() {
      console.log(`[${PLUGIN_NAME}] 📊 对话轮数: ${conversationCount}`);
    },
  };
}
