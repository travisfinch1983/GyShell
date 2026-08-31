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
import { toolCallSnapshot } from '../../tool-call-metrics.js'

// Poll failures were setInterval(() => poll().catch(() => {})) — every failure
// discarded, so a flat/stale metrics chart had no explanation anywhere. One
// line per poller per minute: enough to grep, impossible to flood.
const _pollWarnAt = new Map()
function warnPollFailure(which, e) {
  const now = Date.now()
  if (now - (_pollWarnAt.get(which) ?? 0) < 60_000) return
  _pollWarnAt.set(which, now)
  console.warn(`[metrics-poller] ${which} failing: ${e?.message ?? e}`)
}

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

/**
 * Sum the samples of a Prometheus metric that carry a specific label value.
 * Needed because vLLM reports KV offload volume as ONE metric split by transfer_type
 * (GPU_to_CPU = stored, CPU_to_GPU = restored); promSum would add the two together and
 * report a number that means nothing.
 */
function promSumLabeled(text, name, label, value) {
  if (!text) return null
  let sum = null
  const want = `${label}="${value}"`
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue
    if (!line.startsWith(name)) continue
    const rest = line.slice(name.length)
    if (rest && rest[0] !== ' ' && rest[0] !== '{') continue // avoid prefix collisions
    if (!line.includes(want)) continue
    const m = line.match(/\s([0-9eE+.\-]+)\s*$/)
    if (m) { const v = parseFloat(m[1]); if (!Number.isNaN(v)) sum = (sum ?? 0) + v }
  }
  return sum
}

export class LlmMetricsPoller {
  /**
   * KV offload wired-but-DEAD detector.
   *
   * Stored bytes climb as soon as a connector is attached; restored bytes climb only on a
   * real hit. "Restored flat while stored grows" is therefore the precise signature of a
   * cache that exists, costs disk, and returns nothing — the shape that hid for MONTHS
   * because the counters were published and nobody read them.
   *
   * Two guards against crying wolf: a FLOOR (a cold engine that has served nothing yet is
   * not evidence of anything) and once-per-row latching (a standing condition must not
   * re-alarm every 20s poll). Recovery unlatches, so a later genuine failure still fires.
   */
  _checkKvOffloadDead(row) {
    if (!this.notify) return;
    const FLOOR_BYTES = 5 * 1024 * 1024 * 1024;   // ~5GB stored before we judge
    const stored = row.cum_kvOffloadStoredBytes || 0;
    const restored = row.cum_kvOffloadRestoredBytes || 0;
    if (restored > 0) { row._kvDeadFlagged = false; return; }   // it earns its keep — unlatch
    if (stored < FLOOR_BYTES) return;                            // too early to judge
    if (row._kvDeadFlagged) return;                              // already reported
    row._kvDeadFlagged = true;
    const gb = (stored / 1024 / 1024 / 1024).toFixed(1);
    this.notify({
      severity: 'error',
      source: 'kv-offload',
      message: `KV offload is storing but never restoring on ${row.model || row.currentServiceId || 'a service'} — ${gb} GB written, 0 bytes restored`,
      detail: 'Stored bytes climb whenever the connector is attached; restored bytes climb only on a real hit. Zero restored past the 5GB floor means the cache is present but dead (wrong block hashes, PYTHONHASHSEED unset, or a restore path that never matches).',
    });
  }

