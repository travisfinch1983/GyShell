#!/usr/bin/env node
/**
 * ailab-cluster MCP — cluster inventory + credential vault (the proxlab-cluster
 * replacement). ProxLab / CT107 is decommissioned and GONE; this exposes
 * AI-Lab's ported inventory + credential-vault REST as MCP tools over stdio,
 * with the SAME tool names the old proxlab-cluster MCP had (list_credentials,
 * get_credential, store_credential, update_credential, cluster_search,
 * get_guest, list_hosts, get_host, list_inventory).
 *
 * Env: AILAB_API_URL (default http://127.0.0.1:17890), AILAB_API_TIMEOUT_MS.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { apiGet, apiSend } from './api.js'
import type { ToolSpec } from './tools/types.js'
import { clusterTools } from './tools/cluster.js'

const specs: ToolSpec[] = [...clusterTools]

const server = new McpServer({ name: 'ailab-cluster', version: '0.1.0' })

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
console.error(`[ailab-cluster-mcp] ready on stdio — ${specs.length} tools`)
