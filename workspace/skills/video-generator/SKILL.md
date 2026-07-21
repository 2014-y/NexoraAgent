---
name: video-generator
description: Generate videos using agnes-ai video API. Prefer the draw_video tool; CLI is fallback. Supports duration, resolution, fps, aspect ratio.
---

# Video Generator

Generate short videos using the agnes-ai video API.

## Preferred: `draw_video` tool

When available, call the `draw_video` tool with at least `prompt`.  
Generation often takes **2–10 minutes** — wait for completion; do not cancel early.  
When done, include a first-line `MEDIA:<absolute filepath>` in the reply so the channel can deliver the file.  
Never output placeholders like `[[video]]` or `[[video_media]]`.

## Fallback CLI

```bash
node "%USERPROFILE%/.openclaw/media-cli/agnes-media-cli.js" video --prompt "描述" [options]
```

Use `exec` with `timeout` **≥ 600** and `process poll` until finished.

## IMPORTANT: Always specify --duration when user asks

The default duration is 5 seconds. If the user requests a specific duration, you MUST pass `--duration N` (or the tool `duration` param). Never omit it when the user specifies a length.

## Options

| Flag / param | Description | Default |
|--------------|-------------|---------|
| `prompt` / `--prompt` | Video description (required) | - |
| `duration` / `--duration` | Duration in seconds | 5 |
| `resolution` / `--resolution` | 480p, 720p, or 1080p | 720p |
| `fps` / `--fps` | Frames per second | 24 |
| `aspect_ratio` / `--aspect` | 16:9, 9:16, 1:1, or 4:3 | 16:9 |
| `model` / `--model` | Model to use | agnes-video-v2.0 |

## Examples

```bash
# Generate a 5-second 720p video (default duration)
node "%USERPROFILE%/.openclaw/media-cli/agnes-media-cli.js" video --prompt "a golden retriever playing in the park"

# Generate a 20-second 720p horizontal video
node "%USERPROFILE%/.openclaw/media-cli/agnes-media-cli.js" video --prompt "a golden retriever playing in the park" --duration 20

# Generate a 10-second 1080p vertical video
node "%USERPROFILE%/.openclaw/media-cli/agnes-media-cli.js" video --prompt "a beautiful sunset over the ocean" --duration 10 --resolution 1080p --aspect 9:16
```

## Configuration

Provider settings live in `%USERPROFILE%/.openclaw/video-generator.json`:

| Field | Description |
|-------|-------------|
| `provider` | Optional. `agnes-video`, `openai-video`, `generic-video`, `gateway-video`, `custom-video`, or a name from `media-providers.json` |
| `apiBase` | API endpoint (auto-detected if omitted) |
| `apiKey` | Bearer token (omit for built-in Agnes keys) |
| `model` | Model id |
| `providerOptions` | Poll URL template, field mapping, etc. |

Custom vendors: copy `config/media-providers.json.example` to `%USERPROFILE%/.openclaw/media-providers.json`, define your provider, then set `"provider": "your-provider-id"` in `video-generator.json`.

## Output

Plugin saves to `$env:USERPROFILE/.openclaw/video-output/` as `video_<timestamp>.mp4`.  
CLI may save under `media-output/`. Always use the path returned by the tool/CLI in `MEDIA:`.
