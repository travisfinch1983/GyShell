import { makeAutoObservable } from 'mobx'

/**
 * Cross-tab navigation out of the Roadmap Overview.
 *
 * Follows the same shape as LiveConsoleStore: the caller sets a target and bumps a seq, App
 * reacts to the seq and switches the primary tab. A counter rather than a boolean, so asking
 * for the SAME destination twice in a row still fires — a flag would silently no-op the second
 * click and look like a dead button.
 */
class RoadmapNavStore {
  /** Report to open in the Reporting tab once it is surfaced. */
  reportId: string | null = null
  /** Bump to ask App to surface the Reporting tab. */
  reportSeq = 0

  constructor() { makeAutoObservable(this) }

  openReport(id: string): void {
    this.reportId = id
    this.reportSeq++
  }
}

export const roadmapNavStore = new RoadmapNavStore()
