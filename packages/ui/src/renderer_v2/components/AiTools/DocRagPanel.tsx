import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { RefreshCw, Trash2, X, FileText, FolderOpen, Folder, CornerLeftUp, Loader2, CheckSquare, Square, HardDrive, Pencil, FileUp, Plus, Check, Files } from 'lucide-react'
import { docRagStore as store, DOC_TYPES, type StagedDoc, type RagDocument } from '../../stores/DocRagStore'
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

const typeList = <datalist id="docrag-types">{DOC_TYPES.map((t) => <option key={t} value={t} />)}</datalist>

/** One staged file with its title / type / description. */
const StagedRow: React.FC<{ s: StagedDoc }> = observer(({ s }) => {
  const rep = store.replaces(s)
  return (
    <div className={styles.stagedDoc}>
      <div className={styles.stagedHead}>
        {s.kind === 'server' ? <HardDrive size={12} className={styles.accentIco} /> : <FileText size={12} className={styles.dim} />}
        <span className={styles.fileName} title={s.path || s.name}>{s.name}</span>
        {rep && <span className={styles.replaceTag} title={`A document with this file name is already in the collection - indexing replaces "${rep.title}"`}>replaces “{rep.title}”</span>}
        <span className={styles.dim}>{kb(s.size)}</span>
        <button className={styles.iconBtn} title="Remove" onClick={() => store.removeStaged(s.key)}><X size={12} /></button>
      </div>
      <div className={styles.docMetaGrid}>
        <input className={styles.inputSm} value={s.title} placeholder="Title (required)" onChange={(e) => store.setStaged(s.key, 'title', e.target.value)} />
        <input className={styles.inputSm} value={s.docType} placeholder="Type (Blueprint, Contract…)" list="docrag-types" onChange={(e) => store.setStaged(s.key, 'docType', e.target.value)} />
        <input className={`${styles.inputSm} ${styles.wide}`} value={s.description} placeholder="Description (optional) - what is this document, what does it cover?" onChange={(e) => store.setStaged(s.key, 'description', e.target.value)} />
      </div>
    </div>
  )
})

