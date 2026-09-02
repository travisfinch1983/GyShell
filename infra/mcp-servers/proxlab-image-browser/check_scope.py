#!/usr/bin/env python3
"""Assert every backend call that takes an agent-supplied path runs it through _scope().

Why this exists: _scope() makes the "training_images/" prefix optional, so agents can pass
either form. It was applied by hand across ~17 call sites and MISSED THE TWO that spanned
multiple lines (crop, rating) -- because the original pass used single-line anchors. The
result was a tool surface where rate_image/crop_image 404'd on a bare path while
view_image/list_images/get_ratings accepted it. Loom hit this and reported it as
"the usage scheme for the tools seems to vary".

A per-call-site convention applied by hand needs a mechanical check, or the next call site
added will miss it the same way. Run this after ANY edit to server.py.
"""
import re
import sys

SRC = "/opt/mcp-proxlab-image-browser/server.py"
PATHISH = r"\b(path|folder|src|dest|set_path|src_folder)\b"


def main() -> int:
    src = open(SRC).read()
    checked = bad = 0
    for m in re.finditer(r"_ig_(get|post)\(\s*\"([^\"]+)\"(.*?)\)\)", src, re.S):
        endpoint, args = m.group(2), m.group(3)
        if not re.search(PATHISH, args):
            continue
        checked += 1
        if "_scope(" not in args:
            bad += 1
            print("UNSCOPED  line %-5d %s" % (src[: m.start()].count("\n") + 1, endpoint))
    # A count is a measurement only if the probe ran: if the regex matches nothing, the file
    # shape changed and this check is silently vacuous, not passing.
    if checked == 0:
        print("FAIL: matched 0 path-bearing calls -- the regex no longer fits the file.")
        return 2
    print("checked %d path-bearing call(s), %d unscoped" % (checked, bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
