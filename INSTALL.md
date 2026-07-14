# INSTALL.md

# ClawAI - 安装指南

## 系统要求

- **操作系统**: Windows 10/11 (64-bit)
- **Node.js**: v24.x (无需预装，客户端已内置独立的绿色 Node 沙箱运行时)
- **磁盘空间**: ≥ 500MB
- **内存**: ≥ 2GB RAM

## 📦 极简打包与绿色分发（零环境安装）

如果您想在其他“白机”（即没有任何 Node.js、Git、Python 环境的干净电脑）上安装和部署本客户端，请直接使用我们内置的打包脚本：

### 一键打出安装包
在项目根目录下，直接在命令行中运行以下打包命令：
```powershell
npm run app:dist
```
- **打包产物**：会在当前工程的 `dist/` 目录下生成一个 `ClawAI Setup <Version>.exe`。
- **零环境支持原理**：该打包机制会完美排除打包工具自身的多余代码，但会高压缩地将 `.node-sandbox/`（内置独立 Node 运行时）、`node_modules/`（含 openclaw 和 40+ 插件依赖）和配置模板封入安装包中。
- **白机部署**：白机用户拿到 `ClawAI Setup <Version>.exe` 双击安装后，应用会在首次启动时自动建立用户主目录的 `.openclaw/` 环境，**直接即可双击拉起网关运行，100% 免配置、免安装全局 Node**！

---

## 快速开发与手动安装

### 第一步：安装 NVM for Windows

1. 下载: https://github.com/coreybutler/nvm-windows/releases
2. 安装 nvm-setup.exe
3. 验证: `nvm version`

### 第二步：安装 Node.js v24.x

```powershell
nvm install 24
nvm use 24
node --version  # 应显示 v24.x
```

### 第三步：安装全局依赖

```powershell
npm install -g openclaw@2026.6.11
npm install -g open-computer-use@0.1.54
```

### 第四步：安装 Ollama（可选，用于本地模型）

1. 下载: https://ollama.com/download/windows
2. 安装后按需拉取你要用的本地模型，例如: `ollama pull <你的模型名>`
   然后在 ClawAI「模型配置」中添加该模型并填写到老师/学生字段

### 第五步：配置 API Key

```powershell
cd ClawAI
copy config\openclaw.json.example openclaw.json
notepad openclaw.json
# 将 YOUR_AGNES_API_KEY_HERE 替换为你的实际 Key
```

获取 API Key: https://agnes-ai.com/zh-Hans/docs/agnes-video-v20

### 第六步：启动

```powershell
# 方式1: 双击 start-gateway.bat
# 方式2: 命令行
.\start-gateway.bat
# 方式3: Node.js 启动
node start-gateway.js
```

启动成功后，网关监听 `http://127.0.0.1:18789`

## 验证安装

```powershell
# 检查 MCP 服务器
openclaw mcp doctor
openclaw mcp probe

# 检查插件
openclaw plugins list

# 检查 Gateway
curl http://127.0.0.1:18789/v1/models
```

## 常见问题

### Q: npm install 报错
A: 确保 Node.js 版本 ≥ 20，尝试 `npm cache clean --force`

### Q: Gateway 启动失败
A: 检查端口 18789 是否被占用: `netstat -ano | findstr 18789`

### Q: 微信渠道无法连接
A: 需要配置微信账号凭证，详见 `openclaw-weixin/` 目录

### Q: 视频生成仍然只有 5 秒
A: 确认使用的是更新后的 `media-cli/agnes-media-cli.js`
