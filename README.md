# Nexora Agent

<p align="center">
  <img src="config/icon.ico" width="96" height="96" alt="Nexora Agent Logo" />
</p>

<p align="center">
  <strong>本地 AI 智能助手桌面版</strong><br/>
  安装即可用 · 不用会写代码 · 微信 / QQ / 飞书一键接入
</p>

<p align="center">
  <a href="docs/getting-started.md">新手入门</a> ·
  <a href="docs/install-guide.md">安装说明</a> ·
  <a href="docs/wechat-guide.md">微信接入</a> ·
  <a href="https://github.com/2014-y/Nexora-Agent/releases">下载安装包</a>
</p>

---

## 它是什么？

**Nexora Agent** 是一个跑在你自己电脑上的 **AI 助手控制台**。

用大白话说：

1. 你在电脑上安装并打开它  
2. 点一下「启动」  
3. 用手机扫码绑定微信 / QQ / 飞书  
4. 之后别人给你发消息，**AI 会自动帮忙回复**

你**不需要**：

- 会写代码  
- 自己安装 Node.js  
- 懂复杂的服务器配置  

软件会自己准备好运行环境，开箱即用。

---

## 能做什么？

| 你想做的事 | Nexora Agent 怎么帮你 |
| :--- | :--- |
| 让微信自动回复 | 扫码绑定微信，私聊即可对话 |
| 换不同大模型 | 在「模型配置」里填 API Key，选模型 |
| 让 AI 记住你 | 内置长期记忆，重要信息可写进本地记忆文件 |
| 看看花了多少钱 | 「用量监控」用图表显示 Token 消耗 |
| 加新能力 | 「内置插件」里一键开关联网搜索等功能 |

---

## 三分钟上手（普通用户请看这里）

> 详细图文步骤见：[新手入门教程](docs/getting-started.md)

### ① 下载并安装

1. 打开 [Releases 下载页](https://github.com/2014-y/Nexora-Agent/releases)  
2. 下载最新的 `Nexora Agent Setup x.x.x.exe`  
3. 双击安装（若 Windows 提示“未知发布者”，点 **更多信息 → 仍要运行**）  
4. 完成安装后，桌面会出现 **Nexora Agent** 图标  

### ② 启动服务

1. 打开 Nexora Agent  
2. 点击左上角 **「启动 Nexora Agent」**  
3. 看状态灯：

| 颜色 | 含义 | 你要做什么 |
| :--- | :--- | :--- |
| 红 | 未启动 | 点「启动」 |
| 黄 | 正在启动 | 等一会儿 |
| 绿 | 已就绪 | 可以开始用了 |

### ③ 绑定聊天软件（以微信为例）

1. 进入 **「通讯管理」**  
2. 在微信卡片上点 **扫码绑定**  
3. 手机微信扫屏幕上的二维码并确认  
4. 卡片变成「已绑定」后，用另一台手机/微信给它发消息测试  

完整微信步骤：[微信接入教程](docs/wechat-guide.md)

### ④ 填上大模型 API Key（非常重要）

没有 API Key，AI 无法回答问题。

1. 打开左侧 **「模型配置」**  
2. 按提示填写你的 Key（如 DeepSeek、通义、智谱等）  
3. 保存后再试对话  

---

## 文档导航（按你的情况选）

| 你是谁 | 该看哪一篇 |
| :--- | :--- |
| 第一次用，只想装上跑起来 | [新手入门](docs/getting-started.md) |
| 安装出问题、端口占用等 | [安装说明 + 排错](docs/install-guide.md) |
| 想接微信 / QQ / 飞书 | [微信与多渠道接入](docs/wechat-guide.md) |
| 开发者：源码调试 / 打包 | 见下方「开发者」小节，或 [安装说明 · 第 7 节](docs/install-guide.md#7-开发者从源码安装与打包) |

---

## 常见问题（先看会省很多时间）

**Q：一直红灯，启动不了？**  
先完全退出软件 → 任务管理器结束多余的 `node.exe` → 再打开点启动。详见[安装说明 · 排错](docs/install-guide.md)。

**Q：扫了码，微信没反应？**  
确认状态灯是**绿色**，微信卡片显示**已绑定**，并且你已经在「模型配置」里填了可用的 API Key。

**Q：提示端口 18789 被占用？**  
说明旧进程没退干净。关掉 Nexora Agent，结束残留 `node.exe`，再重开。

**Q：换电脑数据会丢吗？**  
安装目录可以换电脑带走；配置和记忆默认在用户目录（如 `%USERPROFILE%\.openclaw`）和 `%LOCALAPPDATA%\NexoraAgent`，备份这两个位置即可。

更多问答写在各篇文档末尾。

---

## 开发者（可选）

> 普通用户**不需要**看这一节。

```bash
git clone https://github.com/2014-y/Nexora-Agent.git
cd Nexora-Agent
npm install
npm run app:start          # 本地调试桌面端
npm run app:dist           # 打出 Windows 安装包 → dist/
```

更细的打包与排错见 [安装说明 · 开发者](docs/install-guide.md#7-开发者从源码安装与打包)。

---

## 许可证

[MIT License](LICENSE)
