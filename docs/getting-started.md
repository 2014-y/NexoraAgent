# AI-v24.13.0 完整使用流程

> 从下载项目到微信聊天，跟着做就行。

---

## 整体流程一览

`
下载项目 --> 运行 init.bat --> 编辑 openclaw.json --> 运行 start-gateway.bat --> 用微信聊天
`

共 **4 步**，每步不超过 2 分钟。

---

## 第 0 步：安装 Node.js（如果还没有）

打开 CMD，运行：

`ash
node -v
`

如果显示版本号（如 v24.13.0），跳过这一步。

如果没有，去 https://github.com/coreybutler/nvm-windows/releases 下载 nvm-windows，安装后运行：

`ash
nvm install 24
nvm use 24
`

---

## 第 1 步：初始化项目

1. 从 GitHub 下载项目（或 clone）
2. 解压后，双击 **init.bat**
3. 看到 "Setup complete!" 就说明成功了

init.bat 做了什么：
- 在你的电脑上找到 Node.js
- 把 node.exe 复制到项目的 .node-sandbox/ 目录（不影响全局 node）
- 生成配置文件 C:\Users\<你的用户名>\.openclaw\openclaw.json

---

## 第 2 步：配置 API Key

1. 打开文件管理器，进入 C:\Users\<你的用户名>\.openclaw\
2. 用记事本打开 openclaw.json
3. 搜索 YOUR_*_API_KEY_HERE
4. 把占位符替换成你自己的真实 API Key

| 需要替换的 | 去哪里获取 |
|-----------|-----------|
| YOUR_AGNES_API_KEY_HERE | https://agnes-ai.com/zh-Hans/docs/agnes-video-v20 |
| YOUR_YITONG_API_KEY_HERE | https://dashscope.console.aliyun.com/ |
| YOUR_ZHIPU_API_KEY_HERE | https://open.bigmodel.cn/ |

> 至少需要配置一个 API Key 才能正常使用。Agnes AI 是推荐的默认模型。

---

## 第 3 步：启动 Gateway

1. 双击 **start-gateway.bat**
2. 看到 "Starting..." 和日志输出，说明正在启动
3. 看到端口 **18789** 监听，就说明成功了

此时你可以：
- 通过浏览器访问 http://localhost:18789 测试
- 继续配置微信接入

---

## 第 4 步：接入微信（可选）

详细教程见 [微信接入教程](./wechat-guide.md)。

快速步骤：
1. 运行 
px -y @tencent-weixin/openclaw-weixin-cli install
2. 运行 openclaw channels login --channel openclaw-weixin
3. 用微信扫描二维码
4. 登录成功！

---

## 第 5 步：配置本地模型（可选）

如果你想用 Ollama 运行本地离线模型：

### 5.1 安装 Ollama

1. 访问 https://ollama.com 下载 Windows 安装包
2. 安装完成后，Ollama 会自动启动并在后台运行
3. 验证：打开 CMD，运行 ollama --version，应显示版本号

### 5.2 拉取基础模型

在 CMD 中运行：

`ash
ollama pull gemma3:27b
`

这会在本地下载一个约 16GB 的模型文件（首次使用需要耐心等待下载）。

### 5.3 构建 Jarvis 自定义模型

项目自带一个 jarvis-modelfile.txt，它定义了 Jarvis 助手的系统提示词。在 CMD 中运行：

`ash
cd <项目目录>
ollama create jarvis -f jarvis-modelfile.txt
`

这会根据 gemma3:27b 创建一个名为 jarvis 的自定义模型。

### 5.4 验证模型

运行以下命令确认模型已安装：

`ash
ollama list
`

你应该看到 jarvis 和 gemma3:27b 都在列表中。

### 5.5 测试本地模型

`ash
ollama run jarvis "你好，你是谁？"
`

如果回答正常，说明本地模型配置成功。

> **注意**：本地模型不需要联网，所有推理都在你的电脑上完成，隐私性最好。但需要较好的硬件配置（建议 32GB 以上内存，独立显卡更佳）。

---

## 日常使用

### 启动

每次开机后，双击 start-gateway.bat 即可。

### 停止

关闭 Gateway 窗口即可。

### 重启

先杀掉旧进程（start-gateway.bat 会自动做），再双击 start-gateway.bat。

### 查看日志

日志保存在 C:\Users\<你的用户名>\.openclaw\logs\ 目录下。

---

## 故障排查

| 问题 | 解决方法 |
|------|---------|
| 双击后窗口闪退 | 先运行 init.bat |
| 提示 "Node not found" | 安装 Node.js v24+ |
| 提示 "Missing config" | 运行 init.bat 重新生成配置 |
| 微信连不上 | 检查 Gateway 是否在运行 |
| API Key 错误 | 编辑 openclaw.json 检查 Key 是否正确 |
| 端口被占用 | 关闭其他 Gateway 实例，再启动 |
| Ollama 模型拉取失败 | 检查网络连接，或更换镜像源 |
| 本地模型回答慢 | 减少并发请求，或换用小模型 |
