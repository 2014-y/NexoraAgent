---
name: image-generator
description: Generate images using agnes-ai image API. Supports size, quality, count. Saves to $env:USERPROFILE/.openclaw/media-output/
---

# Image Generator

Generate images using the agnes-ai image API.

## Usage

```bash
node "%USERPROFILE%/.openclaw/media-cli/agnes-media-cli.js" image --prompt "鎻忚堪" [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--prompt` | Image description (required) | - |
| `--model` | agnes-image-2.0-flash or agnes-image-2.1-flash | agnes-image-2.0-flash |
| `--size` | 512x512, 1024x1024, 1024x1792, or 1792x1024 | 1024x1024 |
| `--quality` | standard or hd | standard |
| `--count` | Number of images (1-4) | 1 |

## Examples

```bash
# Generate a standard image
node "%USERPROFILE%/.openclaw/media-cli/agnes-media-cli.js" image --prompt "a cute cat sitting on a windowsill"

# Generate 2 HD images
node "%USERPROFILE%/.openclaw/media-cli/agnes-media-cli.js" image --prompt "a modern living room interior" --quality hd --count 2
```

## Output

Image files are saved to `$env:USERPROFILE/.openclaw/media-output/` as `image_<timestamp>_<n>.png`.

After generation, upload the image files to the chat.
