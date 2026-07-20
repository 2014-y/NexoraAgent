---
name: video-generator
description: Generate videos using agnes-ai video API. Supports duration, resolution, fps, aspect ratio. Saves to $env:USERPROFILE/.openclaw/media-output/
---

# Video Generator

Generate short videos using the agnes-ai video API.

## 鈿狅笍 IMPORTANT: Always specify --duration

The default duration is 5 seconds. If the user requests a specific duration, you MUST pass `--duration N`. Never omit this flag when the user specifies a length.

## Usage

```bash
node "%USERPROFILE%/.openclaw/media-cli/agnes-media-cli.js" video --prompt "鎻忚堪" [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--prompt` | Video description (required) | - |
| `--duration` | Duration in seconds | 5 |
| `--resolution` | 480p, 720p, or 1080p | 720p |
| `--fps` | Frames per second | 24 |
| `--aspect` | 16:9, 9:16, 1:1, or 4:3 | 16:9 |
| `--model` | Model to use | agnes-video-v2.0 |

## Examples

```bash
# Generate a 5-second 720p video (default duration)
node "%USERPROFILE%/.openclaw/media-cli/agnes-media-cli.js" video --prompt "a golden retriever playing in the park"

# Generate a 20-second 720p horizontal video
node "%USERPROFILE%/.openclaw/media-cli/agnes-media-cli.js" video --prompt "a golden retriever playing in the park" --duration 20

# Generate a 10-second 1080p vertical video
node "%USERPROFILE%/.openclaw/media-cli/agnes-media-cli.js" video --prompt "a beautiful sunset over the ocean" --duration 10 --resolution 1080p --aspect 9:16
```

## Output

Video files are saved to `$env:USERPROFILE/.openclaw/media-output/` as `video_<timestamp>.mp4`.

After generation, upload the video file to the chat.
