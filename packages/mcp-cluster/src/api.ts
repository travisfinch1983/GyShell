/**
 * Shared HTTP helper for the AI-Lab fleet API (universal-proxy /api/fleet/*).
 *
 * Base URL comes from AILAB_API_URL (default http://127.0.0.1:17890). Same
 * never-throws contract as the ailab-observability MCP server: non-200s,
 * timeouts, and network failures surface as { ok:false, error, endpoint }.
 */

const BASE_URL = (process.env.AILAB_API_URL ?? 'http://127.0.0.1:17890').replace(/\/+$/, '')
const TIMEOUT_MS = Number(process.env.AILAB_API_TIMEOUT_MS ?? 15_000)

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export type ApiResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; endpoint: string; status?: number }

export async function apiSend(method: HttpMethod, path: string, body?: unknown): Promise<ApiResult> {
  const url = `${BASE_URL}${path}`
  try {
    const res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) {
      const detail = text ? `: ${text.slice(0, 500)}` : ''
      return { ok: false, error: `${res.status} ${res.statusText}${detail}`, endpoint: url, status: res.status }
    }
    try {
      return { ok: true, data: JSON.parse(text) }
    } catch {
      return { ok: true, data: text }
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      return { ok: false, error: `request timed out after ${TIMEOUT_MS}ms`, endpoint: url }
    }
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : ''
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `${message}${cause}`, endpoint: url }
  }
}

export function apiGet(path: string): Promise<ApiResult> {
  return apiSend('GET', path)
}
