import React from 'react'
import { observer } from 'mobx-react-lite'
import { Check, ClipboardCopy, Eye, EyeOff, Trash2, X } from 'lucide-react'
import { clipboardStore, copyText, type ClipDrop } from '../../stores/ClipboardStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './Clipboard.module.scss'

function ago(ts: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

const Entry: React.FC<{ item: ClipDrop; fresh: boolean }> = observer(({ item, fresh }) => {
  const [copied, setCopied] = React.useState<'ok' | 'fail' | null>(null)
  const [revealed, setRevealed] = React.useState(false)
  const masked = item.sensitive && !revealed

  const doCopy = async () => {
    const ok = await copyText(item.text)
    setCopied(ok ? 'ok' : 'fail')
    setTimeout(() => setCopied(null), 1800)
  }

  return (
    <div className={`${styles.entry}${fresh ? ` ${styles.fresh}` : ''}`}>
      <div className={styles.entryHead}>
        <span className={styles.entryTitle}>{item.title || 'Untitled'}</span>
        <span className={styles.entryMeta}>
          {item.from ? `${item.from} · ` : ''}{ago(item.ts)}
        </span>
        <span className={styles.spacer} />
        {item.sensitive && (
          <button className={styles.iconBtn} onClick={() => setRevealed((r) => !r)} title={revealed ? 'Hide' : 'Reveal'}>
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
        <button className={styles.iconBtn} onClick={() => void clipboardStore.remove(item.id)} title="Delete">
          <Trash2 size={13} />
        </button>
      </div>
      <div className={styles.entryBody}>
        {/* Tapping the text selects all of it — a manual-copy fallback if the button can't
            reach the system clipboard (some phone browsers). */}
        <pre
          className={styles.text}
          onClick={(e) => {
            if (masked) return
            const sel = window.getSelection()
            const range = document.createRange()
            range.selectNodeContents(e.currentTarget)
            sel?.removeAllRanges()
            sel?.addRange(range)
          }}
        >
          {masked ? '•'.repeat(Math.min(24, Math.max(8, item.text.length))) : item.text}
        </pre>
        <button
          className={`${styles.copyBtn}${copied === 'ok' ? ` ${styles.copied}` : ''}${copied === 'fail' ? ` ${styles.copyFail}` : ''}`}
          onClick={() => void doCopy()}
          title="Copy to clipboard"
        >
          {copied === 'ok' ? <Check size={14} /> : <ClipboardCopy size={14} />}
          <span>{copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Select & copy' : 'Copy'}</span>
        </button>
      </div>
    </div>
  )
})

/**
 * Slide-down drawer for clipboard drops. Mounted once in App; opens itself when an agent posts.
 */
export const ClipboardDrawer: React.FC = observer(() => {
  React.useEffect(() => { void clipboardStore.ensureLoaded() }, [])

  React.useEffect(() => {
    if (!clipboardStore.open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clipboardStore.close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clipboardStore.open])

  const { items, open, freshId, error } = clipboardStore

  return (
    <>
      {open && <div className={styles.backdrop} onClick={() => clipboardStore.close()} />}
      <div className={`${styles.drawer}${open ? ` ${styles.open}` : ''}`} aria-hidden={!open}>
        <div className={styles.head}>
          <ClipboardCopy size={14} />
          <span className={styles.headTitle}>Clipboard</span>
          <span className={styles.headHint}>text agents posted for you to copy</span>
          <span className={styles.spacer} />
          {items.length > 0 && (
            <button
              className={styles.textBtn}
              onClick={async () => {
                if (await confirmStore.confirm({ title: 'Clear clipboard', message: `Delete all ${items.length} entries?`, confirmText: 'Clear' })) {
                  void clipboardStore.clear()
                }
              }}
            >
              Clear all
            </button>
          )}
          <button className={styles.iconBtn} onClick={() => clipboardStore.close()} title="Close (Esc)">
            <X size={15} />
          </button>
        </div>
        {error && <div className={styles.error}>{error}</div>}
        <div className={styles.list}>
          {items.length === 0 ? (
            <div className={styles.empty}>
              Nothing here yet. Agents post here with the <code>clipboard_post</code> tool.
            </div>
          ) : (
            items.map((i) => <Entry key={i.id} item={i} fresh={i.id === freshId} />)
          )}
        </div>
      </div>
    </>
  )
})
