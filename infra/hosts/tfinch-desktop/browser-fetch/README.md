# browser-fetch (tfinch-desktop, Debian 13)

Headless real-browser page fetch from Travis's desktop, for sites that 403 agents (eBay etc.).
Added 2026-10-26 at Travis's request. eBay 403s curl/WebFetch/AI-Lab Playwright from CT181; Playwright **Firefox** headless on the desktop gets HTTP 200.

Install (as root on the desktop):
    python3 -m venv /opt/browser-fetch/venv
    /opt/browser-fetch/venv/bin/pip install playwright
    /opt/browser-fetch/venv/bin/playwright install --with-deps chromium firefox
    install -m755 fetch.py /opt/browser-fetch/fetch.py && ln -sf /opt/browser-fetch/fetch.py /usr/local/bin/browser-fetch

Use from claude1:  ssh tfinch-desktop 'browser-fetch URL [--engine chromium] [--html] [--wait 5] [--shot /tmp/x.png]'
eBay item descriptions live in an iframe: fetch https://itm.ebaydesc.com/itmdesc/<item#>.
