import React, { useEffect, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2, X, FileText, FolderOpen, Folder, CornerLeftUp, Loader2, CheckSquare, Square, HardDrive } from 'lucide-react'
import { docRagStore as store } from '../../stores/DocRagStore'
import { confirmStore } from '../../stores/confirmStore'
import styles from './AiTools.module.scss'

const types = (m: any) => (m ? Object.entries(m).sort((a: any, b: any) => b[1] - a[1]).map(([t, c]) => `${t} (${c})`).join(', ') : '')
const when = (d: string) => (d ? new Date(d).toLocaleDateString() : '')
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

const ServerFileBrowser: React.FC = observer(() => {
  const b = store.browse
  if (!b.open) return null
  const allSelected = b.files.length > 0 && b.files.every((f) => b.selected.includes(f.path))
  return (
    <div className={styles.modalOverlay} onClick={() => store.closeBrowse()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <HardDrive size={15} />
          <span className={styles.modalTitle}>Browse files on the container</span>
          <span className={styles.spacer} />
          <button className={styles.iconBtn} onClick={() => store.closeBrowse()}><X size={15} /></button>
        </div>

        <div className={styles.pathBar}>
          <code className={styles.pathText}>{b.path}</code>
          {b.files.length > 0 && (
            <button className={styles.linkBtn} onClick={() => store.selectAllInFolder()}>
              {allSelected ? 'clear' : `select all ${b.files.length}`}
            </button>
          )}
        </div>

        {b.error && <div className={styles.error}>{b.error}</div>}

        <div className={styles.browseList}>
          {b.parent && (
            <button className={styles.dirRow} onClick={() => void store.browseTo(b.parent!)}>
              <CornerLeftUp size={14} className={styles.dim} /><span>..</span>
            </button>
          )}
          {b.loading ? (
            <div className={styles.browseMuted}><Loader2 size={14} className={styles.spin} /> loading…</div>
          ) : (
            <>
              {b.dirs.map((d) => (
                <button key={d.path} className={styles.dirRow} onClick={() => void store.browseTo(d.path)} title={d.path}>
                  <Folder size={14} className={styles.dim} /><span className={styles.ellip}>{d.name}</span>
                </button>
              ))}
              {b.files.map((f) => {
                const on = b.selected.includes(f.path)
                return (
                  <button key={f.path} className={`${styles.fileSelRow} ${on ? styles.fileSelOn : ''}`} onClick={() => store.toggleSelect(f.path)} title={f.path}>
                    {on ? <CheckSquare size={14} className={styles.accentIco} /> : <Square size={14} className={styles.dim} />}
                    <FileText size={13} className={styles.dim} />
                    <span className={styles.ellip}>{f.name}</span>
                    <span className={styles.spacer} />
                    <span className={styles.dim}>{kb(f.size)}</span>
                  </button>
                )
              })}
              {!b.dirs.length && !b.files.length && <div className={styles.browseMuted}>(no folders or indexable files here)</div>}
            </>
          )}
        </div>

        <div className={styles.modalFoot}>
          <span className={styles.dim}>{b.selected.length} selected</span>
          <span className={styles.spacer} />
          <button className={styles.btn} onClick={() => store.closeBrowse()}>Cancel</button>
          <button className={styles.btnPrimary} disabled={!b.selected.length} onClick={() => store.addSelected()}>Add {b.selected.length || ''} file{b.selected.length === 1 ? '' : 's'}</button>
        </div>
      </div>
    </div>
  )
})

export const DocRagPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const fileRef = useRef<HTMLInputElement>(null)
  const st = store.status

  return (
    <div className={styles.panel}>
      {store.err && <div className={styles.error}>{store.err}</div>}

      <div className={styles.ragCard}>
        <h4 className={styles.h4}>Add &amp; Index Documents</h4>
        <p className={styles.muted}>Upload from your machine, or browse files already on the container (NAS mounts). Multiple files go into one collection, each kept separate by filename.</p>
        <label className={styles.formRow}><span className={styles.formLbl}>Collection Name</span><input className={styles.input} value={store.collection} placeholder="my-documents" onChange={(e) => store.setCollection(e.target.value)} /></label>
        <label className={styles.formRow}><span className={styles.formLbl}>Description</span><input className={styles.input} value={store.description} placeholder="Short description" onChange={(e) => store.setDescription(e.target.value)} /></label>

        <div className={styles.dropzone} onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) void store.addFiles(e.dataTransfer.files) }}>
          <FileText size={22} />
          <div>Drop files here or click to upload</div>
          <div className={styles.dim}>PDF, DOCX, XLSX, PNG, JPG, TXT, MD, CSV, JSON, YAML, XML, HTML</div>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
            accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html"
            onChange={(e) => { if (e.target.files?.length) void store.addFiles(e.target.files); e.currentTarget.value = '' }} />
        </div>

        <div className={styles.orBrowse}>
          <span className={styles.orLine} />
          <button className={styles.btnBrowseServer} onClick={() => store.openBrowse()}><FolderOpen size={14} /> Browse files on the container</button>
          <span className={styles.orLine} />
        </div>

        {store.files.length > 0 && (
          <div className={styles.fileList}>
            {store.files.map((f, i) => (
              <div key={i} className={styles.fileRow}>
                <span className={styles.fileName}>{f.name}</span>
                <span className={styles.dim}>{kb(f.size)}</span>
                <button className={styles.iconBtn} onClick={() => store.removeFile(i)}><X size={12} /></button>
              </div>
            ))}
          </div>
        )}
        {store.serverFiles.length > 0 && (
          <div className={styles.fileList}>
            {store.serverFiles.map((f, i) => (
              <div key={f.path} className={styles.fileRow}>
                <HardDrive size={12} className={styles.accentIco} title="on the container" />
                <span className={styles.fileName} title={f.path}>{f.name}</span>
                <span className={styles.dim}>{kb(f.size)}</span>
                <button className={styles.iconBtn} onClick={() => store.removeServerFile(i)}><X size={12} /></button>
              </div>
            ))}
          </div>
        )}

        <div className={styles.formActions}>
          <button className={styles.btnPrimary} disabled={st.active || store.busy || !store.totalStaged} onClick={() => void store.index()}>
            {st.active || store.busy ? 'Indexing…' : `Index${store.totalStaged ? ` (${store.totalStaged})` : ''}`}
          </button>
        </div>
        {(st.active || st.detail) && (
          <div className={styles.statusBox}>
            <div>{st.detail || st.phase}</div>
            {st.active && <div className={styles.progressWrap}><div className={styles.progressBar} style={{ width: `${st.progress || 0}%` }} /></div>}
          </div>
        )}
      </div>

      <div className={styles.ragCard}>
        <div className={styles.head}>
          <h4 className={styles.h4}>Document Collections</h4>
          <span className={styles.spacer} />
          <button className={styles.btn} onClick={() => void store.load()}><RefreshCw size={13} /> Refresh</button>
        </div>
        {store.collections.length === 0 ? <div className={styles.muted}>No document collections indexed yet.</div> : (
          <table className={styles.ragTable}>
            <thead><tr><th>Name</th><th>Files</th><th>Chunks</th><th>Types</th><th>Indexed</th><th /></tr></thead>
            <tbody>
              {store.collections.map((c) => (
                <tr key={c.name}>
                  <td className={styles.bold}>{c.display_name || c.name}</td>
                  <td>{c.files_indexed || 0}</td>
                  <td>{c.chunks_created || 0}</td>
                  <td className={styles.dim}>{types(c.file_types)}</td>
                  <td className={styles.dim}>{when(c.indexed_at)}</td>
                  <td className={styles.rowActions}>
                    <button className={styles.iconDanger} title="Delete" onClick={async () => { if (await confirmStore.confirm({ title: 'Delete collection', message: `Delete collection “${c.display_name || c.name}”? Removes it from all vector DBs.`, confirmText: 'Delete' })) void store.deleteCollection(c.name) }}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ServerFileBrowser />
    </div>
  )
})
