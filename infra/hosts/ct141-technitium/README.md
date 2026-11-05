# Technitium DNS (CT141 "dhcp" on px-nas, 10.0.0.3)

LAN DNS + DHCP. Web UI/API on :5380 (credential vault: "Technitium DNS/DHCP").

## Upstream: Cloudflare over DNS-over-TLS (2026-10-18)

Before: full recursion from the root servers over plain UDP/53 (the ISP could see every lookup).
Now: Settings -> Proxy & Forwarders
- Forwarders: `cloudflare-dns.com (1.1.1.1:853)`, `cloudflare-dns.com (1.0.0.1:853)`
- Forwarder protocol: `Tls`
- DNSSEC validation stays ON locally (Cloudflare passes the DNSSEC records; `dnssec-failed.org` -> SERVFAIL, signed names get `ad`).

The 10 split-horizon Forwarder zones (`amp`, `hs`, `hs-admin`, `photos`, `sdnext`, `sql`, `usenet`,
`vps-immich`, `vps-nextcloud`, `vps-portainer` `.deeveeyant.com`) had FWD records to `1.1.1.1` over
plain UDP; they now use `Tls` / `cloudflare-dns.com (1.1.1.1:853)` too.

Verify: `dig +short @10.0.0.3 TXT o-o.myaddr.l.google.com` returns a Cloudflare IP (172.69.x / 162.158.x),
not the WAN IP; on CT141 `ss -tn '( dport = :853 )'` shows sessions to 1.1.1.1 / 1.0.0.1.
Measured: uncached lookups 70-100 ms, cached 0-1 ms.

Rollback: set Forwarders empty + protocol Udp (back to recursion). Pre-change JSON backups of the
settings and forwarder zones are on claude1 (CT181) in /root/technitium-backups/ (not committed:
the settings dump may hold secrets).

## Rate limits
IPv4: per-client 600 qpm (/32) only. The /24 limit (6000 qpm) was REMOVED 2026-10-18 (see caveat
below). Exceeding the limit blocks that client's DNS: this took CT152 (AI-Lab) offline on 2026-10-17 (report
maintenance-ct152-dns-ratelimit-20261017). CT152 now runs a local dnsmasq cache for the host and its
Docker containers (see ../ct152/dnsmasq).

**Bypass list (2026-10-18):** the 3 Proxmox hosts + every server guest in the cluster inventory
(67 addresses; desktops/phones/IoT and the Win11Pro VM 10.0.0.201 are NOT exempt). Add new server
guests here when they are created.

Caveat (read from the Technitium source, DnsServer.cs IsQpmLimitBypassed / StatsManager
GetLatestClientSubnetStats): the bypass list only skips the check for the querying client. The /24
subnet total still COUNTS exempt servers' queries, so a runaway server can push 10.0.0.0/24 past
6000 qpm and get every NON-exempt device on the LAN blocked. That's why the IPv4 /24 row was removed
(qpmPrefixLimitsIPv4 = `32|600|600`; the API's table format is pipe-separated
prefix|udp|tcp rows; a comma list errors out). The IPv6 /64 and /56 rows are still at their defaults.
Rollback: `/api/settings/set?qpmPrefixLimitsIPv4=32|600|600|24|6000|6000`.

## DHCP: patched DnsServerCore.dll and widened pools (2026-11-05)

**Problem:** with no relay, Technitium picks a scope for a RENEW/REBIND only by `IsAddressInRange(ciaddr)`.
A reservation outside the pool matched no scope, so the request was dropped with no NAK and no log line.
The client lost its IP at lease expiry and re-DISCOVERed every 2 h. That was about 80 clients, and it caused
the SMB drops and "Restoring Network Connections" popups on Win11Pro. Clients behind relay 10.0.0.251
were not affected because the relay path checks reservations first.

**Running build:** v14.3 plus `infra/patches/technitium/0001-pr2032-reserved-lease-renewal-v14.3.patch`
(upstream PR #2032, unmerged). Only `DnsServerCore.dll` and `.pdb` were replaced. Decompiled, the original DLL
matched a clean v14.3.0 build, and the patched DLL differed only by the PR's changes.

**Rebuild:** clone tag v14.3.0, apply the patch, copy `/opt/technitium/dns/TechnitiumLibrary*.dll` to
`../TechnitiumLibrary/bin/` beside the clone, then `dotnet build DnsServerCore/DnsServerCore.csproj -c Release`
with SDK 9.0.

**Rollback:** in `/opt/technitium/dns`, copy `DnsServerCore.dll.orig-14.3` and `DnsServerCore.pdb.orig-14.3`
over the live files, then `systemctl restart technitium` (the unit is `technitium`, not `dns`; a restart took
about 1 s). CT141 also has snapshot `pre-pr2032-20261105`.

**Upgrading:** an official update overwrites the patched DLL. Upstream v15 targets .NET 10; this CT has .NET 9.
Move back to mainline only once a release contains PR #2032.

**Pools:** ranges were widened so reservations are in range without the patch, and exclusions keep the
dynamic pools unchanged:

| Scope | Before | After | Exclusions | Dynamic pool |
|---|---|---|---|---|
| 10-SERVERS | 10.0.0.21-59 | 10.0.0.1-254 | .1-.20, .60-.254 | .21-.59 |
| 20-MGMT | 10.0.20.200-254 | 10.0.20.1-254 | .1-.199 | .200-.254 |

Rollback: `/api/dhcp/scopes/set` with the old start and end and `exclusions=` empty.
