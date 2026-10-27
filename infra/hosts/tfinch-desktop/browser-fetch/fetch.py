#!/opt/browser-fetch/venv/bin/python
"""Fetch a page with a real browser from this machine (residential IP) for sites that block agents.
Usage: browser-fetch URL [--engine chromium|firefox] [--html] [--wait SECONDS] [--shot FILE.png]
Prints the page's visible text (or HTML with --html) to stdout; status/title to stderr."""
import argparse, sys
from playwright.sync_api import sync_playwright

UA = {"chromium": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "firefox": None}

ap = argparse.ArgumentParser()
ap.add_argument("url"); ap.add_argument("--engine", default="firefox", choices=["chromium", "firefox"])
ap.add_argument("--html", action="store_true"); ap.add_argument("--wait", type=float, default=3)
ap.add_argument("--shot")
a = ap.parse_args()
with sync_playwright() as p:
    b = getattr(p, a.engine).launch(headless=True,
        args=["--disable-blink-features=AutomationControlled"] if a.engine == "chromium" else None)
    ctx = b.new_context(user_agent=UA[a.engine], locale="en-US", viewport={"width": 1366, "height": 900})
    pg = ctx.new_page()
    resp = pg.goto(a.url, wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(int(a.wait * 1000))
    print(f"status={resp.status if resp else None} final_url={pg.url} title={pg.title()!r}", file=sys.stderr)
    if a.shot: pg.screenshot(path=a.shot, full_page=True)
    print(pg.content() if a.html else pg.inner_text("body"))
    b.close()
