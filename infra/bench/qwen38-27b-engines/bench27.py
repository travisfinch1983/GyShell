#!/usr/bin/env python3
"""Engine-agnostic real-data benchmark for Qwen3.8-27B servers (llama.cpp or 1Cat-vLLM).

Methodology = /opt/1cat-vllm-dist/matrix.py (2026-09-14 standard, RAG
v100_benchmark_harness_and_four_traps_20260914) so rows are comparable, with ONE fix:

  TTFT = first streamed token of EITHER `content` or `reasoning_content`.
  Qwen3.8 thinks first; with a reasoning parser the thinking streams as reasoning_content.
  matrix.py only watched `content`, so its TTFT silently included the entire thinking phase
  (prefill understated, decode window shrunk). Both engines here are measured with the fix.

Measured:
  ladder       400 / 32K / 128K / 200K prompt tokens, gen 1536, one stream
  concurrency  1/2/4/8 streams at 32K, gen 1536, EACH stream a different random slice
  workload     32K technical vs creative (speculation acceptance is workload-dependent)
Prompts: REAL agent sessions (corpus-*.txt) at random offsets -> prefix cache cannot cheat.
Tokens: usage.completion_tokens, never SSE chunks.  temperature 0 (as matrix.py).

usage: bench27.py <port> <config_name> <out.json> [--quick]
"""
import json, random, re, sys, threading, time, urllib.request
from transformers import AutoTokenizer

PORT, NAME, OUT = int(sys.argv[1]), sys.argv[2], sys.argv[3]
QUICK = "--quick" in sys.argv
TOK = AutoTokenizer.from_pretrained("/models/Qwen3.8/27B/BF16-Safetensors")
D = "/opt/1cat-vllm-dist/"
# Base64 image payloads from agent sessions are stripped at load (2026-10-18: 9/14 random
# windows of corpus-technical were pure base64). Stripping beats rejecting windows: a 32K
# window of real technical text nearly always contains SOME long token (path, URL, hash).
B64 = re.compile(r"[A-Za-z0-9+/=]{100,}")
def _load(f):
    return B64.sub("[blob]", open(D + f, encoding="utf-8", errors="ignore").read())
CORPORA = {
    "conversations": (_load("corpus-conversations.txt"), 3.08),
    "technical": (_load("corpus-technical.txt"), 3.3),
    "creative": (_load("corpus-creative.txt"), 3.3),
}
LADDER = [400, 32768] if QUICK else [400, 32768, 131072, 200000]
CONC = [1, 4] if QUICK else [1, 2, 4, 8]
GEN = 512 if QUICK else 1536
rng = random.Random(7)


def prompt_of(n, corpus="conversations"):
    text, cpt = CORPORA[corpus]
    want = int(n * cpt * 1.3) + 64
    for _ in range(50):
        s = rng.randint(0, max(0, len(text) - want - 1))
        chunk = text[s:s + want]
        ids = TOK(chunk).input_ids
        if len(ids) >= n:
            return TOK.decode(ids[:n])
    raise RuntimeError(f"no clean {n}-token window in {corpus}")


def model_id():
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/models", timeout=10))["data"][0]["id"]


MODEL = None


def stream_once(ctx, gen, corpus="conversations", out=None,
                instruction="\n\nSummarise the key points of the material above."):
    body = {"model": MODEL, "messages": [{"role": "user", "content": prompt_of(ctx, corpus) + instruction}],
            "max_tokens": gen, "temperature": 0.0, "stream": True,
            "stream_options": {"include_usage": True}}
    t0 = time.time(); ttft = None; chunks = 0; usage = None; err = None; think_chunks = 0; stamps = []
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/chat/completions",
                                     json.dumps(body).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=7200) as r:
            for raw in r:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:"):
                    continue
                p = line[5:].strip()
                if p == "[DONE]":
                    break
                try:
                    d = json.loads(p)
                except Exception:
                    continue
                if d.get("error"):
                    # llama.cpp reports e.g. "Context size has been exceeded" INSIDE the stream.
                    # Unchecked, 7/8 rejected streams once passed as a clean (error-free) result.
                    e = d["error"]
                    err = "stream error: " + str(e.get("message") if isinstance(e, dict) else e)[:120]
                    break
                if d.get("usage"):
                    usage = d["usage"]
                ch = d.get("choices") or []
                if ch:
                    delta = ch[0].get("delta", {})
                    rc = delta.get("reasoning_content") or delta.get("reasoning")
                    if delta.get("content") or rc:
                        if ttft is None:
                            ttft = time.time() - t0
                        chunks += 1
                        stamps.append(time.time())
                        think_chunks += 1 if rc else 0
    except Exception as e:
        err = f"{type(e).__name__}: {str(e)[:100]}"
    total = time.time() - t0
    n = (usage or {}).get("completion_tokens") or chunks
    if err is None and usage is None:
        err = "no usage block (stream ended abnormally)"
    ptok = (usage or {}).get("prompt_tokens")
    res = {"ttft": ttft, "n": n, "total": total, "err": err, "chunks": chunks,
           "think_chunks": think_chunks, "prompt_tokens": ptok, "stamps": stamps}
    if out is not None:
        out.append(res)
    return res


