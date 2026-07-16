import re
from pathlib import Path
SRC = Path(__file__).resolve().parent.parent
DST = Path(r"C:\Program Files\Nexora Agent\resources\app")
for label, p in [("SRC", SRC), ("DST", DST)]:
    print("====", label, "====")
    for name in ["index.html", "renderer.js"]:
        text = (p / name).read_text(encoding="utf-8", errors="replace")
        matches = re.findall(r'["\']([^"\']*plugins-grid[^"\']*)["\']', text)
        print(name, "matches:", matches)
        for m in matches:
            print(" ", repr(m), "len", len(m), "ords", [ord(ch) for ch in m])
    # also show nearby context for id= in html
    h = (p / "index.html").read_text(encoding="utf-8", errors="replace")
    for m in re.finditer(r'.{0,40}plugins-grid.{0,40}', h):
        print("HTML CTX:", repr(m.group(0)))
    j = (p / "renderer.js").read_text(encoding="utf-8", errors="replace")
    for m in re.finditer(r'.{0,50}plugins-grid.{0,50}', j):
        print("JS CTX:", repr(m.group(0)))
