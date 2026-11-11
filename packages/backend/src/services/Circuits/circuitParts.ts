/**
 * Circuit Designer — built-in parts library.
 *
 * Coordinates are in "units" where 10 units = 0.1" (one breadboard pitch), so header pins sit on a
 * 10-unit grid. Every part carries its breadboard art as an SVG string plus a pin table with each
 * pin's position on that art. The pin table is the important half: it is what agents read to wire a
 * design and what the design checks reason about (strapping pins, input-only, ADC2, voltages).
 *
 * 🛑 Board pinouts below are from the vendors' published pinouts. Clones move pins around — check the
 * silkscreen of the board in hand before trusting a wire to a specific header position.
 */

export type PinType = 'power' | 'ground' | 'gpio' | 'input' | 'output' | 'analog' | 'passive' | 'nc' | 'other'
export type PinSide = 'L' | 'R' | 'T' | 'B'

export interface PinDef {
  id: string
  name: string
  x: number
  y: number
  side: PinSide
  type: PinType
  /** Alternate functions, e.g. ['ADC1_CH4', 'TOUCH4'] */
  functions?: string[]
  /** Machine-readable warnings: strapping, input-only, flash, adc2, psram-octal, usb, boot-button, led */
  flags?: string[]
  /** Supply voltage for power pins (what the pin provides or expects) */
  voltage?: number
  notes?: string
}

export type SchSymbol = 'box' | 'resistor' | 'led' | 'diode' | 'cap' | 'cap-pol' | 'button' | 'npn' | 'nmos'

export interface PartDef {
  id: string
  name: string
  category: string
  /** Reference-designator prefix: U, R, D, C, SW, J, K, Q */
  refPrefix: string
  description?: string
  tags?: string[]
  source: 'builtin' | 'custom' | 'fritzing'
  license?: string
  width: number
  height: number
  /** Breadboard art (SVG document). Either this or `image`. */
  svg?: string
  /** Breadboard art as a data: URL (custom parts made from an uploaded PNG/SVG). */
  image?: string
  pins: PinDef[]
  /** Pin groups that are connected inside the part (all GND pins on a dev board, etc.) */
  buses?: string[][]
  schematic?: { symbol: SchSymbol }
  /** Free-form properties: i2cAddress, logicVoltage, supplyMin, supplyMax, datasheet ... */
  props?: Record<string, unknown>
  updatedAt?: string
}

// ── pin specs ─────────────────────────────────────────────────────────────────────────────────
type Extra = { id?: string; fn?: string[]; flags?: string[]; v?: number; notes?: string }
type PinSpec = [name: string, type: PinType, extra?: Extra]

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Lay a header row of pins out along one side of a board. */
function header(side: PinSide, specs: PinSpec[], w: number, h: number, start: number, inset = 5): PinDef[] {
  return specs.map(([name, type, ex], i) => {
    const along = start + 5 + i * 10
    const x = side === 'L' ? inset : side === 'R' ? w - inset : along
    const y = side === 'T' ? inset : side === 'B' ? h - inset : along
    const p: PinDef = { id: ex?.id ?? name, name, x, y, side, type }
    if (ex?.fn?.length) p.functions = ex.fn
    if (ex?.flags?.length) p.flags = ex.flags
    if (ex?.v !== undefined) p.voltage = ex.v
    if (ex?.notes) p.notes = ex.notes
    return p
  })
}

/** Give duplicate names (GND, GND, 3V3, 3V3) unique ids: GND, GND_2, GND_3. */
function uniqueIds(pins: PinDef[]): PinDef[] {
  const seen = new Map<string, number>()
  for (const p of pins) {
    const n = (seen.get(p.id) ?? 0) + 1
    seen.set(p.id, n)
    if (n > 1) p.id = `${p.id}_${n}`
  }
  return pins
}

/** Every pin whose NAME matches is one bus (GND pins on a board are tied together). */
function busesByName(pins: PinDef[], names: string[]): string[][] {
  return names
    .map((n) => pins.filter((p) => p.name === n).map((p) => p.id))
    .filter((g) => g.length > 1)
}

// ── SVG art ───────────────────────────────────────────────────────────────────────────────────
interface ModuleArt {
  w: number; h: number; color: string; label: string; sub?: string
  pins: PinDef[]
  usb?: 'top' | 'bottom'
  can?: { x: number; y: number; w: number; h: number; label?: string }
  /** Small extra drawing (sensor window, LED, terminal blocks) */
  extra?: string
  labelInside?: boolean
}