  constructor({ dataDir, gpuMonitor, getActiveServices, getServiceHistory, interval = 20000, notify = null }) {
    this.notify = notify;
    this.file = join(dataDir, 'llm-metrics.json')
    this.gpuConfigFile = join(dataDir, 'gpu-config.json')
    this.gpuMonitor = gpuMonitor
    this.getActiveServices = getActiveServices || (() => ({ services: [] }))
    this.getServiceHistory = getServiceHistory || (() => ({ services: [] }))
    this.interval = interval
    this.store = this._load()
    this._timer = null
    this._saveTimer = null
    // llama.cpp prompt-cache hit/miss is only visible per-request in /slots (no cumulative counter), so a
    // 20s metrics poll misses most agent requests. Sample /slots on a fast, independent cadence instead.
    this._slotTimer = null
    this._slotInterval = 2000
    this._slotTargets = [] // [{id, base}] of running llama.cpp services, refreshed each main poll
    this._slotState = {}   // per-svc { cur:{slotId:{task,total,cached}}, cacheTok, totalTok } cumulative
    // Live rolling-window decode/prefill rate (computed from cumulative token counters sampled fast).
    this._win = {}                 // fp -> [{t, gen, prompt}] ring buffer (in-memory, ephemeral)
    this._winTargets = []          // [{id, base, fp, providerId}] running LLM services, refreshed each poll
    this._tokenTimer = null
    this._tokenInterval = 3000     // fast token sampler cadence (supports windows down to ~10s)
    this._liveWindowSec = Number.isFinite(this.store.liveWindowSec) && this.store.liveWindowSec > 0 ? this.store.liveWindowSec : 60
    this._WIN_MAX_SEC = 605        // keep enough history for the max configurable window
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
  _flush() { try { writeFileSync(this.file, JSON.stringify(this.store, null, 2)) } catch (e) { warnPollFailure('flush', e) } }

  start() {
    this.poll().catch((e) => warnPollFailure('poll', e))
    this._timer = setInterval(() => this.poll().catch((e) => warnPollFailure('poll', e)), this.interval)
    if (this._timer.unref) this._timer.unref()
    // Fast, lightweight /slots sampler (cache hit/miss) — independent of the heavy metrics poll.
    this._slotTimer = setInterval(() => this._sampleSlots().catch((e) => warnPollFailure('slots', e)), this._slotInterval)
    if (this._slotTimer.unref) this._slotTimer.unref()
    // Fast token-counter sampler feeding the live rolling-window rate.
    this._tokenTimer = setInterval(() => this._sampleTokens().catch((e) => warnPollFailure('tokens', e)), this._tokenInterval)
    if (this._tokenTimer.unref) this._tokenTimer.unref()
  }
  stop() { if (this._timer) clearInterval(this._timer); if (this._slotTimer) clearInterval(this._slotTimer); if (this._tokenTimer) clearInterval(this._tokenTimer) }

  /** Fast loop: poll each running llama.cpp service's /slots and fold per-request prompt-cache reuse into
   *  the cumulative per-svc counters. Cheap (tiny JSON), runs every ~2s so it catches most agent requests
   *  that the 20s metrics poll would skip between. Targets are refreshed by the main poll(). */
  async _sampleSlots() {
    const targets = this._slotTargets || []
    await Promise.all(targets.map(async (t) => {
      const txt = await this._get(`${t.base}/slots`, 1500)
      if (!txt) return
      try { const slots = JSON.parse(txt); if (Array.isArray(slots)) this._accumulateSlots(t.id, slots) } catch {}
    }))
  }

  /** Fold a /slots snapshot into per-svc cumulative cache-token counters. Each request (id_task) is
   *  committed once — using its LAST observed values — when a new task takes the slot or it goes idle,
   *  because n_prompt_tokens_processed is only final after prefill. Cached = total - processed (the
   *  n_prompt_tokens_cache field reads 0 in our build). Counters are monotonic per svc.id. */
  _accumulateSlots(svcId, slots) {
    const st = this._slotState[svcId] || (this._slotState[svcId] = { cur: {}, cacheTok: 0, totalTok: 0 })
    const commit = (c) => { if (c && c.total > 0) { st.cacheTok += (c.cached || 0); st.totalTok += c.total } }
    for (const sl of slots) {
      const id = sl?.id, task = sl?.id_task, total = sl?.n_prompt_tokens
      const processed = sl?.n_prompt_tokens_processed
      const cached = (typeof total === 'number' && typeof processed === 'number') ? Math.max(0, total - processed) : 0
      const prev = st.cur[id]
      if (typeof task === 'number' && task >= 0 && typeof total === 'number' && total > 0) {
        if (prev && prev.task !== task) commit(prev)
        st.cur[id] = { task, total, cached }
      } else if (prev) {
        commit(prev); delete st.cur[id]
      }
    }
  }

  /** Heuristic reasoning mode from the model/alias name (the user encodes it there). */
  _reasoningMode(svc) {
    const s = `${svc.model || ''} ${svc.aliasOverride || ''} ${svc.modelVariant || ''}`.toLowerCase()
    if (/think\w*[\s_-]*preserv|preserv\w*[\s_-]*think|thinking[\s_-]*kept/.test(s)) return 'Thinking Preserved'
    if (/no[\s_-]*think|think\w*[\s_-]*(off|disabled|none)|reasoning[\s_-]*off/.test(s)) return 'Thinking Off'
    if (/think\w*[\s_-]*(on|enabled)|reasoning[\s_-]*on|thinking\b/.test(s)) return 'Thinking On'
    return '—'
  }

  /** Stable fingerprint: one row per (model + backend + the settings that define a distinct run).
   *  Model identity comes from the SELECTION (family/variant) or the base model id — NEVER the
   *  aliasOverride / display name. Two instances of the same model + settings that differ only by a
   *  cosmetic name override are the same run and collapse into one row. */
  fingerprint(svc) {
    const modelId = [svc.modelFamily, svc.modelVariant].filter(Boolean).join('/') || svc.model || ''
    const key = [
      svc.providerId || svc.providerName || '',
      modelId,
      svc.quantFormat || '', svc.quantSize || '',
      String(svc.contextSize ?? ''),
      String(svc.slots ?? ''),
      this._reasoningMode(svc),
      [...(svc.gpuPciIds || [])].sort().join(','),
      svc.node || '',
    ].join('|')
    return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)
  }

