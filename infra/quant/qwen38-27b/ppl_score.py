#!/usr/bin/env python3
"""Realised-token logprobs for paired perplexity comparison (method: RAG
qwen38_27b_quant_accuracy_true_perplexity_v100_20260825).

  ppl_score.py <port> <out.json>            score one served model
  ppl_score.py --compare <ref.json> <cand.json> [...more cand]

- prompt_logprobs=0 returns ONE entry per position = the REALISED token (never use rank==1, that
  is the model's top prediction and measures confidence, not perplexity).
- Held-out text: real agent sessions (corpus-technical.txt), fixed seeded offsets, so every leg
  scores byte-identical prompts. Tokens are compared position-by-position; legs must tokenize
  identically (same tokenizer) or the comparison aborts.
- Paired ratio = exp(mean(lp_ref - lp_cand)); >1 means the candidate is WORSE. Cross-checked
  against the direct perplexity ratio (they must agree).
"""
import json, math, random, re, sys, urllib.request

CORPUS = "/opt/1cat-vllm-dist/corpus-technical.txt"
N_CHUNKS, CHUNK_CHARS = 14, 12000          # ~3.0-4.1 chars/token -> ~3-4k tokens each, ~45k total


def chunks():
    text = open(CORPUS, encoding="utf-8", errors="replace").read()
    rng = random.Random(20261018)
    out = []
    # The corpus holds base64 image payloads from agent sessions (9 of the first 14 unfiltered
    # draws were pure base64, ppl ~275). Reject any window with a 40+ char base64-ish run or
    # heavy escaping, so the legs score language, not random bytes.
    junk = re.compile(r'[A-Za-z0-9+/=]{40,}')
    while len(out) < N_CHUNKS:
        o = rng.randrange(0, len(text) - CHUNK_CHARS)
        c = text[o:o + CHUNK_CHARS]
        if junk.search(c) or c.count('\\n') > 60:
            continue
        out.append(c)
    return out


def score(port, path):
    url = f"http://127.0.0.1:{port}/v1/completions"
    model = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models"))["data"][0]["id"]
    res = []
    for i, c in enumerate(chunks()):
        body = {"model": model, "prompt": c, "max_tokens": 1, "temperature": 0, "prompt_logprobs": 0}
        r = json.load(urllib.request.urlopen(urllib.request.Request(
            url, json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=900))
        pl = r["choices"][0]["prompt_logprobs"]
        toks, lps = [], []
        for ent in pl[1:]:                 # position 0 has no logprob
            if len(ent) != 1:
                raise SystemExit(f"chunk {i}: expected 1 entry/position (realised), got {len(ent)}")
            (tid, d), = ent.items()
            toks.append(int(tid)); lps.append(d["logprob"])
        res.append({"tokens": toks, "logprobs": lps})
        print(f"chunk {i}: {len(toks)} tokens, ppl {math.exp(-sum(lps)/len(lps)):.4f}", flush=True)
    json.dump({"model": model, "port": port, "chunks": res}, open(path, "w"))
    n = sum(len(c["tokens"]) for c in res); s = sum(sum(c["logprobs"]) for c in res)
    print(f"TOTAL {n} tokens  perplexity {math.exp(-s/n):.5f}  -> {path}", flush=True)


def compare(ref_p, cand_ps):
    ref = json.load(open(ref_p))
    for cp in cand_ps:
        cand = json.load(open(cp))
        d, top = [], 0
        for a, b in zip(ref["chunks"], cand["chunks"]):
            if a["tokens"] != b["tokens"]:
                raise SystemExit(f"{cp}: token sequences differ from reference - not comparable")
            d += [x - y for x, y in zip(a["logprobs"], b["logprobs"])]
        n = len(d); m = sum(d) / n
        sd = math.sqrt(sum((x - m) ** 2 for x in d) / (n - 1)); se = sd / math.sqrt(n)
        lr = -sum(sum(c["logprobs"]) for c in ref["chunks"]) / n
        lc = -sum(sum(c["logprobs"]) for c in cand["chunks"]) / n
        print(f"{cp}\n  vs {ref_p}\n  tokens {n}  ppl ref {math.exp(lr):.5f}  cand {math.exp(lc):.5f}"
              f"  direct ratio {math.exp(lc - lr):.5f}x\n  paired ratio {math.exp(m):.5f}x"
              f"  95% CI [{math.exp(m - 1.96*se):.5f}, {math.exp(m + 1.96*se):.5f}]"
              f"  ({'NOT distinguishable' if m - 1.96*se <= 0 <= m + 1.96*se else 'SIGNIFICANT'})\n", flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "--compare":
        compare(sys.argv[2], sys.argv[3:])
    else:
        score(int(sys.argv[1]), sys.argv[2])
