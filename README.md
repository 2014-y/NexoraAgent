# Nexora Agent

<p align="center">
  <img src="config/icon.ico" width="96" height="96" alt="Nexora Agent Logo" />
</p>

<p align="center">
  <strong>专为小白打造的本地 AI 智能助手桌面版</strong><br/>
  一键安装 · 零代码基础 · 微信 / QQ / 飞书 无缝接入
</p>

<p align="center">
  <a href="https://github.com/2014-y/NexoraAgent/releases">
    <img src="https://img.shields.io/github/v/release/2014-y/NexoraAgent?style=flat-square&color=33cd56&label=最新版本" alt="Release" />
  </a>
  <a href="https://github.com/2014-y/NexoraAgent/releases">
    <img src="https://img.shields.io/github/downloads/2014-y/NexoraAgent/total?style=flat-square&color=fcb32c&label=下载量" alt="Downloads" />
  </a>
  <a href="https://github.com/2014-y/NexoraAgent/stargazers">
    <img src="https://img.shields.io/github/stars/2014-y/NexoraAgent?style=flat-square&color=0078d7&label=Stars" alt="Stars" />
  </a>
  <a href="https://github.com/2014-y/NexoraAgent/blob/master/LICENSE">
    <img src="https://img.shields.io/github/license/2014-y/NexoraAgent?style=flat-square&color=ff69b4&label=开源协议" alt="License" />
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows-0078d7?style=flat-square&logo=windows" alt="Windows" />
  <img src="https://img.shields.io/badge/Framework-Electron-47848f?style=flat-square&logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/Language-JavaScript-f7df1e?style=flat-square&logo=javascript&logoColor=black" alt="JavaScript" />
</p>

<p align="center">
  <a href="docs/getting-started.md">新手入门</a> ·
  <a href="docs/install-guide.md">安装说明</a> ·
  <a href="docs/wechat-guide.md">微信接入</a> ·
  <a href="https://github.com/2014-y/ClawAI/releases">下载安装包</a>
</p>

---

## 🌟 它是做什么的？（大白话简介）

**Nexora Agent** 是一个能够跑在你这台电脑上的 **全自动 AI 助手控制台**。

如果你曾经想过：“要是能有一个 AI 帮我自动回复微信消息、帮我处理群聊问题，甚至能记住我的喜好该多好啊！” 那么 Nexora Agent 就是为你量身定制的。

**最核心的亮点是：你完全不需要懂编程代码！**
传统上，想要做一个微信机器人或者飞书机器人，你需要自己租服务器、装环境、写代码、配置复杂的后台。而现在，你只需要：
1. 双击安装本软件。
2. 点击软件界面上的「启动」按钮。
3. 填入你喜欢的 AI 模型（比如 DeepSeek、通义千问等）的密钥。
4. 掏出手机扫个码。
一切就搞定了！你的专属 AI 助手就能立即开始在你的微信或飞书上替你大展身手。

---

## 🚀 为什么选择 Nexora Agent？（我们的核心优势）

我们致力于把复杂的 AI 技术门槛降到最低，让每个人都能拥有自己的超级助理。

- **🟢 真正的“开箱即用”**
  无需安装 Node.js，无需配置环境变量，无需敲命令行。所有复杂的运行环境我们都已经打包在这个桌面软件里了。安装即用，就像装个聊天软件一样简单。
  
- **🔒 数据掌握在自己手中**
  整个核心网关和程序都运行在你自己的本地电脑上。你的聊天记录、记忆库文件、运行日志统统只存在你自己的硬盘里，最大程度保障了你的隐私安全。

- **💬 多平台一键打通**
  不仅支持微信，还支持飞书、QQ 等常见的通讯软件。你可以在一个软件面板里集中管理所有的 AI 接入渠道，扫个码就能让 AI 接管回复。

- **🧠 拥有“超长记忆”与“插件扩展”**
  不只是个只会一问一答的“呆板机器人”。Nexora Agent 内置了强大的长期记忆功能，它会越用越懂你。同时，通过内置的插件系统，你可以一键让 AI 拥有联网搜索、读取网页等超级能力。

- **📊 贴心的可视化控制台**
  拥有非常美观、直观的图形界面。你的 AI 花了多少钱（Token 用量监控）、当前服务的运行状态、实时的日志流水、各个通道的在线情况，看一眼仪表盘就全明白了。

---

## ⚙️ 它是怎么工作的？（运行流程揭秘）

对于想稍微了解一点原理的朋友，我们的运行流程非常简单清晰：

