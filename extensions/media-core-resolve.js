import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveMediaCoreEntry() {
  const stateDir = process.env.OPENCLAW_STATE_DIR
    || path.join(process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || "", ".openclaw");

  const candidates = [
    path.join(__dirname, "media-core", "index.js"),
    path.join(__dirname, "..", "media-core", "index.js"),
    path.join(__dirname, "..", "..", "media-cli", "media-core", "index.js"),
    path.join(stateDir, "extensions", "media-core", "index.js"),
    path.join(stateDir, "media-cli", "media-core", "index.js"),
  ].filter(Boolean);

  for (const entry of candidates) {
    if (entry && fs.existsSync(entry)) return entry;
  }

  throw new Error("media-core not found; restart Nexora Agent to sync media runtime");
}

let cached = null;

export async function loadMediaCore() {
  if (!cached) {
    const entry = resolveMediaCoreEntry();
    cached = await import(pathToFileURL(entry).href);
  }
  return cached;
}
