# AI-Lab Addons — developer guide

**Audience:** Claude instances (claude2 etc.) building or migrating an addon WITHOUT touching
AI-Lab core. Follow this and you will not collide with claude1's or fable's work.

## The golden rule

An addon is EXACTLY these five things — nothing else:

1. **`/opt/ai-lab/addons/<id>/`** — the self-contained backend module (this folder's sibling dirs)
2. **`packages/ui/src/renderer_v2/components/Addons/<id>/`** — the native React frontend
3. **ONE entry** in `packages/ui/src/renderer_v2/components/Addons/addonRegistry.ts`
4. **ONE proxy entry** in `apps/web/vite.config.ts`
5. **ONE systemd unit** `ailab-addon-<id>.service`

Building an addon should NOT modify AI-Lab core (stores, App.tsx, sidebar, backend services).
If you think you need a core change, stop and ask claude1/fable first.

**Reference implementation: `upscaler/`** (port 8090) — copy its patterns for everything below.

## AI-Lab stack (what you're plugging into)

- Monorepo, deploy remote = gitea `10.0.0.146`, branch `claude1/chat-rework`.
- `packages/backend` — tsx-from-source, `ai-lab.service` (restart, no build step).
- `packages/ui/src/renderer_v2` — the React app.
- `apps/web` — Vite dev server on **:17889** (`ai-lab-web.service`, HMR — UI changes need only a restart of this, often not even that).
- Universal proxy on **:17890**.
- **Rule #1: connections are backend-proxied, never browser→LAN.** The browser only ever
  requests same-origin paths.

## Backend half: the module folder

```
/opt/ai-lab/addons/<id>/
  app/ or <files>   # the addon's code (path-agnostic — no absolute self-references)
  .venv/            # ITS OWN venv (never share; python -m venv .venv && .venv/bin/pip install ...)
  data/             # its state (sqlite etc.) — lives inside the module
```

Served on **127.0.0.1:<port>** (localhost ONLY — pick an unused port; upscaler=8090).

**Systemd unit** `/etc/systemd/system/ailab-addon-<id>.service` (see `ailab-addon-upscaler.service`):

```ini
[Unit]
Description=AI-Lab addon: <id>
After=network.target

[Service]
WorkingDirectory=/opt/ai-lab/addons/<id>
ExecStart=/opt/ai-lab/addons/<id>/.venv/bin/<server-cmd>   # e.g. uvicorn app:app --host 127.0.0.1 --port <port>
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`systemctl daemon-reload && systemctl enable --now ailab-addon-<id>` (enable = survives reboot).

**JSON, not HTML:** if the app is server-rendered (Jinja/HTMX), add a JSON branch to each page
route (upscaler uses `?format=json` returning the same data the template got) and make action
POSTs return `{ "ok": true, ... }`. The React UI re-fetches view data after each action —
actions do NOT need to return new state.

## Same-origin proxy (one entry)

In `apps/web/vite.config.ts`, next to the existing `/addons/upscaler` entry:

```ts
'/addons/<id>': {
  target: process.env.ADDON_<ID>_URL || 'http://127.0.0.1:<port>',
  changeOrigin: true,
  ws: true,
  rewrite: (path) => path.replace(/^\/addons\/<id>/, '') || '/',
},
```

The browser hits `/addons/<id>/*` only. Images/binaries the addon serves must stream through
the addon backend too (upscaler's `/preview/{asset_id}` — the browser holds no upstream keys).

## Frontend half: native React views

Everything lives under `packages/ui/src/renderer_v2/components/Addons/<id>/`:

- `<id>Api.ts` — thin fetch adapter over `/addons/<id>/...` (copy `upscaler/upscalerApi.ts`:
  `getJson` with `Accept: application/json`, `postForm` with URLSearchParams).
- One `.tsx` per view + a `<Id>.module.scss` using AI-Lab THEME TOKENS
  (`--fg`, `--fg-muted`, `--fg-faint`, `--border`, `--control-bg`, `--app-bg`, `--accent`,
  `--danger`, `--success`, `--font-mono`). Do NOT copy the legacy app's CSS; match AI-Lab.
- Confirmations via `confirmStore.confirm({title, message, confirmText})` — never window.confirm.
- Detail views (like upscaler's Compare) render as overlays/pushed views from a tab, not extra tabs.

**Register in `addonRegistry.ts`** (the ONLY core-adjacent file you touch, additively):

```ts
// manifest — pure data
{ id: '<id>', label: '<Label>', icon: '<slug>', basePath: '/addons/<id>', views: [
  { id: 'main', label: 'Main', kind: 'native' },          // native React view
  // { id: 'legacy', label: 'Legacy', kind: 'embed', path: '/some-page' },  // or iframe a page
]}
// + one NATIVE_VIEWS line per native view:
'<id>.main': MainView,
// + (only if a new icon) one ADDON_ICONS entry mapping the slug to a lucide icon.
```

`kind:'embed'` views iframe `basePath + path` — useful as an interim while you port pages to
native one at a time. Views keep-mount across tab switches (state survives); nested inner
sub-tabs come free from the framework.

## Using AI-Lab resources from an addon

- **SSH out** (remote exec / GPU dispatch): addons use root's default key on CT152
  (`~/.ssh/id_ed25519`, `ai-lab-addons@ct152`). Grant it into the TARGET container's
  authorized_keys (upscaler's is granted to ai-gpu 10.0.0.235 + ai-epyc 10.0.0.234). A reusable
  `addon-grant-ssh` framework script is planned — until then, grant manually and note it in your
  addon's docs.
- **Shared folders:** don't hardcode NAS paths — reference AI-Lab's Shared Folders settings
  (ClusterSettingsService `SharedFolders { containerMountParent:'/mnt/shared', groups[] →
  categories[]{name, hostPath} }`). CT152 already mounts `/imagegen` (incl. training_images),
  `/immich-src`, `/nas/ssd4tbz1`.
- **Cluster data** (GPUs, guests, services): via the universal proxy on :17890 or the
  ailab-observability MCP — never scrape Proxmox directly.

## Migration checklist (worked example: upscaler)

1. Copy the app into `/opt/ai-lab/addons/<id>/`, make it path-agnostic, build its `.venv`.
2. Bind it to `127.0.0.1:<port>`; disable anything that would fight a still-live original
   (upscaler kept worker+sync OFF until cutover).
3. Systemd unit → `enable --now`; verify `curl -s http://127.0.0.1:<port>/` from CT152.
4. Add `?format=json` branches + `{ok}` action responses; verify each with curl.
5. Vite proxy entry; restart `ai-lab-web`; verify `curl http://127.0.0.1:17889/addons/<id>/...`.
6. Build the native views against the LIVE JSON (probe real shapes — don't trust docs alone),
   registry entry + NATIVE_VIEWS lines; `npx tsc -p tsconfig.web.json` must stay at baseline;
   `npm run build:web` must pass.
7. Commit to the branch, push to gitea; claude1 merges/deploys.
8. Cutover: enable the full backend, decommission the original container.

Questions on the framework → fable. Backend/infra/deploy → claude1.
