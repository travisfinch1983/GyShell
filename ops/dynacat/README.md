# Dynacat — Home tab dashboard (sidecar, inventory-driven)

Runs as a sidecar in the AI-Lab container (CT152) on `127.0.0.1:8081`; the Home tab iframes it via
the Vite `/dash` proxy (same-origin → CSP `frame-ancestors 'self'` covers the embed).

## Pipeline (deployed to /opt/dynacat/, re-run every 10 min by dynacat-config.timer → refresh.sh)
1. **cluster-probe.py** — ground-truth service discovery. For each running LXC it SSHes to the guest's
   PVE node and runs `pct exec <vmid> ss -Hltnp` to get real listening ports + process names; VMs get a
   TCP-scan of common web ports. Each externally-bound port is HTTP-probed (status/title/server) and the
   service identified (process name → container name → HTML title + fingerprint table). Writes
   `cluster-services.json` (per container: open ports + app + url + category) — also intended to feed the
   AI-Lab Services tab. Uses the CT152 key `/opt/ai-lab/.gybackend-data/ssh/id_ed25519` (authorized on all PVE nodes).
2. **gen-dynacat-config.py** — builds `dynacat.yml` from two sources: `active-services.json` (AI services →
   LLM/TTS/Tools groups, model labels, LLMs checked at /health) and `cluster-services.json` (one PRIMARY web
   endpoint per container, grouped by PVE node, 2 full columns). Monitor sites use a broad `alt-status-codes`
   (301/401/404… = OK) so a reachable service that doesn't 200 on / still shows green. Idempotent:
   validate-before-swap, restart dynacat only on change.

## Systemd (on CT152)
- `dynacat.service` — runs the Dynacat binary (`/opt/dynacat/dynacat`, v2.4.0, ~20MB, not in repo).
- `dynacat-config.{service,timer}` — `refresh.sh` (probe + generate) every 10 min.

## Tuning
- Service identification / fingerprints: `PROC_MAP` + `identify()` in cluster-probe.py.
- News feeds / subreddits, grouping, alt-status-codes: top of gen-dynacat-config.py.
