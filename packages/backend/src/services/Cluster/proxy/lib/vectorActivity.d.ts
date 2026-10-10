/** Types for vectorActivity.js — kept beside the implementation so the
 *  NotificationsService import is typed without converting the proxy lib to TS. */
export interface VectorActivityBucket {
  op: 'embed' | 'rerank'
  source: string
  rpm: number; ipm: number; epm: number
  inflight: number
  totalReq: number; totalItems: number; totalErrs: number
  consecutiveErrs: number
  lastError: { status: number; msg: string; ts: string } | null
  lastSeen: string | null
  firstSeen: string
}
export function resolveVectorSource(req: unknown): string
export function beginVectorCall(op: 'embed' | 'rerank', source: string, items: number):
  { end(ok: boolean, status?: number, errMsg?: string): void }
export function vectorActivitySnapshot(): { windowSec: number; buckets: VectorActivityBucket[] }
