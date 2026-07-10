---
name: auto-start-codex
description: "Automatically launch Codex when Computer Use tools are called"
metadata:
  {
    "openclaw": {
      "emoji": "🖥️",
      "events": ["message:received"],
      "requires": { "bins": ["powershell"] }
    }
  }
---

# Auto-Start Codex

Automatically launches the Codex desktop app if it's not already running, whenever a message is received. This enables Computer Use functionality without needing Codex to be constantly running.
