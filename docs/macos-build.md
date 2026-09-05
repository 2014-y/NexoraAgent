# macOS 构建与验证

Nexora Agent 可以在 macOS 上构建 `.app`、`.dmg` 和 `.zip`。Apple Silicon 和 Intel 分别使用原生构建环境，不混用两种架构的 `node_modules` 或网关运行时。

## 本地构建

要求：

- macOS 13.5 或更新版本（内置 Node 24 的最低系统版本）。
- 与目标架构相同的官方 Node.js >= 24.15.0，建议 24.18.0；可通过 nvm 或 CI 的 `actions/setup-node` 安装。
- Xcode Command Line Tools，用于原生模块构建。

```sh
npm install --registry=https://registry.npmjs.org --no-audit --no-fund
npm run app:dist:mac
```

Apple Silicon 的产物为 `dist/Nexora-Agent-<version>-mac-arm64.dmg` 和 `.zip`，Intel 为 `...-mac-x64.dmg` 和 `.zip`。`.app` 在 `dist/mac-arm64/` 或 `dist/mac/`。若清理脚本启用了备用输出目录，产物位于 `dist-release/`。

在相同架构的 Mac 或 CI runner 上运行同一命令即可构建对应架构。不要在 arm64 的安装目录直接加 `--x64` 打包，Node、语音库、终端模块和网关依赖必须与 Electron 的架构一致。

## 包内运行时

Mac 构建会从构建机器的 Node 安装中复制 Node 和 npm 到 `.node-sandbox`，校验 Node 不依赖 Homebrew 等非系统动态库，生成便携 npm/npx 入口，然后一同收入 `gateway-runtime.tar`。应用首次运行时解压到自身可写的运行时目录。最终用户启动应用无需另装 Node/npm，也不依赖终端 shell 的 PATH。

macOS 专用 electron-builder 配置不要求 Windows 的 Wintun、NSIS、离线语音资源；`node-pty` 会在打包前针对当前 Electron 重建。语音原生库会打包，离线语音识别和语音包模型仍需按应用功能另行准备，不能把“语音库加载成功”等同于语音功能已完成验证。

默认数据配置继续兼容已有 OpenClaw 目录。若需独立运行，可设置 `OPENCLAW_HOME` 为专用目录；其配置文件位于该目录的 `.openclaw/openclaw.json`。使用已运行 OpenClaw 的电脑时，应先设置不冲突的 `gateway.port`。

## 验证

```sh
npm test
npm run verify:mac
```

`app:dist:mac` 完成后会自动执行 `verify:mac`，检查运行时归档的必要文件，在仅有 `/usr/bin:/bin:/usr/sbin:/sbin` 的 PATH 下执行包内 Node、npm、OpenClaw CLI，并通过包内 Electron 加载 SQLite、语音原生库及实际创建 PTY 子进程。

CI 已有 Apple Silicon 和 Intel macOS runner；Mac 构建脚本自行准备 Node/npm 和原生模块。未实际跑过的架构不能当作已经验证。

## 签名、公证与功能边界

没有 Developer ID 的本地构建用于开发测试；正式对外分发需要 Apple Developer 的 Developer ID Application 签名与 Apple 公证。不要把仅打包成功视为通过 Gatekeeper 分发验证。配置签名/公证凭据后，需移除 CI 中禁用证书自动发现的设置，并按照 Electron/electron-builder 的官方流程签名和公证。

参考：https://www.electronjs.org/docs/latest/tutorial/code-signing

Mac 版检查到新版本时打开官方 Releases 页面供用户下载对应架构安装包，不执行 Windows EXE 自动覆盖安装。

桌面操作、屏幕捕获、麦克风等能力仍受 macOS 系统授权约束；Windows PowerShell 自动化脚本不能直接在 Mac 上使用。本次打包支持不代表所有 Windows 专有能力已逐项迁移或验证。
