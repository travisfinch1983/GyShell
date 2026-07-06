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
