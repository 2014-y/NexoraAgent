# INSTALL.md

# AI-v24.13.0 开源版 - 安装指南

## 系统要求

- **操作系统**: Windows 10/11 (64-bit)
- **Node.js**: v24.x (推荐 v24.13.0)
- **磁盘空间**: ≥ 500MB
- **内存**: ≥ 2GB RAM

## 快速安装

### 第一步：安装 NVM for Windows

1. 下载: https://github.com/coreybutler/nvm-windows/releases
2. 安装 nvm-setup.exe
3. 验证: `nvm version`

### 第二步：安装 Node.js v24.13.0

```powershell
nvm install 24.13.0
nvm use 24.13.0
node --version  # 应显示 v24.13.0
```

### 第三步：安装全局依赖

```powershell
npm install -g openclaw@2026.6.11
npm install -g open-computer-use@0.1.54
```

### 第四步：安装 Ollama（可选，用于本地模型）

1. 下载: https://ollama.com/download/windows
2. 安装后运行: `ollama pull gemma4:latest`

### 第五步：配置 API Key

```powershell
cd AI-v24.13.0-开源版
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
