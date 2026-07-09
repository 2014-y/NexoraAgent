# AI-v24.13.0 开源版

> 基于 OpenClaw 的本地 AI 助手网关，一键部署，多渠道接入，开箱即用。

## 项目简介

AI-v24.13.0 是一个基于 [OpenClaw](https://github.com/openclaw/openclaw) 构建的本地 AI 助手网关。它将大语言模型能力通过统一接口接入多个聊天平台，让你在自己的服务器上运行一个功能完整的 AI 助手。

### 核心特性

- **一键部署** — 双击 init.bat 完成初始化，无需复杂配置
- **多模型支持** — Agnes AI、阿里云百炼、Ollama 本地模型无缝切换
- **多渠道接入** — 微信、WhatsApp、Discord、飞书、Telegram 统一接入
- **隐私安全** — 所有数据存储在本地，不经过第三方服务器
- **完全隔离** — 使用独立的 Node.js 沙箱，不影响全局环境
- **Windows 原生** — 专为 Windows 系统设计，双击即可运行

### 架构概览

`
微信/WhatsApp/Discord/飞书/Telegram
         |
         v
  OpenClaw Gateway (端口 18789)
         |
         v
  AI 模型服务 (Agnes AI / 阿里云 / Ollama)
`

---

## 快速开始

### 前置条件

- Windows 10/11 系统
- Node.js v24.x（推荐通过 nvm-windows 安装）

### 四步启动

详细的图文教程见 [完整使用流程](docs/getting-started.md)。

1. **双击 init.bat** — 自动初始化项目
2. **编辑 openclaw.json** — 填入你的 API Key
3. **双击 start-gateway.bat** — 启动 Gateway
4. **用微信聊天** — 见 [微信接入教程](docs/wechat-guide.md)

---

## 支持的模型

| 提供商 | 模型 | 特点 | 配置位置 |
|--------|------|------|----------|
| **Agnes AI** | agnes-2.0-flash | 推荐主模型，支持文本+图像 | models.providers.agnes-ai |
| **Agnes AI** | agnes-1.5-flash | 轻量快速模型 | models.providers.agnes-ai |
| **阿里云百炼** | qwen3-max | 中文能力强，上下文长 | models.providers.yitong |
| **Ollama** | jarvis | 本地离线模型 | models.providers.ollama |

---

## 支持的渠道

| 渠道 | 状态 | 配置方式 |
|------|------|----------|
| **微信 (WeChat)** | ✅ | 见 [微信接入教程](docs/wechat-guide.md) |
| **WhatsApp** | ✅ | 配置 channels.whatsapp |
| **Discord** | ✅ | 配置 channels.discord |
| **飞书 (Feishu)** | ✅ | 配置 channels.feishu |
| **Telegram** | ✅ | 配置 channels.telegram |

---

## 常见问题

### Q: 双击 start-gateway.bat 后窗口闪退？
**A:** 先运行 init.bat 初始化项目。如果仍有问题，请检查是否安装了 Node.js。

### Q: 提示 "Missing config" 或 "Invalid config"？
**A:** 运行 init.bat 会自动创建配置文件。如果提示配置错误，请编辑 openclaw.json 填入有效的 API Key。

### Q: 全局 Node.js 版本被改了？
**A:** 不会。项目使用 .node-sandbox/ 内的独立 node，与全局完全隔离。你的全局 
ode -v 不受影响。

### Q: 如何停止 Gateway？
**A:** 直接关闭 Gateway 窗口即可。下次启动 start-gateway.bat 会自动清理旧进程。

### Q: 可以在 Mac/Linux 上运行吗？
**A:** 当前版本仅支持 Windows。Mac/Linux 用户可使用 Docker 部署 OpenClaw 原版。

---

## 安装 Node.js

### 方法一：nvm-windows（推荐）

支持多版本管理，方便切换：

`powershell
# 安装 nvm-windows
# 下载地址: https://github.com/coreybutler/nvm-windows/releases

# 安装并使用 Node.js v24
nvm install 24
nvm use 24
`

### 方法二：官方安装包

直接下载安装：

`
下载地址: https://nodejs.org
选择 LTS 版本安装即可
`

安装完成后验证：

`powershell
node -v   # 应显示 v24.x.x
npm -v    # 应显示 10.x.x
`

---

## 技术栈

| 组件 | 版本 | 说明 |
|------|------|------|
| OpenClaw | 2026.6.11 | AI 网关核心框架 |
| Node.js | v24.13.0 | 运行环境（本地沙箱） |
| Windows | 10/11 | 操作系统 |

---

## 文档

| 文档 | 说明 |
|------|------|
| [完整使用流程](docs/getting-started.md) | 从下载到微信聊天的每一步 |
| [微信接入教程](docs/wechat-guide.md) | 微信扫码绑定详细步骤 |

---

## 许可证

MIT License

---

## 贡献

欢迎提交 Issue 和 Pull Request！

## 联系方式

- GitHub: [2014-y/AI-v24.13.0](https://github.com/2014-y/AI-v24.13.0)
- 文档: [agnes-ai.com](https://agnes-ai.com/zh-Hans/docs/agnes-video-v20)
