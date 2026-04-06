/**
 * TtsPlayback — Automatic text-to-speech for chat messages.
 *
 * When enabled, sends assistant message body text (not thinking blocks,
 * not tool calls, not summaries) to the TTS streaming endpoint.
 * Plays audio chunks as they arrive via SSE.
 */

import { getProxlabApiBase } from './ProxlabDiscovery'

let enabled = false
let currentAudio: HTMLAudioElement | null = null
let currentAbort: AbortController | null = null

// Speech queue — messages wait for the current one to finish
const speechQueue: Array<{ text: string; role?: string; resolve: () => void }> = []
let isProcessingQueue = false

// Load saved state
try {
  enabled = localStorage.getItem('gyshell-tts-auto') === 'true'
} catch {}

export function isTtsEnabled(): boolean {
  return enabled
}

export function setTtsEnabled(on: boolean): void {
  enabled = on
  localStorage.setItem('gyshell-tts-auto', String(on))
}

export function stopPlayback(): void {
  // Clear the queue
  speechQueue.length = 0
  isProcessingQueue = false
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }
  if (currentAbort) {
    currentAbort.abort()
    currentAbort = null
  }
}

/**
 * Get TTS config from localStorage.
 */
function getTtsConfig(): any {
  try {
    return JSON.parse(localStorage.getItem('gyshell-tts-config') || '{}')
  } catch {
    return {}
  }
}

/**
 * Process the speech queue — plays items one at a time in order.
 */
async function processQueue(): Promise<void> {
  if (isProcessingQueue) return
  isProcessingQueue = true

  while (speechQueue.length > 0) {
    const item = speechQueue[0]
    try {
      await speakTextImmediate(item.text, item.role)
    } catch {}
    speechQueue.shift()
    item.resolve()
  }

  isProcessingQueue = false
}

/**
 * Get voice settings for a specific role from the active profile.
 */
function getRoleVoiceSettings(role?: string): { voice?: string; rvcVoice?: string } {
  if (!role) return {}
  try {
    const appStore = (window as any).__appStore
    const settings = appStore?.settings
    if (!settings?.models) return {}
    const profile = settings.models.profiles.find(
      (p: any) => p.id === settings.models.activeProfileId
    )
    if (!profile?.voiceSettings?.[role]) return {}
    return profile.voiceSettings[role]
  } catch {
    return {}
  }
}

/**
 * Queue text for speech. Plays after any currently playing speech finishes.
 * @param text Clean body text to speak
 * @param role Optional role name — uses role-specific voice if configured
 */
export async function speakText(text: string, role?: string): Promise<void> {
  if (!enabled || !text.trim()) return

  return new Promise<void>((resolve) => {
    speechQueue.push({ text, role, resolve })
    processQueue()
  })
}

/**
 * Sanitize text for TTS — strip code blocks, markdown, emojis, symbols.
 * Returns only the natural language content that should be read aloud.
 */
