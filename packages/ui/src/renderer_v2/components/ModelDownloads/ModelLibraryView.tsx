import React, { useEffect, useRef } from 'react'
import { observer } from 'mobx-react-lite'
import {
  ChevronRight, ChevronDown, Folder, FolderPlus, Image as ImageIcon, X,
  Tag, ExternalLink, Type, Check, AlertTriangle, Loader2, Search,
} from 'lucide-react'
import { modelLibraryStore as lib, type LibItem, type TreeNode } from '../../stores/ModelLibraryStore'
import { promptStore } from '../../stores/promptStore'
import styles from './ModelLibrary.module.scss'

const mb = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`
const when = (s: string | null | undefined) => s ? new Date(s).toLocaleDateString() : '—'

/** Strip the HTML CivitAI descriptions ship — rendering it raw would inject markup. */
const plain = (html: string | null | undefined) =>
  !html ? '' : String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim()

// ── folder tree ──────────────────────────────────────────────────────────────────────
const TreeRow: React.FC<{ node: TreeNode; depth: number }> = observer(({ node, depth }) => {
  const open = lib.expanded.has(node.path)
  const active = lib.dir === node.path
  const isTarget = lib.dropTarget === node.path
  return (
    <>
      <div
        className={`${styles.treeRow} ${active ? styles.treeActive : ''} ${isTarget ? styles.treeDrop : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => void lib.open(node.path)}
        onDragOver={(e) => { e.preventDefault(); lib.dropTarget = node.path }}
        onDragLeave={() => { if (lib.dropTarget === node.path) lib.dropTarget = '' }}
        onDrop={(e) => {
          e.preventDefault()
          lib.dropTarget = ''
          const dragged = e.dataTransfer.getData('text/plain')
          void lib.moveTo(node.path, dragged && !lib.selected.has(dragged) ? [dragged] : undefined)
        }}
        title={`${node.totalModels} models`}
      >
        <span
          className={styles.treeCaret}
          onClick={(e) => { e.stopPropagation(); lib.toggleExpand(node.path) }}
        >
          {node.children.length > 0
            ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)
            : <span className={styles.caretGap} />}
        </span>
        <Folder size={12} className={styles.treeIcon} />
        <span className={styles.treeName}>{node.name || 'library'}</span>
        <span className={styles.treeCount}>{node.totalModels}</span>
      </div>
      {open && node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} />)}
    </>
  )
})

