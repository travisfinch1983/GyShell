// LLM metrics poller — persistent per-(model+backend+settings) performance rows for the AI-Lab
// metrics dashboard. Scrapes each running LLM service's Prometheus /metrics on an interval and
// ACCUMULATES counter deltas into a durable store so totals survive both model relaunches (engine
// counters reset to 0) and AI-Lab restarts. Rows are NEVER removed automatically — a model that is
// taken down keeps its row (running:false) for historical reference.
/* eslint-disable */
// @ts-nocheck
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import crypto from 'node:crypto'

const STORE_VERSION = 1

/** Sum all numeric samples of a Prometheus metric by name (ignores labels, comments). */
function promSum(text, name) {
  if (!text) return null
  let sum = null
  const lines = text.split('\n')
  for (const line of lines) {
    if (!line || line[0] === '#') continue
    if (!line.startsWith(name)) continue
    const rest = line.slice(name.length)
    if (rest && rest[0] !== ' ' && rest[0] !== '{') continue // avoid prefix collisions
    const m = line.match(/\s([0-9eE+.\-]+)\s*$/)
    if (m) { const v = parseFloat(m[1]); if (!Number.isNaN(v)) sum = (sum ?? 0) + v }
  }
  return sum
}

export class LlmMetricsPoller {
  constructor({ dataDir, gpuMonitor, getActiveServices, getServiceHistory, interval = 20000 }) {
    this.file = join(dataDir, 'llm-metrics.json')
    this.gpuMonitor = gpuMonitor
    this.getActiveServices = getActiveServices || (() => ({ services: [] }))
    this.getServiceHistory = getServiceHistory || (() => ({ services: [] }))
    this.interval = interval
    this.store = this._load()
    this._timer = null
    this._saveTimer = null
  }

