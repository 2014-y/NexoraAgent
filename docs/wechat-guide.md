# 微信接入完整教程（傻瓜式）

> 本文档教你一步步把 AI 助手接入微信，全程只需 5 分钟。

---

## 目录

- [前置条件](#前置条件)
- [第一步：安装微信插件](#第一步安装微信插件)
- [第二步：扫码登录](#第二步扫码登录)
- [第三步：配置白名单（可选）](#第三步配置白名单可选)
- [常见问题](#常见问题)

---

## 前置条件

- 已完成初始化，Gateway 已启动（端口 18789 监听中）
- 手机上已安装微信
- 已安装 @tencent-weixin/openclaw-weixin 插件

---

## 第一步：安装微信插件

打开 CMD 或 PowerShell，进入项目目录，执行：

```bash
cd D:\ai\AI-v24.13.0
npx -y @tencent-weixin/openclaw-weixin-cli install
```

如果提示找不到 npx，请先安装 Node.js。

安装完成后，编辑配置文件 C:\Users\<你的用户名>\.openclaw\openclaw.json，确保微信插件已启用：

```json
"plugins": {
    "entries": {
        "openclaw-weixin": {
            "enabled": true
        }
    }
}
```

然后重启 Gateway：

```bash
openclaw gateway restart
```

---

## 第二步：扫码登录

在 CMD 中执行：

```bash
cd D:\ai\AI-v24.13.0
openclaw channels login --channel openclaw-weixin
```

屏幕上会出现一个 **二维码**，用微信扫一下，在手机端确认登录。

登录成功后，你会看到类似这样的提示：

```
WeChat account logged in successfully
Account: wxid_xxxxxxxx
```

**重要**：扫码登录的电脑必须保持 Gateway 运行状态，否则微信会掉线。

---

## 第三步：配置白名单（可选）

默认情况下，任何人都可以通过私聊跟你 AI 助手对话。如果你想限制只有特定人能对话：

```bash
# 列出已授权的联系人
openclaw pairing list openclaw-weixin

# 批准某个联系人
openclaw pairing approve openclaw-weixin <CODE>

# 拒绝某个联系人
openclaw pairing deny openclaw-weixin <CODE>
```

---

## 常见问题

### Q: 扫不出二维码？
**A:** 确保 Gateway 正在运行，且微信插件已安装。运行 openclaw plugins list 检查。

### Q: 登录后微信立刻掉线？
**A:** 检查是否在同一台电脑上运行 Gateway。不要同时用多个客户端登录同一个微信账号。

### Q: 收不到消息？
**A:** 检查 openclaw.json 中 plugins.entries.openclaw-weixin.enabled 是否为 true。

### Q: 想接多个微信号？
**A:** 每个微信号单独执行一次 openclaw channels login --channel openclaw-weixin 即可。

### Q: 插件版本不兼容？
**A:** 运行以下命令更新：
```bash
npm view @tencent-weixin/openclaw-weixin version
openclaw plugins install "@tencent-weixin/openclaw-weixin" --force
openclaw gateway restart
```
