/**
 * Reports → RAG. Each report category owns a vector collection; every submitted
 * report is vectorised into it so reports are semantically searchable.
 *
 * The unified memory service speaks MCP (streamable HTTP JSON-RPC), not REST, so
 * this is a minimal client rather than a fetch to a REST route. The BACKEND makes
 * this call — never the browser (coding standard #1).
 *
 * 🔑 DEDUP: doc_id is the PAGE ID, verified against the live service (2026-08-30):
 * re-storing the same doc_id REPLACES the vector rather than adding a second copy,
 * so editing a report and re-vectorising it cannot leave an orphaned v1 haunting
 * search results. Never key this on the version number.
 *
 * Failure policy: vectorisation NEVER blocks a write. A report that saved but did
 * not index is a working report with degraded search; a write refused because the
 * indexer was down would lose the operator's work. Failures are reported to the
 * caller so they can surface as a notification instead of vanishing.
 */

// Read env PER CALL, never at module load: a module-load read bakes whatever the
// environment happened to be at import time, which is both untestable and a trap
// for any caller that configures after importing.
const memoryUrl = (): string => process.env.UNIFIED_MEMORY_URL || 'http://127.0.0.1:9847'
/** Caller identity for the memory service's per-caller routing. */
const caller = (): string => process.env.AILAB_REPORTS_MEMORY_CALLER || 'agent:ailab-reports'

async function rpc(payload: unknown, timeoutMs = 20_000): Promise<any> {
  const res = await fetch(`${memoryUrl()}/u/${encodeURIComponent(caller())}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`memory service HTTP ${res.status}: ${text.slice(0, 200)}`)
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5))
  }
  return text ? JSON.parse(text) : null
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  await rpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ai-lab-reports', version: '1' } },
  })
  const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } })
  if (r?.error) throw new Error(String(r.error?.message ?? 'tool error'))
  const text = r?.result?.content?.[0]?.text
  try { return typeof text === 'string' ? JSON.parse(text) : text } catch { return text }
}

export interface ReportVectorInput {
  collection: string
  pageId: string
  title: string
  category: string
  issue: string
  cause?: string
  fix?: string
  author?: string
  version: number
  body: string
}

/**
 * Index a report. The stored text leads with the summary fields so a semantic hit
 * on "what fixed the pruner" matches the fix line, not just prose buried in the body.
 */
export async function indexReport(input: ReportVectorInput): Promise<void> {
  const text = [
    `REPORT: ${input.title}`,
    `category: ${input.category}`,
    `issue: ${input.issue}`,
    input.cause ? `cause: ${input.cause}` : '',
    input.fix ? `fix: ${input.fix}` : '',
    '',
    input.body,
  ].filter(Boolean).join('\n')

  await callTool('collection_store', {
    collection: input.collection,
    text,
    doc_id: input.pageId,          // stable across versions — replaces, never duplicates
    metadata: JSON.stringify({
      page_id: input.pageId, category: input.category, title: input.title,
      issue: input.issue, author: input.author ?? '', version: input.version,
    }),
  })
}

export async function searchReports(collection: string, query: string, limit = 10): Promise<unknown> {
  return callTool('collection_search', { collection, query, limit })
}
