import { TransitionLatch } from '../notifyLocal'

const sftpLatch = new TransitionLatch(3, 'sftp')

export type SftpTransferDirection = 'upload' | 'download'

export interface SftpTransferProfile {
  id: string
  concurrency: number
  chunkSize: number
}

interface SftpTransferProfileStats {
  attempts: number
  successes: number
  failures: number
  consecutiveFailures: number
  throughputEwmaBytesPerSec: number
  lastSelectedAt: number
  lastSuccessAt: number
}

interface SftpDirectionState {
  profileStats: Map<string, SftpTransferProfileStats>
  totalSelections: number
}

export interface SftpAdaptiveTransferTunerOptions {
  profiles: SftpTransferProfile[]
  preferredProfileId?: string
  explorationInterval?: number
  throughputEwmaAlpha?: number
}

const DEFAULT_EXPLORATION_INTERVAL = 8
const DEFAULT_THROUGHPUT_EWMA_ALPHA = 0.35

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

const createInitialProfileStats = (): SftpTransferProfileStats => ({
  attempts: 0,
  successes: 0,
  failures: 0,
  consecutiveFailures: 0,
  throughputEwmaBytesPerSec: 0,
  lastSelectedAt: 0,
  lastSuccessAt: 0
})

export class SftpAdaptiveTransferTuner {
  private readonly profiles: SftpTransferProfile[]
  private readonly profileById: Map<string, SftpTransferProfile>
  private readonly preferredProfileId: string
  private readonly explorationInterval: number
  private readonly throughputEwmaAlpha: number
  private readonly directionState = new Map<string, SftpDirectionState>()

  constructor(options: SftpAdaptiveTransferTunerOptions) {
    if (!Array.isArray(options.profiles) || options.profiles.length <= 0) {
      throw new Error('SftpAdaptiveTransferTuner requires at least one transfer profile.')
    }

    this.profiles = options.profiles
    this.profileById = new Map(options.profiles.map((profile) => [profile.id, profile]))
    this.preferredProfileId = this.profileById.has(options.preferredProfileId || '')
      ? (options.preferredProfileId as string)
      : options.profiles[0].id
    this.explorationInterval = Math.max(2, Math.floor(options.explorationInterval || DEFAULT_EXPLORATION_INTERVAL))
    this.throughputEwmaAlpha = clamp(
      Number.isFinite(options.throughputEwmaAlpha) ? Number(options.throughputEwmaAlpha) : DEFAULT_THROUGHPUT_EWMA_ALPHA,
      0.05,
      0.95
    )
  }

  selectProfile(endpointKey: string, direction: SftpTransferDirection): SftpTransferProfile {
    const state = this.getDirectionState(endpointKey, direction)
    state.totalSelections += 1
    const now = Date.now()

    const preferredStats = state.profileStats.get(this.preferredProfileId) || createInitialProfileStats()
    if (preferredStats.attempts <= 0) {
      preferredStats.lastSelectedAt = now
      state.profileStats.set(this.preferredProfileId, preferredStats)
      return this.profileById.get(this.preferredProfileId) as SftpTransferProfile
    }

    const shouldExplore = state.totalSelections % this.explorationInterval === 0
    if (shouldExplore) {
      const untested = this.profiles.find((profile) => {
        const stats = state.profileStats.get(profile.id)
        return !stats || stats.attempts <= 0
      })
      if (untested) {
        const stats = state.profileStats.get(untested.id) || createInitialProfileStats()
        stats.lastSelectedAt = now
        state.profileStats.set(untested.id, stats)
        return untested
      }

      const leastRecentlyUsed = this.profiles
        .map((profile) => ({
          profile,
          stats: state.profileStats.get(profile.id) || createInitialProfileStats()
        }))
        .sort((left, right) => left.stats.lastSelectedAt - right.stats.lastSelectedAt)[0]

      leastRecentlyUsed.stats.lastSelectedAt = now
      state.profileStats.set(leastRecentlyUsed.profile.id, leastRecentlyUsed.stats)
      return leastRecentlyUsed.profile
    }

    const best = this.profiles
      .map((profile) => {
        const stats = state.profileStats.get(profile.id) || createInitialProfileStats()
        return {
          profile,
          stats,
          score: this.computeProfileScore(stats)
        }
      })
      .sort((left, right) => right.score - left.score)[0]

    best.stats.lastSelectedAt = now
    state.profileStats.set(best.profile.id, best.stats)
    return best.profile
  }

