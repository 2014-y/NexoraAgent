# 寰俊鎺ュ叆瀹屾暣鏁欑▼锛堝偦鐡滃紡锛?

> 鏈枃妗ｆ暀浣犱竴姝ユ鎶?AI 鍔╂墜鎺ュ叆寰俊锛屽叏绋嬪彧闇€ 5 鍒嗛挓銆?

---

## 鐩綍

- [鍓嶇疆鏉′欢](#鍓嶇疆鏉′欢)
- [绗竴姝ワ細瀹夎寰俊鎻掍欢](#绗竴姝ュ畨瑁呭井淇℃彃浠?
- [绗簩姝ワ細鎵爜鐧诲綍](#绗簩姝ユ壂鐮佺櫥褰?
- [绗笁姝ワ細閰嶇疆鐧藉悕鍗曪紙鍙€夛級](#绗笁姝ラ厤缃櫧鍚嶅崟鍙€?
- [甯歌闂](#甯歌闂)

---

## 鍓嶇疆鏉′欢

- 宸插畬鎴愬垵濮嬪寲锛孏ateway 宸插惎鍔紙绔彛 18789 鐩戝惉涓級
- 鎵嬫満涓婂凡瀹夎寰俊
- 宸插畨瑁?@tencent-weixin/openclaw-weixin 鎻掍欢

---

## 绗竴姝ワ細瀹夎寰俊鎻掍欢

鎵撳紑 CMD 鎴?PowerShell锛岃繘鍏ラ」鐩洰褰曪紝鎵ц锛?

```bash
cd <椤圭洰鐩綍>
npx -y @tencent-weixin/openclaw-weixin-cli install
```

濡傛灉鎻愮ず鎵句笉鍒?npx锛岃鍏堝畨瑁?Node.js銆?

瀹夎瀹屾垚鍚庯紝缂栬緫閰嶇疆鏂囦欢 C:\Users\<浣犵殑鐢ㄦ埛鍚?\.openclaw\openclaw.json锛岀‘淇濆井淇℃彃浠跺凡鍚敤锛?

```json
"plugins": {
    "entries": {
        "openclaw-weixin": {
            "enabled": true
        }
    }
}
```

鐒跺悗閲嶅惎 Gateway锛?

```bash
openclaw gateway restart
```

---

## 绗簩姝ワ細鎵爜鐧诲綍

鍦?CMD 涓墽琛岋細

```bash
cd <椤圭洰鐩綍>
openclaw channels login --channel openclaw-weixin
```

灞忓箷涓婁細鍑虹幇涓€涓?**浜岀淮鐮?*锛岀敤寰俊鎵竴涓嬶紝鍦ㄦ墜鏈虹纭鐧诲綍銆?

鐧诲綍鎴愬姛鍚庯紝浣犱細鐪嬪埌绫讳技杩欐牱鐨勬彁绀猴細

```
WeChat account logged in successfully
Account: wxid_xxxxxxxx
```

**閲嶈**锛氭壂鐮佺櫥褰曠殑鐢佃剳蹇呴』淇濇寔 Gateway 杩愯鐘舵€侊紝鍚﹀垯寰俊浼氭帀绾裤€?

---

## 绗笁姝ワ細閰嶇疆鐧藉悕鍗曪紙鍙€夛級

榛樿鎯呭喌涓嬶紝浠讳綍浜洪兘鍙互閫氳繃绉佽亰璺熶綘 AI 鍔╂墜瀵硅瘽銆傚鏋滀綘鎯抽檺鍒跺彧鏈夌壒瀹氫汉鑳藉璇濓細

```bash
# 鍒楀嚭宸叉巿鏉冪殑鑱旂郴浜?
openclaw pairing list openclaw-weixin

# 鎵瑰噯鏌愪釜鑱旂郴浜?
openclaw pairing approve openclaw-weixin <CODE>

# 鎷掔粷鏌愪釜鑱旂郴浜?
openclaw pairing deny openclaw-weixin <CODE>
```

---

## 甯歌闂

### Q: 鎵笉鍑轰簩缁寸爜锛?
**A:** 纭繚 Gateway 姝ｅ湪杩愯锛屼笖寰俊鎻掍欢宸插畨瑁呫€傝繍琛?openclaw plugins list 妫€鏌ャ€?

### Q: 鐧诲綍鍚庡井淇＄珛鍒绘帀绾匡紵
**A:** 妫€鏌ユ槸鍚﹀湪鍚屼竴鍙扮數鑴戜笂杩愯 Gateway銆備笉瑕佸悓鏃剁敤澶氫釜瀹㈡埛绔櫥褰曞悓涓€涓井淇¤处鍙枫€?

### Q: 鏀朵笉鍒版秷鎭紵
**A:** 妫€鏌?openclaw.json 涓?plugins.entries.openclaw-weixin.enabled 鏄惁涓?true銆?

### Q: 鎯虫帴澶氫釜寰俊鍙凤紵
**A:** 姣忎釜寰俊鍙峰崟鐙墽琛屼竴娆?openclaw channels login --channel openclaw-weixin 鍗冲彲銆?

### Q: 鎻掍欢鐗堟湰涓嶅吋瀹癸紵
**A:** 杩愯浠ヤ笅鍛戒护鏇存柊锛?
```bash
npm view @tencent-weixin/openclaw-weixin version
openclaw plugins install "@tencent-weixin/openclaw-weixin" --force
openclaw gateway restart
```
