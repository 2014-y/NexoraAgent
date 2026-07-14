## [1.0.9] - 2026-07-12

### Added
- **简体中文默认锁定**：将语言偏好默认锁定为简体中文，在设置中隐藏了“界面语言首选项”防止误改。
- **安装释放日志自动展开**：通过注入 `installer.nsh` 自定义脚本，实现安装/卸载过程中文件释放细节的自动完全展开。
- **出品公司与图标强绑定**：定制发布商名称为“ClawAI”，全方位锁定安装器和控制面板图标为项目专属机器人图标。

### Changed
- **精简插件卡片**：在插件开关面板中隐去暂时无须呈现的“微信渠道”、“语音通话”、“Telegram”、“WhatsApp”卡片。
- **打包体积暴跌 80% 优化**：在 `package.json` 的 `build.files` 中排除了重型开发调试包，最终发布包极度轻量化。

## [1.0.8] - 2026-07-10

### Fixed
- 修复 init.ps1 中 NVM 版本硬编码（v24.13.0）
- 清除 7 个 .md 文档的 UTF-8 BOM
- 所有脚本零硬编码路径，所有文件零 BOM

# CHANGELOG

# ClawAI 变更日志

## [1.0.0] - 2026-07-07

### 新增
- OpenClaw 2026.6.11 网关
- Agnes-AI 大模型集成 (agnes-2.0-flash, agnes-1.5-flash)
- Ollama 本地模型支持（按用户在模型配置中添加）
- MCP Computer Use 桌面控制 (9 个工具)
- 微信/WhatsApp 多渠道消息
- 双模型训练插件 (Teacher-Student 蒸馏)
- 记忆核心插件
- 语音通话插件
- 图像/视频生成 CLI (支持 30 秒+ 视频)
- 20+ 技能包 (video-generator, image-generator, humanize-cli 等)
- 健康检查插件
- Cron 定时调度
- 一键启动脚本 (bat/ps1/sh/js)

### 修复
- 视频生成 duration→num_frames 转换 bug (原返回 5 秒 → 现支持 30 秒+)
- MCP 服务器路径配置问题
- API Key 轮询机制优化

### 技术栈
- Node.js v24.13.0
- OpenClaw 2026.6.11
- open-computer-use 0.1.54
- Agnes-AI API
- SQLite (会话存储)
## [1.0.1] - 2026-07-08

### 修复
- **Computer Use 桌面控制解除后鼠标键盘失灵** (严重)
  - 根因：`open-computer-use.exe` 原生进程在管道关闭后未正确退出，持续持有鼠标/键盘独占锁
  - 修复：在 `computer-use-client.mjs` 中新增 `cleanupOrphanedComputerUseProcesses()` 清理函数
  - 修补 `NativePipeComputerUseClient.close()` — 在 finally 块中调用清理
  - 修补 `NativePipeComputerUseTransport.close()` — 关闭 socket 后等待 500ms 再清理
  - 注册 `process.on("exit")` 兜底清理 — Node.js 进程退出时强制终止残留进程
  - 影响：Windows 平台，修复后解除控制时自动清理残留进程，恢复正常输入

