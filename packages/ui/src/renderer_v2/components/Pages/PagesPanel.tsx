import React, { useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import {
  BookOpen,
  Search,
  Check,
  Copy,
  FileCode,
  FileText,
  History,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import type { PageContentType } from '@gyshell/shared'
import { pagesStore as store } from '../../stores/PagesStore'
import { buildPageSrcdoc, needsMermaid, PAGE_SANDBOX, SANDBOX_PROBE_HTML } from '../../lib/pageSandbox'
import styles from './Pages.module.scss'

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString()
}

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

/** In-page editor overlay (standard #2 — no native dialogs). Plain source, deliberately not a WYSIWYG. */
const EditOverlay: React.FC<{
  initial?: { id: string; title: string; contentType: PageContentType; body: string }
  onClose: () => void
}> = observer(({ initial, onClose }) => {
  const [id, setId] = useState(initial?.id ?? '')
  const [title, setTitle] = useState(initial?.title ?? '')
  const [contentType, setContentType] = useState<PageContentType>(initial?.contentType ?? 'markdown')
  const [body, setBody] = useState(initial?.body ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const canSave = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) && title.trim() && body.trim() && !busy
  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setErr(null)
    try {
      await store.write(id, { title: title.trim(), contentType, body })
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.overlayCard}>
        <div className={styles.overlayHead}>
          <span>{initial ? `Edit ${initial.id} (writes a new version)` : 'New scoping page'}</span>
          <button type="button" className={styles.iconBtn} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className={styles.formRow}>
          <input className={styles.field} placeholder="page-id (slug)" value={id} disabled={!!initial}
            onChange={(e) => setId(e.target.value)} />
          <select className={styles.field} value={contentType}
            onChange={(e) => setContentType(e.target.value as PageContentType)}>
            <option value="markdown">markdown</option>
            <option value="html">html</option>
          </select>
        </div>
        <input className={styles.field} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className={styles.editor} value={body} spellCheck={false}
          placeholder={contentType === 'markdown' ? '# Markdown source…' : '<!-- HTML source… -->'}
          onChange={(e) => setBody(e.target.value)} />
        {err && <div className={styles.errorNote}>{err}</div>}
        <button type="button" className={styles.primaryBtn} disabled={!canSave} onClick={() => void save()}>
          Save version
        </button>
      </div>
    </div>
  )
})

/**
 * Pages tab: a render surface for agent-written documents. Pages display in a
 * sandboxed iframe (allow-scripts, NEVER allow-same-origin — see pageSandbox.ts)
 * with versions listed and restorable. Not shareable, by decision: no public
 * routes, everything stays inside this tab.
 */
