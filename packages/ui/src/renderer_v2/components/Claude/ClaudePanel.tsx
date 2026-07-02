import React, { useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Plus, Trash2, RefreshCw, Save, RotateCcw, Terminal as TermIcon } from 'lucide-react'
import { claudeStore as store, CLAUDE_FILES } from '../../stores/ClaudeStore'
import { claudeInstancesStore as instancesStore } from '../../stores/ClaudeInstancesStore'
import { confirmStore } from '../../stores/confirmStore'
import { uiPrefsStore } from '../../stores/uiPrefsStore'
import { InstanceView } from './InstanceView'
import { SpawnInstanceView } from './SpawnInstanceView'
import styles from './Claude.module.scss'

const DIRECTIVES = '__directives__'
const ADD = '__add__'
const SPAWN = '__spawn__'
const INSTANCE_PREFIX = 'inst:'

/** Resizable element whose height persists to the backend (uiPrefsStore), keyed per consumer. */
function usePersistedHeight(key: string, def: number) {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !uiPrefsStore.loaded) return
    let first = true // ignore the initial layout measurement — only persist user drags
    const ro = new ResizeObserver(() => {
      if (first) { first = false; return }
      const h = Math.round(el.offsetHeight)
      if (h && h !== uiPrefsStore.get(key, def)) uiPrefsStore.set(key, h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [key, uiPrefsStore.loaded])
  return { ref, height: uiPrefsStore.get(key, def) as number }
}

const FileEditor: React.FC<{ connId: string }> = observer(({ connId }) => {
  const { ref, height } = usePersistedHeight(`claudeFile:${connId}`, 480)
  const [file, setFile] = useState('CLAUDE.md')
  const [content, setContent] = useState('')
  const [orig, setOrig] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const loadFile = async (name: string) => {
    setFile(name); setStatus('Loading…')
    const r = await store.getFile(connId, name)
    setContent(r?.content || ''); setOrig(r?.content || ''); setStatus(r?.error ? `Error: ${r.error}` : r?.missing ? '(file does not exist yet)' : '')
  }
  useEffect(() => { void loadFile('CLAUDE.md') }, [connId])
  const save = async () => {
    setBusy(true); setStatus('Saving…')
    try { await store.saveFile(connId, file, content); setOrig(content); setStatus('Saved') }
    catch (e: any) { setStatus('Save failed: ' + (e?.message || e)) }
    finally { setBusy(false) }
  }
  return (
    <div className={styles.editor}>
      <div className={styles.fileTabs}>
        {CLAUDE_FILES.map((f) => <button key={f} className={`${styles.fileTab} ${file === f ? styles.fileTabActive : ''}`} onClick={() => loadFile(f)}>{f}</button>)}
        <span className={styles.spacer} />
        <span className={styles.dim}>{status}</span>
        <button className={styles.btn} onClick={() => void loadFile(file)}><RefreshCw size={12} /> Reload</button>
        <button className={styles.btnPrimary} disabled={busy || content === orig} onClick={() => void save()}><Save size={12} /> Save</button>
      </div>
      <textarea ref={ref as any} style={{ height }} className={styles.code} spellCheck={false} value={content} onChange={(e) => setContent(e.target.value)} />
    </div>
  )
})

const ConnectionView: React.FC<{ conn: any }> = observer(({ conn }) => {
  const { ref: termRef, height: termHeight } = usePersistedHeight(`claudeTerm:${conn.id}`, 960)
  const [restartMsg, setRestartMsg] = useState('')
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupLog, setSetupLog] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const runSetup = async () => {
    setSetupBusy(true); setSetupLog('Provisioning ttyd + session + boot auto-start…')
    const r = await store.setup(conn.id)
    setSetupLog(r?.error ? `Error: ${r.error}` : (r?.log || '') + (r?.ok ? '\n\n✓ terminal active' : '\n\n⚠ not active — see log'))
    setSetupBusy(false); await store.load(); setReloadKey((k) => k + 1)
  }
  return (
    <div className={styles.connView}>
      <div className={styles.connHead}>
        <strong>{conn.name}</strong>
        <span className={styles.dim}>CT {conn.vmid} · {conn.node || conn.nodeIp} · {conn.workspacePath}{conn.provisioned ? ' · ✓ provisioned' : ''}</span>
        <span className={styles.spacer} />
        <button className={styles.btn} disabled={setupBusy} onClick={() => void runSetup()}><TermIcon size={13} /> {conn.provisioned ? 'Re-provision' : 'Set up terminal'}</button>
        {conn.restartCommand && <button className={styles.btn} onClick={async () => { setRestartMsg('Restarting…'); const r = await store.restart(conn.id); setRestartMsg(r?.ok ? 'Restarted' : `Failed: ${r?.error || r?.stderr || r?.code}`) }}><RotateCcw size={13} /> Restart</button>}
        <button className={styles.btnDanger} onClick={async () => { if (await confirmStore.confirm({ title: 'Remove connection', message: `Remove the “${conn.name}” connection from the Claude tab? (does not touch the container)`, confirmText: 'Remove' })) void store.deleteConnection(conn.id) }}><Trash2 size={13} /> Remove</button>
      </div>
      {restartMsg && <div className={styles.dim}>{restartMsg}</div>}
      {setupLog && <pre className={styles.setupLog}>{setupLog}</pre>}

      {conn.provisioned
        ? <div ref={termRef as any} className={styles.termWrap} style={{ height: termHeight }}><iframe key={reloadKey} className={styles.term} src={`${store.termUrl(conn.id)}?cb=${reloadKey}`} title={`${conn.name} terminal`} sandbox="allow-scripts allow-same-origin allow-forms" /></div>
        : <div className={styles.termPlaceholder}><TermIcon size={16} /> No live terminal yet — click “Set up terminal” to install ttyd + the auto-starting Claude session on this container.</div>}

      <FileEditor connId={conn.id} />
    </div>
  )
})

