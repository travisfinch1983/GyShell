# Self-hosted Firecrawl (CT152) — Hermes web_extract for every agent

Set up 2026-11-04 by claude1 (Travis: "set up self-hosted Firecrawl for all agents").

- `/opt/firecrawl/docker-compose.yaml` (this copy) = upstream v2.11.0 with the published ghcr images, pinned by digest
  in `/opt/firecrawl/.env` (`env.example` here; the real one holds a generated Postgres password and is NOT
  committed). `docker compose up -d` in /opt/firecrawl; `restart: unless-stopped`.
- API on **127.0.0.1:3002 only** (no auth: USE_DB_AUTHENTICATION=false; every Hermes agent runs on CT152).
- Hermes wiring, per profile and global: `.env` gains `FIRECRAWL_API_URL=http://127.0.0.1:3002`; config
  `web.extract_backend: firecrawl` **and `web.search_backend: searxng`**.
  🛑 The explicit search_backend is REQUIRED: Hermes auto-detect prefers firecrawl over searxng, so adding
  FIRECRAWL_API_URL alone silently moved web_search to Firecrawl (which has no search engine configured) on
  every profile without an explicit backend (18 of 23, 2026-11-04; caught in minutes, no search ran meanwhile).
- Live without restarts: Hermes reads config.yaml and the .env per call (verified: test-agent's running gateway
  did web_extract → 16,025 chars).
- Firecrawl returns TEXT (markdown/html); images are only links. Anti-bot sites (eBay) reject its headless
  playwright ("proxy inadequacy" → wants a stealth proxy we don't have).
- Backups: every profile's `.env.bak-firecrawl-20261104` / `config.yaml.bak-firecrawl-20261104`.
