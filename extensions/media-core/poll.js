import { httpGet } from "./media-http.js";
import { normalizeStatus } from "./utils.js";

const DEFAULT_SUCCESS = ["succeeded", "completed", "success", "done"];
const DEFAULT_FAILED = ["failed", "error", "cancelled", "canceled"];

function emitPollProgress(onUpdate, attempt, intervalMs, status) {
  if (typeof onUpdate !== "function") return;
  const elapsedSec = (attempt + 1) * intervalMs / 1000;
  const mins = Math.floor(elapsedSec / 60);
  const secs = Math.floor(elapsedSec % 60);
  const label = status && status !== "unknown" ? status : "processing";
  onUpdate({
    content: [{ type: "text", text: `Video poll #${attempt + 1}: ${label}` }],
    details: { pollAttempt: attempt + 1, status: label },
    progress: {
      text: `视频生成中… 已等待 ${mins}分${secs}秒`,
      visibility: "channel",
      privacy: "public",
      id: "draw-video-poll",
    },
  });
}

export async function pollUntilDone({
  pollUrl,
  apiKey,
  parseResponse,
  maxAttempts = 120,
  intervalMs = 5000,
  logPrefix = "[media-core]",
  signal,
  onUpdate,
}) {
  console.log(`${logPrefix} Polling ${pollUrl}`);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error("Video generation cancelled");
    }
    if (attempt > 0) await new Promise((r) => setTimeout(r, intervalMs));
    if (signal?.aborted) {
      throw new Error("Video generation cancelled");
    }
    try {
      const result = await checkPoll(pollUrl, apiKey);
      const parsed = parseResponse(result);
      const status = parsed.status || "unknown";
      emitPollProgress(onUpdate, attempt, intervalMs, status);
      if (attempt === 0 || attempt % 6 === 5) {
        console.log(`${logPrefix} Poll #${attempt + 1} status=${status}`);
      }
      if (status === "completed") {
        if (!parsed.url) throw new Error("Task completed but no media URL in response");
        return parsed.url;
      }
      if (status === "failed") {
        throw new Error(parsed.error || "Media generation failed");
      }
    } catch (e) {
      if (/failed|no media URL|completed but no/i.test(e.message || "")) throw e;
      console.warn(`${logPrefix} Poll error: ${e.message}`);
    }
  }
  throw new Error(`Media generation timed out after ${Math.round((maxAttempts * intervalMs) / 60000)} minutes`);
}

function checkPoll(pollUrl, apiKey) {
  return httpGet(pollUrl, { Authorization: `Bearer ${apiKey}` }, 30000).then(({ statusCode, text }) => {
    let result;
    try {
      result = JSON.parse(text);
    } catch (e) {
      throw new Error(`Poll response parse error: ${e.message}`);
    }
    if (statusCode < 200 || statusCode >= 300 || result.error?.message) {
      throw new Error(result.error?.message || `HTTP ${statusCode}`);
    }
    return result;
  });
}

export function defaultParsePollResponse(result, options = {}) {
  const success = options.successStatuses || DEFAULT_SUCCESS;
  const failed = options.failedStatuses || DEFAULT_FAILED;
  const statusRaw = result.status || result.data?.status || result.state || "";
  const status = normalizeStatus(statusRaw, success, failed);
  const urlPaths = options.responseUrlPaths || [
    "metadata.url",
    "video.url",
    "video_url",
    "url",
    "output_url",
    "output.url",
    "result.url",
    "data.0.url",
    "data.url",
  ];
  const idPaths = options.responseIdPaths || ["video_id", "id", "task_id"];
  let url = "";
  for (const p of urlPaths) {
    const parts = p.split(".");
    let cur = result;
    for (const key of parts) {
      if (cur == null) break;
      cur = cur[key];
    }
    if (cur) { url = cur; break; }
  }
  const error = result.error?.message || result.error || result.message || "";
  return { status, url, error };
}
