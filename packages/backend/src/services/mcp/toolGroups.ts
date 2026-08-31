/**
 * Shared MCPJungle tool-group writer.
 *
 * ALL non-native tools reach an agent through MCPJungle: servers are registered with the
 * gateway, and a per-agent tool GROUP (`agent-<id>`) dictates which of those tools that agent
 * can see. The agent itself only ever holds ONE MCP server entry pointed at
 * /v0/groups/agent-<id>/mcp. Nothing is registered directly against Hermes.
 *
 * There were two independent implementations of "write an agent's group" — HermesManagementService
 * (Hermes agents) and agentToolsHttp (AI-Lab agents) — and they drifted: only one validated its
 * input, and the other deleted before creating. That delete-then-create destroyed Wren's entire
 * toolset on 2026-07-25 when one bad tool name made the recreate 400. This module is the single
 * place that logic lives now.
 *
 * Two gateway properties drive the design:
 *   1. MCPJungle rejects the WHOLE request if any single included_tools entry is not a live,
 *      ENABLED tool ("tool X does not exist or is disabled"). A bare SERVER name (what selecting a
 *      whole toolset submits) and a momentarily-disabled server both trigger it.
 *   2. PUT /api/v0/tool-groups/<name> (MCPJungle >= 0.4.5) is an atomic in-place update: on a 400
 *      the previous membership survives untouched. PUT 404s when the group does not exist, so POST
 *      remains the create path. Never DELETE first.
 */

export interface ToolRegistry {
  /** Every live, enabled tool name, as `server__tool`. */
  valid: Set<string>
  /** server name -> its live enabled tool names, used to expand a whole-toolset selection. */
  serverTools: Map<string, string[]>
}

/** Read the gateway's live registry. Throws if the gateway is unreachable — callers must NOT
 *  fall back to writing blind, since a wrong write can cost an agent its tools. */
export async function loadToolRegistry(gatewayBase: string, timeoutMs = 8000): Promise<ToolRegistry> {
  const gw = gatewayBase.replace(/\/+$/, '')
  let servers: Array<{ name: string; enabled?: boolean }>
  try {
    servers = await (await fetch(`${gw}/api/v0/servers`, { signal: AbortSignal.timeout(timeoutMs) })).json() as Array<{ name: string; enabled?: boolean }>
  } catch (e) {
    throw new Error(`cannot reach the MCP gateway to validate tools: ${(e as Error).message}`)
  }
  const valid = new Set<string>()
  const serverTools = new Map<string, string[]>()
  for (const s of servers) {
    if (s.enabled === false) continue
    try {
      const tools = await (await fetch(`${gw}/api/v0/tools?server=${encodeURIComponent(s.name)}`, { signal: AbortSignal.timeout(timeoutMs) })).json() as Array<{ name: string; enabled?: boolean }>
      const live = tools.filter((t) => t.enabled !== false).map((t) => t.name)
      serverTools.set(s.name, live)
      for (const n of live) valid.add(n)
    } catch (e) {
      // Which server failed was never recorded — a registry built while one
      // server was down validated selections against a silently smaller world.
      console.warn(`[tool-groups] tool enumeration failed for '${s.name}' — its tools are absent from the registry this pass (${(e as Error)?.message})`)
    }
  }
  return { valid, serverTools }
}

/** Turn a UI selection into a submittable tool list: keep known-good tools, EXPAND a bare server
 *  name into that server's enabled tools, and report anything left over as unknown. */
export function resolveSelection(selection: string[], reg: ToolRegistry): { included: string[]; unknown: string[] } {
  const resolved = new Set<string>()
  const unknown: string[] = []
  for (const name of selection) {
    if (reg.valid.has(name)) { resolved.add(name); continue }
    const expand = reg.serverTools.get(name)
    if (expand && expand.length) { for (const n of expand) resolved.add(n); continue }
    unknown.push(name)
  }
  return { included: [...resolved], unknown }
}

/** Human-readable refusal for a selection containing names the gateway would reject. */
export function unknownToolsError(group: string, unknown: string[]): Error {
  const shown = unknown.slice(0, 12).join(', ')
  const more = unknown.length > 12 ? ` (+${unknown.length - 12} more)` : ''
  return new Error(`refusing to modify ${group} - ${unknown.length} selected item(s) are not live, enabled gateway tools: ${shown}${more}. Existing tools left untouched.`)
}

/** Write a group's membership. PUT (atomic in-place) with POST as the create path. Never deletes. */
export async function writeToolGroup(
  gatewayBase: string, group: string, description: string, tools: string[], timeoutMs = 8000,
): Promise<void> {
  const gw = gatewayBase.replace(/\/+$/, '')
  const headers = { 'Content-Type': 'application/json' }
  const body = JSON.stringify({
    name: group, description, included_servers: [], included_tools: tools, excluded_tools: [],
  })
  let r = await fetch(`${gw}/api/v0/tool-groups/${group}`, { method: 'PUT', headers, body, signal: AbortSignal.timeout(timeoutMs) })
  if (r.status === 404) {
    r = await fetch(`${gw}/api/v0/tool-groups`, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) })
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '')
    throw new Error(`group update -> ${r.status}: ${detail} (existing tools left untouched)`)
  }
}

/** Read a group's current membership, or null if it does not exist. */
export async function readToolGroup(gatewayBase: string, group: string, timeoutMs = 8000): Promise<string[] | null> {
  return (await readToolGroupStatus(gatewayBase, group, timeoutMs)).tools
}

/**
 * Like readToolGroup, but keeps "the group does not exist" (404 — normal on an
 * agent's very first sync) distinguishable from "the read FAILED" (gateway
 * down/blip). Collapsing both to null made the pre-write backup skip silently
 * on exactly the flaky-gateway case it exists for, while any fix that emitted
 * on bare null would have alarmed on every first-time agent instead.
 */
export async function readToolGroupStatus(
  gatewayBase: string, group: string, timeoutMs = 8000,
): Promise<{ tools: string[] | null; missing: boolean }> {
  const gw = gatewayBase.replace(/\/+$/, '')
  try {
    const r = await fetch(`${gw}/api/v0/tool-groups/${group}`, { signal: AbortSignal.timeout(timeoutMs) })
    if (r.status === 404) return { tools: null, missing: true }
    if (!r.ok) return { tools: null, missing: false }
    return { tools: ((await r.json()) as { included_tools?: string[] })?.included_tools ?? null, missing: false }
  } catch {
    return { tools: null, missing: false }
  }
}

/** Validate + expand + write, in the one safe order. Returns what was actually submitted. */
export async function syncToolGroup(
  gatewayBase: string, group: string, description: string, selection: string[],
): Promise<{ included: string[] }> {
  const reg = await loadToolRegistry(gatewayBase)
  const { included, unknown } = resolveSelection(selection, reg)
  if (unknown.length) throw unknownToolsError(group, unknown)
  await writeToolGroup(gatewayBase, group, description, included)
  return { included }
}
