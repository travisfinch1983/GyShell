/**
 * HermesTtsSection — per-agent HERMES-NATIVE TTS (Telegram and other gateway
 * channels). Fully independent of the "Voice (TTS)" block above it, which
 * configures the AI-Lab CHAT playback: changing one never touches the other.
 *
 * Backed by the profile's config.yaml (`tts:` + `voice.auto_tts`) via
 *   GET/PUT /api/hermes/agents/:id/hermes-tts
 * — deliberately OUTSIDE the agent spec so the applySpec auxiliary reset can
 * never clear it. Voice names are validated server-side against the live
 * endpoint's voice list; unknown voices are REJECTED, never silently accepted.
 * Wipe-guard: the editor only renders once a GET has succeeded.
 */
import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { hermesApi } from '../../stores/hermesApi'
import styles from './Agents.module.scss'

type State = {
  provider: string; voice: string; model: string; baseUrl: string; speed: number
  autoTts: boolean; voices: string[]; voicesError?: string
}

export const HermesTtsSection: React.FC<{ agentId: string }> = observer(({ agentId }) => {
  const [cfg, setCfg] = useState<State | null>(null)
  const [baseline, setBaseline] = useState<State | null>(null)
  const [err, setErr] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [testBusy, setTestBusy] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const [allBusy, setAllBusy] = useState(false)
  const [allMsg, setAllMsg] = useState('')

  useEffect(() => {
    setCfg(null); setBaseline(null); setErr(''); setStatus('')
    void hermesApi.getHermesTts(agentId).then((r) => {
      if (!r) { setErr('Failed to read Hermes TTS config — backend unreachable?'); return }
      setCfg(r); setBaseline(r)
    })
  }, [agentId])

  if (err) return <div className={styles.formMsg} style={{ color: 'var(--danger, #f87171)' }}>{err}</div>
  if (!cfg || !baseline) return <div className={styles.dim}>Loading Hermes TTS config…</div>

  const dirty = cfg.voice !== baseline.voice || cfg.autoTts !== baseline.autoTts
    || cfg.model !== baseline.model || cfg.baseUrl !== baseline.baseUrl || cfg.speed !== baseline.speed

  const testVoice = async () => {
    setTestBusy(true); setTestMsg('Synthesizing through the Hermes pipeline…'); setErr('')
    if (dirty) { setTestMsg('Save first — the test speaks the SAVED config, not unsaved edits.'); setTestBusy(false); return }
    const r = await hermesApi.testHermesTts(agentId)
    setTestBusy(false)
    if (!r.ok || !r.audioB64) { setTestMsg(''); setErr(`Voice test failed: ${r.error ?? 'no audio returned'}`); return }
    try {
      const audio = new Audio(`data:${r.mime ?? 'audio/ogg'};base64,${r.audioB64}`)
      void audio.play()
      setTestMsg('Playing — this is exactly what Telegram will sound like.')
    } catch {
      setTestMsg('Audio returned but playback failed — browser blocked autoplay? Click again.')
    }
  }

  const setAll = async (on: boolean) => {
    setAllBusy(true); setAllMsg(`${on ? 'Enabling' : 'Disabling'} Hermes TTS for ALL agents…`)
    const r = await hermesApi.setHermesTtsAll(on)
    setAllBusy(false)
    if (!r.ok) { setAllMsg(`Failed: ${r.error ?? 'unknown'}`); return }
    const fails = r.failed?.length ? ` · FAILED: ${r.failed.map((f) => f.agent).join(', ')}` : ''
    setAllMsg(`${on ? 'Enabled' : 'Disabled'} for ${r.updated?.length ?? 0} agents · gateways restarted: ${r.gatewaysRestarted?.join(', ') || 'none running'}${fails}`)
    // refresh this agent's view — the master switch just changed its autoTts too
    const fresh = await hermesApi.getHermesTts(agentId)
    if (fresh) { setCfg(fresh); setBaseline(fresh) }
  }

  const save = async () => {
    setBusy(true); setErr(''); setStatus('')
    // change-only: send just what moved
    const patch: Record<string, unknown> = {}
    if (cfg.voice !== baseline.voice) patch.voice = cfg.voice
    if (cfg.autoTts !== baseline.autoTts) patch.autoTts = cfg.autoTts
    if (cfg.model !== baseline.model) patch.model = cfg.model
    if (cfg.baseUrl !== baseline.baseUrl) patch.baseUrl = cfg.baseUrl
    if (cfg.speed !== baseline.speed) patch.speed = cfg.speed
    const r = await hermesApi.putHermesTts(agentId, patch)
    setBusy(false)
    if (!r.ok) { setErr(`Save failed: ${r.error ?? 'unknown'}`); return }
    setBaseline({ ...cfg })
    setStatus(r.gatewayRestarted
      ? 'Saved ✓ — messaging gateway restarted; Telegram uses the new voice now.'
      : 'Saved ✓ — applies when the messaging gateway next starts.')
  }

  return (
    <>
      <div className={styles.sectionTitle} style={{ marginTop: 14 }}>Hermes TTS — native channels (Telegram, etc.)</div>
      <div className={styles.dim} style={{ marginBottom: 6 }}>
        Voice for conversations that go THROUGH Hermes (Telegram and other gateway platforms).
        Independent of the AI-Lab chat voice above — changing one never affects the other.
      </div>
      <div className={styles.formRow}>
        <label className={styles.label}>
          <input type="checkbox" checked={cfg.autoTts} disabled={busy}
            onChange={(e) => setCfg({ ...cfg, autoTts: e.target.checked })} />
          {' '}<b>Hermes TTS enabled</b> — speak replies on Telegram & other gateway channels
        </label>
      </div>
      <div className={styles.formRow}>
        <span className={styles.label}>Voice</span>
        {cfg.voices.length > 0 ? (
          <select className={`${styles.input} ${styles.mono}`} value={cfg.voice} disabled={busy}
            onChange={(e) => setCfg({ ...cfg, voice: e.target.value })}>
            {!cfg.voices.includes(cfg.voice) && cfg.voice && (
              <option value={cfg.voice}>{cfg.voice} (NOT on the endpoint — pick a valid voice)</option>
            )}
            {!cfg.voice && <option value="">— pick a voice —</option>}
            {cfg.voices.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        ) : (
          <div className={styles.formMsg} style={{ color: 'var(--warning, #fbbf24)' }}>
            Voice list unavailable{cfg.voicesError ? ` — ${cfg.voicesError}` : ''}. Set the endpoint below.
          </div>
        )}
      </div>
      <button className={styles.btn} onClick={() => setShowAdvanced((v) => !v)}>{showAdvanced ? 'Hide' : 'Show'} advanced</button>
      {showAdvanced && (
        <>
          <div className={styles.formRow}>
            <span className={styles.label}>Endpoint (OpenAI-compatible)</span>
            <input className={`${styles.input} ${styles.mono}`} value={cfg.baseUrl} disabled={busy}
              placeholder="http://10.0.0.219:17890/api/proxy/tts/v1" onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })} />
          </div>
          <div className={styles.formRow}>
            <span className={styles.label}>Model</span>
            <input className={`${styles.input} ${styles.mono}`} value={cfg.model} disabled={busy}
              onChange={(e) => setCfg({ ...cfg, model: e.target.value })} />
          </div>
          <div className={styles.formRow}>
            <span className={styles.label}>Speed</span>
            <input className={`${styles.input} ${styles.mono}`} type="number" step="0.1" min="0.5" max="2" value={cfg.speed} disabled={busy}
              onChange={(e) => setCfg({ ...cfg, speed: Number(e.target.value) || 1.0 })} />
          </div>
        </>
      )}
      <div className={styles.formRow}>
        <button className={styles.btnPrimary} disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save Hermes TTS'}
        </button>
        <button className={styles.btn} disabled={busy || testBusy} onClick={() => void testVoice()}
          title="Synthesizes a sample through the agent's SAVED Hermes TTS config — the same code path the Telegram gateway uses">
          {testBusy ? 'Testing…' : 'Test voice'}
        </button>
      </div>
      {status && <div className={styles.formMsg} style={{ color: 'var(--accent)' }}>{status}</div>}
      {testMsg && <div className={styles.formMsg} style={{ color: 'var(--accent)' }}>{testMsg}</div>}
      <div className={styles.dim} style={{ marginTop: 10 }}>All agents at once (voices stay per-agent):</div>
      <div className={styles.formRow}>
        <button className={styles.btn} disabled={allBusy} onClick={() => void setAll(true)}>Enable Hermes TTS for ALL agents</button>
        <button className={styles.btn} disabled={allBusy} onClick={() => void setAll(false)}>Disable for ALL agents</button>
      </div>
      {allMsg && <div className={styles.formMsg} style={{ color: 'var(--accent)' }}>{allMsg}</div>}
      {err && <div className={styles.formMsg} style={{ color: 'var(--danger, #f87171)' }}>{err}</div>}
    </>
  )
})
