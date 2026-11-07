#!/bin/bash
# Runs inside CT172 (hostname blender). Installs official Blender tarball to /opt/blender.
set -eu
[ "$(hostname)" = "blender" ] || { echo "wrong host"; exit 2; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils python3 python3-venv git \
  libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libegl1 libglx-mesa0 libgl1-mesa-dri libxkbcommon0 libsm6 libice6 libx11-6 libxext6 libdbus-1-3 libwayland-client0 libwayland-cursor0 libwayland-egl1 libdecor-0-0 >/dev/null
base=https://download.blender.org/release
series=$(curl -fsSL $base/ | grep -oE 'Blender[0-9]+\.[0-9]+/' | sort -V | tail -6 | tr '\n' ' ')
echo "series: $series"
pick=""
for s in $(echo $series | tr ' ' '\n' | sort -Vr); do
  f=$(curl -fsSL $base/$s | grep -oE 'blender-[0-9.]+-linux-x64\.tar\.xz' | sort -Vu | tail -1)
  if [ -n "$f" ]; then pick="$s$f"; break; fi
done
[ -n "$pick" ] || { echo "no tarball found"; exit 3; }
echo "picked: $pick"
curl -fL --retry 3 -sS -o /root/blender.tar.xz "$base/$pick"
curl -fsS "$base/${pick%/*}/" | grep -oE 'blender-[0-9.]+\.sha256' | sort -u | tail -2
mkdir -p /opt/blender-dist
tar -xf /root/blender.tar.xz -C /opt/blender-dist
d=$(ls -d /opt/blender-dist/blender-* | sort -V | tail -1)
ln -sfn "$d" /opt/blender
ln -sfn /opt/blender/blender /usr/local/bin/blender
/opt/blender/blender -b --factory-startup --version | head -1
rm -f /root/blender.tar.xz
echo INSTALL_OK
