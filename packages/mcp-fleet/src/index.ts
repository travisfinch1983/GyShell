#!/usr/bin/env node
/**
 * ailab-fleet MCP gateway — inter-agent messaging over the AI-Lab
 * ConversationBus (the claude-relay replacement).
 *
 * Exposes the universal proxy's /api/fleet HTTP surface as MCP tools over
 * stdio so ANY external agent (claude instances, OpenClaw, ...) can read and
 * post fleet messages without AI-Lab-specific client code.
 *
 * Env: AILAB_API_URL (default http://127.0.0.1:17890), AILAB_API_TIMEOUT_MS.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { apiGet, apiSend } from './api.js'
import type { ToolSpec } from './tools/types.js'
import { fleetTools } from './tools/fleet.js'

const specs: ToolSpec[] = [...fleetTools]

const server = new McpServer({ name: 'ailab-fleet', version: '0.1.0' })

for (const spec of specs) {
  server.tool(spec.name, spec.description, spec.schema, async (args: Record<string, unknown>) => {
    const path = typeof spec.endpoint === 'function' ? spec.endpoint(args) : spec.endpoint
    const method = spec.method ?? 'GET'
    const result =
      method === 'GET' ? await apiGet(path) : await apiSend(method, path, spec.body?.(args))
    if (!result.ok) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: true,
      }
    }
    const data = spec.transform ? spec.transform(result.data, args) : result.data
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    }
  })
}

const transport = new StdioServerTransport()
await server.connect(transport)
// stdout is the MCP channel — all logging goes to stderr
console.error(`[ailab-fleet-mcp] ready on stdio — ${specs.length} tools`)
