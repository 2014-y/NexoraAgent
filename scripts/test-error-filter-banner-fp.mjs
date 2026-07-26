/**
 * Regression: conversational model advice mentioning Rate Limit must NOT be blocked.
 * Real incident 2026-07-26T05:22 — error-filter cancelled outbound「双剑合璧」建议.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const modUrl = pathToFileURL(path.join(process.cwd(), 'plugins', 'error-filter', 'index.js')).href;
const { __testables: t } = await import(modUrl);

const realBlocked = `**回主子！** 在 OpenClaw 这种需要频繁**调用工具、写代码、盘文件、多轮交互**的 Agent 场景下，小的为您推荐以下**“双剑合璧”**的黄金配置方案：

---

### ⚔️ **主用模型（首选主力）：Gemini 3.6 Flash**
* **推荐理由**：
  1. **响应极快、延时超低**：Agent 模式下常常需要连续跑多轮工具，Flash 的迅捷身法能让您几乎感觉不到卡顿。
  2. **Tool Calling（工具调用）与代码极强**：执行指令准确，不容易在复杂链条里“掉链子”。
  3. **超长上下文与极高性价比**：处理超长文件或历史记忆毫无压力，且配额/成本非常划算。
* **定位**：日常干活、查资料、写代码、操控系统的一线大将军。

---

### 🛡️ **备用模型（防断供/悬难备选）：DeepSeek V3 / R1** 或 **Claude 3.5 Sonnet**
* **推荐方案 A（性价比首选）：DeepSeek V3**
  * **理由**：国产强芯，价格便宜，推理与代码实力极强。当 Google 接口偶尔遭遇网络波动或限流（Rate Limit）时，DeepSeek 可以无缝接管，完美兜底。
* **推荐方案 B（极致体验）：Claude 3.5 Sonnet**
  * **理由**：逻辑严谨、文笔好，适合硬核难题。`;

const cases = [
  { name: 'real-双剑合璧-advice', text: realBlocked, expect: false },
  { name: 'short-rate-limit-banner', text: '⚠️ All models are temporarily rate-limited. Please try again in a few minutes.', expect: true },
  { name: 'llm-failed', text: 'LLM request failed', expect: true },
  { name: 'compaction-diag', text: 'Auto-compaction could not recover this turn. Context overflow: prompt too large. Please use /new to start. compaction-diag diagId=ovf-123', expect: true },
  { name: '所有模型推荐-conversational', text: '回主子！所有模型里小的更推荐这两个当主用和备用。', expect: false },
  { name: 'message-colon-normal', text: '回主子，刚才那条 Message: hello 只是举例，不是报错。', expect: false },
  { name: 'message-failed-banner', text: 'Message: tool xyz failed', expect: true },
];

let failed = 0;
for (const c of cases) {
  const got = t.shouldBlockOutbound(c.text);
  const ok = got === c.expect;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} got=${got} expect=${c.expect}`);
  if (!ok) failed += 1;
}

if (failed) {
  console.error('REGRESSION_FAIL', failed);
  process.exit(1);
}
console.log('REGRESSION_OK');
