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

  /** Attach to a running service's tmux session (from the "Logs" button or the dropdown). */
  openService(s: AiService): void {
    if (!s.pveHostIp || !s.vmid || !s.tmuxSession) {
      // no attachable tmux session (e.g. a systemd service w/o a live pane)
      this.target = { id: s.id, kind: 'service', label: serviceConsoleLabel(s), host: s.pveHostIp || '', command: '' }
      this.focus()
      return
    }
    this.target = {
      id: s.id,
      kind: 'service',
      label: serviceConsoleLabel(s),
      host: s.pveHostIp,
      command: `pct exec ${s.vmid} -- tmux attach -t '${s.tmuxSession.replace(/'/g, "'\\''")}'`,
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
