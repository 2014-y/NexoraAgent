import re
from pathlib import Path
SRC = Path(r"C:\Users\Yuan\Desktop\ClawAI\ClawAI")
DST = Path(r"C:\Program Files\ClawAI\resources\app")
for label, p in [("SRC", SRC), ("DST", DST)]:
    h = (p / "index.html").read_text(encoding="utf-8", errors="replace")
    j = (p / "renderer.js").read_text(encoding="utf-8", errors="replace")
    c = (p / "index.css").read_text(encoding="utf-8", errors="replace")
    hm = re.search(r'id=["\']([^"\']*plugins-grid[^"\']*)["\']', h)
    jm = re.search(r'getElementById\(["\']([^"\']*plugins-grid[^"\']*)["\']', j)
    hi = hm.group(1) if hm else None
    ji = jm.group(1) if jm else None
    print(label, "HTML_ID", hi, "LEN", len(hi) if hi else 0)
    print(label, "JS_ID", ji, "LEN", len(ji) if ji else 0)
    print(label, "EQUAL", hi == ji)
    print(label, "MASONRY", bool(re.search(r"(?s)\.plugins-masonry\s*\{[^}]*min-height:\s*0", c)))
