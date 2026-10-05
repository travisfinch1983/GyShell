import React, { useEffect, useMemo, useState } from 'react'
import { ImagePlus, Send, X } from 'lucide-react'
import styles from './Claude.module.scss'

function bridge(): any { return (window as any).gyshell?.cluster }

const readB64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] || '')
  r.onerror = () => reject(r.error || new Error(`could not read ${f.name}`))
  r.readAsDataURL(f)
})

/**
 * Send images to a Claude Code instance as a message. The backend stores them in a private folder
 * on the instance container (POST /api/claude/send-images/:id); `onSent` then pastes the paths
 * into the instance's prompt, where Claude Code attaches image paths as images.
 * Not click-to-close: a stray backdrop click would throw away the picked images and typed text.
 */
export const SendImagesDialog: React.FC<{
  instanceId: string
  initial: File[]
  onSent: (paths: string[], message: string) => void
  onClose: () => void
}> = ({ instanceId, initial, onSent, onClose }) => {
  const [files, setFiles] = useState<File[]>(initial)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files])
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls])

  const addMore = (list: FileList | null) => {
    if (!list) return
    setFiles((cur) => [...cur, ...Array.from(list).filter((f) => f.type.startsWith('image/'))].slice(0, 20))
  }

  const send = async () => {
    if (!files.length) return
    setBusy(true); setErr('')
    try {
      const payload = await Promise.all(files.map(async (f) => ({ name: f.name || 'pasted.png', dataB64: await readB64(f) })))
      const r = await bridge().request('POST', `/api/claude/send-images/${encodeURIComponent(instanceId)}`, { files: payload })
      if (!r?.paths?.length) throw new Error(r?.error || 'upload failed')
      if (r.errors?.length) console.warn('[send-images] skipped:', r.errors)
      onSent(r.paths, message.trim())
    } catch (e: any) {
      setErr(String(e?.message || e))
      setBusy(false)
    }
  }

  return (
    <div className={styles.sendImgBg}>
      <div className={styles.sendImgBox} onClick={(e) => e.stopPropagation()}>
        <div className={styles.sendImgHead}>
          <strong>Send images to {instanceId}</strong>
          <span style={{ flex: 1 }} />
          <button className={styles.btn} onClick={onClose} disabled={busy}><X size={13} /> Cancel</button>
        </div>
        <div className={styles.sendImgGrid}>
          {files.map((f, i) => (
            <div key={i} className={styles.sendImgThumb} title={f.name}>
              <img src={urls[i]} alt={f.name} />
              <button className={styles.sendImgRemove} disabled={busy} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} title="Remove"><X size={12} /></button>
            </div>
          ))}
          <label className={styles.sendImgAdd} title="Add more images">
            <ImagePlus size={20} />
            <input type="file" accept="image/*" multiple hidden disabled={busy} onChange={(e) => { addMore(e.target.files); e.target.value = '' }} />
          </label>
        </div>
        <textarea
          className={styles.sendImgText}
          placeholder="Message to go with the images (optional)"
          value={message}
          disabled={busy}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send() }}
          rows={3}
        />
        {err && <div className={styles.sendImgErr}>Failed: {err}</div>}
        <div className={styles.sendImgFoot}>
          <span className={styles.dim}>{files.length} image{files.length === 1 ? '' : 's'} · Ctrl+Enter sends</span>
          <span style={{ flex: 1 }} />
          <button className={styles.btnPrimary} onClick={() => void send()} disabled={busy || !files.length}>
            <Send size={13} /> {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
