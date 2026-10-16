# Image Request page — imagine.deeveeyant.com

Phone-first page for building an image-generation request (model family, LoRAs, pose, reference
images with per-image notes, free-text request) and sending it to an image agent as ONE Matrix
message from the person's own account. Templates save/load the whole selection.

- Runs on CT152: `/opt/imagine` (venv `.venv`: fastapi, uvicorn, python-multipart, pillow,
  pillow-heif, httpx, pyjwt[crypto]); `imagine.service`, port 17896.
- Public: Cloudflare tunnel 711a8c4e → NPM (10.0.0.106, proxy host 54) → :17896. Access app
  "Image Request" (aud in config.json), policy "Image Request - Travis + Kyla".
- LAN/tailnet: NPM proxy host 54 sets `X-Imagine-Peer $realip_remote_addr` in its advanced
  config. Do NOT switch to X-Real-IP: NPM's nginx.conf trusts X-Real-IP from all 10.0.0.0/8, so a
  LAN client can forge it. Trusted devices = builtins + `/opt/ai-lab/.gybackend-data/trusted-sources.json`.
- Who is using it: Cloudflare Access / the LAN trust list is only the GATE. A PIN typed on the page
  picks the PERSON (devices are shared); a 1-year HttpOnly session cookie remembers it, "👤 name"
  in the header locks the page again. 8 wrong PINs per IP per 10 min → 429. PINs are pbkdf2-hashed
  in `/var/lib/imagine/pins.json` (0600) and set by an admin in Manage → PINs.
- Restricted people (`"restricted": true`, Kyla) see only what an admin ticked in Manage mode
  (same grids, checkboxes = "shown to them"; table `visibility`: base:<fam>, ft:<fam>/<id>,
  lora:<fam>/<id>). A family shows when anything in it is ticked. Enforced server-side on every
  catalogue route and on send, not just hidden in the UI.
- First card in each finetune panel = "Base model": sends `FINETUNE: none, use the official base,
  quant is your choice`. A specific quant of the base is picked as an ordinary finetune card.
- State (not in git): `/var/lib/imagine/` — imagine.db (refs, templates, history, sessions, visibility), pins.json and
  matrix-sessions.json (0600, per-person Matrix access tokens from the one-time password login;
  the password itself is never stored). Uploads: `/imagegen/request_refs/<person>/<YYYY-MM>/`.
- Why one message: Hermes starts a turn on the first Matrix event, so separate m.image events
  would make the agent answer before the request arrives; a third "display" account in the DM
  would flip Hermes' room classification (named room, 3 members) to a group needing @mentions.
  The m.text body carries absolute file paths; formatted_body shows the images inline.
- Catalogue: `models.json` (families, badges, descriptions, dirs, lora_dirs). LoRA layer badge =
  first Civitai category tag, else the filename's primary-tag prefix.
- Adding a person / agent: `people[]` (`admin` / `restricted` flags) and `agents{}` in config.json,
  restart the service, then give them a PIN in Manage → PINs.
