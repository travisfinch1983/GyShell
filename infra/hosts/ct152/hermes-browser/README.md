# Per-agent browser MCP (CT152): every agent gets its own browser, by default

Built 2026-11-04 by claude1. Travis: "Every agent should get it... a needed tool to become a default". The design
was his (an MCP server with a separate session per agent instead of Hermes's browser_exec, which needs an
externally started Chrome).

| Piece | Where |
|---|---|
| Launcher (stdio MCP) | `/opt/hermes-browser/browser-mcp <agent-id>` — Playwright MCP 0.0.79 (pinned copy `/opt/hermes-browser/mcp-0.0.79`), Chromium from `/opt/ai-lab-mcp/ms-playwright` |
| Per-agent profile | `/var/lib/hermes-browser/agents/<id>` (cookies, logins, tabs persist); output `/var/lib/hermes-browser/out/<id>` |
| Virtual display | `hermes-browser-xvfb.service` = Xvfb **:117** (headed Chromium: anti-bot checks flag headless far more). `:99` belongs to an older root Xvfb (since 2026-09-14): don't touch |
| LAN block | `hermes-browser-egress.service` loads `/etc/hermes-browser-egress.nft`: uid **hermes-browser** may reach DNS 10.0.0.3 and the public internet only; every private / loopback / CGNAT / link-local destination is rejected (TCP reset, so it fails fast) |
| Gateway | one server `browser-<id>` per agent (stdio, stateful; `servers/*.json` here), its 30 tools in group `agent-<id>` |
| Default for new agents | `HermesManagementService.ensureMemoryNamespaceAndFleet` registers `browser-<id>`, adds its tools by NAME, disables `__browser_run_code_unsafe` at the gateway; `deleteAgent` removes the registration (the profile on disk stays) |
| Backfill helper | `add-browser-to-group.py <id>...` (`/opt/hermes-browser/`) |

🛑 **`browser_run_code_unsafe` is never exposed**: it runs arbitrary code in the server process (not the page),
and all agents' browsers share one uid, so it could read another agent's profile or any readable file. It is
(1) disabled at the gateway for every caller, (2) refused by `writeToolGroup` (`NEVER_EXPOSED_TOOL`) for every
group, and (3) never added by provisioning. Excluding it from the groups alone missed the Claude Code instances,
which use the whole gateway (maintenance-claude caught it).

🛑 **The nft rule must match the uid POSITIVELY** (`meta skuid "hermes-browser" jump browser`). The first version
used `meta skuid != X accept`; kernel-generated packets have no socket owner, so they fell through and CT152's own
LAN control packets were rejected for ~6 min (2026-11-04 01:50–01:56). No service impact was found.

Live tool updates: the gateway sends `tools/list_changed` when a group changes, and running Hermes agents refresh
("dynamically refreshed N tool(s)"); no restart or reconnect is needed. AI-Lab's tool-health check now reads those
lines (it used to report every live-added tool as a stale set).

Verified 2026-11-04: eBay search loads (title "Ps5 Console Firmware for sale | eBay", no challenge; Firecrawl was
refused); screenshots come back as images; LAN addresses refused; test-agent used it live from Matrix. Idle cost:
one node process per agent that has used it, plus Chromium (about 1.2 GB with one active).

Also disabled 2026-11-04: `playwright__browser_run_code_unsafe` on the older SHARED `playwright` server (runs as
ROOT with no LAN block; in no agent group, reachable only by whole-gateway callers). Re-enable with
`POST /api/v0/tools/enable?entity=playwright__browser_run_code_unsafe` if a Claude instance genuinely needs it.

## Field notes (Optimus, first real use 2026-11-04)
- **eBay: never deep-link a search.** A cold hit on `/sch/i.html?_nkw=...` (with or without filters) returns
  eBay's generic "SORRY — Something went wrong" page. Open `https://www.ebay.com` first, type into the search box
  (`#gh-ac`) and submit: the same results page then loads (13,000+ results, prices, seller feedback). The search
  endpoint wants the cookies the homepage sets.
- **Extract with `browser_evaluate`, not the accessibility snapshot**: one call returned 62 title/price pairs.
- **`browser_take_screenshot` needs an explicit `scale` (`"css"` or `"device"`)**: upstream marks it required
  despite documenting a default of css (still so in @playwright/mcp 0.0.84, checked 2026-11-04).
- The profiles' eBay ship-to defaults to **US 85541** (eBay's own guess), so prices and delivery estimates are
  US-domestic.

## Shared skill `custom/web-browser` (2026-11-04)
Library copy: `/root/.hermes/skills/custom/web-browser/SKILL.md` (repo copy: `skill/SKILL.md` here). Copied into
all 23 profiles; `ensureMemoryNamespaceAndFleet` assigns it whenever it first gives an agent the browser, so new
agents get it by default and unassigning it from one agent sticks. Edit the library copy, then re-copy to profiles.
Running agents see it in their skill index from their next new session.
