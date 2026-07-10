# INSTALL.md

# AI-v24.13.0 寮€婧愮増 - 瀹夎鎸囧崡

## 绯荤粺瑕佹眰

- **鎿嶄綔绯荤粺**: Windows 10/11 (64-bit)
- **Node.js**: v24.x (鎺ㄨ崘 v24.13.0)
- **纾佺洏绌洪棿**: 鈮?500MB
- **鍐呭瓨**: 鈮?2GB RAM

## 蹇€熷畨瑁?
### 绗竴姝ワ細瀹夎 NVM for Windows

1. 涓嬭浇: https://github.com/coreybutler/nvm-windows/releases
2. 瀹夎 nvm-setup.exe
3. 楠岃瘉: `nvm version`

### 绗簩姝ワ細瀹夎 Node.js v24.13.0

```powershell
nvm install 24.13.0
nvm use 24.13.0
node --version  # 搴旀樉绀?v24.13.0
```

### 绗笁姝ワ細瀹夎鍏ㄥ眬渚濊禆

```powershell
npm install -g openclaw@2026.6.11
npm install -g open-computer-use@0.1.54
```

### 绗洓姝ワ細瀹夎 Ollama锛堝彲閫夛紝鐢ㄤ簬鏈湴妯″瀷锛?
1. 涓嬭浇: https://ollama.com/download/windows
2. 瀹夎鍚庤繍琛? `ollama pull gemma4:latest`

### 绗簲姝ワ細閰嶇疆 API Key

```powershell
cd AI-v24.13.0-寮€婧愮増
copy config\openclaw.json.example openclaw.json
notepad openclaw.json
# 灏?YOUR_AGNES_API_KEY_HERE 鏇挎崲涓轰綘鐨勫疄闄?Key
```

鑾峰彇 API Key: https://agnes-ai.com/zh-Hans/docs/agnes-video-v20

### 绗叚姝ワ細鍚姩

```powershell
# 鏂瑰紡1: 鍙屽嚮 start-gateway.bat
# 鏂瑰紡2: 鍛戒护琛?.\start-gateway.bat
# 鏂瑰紡3: Node.js 鍚姩
node start-gateway.js
```

鍚姩鎴愬姛鍚庯紝缃戝叧鐩戝惉 `http://127.0.0.1:18789`

## 楠岃瘉瀹夎

```powershell
# 妫€鏌?MCP 鏈嶅姟鍣?openclaw mcp doctor
openclaw mcp probe

# 妫€鏌ユ彃浠?openclaw plugins list

# 妫€鏌?Gateway
curl http://127.0.0.1:18789/v1/models
```

## 甯歌闂

### Q: npm install 鎶ラ敊
A: 纭繚 Node.js 鐗堟湰 鈮?20锛屽皾璇?`npm cache clean --force`

### Q: Gateway 鍚姩澶辫触
A: 妫€鏌ョ鍙?18789 鏄惁琚崰鐢? `netstat -ano | findstr 18789`

### Q: 寰俊娓犻亾鏃犳硶杩炴帴
A: 闇€瑕侀厤缃井淇¤处鍙峰嚟璇侊紝璇﹁ `openclaw-weixin/` 鐩綍

### Q: 瑙嗛鐢熸垚浠嶇劧鍙湁 5 绉?A: 纭浣跨敤鐨勬槸鏇存柊鍚庣殑 `media-cli/agnes-media-cli.js`
