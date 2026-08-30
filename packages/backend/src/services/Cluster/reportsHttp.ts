// @ts-expect-error — express ships untyped in this repo (same pattern as pagesHttp)
import express from 'express'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { marked } from 'marked'
import {
  reportIdSchema,
  reportTypeSchema,
  reportWriteRequestSchema,
  type ReportMeta,
  type ReportType,
  type ReportVersion,
} from '@gyshell/shared'
import { indexReport, searchReports } from './reportsRag'

type Req = express.Request
type Res = express.Response

/**
 * Reports store — /api/reports/*, its OWN surface, deliberately not part of
 * /api/pages. Scoping pages, reports and the journal are three separate things
 * with three separate toolsets so an agent cannot file one into another's
 * section by accident (Travis, 2026-08-30).
 *
 * A report has a TYPE from a predefined list. Types are the fleet-wide
 * extension point: maintenance today; security-camera and network-vulnerability
 * reports when those agents come online. Each type owns a RAG collection, so
 * one agent's reports never dilute another's search.
 *
 * Append-only versions, like pages: a report is a record of what was true when
 * it was written and must never be silently rewritten.
 */
export function createReportsRouter(dataDir: string): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '8mb' })
  const root = path.join(dataDir, 'reports')
  const dir = (id: string) => path.join(root, id)
  const metaFile = (id: string) => path.join(dir(id), 'meta.json')
  const vName = (n: number) => `v${String(n).padStart(4, '0')}`
  const htmlFile = (id: string, n: number) => path.join(dir(id), `${vName(n)}.html`)
  const srcFile = (id: string, n: number) => path.join(dir(id), `${vName(n)}.src.md`)
  const ensure = () => { if (!existsSync(root)) mkdirSync(root, { recursive: true }) }
  const fail = (res: Res, code: number, error: string) => res.status(code).json({ ok: false, error })

  const typesFile = path.join(dataDir, 'report-types.json')
  /**
   * Seeded once, then the FILE is the truth — a new report type (a new kind of
   * agent) is a config edit, never a code change. The seeds cover the fleet
   * Travis named plus the two generic ones.
   */
  const DEFAULT_TYPES: ReportType[] = [
    {
      id: 'maintenance', label: 'Maintenance', collection: 'reports_maintenance',
      description: 'Repairs to warnings and errors raised by the notifications panel.',
      template: [
        '# <short issue name>', '',
        '## What was reported', '<the notification / symptom, verbatim where possible>', '',
        '## What was actually wrong', '<root cause — the thing that was true, not the first theory>', '',
        '## What I changed', '<commands, files, config; enough for someone else to repeat or revert it>', '',
        '## How I verified the fix',
        '<the evidence. a check that only passes because it was re-run is not evidence>', '',
        '## Anything still open', '<follow-ups, or "nothing">',
      ].join('\n'),
    },
    {
      id: 'security', label: 'Security / Surveillance', collection: 'reports_security',
      description: 'Observations from camera and physical-security monitoring.',
      template: [
        '# <what was observed>', '',
        '## When and where', '<time window, camera / zone>', '',
        '## What was seen', '<description; keep interpretation separate from observation>', '',
        '## Assessment', '<benign / suspicious / needs Travis — and why>', '',
        '## Evidence', '<clip references, stills, detections>', '',
        '## Action taken', '<or "none — logged only">',
      ].join('\n'),
    },
    {
      id: 'vulnerability', label: 'Vulnerability', collection: 'reports_vulnerability',
      description: 'Findings from security probes and scans of the network.',
      template: [
        '# <finding>', '',
        '## Affected', '<host / service / version>', '',
        '## Finding', '<what is exposed, and how it was determined>', '',
        '## Severity and why', '<impact if exploited, and the reasoning — not just a CVSS number>', '',
        '## Reproduction', '<the exact probe, so it can be re-run after a fix>', '',
        '## Remediation', '<recommended fix, and whether it was applied>',
      ].join('\n'),
    },
    {
      id: 'incident', label: 'Incident', collection: 'reports_incident',
      description: 'Outages and degradations, including ones that resolved themselves.',
      template: ['# <incident name>', '', '## Impact', '', '## Timeline', '', '## Cause', '', '## Fix / mitigation', '', '## Prevention'].join('\n'),
    },
    {
      id: 'research', label: 'Research', collection: 'reports_research',
      description: 'Findings from investigation work — upstream digs, benchmarks, evaluations.',
      template: ['# <question investigated>', '', '## Answer', '', '## Evidence', '', '## What I could not determine', '', '## Sources'].join('\n'),
    },
  ]

  const loadTypes = (): ReportType[] => {
    try {
      if (!existsSync(typesFile)) writeFileSync(typesFile, JSON.stringify({ types: DEFAULT_TYPES }, null, 2))
      const raw = JSON.parse(readFileSync(typesFile, 'utf8'))
      const list = Array.isArray(raw?.types) ? raw.types : DEFAULT_TYPES
      return list.map((t: unknown) => reportTypeSchema.parse(t))
    } catch (e) {
      console.warn('[reports] types config unreadable, using defaults:', (e as Error).message)
      return DEFAULT_TYPES
    }
  }

  const readMeta = (id: string): ReportMeta | null => {
    if (!existsSync(metaFile(id))) return null
    try { return JSON.parse(readFileSync(metaFile(id), 'utf8')) as ReportMeta } catch { return null }
  }

  router.get('/api/reports/types', (_req: Req, res: Res) => {
    res.json({ types: loadTypes() })
  })

  router.get('/api/reports', (req: Req, res: Res) => {
    try {
      ensure()
      const type = req.query.type ? String(req.query.type) : null
      const reports = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => readMeta(d.name))
        .filter((m): m is ReportMeta => m !== null)
        .filter((m) => !type || m.type === type)
        .map(({ versions, ...m }) => ({ ...m, versionCount: versions.length }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      res.json({ reports })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  router.get('/api/reports/:id', (req: Req, res: Res) => {
    const id = req.params.id
    if (!reportIdSchema.safeParse(id).success) return fail(res, 400, 'bad report id')
    const meta = readMeta(id)
    if (!meta) return fail(res, 404, `no report ${id}`)
    const version = req.query.version ? Number(req.query.version) : meta.currentVersion
    if (!meta.versions.some((v) => v.version === version)) return fail(res, 404, `report ${id} has no version ${version}`)
    try {
      const html = readFileSync(htmlFile(id, version), 'utf8')
      const source = existsSync(srcFile(id, version)) ? readFileSync(srcFile(id, version), 'utf8') : html
      res.json({ meta, version, html, source })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  router.put('/api/reports/:id', json, async (req: Req, res: Res) => {
    const id = req.params.id
    if (!reportIdSchema.safeParse(id).success) return fail(res, 400, 'bad report id')
    const parsed = reportWriteRequestSchema.safeParse(req.body)
    if (!parsed.success) return fail(res, 400, `bad report: ${parsed.error.issues[0]?.message}`)
    const { type, title, body, summary, links, author } = parsed.data
    const types = loadTypes()
    const rt = types.find((t) => t.id === type)
    if (!rt) return fail(res, 400, `unknown report type '${type}' (have: ${types.map((t) => t.id).join(', ')})`)
    try {
      ensure()
      let meta = readMeta(id)
      const now = new Date().toISOString()
      if (!meta) {
        mkdirSync(dir(id), { recursive: true })
        meta = { id, type, title, createdAt: now, updatedAt: now, currentVersion: 0, authors: [], versions: [], links: [] }
      }
      // A report never changes type: its type chose its collection and its readers.
      if (meta.currentVersion > 0 && meta.type !== type) {
        return fail(res, 400, `report ${id} is type '${meta.type}' — a report cannot change type (file a new one)`)
      }
      const version = meta.currentVersion + 1
      const html = marked.parse(body, { async: false }) as string
      writeFileSync(htmlFile(id, version), html)
      writeFileSync(srcFile(id, version), body)
      const info: ReportVersion = { version, title, author, createdAt: now, bytes: Buffer.byteLength(html) }
      const versions = [...meta.versions, info]
      meta = {
        ...meta, type, title, summary: summary ?? meta.summary, updatedAt: now, currentVersion: version, versions,
        authors: [...new Set(versions.map((v) => v.author).filter((a): a is string => !!a))],
        links: links ?? meta.links,
      }
      writeFileSync(metaFile(id), JSON.stringify(meta, null, 2))

      // Indexing never blocks the write: a report that saved but did not index is
      // a working report with degraded search; refusing the write would lose it.
      let indexed: boolean | undefined
      let indexError: string | undefined
      try {
        await indexReport({
          collection: rt.collection, pageId: id, title, category: type,
          issue: summary ?? title, author, version, body,
        })
        indexed = true
      } catch (e) {
        indexed = false
        indexError = (e as Error).message
        console.warn(`[reports] ${id} saved but NOT indexed:`, indexError)
      }
      res.json({ ok: true, id, type, version, indexed, indexError })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  router.get('/api/reports-search', async (req: Req, res: Res) => {
    const q = String(req.query.q ?? '').trim()
    if (!q) return fail(res, 400, 'q is required')
    const types = loadTypes()
    const wanted = req.query.type ? types.filter((t) => t.id === String(req.query.type)) : types
    if (!wanted.length) return fail(res, 404, 'no such report type')
    const collections = await Promise.all(wanted.map(async (t) => {
      try { return { type: t.id, ...(await searchReports(t.collection, q) as object) } }
      catch (e) { return { type: t.id, error: String((e as Error).message) } }
    }))
    res.json({ query: q, collections })
  })

  // Delete is a move to trash, never an unlink — same rule as pages.
  router.delete('/api/reports/:id', (req: Req, res: Res) => {
    const id = req.params.id
    if (!reportIdSchema.safeParse(id).success) return fail(res, 400, 'bad report id')
    if (!existsSync(dir(id))) return fail(res, 404, `no report ${id}`)
    try {
      const trash = path.join(root, '.trash')
      mkdirSync(trash, { recursive: true })
      renameSync(dir(id), path.join(trash, `${id}-${Date.now()}`))
      res.json({ ok: true })
    } catch (e) { fail(res, 500, String((e as Error).message)) }
  })

  return router
}