function moduleSvg(a: ModuleArt): string {
  const parts: string[] = []
  parts.push(`<rect x="0.5" y="0.5" width="${a.w - 1}" height="${a.h - 1}" rx="3" fill="${a.color}" stroke="#0b0b0b" stroke-width="0.8"/>`)
  // mounting-hole-ish corner dots
  for (const [cx, cy] of [[4, 4], [a.w - 4, 4], [4, a.h - 4], [a.w - 4, a.h - 4]]) {
    if (a.pins.some((p) => Math.abs(p.x - cx) < 6 && Math.abs(p.y - cy) < 6)) continue
    parts.push(`<circle cx="${cx}" cy="${cy}" r="1.6" fill="#00000055"/>`)
  }
  if (a.usb) {
    const uw = Math.min(26, a.w * 0.35), ux = (a.w - uw) / 2
    const uy = a.usb === 'top' ? -3 : a.h - 9
    parts.push(`<rect x="${ux}" y="${uy}" width="${uw}" height="12" rx="2" fill="#c9ccd1" stroke="#7d8188" stroke-width="0.6"/>`)
    parts.push(`<rect x="${ux + 3}" y="${uy + 4}" width="${uw - 6}" height="4" rx="1" fill="#55595f"/>`)
  }
  if (a.can) {
    const c = a.can
    parts.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="1.5" fill="#d7d9dc" stroke="#8a8e94" stroke-width="0.6"/>`)
    if (c.label) parts.push(`<text x="${c.x + c.w / 2}" y="${c.y + c.h / 2 + 1.6}" font-size="4.6" font-family="sans-serif" fill="#3b3f45" text-anchor="middle">${esc(c.label)}</text>`)
  }
  if (a.extra) parts.push(a.extra)
  // header pads + labels
  for (const p of a.pins) {
    parts.push(`<rect x="${p.x - 3.2}" y="${p.y - 3.2}" width="6.4" height="6.4" rx="1" fill="#d4a017" stroke="#8a6508" stroke-width="0.5"/>`)
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="1.5" fill="#2b2b2b"/>`)
    const fs = 3.6
    let tx = p.x, ty = p.y + fs / 2.8, anchor = 'middle', rot = ''
    if (p.side === 'L') { tx = p.x + 5.5; anchor = 'start' }
    else if (p.side === 'R') { tx = p.x - 5.5; anchor = 'end' }
    else if (p.side === 'B') { ty = p.y - 5.5; rot = ` transform="rotate(-90 ${tx} ${ty})"`; anchor = 'start' }
    else if (p.side === 'T') { ty = p.y + 5.5; rot = ` transform="rotate(-90 ${tx} ${ty})"`; anchor = 'end' }
    parts.push(`<text x="${tx}" y="${ty}" font-size="${fs}" font-family="monospace" fill="#f2f2f2" text-anchor="${anchor}"${rot}>${esc(p.name)}</text>`)
  }
  // title
  const tall = a.h > a.w * 1.4
  const cx = a.w / 2, cy = a.h / 2
  const t = tall
    ? `<text x="${cx}" y="${cy}" font-size="6" font-weight="bold" font-family="sans-serif" fill="#ffffffcc" text-anchor="middle" transform="rotate(-90 ${cx} ${cy})">${esc(a.label)}</text>`
    : `<text x="${cx}" y="${a.labelInside === false ? a.h + 7 : cy - 1}" font-size="5" font-weight="bold" font-family="sans-serif" fill="#ffffffcc" text-anchor="middle">${esc(a.label)}</text>`
  parts.push(t)
  if (a.sub) parts.push(tall
    ? `<text x="${cx + 7}" y="${cy}" font-size="3.6" font-family="sans-serif" fill="#ffffff99" text-anchor="middle" transform="rotate(-90 ${cx + 7} ${cy})">${esc(a.sub)}</text>`
    : `<text x="${cx}" y="${cy + 6}" font-size="3.6" font-family="sans-serif" fill="#ffffff99" text-anchor="middle">${esc(a.sub)}</text>`)
  return wrapSvg(a.w, a.h, parts.join(''))
}

