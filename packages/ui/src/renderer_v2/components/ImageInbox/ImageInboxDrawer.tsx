import React from 'react'
import { observer } from 'mobx-react-lite'
import { ChevronLeft, ChevronRight, Trash2, X } from 'lucide-react'
import { imageInboxStore } from '../../stores/ImageInboxStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './ImageInbox.module.scss'

function ago(ts: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * Image inbox viewer: images agents sent for Travis to SEE. Opens ONLY from its TopBar
 * button — a new image never opens anything by itself (that's the clipboard's job); it
 * only bumps the pip on the button.
 */
export const ImageInboxDrawer: React.FC = observer(() => {
  const s = imageInboxStore
  const current = s.items[s.selected]

  // Arrow keys page through the gallery while the viewer is open.
  React.useEffect(() => {
    if (!s.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') s.prev()
      else if (e.key === 'ArrowRight') s.next()
      else if (e.key === 'Escape') s.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s, s.open])

  const clearAll = async () => {
    const ok = await confirmStore.confirm({
      title: 'Clear image inbox',
      message: `Delete all ${s.items.length} image(s) from the inbox? This also deletes the stored copies.`,
      confirmText: 'Clear all',
      danger: true,
    })
    if (ok) void s.clear()
  }

  return (
    <>
      {s.open && <div className={styles.backdrop} onClick={() => s.close()} />}
      <div className={`${styles.drawer}${s.open ? ` ${styles.open}` : ''}`} role="dialog" aria-label="Image inbox">
        <div className={styles.head}>
          <span className={styles.headTitle}>Image inbox</span>
          <span className={styles.headMeta}>
            {s.items.length === 0 ? 'empty' : `${s.selected + 1} / ${s.items.length}`}
          </span>
          <span className={styles.spacer} />
          {s.items.length > 0 && (
            <button className={styles.iconBtn} onClick={() => void clearAll()} title="Clear all images">
              <Trash2 size={14} />
            </button>
          )}
          <button className={styles.iconBtn} onClick={() => s.close()} title="Close">
            <X size={15} />
          </button>
        </div>

        {s.error && <div className={styles.error}>{s.error}</div>}

        {s.items.length === 0 ? (
          <div className={styles.empty}>
            Nothing here. When an agent sends you an image (MCP <code>image_inbox_post</code>),
            it lands in this viewer and the TopBar button shows a count.
          </div>
        ) : current && (
          <>
            <div className={styles.stage}>
              <button
                className={styles.navBtn}
                onClick={() => s.prev()}
                disabled={s.selected === 0}
                title="Previous (←)"
              >
                <ChevronLeft size={20} />
              </button>
              {/* key remounts the img per image so a slow previous load can't linger */}
              <a href={s.imageUrl(current.id)} target="_blank" rel="noreferrer" className={styles.stageLink} title="Open full size in a new tab">
                <img key={current.id} className={styles.stageImg} src={s.imageUrl(current.id)} alt={current.title || 'inbox image'} />
              </a>
              <button
                className={styles.navBtn}
                onClick={() => s.next()}
                disabled={s.selected >= s.items.length - 1}
                title="Next (→)"
              >
                <ChevronRight size={20} />
              </button>
            </div>

            <div className={styles.meta}>
              <div className={styles.metaMain}>
                <span className={styles.metaTitle}>{current.title || 'Untitled'}</span>
                <span className={styles.metaSub}>
                  {current.from ? `${current.from} · ` : ''}{ago(current.ts)} · {sizeLabel(current.bytes)}
                </span>
              </div>
              <button
                className={styles.iconBtn}
                onClick={() => void s.remove(current.id)}
                title="Delete this image from the inbox"
              >
                <Trash2 size={14} />
              </button>
            </div>
            {current.caption && <div className={styles.caption}>{current.caption}</div>}

            {s.items.length > 1 && (
              <div className={styles.strip}>
                {s.items.map((item, i) => (
                  <button
                    key={item.id}
                    className={`${styles.thumbBtn}${i === s.selected ? ` ${styles.thumbActive}` : ''}`}
                    onClick={() => s.select(i)}
                    title={item.title || ago(item.ts)}
                  >
                    <img className={styles.thumbImg} src={s.imageUrl(item.id)} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
})
