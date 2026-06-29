import { makeAutoObservable } from 'mobx'

export type LogLevel = 'info' | 'ok' | 'warn' | 'err'
export interface LogLine { t: string; msg: string; level: LogLevel }

/** Shared TTS activity log — used by both the TTS Test Panel and Voice Manager sub-tabs. */
class TtsLogStore {
  lines: LogLine[] = []
  constructor() { makeAutoObservable(this) }
  log(msg: string, level: LogLevel = 'info'): void {
    const d = new Date()
    const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    this.lines.push({ t, msg, level })
    if (this.lines.length > 500) this.lines.splice(0, this.lines.length - 500)
  }
  clear(): void { this.lines = [] }
}
export const ttsLogStore = new TtsLogStore()
