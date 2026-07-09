# AI-v24.13.0 开源版

基于 OpenClaw 2026.6.11 的本地 AI 助手网关，支持微信、Discord、飞书等多渠道接入。

## 快速开始

### 第一步：初始化
双击项目目录中的 **init.bat**，脚本会自动：
- 检测本机 Node.js（优先 nvm v24.13.0，其次系统 nodejs）
- 将 node.exe 复制到项目内的 .node-sandbox/ 目录（与全局 node 完全隔离）
- 从模板生成配置文件 C:\Users\<你的用户名>\.openclaw\openclaw.json

> ⚠️ 如果提示 "Node sandbox not found"，说明你的电脑没有安装 Node.js，请先安装（见下方"安装 Node.js"章节）。

### 第二步：配置 API Key
打开 C:\Users\<你的用户名>\.openclaw\openclaw.json，搜索 YOUR_*_API_KEY_HERE，替换为你自己的真实 API Key：

| 占位符 | 说明 | 获取地址 |
|--------|------|----------|
| YOUR_AGNES_API_KEY_HERE | Agnes AI 大模型 API Key | https://agnes-ai.com/zh-Hans/docs/agnes-video-v20 |
| YOUR_YITONG_API_KEY_HERE | 阿里云百炼 API Key | https://dashscope.console.aliyun.com/ |
| YOUR_ZHIPU_API_KEY_HERE | 智谱 AI API Key | https://open.bigmodel.cn/ |

### 第三步：启动 Gateway
双击 **start-gateway.bat**，看到端口 **18789** 监听即表示启动成功。

### 第四步：接入微信
微信接入需要额外配置：
1. 在 openclaw.json 中找到 "openclaw-weixin" 部分
2. 按照 [OpenClaw 微信接入文档](docs/weixin-setup.md) 扫码绑定
3. 重启 Gateway 即可

## 支持的模型

| 模型提供商 | 模型列表 | 用途 |
|-----------|---------|------|
| Agnes AI | agnes-2.0-flash, agnes-1.5-flash | 主模型（推荐） |
| 阿里云百炼 | qwen3-max | 备用模型 |
| Ollama | jarvis, gemma4:latest | 本地离线模型 |

## 支持的渠道

| 渠道 | 状态 | 配置方式 |
|------|------|----------|
| 微信 (WeChat) | ✅ | 见上方"接入微信" |
| WhatsApp | ✅ | 在 openclaw.json 中配置 |
| Discord | ✅ | 在 openclaw.json 中配置 |
| 飞书 (Feishu) | ✅ | 在 openclaw.json 中配置 |
| Telegram | ✅ | 在 openclaw.json 中配置 |

## 常见问题

### Q: 双击后窗口闪退？
A: 先运行 init.bat 初始化项目，确保 .node-sandbox/node.exe 存在。

### Q: 提示 "Missing config"？
A: init.bat 会自动创建配置文件，编辑 openclaw.json 填入 API Key 后重新启动。

### Q: 全局 Node.js 版本被改了？
A: 不会。项目使用 .node-sandbox/ 内的独立 node，与全局完全隔离。

### Q: 如何停止 Gateway？
A: 关闭 Gateway 窗口即可。下次启动 start-gateway.bat 会自动清理旧进程。

## 安装 Node.js

### 推荐：nvm-windows（支持多版本管理）
1. 下载：https://github.com/coreybutler/nvm-windows/releases
2. 安装后打开 CMD，运行：
   `
   nvm install 24
   nvm use 24
   `

### 备选：官方安装包
1. 下载地址：https://nodejs.org
2. 选择 LTS 或 Current 版本安装

## 技术栈

- **OpenClaw** 2026.6.11 — AI 网关框架
- **Node.js** v24.13.0 — 运行环境（本地沙箱）
- **Windows** — 仅支持 Windows 系统

## License

MIT
