import React, { useEffect, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2, X, FileText } from 'lucide-react'
import { docRagStore as store } from '../../stores/DocRagStore'
import styles from './AiTools.module.scss'

const types = (m: any) => (m ? Object.entries(m).sort((a: any, b: any) => b[1] - a[1]).map(([t, c]) => `${t} (${c})`).join(', ') : '')
const when = (d: string) => (d ? new Date(d).toLocaleDateString() : '')
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

export const DocRagPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const fileRef = useRef<HTMLInputElement>(null)
  const st = store.status

  return (
    <div className={styles.panel}>
      {store.err && <div className={styles.error}>{store.err}</div>}

      <div className={styles.ragCard}>
        <h4 className={styles.h4}>Upload &amp; Index Documents</h4>
        <p className={styles.muted}>Upload PDFs, images, office docs, or text files to index into vector DBs.</p>
        <label className={styles.formRow}><span className={styles.formLbl}>Collection Name</span><input className={styles.input} value={store.collection} placeholder="my-documents" onChange={(e) => store.setCollection(e.target.value)} /></label>
        <label className={styles.formRow}><span className={styles.formLbl}>Description</span><input className={styles.input} value={store.description} placeholder="Short description" onChange={(e) => store.setDescription(e.target.value)} /></label>

        <div className={styles.dropzone} onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) void store.addFiles(e.dataTransfer.files) }}>
          <FileText size={22} />
          <div>Drop files here or click to browse</div>
          <div className={styles.dim}>PDF, DOCX, XLSX, PNG, JPG, TXT, MD, CSV, JSON, YAML, XML, HTML</div>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }}
            accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html"
            onChange={(e) => { if (e.target.files?.length) void store.addFiles(e.target.files); e.currentTarget.value = '' }} />
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

        <div className={styles.formActions}>
          <button className={styles.btnPrimary} disabled={st.active || store.busy || !store.files.length} onClick={() => void store.index()}>
            {st.active || store.busy ? 'Indexing…' : `Upload & Index${store.files.length ? ` (${store.files.length})` : ''}`}
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
                    <button className={styles.iconDanger} title="Delete" onClick={() => { if (window.confirm(`Delete collection "${c.display_name || c.name}"? Removes it from all vector DBs.`)) void store.deleteCollection(c.name) }}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
})
