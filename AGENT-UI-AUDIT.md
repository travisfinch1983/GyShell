# AGENT-UI-AUDIT — agent-system UI/settings vs the Hermes + fleet backend

**Date:** 2026-07-03 · **Author:** fable · **Branch:** `fable/chat-rework` (post-merge of `claude1/chat-rework` @ d50686c)
**Method:** traced every agent/model/chat surface from component → store → bridge/RPC/HTTP → backend service; live-probed endpoints where wiring was ambiguous.

**NEW backend** = `/api/hermes/*` (control plane + SSE), `/api/fleet/*` (ConversationBus), `/api/proxy/llm/catalog` (tagged `CatalogModel[]`), `/api/proxy/external-sources` (model-endpoints registry). **OLD** = `gyshell.agent.*`/`gyshell.agents.*` gateway RPCs (AgentService_v2), local `settings.models`, ProxLab discovery, minion/relay code.

**Reminder on intent (from the Hermes plan):** `AgentService_v2` deliberately REMAINS the engine for Travis's primary chat tab; Hermes powers *fleet* agents. "Still on `gyshell.agent.*`" is therefore not automatically wrong — verdicts below account for that.

---

## 1. Classified surfaces

| # | Surface | Files (key) | Wired to | Verdict | Pri |
|---|---------|-------------|----------|---------|-----|
| 1 | **Agents primary tab** (Hermes builder + interim prompt) | `components/Agents/*`, `stores/hermesApi.ts`, `stores/HermesAgentsStore.ts` | NEW: `/api/hermes/agents*`, `/api/proxy/llm/catalog` | **NEW-OK** (seed) | — |
| 2 | **Fleet Feed primary tab** | `components/Fleet/FleetPanel.tsx`, `stores/FleetStore.ts` | NEW: `fleet:*` RPCs + `fleet:record` broadcast, `/api/fleet/*` | **NEW-OK** | — |
| 3 | **Claude tab** (consolidated instances) | `components/Claude/*`, `stores/instanceManager.ts` | NEW: `/api/claude/instances*` → CT180 manager | **NEW-OK** | — |
| 4 | **Hermes chat surface** (streaming, per-agent) | *(does not exist — interim one-shot prompt box only)* | SSE `/api/hermes/agents/:id/stream` unconsumed | **MISSING** | **P0** |
| 5 | **Settings › Models — External Model Connections + importer** | `SettingsView.tsx` §models (~1648–1752), `AppStore.ts:2544–2655` (`gyshell.models.listRemote`, `settings.set({models})`) | OLD: raw `/v1/models` probes; **API keys stored inline in local settings** | **ADAPT** → external-sources registry UI | **P0** |
| 6 | **Settings › Models — ProxLab discovery** | `Settings/ProxlabServicesPanel.tsx`, `services/ProxlabDiscovery.ts` (hardcoded `10.0.0.140:7777`) | OLD: ProxLab proxy — **probed 2026-07-03: host DEAD (conn refused)**; section is dark at runtime | **DEAD** (repoint or remove) | **P0** |
| 7 | **Settings › Agents (April-era)** | `Settings/AgentsPanel.tsx` (mounted `SettingsView.tsx:1012/2408`), `AppStore.ts:109,2658–2681` | OLD: `gyshell.agents.getAll/save/delete` → settings-backed `AgentDefinition`s fed to AgentService_v2 | **ADAPT/DEAD** — superseded by the Agents tab; see open question Q1 | **P1** |
| 8 | **Main chat vertical** (GlobalChat/ChatPanel/ChatStore/RichInput/queue) | `components/Chat/*`, `stores/ChatStore.ts`, send path `AppStore.ts:3039→3090` (`gyshell.agent.startTask`) | OLD `gyshell.agent.*` — **by design** (AgentService_v2 retained for Travis's chat) | **NEW-OK (by design)**, with ADAPT items 8a/8b | — |
| 8a | └ chat model/profile picker | `ChatPanel.tsx:551,1250` ← `settings.models.profiles` | per-profile `/v1/models` discovery in local settings; blind to `[TAG]` catalog + external sources | **ADAPT** | P1 |
| 8b | └ slash-commands + session browser (chat-rework reqs) | `RichInput.tsx`, `ChatHistoryPanel.tsx` | n/a — never built (parked tasks) | **MISSING** | P2 |
| 9 | **AgentRail** (left icon strip) | `components/AgentRail/AgentRail.tsx` (mounted `App.tsx:193`) | Chat toggle: fine. Agent icons: OLD `appStore.agents` (`AgentDefinition`) + `gyshell.agents.onActiveCountsUpdated` | **ADAPT** — repoint icons to Hermes agents / fleet presence, or drop the icon list | **P1** |
| 10 | **Minion island** | `stores/MinionStore.ts`, `stores/MinionContext.tsx`, `components/Minions/*` (barrel even re-exports a nonexistent `MinionSidebar`), `services/MinionRouter.ts`, `services/minionMessageParser.ts` (+ scss) | Nothing — zero external importers; banners say DORMANT 2026-07-02 | **DEAD** — delete whole island | **P1** |
| 11 | **Settings › cluster-proxy (Claude Max prompt capture)** | `Settings/ProxySettingsPanel.tsx` → `/api/proxy/claude-max/debug/*` | Model-plane debug tool; works | **NEW-OK** (fold into future Settings › Models later) | P2 |
| 12 | **AI infra stores** (out of agent scope, noted for completeness) | `AiProvidersStore.ts`, `AiServicesStore.ts`, `ClusterSettingsPanels.tsx` (incl. the "AI Agents" **vmid map** — infra placement, not personas) | `/api/ai/*`, `gyshell.clusterSettings` — service lifecycle/install | **KEEP** (not agent-system) | — |
| 13 | **Hermes ops visibility** (usage metrics, bus-subscriber status, per-agent session state) | *(no UI)* — backend emits `usageUpdate` + `HermesBusSubscriber` exists | NEW backend capability, no surface | **MISSING** | P2 |

Supporting facts (traced, with refs):
- **Chat never touches the new system**: zero `hermes|fleet|minion|relay|persona` hits across `components/Chat/*` + `ChatStore` + `ChatQueueStore`. Send path: `RichInput.tsx:580` → `ChatPanel.tsx:392` → `AppStore.sendChatMessage:3039` → `gyshell.agent.startTask:3090`; replies via `gyshell.agent.onUiUpdate:2128`. Legacy specialist-router already removed (`AppStore.ts:3044–3050`).
- **No Settings surface calls any NEW route**; `external-sources` has 0 references in all of renderer_v2 (workstream 3 not started — matches plan).
- **No `claude-relay`/`6277`/`10.0.0.161` references remain in packages/ui.** The three surviving "relay" strings are unrelated live subsystems (fleet `relay-inbound`, catalogInstall PTY relay ×2).
- **Old `agents:*` RPCs**: web gateway throws `METHOD_NOT_FOUND` (`WebSocketGatewayAdapter.ts:1356–1376` guard); electron adapter persists to settings AND calls `agentService.updateSettings` — so the old panel half-works on electron, no-ops on web.

## 2. Open questions for triage
- **Q1 (drives #7/#9):** does AgentService_v2 still *invoke* `AgentDefinition`s at runtime (the `agentActiveCounts` badge source), or are they inert since the specialist-router removal? If inert → old Settings›Agents + the AgentRail icon list are DEAD, delete both (redirect the Settings nav item to the Agents tab). If still invoked (e.g. sub-agent tool) → ADAPT: keep panel, but its model multi-select must move off dead ProxLab items to the tagged catalog.
- **Q2 (drives #6):** anything else consuming `ProxlabDiscovery.ts` besides the Settings models section? (TTS settings imports look adjacent.) Repointing it at the AI-Lab proxy (`/api/proxy/llm/v1/models` etc.) may rescue several panels in one move.
- **Q3 (drives 8a):** chat model profiles vs tagged catalog — replace profile discovery with catalog entries outright, or keep profiles and add catalog-backed entries alongside? (Profiles carry per-profile params the catalog doesn't have.)

## 3. Prioritized rework backlog (proposed build order)
1. **P0 — Hermes chat surface** (my task #15, already scoped): EventSource on `/stream`, render `message`/`thought`/`tool_*` cards + `commands` slash menu + `usageUpdate` meter off `hermesStreamEventSchema`; replaces the interim prompt box in the Agents tab.
2. **P0 — Settings › Models rework** (absorbs my task #16): new external-sources registry UI (`/api/proxy/external-sources` CRUD, masked keys, `hasKey`, per-source enable + metrics) + tagged-catalog browser; **migrate/retire the local-settings External Model Connections** (today keys sit unmasked in local settings and the section's ProxLab discovery is dead — worst state in the audit).
3. **P0 — kill/repoint ProxLab discovery**: point `ProxlabDiscovery.ts` at the AI-Lab proxy or delete `ProxlabServicesPanel` in favor of the catalog browser (answer Q2 first).
4. **P1 — delete the minion island** (safe-delete list in §1 #10 — no live importers; pairs with the GyShell→AI-Lab rename sweep).
5. **P1 — resolve Q1**, then delete-or-adapt old Settings›Agents + AgentRail icon feed accordingly (redirect Settings nav to the Agents primary tab).
6. **P1 — chat profile picker → tagged catalog** (Q3 decision), so `[MAX]/[AN]/[DS]/[OC]` models are pickable in Travis's chat once external-source forwarding is proven.
7. **P2 — Hermes ops visibility**: usage/bus-subscriber/session-state chips in the Agents tab; fold Claude-Max capture panel into Settings › Models.
8. **P2 — chat-rework leftovers**: slash-command palette in RichInput, session-browser UI (parked tasks #5/#6).
