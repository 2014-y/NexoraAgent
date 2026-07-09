# AI-v24.13.0 开源版

> 基于 OpenClaw 的本地 AI 助手网关，一键部署，多渠道接入，开箱即用。

---

## 什么是 AI-v24.13.0？

AI-v24.13.0 是一个**本地 AI 助手网关**，它把你的电脑变成一个 AI 服务平台。通过它，你可以用**微信、WhatsApp、Discord、飞书、Telegram** 等多个平台，随时和 AI 对话。

**核心优势：**
- **完全本地运行** — 所有数据存在你自己电脑上，不经过任何第三方服务器
- **一键部署** — 双击两个批处理文件就搞定，不需要命令行经验
- **多模型切换** — 支持 Agnes AI、阿里云百炼、Ollama 本地模型
- **多渠道接入** — 一个网关对接所有聊天平台
- **隐私安全** — API Key 存在本地，不上传云端

---

## 功能特性一览

### 支持的 AI 模型

| 模型 | 提供商 | 特点 | 适合场景 |
|------|--------|------|----------|
| agnes-2.0-flash | Agnes AI | 推荐主模型，支持文本+图像，响应快 | 日常对话、图片理解 |
| agnes-1.5-flash | Agnes AI | 轻量快速模型，节省 Token | 简单问答、快速回复 |
| qwen3-max | 阿里云百炼 | 中文能力强，上下文长（200K tokens） | 长文写作、代码生成 |
| jarvis | Ollama | 本地离线模型，无需网络 | 隐私敏感场景、离线使用 |

### 支持的聊天渠道

| 渠道 | 功能 | 配置难度 |
|------|------|----------|
| **微信 (WeChat)** | 私聊、群聊、图片、语音 | 低（扫码即可） |
| **WhatsApp** | 私聊、群聊、媒体 | 低 |
| **Discord** | 服务器、频道、机器人 | 中 |
| **飞书 (Feishu)** | 单聊、群组、应用 | 中 |
| **Telegram** | 私聊、群组、频道 | 低 |

### 高级功能

- **插件系统** — 支持 40+ 插件，包括记忆、语音通话、搜索、自动摘要等
- **多账号支持** — 一个网关可以对接多个微信号、多个 Discord 服务器
- **访问控制** — 白名单机制，只允许指定的人使用 AI 助手
- **健康监控** — 自动检测 Gateway 状态，异常时自动重启
- **日志系统** — 完整的操作日志，方便排查问题

---

## 系统运转流程

`
┌─────────────────────────────────────────────────────────────────┐
│                        用户端（手机/电脑）                        │
│                                                                 │
│   微信 ──┐                                                      │
│   WhatsApp──┐                                                   │
│   Discord ──┤                                                   │
│   飞书  ────┤── 发消息 ──→  ┌──────────────────┐                │
│   Telegram─┘                │                  │                │
│                             │   OpenClaw       │                │
│                             │   Gateway        │                │
│                             │   (端口 18789)   │                │
│                             │                  │                │
│                             └────────┬─────────┘                │
│                                      │ 转发请求                   │
│                                      ▼                          │
│                             ┌──────────────────┐                │
│                             │                  │                │
│                    Agnes AI ──→ agnes-2.0-flash │                │
│                    阿里云百炼──→ qwen3-max       │                │
│                    Ollama ────→ jarvis (本地)    │                │
│                             │                  │                │
│                             └────────┬─────────┘                │
│                                      │ 返回回答                  │
│                                      ▼                          │
│                             ┌──────────────────┐                │
│                             │                  │                │
│                    微信 ←───┤  回复消息         │                │
│                    WhatsApp──┤                  │                │
│                    Discord ──┤                  │                │
│                    飞书  ─────┤                  │                │
│                    Telegram──┘                  │                │
│                             └──────────────────┘                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
`

**流程说明：**

1. **用户发送消息** — 通过微信、WhatsApp 等平台发送消息
2. **消息到达 Gateway** — OpenClaw Gateway 在本地端口 18789 监听所有渠道的消息
3. **消息路由到模型** — Gateway 根据配置选择合适的 AI 模型处理消息
4. **AI 生成回答** — 模型处理消息后生成回复
5. **回复发送给用户** — Gateway 将回复通过原渠道发送给用户

整个过程在本地完成，不经过任何外部服务器（除了调用 AI 模型的 API）。

