# Dynacat — Home tab dashboard (sidecar)

Runs as a sidecar in the AI-Lab container (CT152) on `127.0.0.1:8081`; the Home tab iframes it
via the Vite `/dash` proxy (same-origin → CSP `frame-ancestors 'self'` covers the embed).

## Files (deployed to CT152)
- `gen-dynacat-config.py` → `/opt/dynacat/` — generates `dynacat.yml` from AI-Lab inventory
  (`active-services.json` → AI endpoints grouped by serviceType; `inventory.json` → infra IPs by
  name). Idempotent: only rewrites + restarts dynacat on change. Tune `INFRA`/`RSS_FEEDS`/`SUBREDDITS` here.
- `dynacat.service` → `/etc/systemd/system/` — runs the Dynacat binary (`/opt/dynacat/dynacat`).
- `dynacat-config.{service,timer}` → `/etc/systemd/system/` — regenerates config every 10 min.

The Dynacat binary itself (v2.4.0, ~20MB) lives at `/opt/dynacat/dynacat`, not in this repo.
