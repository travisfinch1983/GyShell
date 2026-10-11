/**
 * Social scraper addon API adapter (Instagram + X/Twitter + RedGIFs + Bluesky).
 *
 * Backend: ONE bundled module on CT152 (/opt/ai-lab/addons/social, systemd ailab-addon-social.service,
 * 127.0.0.1:8097), same-origin proxied under /addons/social (prefix-stripped). Site-scoped routes are
 * /<site>/...; media files and training sets are shared across both sites.
 */
export type Site = 'instagram' | 'twitter' | 'redgifs' | 'bluesky'

export const SITE_LABEL: Record<Site, string> = { instagram: 'Instagram', twitter: 'X / Twitter', redgifs: 'RedGIFs', bluesky: 'Bluesky' }

/** Public profile page of a watched account. */
export const profileUrl = (site: Site, handle: string) =>
  site === 'instagram' ? `https://www.instagram.com/${handle}/` : site === 'redgifs' ? `https://www.redgifs.com/users/${handle}`
    : site === 'bluesky' ? `https://bsky.app/profile/${handle}` : `https://x.com/${handle}`

/** How a site logs in: browser cookies, an optional Bluesky app password, or not at all (RedGIFs uses an
 *  anonymous API token). Either secret lives in the backend's never-returned `<site>.cookies` store. */
export const LOGIN_KIND: Record<Site, 'cookies' | 'app_password' | null> = { instagram: 'cookies', twitter: 'cookies', redgifs: null, bluesky: 'app_password' }

const BASE = '/addons/social'

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
  if (!r.ok && !j?.error) throw new Error(`${path}: HTTP ${r.status}`)
  return j
}

export interface Account {
  id: number
  handle: string
  enabled: number
  complete: number
  last_synced_at: number | null
  last_status: string | null
  last_error: string | null
  last_new: number | null
  n_media: number
}

export interface CookieInfo { names: string[]; required: string[]; missing: string[]; set: boolean }

export interface MediaItem {
  id: number
  key: string
  rel: string
  post_id: string
  post_url: string | null
  posted_at: number | null
  width: number | null
  height: number | null
  is_video: number
  handle: string
  caption?: string | null
}

export const thumbUrl = (id: number) => `${BASE}/file/thumb/${id}`
export const fullUrl = (id: number) => `${BASE}/file/full/${id}`

export function socialApi(site: Site) {
  const s = `/${site}`
  return {
    dashboard: () => getJson<any>(`${s}/`),
    log: () => getJson<{ lines: string[] }>(`${s}/log`),
    browser: (p: { account?: number; page?: number; per_page?: number; sort?: string; videos?: boolean; q?: string }) =>
      getJson<any>(`${s}/browser?account=${p.account ?? 0}&page=${p.page ?? 1}&per_page=${p.per_page ?? 60}`
        + `&sort=${p.sort ?? 'newest'}&videos=${p.videos ? 'true' : 'false'}&q=${encodeURIComponent(p.q ?? '')}`),
    media: (id: number) => getJson<MediaItem>(`/media/${id}`),
    settings: () => getJson<any>(`${s}/settings`),

    addAccounts: (handles: string) => post(`${s}/api/accounts/add`, { handles }),
    removeAccount: (id: number, deleteFiles: boolean) =>
      post(`${s}/api/accounts/remove`, { id, delete_files: deleteFiles ? '1' : '0' }),
    toggleAccount: (id: number, enabled: boolean) => post(`${s}/api/accounts/toggle`, { id, enabled: enabled ? '1' : '0' }),
    syncAccount: (id: number, full = false) => post(`${s}/api/accounts/sync`, { id, full: full ? '1' : '0' }),
    syncAll: () => post(`${s}/api/sync-all`),
    cancel: () => post(`${s}/api/cancel`),
    pause: (paused: boolean) => post(`${s}/api/pause`, { action: paused ? 'pause' : 'resume' }),
    saveSettings: (v: Record<string, string>) => post(`${s}/api/settings`, v),
    saveCookies: (cookies: string) => post(`${s}/api/cookies`, { cookies }),
    clearCookies: () => post(`${s}/api/cookies/clear`),
    rescan: () => post(`${s}/api/rescan`),

    deleteMedia: (ids: number[]) => post('/api/media/delete', { ids }),
    trainingSets: () => getJson<{ sets: { name: string; count: number }[] }>('/api/training-sets'),
    createTrainingSet: (name: string) => post('/api/training-sets/create', { name }),
    addToTrainingSet: (set: string, ids: number[]) => post('/api/training-sets/add', { set, ids }),
    trainingSetMembers: (set: string) => getJson<{ keys: string[] }>(`/api/training-sets/members?set=${encodeURIComponent(set)}`),
    trainingSetMembersAll: () => getJson<{ members: Record<string, string[]> }>('/api/training-sets/members-all'),
  }
}
