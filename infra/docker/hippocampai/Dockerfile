# HippocampAI — memory engine API.
#
# Upstream lives in Gitea as a READ-ONLY MIRROR, so our local changes cannot be
# pushed there. They are carried as a patch in patches/ instead, generated with
# `git format-patch` and verified to apply cleanly onto the pinned base commit.
#
# Pinned to ca24195 deliberately: that is the commit running in production on
# CT26. The mirror has since moved on (70bf917+); do NOT float to main without
# re-testing, the local patches are only known-good against ca24195.
FROM python:3.13-slim

ARG HIPPO_REPO=http://10.0.0.146:3000/travisfinch1983/HippocampAI.git
ARG HIPPO_COMMIT=ca24195d6499572ecaf1ac3e5facfdcff3039ff8

RUN apt-get update && apt-get install -y --no-install-recommends \
        git build-essential libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/HippocampAI
RUN git init -q . \
 && git remote add origin "$HIPPO_REPO" \
 && git fetch -q --depth 1 origin "$HIPPO_COMMIT" \
 && git checkout -q FETCH_HEAD

# Local patches: self-hosted base_url, REMOTE embedder, pluggable vector backend.
COPY patches/ /tmp/patches/
RUN git apply --verbose /tmp/patches/*.patch && rm -rf /tmp/patches

# NOTE ON TORCH (decided 2026-07-27): the stock install pulls sentence-transformers
# -> torch, ~5.6 GB, purely for a LOCAL embedder + LOCAL cross-encoder reranker.
# The embedder patch above already supports a REMOTE OpenAI-compatible endpoint
# (EMBED_API_URL), and rag-models.json already selects a remote reranker
# (nvidia/llama-nemotron-rerank-vl-1b-v2), so neither needs to run in-process.
# Keeping torch out drops the image by orders of magnitude AND removes a second
# reranker that could silently disagree with the unified MCP's.
# VERIFY before first deploy: that hippo's rerank path can be pointed remote or
# disabled. If it cannot, that is a code change, not a packaging one.
RUN sed -i -E '/^(torch|sentence-transformers|transformers)([=<>~ ]|$)/d' requirements.txt 2>/dev/null || true
RUN pip install --no-cache-dir -r requirements.txt && pip install --no-cache-dir .

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
# Mirrors hippocampai.service ExecStart on CT26.
CMD ["python", "-m", "uvicorn", "hippocampai.api.app:socket_app", \
     "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
