import React, { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { Undo2, X, Pin, Trash2, Check, Lock } from 'lucide-react'
import { modelMapStore as store, changeLabel, type MapGpu, type MapBlock, type CacheCyl, type CacheBlock } from '../../stores/ModelMapStore'
import { imageModelsStore } from '../../stores/ImageModelsStore'
import { ModelPlacementPanel } from './ModelPlacementPanel'
import styles from './ModelMap.module.scss'

/**
 * Graphical Image Model Service manager (Travis's /claude/ui_example.png). One cylinder per GPU, RAM cache and
 * Disk/Optane cache; drag models in from the list (or from another cylinder) to stage a load / duplicate / cache
 * copy, drag a text encoder's ⇔ grip onto a neighbouring card to split it, X to unload, the pin box to keep it.
 * Everything is STAGED - the cylinders show the result as ghosts - and runs only on Apply. The old table view
 * (quotas, placement reservations, the full model list) stays one click away.
 */
const W = 104, CAP = 22, BODY = 190
const MIME = 'application/x-ailab-modelmap'
const KIND_COLOR: Record<string, string> = {
  unet: '#e5484d', ckpt: '#d6409f', te: '#f5d90a', vae: '#3e63dd', lora: '#8e4ec6',
  detector: '#12a594', sam: '#0d9488', sam3: '#0f766e', seedvr2: '#f76b15', upscale: '#f76b15', other: '#8b8d98',
}
const KIND_TEXT: Record<string, string> = { te: '#3b3200' }
const VIEW_KEY = 'ailab-modelmap-view'

const short = (n: string) => n.split('/').pop()!.replace(/\.(safetensors|gguf|pth|pt|ckpt|bin|onnx)$/i, '').replace(/_/g, ' ')
const gb = (v: number | null | undefined) => (v == null ? '?' : v >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/0$/, ''))

type Drag = { src: 'palette' | 'block' | 'cache' | 'split'; kind: string; name: string; service?: string; gpu?: number; clipType?: string; blockId?: string }
const setDrag = (e: React.DragEvent, d: Drag) => { e.dataTransfer.setData(MIME, JSON.stringify(d)); e.dataTransfer.effectAllowed = 'copyMove' }
const getDrag = (e: React.DragEvent): Drag | null => { try { return JSON.parse(e.dataTransfer.getData(MIME)) } catch { return null } }

interface Placed<T> { b: T; off: number; h: number }
function stack<T extends { gb: number | null; staged?: string }>(blocks: T[], capGb: number): Placed<T>[] {
  const scale = BODY / Math.max(capGb, 0.1)
  let off = 0
  return blocks.map((b) => {
    // a parked copy holds ~no VRAM but must stay readable: fixed height, drawn hatched
    const h = (b as any).parked ? 34 : Math.max(b.gb == null ? 14 : 5, (b.gb ?? 0.6) * scale)
    const p = { b, off, h }; off += h
    return p
  })
}

