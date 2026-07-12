# ClawAI 开源版

<p align="center">
  <img src="config/icon.ico" width="80" height="80" alt="ClawAI Logo" />
</p>

<p align="center">
  <strong>基于 OpenClaw 的零环境依赖本地 AI 智能网关，支持一键部署与多渠道接入。</strong>
</p>

<p align="center">
  <a href="https://github.com/2014-y/AI-v24.13.0/releases"><img src="https://img.shields.io/github/v/release/2014-y/AI-v24.13.0?color=purple&label=Release" alt="Latest Release" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D24.x-green?logo=node.js" alt="Node Version" /></a>
  <a href="https://github.com/electron/electron"><img src="https://img.shields.io/badge/Electron-Latest-blue?logo=electron" alt="Electron Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-orange" alt="License" /></a>
</p>

---

## 🌟 最新优化与核心特性

我们针对客户端的可维护性、网络容错性、安装透明度以及 UI 简洁度进行了多维度的核心优化：

### 🔄 1. 双通道自适应检查更新与自动升级
* **智能自适应下载**：内置高可用的国内加速镜像；同时为了防止某些地区宽带对代理镜像进行 TLS 阻断（导致 `socket disconnected` 报错），加入了**自适应回退直连重试机制**。若加速通道遭遇拦截，将自动重置并使用 GitHub 官方下载链接重新拉取，确保升级成功！
* **高容错版本校验**：优先使用官方 Release API 比对版本。若遇 API 匿名限流（403 错误），自动切换至网页 HEAD 重定向提取 tag 机制作为强力兜底。
* **双通道入口**：在侧边栏左下角以及“系统设置”的“关于”模块中，均内置了实用的“检查更新”按钮。

### 📄 2. 默认展开详细的安装释放日志
* **安装进度透明化**：通过在底层的安装脚本中引入 NSIS 宏重映射机制，强行攻克了打包器模板中硬编码的静默逻辑。
* **效果**：在运行安装程序时，底部的**文件解压和写入细节框默认直接自动展开**并滚动显示（如提取各种依赖），安装进度清晰可见，彻底消除进度焦虑！

### 🎨 3. “关于”页签与“系统设置”深度整合
* **侧边栏瘦身**：彻底移除了左侧导航栏原本独立的“关于 ClawAI”页签，使系统界面结构更加紧凑、核心功能更为突出。
* **精美排版融合**：将原本关于页中的**系统技术架构**、**核心服务能力**以及**极速上手使用指南**重构为垂直流式单列布局，使其在偏好设置面板的宽度限制下，展示效果极其精致。

---

## 🚀 极速下载与使用（小白推荐，零环境依赖，双击即用）

本项目已经过深度沙箱模块封装，提供了**一键安装程序**，无需在电脑上预先安装任何 Node.js、Python 或 Git 环境！

