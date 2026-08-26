/**
 * SttCapture — Speech-to-text capture service.
 *
 * Two modes:
 * 1. Push-to-talk: Record while held, transcribe on release, paste into input
 * 2. Hands-free: Continuously listen, auto-send after silence detected
 *
 * Uses browser MediaRecorder → sends audio to ProxLab STT endpoint.
 */

import { getProxlabApiBase } from './ProxlabDiscovery'

// ─── State ──────────────────────────────────────────────────────────────────

let mediaStream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let audioChunks: Blob[] = []

// Hands-free state
let handsFreeActive = false
let silenceTimer: ReturnType<typeof setTimeout> | null = null
let analyser: AnalyserNode | null = null
let audioContext: AudioContext | null = null
let silenceCheckInterval: ReturnType<typeof setInterval> | null = null

// Floor for "is this speech" on a 0-128 RMS scale. Used only until the real noise
// floor has been measured (see calibrate below) — the previous fixed 15 was higher than
// normal speech on a quiet mic with noiseSuppression enabled, which made hands-free look
// completely dead rather than merely mis-tuned.
const SILENCE_THRESHOLD_FLOOR = 3
// Speech must exceed the measured ambient noise by this factor.
const SPEECH_OVER_NOISE = 2.5
const SILENCE_TIMEOUT_MS = 3500 // Auto-send after this much silence
const SAMPLE_RATE = 16000

export type SttState = 'idle' | 'recording' | 'transcribing' | 'handsfree' | 'handsfree-recording'

// ─── Ownership ──────────────────────────────────────────────────────────────
//
// There is ONE microphone and one set of callbacks, but more than one consumer (the agent
// chat composer and the Notes tool). Without an explicit owner the second component to
// register silently steals the first one's transcripts: the mic still works, the audio is
// still transcribed, and the text is handed to a component the user isn't looking at. No
// error is raised anywhere, which makes it near-impossible to diagnose from the symptom.
//
// So: claim it. Last claimant wins, the previous owner is TOLD, and any capture still
// running is stopped instead of feeding a callback nobody is listening to.

export interface SttHandlers {
  onTranscript?: (text: string) => void
  onAutoSend?: (text: string) => void
  onStateChange?: (state: SttState) => void
  /** Called when someone else claims the microphone, so the UI can drop back to idle. */
  onEvicted?: (newOwner: string) => void
}

let owner: string | null = null
let onTranscript: ((text: string) => void) | null = null
let onAutoSend: ((text: string) => void) | null = null
let onStateChange: ((state: SttState) => void) | null = null
let onEvicted: ((newOwner: string) => void) | null = null

/** Take the microphone. Safe to call repeatedly with the same owner (handlers refresh). */
export function claimStt(newOwner: string, h: SttHandlers): void {
  if (owner && owner !== newOwner) {
    const prev = owner
    const prevEvicted = onEvicted
    // Stop BEFORE swapping handlers so the old owner sees its own final state change.
    if (handsFreeActive || (recorder && recorder.state === 'recording')) {
      console.warn(`[SttCapture] "${newOwner}" claimed the microphone while "${prev}" was still `
        + 'capturing — stopping the old capture rather than recording into a dead callback')
      stopHandsFree()
    }
    console.log(`[SttCapture] owner: ${prev} -> ${newOwner}`)
    prevEvicted?.(newOwner)
  }
  owner = newOwner
  onTranscript = h.onTranscript ?? null
  onAutoSend = h.onAutoSend ?? null
  onStateChange = h.onStateChange ?? null
  onEvicted = h.onEvicted ?? null
}

/**
 * Give the microphone back. OWNER-CHECKED on purpose: React unmounts the outgoing panel
 * AFTER the incoming one mounts, so an unguarded release would wipe the new owner's
 * callbacks on every tab switch and leave the mic owned by nobody.
 */
export function releaseStt(claimant: string): void {
  if (owner !== claimant) return
  if (handsFreeActive) stopHandsFree()
  owner = null
  onTranscript = null
  onAutoSend = null
  onStateChange = null
  onEvicted = null
}

export function sttOwner(): string | null {
  return owner
}

/** Warn loudly if capture starts with nobody registered — the transcript would go nowhere. */
function warnIfUnowned(what: string): void {
  if (!owner) {
    console.warn(`[SttCapture] ${what} started with NO owner claimed — the transcript will be `
      + 'discarded. Call claimStt() first.')
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

function getSttConfig(): any {
  try {
    return JSON.parse(localStorage.getItem('gyshell-stt-config') || '{}')
  } catch {
    return {}
  }
}

// ─── Microphone Access ──────────────────────────────────────────────────────

async function getMicrophone(): Promise<MediaStream> {
  if (mediaStream) return mediaStream
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
      echoCancellation: true,
      noiseSuppression: true,
    }
  })
  return mediaStream
}

