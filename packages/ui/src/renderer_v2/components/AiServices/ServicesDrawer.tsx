import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, X, ExternalLink, Pause, Play, RotateCw, Square, Loader2, Cpu, Server, Pencil, Check, Copy, TerminalSquare } from 'lucide-react'
import { liveConsoleStore } from '../../stores/LiveConsoleStore'
import { aiServicesStore as store, type AiService } from '../../stores/AiServicesStore'
import { ConfirmModal } from '../Cluster/ClusterModals'
import styles from './AiServices.module.scss'

const TYPE_COLORS: Record<string, string> = {
  llm: 'var(--accent)', tts: '#c879e0', stt: '#79b8e0', image: '#e0a832',
  tools: '#5fd38a', embed: '#ec4899', rerank: '#ec4899', training: '#e0794f',
}
const STATUS: Record<string, { label: string; cls: string }> = {
  running: { label: 'Running', cls: 'stRun' },
  suspended: { label: 'Suspended', cls: 'stSusp' },
  down: { label: 'Down', cls: 'stDown' },
  unknown: { label: '…', cls: 'stUnknown' },
}
function uptime(ts?: number | string): string {
  if (!ts) return ''
  const t = typeof ts === 'string' ? Date.parse(ts) : ts
  if (!t) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
function fmtCtx(n?: number): string {
  if (!n) return ''
  if (n >= 1024) return `${Math.round(n / 1024)}K`
  return String(n)
}
const gb = (mb?: number) => (mb ? (mb / 1024).toFixed(mb < 10240 ? 1 : 0) : '0')

/** Element-wise average / sum across several equal-ish-length series. */
function combine(series: number[][], mode: 'avg' | 'sum'): number[] {
  const arrs = series.filter((a) => a?.length)
  if (!arrs.length) return []
  const len = Math.min(...arrs.map((a) => a.length))
  const out: number[] = []
  for (let i = 0; i < len; i++) {
    const slice = arrs.map((a) => a[a.length - len + i])
    const s = slice.reduce((n, v) => n + v, 0)
    out.push(mode === 'avg' ? s / slice.length : s)
  }
  return out
}

/** Full-width labeled sparkline row. data scaled to [0,max]; stretches to container width. */
const SparkRow: React.FC<{ label: string; data: number[]; max: number; color: string; value: string }> = ({ label, data, max, color, value }) => {
  const h = 24
  const pts =
    data.length > 0
      ? data
          .map((v, i) => {
            const x = data.length === 1 ? 100 : (i / (data.length - 1)) * 100
            const y = h - (Math.max(0, Math.min(max || 1, v)) / (max || 1)) * h
            return `${x.toFixed(2)},${y.toFixed(2)}`
          })
          .join(' ')
      : ''
  return (
    <div className={styles.sparkRow}>
      <span className={styles.sparkLabel}>{label}</span>
      <svg className={styles.sparkSvg} height={h} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none">
        {pts && <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      </svg>
      <span className={styles.sparkVal}>{value}</span>
    </div>
  )
}

const ServiceCard: React.FC<{ s: AiService; onKill: (s: AiService) => void }> = observer(({ s, onKill }) => {
  const busy = store.busyId === s.id
  const color = TYPE_COLORS[s.serviceType || ''] || 'var(--fg-muted)'
  const model = [s.modelFamily, s.modelVariant, s.quantFormat, s.quantSize].filter(Boolean).join(' · ')
  const sd = !!s.isSystemService
  const status = store.statusOf(s.id)
  const stat = store.statsById[s.id]
  const st = STATUS[status]
  const gpus = (s.gpuPciIds ?? []).map((pci) => ({ pci, info: store.gpuIndex[pci] })).filter((g) => g.info)
  const vramUsed = gpus.reduce((n, g) => n + (g.info?.memUsed ?? 0), 0)
  const vramTotal = gpus.reduce((n, g) => n + (g.info?.memTotal ?? 0), 0)
  const pcis = gpus.map((g) => g.pci)
  const utilSeries = combine(pcis.map((p) => store.utilHistory[p] ?? []), 'avg')
  const vramSeries = combine(pcis.map((p) => store.vramHistory[p] ?? []), 'sum')
  const curUtil = utilSeries.length ? Math.round(utilSeries[utilSeries.length - 1]) : 0
  const alias = stat?.modelIdentifier || s.aliasOverride

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  return (
    <div className={styles.card} style={{ borderColor: `color-mix(in srgb, ${color} 55%, var(--border))`, borderLeft: `3px solid ${color}` }}>
      <div className={styles.cardHead}>
        <span className={styles.typeBadge} style={{ background: `color-mix(in srgb, ${color} 22%, transparent)`, color }}>{s.serviceType || 'svc'}</span>
        <span className={styles.svcName} title={s.providerName}>{s.providerName || s.providerId}</span>
        <span className={`${styles.statusPill} ${styles[st.cls]}`}>{st.label}</span>
        {busy && <Loader2 size={13} className={styles.spin} />}
      </div>

      {model && <div className={styles.model}>{model}</div>}

      {/* model alias / served-name override */}
      <div className={styles.aliasRow}>
        {editing ? (
          <>
            <input
              className={styles.aliasInput}
              autoFocus
              value={draft}
              placeholder="served model name"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { void store.setAlias(s.id, draft); setEditing(false) }
                if (e.key === 'Escape') setEditing(false)
              }}
            />
            <button className={styles.act} title="Save alias" onClick={() => { void store.setAlias(s.id, draft); setEditing(false) }}><Check size={12} /></button>
          </>
        ) : (
          <>
            <span className={styles.alias} title={alias || ''}>{alias || <span className={styles.aliasNone}>no alias</span>}</span>
            <button className={styles.iconMini} title="Override served model name" onClick={() => { setDraft(alias || ''); setEditing(true) }}><Pencil size={11} /></button>
          </>
        )}
      </div>

      <div className={styles.meta}>
        <span>{s.node}</span><span>:{s.port}</span>
        {s.contextSize ? <span title="context size">ctx {fmtCtx(s.contextSize)}</span> : null}
        {s.proxySlot != null ? <span title="proxy slot">slot {String(s.proxySlot)}</span> : null}
        {typeof stat?.tps === 'number' ? <span className={styles.tps}>{stat.tps.toFixed(0)} tps</span> : null}
        {s.startedAt ? <span className={styles.up}>up {uptime(s.startedAt)}</span> : null}
        <span className={sd ? styles.sd : styles.tmux}>{sd ? 'systemd' : 'tmux'}</span>
      </div>

      {/* GPU badges (wrap to as many rows as needed) */}
      {gpus.length > 0 && (
        <div className={styles.gpuRow}>
          {gpus.map((g) => (
            <span key={g.pci} className={styles.gpuBadge} title={`${g.pci} · ${g.info!.util}% · ${gb(g.info!.memUsed)}/${gb(g.info!.memTotal)} GB`}>
              <Cpu size={10} /> GPU{g.info!.index} {g.info!.name}
            </span>
          ))}
        </div>
      )}

      {/* Full-width labeled GPU + VRAM usage sparklines */}
      {gpus.length > 0 && (
        <div className={styles.metrics}>
          <SparkRow label="GPU" data={utilSeries} max={100} color={color} value={`${curUtil}%`} />
          <SparkRow label="VRAM" data={vramSeries} max={vramTotal} color="#8aa0ff" value={`${gb(vramUsed)}/${gb(vramTotal)} GB`} />
        </div>
      )}

      <div className={styles.cardFoot}>
        {s.endpoint && (
          <a className={styles.endpoint} href={s.endpoint} target="_blank" rel="noreferrer" title={s.endpoint}>
            {s.endpoint.replace(/^https?:\/\//, '')} <ExternalLink size={10} />
          </a>
        )}
        <div className={styles.spacer} />
        <button className={styles.act} title="Live console / logs (attach to tmux session)" onClick={() => liveConsoleStore.openService(s)}><TerminalSquare size={13} /></button>
        {sd && (
          <>
            <button className={styles.act} title="Suspend" disabled={busy} onClick={() => void store.lifecycle(s.id, 'suspend')}><Pause size={13} /></button>
            <button className={styles.act} title="Start" disabled={busy} onClick={() => void store.lifecycle(s.id, 'start')}><Play size={13} /></button>
            <button className={styles.act} title="Restart" disabled={busy} onClick={() => void store.lifecycle(s.id, 'restart')}><RotateCw size={13} /></button>
          </>
        )}
        <button className={`${styles.act} ${styles.danger}`} title="Stop + remove" disabled={busy} onClick={() => onKill(s)}><Square size={13} /></button>
      </div>
    </div>
  )
})

type UrlMode = 'ip' | 'http' | 'https'
// Per-type endpoint templates: (slot) → [ [label, pathSuffix], ... ] under /<type>/<slot>...
const ENDPOINTS: Record<string, (slot: number) => Array<[string, string]>> = {
  llm: (s) => [
    ['chat', `/llm/${s}/v1/chat/completions`],
    ['completions', `/llm/${s}/v1/completions`],
    ['models', `/llm/${s}/v1/models`],
  ],
  embed: (s) => [
    ['embeddings', `/embed/${s}/v1/embeddings`],
    ['models', `/embed/${s}/v1/models`],
  ],
  rerank: (s) => [
    ['rerank v1', `/rerank/${s}/v1/rerank`],
    ['rerank v2', `/rerank/${s}/v2/rerank`],
  ],
  tts: (s) => [
    ['speech', `/tts/${s}/v1/audio/speech`],
    ['voices', `/tts/v1/providers/${s}/voices`],
    ['models', `/tts/v1/providers/${s}/models`],
  ],
  stt: (s) => [
    ['transcriptions', `/stt/${s}/v1/audio/transcriptions`],
    ['models', `/stt/v1/providers/${s}/models`],
  ],
  image: (s) => [['base', `/image/${s}/v1`]],
}
// Universal, load-balanced LLM endpoint (1st/any active LLM slot) — the headline endpoint apps point at.
const UNIVERSAL_LLM: Array<[string, string]> = [
  ['chat', '/llm/v1/chat/completions'],
  ['completions', '/llm/v1/completions'],
  ['models', '/llm/v1/models'],
]
const MULTI_TTS: Array<[string, string]> = [
  ['preset base (OpenAI-compat)', '/preset-tts/v1'],
  ['preset-speech', '/preset-tts/v1/audio/speech'],
  ['voice-presets', '/multi-tts/voice-presets'],
  ['speech', '/multi-tts/v1/audio/speech'],
  ['cloned-speech', '/multi-tts/v1/audio/cloned-speech'],
  ['stream', '/multi-tts/stream'],
  ['speech (raw)', '/multi-tts/speech'],
  ['models', '/multi-tts/v1/models'],
  ['voices', '/multi-tts/v1/voices'],
  ['status', '/multi-tts/status'],
]
const TYPE_TITLES: Record<string, string> = { llm: 'LLM', tts: 'TTS', stt: 'STT', embed: 'Embeddings', rerank: 'Rerankers', image: 'Image Gen' }

const UrlRow: React.FC<{ label: string; url: string }> = ({ label, url }) => {
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.epRow}>
      <span className={styles.epLabel}>{label}</span>
      <button
        className={styles.epUrlBtn}
        title="Copy"
        onClick={() => {
          navigator.clipboard?.writeText(url)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        <code className={styles.epUrl}>{url}</code>
        {copied ? <Check size={11} className={styles.epCopyIcon} /> : <Copy size={11} className={styles.epCopyIcon} />}
      </button>
    </div>
  )
}

/** A proxy entry: header (name + model) on row 1, then each endpoint URL on its own row. */
const ProxyEntry: React.FC<{ title: string; sub?: string; healthy?: boolean; endpoints: Array<[string, string]>; base: string }> = ({ title, sub, healthy, endpoints, base }) => (
  <div className={styles.proxyEntry}>
    <div className={styles.entryHeader}>
      {healthy != null && <span className={`${styles.healthDot} ${healthy ? styles.hOk : styles.hDown}`} />}
      <span className={styles.entryName}>{title}</span>
      {sub && <span className={styles.entryModel}>{sub}</span>}
    </div>
    {endpoints.map(([label, path]) => (
      <UrlRow key={path} label={label} url={`${base}${path}`} />
    ))}
  </div>
)

const URL_MODE_KEY = 'ai-lab-proxy-url-mode'

/** AI-Lab Universal API Proxy card — full endpoint surface, click-to-copy, URL-format toggle. */
const ProxyCard: React.FC = observer(() => {
  const ps = store.proxyState
  const [mode, setMode] = useState<UrlMode>(() => (localStorage.getItem(URL_MODE_KEY) as UrlMode) || 'ip')
  const setUrlMode = (m: UrlMode) => {
    setMode(m)
    localStorage.setItem(URL_MODE_KEY, m)
  }
  if (!ps?.port) return null
  const bp = ps.basePath || '/api/proxy'
  const host = window.location.hostname
  const base =
    mode === 'ip' ? `http://${ps.lanIp || host}:${ps.port}${bp}` : mode === 'http' ? `http://${host}:${ps.port}${bp}` : `https://${host}${bp}`

  const svc = (ps.services || {}) as Record<string, any>
  const slotTypes = ['llm', 'embed', 'rerank', 'tts', 'stt', 'image']
  const multi = svc.multiTts
  const hasMulti = multi && ((multi.ttsCount ?? 0) > 0 || (multi.tts || []).length > 0)
  const vector = ps.vector || []
  const anySlots = slotTypes.some((t) => (svc[t] || []).length)

  return (
    <div className={styles.proxyCard}>
      <div className={styles.proxyHead}>
        <Server size={14} className={styles.headerIcon} />
        <span className={styles.proxyTitle}>Universal API Proxy</span>
        <div className={styles.urlToggle}>
          {(['ip', 'http', 'https'] as UrlMode[]).map((m) => (
            <button key={m} className={`${styles.urlMode} ${mode === m ? styles.urlModeActive : ''}`} onClick={() => setUrlMode(m)}>
              {m.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {(svc.llm || []).length > 0 && (
        <div className={styles.proxyType}>
          <div className={styles.proxyTypeLabel}>Universal LLM (load-balanced)</div>
          <ProxyEntry title={`${(svc.llm || []).length} LLM slot${(svc.llm || []).length > 1 ? 's' : ''} · auto-routed`} endpoints={UNIVERSAL_LLM} base={base} />
        </div>
      )}

      {slotTypes.map((t) => {
        const list = svc[t] || []
        if (!list.length || !ENDPOINTS[t]) return null
        return (
          <div key={t} className={styles.proxyType}>
            <div className={styles.proxyTypeLabel}>{TYPE_TITLES[t] || t}</div>
            {list.map((s: any) => (
              <ProxyEntry
                key={s.slot}
                title={`Slot ${s.slot} · ${s.providerName || s.providerId || ''}`}
                sub={s.aliasOverride || s.model || undefined}
                endpoints={ENDPOINTS[t](s.slot)}
                base={base}
              />
            ))}
          </div>
        )
      })}

      {hasMulti && (
        <div className={styles.proxyType}>
          <div className={styles.proxyTypeLabel}>Multi-TTS Pipeline</div>
          <ProxyEntry title={`${multi.ttsCount ?? (multi.tts || []).length} TTS · ${(multi.rvc || []).length} RVC`} endpoints={MULTI_TTS} base={base} />
        </div>
      )}

      {vector.length > 0 && (
        <div className={styles.proxyType}>
          <div className={styles.proxyTypeLabel}>Vector Databases</div>
          <ProxyEntry
            title="Consensus (all DBs)"
            endpoints={[
              ['collections', '/vector/all/collections'],
              ['search', '/vector/all/collections/{collection}/search'],
            ]}
            base={base}
          />
          {vector.map((db: any) => (
            <ProxyEntry
              key={db.name}
              title={db.name}
              sub={db.type}
              healthy={db.healthy}
              endpoints={[['proxy', `/vector/${db.name}`]]}
              base={base}
            />
          ))}
        </div>
      )}

      {!anySlots && !hasMulti && vector.length === 0 && <div className={styles.proxyEmpty}>No routable services yet.</div>}
    </div>
  )
})

/** Global right-side running-services drawer — visible on any tab while open. */
export const ServicesDrawer: React.FC<{ visible: boolean; onClose: () => void }> = observer(({ visible, onClose }) => {
  const [killing, setKilling] = useState<AiService | null>(null)
  useEffect(() => {
    if (visible) store.startPolling(15000)
    else store.stopPolling()
    return () => store.stopPolling()
  }, [visible])

  return (
    <div className={`${styles.drawer} ${visible ? styles.drawerOpen : ''}`} aria-hidden={!visible}>
      <div className={styles.drawerHead}>
        <Server size={15} className={styles.headerIcon} />
        <span className={styles.title}>Services</span>
        <span className={styles.count}>{store.services.length}</span>
        <div className={styles.spacer} />
        <button className={styles.refreshBtn} title="Refresh" onClick={() => void store.load()}>
          <RefreshCw size={13} className={store.loading ? styles.spin : ''} />
        </button>
        <button className={styles.refreshBtn} title="Close" onClick={onClose}><X size={15} /></button>
      </div>
      <div className={styles.filterChips}>
        <button
          className={`${styles.fChip} ${store.typeFilter === 'all' ? styles.fChipActive : ''}`}
          onClick={() => store.setTypeFilter('all')}
        >
          All <span className={styles.fCount}>{store.services.length}</span>
        </button>
        {store.serviceTypes.map((t) => {
          const c = TYPE_COLORS[t] || 'var(--fg-muted)'
          const active = store.typeFilter === t
          const n = store.services.filter((s) => (s.serviceType || 'other') === t).length
          return (
            <button
              key={t}
              className={`${styles.fChip} ${active ? styles.fChipActive : ''}`}
              style={active ? { background: c, borderColor: c, color: '#06121f' } : { borderColor: `color-mix(in srgb, ${c} 50%, var(--border))`, color: c }}
              onClick={() => store.setTypeFilter(t)}
            >
              {t} <span className={styles.fCount}>{n}</span>
            </button>
          )
        })}
      </div>
      <div className={styles.drawerBody}>
        {store.error && <div className={styles.errorBar}>{store.error}</div>}
        {!store.loaded && !store.error && <div className={styles.loading}>Loading…</div>}
        <ProxyCard />
        {store.typeFilter === 'all'
          ? store.serviceTypes.map((t) => {
              const cards = store.filteredServices.filter((s) => (s.serviceType || 'other') === t)
              if (!cards.length) return null
              const c = TYPE_COLORS[t] || 'var(--fg-muted)'
              return (
                <div key={t} className={styles.svcGroup}>
                  <div className={styles.svcGroupLabel} style={{ color: c }}>{t}<span className={styles.fCount}>{cards.length}</span></div>
                  {cards.map((s) => <ServiceCard key={s.id} s={s} onKill={setKilling} />)}
                </div>
              )
            })
          : store.filteredServices.map((s) => <ServiceCard key={s.id} s={s} onKill={setKilling} />)}
        {store.loaded && store.filteredServices.length === 0 && <div className={styles.empty}>No running services.</div>}
      </div>
      {killing && (
        <ConfirmModal
          title={`Stop ${killing.providerName || killing.providerId}?`}
          message={`Stops and removes the service on ${killing.node}:${killing.port}.`}
          confirmLabel="Stop + remove" danger
          onConfirm={() => void store.lifecycle(killing.id, 'kill')}
          onClose={() => setKilling(null)}
        />
      )}
    </div>
  )
})