export const PagesPanel: React.FC = observer(() => {
  const [editing, setEditing] = useState<null | 'new' | 'edit'>(null)
  const [showSource, setShowSource] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [probe, setProbe] = useState<null | 'running' | { pass: boolean; summary: string }>(null)
  const [searchDraft, setSearchDraft] = useState('')

  useEffect(() => {
    void store.ensureLoaded()
  }, [])

  // Sandbox self-test results arrive from the probe page via postMessage.
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const p = (ev.data as any)?.__pageProbe
      if (!p) return
      setProbe({
        pass: p.pass === true,
        summary: (p.checks ?? [])
          .map((c: any) => `${c.escaped ? 'ESCAPED' : 'blocked'} ${c.name}`)
          .join(' · '),
      })
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Mermaid is ~3.4MB, so it loads as a lazy chunk the FIRST time a page needs
  // it, then rides inline into the sandbox (the CSP forbids external scripts —
  // the library travels as source text, never a URL).
  const [mermaidLib, setMermaidLib] = useState<string | null>(null)
  const wantMermaid = !!store.current && needsMermaid(store.current.html)
  useEffect(() => {
    if (!wantMermaid || mermaidLib) return
    let cancelled = false
    void import('mermaid/dist/mermaid.min.js?raw').then((m) => {
      if (!cancelled) setMermaidLib(m.default)
    })
    return () => {
      cancelled = true
    }
  }, [wantMermaid, mermaidLib])

  const doc = useMemo(() => {
    if (probe === 'running') return buildPageSrcdoc(SANDBOX_PROBE_HTML, currentTheme())
    // Reports render through the SAME sandbox as pages — agent-authored HTML is
    // agent-authored HTML whichever surface it came from.
    if (store.currentReport) return buildPageSrcdoc(store.currentReport.html, currentTheme())
    if (!store.current) return null
    if (wantMermaid && !mermaidLib) return buildPageSrcdoc('<p>Loading diagram renderer…</p>', currentTheme())
    return buildPageSrcdoc(store.current.html, currentTheme(), wantMermaid ? mermaidLib ?? undefined : undefined)
  }, [store.current, probe, wantMermaid, mermaidLib])

  if (!store.available) {
    return (
      <div className={styles.panel}>
        <div className={styles.empty}>Pages unavailable — backend too old or bridge missing.</div>
      </div>
    )
  }

  const cur = store.current
  const rep = store.currentReport
  const copySource = async () => {
    const src = cur ?? rep
    if (!src) return
    try {
      await navigator.clipboard.writeText(showSource ? src.source : src.html)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard denied — the source view still allows manual selection */
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.list}>
        <div className={styles.listHead}>
          <span className={styles.title}>
            <BookOpen size={15} /> Pages
          </span>
          <button type="button" className={styles.iconBtn} title="Refresh" onClick={() => { void store.refresh(); if (store.view === 'journal') void store.loadJournal() }}>
            <RefreshCw size={13} />
          </button>
          <button type="button" className={styles.newBtn} onClick={() => setEditing('new')}>
            <Plus size={12} /> New page
          </button>
        </div>
        <div className={styles.subTabs}>
          {([['documents', 'Documents'], ['reports', 'Reports'], ['journal', 'Journal']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`${styles.subTab} ${store.view === id ? styles.subTabActive : ''}`}
              onClick={() => store.setView(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {store.view !== 'documents' && store.reportTypes.length > 0 && (
          <div className={styles.catRow}>
            <button
              type="button"
              className={`${styles.catChip} ${store.typeFilter === null ? styles.catActive : ''}`}
              onClick={() => store.setTypeFilter(null)}
            >
              all
            </button>
            {store.reportTypes.map((c: { id: string; label: string; description?: string }) => (
              <button
                key={c.id}
                type="button"
                title={c.description}
                className={`${styles.catChip} ${store.typeFilter === c.id ? styles.catActive : ''}`}
                onClick={() => store.setTypeFilter(store.typeFilter === c.id ? null : c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        {store.view === 'reports' && (
          <div className={styles.searchRow}>
            <Search size={12} />
            <input
              className={styles.searchInput}
              placeholder="Search reports (semantic)…"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void store.searchReports(searchDraft)
                if (e.key === 'Escape') { setSearchDraft(''); store.clearSearch() }
              }}
            />
            {store.searchResults !== null && (
              <button type="button" className={styles.iconBtn} onClick={() => { setSearchDraft(''); store.clearSearch() }}>
                <X size={12} />
              </button>
            )}
          </div>
        )}
        {store.error && <div className={styles.errorNote}>{store.error}</div>}
        <div className={styles.rows}>
          {store.view === 'journal' ? (
            store.journal.length === 0 ? (
              <div className={styles.empty}>
                The journal is empty. Entries are started when work begins and grow as it
                proceeds — including the "looked at it, nothing to repair" ones, which are
                exactly the entries nobody remembers otherwise.
              </div>
            ) : (
              store.journal.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  className={styles.row}
                  onClick={() => { if (j.reportIds?.[0]) void store.openReport(j.reportIds[0]) }}
                >
                  <div className={styles.rowTitle}>
                    <span className={`${styles.statusBadge} ${styles[`st_${j.status}`] ?? ''}`}>{j.status}</span>
                    {j.issue}
                  </div>
                  <div className={styles.rowMeta}>
                    {fmtTime(j.updatedAt)}{j.author ? ` · ${j.author}` : ''}
                    {j.revisions?.length ? ` · ${j.revisions.length} revision(s)` : ''}
                    {j.keys?.length ? ` · ${j.keys.join(' ')}` : ''}
                    {/* An entry that cannot serve as a prior occurrence says so
                        here too, so the list never implies a coverage it lacks. */}
                    {j.excludedFromCounts ? ' · record only, not counted' : ''}
                  </div>
                  {j.notes && <div className={styles.journalLine}>{j.notes.replace(/\n+/g, ' ').slice(0, 160)}</div>}
                  {j.reportIds?.length > 0 && (
                    <div className={styles.journalLink}>reports: {j.reportIds.join(', ')}</div>
                  )}
                </button>
              ))
            )
          ) : store.view === 'reports' && store.searchResults !== null ? (
            <>
              <div className={styles.empty} style={{ padding: '8px 12px', textAlign: 'left' }}>
                {store.searching ? 'Searching…' : `${store.searchResults.length} semantic match(es)`}
              </div>
              {store.searchResults.map((r, i) => (
                r.error ? (
                  <div key={`err-${i}`} className={styles.errorNote}>{r.category}: search unavailable — {r.error}</div>
                ) : (
                  <button
                    key={`${r.pageId}-${i}`}
                    type="button"
                    className={styles.row}
                    onClick={() => r.pageId && void store.open(r.pageId)}
                  >
                    <div className={styles.rowTitle}>{r.pageId}</div>
                    <div className={styles.rowMeta}>{store.typeLabel(r.category)}{r.score !== undefined ? ` · score ${r.score}` : ''}</div>
                    <div className={styles.journalLine}>{String(r.text ?? '').slice(0, 160)}</div>
                  </button>
                )
              ))}
            </>
          ) : store.view === 'reports' ? (
            store.reports.length === 0 ? (
              <div className={styles.empty}>
                No reports yet. Agents file them with their Reports toolset — each report has a
                type (maintenance, security, vulnerability…) and is searchable within it.
              </div>
            ) : (
              store.reports.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`${styles.row} ${r.id === store.selectedId ? styles.active : ''}`}
                  onClick={() => { setProbe(null); setShowSource(false); void store.openReport(r.id) }}
                >
                  <div className={styles.rowTitle}>{r.title}</div>
                  <div className={styles.rowMeta}>
                    <span className={styles.typeBadge}>{store.typeLabel(r.type)}</span>
                    {r.id} · v{r.currentVersion} · {fmtTime(r.updatedAt)}
                  </div>
                  {r.summary && <div className={styles.journalLine}>{r.summary}</div>}
                  {r.authors?.length > 0 && <div className={styles.rowMeta}>by {r.authors.join(' + ')}</div>}
                </button>
              ))
            )
          ) : store.documents.length === 0 ? (
            <div className={styles.empty}>
              No scoping pages yet. Agents write them with their Pages toolset; you can also
              create one here.
            </div>
          ) : (
            store.documents.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`${styles.row} ${p.id === store.selectedId ? styles.active : ''}`}
                onClick={() => { setProbe(null); setShowSource(false); setConfirmDelete(false); void store.open(p.id) }}
              >
                <div className={styles.rowTitle}>{p.title}</div>
                <div className={styles.rowMeta}>
                  {p.contentType === 'markdown' ? <FileText size={10} /> : <FileCode size={10} />} {p.id} · v
                  {p.currentVersion}
                  {p.versionCount > 1 ? ` (${p.versionCount} versions)` : ''} · {fmtTime(p.updatedAt)}
                </div>
                {p.authors.length > 0 && <div className={styles.rowMeta}>by {p.authors.join(' + ')}</div>}
              </button>
            ))
          )}
        </div>
        <div className={styles.listFoot}>
          <button
            type="button"
            className={styles.selfTestBtn}
            title="Load a page that ATTEMPTS to escape the sandbox (parent DOM, storage, backend API, LAN, external web) and report every result. All attempts must fail."
            onClick={() => {
              setProbe('running')
              store.close()
            }}
          >
            <ShieldCheck size={12} /> Sandbox self-test
          </button>
          {probe && probe !== 'running' && (
            <span className={probe.pass ? styles.probePass : styles.probeFail}>
              {probe.pass ? 'PASS — boundary held' : 'FAIL — BOUNDARY BROKEN'} · {probe.summary}
            </span>
          )}
        </div>
      </div>

      <div className={styles.view}>
        {rep && probe !== 'running' && (
          <div className={styles.viewHead}>
            <span className={styles.viewTitle}>{rep.meta.title}</span>
            <span className={styles.typeBadge}>{store.typeLabel(rep.meta.type)}</span>
            <span className={styles.authors}>
              v{rep.version}/{rep.meta.currentVersion}
              {rep.meta.authors.length ? ` · by ${rep.meta.authors.join(' + ')}` : ''}
            </span>
            <span className={styles.spacer} />
            <button type="button" className={`${styles.toolBtn} ${showSource ? styles.activeTool : ''}`}
              onClick={() => setShowSource((v) => !v)}>
              <FileCode size={13} /> source
            </button>
            <button type="button" className={styles.toolBtn} onClick={() => void copySource()}>
              {copied ? <Check size={13} /> : <Copy size={13} />} copy
            </button>
          </div>
        )}
        {cur && probe !== 'running' && (
          <div className={styles.viewHead}>
            <span className={styles.viewTitle}>{cur.meta.title}</span>
            {cur.meta.authors.length > 0 && (
              <span className={styles.authors} title="Every version records its author — the version picker is the per-edit audit trail.">
                by {cur.meta.authors.join(' + ')}
              </span>
            )}
            <span className={styles.versionWrap} title="Version history — pick one to view; Restore copies it forward as a new version.">
              <History size={12} />
              <select
                className={styles.versionSelect}
                value={cur.version}
                onChange={(e) => void store.open(cur.meta.id, Number(e.target.value))}
              >
                {[...cur.meta.versions].reverse().map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                    {v.version === cur.meta.currentVersion ? ' (latest)' : ''}
                    {v.restoredFrom ? ` ← v${v.restoredFrom}` : ''} · {fmtTime(v.createdAt)}
                    {v.author ? ` · ${v.author}` : ''}
                  </option>
                ))}
              </select>
            </span>
            {cur.version !== cur.meta.currentVersion && (
              <button type="button" className={styles.newBtn} onClick={() => void store.restore(cur.version)}>
                Restore this version
              </button>
            )}
            <span className={styles.spacer} />
            <button
              type="button"
              className={`${styles.toolBtn} ${showSource ? styles.activeTool : ''}`}
              title="Toggle rendered / source view"
              onClick={() => setShowSource((s) => !s)}
            >
              <FileCode size={13} /> source
            </button>
            <button type="button" className={styles.toolBtn} title="Copy the full source to the clipboard" onClick={() => void copySource()}>
              {copied ? <Check size={13} /> : <Copy size={13} />} copy
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() =>
                setEditing('edit')
              }
            >
              edit
            </button>
            {confirmDelete ? (
              <button
                type="button"
                className={`${styles.toolBtn} ${styles.dangerTool}`}
                title="Moves the page to trash on the backend (recoverable)"
                onClick={() => {
                  setConfirmDelete(false)
                  void store.remove(cur.meta.id)
                }}
              >
                <Trash2 size={13} /> really delete?
              </button>
            ) : (
              <button type="button" className={styles.toolBtn} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={13} />
              </button>
            )}
          </div>
        )}
        {store.loading ? (
          <div className={styles.empty}>Loading…</div>
        ) : doc && !showSource ? (
          // The security boundary: allow-scripts only. NEVER add allow-same-origin.
          <iframe className={styles.frame} sandbox={PAGE_SANDBOX} srcDoc={doc} title={cur?.meta.title ?? 'page'} />
        ) : doc && showSource && (cur ?? rep) ? (
          <pre className={styles.sourceView}>{(cur ?? rep)!.source}</pre>
        ) : (
          <div className={styles.empty}>Select a page, create one, or run the sandbox self-test.</div>
        )}
      </div>

      {editing && (
        <EditOverlay
          initial={
            editing === 'edit' && cur
              ? { id: cur.meta.id, title: cur.meta.title, contentType: cur.meta.contentType, body: cur.source }
              : undefined
          }
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
})
