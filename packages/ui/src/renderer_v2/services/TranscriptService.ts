/**
 * TranscriptService — Records all chat messages and activity feed entries.
 *
 * Persists a running transcript to localStorage with configurable limits.
 * Provides export functionality and cleanup based on message count or age.
 */

const TRANSCRIPT_CHAT_KEY = 'gyshell-transcript-chat'
const TRANSCRIPT_ACTIVITY_KEY = 'gyshell-transcript-activity'
const TRANSCRIPT_SETTINGS_KEY = 'gyshell-transcript-settings'

export interface TranscriptEntry {
  id: string
  timestamp: number
  type: 'chat' | 'activity'
  from: string
  to: string
  role?: string
  content: string
  messageType?: string
  metadata?: Record<string, any>
}

export interface TranscriptSettings {
  maxChatMessages: number      // Max chat messages to keep (0 = unlimited)
  maxActivityEntries: number   // Max activity entries to keep (0 = unlimited)
  retentionDays: number        // Delete entries older than this (0 = unlimited)
}

const DEFAULT_SETTINGS: TranscriptSettings = {
  maxChatMessages: 1000,
  maxActivityEntries: 500,
  retentionDays: 30,
}

export class TranscriptService {
  private settings: TranscriptSettings

  constructor() {
    this.settings = this.loadSettings()
  }

  // ─── Settings ──────────────────────────────────────────────────────

  loadSettings(): TranscriptSettings {
    try {
      const stored = localStorage.getItem(TRANSCRIPT_SETTINGS_KEY)
      if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }
    } catch {}
    return { ...DEFAULT_SETTINGS }
  }

  saveSettings(settings: Partial<TranscriptSettings>): void {
    this.settings = { ...this.settings, ...settings }
    localStorage.setItem(TRANSCRIPT_SETTINGS_KEY, JSON.stringify(this.settings))
  }

  getSettings(): TranscriptSettings {
    return { ...this.settings }
  }

  // ─── Recording ─────────────────────────────────────────────────────

  recordChatMessage(entry: Omit<TranscriptEntry, 'type'>): void {
    const transcript = this.loadTranscript(TRANSCRIPT_CHAT_KEY)
    transcript.push({ ...entry, type: 'chat' })
    this.trimAndSave(TRANSCRIPT_CHAT_KEY, transcript, this.settings.maxChatMessages)
  }

  recordActivityEntry(entry: Omit<TranscriptEntry, 'type'>): void {
    const transcript = this.loadTranscript(TRANSCRIPT_ACTIVITY_KEY)
    transcript.push({ ...entry, type: 'activity' })
    this.trimAndSave(TRANSCRIPT_ACTIVITY_KEY, transcript, this.settings.maxActivityEntries)
  }

  // ─── Retrieval ─────────────────────────────────────────────────────

  getChatTranscript(): TranscriptEntry[] {
    return this.loadTranscript(TRANSCRIPT_CHAT_KEY)
  }

  getActivityTranscript(): TranscriptEntry[] {
    return this.loadTranscript(TRANSCRIPT_ACTIVITY_KEY)
  }

  getFullTranscript(): TranscriptEntry[] {
    const chat = this.getChatTranscript()
    const activity = this.getActivityTranscript()
    return [...chat, ...activity].sort((a, b) => a.timestamp - b.timestamp)
  }

  // ─── Export ────────────────────────────────────────────────────────

  exportAsText(): string {
    const entries = this.getFullTranscript()
    const lines: string[] = [
      `# GyShell Transcript`,
      `# Exported: ${new Date().toISOString()}`,
      `# Entries: ${entries.length}`,
      '',
    ]

    for (const entry of entries) {
      const time = new Date(entry.timestamp).toLocaleString()
      const prefix = entry.type === 'activity' ? '[ACTIVITY]' : '[CHAT]'
      const header = `${prefix} ${time} | ${entry.from} → ${entry.to}`
      lines.push(header)
      lines.push(entry.content)
      lines.push('')
    }

    return lines.join('\n')
  }

  downloadTranscript(): void {
    const text = this.exportAsText()
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gyshell-transcript-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ─── Cleanup ───────────────────────────────────────────────────────

  clearChatTranscript(): void {
    localStorage.removeItem(TRANSCRIPT_CHAT_KEY)
  }

  clearActivityTranscript(): void {
    localStorage.removeItem(TRANSCRIPT_ACTIVITY_KEY)
  }

  clearAll(): void {
    this.clearChatTranscript()
    this.clearActivityTranscript()
  }

  /**
   * Run retention cleanup based on settings.
   * Call periodically (e.g., on app startup).
   */
  runRetentionCleanup(): void {
    if (this.settings.retentionDays <= 0) return
    const cutoff = Date.now() - (this.settings.retentionDays * 24 * 60 * 60 * 1000)

    for (const key of [TRANSCRIPT_CHAT_KEY, TRANSCRIPT_ACTIVITY_KEY]) {
      const entries = this.loadTranscript(key)
      const filtered = entries.filter(e => e.timestamp >= cutoff)
      if (filtered.length < entries.length) {
        localStorage.setItem(key, JSON.stringify(filtered))
      }
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private loadTranscript(key: string): TranscriptEntry[] {
    try {
      return JSON.parse(localStorage.getItem(key) || '[]')
    } catch {
      return []
    }
  }

  private trimAndSave(key: string, entries: TranscriptEntry[], maxEntries: number): void {
    if (maxEntries > 0 && entries.length > maxEntries) {
      entries.splice(0, entries.length - maxEntries)
    }
    try {
      localStorage.setItem(key, JSON.stringify(entries))
    } catch {
      // localStorage full — trim more aggressively
      if (entries.length > 100) {
        entries.splice(0, Math.floor(entries.length / 2))
        try { localStorage.setItem(key, JSON.stringify(entries)) } catch {}
      }
    }
  }
}
