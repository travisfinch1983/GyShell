import React, { useCallback, useEffect, useState } from 'react'
import { Pause, Play, RefreshCw, Trash2, Zap } from 'lucide-react'
import { upscalerApi } from './upscalerApi'
import styles from './Upscaler.module.scss'

/**
 * Upscaler · Dashboard — native port of templates/index.html (behavior parity,
 * AI-Lab styling): status header (worker/queue/immich), processing + recent
 * activity, watch list, exclusions, GPU toggles, settings.
 * Data: GET /?format=json (triggers live Immich + GPU refresh — slow first
 * load, spinner shown). Actions POST then re-fetch.
 */

interface Source { id: number; kind: 'album' | 'tag'; external_id: string; name: string; role: string }

const MODELS = ['seedvr2-7b-fp16', 'seedvr2-7b-fp8', 'seedvr2-7b-sharp-fp16', 'seedvr2-7b-sharp-fp8', 'seedvr2-3b-fp16', 'seedvr2-3b-fp8', 'nmkd-siax', 'remacri', 'realesrgan-x4']
const SETTING_FIELDS: Array<{ key: string; label: string; type?: 'number' }> = [
  { key: 'proxlab_url', label: 'ProxLab URL' },
  { key: 'gpu_host_user', label: 'SSH user on GPU containers' },
  { key: 'gpu_host_script', label: 'upscale_pipeline.py path on GPU containers' },
  { key: 'min_input_mp', label: 'Min input MP (smaller = skipped)', type: 'number' },
  { key: 'poll_interval_sec', label: 'Poll interval (seconds)', type: 'number' },
  { key: 'auto_managed_tag', label: 'Auto-managed tag (added on completion)' },
]

/** Album/tag picker pair — picking one clears the other (parity with the Jinja form). */
const SourcePicker: React.FC<{ albums: any[]; tags: any[]; role: 'watch' | 'exclude'; onAdded: () => void }> = ({ albums, tags, role, onAdded }) => {
  const [album, setAlbum] = useState('')
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  const add = async () => {
    const kind = album ? 'album' : 'tag'
    const id = album || tag
    if (!id) return
    const name = album
      ? albums.find((a) => a.id === album)?.albumName ?? id
      : tags.find((t) => t.id === tag)?.value ?? tags.find((t) => t.id === tag)?.name ?? id
    setBusy(true)
    try { await upscalerApi.addSource(kind, id, name, role); setAlbum(''); setTag(''); onAdded() } finally { setBusy(false) }
  }
  return (
    <div className={styles.addRow}>
      <select className={styles.select} value={album} onChange={(e) => { setAlbum(e.target.value); if (e.target.value) setTag('') }}>
        <option value="">— album —</option>
        {albums.map((a) => <option key={a.id} value={a.id}>{a.albumName} ({a.assetCount ?? '?'})</option>)}
      </select>
      <span className={styles.faint}>or</span>
      <select className={styles.select} value={tag} onChange={(e) => { setTag(e.target.value); if (e.target.value) setAlbum('') }}>
        <option value="">— tag —</option>
        {tags.map((t) => <option key={t.id} value={t.id}>{t.value ?? t.name}</option>)}
      </select>
      <button className={styles.btn} disabled={busy || (!album && !tag)} onClick={() => void add()}>
        Add to {role === 'watch' ? 'watch list' : 'exclusions'}
      </button>
    </div>
  )
}

