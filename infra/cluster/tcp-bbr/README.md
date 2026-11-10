# Cluster-wide TCP BBR default (2026-11-10, claude1)

Remote clients (Travis's laptop/desktop over Starlink + headscale, ~75-100 ms RTT, slight loss)
got 1-3 Mbit/s per TCP flow with cubic. BBR is a **sender-side** setting, so it has to be set on the
machine that SENDS the data; a router/subnet router (OPNsense, CT110) cannot apply it to forwarded flows.

## How it is applied
- Each PVE host: `tcp_bbr` in `/etc/modules-load.d/tcp_bbr.conf` + `/etc/sysctl.d/90-tcp-bbr.conf`
  (`net.ipv4.tcp_congestion_control = bbr`).
- **New network namespaces inherit the host (init_net) default** - verified with `unshare -n` and on
  px-gpu CT177. So every LXC started after this, and every docker container, gets BBR with no
  per-container config.
- Already-running namespaces were switched live by `bbr-rollout.sh` (nsenter into every netns from
  `lsns -t net`). Existing TCP connections keep their CC until they reconnect.

## State on 2026-11-10
| host | result |
|---|---|
| px-nas | host bbr, 67 netns / 50 running CTs bbr, 0 failures |
| px-epyc | host bbr, 44 netns / 22 running CTs bbr, 0 failures |
| px-gpu | already bbr host-wide (`99-kernel-bbr.conf`, also fq qdisc); 3 netns bbr |
| px-mobile | host bbr (no CTs yet) |
| px-gateway | not PVE (backup router), left cubic; serves nothing to remote clients |

VMs (Win11, HAOS) have their own kernels and are not covered.
Older per-route units (`tailnet-bbr-route.service` on px-nas, ai-epyc CT176, CT152) are now redundant but harmless.

## New hosts
Run `bbr-rollout.sh` once on any new PVE node.

## Container template
`px-data:vztmpl/Debian-13-Custom-Template-4.25.26.tar.gz` (Travis's standard Debian 13 template; name typo
"Tempalte" fixed) has `/etc/sysctl.d/90-tcp-bbr.conf` baked in, so a CT made from it is BBR even on a
host that lacks the default. Built 2026-11-10 by gunzip -> `tar -r` of that one file (root:root 0644) ->
gzip; every other entry is byte-identical to the original `Debian-13-Custom-Tempalte-4.25.26.tar.gz`
(entry count = original + 1). Verified with a throwaway unprivileged CT: sysctl reports bbr,
systemd-sysctl clean.
