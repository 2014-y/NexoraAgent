# AI-v24.13.0 开源版

> 基于 OpenClaw 的本地 AI 助手网关，一键部署，多渠道接入，开箱即用。

---

## 简介

AI-v24.13.0 是一个**本地 AI 助手网关**，让你的电脑变成一个 AI 服务平台。通过微信、WhatsApp、Discord、飞书、Telegram 等平台，随时随地和 AI 对话。

**核心特点：**
- **完全本地运行** — 数据存在自己电脑上，不经过第三方服务器
- **一键部署** — 双击批处理文件即可，无需命令行经验
- **多模型切换** — 支持 Agnes AI、阿里云百炼、Ollama 本地模型
- **多渠道接入** — 一个网关对接所有聊天平台
- **Node.js 隔离** — 项目自带独立 Node 环境，不影响全局

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

## 支持的模型

| 模型 | 类型 | 特点 |
|------|------|------|
| agnes-2.0-flash | Agnes AI | 推荐主模型，支持文本+图像，响应快 |
| agnes-1.5-flash | Agnes AI | 轻量快速，节省 Token |
| qwen3-max | 阿里云百炼 | 中文能力强，上下文 200K tokens |
| jarvis | Ollama 本地 | 离线运行，完全隐私 |

---

## 支持的渠道

| 渠道 | 功能 |
|------|------|
| 微信 (WeChat) | 私聊、群聊、图片、语音 |
| WhatsApp | 私聊、群聊、媒体 |
| Discord | 服务器、频道、机器人 |
| 飞书 (Feishu) | 单聊、群组 |
| Telegram | 私聊、群组、频道 |

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
