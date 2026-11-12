#!/usr/bin/env node
/**
 * Import the Fritzing core parts library into the AI-Lab Circuit Designer.
 *
 *   node import-fritzing.mjs --parts /opt/fritzing-parts --out <dataDir>/circuits/fritzing --chrome <chrome-headless-shell>
 *
 * Needs `playwright-core` and `@xmldom/xmldom` resolvable (run it from /opt/fritzing-import, which
 * has them installed — see infra/circuits/README.md). Pin positions come from a real browser
 * layout of each breadboard SVG (getBoundingClientRect of the connector's svgId), so nested
 * transforms, viewBoxes and units are handled the way a browser renders them.
 *
 * Output: one <id>.json per part (PartDef, source 'fritzing') plus _report.json listing every
 * skipped part and why. The output dir is written to <out>.new and swapped in at the end.
 * Fritzing parts are CC-BY-SA 3.0 (https://github.com/fritzing/fritzing-parts).
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs'
import path from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { chromium } from 'playwright-core'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const PARTS = arg('parts', '/opt/fritzing-parts')
const OUT = arg('out')
const CHROME = arg('chrome')
const LIMIT = Number(arg('limit', '0')) || Infinity
const ONLY = arg('only') // regex on the fzp file name, for testing
if (!OUT || !CHROME) { console.error('usage: --out <dir> --chrome <path> [--parts <fritzing-parts>] [--limit N] [--only regex]'); process.exit(2) }

const UNITS_PER_INCH = 100 // 10 units = 0.1"
const MAX_PINS = 400, MAX_SVG = 4_000_000

const xml = (s) => new DOMParser({ onError: () => {} }).parseFromString(s, 'text/xml')
const kids = (el, name) => (el ? Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.nodeName === name) : [])
const kid = (el, name) => kids(el, name)[0]
const text = (el) => (el?.textContent ?? '').trim()
// Fritzing descriptions are often Qt rich text: drop <style>/<head> blocks (and the bare
// "p, li { white-space: pre-wrap; }" left when the tags were already stripped) before the tags.
const stripHtml = (s) => s.replace(/<(style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/^\s*p,\s*li\s*\{[^}]*\}/i, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()

// ── categories from the bins ─────────────────────────────────────────────────────────────────
const category = new Map()
{
  const core = xml(readFileSync(path.join(PARTS, 'bins/core.fzb'), 'utf8'))
  let section = 'Other'
  for (const inst of Array.from(core.getElementsByTagName('instance'))) {
    const mid = inst.getAttribute('moduleIdRef')
    if (mid === '__spacer__') { section = inst.getAttribute('path') || section; continue }
    if (/View$|Tools$/.test(section)) continue // schematic/pcb-only helpers and rulers
    if (!category.has(mid)) category.set(mid, `Fritzing · ${section}`)
  }
  const more = path.join(PARTS, 'bins/more')
  for (const f of readdirSync(more).filter((f) => f.endsWith('.fzb')).sort()) {
    const doc = xml(readFileSync(path.join(more, f), 'utf8'))
    const title = text(doc.getElementsByTagName('title')[0]) || f.replace(/\.fzb$/, '')
    for (const inst of Array.from(doc.getElementsByTagName('instance'))) {
      const mid = inst.getAttribute('moduleIdRef')
      if (mid && !category.has(mid)) category.set(mid, `Fritzing · ${title}`)
    }
  }
}

// ── pin classification (Fritzing has no pin types; best effort from the name) ──────────────────
function pinType(name) {
  const n = name.toUpperCase().replace(/\s+/g, '')
  if (/^(GND|VSS|AGND|DGND|GROUND|V-|0V|-|COM-?)\d*$/.test(n) || /^GND/.test(n)) return 'ground'
  if (/^(VCC|VDD|VIN|V\+|\+|VBAT|VBUS|VUSB|3V3|3\.3V|5V|\+5V|\+3\.3V|12V|\+12V|VS|VIO|VREF|AREF|IOREF|PWR|POWER)\d*$/.test(n)) return 'power'
  if (/^(GPIO|IO|D|P[A-Z]?)\d+/.test(n)) return 'gpio'
  if (/^(A|ADC)\d+$/.test(n)) return 'analog'
  if (/^(NC|N\/C)$/.test(n)) return 'nc'
  return 'passive'
}

/** Parts that no bin lists: group them by what their family / title / tags say they are. */
const FAMILY_SECTIONS = [
  ['Microcontroller', /arduino|esp(32|8266)|nodemcu|microcontroller|\bmcu\b|teensy|feather|wemos|raspberry|pico|attiny|atmega|\bpic\d|stm32|dev ?kit/],
  ['Input', /sensor|button|switch|potentiometer|encoder|joystick|keypad|microphone|accelerometer|gyro|thermistor|ldr|photo|\bpir\b|ultrasonic|gps|rfid|touch/],
  ['Output', /display|lcd|oled|led matrix|7.?segment|seven segment|speaker|buzzer|piezo|motor|servo|relay|vibration|neopixel|ws2812/],
  ['Power', /regulator|battery|power|buck|boost|charger|solar|fuse|transformer|ldo|supply/],
  ['Connection', /connector|header|terminal|jack|socket|usb|plug|cable|adapter|antenna/],
  ['Basic', /resistor|capacitor|inductor|diode|\bled\b|transistor|mosfet|crystal|oscillator|ferrite|zener/],
  ['ICs', /\bic\b|chip|dip|soic|shift register|driver|amplifier|op.?amp|logic|eeprom|memory|timer|multiplexer|mux|converter/],
  ['RF & Comms', /radio|rf\b|wifi|bluetooth|ble\b|xbee|lora|nrf|cellular|gsm|ethernet|can\b|rs.?485/],
]
function familyCategory(c) {
  const hay = [c.props.family, c.title, ...c.tags].join(' ').toLowerCase()
  for (const [sec, re] of FAMILY_SECTIONS) if (re.test(hay)) return `Fritzing · ${sec}`
  return 'Fritzing · Other'
}

