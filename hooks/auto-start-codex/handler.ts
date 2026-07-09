import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const CODEX_EXE = "C:\\\\Users\\\\Yuan\\\\AppData\\\\Local\\\\OpenAI\\\\Codex\\\\bin\\\\codex.exe";

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

