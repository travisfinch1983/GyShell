# proxlab-logrotate — rotation + orphan sweep for AI-Lab service logs

The service logs live at `/var/log/proxlab/*.log` **inside the agent
containers** (CT177 on px-gpu 10.0.0.100, CT176 on px-epyc 10.0.0.101), written
by tmux `pipe-pane` appends or systemd `StandardOutput=append:` (see
`packages/backend/src/services/Cluster/proxy/system.js` for the full map).
Before 2026-07-14 there was no rotation (single files reached 49MB+) and the
100-entry cap in `service-history.json` orphaned old `.log` files forever.

## 1. Rotation — `proxlab.logrotate`

Deployed to `/etc/logrotate.d/proxlab` in both containers (2026-07-14):
daily + `maxsize 50M`, keep 7, compress (delaycompress), **copytruncate**.

copytruncate is load-bearing: the writers keep append fds open forever, so a
rename-based rotation would strand them writing to the rotated file. Verified
live: forced rotation on CT177's 49MB `audio-tools-8890.log` → file truncated
in place, writer kept appending, Logs-tab tail unaffected (`source: logfile`).

Redeploy after container rebuilds: `./deploy.sh 177` on px-gpu,
`./deploy.sh 176` on px-epyc.

## 2. Orphan sweep — `POST /api/system/logs/sweep-orphans`

Backend endpoint (system.js): removes log families whose stem is referenced by
NEITHER `active-services.json` NOR `service-history.json` (both live in
`/opt/ai-lab/.gybackend-data/` on CT152). A referenced service keeps its whole
rotation family (`name.log`, `.log.1`, `.log.2.gz`); an orphan's family goes
together.

- **Dry-run by default** — reports orphans per container, deletes nothing.
- `?apply=true` — actually delete; every removal is logged server-side.
- `?minAgeDays=N` (default 7) — mtime safety margin for anything writing to
  the directory outside the service registry.

Caveat: any logrotate copytruncate pass refreshes mtimes on every non-empty
file, so right after a forced full rotation the age guard over-skips (the
2026-07-14 verification run did exactly this). In steady state orphaned files
stop being rotated (`notifempty` + no new writes) and age normally. For a
first sweep after a forced rotation, use `?minAgeDays=0` — the reference-set
check alone protects every registered service.

Baseline at build time (apparent sizes; ZFS lz4 compresses text logs ~8x):
CT177 = 113 orphan files / 645MB apparent, CT176 = 52 / 174MB.