1. **大脑中枢（AI 模型）**：你在软件里配置好第三方大模型的 API Key（这就像是给你的助手装上了大脑）。
2. **本地网关（Nexora Agent 服务）**：点击启动后，软件会在你的电脑后台悄悄开启一个“调度中心”。
3. **触角延伸（聊天软件接入）**：当你扫码绑定微信/飞书后，“调度中心”就伸出了触角。
4. **全自动闭环**：朋友发来微信 -> 触角抓取消息 -> 发送给调度中心 -> 调度中心整理好背景记忆后交给“大脑” -> 大脑给出回答 -> 调度中心再通过触角把文字发回给朋友微信。

这整个流转过程都是在我们为你打包好的环境里全自动完成的，你只需要在好看的界面上按几个按钮就行。

---

## 👣 极简实现步骤（手把手教你跑起来）

> 详细图文步骤见：[新手入门教程](docs/getting-started.md)

### 第一步：下载并安装
1. 打开 [Releases 下载页](https://github.com/2014-y/ClawAI/releases) 
2. 下载最新的 `.exe` 结尾的安装包。
3. 双击安装（如果 Windows 弹窗拦截提示“未知发布者”，点击 **更多信息 -> 仍要运行** 即可）。
4. 安装完成后，在桌面找到 **Nexora Agent** 图标并打开。

### 第二步：启动本地服务
1. 进入软件后，点击左上角醒目的 **「启动 Nexora Agent」** 按钮。
2. 观察指示灯：**红灯**变**黄灯**（正在启动），最后变成**绿灯**（启动成功）。
3. 只要绿灯亮起，就说明你电脑上的“调度中心”已经完美运行了！

### 第三步：配置 AI 的大脑（关键环节）
没有大脑，AI 是没法思考的。
1. 点击左侧菜单栏的 **「模型配置」**。
2. 按照界面提示，填入你获取到的 API Key（比如去各大平台免费申请的 Key）。
3. 点击保存。

### 第四步：扫码接入微信/飞书
1. 点击左侧的 **「通讯管理」** 菜单。
2. 找到你要接入的平台（比如微信），点击卡片上的 **「扫码绑定」**。
3. 用手机上的聊天软件扫描电脑屏幕上弹出的二维码。
4. 绑定成功后，卡片会显示绿色的“已连接”。
**搞定！现在拿另一台手机或者让朋友发条消息测试一下吧！**

---

## 💡 给小白用户的几个关键要点（避坑指南）

- **必须保持软件运行**：既然是运行在你自己的电脑上，那么想要 AI 一直能回复，电脑就不能关机，Nexora Agent 软件也不能退出，必须保持在这个「绿灯」启动状态。
- **配置模型才能聊天**：不要忘了在「模型配置」里填写大模型的 API 密钥，否则 AI 接到消息也会处于“不知道怎么思考”的宕机状态。
- **遇到问题先重启**：如果你发现状态灯一直是黄色或者红色，大部分情况是因为之前没正常退出。彻底关闭软件，在电脑的任务管理器里把多余的 `node.exe` 进程结束掉，再重新打开软件点启动，99% 的问题都能解决。

---

## 📚 文档导航（按需查阅）

| 你的需求 | 推荐阅读 |
| :--- | :--- |
| **我是小白，只想赶紧用上** | 👉 [新手图文入门指南](docs/getting-started.md) |
| **安装时弹报错、端口被占用了** | 👉 [安装与排错说明](docs/install-guide.md) |
| **我想专门看微信是怎么扫码接入的** | 👉 [微信与多渠道接入教程](docs/wechat-guide.md) |
| **我想自己改代码、自己打包** | 👉 见下方「开发者」小节，或 [开发者手册](docs/install-guide.md#7-开发者从源码安装与打包) |

---

## 👨‍💻 给开发者的说明（普通用户可忽略）

如果你懂代码，想要进行二次开发或者自己尝试打包：

```bash
# 1. 克隆代码仓库
git clone https://github.com/2014-y/ClawAI.git
cd Nexora-Agent

# 2. 安装项目依赖
npm install

# 3. 本地启动开发模式，进行界面和逻辑调试
npm run app:start

# 4. 一键打包成 Windows 安装包（输出到 dist 目录）
npm run app:dist
```

更详细的二次开发规范与打包排错请参阅 [安装说明 · 开发者](docs/install-guide.md#7-开发者从源码安装与打包)。

---

## 📄 许可证协议

本项目采用 [MIT License](LICENSE) 开源许可协议。
