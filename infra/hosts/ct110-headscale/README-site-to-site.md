# Home ↔ trailer site-to-site over the tailnet (2026-10-30, claude1)

Goal (Travis): reach both LANs (home 10.0.0.0/24, trailer 10.50.0.0/24) from either one, from any device, with no
per-device Tailscale.

| Piece | Where | Setting |
|---|---|---|
| Trailer subnet advertised | trailer OPNsense (headscale node 14, 100.64.0.12), Tailscale plugin | advertises + serves 10.50.0.0/24 (approved); RouteAll=true; it NATs trailer traffic to its tailnet IP on the way out |
| Home subnet advertised | CT110 `headscale` (node 3, 100.64.0.3) | advertises 10.0.0.0/24 (+ exit) |
| CT110 accepts the trailer route | CT110 | `tailscale set --accept-routes=true` (persisted in tailscaled prefs) |
| CT110 masquerade | CT110 `/etc/nftables.conf` table `ip lan2tailnet` | home LAN → 10.50.0.0/24 leaves as 100.64.0.3 |
| Home gateway route | home OPNsense 10.0.0.223 | gateway `TAILNET_CT110` = 10.0.0.67 (lan, monitor off) + static route 10.50.0.0/24 → TAILNET_CT110. Backup `/conf/config.xml.bak-claude1-trailer-route-20261030` |

**Why the masquerade:** the headscale ACL (`racknerd-vps-headscale`, /etc/headscale/acl.hujson) only admits
`homelab@` tailnet-node sources. A packet from a home LAN IP (10.0.0.x) reached the trailer's tailscaled and was
silently dropped — CT110 showed it leaving on tailscale0, the trailer's tailscale0 never saw it. Alternative would be
an ACL rule with src 10.0.0.0/24 + 10.50.0.0/24; not done, to avoid editing the fail-closed policy.

**Not included:** home mgmt VLAN 10.0.20.0/24 (BMCs) is NOT reachable from the trailer (not advertised).

Rollback: delete the OPNsense route + gateway (or restore the backup), `nft delete table ip lan2tailnet` and remove
the block from /etc/nftables.conf, `tailscale set --accept-routes=false` on CT110.
