import type { ZodRawShape } from 'zod'
import type { HttpMethod } from '../api.js'

/**
 * Declarative spec for a fleet tool — one /api/fleet endpoint per tool
 * (same pattern as the ailab-observability MCP server).
 */
export interface ToolSpec {
  name: string
  description: string
  /** zod shape for the tool's input; {} for no-arg tools */
  schema: ZodRawShape
  /** API path or a builder from the (validated) tool args */
  endpoint: string | ((args: Record<string, unknown>) => string)
  /** HTTP method; defaults to GET */
  method?: HttpMethod
  /** JSON request body builder (non-GET tools only) */
  body?: (args: Record<string, unknown>) => unknown
  /** Optional client-side reshaping of the response body */
  transform?: (data: unknown, args: Record<string, unknown>) => unknown
}
