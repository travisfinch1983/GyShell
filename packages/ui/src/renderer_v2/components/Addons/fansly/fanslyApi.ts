/**
 * Fansly/Coomer/Kemono addon - media library API (the native Browser tab).
 *
 * Backend: /opt/ai-lab/addons/fansly (ailab-addon-fansly.service, 127.0.0.1:8096), reached same-origin
 * through the backend's runtime-addon proxy at /addons/fansly (prefix-stripped). The library routes live
 * under /lib (library.py); the scraper's own web page is the addon root and is shown as the Scraper tab.
 * A file is addressed by "<service>:<path under that service's download root>".
 */
const BASE = '/addons/fansly'

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return (await r.json()) as T
}

async function post(path: string, obj?: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj ?? {}),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.detail || j?.error || `${path}: HTTP ${r.status}`)
  return j
}

export interface LibItem {
  id: string
  svc: string
  rel: string
  name: string
  creator: string
  section: string
  is_video: number
  size: number
  mtime: number
  posted_at: number | null
  key: string
  width: number | null
  height: number | null
}

export interface Creator { svc: string; svc_label: string; creator: string; images: number; videos: number }

export const thumbUrl = (id: string) => `${BASE}/lib/thumb?id=${encodeURIComponent(id)}`
export const fullUrl = (id: string) => `${BASE}/lib/file?id=${encodeURIComponent(id)}`

export const fanslyApi = {
  creators: () => getJson<{ creators: Creator[] }>('/lib/creators'),
  items: (p: { svc?: string; creator?: string; sort?: string; videos?: boolean; q?: string; page?: number; per_page?: number; refresh?: boolean }) =>
    getJson<{ items: LibItem[]; total: number; page: number; total_pages: number }>(
      `/lib/items?svc=${encodeURIComponent(p.svc ?? '')}&creator=${encodeURIComponent(p.creator ?? '')}`
      + `&sort=${p.sort ?? 'newest'}&videos=${p.videos ? 'true' : 'false'}&q=${encodeURIComponent(p.q ?? '')}`
      + `&page=${p.page ?? 1}&per_page=${p.per_page ?? 60}${p.refresh ? '&refresh=true' : ''}`),
  deleteItems: (ids: string[]) => post('/lib/delete', { ids }),
  trainingSets: () => getJson<{ sets: { name: string; count: number }[] }>('/lib/training-sets'),
  createTrainingSet: (name: string) => post('/lib/training-sets/create', { name }),
  addToTrainingSet: (set: string, ids: string[]) => post('/lib/training-sets/add', { set, ids }),
  trainingSetMembers: (set: string) => getJson<{ keys: string[] }>(`/lib/training-sets/members?set=${encodeURIComponent(set)}`),
  trainingSetMembersAll: () => getJson<{ members: Record<string, string[]> }>('/lib/training-sets/members-all'),
}