def row(ctx, r):
    t = r["ttft"]
    return {"ctx": ctx, "prompt_tokens": r["prompt_tokens"], "ttft_s": round(t, 3) if t else None,
            "prefill_tok_s": round(r["prompt_tokens"] / t, 1) if t and r["prompt_tokens"] else None,
            "decode_tok_s": round(r["n"] / (r["total"] - t), 2) if t and r["total"] > t and r["n"] else None,
            "gen_tokens": r["n"], "sse_chunks": r["chunks"], "think_chunks": r["think_chunks"],
            "tokens_per_chunk": round(r["n"] / r["chunks"], 2) if r["chunks"] else None,
            "total_s": round(r["total"], 2), "error": r["err"]}


def save(res):
    json.dump(res, open(OUT, "w"), indent=2)


def main():
    global MODEL
    MODEL = model_id()
    res = {"config": NAME, "port": PORT, "model": MODEL, "started": time.strftime("%F %T"),
           "gen": GEN, "ladder": [], "concurrency": [], "workload": []}
    stream_once(4096, 64)                               # warm-up, discarded
    for ctx in LADDER:
        r = row(ctx, stream_once(ctx, GEN)); res["ladder"].append(r); save(res)
        print(f"{NAME:<14} ladder ctx={ctx:<7} prefill={r['prefill_tok_s']} decode={r['decode_tok_s']} "
              f"tok/chunk={r['tokens_per_chunk']} {r['error'] or ''}", flush=True)
    for n in CONC:
        out = []
        th = [threading.Thread(target=stream_once, args=(32768, GEN, "conversations", out,
              "\n\nSummarise the key points of the material above in detail.")) for _ in range(n)]
        t0 = time.time(); [t.start() for t in th]; [t.join() for t in th]; wall = time.time() - t0
        dec = sum(x["n"] / (x["total"] - x["ttft"]) for x in out if x["ttft"] and x["total"] > x["ttft"] and x["n"])
        toks = sum(x["n"] for x in out)
        # STEADY-STATE aggregate: only the window where EVERY stream is decoding
        # (last first-token .. first finish). The per-stream metric above charges each stream
        # for time it sat stalled while LATER streams prefilled; llama.cpp prefills
        # concurrent prompts largely serially, so that metric hid a ~2.4x real scaling
        # (2026-10-18 smoke: per-slot tg_3s ~27 x4 vs reported 44 aggregate).
        # Tokens per chunk assumed uniform within a stream (n/chunks) - exact without
        # speculation, an average with it.
        steady = None
        if all(x["stamps"] for x in out):
            ws = max(x["stamps"][0] for x in out); we = min(x["stamps"][-1] for x in out)
            if we > ws:
                steady = sum(sum(1 for t in x["stamps"] if ws <= t <= we) * (x["n"] / len(x["stamps"]))
                             for x in out) / (we - ws)
        c = {"n": n, "ctx": 32768, "gen": GEN, "wall_s": round(wall, 2), "total_gen_tokens": toks,
             "decode_aggregate_tok_s": round(dec, 2), "decode_per_stream_tok_s": round(dec / n, 2),
             "decode_steady_agg_tok_s": round(steady, 2) if steady else None,
             "steady_window_s": round(we - ws, 1) if steady else None,
             "end_to_end_tok_s": round(toks / wall, 2),
             "mean_ttft_s": round(sum(x["ttft"] or 0 for x in out) / n, 2),
             "errors": [x["err"] for x in out if x["err"]][:2]}
        res["concurrency"].append(c); save(res)
        print(f"{NAME:<14} conc n={n} decode_agg={c['decode_aggregate_tok_s']} per-stream="
              f"{c['decode_per_stream_tok_s']} steady={c['decode_steady_agg_tok_s']} e2e={c['end_to_end_tok_s']} ttft={c['mean_ttft_s']} {c['errors'] or ''}", flush=True)
    for corpus in ("technical", "creative"):
        r = row(32768, stream_once(32768, GEN, corpus)); r["corpus"] = corpus
        res["workload"].append(r); save(res)
        print(f"{NAME:<14} workload {corpus:<9} prefill={r['prefill_tok_s']} decode={r['decode_tok_s']} "
              f"tok/chunk={r['tokens_per_chunk']} {r['error'] or ''}", flush=True)
    res["finished"] = time.strftime("%F %T"); save(res)


if __name__ == "__main__":
    main()