  _gpuConfig() {
    try { return JSON.parse(readFileSync(this.gpuConfigFile, 'utf8')) } catch { return {} }
  }
  _gpuNames(svc) {
    // Friendly names live in gpu-config.json keyed `node:pci` → "V100 #0". Read it directly (authoritative);
    // fall back to gpuMonitor's resolver, then the raw PCI id.
    const cfg = this._gpuConfig()
    return [...(svc.gpuPciIds || [])].sort().map((pci) => {
      const key = `${svc.node}:${pci}`
      if (cfg[key]?.friendlyName) return cfg[key].friendlyName
      let fn = null
      try { fn = this.gpuMonitor?.getFriendlyName?.(svc.node, pci) } catch {}
      return fn || pci
    })
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
        // NOTE: external_prefix_cache_* counts hits served by the offload CONNECTOR, which is
        // the RAM tier and the Optane tier together — it is not Optane-specific. Kept under the
        // existing field name so stored history stays comparable; the UI labels it accordingly.
        optaneHits: promSum(text, 'vllm:external_prefix_cache_hits_total'),
        optaneQueries: promSum(text, 'vllm:external_prefix_cache_queries_total'),
        // Volume and latency of the offload path, split by direction. These are what actually
        // show the cache doing work: stored bytes climb whenever the connector is wired up at
        // all, restored bytes climb only when a lookup HITS. Restored staying at 0 while stored
        // grows is the exact signature of the cache being broken, which is the failure Travis
        // could not see before.
        kvOffloadStoredBytes: promSumLabeled(text, 'vllm:kv_offload_total_bytes_total', 'transfer_type', 'GPU_to_CPU'),
        kvOffloadRestoredBytes: promSumLabeled(text, 'vllm:kv_offload_total_bytes_total', 'transfer_type', 'CPU_to_GPU'),
        kvOffloadStoredSec: promSumLabeled(text, 'vllm:kv_offload_total_time_total', 'transfer_type', 'GPU_to_CPU'),
        kvOffloadRestoredSec: promSumLabeled(text, 'vllm:kv_offload_total_time_total', 'transfer_type', 'CPU_to_GPU'),
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
        kvOffloadStoredBytes: null, kvOffloadRestoredBytes: null,
        kvOffloadStoredSec: null, kvOffloadRestoredSec: null,
      }
    }
    if (text.includes('llamacpp:')) {
      const r = {
        promptTokens: promSum(text, 'llamacpp:prompt_tokens_total'),
        genTokens: promSum(text, 'llamacpp:tokens_predicted_total'),
        genSec: promSum(text, 'llamacpp:tokens_predicted_seconds_total'),
        promptSec: promSum(text, 'llamacpp:prompt_seconds_total'),
        decodeTps: promSum(text, 'llamacpp:predicted_tokens_seconds'),
        prefillTps: promSum(text, 'llamacpp:prompt_tokens_seconds'),
        cacheHits: null, cacheQueries: null, optaneHits: null, optaneQueries: null,
        kvOffloadStoredBytes: null, kvOffloadRestoredBytes: null,
        kvOffloadStoredSec: null, kvOffloadRestoredSec: null,
      }
      // "Regular" KV / prompt-cache hit rate is sampled from /slots by the fast _sampleSlots loop every
      // ~2s (llama.cpp has no cumulative cache counter in /metrics, and a 20s poll would miss most
      // requests). Here we just read the accumulated monotonic token totals.
      const st = this._slotState[svc.id]
      if (st) { r.cacheHits = st.cacheTok; r.cacheQueries = st.totalTok }
      // llama.cpp's Optane KV cache lives in the kvcache shim (servicePort + 1000), when one fronts it.
      const shim = await this._get(`http://${svc.containerIp}:${svc.port + 1000}/shim/stats`, 2000)
      if (shim) { try {
        const j = JSON.parse(shim)
        const st = j.stats || j
        const hits = j.hits ?? st.cache_hits ?? 0
        const misses = j.misses ?? st.cache_misses ?? 0
        r.optaneHits = hits; r.optaneQueries = hits + misses
        const avg = j.avgRestoreMs != null ? j.avgRestoreMs : (st.cache_hits ? st.restore_ms_total / st.cache_hits : null)
        if (avg != null) r.optaneRestoreMs = avg
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
    const IMAGE = new Set(['comfyui', 'sdnext', 'fooocus', 'invokeai'])
    const llm = all.filter((s) =>
      s && typeof s === 'object' && s.containerIp && s.port &&
      !s.isTts && !s.isImageGen && !s.isStt && !s.isTools &&
      !IMAGE.has((s.providerId || '').toLowerCase()) &&
      !/embed|rerank/i.test(`${s.model || ''} ${s.aliasOverride || ''} ${s.providerId || ''}`), // generative LLMs only
    )
    // Refresh the fast /slots sampler's target list (llama.cpp services only — others have no /slots).
    this._slotTargets = llm
      .filter((s) => /^llama-server/.test((s.providerId || '').toLowerCase()))
      .map((s) => ({ id: s.id, base: `http://${s.containerIp}:${s.port}` }))
    // All running LLM services get a live token window (keyed by durable fingerprint).
    this._winTargets = llm.map((s) => ({ id: s.id, base: `http://${s.containerIp}:${s.port}`, fp: this.fingerprint(s), providerId: (s.providerId || '').toLowerCase() }))
    const _liveFps = new Set(this._winTargets.map((t) => t.fp))
    for (const fp of Object.keys(this._win)) if (!_liveFps.has(fp)) delete this._win[fp]

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
        if (row._rebaseline) {
          // Just reset: baseline the counters at their CURRENT server values so cum_* starts from 0
          // (the /metrics counters are the server's monotonic lifetime totals; a plain accum after a
          // reset would re-add the whole lifetime). Skip accumulation for this one cycle.
          row._last = { promptTokens: m.promptTokens, genTokens: m.genTokens, genSec: m.genSec, promptSec: m.promptSec, cacheHits: m.cacheHits, cacheQueries: m.cacheQueries, optaneHits: m.optaneHits, optaneQueries: m.optaneQueries,
            kvOffloadStoredBytes: m.kvOffloadStoredBytes, kvOffloadRestoredBytes: m.kvOffloadRestoredBytes, kvOffloadStoredSec: m.kvOffloadStoredSec, kvOffloadRestoredSec: m.kvOffloadRestoredSec }
          delete row._rebaseline
        } else {
          this._accum(row, 'promptTokens', m.promptTokens, runId)
          this._accum(row, 'genTokens', m.genTokens, runId)
          this._accum(row, 'genSec', m.genSec, runId)
          this._accum(row, 'promptSec', m.promptSec, runId)
          this._accum(row, 'cacheHits', m.cacheHits, runId)
          this._accum(row, 'cacheQueries', m.cacheQueries, runId)
          this._accum(row, 'optaneHits', m.optaneHits, runId)
          this._accum(row, 'optaneQueries', m.optaneQueries, runId)
          // KV offload volume/latency, split by direction. cum_kvOffloadRestoredBytes is the one
          // that proves the cache is EARNING its keep: stored bytes climb as soon as the connector
          // is wired at all, restored bytes climb only on an actual hit.
          this._accum(row, 'kvOffloadStoredBytes', m.kvOffloadStoredBytes, runId)
          this._accum(row, 'kvOffloadRestoredBytes', m.kvOffloadRestoredBytes, runId)
          this._accum(row, 'kvOffloadStoredSec', m.kvOffloadStoredSec, runId)
          this._accum(row, 'kvOffloadRestoredSec', m.kvOffloadRestoredSec, runId)
          this._checkKvOffloadDead(row);
        }
        row._lastRun = runId
        // Long-term rate = accumulated tokens / accumulated PHASE time (reset-able, excludes idle) —
        // the llamacpp gauge is a non-reset-able lifetime avg. Fall back to the engine gauge (vLLM).
        if (row.cum_genSec > 0) row.decodeTps = Math.round((row.cum_genTokens / row.cum_genSec) * 10) / 10
        else if (m.decodeTps != null && m.decodeTps > 0) row.decodeTps = Math.round(m.decodeTps * 10) / 10
        if (row.cum_promptSec > 0) row.prefillTps = Math.round((row.cum_promptTokens / row.cum_promptSec) * 10) / 10
        else if (m.prefillTps != null && m.prefillTps > 0) row.prefillTps = Math.round(m.prefillTps * 10) / 10
        if (m.optaneRestoreMs != null) row.optaneRestoreMs = m.optaneRestoreMs
      }
    }
    // Fold API-level tool-call counts (accumulated in-process per serviceId) into the durable rows.
    // Delta-accumulate keyed by currentServiceId so totals persist across model relaunches + AI-Lab restarts.
    try {
      const snap = toolCallSnapshot()
      const bySvc = new Map(snap.map((e) => [e.svcId, e]))
      for (const row of Object.values(this.store.rows)) {
        const e = row.currentServiceId ? bySvc.get(row.currentServiceId) : null
        if (!e) continue
        const base = row._toolBase
        const fresh = !base || base.svcId !== row.currentServiceId
        for (const [field, cur] of [['toolCalls', e.total], ['toolErrStructure', e.structureErrors], ['toolErrHallucination', e.hallucinationErrors]]) {
          const last = fresh ? 0 : (base[field] || 0)
          const delta = cur < last ? cur : cur - last // guard against in-process reset
          row[field] = (row[field] || 0) + delta
        }
        row._toolBase = { svcId: row.currentServiceId, toolCalls: e.total, toolErrStructure: e.structureErrors, toolErrHallucination: e.hallucinationErrors }
      }
    } catch {}

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

  /** Lightweight fast scrape: just the cumulative gen/prompt token counters (no shim/slots). */
  async _scrapeTokens(t) {
    const text = await this._get(`${t.base}/metrics`, 2500)
    if (!text) return null
    const pid = t.providerId
    if (text.includes('vllm:') || pid.includes('vllm')) return { gen: promSum(text, 'vllm:generation_tokens_total'), prompt: promSum(text, 'vllm:prompt_tokens_total') }
    if (text.includes('aphrodite:')) return { gen: promSum(text, 'aphrodite:generation_tokens_total'), prompt: promSum(text, 'aphrodite:prompt_tokens_total') }
    if (text.includes('llamacpp:')) return {
      gen: promSum(text, 'llamacpp:tokens_predicted_total'), genSec: promSum(text, 'llamacpp:tokens_predicted_seconds_total'),
      prompt: promSum(text, 'llamacpp:prompt_tokens_total'), promptSec: promSum(text, 'llamacpp:prompt_seconds_total'),
    }
    return null
  }

  /** Fast loop: push a timestamped {gen,prompt} counter sample per running service into its ring buffer. */
  async _sampleTokens() {
    const now = Date.now()
    const cutoff = now - this._WIN_MAX_SEC * 1000
    await Promise.all((this._winTargets || []).map(async (t) => {
      const m = await this._scrapeTokens(t).catch(() => null)
      if (!m || m.gen == null) return
      const buf = this._win[t.fp] || (this._win[t.fp] = [])
      buf.push({ t: now, gen: m.gen, genSec: m.genSec ?? null, prompt: m.prompt ?? 0, promptSec: m.promptSec ?? null })
      while (buf.length && buf[0].t < cutoff) buf.shift()
    }))
  }

  /** Rolling decode/prefill t/s over the configured live window, from the counter ring buffer.
   *  Counters can reset on service relaunch — a negative delta means reset, so we skip it. */
  _liveTps(fp) {
    const buf = this._win[fp]
    if (!buf || buf.length < 2) return { liveDecodeTps: null, livePrefillTps: null }
    const now = buf[buf.length - 1].t
    const winStart = now - this._liveWindowSec * 1000
    let a = buf[0]
    for (const s of buf) { if (s.t <= winStart) a = s; else break }
    if (a === buf[buf.length - 1]) a = buf[0]
    const b = buf[buf.length - 1]
    const dtWall = (b.t - a.t) / 1000
    if (dtWall <= 0) return { liveDecodeTps: null, livePrefillTps: null }
    // TRUE rate divides tokens by the PHASE time (llama.cpp's *_seconds_total counters, which only
    // advance during that phase) — excludes prefill/idle and reflects the aggregate across busy slots.
    // Both token + seconds counters bulk-update at request completion, so this is the rate of the
    // request(s) that completed within the window. vLLM has no phase-seconds counter -> wall-time.
    const rate = (dTok, dSec) => {
      if (dTok == null || dTok < 0) return null
      if (dSec != null) return dSec > 0.05 ? Math.round((dTok / dSec) * 10) / 10 : 0
      return Math.round((dTok / dtWall) * 10) / 10 // wall-time fallback (no phase-seconds counter)
    }
    const dGenSec = (b.genSec != null && a.genSec != null) ? b.genSec - a.genSec : null
    const dPromptSec = (b.promptSec != null && a.promptSec != null) ? b.promptSec - a.promptSec : null
    return { liveDecodeTps: rate(b.gen - a.gen, dGenSec), livePrefillTps: rate(b.prompt - a.prompt, dPromptSec) }
  }

  getLiveWindowSec() { return this._liveWindowSec }
  setLiveWindowSec(sec) {
    const v = Math.max(5, Math.min(600, Math.round(Number(sec) || 0)))
    this._liveWindowSec = v; this.store.liveWindowSec = v; this._flush(); return v
  }

  /** Reset a config's accumulated metrics to zero WITHOUT deleting the row (keeps identity/settings).
   *  Clears cumulative counters, rates, tool-call tallies, and the live window baseline. */
  resetRow(fp) {
    const row = this.store.rows[fp]
    if (!row) return false
    for (const k of Object.keys(row)) if (k.startsWith('cum_')) row[k] = 0
    row.decodeTps = 0; row.prefillTps = 0; row.optaneRestoreMs = null
    row.toolCalls = 0; row.toolErrStructure = 0; row.toolErrHallucination = 0
    row._last = undefined; row._lastRun = undefined; row._toolBase = undefined; row._rebaseline = true
    delete this._win[fp]
    if (this._slotState[row.currentServiceId]) delete this._slotState[row.currentServiceId]
    this._flush(); return true
  }

  /** Rows for the dashboard; running rows also carry the live rolling-window rates + the window size. */
  getRows() {
    return Object.values(this.store.rows).map((r) => {
      const { _last, _lastRun, _toolBase, ...rest } = r
      if (rest.running) { const live = this._liveTps(r.fingerprint); rest.liveDecodeTps = live.liveDecodeTps; rest.livePrefillTps = live.livePrefillTps }
      rest.liveWindowSec = this._liveWindowSec
      return rest
    })
  }
  deleteRow(fp) { if (this.store.rows[fp]) { delete this.store.rows[fp]; delete this._win[fp]; this._flush(); return true } return false }
}