const SourceTable: React.FC<{ rows: Source[]; empty: string; onChanged: () => void }> = ({ rows, empty, onChanged }) => (
  <table className={styles.table}>
    <thead><tr><th>Kind</th><th>Name</th><th>External id</th><th /></tr></thead>
    <tbody>
      {rows.length === 0 && <tr><td colSpan={4} className={styles.dim}>{empty}</td></tr>}
      {rows.map((s) => (
        <tr key={s.id}>
          <td><span className={`${styles.badge} ${styles.badgeKind}`}>{s.kind}</span></td>
          <td>{s.name}</td>
          <td className={styles.mono} title={s.external_id}>{s.external_id.slice(0, 8)}…</td>
          <td>
            <button className={styles.btnDanger} onClick={() => void upscalerApi.deleteSource(String(s.id)).then(onChanged)}>
              <Trash2 size={12} /> remove
            </button>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
)

export const DashboardView: React.FC = () => {
  const [d, setD] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [gpuSel, setGpuSel] = useState<Set<string>>(new Set())
  const [settings, setSettings] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const data = await upscalerApi.dashboard()
      setD(data)
      setErr(null)
      const sel = new Set<string>()
      for (const gpus of Object.values<any[]>(data.gpus_by_container ?? {}))
        for (const g of gpus) if (g.enabled) sel.add(`${g.agent_name}:${g.cuda_index}`)
      setGpuSel(sel)
      setSettings((prev) => {
        // Don't clobber in-progress edits on the background refresh.
        if (Object.keys(prev).length) return prev
        const s: Record<string, string> = { model: String(data.settings?.model ?? '') }
        for (const f of SETTING_FIELDS) s[f.key] = String(data.settings?.[f.key] ?? '')
        return s
      })
    } catch (e) {
      setErr(String((e as Error).message))
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 15000)
    return () => clearInterval(t)
  }, [load])

  if (err && !d) return <div className={styles.view}><span className={styles.msgErr}>{err}</span></div>
  if (!d) return <div className={styles.view}><span className={styles.dim}>Loading (first load hits Immich + GPU discovery — a few seconds)…</span></div>

  const workerOn = String(d.settings?.worker_enabled) === '1' || d.settings?.worker_enabled === 1 || d.settings?.worker_enabled === true
  const queue: Record<string, number> = d.queue ?? {}
  const act = async (fn: () => Promise<any>, label: string) => {
    try { const r = await fn(); setMsg(r?.ok === false ? `${label} failed` : `${label} ✓`); await load() } catch (e) { setMsg(`${label} failed: ${String((e as Error).message)}`) }
  }

  return (
    <div className={styles.view}>
      {/* ── status header ── */}
      <div className={styles.headRow}>
        <span className={`${styles.badge} ${d.immich_ok ? styles.badgeOk : styles.badgeErr}`} title={d.immich_err ?? d.immich_url}>
          Immich {d.immich_version ?? '?'}{!d.immich_ok && ' — unreachable'}
        </span>
        <span className={`${styles.badge} ${workerOn ? styles.badgeOk : ''}`}>worker {workerOn ? 'running' : 'paused'}</span>
        <span className={styles.badge}>{d.enabled_gpu_count} GPU{d.enabled_gpu_count === 1 ? '' : 's'} enabled</span>
        <span className={styles.spacer} />
        {workerOn ? (
          <button className={styles.btn} onClick={() => void act(upscalerApi.workerPause, 'Pause')}><Pause size={12} /> Pause worker</button>
        ) : (
          <button className={styles.btnPrimary} onClick={() => void act(upscalerApi.workerResume, 'Resume')}><Play size={12} /> Resume worker</button>
        )}
        <button className={styles.btn} onClick={() => void act(upscalerApi.pollNow, 'Poll')}><Zap size={12} /> Poll now</button>
        <button className={styles.btn} title="Refresh view" onClick={() => void load()}><RefreshCw size={12} /></button>
      </div>
      {msg && <span className={styles.msg} onClick={() => setMsg(null)}>{msg}</span>}

      {/* ── queue stats + processing ── */}
      <div className={styles.card}>
        <div className={styles.statRow}>
          {['queued', 'processing', 'failed'].map((k) => (
            <span key={k} className={styles.stat}><b className={k === 'failed' && queue[k] ? styles.err : ''}>{queue[k] ?? 0}</b><span>{k}</span></span>
          ))}
          {Object.entries(queue).filter(([k]) => !['queued', 'processing', 'failed'].includes(k)).map(([k, v]) => (
            <span key={k} className={styles.stat}><b>{v}</b><span>{k}</span></span>
          ))}
          {Object.entries<any>(d.processed ?? {}).map(([k, v]) => (
            <span key={k} className={styles.stat}><b>{String(v)}</b><span>{k}</span></span>
          ))}
        </div>
        {(d.processing ?? []).length > 0 && (
          <table className={styles.table} style={{ marginTop: 8 }}>
            <thead><tr><th>Processing now</th><th>Started</th></tr></thead>
            <tbody>
              {d.processing.map((p: any, i: number) => (
                <tr key={p.asset_id ?? i}>
                  <td className={styles.mono}>{p.filename ?? p.asset_id}</td>
                  <td className={styles.dim}>{p.started_at ? `${Math.max(0, Math.round(d.now_ts - p.started_at))}s ago` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── recent activity ── */}
      <div className={styles.card}>
        <div className={styles.cardTitle}>Recent activity</div>
        <table className={styles.table}>
          <thead><tr><th>File</th><th>Model</th><th>Size</th><th>Elapsed</th><th>Status</th><th>When</th></tr></thead>
          <tbody>
            {(d.activity ?? []).length === 0 && <tr><td colSpan={6} className={styles.dim}>No activity yet.</td></tr>}
            {(d.activity ?? []).slice(0, 15).map((a: any) => (
              <tr key={`${a.asset_id}-${a.processed_at}`}>
                <td className={styles.mono} title={a.asset_id}>{a.filename ?? a.asset_id}</td>
                <td className={styles.dim}>{a.model}</td>
                <td className={styles.mono}>{a.src_w}×{a.src_h} → {a.dst_w}×{a.dst_h}</td>
                <td className={styles.dim}>{a.elapsed_sec != null ? `${Math.round(a.elapsed_sec)}s` : '—'}</td>
                <td className={a.status === 'ok' ? styles.ok : styles.err} title={a.error ?? undefined}>{a.status}</td>
                <td className={styles.dim}>{a.processed_at ? new Date(a.processed_at * 1000).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── watch list / exclusions ── */}
      <div className={styles.card}>
        <div className={styles.cardTitle}>Watch list</div>
        <div className={styles.cardSub}>Assets in any of these albums or tagged with any of these tags get queued for upscaling.</div>
        <SourceTable rows={d.watch ?? []} empty="No watch sources. Add one below." onChanged={() => void load()} />
        <SourcePicker albums={d.albums ?? []} tags={d.tags ?? []} role="watch" onAdded={() => void load()} />
      </div>
      <div className={styles.card}>
        <div className={styles.cardTitle}>Exclusions</div>
        <div className={styles.cardSub}>
          Assets carrying any of these tags or in these albums are never queued. The auto-managed tag{' '}
          <code className={styles.mono}>{d.settings?.auto_managed_tag}</code> is always excluded implicitly.
        </div>
        <SourceTable rows={d.exclude ?? []} empty="None." onChanged={() => void load()} />
        <SourcePicker albums={d.albums ?? []} tags={d.tags ?? []} role="exclude" onAdded={() => void load()} />
      </div>

      {/* ── GPUs ── */}
      <div className={styles.card}>
        <div className={styles.cardTitle}>GPUs</div>
        <div className={styles.cardSub}>Each toggled-on GPU runs ONE job at a time; total concurrency = enabled GPUs.</div>
        {Object.keys(d.gpus_by_container ?? {}).length === 0 && (
          <div className={styles.dim}>No GPUs cached — set the ProxLab URL below and Refresh.</div>
        )}
        {Object.entries<any[]>(d.gpus_by_container ?? {}).map(([container, gpus]) => (
          <div key={container}>
            <div className={styles.cardSub} style={{ marginTop: 6 }}>
              <b>{container}</b> <span className={styles.faint}>({gpus[0]?.agent_ip})</span>
            </div>
            <div className={styles.gpuGrid}>
              {gpus.map((g) => {
                const key = `${g.agent_name}:${g.cuda_index}`
                const on = gpuSel.has(key)
                return (
                  <label key={key} className={`${styles.gpuCard} ${on ? styles.on : ''}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setGpuSel((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })}
                    />
                    <span>[{g.cuda_index}] {g.friendly_name}<br /><span className={styles.faint}>{(g.vram_mb / 1024).toFixed(1)} GB</span></span>
                  </label>
                )
              })}
            </div>
          </div>
        ))}
        <div className={styles.addRow}>
          <button className={styles.btnPrimary} onClick={() => void act(() => upscalerApi.gpusSave([...gpuSel]), 'GPU selection saved')}>Save GPU selection</button>
          <button className={styles.btn} onClick={() => void act(upscalerApi.gpusRefresh, 'GPU refresh')}>Refresh from ProxLab</button>
        </div>
      </div>

      {/* ── settings ── */}
      <div className={styles.card}>
        <div className={styles.cardTitle}>Settings</div>
        <div className={styles.formGrid}>
          <label className={styles.fieldCol}>
            <span>Model</span>
            <select className={styles.select} value={settings.model ?? ''} onChange={(e) => setSettings({ ...settings, model: e.target.value })}>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          {SETTING_FIELDS.map((f) => (
            <label key={f.key} className={styles.fieldCol}>
              <span>{f.label}</span>
              <input
                className={`${styles.input} ${styles.mono}`}
                type={f.type ?? 'text'}
                step={f.type === 'number' ? 'any' : undefined}
                value={settings[f.key] ?? ''}
                onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <button className={styles.btnPrimary} onClick={() => void act(() => upscalerApi.saveSettings(settings), 'Settings saved')}>Save settings</button>
      </div>
    </div>
  )
}
