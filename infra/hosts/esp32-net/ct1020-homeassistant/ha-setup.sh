#!/bin/bash
# Home Assistant Core in an LXC (claude1, 2026-10-30). Debian 13 + uv-managed Python 3.14 (HA needs >= 3.14.2).
set -euo pipefail
HA_VERSION="${HA_VERSION:-2026.10.3}"
export DEBIAN_FRONTEND=noninteractive
echo "== apt"; apt-get update -qq
apt-get install -y -qq --no-install-recommends curl ca-certificates sudo git build-essential pkg-config autoconf \
  libffi-dev libssl-dev zlib1g-dev libjpeg62-turbo-dev libturbojpeg0 libopenjp2-7 libtiff6 liblapack3 libpcap0.8 \
  libxml2 libxslt1.1 libudev1 ffmpeg tzdata iputils-ping >/dev/null
echo "== user + dirs"
id homeassistant >/dev/null 2>&1 || useradd -r -m -d /var/lib/homeassistant -s /usr/sbin/nologin homeassistant
install -d -o homeassistant -g homeassistant /var/lib/homeassistant/config /opt/homeassistant
echo "== uv"
[ -x /usr/local/bin/uv ] || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
cd /var/lib/homeassistant  # uv looks for uv.toml in the CWD; /root is unreadable to homeassistant
echo "== python + venv"
sudo -u homeassistant -H env UV_PYTHON_INSTALL_DIR=/opt/homeassistant/python uv venv --python 3.14 /opt/homeassistant/venv
echo "== homeassistant ${HA_VERSION}"
sudo -u homeassistant -H env VIRTUAL_ENV=/opt/homeassistant/venv uv pip install --python /opt/homeassistant/venv/bin/python "homeassistant==${HA_VERSION}"
/opt/homeassistant/venv/bin/python -c "import homeassistant.const as c; print('installed', c.__version__)"
echo "== DONE"
