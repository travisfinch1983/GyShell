# OpenViking — agent-native context database. Upstream: github.com/volcengine/openviking
#
# Installed from PyPI, NOT a git checkout — so there is no lineage and the local
# patches live inside site-packages. A bare `pip install` DESTROYS them silently.
# That is why patches/ exists and is applied explicitly below; if the patch step
# ever fails the build MUST fail rather than ship an unpatched image.
FROM python:3.13-slim

ARG OPENVIKING_VERSION=0.3.22

RUN apt-get update && apt-get install -y --no-install-recommends \
        patch \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "openviking==${OPENVIKING_VERSION}"

# Local patches, recovered 2026-07-27 from the .bak-ovrecall-* originals on CT156:
#   0001 search.py                            — recalled abstracts are stored as
#        "Summary: <one-liner>\n<date> ChatLog: <full transcript>". Injecting the
#        whole abstract INFLATES THE PROMPT ~80% and empty-summary memories are
#        pure noise. Compacts to the text before ChatLog:, drops empty ones.
#   0002 session_extract_context_provider.py  — extraction context provider.
COPY patches/ /tmp/patches/
# The patch headers carry absolute paths from the ORIGINAL host install
# (/opt/openviking/venv/lib/python3.13/site-packages/...), which do not exist in
# this image. Strip those 7 leading components (-p7 — the leading slash counts) and apply relative to THIS
# image's site-packages. --fuzz=0 + set -e means a future upstream bump FAILS THE
# BUILD instead of silently shipping an unpatched image.
RUN set -e; \
    SP="$(python -c 'import openviking,os;print(os.path.dirname(os.path.dirname(openviking.__file__)))')"; \
    echo "site-packages: $SP"; \
    patch -p7 -d "$SP" --fuzz=0 < /tmp/patches/0001-search-recall-compact.patch; \
    patch -p7 -d "$SP" --fuzz=0 < /tmp/patches/0002-session-extract-context.patch; \
    grep -q 'ov-recall-compact' "$SP/openviking/server/routers/search.py" \
      || { echo "PATCH VERIFY FAILED: marker missing from search.py"; exit 1; }; \
    echo "patches applied and verified"; \
    rm -rf /tmp/patches
# patches/ also carries the FULL patched files (search.py,
# session_extract_context_provider.py) as a fallback if the diffs ever stop applying.

ENV PYTHONUNBUFFERED=1
EXPOSE 1933
# storage.workspace is set AT RUNTIME by the entrypoint (per-fingerprint).
VOLUME ["/opt/openviking/workspaces"]
# Entrypoint resolves the workspace from the embedding model's fingerprint, so
# each encoder gets its own index instead of contaminating a shared one.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
