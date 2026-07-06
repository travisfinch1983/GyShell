// @ts-expect-error — express ships untyped in this repo (same pattern as hermesHttp/UniversalProxyService)
import express from 'express'
import type { FtpService } from './FtpService'

type Req = express.Request
type Res = express.Response

/**
 * HTTP surface for the AI-Lab FTP service (SFTPGo wrapper). Mounted on the universal proxy
 * app alongside the Hermes/fleet routers, before the broad /api cluster router. Backs the
 * Settings › General → FTP section: connection info + FTP user-account management. All
 * SFTPGo admin access is server-side; the browser never holds SFTPGo creds. Add `/api/ftp`
 * to ClusterService ALLOWED_PREFIXES + LOCAL_PREFIXES (same as /api/hermes).
 */
export function createFtpRouter(ftp: FtpService): express.Router {
  const router = express.Router()
  const json = express.json({ limit: '256kb' })

  // Service + connection info (host/ports + SFTP/FTP active flags) for the settings header.
  router.get('/api/ftp/status', async (_req: Req, res: Res) => {
    try {
      res.json(await ftp.status())
    } catch (e) {
      res.status(503).json({ error: String((e as Error).message) })
    }
  })

  // List FTP users — masked (no secret; hasPassword flag only).
  router.get('/api/ftp/users', async (_req: Req, res: Res) => {
    try {
      res.json({ users: await ftp.listUsers() })
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) })
    }
  })

  // Create a user. username + password required; homeDir/permissions/quota optional.
  router.post('/api/ftp/users', json, async (req: Req, res: Res) => {
    try {
      const b = (req.body ?? {}) as { username?: string; password?: string }
      if (!b.username || !String(b.username).trim()) return res.status(400).json({ error: 'username required' })
      if (!b.password || !String(b.password).trim()) return res.status(400).json({ error: 'password required' })
      await ftp.createUser(req.body)
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message) })
    }
  })

  // Update a user. A blank/omitted password preserves the existing one (masked discipline).
  router.put('/api/ftp/users/:username', json, async (req: Req, res: Res) => {
    try {
      await ftp.updateUser(req.params.username, req.body ?? {})
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message) })
    }
  })

  router.delete('/api/ftp/users/:username', async (req: Req, res: Res) => {
    try {
      await ftp.deleteUser(req.params.username)
      res.json({ ok: true })
    } catch (e) {
      res.status(400).json({ error: String((e as Error).message) })
    }
  })

  return router
}