/** The collection window: every document in a collection, with edit / replace / delete. */
const CollectionDetail: React.FC = observer(() => {
  const d = store.detail
  const replaceRef = useRef<HTMLInputElement>(null)
  const [replacing, setReplacing] = useState<RagDocument | null>(null)
  const [desc, setDesc] = useState<string | null>(null)
  if (!d.open) return null
  const e = d.entry || {}
  const jobHere = store.status.active && store.status.colName === d.name
  const locked = store.status.active || store.busy
  const descVal = desc ?? (e.description || '')
  return (
    <div className={styles.modalOverlay} onClick={() => store.closeDetail()}>
      <div className={`${styles.modal} ${styles.modalWide}`} onClick={(ev) => ev.stopPropagation()}>
        <div className={styles.modalHead}>
          <Files size={15} />
          <strong>{e.display_name || d.name}</strong>
          <span className={styles.dim}>{d.docs.length} document{d.docs.length === 1 ? '' : 's'} · {e.chunks_created || 0} chunks</span>
          <span className={styles.spacer} />
          <button className={styles.iconBtn} title="Reload" onClick={() => void store.loadDetail()}><RefreshCw size={14} /></button>
          <button className={styles.iconBtn} onClick={() => store.closeDetail()}><X size={15} /></button>
        </div>
        <div className={styles.modalBody}>
          {d.error && <div className={styles.error}>{d.error}</div>}
          <label className={styles.formRow}>
            <span className={styles.formLbl}>Description</span>
            <input className={styles.input} value={descVal} placeholder="What is this collection for?" onChange={(ev) => setDesc(ev.target.value)} />
            {desc != null && desc !== (e.description || '') && (
              <button className={styles.btn} disabled={d.savingDesc} onClick={async () => { await store.saveCollectionDescription(desc); setDesc(null) }}><Check size={13} /> Save</button>
            )}
          </label>
          {(jobHere || store.uploadMsg) && (
            <div className={styles.statusBox}>
              <div>{store.uploadMsg || store.status.detail}</div>
              {jobHere && <div className={styles.progressWrap}><div className={styles.progressBar} style={{ width: `${store.status.progress || 0}%` }} /></div>}
            </div>
          )}
          {d.loading && !d.docs.length ? (
            <div className={styles.browseMuted}><Loader2 size={14} className={styles.spin} /> loading documents… (an older collection is catalogued on first open)</div>
          ) : d.docs.length === 0 ? (
            <div className={styles.muted}>No documents in this collection.</div>
          ) : (
            <div className={styles.docTableWrap}>
              <table className={styles.ragTable}>
                <thead><tr><th>Document</th><th>Type</th><th>Chunks</th><th>Pages</th><th>Indexed</th><th /></tr></thead>
                <tbody>
                  {d.docs.map((doc) => d.editing === doc.doc_id ? (
                    <tr key={doc.doc_id}>
                      <td colSpan={6}>
                        <div className={styles.editBox}>
                          <div className={styles.docMetaGrid}>
                            <input className={styles.inputSm} value={d.draft.title} placeholder="Title" onChange={(ev) => store.setDraft('title', ev.target.value)} autoFocus />
                            <input className={styles.inputSm} value={d.draft.docType} placeholder="Type" list="docrag-types" onChange={(ev) => store.setDraft('docType', ev.target.value)} />
                            <input className={`${styles.inputSm} ${styles.wide}`} value={d.draft.description} placeholder="Description" onChange={(ev) => store.setDraft('description', ev.target.value)} />
                          </div>
                          <div className={styles.formActions}>
                            <button className={styles.btnPrimary} onClick={() => void store.saveEdit()}><Check size={13} /> Save</button>
                            <button className={styles.btn} onClick={() => store.cancelEdit()}>Cancel</button>
                            <span className={styles.dim}>{doc.file_name}</span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={doc.doc_id}>
                      <td>
                        <div className={styles.docTitle}>{doc.title}</div>
                        <div className={styles.docSub}>{doc.file_name}{doc.version && doc.version > 1 ? ` · v${doc.version}` : ''}{doc.size ? ` · ${kb(doc.size)}` : ''}</div>
                        {doc.description && <div className={styles.docSub}>{doc.description}</div>}
                      </td>
                      <td>{doc.doc_type ? <span className={styles.typeChip}>{doc.doc_type}</span> : <span className={styles.dim}>—</span>}</td>
                      <td>{doc.chunks || 0}</td>
                      <td>{doc.page_images || 0}</td>
                      <td className={styles.dim}>{when(doc.indexed_at || '')}</td>
                      <td>
                        <div className={styles.rowActions}>
                          <button className={styles.iconBtn} title="Edit title, type, description" disabled={locked} onClick={() => store.startEdit(doc)}><Pencil size={13} /></button>
                          <button className={styles.iconBtn} title="Replace with a new version of this file (the old version is removed once the new one is indexed)" disabled={locked}
                            onClick={() => { setReplacing(doc); replaceRef.current?.click() }}><FileUp size={13} /></button>
                          <button className={styles.iconDanger} title="Remove this document" disabled={locked}
                            onClick={async () => { if (await confirmStore.confirm({ title: 'Remove document', message: `Remove “${doc.title}” (${doc.file_name}) from ${e.display_name || d.name}? Its ${(doc.chunks || 0) + (doc.page_images || 0)} chunks are deleted from the index.`, confirmText: 'Remove' })) void store.deleteDocument(doc) }}><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <input ref={replaceRef} type="file" style={{ display: 'none' }} accept={ACCEPT}
            onChange={async (ev) => {
              const f = ev.target.files?.[0]; const doc = replacing; ev.currentTarget.value = ''
              if (!f || !doc) return
              if (await confirmStore.confirm({ title: 'Replace document', message: `Replace “${doc.title}” (${doc.file_name}) with ${f.name}? The title, type and description are kept; the old version is removed after the new one is indexed.`, confirmText: 'Replace' })) void store.replaceDocument(doc, f)
              setReplacing(null)
            }} />
        </div>
        <div className={styles.modalFoot}>
          <span className={styles.dim}>Click a pencil to retitle; titles and types narrow searches (search_docs <code>document</code> / <code>doc_type</code>).</span>
          <span className={styles.spacer} />
          <button className={styles.btn} onClick={() => store.addToThis()}><Plus size={13} /> Add documents…</button>
          <button className={styles.btn} onClick={() => store.closeDetail()}>Close</button>
        </div>
      </div>
    </div>
  )
})

const ACCEPT = '.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.txt,.md,.csv,.json,.yaml,.yml,.xml,.html'

export const DocRagPanel: React.FC = observer(() => {
  useEffect(() => { if (!store.loaded) void store.load() }, [])
  const fileRef = useRef<HTMLInputElement>(null)
  const st = store.status
  const target = store.targetCollection
  const replacing = store.staged.filter((s) => store.replaces(s)).length

  return (
    <div className={styles.panel}>
      {typeList}
      {store.err && <div className={styles.error}>{store.err}</div>}

      <div className={styles.ragCard}>
        <h4 className={styles.h4}>Add &amp; Index Documents</h4>
        <p className={styles.muted}>Upload from your machine, or browse files already on the container (NAS mounts). One collection holds many documents; give each a title and type so searches can target it. Pick an existing collection to add to it.</p>
        <label className={styles.formRow}><span className={styles.formLbl}>Collection</span><input className={styles.input} value={store.collection} list="docrag-collections" placeholder="new name, or pick an existing collection" onChange={(e) => store.setCollection(e.target.value)} /></label>
        <datalist id="docrag-collections">{store.collections.map((c) => <option key={c.name} value={c.display_name || c.name} />)}</datalist>
        {store.collection.trim() && (
          <div className={styles.targetHint}>
            {target ? <>Adding to existing collection <b>{target.display_name || target.name}</b> ({target.files_indexed || 0} documents){replacing ? ` - ${replacing} file${replacing === 1 ? '' : 's'} will replace a document of the same name` : ''}.</> : 'A new collection will be created.'}
          </div>
        )}
        <label className={styles.formRow}><span className={styles.formLbl}>Description</span><input className={styles.input} value={store.description} placeholder={target ? 'leave blank to keep the collection description' : 'Short description of the collection'} onChange={(e) => store.setDescription(e.target.value)} /></label>

        <div className={styles.dropzone} onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) void store.addFiles(e.dataTransfer.files) }}>
          <FileText size={22} />
          <div>Drop files here or click to upload</div>
          <div className={styles.dim}>PDF, DOCX, XLSX, PNG, JPG, TXT, MD, CSV, JSON, YAML, XML, HTML</div>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }} accept={ACCEPT}
            onChange={(e) => { if (e.target.files?.length) void store.addFiles(e.target.files); e.currentTarget.value = '' }} />
        </div>

        <div className={styles.orBrowse}>
          <span className={styles.orLine} />
          <button className={styles.btnBrowseServer} onClick={() => store.openBrowse()}><FolderOpen size={14} /> Browse files on the container</button>
          <span className={styles.orLine} />
        </div>

        {store.staged.length > 0 && (
          <>
            {store.staged.length > 1 && (
              <label className={styles.formRow} style={{ alignItems: 'center' }}>
                <span className={styles.formLbl}>Type for all</span>
                <input className={styles.inputSm} style={{ flex: 1 }} list="docrag-types" placeholder="set every file's type at once (optional)" onChange={(e) => store.setAllTypes(e.target.value)} />
              </label>
            )}
            <div className={styles.stagedList}>
              {store.staged.map((s) => <StagedRow key={s.key} s={s} />)}
            </div>
          </>
        )}

        <label className={styles.formRow} style={{ alignItems: 'center', gap: 8 }}
               title="Render every PDF page and embed it as an image too, so diagrams, wiring schematics and scanned pages are searchable. Roughly doubles indexing time.">
          <input type="checkbox" checked={store.pageImages} onChange={(e) => store.setPageImages(e.target.checked)} />
          <span>Index PDF page images (diagrams &amp; scanned pages)</span>
        </label>
        <div className={styles.formActions}>
          <button className={styles.btnPrimary} disabled={st.active || store.busy || !store.totalStaged} onClick={() => void store.index()}>
            {st.active || store.busy ? 'Indexing…' : `${target ? 'Add to collection' : 'Index'}${store.totalStaged ? ` (${store.totalStaged})` : ''}`}
          </button>
        </div>
        {store.uploadMsg && !store.detail.open && (
          <div className={styles.statusBox}>
            <div>{store.uploadMsg}</div>
          </div>
        )}
        {(st.active || st.detail) && (
          <div className={styles.statusBox}>
            {/* Name the job: a finished job's line used to read like the current one's status. */}
            <div>{st.active ? '' : 'Last job'}{st.collection ? `${st.active ? '' : ' · '}${st.collection}: ` : (st.active ? '' : ': ')}{st.detail || st.phase}</div>
            {st.active && <div className={styles.progressWrap}><div className={styles.progressBar} style={{ width: `${st.progress || 0}%` }} /></div>}
          </div>
        )}
      </div>

      <div className={styles.ragCard}>
        <div className={styles.head}>
          <h4 className={styles.h4}>Document Collections</h4>
          <span className={styles.dim}>click a collection to see and manage its documents</span>
          <span className={styles.spacer} />
          <button className={styles.btn} onClick={() => void store.load()}><RefreshCw size={13} /> Refresh</button>
        </div>
        {store.collections.length === 0 ? <div className={styles.muted}>No document collections indexed yet.</div> : (
          <table className={styles.ragTable}>
            <thead><tr><th>Name</th><th>Documents</th><th>Chunks</th><th>Types</th><th>Updated</th><th /></tr></thead>
            <tbody>
              {store.collections.map((c) => (
                <tr key={c.name} className={styles.clickRow} onClick={() => store.openDetail(c.name)} title="Open this collection's documents">
                  <td>
                    <div className={styles.bold}>{c.display_name || c.name}</div>
                    {c.description && <div className={styles.docSub}>{c.description}</div>}
                  </td>
                  <td>{c.files_indexed || 0}</td>
                  <td>{c.chunks_created || 0}</td>
                  <td className={styles.dim}>{types(c.file_types)}</td>
                  <td className={styles.dim}>{when(c.indexed_at)}</td>
                  <td className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
                    <button className={styles.iconBtn} title="Add documents to this collection" onClick={() => store.setCollection(c.display_name || c.name)}><Plus size={13} /></button>
                    <button className={styles.iconDanger} title="Delete collection" onClick={async () => { if (await confirmStore.confirm({ title: 'Delete collection', message: `Delete collection “${c.display_name || c.name}” and all ${c.files_indexed || 0} of its documents? Removes it from all vector DBs.`, confirmText: 'Delete' })) void store.deleteCollection(c.name) }}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ServerFileBrowser />
      <CollectionDetail />
    </div>
  )
})