function releaseMicrophone(): void {
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop())
    mediaStream = null
  }
  if (audioContext) {
    audioContext.close()
    audioContext = null
    analyser = null
  }
}

// ─── Transcription ──────────────────────────────────────────────────────────

async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const apiBase = getProxlabApiBase()
  const config = getSttConfig()

  const formData = new FormData()
  formData.append('file', audioBlob, 'recording.webm')
  formData.append('model', config.model || 'large-v3-turbo')

  const resp = await fetch(`${apiBase}/stt/v1/audio/transcriptions`, {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(30000),
  })

  if (!resp.ok) {
    console.warn(`[SttCapture] Transcription error: ${resp.status}`)
    return ''
  }

  const data = await resp.json()
  return (data.text || '').trim()
}

// ─── Push-to-Talk Mode ──────────────────────────────────────────────────────

export async function startPushToTalk(): Promise<void> {
  warnIfUnowned('push-to-talk')
  try {
    const stream = await getMicrophone()
    audioChunks = []

    recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm',
    })

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data)
    }

    recorder.start(100) // Collect chunks every 100ms
    onStateChange?.('recording')
    console.log('[SttCapture] Push-to-talk: recording started')
  } catch (err) {
    console.error('[SttCapture] Microphone error:', err)
    onStateChange?.('idle')
  }
}

export async function stopPushToTalk(): Promise<void> {
  if (!recorder || recorder.state !== 'recording') {
    onStateChange?.('idle')
    return
  }

  return new Promise<void>((resolve) => {
    recorder!.onstop = async () => {
      onStateChange?.('transcribing')
      const blob = new Blob(audioChunks, { type: 'audio/webm' })
      audioChunks = []

      if (blob.size < 1000) {
        // Too short — probably just a click
        console.log('[SttCapture] Recording too short, ignoring')
        onStateChange?.('idle')
        resolve()
        return
      }

      try {
        const text = await transcribeAudio(blob)
        if (text) {
          console.log(`[SttCapture] Transcribed: "${text}"`)
          onTranscript?.(text)
        }
      } catch (err) {
        console.warn('[SttCapture] Transcription failed:', err)
      }

      onStateChange?.('idle')
      releaseMicrophone()
      resolve()
    }

    recorder!.stop()
  })
}

// ─── Hands-Free Mode ────────────────────────────────────────────────────────

export async function startHandsFree(): Promise<void> {
  // A stuck flag from a previous failed attempt used to make every later press a silent
  // no-op — the button looked inert with no explanation anywhere.
  warnIfUnowned('hands-free')
  if (handsFreeActive) {
    console.warn('[SttCapture] Hands-free is already active — ignoring the start request. '
      + 'If the UI shows it as OFF, its state and this flag have diverged.')
    return
  }

  try {
    const stream = await getMicrophone()
    handsFreeActive = true

    // Set up audio analysis for silence detection
    audioContext = new AudioContext()
    // MUST resume. getMicrophone() is awaited above, which ends the user-gesture context,
    // so this AudioContext can be created 'suspended'. A suspended context feeds the
    // analyser nothing: RMS reads 0 forever, speech is never detected, and hands-free
    // silently does absolutely nothing. This was the bug.
    if (audioContext.state === 'suspended') {
      console.warn('[SttCapture] AudioContext started suspended (created after an await) — resuming')
      try {
        await audioContext.resume()
      } catch (e) {
        console.error('[SttCapture] could not resume the AudioContext — hands-free cannot hear anything:', e)
      }
    }
    console.log(`[SttCapture] AudioContext state: ${audioContext.state}`)
    if (audioContext.state !== 'running') {
      console.error('[SttCapture] AudioContext is not running — aborting hands-free rather than '
        + 'appearing to listen while deaf')
      handsFreeActive = false
      onStateChange?.('idle')
      releaseMicrophone()
      return
    }

    const source = audioContext.createMediaStreamSource(stream)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)

    onStateChange?.('handsfree')
    console.log('[SttCapture] Hands-free: listening')

    // Start the listen-detect-transcribe loop
    listenLoop(stream)
  } catch (err) {
    console.error('[SttCapture] Hands-free microphone error:', err)
    handsFreeActive = false
    onStateChange?.('idle')
  }
}

