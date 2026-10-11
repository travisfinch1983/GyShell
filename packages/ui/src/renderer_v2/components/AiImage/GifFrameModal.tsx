import React, { useEffect, useRef, useState } from 'react'
import { trainingImagesStore as store, igImage, igGifFrame, igDownload } from '../../stores/TrainingImagesStore'
import styles from './TrainingImages.module.scss'

// ── GIF frame viewer + extractor ─────────────────────────────────────────────────────
// The crop editor only ever sees a GIF's first frame, so a GIF opens here instead. Paused, the
// stage shows ONE server-rendered frame (libvips composites it against the frames before it, so a
// partial-update frame is the full picture); playing, it shows the GIF itself. Extracted frames
// are full-size PNGs in screenshots/ beside the GIF -- the same place the video frame grabber
// writes -- where they crop like any other image.
export const GifFrameModal: React.FC<{ rel: string; name: string; onClose: () => void; onCrop?: () => void }> = ({ rel, name, onClose, onCrop }) => {
  const [info, setInfo] = useState<{ frames: number; w: number; h: number; delays: number[] } | null>(null)
  const [err, setErr] = useState('')
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [extracted, setExtracted] = useState(0)
  const stripRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    store.gifInfo(rel).then(setInfo).catch((e) => setErr(String(e?.message || e)))
  }, [rel])

  const n = info?.frames ?? 0
  const go = (k: number) => { if (!n) return; setPlaying(false); setI(((k % n) + n) % n) }

  // keep the current frame's thumbnail in view while stepping
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-f="${i}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [i])

  const pick = (k: number, shift: boolean) => {
    // read the anchor NOW: the updater runs later, after anchor.current has already moved to k
    const from = anchor.current
    setPicked((prev) => {
      const next = new Set(prev)
      if (shift && from != null) {
        const [a, b] = from < k ? [from, k] : [k, from]
        for (let x = a; x <= b; x++) next.add(x)
      } else if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
    anchor.current = k
  }

  const extract = async (frames: number[]) => {
    if (!frames.length) return
    setBusy(true)
    try {
      const r = await store.gifExtract(rel, frames)
      setExtracted((c) => c + r.saved.length)
      setMsg(`Saved ${r.saved.length} frame${r.saved.length === 1 ? '' : 's'} → ${r.dir}/` +
        (r.saved.length === 1 ? `  (${r.saved[0]})` : '') + (r.errors.length ? `  · ${r.errors.length} failed: ${r.errors[0]}` : ''))
      // screenshots/ is new the first time; refresh so it shows up in the browser
      void store.browse(store.cwd)
    } catch (e: any) { setMsg('Failed: ' + (e?.message || e)) }
    finally { setBusy(false) }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (!n) return
    if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - (e.shiftKey ? 10 : 1)) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(i + (e.shiftKey ? 10 : 1)) }
    else if (e.key.toLowerCase() === 's') { e.preventDefault(); void extract([i]) }
    else if (e.key.toLowerCase() === 'x') { e.preventDefault(); pick(i, e.shiftKey) }
  }

  const ms = info ? info.delays.slice(0, i).reduce((a, b) => a + b, 0) : 0
  const total = info ? info.delays.reduce((a, b) => a + b, 0) : 0

  return (
    <div className={styles.modalBg} onClick={onClose} onKeyDown={onKey} tabIndex={-1} ref={(el) => el?.focus()}>
      <div className={styles.pkBox} style={{ width: 'min(1200px,96%)', maxHeight: '94vh' }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</strong>
          <span style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {onCrop && <button className={styles.btn} onClick={onCrop} title="Open frame 1 in the crop editor (tags, rating, crops)">Crop editor</button>}
            <a className={styles.btn} href={igDownload(rel)} download={name} style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
               title="Download the original GIF">⬇ Download</a>
            <button className={styles.btn} onClick={onClose}>Close</button>
          </span>
        </div>

        {err && <div className={styles.acHint}>Could not read this GIF: {err}</div>}
        {info && (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', background: '#000', borderRadius: 6, minHeight: 200 }}>
              <img alt="" draggable={false}
                src={playing ? igImage(rel) : igGifFrame(rel, i)}
                style={{ maxWidth: '100%', maxHeight: '58vh', objectFit: 'contain', imageRendering: info.w < 400 ? 'pixelated' : undefined }} />
            </div>

            <div className={styles.acl} style={{ justifyContent: 'flex-start', gap: 10 }}>
              <button className={styles.btn} disabled={n < 2} onClick={() => setPlaying((p) => !p)}>{playing ? '❚❚ Pause' : '▶ Play'}</button>
              <button className={styles.btn} disabled={n < 2} onClick={() => go(i - 1)} title="Previous frame (←)">‹</button>
              <input type="range" min={0} max={Math.max(0, n - 1)} value={i} disabled={n < 2}
                onChange={(e) => go(Number(e.target.value))} style={{ flex: 1 }} />
              <button className={styles.btn} disabled={n < 2} onClick={() => go(i + 1)} title="Next frame (→)">›</button>
              <span className={styles.dim} style={{ minWidth: 150, textAlign: 'right' }}>
                {playing ? `playing · ${n} frames` : `frame ${i + 1} / ${n}`} · {(ms / 1000).toFixed(2)}s / {(total / 1000).toFixed(2)}s
              </span>
            </div>

            {n > 1 && (
              <div ref={stripRef} style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 6 }}>
                {Array.from({ length: n }, (_, k) => {
                  const sel = picked.has(k)
                  return (
                    <div key={k} data-f={k} onClick={(e) => { if (e.shiftKey) pick(k, true); else go(k) }}
                      title={`Frame ${k + 1} · ${info.delays[k]} ms — click to view, tick (or shift-click) to select`}
                      style={{ position: 'relative', flex: '0 0 auto', width: 96, height: 96, borderRadius: 5, cursor: 'pointer', overflow: 'hidden', background: '#111',
                               border: `2px solid ${k === i && !playing ? 'var(--accent)' : sel ? 'color-mix(in srgb, var(--accent) 60%, transparent)' : 'var(--border)'}` }}>
                      <img loading="lazy" src={igGifFrame(rel, k, 160)} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      <span onClick={(e) => { e.stopPropagation(); pick(k, e.shiftKey) }} onMouseDown={(e) => { if (e.shiftKey) e.preventDefault() }}
                        style={{ position: 'absolute', top: 4, left: 4, width: 16, height: 16, borderRadius: '50%', border: '2px solid #fff',
                                 background: sel ? 'var(--accent)' : 'rgba(0,0,0,0.4)' }} />
                      <span style={{ position: 'absolute', right: 3, bottom: 2, fontSize: 10, color: '#fff', textShadow: '0 0 3px #000' }}>{k + 1}</span>
                    </div>
                  )
                })}
              </div>
            )}

            <div className={styles.acl} style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
              <button className={styles.btnPrimary} disabled={busy || playing} onClick={() => void extract([i])}
                title={playing ? 'Pause first to choose a frame' : 'Save this frame as a full-size PNG (S)'}>📸 Extract frame {playing ? '' : i + 1}</button>
              {n > 1 && (
                <>
                  <button className={styles.btnPrimary} disabled={busy || !picked.size} onClick={() => void extract([...picked].sort((a, b) => a - b))}>
                    Extract {picked.size || ''} selected
                  </button>
                  <button className={styles.btn} onClick={() => setPicked(new Set(Array.from({ length: n }, (_, k) => k)))}>Select all</button>
                  <button className={styles.btn} disabled={!picked.size} onClick={() => setPicked(new Set())}>Clear</button>
                </>
              )}
              <span className={styles.spacer} />
              <span className={styles.dim}>{info.w}×{info.h}{extracted ? ` · ${extracted} extracted` : ''}</span>
            </div>
            <div className={styles.acHint}>
              <strong>←/→</strong> step (hold <strong>Shift</strong> for 10) · <strong>Space</strong> play/pause · <strong>S</strong> extract this frame ·
              {' '}<strong>X</strong> tick this frame · tick a frame then shift-tick another to select the range. Frames are saved to <code>screenshots/</code> beside the GIF.
            </div>
          </>
        )}
        {!info && !err && <div className={styles.dim}>Reading frames…</div>}
        {msg && <div className={styles.acHint}>{msg}</div>}
      </div>
    </div>
  )
}
