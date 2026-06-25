import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, FolderPlus, Folder, File as FileIcon, CornerLeftUp, Pencil, Trash2, ScanLine, Loader2, ChevronRight } from 'lucide-react'
import { fileManagerStore as store, type FmFile } from '../../stores/FileManagerStore'
import { EditValueModal, ConfirmModal } from '../Cluster/ClusterModals'
import styles from './FileManager.module.scss'

function fmtBytes(b?: number): string {
  if (!b || b <= 0) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = b
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

const tabLabel = (k: string) => k.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

export const FileManagerPanel: React.FC = observer(() => {
  const [mkdirOpen, setMkdirOpen] = useState(false)
  const [renaming, setRenaming] = useState<FmFile | null>(null)
  const [deleting, setDeleting] = useState<{ path: string; name: string } | null>(null)

  useEffect(() => {
    void store.loadConfig()
  }, [])

  return (
    <div className={styles.container}>
      <div className={styles.tabbar}>
        {store.tabKeys.map((k) => (
          <button key={k} className={`${styles.tab} ${store.activeTab === k ? styles.tabActive : ''}`} onClick={() => store.setTab(k)}>
            {tabLabel(k)}
          </button>
        ))}
        <div className={styles.spacer} />
        <button className={styles.toolBtn} title="New folder" disabled={store.busy} onClick={() => setMkdirOpen(true)}>
          <FolderPlus size={14} /> New folder
        </button>
        <button className={styles.toolBtn} title="Refresh" onClick={() => void store.browse()}>
          <RefreshCw size={14} className={store.loading ? styles.spin : ''} />
        </button>
      </div>

      <div className={styles.crumbs}>
        <button className={styles.crumb} onClick={() => store.goToCrumb(-1)}>{store.activeTab || 'root'}</button>
        {store.crumbs.map((c, i) => (
          <React.Fragment key={i}>
            <ChevronRight size={12} className={styles.crumbSep} />
            <button className={styles.crumb} onClick={() => store.goToCrumb(i)}>{c}</button>
          </React.Fragment>
        ))}
      </div>

      {store.error && <div className={styles.errorBar}>{store.error}</div>}

      <div className={styles.body}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.colName}>Name</th>
              <th className={styles.colType}>Type</th>
              <th className={styles.colSize}>Size</th>
              <th className={styles.colActions} />
            </tr>
          </thead>
          <tbody>
            {store.relDir !== '/' && (
              <tr className={styles.row} onClick={() => store.up()}>
                <td className={styles.nameCell}><CornerLeftUp size={15} className={styles.upIcon} /> ..</td>
                <td /><td /><td />
              </tr>
            )}
            {store.dirs.map((d) => (
              <tr key={d.path} className={styles.row}>
                <td className={styles.nameCell} onClick={() => store.enter(d.name)}>
                  <Folder size={15} className={styles.folderIcon} /> {d.name}
                </td>
                <td className={styles.typeCell}>folder</td>
                <td />
                <td className={styles.actionsCell}>
                  <button className={styles.actBtn} title="Rename" onClick={() => setRenaming({ name: d.name, path: d.path })}><Pencil size={12} /></button>
                  <button className={`${styles.actBtn} ${styles.danger}`} title="Delete" onClick={() => setDeleting({ path: d.path, name: d.name })}><Trash2 size={12} /></button>
                </td>
              </tr>
            ))}
            {store.files.map((f) => (
              <tr key={f.path} className={`${styles.row} ${f.scan?.misplaced ? styles.misplaced : ''}`}>
                <td className={styles.nameCell}><FileIcon size={15} className={styles.fileIcon} /> {f.name}</td>
                <td className={styles.typeCell}>
                  {f.scan ? (
                    <span className={styles.badge} style={{ background: `color-mix(in srgb, ${f.scan.color || 'var(--accent)'} 22%, transparent)`, color: f.scan.color || 'var(--accent)' }} title={f.scan.label || ''}>
                      {f.scan.type}{f.scan.misplaced ? ' ⚠' : ''}
                    </span>
                  ) : isModel(f) ? (
                    <button className={styles.scanBadge} disabled={!!store.scanning[f.path]} onClick={() => void store.scanFile(f.path)}>
                      {store.scanning[f.path] ? <Loader2 size={11} className={styles.spin} /> : <ScanLine size={11} />} scan
                    </button>
                  ) : (
                    <span className={styles.extType}>{f.ext || ''}</span>
                  )}
                </td>
                <td className={styles.sizeCell}>{fmtBytes(f.size)}</td>
                <td className={styles.actionsCell}>
                  <button className={styles.actBtn} title="Rename" onClick={() => setRenaming(f)}><Pencil size={12} /></button>
                  <button className={`${styles.actBtn} ${styles.danger}`} title="Delete" onClick={() => setDeleting({ path: f.path, name: f.name })}><Trash2 size={12} /></button>
                </td>
              </tr>
            ))}
            {!store.loading && store.dirs.length === 0 && store.files.length === 0 && (
              <tr><td colSpan={4} className={styles.empty}>Empty folder</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {mkdirOpen && (
        <EditValueModal title="New folder" label="Folder name" initial="" onSubmit={(v) => void store.mkdir(v)} onClose={() => setMkdirOpen(false)} />
      )}
      {renaming && (
        <EditValueModal title={`Rename ${renaming.name}`} label="New name" initial={renaming.name} onSubmit={(v) => void store.rename(renaming.path, v)} onClose={() => setRenaming(null)} />
      )}
      {deleting && (
        <ConfirmModal title={`Delete ${deleting.name}?`} message="This cannot be undone." confirmLabel="Delete" danger onConfirm={() => void store.del(deleting.path)} onClose={() => setDeleting(null)} />
      )}
    </div>
  )
})

const MODEL_EXTS = ['.safetensors', '.gguf', '.ckpt', '.pt', '.pth', '.bin']
function isModel(f: FmFile): boolean {
  return MODEL_EXTS.includes((f.ext || '').toLowerCase())
}
