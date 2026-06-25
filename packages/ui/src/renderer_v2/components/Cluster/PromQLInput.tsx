import React, { useEffect, useRef, useState } from 'react'
import styles from './Cluster.module.scss'

/**
 * PromQLInput — a text input with metric-name autocomplete so users can discover
 * what's available without a separate dictionary. Metric names are fetched once from
 * the backend `metrics:metricNames` RPC (rule #1: backend queries Prometheus) and
 * cached at module scope. As you type an identifier token, matching metric names are
 * suggested; Enter/Tab/click inserts.
 */
let namesCache: Promise<string[]> | null = null
function getMetricNames(): Promise<string[]> {
  if (namesCache) return namesCache
  const api = (window as any).gyshell?.metrics
  const p: Promise<string[]> = api?.metricNames
    ? api.metricNames().then((r: any) => (Array.isArray(r?.names) ? r.names : [])).catch(() => [])
    : Promise.resolve<string[]>([])
  namesCache = p
  return p
}

const IDENT = /[a-zA-Z0-9_:]/

function tokenAround(value: string, caret: number): { start: number; end: number; text: string } {
  let start = caret
  while (start > 0 && IDENT.test(value[start - 1])) start--
  let end = caret
  while (end < value.length && IDENT.test(value[end])) end++
  return { start, end, text: value.slice(start, caret) }
}

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}

export const PromQLInput: React.FC<Props> = ({ value, onChange, placeholder, className }) => {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [names, setNames] = useState<string[]>([])
  const [matches, setMatches] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const tokenRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 })

  useEffect(() => {
    let alive = true
    void getMetricNames().then((n) => alive && setNames(n))
    return () => {
      alive = false
    }
  }, [])

  const recompute = (val: string, caret: number) => {
    const tok = tokenAround(val, caret)
    tokenRef.current = { start: tok.start, end: tok.end }
    if (tok.text.length < 2) {
      setOpen(false)
      return
    }
    const q = tok.text.toLowerCase()
    const starts = names.filter((n) => n.toLowerCase().startsWith(q))
    const incl = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q))
    const m = [...starts, ...incl].slice(0, 12)
    setMatches(m)
    setActive(0)
    setOpen(m.length > 0)
  }

  const insert = (name: string) => {
    const { start, end } = tokenRef.current
    const next = value.slice(0, start) + name + value.slice(end)
    onChange(next)
    setOpen(false)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        const pos = start + name.length
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  return (
    <div className={styles.acWrap}>
      <input
        ref={inputRef}
        className={className}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value)
          recompute(e.target.value, e.target.selectionStart ?? e.target.value.length)
        }}
        onClick={(e) => recompute(value, (e.target as HTMLInputElement).selectionStart ?? value.length)}
        onKeyDown={(e) => {
          if (!open) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((a) => Math.min(a + 1, matches.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => Math.max(a - 1, 0))
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (matches[active]) {
              e.preventDefault()
              insert(matches[active])
            }
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      {open && (
        <div className={styles.acDropdown}>
          {matches.map((m, i) => (
            <div
              key={m}
              className={`${styles.acItem} ${i === active ? styles.acActive : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                insert(m)
              }}
              onMouseEnter={() => setActive(i)}
            >
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
