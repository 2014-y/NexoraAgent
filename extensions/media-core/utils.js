export function getByPath(obj, dotPath) {
  if (!obj || !dotPath) return undefined;
  const parts = String(dotPath).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

export function pickFirst(obj, paths) {
  for (const p of paths) {
    const v = getByPath(obj, p);
    if (v != null && v !== "") return v;
  }
  return "";
}

export function normalizeStatus(raw, successList, failedList) {
  const s = String(raw || "").toLowerCase();
  if (successList.some((x) => s === String(x).toLowerCase())) return "completed";
  if (failedList.some((x) => s === String(x).toLowerCase())) return "failed";
  if (["processing", "queued", "pending", "in_progress", "running"].includes(s)) return "processing";
  return s || "unknown";
}

export function supportsOpenAiImageExtras(modelId) {
  const m = String(modelId || "").toLowerCase();
  return /dall-?e|gpt-image/.test(m);
}

export function isUnsupportedImageParamError(err) {
  const msg = String(err?.message || err || "");
  return /UnsupportedParamsError|style is not supported|quality is not supported|drop_params/i.test(msg);
}

export function framesForDuration(seconds, fps) {
  const target = Math.max(1, Math.round(Number(seconds) * Number(fps) || 120));
  let best = 1;
  for (let n = 0; n <= 55; n++) {
    const frames = 8 * n + 1;
    if (frames > 441) break;
    if (Math.abs(frames - target) < Math.abs(best - target)) best = frames;
  }
  return best;
}

export function sizeForResolution(resolution, aspectRatio) {
  const presets = {
    "480p": { "16:9": [832, 448], "9:16": [448, 832], "1:1": [640, 640], "4:3": [640, 480], "3:4": [480, 640] },
    "720p": { "16:9": [1152, 768], "9:16": [768, 1152], "1:1": [768, 768], "4:3": [1024, 768], "3:4": [768, 1024] },
    "1080p": { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:3": [1440, 1080], "3:4": [1080, 1440] },
  };
  const resKey = String(resolution || "720p").toLowerCase();
  const ratioKey = String(aspectRatio || "16:9");
  const table = presets[resKey] || presets["720p"];
  const pair = table[ratioKey] || table["16:9"];
  return { width: pair[0], height: pair[1] };
}

export function fillTemplate(tpl, vars) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key];
    return v == null ? "" : String(v);
  });
}
