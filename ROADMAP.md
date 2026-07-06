# AI-Lab Roadmap

Living list of planned / deferred work. Add items as they surface; check off when shipped.

## Skills library
- [ ] **Semantic / vector search of skills** *(roadmap — not yet scheduled)*
  Layer embedding-based semantic search on top of the existing tag + full-text
  search. The backend already exposes `GET /api/hermes/skills/search?q=`
  (metadata + SKILL.md content grep) and `GET/PUT /api/hermes/skills/tags`.
  Vector search adds a third, meaning-based retrieval mode: embed each SKILL.md
  via the local embedder behind the AI-Lab proxy, persist the vectors, rank by
  cosine similarity. Would let "find me a skill for X" work without keyword overlap.
- [ ] Extend **inline** cluster-localization to more skills if the advisory
  blocks prove insufficient in day-to-day agent use.
- [x] Tag system + full-text content search — shipped `87c06d2`.
- [x] Cluster-localization of imported skills — 19 cloud-only OMITted, 71
  localized (advisory blocks; ~20 also inlined), 614 KEEP verified.
  See memory `project_agent_skills_curation`.

## Chat interface
- [ ] Continue the chat-interface rework *(current focus)*.

## Notes / where things live
- Skills library: Hermes host `/root/.hermes/skills/`; tag sidecar
  `/root/.hermes/skill-tags.json`. Backend: `HermesManagementService` +
  `hermesHttp`. UI: `renderer_v2/components/Settings/HermesSkillsPanel.tsx`.
- kvcache Optane shim: auto-provisioned per llama.cpp launch (`ai.js`); see
  memory `project_kvcache_proxy`.

## AI Services / GPU panel / Addons (queued 2026-07-06)
- [ ] **#1 Service-card GPU badges** — cards regressed (pre-gitea overwrite); show a badge per GPU currently assigned to each service. Data: registry `gpuPciIds` → gpuMonitor resolve (same as `comfyui-instances`).
- [ ] **#2 llama.cpp / ik_llama.cpp name-override field** — add a model-id alias-override input to the launch options, persisted to the launch TEMPLATE (`aliasOverride`) so it survives without hand-editing after each launch.
- [ ] **#3 GPU fleet panel: meters → sparklines** — swap the GPU% + VRAM bar meters to sparklines. (Pure UI; accumulate rolling samples client-side.) → Fable
- [ ] **#4 Per-service resource sparklines on cards** — regressed. Each card gets a GPU-usage sparkline (avg across its assigned GPUs) + a VRAM sparkline — attributed to the SERVICE, not the whole GPU. Needs backend: nvidia-smi `pmon` (per-pid SM%) + `--query-compute-apps` (per-pid VRAM) + pid→service mapping.
- [ ] **#5 Runtime addon proxy (no rebuild)** — addons as self-contained services with own UI, reverse-proxied into an Addons sub-tab created at runtime. Precedent: Dynacat `/dash` embed. Registry-driven: register addon {name,url} → backend proxies `/addons/<name>/*` → UI fetches addon list + renders iframe sub-tab. No AI-Lab rebuild/restart.
- [ ] **#5b Port existing addons to self-served** — once the runtime addon proxy lands, migrate upscaler (8090) + rule34 (8091) out of the compiled NATIVE_VIEWS into their own self-served services + manifests, for consistency with fansly.
