# 瀹夎鎸囧崡

> 浠庨浂寮€濮嬶紝涓€姝ユ鎶?AI-v24.13.0 璺戣捣鏉ャ€?

---

## 鐩綍

- [鍓嶇疆鏉′欢](#鍓嶇疆鏉′欢)
- [绗竴姝ワ細瀹夎 Node.js](#绗竴姝ュ畨瑁?nodejs)
- [绗簩姝ワ細涓嬭浇椤圭洰](#绗簩姝ヤ笅杞介」鐩?
- [绗笁姝ワ細杩愯 init.bat](#绗笁姝ヨ繍琛?initbat)
- [绗洓姝ワ細閰嶇疆 API Key](#绗洓姝ラ厤缃?api-key)
- [绗簲姝ワ細鍚姩 Gateway](#绗簲姝ュ惎鍔?gateway)
- [绗叚姝ワ細瀹夎 openclaw锛堝鏋滄彁绀烘壘涓嶅埌锛塢(#绗叚姝ュ畨瑁?openclaw濡傛灉鎻愮ず鎵句笉鍒?
- [甯歌闂](#甯歌闂)

---

## 鍓嶇疆鏉′欢

| 椤圭洰 | 瑕佹眰 |
|------|------|
| 鎿嶄綔绯荤粺 | Windows 10 鎴?Windows 11 |
| 鍐呭瓨 | 4GB 浠ヤ笂 |
| 纭洏 | 2GB 鍙敤绌洪棿 |
| 缃戠粶 | 闇€瑕佽仈缃戯紙鐢ㄤ簬璋冪敤 AI API锛?|

---

## 绗竴姝ワ細瀹夎 Node.js

AI-v24.13.0 闇€瑕?Node.js v24.x 鎵嶈兘杩愯銆?

### 鏂规硶涓€锛歯vm-windows锛堟帹鑽愶級

nvm 鍙互璁╀綘绠＄悊澶氫釜 Node.js 鐗堟湰锛屼簰涓嶅共鎵般€?

**1. 涓嬭浇 nvm-windows**

娴忚鍣ㄨ闂細https://github.com/coreybutler/nvm-windows/releases

涓嬭浇鏈€鏂扮殑 
vm-setup.exe銆?

**2. 瀹夎**

鍙屽嚮 
vm-setup.exe锛屼竴璺偣鍑?涓嬩竴姝?瀹屾垚瀹夎銆?

**3. 瀹夎 Node.js v24**

鎵撳紑 CMD锛堝懡浠ゆ彁绀虹锛夛紝渚濇杩愯锛?

`ash
nvm install 24
nvm use 24
`

**4. 楠岃瘉**

`ash
node -v
`

搴旀樉绀?24.x.x銆?

### 鏂规硶浜岋細瀹樻柟瀹夎鍖?

**1. 涓嬭浇**

娴忚鍣ㄨ闂細https://nodejs.org

閫夋嫨 LTS 鐗堟湰锛岀偣鍑讳笅杞姐€?

**2. 瀹夎**

鍙屽嚮瀹夎鍖咃紝涓€璺?涓嬩竴姝?瀹屾垚瀹夎銆?

**3. 楠岃瘉**

鎵撳紑 CMD锛?

`ash
node -v
npm -v
`

搴斿垎鍒樉绀虹増鏈彿銆?

---

## 绗簩姝ワ細涓嬭浇椤圭洰

### 鏂瑰紡涓€锛氫笅杞?ZIP

1. 娴忚鍣ㄨ闂細https://github.com/2014-y/AI-v24.13.0
2. 鐐瑰嚮缁胯壊 **"Code"** 鎸夐挳
3. 閫夋嫨 **"Download ZIP"**
4. 瑙ｅ帇鍒颁换鎰忕洰褰曪紙濡?<项目目录>锛堜换鎰忕洰褰曞潎鍙級锛?

### 鏂瑰紡浜岋細Git clone

`ash
git clone https://github.com/2014-y/AI-v24.13.0.git
cd AI-v24.13.0
`

---

## 绗笁姝ワ細杩愯 init.bat

1. 鎵撳紑椤圭洰鏂囦欢澶?
2. **鍙屽嚮 init.bat**

绛夊緟瀹屾垚锛岀湅鍒?"Setup complete!" 鍗虫垚鍔熴€?

init.bat 浼氳嚜鍔ㄥ畬鎴愶細
- 妫€娴嬫湰鏈?Node.js
- 鍒涘缓 .node-sandbox/ 鐩綍
- 鐢熸垚閰嶇疆鏂囦欢 C:\Users\<浣犵殑鐢ㄦ埛鍚?\.openclaw\openclaw.json

---

## 绗洓姝ワ細閰嶇疆 API Key

1. 鎵撳紑鏂囦欢绠＄悊鍣紝杩涘叆 C:\Users\<浣犵殑鐢ㄦ埛鍚?\.openclaw\
2. 鐢ㄨ浜嬫湰鎵撳紑 openclaw.json
3. 鎸?Ctrl + H 鎼滅储骞舵浛鎹細

| 鎼滅储 | 鏇挎崲涓?| 璇存槑 |
|------|--------|------|
| YOUR_AGNES_API_KEY_HERE | 浣犵殑 Agnes AI Key | 蹇呭～ |
| YOUR_YITONG_API_KEY_HERE | 浣犵殑闃块噷浜?Key | 閫夊～ |
| YOUR_ZHIPU_API_KEY_HERE | 浣犵殑鏅鸿氨 Key | 閫夊～ |

4. 鎸?Ctrl + S 淇濆瓨銆?

**鑾峰彇 API Key锛?*
- Agnes AI锛歨ttps://agnes-ai.com/zh-Hans/docs/agnes-video-v20
- 闃块噷浜戠櫨鐐硷細https://dashscope.console.aliyun.com/
- 鏅鸿氨 AI锛歨ttps://open.bigmodel.cn/

---

## 绗簲姝ワ細鍚姩 Gateway

1. 鎵撳紑椤圭洰鏂囦欢澶?
2. **鍙屽嚮 start-gateway.bat**
3. 鐪嬪埌 "http server listening on port 18789" 鍗冲惎鍔ㄦ垚鍔?

---

## 绗叚姝ワ細瀹夎 openclaw锛堝鏋滄彁绀烘壘涓嶅埌锛?

濡傛灉鍚姩鏃舵姤閿?openclaw not found锛岃鏄庝綘鐨勭數鑴戜笂娌℃湁瀹夎 openclaw銆?

**鎵嬪姩瀹夎鏂规硶锛?*

鎵撳紑 CMD锛岃繘鍏ラ」鐩洰褰曪細

`ash
cd <椤圭洰鐩綍>
npm install -g openclaw@2026.6.11
`

绛夊緟瀹夎瀹屾垚锛堝彲鑳介渶瑕佸嚑鍒嗛挓锛夛紝鐒跺悗閲嶆柊鍙屽嚮 start-gateway.bat銆?

---

## 甯歌闂

### Q: 鍙屽嚮 init.bat 娌″弽搴旓紵
**A:** 鍙抽敭 鈫?浠ョ鐞嗗憳韬唤杩愯銆?

### Q: 鎻愮ず "Node.js not found"锛?
**A:** 鍏堝畨瑁?Node.js锛岃绗竴姝ャ€?

### Q: 鎻愮ず "openclaw not found"锛?
**A:** 杩愯 
pm install -g openclaw@2026.6.11 瀹夎銆?

### Q: npm 鍛戒护鎵句笉鍒帮紵
**A:** 璇存槑 Node.js 娌¤濂斤紝閲嶆柊瀹夎 Node.js銆?

### Q: 绔彛 18789 琚崰鐢紵
**A:** 鍏堝叧闂崰鐢ㄨ绔彛鐨勭▼搴忥紝鍐嶅惎鍔?Gateway銆?