### 📥 1. 一键下载
请直接前往本项目的 **[GitHub Releases 页面](https://github.com/2014-y/AI-v24.13.0/releases)** 下载最新编译好的安装程序：
* **文件名格式**：`ClawAI Setup <版本号>.exe`

### 💿 2. 简易安装
1. 双击运行下载好的安装程序文件。
2. 安装器会自动展开详细的解压和文件释放日志。您可以**自由选择安装到指定的盘符和文件夹**（例如 D 盘、E 盘等自定义路径）。
3. 勾选创建桌面快捷方式。安装结束后，桌面上会生成一个 **「ClawAI」** 图标，直接双击打开！

### 💬 3. 接入微信与大模型
1. 启动桌面的 **ClawAI**，进入 **「控制台」** 面板。
2. 点击左上角的 **「启动网关」** 按钮，网关将自动拉起并开启 18789 端口。
3. 点击右侧面板底部的 **「绑定微信」**，系统会自动弹出微信扫码遮罩层，使用手机微信扫码即可接入 AI 服务！
4. 点击 **「用量监控」** 面板，您可以实时查看本次软件开启后模型的 Tokens 消耗、命中率和成本。每次软件关闭时所有会话监控数据都会默认清空重置，完全绿色无残留。

---

## 💡 这是什么项目？

ClawAI 是一个**本地 AI 助手网关控制面板**。

想象一下：**你在微信里跟 AI 聊天，AI 能帮你写代码、回答问题、看图识物、生成文案，而且所有数据都跑在你自己的电脑上，不经过任何第三方云服务器。**

它把你的电脑变成一个 24 小时在线 of AI 服务平台，然后通过微信、WhatsApp、Discord、飞书、Telegram 这些你每天都在用的聊天工具，直接跟 AI 对话。

---

## 🛠️ 核心能力与场景

### 核心能力

| 能力 | 说明 |
| :--- | :--- |
| **💬 微信聊 AI** | 在微信私聊或群里直接跟 AI 对话，发文字、图片、语音都能处理 |
| **🎯 多模型切换** | 支持 Agnes AI、阿里云百炼，或完全离线的本地 Ollama |
| **🔌 插件扩展** | 支持记忆、语音通话、网页搜索、自动摘要等 40+ 生产力插件 |
| **🛡️ 隐私安全** | 所有数据存在本地，API Key 绝不上传，完全掌控 |

### 支持的 AI 模型

| 模型 | 提供商 | 特点 | 适合场景 |
| :--- | :--- | :--- | :--- |
| **agnes-2.0-flash** | Agnes AI | 推荐主模型，支持文本+图像，响应快 | 日常对话、图片理解 |
| **agnes-1.5-flash** | Agnes AI | 轻量快速模型，节省 Token | 简单问答、快速回复 |
| **qwen3-max** | 阿里云百炼 | 中文能力强，上下文 200K tokens | 长文写作、代码生成 |
| **jarvis (Ollama)** | 本地离线 | 无需联网，完全隐私 | 隐私敏感场景、离线使用 |

---

## 🚀 开发者快速开始（从源码运行）

如果你是开发者，想要从源码运行或进行二次开发，请参考以下步骤：

| 步骤 | 操作 | 预计时间 |
| :---: | :--- | :---: |
| 1 | **[安装 Node.js](#1-安装-nodejs)** (推荐 v24.x) | 3 分钟 |
| 2 | **[下载并解压项目](#2-下载并解压项目)** | 1 分钟 |
| 3 | **[安装 openclaw 核心](#3-安装-openclaw-核心)** | 2 分钟 |
| 4 | **[运行 init.bat 进行初始化](#4-运行-initbat-进行初始化)** | 1 分钟 |
| 5 | **[配置本地 API Key](#5-配置-api-key)** | 2 分钟 |
| 6 | **[双击 start-gateway.bat 启动](#6-启动-gateway)** | 1 分钟 |

### 1. 安装 Node.js
项目运行环境推荐 **Node.js v24.x**。建议使用 `nvm-windows` 来管理版本。
```cmd
nvm install 24
nvm use 24
```

### 2. 下载并解压项目
```cmd
git clone https://github.com/2014-y/AI-v24.13.0.git
cd AI-v24.13.0
```

### 3. 安装 openclaw 核心
```cmd
npm install -g openclaw@2026.6.11
```

### 4. 运行 init.bat 进行初始化
在项目根目录双击运行 `init.bat`，它会自动检测环境、创建项目沙箱环境并生成 user 配置文件。

### 5. 配置 API Key
打开 `C:\Users\<你的用户名>\.openclaw\openclaw.json`，配置你的 API Key：
```json
{
  "agnesApiKey": "YOUR_AGNES_API_KEY_HERE",
  "yitongApiKey": "YOUR_YITONG_API_KEY_HERE"
}
```

### 6. 启动 Gateway
双击 `start-gateway.bat`。当看到控制台打印 `http server listening on port 18789` 即代表启动成功。

---

## 🛠️ 打包编译指南

如果你修改了源码（例如修改了 UI 或主进程逻辑），可以使用以下命令重新打包生成 Windows 独立安装包：

```bash
# 安装开发依赖
npm install

# 编译生成 NSIS 单文件安装包 (输出在 dist 目录下)
npm run app:dist
```

---

## 📑 文档索引与参考

*   **[INSTALL.md](INSTALL.md)** — 从零开始的完整环境搭建与调试指南
*   **[docs/getting-started.md](docs/getting-started.md)** — 从源码下载到运行的详细教程
*   **[docs/wechat-guide.md](docs/wechat-guide.md)** — 微信机器人渠道接入的专项指南
*   **[CHANGELOG.md](CHANGELOG.md)** — 项目版本迭代日志

---

## 📜 许可证

本项目遵循 [MIT License](LICENSE) 开源许可协议。

---

## 📬 联系与交流

*   **GitHub 仓库**: [2014-y/AI-v24.13.0](https://github.com/2014-y/AI-v24.13.0)
*   **API 提供商官网**: [agnes-ai.com](https://agnes-ai.com/zh-Hans/docs/agnes-video-v20)
