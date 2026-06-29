// API-level tool-call metrics — classify tool calls seen at the universal proxy's chat-completions
// boundary, per upstream service. Two error classes:
//   - "structure"      : tool_call arguments aren't valid JSON, OR valid JSON that violates the tool's
//                        declared parameters schema (missing required keys / wrong primitive types).
//   - "hallucination"  : tool_call function.name was NOT in the request's offered tools[] list.
// Counts accumulate in-process per upstream serviceId; the metrics poller folds deltas into the durable
// per-(model+settings) dashboard rows. Shared singleton — imported by both proxy.js (writer) and the
// poller (reader).
/* eslint-disable */
// @ts-nocheck

const acc = new Map() // serviceId -> { total, structureErrors, hallucinationErrors, model, svcId }

function typeOk(v, t) {
  if (Array.isArray(t)) return t.some((x) => typeOk(v, x))
  switch (t) {
    case 'string': return typeof v === 'string'
    case 'number': case 'integer': return typeof v === 'number'
    case 'boolean': return typeof v === 'boolean'
    case 'array': return Array.isArray(v)
    case 'object': return v != null && typeof v === 'object' && !Array.isArray(v)
    case 'null': return v === null
    default: return true
  }
}

/** Light JSON-schema check: required keys present + declared primitive types match. Not a full validator. */
function violatesSchema(args, schema) {
  if (!schema || typeof schema !== 'object') return false
  const wantsObject = schema.type === 'object' || schema.properties || schema.required
  if (!wantsObject) return false
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return true
  for (const req of schema.required || []) if (!(req in args)) return true
  for (const [k, v] of Object.entries(args)) {
    const ps = schema.properties?.[k]
    if (ps?.type && !typeOk(v, ps.type)) return true
  }
  return false
}

/** Reconstruct tool_calls from an upstream chat-completions response (streamed SSE or full JSON). */
export function extractToolCalls(text, isSSE) {
  if (!text) return []
  if (!isSSE) {
    try {
      const j = JSON.parse(text)
      return (j.choices || []).flatMap((c) => c.message?.tool_calls || [])
    } catch { return [] }
  }
  const byIndex = new Map()
  const merge = (i, tc) => {
    const cur = byIndex.get(i) || { function: { name: '', arguments: '' } }
    if (tc.function?.name) cur.function.name = (cur.function.name || '') + tc.function.name
    if (tc.function?.arguments) cur.function.arguments = (cur.function.arguments || '') + tc.function.arguments
    byIndex.set(i, cur)
  }
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('data:')) continue
    const payload = s.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let j; try { j = JSON.parse(payload) } catch { continue }
    for (const c of j.choices || []) {
      for (const tc of c.message?.tool_calls || []) merge(tc.index ?? 0, tc)
      for (const tc of c.delta?.tool_calls || []) merge(tc.index ?? 0, tc)
    }
  }
  return [...byIndex.values()]
}

/** Classify a response's tool calls against the request's offered tools and accumulate per service. */
export function recordToolUsage({ svc, requestTools, toolCalls }) {
  if (!svc || !toolCalls || !toolCalls.length) return
  const tools = Array.isArray(requestTools) ? requestTools : []
  const offered = new Set(tools.map((t) => t?.function?.name).filter(Boolean))
  let total = 0, structureErrors = 0, hallucinationErrors = 0
  for (const tc of toolCalls) {
    const fn = tc?.function
    if (!fn || !fn.name) continue
    total++
    if (offered.size && !offered.has(fn.name)) { hallucinationErrors++; continue }
    let args
    try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments || '{}') : (fn.arguments || {}) }
    catch { structureErrors++; continue }
    const schema = tools.find((t) => t?.function?.name === fn.name)?.function?.parameters
    if (violatesSchema(args, schema)) structureErrors++
  }
  if (!total) return
  const key = svc.id || svc.endpoint || svc.model
  const e = acc.get(key) || { total: 0, structureErrors: 0, hallucinationErrors: 0 }
  e.total += total; e.structureErrors += structureErrors; e.hallucinationErrors += hallucinationErrors
  e.model = svc.model; e.svcId = svc.id
  acc.set(key, e)
}

/** Snapshot of in-process accumulated counts, keyed by serviceId (for the poller to fold). */
export function toolCallSnapshot() {
  return [...acc.values()].map((v) => ({ ...v }))
}