const slugId = (s) => ('fz-' + String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')).slice(0, 80)

// ── parse every core fzp ─────────────────────────────────────────────────────────────────────
const skipped = []
const skip = (file, why) => skipped.push({ file, why })
const candidates = []
const files = ['core', 'contrib'].flatMap((d) => readdirSync(path.join(PARTS, d)).filter((f) => f.endsWith('.fzp')).sort().map((f) => ({ dir: d, f })))
const SVG_DIRS = ['core', 'contrib', 'user', 'obsolete']
for (const { dir, f } of files) {
  if (candidates.length >= LIMIT) break
  if (ONLY && !new RegExp(ONLY, 'i').test(f)) continue
  let doc
  try { doc = xml(readFileSync(path.join(PARTS, dir, f), 'utf8')) } catch (e) { skip(f, `unparseable fzp: ${e.message}`); continue }
  const mod = doc.documentElement
  if (!mod || mod.nodeName !== 'module') { skip(f, 'no <module>'); continue }
  const moduleId = mod.getAttribute('moduleId') || f.replace(/\.fzp$/, '')
  const props = {}
  for (const p of kids(kid(mod, 'properties'), 'property')) props[(p.getAttribute('name') || '').toLowerCase()] = text(p)
  const family = (props.family || '').toLowerCase()
  if (/^(breadboard|wire|jumper|via|hole|pad|logo|ruler|note|net label|power label|frame|schematic frame)/.test(family)) { skip(f, `non-component family '${props.family}'`); continue }
  const bbView = kid(kid(mod, 'views'), 'breadboardView')
  const image = kid(bbView, 'layers')?.getAttribute('image')
  if (!image) { skip(f, 'no breadboard view'); continue }
  const svgPath = SVG_DIRS.map((d) => path.join(PARTS, 'svg', d, image)).find((q) => existsSync(q))
  if (!svgPath) { skip(f, `breadboard svg missing: ${image}`); continue }
  const conns = []
  for (const c of Array.from(mod.getElementsByTagName('connector'))) {
    if (c.getAttribute('hybrid') === 'yes') continue
    const bb = kid(kid(c, 'views'), 'breadboardView')
    const p = kids(bb, 'p').find((q) => q.getAttribute('svgId') && q.getAttribute('hybrid') !== 'yes')
    conns.push({ cid: c.getAttribute('id'), name: (c.getAttribute('name') || c.getAttribute('id') || '').trim(), desc: text(kid(c, 'description')), svgId: p?.getAttribute('svgId') })
  }
  if (!conns.length) { skip(f, 'no connectors'); continue }
  if (conns.length > MAX_PINS) { skip(f, `${conns.length} connectors (max ${MAX_PINS})`); continue }
  if (conns.some((c) => !c.svgId)) { skip(f, 'a connector has no breadboard svgId'); continue }
  const svg = readFileSync(svgPath, 'utf8')
  if (svg.length > MAX_SVG) { skip(f, `breadboard svg ${(svg.length / 1e6).toFixed(1)} MB (max 4)`); continue }
  const buses = []
  for (const b of kids(kid(mod, 'buses'), 'bus')) buses.push(kids(b, 'nodeMember').map((m) => m.getAttribute('connectorId')))
  candidates.push({
    file: f, moduleId, title: text(kid(mod, 'title')) || moduleId, props,
    description: stripHtml(text(kid(mod, 'description'))).slice(0, 4000),
    tags: kids(kid(mod, 'tags'), 'tag').map(text).filter(Boolean).slice(0, 30),
    label: text(kid(mod, 'label')), author: text(kid(mod, 'author')), url: text(kid(mod, 'url')),
    conns, buses, svg, illustrator: /Illustrator/i.test(svg.slice(0, 2000)),
  })
}
console.log(`parsed ${candidates.length} candidate parts, ${skipped.length} skipped so far`)

// ── measure pins in a real browser ───────────────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage()
await page.setContent('<!doctype html><html><body style="margin:0"><div id="host"></div></body></html>')

const measure = (job) => page.evaluate(({ svgText, ids, illustrator, upi }) => {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) return { error: 'svg does not parse' }
  const toIn = (v, fallbackDpi) => {
    const m = /^\s*([0-9.]+)\s*([a-z%]*)\s*$/i.exec(v || '')
    if (!m) return null
    const n = parseFloat(m[1]), u = m[2].toLowerCase()
    if (u === 'in') return n
    if (u === 'mm') return n / 25.4
    if (u === 'cm') return n / 2.54
    if (u === 'pt') return n / 72
    if (u === 'pc') return n / 6
    if (u === 'px' || u === '') return n / fallbackDpi
    return null
  }
  const dpi = illustrator ? 72 : 90
  let vb = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
  let wIn = toIn(root.getAttribute('width'), dpi), hIn = toIn(root.getAttribute('height'), dpi)
  if (vb.length !== 4 || vb.some((x) => !Number.isFinite(x)) || vb[2] <= 0 || vb[3] <= 0) {
    if (wIn === null || hIn === null) return { error: 'no viewBox and no usable width/height' }
    // without a viewBox the user units are CSS px of the given width/height
    const rawW = /^\s*[0-9.]+\s*(px)?\s*$/i.test(root.getAttribute('width')) ? parseFloat(root.getAttribute('width')) : wIn * 96
    const rawH = /^\s*[0-9.]+\s*(px)?\s*$/i.test(root.getAttribute('height')) ? parseFloat(root.getAttribute('height')) : hIn * 96
    vb = [0, 0, rawW, rawH]
    root.setAttribute('viewBox', vb.join(' '))
  }
  if (wIn === null || hIn === null) { wIn = vb[2] / dpi; hIn = vb[3] / dpi }
  const W = Math.round(wIn * upi * 100) / 100, H = Math.round(hIn * upi * 100) / 100
  root.setAttribute('width', String(W)); root.setAttribute('height', String(H))
  root.setAttribute('preserveAspectRatio', 'none')
  const out = new XMLSerializer().serializeToString(root)
  const host = document.getElementById('host')
  host.innerHTML = ''
  const node = document.importNode(root, true)
  host.appendChild(node)
  const box = node.getBoundingClientRect()
  const pins = {}
  for (const id of ids) {
    let el = null
    try { el = node.querySelector(`[id="${CSS.escape(id)}"]`) } catch { el = null }
    if (!el || el.closest('defs')) { pins[id] = null; continue }
    const r = el.getBoundingClientRect()
    if (!r.width && !r.height && !r.x && !r.y) { pins[id] = null; continue }
    pins[id] = { x: Math.round((r.left + r.width / 2 - box.left) * 10) / 10, y: Math.round((r.top + r.height / 2 - box.top) * 10) / 10 }
  }
  host.innerHTML = ''
  return { W, H, svg: out, pins }
}, job)

