import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Mic, MicOff, NotebookPen, Plus, Radio, RefreshCw, Trash2 } from 'lucide-react'
import {
  startPushToTalk, stopPushToTalk,
  startHandsFree, stopHandsFree,
  claimStt, releaseStt,
  type SttState,
} from '../../services/SttCapture'
import { useSttHealth } from '../../services/useSttHealth'

/**
 * Notes — a dictation notepad.
 *
 * Built for talking at it hands-free while away from a keyboard (Travis asked for this from
 * the car), so every decision favours NOT LOSING WORDS over anything else:
 *
 *  - Dictated speech is committed through POST /append, which only ever adds. A whole-note
 *    save sends the client's idea of the entire note, so a stale tab could wipe text it
 *    never knew about; append cannot, no matter how confused the client is.
 *  - Typed edits autosave on a debounce, and are FLUSHED before each append so the two
 *    writers can never race for the same note.
 *  - Nothing is swallowed. A failed save says so in the header instead of leaving the note
 *    looking saved.
 */

interface Item { id: string; title: string; updatedAt: string; chars: number; preview: string }

const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  // Throw with the SERVER'S reason — it names the actual problem, and replacing that with
  // "save failed" throws away the only useful part of the message.
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data
}

const AUTOSAVE_MS = 900

export const NotesPanel: React.FC = () => {
  const [items, setItems] = useState<Item[]>([])
  const [current, setCurrent] = useState<string>('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [sttState, setSttState] = useState<SttState>('idle')

  const stt = useSttHealth()
  const bodyRef = useRef('')
  const titleRef = useRef('')
  const currentRef = useRef('')
  const dirtyRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  // Refs shadow the state because the save path is called from timers and STT callbacks,
  // which close over whatever was current when they were registered.
  bodyRef.current = body
  titleRef.current = title
  currentRef.current = current

  const refresh = useCallback(async () => {
    try {
      const d = await api('GET', '/api/notes')
      setItems(Array.isArray(d?.notes) ? d.notes : [])
      setError('')
    } catch (e: any) { setError(`Could not list notes: ${e?.message ?? e}`) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  /** Write pending changes NOW and resolve when durable. Safe to call when nothing is dirty. */
  const flush = useCallback(async (): Promise<void> => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    const id = currentRef.current
    if (!id || !dirtyRef.current) return
    try {
      setStatus('saving…')
      await api('PUT', `/api/notes/${encodeURIComponent(id)}`, { title: titleRef.current, body: bodyRef.current })
      dirtyRef.current = false
      setStatus(`saved ${new Date().toLocaleTimeString()}`)
      setError('')
      void refresh()
    } catch (e: any) {
      // Loudly. A note that looks saved and is not is the worst outcome here.
      setStatus('')
      setError(`Save failed — your text is still in the box, do not close the tab: ${e?.message ?? e}`)
    }
  }, [refresh])

  const touch = useCallback(() => {
    dirtyRef.current = true
    setStatus('unsaved…')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void flush(), AUTOSAVE_MS)
  }, [flush])

  // Last-ditch save when the tab goes away mid-thought.
  useEffect(() => {
    const onHide = () => { if (dirtyRef.current) void flush() }
    window.addEventListener('beforeunload', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', onHide)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [flush])

  const open = useCallback(async (id: string) => {
    await flush()
    try {
      const d = await api('GET', `/api/notes/${encodeURIComponent(id)}`)
      setCurrent(id); currentRef.current = id
      setTitle(d?.title ?? id); titleRef.current = d?.title ?? id
      setBody(d?.body ?? ''); bodyRef.current = d?.body ?? ''
      dirtyRef.current = false
      setStatus('')
      setError('')
    } catch (e: any) { setError(`Could not open "${id}": ${e?.message ?? e}`) }
  }, [flush])

  const create = useCallback(async () => {
    await flush()
    // Timestamp id, free-text title. The filename is the identity, so renaming the title
    // later never moves the file and an open editor can't lose track of what it is editing.
    const id = `note-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    const name = `Note ${new Date().toLocaleString()}`
    try {
      await api('PUT', `/api/notes/${encodeURIComponent(id)}`, { title: name, body: '' })
      setCurrent(id); currentRef.current = id
      setTitle(name); titleRef.current = name
      setBody(''); bodyRef.current = ''
      dirtyRef.current = false
      setStatus('new note')
      setError('')
      await refresh()
      areaRef.current?.focus()
    } catch (e: any) { setError(`Could not create a note: ${e?.message ?? e}`) }
  }, [flush, refresh])

  const remove = useCallback(async (id: string) => {
    try {
      await api('DELETE', `/api/notes/${encodeURIComponent(id)}`)
      if (id === currentRef.current) {
        setCurrent(''); currentRef.current = ''
        setTitle(''); setBody(''); dirtyRef.current = false
      }
      await refresh()
    } catch (e: any) { setError(`Delete failed: ${e?.message ?? e}`) }
  }, [refresh])

  /**
   * Commit a dictated utterance. Flush first so a typed edit sitting in the debounce window
   * is written BEFORE the append lands on top of it — otherwise the append's response would
   * carry a body that predates the typing and quietly undo it.
   */
  const appendSpoken = useCallback(async (text: string) => {
    const id = currentRef.current
    if (!id) { setError('Dictation had nowhere to go — open or create a note first.'); return }
    await flush()
    try {
      const d = await api('POST', `/api/notes/${encodeURIComponent(id)}/append`, { text })
      setBody(d?.body ?? ''); bodyRef.current = d?.body ?? ''
      dirtyRef.current = false
      setStatus(`dictated ${new Date().toLocaleTimeString()}`)
      setError('')
      void refresh()
    } catch (e: any) {
      // Say what was lost. Silently dropping a sentence you just spoke is unforgivable here.
      setError(`Could not save what you just said ("${text.slice(0, 60)}…"): ${e?.message ?? e}`)
    }
  }, [flush, refresh])

  /** Push-to-talk drops text into the box for review — it does not commit on its own. */
  const insertSpoken = useCallback((text: string) => {
    if (!currentRef.current) { setError('Dictation had nowhere to go — open or create a note first.'); return }
    const prev = bodyRef.current
    const sep = !prev ? '' : /\s$/.test(prev) ? '' : ' '
    const next = prev + sep + text
    setBody(next); bodyRef.current = next
    touch()
  }, [touch])

  // Claim the shared microphone. The chat composer claims the same singleton, so whoever
  // claims last owns it and the other is told (onEvicted) instead of going quietly deaf.
  useEffect(() => {
    claimStt('notes', {
      onTranscript: insertSpoken,
      onAutoSend: appendSpoken,
      onStateChange: (s) => setSttState(s),
      onEvicted: (by) => {
        setSttState('idle')
        setError(`The microphone was taken over by "${by}" — dictation here has stopped.`)
      },
    })
    return () => releaseStt('notes')
  }, [insertSpoken, appendSpoken])

  const recording = sttState === 'recording'
  const transcribing = sttState === 'transcribing'
  const handsFree = sttState === 'handsfree' || sttState === 'handsfree-recording'
  const speaking = sttState === 'handsfree-recording'

  const btn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 11px',
    border: '1px solid var(--border)', borderRadius: 8, background: 'var(--control-bg)',
    color: 'var(--fg-muted)', fontSize: 12, cursor: 'pointer',
  }
  const hot: React.CSSProperties = {
    ...btn, borderColor: 'var(--accent)', background: 'var(--accent)',
    color: 'var(--app-bg)', fontWeight: 600,
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* ── note list ─────────────────────────────────────────────── */}
      <div style={{ width: 230, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 6, padding: 8, borderBottom: '1px solid var(--border)' }}>
          <button style={{ ...hot, flex: 1, justifyContent: 'center' }} onClick={() => void create()}><Plus size={13} /> New note</button>
          <button style={btn} onClick={() => void refresh()} title="Refresh the list"><RefreshCw size={12} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {items.length === 0 && (
            <div style={{ padding: 12, fontSize: 11.5, color: 'var(--fg-faint)' }}>
              No notes yet. “New note”, then press the mic.
            </div>
          )}
          {items.map((n) => (
            <div
              key={n.id}
              onClick={() => void open(n.id)}
              style={{
                padding: '8px 10px', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                background: n.id === current ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span>
                <button
                  style={{ background: 'none', border: 0, color: 'var(--fg-faint)', cursor: 'pointer', padding: 2 }}
                  title={`Delete "${n.title}"`}
                  onClick={(e) => { e.stopPropagation(); void remove(n.id) }}
                ><Trash2 size={11} /></button>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--fg-faint)', marginTop: 2 }}>
                {new Date(n.updatedAt).toLocaleString()} · {n.chars} chars
              </div>
              {n.preview && (
                <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {n.preview}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── editor ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <NotebookPen size={15} />
          <input
            value={title}
            disabled={!current}
            placeholder={current ? 'Untitled' : 'No note open'}
            onChange={(e) => { setTitle(e.target.value); titleRef.current = e.target.value; touch() }}
            style={{
              flex: 1, minWidth: 140, padding: '6px 9px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              border: '1px solid var(--border)', background: 'var(--control-bg)', color: 'var(--fg)',
            }}
          />

          <button
            style={recording ? hot : btn}
            disabled={!current || !stt.ok || transcribing || handsFree}
            title={!stt.ok ? `Speech-to-text unavailable — ${stt.why}`
              : !current ? 'Open or create a note first'
              : transcribing ? 'Transcribing…'
              : recording ? 'Recording — click to stop and drop the text into the note'
              : 'Record once; the transcript lands in the note for you to edit'}
            onClick={() => { if (recording) void stopPushToTalk(); else if (sttState === 'idle') void startPushToTalk() }}
          >
            {transcribing ? <Radio size={13} /> : recording ? <MicOff size={13} /> : <Mic size={13} />}
            {transcribing ? 'Transcribing…' : recording ? 'Stop' : 'Dictate once'}
          </button>

          <button
            style={handsFree ? hot : btn}
            disabled={!current || !stt.ok || recording || transcribing}
            title={!stt.ok ? `Speech-to-text unavailable — ${stt.why}`
              : !current ? 'Open or create a note first'
              : handsFree ? 'Always listening — each pause commits what you said. Click to stop.'
              : 'Always listen: keep talking and every pause commits a sentence into this note'}
            onClick={() => { if (handsFree) stopHandsFree(); else void startHandsFree() }}
          >
            <Radio size={13} />
            {speaking ? 'Listening — hearing you' : handsFree ? 'Listening…' : 'Always listen'}
          </button>

          {current && (
            <a
              href={`/api/notes/${encodeURIComponent(current)}/file.txt`}
              style={{ ...btn, textDecoration: 'none' }}
              title="Download this note as plain text"
            ><Download size={12} /></a>
          )}

          <span style={{ fontSize: 11, color: 'var(--fg-faint)', minWidth: 90, textAlign: 'right' }}>{status}</span>
        </div>

        {error && (
          <div style={{ padding: '7px 12px', background: 'color-mix(in srgb, var(--danger, #e5484d) 14%, transparent)', borderBottom: '1px solid var(--danger, #e5484d)', fontSize: 11.5 }}>
            {error}
          </div>
        )}
        {handsFree && (
          <div style={{ padding: '6px 12px', background: 'color-mix(in srgb, var(--accent) 12%, transparent)', borderBottom: '1px solid var(--accent)', fontSize: 11.5 }}>
            {speaking
              ? 'Hearing you — pause for a moment and it will commit that sentence.'
              : 'Listening. Just talk; each pause commits a sentence into this note.'}
          </div>
        )}

        <textarea
          ref={areaRef}
          value={body}
          disabled={!current}
          placeholder={current ? 'Type, or press “Always listen” and talk.' : 'Create a note to start.'}
          onChange={(e) => { setBody(e.target.value); bodyRef.current = e.target.value; touch() }}
          onBlur={() => void flush()}
          style={{
            flex: 1, minHeight: 0, resize: 'none', padding: '12px 14px', border: 0, outline: 'none',
            background: 'var(--app-bg)', color: 'var(--fg)', fontSize: 14, lineHeight: 1.6,
            fontFamily: 'inherit',
          }}
        />
      </div>
    </div>
  )
}
