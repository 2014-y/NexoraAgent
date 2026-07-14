# Teach-Learn 双模型训练插件 v4.0 - 生产级

## 核心流程

```
用户提问
  ↓
① 老师模型回答（在模型配置中指定）← 高质量示范
  ↓
② 口吻分析引擎 ← 提取老师的说话特征
   - 称呼习惯（您好/你好/先生...）
   - 句式结构（列表/编号/代码块）
   - 语气风格（正式/亲切/简洁）
   - 结尾习惯（总结/反问/祝福）
  ↓
③ 学生模型 1:1 模仿老师口吻回答 ← 核心功能
  ↓
用户收到回复 ← 感觉就像老师在说话
```

## 降级策略

| 场景 | 行为 |
|------|------|
| 老师不可用 + 学生可用 | 学生自主回答，标记 `[自主模式]` |
| 老师不可用 + 学生也不可用 | 返回错误提示 |
| 口吻模仿失败 | 退回老师原始回答 |
| 任何步骤异常 | 记录错误，不中断主流程 |

## 配置

```json
{
  "plugins": {
    "entries": {
      "dual-model-trainer": {
        "enabled": true,
        "config": {
          "teacherModel": "agnes-ai/agnes-2.0-flash",
          "studentModel": "",
          "mode": "teach-learn",
          "enableVoiceMimicry": true,
          "enableFallback": true,
          "enableTeachLearn": true,
          "maxRetries": 2,
          "retryDelay": 3000,
          "timeoutMs": 60000,
          "minAnswerLength": 10
        }
      }
    }
  }
}
```

## 运行模式

| 模式 | 说明 |
|------|------|
| `teach-learn` | 老师教、学生学、学生模仿口吻回答（默认） |
| `fallback` | 仅当老师不可用时学生顶替 |
| `collect-only` | 仅收集数据，不做实时推理 |

## 生产级特性

- **并发安全**：每轮对话独立状态，不共享可变变量
- **竞态保护**：同一问题不会重复触发
- **超时保护**：单轮教学最多 60 秒
- **内存安全**：大回答截断、空值防御、类型校验
- **数据完整性**：原子化写入，防止训练数据损坏
- **优雅降级**：每一步都有 fallback 链
- **错误隔离**：任何单步失败不影响主流程
- **指数退避**：模型调用失败时使用指数退避重试
- **请求去重**：防止同一消息被多次触发
- **自动清理**：过期请求条目自动回收

## 训练数据格式

```json
{
  "timestamp": "2026-06-26T12:00:00.000Z",
  "question": "用户问题",
  "teacherAnswer": "老师的原始回答",
  "studentAnswer": "学生模仿老师口吻的回答",
  "teacherModel": "agnes-ai/agnes-2.0-flash",
  "studentModel": "",
  "mode": "voice-mimic",
  "teacher_voice": {
    "styleDescription": "正式礼貌，善用列表，回答详尽",
    "formalityLevel": 8,
    "greetings": ["您好"],
    "usesBulletPoints": true
  },
  "mimic_enabled": true,
  "source": "teach-learn-v4"
}
```

## 版本历史

- **v4.0** — 生产级（并发安全、超时保护、数据完整性、错误隔离）
- **v3.0** — 口吻模仿版（1:1 模仿老师说话方式）
- **v2.0** — Teach-Learn 模式（老师教、学生学、学生回答）
- **v1.0** — 双模型训练（仅收集云端答案用于离线训练）
