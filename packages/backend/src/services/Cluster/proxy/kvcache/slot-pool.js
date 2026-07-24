// ─────────────────────────────────────────────────────────────────────────────
// SlotPool  — per-slot async locks over a llama-server's slots
// ─────────────────────────────────────────────────────────────────────────────
// Faithful port of the shim's SlotPool. llama-server has a fixed number of slots
// (--parallel). We must not restore/save/forward two requests into the SAME slot
// concurrently, so each slot has a mutex. acquire() takes any free slot (first-free, then
// round-robin wait); acquireSpecific() grabs one named slot ONLY if free right now (used by
// warm-slot affinity — never block waiting for a specific warm slot, fall back instead).
//
// forceReleaseStale() is the safety valve: if a request path dies without releasing (bug),
// a slot held longer than maxAgeSec is force-released so the pool can't wedge permanently.

/** Minimal FIFO async mutex. */
class AsyncLock {
  constructor() {
    this._locked = false;
    this._waiters = [];
  }
  get locked() { return this._locked; }
  async acquire() {
    if (!this._locked) { this._locked = true; return; }
    await new Promise((resolve) => this._waiters.push(resolve));
    // handed the lock by release(); already marked locked there.
  }
  tryAcquire() {
    if (this._locked) return false;
    this._locked = true;
    return true;
  }
  release() {
    const next = this._waiters.shift();
    if (next) next();            // hand lock to next waiter; stays locked
    else this._locked = false;   // no waiters; free it
  }
}

export class SlotPool {
  /** @param {number[]} slotIds  e.g. [0,1] */
  constructor(slotIds) {
    this.slotIds = [...slotIds];
    this.locks = new Map(this.slotIds.map((id) => [id, new AsyncLock()]));
    this.acquiredAt = new Map();   // slotId → monotonic ms
    this._rr = 0;
  }

  /** Acquire any free slot; if none free, round-robin wait for the next to free. */
  async acquire() {
    for (const id of this.slotIds) {
      if (this.locks.get(id).tryAcquire()) {
        this.acquiredAt.set(id, now());
        return id;
      }
    }
    const id = this.slotIds[this._rr % this.slotIds.length];
    this._rr = (this._rr + 1) % this.slotIds.length;
    await this.locks.get(id).acquire();
    this.acquiredAt.set(id, now());
    return id;
  }

  /** Acquire a SPECIFIC slot only if free right now (VRAM warm-slot affinity). No blocking. */
  acquireSpecific(slotId) {
    const lock = this.locks.get(slotId);
    if (!lock || lock.locked) return false;
    const got = lock.tryAcquire();
    if (got) this.acquiredAt.set(slotId, now());
    return got;
  }

  release(slotId) {
    const lock = this.locks.get(slotId);
    if (!lock) return;
    this.acquiredAt.delete(slotId);
    lock.release();
  }

  /** Force-release any slot held longer than maxAgeSec (safety sweep). Returns released ids. */
  forceReleaseStale(maxAgeSec) {
    const cutoff = now() - maxAgeSec * 1000;
    const freed = [];
    for (const [id, at] of [...this.acquiredAt.entries()]) {
      if (at < cutoff && this.locks.get(id).locked) {
        this.release(id);
        freed.push(id);
      }
    }
    return freed;
  }

  status() {
    return this.slotIds.map((id) => ({
      id,
      locked: this.locks.get(id).locked,
      heldMs: this.acquiredAt.has(id) ? now() - this.acquiredAt.get(id) : null,
    }));
  }
}

// process-monotonic ms; avoids Date.now() clock-jump issues for hold-age math.
function now() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