const Cylinder: React.FC<{
  title: string; sub: string; note?: string; capGb: number; projectedGb: number; usedGb: number; dropOk: boolean
  onDrop: (d: Drag, e: React.DragEvent) => void; children: (scaleCap: number) => React.ReactNode; tone?: 'gpu' | 'ram' | 'disk'
}> = ({ title, sub, note, capGb, projectedGb, usedGb, dropOk, onDrop, children, tone = 'gpu' }) => {
  const [over, setOver] = useState(false)
  const scaleCap = Math.max(capGb, projectedGb)
  const overfull = projectedGb > capGb + 0.05
  return (
    <div className={styles.cylWrap}>
      <div className={`${styles.cyl} ${styles['tone_' + tone]} ${over ? (dropOk ? styles.dropOk : styles.dropNo) : ''} ${overfull ? styles.overfull : ''}`}
           style={{ width: W, height: BODY + CAP }}
           onDragOver={(e) => { if (e.dataTransfer.types.includes(MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = dropOk ? 'copy' : 'none'; setOver(true) } }}
           onDragLeave={() => setOver(false)}
           onDrop={(e) => { setOver(false); const d = getDrag(e); if (d) { e.preventDefault(); onDrop(d, e) } }}>
        <div className={styles.body} style={{ top: CAP / 2, height: BODY }}>
          <div className={styles.floor} />
          {children(scaleCap)}
        </div>
        <div className={styles.cap} style={{ height: CAP }} title={`${gb(usedGb)} GB in use now${projectedGb !== usedGb ? ` · ${gb(projectedGb)} GB after Apply` : ''}`}>
          {Math.round(capGb)} GB
        </div>
      </div>
      <div className={styles.cylTitle}>{title}</div>
      <div className={`${styles.cylSub} ${overfull ? styles.warnText : ''}`}>{overfull ? `over by ${gb(projectedGb - capGb)} GB` : sub}</div>
      {note && <div className={styles.cylNote}>{note}</div>}
    </div>
  )
}

/** A model section inside a GPU cylinder: colour + label only. Its controls live in the side column (SideControls),
 *  because a small section clipped its own pin / X buttons (Travis, 2026-10-10). */
const Block: React.FC<{ p: Placed<MapBlock>; z: number; top: boolean; label: string; sublabel: string; kind: string
  draggableAs?: Drag; copies?: number; staged?: string; tooltip: string }> = ({ p, z, top, label, sublabel, kind, draggableAs, copies, staged, tooltip }) => {
  const c = KIND_COLOR[kind] || KIND_COLOR.other
  return (
    <div className={`${styles.block} ${top ? styles.blockTop : ''} ${(p.b as any).parked ? styles.parked : ''} ${staged === 'add' ? styles.stAdd : ''} ${staged === 'remove' ? styles.stRemove : ''}`}
         style={{ bottom: p.off, height: p.h, zIndex: z, ['--c' as any]: c, color: KIND_TEXT[kind] || '#fff', ['--cap' as any]: `${CAP}px` }}
         draggable={!!draggableAs} onDragStart={draggableAs ? (e) => setDrag(e, draggableAs) : undefined} title={tooltip}>
      {p.h >= 30 && <div className={styles.blockText}><b>{label}</b><span>{sublabel}</span></div>}
      {!!copies && copies > 1 && p.h >= 18 && <span className={styles.copies} title={`${copies} copies on this node (CFG split uses them in parallel)`}>×{copies}</span>}
    </div>
  )
}

type PinState = 'off' | 'on' | 'stagedOn' | 'stagedOff' | 'locked' | 'unsupported'
const pinState = (b: MapBlock, supported: boolean): PinState => {
  if (b.plugin) return 'locked'
  if (!supported) return 'unsupported'
  if (b.pinNext === true) return 'stagedOn'
  if (b.pinNext === false) return 'stagedOff'
  return b.pinned ? 'on' : 'off'
}
const PIN_TITLE: Record<PinState, string> = {
  off: 'Not pinned - click to stage a VRAM pin (permanently loaded: never unloaded or offloaded from this card)',
  on: 'PINNED in VRAM - permanently loaded. Click to stage an unpin.',
  stagedOn: 'Pin staged - takes effect on Apply (click again to un-stage)',
  stagedOff: 'Unpin staged - takes effect on Apply (click again to un-stage)',
  locked: 'Always loaded: a split encoder is held by the te_split plugin outside the memory manager - nothing evicts it, and it reloads on every service restart. Unload it with X.',
  unsupported: "This service's core is too old for VRAM pins",
}

/** The controls column beside a cylinder: one group per model section, level with it; groups push apart so even a
 *  hairline section gets its own readable controls. */
const SideControls: React.FC<{ g: MapGpu; placed: Placed<MapBlock>[] }> = observer(({ g, placed }) => {
  const ROW = 20
  const items = placed.filter((p) => !p.b.other && (p.b.gpus[0] === g.svcIndex)).map((p) => {
    const b = p.b
    const n = 2 + (b.kind === 'te' && !b.split && g.teSplit && b.staged !== 'remove' ? 1 : 0)
    return { b, h: n * ROW, want: CAP / 2 + BODY - p.off - p.h / 2 }   // y of the section's centre
  }).sort((a, b) => a.want - b.want)
  // place top-down without overlap, then pull back up if the last group overflows the bottom
  let y = 0
  const tops = items.map((it) => { const t = Math.max(it.want - it.h / 2, y); y = t + it.h + 3; return t })
  const limit = BODY + CAP
  for (let i = items.length - 1, floor = limit; i >= 0; i--) { if (tops[i] + items[i].h > floor) tops[i] = floor - items[i].h; floor = tops[i] - 3 }
  return (
    <div className={styles.side} style={{ height: BODY + CAP }}>
      {items.map((it, i) => {
        const b = it.b, ps = pinState(b, g.pinSupported)
        const c = KIND_COLOR[b.kind] || KIND_COLOR.other
        return (
          <div key={b.id} className={styles.sideGroup} style={{ top: tops[i], borderLeftColor: c }}>
            <button className={`${styles.sideBtn} ${styles['pin_' + ps]}`} title={`${short(b.name)}\n${PIN_TITLE[ps]}`}
                    disabled={ps === 'locked' || ps === 'unsupported' || b.staged === 'add'}
                    onClick={() => store.stagePin(b, !(b.pinNext ?? b.pinned))}>
              {ps === 'locked' ? <Lock size={11} /> : <Pin size={11} />}
            </button>
            <button className={`${styles.sideBtn} ${b.staged === 'remove' ? styles.sideOn : ''}`}
                    title={b.staged === 'add' ? `Un-stage loading ${short(b.name)}` : b.staged === 'remove' ? `Unload of ${short(b.name)} staged - click again to keep it`
                      : b.split ? `Unload the split ${short(b.name)} (both cards)` : `Unload ${short(b.name)} from this card`}
                    onClick={() => (b.staged === 'remove' ? store.unstageUnload(b) : store.stageUnload(b))}><X size={11} /></button>
            {b.kind === 'te' && !b.split && g.teSplit && b.staged !== 'remove' && (
              <span className={styles.sideBtn} draggable title={`Drag onto a neighbouring card of this node to SPLIT ${short(b.name)} across both`}
                    onDragStart={(e) => setDrag(e, { src: 'split', kind: b.kind, name: b.name, service: b.service, gpu: g.svcIndex ?? undefined, blockId: b.id })}>⇔</span>
            )}
          </div>
        )
      })}
    </div>
  )
})

const GpuCyl: React.FC<{ g: MapGpu; copies: Record<string, number> }> = observer(({ g, copies }) => {
  const onDrop = (d: Drag, e: React.DragEvent) => {
    if (g.service == null || g.svcIndex == null) { store.setHint('That card is not part of an Image Model Service - only service GPUs can load models.'); return }
    if (d.src === 'split') {
      const b = store.view.flatMap((n) => n.gpus).flatMap((x) => x.blocks).find((x) => x.id === d.blockId)
      if (b) store.stageSplit(b, g.service, g.svcIndex)
      return
    }
    store.stageLoad(d.kind, d.name, g.service, g.svcIndex, d.clipType)
    // Shift-drop from another card = MOVE: also stage the unload of the source copy
    if (e.shiftKey && d.src === 'block' && d.service && d.gpu != null && !(d.service === g.service && d.gpu === g.svcIndex)) {
      const b = store.view.flatMap((n) => n.gpus).flatMap((x) => x.blocks).find((x) => x.id === d.blockId)
      if (b) store.stageUnload(b)
    }
  }
  const placed = stack(g.blocks, Math.max(g.totalGb, g.projectedGb))
  return (
    <div className={styles.cylPair}>
      <Cylinder title={g.label} sub={`${gb(g.usedGb)} / ${Math.round(g.totalGb)} GB`} note={g.service ? undefined : 'not a model service'}
                capGb={g.totalGb} projectedGb={g.projectedGb} usedGb={g.usedGb} dropOk={g.service != null} onDrop={onDrop}>
        {() => placed.map((p, i, all) => {
          const b = p.b
          if (b.other) {
            return <Block key={b.id} p={p} z={i + 1} top={i === all.length - 1} kind="other" label={g.service ? 'other' : ''} sublabel={`${gb(b.gb)} GB`}
                          tooltip={g.service ? `${gb(b.gb)} GB not held by a listed model (CUDA contexts, cache, other processes)` : `${gb(b.gb)} GB in use (not an Image Model Service card)`} />
          }
          const lead = b.gpus[0] === g.svcIndex
          const pinMark = b.plugin ? ' · always loaded' : (b.pinNext ?? b.pinned) ? ' · 📌 pinned' : ''
          return (
            <Block key={b.id + (lead ? '' : '|b')} p={p} z={i + 1} top={i === all.length - 1} kind={b.kind}
                   label={short(b.name)} sublabel={b.parked ? 'off the card' : `${b.staged === 'add' ? '≈' : ''}${gb(b.gb)} GB${b.split ? ' (split)' : ''}${(b.pinNext ?? b.pinned) && !b.plugin ? ' 📌' : ''}${b.tier && b.tier !== 'hot' && b.tier !== 'staged' ? ` · ${b.tier}` : ''}`}
                   staged={b.staged} copies={b.split ? 0 : copies[`${b.service}|${b.kind}|${b.name}`]}
                   draggableAs={b.staged === 'remove' ? undefined : { src: 'block', kind: b.kind, name: b.name, service: b.service, gpu: g.svcIndex ?? undefined, clipType: b.clipType, blockId: b.id }}
                   tooltip={`${b.name}\n${b.parked ? `Registered on this card but its weights are not on it (service: ${b.tier}). Either parked in RAM between runs (SeedVR2 on 16 GB cards) or not materialised yet - it loads onto the card for its next run.\n` : ''}${b.kind} · ${gb(b.gb)} GB${b.split ? ` · split across ${b.gpus.length} cards` : ''}${pinMark}${b.busy ? ' · busy' : ''}${b.tier ? ` · ${b.tier}` : ''}\nDrag onto another card to duplicate (Shift = move)`} />
          )
        })}
      </Cylinder>
      {g.service && <SideControls g={g} placed={placed} />}
    </div>
  )
})

/** The symbol between two adjacent cards: ● pair link for copies (CFG), ◆◆ double bar for one model split across both. */
const Link: React.FC<{ a: MapGpu; b: MapGpu }> = ({ a, b }) => {
  const placed = stack(a.blocks, Math.max(a.totalGb, a.projectedGb))
  const marks: React.ReactNode[] = []
  for (const p of placed) {
    const x = p.b as MapBlock
    if (x.other || x.staged === 'remove') continue
    const y = CAP / 2 + BODY - p.off - p.h / 2
    if (x.split && b.blocks.some((o) => o.id === x.id)) {
      marks.push(<div key={x.id} className={styles.linkSplit} style={{ top: y - 8 }} title={`${short(x.name)} is SPLIT across both cards`}><i /><i /></div>)
    } else if (!x.split && b.blocks.some((o) => !o.other && !o.split && o.staged !== 'remove' && o.service === x.service && o.kind === x.kind && o.name === x.name)) {
      marks.push(<div key={x.id} className={styles.linkPair} style={{ top: y - 6 }} title={`${short(x.name)} has a copy on both cards (CFG split runs them as a pair)`}><b /></div>)
    }
  }
  return <div className={styles.link} style={{ height: BODY + CAP }}>{marks}</div>
}

/**
 * A cache as a full-width rectangle (Travis: cylinders are far too small for 236-580 GB holding hundreds of files).
 * An invisible grid of COLS columns; each square stands for `cellGb`, chosen so the cache fills ~ROWS rows. A cached
 * model is a tile covering as many squares as its size (2 rows tall once it is big enough to carry a readable name),
 * packed densely; free space shows as faint empty squares. Files smaller than one square fold into one tile.
 */
const COLS = 48, ROWS = 12
const CacheGrid: React.FC<{ cy: CacheCyl }> = observer(({ cy }) => {
  const [over, setOver] = useState(false)
  const cap = Math.max(cy.capGb, cy.projectedGb, 1)
  const cellGb = cap / (COLS * ROWS)
  const small = cy.blocks.filter((b) => b.gb < cellGb && !b.staged && b.pinNext == null)
  const tiles: (CacheBlock & { group?: CacheBlock[] })[] = cy.blocks.filter((b) => !small.includes(b))
  if (small.length) tiles.push({ id: `${cy.node}|${cy.tier}|small`, kind: 'other', name: `${small.length} small files`, gb: small.reduce((a, b) => a + b.gb, 0), pinned: false, group: small })
  const shape = (g: number) => {
    const cells = Math.max(1, Math.round(g / cellGb))
    if (cells > COLS * 2) return { w: COLS, h: Math.ceil(cells / COLS) }
    if (cells >= 8) return { w: Math.ceil(cells / 2), h: 2 }
    return { w: cells, h: 1 }
  }
  const usedCells = tiles.reduce((a, t) => { const s = shape(t.gb); return a + (t.staged === 'remove' ? 0 : s.w * s.h) }, 0)
  const free = Math.max(0, Math.min(COLS * ROWS - usedCells, 2000))
  // usedGb (the cache's own accounting) and the sum of its files differ by rounding - only show an "after Apply" figure
  // when this cache has staged changes, as used + the staged delta
  const delta = cy.blocks.reduce((a, b) => a + (b.staged === 'add' ? b.gb : b.staged === 'remove' ? -b.gb : 0), 0)
  const staged = cy.blocks.some((b) => b.staged)
  const overfull = cy.usedGb + delta > cy.capGb + 0.05
  return (
    <div className={styles.cacheWrap}>
      <div className={styles.cacheHead}>
        <b>{cy.label}</b>
        <span className={overfull ? styles.warnText : ''}>{gb(cy.usedGb)} / {Math.round(cy.capGb)} GB{staged ? ` → ${gb(cy.usedGb + delta)} GB after Apply` : ''}</span>
        <span className={styles.dimText}>{cy.blocks.length} files · each square ≈ {gb(cellGb)} GB · drop a model here to cache it</span>
      </div>
      <div className={`${styles.cacheGrid} ${over ? styles.dropOk : ''} ${overfull ? styles.overfullBox : ''}`} style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}
           onDragOver={(e) => { if (e.dataTransfer.types.includes(MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true) } }}
           onDragLeave={() => setOver(false)}
           onDrop={(e) => { setOver(false); const d = getDrag(e); if (d) { e.preventDefault(); store.stageWarm(cy, d.kind, d.name) } }}>
        {tiles.map((t) => {
          const s = shape(t.gb)
          const c = KIND_COLOR[t.kind] || KIND_COLOR.other
          const showPin = t.pinNext ?? t.pinned
          return (
            <div key={t.id} className={`${styles.tile} ${t.staged === 'add' ? styles.stAdd : ''} ${t.staged === 'remove' ? styles.stRemove : ''}`}
                 style={{ gridColumn: `span ${s.w}`, gridRow: `span ${s.h}`, background: c, color: KIND_TEXT[t.kind] || '#fff' }}
                 draggable={!t.group && t.staged !== 'remove'}
                 onDragStart={!t.group ? (e) => setDrag(e, { src: 'cache', kind: t.kind, name: t.name }) : undefined}
                 title={t.group ? t.group.map((x) => `${x.kind} · ${x.name} · ${gb(x.gb)} GB`).slice(0, 60).join('\n') + (t.group.length > 60 ? `\n… ${t.group.length - 60} more` : '')
                   : `${t.name}\n${t.kind} · ${gb(t.gb)} GB in ${cy.node} ${cy.label}${t.pinned ? ' · pinned' : ''}${t.copying ? ' · copying' : ''}\nDrag onto a GPU to load it`}>
              {s.w >= 3 && <span className={styles.tileName}>{t.group ? t.name : short(t.name)}</span>}
              {s.w >= 3 && <span className={styles.tileSize}>{t.staged === 'add' ? '≈' : ''}{gb(t.gb)} GB{t.copying ? ' · copying' : ''}</span>}
              {!t.group && (
                <>
                  <div className={styles.tileCtl}>
                    <button className={`${styles.sideBtn} ${styles['pin_' + (t.pinNext === true ? 'stagedOn' : t.pinNext === false ? 'stagedOff' : showPin ? 'on' : 'off')]}`}
                            disabled={t.staged === 'add'} onClick={(e) => { e.stopPropagation(); store.stageCachePin(cy, t, !showPin) }}
                            title={t.pinNext != null ? `${t.pinNext ? 'Pin' : 'Unpin'} staged - takes effect on Apply (click again to un-stage)`
                              : showPin ? 'PINNED in this cache - never evicted. Click to stage an unpin.' : 'Not pinned - click to stage a cache pin (never evicted to make room)'}><Pin size={11} /></button>
                    <button className={`${styles.sideBtn} ${t.staged === 'remove' ? styles.sideOn : ''}`} title={t.staged === 'add' ? 'Un-stage' : `Evict from ${cy.label}`}
                            onClick={(e) => { e.stopPropagation(); store.stageEvict(cy, t) }}><X size={11} /></button>
                  </div>
                </>
              )}
            </div>
          )
        })}
        {Array.from({ length: free }, (_, i) => <div key={`f${i}`} className={styles.freeCell} />)}
      </div>
    </div>
  )
})

