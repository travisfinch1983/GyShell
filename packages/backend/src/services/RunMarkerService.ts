import Store from 'electron-store'

/**
 * RunMarkerService — persistent "a run is in flight" markers, one per session.
 *
 * The agent loop lives in the always-up backend, but LangGraph run state is
 * held in an in-memory MemorySaver (deleted after every task). So if the
 * backend is restarted/crashes mid-turn, the transcript keeps whatever was
 * last persisted, but the interrupted turn silently vanishes. These markers
 * let boot-time recovery notice an interrupted turn and surface it to the user
 * ("your last turn was cut off — re-send to continue") instead of leaving a
 * confusing gap. Keyed by sessionId → matches the one-in-flight-run-per-agent
 * (single-flight) model of the ConversationBus.
 *
 * Deliberately NOT a LangGraph checkpointer: the graph rebuilds its state from
 * ChatHistoryService each run and clears its checkpoint thread on completion,
 * so a persistent checkpointer would only help mid-graph resume (replaying
 * half-executed tool side effects — out of scope). Run-level recovery is the
 * honest, cheap thing to build. See /claude/plans/ailab-chat-rework.md §R3.5.
 */
export interface RunMarker {
  sessionId: string
  /** epoch ms when the run started */
  startedAt: number
  startMode: 'normal' | 'inserted'
}

interface StoredRunMarkers {
  markers: Record<string, RunMarker>
}

export class RunMarkerService {
  private store: Store<StoredRunMarkers>

  constructor() {
    const storeOptions: any = {
      defaults: { markers: {} },
      name: 'gyshell-run-markers',
      projectName: 'gyshell'
    }
    if (process.env.GYSHELL_STORE_DIR) {
      storeOptions.cwd = process.env.GYSHELL_STORE_DIR
    }
    this.store = new Store<StoredRunMarkers>(storeOptions)
  }

  set(marker: RunMarker): void {
    const markers = this.store.get('markers') || {}
    markers[marker.sessionId] = marker
    this.store.set('markers', markers)
  }

  clear(sessionId: string): void {
    const markers = this.store.get('markers') || {}
    if (markers[sessionId]) {
      delete markers[sessionId]
      this.store.set('markers', markers)
    }
  }

  getAll(): RunMarker[] {
    return Object.values(this.store.get('markers') || {})
  }

  clearAll(): void {
    this.store.set('markers', {})
  }
}
