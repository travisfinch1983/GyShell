# The Optane KV Cache — how it works, why each piece exists, how to check it, how to undo it

*Written 2026-08-30 for a reader who wasn't here. Everything in this document is measured
on the running system, not assumed. Sources: claude1's build/verification runs (2026-08-28
→ 30), the upstream research record (Fleet Feed thread `thr-940e2f6209c0`), and the
`llm_inference_knowledge` docs it cites.*

> **DRAFT NOTE (remove before publishing):** the FULLPREFIX patch section reflects the
> state claude1 described on 2026-08-30 and is marked where his in-flight change may have
> altered it. Confirm the final state with him before treating §3.3 as current.

---

## 1. What this is

vLLM serving the 27B GDN-hybrid model (service **5003** on ai-gpu) keeps its KV cache in
three tiers: **VRAM → RAM → Optane**. A conversation whose KV has been evicted from the
GPU can be resumed from RAM at a fraction of the cost of recomputing it, and — because the
Optane tier is persistent — can survive a full engine restart.

Two sentences of honesty up front:

- **RAM is where the speed is.** ~5× at 14.7k tokens, **24.5×** at 100k (116.2s → 4.75s).
- **Optane is durability, not speed.** A disk restore after a genuine restart is ~1.4×
  (40s → 27s). Its value is that five 34.5k-token conversations came back **byte-identical**
  after an engine restart (PID changed, `serve-full local=0 hit=33600`) — not that it is fast.

**Where it lives:** inside vLLM itself — four patches in the site-packages of
`/opt/conda/envs/1cat-vllm-sm70-130` plus connector configuration in
`/opt/proxlab/services/1cat-vllm-5003.sh`. There is **no proxy or shim in the path**.

> ⚠️ Do not confuse this with `/opt/kvcache-proxy` — that is the **old llama.cpp**
> KV-cache proxy, a separate and now-dormant system: disabled, not running, nothing on
> port 5001. If you are debugging the vLLM tier stack, that directory is a red herring.

## 2. The tier hierarchy — by construction, not convention

The order is enforced by `TieringOffloadingManager.lookup()`:

1. **VRAM** (vLLM's own prefix cache) is consulted before the connector is asked anything.
2. On a VRAM miss, the **RAM primary tier** answers; a RAM hit short-circuits.
3. Only on a RAM miss is **Optane** queried — and a disk hit **promotes** the block into
   RAM so the next access is warm.

RAM tier size: **256 GB = 4,934 blocks ≈ 3.95M tokens**, deliberately ~3.5× the
1,125,767-token GPU cache, so the working set of every active conversation fits above disk.

## 3. The four patches (`/opt/1cat-vllm/patches/optane-gdn-fix/`, with README)

Each exists because something measurable was wrong. They are inert without
`--kv-transfer-config` (see §8, Rollback).

### 3.1 MAMBAFIX — the root cause of silent wrong answers

A Mamba/GDN block's recurrent state is written at step **N+1**. The connector therefore
stored every block while it was still **empty**, then re-stored it correctly on the next
job — except the **final** block, which has no next job. Its stored copy stayed all-zero,
so every restore resumed the model with **no recurrent state**: output that was fast,
fluent, deterministic and factually wrong (the measured failure: a needle at depth
confidently reported as "not found"). The fix holds back the newest block at three sites
so nothing is stored before its state exists.

### 3.2 RACEFIX — load-side stream ordering

The store path had a barrier against compute; the load path had none, so compute could
read blocks **mid-copy**. One-line stream-ordering fix.

### 3.3 FULLPREFIX — the upstream gate, ported ⚠️ *state in flux*

Ports upstream PR **#42554**'s gate (`_mamba_block_aligned_split` must not run for
async-load requests — without it, an external-hit request is silently dropped from
scheduling every step and parks forever). Originally this patch **also refused partial
hits** (no-splice policy: a snapshot is consumed whole or not at all).
**⚠️ As of 2026-08-30 claude1 was relaxing the partial-hit half — confirm the final
policy before relying on this paragraph.**

### 3.4 HOTNESS — eviction that knows what's warm

Records lookup frequency per block in `TieringOffloadingManager.lookup()`, flushed to a
sidecar file the pruner sorts on. Without it, pruning degrades to FIFO — which deletes
the **shared prefix first**, the worst possible choice (see §6).

## 4. Critical configuration — each line has a reason