const written = []
const tmp = `${OUT}.new`
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
const titleCount = new Map()
for (const c of candidates) titleCount.set(c.title, (titleCount.get(c.title) ?? 0) + 1)
const usedIds = new Set()

for (const [i, c] of candidates.entries()) {
  if (i % 100 === 0) console.log(`measuring ${i}/${candidates.length}`)
  let m
  try { m = await measure({ svgText: c.svg, ids: [...new Set(c.conns.map((q) => q.svgId))], illustrator: c.illustrator, upi: UNITS_PER_INCH }) }
  catch (e) { skip(c.file, `browser error: ${String(e.message).slice(0, 200)}`); continue }
  if (m.error) { skip(c.file, m.error); continue }
  if (!(m.W >= 5 && m.W <= 3000 && m.H >= 5 && m.H <= 3000)) { skip(c.file, `size ${m.W}x${m.H} units out of range`); continue }
  const missing = c.conns.filter((q) => !m.pins[q.svgId])
  if (missing.length) { skip(c.file, `${missing.length}/${c.conns.length} pins not found in the breadboard svg (e.g. ${missing.slice(0, 3).map((q) => q.svgId).join(', ')})`); continue }
  // pin ids: the Fritzing connector name, made unique (two GND pins → GND, GND_2)
  const seen = new Map(), idOf = new Map()
  const pins = c.conns.map((q) => {
    // Some parts name their connectors pin1, pin2… and keep the meaning in the description
    // ("22, GPIO1, TXD0", "Ground (2)") — use that instead.
    let nm = q.name || q.cid, type = pinType(nm), functions
    if (/^(pin|connector|conn|p)?[\s_-]?\d+$/i.test(nm) && q.desc && !/^(pin|connector)?[\s_-]?\d+$/i.test(q.desc)) {
      const gp = /\bGPIO\s?(\d+)\b/i.exec(q.desc)
      const d = q.desc.replace(/\s*\(\d+\)\s*$/, '').trim()
      type = /\b(ground|gnd)\b/i.test(d) ? 'ground' : /\b(3\.3|5|12)\s?v(olts?)?\b|\bvin\b|\bvcc\b|\bvdd\b|\bvusb\b/i.test(d) ? 'power' : gp ? 'gpio' : pinType(d)
      functions = d.split(/\s*[,/]\s*/).filter((t) => t && t.length <= 20).slice(0, 20)
      nm = gp ? `GPIO${gp[1]}` : d
    }
    const base = nm.slice(0, 34)
    const k = base.toLowerCase(), nth = (seen.get(k) ?? 0) + 1
    seen.set(k, nth)
    const id = nth === 1 ? base : `${base}_${nth}`
    idOf.set(q.cid, id)
    const { x, y } = m.pins[q.svgId]
    const d = { L: x, R: m.W - x, T: y, B: m.H - y }
    const side = Object.entries(d).sort((a, b) => a[1] - b[1])[0][0]
    const p = { id, name: nm.slice(0, 40), x, y, side, type }
    if (functions?.length) p.functions = functions
    if (q.desc && q.desc !== nm) p.notes = q.desc.slice(0, 1000)
    return p
  })
  const buses = c.buses.map((b) => b.map((cid) => idOf.get(cid)).filter(Boolean)).filter((b) => b.length > 1)
  let id = slugId(c.moduleId)
  for (let n = 2; usedIds.has(id); n++) id = `${slugId(c.moduleId).slice(0, 74)}-${n}`
  usedIds.add(id)
  const variant = c.props.variant || c.props.package || c.props.type
  const name = (titleCount.get(c.title) > 1 && variant ? `${c.title} (${variant})` : c.title).slice(0, 120)
  const prefix = (c.label || '').toUpperCase()
  const part = {
    id, name, category: category.get(c.moduleId) ?? familyCategory(c),
    refPrefix: /^[A-Z]{1,3}$/.test(prefix) ? prefix : 'U',
    description: c.description || undefined,
    tags: [...new Set([...c.tags, c.props.family].filter(Boolean))].slice(0, 30),
    source: 'fritzing', license: 'CC-BY-SA 3.0 — Fritzing parts library',
    width: m.W, height: m.H, svg: m.svg, pins,
    ...(buses.length ? { buses } : {}),
    schematic: { symbol: 'box' },
    props: Object.fromEntries(Object.entries({ fritzingModuleId: c.moduleId, fritzingFile: c.file, author: c.author, url: c.url, family: c.props.family, variant }).filter(([, v]) => v)),
  }
  writeFileSync(path.join(tmp, `${id}.json`), JSON.stringify(part))
  written.push(id)
}
await browser.close()

let rev = ''
try { rev = readFileSync(path.join(PARTS, '.git/HEAD'), 'utf8').trim(); if (rev.startsWith('ref:')) rev = readFileSync(path.join(PARTS, '.git', rev.slice(5).trim()), 'utf8').trim() } catch { /* not a git checkout */ }
writeFileSync(path.join(tmp, '_report.json'), JSON.stringify({ importedAt: new Date().toISOString(), fritzingPartsRev: rev, imported: written.length, skipped }, null, 1))
// swap in: old → .old, new → out, then drop .old
const old = `${OUT}.old`
rmSync(old, { recursive: true, force: true })
if (existsSync(OUT)) renameSync(OUT, old)
renameSync(tmp, OUT)
rmSync(old, { recursive: true, force: true })
console.log(`imported ${written.length} parts, skipped ${skipped.length} → ${OUT}`)
