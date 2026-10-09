"""One-time (re-runnable) backfill of training-set ledgers (.r34-members.json) by CONTENT.

Images renamed after being added (subsection moves -> concept-N, the bulk renamer) no longer carry
their r34_<id> name, so the browser lost its "already added" border. ~74% of rule34 posts have file
URLs named by the file's MD5 (verified 15/15 against the downloaded bytes), so hashing a training
image recovers its post id. Cropped images are hashed from their untouched .orig/ baseline.
Usage:  python backfill_set_ledgers.py            (dry run: counts only)
        python backfill_set_ledgers.py --apply
"""
import hashlib, os, re, sqlite3, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app import _all_set_dirs, _ledger_add, _ledger_read  # same ledger code as the API
from db import DB_PATH

IMG = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")
apply = "--apply" in sys.argv
con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
idx = {}
for pid, url in con.execute("select id, file_url from posts where downloaded=1"):
    stem = url.rsplit("/", 1)[-1].split(".")[0]
    if re.fullmatch(r"[0-9a-f]{32}", stem):
        idx[stem] = pid
print(f"md5 index: {len(idx)} posts", flush=True)
grand = 0
for label, setdir in _all_set_dirs():
    known = _ledger_read(setdir)
    found, scanned = {}, 0
    for root, dirs, files in os.walk(setdir):
        dirs[:] = [x for x in dirs if not x.startswith(".")]
        for f in files:
            if not f.lower().endswith(IMG):
                continue
            scanned += 1
            path = os.path.join(root, f)
            base = os.path.join(root, ".orig", f)
            src = base if os.path.isfile(base) else path
            m = re.match(r"^r34_(\d+)(?:-\d+)?\.", f)
            if m:
                pid = int(m.group(1))
            else:
                with open(src, "rb") as fh:
                    pid = idx.get(hashlib.md5(fh.read()).hexdigest())
            if pid and pid not in known and pid not in found:
                found[pid] = os.path.relpath(path, setdir)
    if scanned:
        print(f"{label:60s} images {scanned:5d}  new ledger entries {len(found):5d}  (already {len(known)})", flush=True)
    grand += len(found)
    if apply and found:
        _ledger_add(setdir, found)
print(("APPLIED" if apply else "DRY RUN") + f": {grand} entries")