---

## 环境要求

### 最低配置

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10 或 Windows 11 |
| 内存 | 4GB RAM |
| 硬盘 | 2GB 可用空间 |
| 网络 | 需要联网（用于调用 AI API） |

### 推荐配置

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 11 专业版 |
| 内存 | 8GB RAM 或以上 |
| 硬盘 | 5GB 可用空间（如果使用 Ollama 本地模型） |
| 网络 | 稳定的宽带连接 |

### 软件依赖

| 软件 | 版本 | 用途 | 是否必需 |
|------|------|------|----------|
| Node.js | v24.x | 运行环境 | 是 |
| nvm-windows | 最新版 | Node.js 版本管理 | 推荐 |

---

## 安装教程（从零开始）

### 第 0 步：安装 Node.js

> 如果你的电脑已经安装了 Node.js v24.x，可以跳过这一步。

#### 方法一：使用 nvm-windows（推荐）

nvm 可以让你在一台电脑上管理多个 Node.js 版本，互不干扰。

**1. 下载 nvm-windows**

打开浏览器，访问：https://github.com/coreybutler/nvm-windows/releases

找到最新的 
vm-setup.exe，点击下载。

**2. 安装 nvm**

双击 
vm-setup.exe，按照提示安装：
- 安装路径保持默认（C:\Users\<你的用户名>\AppData\Roaming\nvm）
- 一路点击"下一步"即可完成

**3. 验证安装**

打开 CMD（命令提示符），输入：

`ash
nvm version
`

如果显示版本号（如 1.1.11），说明安装成功。

**4. 安装 Node.js v24**

`ash
nvm install 24
nvm use 24
`

**5. 验证 Node.js**

`ash
node -v
`

应该显示 24.x.x。

#### 方法二：使用官方安装包

如果你不想用 nvm，可以直接安装官方 Node.js。

**1. 下载**

打开浏览器，访问：https://nodejs.org

选择 **LTS** 版本（长期支持版），点击下载。

**2. 安装**

双击下载的安装包，按照提示安装：
- 勾选 "Automatically install the necessary tools"
- 安装路径保持默认
- 一路点击"下一步"

**3. 验证**

打开 CMD，输入：

`ash
node -v
npm -v
`

应该分别显示 Node.js 和 npm 的版本号。

---

### 第 1 步：下载项目

**方式一：从 GitHub 下载 ZIP**

1. 打开浏览器，访问：https://github.com/2014-y/AI-v24.13.0
2. 点击绿色按钮 **"Code"**
3. 选择 **"Download ZIP"**
4. 下载完成后，解压到你想放置的目录（如 D:\ai\AI-v24.13.0）

**方式二：使用 Git clone**

如果你有 Git，可以打开 CMD 或 PowerShell，输入：

`ash
git clone https://github.com/2014-y/AI-v24.13.0.git
cd AI-v24.13.0
`

---

### 第 2 步：初始化项目

1. 打开项目文件夹（如 D:\ai\AI-v24.13.0）
2. 找到 **init.bat** 文件
3. **双击** init.bat

你会看到类似这样的输出：

`
========================================
  AI-v24.13.0 Setup
========================================

[1/3] Looking for Node.js...
  Found: C:\Users\你的用户名\AppData\Roaming\nvm\v24.13.0
[2/3] Setting up .node-sandbox...
  Created .node-sandbox with node.exe
[3/3] Setting up configuration...
  Created openclaw.json from template.

  IMPORTANT: Edit C:\Users\你的用户名\.openclaw\openclaw.json
  Replace YOUR_*_API_KEY_HERE with your actual API Keys.

========================================
  Setup complete!
========================================
`

按 Enter 键退出。

**init.bat 做了什么？**
- 检测你电脑上的 Node.js
- 把 node.exe 复制到项目内的 .node-sandbox/ 目录（与全局 Node.js 完全隔离）
- 生成配置文件 C:\Users\<你的用户名>\.openclaw\openclaw.json

---

### 第 3 步：配置 API Key

**1. 打开配置文件**

打开文件管理器，进入：

`
C:\Users\<你的用户名>\.openclaw\
`

找到 openclaw.json 文件，右键 → 打开方式 → 记事本。

**2. 搜索并替换 API Key**

在记事本中按 Ctrl + H 打开替换对话框：

