# 安装指南

> 从零开始，一步步把 AI-v24.13.0 跑起来。

---

## 目录

- [前置条件](#前置条件)
- [第一步：安装 Node.js](#第一步安装-nodejs)
- [第二步：下载项目](#第二步下载项目)
- [第三步：运行 init.bat](#第三步运行-initbat)
- [第四步：配置 API Key](#第四步配置-api-key)
- [第五步：启动 Gateway](#第五步启动-gateway)
- [第六步：安装 openclaw（如果提示找不到）](#第六步安装-openclaw如果提示找不到)
- [常见问题](#常见问题)

---

## 前置条件

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10 或 Windows 11 |
| 内存 | 4GB 以上 |
| 硬盘 | 2GB 可用空间 |
| 网络 | 需要联网（用于调用 AI API） |

---

## 第一步：安装 Node.js

AI-v24.13.0 需要 Node.js v24.x 才能运行。

### 方法一：nvm-windows（推荐）

nvm 可以让你管理多个 Node.js 版本，互不干扰。

**1. 下载 nvm-windows**

浏览器访问：https://github.com/coreybutler/nvm-windows/releases

下载最新的 
vm-setup.exe。

**2. 安装**

双击 
vm-setup.exe，一路点击"下一步"完成安装。

**3. 安装 Node.js v24**

打开 CMD（命令提示符），依次运行：

`ash
nvm install 24
nvm use 24
`

**4. 验证**

`ash
node -v
`

应显示 24.x.x。

### 方法二：官方安装包

**1. 下载**

浏览器访问：https://nodejs.org

选择 LTS 版本，点击下载。

**2. 安装**

双击安装包，一路"下一步"完成安装。

**3. 验证**

打开 CMD：

`ash
node -v
npm -v
`

应分别显示版本号。

---

## 第二步：下载项目

### 方式一：下载 ZIP

1. 浏览器访问：https://github.com/2014-y/AI-v24.13.0
2. 点击绿色 **"Code"** 按钮
3. 选择 **"Download ZIP"**
4. 解压到任意目录（如 D:\\ai\\AI-v24.13.0（任意目录均可））

### 方式二：Git clone

`ash
git clone https://github.com/2014-y/AI-v24.13.0.git
cd AI-v24.13.0
`

---

## 第三步：运行 init.bat

1. 打开项目文件夹
2. **双击 init.bat**

等待完成，看到 "Setup complete!" 即成功。

init.bat 会自动完成：
- 检测本机 Node.js
- 创建 .node-sandbox/ 目录
- 生成配置文件 C:\Users\<你的用户名>\.openclaw\openclaw.json

---

## 第四步：配置 API Key

1. 打开文件管理器，进入 C:\Users\<你的用户名>\.openclaw\
2. 用记事本打开 openclaw.json
3. 按 Ctrl + H 搜索并替换：

| 搜索 | 替换为 | 说明 |
|------|--------|------|
| YOUR_AGNES_API_KEY_HERE | 你的 Agnes AI Key | 必填 |
| YOUR_YITONG_API_KEY_HERE | 你的阿里云 Key | 选填 |
| YOUR_ZHIPU_API_KEY_HERE | 你的智谱 Key | 选填 |

4. 按 Ctrl + S 保存。

**获取 API Key：**
- Agnes AI：https://agnes-ai.com/zh-Hans/docs/agnes-video-v20
- 阿里云百炼：https://dashscope.console.aliyun.com/
- 智谱 AI：https://open.bigmodel.cn/

---

## 第五步：启动 Gateway

1. 打开项目文件夹
2. **双击 start-gateway.bat**
3. 看到 "http server listening on port 18789" 即启动成功

---

## 第六步：安装 openclaw（如果提示找不到）

如果启动时报错 openclaw not found，说明你的电脑上没有安装 openclaw。

**手动安装方法：**

打开 CMD，进入项目目录：

`ash
cd <项目目录>
npm install -g openclaw@2026.6.11
`

等待安装完成（可能需要几分钟），然后重新双击 start-gateway.bat。

---

## 常见问题

### Q: 双击 init.bat 没反应？
**A:** 右键 → 以管理员身份运行。

### Q: 提示 "Node.js not found"？
**A:** 先安装 Node.js，见第一步。

### Q: 提示 "openclaw not found"？
**A:** 运行 
pm install -g openclaw@2026.6.11 安装。

### Q: npm 命令找不到？
**A:** 说明 Node.js 没装好，重新安装 Node.js。

### Q: 端口 18789 被占用？
**A:** 先关闭占用该端口的程序，再启动 Gateway。