export const ModelMapPanel: React.FC = observer(() => {
  const [table, setTable] = useState(() => { try { return localStorage.getItem(VIEW_KEY) === 'table' } catch { return false } })
  useEffect(() => { store.start(); return () => store.stop() }, [])
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, table ? 'table' : 'map') } catch { /* private window */ } }, [table])
  const toggle = (
    <div className={styles.viewToggle}>
      <button className={`${styles.btn} ${!table ? styles.btnOn : ''}`} onClick={() => setTable(false)}>Map</button>
      <button className={`${styles.btn} ${table ? styles.btnOn : ''}`} onClick={() => setTable(true)}>Table · quotas · reservations</button>
    </div>
  )
  if (table) return <div>{toggle}<ModelPlacementPanel /></div>

  const view = store.view
  const n = store.changes.length
  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        {toggle}
        <div className={styles.legend}>
          {['unet', 'te', 'vae', 'lora', 'ckpt', 'detector', 'seedvr2', 'other'].map((k) => (
            <span key={k}><i style={{ background: KIND_COLOR[k] }} />{k === 'other' ? 'other' : k}</span>
          ))}
        </div>
        <span className={styles.spacer} />
        {(imageModelsStore.error || store.metricsError) && <span className={styles.warnText}>{imageModelsStore.error || store.metricsError}</span>}
        <button className={styles.btn} disabled={!n || store.applying} onClick={() => store.undo()} title="Undo the last staged change"><Undo2 size={13} /> Undo</button>
        <button className={styles.btn} disabled={!n || store.applying} onClick={() => store.clear()} title="Drop every staged change"><Trash2 size={13} /> Clear</button>
        <button className={styles.btnPrimary} disabled={!n || store.applying} onClick={() => void store.apply()}>
          <Check size={13} /> {store.applying ? 'Applying…' : `Apply${n ? ` (${n})` : ''}`}
        </button>
      </div>

      {(n > 0 || store.applyLog.length > 0 || store.hint) && (
        <div className={styles.staged}>
          {store.hint && <div className={styles.warnText}>{store.hint}</div>}
          {store.changes.map((c, i) => (
            <span key={i} className={styles.chip}>{changeLabel(c, (s, g) => store.gpuName(s, g))}
              <button title="Drop this change" onClick={() => store.removeChange(i)} disabled={store.applying}><X size={10} /></button></span>
          ))}
          {store.applyLog.map((l, i) => <div key={`l${i}`} className={l.ok ? styles.okText : styles.warnText}>{l.text}</div>)}
        </div>
      )}

      <div className={styles.main}>
        <div className={styles.palette}>
          <input className={styles.input} placeholder="Search models…" value={store.search} onChange={(e) => store.setSearch(e.target.value)} />
          <select className={styles.input} value={store.kindFilter} onChange={(e) => store.setKindFilter(e.target.value)}>
            <option value="">all kinds</option>
            {store.paletteKinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <div className={styles.paletteHint}>Drag onto a GPU to load, onto a cache to copy it there.</div>
          <div className={styles.paletteList}>
            {store.palette.map((m) => (
              <div key={`${m.kind}|${m.name}`} className={styles.palItem} draggable onDragStart={(e) => setDrag(e, { src: 'palette', kind: m.kind, name: m.name })} title={m.name}>
                <i style={{ background: KIND_COLOR[m.kind] || KIND_COLOR.other }} />
                <span className={styles.palName}>{short(m.name)}</span>
                <span className={styles.palKind}>{m.kind}</span>
                <span className={styles.palSize}>{m.gb != null ? `${gb(m.gb)} GB` : ''}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.nodes}>
          {!view.length && <div className={styles.muted}>Waiting for GPU metrics and the model services…</div>}
          {view.map((node) => {
            const copies: Record<string, number> = {}
            for (const g of node.gpus) for (const b of g.blocks) if (!b.other && !b.split && b.staged !== 'remove') copies[`${b.service}|${b.kind}|${b.name}`] = (copies[`${b.service}|${b.kind}|${b.name}`] || 0) + 1
            return (
              <div key={node.node} className={styles.node}>
                <div className={styles.nodeHead}>{node.node}</div>
                <div className={styles.row}>
                  {node.gpus.map((g, i) => (
                    <React.Fragment key={g.uuid}>
                      {i > 0 && <Link a={node.gpus[i - 1]} b={g} />}
                      <GpuCyl g={g} copies={copies} />
                    </React.Fragment>
                  ))}
                </div>
                {node.caches.map((cy) => <CacheGrid key={cy.tier} cy={cy} />)}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
})
