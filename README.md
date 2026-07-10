# AI-v24.13.0 开源版

> 基于 OpenClaw 的本地 AI 助手网关，一键部署，多渠道接入，开箱即用。

---

## 这是什么项目？

想象一下：**你在微信里跟 AI 聊天，AI 能帮你写代码、回答问题、看图识物、生成文案，而且所有数据都跑在你自己的电脑上，不经过任何云服务器。**

AI-v24.13.0 就是一个**本地 AI 助手网关**。它把你的电脑变成一个 24 小时在线的 AI 服务平台，然后通过微信、WhatsApp、Discord、飞书、Telegram 这些你每天都在用的聊天工具，直接跟 AI 对话。

---

## 它能做什么？

### 核心能力

| 能力 | 说明 |
|------|------|
| **微信聊 AI** | 在微信私聊或群里直接跟 AI 对话，发文字、图片、语音都能处理 |
| **多模型切换** | 想用 Agnes AI 就 Agnes，想用阿里云就阿里云，想离线就用本地 Ollama |
| **多渠道统一** | 一个网关同时接微信、WhatsApp、Discord、飞书、Telegram，消息统一管理 |
| **图片理解** | 发张图片给 AI，它能看懂图里的内容并回答你的问题 |
| **插件扩展** | 支持记忆、语音通话、网页搜索、自动摘要等 40+ 插件 |
| **隐私安全** | 所有数据存在本地，API Key 不上传，完全掌控 |

### 典型使用场景

| 场景 | 怎么用 |
|------|--------|
| **个人助手** | 微信里随时问 AI 问题、写文案、翻译、总结文章 |
| **团队客服** | 接在微信群或飞书群里，AI 自动回答客户常见问题 |
| **代码辅助** | 在聊天窗口让 AI 帮你写代码、查 bug、解释技术方案 |
| **图片分析** | 拍张照发给 AI，让它识别内容、提取文字、回答问题 |
| **离线推理** | 用 Ollama 跑本地模型，断网也能用，适合隐私敏感场景 |
| **多平台管理** | 一套配置同时管微信、WhatsApp、Discord，不用装多个客户端 |

### 支持的 AI 模型

| 模型 | 提供商 | 特点 | 适合场景 |
|------|--------|------|----------|
| **agnes-2.0-flash** | Agnes AI | 推荐主模型，支持文本+图像，响应快 | 日常对话、图片理解 |
| **agnes-1.5-flash** | Agnes AI | 轻量快速模型，节省 Token | 简单问答、快速回复 |
| **qwen3-max** | 阿里云百炼 | 中文能力强，上下文 200K tokens | 长文写作、代码生成 |
| **jarvis (Ollama)** | 本地离线 | 无需联网，完全隐私 | 隐私敏感场景、离线使用 |

### 支持的聊天渠道

| 渠道 | 功能 | 配置难度 |
|------|------|----------|
| **微信 (WeChat)** | 私聊、群聊、图片、语音 | 低（扫码即可） |
| **WhatsApp** | 私聊、群聊、媒体 | 低 |
| **Discord** | 服务器、频道、机器人 | 中 |
| **飞书 (Feishu)** | 单聊、群组、应用 | 中 |
| **Telegram** | 私聊、群组、频道 | 低 |

### 支持的插件功能

项目内置插件系统，支持 40+ 插件，常用功能包括：

| 插件类别 | 功能 | 说明 |
|----------|------|------|
| **记忆** | 长期记忆 | AI 能记住之前的对话内容，跨会话持续学习 |
| **语音通话** | 实时语音 | 通过微信语音跟 AI 打电话 |
| **网页搜索** | 实时搜索 | AI 能上网查最新信息，不只靠训练数据 |
| **自动摘要** | 长文总结 | 发一篇长文章，AI 帮你提炼要点 |
| **图片处理** | 识图/生成 | 发图让 AI 分析，或用 AI 生成图片 |
| **文件处理** | 文档解析 | 发送 PDF、Word、Excel，AI 帮你读取和分析 |
| **访问控制** | 白名单管理 | 指定谁能用你的 AI 助手，防止滥用 |
| **健康监控** | 自动重启 | Gateway 异常时自动检测并重启 |

