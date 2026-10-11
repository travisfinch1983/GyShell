"""gallery-dl entry point for Bluesky syncs: originals of JPEG photos come from Bluesky's image CDN.

gallery-dl fetches every Bluesky file from the author's PDS (com.atproto.sync.getBlob), and PDS blob
downloads are throttled hard: measured 2026-10-11 at ~90 KB/s - a 2 MB photo took 21 s, while
cdn.bsky.app served the same photo, at the same 4000x3000 resolution, in 1.4 s. The CDN re-encodes;
on that sample the result was 52 dB PSNR vs the original (visually identical) with the same JPEG
quantisation tables.

With AILAB_BSKY_CDN=1 this rewrites the download URL of JPEG files only - PNG/WebP/GIF originals would
be converted to JPEG by the CDN, so those keep coming from the PDS untouched. Anything unexpected in
gallery-dl's internals (renamed class or method) falls back to plain gallery-dl with a warning, so an
upgrade can make syncs slower but never wrong.

Run exactly like gallery-dl: python gdl_bluesky.py <gallery-dl args...>
"""

import os
import re
import sys

BLOB_RE = re.compile(r"/xrpc/com\.atproto\.sync\.getBlob\?did=(did:[a-z]+:[A-Za-z0-9._:-]+)&cid=([a-z0-9]+)$")
CDN = "https://cdn.bsky.app/img/feed_fullsize/plain/{did}/{cid}@jpeg"


def _patch() -> None:
    from gallery_dl.extractor import bluesky
    from gallery_dl.extractor.common import Message

    base = bluesky.BlueskyExtractor
    orig_items = base.items

    def items(self):
        for msg in orig_items(self):
            if msg and msg[0] == Message.Url and len(msg) >= 3:
                kwdict = msg[2]
                m = BLOB_RE.search(msg[1] or "")
                if m and str(kwdict.get("extension", "")).lower() in ("jpg", "jpeg"):
                    msg = (msg[0], CDN.format(did=m.group(1), cid=m.group(2)), kwdict) + tuple(msg[3:])
            yield msg

    base.items = items


if __name__ == "__main__":
    if os.environ.get("AILAB_BSKY_CDN") == "1":
        try:
            _patch()
        except Exception as e:   # never block a sync over the speed-up
            print(f"[gdl_bluesky][warning] CDN rewrite disabled, using PDS originals: {e!r}", file=sys.stderr)
    from gallery_dl import main
    sys.exit(main())
