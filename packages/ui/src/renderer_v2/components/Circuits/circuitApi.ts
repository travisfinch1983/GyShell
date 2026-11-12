import type { Design, DesignSummary, Finding, Net, PartDef } from './circuitTypes'

const bridge = (): { request: (m: string, p: string, b?: unknown) => Promise<any> } => {
  const b = (window as unknown as { gyshell?: { cluster?: any } }).gyshell?.cluster
  if (!b?.request) throw new Error('AI-Lab backend bridge is not available')
  return b
}
const req = (m: string, p: string, b?: unknown) => bridge().request(m, p, b)
const enc = encodeURIComponent

/** Failures PROPAGATE — "could not load" must never render as "no designs". */
export const circuitApi = {
  /** The palette list. Imported Fritzing parts come back `lite` (no art/pins) — fetch them with part(). */
  async parts(): Promise<PartDef[]> {
    const r = await req('GET', '/api/circuits/parts?lite=1')
    if (!Array.isArray(r?.parts)) throw new Error('parts list missing from the response')
    return r.parts
  },
  async part(id: string): Promise<PartDef> {
    const r = await req('GET', `/api/circuits/parts/${enc(id)}`)
    if (!r?.part) throw new Error(`no part '${id}' in the response`)
    return r.part
  },
  async list(): Promise<DesignSummary[]> {
    const r = await req('GET', '/api/circuits/designs')
    if (!Array.isArray(r?.designs)) throw new Error('design list missing from the response')
    return r.designs
  },
  async load(id: string): Promise<Design> {
    const r = await req('GET', `/api/circuits/designs/${enc(id)}`)
    if (!r?.design) throw new Error(`no design '${id}' in the response`)
    return r.design
  },
  async version(id: string): Promise<{ updatedAt: string | null; by: string | null }> {
    return req('GET', `/api/circuits/designs/${enc(id)}/version`)
  },
  async create(name: string): Promise<Design> {
    const r = await req('POST', '/api/circuits/designs', { name })
    if (!r?.design) throw new Error('create returned no design')
    return r.design
  },
  async save(d: Design, baseUpdatedAt: string | null): Promise<{ design: Design; warnings: string[] }> {
    const r = await req('PUT', `/api/circuits/designs/${enc(d.id)}`, { ...d, baseUpdatedAt, updatedBy: 'ui' })
    if (!r?.design) throw new Error('save returned no design')
    return { design: r.design, warnings: r.warnings ?? [] }
  },
  async remove(id: string): Promise<void> { await req('DELETE', `/api/circuits/designs/${enc(id)}`) },
  async check(d: Design): Promise<{ findings: Finding[]; nets: Net[] }> {
    const r = await req('POST', '/api/circuits/check', { design: d })
    return { findings: r?.findings ?? [], nets: r?.nets ?? [] }
  },
  async exportText(id: string, format: string): Promise<string> {
    const r = await req('GET', `/api/circuits/designs/${enc(id)}/export?format=${enc(format)}`)
    return String(r?.text ?? '')
  },
  async savePart(p: Partial<PartDef>, isNew: boolean): Promise<PartDef> {
    const r = isNew ? await req('POST', '/api/circuits/parts', p) : await req('PUT', `/api/circuits/parts/${enc(String(p.id))}`, p)
    if (!r?.part) throw new Error('save returned no part')
    return r.part
  },
  async removePart(id: string): Promise<{ stillUsedBy: string[] }> {
    const r = await req('DELETE', `/api/circuits/parts/${enc(id)}`)
    return { stillUsedBy: r?.stillUsedBy ?? [] }
  },
}

export const isConflict = (e: unknown) => /\b409\b|conflict:/.test(String((e as Error)?.message ?? e))
export const errText = (e: unknown) => String((e as Error)?.message ?? e)
