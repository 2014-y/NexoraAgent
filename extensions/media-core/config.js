import fs from "node:fs";
import path from "node:path";
import { detectProvider, normalizeProviderId } from "./detect.js";
import { isBuiltInApiKey } from "./keys.js";
import { normalizeImageApiBase, normalizeVideoApiBase, resolveStateDir } from "./paths.js";

const IMAGE_PREFS_FILE = "media-generator.json";
const VIDEO_PREFS_FILE = "video-generator.json";
const CUSTOM_PROVIDERS_FILE = "media-providers.json";

const DEFAULT_IMAGE = {
  provider: "agnes-image",
  apiBase: "https://apihub.agnes-ai.com/v1/images/generations",
  apiKey: "",
  model: "agnes-image-2.0-flash",
  providerOptions: {},
};

const DEFAULT_VIDEO = {
  provider: "agnes-video",
  apiBase: "https://apihub.agnes-ai.com/v1/videos",
  apiKey: "",
  model: "agnes-video-v2.0",
  providerOptions: {},
};

function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (e) {}
  return null;
}

export function loadCustomProviderDefinitions(stateDir = resolveStateDir()) {
  const data = readJsonFile(path.join(stateDir, CUSTOM_PROVIDERS_FILE));
  if (!data || typeof data !== "object") return {};
  const providers = data.providers && typeof data.providers === "object" ? data.providers : data;
  return providers && typeof providers === "object" ? providers : {};
}

function mergeSection(defaults, sidecar, runtimeOverlay, kind) {
  const merged = {
    ...defaults,
    ...(runtimeOverlay && typeof runtimeOverlay === "object" ? runtimeOverlay : {}),
    ...(sidecar && typeof sidecar === "object" ? sidecar : {}),
  };

  const normalizeBase = kind === "image" ? normalizeImageApiBase : normalizeVideoApiBase;
  merged.apiBase = normalizeBase(merged.apiBase || defaults.apiBase);

  const rawKey = String(merged.apiKey || "").trim();
  merged.apiKey = isBuiltInApiKey(rawKey) ? "" : rawKey;

  merged.provider = normalizeProviderId(merged.provider, kind)
    || detectProvider(merged.apiBase, kind);

  if (!merged.providerOptions || typeof merged.providerOptions !== "object") {
    merged.providerOptions = {};
  }

  return merged;
}

export function loadImageConfig(runtimeOverlay) {
  const stateDir = resolveStateDir();
  const sidecar = readJsonFile(path.join(stateDir, IMAGE_PREFS_FILE));
  let openclawOverlay = null;
  try {
    const cfg = readJsonFile(path.join(stateDir, "openclaw.json"));
    if (cfg?.imageGenerator) openclawOverlay = cfg.imageGenerator;
  } catch (e) {}

  return mergeSection(
    DEFAULT_IMAGE,
    sidecar,
    { ...openclawOverlay, ...runtimeOverlay },
    "image"
  );
}

export function loadVideoConfig(runtimeOverlay) {
  const stateDir = resolveStateDir();
  const sidecar = readJsonFile(path.join(stateDir, VIDEO_PREFS_FILE));
  let openclawOverlay = null;
  try {
    const cfg = readJsonFile(path.join(stateDir, "openclaw.json"));
    if (cfg?.videoGenerator) openclawOverlay = cfg.videoGenerator;
  } catch (e) {}

  const merged = mergeSection(
    DEFAULT_VIDEO,
    sidecar,
    { ...openclawOverlay, ...runtimeOverlay },
    "video"
  );

  if (runtimeOverlay?.config?.agents?.defaults?.videoGenerationModel?.primary && !merged.model) {
    merged.model = runtimeOverlay.config.agents.defaults.videoGenerationModel.primary;
  }

  return merged;
}

export function resolveCustomProviderConfig(providerId, kind, stateDir = resolveStateDir()) {
  const defs = loadCustomProviderDefinitions(stateDir);
  const def = defs[providerId];
  if (!def || typeof def !== "object") return null;
  const defKind = def.kind || def.type;
  if (defKind && defKind !== kind) return null;
  return def;
}
