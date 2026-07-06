import { makeAutoObservable, runInAction } from 'mobx'

function bridge(): any {
  return (window as any).gyshell?.cluster
}

/** Connection info for the settings header rows (GET /api/ftp/status). */
export interface FtpStatus {
  host: string
  sftp: { active: boolean; port: number }
  ftp: { active: boolean; port: number }
}

/** Masked user view — never carries a password (hasPassword flag only). */
export interface FtpUser {
  username: string
  homeDir: string
  status: number // 1 = active, 0 = disabled
  permissions: string[] // SFTPGo perm strings for '/'
  quotaSize: number // bytes; 0 = unlimited
  hasPassword: boolean
  lastLogin?: number
}

export interface FtpUserInput {
  username?: string
  password?: string
  homeDir?: string
  permissions?: string[]
  status?: number
  quotaSize?: number
}

/**
 * FTP settings store — Settings › General → FTP Server. Talks to the AI-Lab
 * backend's SFTPGo wrapper (/api/ftp/*); SFTPGo admin creds stay server-side.
 * On update, a blank/omitted password preserves the stored one (masked-update
 * discipline, same as external-sources).
 */
export class FtpStore {
  status: FtpStatus | null = null
  users: FtpUser[] = []
  loading = false
  loaded = false
  err = ''

  constructor() { makeAutoObservable(this) }

  async load(): Promise<void> {
    this.loading = true; this.err = ''
    try {
      const [st, us] = await Promise.all([
        bridge().request('GET', '/api/ftp/status').catch(() => null),
        bridge().request('GET', '/api/ftp/users').catch(() => null),
      ])
      runInAction(() => {
        this.status = st && !st.error ? (st as FtpStatus) : null
        this.users = Array.isArray(us?.users) ? (us.users as FtpUser[]) : []
        if (!st || st.error) this.err = String(st?.error ?? 'FTP service unreachable')
        this.loaded = true
      })
    } finally {
      runInAction(() => { this.loading = false })
    }
  }

  get connected(): boolean { return !!this.status && (this.status.sftp.active || this.status.ftp.active) }

  async createUser(input: FtpUserInput): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('POST', '/api/ftp/users', input)
      if (r?.error) return { ok: false, error: String(r.error) }
      await this.load()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  }

  async updateUser(username: string, input: FtpUserInput): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('PUT', `/api/ftp/users/${encodeURIComponent(username)}`, input)
      if (r?.error) return { ok: false, error: String(r.error) }
      await this.load()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  }

  async deleteUser(username: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await bridge().request('DELETE', `/api/ftp/users/${encodeURIComponent(username)}`)
      if (r?.error) return { ok: false, error: String(r.error) }
      await this.load()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  }
}

export const ftpStore = new FtpStore()
