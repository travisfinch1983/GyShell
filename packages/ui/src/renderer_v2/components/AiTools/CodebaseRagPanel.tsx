import React, { useEffect } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2, RotateCw } from 'lucide-react'
import { ragStore as store } from '../../stores/RagStore'
import styles from './AiTools.module.scss'

const langs = (m: any) => (m ? Object.entries(m).sort((a: any, b: any) => b[1] - a[1]).slice(0, 3).map(([l, c]) => `${l} (${c})`).join(', ') : '')
const repoShort = (u: string) => (u || '').replace(/^https?:\/\/(github\.com|10\.\d+\.\d+\.\d+:\d+)\//, '').replace(/\.git$/, '')
const when = (d: string) => (d ? new Date(d).toLocaleDateString() : '')

export const CodebaseRagPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const f = store.form
  const st = store.status

  return (
    <div className={styles.panel}>
      {store.err && <div className={styles.error}>{store.err}</div>}

      {store.checkpoints.length > 0 && (
        <div className={styles.warnBanner}>
          <div>Interrupted indexing found for: {store.checkpoints.map((c) => c.displayName || c.collection).join(', ')}</div>
          <div className={styles.warnActions}>
            {store.checkpoints.map((c) => (
              <span key={c.collection} className={styles.cpRow}>
                <button className={styles.btnPrimary} onClick={() => void store.resume(c.collection)}>Resume {c.displayName || c.collection} ({c.filesCompleted}/{c.filesTotal})</button>
                <button className={styles.btn} onClick={() => void store.discardCheckpoint(c.collection)}>Discard</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Index form */}
      <div className={styles.ragCard}>
        <h4 className={styles.h4}>Index a Repository</h4>
        <p className={styles.muted}>Clone a git repo and index all code files into vector DBs for semantic search.</p>
        <label className={styles.formRow}><span className={styles.formLbl}>Repository URL</span><input className={styles.input} value={f.url} placeholder="https://github.com/user/repo" onChange={(e) => store.setForm('url', e.target.value)} /></label>
        <label className={styles.formRow}><span className={styles.formLbl}>Collection Name</span><input className={styles.input} value={f.collection} placeholder="my-project" onChange={(e) => store.setForm('collection', e.target.value)} /></label>
        <label className={styles.formRow}><span className={styles.formLbl}>Description</span><input className={styles.input} value={f.description} placeholder="Short description" onChange={(e) => store.setForm('description', e.target.value)} /></label>
        <label className={styles.formRow}><span className={styles.formLbl}>Branch</span><input className={styles.input} value={f.branch} placeholder="(repo default)" onChange={(e) => store.setForm('branch', e.target.value)} /></label>
        <div className={styles.formActions}>
          <button className={styles.btnPrimary} disabled={st.active} onClick={() => void store.index()}>{st.active ? 'Indexing…' : 'Index Repository'}</button>
        </div>
        {(st.active || st.detail) && (
          <div className={styles.statusBox}>
            <div>{st.detail || st.phase}</div>
            {st.active && <div className={styles.progressWrap}><div className={styles.progressBar} style={{ width: `${st.progress || 0}%` }} /></div>}
          </div>
        )}
      </div>

      {/* Collections */}
      <div className={styles.ragCard}>
        <div className={styles.head}>
          <h4 className={styles.h4}>Indexed Collections</h4>
          <span className={styles.spacer} />
          <button className={styles.btn} onClick={() => void store.load()}><RefreshCw size={13} /> Refresh</button>
        </div>
        {store.collections.length === 0 ? <div className={styles.muted}>No codebase collections indexed yet.</div> : (
          <table className={styles.ragTable}>
            <thead><tr><th>Name</th><th>Repository</th><th>Files</th><th>Chunks</th><th>Languages</th><th>Indexed</th><th /></tr></thead>
            <tbody>
              {store.collections.map((c) => (
                <tr key={c.name}>
                  <td className={styles.bold}>{c.display_name || c.name}</td>
                  <td className={styles.dim} title={c.repo_url}>{repoShort(c.repo_url)}</td>
                  <td>{c.files_indexed || 0}</td>
                  <td>{c.chunks_created || 0}</td>
                  <td className={styles.dim}>{langs(c.languages)}</td>
                  <td className={styles.dim}>{when(c.indexed_at)}</td>
                  <td className={styles.rowActions}>
                    <button className={styles.iconBtn} title="Update (re-index)" disabled={st.active} onClick={() => void store.updateCollection(c)}><RotateCw size={13} /></button>
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
