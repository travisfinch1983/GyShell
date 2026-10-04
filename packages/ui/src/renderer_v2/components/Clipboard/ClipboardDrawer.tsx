import React from 'react'
import { observer } from 'mobx-react-lite'
import { ArrowLeft, Check, ClipboardCopy, Eye, EyeOff, History, RotateCcw, Trash2, X } from 'lucide-react'
import { clipboardStore, copyText, type ClipDrop, type ClipHistoryEntry } from '../../stores/ClipboardStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './Clipboard.module.scss'

function ago(ts: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

/** One entry. In history mode it gets Restore (when no longer in the drawer) and deletes from history. */
const Entry: React.FC<{ item: ClipDrop | ClipHistoryEntry; fresh?: boolean; history?: boolean }> = observer(({ item, fresh, history }) => {
  const [copied, setCopied] = React.useState<'ok' | 'fail' | null>(null)
  const [revealed, setRevealed] = React.useState(false)
  const masked = item.sensitive && !revealed
  const inClipboard = history ? (item as ClipHistoryEntry).inClipboard : true

  const doCopy = async () => {
    const ok = await copyText(item.text)
    setCopied(ok ? 'ok' : 'fail')
    setTimeout(() => setCopied(null), 1800)
  }

  return (
    <div className={`${styles.entry}${fresh ? ` ${styles.fresh}` : ''}${history && !inClipboard ? ` ${styles.dismissed}` : ''}`}>
      <div className={styles.entryHead}>
        <span className={styles.entryTitle}>{item.title || 'Untitled'}</span>
        <span className={styles.entryMeta}>
          {item.from ? `${item.from} · ` : ''}{ago(item.ts)}
          {history && (inClipboard ? ' · in clipboard' : ' · cleared')}
        </span>
        <span className={styles.spacer} />
        {item.sensitive && (
          <button className={styles.iconBtn} onClick={() => setRevealed((r) => !r)} title={revealed ? 'Hide' : 'Reveal'}>
            {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
        {history && !inClipboard && (
          <button className={styles.iconBtn} onClick={() => void clipboardStore.restore(item.id)} title="Put it back in the clipboard">
            <RotateCcw size={13} />
          </button>
        )}
        <button
          className={styles.iconBtn}
          onClick={() => void (history ? clipboardStore.removeFromHistory(item.id) : clipboardStore.remove(item.id))}
          title={history ? 'Delete from history' : 'Remove from clipboard (stays in History)'}
        >
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
 * The History view lists every drop ever posted, including ones removed from the clipboard.
 */
export const ClipboardDrawer: React.FC = observer(() => {
  React.useEffect(() => { void clipboardStore.ensureLoaded() }, [])

  React.useEffect(() => {
    if (!clipboardStore.open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clipboardStore.close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clipboardStore.open])

  const { items, open, freshId, error, view } = clipboardStore
  const inHistory = view === 'history'
  const historyRows = clipboardStore.filteredHistory

  return (
    <>
      {open && <div className={styles.backdrop} onClick={() => clipboardStore.close()} />}
      <div className={`${styles.drawer}${open ? ` ${styles.open}` : ''}`} aria-hidden={!open}>
        <div className={styles.head}>
          {inHistory ? (
            <button className={styles.iconBtn} onClick={() => clipboardStore.setView('clipboard')} title="Back to clipboard">
              <ArrowLeft size={15} />
            </button>
          ) : (
            <ClipboardCopy size={14} />
          )}
          <span className={styles.headTitle}>{inHistory ? 'Clipboard history' : 'Clipboard'}</span>
          <span className={styles.headHint}>
            {inHistory ? 'everything ever posted, newest first' : 'text agents posted for you to copy'}
          </span>
          <span className={styles.spacer} />
          {!inHistory && (
            <button className={styles.textBtn} onClick={() => clipboardStore.setView('history')} title="Everything ever posted, including cleared entries">
              <History size={13} /> History
            </button>
          )}
          {!inHistory && items.length > 0 && (
            <button
              className={styles.textBtn}
              onClick={async () => {
                if (await confirmStore.confirm({
                  title: 'Clear clipboard',
                  message: `Remove all ${items.length} entries from the clipboard? They stay in History.`,
                  confirmText: 'Clear',
                  danger: false,
                })) void clipboardStore.clear()
              }}
            >
              Clear all
            </button>
          )}
          {inHistory && clipboardStore.history.length > 0 && (
            <button
              className={styles.textBtn}
              onClick={async () => {
                if (await confirmStore.confirm({
                  title: 'Clear history',
                  message: `Permanently delete all ${clipboardStore.history.length} history entries? Entries still in the clipboard stay there.`,
                  confirmText: 'Delete history',
                })) void clipboardStore.clearHistory()
              }}
            >
              Clear history
            </button>
          )}
          <button className={styles.iconBtn} onClick={() => clipboardStore.close()} title="Close (Esc)">
            <X size={15} />
          </button>
        </div>
        {inHistory && (
          <div className={styles.filterRow}>
            <input
              className={styles.filter}
              placeholder="Filter by title, sender or text…"
              value={clipboardStore.historyFilter}
              onChange={(e) => clipboardStore.setHistoryFilter(e.target.value)}
            />
          </div>
        )}
        {error && <div className={styles.error}>{error}</div>}
        <div className={styles.list}>
          {inHistory ? (
            clipboardStore.historyLoading && clipboardStore.history.length === 0 ? (
              <div className={styles.empty}>Loading…</div>
            ) : historyRows.length === 0 ? (
              <div className={styles.empty}>
                {clipboardStore.historyFilter ? 'Nothing matches that filter.' : 'No history yet.'}
              </div>
            ) : (
              historyRows.map((h) => <Entry key={h.id} item={h} history />)
            )
          ) : items.length === 0 ? (
            <div className={styles.empty}>
              Nothing here right now. Agents post here with the <code>clipboard_post</code> tool;
              older entries are under History.
            </div>
          ) : (
            items.map((i) => <Entry key={i.id} item={i} fresh={i.id === freshId} />)
          )}
        </div>
      </div>
    </>
  )
})
