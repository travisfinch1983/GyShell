/**
 * Rule34 scraper addon API adapter.
 *
 * Backend: bundled module on CT152 (systemd ailab-addon-rule34.service,
 * 127.0.0.1:8091), same-origin proxied under /addons/rule34 (prefix-stripped).
 * View data = page routes with ?format=json; actions are form-encoded POSTs
 * returning {ok,...} — after an action, RE-FETCH the view data.
 */
const BASE = '/addons/rule34'

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return (await r.json()) as T
}

async function postForm(path: string, fields?: Record<string, string | string[] | undefined>): Promise<any> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === undefined) continue
    if (Array.isArray(v)) v.forEach((x) => body.append(k, x))
    else body.append(k, v)
  }
  const r = await fetch(`${BASE}${path}`, { method: 'POST', body })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}

// Media URLs
export const thumbUrl = (postId: number) => `${BASE}/media/thumb/${postId}`
export const fullUrl = (postId: number) => `${BASE}/media/full/${postId}`

export const rule34Api = {
  // ── view data ──────────────────────────────────────────────────────────────
  dashboard: () => getJson<any>('/?format=json'),
  browser: (p: { tags?: string; page?: number; per_page?: number; sort?: string; rating?: string }) =>
    getJson<any>(
      `/browser?format=json&tags=${p.tags ?? ''}&page=${p.page ?? 1}&per_page=${p.per_page ?? 40}&sort=${p.sort ?? 'newest'}&rating=${p.rating ?? ''}`,
    ),
  post: (id: number) => getJson<any>(`/browser/post/${id}?format=json`),
  tags: () => getJson<any>('/tags?format=json'),
  settings: () => getJson<any>('/settings?format=json'),
  searchTags: (q: string) => getJson<any[]>(`/tags/search?q=${encodeURIComponent(q)}`),

  // ── actions (form-encoded; {ok,...}) ──────────────────────────────────────
  addTag: (query: string) => postForm('/api/tags/add', { query }),
  removeTag: (id: string) => postForm('/api/tags/remove', { id }),
  toggleTag: (id: string, enabled: boolean) => postForm('/api/tags/toggle', { id, enabled: enabled ? '1' : '0' }),
  scrapeTagNow: (id: string) => postForm('/api/tags/scrape-now', { id }),
  saveSettings: (s: Record<string, string>) => postForm('/api/settings', s),
  addKey: (k: { api_key: string; user_id: string; label?: string; proxy?: string }) =>
    postForm('/api/keys/add', { api_key: k.api_key, user_id: k.user_id, label: k.label, proxy: k.proxy }),
  removeKey: (id: number) => postForm('/api/keys/remove', { id: String(id) }),
  toggleKey: (id: number, enabled: boolean) =>
    postForm('/api/keys/toggle', { id: String(id), enabled: enabled ? '1' : '0' }),
  workerPause: () => postForm('/api/worker/pause', { action: 'pause' }),
  workerResume: () => postForm('/api/worker/pause', { action: 'resume' }),
  scrapeAll: () => postForm('/api/worker/scrape-all'),
  retryFailed: () => postForm('/api/retry-failed'),
}
