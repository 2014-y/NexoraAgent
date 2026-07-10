# AI-v24.13.0 瀹屾暣浣跨敤娴佺▼

> 浠庝笅杞介」鐩埌寰俊鑱婂ぉ锛岃窡鐫€鍋氬氨琛屻€?

---

## 鏁翠綋娴佺▼涓€瑙?

`
涓嬭浇椤圭洰 --> 杩愯 init.bat --> 缂栬緫 openclaw.json --> 杩愯 start-gateway.bat --> 鐢ㄥ井淇¤亰澶?
`

鍏?**4 姝?*锛屾瘡姝ヤ笉瓒呰繃 2 鍒嗛挓銆?

---

## 绗?0 姝ワ細瀹夎 Node.js锛堝鏋滆繕娌℃湁锛?

鎵撳紑 CMD锛岃繍琛岋細

`ash
node -v
`

濡傛灉鏄剧ず鐗堟湰鍙凤紙濡?v24.13.0锛夛紝璺宠繃杩欎竴姝ャ€?

濡傛灉娌℃湁锛屽幓 https://github.com/coreybutler/nvm-windows/releases 涓嬭浇 nvm-windows锛屽畨瑁呭悗杩愯锛?

`ash
nvm install 24
nvm use 24
`

---

## 绗?1 姝ワ細鍒濆鍖栭」鐩?

1. 浠?GitHub 涓嬭浇椤圭洰锛堟垨 clone锛?
2. 瑙ｅ帇鍚庯紝鍙屽嚮 **init.bat**
3. 鐪嬪埌 "Setup complete!" 灏辫鏄庢垚鍔熶簡

init.bat 鍋氫簡浠€涔堬細
- 鍦ㄤ綘鐨勭數鑴戜笂鎵惧埌 Node.js
- 鎶?node.exe 澶嶅埗鍒伴」鐩殑 .node-sandbox/ 鐩綍锛堜笉褰卞搷鍏ㄥ眬 node锛?
- 鐢熸垚閰嶇疆鏂囦欢 C:\Users\<浣犵殑鐢ㄦ埛鍚?\.openclaw\openclaw.json

---

## 绗?2 姝ワ細閰嶇疆 API Key

1. 鎵撳紑鏂囦欢绠＄悊鍣紝杩涘叆 C:\Users\<浣犵殑鐢ㄦ埛鍚?\.openclaw\
2. 鐢ㄨ浜嬫湰鎵撳紑 openclaw.json
3. 鎼滅储 YOUR_*_API_KEY_HERE
4. 鎶婂崰浣嶇鏇挎崲鎴愪綘鑷繁鐨勭湡瀹?API Key

| 闇€瑕佹浛鎹㈢殑 | 鍘诲摢閲岃幏鍙?|
|-----------|-----------|
| YOUR_AGNES_API_KEY_HERE | https://agnes-ai.com/zh-Hans/docs/agnes-video-v20 |
| YOUR_YITONG_API_KEY_HERE | https://dashscope.console.aliyun.com/ |
| YOUR_ZHIPU_API_KEY_HERE | https://open.bigmodel.cn/ |

> 鑷冲皯闇€瑕侀厤缃竴涓?API%USERPROFILE%\\.openclaw*18789** 鐩戝惉锛屽氨璇存槑鎴愬姛浜?

姝ゆ椂浣犲彲浠ワ細
- 閫氳繃娴忚鍣ㄨ闂?http://localhost:18789 娴嬭瘯
- 缁х画閰嶇疆寰俊鎺ュ叆

---

## 绗?4 姝ワ細鎺ュ叆寰俊锛堝彲閫夛級

璇︾粏鏁欑▼瑙?[寰俊鎺ュ叆鏁欑▼](./wechat-guide.md)銆?

蹇€熸楠わ細
1. 杩愯 
px -y @tencent-weixin/openclaw-weixin-cli install
2. 杩愯 openclaw channels login --channel openclaw-weixin
3. 鐢ㄥ井淇℃壂鎻忎簩缁寸爜
4. 鐧诲綍鎴愬姛锛?

---

## 绗?5 姝ワ細閰嶇疆鏈湴妯″瀷锛堝彲閫夛級

濡傛灉浣犳兂鐢?Ollama 杩愯鏈湴绂荤嚎妯″瀷锛?

### 5.1 瀹夎 Ollama

