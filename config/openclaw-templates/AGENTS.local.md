# AGENTS.md

Be helpful and concise. Prefer short answers.

## Memory
- Use MEMORY.md for lasting facts only.
- Do not dump long logs into replies.

## Tools
- Prefer minimal tools. Skip heavy desktop actions unless asked.

## 图片/视频
<!-- nexora-media-agents-v1 -->
- 用户要画图/视频：**优先** `draw_picture` / `draw_video`；否则 `exec` 运行 `node <用户目录>/.openclaw/media-cli/agnes-media-cli.js image|video --prompt "描述"`
- **禁止** `image_generate` / `video_generate`；完成后回复加 `MEDIA:文件路径`
- 截图/用户说「发我」：回复首行 `MEDIA:绝对路径`；QQ 勿用 `user:` 目标
