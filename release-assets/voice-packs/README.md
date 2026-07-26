# 发版语音资源（不进安装包 asar）

当前应用默认朗读：**微软 Edge 在线云扬**（无需离线大包）。

本目录文件在 `npm run app:dist` 后会复制到 `dist/`，与 Setup.exe 同级，方便上传 GitHub Release。

## 本地生成

```bash
npm run voice:ensure
```

会生成：

- `yunyang-edge-tts-demo.mp3` — 云扬试听
- `云扬在线TTS说明.txt` — 发版说明
