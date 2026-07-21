import path from "node:path";
import os from "node:os";

export function resolveStateDir() {
  return (
    process.env.OPENCLAW_STATE_DIR
    || path.join(
      process.env.OPENCLAW_HOME || process.env.USERPROFILE || process.env.HOME || os.homedir(),
      ".openclaw"
    )
  );
}

export function normalizeImageApiBase(apiBase) {
  const b = String(apiBase || "").trim().replace(/\/$/, "");
  if (!b) return "https://apihub.agnes-ai.com/v1/images/generations";
  if (b.endsWith("/images/generations")) return b;
  if (b.endsWith("/images")) return `${b}/generations`;
  if (b.endsWith("/v1")) return `${b}/images/generations`;
  if (!b.includes("/generations")) return `${b}/generations`;
  return b;
}

export function normalizeVideoApiBase(apiBase) {
  const b = String(apiBase || "").trim().replace(/\/$/, "");
  if (!b) return "https://apihub.agnes-ai.com/v1/videos";
  if (b.endsWith("/videos")) return b;
  if (b.endsWith("/v1")) return `${b}/videos`;
  return b;
}

export function cleanModelId(model) {
  const m = String(model || "").trim();
  if (!m) return m;
  return m.includes("/") ? m.split("/").pop() : m;
}