const DirectivesView: React.FC = observer(() => {
  const { ref, height } = usePersistedHeight('claudeDirectives', 520)
  const [content, setContent] = useState('')
  const [orig, setOrig] = useState('')
  const [status, setStatus] = useState('Loading…')
  const [busy, setBusy] = useState(false)
  useEffect(() => { void (async () => { const r = await store.getDirectives(); setContent(r?.content || ''); setOrig(r?.content || ''); setStatus(r?.error ? `Error: ${r.error}` : '') })() }, [])
  const save = async () => { setBusy(true); setStatus('Saving…'); try { await store.saveDirectives(content); setOrig(content); setStatus('Saved') } catch (e: any) { setStatus('Save failed: ' + (e?.message || e)) } finally { setBusy(false) } }
  return (
    <div className={styles.editor}>
      <div className={styles.fileTabs}>
        <strong>Central Directives</strong>
        <span className={styles.dim}>shared /claude/CENTRAL-DIRECTIVES.md — applies to all instances</span>
        <span className={styles.spacer} />
        <span className={styles.dim}>{status}</span>
        <button className={styles.btnPrimary} disabled={busy || content === orig} onClick={() => void save()}><Save size={12} /> Save</button>
      </div>
      <textarea ref={ref as any} style={{ height }} className={styles.code} spellCheck={false} value={content} onChange={(e) => setContent(e.target.value)} />
    </div>
  )
})

