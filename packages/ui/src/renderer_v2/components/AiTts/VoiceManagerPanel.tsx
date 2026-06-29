import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Play, Square, RefreshCw, Trash2, FolderOpen, Save, Undo2, RotateCcw, Download, Scissors, X, ArrowUp, Wand2 } from 'lucide-react'
import { voiceManagerStore as store, STEP_COLORS, fmtSize } from '../../stores/VoiceManagerStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './TtsTest.module.scss'
import vm from './VoiceManager.module.scss'

/** Draw min/max peak buckets. `layers` overlays multiple colored peak sets (back-to-front). */
function draw(canvas: HTMLCanvasElement | null, layers: { color: string; peaks: number[][] }[], duration: number, selStart: number, selEnd: number) {
  if (!canvas) return
  const ctx = canvas.getContext('2d'); if (!ctx) return
  const w = canvas.width, h = canvas.height, mid = h / 2
  ctx.clearRect(0, 0, w, h)
  for (const layer of layers) {
    const peaks = layer.peaks || []; if (!peaks.length) continue
    ctx.fillStyle = layer.color
    const bw = w / peaks.length
    for (let i = 0; i < peaks.length; i++) {
      const [mn, mx] = peaks[i]
      const yTop = mid - (mx || 0) * mid, yBot = mid - (mn || 0) * mid
      ctx.fillRect(i * bw, yTop, Math.max(1, bw - 0.3), Math.max(1, yBot - yTop))
    }
  }
  if (duration > 0 && selEnd > selStart) {
    const x0 = (selStart / duration) * w, x1 = (selEnd / duration) * w
    ctx.fillStyle = 'rgba(78,161,255,0.18)'; ctx.fillRect(x0, 0, x1 - x0, h)
    ctx.strokeStyle = '#4ea1ff'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, h); ctx.moveTo(x1, 0); ctx.lineTo(x1, h); ctx.stroke()
  }
}

/** Shared hidden audio element + playhead via rAF. */
function useAudio() {
  const ref = useRef<HTMLAudioElement | null>(null)
  if (!ref.current && typeof Audio !== 'undefined') ref.current = new Audio()
  return ref
}

