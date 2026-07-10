# -*- coding: utf-8 -*-
"""OpenClaw Gateway + 对话日志监控 (单终端，不卡住)"""
import subprocess
import sys
import os
import time
import threading
import json
from datetime import datetime

def find_node_exe():
    """动态查找 Node.js 可执行文件"""
    nvm_dir = os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Roaming", "nvm")
    if os.path.isdir(nvm_dir):
        for entry in sorted(os.listdir(nvm_dir), reverse=True):
            node_exe = os.path.join(nvm_dir, entry, "node.exe")
            if os.path.isfile(node_exe):
                return node_exe
    prog_files = r"C:\Program Files\nodejs\node.exe"
    if os.path.isfile(prog_files):
        return prog_files
    return "node"

def find_openclaw_index():
    """动态查找 openclaw dist/index.js"""
    nvm_dir = os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Roaming", "nvm")
    if os.path.isdir(nvm_dir):
        for entry in sorted(os.listdir(nvm_dir), reverse=True):
            idx = os.path.join(nvm_dir, entry, "node_modules", "openclaw", "dist", "index.js")
            if os.path.isfile(idx):
                return idx
    prog_files = r"C:\Program Files\nodejs\node_modules\openclaw\dist\index.js"
    if os.path.isfile(prog_files):
        return prog_files
    return None

NODE = find_node_exe()
CLI = find_openclaw_index()
LOG_FILE = os.path.join(os.environ.get("TEMP", ""), "openclaw", "openclaw-latest.log")

def colorize(text, level):
    colors = {
        "INFO": "\033[92m",
        "WARN": "\033[93m",
        "ERROR": "\033[91m",
        "DEBUG": "\033[90m",
    }
    reset = "\033[0m"
    c = colors.get(level, reset)
    return c + text + reset

def tail_logs():
    """后台线程：读取日志文件并打印"""
    if not os.path.exists(LOG_FILE):
        return
    # 先读已有的
    try:
        with open(LOG_FILE, "r", encoding="utf-8-sig") as f:
            lines = f.readlines()
        for line in lines[-20:]:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                ts = datetime.fromisoformat(obj["time"]).strftime("%H:%M:%S")
                level = obj["_meta"]["logLevelName"]
                msg = obj.get("1", "")
                subsys = obj.get("0", "")
                dm = msg
                if isinstance(subsys, str) and subsys != "{}":
                    dm = "[" + subsys + "] " + msg
                print(colorize("[" + ts + "] " + dm, level))
            except:
                pass
    except:
        pass

    # 实时尾随
    print()
    print(colorize("--- 实时监控 (Ctrl+C 停止) ---", "INFO"))
    print()

    with open(LOG_FILE, "r", encoding="utf-8-sig") as f:
        f.seek(0, 2)
        while True:
            line = f.readline()
            if not line:
                time.sleep(0.3)
                continue
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                ts = datetime.fromisoformat(obj["time"]).strftime("%H:%M:%S")
                level = obj["_meta"]["logLevelName"]
                msg = obj.get("1", "")
                subsys = obj.get("0", "")
                dm = msg
                if isinstance(subsys, str) and subsys != "{}":
                    dm = "[" + subsys + "] " + msg
                print(colorize("[" + ts + "] " + dm, level))
            except:
                pass

if __name__ == "__main__":
    print("=" * 70)
    print(colorize("  OpenClaw Gateway + 对话日志监控", "INFO"))
    print("=" * 70)
    print()

    if CLI is None:
        print(colorize("[ERROR] openclaw not found. Run: npm install -g openclaw", "ERROR"), file=sys.stderr)
        sys.exit(1)

    # 启动日志监控线程
    log_thread = threading.Thread(target=tail_logs, daemon=True)
    log_thread.start()

    # 等待日志线程初始化
    time.sleep(1)

    # 启动 Gateway（stdout 直接打印到终端）
    print(colorize("[INFO] 正在启动 Gateway...", "INFO"))
    print()

    proc = subprocess.Popen(
        [NODE, CLI, "gateway", "run", "--force"],
        stdout=sys.stdout,
        stderr=sys.stderr,
    )

    try:
        proc.wait()
    except KeyboardInterrupt:
        print(colorize("\n[INFO] 停止 Gateway...", "WARN"))
        proc.terminate()
        proc.wait()
        print(colorize("[OK] 已停止", "INFO"))
