# ClawAI 开源版

<p align="center">
  <img src="config/icon.ico" width="80" height="80" alt="ClawAI Logo" />
</p>

<p align="center">
  <strong>基于 Electron + OpenClaw 的本地零依赖 AI 智能网关控制台，支持一键运行、免置 Key 大模型和多渠道聊天接入。</strong>
</p>

<p align="center">
  <a href="https://github.com/2014-y/ClawAI/releases"><img src="https://img.shields.io/github/v/release/2014-y/ClawAI?color=purple&label=Release" alt="Latest Release" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D24.x-green?logo=node.js" alt="Node Version" /></a>
  <a href="https://github.com/electron/electron"><img src="https://img.shields.io/badge/Electron-Latest-blue?logo=electron" alt="Electron Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-orange" alt="License" /></a>
</p>

---

## 🌟 核心特性与独创优化

本项目为原本复杂的 AI 网关服务提供了极简的可视化桌面控制端。为了彻底消除小白用户的部署门槛并保护内置资产，我们实现了一系列核心特性的深度重构与定制：

### 1. 🔌 零依赖一键运行（小白神器）
* **免除全局环境**：用户电脑上无需预先安装任何 Node.js、Git 或 Python 运行环境。
* **内置绿色沙箱**：集成高度优化且自愈的 `.node-sandbox`。脚本会在首次启动时自动建立独立的绿色 Node/npm 执行空间，避免破坏用户的系统级环境变量。
* **预装微信渠道**：预先内置了微信通道插件 `@tencent-weixin/openclaw-weixin`。新用户安装后点击“绑定微信”可**秒级渲染出登录二维码，扫码即用，100% 避免因连网下载插件导致的卡死崩溃**。

### 2. 🔑 内置大模型（开箱即用 + 安全锁）
* **免置 Key 调用**：配置模板默认集成并内置了官方有效的 Agnes AI 服务密钥，普通用户无需进行繁琐的大模型平台注册、绑定和 Key 的配置，一键启动直接可聊。
* **内置密钥防护**：
  * **禁止查看**：前端界面已彻底移除内置大模型厂商的明文查看眼睛按钮。
  * **禁止复制与导出**：密钥输入框被设为 `readonly` 并强制重写底层事件，**全面拦截选择、复制、剪切以及鼠标右键动作，实现密钥资产的物理隔离保护**。

### 3. 📉 可视化用量监控与 Token 卫士
* **底层流量拦截**：基于原生 Node.js 实现的 API 请求代理劫持。每次发起 AI 调用时，后台的 `patch_gateway.js` 会自动截获 prompt（输入）和 completion（输出）的 Tokens 消耗，并记录估计成本。
* **本地化数据库**：所有用量数据记录于本地 `real_tokens.json` 数据库，完全离线与安全。
* **精美看板绘制**：前端以可视化折线图和统计指标直接反映 Token 消耗、总体请求和缓存命中率。

### 4. 🎨 UI 界面与交互重构
* **厂商卡片顶置**：内置大模型通道 `agnes-ai` 强制在模型配置卡片列表中最顶层渲染。
* **默认折叠**：所有通道卡片默认保持折叠，并支持通过点击卡片标题栏或折叠按钮自由展收，极大节省页面空间。
* **物理锁定**：内置的 `agnes-ai` 和默认的 `ollama` 通道卡片在界面上被强制物理上锁，移除了删除按钮，禁止用户误删除。

> [!TIP]
> **💡 魔法网络加速**：如在下载依赖、拉取模型或访问大模型 API 时遇到网络困难，可使用推荐的 [网络加速通道](https://pin.dianping.men/auth/register?code=2k788U5v)（注册即可获取极速网络环境支持）。

---

## 📥 极速下载与安装（普通用户）

1. **下载安装包**：前往本项目的 **[GitHub Releases 页面](https://github.com/2014-y/ClawAI/releases)** 下载最新版本的单文件安装程序 `ClawAI Setup <Version>.exe`。
2. **简易安装**：双击运行安装包。安装程序会展开解压细节日志，允许你自由选择安装到指定的盘符或目录（例如 D 盘等）。
3. **极速使用**：
   * 打开软件，在右侧面板点击 **「启动网关」**，等待状态灯变绿。
   * 点击右下角的 **「绑定微信」** 按钮，在弹出的窗口中直接用手机微信扫码。
   * 绑定成功后，在微信中直接向助手发送消息，或者邀请助手入群，即可开聊！

---

## 🛠️ 开发者快速上手（二次开发）

### 1. 克隆并进入目录
```bash
git clone https://github.com/2014-y/ClawAI.git
cd ClawAI
```

### 2. 初始化开发环境沙箱
在项目根目录双击运行 `init.bat`（或使用终端运行 `.\init.ps1`）。它会自动拉起独立 Node 绿色沙箱，并复制所需模块和配置模板。

### 3. 运行调试
```bash
# 启动 Electron 桌面客户端进行调试
npm run app:start

# 或者手动通过脚本起网关（已修复自动关联本地 node_modules 依赖）
start-gateway.bat
```

### 4. 打包分发发布
如果你修改了界面样式或主进程代码，可通过以下命令一键编译生成 Windows 独立安装包：
```bash
# 编译生成 NSIS 单文件安装包 (输出在 dist 目录下)
npm run app:dist
```

---

## 📑 工程关键文件导览

* `main.js`：Electron 主进程逻辑（控制网关子进程拉起、微信登录 IPC 通信、静默升级）。
* `renderer.js`：前端交互逻辑（厂商列表顶置、折叠与展收、大模型密钥屏蔽与防复制、用量曲线图绘制）。
* `patch_gateway.js`：网关 HTTP/HTTPS 请求底层拦截层（Token 卫士，自动捕获流量计算 Token 写入本地）。
* `init.ps1` / `init.bat`：绿色沙箱自愈与环境初始化脚本。
* `start-gateway.bat` / `start-gateway.ps1`：已修护的支持脱离全局 Node 独立拉起网关的本地脚本。

---

## 📜 开源协议

本项目遵循 [MIT License](LICENSE) 开源许可协议。
