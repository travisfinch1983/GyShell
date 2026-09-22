import sqlite3, os, time
from concurrent.futures import ThreadPoolExecutor

SP  = "/nas/zpoolalpha/media/xxx/rule34"
DB  = "/opt/ai-lab/addons/rule34/data/state.db"
LOG = "/opt/ai-lab/addons/rule34/scan_missing.log"

def log(m):
    line = f"{time.strftime('%H:%M:%S')} {m}"
    with open(LOG, "a") as f: f.write(line + "\n")

def check(row):
    pid, lp = row
    if not lp: return (pid, True)
    p = os.path.join(SP, lp)
    try:
        return (pid, os.stat(p).st_size == 0)
    except OSError:
        return (pid, True)

def main():
    open(LOG, "w").close()
    log("scan start")
    c = sqlite3.connect(DB, timeout=60); c.row_factory = sqlite3.Row
    rows = [(r["id"], r["local_path"]) for r in c.execute("SELECT id, local_path FROM posts WHERE downloaded=1")]
    c.close()
    total = len(rows); log(f"downloaded=1 rows: {total}")
    missing = []; done = 0; t0 = time.time()
    with ThreadPoolExecutor(max_workers=32) as ex:
        for pid, bad in ex.map(check, rows, chunksize=200):
            done += 1
            if bad: missing.append(pid)
            if done % 50000 == 0:
                el = time.time() - t0
                log(f"  {done}/{total} checked, {len(missing)} missing, {done/el:.0f}/s")
    log(f"scan complete: {len(missing)} missing/empty of {total}")
    with open("/opt/ai-lab/addons/rule34/scan_missing_ids.txt", "w") as f:
        f.write("\n".join(map(str, missing)))
    if missing:
        w = sqlite3.connect(DB, timeout=60); w.execute("PRAGMA busy_timeout=60000")
        n = 0
        for i in range(0, len(missing), 500):
            chunk = missing[i:i+500]; ph = ",".join("?"*len(chunk))
            for _ in range(6):
                try:
                    w.execute(f"UPDATE posts SET downloaded=0, next_retry_at=0 WHERE id IN ({ph})", chunk)
                    w.commit(); n += len(chunk); break
                except sqlite3.OperationalError as e:
                    if "locked" in str(e).lower(): time.sleep(1.0); continue
                    raise
        w.close()
        log(f"re-queued {n} posts for re-download (downloaded=0)")
    log("DONE")

main()
