# CT187 nicky-dev (px-epyc, 10.0.0.24) — Nicky's contractor-app dev environment

Created 2026-10-12 by claude1 for Travis: Ubuntu 24.04 LXC, 16 cores / 16 GB / 50 GB, unprivileged, nesting+keyctl (Docker).

| File | What |
|---|---|
| `root/bootstrap.sh` | base system: Docker CE + compose, Node 22, Bun, ttyd, Claude Code, tools |
| `root/hermes-install.sh` | Hermes agent v2026.8.18 (0.20.4) + `~/.hermes/config.yaml` pointing at the AI-Lab proxy |
| `root/nicky-claude-launch.sh`, `etc/systemd/system/nicky-claude-session.service` | headless Claude Code (`nicky-claude`) in dtach `/tmp/nicky-claude.sock`; fleet + Matrix channels |
| `root/CLAUDE.md` | the instance's brief (scope, boundaries, what's installed) |
| `opt/stack/*` | Docker Compose: Postgres 17+pgvector, Redis 7, Qdrant 1.19.2, Authentik 2026.8.3, Caddy 2. Secrets in `/opt/stack/.env` on the box only |

Not in git (secrets): `/opt/stack/.env`, `/root/.claude/channels/matrix/.env`. Matrix bot `@nicky-claude` (vault cred-fc2caf2e), Nicky's account `@nicky` (cred-5c62fd3f), room "Nicky's Claude" with Travis + Nicky.
Also: fleet agent `nicky-claude` registered in fleetd; AI-Lab Claude tab via instance-manager remote `host` (see ct181-claude1); app repo `claude/nicky-contractor-app` (deploy key).
