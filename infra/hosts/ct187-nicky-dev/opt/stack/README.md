# /opt/stack — base services for nicky-dev

Set up by claude1 on 2026-10-12. `docker compose ps` / `docker compose logs -f <svc>` from this directory.
Secrets live in `.env` (root-only, never commit it). Data lives in `./data/` (the container is backed up to PBS Sat/Tue/Thu 22:00).

| Service | Port | Notes |
|---|---|---|
| Postgres 17 + pgvector | 5432 | superuser `postgres`; databases `authentik` (owner authentik) and `app` (owner app, `vector` extension enabled) |
| Redis 7 | 6379 | password `REDIS_PASSWORD` |
| Qdrant | 6333 REST, 6334 gRPC | header `api-key: QDRANT_API_KEY` |
| Authentik 2026.8.3 | 9000 http, 9443 https | first-time admin setup: `http://<this-ip>:9000/if/flow/initial-setup/` |
| Caddy 2 | 80 | `caddy/Caddyfile`; static placeholder in `caddy/site/` |

App connection strings (fill the passwords from `.env`):
- `postgresql://app:${PG_APP_PASSWORD}@localhost:5432/app`
- `redis://:${REDIS_PASSWORD}@localhost:6379/0`
- Qdrant: `http://localhost:6333` with `api-key`

Upgrades: bump the image tag in `docker-compose.yml`, `docker compose pull && docker compose up -d`.
