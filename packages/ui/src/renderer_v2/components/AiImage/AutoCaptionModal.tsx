import React, { useEffect, useRef, useState } from 'react'
import { trainingImagesStore as store } from '../../stores/TrainingImagesStore'
import styles from './TrainingImages.module.scss'

export const AutoCaptionModal: React.FC<{ onClose: () => void; onDone: () => void }> = ({ onClose, onDone }) => {
  const [taggers, setTaggers] = useState<any[]>([])
  const [model, setModel] = useState('')
  const [device, setDevice] = useState('cpu')
  const [thr, setThr] = useState('0.35'); const [cthr, setCthr] = useState('0.85')
  const [spaces, setSpaces] = useState(false); const [trigger, setTrigger] = useState(''); const [overwrite, setOverwrite] = useState(false)
  const [status, setStatus] = useState(''); const [running, setRunning] = useState(false)
  const poll = useRef<any>(null)
  useEffect(() => {
    store.taggers().then((d) => { setTaggers(d.taggers || []); if (d.taggers?.[0]) setModel(d.taggers[0].id) }).catch(() => setStatus('No taggers available.'))
    return () => { if (poll.current) clearInterval(poll.current) }
  }, [])
  const cur = taggers.find((t) => t.id === model)
  const isBlip = cur?.engine === 'blip'
  useEffect(() => { if (isBlip) setDevice('cuda') }, [isBlip])

  const run = async () => {
    if (!cur) return
    const body = { path: store.cwd, engine: cur.engine, model, device, threshold: parseFloat(thr) || 0.35, char_threshold: parseFloat(cthr) || 0.85, spaces, trigger: trigger.trim(), overwrite }
    setRunning(true); setStatus('Starting…')
    try {
      const { jobId } = await store.autoCaption(body)
      poll.current = setInterval(async () => {
        let s: any; try { s = await store.autoCaptionStatus(jobId) } catch { return }
        if (s.state === 'running') { setStatus(`Captioning ${s.done}/${s.total || '…'}${s.provider ? ' (' + s.provider + ')' : ''}…`); return }
        clearInterval(poll.current); poll.current = null; setRunning(false)
        if (s.state === 'done') { setStatus(`Done — wrote ${s.wrote}, skipped ${s.skipped}, errors ${s.errors}.${s.lastError ? ' Last: ' + s.lastError : ''}`); onDone() }
        else setStatus(`Failed: ${s.error || s.lastError || 'unknown'}`)
      }, 2000)
    } catch (e: any) { setRunning(false); setStatus('Failed: ' + (e?.message || e)) }
  }

  return (
    <div className={styles.modalBg} onClick={onClose}>
      <div className={styles.pkBox} style={{ width: 'min(480px,92%)' }} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}><strong>Auto-caption — {store.cwd.split('/').pop()}</strong><button className={styles.btn} onClick={onClose}>Close</button></div>
        <label className={styles.acl}>Model
          <select className={styles.input} value={model} onChange={(e) => setModel(e.target.value)}>
            {taggers.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <label className={styles.acl}>Device
          <select className={styles.input} value={device} onChange={(e) => setDevice(e.target.value)} disabled={isBlip}>
            <option value="cpu">CPU</option><option value="cuda">GPU (4090)</option>
          </select>
        </label>
        {!isBlip && (
          <>
            <label className={styles.acl}>General threshold <input className={styles.input} type="number" step="0.05" min="0" max="1" value={thr} onChange={(e) => setThr(e.target.value)} /></label>
            <label className={styles.acl}>Character threshold <input className={styles.input} type="number" step="0.05" min="0" max="1" value={cthr} onChange={(e) => setCthr(e.target.value)} /></label>
            <label className={styles.aclChk}><input type="checkbox" checked={spaces} onChange={(e) => setSpaces(e.target.checked)} /> underscores → spaces</label>
          </>
        )}
        <label className={styles.acl}>Trigger word(s) <input className={styles.input} placeholder="optional, prepended" value={trigger} onChange={(e) => setTrigger(e.target.value)} /></label>
        <label className={styles.aclChk}><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> overwrite existing captions</label>
        <div className={styles.msg}>{status}</div>
        <div className={styles.pkFoot}><span className={styles.spacer} /><button className={styles.btnPrimary} disabled={running || !model} onClick={() => void run()}>Run</button></div>
      </div>
    </div>
  )
}
