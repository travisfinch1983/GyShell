#!/usr/bin/env python3
"""Tabulate /opt/bench-27b/results/*.json into markdown tables (stdout) + summary.json."""
import glob, json, os
R = "/opt/bench-27b/results"
order = ["llama-base-tensor", "llama-mtp-tensor", "llama-base-layer", "llama-mtp-layer",
         "llama-fastmtp-layer", "llama-dflash2-layer", "1cat-nospec", "1cat-mtp", "1cat-dflash2"]
runs = {}
for f in sorted(glob.glob(R + "/*.json")):
    if "BROKEN" in f: continue
    d = json.load(open(f)); runs[d["config"]] = d
names = [n for n in order if n in runs] + sorted(set(runs) - set(order))
fmt = lambda v: "-" if v is None else (f"{v:.1f}" if isinstance(v, float) else str(v))

def table(title, cols, getter):
    print(f"\n### {title}\n")
    print("| config | " + " | ".join(cols) + " |")
    print("|---|" + "---|" * len(cols))
    for n in names:
        print(f"| {n} | " + " | ".join(fmt(getter(runs[n], c)) for c in cols) + " |")

def lad(r, ctx, key):
    for x in r["ladder"]:
        if x["ctx"] == ctx:
            return x[key] if not x.get("error") else None
def conc(r, n, key):
    for x in r["concurrency"]:
        if x["n"] == n:
            return x[key] if not x.get("errors") else None
def wl(r, corpus, key):
    for x in r["workload"]:
        if x.get("corpus") == corpus:
            return x[key] if not x.get("error") else None

ctxs = [400, 32768, 131072, 200000]
table("Single-stream decode tok/s (ladder, gen 1536)", ["400", "32K", "128K", "200K"],
      lambda r, c: lad(r, ctxs[["400", "32K", "128K", "200K"].index(c)], "decode_tok_s"))
table("Prefill tok/s (ladder)", ["400", "32K", "128K", "200K"],
      lambda r, c: lad(r, ctxs[["400", "32K", "128K", "200K"].index(c)], "prefill_tok_s"))
table("TTFT seconds (ladder)", ["400", "32K", "128K", "200K"],
      lambda r, c: lad(r, ctxs[["400", "32K", "128K", "200K"].index(c)], "ttft_s"))
table("Concurrency @32K: STEADY aggregate decode tok/s (all streams decoding)", ["n=1", "n=2", "n=4", "n=8"],
      lambda r, c: conc(r, int(c[2:]), "decode_steady_agg_tok_s"))
table("Concurrency @32K: end-to-end tok/s (tokens / wall clock, incl. prefill queueing)", ["n=1", "n=2", "n=4", "n=8"],
      lambda r, c: conc(r, int(c[2:]), "end_to_end_tok_s"))
table("Concurrency @32K: mean TTFT seconds", ["n=1", "n=2", "n=4", "n=8"],
      lambda r, c: conc(r, int(c[2:]), "mean_ttft_s"))
table("Workload @32K single-stream decode tok/s (real sessions)", ["conversations", "technical", "creative"],
      lambda r, c: lad(r, 32768, "decode_tok_s") if c == "conversations" else wl(r, c, "decode_tok_s"))
json.dump(runs, open("/opt/bench-27b/summary.json", "w"), indent=1)
