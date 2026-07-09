' OpenClaw Gateway (v2026.6.11)
Dim ws, cmd
Set ws = CreateObject("WScript.Shell")
cmd = ws.ExpandEnvironmentStrings("%USERPROFILE%\.openclaw\gateway.cmd")
ws.Run cmd, 0, False
