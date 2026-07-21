/**
 * agnes-media-cli.js
 * CLI for multi-vendor image and video generation via media-core.
 */

import { generateImage, generateVideo } from "./media-core/index.js";

function getArg(name, argv) {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || !["video", "image"].includes(cmd)) {
    console.error("Usage: node agnes-media-cli.js video|image --prompt \"...\" [options]");
    process.exit(1);
  }

  try {
    let res;
    if (cmd === "video") {
      const prompt = getArg("prompt", argv);
      if (!prompt) throw new Error("Missing --prompt");
      res = await generateVideo({
        prompt,
        model: getArg("model", argv),
        duration: getArg("duration", argv) != null ? Number(getArg("duration", argv)) : undefined,
        resolution: getArg("resolution", argv),
        fps: getArg("fps", argv) != null ? Number(getArg("fps", argv)) : undefined,
        aspect_ratio: getArg("aspect", argv),
        image_url: getArg("image_url", argv) || getArg("image", argv),
      });
    } else {
      const prompt = getArg("prompt", argv);
      if (!prompt) throw new Error("Missing --prompt");
      res = await generateImage({
        prompt,
        model: getArg("model", argv),
        size: getArg("size", argv),
        quality: getArg("quality", argv),
        n: getArg("count", argv) != null ? Number(getArg("count", argv)) : undefined,
      });
    }
    console.log(JSON.stringify(res));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
    process.exit(1);
  }
}

main();
