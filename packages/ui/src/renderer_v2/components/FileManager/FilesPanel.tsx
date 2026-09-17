import React, { useState } from 'react'
import { FolderTree, Type, ArrowRightLeft, RotateCcw } from 'lucide-react'
import { BulkRenamerPanel } from './BulkRenamerPanel'
import { ConvertPanel } from './ConvertPanel'
import styles from './Files.module.scss'

/**
 * Files tab — two sub-tabs.
 *
 *  File Browser  embeds FileBrowser Quantum (browsing the mounted NAS pools at /nas), which
 *                runs as a sidecar on :8082 in this container. Served same-origin via the
 *                Vite /files proxy (baseURL=/files) so X-Frame-Options:SAMEORIGIN permits the
 *                iframe — no token, no CORS, no mixed content.
 *  Bulk Renamer  our own UI. Quantum is a binary we cannot extend, so mass renaming with
 *                metadata assistance lives in AI-Lab itself, against /api/files.
 *
 * The iframe stays MOUNTED when the renamer is shown (hidden, not unmounted) so switching
 * sub-tabs does not reload Quantum and lose its place in a deep directory.
 */
type Sub = 'browser' | 'renamer' | 'convert'

export const FilesPanel: React.FC = () => {
  const [sub, setSub] = useState<Sub>('browser')
  // Bumping the key remounts the iframe at /files/. Quantum is cross-origin-opaque to us,
  // so once a link inside it navigates the frame somewhere that refuses framing (github.com),
  // this is the only way back short of reloading all of AI-Lab.
  const [frameKey, setFrameKey] = useState(0)
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Files</span>
        <div className={styles.tabs}>
          {([['browser', 'File Browser', <FolderTree size={13} key="a" />],
             ['renamer', 'Bulk Renamer', <Type size={13} key="b" />],
             ['convert', 'Convert', <ArrowRightLeft size={13} key="c" />]] as const).map(([id, label, icon]) => (
            <button key={id} className={`${styles.tab} ${sub === id ? styles.tabActive : ''}`}
              onClick={() => setSub(id as Sub)}>
              {icon}{label}
            </button>
          ))}
        </div>
        <div className={styles.spacer} />
        {sub === 'browser' && (
          <button className={styles.resetBtn} title="Reload the file browser at its root (use if it navigated somewhere it can't come back from)"
            onClick={() => setFrameKey((k) => k + 1)}>
            <RotateCcw size={12} /> Reset browser
          </button>
        )}
      </div>
      <div className={styles.headRule} />
      <div className={styles.body}>
        <div style={{ position: 'absolute', inset: 0, visibility: sub === 'browser' ? 'visible' : 'hidden' }}>
          <iframe key={frameKey} src="/files/" title="File Manager" className={styles.frame} />
        </div>
        {sub === 'renamer' && <BulkRenamerPanel />}
        {sub === 'convert' && <ConvertPanel />}
      </div>
    </div>
  )
}
