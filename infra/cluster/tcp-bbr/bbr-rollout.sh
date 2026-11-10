#!/bin/bash
# Make BBR the TCP default on this PVE host and switch every live network namespace to it.
# New netns (LXC starts, docker containers) inherit the host (init_net) default.
# Existing connections keep their CC until they reconnect. No restarts.
set -u
modprobe tcp_bbr || { echo "modprobe tcp_bbr FAILED"; exit 1; }
[ -f /etc/modules-load.d/tcp_bbr.conf ] || echo tcp_bbr > /etc/modules-load.d/tcp_bbr.conf
cat > /etc/sysctl.d/90-tcp-bbr.conf <<'X'
# BBR as the TCP default (claude1, 2026-11-10). Remote clients reach the LAN over
# Starlink/tailnet with ~75-100 ms RTT and slight loss; cubic collapses to 1-3 Mbit/s
# per flow there. New network namespaces (LXCs, docker) inherit this default.
net.ipv4.tcp_congestion_control = bbr
X
sysctl -q -p /etc/sysctl.d/90-tcp-bbr.conf
echo "host: $(sysctl -n net.ipv4.tcp_congestion_control)"
ok=0; fail=0
for pid in $(lsns -t net -n -o PID); do
  cur=$(nsenter -t "$pid" -n sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null) || { echo "skip pid $pid (gone)"; continue; }
  [ "$cur" = bbr ] && { ok=$((ok+1)); continue; }
  if nsenter -t "$pid" -n sysctl -q -w net.ipv4.tcp_congestion_control=bbr; then ok=$((ok+1)); else fail=$((fail+1)); echo "FAIL pid $pid ($(cat /proc/$pid/comm))"; fi
done
echo "netns now bbr: $ok  failed: $fail"
echo "--- per-CT check:"
for id in $(pct list | awk 'NR>1 && $2=="running"{print $1}'); do
  p=$(lxc-info -n "$id" -p -H 2>/dev/null)
  printf "%s=%s " "$id" "$(nsenter -t "$p" -n sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)"
done; echo
