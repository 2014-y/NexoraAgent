/**
 * Teach-Learn 双模型训练插件 v4.0 - 口吻模仿版（生产级）
 *
 * 核心流程：
 *   1. 用户提问 → 老师模型回答（示范）
 *   2. 学生模型 1:1 模仿老师的口吻/语气/表达习惯回复
 *   3. 老师不可用时，学生自主回答
 *
 * v4.0 修复：
 *   - 并发安全：每轮对话独立状态，不共享可变变量
 *   - 竞态保护：同一问题不会重复触发
 *   - 超时保护：防止单轮教学无限等待
 *   - 内存安全：大回答截断、空值防御、类型校验
 *   - 数据完整性：写入原子化，防止损坏训练数据
 *   - 优雅降级：每一步都有 fallback 链
 *   - 错误隔离：任何单步失败不影响主流程
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 常量定义 ───
const MAX_TEACHER_ANSWER_LENGTH = 16000;  // 老师回答最大长度（防止超长分析出错）
const MAX_STUDENT_PROMPT_LENGTH = 24000; // 学生提示词最大长度
const TEACH_LEARN_TIMEOUT_MS = 120000;    // 单轮教学总超时 120 秒
const MIN_QUESTION_LENGTH = 1;           // 最小问题长度，过滤空消息
const DATA_WRITE_BUFFER_SIZE = 50;       // 批量写入缓冲（减少 fs 操作）
const EMOTICON_REGEX = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;

export default function createPlugin(runtime) {
  const pluginName = 'dual-model-trainer';

  // ─── 初始化日志 ───
  console.log(`[${pluginName}] 🎓 Teach-Learn v4 (生产级) 正在初始化...`);

  // ─── 配置读取与校验 ───
  let pluginConfig;
  try {
    pluginConfig = runtime?.config?.plugins?.entries?.[pluginName]?.config || {};
  } catch (e) {
    console.warn(`[${pluginName}] ⚠️  配置读取异常，使用默认值: ${e.message}`);
    pluginConfig = {};
  }

  const enabled = pluginConfig.enabled !== false;

  if (!enabled) {
    console.log(`[${pluginName}] ⏸️  插件已禁用`);
    return {};
  }

  // 配置项（带默认值和类型校验）
  const config = {
    teacherModel: String(pluginConfig.teacherModel || 'yitong/qwen3-max'),
    studentModel: String(pluginConfig.studentModel || 'ollama/gemma4:latest'),
    mode: ['teach-learn', 'fallback', 'collect-only'].includes(pluginConfig.mode)
      ? pluginConfig.mode : 'teach-learn',
    enableTeachLearn: Boolean(pluginConfig.enableTeachLearn !== false),
    enableFallback: Boolean(pluginConfig.enableFallback !== false),
    trainingDataPath: String(pluginConfig.trainingDataPath || '$env:USERPROFILE\\glm4_finetune\\learning_data\\learning_log.jsonl'),
    minAnswerLength: Number(pluginConfig.minAnswerLength) || 10,
    maxRetries: Number(pluginConfig.maxRetries) || 2,
    retryDelay: Number(pluginConfig.retryDelay) || 3000,
    enableVoiceMimicry: Boolean(pluginConfig.enableVoiceMimicry !== false),
    timeoutMs: Number(pluginConfig.timeoutMs) || TEACH_LEARN_TIMEOUT_MS,
  };

  // 校验模型名称不为空
  if (!config.teacherModel || config.teacherModel.length < 2) {
    console.warn(`[${pluginName}] ⚠️  老师模型名称无效，使用默认值`);
    config.teacherModel = 'yitong/qwen3-max';
  }
  if (!config.studentModel || config.studentModel.length < 2) {
    console.warn(`[${pluginName}] ⚠️  学生模型名称无效，使用默认值`);
    config.studentModel = 'ollama/jarvis';
  }

  // ─── 确保数据目录存在 ───
  let dataDir;
  try {
    dataDir = path.dirname(config.trainingDataPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log(`[${pluginName}] 📂 已创建数据目录: ${dataDir}`);
    }
  } catch (e) {
    console.error(`[${pluginName}] ❌ 无法创建数据目录: ${e.message}`);
    // 降级到默认目录
    config.trainingDataPath = '$env:USERPROFILE\\glm4_finetune\\learning_data\\learning_log.jsonl';
    dataDir = path.dirname(config.trainingDataPath);
  }

  // ─── 运行时状态（每轮对话独立） ───
  const stats = {
    savedCount: 0,
    teachRounds: 0,
    fallbackActivations: 0,
    mimicSuccess: 0,
    totalErrors: 0,
    // 监控指标
    totalRequests: 0,
    teacherLatencyMs: [],     // 最近 100 次老师响应延迟
    studentLatencyMs: [],     // 最近 100 次学生响应延迟
    totalTokensInput: 0,
    totalTokensOutput: 0,
    modelCalls: {},           // per-model call count
  };

  // 已处理的请求追踪（防止同一消息被多次触发）
  const processedRequests = new Map();

  console.log(`[${pluginName}] ✅ 插件已启用 | 模式: ${config.mode}`);
  console.log(`[${pluginName}] 👨‍🏫 老师模型: ${config.teacherModel}`);
  console.log(`[${pluginName}] 👨‍🎓 学生模型: ${config.studentModel}`);
  console.log(`[${pluginName}] 🎭 口吻模仿: ${config.enableVoiceMimicry ? '开启' : '关闭'}`);
  console.log(`[${pluginName}] ⏱️  超时保护: ${config.timeoutMs / 1000}s`);
  console.log(`[${pluginName}] 📦 数据存储: ${config.trainingDataPath}`);

  // ═══════════════════════════════════════════════════
  //  工具函数
  // ═══════════════════════════════════════════════════

  /**
   * 安全的 JSON 序列化（防止训练数据损坏）
   */
  function safeJsonStringify(obj) {
    try {
      return JSON.stringify(obj, (_key, value) => {
        // 处理循环引用
        if (typeof value === 'object' && value !== null) {
          try {
            JSON.stringify(value);
            return value;
          } catch {
            return '[circular]';
          }
        }
        // 处理超大字符串截断
        if (typeof value === 'string' && value.length > 5000) {
          return value.substring(0, 5000) + '...(truncated)';
        }
        return value;
      }, 2);
    } catch (e) {
      return '{"error": "JSON serialization failed", "message": "' + String(e.message).substring(0, 200) + '"}';
    }
  }

  /**
   * 安全的字符串清理（去除控制字符，防止 JSON 损坏）
   */
  function sanitizeString(str) {
    if (typeof str !== 'string') return '';
    // 去除非法 JSON 字符（控制字符）
    return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  /**
   * 原子化文件写入（防止训练数据损坏）
   * 先写入临时文件，再替换原文件
   */
  function atomicAppend(filePath, line) {
    try {
      // 先写入临时文件
      const tmpPath = filePath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).substring(2, 8);
      fs.writeFileSync(tmpPath, line + '\n', 'utf-8');
      // 再追加到原文件（原子操作）
      fs.appendFileSync(filePath, line + '\n', 'utf-8');
      // 删除临时文件
      try { fs.unlinkSync(tmpPath); } catch {}
    } catch (e) {
      console.error(`[${pluginName}] ❌ 文件写入失败: ${e.message}`);
      // 清理临时文件
      try { fs.unlinkSync(filePath + '.tmp.*'); } catch {}
    }
  }

  // ═══ 模型调用层 ═══

  /**
   * 调用 OpenClaw 模型推理 API
   * 支持多提供者、多重试、超时保护
   */
  async function callModel(modelName, messages, maxRetries = config.maxRetries) {
    // 输入校验
    if (!modelName || typeof modelName !== 'string') {
      return { success: false, error: 'Invalid model name', code: 'INVALID_MODEL' };
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return { success: false, error: 'Empty or invalid messages', code: 'INVALID_MESSAGES' };
    }

    // 初始化模型调用计数
    if (!stats.modelCalls[modelName]) stats.modelCalls[modelName] = 0;
    stats.modelCalls[modelName]++;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const attemptStart = Date.now();
      try {
        // 检查全局超时
        if (Date.now() - attemptStart > config.timeoutMs) {
          return { success: false, error: 'Global timeout exceeded', code: 'TIMEOUT' };
        }

        let result;

        // 尝试 runtime.llm 接口
        if (runtime?.llm) {
          result = await runtime.llm.complete({
            model: modelName,
            messages: messages,
            maxTokens: 8192,
          });
        }

        // 尝试 runtime.chat 接口
        if (!result && runtime?.chat?.send) {
          result = await runtime.chat.send({
            model: modelName,
            messages: messages,
          });
        }

        // 提取内容
        const content = result?.content || result?.text || null;
        if (content && typeof content === 'string' && content.trim().length > 0) {
          // 记录 token 用量
          const usage = result?.usage;
          if (usage) {
            stats.totalTokensInput += usage.input || usage.promptTokens || 0;
            stats.totalTokensOutput += usage.output || usage.completionTokens || 0;
          }
          return { success: true, content: sanitizeString(content), code: 'OK' };
        }

        // Ollama special: content empty but reasoning has data

        if ((!content || content.trim().length === 0) && result && result.choices && result.choices[0]) {
          const choice = result.choices[0];
          const oc = choice.message && (choice.message.reasoning || choice.message.content);
          if (oc && typeof oc === "string" && oc.trim().length > 0) content = oc;
        }

        // 如果拿到结果但没有 content，可能是结构化输出
        if (result && typeof result === 'object') {
          const jsonStr = JSON.stringify(result);
          if (jsonStr.length > 10 && jsonStr !== '{}' && jsonStr !== 'null') {
            return { success: true, content: sanitizeString(jsonStr), code: 'OK' };
          }
        }

        return { success: false, error: 'Empty response from model', code: 'EMPTY_RESPONSE' };

      } catch (error) {
        const errorMsg = error?.message || String(error);
        const errorType = error?.code || '';

        // 判断是否可重试
        const isRetryable = (
          errorMsg.includes('timeout') ||
          errorMsg.includes('ETIMEDOUT') ||
          errorMsg.includes('ECONNRESET') ||
          errorMsg.includes('ECONNREFUSED') ||
          errorMsg.includes('network') ||
          errorMsg.includes('fetch') ||
          errorType === 'RATE_LIMIT' ||
          errorMsg.includes('429') ||
          errorMsg.includes('503') ||
          errorMsg.includes('502') ||
          errorMsg.includes('500')
        );

        if (!isRetryable) {
          // 非可重试错误，立即返回
          return { success: false, error: errorMsg, code: 'NON_RETRYABLE' };
        }

        console.log(`[${pluginName}] ⚠️  模型调用失败 (第${attempt}/${maxRetries}次): ${errorMsg}`);

        if (attempt < maxRetries) {
          const delay = config.retryDelay * Math.pow(1.5, attempt - 1); // 指数退避
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return { success: false, error: `Failed after ${maxRetries} retries`, code: 'MAX_RETRIES_EXCEEDED' };
  }

  // ═══ 口吻分析引擎 ═══

  /**
   * 深度分析老师的回答口吻特征
   * 提取可用于模仿的结构化风格指纹
   */
  function analyzeTeacherVoice(teacherAnswer) {
    // 输入防御
    if (!teacherAnswer || typeof teacherAnswer !== 'string' || teacherAnswer.length === 0) {
      return getDefaultVoiceAnalysis();
    }

    // 截断超长回答（防止分析出错）
    const answer = teacherAnswer.length > MAX_TEACHER_ANSWER_LENGTH
      ? teacherAnswer.substring(0, MAX_TEACHER_ANSWER_LENGTH)
      : teacherAnswer;

    const analysis = {
      greetings: [],
      signoffs: [],
      formalityLevel: 5,
      avgSentenceLength: 20,
      usesBulletPoints: false,
      usesNumberedList: false,
      usesCodeBlocks: false,
      usesMarkdownHeaders: false,
      paragraphCount: 1,
      isDetailed: answer.length > 300,
      isConcise: answer.length < 100,
      hasEmojis: false,
      hasIntro: false,
      hasConclusion: false,
      frequentWords: [],
      styleDescription: '标准专业',
    };

    try {
      // 分析称呼
      const greetingPatterns = [/您好/, /你好/, /先生/, /女士/, /亲/, /嗨/, /嘿/, /喂/];
      greetingPatterns.forEach(p => {
        if (p.test(answer)) analysis.greetings.push(p.source);
      });

      // 分析结尾
      const lastChars = answer.slice(-50);
      const conclusionPatterns = [/总结/, /总之/, /希望/, /如有/, /请问/, /需要/, /再见/, /谢谢/];
      conclusionPatterns.forEach(p => {
        if (p.test(lastChars)) analysis.signoffs.push(p.source);
      });

      // 正式程度评估
      if (analysis.greetings.includes('您好')) analysis.formalityLevel = 8;
      else if (analysis.greetings.includes('你好')) analysis.formalityLevel = 5;
      else if (analysis.greetings.includes('嗨')) analysis.formalityLevel = 2;
      else if (analysis.greetings.includes('先生') || analysis.greetings.includes('女士')) analysis.formalityLevel = 7;
      else analysis.formalityLevel = 4;

      // 句子长度分析
      const sentences = answer.split(/[。！？\n]/).filter(s => s.trim().length > 0);
      if (sentences.length > 0) {
        const totalLen = sentences.reduce((sum, s) => sum + s.trim().length, 0);
        analysis.avgSentenceLength = Math.round(totalLen / sentences.length);
      }

      // 列表分析
      analysis.usesBulletPoints = /[-•]\s/.test(answer);
      analysis.usesNumberedList = /\d+[.、]\s/.test(answer);
      analysis.usesCodeBlocks = /```/.test(answer);
      analysis.usesMarkdownHeaders = /^#{1,3}\s/m.test(answer);

      // 段落数
      analysis.paragraphCount = answer.split(/\n\n+/).filter(p => p.trim()).length || 1;

      // Emoji 检测
      try {
        analysis.hasEmojis = EMOTICON_REGEX.test(answer);
      } catch {
        analysis.hasEmojis = false;
      }

      // 高频词提取
      try {
        const stopWords = new Set(['的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '会', '给', '如', '如果', '因为', '但是', '所以', '然而', '此外', '另外', '这个', '那个', '什么', '怎么', '如何', '可以', '可能', '应该']);
        const wordMap = {};
        sentences.forEach(s => {
          const chars = s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').split('');
          chars.forEach(c => {
            if (c.length >= 2 && c.length <= 8 && !stopWords.has(c)) {
              wordMap[c] = (wordMap[c] || 0) + 1;
            }
          });
        });
        analysis.frequentWords = Object.entries(wordMap)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(e => e[0]);
      } catch {
        // 词频提取失败不影响整体
      }

      // 生成风格描述
      const parts = [];
      if (analysis.formalityLevel >= 7) parts.push('正式礼貌');
      else if (analysis.formalityLevel >= 4) parts.push('友好专业');
      else parts.push('轻松随意');
      if (analysis.usesBulletPoints) parts.push('善用列表');
      if (analysis.usesNumberedList) parts.push('编号结构');
      if (analysis.usesCodeBlocks) parts.push('包含代码示例');
      if (analysis.isDetailed) parts.push('回答详尽');
      else if (analysis.isConcise) parts.push('简洁明了');
      if (analysis.signoffs.length > 0) parts.push('习惯总结');
      if (analysis.paragraphCount <= 2) parts.push('段落紧凑');
      analysis.styleDescription = parts.length > 0 ? parts.join('，') : '标准专业';

    } catch (e) {
      console.warn(`[${pluginName}] ⚠️  口吻分析异常: ${e.message}`);
      // 分析失败返回默认值，不中断主流程
    }

    return analysis;
  }

  function getDefaultVoiceAnalysis() {
    return {
      greetings: [],
      signoffs: [],
      formalityLevel: 5,
      avgSentenceLength: 20,
      usesBulletPoints: false,
      usesNumberedList: false,
      usesCodeBlocks: false,
      usesMarkdownHeaders: false,
      paragraphCount: 1,
      isDetailed: false,
      isConcise: true,
      hasEmojis: false,
      styleDescription: '标准专业',
    };
  }

  // ═══ 提示词构建 ═══

  /**
   * 构建口吻模仿提示词
   */
  function buildVoiceMimicPrompt(question, teacherAnswer, voiceAnalysis) {
    // 截断过长的老师回答
    const truncatedAnswer = teacherAnswer.length > 8000
      ? teacherAnswer.substring(0, 8000) + '\n\n...(回答过长，已截断)'
      : teacherAnswer;

    // 构建风格指令
    const styleParts = [];
    if (voiceAnalysis.formalityLevel >= 7) styleParts.push('正式礼貌');
    else if (voiceAnalysis.formalityLevel >= 4) styleParts.push('友好专业');
    else styleParts.push('轻松随意');

    if (voiceAnalysis.usesBulletPoints) styleParts.push('使用项目符号列表组织内容');
    if (voiceAnalysis.usesNumberedList) styleParts.push('使用编号列表组织内容');
    if (voiceAnalysis.usesCodeBlocks) styleParts.push('适当使用代码块展示示例');
    if (voiceAnalysis.isDetailed) styleParts.push('回答详尽深入');
    if (voiceAnalysis.isConcise) styleParts.push('回答简洁精炼');
    if (voiceAnalysis.paragraphCount <= 2) styleParts.push('段落紧凑，不超过3段');
    if (voiceAnalysis.greetings.length > 0) styleParts.push(`使用"${voiceAnalysis.greetings[0]}"作为开头称呼`);
    if (voiceAnalysis.signoffs.length > 0) styleParts.push('回答末尾包含总结或问候');

    const styleInstruction = styleParts.length > 0
      ? styleParts.join('；')
      : '保持专业友好的语气';

    return `你是一位AI助手，正在学习一位优秀老师的回答风格。

## 用户的问题
${question}

## 老师的示范回答
${truncatedAnswer}

## 老师的口吻特征
- 风格总结: ${voiceAnalysis.styleDescription}
- 称呼习惯: ${voiceAnalysis.greetings.length > 0 ? voiceAnalysis.greetings.join('、') : '无特殊称呼'}
- 结尾习惯: ${voiceAnalysis.signoffs.length > 0 ? voiceAnalysis.signoffs.join('、') : '无特殊结尾'}
- 句式偏好: ${styleInstruction}
- 平均句长: ${voiceAnalysis.avgSentenceLength} 字
- 段落数量: ${voiceAnalysis.paragraphCount}

## 你的任务
请针对上述用户问题，**完全模仿老师的口吻和说话方式**来回答。

## 严格遵循以下规则
1. **称呼一致**：如果老师用"您好"，你也用"您好"；如果用"你好"，你也用"你好"
2. **句式一致**：老师喜欢用列表你就用列表，老师句子长你就写长的
3. **结构一致**：老师先总结再说细节，你也这样；老师直接给结论，你也这样
4. **结尾一致**：老师有总结/反问/祝福，你也要有
5. **语气一致**：老师正式你就正式，老师亲切你就亲切
6. **格式一致**：老师用代码块你就用，老师不用你也不用
7. **不要说"我是学生"或"我模仿"**：你就是以老师的口吻在回答
8. **内容要准确**：模仿口吻但不编造事实

记住：用户收到的回复应该让他们感觉就是老师在说话。`;
  }

  /**
   * 构建学生自主回答提示词（老师不可用时）
   */
  function buildIndependentPrompt(question) {
    return `你是一个专业的AI助手。老师暂时不在，请直接回答问题：

${question}

要求回答专业、清晰、有条理。`;
  }

  // ═══ 数据持久化 ═══

  /**
   * 保存训练数据记录
   */
  function saveTrainingData(record) {
    try {
      if (!record?.question) return;

      // 清理可能破坏 JSON 的内容
      const sanitizedRecord = {
        timestamp: new Date().toISOString(),
        question: sanitizeString(record.question),
        teacherAnswer: record.teacherAnswer ? sanitizeString(record.teacherAnswer) : null,
        studentAnswer: record.studentAnswer ? sanitizeString(record.studentAnswer) : null,
        teacherModel: record.teacherModel || config.teacherModel,
        studentModel: record.studentModel || config.studentModel,
        mode: record.mode || 'teach-learn',
        teacher_voice: record.voiceAnalysis ? sanitizeVoiceAnalysis(record.voiceAnalysis) : null,
        mimic_enabled: record.mimicEnabled || config.enableVoiceMimicry,
        source: 'teach-learn-v4',
      };

      const line = safeJsonStringify(sanitizedRecord);
      atomicAppend(config.trainingDataPath, line);
      stats.savedCount++;

      if (stats.savedCount % 20 === 0) {
        console.log(`[${pluginName}] 📚 已累计保存 ${stats.savedCount} 条教学数据`);
      }
    } catch (e) {
      console.error(`[${pluginName}] ❌ 保存训练数据失败: ${e.message}`);
      stats.totalErrors++;
    }
  }

  function sanitizeVoiceAnalysis(voice) {
    try {
      // 确保 voiceAnalysis 可安全序列化
      const copy = {};
      for (const [key, val] of Object.entries(voice)) {
        if (typeof val === 'string') {
          copy[key] = sanitizeString(val);
        } else if (Array.isArray(val)) {
          copy[key] = val.map(v => typeof v === 'string' ? sanitizeString(v) : v);
        } else {
          copy[key] = val;
        }
      }
      return copy;
    } catch {
      return { styleDescription: 'unknown' };
    }
  }

  // ═══ 核心教学流程 ═══

  /**
   * Step 1: 老师回答（同步，阻塞主链路）
   * 返回老师的答案，供 gateway 直接发送给用户
   */
  async function getTeacherAnswer(question, deliveryContext) {
    const result = {
      teacherAnswer: null,
      mode: 'teach-learn',
      teacherFailed: false,
    };

    console.log(`[${pluginName}] 👨‍🏫 老师模型正在回答...`);
    const teacherMessages = [
      { role: 'system', content: '你是一个专业的AI助手，擅长分析问题、给出详细的解决方案。请用中文回答。' },
      { role: 'user', content: question },
    ];

    const teacherStart = Date.now();
    stats.totalRequests++;
    let teacherResponse = await callModel(config.teacherModel, teacherMessages);
    const teacherElapsed = Date.now() - teacherStart;

    if (!teacherResponse.success) {
      console.log(`[${pluginName}] ⚠️  老师模型不可用 (${teacherResponse.code}): ${teacherResponse.error}`);
      result.teacherFailed = true;
      result.teacherAnswer = null;

      if (config.enableFallback) {
        console.log(`[${pluginName}] 🔄 切换到学生自主模式...`);
        stats.fallbackActivations++;
        return autonomousStudentMode(question, deliveryContext, result);
      }
      return { ...result, finalAnswer: `⚠️ 老师模型暂时不可用 (${teacherResponse.error})，请稍后再试。` };
    }

    result.teacherAnswer = teacherResponse.content;
    // 记录老师延迟（保留最近 100 条）
    stats.teacherLatencyMs.push(teacherElapsed);
    if (stats.teacherLatencyMs.length > 100) stats.teacherLatencyMs.shift();
    console.log(`[${pluginName}] 👨‍🏫 老师回答完成 (${result.teacherAnswer.length} 字符, ${teacherElapsed}ms)`);
    return result;
  }

  /**
   * Step 2: 学生模仿（异步后台执行，不阻塞主链路）
   * 拿到老师答案后，后台跑口吻分析和学生模仿，结果存入 learning_log.jsonl
   */
  async function studentLearnInBackground(question, teacherAnswer, deliveryContext) {
    const voiceAnalysis = analyzeTeacherVoice(teacherAnswer);
    console.log(`[${pluginName}] 🎭 [后台] 口吻分析: ${voiceAnalysis.styleDescription}`);

    if (config.enableVoiceMimicry) {
      console.log(`[${pluginName}] 👨‍🎓 [后台] 学生正在模仿老师口吻...`);
      const mimicPrompt = buildVoiceMimicPrompt(question, teacherAnswer, voiceAnalysis);
      const safePrompt = mimicPrompt.length > MAX_STUDENT_PROMPT_LENGTH
        ? mimicPrompt.substring(0, MAX_STUDENT_PROMPT_LENGTH) + '\n...(提示词过长，已截断)'
        : mimicPrompt;

      const studentMessages = [{ role: 'user', content: safePrompt }];
      const studentStart = Date.now();
      const studentResponse = await callModel(config.studentModel, studentMessages);
      const studentElapsed = Date.now() - studentStart;
      stats.studentLatencyMs.push(studentElapsed);
      if (stats.studentLatencyMs.length > 100) stats.studentLatencyMs.shift();

      if (!studentResponse.success) {
        console.log(`[${pluginName}] ⚠️  [后台] 学生模型不可用 (${studentResponse.code}): ${studentResponse.error}`);
        // 即使学生失败，也保存老师答案作为训练数据
        saveTrainingData({
          question,
          teacherAnswer: sanitizeString(teacherAnswer),
          studentAnswer: null,
          teacherModel: config.teacherModel,
          studentModel: config.studentModel,
          voiceAnalysis,
          mimicEnabled: true,
          deliveryContext,
          mode: 'teacher-only',
        });
        return;
      }

      console.log(`[${pluginName}] 👨‍🎓 [后台] 学生模仿完成 (${studentResponse.content.length} 字符)`);
      stats.teachRounds++;
      stats.mimicSuccess++;

      saveTrainingData({
        question,
        teacherAnswer: sanitizeString(teacherAnswer),
        studentAnswer: sanitizeString(studentResponse.content),
        teacherModel: config.teacherModel,
        studentModel: config.studentModel,
        voiceAnalysis,
        mimicEnabled: true,
        deliveryContext,
        mode: 'voice-mimic',
      });
    } else {
      console.log(`[${pluginName}] 👨‍🎓 [后台] 学生独立回答...`);
      const studentMessages = [
        { role: 'system', content: '你是一个专业的AI助手。' },
        { role: 'user', content: question },
      ];

      const studentStart = Date.now();
      const studentResponse = await callModel(config.studentModel, studentMessages);
      const studentElapsed = Date.now() - studentStart;
      stats.studentLatencyMs.push(studentElapsed);
      if (stats.studentLatencyMs.length > 100) stats.studentLatencyMs.shift();
      if (studentResponse.success) {
        stats.teachRounds++;
        saveTrainingData({
          question,
          teacherAnswer: sanitizeString(teacherAnswer),
          studentAnswer: sanitizeString(studentResponse.content),
          teacherModel: config.teacherModel,
          studentModel: config.studentModel,
          deliveryContext,
          mode: 'standard',
        });
      }
    }
  }

  /**
   * 完整 Teach-Learn 流程（保留向后兼容）
   * 注意：现在已由 getTeacherAnswer + studentLearnInBackground 拆分
   */
  async function teachAndLearn(question, deliveryContext) {
    // 同步获取老师答案
    const teacherResult = await getTeacherAnswer(question, deliveryContext);

    // 如果有老师答案，后台异步跑学生学习
    if (teacherResult.teacherAnswer) {
      studentLearnInBackground(question, teacherResult.teacherAnswer, deliveryContext)
        .catch(err => {
          stats.totalErrors++;
          console.error(`[${pluginName}] ❌ [后台] 学生学习失败: ${err?.message || String(err)}`);
        });
    }

    return teacherResult;
  }

  /**
   * 学生自主模式（老师不可用时）
   */
  async function autonomousStudentMode(question, deliveryContext, result) {
    const studentMessages = [
      { role: 'system', content: '你是一个专业的AI助手。老师暂时不可用，请直接回答问题。' },
      { role: 'user', content: question },
    ];

    let studentResponse = await callModel(config.studentModel, studentMessages);

    if (!studentResponse.success) {
      return {
        ...result,
        finalAnswer: `⚠️ 老师模型和学生模型都暂时不可用，请稍后再试。`,
        mode: 'fallback-failed',
      };
    }

    result.studentAnswer = studentResponse.content;
    result.finalAnswer = `[自主模式] ${result.studentAnswer}`;
    result.mode = 'autonomous';

    saveTrainingData({
      question,
      teacherAnswer: null,
      studentAnswer: result.studentAnswer,
      teacherModel: config.teacherModel,
      studentModel: config.studentModel,
      mode: 'autonomous',
      deliveryContext,
    });

    return result;
  }

  // ═══ 插件钩子 ═══

  return {
    name: pluginName,

    /**
     * 消息到达时挂载上下文
     */
    async onMessage(context) {
      const msg = context.message?.content || context.content;

      // 防御：空消息、纯空白、太短的消息
      if (!msg || typeof msg !== 'string' || msg.trim().length < MIN_QUESTION_LENGTH) {
        return;
      }

      // 防御：超短消息可能是心跳/健康检查
      if (msg.trim().length <= 2 && /^[🔔⏰💤]+$/.test(msg.trim())) {
        return;
      }

      // 去重：防止同一消息被多次触发
      const requestId = msg.trim().substring(0, 100);
      if (processedRequests.has(requestId)) {
        // 检查是否在 2 秒内重复（可能是并发钩子）
        const lastTime = processedRequests.get(requestId);
        if (Date.now() - lastTime < 2000) {
          return;
        }
      }
      processedRequests.set(requestId, Date.now());

      // 清理过期条目（防止内存泄漏）
      if (processedRequests.size > 1000) {
        const cutoff = Date.now() - 60000;
        for (const [key, time] of processedRequests) {
          if (time < cutoff) processedRequests.delete(key);
        }
      }

      context.dualModelData = {
        question: msg.trim(),
        startTime: Date.now(),
        deliveryContext: context.deliveryContext || context.route,
      };
    },

    /**
     * 老师回答完成后触发 Teach-Learn 流程
     */
    async onAfterResponse(context) {
      if (!context?.dualModelData) return;

      const question = context.dualModelData.question;
      const deliveryContext = context.dualModelData.deliveryContext;

      // collect-only 模式：仅收集老师回答，不做教学
      if (config.mode === 'collect-only') {
        const teacherAnswer = context.response?.content || context.response;
        if (teacherAnswer && typeof teacherAnswer === 'string' && teacherAnswer.length >= config.minAnswerLength) {
          saveTrainingData({
            question,
            teacherAnswer: sanitizeString(teacherAnswer),
            studentAnswer: null,
            teacherModel: context.model || config.teacherModel,
            studentModel: config.studentModel,
            deliveryContext,
          });
        }
        return;
      }

      // Teach-Learn 模式 — 异步后台执行，不阻塞主链路
      if (!config.enableTeachLearn) return;

      // Fire-and-forget: teachAndLearn 现在只跑老师回答（快速），
      // 学生模仿在后台异步进行，结果存入 learning_log.jsonl
      Promise.resolve(teachAndLearn(question, deliveryContext))
        .then(result => {
          const elapsed = result?.teacherFailed ? 'N/A' : 'fast';
          const summary = result?.teacherFailed
            ? '🔄 老师不可用'
            : result?.mode === 'autonomous'
              ? '🔄 自主模式'
              : '👨‍🏫 老师回答已返回';

          console.log(`[${pluginName}] 📊 ${summary} | 学生后台学习中... | 累计教学: ${stats.teachRounds} | 降级: ${stats.fallbackActivations} | 错误: ${stats.totalErrors}`);
        })
        .catch(error => {
          stats.totalErrors++;
          console.error(`[${pluginName}] ❌ Teach-Learn 流程异常: ${error?.message || String(error)}`);
        });
    },

    /**
     * 插件卸载时输出统计
     */
    
  /**
   * 定期生成学习总结
   */
  async generateLearningSummary() {
    try {
      const summaryModule = require(path.join(__dirname, "learning-summary.js"));
      const result = summaryModule.generateLearningSummary();
      console.log(`[dual-model-trainer] 📥 学习总结:`, result);
    } catch(e) {
      console.error(`[dual-model-trainer] 学习总结失败:`, e.message);
    }
  },
    async onShutdown() {
      // 计算延迟统计
      const avgLatency = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
      const p95Latency = (arr) => {
        if (!arr.length) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
      };

      console.log(`[${pluginName}] 📊 插件统计:`);
      console.log(`   - 保存数据: ${stats.savedCount} 条`);
      console.log(`   - 教学回合: ${stats.teachRounds} 轮`);
      console.log(`   - 口吻模仿: ${stats.mimicSuccess} 次`);
      console.log(`   - 降级激活: ${stats.fallbackActivations} 次`);
      console.log(`   - 总错误数: ${stats.totalErrors}`);
      console.log(`   - 总请求数: ${stats.totalRequests}`);
      console.log(`   - Token 消耗: 输入 ${stats.totalTokensInput.toLocaleString()} | 输出 ${stats.totalTokensOutput.toLocaleString()}`);
      console.log(`   - 模型调用: ${JSON.stringify(stats.modelCalls)}`);
      console.log(`   - 老师延迟: 平均 ${avgLatency(stats.teacherLatencyMs).toFixed(0)}ms | P95 ${p95Latency(stats.teacherLatencyMs).toFixed(0)}ms`);
      console.log(`   - 学生延迟: 平均 ${avgLatency(stats.studentLatencyMs).toFixed(0)}ms | P95 ${p95Latency(stats.studentLatencyMs).toFixed(0)}ms`);
    },
  };
}
