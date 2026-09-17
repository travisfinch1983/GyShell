import { makeAutoObservable, runInAction } from 'mobx'

/**
 * Transmute (native file converter) — Files → Convert sub-tab.
 *
 * Talks to /api/transmute/* which the backend reverse-proxies to the native
 * Transmute service on :3313 WITH the API key injected server-side — this store
 * never sees or handles credentials. Same plain same-origin fetch transport as
 * the Bulk Renamer (/api/files).
 *
 * Flow: upload (multipart) → the response carries per-file compatible_formats
 * computed by the server (format → quality options) → submit a conversion job
 * per file → poll jobs while any are active → download by output_file_id.
 */

export interface PendingFile {
  id: string
  name: string
  ext: string
  size: number
  /** output format → quality options ([] = no quality choice) */
  formats: Record<string, string[]>
  format: string
  quality: string
}

export interface TJob {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number | null
  output_format: string
  quality: string | null
  output_file_id: string | null
  error_message: string | null
  source_filename: string | null
  source_extension: string | null
  created_at: string | null
}

async function j(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch('/api/transmute' + path, init)
  const text = await r.text()
  let data: any = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = {} }
  if (!r.ok) throw new Error(data?.detail || data?.error || `${r.status} ${r.statusText}`)
  return data
}

class TransmuteStore {
  /** unconfigured = proxy has no key file; down = configured but service unreachable. */
  service: 'unknown' | 'ok' | 'down' | 'unconfigured' = 'unknown'
  uploading = 0
  pending: PendingFile[] = []
  jobs: TJob[] = []
  msg = ''
  loaded = false
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor() { makeAutoObservable(this) }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const s = await j('/_status')
      runInAction(() => { this.service = !s.configured ? 'unconfigured' : s.up ? 'ok' : 'down' })
    } catch {
      runInAction(() => { this.service = 'down' })
    }
    if (this.service === 'ok') await this.refreshJobs()
  }

  async addFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files)
    runInAction(() => { this.uploading += list.length; this.msg = '' })
    await Promise.all(list.map(async (f) => {
      try {
        const body = new FormData()
        body.append('file', f)
        const r = await j('/files', { method: 'POST', body })
        const m = r.metadata
        const formats = (m?.compatible_formats ?? {}) as Record<string, string[]>
        const names = Object.keys(formats).sort()
        runInAction(() => {
          this.pending.push({
            id: m.id, name: m.original_filename || f.name,
            ext: (m.extension || '').replace(/^\./, ''),
            size: m.size_bytes || f.size, formats,
            format: names[0] || '', quality: '',
          })
        })
      } catch (e: any) {
        runInAction(() => { this.msg = `Upload failed for ${f.name}: ${e?.message || e}` })
      } finally {
        runInAction(() => { this.uploading-- })
      }
    }))
  }

  setChoice(id: string, patch: Partial<Pick<PendingFile, 'format' | 'quality'>>): void {
    const p = this.pending.find((x) => x.id === id)
    if (!p) return
    Object.assign(p, patch)
    // A format switch invalidates a quality that the new format doesn't offer.
    if (patch.format !== undefined && p.quality && !(p.formats[p.format] || []).includes(p.quality)) p.quality = ''
    this.pending = [...this.pending]
  }

  /** Every pending file with the same extension gets this file's format (bulk convenience). */
  applyToSameType(id: string): void {
    const src = this.pending.find((x) => x.id === id)
    if (!src) return
    for (const p of this.pending) {
      if (p.id !== id && p.ext === src.ext && src.format in p.formats) {
        p.format = src.format
        p.quality = (p.formats[p.format] || []).includes(src.quality) ? src.quality : ''
      }
    }
    this.pending = [...this.pending]
  }

  async removePending(id: string): Promise<void> {
    this.pending = this.pending.filter((p) => p.id !== id)
    // Best-effort server cleanup of the unused upload; the daily sweep also covers it.
    try { await j(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' }) } catch { /* ignore */ }
  }

  async convertAll(): Promise<void> {
    const ready = this.pending.filter((p) => p.format)
    if (!ready.length) return
    runInAction(() => { this.msg = '' })
    for (const p of ready) {
      try {
        await j('/jobs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: p.id, output_format: p.format, ...(p.quality ? { quality: p.quality } : {}) }),
        })
        runInAction(() => { this.pending = this.pending.filter((x) => x.id !== p.id) })
      } catch (e: any) {
        runInAction(() => { this.msg = `Convert failed for ${p.name}: ${e?.message || e}` })
      }
    }
    await this.refreshJobs()
  }

  async refreshJobs(): Promise<void> {
    try {
      const r = await j('/jobs')
      runInAction(() => { this.jobs = r.jobs || [] })
    } catch (e: any) {
      runInAction(() => { this.msg = `Jobs: ${e?.message || e}` })
    }
    const active = this.jobs.some((x) => x.status === 'queued' || x.status === 'running')
    if (active && !this.pollTimer) {
      this.pollTimer = setInterval(() => void this.refreshJobs(), 2000)
    } else if (!active && this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  downloadUrl(fileId: string): string { return `/api/transmute/files/${encodeURIComponent(fileId)}` }

  async cancelJob(id: string): Promise<void> {
    try { await j(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }) } catch (e: any) { runInAction(() => { this.msg = String(e?.message || e) }) }
    await this.refreshJobs()
  }

  async retryJob(id: string): Promise<void> {
    try { await j(`/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }) } catch (e: any) { runInAction(() => { this.msg = String(e?.message || e) }) }
    await this.refreshJobs()
  }

  async deleteJob(id: string): Promise<void> {
    try { await j(`/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }) } catch (e: any) { runInAction(() => { this.msg = String(e?.message || e) }) }
    await this.refreshJobs()
  }
}

export const transmuteStore = new TransmuteStore()
