/**
 * Upscaler addon API adapter — the FULL contract from
 * /claude/upscaler-addon-api-contract.md (claude1, 2026-07-04).
 *
 * Backend: bundled module on CT152 (systemd ailab-addon-upscaler.service,
 * 127.0.0.1:8090), same-origin proxied under /addons/upscaler (prefix-stripped).
 * View data = the page routes with ?format=json; actions are form-encoded POSTs
 * returning {ok,...} — after an action, RE-FETCH the view data (actions don't
 * return new state). Images stream via /preview/{assetId} (browser holds no
 * Immich key).
 */
const BASE = '/addons/upscaler'

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

export const previewUrl = (assetId: string, which: 'original' | 'thumbnail' = 'thumbnail', size: 'thumbnail' | 'preview' = 'thumbnail') =>
  `${BASE}/preview/${encodeURIComponent(assetId)}?which=${which}&size=${size}`

export const upscalerApi = {
  // ── view data ──────────────────────────────────────────────────────────────
  dashboard: () => getJson<any>('/?format=json'),
  browse: (p: { album_id?: string; tag_id?: string; page?: number; page_size?: string }) =>
    getJson<any>(`/browse?format=json&album_id=${p.album_id ?? ''}&tag_id=${p.tag_id ?? ''}&page=${p.page ?? 1}&page_size=${p.page_size ?? '50'}`),
  history: (p: { page?: number; status?: 'ok' | 'failed'; album_id?: string; tag_id?: string; include_children?: boolean; page_size?: string }) =>
    getJson<any>(
      `/history?format=json&page=${p.page ?? 1}&status=${p.status ?? 'ok'}&album_id=${p.album_id ?? ''}&tag_id=${p.tag_id ?? ''}&include_children=${p.include_children ? '1' : '0'}&page_size=${p.page_size ?? '50'}`,
    ),
  sync: (q = '') => getJson<any>(`/sync?format=json&q=${encodeURIComponent(q)}`),
  compare: (assetId: string) => getJson<any>(`/compare/${encodeURIComponent(assetId)}?format=json`),
  syncStatus: () => getJson<any>('/api/sync/status'),

  // ── actions (form-encoded; {ok,...}) ──────────────────────────────────────
  addSource: (kind: 'tag' | 'album', external_id: string, name: string, role: 'watch' | 'exclude') =>
    postForm('/api/sources/add', { kind, external_id, name, role }),
  deleteSource: (sourceId: string) => postForm(`/api/sources/${encodeURIComponent(sourceId)}/delete`),
  saveSettings: (s: Record<string, string>) => postForm('/api/settings', s),
  workerPause: () => postForm('/api/worker/pause'),
  workerResume: () => postForm('/api/worker/resume'),
  pollNow: () => postForm('/api/poll-now'),
  queueAssets: (assetIds: string[]) => postForm('/api/queue', { asset_id: assetIds }),
  queueAll: (p: { album_id?: string; tag_id?: string; include_children?: boolean }) =>
    postForm('/api/queue/all', { album_id: p.album_id, tag_id: p.tag_id, include_children: p.include_children ? '1' : undefined }),
  retry: (assetId: string) => postForm(`/api/queue/${encodeURIComponent(assetId)}/retry`),
  reprocess: (assetId: string, view?: string) => postForm(`/api/history/${encodeURIComponent(assetId)}/reprocess`, { view }),
  reprocessBatch: (p: { view: string; album_id?: string; tag_id?: string; include_children?: boolean; all_in_filter?: boolean; all_failed?: boolean; asset_id?: string[] }) =>
    postForm('/api/history/reprocess-batch', {
      view: p.view, album_id: p.album_id, tag_id: p.tag_id,
      include_children: p.include_children ? '1' : undefined,
      all_in_filter: p.all_in_filter ? '1' : undefined,
      all_failed: p.all_failed ? '1' : undefined,
      asset_id: p.asset_id,
    }),
  gpusRefresh: () => postForm('/api/gpus/refresh'),
  gpusSave: (enabled: string[]) => postForm('/api/gpus/save', { enabled }), // 'agent_name:cuda_index'
  syncSource: (tagId: string, action: 'add' | 'remove') => postForm('/api/sync/source', { tag_id: tagId, action }),
  syncReset: (tagId: string) => postForm('/api/sync/reset', { tag_id: tagId }),
  syncRun: () => postForm('/api/sync/run'),
  syncToggle: () => postForm('/api/sync/toggle'),
}
