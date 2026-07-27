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
RUN SP="$(python -c 'import openviking,os;print(os.path.dirname(openviking.__file__))')" \
 && echo "site-packages: $SP" \
 && patch -p0 -d / --fuzz=0 < /tmp/patches/0001-search-recall-compact.patch \
 && patch -p0 -d / --fuzz=0 < /tmp/patches/0002-session-extract-context.patch \
 && rm -rf /tmp/patches
# If the patches ever fuzz against a new upstream, patches/ also carries the FULL
# patched files (search.py, session_extract_context_provider.py) to copy over instead.

ENV PYTHONUNBUFFERED=1
EXPOSE 1933
# storage.workspace in ov.conf must point at the mounted volume.
VOLUME ["/opt/openviking/workspace"]
CMD ["openviking-server", "--config", "/root/.openviking/ov.conf"]
