#!/bin/bash
# Hermes agent for nicky-dev: same release as AI-Lab's (v2026.8.18 / 0.20.4), models via the AI-Lab proxy.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -y -q install libolm-dev >/dev/null
D=/usr/local/lib/hermes-agent
[ -d $D/.git ] || git clone -q --branch v2026.8.18 --depth 1 https://github.com/NousResearch/hermes-agent.git $D
cd $D
[ -x venv/bin/python ] || python3 -m venv venv
venv/bin/pip install -q --upgrade pip
venv/bin/pip install -q -e ".[matrix]"
printf '#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "%s/venv/bin/hermes" "$@"\n' "$D" > /usr/local/bin/hermes
chmod +x /usr/local/bin/hermes
mkdir -p /root/.hermes
[ -f /root/.hermes/config.yaml ] || cat > /root/.hermes/config.yaml <<'YAML'
# Hermes on nicky-dev (claude1, 2026-10-12). Models come from Travis's AI-Lab universal proxy.
model:
  default: Qwen3.8-27B-INT8-MM-8_Slot-Think_Preserve-256k
  provider: ailab
  api_mode: openai_chat
providers:
  ailab:
    name: AI-Lab Universal Proxy
    api: http://10.0.0.219:17890/api/proxy/llm/v1
    transport: openai_chat
    default_model: Qwen3.8-27B-INT8-MM-8_Slot-Think_Preserve-256k
  custom:
    name: AI-Lab Universal Proxy (custom)
    api: http://10.0.0.219:17890/api/proxy/llm/v1
    transport: openai_chat
    default_model: Qwen3.8-27B-INT8-MM-8_Slot-Think_Preserve-256k
timezone: America/Phoenix
YAML
hermes --version
