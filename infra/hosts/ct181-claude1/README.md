# CT181 claude1 — hand-placed host files

| File | Why | Deployed |
|---|---|---|
| `opt/instance-manager/server.py` | Claude fleet control plane (systemd `instance-manager.service`, :7700). Not a git repo on the box; this is the tracked copy. 2026-10-12: **remote instances** — a registry entry with `host` (e.g. `root@10.0.0.24`) is probed, controlled and reported over SSH, and `/instances` exposes `sshTarget` so AI-Lab's console attaches to that host. First user: `nicky-claude` on CT187 (px-epyc). | 2026-10-12 |

## Notifiers (2026-10-16): Telegram retired, everything posts to Matrix

Telegram is retired for every Claude Code instance and every agent except Optimus (Zack's only
channel). Travis-facing notices now go through `usr/local/bin/matrix-notify`, which posts as the
@claude1 bot into Travis's DM room, using claude1's channel config `/root/.claude/channels/matrix/.env`.
claude1's channel plugin ignores its own bot's messages, so notices never loop back into the session.
- `usr/local/bin/memory-git-sync`: nightly memory repo sync. Includes the MEMORY.md size warning.
- `opt/job-watch/job-watch.py` (cron */5): long-job completion notices.
- `opt/pr-watch/pr-watch.py` (cron */30) and `pr-reply.py`: GitHub PR activity.
The old Telegram bot configs are archived at `/root/telegram-retired-20261016.tgz` (mode 600, contains tokens).
