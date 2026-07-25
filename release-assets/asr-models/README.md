# 离线语音识别发版资源

- 文件：`sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2`（约 220MB）
- 来源：[sherpa-onnx ASR models](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2)

## 用途

- **不会**打进 Electron asar / 安装包本体
- **`npm run app:dist` 之后**复制到 `dist/`，与 Setup.exe 同级，方便上传 GitHub Release
- 大文件默认 **不提交进 Git**（GitHub 普通仓库约 100MB 上限；LFS 需账号配额）

## 本地补齐（发版前）

```bash
npm run asr:ensure
# 或
node scripts/ensure-asr-release-asset.js
```

打包：

```bash
npm run app:dist
```

完成后在 `dist/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2` 取文件，上传到该版本的 GitHub Release Assets。

用户也可在应用「语音管理 → 本地导入」选择本压缩包导入。

## 若要用 Git LFS 存进仓库

账号需有足够的 Git LFS 存储/带宽配额后，再把 `release-assets/asr-models/*.tar.bz2` 纳入 LFS 跟踪并推送。
