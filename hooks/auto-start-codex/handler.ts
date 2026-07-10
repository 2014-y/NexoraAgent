import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// 动态查找 Codex 可执行文件
function findCodexExe(): string {
  const candidates = [
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\OpenAI\\Codex\\bin\\codex.exe` : undefined,
    "codex.exe",  // 如果在 PATH 中
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      require("fs").accessSync(candidate, require("fs").constants.F_OK);
      return candidate;
    } catch { /* try next */ }
  }
  return candidates[0] || "codex.exe";
}

const CODEX_EXE = findCodexExe();

export default async function handler(event) {
  // Only react to message events (user sends a message)
  if (event.type !== "message" || event.action !== "received") {
    return;
  }

  // Check if Codex is already running
  const isRunning = await checkCodexRunning();

  if (!isRunning) {
    console.log("[auto-start-codex] Codex not running, launching...");
    try {
      await launchCodex();
      console.log("[auto-start-codex] Codex launched successfully");
    } catch (err) {
      console.error("[auto-start-codex] Failed to launch Codex:", err.message);
    }
  }
}

async function checkCodexRunning() {
  try {
    const result = await execFileAsync("tasklist", [
      "/FI", "IMAGENAME eq codex.exe",
      "/FO", "CSV",
      "/NH"
    ]);
    return result.stdout.includes("codex.exe");
  } catch {
    return false;
  }
}

async function launchCodex() {
  await execFileAsync(CODEX_EXE, [], {
    detached: true,
    stdio: "ignore"
  });
}
