import https from 'node:https'
import { clusterSettingsService } from './ClusterSettingsService'

/**
 * PveClient — NATIVE Proxmox VE API client (AI-Lab replacing ProxLab). Reads the
 * connection from ClusterSettingsService and talks to the PVE REST API directly with
 * the stored API token. Rule #1: runs on the backend (CT 152), never the browser.
 *
 * Phase 1 scope: connection test + version/cluster-status reads. Guest actions,
 * migrate, GPU hookscripts (SSH) get ported in later phases.
 */
export class PveClient {
  private agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true })

  private conn() {
    const { host, port, tokenId, tokenSecret, verifySsl } = clusterSettingsService.getRaw().pve
    if (!host || !tokenId || !tokenSecret) {
      throw new Error('PVE connection not configured (host/tokenId/tokenSecret required)')
    }
    return { host, port: port || 8006, tokenId, tokenSecret, verifySsl }
  }

  private request(pathName: string, timeoutMs = 12000): Promise<any> {
    const c = this.conn()
    const agent = c.verifySsl ? undefined : this.agent
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: c.host,
          port: c.port,
          path: `/api2/json${pathName}`,
          method: 'GET',
          agent,
          rejectUnauthorized: c.verifySsl,
          headers: { Authorization: `PVEAPIToken=${c.tokenId}=${c.tokenSecret}` },
          timeout: timeoutMs,
        },
        (res) => {
          let body = ''
          res.on('data', (d) => (body += d))
          res.on('end', () => {
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`PVE ${pathName}: HTTP ${res.statusCode} ${body.slice(0, 160)}`))
              return
            }
            try {
              resolve(JSON.parse(body)?.data)
            } catch {
              reject(new Error(`PVE ${pathName}: bad JSON`))
            }
          })
        },
      )
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error(`PVE ${pathName}: timeout`)))
      req.end()
    })
  }

  /** Verify credentials by hitting /version; returns { ok, version } or { ok:false, error }. */
  async testConnection(): Promise<{ ok: boolean; version?: string; release?: string; error?: string }> {
    try {
      const v = await this.request('/version')
      return { ok: true, version: v?.version, release: v?.release }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Cluster status (nodes + quorum) — used as the native read path migrates off the ProxLab proxy. */
  clusterStatus(): Promise<any> {
    return this.request('/cluster/status')
  }
}

export const pveClient = new PveClient()
