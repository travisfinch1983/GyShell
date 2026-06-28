import { makeAutoObservable } from 'mobx'
import type { AiService } from './AiServicesStore'

/**
 * LiveConsoleStore — the single home for interactive PTY sessions (tmux attach + install/update
 * scripts). Other parts of the UI (service-card "Logs", provider Install/Update) set a target here
 * and bump `focusSeq`; App watches focusSeq to switch to the Live Console tab. This replaces the
 * per-tab popup xterm windows — everything attaches in one place.
 */
export type ConsoleTargetKind = 'service' | 'install'

export interface ConsoleTarget {
  id: string // stable session key (re-selecting the same id won't restart)
  kind: ConsoleTargetKind
  label: string
  host: string // PVE host IP to SSH into
  command: string // full command to run on the host (e.g. `pct exec <vmid> -- tmux attach -t <s>`)
}

/** Display name by priority: port:aliasOverride → port:model → port:providerName/tmux. */
export function serviceConsoleLabel(s: AiService): string {
  const name = s.aliasOverride || s.model || s.providerName || s.tmuxSession || s.id
  return s.port ? `${s.port}:${name}` : String(name)
}

export class LiveConsoleStore {
  target: ConsoleTarget | null = null
  focusSeq = 0 // bump to ask App to switch to the Live Console tab

  constructor() {
    makeAutoObservable(this)
  }

  private focus() {
    this.focusSeq++
  }

  /** Attach to a running service's live console (from the "Logs" button or the dropdown).
   *  tmux-launched services have a live pane to attach to; systemd services don't (they log to a
   *  file), so we attach to tmux IF a session exists, otherwise follow the live log file. */
  openService(s: AiService): void {
    if (!s.pveHostIp || !s.vmid) {
      this.target = { id: s.id, kind: 'service', label: serviceConsoleLabel(s), host: s.pveHostIp || '', command: '' }
      this.focus()
      return
    }
    // Match ProxLab: follow the persistent log file (fast, universal). tmux-attach was slow to
    // start (waits, fails on systemd services) — services log to /var/log/proxlab/<session>.log.
    const logFile = `/var/log/proxlab/${s.tmuxSession || s.id}.log`.replace(/'/g, "'\\''")
    this.target = {
      id: s.id,
      kind: 'service',
      label: serviceConsoleLabel(s),
      host: s.pveHostIp,
      command: `pct exec ${s.vmid} -- tail -n 400 -f '${logFile}'`,
    }
    this.focus()
  }

  /** Run an install/update script for a provider in the console (new live term). */
  openInstall(label: string, host: string, command: string): void {
    this.target = { id: `install:${label}:${this.focusSeq + 1}`, kind: 'install', label, host, command }
    this.focus()
  }

  clear(): void {
    this.target = null
  }
}

export const liveConsoleStore = new LiveConsoleStore()
