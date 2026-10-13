# CT181 claude1 — hand-placed host files

| File | Why | Deployed |
|---|---|---|
| `opt/instance-manager/server.py` | Claude fleet control plane (systemd `instance-manager.service`, :7700). Not a git repo on the box; this is the tracked copy. 2026-10-12: **remote instances** — a registry entry with `host` (e.g. `root@10.0.0.24`) is probed, controlled and reported over SSH, and `/instances` exposes `sshTarget` so AI-Lab's console attaches to that host. First user: `nicky-claude` on CT187 (px-epyc). | 2026-10-12 |