---

## 适合谁用？

- **个人用户** — 想在自己的电脑上跑一个 AI 助手，随时用微信聊天
- **小团队** — 需要一个内部 AI 客服/助手，接在微信群或飞书群里
- **开发者** — 想基于 OpenClaw 二次开发，搭建自己的 AI 服务平台
- **隐私敏感用户** — 不想把数据传给任何第三方云服务

---

## 快速开始（6 步搞定）

| 步骤 | 操作 | 预计时间 |
|------|------|----------|
| 1 | [安装 Node.js](#1-安装-nodejs) | 3 分钟 |
| 2 | [下载并解压项目](#2-下载并解压项目) | 1 分钟 |
| 3 | [安装 openclaw](#3-安装-openclaw) | 2 分钟 |
| 4 | [运行 init.bat 初始化](#4-运行-initbat-初始化) | 1 分钟 |
| 5 | [配置 API Key](#5-配置-api-key) | 2 分钟 |
| 6 | [双击 start-gateway.bat 启动](#6-启动-gateway) | 1 分钟 |

> 全部完成后，参考 [接入微信](#接入微信可选) 或 [配置本地 Ollama 模型](#配置本地-ollama-模型可选)。

---

## 详细教程

**新手推荐阅读顺序：**

1. **[INSTALL.md](INSTALL.md)** — 从零开始的完整安装指南
2. **[docs/getting-started.md](docs/getting-started.md)** — 从下载到使用的完整流程
3. **[docs/wechat-guide.md](docs/wechat-guide.md)** — 微信接入详细教程

---

## 1. 安装 Node.js

项目需要 **Node.js v24.x**。

### 推荐方式：nvm-windows

nvm 可以管理多个 Node.js 版本，互不干扰。

1. 下载：https://github.com/coreybutler/nvm-windows/releases
2. 安装 
vm-setup.exe
3. 打开 CMD，运行：

`cmd
nvm install 24
nvm use 24
`

4. 验证：
ode -v 应显示 v24.x.x

### 备选方式：官方安装包

直接下载安装：https://nodejs.org （选 LTS 版本）

---

## 2. 下载并解压项目

**方式一：下载 ZIP**

1. 访问 https://github.com/2014-y/AI-v24.13.0
2. 点击绿色 **Code** 按钮 → **Download ZIP**
3. 解压到你喜欢的目录（比如 D:\ai\AI-v24.13.0）

**方式二：Git Clone**

`cmd
git clone https://github.com/2014-y/AI-v24.13.0.git
cd AI-v24.13.0
`

---

## 3. 安装 openclaw

openclaw 是网关的核心工具，依赖 Node.js 的 npm。

在 CMD 中运行：

`cmd
npm install -g openclaw@2026.6.11
`

验证安装：

`cmd
openclaw --version
`

应显示 2026.6.11。

> 💡 如果提示 "npm 不是内部命令"，说明 Node.js 没装好或没添加到环境变量，请回到第 1 步重新安装。

---

## 4. 运行 init.bat 初始化

1. 打开项目文件夹
2. **双击 init.bat**
3. 看到 **"Setup complete!"** 即成功

init.bat 会自动完成：
- 检测本机 Node.js
- 创建 .node-sandbox/ 目录（独立 Node 环境，不影响全局）
- 生成配置文件 C:\Users\<你的用户名>\.openclaw\openclaw.json

> ⚠️ 如果双击没反应，右键 → 以管理员身份运行。

---

## 5. 配置 API Key

1. 打开文件管理器，进入 C:\Users\<你的用户名>\.openclaw\
2. 用记事本打开 openclaw.json
3. 按 Ctrl+H 搜索并替换以下占位符：

| 搜索 | 替换为 | 说明 |
|------|--------|------|
| YOUR_AGNES_API_KEY_HERE | 你的 Agnes AI Key | **必填** |
| YOUR_YITONG_API_KEY_HERE | 你的阿里云 Key | 选填 |
| YOUR_ZHIPU_API_KEY_HERE | 你的智谱 Key | 选填 |

4. 按 Ctrl+S 保存

**获取 API Key：**
- **Agnes AI**：https://agnes-ai.com/zh-Hans/docs/agnes-video-v20
- **阿里云百炼**：https://dashscope.console.aliyun.com/
- **智谱 AI**：https://open.bigmodel.cn/

> 💡 至少配置一个 API Key 才能正常使用。推荐优先配置 Agnes AI。

---

## 6. 启动 Gateway

1. 打开项目文件夹
2. **双击 start-gateway.bat**
3. 看到 **"http server listening on port 18789"** 即启动成功

此时 AI 网关已在运行，可以通过以下方式接入：

---

## 接入微信（可选）

1. 安装微信插件：
   `cmd
   npx -y @tencent-weixin/openclaw-weixin-cli install
   `

2. 扫码登录：
   `cmd
   openclaw channels login --channel openclaw-weixin
   `
   用微信扫描屏幕上出现的二维码，手机端确认登录。

3. 登录成功后即可在微信中和 AI 对话！

> 📖 详细教程：[docs/wechat-guide.md](docs/wechat-guide.md)

---

## 配置本地 Ollama 模型（可选）

如果想用**离线本地模型**（无需联网，完全隐私）：

1. 安装 Ollama：https://ollama.com
2. 拉取模型：ollama pull gemma3:27b
3. 构建自定义模型：ollama create jarvis -f jarvis-modelfile.txt
4. 验证：ollama list

> 详见 [docs/getting-started.md#第-5-步配置本地模型可选](docs/getting-started.md)

---

## 常见问题

| 问题 | 解决方法 |
|------|---------|
| 双击 start-gateway.bat 闪退 | 先运行 init.bat，确保 openclaw 已安装 |
| 提示 "Invalid config" 或路径错误 | 重新运行 init.bat，检查配置文件 |
| 提示 "openclaw not found" | 运行 
pm install -g openclaw@2026.6.11 安装 |
| 提示 "npm 命令找不到" | Node.js 未正确安装，重新安装 |
| 端口 18789 被占用 | 关闭其他 Gateway 实例 |
| 全局 Node.js 版本被改了？ | 不会！项目使用 .node-sandbox/ 内的独立 node，与全局完全隔离 |
| 如何停止 Gateway？ | 直接关闭窗口即可 |

---

## 架构概览

`
用户端（微信/WhatsApp/Discord...）
        ↓ 发消息
   OpenClaw Gateway (端口 18789)
        ↓ 转发请求
   Agnes AI / 阿里云 / Ollama 本地
        ↓ 返回回答
   用户端收到回复
`

---

## 文档索引

| 文档 | 用途 |
|------|------|
| [INSTALL.md](INSTALL.md) | 从零开始的完整安装指南 |
| [docs/getting-started.md](docs/getting-started.md) | 从下载到使用的完整流程 |
| [docs/wechat-guide.md](docs/wechat-guide.md) | 微信接入详细教程 |
| [CHANGELOG.md](CHANGELOG.md) | 版本更新日志 |

---

## 技术栈

| 组件 | 版本 |
|------|------|
| OpenClaw | 2026.6.11 |
| Node.js | v24.13.0（项目沙箱内） |
| 操作系统 | Windows 10/11 |

---

## 许可证

MIT License

---

## 联系方式

- GitHub: [2014-y/AI-v24.13.0](https://github.com/2014-y/AI-v24.13.0)
- 文档: [agnes-ai.com](https://agnes-ai.com/zh-Hans/docs/agnes-video-v20)