const AddView: React.FC<{ onAdded: (id: string) => void }> = observer(({ onAdded }) => {
  const [sel, setSel] = useState('')
  const [name, setName] = useState('')
  const [ws, setWs] = useState('/root')
  const [restartCommand, setRestartCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [candidates, setCandidates] = useState<{ dir: string; files: string[] }[]>([])
  const [cwds, setCwds] = useState<string[]>([])
  const [detectMsg, setDetectMsg] = useState('')
  const pick = async (vmid: string) => {
    setSel(vmid)
    const c = store.lxc.find((l) => String(l.vmid) === String(vmid))
    if (!c) return
    if (!name) setName(c.name)
    setCandidates([]); setCwds([]); setDetectMsg(''); setDetecting(true)
    const r = await store.detectWorkspace(c.node, c.vmid)
    setDetecting(false)
    if (r?.error) { setDetectMsg('Auto-detect failed: ' + r.error); return }
    setCandidates(r.candidates || []); setCwds(r.cwds || [])
    if (r.best) setWs(r.best)
    setDetectMsg((r.candidates || []).length ? `Found the agent files in ${(r.candidates || []).length} location(s) — auto-selected the best match.` : 'No CLAUDE/RULES/MEMORY/TOOLS files found in the usual spots — set the path manually.')
  }
  const add = async () => {
    const c = store.lxc.find((l) => String(l.vmid) === String(sel))
    if (!c || !name.trim()) { setErr('Pick a container and name it'); return }
    setBusy(true); setErr('')
    try {
      const r = await store.addConnection({ name: name.trim(), vmid: c.vmid, node: c.node, containerIp: c.ip, workspacePath: ws.trim() || '/root', restartCommand: restartCommand.trim() })
      setErr(''); setBusy(true)
      // fully-automatic provisioning on add (install ttyd + auto-starting Claude session)
      const setupRes = await store.setup(r?.id)
      await store.load()
      onAdded(r?.id)
      if (setupRes?.error) setErr('Added, but provisioning failed: ' + setupRes.error)
    } catch (e: any) { setErr(e?.message || String(e)) } finally { setBusy(false) }
  }
  return (
    <div className={styles.addForm}>
      <h4 className={styles.h4}>Add Claude Connection</h4>
      <label className={styles.field}><span>Container</span>
        <select value={sel} onChange={(e) => void pick(e.target.value)}>
          <option value="">Select an LXC…</option>
          {store.lxc.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((l) => <option key={l.vmid} value={l.vmid}>{l.name} (CT {l.vmid} · {l.node}{l.ip ? ` · ${l.ip}` : ''})</option>)}
        </select>
      </label>
      <label className={styles.field}><span>Display name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DHB-Claude" /></label>
      <label className={styles.field}><span>Workspace path — directory that holds this instance's CLAUDE.md / RULES.md / MEMORY.md / TOOLS.md {detecting && <em>· detecting…</em>}</span><input value={ws} onChange={(e) => setWs(e.target.value)} placeholder="auto-detected when you pick a container" /></label>
      {detectMsg && <p className={styles.dim}>{detectMsg}</p>}
      {candidates.length > 0 && (
        <div className={styles.detectRow}>
          {candidates.map((c) => (
            <button key={c.dir} type="button" className={`${styles.detectChip} ${ws === c.dir ? styles.detectChipActive : ''}`} onClick={() => setWs(c.dir)} title={`contains: ${c.files.join(', ')}`}>
              {c.dir} <span className={styles.detectFiles}>{c.files.length}/4</span>
            </button>
          ))}
        </div>
      )}
      {cwds.length > 0 && <p className={styles.dim}>Claude Code running dir{cwds.length > 1 ? 's' : ''}: {cwds.join(', ')} (working folder ≠ where the .md files live — the chips above are the file locations).</p>}
      <label className={styles.field}><span>Restart command (optional, run via pct exec)</span><input value={restartCommand} onChange={(e) => setRestartCommand(e.target.value)} placeholder="systemctl restart openclaw-claude.service" /></label>
      {err && <div className={styles.error}>{err}</div>}
      <button className={styles.btnPrimary} disabled={busy || !sel || !name.trim()} onClick={() => void add()}><Plus size={13} /> Add Connection</button>
      <p className={styles.dim}>Phase 2 will auto-detect Claude Code on the container and configure boot auto-start + a ttyd terminal.</p>
    </div>
  )
})

const INSTANCE_DOT: Record<string, string> = {
  running: 'instDotRunning',
  stopped: 'instDotStopped',
  'needs-login': 'instDotAuth',
  starting: 'instDotStarting',
}

export const ClaudePanel: React.FC = observer(() => {
  useEffect(() => {
    if (!store.loaded) void store.load()
    void instancesStore.ensureLoaded()
    void uiPrefsStore.ensureLoaded()
  }, [])
  const [active, setActiveState] = useState<string>(DIRECTIVES)
  const restored = useRef(false)
  // Restore the last-viewed sub-tab once prefs + connections have loaded (fall back if it's a stale connection).
  useEffect(() => {
    if (restored.current || !uiPrefsStore.loaded || !store.loaded || !instancesStore.loaded) return
    restored.current = true
    const saved = uiPrefsStore.get('claudeActiveTab', DIRECTIVES) as string
    const isInstance = saved.startsWith(INSTANCE_PREFIX) && instancesStore.instances.some((i) => INSTANCE_PREFIX + i.id === saved)
    if (saved === DIRECTIVES || saved === ADD || saved === SPAWN || isInstance || store.connections.some((c) => c.id === saved)) setActiveState(saved)
  }, [uiPrefsStore.loaded, store.loaded, instancesStore.loaded])
  const setActive = (id: string) => { setActiveState(id); uiPrefsStore.set('claudeActiveTab', id) }
  const conn = store.connections.find((c) => c.id === active)
  const instance = active.startsWith(INSTANCE_PREFIX)
    ? instancesStore.instances.find((i) => INSTANCE_PREFIX + i.id === active)
    : undefined

  return (
    <div className={styles.panel}>
      <div className={styles.subNav}>
        {/* Consolidated CT161 instances (fleet-consolidation Phase 3) */}
        {instancesStore.instances.map((i) => (
          <button
            key={INSTANCE_PREFIX + i.id}
            className={`${styles.navTab} ${active === INSTANCE_PREFIX + i.id ? styles.navTabActive : ''}`}
            title={`CT161 · user ${i.id} · ${i.status}`}
            onClick={() => setActive(INSTANCE_PREFIX + i.id)}
          >
            <span className={`${styles.instDot} ${styles[INSTANCE_DOT[i.status]] ?? ''}`} />
            {i.name}
          </button>
        ))}
        <button className={`${styles.navTab} ${styles.addTab} ${active === SPAWN ? styles.navTabActive : ''}`} onClick={() => setActive(SPAWN)}><Plus size={13} /> Spawn</button>
        <span className={styles.navDivider} />
        {/* Legacy per-container connections (retired as instances migrate to CT161) */}
        {store.connections.map((c) => (
          <button key={c.id} className={`${styles.navTab} ${active === c.id ? styles.navTabActive : ''}`} onClick={() => setActive(c.id)}>{c.name}</button>
        ))}
        <button className={`${styles.navTab} ${active === DIRECTIVES ? styles.navTabActive : ''}`} onClick={() => setActive(DIRECTIVES)}>Central Directives</button>
        <button className={`${styles.navTab} ${styles.addTab} ${active === ADD ? styles.navTabActive : ''}`} onClick={() => setActive(ADD)}><Plus size={13} /> Add</button>
      </div>
      <div className={styles.body}>
        {store.err && <div className={styles.error}>{store.err}</div>}
        {instancesStore.err && <div className={styles.error}>{instancesStore.err}</div>}
        {instancesStore.mocked && instancesStore.loaded && (
          <div className={styles.mockBanner}>
            Instance-manager API not deployed yet — consolidated-instance tabs show MOCK data (UI preview; spawn/controls don't touch CT161).
          </div>
        )}
        {active === DIRECTIVES && <DirectivesView />}
        {active === ADD && <AddView onAdded={(id) => setActive(id || DIRECTIVES)} />}
        {active === SPAWN && <SpawnInstanceView onSpawned={(id) => setActive(INSTANCE_PREFIX + id)} />}
        {instance && <InstanceView instance={instance} />}
        {conn && <ConnectionView conn={conn} />}
        {active !== DIRECTIVES && active !== ADD && active !== SPAWN && !conn && !instance && <div className={styles.dim}>Select a connection.</div>}
      </div>
    </div>
  )
})
