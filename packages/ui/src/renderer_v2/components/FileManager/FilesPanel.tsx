import React, { useState } from 'react'
import { FolderTree, Type } from 'lucide-react'
import { BulkRenamerPanel } from './BulkRenamerPanel'
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
type Sub = 'browser' | 'renamer'

export const FilesPanel: React.FC = () => {
  const [sub, setSub] = useState<Sub>('browser')
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Files</span>
        <div className={styles.tabs}>
          {([['browser', 'File Browser', <FolderTree size={13} key="a" />],
             ['renamer', 'Bulk Renamer', <Type size={13} key="b" />]] as const).map(([id, label, icon]) => (
            <button key={id} className={`${styles.tab} ${sub === id ? styles.tabActive : ''}`}
              onClick={() => setSub(id as Sub)}>
              {icon}{label}
            </button>
          ))}
        </div>
        <div className={styles.spacer} />
      </div>
      <div className={styles.headRule} />
      <div className={styles.body}>
        <div style={{ position: 'absolute', inset: 0, visibility: sub === 'browser' ? 'visible' : 'hidden' }}>
          <iframe src="/files/" title="File Manager" className={styles.frame} />
        </div>
        {sub === 'renamer' && <BulkRenamerPanel />}
      </div>
    </div>
  )
}