| Setting | Why it must be exactly this |
|---|---|
| `PYTHONHASHSEED=0` | **Required for persistence at all.** When unset, `NONE_HASH` is `os.urandom(32)` per process (`kv_cache_utils.py:109`), so block hashes rotate every restart: the on-disk tier becomes unreachable **and** the old files are orphaned. The persistence failure and the disk leak were the same bug. |
| `--mamba-cache-mode all` | `align` keeps only 2 rolling state pages — there is no per-block checkpoint to store. `all` materialises the checkpoints the connector needs. |
| `--no-disable-hybrid-kv-cache-manager` | vLLM auto-disables HMA whenever any `kv_transfer_config` is set unless the user states a preference; without HMA the hybrid specs can't unify and the engine won't start. |
| RAM tier 256 GB | 4,934 blocks ≈ 3.95M tokens ≈ 3.5× the GPU cache (§2). |

## 5. Performance — keep the two numbers apart

| Path | Measured |
|---|---|
| RAM-tier hit, 14.7k tokens | ~5× faster than recompute |
| RAM-tier hit, 100k tokens | **24.5×** (116.2s → 4.75s) |
| Optane restore after real restart | ~1.4× (40s → 27s) |

Verification that counts (production): 5 conversations × 34.5k tokens, genuine engine
restart (PID changed), **all five byte-identical**, log shows `serve-full local=0 hit=33600`.

## 6. Capacity and pruning

- ~**39 GB per ~100k-token conversation** → the 630 GB Optane device holds ~16.
- `optane-kv-prune.timer` runs every 30 min, watermarks **80/65** (start pruning at 80%
  full, stop at 65%), evicting by **lookup frequency, then age**.
- The pruner **refuses to delete when the hotness sidecar is missing** — without it the
  sort degrades to FIFO, and FIFO deletes the shared prefix (the most valuable blocks,
  because every conversation reuses them) first.

## 7. Operational trap: the /dev/shm leak

Every Tiering engine maps a `/dev/shm` region **the size of the RAM tier** and does
**not** unlink it on exit — each `systemctl restart` leaks one. Three test restarts put
`/dev/shm` at **96%**; the next allocation would have failed. The launcher now reclaims
orphaned regions at startup. **Any new engine using the Tiering spec needs the same
guard.**

## 8. How to verify it is working

1. **Use the counters, never wall-clock.** `/metrics` →
   `vllm:external_prefix_cache_{hits,queries}_total`. An 11.9× speedup with
   `external_prefix_cache_hits_total == 0` is a pure GPU-cache hit, not the tier stack.
2. **The only discriminating correctness test is a needle at depth after a restart.**
   Plant a fact deep in a long context, restart the engine, ask for it. Hit rates,
   throughput, spot checks and even token-exact single-turn diffs have all passed while
   the cache was broken — both here (MAMBAFIX's zero-state bug) and independently
   upstream. Aggregate score gates do not catch this class.
3. Expect `Created secondary tier #0 (fs)` in the launch log, files appearing under
   `/optane-sock1`, and `serve-full local=0 hit=<n>` on restored requests.
4. At temp=0, cold and cached outputs are **not** bit-identical to each other in general
   (different batching → different float reduction order). Restart-restore of the *same*
   path is byte-stable (§5); cold-vs-cached divergence alone is not corruption.

## 9. Rollback

- `/opt/proxlab/services/1cat-vllm-5003.sh.pre-kvoffload-202608300218` — disables the
  connector entirely (the four site-packages patches are **inert** without
  `--kv-transfer-config`).
- `.pre-ramtier-*` — reverts the tier size only.
- The scheduler file in site-packages is pristine (the FULLPREFIX gate lives in the patch
  set, not hand-edits) — production 5003 runs that same env.

## 10. History, in three sentences

Upstream's assert (`External KV connector is not verified yet`) blocked all of this and
turned out to be **load-bearing**: lifting it naively produced a 14×-faster engine that
silently lost facts, because attention KV restored while GDN state did not (MAMBAFIX is
what made state restore real). Upstream removed the assert in #42554 for a path that does
transfer state (NIXL/Mamba2); GDN state offload remains upstream-roadmap, and the only
credible external road (LMCache's opaque-page connector) needs a newer vLLM than the SM70
fork currently tracks. So this stack is, for now, the only correct Optane KV path for
this model — which is exactly why its verification gate (§8.2) is a needle test and not a
benchmark.