function wrapSvg(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`
}

/** Pin flags/functions helper. */
const g = (fn: string[] = [], flags: string[] = [], id?: string, notes?: string): Extra => ({ fn, flags, id, notes })

// ── ESP32 DevKitC V4 (38-pin, WROOM-32) ───────────────────────────────────────────────────────
function esp32DevkitC(): PartDef {
  const w = 110, h = 230, top = 22
  const L: PinSpec[] = [
    ['3V3', 'power', { v: 3.3 }],
    ['EN', 'input', g([], ['reset'], 'EN', 'Chip enable / reset. Pulled up on the board.')],
    ['VP', 'input', g(['GPIO36', 'ADC1_CH0', 'SENSOR_VP'], ['input-only'], 'GPIO36')],
    ['VN', 'input', g(['GPIO39', 'ADC1_CH3', 'SENSOR_VN'], ['input-only'], 'GPIO39')],
    ['IO34', 'input', g(['GPIO34', 'ADC1_CH6'], ['input-only'], 'GPIO34')],
    ['IO35', 'input', g(['GPIO35', 'ADC1_CH7'], ['input-only'], 'GPIO35')],
    ['IO32', 'gpio', g(['GPIO32', 'ADC1_CH4', 'TOUCH9', 'XTAL_32K_P'], [], 'GPIO32')],
    ['IO33', 'gpio', g(['GPIO33', 'ADC1_CH5', 'TOUCH8', 'XTAL_32K_N'], [], 'GPIO33')],
    ['IO25', 'gpio', g(['GPIO25', 'ADC2_CH8', 'DAC1'], ['adc2'], 'GPIO25')],
    ['IO26', 'gpio', g(['GPIO26', 'ADC2_CH9', 'DAC2'], ['adc2'], 'GPIO26')],
    ['IO27', 'gpio', g(['GPIO27', 'ADC2_CH7', 'TOUCH7'], ['adc2'], 'GPIO27')],
    ['IO14', 'gpio', g(['GPIO14', 'ADC2_CH6', 'TOUCH6', 'HSPI_CLK', 'MTMS'], ['adc2'], 'GPIO14', 'Outputs a PWM signal at boot.')],
    ['IO12', 'gpio', g(['GPIO12', 'ADC2_CH5', 'TOUCH5', 'HSPI_MISO', 'MTDI'], ['adc2', 'strapping'], 'GPIO12', 'Strapping (flash voltage). Must be LOW at boot or a 3.3 V-flash module will not boot.')],
    ['GND', 'ground'],
    ['IO13', 'gpio', g(['GPIO13', 'ADC2_CH4', 'TOUCH4', 'HSPI_MOSI', 'MTCK'], ['adc2'], 'GPIO13')],
    ['SD2', 'gpio', g(['GPIO9', 'FLASH_D2'], ['flash'], 'GPIO9', 'Connected to the SPI flash. Do not use.')],
    ['SD3', 'gpio', g(['GPIO10', 'FLASH_D3'], ['flash'], 'GPIO10', 'Connected to the SPI flash. Do not use.')],
    ['CMD', 'gpio', g(['GPIO11', 'FLASH_CMD'], ['flash'], 'GPIO11', 'Connected to the SPI flash. Do not use.')],
    ['5V', 'power', { v: 5, notes: 'USB 5 V / external 5 V input.' }],
  ]
  const R: PinSpec[] = [
    ['GND', 'ground'],
    ['IO23', 'gpio', g(['GPIO23', 'VSPI_MOSI'], [], 'GPIO23')],
    ['IO22', 'gpio', g(['GPIO22', 'I2C_SCL (default)'], [], 'GPIO22')],
    ['TX', 'gpio', g(['GPIO1', 'U0TXD'], ['uart0'], 'GPIO1', 'USB-serial TX. Busy during flashing and logging.')],
    ['RX', 'gpio', g(['GPIO3', 'U0RXD'], ['uart0'], 'GPIO3', 'USB-serial RX. Busy during flashing.')],
    ['IO21', 'gpio', g(['GPIO21', 'I2C_SDA (default)'], [], 'GPIO21')],
    ['GND', 'ground'],
    ['IO19', 'gpio', g(['GPIO19', 'VSPI_MISO'], [], 'GPIO19')],
    ['IO18', 'gpio', g(['GPIO18', 'VSPI_CLK'], [], 'GPIO18')],
    ['IO5', 'gpio', g(['GPIO5', 'VSPI_CS'], ['strapping'], 'GPIO5', 'Strapping (SDIO timing). Outputs PWM at boot.')],
    ['IO17', 'gpio', g(['GPIO17', 'U2TXD'], [], 'GPIO17')],
    ['IO16', 'gpio', g(['GPIO16', 'U2RXD'], [], 'GPIO16')],
    ['IO4', 'gpio', g(['GPIO4', 'ADC2_CH0', 'TOUCH0'], ['adc2'], 'GPIO4')],
    ['IO0', 'gpio', g(['GPIO0', 'ADC2_CH1', 'TOUCH1'], ['adc2', 'strapping', 'boot-button'], 'GPIO0', 'Strapping: LOW at boot = download mode. Wired to the BOOT button.')],
    ['IO2', 'gpio', g(['GPIO2', 'ADC2_CH2', 'TOUCH2'], ['adc2', 'strapping'], 'GPIO2', 'Strapping: must be LOW/floating to enter download mode.')],
    ['IO15', 'gpio', g(['GPIO15', 'ADC2_CH3', 'TOUCH3', 'HSPI_CS', 'MTDO'], ['adc2', 'strapping'], 'GPIO15', 'Strapping: LOW silences boot log. Outputs PWM at boot.')],
    ['SD1', 'gpio', g(['GPIO8', 'FLASH_D1'], ['flash'], 'GPIO8', 'Connected to the SPI flash. Do not use.')],
    ['SD0', 'gpio', g(['GPIO7', 'FLASH_D0'], ['flash'], 'GPIO7', 'Connected to the SPI flash. Do not use.')],
    ['CLK', 'gpio', g(['GPIO6', 'FLASH_CLK'], ['flash'], 'GPIO6', 'Connected to the SPI flash. Do not use.')],
  ]
  const pins = uniqueIds([...header('L', L, w, h, top), ...header('R', R, w, h, top)])
  return {
    id: 'esp32-devkitc-v4', name: 'ESP32 DevKitC V4 (38-pin)', category: 'Microcontrollers', refPrefix: 'U',
    description: 'Espressif ESP32-DevKitC V4 with ESP32-WROOM-32. 3.3 V logic; 5 V pin feeds the on-board LDO.',
    tags: ['esp32', 'wroom', 'devkit', 'wifi', 'bluetooth'], source: 'builtin', width: w, height: h,
    svg: moduleSvg({ w, h, color: '#1d2a3a', label: 'ESP32-DevKitC', sub: 'WROOM-32', pins, usb: 'bottom', can: { x: 22, y: 6, w: 66, h: 70, label: 'ESP32-WROOM-32' } }),
    pins, buses: busesByName(pins, ['GND']),
    props: { logicVoltage: 3.3, chip: 'ESP32', i2cDefault: { sda: 'GPIO21', scl: 'GPIO22' } },
  }
}

// ── ESP32-S3-DevKitC-1 ────────────────────────────────────────────────────────────────────────
function esp32S3DevkitC1(): PartDef {
  const w = 110, h = 262, top = 22
  const io = (n: number, fn: string[] = [], flags: string[] = [], notes?: string): PinSpec => [String(n), 'gpio', g([`GPIO${n}`, ...fn], flags, `GPIO${n}`, notes)]
  const adc = (n: number) => (n >= 1 && n <= 10 ? [`ADC1_CH${n - 1}`, `TOUCH${n}`] : n >= 11 && n <= 20 ? [`ADC2_CH${n - 11}`, ...(n <= 14 ? [`TOUCH${n}`] : [])] : [])
  const L: PinSpec[] = [
    ['3V3', 'power', { v: 3.3 }], ['3V3', 'power', { v: 3.3 }],
    ['RST', 'input', g([], ['reset'], 'RST', 'EN / reset.')],
    io(4, adc(4)), io(5, adc(5)), io(6, adc(6)), io(7, adc(7)),
    io(15, [...adc(15), 'XTAL_32K_P'], ['adc2']), io(16, [...adc(16), 'XTAL_32K_N'], ['adc2']),
    io(17, adc(17), ['adc2']), io(18, adc(18), ['adc2']), io(8, adc(8)),
    io(3, adc(3), ['strapping'], 'Strapping (JTAG source select).'),
    io(46, [], ['strapping'], 'Strapping (boot mode / ROM log). Input-only on some revisions.'),
    io(9, adc(9)), io(10, adc(10)), io(11, adc(11), ['adc2']), io(12, adc(12), ['adc2']),
    io(13, adc(13), ['adc2']), io(14, adc(14), ['adc2']),
    ['5V', 'power', { v: 5 }], ['GND', 'ground'],
  ]
  const R: PinSpec[] = [
    ['GND', 'ground'],
    ['TX', 'gpio', g(['GPIO43', 'U0TXD'], ['uart0'], 'GPIO43', 'UART0 TX (USB-UART bridge port).')],
    ['RX', 'gpio', g(['GPIO44', 'U0RXD'], ['uart0'], 'GPIO44', 'UART0 RX (USB-UART bridge port).')],
    io(1, adc(1)), io(2, adc(2)),
    io(42, ['MTMS'], ['jtag']), io(41, ['MTDI'], ['jtag']), io(40, ['MTDO'], ['jtag']), io(39, ['MTCK'], ['jtag']),
    io(38, [], [], 'RGB LED on DevKitC-1 v1.1 (GPIO48 on v1.0).'),
    io(37, [], ['psram-octal'], 'Used by octal PSRAM on N8R8/N16R8 modules.'),
    io(36, [], ['psram-octal'], 'Used by octal PSRAM on N8R8/N16R8 modules.'),
    io(35, [], ['psram-octal'], 'Used by octal PSRAM on N8R8/N16R8 modules.'),
    io(0, [], ['strapping', 'boot-button'], 'Strapping: LOW at boot = download mode. BOOT button.'),
    io(45, [], ['strapping'], 'Strapping (VDD_SPI voltage). Keep LOW at boot.'),
    io(48, [], [], 'RGB LED on DevKitC-1 v1.0.'), io(47, []),
    io(21, []), io(20, [...adc(20), 'USB_D+'], ['adc2', 'usb']), io(19, [...adc(19), 'USB_D-'], ['adc2', 'usb']),
    ['GND', 'ground'], ['GND', 'ground'],
  ]
  const pins = uniqueIds([...header('L', L, w, h, top), ...header('R', R, w, h, top)])
  return {
    id: 'esp32-s3-devkitc-1', name: 'ESP32-S3-DevKitC-1', category: 'Microcontrollers', refPrefix: 'U',
    description: 'Espressif ESP32-S3-DevKitC-1 (WROOM-1). 3.3 V logic. Two USB ports (UART bridge + native USB on GPIO19/20).',
    tags: ['esp32-s3', 'devkit', 'wifi', 'bluetooth', 'usb'], source: 'builtin', width: w, height: h,
    svg: moduleSvg({ w, h, color: '#1d2a3a', label: 'ESP32-S3-DevKitC-1', sub: 'WROOM-1', pins, usb: 'bottom', can: { x: 22, y: 6, w: 66, h: 74, label: 'ESP32-S3-WROOM-1' } }),
    pins, buses: busesByName(pins, ['GND', '3V3']),
    props: { logicVoltage: 3.3, chip: 'ESP32-S3' },
  }
}

// ── ESP32-C3 SuperMini ────────────────────────────────────────────────────────────────────────
function esp32C3SuperMini(): PartDef {
  const w = 72, h = 100, top = 14
  const io = (n: number, fn: string[] = [], flags: string[] = [], notes?: string): PinSpec => [String(n), 'gpio', g([`GPIO${n}`, ...fn], flags, `GPIO${n}`, notes)]
  const L: PinSpec[] = [
    ['5V', 'power', { v: 5 }], ['GND', 'ground'], ['3V3', 'power', { v: 3.3 }],
    io(4, ['ADC1_CH4']), io(3, ['ADC1_CH3']), io(2, ['ADC1_CH2'], ['strapping'], 'Strapping: must be HIGH at boot.'),
    io(1, ['ADC1_CH1']), io(0, ['ADC1_CH0']),
  ]
  const R: PinSpec[] = [
    io(5, ['ADC2_CH0'], ['adc2']), io(6), io(7),
    io(8, [], ['strapping', 'led'], 'Strapping (must be HIGH for download mode). On-board blue LED, active LOW.'),
    io(9, [], ['strapping', 'boot-button'], 'Strapping: LOW at boot = download mode. BOOT button.'),
    io(10), io(20, ['U0RXD']), io(21, ['U0TXD']),
  ]
  const pins = uniqueIds([...header('L', L, w, h, top), ...header('R', R, w, h, top)])
  return {
    id: 'esp32-c3-supermini', name: 'ESP32-C3 SuperMini', category: 'Microcontrollers', refPrefix: 'U',
    description: 'Tiny ESP32-C3 board with native USB-C. 3.3 V logic. GPIO18/19 are the USB pins (not broken out).',
    tags: ['esp32-c3', 'supermini', 'wifi', 'bluetooth', 'riscv'], source: 'builtin', width: w, height: h,
    svg: moduleSvg({ w, h, color: '#111418', label: 'C3 SuperMini', pins, usb: 'top', can: { x: 18, y: 30, w: 36, h: 36, label: 'ESP32-C3' } }),
    pins, buses: [],
    props: { logicVoltage: 3.3, chip: 'ESP32-C3' },
  }
}

// ── breakout modules ──────────────────────────────────────────────────────────────────────────
interface BreakoutOpts {
  id: string; name: string; category: string; refPrefix?: string; description: string; tags: string[]
  color: string; label: string; sub?: string; pins: PinSpec[]; side?: PinSide; h?: number; w?: number
  extra?: (w: number, h: number) => string; props?: Record<string, unknown>; buses?: string[]
  /** Pins on a second side (relay output terminals) */
  pins2?: PinSpec[]; side2?: PinSide
}
function breakout(o: BreakoutOpts): PartDef {
  const side = o.side ?? 'B'
  const n = Math.max(o.pins.length, o.pins2?.length ?? 0)
  const horiz = side === 'B' || side === 'T'
  const w = o.w ?? (horiz ? n * 10 + 10 : 70)
  const h = o.h ?? (horiz ? 50 : n * 10 + 14)
  // Centre a row of k pins on the side: first pin at (len - (k-1)*10) / 2; header() adds 5.
  const startFor = (s: PinSide, k: number) => Math.round(((s === 'B' || s === 'T' ? w : h) - (k - 1) * 10) / 2 - 5)
  let pins = header(side, o.pins, w, h, startFor(side, o.pins.length))
  if (o.pins2 && o.side2) pins = pins.concat(header(o.side2, o.pins2, w, h, startFor(o.side2, o.pins2.length)))
  pins = uniqueIds(pins)
  return {
    id: o.id, name: o.name, category: o.category, refPrefix: o.refPrefix ?? 'U', description: o.description, tags: o.tags,
    source: 'builtin', width: w, height: h,
    svg: moduleSvg({ w, h, color: o.color, label: o.label, sub: o.sub, pins, extra: o.extra?.(w, h) }),
    pins, buses: o.buses ? busesByName(pins, o.buses) : [], props: o.props,
  }
}

// ── discrete parts (hand-drawn art) ───────────────────────────────────────────────────────────
function twoPin(o: {
  id: string; name: string; category: string; refPrefix: string; description: string; tags: string[]
  w: number; h: number; art: string; a: [string, string, PinType, number, number]; b: [string, string, PinType, number, number]
  symbol: SchSymbol; props?: Record<string, unknown>
}): PartDef {
  const mk = ([id, name, type, x, y]: [string, string, PinType, number, number], side: PinSide): PinDef => ({ id, name, type, x, y, side })
  return {
    id: o.id, name: o.name, category: o.category, refPrefix: o.refPrefix, description: o.description, tags: o.tags,
    source: 'builtin', width: o.w, height: o.h, svg: wrapSvg(o.w, o.h, o.art),
    pins: [mk(o.a, 'L'), mk(o.b, 'R')], schematic: { symbol: o.symbol }, props: o.props,
  }
}

const lead = (x1: number, y1: number, x2: number, y2: number) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#a7a9ad" stroke-width="1.2" stroke-linecap="round"/>`
const pad = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="1.8" fill="#c9ccd1" stroke="#6d7177" stroke-width="0.5"/>`

function resistor(): PartDef {
  const art = lead(5, 5, 15, 5) + lead(35, 5, 45, 5) +
    `<rect x="14" y="1.5" width="22" height="7" rx="3" fill="#d8c08a" stroke="#8f7a4a" stroke-width="0.5"/>` +
    `<rect x="18" y="1.5" width="2" height="7" fill="#7a4a1f"/><rect x="22" y="1.5" width="2" height="7" fill="#111"/>` +
    `<rect x="26" y="1.5" width="2" height="7" fill="#e5484d"/><rect x="32" y="1.5" width="2" height="7" fill="#c9a227"/>` +
    pad(5, 5) + pad(45, 5)
  return twoPin({
    id: 'resistor', name: 'Resistor', category: 'Passives', refPrefix: 'R', description: 'Through-hole resistor. Set the value in the part properties.',
    tags: ['resistor', 'passive', 'pull-up', 'pull-down'], w: 50, h: 10, art, a: ['1', '1', 'passive', 5, 5], b: ['2', '2', 'passive', 45, 5],
    symbol: 'resistor', props: { value: '10k' },
  })
}

function led(color: string, id: string, label: string): PartDef {
  const art = lead(6, 18, 6, 35) + lead(14, 18, 14, 31) +
    `<path d="M3 18 V8 a7 7 0 0 1 14 0 V18 Z" fill="${color}" fill-opacity="0.85" stroke="#00000055" stroke-width="0.6"/>` +
    `<rect x="2" y="17" width="16" height="2.5" rx="0.8" fill="${color}" stroke="#00000055" stroke-width="0.5"/>` +
    pad(6, 35) + pad(14, 31)
  return twoPin({
    id, name: `LED (${label})`, category: 'Passives', refPrefix: 'D', description: `5 mm ${label.toLowerCase()} LED. Long leg = anode (A). Needs a series resistor.`,
    tags: ['led', 'indicator', label.toLowerCase()], w: 20, h: 38, art,
    a: ['A', 'A (+)', 'passive', 6, 35], b: ['K', 'K (−)', 'passive', 14, 31], symbol: 'led', props: { forwardVoltage: label === 'Red' ? 2.0 : 3.0, color: label },
  })
}

function button(): PartDef {
  const art = lead(5, 25, 5, 18) + lead(25, 25, 25, 18) +
    `<rect x="2" y="2" width="26" height="18" rx="2" fill="#2b2f36" stroke="#0e0f11" stroke-width="0.6"/>` +
    `<circle cx="15" cy="11" r="6" fill="#4b525c" stroke="#16181b" stroke-width="0.6"/>` + pad(5, 25) + pad(25, 25)
  return twoPin({
    id: 'pushbutton', name: 'Push button (momentary)', category: 'Input', refPrefix: 'SW', description: '6 mm tactile switch, normally open.',
    tags: ['button', 'switch', 'tactile', 'input'], w: 30, h: 28, art, a: ['1', '1', 'passive', 5, 25], b: ['2', '2', 'passive', 25, 25], symbol: 'button',
  })
}

function ceramicCap(): PartDef {
  const art = lead(6, 14, 6, 25) + lead(14, 14, 14, 25) +
    `<ellipse cx="10" cy="8" rx="8" ry="7" fill="#d68a2e" stroke="#8a5516" stroke-width="0.6"/>` +
    `<text x="10" y="9.6" font-size="4" font-family="monospace" fill="#3b2208" text-anchor="middle">104</text>` + pad(6, 25) + pad(14, 25)
  return twoPin({
    id: 'capacitor-ceramic', name: 'Capacitor (ceramic)', category: 'Passives', refPrefix: 'C', description: 'Ceramic disc capacitor. 104 = 100 nF.',
    tags: ['capacitor', 'decoupling', 'ceramic'], w: 20, h: 28, art, a: ['1', '1', 'passive', 6, 25], b: ['2', '2', 'passive', 14, 25], symbol: 'cap', props: { value: '100nF' },
  })
}

function electrolyticCap(): PartDef {
  const art = lead(6, 24, 6, 33) + lead(14, 24, 14, 33) +
    `<rect x="1" y="1" width="18" height="24" rx="3" fill="#1f3a8a" stroke="#0e1d45" stroke-width="0.6"/>` +
    `<rect x="13" y="1" width="5" height="24" fill="#c9d3ea" fill-opacity="0.7"/>` +
    `<text x="15.5" y="14" font-size="5" font-family="sans-serif" fill="#0e1d45" text-anchor="middle">−</text>` + pad(6, 33) + pad(14, 33)
  return twoPin({
    id: 'capacitor-electrolytic', name: 'Capacitor (electrolytic)', category: 'Passives', refPrefix: 'C', description: 'Polarised electrolytic capacitor. Stripe side = negative.',
    tags: ['capacitor', 'bulk', 'electrolytic', 'polarised'], w: 20, h: 36, art,
    a: ['+', '+', 'passive', 6, 33], b: ['-', '−', 'passive', 14, 33], symbol: 'cap-pol', props: { value: '100uF', voltage: '25V' },
  })
}

function diode(): PartDef {
  const art = lead(5, 5, 15, 5) + lead(35, 5, 45, 5) +
    `<rect x="14" y="1.5" width="22" height="7" rx="1.5" fill="#1b1b1b"/><rect x="31" y="1.5" width="3" height="7" fill="#c9ccd1"/>` + pad(5, 5) + pad(45, 5)
  return twoPin({
    id: 'diode-1n4007', name: 'Diode 1N4007', category: 'Passives', refPrefix: 'D', description: 'General-purpose rectifier / flyback diode. Stripe = cathode (K).',
    tags: ['diode', 'flyback', 'rectifier'], w: 50, h: 10, art, a: ['A', 'A', 'passive', 5, 5], b: ['K', 'K', 'passive', 45, 5], symbol: 'diode',
  })
}

function threePinPackage(o: {
  id: string; name: string; category: string; refPrefix: string; description: string; tags: string[]
  pins: Array<[string, string, PinType]>; body: 'to92' | 'to220'; label: string; symbol: SchSymbol
}): PartDef {
  const w = 30, h = o.body === 'to220' ? 52 : 34
  const yPin = h - 3
  const xs = [5, 15, 25]
  let art = xs.map((x) => lead(x, o.body === 'to220' ? 34 : 18, x, yPin)).join('')
  art += o.body === 'to92'
    ? `<path d="M3 18 V8 a12 8 0 0 1 24 0 V18 Z" fill="#202225" stroke="#000" stroke-width="0.5"/>`
    : `<rect x="3" y="0" width="24" height="12" rx="1" fill="#b6b9be" stroke="#6d7177" stroke-width="0.5"/><circle cx="15" cy="6" r="2.6" fill="#55595f"/><rect x="2" y="12" width="26" height="22" rx="1" fill="#202225"/>`
  art += `<text x="15" y="${o.body === 'to92' ? 14 : 25}" font-size="3.6" font-family="monospace" fill="#d0d0d0" text-anchor="middle">${esc(o.label)}</text>`
  art += xs.map((x) => pad(x, yPin)).join('')
  const pins: PinDef[] = o.pins.map(([id, name, type], i) => ({ id, name, type, x: xs[i], y: yPin, side: 'B' as PinSide }))
  return { id: o.id, name: o.name, category: o.category, refPrefix: o.refPrefix, description: o.description, tags: o.tags, source: 'builtin', width: w, height: h, svg: wrapSvg(w, h, art), pins, schematic: { symbol: o.symbol } }
}

function powerSource(o: { id: string; name: string; v: number; color: string; label: string; description: string; tags: string[] }): PartDef {
  const w = 40, h = 40
  const pins: PinDef[] = [
    { id: '+', name: `+${o.v}V`, x: 10, y: 35, side: 'B', type: 'power', voltage: o.v },
    { id: '-', name: 'GND', x: 30, y: 35, side: 'B', type: 'ground' },
  ]
  const art = `<rect x="1" y="1" width="38" height="28" rx="3" fill="${o.color}" stroke="#000" stroke-width="0.6"/>` +
    `<text x="20" y="13" font-size="6" font-weight="bold" font-family="sans-serif" fill="#fff" text-anchor="middle">${esc(o.label)}</text>` +
    `<text x="20" y="22" font-size="4" font-family="sans-serif" fill="#ffffffcc" text-anchor="middle">${o.v} V</text>` +
    lead(10, 29, 10, 35) + lead(30, 29, 30, 35) +
    `<text x="10" y="27" font-size="4" font-family="sans-serif" fill="#ff6b6b" text-anchor="middle">+</text><text x="30" y="27" font-size="4" font-family="sans-serif" fill="#ccc" text-anchor="middle">−</text>` +
    pad(10, 35) + pad(30, 35)
  return { id: o.id, name: o.name, category: 'Power', refPrefix: 'J', description: o.description, tags: o.tags, source: 'builtin', width: w, height: h, svg: wrapSvg(w, h, art), pins, props: { outputVoltage: o.v } }
}

// ── the library ───────────────────────────────────────────────────────────────────────────────
const P = (name: string, type: PinType, extra?: Extra): PinSpec => [name, type, extra]
const pwr = (v: number, name = 'VCC'): PinSpec => [name, 'power', { v }]

let cache: PartDef[] | null = null

export function builtinParts(): PartDef[] {
  if (cache) return cache
  const sensorWindow = (w: number) => `<rect x="${w / 2 - 5}" y="9" width="10" height="10" rx="1" fill="#c9ccd1" stroke="#6d7177" stroke-width="0.5"/><circle cx="${w / 2 + 2}" cy="12" r="0.9" fill="#333"/>`
  cache = [
    esp32DevkitC(),
    esp32S3DevkitC1(),
    esp32C3SuperMini(),

    breakout({
      id: 'bme280', name: 'BME280 (temp / humidity / pressure)', category: 'Sensors',
      description: 'Bosch BME280 breakout, I2C. Address 0x76 (SDO to GND) or 0x77. Most purple boards have an LDO and accept 3.3-5 V on VIN.',
      tags: ['bme280', 'temperature', 'humidity', 'pressure', 'i2c'], color: '#5b2a86', label: 'BME280',
      pins: [pwr(3.3, 'VIN'), P('GND', 'ground'), P('SCL', 'input', { fn: ['I2C_SCL'] }), P('SDA', 'gpio', { fn: ['I2C_SDA'] })],
      extra: sensorWindow, props: { i2cAddress: ['0x76', '0x77'], bus: 'i2c', supplyMin: 3.3, supplyMax: 5 },
    }),
    breakout({
      id: 'ssd1306-oled-128x64', name: 'OLED 0.96" SSD1306 (I2C)', category: 'Displays',
      description: '128x64 monochrome OLED, I2C address 0x3C (some 0x3D). Pin order varies between sellers (GND/VCC swapped) — check the silkscreen.',
      tags: ['oled', 'ssd1306', 'display', 'i2c'], color: '#1f3b73', label: 'SSD1306 OLED', side: 'T', w: 70, h: 60,
      pins: [P('GND', 'ground'), pwr(3.3, 'VCC'), P('SCL', 'input', { fn: ['I2C_SCL'] }), P('SDA', 'gpio', { fn: ['I2C_SDA'] })],
      extra: (w, h) => `<rect x="4" y="14" width="${w - 8}" height="${h - 20}" rx="1" fill="#05070c" stroke="#30384a" stroke-width="0.6"/>`,
      props: { i2cAddress: ['0x3C', '0x3D'], bus: 'i2c', supplyMin: 3.3, supplyMax: 5 },
    }),
    breakout({
      id: 'ds18b20-module', name: 'DS18B20 temperature (1-Wire)', category: 'Sensors',
      description: 'DS18B20 1-Wire temperature sensor. DQ needs a 4.7k pull-up to 3.3 V (many modules include it).',
      tags: ['ds18b20', 'temperature', 'onewire', '1-wire'], color: '#0f5132', label: 'DS18B20',
      pins: [P('GND', 'ground'), P('DQ', 'gpio', { fn: ['ONEWIRE'] }), pwr(3.3, 'VDD')], props: { bus: 'onewire', supplyMin: 3.0, supplyMax: 5.5 },
    }),
    breakout({
      id: 'dht22', name: 'DHT22 / AM2302 (temp / humidity)', category: 'Sensors',
      description: 'DHT22 single-wire temperature / humidity sensor. DATA needs a 10k pull-up (modules usually include it).',
      tags: ['dht22', 'am2302', 'temperature', 'humidity'], color: '#e9eef2', label: 'DHT22',
      pins: [pwr(3.3, 'VCC'), P('DATA', 'gpio'), P('NC', 'nc'), P('GND', 'ground')],
      extra: (w) => Array.from({ length: 4 }, (_, i) => `<rect x="${w / 2 - 12}" y="${8 + i * 6}" width="24" height="3" rx="1" fill="#b5bcc4"/>`).join(''),
      props: { supplyMin: 3.3, supplyMax: 6 },
    }),
    breakout({
      id: 'pir-hc-sr501', name: 'PIR motion HC-SR501', category: 'Sensors',
      description: 'Passive-infrared motion sensor. Needs 5 V supply (4.5-20 V); OUT is 3.3 V logic.',
      tags: ['pir', 'motion', 'hc-sr501', 'presence'], color: '#14532d', label: 'HC-SR501',
      pins: [pwr(5, 'VCC'), P('OUT', 'output'), P('GND', 'ground')], props: { supplyMin: 4.5, supplyMax: 20, outputVoltage: 3.3 },
      extra: (w) => `<circle cx="${w / 2}" cy="20" r="13" fill="#f4f4f2" stroke="#c9c9c4" stroke-width="0.6"/>`, h: 55,
    }),
    breakout({
      id: 'ina219', name: 'INA219 current / voltage monitor', category: 'Sensors',
      description: 'High-side current sensor (I2C, 0x40 default). Load current flows VIN+ → VIN−.',
      tags: ['ina219', 'current', 'power', 'i2c'], color: '#5b2a86', label: 'INA219', side: 'L',
      pins: [pwr(3.3, 'VCC'), P('GND', 'ground'), P('SCL', 'input', { fn: ['I2C_SCL'] }), P('SDA', 'gpio', { fn: ['I2C_SDA'] })],
      pins2: [P('VIN+', 'passive'), P('VIN-', 'passive')], side2: 'R',
      props: { i2cAddress: ['0x40', '0x41', '0x44', '0x45'], bus: 'i2c' },
    }),
    breakout({
      id: 'relay-1ch-5v', name: 'Relay module 1-channel (5 V)', category: 'Outputs', refPrefix: 'K',
      description: 'Opto/transistor-driven 5 V relay module. IN is usually active LOW. Many need 5 V on VCC; check the IN threshold works at 3.3 V.',
      tags: ['relay', 'switch', 'output', 'mains'], color: '#1e40af', label: 'RELAY', side: 'L', w: 80, h: 50,
      pins: [pwr(5, 'VCC'), P('GND', 'ground'), P('IN', 'input')],
      pins2: [P('NO', 'passive'), P('COM', 'passive'), P('NC', 'passive')], side2: 'R',
      extra: () => `<rect x="24" y="8" width="30" height="34" rx="1.5" fill="#2563eb" stroke="#0f2c74" stroke-width="0.6"/><text x="39" y="27" font-size="4" font-family="sans-serif" fill="#e0e7ff" text-anchor="middle">SRD-05VDC</text>`,
      props: { supplyMin: 5, supplyMax: 5, activeLow: true },
    }),
    breakout({
      id: 'ws2812b-strip', name: 'WS2812B LED strip (input end)', category: 'Outputs',
      description: 'Addressable RGB strip. 5 V supply; DIN wants ~0.7×VDD, so a 3.3 V GPIO is marginal — a level shifter (74AHCT125) is safer.',
      tags: ['ws2812b', 'neopixel', 'led', 'addressable'], color: '#111', label: 'WS2812B', side: 'L', w: 90, h: 40,
      pins: [pwr(5, '5V'), P('DIN', 'input'), P('GND', 'ground')],
      extra: () => [20, 45, 70].map((x) => `<rect x="${x - 6}" y="14" width="12" height="12" fill="#f5f5f5"/><circle cx="${x}" cy="20" r="3.5" fill="#ffd166"/>`).join(''),
      props: { supplyMin: 4.5, supplyMax: 5.5, logicHighMin: 3.5 },
    }),
    breakout({
      id: 'level-shifter-4ch', name: 'Logic level shifter 4-ch (BSS138)', category: 'Power',
      description: 'Bidirectional 3.3 V ↔ 5 V shifter. LV side to the ESP32, HV side to the 5 V device.',
      tags: ['level shifter', 'bss138', '5v', '3.3v'], color: '#7f1d1d', label: 'LV ↔ HV', side: 'L', w: 60,
      pins: [P('LV1', 'passive'), P('LV2', 'passive'), pwr(3.3, 'LV'), P('GND', 'ground'), P('LV3', 'passive'), P('LV4', 'passive')],
      pins2: [P('HV1', 'passive'), P('HV2', 'passive'), pwr(5, 'HV'), P('GND', 'ground'), P('HV3', 'passive'), P('HV4', 'passive')], side2: 'R',
      buses: ['GND'],
    }),
    breakout({
      id: 'buck-lm2596', name: 'Buck converter LM2596', category: 'Power',
      description: 'Adjustable step-down regulator (in 4.5-40 V, out 1.25-37 V, ~2 A). Set the output with the trimpot BEFORE connecting a board.',
      tags: ['buck', 'regulator', 'lm2596', 'step-down', '12v'], color: '#1e3a8a', label: 'LM2596', side: 'L', w: 90, h: 44,
      pins: [P('IN+', 'power', { v: 12 }), P('IN-', 'ground')],
      pins2: [P('OUT+', 'power', { v: 5 }), P('OUT-', 'ground')], side2: 'R',
      extra: () => `<rect x="34" y="10" width="22" height="16" fill="#1f2937"/><circle cx="64" cy="32" r="4" fill="#3b82f6" stroke="#1e3a8a"/>`,
      props: { inputMax: 40, outputAdjustable: true }, buses: [],
    }),
    breakout({
      id: 'ams1117-3v3', name: 'AMS1117 3.3 V regulator module', category: 'Power',
      description: 'Linear 3.3 V LDO (in 4.5-12 V, 800 mA max, burns the difference as heat).',
      tags: ['ldo', 'regulator', 'ams1117', '3.3v'], color: '#1e3a8a', label: 'AMS1117-3.3',
      pins: [P('VIN', 'power', { v: 5 }), P('GND', 'ground'), P('VOUT', 'power', { v: 3.3 })], props: { inputMax: 12 },
    }),

    powerSource({ id: 'power-12v', name: 'DC supply 12 V', v: 12, color: '#3f3f46', label: '12 V DC', description: '12 V DC input (coach battery / PSU).', tags: ['power', '12v', 'battery', 'supply'] }),
    powerSource({ id: 'power-5v-usb', name: 'USB 5 V supply', v: 5, color: '#27272a', label: 'USB 5V', description: '5 V from a USB charger or power bank.', tags: ['power', '5v', 'usb', 'supply'] }),

    resistor(),
    led('#ef4444', 'led-red', 'Red'),
    led('#22c55e', 'led-green', 'Green'),
    led('#3b82f6', 'led-blue', 'Blue'),
    ceramicCap(),
    electrolyticCap(),
    diode(),
    button(),
    threePinPackage({
      id: 'npn-2n2222', name: 'NPN transistor 2N2222 (TO-92)', category: 'Semiconductors', refPrefix: 'Q',
      description: 'Small-signal NPN (600 mA). Pinout E-B-C with the flat face toward you — varies by maker (PN2222A is E-B-C, P2N2222A is C-B-E).',
      tags: ['transistor', 'npn', '2n2222', 'switch'], body: 'to92', label: '2N2222', symbol: 'npn',
      pins: [['E', 'E', 'passive'], ['B', 'B', 'passive'], ['C', 'C', 'passive']],
    }),
    threePinPackage({
      id: 'nmos-irlz44n', name: 'N-MOSFET IRLZ44N (TO-220)', category: 'Semiconductors', refPrefix: 'Q',
      description: 'Logic-level N-channel MOSFET for switching 12 V loads from a GPIO. Add a ~100 Ω gate resistor and a 10k gate pull-down.',
      tags: ['mosfet', 'n-channel', 'irlz44n', 'switch', 'logic-level'], body: 'to220', label: 'IRLZ44N', symbol: 'nmos',
      pins: [['G', 'G', 'passive'], ['D', 'D', 'passive'], ['S', 'S', 'passive']],
    }),
    breakout({
      id: 'screw-terminal-2p', name: 'Screw terminal 2-pin', category: 'Connectors', refPrefix: 'J',
      description: '5 mm pitch 2-way screw terminal for off-board wires.', tags: ['terminal', 'connector', 'screw'], color: '#15803d', label: 'TERM', h: 30,
      pins: [P('1', 'passive'), P('2', 'passive')],
    }),
    breakout({
      id: 'header-4p', name: 'Header / JST 4-pin', category: 'Connectors', refPrefix: 'J',
      description: 'Generic 4-pin connector (pin header, JST-XH, Dupont).', tags: ['header', 'connector', 'jst', 'dupont'], color: '#262626', label: 'J 4P', h: 30,
      pins: [P('1', 'passive'), P('2', 'passive'), P('3', 'passive'), P('4', 'passive')],
    }),
  ]
  for (const p of cache) Object.assign(p, { license: 'AI-Lab built-in (original art)' })
  return cache
}
