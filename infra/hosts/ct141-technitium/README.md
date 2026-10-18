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
Per-client 600 qpm (/32) and 6000 qpm per /24. Exceeding a limit blocks that client's (or that
whole /24's) DNS: this took CT152 (AI-Lab) offline on 2026-10-17 (report
maintenance-ct152-dns-ratelimit-20261017). CT152 now runs a local dnsmasq cache for the host and its
Docker containers (see ../ct152/dnsmasq).

**Bypass list (2026-10-18):** the 3 Proxmox hosts + every server guest in the cluster inventory
(67 addresses; desktops/phones/IoT and the Win11Pro VM 10.0.0.201 are NOT exempt). Add new server
guests here when they are created.

Caveat (read from the Technitium source, DnsServer.cs IsQpmLimitBypassed / StatsManager
GetLatestClientSubnetStats): the bypass list only skips the check for the querying client. The /24
subnet total still COUNTS exempt servers' queries, so a runaway server can push 10.0.0.0/24 past
6000 qpm and get every NON-exempt device on the LAN blocked.
