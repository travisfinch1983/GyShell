/**
 * Emitter spec — the four in-backend emitters must be HONEST: they fire on real
 * conditions, stay silent on healthy ones, and never re-alarm a standing state.
 * The KV-dead detector is exercised directly (pure function of a row).
 * Run: tsx packages/backend/src/services/Notifications/emitters.extreme.spec.ts
 */
// @ts-expect-error — ported JS module, no types
import { LlmMetricsPoller } from '../Cluster/proxy/llm/services/metrics-poller.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const assert = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(msg)
}

const GB = 1024 * 1024 * 1024
const raised: Array<{ severity: string; source: string; message: string }> = []
const poller = new LlmMetricsPoller({
  dataDir: mkdtempSync(join(tmpdir(), 'emit-spec-')),
  gpuMonitor: null,
  notify: (e: { severity: string; source: string; message: string }) => raised.push(e),
})

// Cold engine: stored below the floor → silent (not evidence of anything yet).
const cold: any = { model: 'm1', cum_kvOffloadStoredBytes: 2 * GB, cum_kvOffloadRestoredBytes: 0 }
poller._checkKvOffloadDead(cold)
assert(raised.length === 0, 'below the floor stays silent')

// Past the floor with zero restored → the wired-but-dead signature, exactly one event.
const dead: any = { model: 'm2', cum_kvOffloadStoredBytes: 12 * GB, cum_kvOffloadRestoredBytes: 0 }
poller._checkKvOffloadDead(dead)
assert(raised.length === 1 && raised[0].source === 'kv-offload', 'dead cache raises one event')
assert(raised[0].severity === 'error' && raised[0].message.includes('12.0 GB'), 'event names the volume')

// Standing condition must NOT re-alarm on every 20s poll.
poller._checkKvOffloadDead(dead)
poller._checkKvOffloadDead(dead)
assert(raised.length === 1, 'latched: a standing condition does not re-alarm')

// A healthy cache (restored > 0) is silent AND unlatches, so a later real failure still fires.
const healthy: any = { model: 'm3', cum_kvOffloadStoredBytes: 50 * GB, cum_kvOffloadRestoredBytes: 3 * GB }
poller._checkKvOffloadDead(healthy)
assert(raised.length === 1, 'a working cache raises nothing')
dead.cum_kvOffloadRestoredBytes = 1
poller._checkKvOffloadDead(dead)          // recovers → unlatch
dead.cum_kvOffloadRestoredBytes = 0
poller._checkKvOffloadDead(dead)          // fails again → fires again
assert(raised.length === 2, 'recovery unlatches so a later failure is not swallowed')

// No notify sink → no throw (the poller must run unchanged without notifications).
const bare = new LlmMetricsPoller({ dataDir: mkdtempSync(join(tmpdir(), 'emit-spec2-')), gpuMonitor: null })
bare._checkKvOffloadDead({ cum_kvOffloadStoredBytes: 99 * GB, cum_kvOffloadRestoredBytes: 0 })

console.log('emitters.extreme.spec: all assertions passed')