  _load() {
    try { const d = JSON.parse(readFileSync(this.file, 'utf8')); if (d && d.rows) return d } catch {}
    return { version: STORE_VERSION, rows: {} }
  }
  _save() {
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      try { writeFileSync(this.file, JSON.stringify(this.store, null, 2)) } catch (e) { console.warn('[llm-metrics] save failed:', e?.message) }
    }, 1500)
  }
  _flush() { try { writeFileSync(this.file, JSON.stringify(this.store, null, 2)) } catch {} }

  start() {
    this.poll().catch(() => {})
    this._timer = setInterval(() => this.poll().catch(() => {}), this.interval)
    if (this._timer.unref) this._timer.unref()
  }
  stop() { if (this._timer) clearInterval(this._timer) }

  /** Heuristic reasoning mode from the model/alias name (the user encodes it there). */
  _reasoningMode(svc) {
    const s = `${svc.model || ''} ${svc.aliasOverride || ''} ${svc.modelVariant || ''}`.toLowerCase()
    if (/think\w*[\s_-]*preserv|preserv\w*[\s_-]*think|thinking[\s_-]*kept/.test(s)) return 'Thinking Preserved'
    if (/no[\s_-]*think|think\w*[\s_-]*(off|disabled|none)|reasoning[\s_-]*off/.test(s)) return 'Thinking Off'
    if (/think\w*[\s_-]*(on|enabled)|reasoning[\s_-]*on|thinking\b/.test(s)) return 'Thinking On'
    return '—'
  }

  /** Stable fingerprint: one row per (model + backend + the settings that define a distinct run). */
  fingerprint(svc) {
    const key = [
      svc.providerId || svc.providerName || '',
      svc.model || '',
      svc.quantFormat || '', svc.quantSize || '',
      String(svc.contextSize ?? ''),
      String(svc.slots ?? ''),
      this._reasoningMode(svc),
      [...(svc.gpuPciIds || [])].sort().join(','),
      svc.node || '',
    ].join('|')
    return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)
  }

  _gpuNames(svc) {
    try {
      const inv = this.gpuMonitor?.getEnrichedInventory?.() || []
      const map = {}
      for (const g of inv) map[`${g.node}:${g.pciId}`] = g.friendlyName || g.name || g.pciId
      return [...(svc.gpuPciIds || [])].sort().map((pci) => map[`${svc.node}:${pci}`] || map[pci] || pci)
    } catch { return [...(svc.gpuPciIds || [])] }
  }

  /** Fetch + parse a service's Prometheus metrics into normalised counters/gauges. */
  async _scrape(svc) {
    const base = `http://${svc.containerIp}:${svc.port}`
    const text = await this._get(`${base}/metrics`, 4000)
    if (!text) return null
    const pid = (svc.providerId || '').toLowerCase()
    if (text.includes('vllm:') || pid.includes('vllm') || pid.includes('cat-vllm')) {
      return {
        promptTokens: promSum(text, 'vllm:prompt_tokens_total'),
        genTokens: promSum(text, 'vllm:generation_tokens_total'),
        decodeTps: promSum(text, 'vllm:avg_generation_throughput_toks_per_s'),
        prefillTps: promSum(text, 'vllm:avg_prompt_throughput_toks_per_s'),
        cacheHits: promSum(text, 'vllm:prefix_cache_hits_total'),
        cacheQueries: promSum(text, 'vllm:prefix_cache_queries_total'),
        optaneHits: promSum(text, 'vllm:external_prefix_cache_hits_total'),
        optaneQueries: promSum(text, 'vllm:external_prefix_cache_queries_total'),
      }
    }
    if (text.includes('aphrodite:')) {
      return {
        promptTokens: promSum(text, 'aphrodite:prompt_tokens_total'),
        genTokens: promSum(text, 'aphrodite:generation_tokens_total'),
        decodeTps: promSum(text, 'aphrodite:avg_generation_throughput_toks_per_s'),
        prefillTps: promSum(text, 'aphrodite:avg_prompt_throughput_toks_per_s'),
        cacheHits: promSum(text, 'aphrodite:prefix_cache_hits_total'),
        cacheQueries: promSum(text, 'aphrodite:prefix_cache_queries_total'),
        optaneHits: null, optaneQueries: null,
      }
    }
    if (text.includes('llamacpp:')) {
      const r = {
        promptTokens: promSum(text, 'llamacpp:prompt_tokens_total'),
        genTokens: promSum(text, 'llamacpp:tokens_predicted_total'),
        decodeTps: promSum(text, 'llamacpp:predicted_tokens_seconds'),
        prefillTps: promSum(text, 'llamacpp:prompt_tokens_seconds'),
        cacheHits: null, cacheQueries: null, optaneHits: null, optaneQueries: null,
      }
      // llama.cpp's Optane KV cache lives in the kvcache shim (servicePort + 1000).
      const shim = await this._get(`http://${svc.containerIp}:${svc.port + 1000}/shim/stats`, 2000)
      if (shim) { try {
        const j = JSON.parse(shim)
        const hits = j.hits ?? 0, misses = j.misses ?? 0
        r.optaneHits = hits; r.optaneQueries = hits + misses
        if (j.avgRestoreMs != null) r.optaneRestoreMs = j.avgRestoreMs
      } catch {} }
      return r
    }
    return {} // unknown engine — still keep the identity row
  }

  _get(url, timeoutMs) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    return fetch(url, { signal: ctrl.signal }).then((r) => (r.ok ? r.text() : null)).catch(() => null).finally(() => clearTimeout(t))
  }

  /** Accumulate a monotonic counter into a lifetime total, detecting per-run resets. */
  _accum(row, field, cur, runId) {
    if (cur == null) return
    row._last = row._last || {}
    const lastRun = row._lastRun
    const last = row._last[field]
    const cumKey = 'cum_' + field
    if (lastRun !== runId || last == null || cur < last) row[cumKey] = (row[cumKey] || 0) + cur // new run / reset
    else row[cumKey] = (row[cumKey] || 0) + (cur - last)
    row._last[field] = cur
  }

  async poll() {
    const svcData = await this.getActiveServices()
    // active-services.json stores `services` as an object keyed by id (proxy uses Object.values).
    const all = Array.isArray(svcData?.llm) ? svcData.llm
      : Array.isArray(svcData?.services) ? svcData.services
      : (svcData?.services && typeof svcData.services === 'object') ? Object.values(svcData.services)
      : []
    const llm = all.filter((s) => s && typeof s === 'object' && s.containerIp && s.port && !s.isTts && !s.isImageGen && !s.isStt && !s.isTools)
    const now = Date.now()
    const seen = new Set()

    for (const svc of llm) {
      if (!svc.containerIp || !svc.port) continue
      const fp = this.fingerprint(svc)
      seen.add(fp)
      const row = this.store.rows[fp] || (this.store.rows[fp] = { fingerprint: fp, firstSeen: now })
      // identity / settings snapshot (refreshed each poll from the live record)
      row.model = svc.model || svc.aliasOverride || row.model // base model id — the group key
      row.displayName = svc.aliasOverride || svc.model || row.displayName // descriptive per-config name
      row.modelFamily = svc.modelFamily || row.modelFamily
      row.provider = svc.providerName || svc.providerId || row.provider
      row.providerId = svc.providerId || row.providerId
      row.quant = [svc.quantFormat, svc.quantSize].filter(Boolean).join(' ') || row.quant || '—'
      row.contextSize = svc.contextSize ?? row.contextSize
      row.slotCount = svc.slots ?? row.slotCount
      row.reasoningMode = this._reasoningMode(svc)
      row.gpuPciIds = svc.gpuPciIds || row.gpuPciIds || []
      row.gpuCount = (svc.gpuPciIds || []).length || row.gpuCount || 0
      row.gpus = this._gpuNames(svc)
      row.node = svc.node || row.node
      row.vramMB = svc.reservedVramMB ?? row.vramMB ?? null
      row.endpoint = svc.endpoint || row.endpoint
      row.settings = {
        model: svc.model, aliasOverride: svc.aliasOverride, family: svc.modelFamily, variant: svc.modelVariant,
        provider: row.provider, quant: row.quant, contextSize: row.contextSize, slots: row.slotCount,
        reasoningMode: row.reasoningMode, gpus: row.gpus, node: row.node, reservedVramMB: row.vramMB,
        endpoint: svc.endpoint, port: svc.port, startedAt: svc.startedAt, scriptPath: svc.scriptPath,
      }
      row.running = true
      row.lastSeen = now
      row.currentServiceId = svc.id

      const m = await this._scrape(svc).catch(() => null)
      if (m) {
        const runId = svc.id
        this._accum(row, 'promptTokens', m.promptTokens, runId)
        this._accum(row, 'genTokens', m.genTokens, runId)
        this._accum(row, 'cacheHits', m.cacheHits, runId)
        this._accum(row, 'cacheQueries', m.cacheQueries, runId)
        this._accum(row, 'optaneHits', m.optaneHits, runId)
        this._accum(row, 'optaneQueries', m.optaneQueries, runId)
        row._lastRun = runId
        if (m.decodeTps != null && m.decodeTps > 0) row.decodeTps = Math.round(m.decodeTps * 10) / 10
        if (m.prefillTps != null && m.prefillTps > 0) row.prefillTps = Math.round(m.prefillTps * 10) / 10
        if (m.optaneRestoreMs != null) row.optaneRestoreMs = m.optaneRestoreMs
      }
    }
    // Any row not seen this cycle → its service is down; keep the row for history.
    for (const [fp, row] of Object.entries(this.store.rows)) {
      if (!seen.has(fp) && row.running) { row.running = false; row._last = undefined; row._lastRun = undefined }
    }
    this._save()
  }

  // ── Phase 2: tool-call metrics ingestion (called from the proxy chat-completions path) ──
  recordToolCalls(svc, { total = 0, structureErrors = 0, hallucinationErrors = 0 } = {}) {
    if (!svc) return
    const fp = typeof svc === 'string' ? svc : this.fingerprint(svc)
    const row = this.store.rows[fp]
    if (!row) return // only track services we already have an identity row for
    row.toolCalls = (row.toolCalls || 0) + total
    row.toolErrStructure = (row.toolErrStructure || 0) + structureErrors
    row.toolErrHallucination = (row.toolErrHallucination || 0) + hallucinationErrors
    this._save()
  }

  /** Rows for the dashboard, newest-active first within model groups handled client-side. */
  getRows() { return Object.values(this.store.rows).map((r) => { const { _last, _lastRun, ...rest } = r; return rest }) }
  deleteRow(fp) { if (this.store.rows[fp]) { delete this.store.rows[fp]; this._flush(); return true } return false }
}
