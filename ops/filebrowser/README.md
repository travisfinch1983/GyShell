# File Manager — FileBrowser Quantum (sidecar)

The Files tab embeds FileBrowser Quantum (gtsteffaniak/filebrowser, Apache-2.0) browsing the mounted NAS
pools. Replaces the old bare-bones ProxLab-backed file manager (the `/api/file-manager` bridge is no longer
called — last ProxLab tie removed).

## Deployed to CT152
- Binary: `/opt/filebrowser/filebrowser` (v1.4.0-stable, linux-amd64 — not in repo).
- Config: `/opt/filebrowser/config.yaml` (this dir's `config.yaml`) — port 8082, `baseURL: /files`,
  single source `/nas` (all pools), **auth disabled** (`auth.methods.noauth: true`) — single-user behind
  Tailscale/Cloudflare. It builds a SQLite search index of `/nas` on first start (can take a while on huge pools).
- systemd: `filebrowser.service`.

## Wiring (in repo)
- `apps/web/vite.config.ts`: `/files` → `http://127.0.0.1:8082` (same-origin, no rewrite, ws:true).
- `packages/ui/.../FileManager/FilesPanel.tsx`: iframe to `/files/`, rendered for the `files` tab in App.tsx.

To expose pools as separate named roots instead of one `/nas` tree, switch `server.sources` to one entry per
pool (path `/nas/<pool>`, name `<pool>`) and restart filebrowser.
