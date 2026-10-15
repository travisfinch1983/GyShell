# poses-site: poses.deeveeyant.com

A read-only, numbered browser for `/imagegen/pose_library`, built so Kyla can pick a pose and tell Cinder its number.

- **Deployed:** CT152 `/opt/poses-site/`, unit `poses-site.service`, port 17895. `index.html` is re-read on every request; `server.py` changes need `systemctl restart poses-site`.
- **Data:** reads `poses.json`, `pose_images/`, `mannequin_images/` and `skeletons/` live and never writes to them. WebP previews are cached in `/var/cache/poses-site`.
- **Routing:** Cloudflare tunnel `poses.deeveeyant.com` -> NPM `10.0.0.106:80` (NPM proxy host #53) -> `10.0.0.219:17895`. On the LAN, the Technitium wildcard reaches NPM directly.
- **Auth:** Cloudflare Access app "Pose Library" (`0b46e946-6d60-417d-8dfd-290cf13aa2fe`), reusable policy "Email Address Authentication", 24h session. As with every split-horizon host, LAN clients bypass Access.
- **Cinder:** "pose #N" means the poses.json entry with `index == N`. See the "Pose library" section in the cinder and cinder-kyla AGENTS.md.
- **Upscaled originals:** 146 poses had only the 224x284 thumbnail. `tools/upscale_small.py` (SeedVR2 7B on ai-epyc :9312, one worker per GPU; defaults to the two 5060 Tis, gpus 1 and 2) writes `pose_library/upscaled_images/<id>.png`. It never touches `pose_images/`, which the ComfyUI Krea2 gallery reads. The site prefers the full source, then the upscale, then the thumbnail. Re-run it after adding thumbnail-only poses; it skips anything already done.
