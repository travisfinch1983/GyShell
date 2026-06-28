import { makeAutoObservable } from 'mobx'
import type { AiService } from './AiServicesStore'

/**
 * LiveConsoleStore — multiple interactive PTY sessions (service log tails + install/update scripts)
 * shown as tabs in the Live Console pane. Service-card "Logs" + provider Install/Update push a
 * session here and bump focusSeq; App watches focusSeq to surface the console pane.
 */
export type ConsoleSessionKind = 'service' | 'install'

export interface ConsoleSession {
  id: string // stable key (service id, or install:<n>)
  kind: ConsoleSessionKind
  label: string
  host: string // PVE host IP to SSH into
  command: string // command to run on the host
}

/** Display name by priority: port:aliasOverride → port:model → port:providerName/tmux. */
export function serviceConsoleLabel(s: AiService): string {
  const name = s.aliasOverride || s.model || s.providerName || s.tmuxSession || s.id
  return s.port ? `${s.port}:${name}` : String(name)
}

export class LiveConsoleStore {
  sessions: ConsoleSession[] = []
  activeId: string | null = null
  focusSeq = 0 // bump to ask App to surface the Live Console pane
  private installSeq = 0

  constructor() {
    makeAutoObservable(this)
  }
  private focus() {
    this.focusSeq++
  }
  get active(): ConsoleSession | null {
    return this.sessions.find((s) => s.id === this.activeId) ?? null
  }
  setActive(id: string): void {
    if (this.sessions.some((s) => s.id === id)) this.activeId = id
  }
  close(id: string): void {
    const idx = this.sessions.findIndex((s) => s.id === id)
    if (idx < 0) return
    this.sessions.splice(idx, 1)
    if (this.activeId === id) this.activeId = this.sessions[Math.max(0, idx - 1)]?.id ?? null
  }

  private upsert(sess: ConsoleSession): void {
    const existing = this.sessions.find((s) => s.id === sess.id)
    if (existing) {
      // refresh the command (e.g. re-open) but keep tab position
      existing.label = sess.label
      existing.host = sess.host
      existing.command = sess.command
    } else {
      this.sessions.push(sess)
    }
    this.activeId = sess.id
    this.focus()
  }

  /** Tail a running service's live log (ProxLab-style; works for tmux + systemd). */
  openService(s: AiService): void {
    if (!s.pveHostIp || !s.vmid) return
    const logFile = `/var/log/proxlab/${s.tmuxSession || s.id}.log`.replace(/'/g, "'\\''")
    this.upsert({
      id: s.id,
      kind: 'service',
      label: serviceConsoleLabel(s),
      host: s.pveHostIp,
      command: `pct exec ${s.vmid} -- tail -n 400 -f '${logFile}'`,
    })
  }

  /** Run an install/update script as a new console tab. */
  openInstall(label: string, host: string, command: string): void {
    this.installSeq++
    this.upsert({ id: `install:${this.installSeq}`, kind: 'install', label, host, command })
  }
}

export const liveConsoleStore = new LiveConsoleStore()
