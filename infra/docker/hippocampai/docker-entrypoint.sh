#!/bin/sh
# Derive LLM_MODEL from AI-Lab's Support Models file so the model is controlled in ONE place
# (the Support Models tab, role `memory_extraction`) instead of being hardcoded in .env.
#
# WHY THIS EXISTS: hippo's LLM_MODEL was pinned in .env and invisible to the UI. When the
# served model name on :5020 was corrected (Qwen3.6->Qwen3.5 typo) hippo silently broke —
# nothing in the UI showed it, and a host-side grep for the old name missed it entirely
# because it lived in a container env var.
#
# PRECEDENCE: file wins, env is the fallback. A missing/!unreadable file must NOT wipe a
# working config — we keep whatever .env supplied and say so loudly.
#
# NOTE: /ai-lab-data is the bind-mounted DIRECTORY, never the file. AI-Lab writes the JSON
# atomically (tmp + rename), which swaps the inode — a file bind-mount would pin the OLD
# inode forever and this would read a stale value with no sign anything was wrong.
set -e

SM=/ai-lab-data/hermes-support-models.json
ROLE=memory_extraction

if [ -f "$SM" ]; then
  FROM_FILE="$(python3 - "$SM" "$ROLE" <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception as e:
    print("", file=sys.stderr); print(f"support-models unreadable: {e}", file=sys.stderr); print(""); raise SystemExit(0)
print(((cfg.get(sys.argv[2]) or {}).get("model") or ""))
PY
)"
  if [ -n "$FROM_FILE" ]; then
    if [ "$FROM_FILE" != "${LLM_MODEL:-}" ]; then
      echo "hippocampai: LLM_MODEL <- support-models[$ROLE] = '$FROM_FILE' (was '${LLM_MODEL:-unset}')"
    else
      echo "hippocampai: LLM_MODEL = '$FROM_FILE' (support-models and env agree)"
    fi
    LLM_MODEL="$FROM_FILE"
    export LLM_MODEL
  else
    echo "hippocampai: support-models has no '$ROLE' model; keeping env LLM_MODEL='${LLM_MODEL:-unset}'" >&2
  fi
else
  echo "hippocampai: $SM not mounted; keeping env LLM_MODEL='${LLM_MODEL:-unset}'" >&2
fi


# ── Embedding + reranker models: SAME single-source contract as LLM_MODEL above ──
# These live in rag-models.json (AI-Lab Settings -> Support Models, embeddings/reranker rows),
# so the model is chosen in ONE place for the whole cluster.
#
# WHY THIS EXISTS: hippo's EMBED_API_MODEL was pinned in .env to `Qwen3-VL-Embedding-8B`, which
# is the served name of the RETIRED 4-bit V100 instance. The current 5060 Ti instance is
# `Qwen3-VL-Embedding-8B-FP8`. BOTH advertise dim 4096, so embedding through the wrong one can
# NEVER raise an error -- vectors compare happily and silently return nonsense similarity. A
# dimension change would have failed loudly; this cannot. That is why it must be derived, not
# copied.
#
# ⚠ CHANGING THE EMBED MODEL REQUIRES RE-EMBEDDING hippo's stored vectors. Queries encoded by a
# different model than the corpus are not comparable, and nothing will report an error.
#
# PRECEDENCE (same as above): file wins, env is the fallback. A missing/unreadable file must
# NOT wipe a working config -- keep whatever .env supplied and say so loudly.
RM=/ai-lab-data/rag-models.json

if [ -f "$RM" ]; then
  RM_EMBED="$(python3 - "$RM" embedModel <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"rag-models unreadable: {e}", file=sys.stderr); print(""); raise SystemExit(0)
print((cfg or {}).get(sys.argv[2]) or "")
PY
)"
  RM_RERANK="$(python3 - "$RM" rerankModel <<'PY'
import json, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"rag-models unreadable: {e}", file=sys.stderr); print(""); raise SystemExit(0)
print((cfg or {}).get(sys.argv[2]) or "")
PY
)"

  if [ -n "$RM_EMBED" ]; then
    if [ "$RM_EMBED" != "${EMBED_API_MODEL:-}" ]; then
      echo "hippocampai: EMBED_API_MODEL <- rag-models.embedModel = '$RM_EMBED' (was '${EMBED_API_MODEL:-unset}') -- RE-EMBED REQUIRED if the corpus was built with the old model"
    else
      echo "hippocampai: EMBED_API_MODEL = '$RM_EMBED' (rag-models and env agree)"
    fi
    EMBED_API_MODEL="$RM_EMBED"
    EMBED_MODEL="$RM_EMBED"
    export EMBED_API_MODEL EMBED_MODEL
  else
    echo "hippocampai: rag-models.json has no embedModel; keeping env EMBED_API_MODEL='${EMBED_API_MODEL:-unset}'" >&2
  fi

  if [ -n "$RM_RERANK" ]; then
    if [ "$RM_RERANK" != "${RERANK_API_MODEL:-}" ]; then
      echo "hippocampai: RERANK_API_MODEL <- rag-models.rerankModel = '$RM_RERANK' (was '${RERANK_API_MODEL:-unset}')"
    else
      echo "hippocampai: RERANK_API_MODEL = '$RM_RERANK' (rag-models and env agree)"
    fi
    RERANK_API_MODEL="$RM_RERANK"
    export RERANK_API_MODEL
  else
    echo "hippocampai: rag-models.json has no rerankModel; keeping env RERANK_API_MODEL='${RERANK_API_MODEL:-unset}'" >&2
  fi
else
  echo "hippocampai: $RM not mounted; keeping env EMBED_API_MODEL='${EMBED_API_MODEL:-unset}' RERANK_API_MODEL='${RERANK_API_MODEL:-unset}'" >&2
fi

exec "$@"