  reportSuccess(
    endpointKey: string,
    direction: SftpTransferDirection,
    profileId: string,
    transferredBytes: number,
    elapsedMs: number
  ): void {
    const profile = this.profileById.get(profileId)
    if (!profile) return
    const state = this.getDirectionState(endpointKey, direction)
    const stats = state.profileStats.get(profileId) || createInitialProfileStats()

    const safeBytes = Math.max(0, Number(transferredBytes) || 0)
    const safeElapsedMs = Math.max(1, Number(elapsedMs) || 1)
    const observedBytesPerSec = safeBytes <= 0 ? 0 : (safeBytes * 1000) / safeElapsedMs

    stats.attempts += 1
    stats.successes += 1
    if (stats.consecutiveFailures >= 3) sftpLatch.rearm(`degraded:${endpointKey}:${direction}`)
    stats.consecutiveFailures = 0
    stats.lastSuccessAt = Date.now()
    if (observedBytesPerSec > 0) {
      stats.throughputEwmaBytesPerSec = stats.throughputEwmaBytesPerSec > 0
        ? (stats.throughputEwmaBytesPerSec * (1 - this.throughputEwmaAlpha)) + (observedBytesPerSec * this.throughputEwmaAlpha)
        : observedBytesPerSec
    }
    state.profileStats.set(profileId, stats)
  }

  reportFailure(endpointKey: string, direction: SftpTransferDirection, profileId: string): void {
    const profile = this.profileById.get(profileId)
    if (!profile) return
    const state = this.getDirectionState(endpointKey, direction)
    const stats = state.profileStats.get(profileId) || createInitialProfileStats()
    stats.attempts += 1
    stats.failures += 1
    stats.consecutiveFailures += 1
    state.profileStats.set(profileId, stats)
    // The tuner has always COUNTED this and never surfaced it: every failure
    // silently ran the stream fallback and returned success, so a 32-way
    // parallel transfer and a single-stream crawl were indistinguishable to
    // the caller. Three consecutive = the fast path is off for this endpoint,
    // not a blip. Endpoint key only — never credentials.
    if (stats.consecutiveFailures === 3) {
      console.warn(`[sftp-tuner] ${endpointKey}/${direction}: fast transfer failed 3 consecutive times — running degraded on the stream fallback`)
      sftpLatch.once(`degraded:${endpointKey}:${direction}`, 'warning',
        'SFTP fast transfer is degraded for an endpoint',
        `${endpointKey} (${direction}): 3 consecutive fast-path failures; transfers still complete via the single-stream fallback, just slower.`)
    }
  }

  private getDirectionState(endpointKey: string, direction: SftpTransferDirection): SftpDirectionState {
    const key = `${endpointKey}::${direction}`
    let state = this.directionState.get(key)
    if (!state) {
      state = {
        profileStats: new Map(),
        totalSelections: 0
      }
      this.directionState.set(key, state)
    }
    return state
  }

  private computeProfileScore(stats: SftpTransferProfileStats): number {
    const throughput = stats.throughputEwmaBytesPerSec > 0 ? stats.throughputEwmaBytesPerSec : 1
    const reliability = stats.successes / Math.max(1, stats.successes + stats.failures)
    const reliabilityFactor = 0.3 + reliability * 0.7
    const failurePenalty = 1 / (1 + stats.consecutiveFailures * 0.8)
    return throughput * reliabilityFactor * failurePenalty
  }
}

export const DEFAULT_SFTP_TRANSFER_PROFILES: SftpTransferProfile[] = [
  { id: 'balanced-32x128k', concurrency: 32, chunkSize: 128 * 1024 },
  { id: 'compat-64x32k', concurrency: 64, chunkSize: 32 * 1024 },
  { id: 'wide-16x256k', concurrency: 16, chunkSize: 256 * 1024 }
]

