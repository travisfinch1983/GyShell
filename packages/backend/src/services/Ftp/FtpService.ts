/**
 * FtpService — thin backend wrapper over the SFTPGo REST API (the AI-Lab FTP engine,
 * `ai-lab-ftp.service` on CT152). The AI-Lab General-settings FTP section drives this;
 * it never talks to SFTPGo directly (admin creds stay server-side, per the
 * connections-backend-proxied rule). Caches the admin JWT until just before expiry.
 */
export interface FtpServiceConfig {
  adminUrl: string // e.g. http://127.0.0.1:8092
  adminUser: string
  adminPass: string
  sftpPort: number
  ftpPort: number
  publicHost: string // host users connect to (LAN IP or hostname)
  homeBase?: string // base dir for auto-created user homes
}

/** A masked FTP user for the UI — never carries the password (SFTPGo stores it hashed). */
export interface FtpUserView {
  username: string
  homeDir: string
  status: number // 1 = active, 0 = disabled
  permissions: string[] // permissions for '/'
  quotaSize: number // bytes; 0 = unlimited
  hasPassword: boolean
  lastLogin?: number
}

export class FtpService {
  private token = ''
  private tokenExpMs = 0

  constructor(private readonly cfg: FtpServiceConfig) {}

  private async authHeader(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpMs - 30_000) return `Bearer ${this.token}`
    const basic = Buffer.from(`${this.cfg.adminUser}:${this.cfg.adminPass}`).toString('base64')
    const r = await fetch(`${this.cfg.adminUrl}/api/v2/token`, { headers: { Authorization: `Basic ${basic}` } })
    if (!r.ok) throw new Error(`sftpgo auth failed (${r.status}) — check ai-lab-ftp.service + SFTPGO_ADMIN_* env`)
    const d = (await r.json()) as { access_token: string; expires_at: string }
    this.token = d.access_token
    this.tokenExpMs = Date.parse(d.expires_at) || Date.now() + 10 * 60_000
    return `Bearer ${this.token}`
  }

  private async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const auth = await this.authHeader()
    const r = await fetch(`${this.cfg.adminUrl}/api/v2${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`sftpgo ${method} ${path} -> ${r.status}: ${text.slice(0, 240)}`)
    return (text ? JSON.parse(text) : null) as T
  }

  /** Service + connection info for the settings header rows. */
  async status(): Promise<{
    host: string
    sftp: { active: boolean; port: number }
    ftp: { active: boolean; port: number }
  }> {
    const s = await this.api<{ ssh?: { is_active?: boolean }; ftp?: { is_active?: boolean } }>('GET', '/status')
    return {
      host: this.cfg.publicHost,
      sftp: { active: !!s?.ssh?.is_active, port: this.cfg.sftpPort },
      ftp: { active: !!s?.ftp?.is_active, port: this.cfg.ftpPort },
    }
  }

  async listUsers(): Promise<FtpUserView[]> {
    const users = await this.api<Array<Record<string, unknown>>>('GET', '/users?limit=500&order=ASC')
    return (users || []).map((u) => ({
      username: String(u.username ?? ''),
      homeDir: String(u.home_dir ?? ''),
      status: Number(u.status ?? 0),
      permissions: (u.permissions as Record<string, string[]> | undefined)?.['/'] ?? [],
      quotaSize: Number(u.quota_size ?? 0),
      hasPassword: true, // masked — SFTPGo never returns the secret
      lastLogin: u.last_login ? Number(u.last_login) : undefined,
    }))
  }

  async createUser(input: {
    username: string
    password: string
    homeDir?: string
    permissions?: string[]
    status?: number
    quotaSize?: number
  }): Promise<void> {
    const home = input.homeDir?.trim() || `${this.cfg.homeBase ?? '/opt/ai-lab-ftp/data'}/${input.username}`
    await this.api('POST', '/users', {
      username: input.username,
      password: input.password,
      home_dir: home,
      status: input.status ?? 1,
      quota_size: input.quotaSize ?? 0,
      permissions: { '/': input.permissions?.length ? input.permissions : ['*'] },
    })
  }

  /** SFTPGo PUT replaces the record, so fetch-merge. An empty password is omitted so the
   *  existing secret is preserved (masked-update discipline). */
  async updateUser(
    username: string,
    input: { password?: string; homeDir?: string; permissions?: string[]; status?: number; quotaSize?: number }
  ): Promise<void> {
    const existing = await this.api<Record<string, unknown>>('GET', `/users/${encodeURIComponent(username)}`)
    const merged: Record<string, unknown> = { ...existing }
    delete merged.password // omit unless a new one is supplied
    if (input.password && input.password.trim()) merged.password = input.password
    if (input.homeDir && input.homeDir.trim()) merged.home_dir = input.homeDir
    if (input.permissions?.length) merged.permissions = { '/': input.permissions }
    if (typeof input.status === 'number') merged.status = input.status
    if (typeof input.quotaSize === 'number') merged.quota_size = input.quotaSize
    await this.api('PUT', `/users/${encodeURIComponent(username)}`, merged)
  }

  async deleteUser(username: string): Promise<void> {
    await this.api('DELETE', `/users/${encodeURIComponent(username)}`)
  }
}
