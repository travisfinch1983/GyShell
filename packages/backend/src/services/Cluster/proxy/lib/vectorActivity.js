/**
 * Vector-work activity tracker (Travis, 2026-10-09): every embed/rerank call that
 * crosses the proxy is attributed to a SOURCE and aggregated, so the notifications
 * panel can show what background work is hammering the vector cards — and whether
 * something is failing-and-repeating rather than working. The proxy is a true
 * chokepoint today (verified: all 5012/5013 traffic arrives from this process), so
 * what this module sees is the whole picture; if a future consumer bypasses the
 * proxy it will be visible as engine load with no bucket here, not mis-attributed.
 *
 * Attribution: callers that set `x-ailab-source` are named exactly; everything
 * else is labelled from user-agent + remote address — honest about being a guess.
 */
import { emitNotification } from './notify.js';

const WINDOW_SEC = 120;           // ring size; rates are computed over the last 60s
const RATE_SEC = 60;
const CONSECUTIVE_FAIL_ALARM = 5; // failing-and-repeating threshold

const buckets = new Map(); // `${op}|${source}` -> bucket

function getBucket(op, source) {
  const key = `${op}|${source}`;
  let b = buckets.get(key);
  if (!b) {
    b = {
      op, source,
      ring: Array.from({ length: WINDOW_SEC }, () => ({ sec: 0, req: 0, items: 0, errs: 0 })),
      totalReq: 0, totalItems: 0, totalErrs: 0,
      consecutiveErrs: 0, alarmed: false,
      lastError: null, lastSeenMs: 0, firstSeenMs: Date.now(), inflight: 0,
    };
    buckets.set(key, b);
  }
  return b;
}

function ringSlot(b, nowSec) {
  const slot = b.ring[nowSec % WINDOW_SEC];
  if (slot.sec !== nowSec) { slot.sec = nowSec; slot.req = 0; slot.items = 0; slot.errs = 0; }
  return slot;
}

/** Map a request to a source name. Header wins; the rest is a labelled guess. */
export function resolveVectorSource(req) {
  const tagged = String(req.headers?.['x-ailab-source'] || '').trim();
  if (tagged) return tagged.slice(0, 60);
  const ua = String(req.headers?.['user-agent'] || '').toLowerCase();
  const ip = req.ip || req.socket?.remoteAddress || '?';
  const host = ip.replace(/^::ffff:/, '');
  if (ua.includes('python') || ua.includes('aiohttp') || ua.includes('httpx'))
    return `python @${host === '127.0.0.1' ? 'local' : host}`;
  if (host === '127.0.0.1' || host === '::1') return 'ai-lab backend (untagged)';
  return `${(ua.split('/')[0] || 'unknown').slice(0, 20)} @${host}`;
}

/** Begin tracking one call; call .end(ok, status?, errMsg?) exactly once. */
export function beginVectorCall(op, source, items) {
  const b = getBucket(op, source);
  b.inflight += 1;
  const t0 = Date.now();
  let ended = false;
  return {
    end(ok, status = 0, errMsg = '') {
      if (ended) return; ended = true;
      b.inflight = Math.max(0, b.inflight - 1);
      const now = Date.now();
      const slot = ringSlot(b, Math.floor(now / 1000));
      slot.req += 1; slot.items += items || 0;
      b.totalReq += 1; b.totalItems += items || 0;
      b.lastSeenMs = now;
      if (ok) {
        if (b.alarmed) {
          b.alarmed = false;
          void emitNotification('info', `vector-activity:${op}:${b.source}`,
            'vector calls recovered', `${b.op} from ${b.source} succeeding again after ${b.consecutiveErrs} consecutive failures (${Math.round((now - t0) / 1000)}s last call)`);
        }
        b.consecutiveErrs = 0;
      } else {
        slot.errs += 1; b.totalErrs += 1; b.consecutiveErrs += 1;
        b.lastError = { status, msg: String(errMsg || '').slice(0, 200), ts: new Date(now).toISOString() };
        // Failing-and-repeating is the state Travis explicitly wants distinguishable
        // from normal background work; latch so an outage is one warning, not a storm.
        if (!b.alarmed && b.consecutiveErrs >= CONSECUTIVE_FAIL_ALARM) {
          b.alarmed = true;
          void emitNotification('warning', `vector-activity:${op}:${b.source}`,
            'vector calls failing repeatedly',
            `${b.op} from ${b.source}: ${b.consecutiveErrs} consecutive failures, last status ${status} ${b.lastError.msg}`);
        }
      }
    },
  };
}

/** Panel snapshot: per-bucket totals + rates over the last 60s. */
export function vectorActivitySnapshot() {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const out = [];
  for (const b of buckets.values()) {
    let req = 0, items = 0, errs = 0;
    for (const slot of b.ring) if (slot.sec > nowSec - RATE_SEC && slot.sec <= nowSec) { req += slot.req; items += slot.items; errs += slot.errs; }
    out.push({
      op: b.op, source: b.source,
      rpm: req, ipm: items, epm: errs,          // per-minute figures (last 60s)
      inflight: b.inflight,
      totalReq: b.totalReq, totalItems: b.totalItems, totalErrs: b.totalErrs,
      consecutiveErrs: b.consecutiveErrs,
      lastError: b.lastError,
      lastSeen: b.lastSeenMs ? new Date(b.lastSeenMs).toISOString() : null,
      firstSeen: new Date(b.firstSeenMs).toISOString(),
    });
  }
  out.sort((a, c) => (c.rpm - a.rpm) || ((c.lastSeen || '') < (a.lastSeen || '') ? -1 : 1));
  return { windowSec: RATE_SEC, buckets: out };
}