export const VoiceManagerPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const origCanvas = useRef<HTMLCanvasElement>(null)
  const workCanvas = useRef<HTMLCanvasElement>(null)
  const audio = useAudio()
  const [playhead, setPlayhead] = useState(0)
  const [playingWhich, setPlayingWhich] = useState<'orig' | 'work' | ''>('')
  const [showSettings, setShowSettings] = useState(false)
  const vmFileRef = useRef<HTMLInputElement>(null)

  // redraw canvases when data/selection change
  useEffect(() => { draw(origCanvas.current, [{ color: STEP_COLORS.original, peaks: store.origPeaks }], store.origDuration, 0, 0) }, [store.origPeaks, store.origDuration, store.loaded])
  useEffect(() => {
    draw(workCanvas.current, store.layers.map((l) => ({ color: STEP_COLORS[l.type] || '#64748b', peaks: l.peaks })), store.duration, store.selStart, store.selEnd)
  }, [store.layers, store.duration, store.selStart, store.selEnd, store.loaded])

  const stopPlay = () => { const a = audio.current; if (a) { a.pause() } setPlayingWhich(''); setPlayhead(0) }
  const play = (which: 'orig' | 'work', start = 0, end?: number) => {
    const a = audio.current; if (!a || !store.wsId) return
    a.src = `/api/ai/workspace/${store.wsId}/audio${which === 'orig' ? '?source=original' : ''}`
    a.currentTime = start; setPlayingWhich(which)
    const tick = () => { if (a.paused) return; setPlayhead(a.currentTime); if (end != null && a.currentTime >= end) { a.pause(); setPlayingWhich('') } else requestAnimationFrame(tick) }
    a.onplay = () => requestAnimationFrame(tick)
    a.onended = () => { setPlayingWhich(''); setPlayhead(0) }
    void a.play()
  }

  const seekFrac = (e: React.MouseEvent<HTMLCanvasElement>, dur: number) => {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur
  }
  const onWorkClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const t = seekFrac(e, store.duration)
    if (e.shiftKey) { // adjust nearest selection edge
      const dS = Math.abs(t - store.selStart), dE = Math.abs(t - store.selEnd)
      if (dS < dE) store.set('selStart', Math.min(t, store.selEnd)); else store.set('selEnd', Math.max(t, store.selStart))
    } else { play('work', t, store.selEnd) }
  }

  const phPct = store.duration > 0 ? (playhead / store.duration) * 100 : 0
  const origPhPct = store.origDuration > 0 ? (playhead / store.origDuration) * 100 : 0

  // Gate until loaded so early clicks aren't clobbered by the initial load (see TtsTestPanel note).
  if (!store.loaded) return (
    <div className={styles.panel}><section className={styles.card}><div className={styles.muted}>Loading Voice Manager…</div></section></div>
  )

  return (
    <div className={styles.panel}>
      {/* Audio Tools service */}
      <section className={styles.card}>
        <div className={styles.head}><h4 className={styles.h4}>Audio Tools Service</h4>
          <span className={`${vm.dot} ${store.atStatus === 'online' ? vm.dotOn : store.atStatus === 'starting' ? vm.dotWarn : vm.dotOff}`} />
          <span className={styles.dim}>{store.atStatus}{store.atDetail ? ` · ${store.atDetail}` : ''}</span>
          <span className={styles.spacer} />
          {store.atStatus === 'online' && store.atServiceId
            ? <button className={styles.btnDanger} onClick={() => void store.atStop()}>Stop</button>
            : <button className={styles.btn} disabled={store.atStatus === 'starting'} onClick={() => void store.atStart()}>Start (px-gpu)</button>}
          <button className={styles.btn} onClick={() => void store.atCheckStatus()}><RefreshCw size={13} /></button>
        </div>
      </section>

      {/* Saved Voices */}
      <section className={styles.card}>
        <div className={styles.head}><h4 className={styles.h4}>Saved Voices <span className={styles.dim}>({store.voices.length})</span></h4><span className={styles.spacer} /><button className={styles.btn} onClick={() => void store.loadVoices()}><RefreshCw size={13} /> Refresh</button></div>
        <div className={vm.voiceList}>
          {store.voices.length === 0 && <div className={styles.muted}>No saved voices.</div>}
          {store.voices.map((v) => (
            <div key={v.name} className={vm.voiceRow}>
              <span className={vm.voiceName}>{v.name}</span>
              {v.duration ? <span className={`${vm.durBadge} ${v.duration >= 5 ? vm.durOk : vm.durWarn}`}>{v.duration.toFixed(1)}s{v.duration < 5 ? ' ⚠' : ''}</span> : null}
              <span className={styles.spacer} />
              {v.name !== 'default' && <button className={styles.btnDanger} title="Delete" onClick={async () => { if (await confirmStore.confirm({ title: 'Delete voice', message: `Delete voice “${v.name}”?`, confirmText: 'Delete' })) void store.deleteVoice(v.name) }}><Trash2 size={12} /></button>}
            </div>
          ))}
        </div>
      </section>

      {/* Add New Voice */}
      <section className={styles.card}>
        <h4 className={styles.h4}>Add New Voice</h4>
        <p className={styles.muted}>
          Chatterbox-Turbo clones voices from audio alone — no transcript needed. Clips must be <b>longer than 5 seconds</b>;
          10–15s is ideal, and audio beyond 15s is truncated. Upload or pick a clip below, then use the workspace tools to
          isolate / denoise / upscale / trim before saving.
        </p>
        <div className={styles.actions}>
          <input ref={vmFileRef} type="file" accept="audio/*,video/*" className={styles.fileInput} onChange={(e) => { const f = e.target.files?.[0]; if (f) void store.createFromFile(f) }} />
          <button className={styles.btn} onClick={() => store.openBrowser('workspace')}><FolderOpen size={13} /> Browse Server</button>
          <span className={styles.dim}>{store.status}</span>
        </div>
      </section>

      {/* Workspace editor */}
      {store.hasWorkspace && (
        <section className={styles.card}>
          <div className={styles.head}><h4 className={styles.h4}>Audio Workspace</h4><span className={styles.dim}>{store.filename} · {store.duration.toFixed(1)}s · {store.sampleRate}Hz</span></div>

          {/* original */}
          <div className={vm.wfLabel}>Original</div>
          <div className={vm.wfWrap}>
            <canvas ref={origCanvas} width={1000} height={80} className={vm.canvas} />
            {playingWhich === 'orig' && <div className={vm.playhead} style={{ left: `${origPhPct}%` }} />}
          </div>
          <div className={styles.actions}>
            {playingWhich === 'orig' ? <button className={styles.btn} onClick={stopPlay}><Square size={12} /> Stop</button> : <button className={styles.btn} onClick={() => play('orig', 0)}><Play size={12} /> Play original</button>}
          </div>

          {/* tools */}
          <div className={styles.actions}>
            <button className={styles.btn} disabled={store.busy} onClick={() => void store.process('isolate')}><Wand2 size={12} /> Isolate vocals</button>
            <button className={styles.btn} disabled={store.busy} onClick={() => void store.process('denoise')}>Denoise</button>
            <button className={styles.btn} disabled={store.busy} onClick={() => void store.process('upscale')}>Upscale</button>
            <button className={styles.btn} disabled={store.busy} onClick={() => void store.process('pipeline')}>Full Pipeline</button>
            <button className={styles.btn} onClick={() => setShowSettings(!showSettings)}>Settings</button>
          </div>
          {showSettings && <div className={styles.grid2}>
            <label className={styles.field}><span>Demucs shifts (1–5)</span><input type="number" min={1} max={5} value={store.shifts} onChange={(e) => store.set('shifts', Number(e.target.value))} /></label>
            <label className={styles.field}><span>FLowHigh timestep (1–4)</span><input type="number" min={1} max={4} value={store.timestep} onChange={(e) => store.set('timestep', Number(e.target.value))} /></label>
          </div>}
          {store.busy && store.progressText && <div className={vm.progress}><div className={vm.progressFill} style={{ width: `${store.progress}%` }} /><span>{store.progressText}</span></div>}

          {/* step chips + rollback */}
          {store.steps.length > 0 && <div className={vm.chips}>
            {store.steps.map((s: any, i: number) => (
              <span key={i} className={vm.chip} style={{ background: `${STEP_COLORS[s.type] || '#64748b'}33`, color: STEP_COLORS[s.type] || '#94a3b8' }}>
                {s.type}
                <button className={vm.chipX} title="Roll back to before this step" onClick={async () => { if (await confirmStore.confirm({ title: 'Roll back', message: `Roll back "${s.type}" and all steps after it?`, confirmText: 'Roll back' })) void store.rollback(i) }}>×</button>
              </span>
            ))}
          </div>}

          {/* working waveform */}
          <div className={vm.wfLabel}>Working (click to seek · shift-click to set selection edge)</div>
          <div className={vm.wfWrap}>
            <canvas ref={workCanvas} width={1000} height={100} className={`${vm.canvas} ${vm.clickable}`} onClick={onWorkClick} />
            {playingWhich === 'work' && <div className={vm.playhead} style={{ left: `${phPct}%` }} />}
          </div>
          <div className={styles.actions}>
            {playingWhich === 'work' ? <button className={styles.btn} onClick={stopPlay}><Square size={12} /> Stop</button> : <button className={styles.btn} onClick={() => play('work', store.selStart, store.selEnd)}><Play size={12} /> Play selection</button>}
            <button className={styles.btn} disabled={!store.historyCount} onClick={() => void store.undo()}><Undo2 size={12} /> Undo</button>
            <button className={styles.btn} disabled={!store.historyCount} onClick={() => void store.reset()}><RotateCcw size={12} /> Reset</button>
            <button className={styles.btn} onClick={() => store.download()}><Download size={12} /> Download</button>
          </div>

          {/* trim row */}
          <div className={styles.grid2}>
            <label className={styles.field}><span>Selection start (s)</span><input type="number" step={0.1} value={store.selStart.toFixed(2)} onChange={(e) => store.set('selStart', Math.max(0, Number(e.target.value)))} /></label>
            <label className={styles.field}><span>Selection end (s)</span><input type="number" step={0.1} value={store.selEnd.toFixed(2)} onChange={(e) => store.set('selEnd', Math.min(store.duration, Number(e.target.value)))} /></label>
            <div className={styles.field}><span>Duration</span><b className={store.selDuration < 5 ? styles.down : store.selDuration < 10 ? styles.unknown : styles.up}>{store.selDuration.toFixed(2)}s {store.selDuration < 5 ? '(min 5s!)' : store.selDuration < 10 ? '(10–15s ideal)' : ''}</b></div>
          </div>
          <div className={styles.actions}>
            <button className={styles.btn} onClick={() => void store.trim()}><Scissors size={12} /> Apply Trim</button>
          </div>

          {/* save voice */}
          <div className={styles.presetBar}>
            <input placeholder="voice name (letters, numbers, _ -)" value={store.saveName} onChange={(e) => store.set('saveName', e.target.value)} style={{ flex: 1, padding: '6px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--control-bg)', color: 'var(--fg)' }} />
            <button className={styles.btnPrimary} disabled={store.busy || store.selDuration < 5} onClick={() => void store.saveVoice()}><Save size={13} /> Save as Voice</button>
          </div>
        </section>
      )}

      {/* Audio Ripper */}
      <section className={styles.card}>
        <div className={styles.head}><h4 className={styles.h4}>Audio Ripper</h4><span className={styles.dim}>Extract audio from video/audio → saved on server</span></div>
        <div className={styles.actions}>
          <label className={styles.btn}><input type="file" accept="video/*,audio/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) { store.set('arFile', f); store.set('arServerPath', ''); store.set('arSavePath', '/claude/ripped-audio/' + f.name.replace(/\.[^.]+$/, '') + '.wav') } }} /> From My PC</label>
          <button className={styles.btn} onClick={() => store.openBrowser('ripper')}><FolderOpen size={13} /> From Server</button>
          <span className={styles.dim}>{store.arFile ? store.arFile.name : store.arServerPath || 'no file'}</span>
        </div>
        {(store.arFile || store.arServerPath) && <>
          <label className={styles.field}><span>Save to (server path)</span><input value={store.arSavePath} onChange={(e) => store.set('arSavePath', e.target.value)} /></label>
          <div className={styles.actions}>
            <button className={styles.btnPrimary} disabled={store.arBusy} onClick={() => void store.ripExtract()}>Extract Audio</button>
            <span className={styles.dim}>{store.arStatus}</span>
          </div>
          {store.arBusy && <div className={vm.progress}><div className={vm.progressFill} style={{ width: `${store.arProgress}%` }} /><span>{store.arProgress}%</span></div>}
        </>}
      </section>

      {/* shared file browser modal */}
      {store.fbOpen && (
        <div className={vm.fbOverlay} onClick={() => store.closeBrowser()}>
          <div className={vm.fbModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.head}><h4 className={styles.h4}>Browse Server — {store.fbTarget === 'ripper' ? 'pick a video/audio file' : 'pick an audio file'}</h4><span className={styles.spacer} /><button className={styles.btn} onClick={() => store.closeBrowser()}><X size={14} /></button></div>
            <div className={vm.fbCrumb}>{store.fbDir}</div>
            <div className={vm.fbList}>
              {store.fbDir !== '/' && <button className={vm.fbItem} onClick={() => store.fbNavigate(store.fbDir.replace(/\/[^/]+\/?$/, '') || '/')}><ArrowUp size={12} /> ..</button>}
              {store.fbDirs.map((d) => <button key={d.path} className={vm.fbItem} onClick={() => store.fbNavigate(d.path)}><FolderOpen size={12} /> {d.name}/</button>)}
              {store.fbFiles.map((f) => <button key={f.path} className={vm.fbFile} onClick={() => store.fbSelect(f)}>{f.isVideo ? '🎬' : '🎵'} {f.name} <span className={styles.dim}>{fmtSize(f.size)}</span></button>)}
            </div>
            <div className={styles.dim}>{store.fbStatus}</div>
          </div>
        </div>
      )}

      {/* activity log lives on the TTS Test panel; not duplicated here */}
    </div>
  )
})