function sanitizeForTts(text: string): string {
  let clean = text

  // Remove <code>...</code> blocks (model-generated code)
  clean = clean.replace(/<code>[\s\S]*?<\/code>/gi, '')

  // Remove markdown code blocks (```...```)
  clean = clean.replace(/```[\s\S]*?```/g, '')

  // Remove inline code (`...`)
  clean = clean.replace(/`[^`]+`/g, '')

  // Remove markdown bold/italic (**text**, *text*, __text__, _text_)
  clean = clean.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
  clean = clean.replace(/_{1,2}([^_]+)_{1,2}/g, '$1')

  // Remove markdown headers (# ## ### etc)
  clean = clean.replace(/^#{1,6}\s+/gm, '')

  // Remove markdown list markers (- * + and numbered)
  clean = clean.replace(/^[\s]*[-*+]\s+/gm, '')
  clean = clean.replace(/^[\s]*\d+\.\s+/gm, '')

  // Remove markdown links [text](url) → text
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

  // Remove horizontal rules
  clean = clean.replace(/^[-*_]{3,}$/gm, '')

  // Remove emojis (Unicode emoji ranges)
  clean = clean.replace(/[\u{1F600}-\u{1F64F}]/gu, '') // Emoticons
  clean = clean.replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // Misc symbols
  clean = clean.replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // Transport
  clean = clean.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // Flags
  clean = clean.replace(/[\u{2600}-\u{26FF}]/gu, '')   // Misc symbols
  clean = clean.replace(/[\u{2700}-\u{27BF}]/gu, '')   // Dingbats
  clean = clean.replace(/[\u{FE00}-\u{FE0F}]/gu, '')   // Variation selectors
  clean = clean.replace(/[\u{1F900}-\u{1F9FF}]/gu, '') // Supplemental
  clean = clean.replace(/[\u{200D}]/gu, '')             // Zero-width joiner

  // Remove common symbols that don't read well
  clean = clean.replace(/[✓✗✔✘★☆●○■□▸▾▴▪•→←↑↓⚠️❌✅❗❓💡🔧📋↗]/g, '')

  // Clean up multiple blank lines and whitespace
  clean = clean.replace(/\n{3,}/g, '\n\n')
  clean = clean.replace(/[ \t]+/g, ' ')
  clean = clean.trim()

  return clean
}

/**
 * Speak text immediately (internal — called by queue processor).
 */
async function speakTextImmediate(text: string, role?: string): Promise<void> {
  const config = getTtsConfig()
  if (!config.enabled) return

  // Resolve voice: role-specific override > global default
  const roleVoice = getRoleVoiceSettings(role)
  const effectiveVoice = roleVoice.voice || config.defaultVoice || 'default'

  // RVC: "__none__" means explicitly skip RVC for this role
  // undefined/missing means use global default
  let effectiveRvcModel = ''
  let rvcDisabledForRole = false
  if (roleVoice.rvcVoice === '__none__') {
    effectiveRvcModel = ''
    rvcDisabledForRole = true
  } else if (roleVoice.rvcVoice) {
    effectiveRvcModel = roleVoice.rvcVoice
  } else {
    effectiveRvcModel = config.rvcModel || ''
  }

  console.log(`[TtsPlayback] Role: ${role || '(none)'}`)
  console.log(`[TtsPlayback] Role voice settings:`, JSON.stringify(roleVoice))
  console.log(`[TtsPlayback] Effective voice: ${effectiveVoice}, RVC: ${effectiveRvcModel || '(disabled for role)'}`)

  // Build effective config with role overrides applied
  const effectiveConfig = {
    ...config,
    defaultVoice: effectiveVoice,
    rvcModel: rvcDisabledForRole ? '' : effectiveRvcModel,
    // If RVC is explicitly disabled for this role, override rvcEnabled
    rvcEnabled: rvcDisabledForRole ? false : config.rvcEnabled,
  }

  const apiBase = getProxlabApiBase()
  const abort = new AbortController()
  currentAbort = abort

  // Sanitize text for TTS — strip code, markdown, emojis, symbols
  const ttsText = sanitizeForTts(text)
  if (!ttsText) {
    console.log('[TtsPlayback] Nothing to speak after sanitization')
    return
  }

  try {
    // Always use streaming endpoint (simple /v1/audio/speech was removed in TTS overhaul)
    await speakViaStream(ttsText, effectiveConfig, apiBase, abort)
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      console.warn('[TtsPlayback] Error:', err.message)
    }
  } finally {
    currentAbort = null
  }
}

/**
 * Simple TTS — single request, returns full audio.
 */
async function speakViaSimple(
  text: string, config: any, apiBase: string, abort: AbortController
): Promise<void> {
  const resp = await fetch(`${apiBase}/multi-tts/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: text,
      voice: config.defaultVoice || 'default',
      model: config.defaultModel || 'f5-tts',
      response_format: 'mp3',
    }),
    signal: abort.signal,
  })

  if (!resp.ok) {
    console.warn(`[TtsPlayback] TTS error: ${resp.status}`)
    return
  }

  const blob = await resp.blob()
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  currentAudio = audio

  await new Promise<void>((resolve, reject) => {
    audio.onended = () => { URL.revokeObjectURL(url); resolve() }
    audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Audio playback error')) }
    audio.play().catch(reject)
  })
}

/**
 * Streaming TTS — SSE dual pipeline with in-order sentence delivery.
 */
async function speakViaStream(
  text: string, config: any, apiBase: string, abort: AbortController
): Promise<void> {
  const body: any = {
    input: text,
    voice: config.defaultVoice || 'default',
    model: config.defaultModel || 'f5-tts',
    dual: true,
  }

  // Add RVC if enabled
  if (config.rvcEnabled && config.rvcModel) {
    body.rvc_model = config.rvcModel
  }

  // Add provider preferences
  if (config.preferredProviders?.length) {
    body.providers = config.preferredProviders
  }
  if (config.rvcProviders?.length) {
    body.rvc_providers = config.rvcProviders
  }

  console.log(`[TtsPlayback] Stream request body:`, JSON.stringify(body))

  const resp = await fetch(`${apiBase}/multi-tts/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: abort.signal,
  })

  if (!resp.ok || !resp.body) {
    console.warn(`[TtsPlayback] Stream error: ${resp.status}`)
    return
  }

  // Parse SSE stream and play audio chunks in order
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const audioQueue: string[] = [] // base64 audio chunks
  let playing = false

  const playNext = async () => {
    if (playing || audioQueue.length === 0) return
    playing = true
    const base64 = audioQueue.shift()!
    try {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'audio/wav' })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      currentAudio = audio
      await new Promise<void>((resolve) => {
        audio.onended = () => { URL.revokeObjectURL(url); resolve() }
        audio.onerror = () => { URL.revokeObjectURL(url); resolve() }
        audio.play().catch(() => resolve())
      })
    } catch {}
    playing = false
    // Play next chunk if available
    if (audioQueue.length > 0) playNext()
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const data = JSON.parse(line.slice(6))
        if (data.audio) {
          audioQueue.push(data.audio)
          playNext()
        }
      } catch {}
    }
  }

  // Wait for remaining audio to finish
  while (audioQueue.length > 0 || playing) {
    await new Promise(r => setTimeout(r, 100))
  }
}
