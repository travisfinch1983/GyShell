/**
 * Pixiv scraper addon API adapter.
 * Backend: /opt/ai-lab/addons/pixiv (FastAPI, systemd ailab-addon-pixiv.service,
 * 127.0.0.1:8093), same-origin proxied under /addons/pixiv (prefix-stripped).
 */
const BASE = '/addons/pixiv'

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return (await r.json()) as T
}

async function postForm(path: string, fields?: Record<string, string | undefined>): Promise<any> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(fields ?? {})) if (v !== undefined) body.append(k, v)
  const r = await fetch(`${BASE}${path}`, { method: 'POST', body })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}

export const thumbUrl = (illustId: number) => `${BASE}/media/thumb/${illustId}`
export const fullUrl = (illustId: number, page = 0) => `${BASE}/media/full/${illustId}/${page}`

export const pixivApi = {
  dashboard: () => getJson<any>('/?format=json'),
  browser: (p: { q?: string; page?: number; per_page?: number; sort?: string; artist_id?: number; restrict?: string }) =>
    getJson<any>(`/browser?format=json&q=${encodeURIComponent(p.q ?? '')}&page=${p.page ?? 1}&per_page=${p.per_page ?? 40}&sort=${p.sort ?? 'newest'}&artist_id=${p.artist_id ?? ''}&restrict=${p.restrict ?? ''}`),
  post: (id: number) => getJson<any>(`/browser/post/${id}`),
  settings: () => getJson<any>('/settings?format=json'),
  saveSettings: (s: Record<string, string>) => postForm('/api/settings', s),
  addWatch: (kind: string, value: string, label?: string) => postForm('/api/watches/add', { kind, value, label }),
  removeWatch: (id: number) => postForm('/api/watches/remove', { id: String(id) }),
  toggleWatch: (id: number, enabled: boolean) => postForm('/api/watches/toggle', { id: String(id), enabled: enabled ? '1' : '0' }),
  scrapeNow: (id: number) => postForm('/api/watches/scrape-now', { id: String(id) }),
  workerPause: () => postForm('/api/worker/pause', { action: 'pause' }),
  workerResume: () => postForm('/api/worker/pause', { action: 'resume' }),
  retryFailed: () => postForm('/api/retry-failed'),
}
