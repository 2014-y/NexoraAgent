#!/bin/bash
# AI-v24.13.0 开源版 - Linux/Mac 启动脚本
# 使用方法: ./start-gateway.sh

set -e

BASE_PATH="$HOME/.openclaw"
export PATH="$BASE_PATH:$PATH"

# 检查端口占用
if lsof -i :18789 >/dev/null 2>&1; then
    echo "[INFO] Gateway already running. Stopping..."
    lsof -ti :18789 | xargs kill -9
    sleep 3
fi

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found. Please install Node.js 20+ first."
    exit 1
fi

echo "Node.js version: $(node --version)"
echo ""
echo "========================================"
echo " OpenClaw Gateway Launcher"
echo "========================================"
echo ""

# 启动 Gateway
cd "$BASE_PATH" || exit 1
node "$(which openclaw)/dist/index.js" gateway run --force
