import hashlib
from pathlib import Path
SRC = Path(r"C:\Users\Yuan\Desktop\ClawAI\ClawAI")
DST = Path(r"C:\Program Files\ClawAI\resources\app")
FILES = ["index.html","renderer.js","index.css","plugin-catalog.js","preload.js","main.js","locales.js","latency-tune.js","token-usage-parse.js","home-resolve.js"]
def sha(p):
    if not p.exists():
        return None
    h=hashlib.sha256()
    h.update(p.read_bytes())
    return h.hexdigest()[:12]
for f in FILES:
    s,d = sha(SRC/f), sha(DST/f)
    print(f, "SRC", s, "DST", d, "SAME" if s==d else "DIFF")
