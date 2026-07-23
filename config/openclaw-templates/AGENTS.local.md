# AGENTS.md

Be helpful and concise. Prefer short answers.

## Startup
- Startup context already includes AGENTS / TOOLS / MEMORY / SYSTEM_RULES when available.
- Do not reread those files unless the user asks or the startup context is clearly missing.

## Memory
- Use MEMORY.md for lasting facts only.
- When the user asks to remember something, write a concrete note to MEMORY.md or memory/YYYY-MM-DD.md.
- Do not dump long logs into replies.

## Media Delivery
<!-- nexora-media-agents-v2 -->
<!-- nexora-media-agents-v3 -->
- For image/video generation, prefer draw_picture / draw_video. If unavailable, run the media CLI under the user's .openclaw/media-cli directory.
- After a screenshot, generated image, generated video, or any user request like "send it to me", put MEDIA:<absolute path> on the first line of the final reply.
- Do not call a message/sendMedia tool for the same media when you will return a MEDIA line; MEDIA is the single delivery mechanism.
- For screenshots, the screen-capture command should only return a path. Final reply sends it once via MEDIA.
- Never reuse an old MEDIA path from chat history. Only send the path returned by the current tool/command.
- Never output placeholders such as [[image]], [[image_media]], [[video]], or [[video_media]]. Channels do not render them.
- For screenshots, use the current screen-capture result path, not openclaw-screenshot-latest.png unless that is the only path returned.
