import { execFile, execFileSync, spawn } from "child_process";
import { accessSync, constants } from "fs";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// 动态查找 Codex 可执行文件
function findCodexExe(): string {
  const candidates = [
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Codex\\Codex.exe` : undefined,
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\OpenAI\\Codex\\bin\\codex.exe` : undefined,
    process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Codex\\Codex.exe` : undefined,
    "codex.exe",  // 如果在 PATH 中
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK);
      return candidate;
    } catch { /* try next */ }
  }
  try {
    const detected = execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      "$c=Get-Command codex -ErrorAction SilentlyContinue; if($c){$c.Source}",
    ], { encoding: "utf8", windowsHide: true, timeout: 1500 }).trim();
    if (detected) return detected;
  } catch { /* fallback below */ }
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
  // Microsoft Store 版使用稳定 AUMID 唤醒桌面应用，避免把 resources/codex.exe
  // 误当成普通可执行文件并传入不存在的 "app" 子命令。
  if (/WindowsApps[\\/]+OpenAI\.Codex_/i.test(CODEX_EXE)) {
    const child = spawn("explorer.exe", ["shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }
  const child = spawn(CODEX_EXE, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