// ── one model card ───────────────────────────────────────────────────────────────────
const Card: React.FC<{ item: LibItem }> = observer(({ item }) => {
  const sel = lib.selected.has(item.path)
  return (
    <div
      className={`${styles.card} ${sel ? styles.cardSel : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', item.path)
        e.dataTransfer.effectAllowed = 'move'
        // Dragging an unselected card should move just it, not the stale selection.
        if (!lib.selected.has(item.path)) lib.toggleSelect(item.path, false)
      }}
      onClick={(e) => lib.toggleSelect(item.path, e.ctrlKey || e.metaKey || e.shiftKey)}
      onDoubleClick={() => void lib.showDetail(item.path)}
      title={item.name}
    >
      <div className={styles.thumbWrap}>
        {item.preview
          ? <img className={styles.thumb} src={lib.thumb(item.preview)} loading="lazy" alt="" />
          : <div className={styles.noThumb}><ImageIcon size={20} /></div>}
        {item.imageCount > 1 && <span className={styles.imgBadge}>{item.imageCount}</span>}
        {!item.tracked && <span className={styles.untracked} title="Not in the download history — rename by template is unavailable">untracked</span>}
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardName}>{item.modelName || item.base}</div>
        <div className={styles.cardMeta}>
          {item.baseModel && <span className={styles.chip}>{item.baseModel}</span>}
          {item.versionName && <span className={styles.dim}>{item.versionName}</span>}
        </div>
        <div className={styles.cardFile}>{item.name}</div>
        <div className={styles.cardFoot}>
          <span>{mb(item.size)}</span>
          <span>{when(item.downloadedAt)}</span>
        </div>
      </div>
    </div>
  )
})

// ── detail drawer ────────────────────────────────────────────────────────────────────
const Detail: React.FC = observer(() => {
  const d = lib.detail
  if (!d) return null
  const v = d.version
  const m = d.model
  const desc = plain(v?.description) || plain(m?.description)
  return (
    <div className={styles.detail}>
      <div className={styles.detailHead}>
        <div className={styles.detailTitle}>{d.history?.modelName || d.base}</div>
        <button className={styles.iconBtn} onClick={() => lib.closeDetail()} title="Close"><X size={14} /></button>
      </div>

      {d.media.length > 0 && (
        <div className={styles.gallery}>
          {d.media.map((mm, i) => (
            mm.kind === 'video'
              ? <video key={mm.path} className={styles.galleryItem} src={lib.image(mm.path)} muted loop
                       onMouseEnter={(e) => void (e.target as HTMLVideoElement).play()}
                       onMouseLeave={(e) => (e.target as HTMLVideoElement).pause()} />
              : <img key={mm.path} className={styles.galleryItem} src={lib.thumb(mm.path)} loading="lazy"
                     alt="" onClick={() => (lib.lightbox = i)} />
          ))}
        </div>
      )}

      <div className={styles.kv}>
        <div><span>File</span><code>{d.name}</code></div>
        <div><span>Folder</span><code>{d.dir}</code></div>
        <div><span>Size</span>{mb(d.size)}</div>
        {d.history && <>
          <div><span>Model</span>{d.history.modelName} <span className={styles.dim}>#{d.history.modelId}</span></div>
          <div><span>Version</span>{d.history.versionName} <span className={styles.dim}>#{d.history.versionId}</span></div>
          <div><span>Type</span>{d.history.modelType}</div>
          <div><span>Base</span>{d.history.baseModel}</div>
          <div><span>Creator</span>{d.history.creator || '—'}</div>
          <div><span>Downloaded</span>{when(d.history.downloadedAt)}</div>
        </>}
        {v && v.trainedWords && v.trainedWords.length > 0 && (
          <div className={styles.kvWide}>
            <span>Trigger words</span>
            <div className={styles.triggers}>
              {v.trainedWords.map((w: string) => (
                <code key={w} className={styles.trigger} title="Click to copy"
                      onClick={() => void navigator.clipboard?.writeText(w)}>{w}</code>
              ))}
            </div>
          </div>
        )}
        {m && m.tags && m.tags.length > 0 && (
          <div className={styles.kvWide}>
            <span>Tags</span>
            <div className={styles.tags}>
              {m.tags.slice(0, 24).map((t: string) => (
                <span key={t} className={styles.tag}><Tag size={9} /> {t}</span>
              ))}
            </div>
          </div>
        )}
        {v && v.files && v.files.length > 0 && (
          <div className={styles.kvWide}>
            <span>Version files</span>
            <div className={styles.fileList}>
              {v.files.map((f: any) => (
                <div key={f.id} className={styles.fileRow}>
                  <code>{f.name}</code>
                  <span className={styles.dim}>{f.fp || ''} {f.format || ''} {f.sizeKB ? `${(f.sizeKB / 1024).toFixed(0)} MB` : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {desc && <div className={styles.kvWide}><span>Description</span><div className={styles.desc}>{desc}</div></div>}
        {d.sidecars.length > 0 && (
          <div className={styles.kvWide}><span>Sidecars</span>
            <div className={styles.dim}>{d.sidecars.join(', ')}</div></div>
        )}
        {d.history?.pageUrl && (
          <div className={styles.kvWide}>
            <a className={styles.link} href={d.history.pageUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={11} /> Open on CivitAI
            </a>
          </div>
        )}
      </div>

      {lib.lightbox !== null && d.media[lib.lightbox] && (
        <div className={styles.lightbox} onClick={() => (lib.lightbox = null)}>
          <img src={lib.image(d.media[lib.lightbox!].path)} alt="" />
        </div>
      )}
    </div>
  )
})

// ── template rename dialog ───────────────────────────────────────────────────────────
const VARS = ['$PRIMARY_TAG', '$REPO_NAME', '$MODEL_FILE_NAME', '$VERSION_NAME', '$VERSION_ID',
  '$BASE_MODEL_SHORT', '$BASE_MODEL_LONG', '$CREATOR_NAME', '$MODEL_TYPE', '$QUANT_LEVEL', '$UPLOAD_DATE']

const RenameDialog: React.FC = observer(() => {
  if (!lib.renameOpen) return null
  const ok = lib.renameChanged
  const bad = lib.renameProblems
  return (
    <div className={styles.modalWrap} onClick={() => lib.closeRename()}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHead}>
          <Type size={14} /> <span>Rename {lib.selected.size} by template</span>
          <div className={styles.spacer} />
          <button className={styles.iconBtn} onClick={() => lib.closeRename()}><X size={14} /></button>
        </div>

        <div className={styles.tplRow}>
          <input className={styles.tplInput} value={lib.template} spellCheck={false}
                 onChange={(e) => (lib.template = e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && void lib.previewRename()} />
          <button className={styles.btn} disabled={lib.renamePreviewing} onClick={() => void lib.previewRename()}>
            {lib.renamePreviewing ? <Loader2 size={12} className={styles.spin} /> : <Search size={12} />} Preview
          </button>
        </div>
        <div className={styles.varRow}>
          {VARS.map((vv) => (
            <button key={vv} className={styles.varChip}
                    onClick={() => { lib.template = lib.template + (lib.template.endsWith('-') || !lib.template ? '' : '-') + vv; void lib.previewRename() }}>
              {vv}
            </button>
          ))}
        </div>

        <div className={styles.previewList}>
          {lib.renameRows.length === 0 && !lib.renamePreviewing && <div className={styles.dim}>No preview yet.</div>}
          {lib.renameRows.map((r) => (
            <div key={r.path} className={`${styles.prevRow} ${r.error || r.collision ? styles.prevBad : ''}`}>
              <code className={styles.prevOld}>{r.name}</code>
              <span className={styles.prevArrow}>→</span>
              {r.error
                ? <span className={styles.prevErr}><AlertTriangle size={11} /> {r.error}</span>
                : r.collision
                  ? <span className={styles.prevErr}><AlertTriangle size={11} /> collides with {r.collision}</span>
                  : <code className={r.unchanged ? styles.dim : styles.prevNew}>{r.newName}{r.unchanged ? '  (unchanged)' : ''}</code>}
            </div>
          ))}
        </div>

        <div className={styles.modalFoot}>
          <span className={styles.dim}>
            {ok.length} will change{bad.length ? ` · ${bad.length} skipped` : ''}
          </span>
          <div className={styles.spacer} />
          <button className={styles.btn} onClick={() => lib.closeRename()}>Cancel</button>
          <button className={styles.btnPrimary} disabled={!ok.length || lib.renameApplying}
                  onClick={() => void lib.applyRename()}>
            {lib.renameApplying ? <Loader2 size={12} className={styles.spin} /> : <Check size={12} />} Rename {ok.length}
          </button>
        </div>
      </div>
    </div>
  )
})

// ── the view ─────────────────────────────────────────────────────────────────────────
export const ModelLibraryView: React.FC = observer(() => {
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void lib.loadTree()
    void lib.open(lib.dir)
  }, [])

  return (
    <div className={styles.wrap}>
      <div className={styles.treePane}>
        <div className={styles.paneHead}>
          <span>Folders</span>
          <button className={styles.iconBtn} title="New folder in the open directory"
                  onClick={async () => {
                    const name = await promptStore.prompt({
                      title: 'New folder', label: `Inside ${lib.dir}`, placeholder: 'folder name',
                    })
                    if (name) { await lib.mkdir(`${lib.dir}/${name}`); lib.msg = `Created ${name}.` }
                  }}>
            <FolderPlus size={13} />
          </button>
        </div>
        <div className={styles.treeScroll}>
          {lib.tree ? <TreeRow node={lib.tree} depth={0} /> : <div className={styles.dim}>Loading…</div>}
        </div>
      </div>

      <div className={styles.mainPane}>
        <div className={styles.toolbar}>
          <code className={styles.crumb}>{lib.dir || 'library'}</code>
          <span className={styles.dim}>{lib.visible.length} models</span>
          <input className={styles.search} placeholder="Filter…" value={lib.filter}
                 onChange={(e) => (lib.filter = e.target.value)} />
          <div className={styles.spacer} />
          {lib.selected.size > 0 && <>
            <span className={styles.selCount}>{lib.selected.size} selected</span>
            <button className={styles.btn} onClick={() => lib.clearSelection()}>Clear</button>
            <button className={styles.btnPrimary} onClick={() => lib.openRename()}><Type size={12} /> Rename…</button>
          </>}
          {lib.selected.size === 0 && lib.visible.length > 0 &&
            <button className={styles.btn} onClick={() => lib.selectAll()}>Select all</button>}
        </div>

        {lib.msg && <div className={styles.msg} onClick={() => (lib.msg = '')}>{lib.msg}</div>}
        {lib.error && <div className={styles.err}>{lib.error}</div>}

        <div className={styles.gridScroll}>
          {lib.subdirs.length > 0 && (
            <div className={styles.subdirRow}>
              {lib.subdirs.map((s) => (
                <button key={s} className={`${styles.subdir} ${lib.dropTarget === `${lib.dir}/${s}` ? styles.treeDrop : ''}`}
                        onClick={() => void lib.open(`${lib.dir}/${s}`)}
                        onDragOver={(e) => { e.preventDefault(); lib.dropTarget = `${lib.dir}/${s}` }}
                        onDragLeave={() => { if (lib.dropTarget === `${lib.dir}/${s}`) lib.dropTarget = '' }}
                        onDrop={(e) => {
                          e.preventDefault(); lib.dropTarget = ''
                          const dragged = e.dataTransfer.getData('text/plain')
                          void lib.moveTo(`${lib.dir}/${s}`, dragged && !lib.selected.has(dragged) ? [dragged] : undefined)
                        }}>
                  <Folder size={12} /> {s}
                </button>
              ))}
            </div>
          )}
          {lib.loading
            ? <div className={styles.dim}>Loading…</div>
            : lib.visible.length === 0
              ? <div className={styles.dim}>No models here.</div>
              : <div className={styles.grid}>{lib.visible.map((i) => <Card key={i.path} item={i} />)}</div>}
        </div>
      </div>

      {(lib.detail || lib.detailLoading) && (
        <div className={styles.detailPane}>
          {lib.detailLoading ? <div className={styles.dim}>Loading…</div> : <Detail />}
        </div>
      )}

      <RenameDialog />
    </div>
  )
})