| 搜索 | 替换为 | 说明 |
|------|--------|------|
| YOUR_AGNES_API_KEY_HERE | 你的 Agnes AI API Key | 必填 |
| YOUR_YITONG_API_KEY_HERE | 你的阿里云 API Key | 选填 |
| YOUR_ZHIPU_API_KEY_HERE | 你的智谱 API Key | 选填 |

**3. 获取 API Key**

- **Agnes AI**：访问 https://agnes-ai.com/zh-Hans/docs/agnes-video-v20，注册登录后在控制台创建 API Key
- **阿里云百炼**：访问 https://dashscope.console.aliyun.com/，登录后在 API Key 管理页面创建
- **智谱 AI**：访问 https://open.bigmodel.cn/，登录后在 API Key 管理页面创建

**4. 保存文件**

按 Ctrl + S 保存文件，关闭记事本。

---

### 第 4 步：启动 Gateway

1. 打开项目文件夹
2. **双击 start-gateway.bat**

你会看到类似这样的输出：

`
========================================
 OpenClaw Gateway Launcher
========================================

Node: D:\ai\AI-v24.13.0\.node-sandbox\node.exe
Modules: C:\Users\你的用户名\AppData\Roaming\nvm\v24.13.0\node_modules

Starting...

2026-07-09T09:12:37 [gateway] loading configuration...
2026-07-09T09:12:37 [gateway] starting HTTP server...
2026-07-09T09:12:37 [gateway] agent model: agnes-ai/agnes-2.0-flash
2026-07-09T09:12:37 [gateway] http server listening on port 18789
`

看到 **"http server listening on port 18789"** 就说明启动成功了！

---

### 第 5 步：接入微信（可选）

详细的微信接入教程见 [docs/wechat-guide.md](docs/wechat-guide.md)。

**快速步骤：**

1. 安装微信插件：
   `ash
   npx -y @tencent-weixin/openclaw-weixin-cli install
   `

2. 扫码登录：
   `ash
   openclaw channels login --channel openclaw-weixin
   `

3. 用微信扫描屏幕上出现的二维码，手机端确认登录。

4. 登录成功后，你就可以在微信里和你的 AI 助手对话了！

---

## 日常使用

### 启动

每次开机后，双击 **start-gateway.bat** 即可启动 Gateway。

### 停止

直接关闭 Gateway 窗口即可。

### 重启

1. 先关闭 Gateway 窗口
2. 双击 **start-gateway.bat** 重新启动

### 查看日志

日志保存在：

`
C:\Users\<你的用户名>\.openclaw\logs\
`

按日期命名的 .log 文件就是日志。

---

## 常见问题

### Q: 双击 start-gateway.bat 后窗口闪退？
**A:** 先运行 init.bat 初始化项目，确保 .node-sandbox/node.exe 存在。

### Q: 提示 "Missing config"？
**A:** 运行 init.bat 会自动创建配置文件，然后编辑 openclaw.json 填入 API Key。

### Q: 全局 Node.js 版本被改了？
**A:** 不会。项目使用 .node-sandbox/ 内的独立 node，与全局完全隔离。

### Q: 微信登录后立刻掉线？
**A:** 检查是否在同一台电脑上运行 Gateway。不要同时用多个客户端登录同一个微信账号。

### Q: 收不到微信消息？
**A:** 检查 openclaw.json 中 plugins.entries.openclaw-weixin.enabled 是否为 	rue。

### Q: 想接多个微信号？
**A:** 每个微信号单独执行一次 openclaw channels login --channel openclaw-weixin 即可。

### Q: 端口 18789 被占用？
**A:** 先关闭占用该端口的程序，再启动 Gateway。

---

## 技术栈

| 组件 | 版本 | 说明 |
|------|------|------|
| OpenClaw | 2026.6.11 | AI 网关核心框架 |
| Node.js | v24.13.0 | 运行环境（本地沙箱） |
| Windows | 10/11 | 操作系统 |

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [完整使用流程](docs/getting-started.md) | 从下载到微信聊天的每一步 |
| [微信接入教程](docs/wechat-guide.md) | 微信扫码绑定详细步骤 |

---

## 许可证

MIT License

---

## 联系方式

- GitHub: [2014-y/AI-v24.13.0](https://github.com/2014-y/AI-v24.13.0)
- 文档: [agnes-ai.com](https://agnes-ai.com/zh-Hans/docs/agnes-video-v20)
