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

const SILENCE_THRESHOLD = 15 // RMS below this = silence (0-128 scale)
const SILENCE_TIMEOUT_MS = 3500 // Auto-send after this much silence
const SAMPLE_RATE = 16000

// Callbacks
let onTranscript: ((text: string) => void) | null = null
let onAutoSend: ((text: string) => void) | null = null
let onStateChange: ((state: 'idle' | 'recording' | 'transcribing' | 'handsfree' | 'handsfree-recording') => void) | null = null

export type SttState = 'idle' | 'recording' | 'transcribing' | 'handsfree' | 'handsfree-recording'

// ─── Config ─────────────────────────────────────────────────────────────────

function getSttConfig(): any {
  try {
    return JSON.parse(localStorage.getItem('gyshell-stt-config') || '{}')
  } catch {
    return {}
  }
}

// ─── Callbacks ──────────────────────────────────────────────────────────────

export function setOnTranscript(cb: (text: string) => void): void {
  onTranscript = cb
}

export function setOnAutoSend(cb: (text: string) => void): void {
  onAutoSend = cb
}

export function setOnStateChange(cb: (state: SttState) => void): void {
  onStateChange = cb
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
  if (handsFreeActive) return

  try {
    const stream = await getMicrophone()
    handsFreeActive = true

    // Set up audio analysis for silence detection
    audioContext = new AudioContext()
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

  // Wait for speech to start
  const dataArray = new Uint8Array(analyser.frequencyBinCount)
  let speechDetected = false

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

    if (rms > SILENCE_THRESHOLD) {
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
        silenceTimer = setTimeout(() => {
          // Silence timeout reached — stop and transcribe
          finishHandsFreeSegment(stream)
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