1. 璁块棶 https://ollama.com 涓嬭浇 Windows 瀹夎鍖?
2. 瀹夎瀹屾垚鍚庯紝Ollama 浼氳嚜鍔ㄥ惎鍔ㄥ苟鍦ㄥ悗鍙拌繍琛?
3. 楠岃瘉锛氭墦寮€ CMD锛岃繍琛?ollama --version锛屽簲鏄剧ず鐗堟湰鍙?

### 5.2 鎷夊彇鍩虹妯″瀷

鍦?CMD 涓繍琛岋細

`ash
ollama pull gemma3:27b
`

杩欎細鍦ㄦ湰鍦颁笅杞戒竴涓害 16GB 鐨勬ā鍨嬫枃浠讹紙棣栨浣跨敤闇€瑕佽€愬績绛夊緟涓嬭浇锛夈€?

### 5.3 鏋勫缓 Jarvis 鑷畾涔夋ā鍨?

椤圭洰鑷甫涓€涓?jarvis-modelfile.txt锛屽畠瀹氫箟浜?Jarvis 鍔╂墜鐨勭郴缁熸彁绀鸿瘝銆傚湪 CMD 涓繍琛岋細

`ash
cd <椤圭洰鐩綍>
ollama create jarvis -f jarvis-modelfile.txt
`

杩欎細鏍规嵁 gemma3:27b 鍒涘缓涓€涓悕涓?jarvis 鐨勮嚜瀹氫箟妯″瀷銆?

### 5.4 楠岃瘉妯″瀷

杩愯浠ヤ笅鍛戒护纭妯″瀷宸插畨瑁咃細

`ash
ollama list
`

浣犲簲璇ョ湅鍒?jarvis 鍜?gemma3:27b 閮藉湪鍒楄〃涓€?

### 5.5 娴嬭瘯鏈湴妯″瀷

`ash
ollama run jarvis "浣犲ソ锛屼綘鏄皝锛?
`

濡傛灉鍥炵瓟姝ｅ父锛岃鏄庢湰鍦版ā鍨嬮厤缃垚鍔熴€?

> **娉ㄦ剰**锛氭湰鍦版ā鍨嬩笉闇€瑕佽仈缃戯紝鎵€鏈夋帹鐞嗛兘鍦ㄤ綘鐨勭數鑴戜笂瀹屾垚锛岄殣绉佹€ф渶濂姐€備絾闇€瑕佽緝濂界殑纭欢閰嶇疆锛堝缓璁?32GB 浠ヤ笂鍐呭瓨锛岀嫭绔嬫樉鍗℃洿浣筹級銆?

---

## 鏃ュ父浣跨敤

### 鍚姩

姣忔寮€鏈哄悗锛屽弻鍑?start-gateway.bat 鍗冲彲銆?

### 鍋滄

鍏抽棴 Gateway 绐楀彛鍗冲彲銆?

### 閲嶅惎

鍏堟潃鎺夋棫杩涚▼锛坰tart-gateway.bat 浼氳嚜鍔ㄥ仛锛夛紝鍐嶅弻鍑?start-gateway.bat銆?

### 鏌ョ湅鏃ュ織

鏃ュ織淇濆瓨鍦?C:\Users\<浣犵殑鐢ㄦ埛鍚?\.openclaw\logs\ 鐩綍涓嬨€?

---

## 鏁呴殰鎺掓煡

| 闂 | 瑙ｅ喅鏂规硶 |
|------|---------|
| 鍙屽嚮鍚庣獥鍙ｉ棯閫€ | 鍏堣繍琛?init.bat |
| 鎻愮ず "Node not found" | 瀹夎 Node.js v24+ |
| 鎻愮ず "Missing config" | 杩愯 init.bat 閲嶆柊鐢熸垚閰嶇疆 |
| 寰俊杩炰笉涓?| 妫€鏌?Gateway 鏄惁鍦ㄨ繍琛?|
| API Key 閿欒 | 缂栬緫 openclaw.json 妫€鏌?Key 鏄惁姝ｇ‘ |
| 绔彛琚崰鐢?| 鍏抽棴鍏朵粬 Gateway 瀹炰緥锛屽啀鍚姩 |
| Ollama 妯″瀷鎷夊彇澶辫触 | 妫€鏌ョ綉缁滆繛鎺ワ紝鎴栨洿鎹㈤暅鍍忔簮 |
| 鏈湴妯″瀷鍥炵瓟鎱?| 鍑忓皯骞跺彂璇锋眰锛屾垨鎹㈢敤灏忔ā鍨?|
%USERPROFILE%\\.openclaw