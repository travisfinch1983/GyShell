# GyShell — Multi-Agent Group Chat Fork

> Fork of [GyShell v1.3.0](https://github.com/MrOrangeJJ/GyShell) by TUOTUO, adapted from an Electron desktop AI terminal into a **web-served multi-agent group chat UI** with direct model routing, a collapsible sidebar, live activity feed, and orchestrator auto-classification.

---

## What This Fork Changes

GyShell upstream is a full-featured AI-native terminal app (Electron + TUI + mobile-web). This fork repurposes the web rendering layer into a self-hosted multi-model chat workspace where multiple LLM specialists (coder, creative, architect, chat, etc.) can be addressed directly or auto-routed through an orchestrator.

### Key Differences from Upstream

| Area | Upstream GyShell 1.3.0 | This Fork |
|------|------------------------|-----------|
| **Delivery** | Electron desktop app | Web-served via Express (no Electron required) |
| **Model routing** | Single profile with role slots (Global, Thinking, Action, Compaction) | Multi-specialist routing: direct card selection or orchestrator auto-classification |
| **Model API calls** | Routed through internal Claude Code pipeline | Direct HTTP fetch to model endpoints (KoboldCpp, vLLM, OpenAI-compatible) via ProxLab proxy |
| **Sidebar** | None | Collapsible model status cards + live activity feed with role icons |
| **Chat messages** | Standard assistant/user | Color-coded by role, tinted backgrounds, role name headers, timestamps |
| **Message persistence** | Session-based | localStorage persistence with cross-refresh rehydration |
| **Orchestrator** | Built-in model profile routing | 9B classifier auto-routes to specialists based on message content |
| **Edit/Resend** | Standard chat rollback | Inline edit and resend for specialist messages |
| **Activity feed** | None | Real-time inter-agent message log with role filters |

### New Components

- **`MinionSidebar`** — Collapsible sidebar with resizable cards/feed panels, draggable divider
- **`MinionCards`** — Model status cards with live status dots, role badges, stop buttons, selection
- **`MinionFeed`** — Color-coded activity feed with role filtering
- **`MinionRouter`** — Direct API routing service bypassing Claude Code pipeline
- **`MinionStore`** — MobX reactive state for multi-agent message bus and model status
- **`TranscriptService`** — Chat and activity recording with configurable retention
- **Collapsed sidebar** — 40px icon strip with lucide role icons, status dot overlays, activity pulse indicator

### Role Icons (Collapsed Sidebar)

| Role | Icon | Color |
|------|------|-------|
| Orchestrator | Brain | `#8b5cf6` |
| Chat | MessageCircle | `#10b981` |
| Coder | Code | `#3b82f6` |
| Creative | Palette | `#ec4899` |
| Architect | Blocks | `#f59e0b` |
| Scout | Search | `#22c55e` |
| Action | Zap | `#6366f1` |
| Thinking | Lightbulb | `#a855f7` |
| Compaction | Layers | `#64748b` |

---

## Architecture

```
Browser (GyShell Web UI)
  |
  |-- WebSocket ──> gyshell-web backend (Express + node-pty)
  |                   |── Terminal sessions (tmux-backed)
  |                   |── Gateway RPC (session management, tools, settings)
  |                   |── File browser, monitor panels
  |
  |-- HTTP fetch ──> ProxLab proxy ──> Model endpoints
  |                   |── KoboldCpp (Qwen, Darkidol, etc.)
  |                   |── vLLM (various models)
  |                   |── Any OpenAI-compatible API
  |
  MinionRouter (browser-side)
    |── Direct routing: user selects card -> fetch to model endpoint
    |── Auto routing: orchestrator 9B classifies -> routes to specialist
    |── Per-role conversation history (10 turns)
    |── AbortController per role for cancellation
```

### WebSocket Layer

The web shim (`apps/web/src/gyshell-web-shim.ts`) replaces Electron's IPC with a WebSocket connection to the Express backend. All RPC calls (session CRUD, terminal I/O, settings, tools) go through this transport. The gateway service (`packages/backend/src/services/Gateway/`) handles session lifecycle, model interactions, and WebSocket client management.

Key files for the WebSocket architecture:
- `apps/web/src/gyshell-web-shim.ts` — Browser-side WebSocket shim replacing Electron IPC
- `apps/web/src/main.ts` — Web entry point, bootstraps the shim
- `packages/backend/src/services/Gateway/WebSocketGatewayAdapter.ts` — Server-side WS adapter
- `packages/backend/src/services/Gateway/WebSocketGatewayControlService.ts` — WS policy and lifecycle
- `packages/backend/src/services/Gateway/WebSocketClientTransport.ts` — Client transport abstraction
- `packages/backend/src/services/Gateway/types.ts` — Gateway type definitions
- `packages/ui/src/renderer_v2/stores/AppStore.ts` — Frontend store consuming WS events

### Model Routing (MinionRouter)

The `MinionRouter` (`packages/ui/src/renderer_v2/services/MinionRouter.ts`) handles all specialist communication:

1. **Direct mode**: User clicks a model card in the sidebar, types a message. MinionRouter resolves the endpoint from the active profile's slot configuration, builds a clean context (system prompt + conversation history + new message), and fetches directly.

2. **Auto mode**: No card selected. Message goes to the orchestrator (9B model) which returns a JSON classification `{"route": "coder"}`. MinionRouter then dispatches to the classified specialist.

3. **Message injection**: Responses are injected into the main ChatStore via synthetic `handleUiUpdate` ADD_MESSAGE events, appearing inline with native chat messages.

---

## Running

### Prerequisites

- Node.js 18+
- npm

### Development

```bash
git clone https://github.com/travisfinch1983/GyShell.git
cd GyShell
npm install
npm run dev
```

### Web-only (no Electron)

```bash
npm run dev:web
# or build and serve:
npm run build:web
node apps/web/dist/server.js
```

The web UI runs on port 3456 by default.

---

## Upstream

This is a fork of [GyShell v1.3.0](https://github.com/MrOrangeJJ/GyShell) by TUOTUO (tuotuo@gyshell.com). The upstream project is an AI-native terminal application supporting Electron, TUI, and mobile-web delivery surfaces. See the [upstream README](https://github.com/MrOrangeJJ/GyShell/blob/main/README.md) for the full feature set and documentation.

## License

This project inherits the upstream **CC BY-NC 4.0** license.