function listenLoop(stream: MediaStream): void {
  if (!handsFreeActive || !analyser) return

  // fftSize samples, NOT frequencyBinCount (= fftSize/2): getByteTimeDomainData fills a
  // waveform of fftSize, so the old half-length array examined only half of each window.
  const dataArray = new Uint8Array(analyser.fftSize)
  let speechDetected = false
  // Ambient noise is measured for the first second and the speech threshold derived from
  // it, so a quiet mic no longer reads as permanent silence.
  let noiseFloor = 0
  let calibrationTicks = 0
  let threshold = SILENCE_THRESHOLD_FLOOR
  let peak = 0
  let ticks = 0

  audioChunks = []
  recorder = new MediaRecorder(stream, {
    mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm',
  })

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data)
  }

  recorder.start(100)

  // Monitor audio levels
  silenceCheckInterval = setInterval(() => {
    if (!analyser || !handsFreeActive) {
      clearSilenceMonitor()
      return
    }

    analyser.getByteTimeDomainData(dataArray)

    // Calculate RMS
    let sum = 0
    for (let i = 0; i < dataArray.length; i++) {
      const val = (dataArray[i] - 128) / 128
      sum += val * val
    }
    const rms = Math.sqrt(sum / dataArray.length) * 128

    // First ~1s: learn the room instead of trusting a constant.
    ticks++
    if (rms > peak) peak = rms
    if (calibrationTicks < 10) {
      calibrationTicks++
      noiseFloor = Math.max(noiseFloor, rms)
      if (calibrationTicks === 10) {
        threshold = Math.max(noiseFloor * SPEECH_OVER_NOISE, SILENCE_THRESHOLD_FLOOR)
        console.log(`[SttCapture] VAD calibrated: noise floor ${noiseFloor.toFixed(1)}, `
          + `speech threshold ${threshold.toFixed(1)} (0-128 scale)`)
      }
      return
    }

    // Say what we are hearing. Without this, a mic quieter than the threshold is
    // indistinguishable from a dead pipeline — which is exactly how this bug presented.
    if (ticks % 20 === 0 && !speechDetected) {
      console.log(`[SttCapture] listening… peak RMS ${peak.toFixed(1)} vs threshold `
        + `${threshold.toFixed(1)} — ${peak > threshold ? 'should have triggered' : 'below threshold, not speech yet'}`)
      peak = 0
    }

    if (rms > threshold) {
      // Speech detected
      if (!speechDetected) {
        speechDetected = true
        onStateChange?.('handsfree-recording')
        console.log('[SttCapture] Hands-free: speech detected')
      }
      // Reset silence timer
      if (silenceTimer) {
        clearTimeout(silenceTimer)
        silenceTimer = null
      }
    } else if (speechDetected) {
      // Silence after speech — start countdown
      if (!silenceTimer) {
        console.log(`[SttCapture] Hands-free: silence — sending in ${SILENCE_TIMEOUT_MS}ms unless you resume`)
        silenceTimer = setTimeout(() => {
          console.log('[SttCapture] Hands-free: silence timeout — transcribing the segment')
          void finishHandsFreeSegment(stream)
        }, SILENCE_TIMEOUT_MS)
      }
    }
  }, 100)
}

function clearSilenceMonitor(): void {
  if (silenceCheckInterval) {
    clearInterval(silenceCheckInterval)
    silenceCheckInterval = null
  }
  if (silenceTimer) {
    clearTimeout(silenceTimer)
    silenceTimer = null
  }
}

async function finishHandsFreeSegment(stream: MediaStream): Promise<void> {
  clearSilenceMonitor()

  if (!recorder || recorder.state !== 'recording') {
    if (handsFreeActive) listenLoop(stream)
    return
  }

  return new Promise<void>((resolve) => {
    recorder!.onstop = async () => {
      onStateChange?.('transcribing')
      const blob = new Blob(audioChunks, { type: 'audio/webm' })
      audioChunks = []

      if (blob.size < 1000) {
        onStateChange?.('handsfree')
        if (handsFreeActive) listenLoop(stream)
        resolve()
        return
      }

      try {
        const text = await transcribeAudio(blob)
        if (text) {
          console.log(`[SttCapture] Hands-free transcribed: "${text}"`)
          onAutoSend?.(text)
        }
      } catch (err) {
        console.warn('[SttCapture] Hands-free transcription failed:', err)
      }

      onStateChange?.('handsfree')
      // Continue listening
      if (handsFreeActive) listenLoop(stream)
      resolve()
    }

    recorder!.stop()
  })
}

export function stopHandsFree(): void {
  handsFreeActive = false
  clearSilenceMonitor()

  if (recorder && recorder.state === 'recording') {
    recorder.stop()
  }
  recorder = null
  audioChunks = []
  releaseMicrophone()
  onStateChange?.('idle')
  console.log('[SttCapture] Hands-free: stopped')
}

export function isHandsFreeActive(): boolean {
  return handsFreeActive
}
