/**
 * Infer provider id from apiBase when user omits "provider".
 */

export function detectProvider(apiBase, kind) {
  const base = String(apiBase || "").trim().toLowerCase();
  let host = "";
  try {
    host = new URL(base.startsWith("http") ? base : `https://${base}`).hostname.toLowerCase();
  } catch {
    return kind === "image" ? "generic-image" : "generic-video";
  }

  if (/agnes-ai\.com$/.test(host) || host.endsWith(".agnes-ai.com")) {
    return kind === "image" ? "agnes-image" : "agnes-video";
  }
  if (/openai\.azure\.com$/.test(host) || host.includes(".openai.azure.com")) {
    return kind === "image" ? "openai-image" : "openai-video";
  }
  if (host === "api.openai.com" || host.endsWith(".openai.com")) {
    return kind === "image" ? "openai-image" : "openai-video";
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return kind === "image" ? "gateway-image" : "gateway-video";
  }

  return kind === "image" ? "generic-image" : "generic-video";
}

export function normalizeProviderId(provider, kind) {
  const p = String(provider || "").trim().toLowerCase();
  if (!p) return "";
  const aliases = {
    agnes: kind === "image" ? "agnes-image" : "agnes-video",
    openai: kind === "image" ? "openai-image" : "openai-video",
    gateway: kind === "image" ? "gateway-image" : "gateway-video",
    generic: kind === "image" ? "generic-image" : "generic-video",
    custom: kind === "image" ? "custom-image" : "custom-video",
  };
  return aliases[p] || p;
}
