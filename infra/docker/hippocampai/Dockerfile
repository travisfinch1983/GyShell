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

# DEPENDENCIES: pinned from the KNOWN-WORKING venv on CT26 (`pip freeze`), not
# from pyproject.toml. pyproject under-declares what the code actually imports —
# resolving from it failed on python-socketio, then networkx, and would have kept
# going. The frozen list is exact parity with the install that has been running.
#
# TORCH IS EXCLUDED (18 packages: torch, sentence-transformers, nvidia-*, triton).
# Patch 0001 made the EMBEDDER remote; patch 0003 makes the RERANKER remote and
# defers the sentence_transformers import into the local-only branch, so torch is
# never imported. VERIFIED on the live install: 0 torch mappings in the running
# process before and after a rerank. Bonus — hippo now shares the SAME reranker
# the rest of the stack selects via rag-models.json, rather than a second
# cross-encoder that could silently disagree with the unified memory MCP.
COPY requirements-frozen.txt /tmp/requirements-frozen.txt
RUN pip install --no-cache-dir -r /tmp/requirements-frozen.txt
# --no-deps so pip cannot re-resolve pyproject and drag sentence-transformers back.
RUN pip install --no-cache-dir --no-deps .

# Fail the build LOUDLY if anything still needs torch at import time, rather than
# shipping an image that dies on first request.
RUN python -c "import hippocampai.api.app; print('import OK - torch not required')"

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
# Mirrors hippocampai.service ExecStart on CT26.
CMD ["python", "-m", "uvicorn", "hippocampai.api.app:socket_app", \
     "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
