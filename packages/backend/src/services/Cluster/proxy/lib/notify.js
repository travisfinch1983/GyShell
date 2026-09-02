/**
 * Proxy-side notification emitter — the estate-wide cheap path, from inside.
 *
 * The proxy routers run in the same process as NotificationsService, which
 * mounts POST /api/notifications/emit on this very listener — so a local HTTP
 * call is the whole integration, and a router needs no service handle threaded
 * through eight layers to raise an event.
 *
 * Rules baked in rather than left to call sites:
 *  - NEVER throws, never blocks meaningfully: reporting a fault must not be
 *    able to cause one. A lost report still leaves one console line saying the
 *    REPORT was lost — a notification that vanishes silently is the exact
 *    failure class this whole sweep exists to remove.
 *  - emitOnce() latches per process per key: startup capability warnings and
 *    per-run summaries must not repeat on every request that touches them.
 *  - Interpolated values belong in `detail`, never `message` — the backend
 *    dedups and the journal keys on stable text (the $nosig lesson).
 */
const PORT = process.env.AILAB_PROXY_PORT || 17890;

const seen = new Set();

export async function emitNotification(severity, source, message, detail = '') {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/notifications/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ severity, source, message, detail }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.warn(`[notify] NOTIFY LOST (${e?.message || e}): ${severity} ${source}: ${message}`);
  }
}

/**
 * Write one line to the DEBUG CONSOLE (not the notification panel).
 *
 * Same contract as emitNotification: never throws, never blocks meaningfully. Debug lines narrate
 * work that is going fine - starts, finishes, scheduler ticks - which do not deserve a badge but
 * are exactly what you want when asking "is this thing actually running?". Faults still go to
 * emitNotification.
 */
export async function emitDebug(source, message) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/notifications/debug`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, message }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.warn(`[notify] DEBUG LOST (${e?.message || e}): ${source}: ${message}`);
  }
}

/**
 * Load a JSON state file, refusing to confuse ABSENT with UNREADABLE.
 *
 * 🛑 The old idiom — try { parse } catch {} return fallback — made a corrupt
 * file indistinguishable from a first boot, and the next save() then wrote the
 * fallback OVER the corrupt file: external model sources, the credentials
 * vault, the vector-DB config and the active-services map could each be
 * silently emptied by one truncated write (Observability Sweep, 2026-08-30).
 *
 * Absent stays a normal, silent fallback. Present-but-unparseable is never
 * normal: the file is COPIED ASIDE first (so a later save cannot destroy the
 * only copy of the data), then an error is emitted naming the file, then the
 * fallback is returned so the surface stays up.
 */
export function loadJsonState(fs, file, fallback, { source, what }) {
  if (!fs.existsSync(file)) return fallback;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    let saved = '';
    try {
      const backup = `${file}.corrupt-${Date.now()}`;
      fs.copyFileSync(file, backup);
      saved = backup;
    } catch { /* the emit below still names the file */ }
    console.error(`[state] ${file} is present but unreadable (${e?.message || e}); ` +
      (saved ? `original copied to ${saved}; ` : 'backup copy FAILED; ') + 'serving defaults.');
    emitOnce(`state-corrupt:${file}`, 'error', source,
      `${what} state file is corrupt — serving defaults`,
      `${file} exists but cannot be parsed (${e?.message || e}). ` +
      (saved ? `The original is preserved at ${saved}. ` : 'Backing it up ALSO failed. ') +
      `${what} appears empty until this is repaired, and any edit made now will save over the broken file.`);
    return fallback;
  }
}

/** Emit at most once per process for `key` — for startup warnings and per-run summaries. */
export function emitOnce(key, severity, source, message, detail = '') {
  if (seen.has(key)) return;
  seen.add(key);
  void emitNotification(severity, source, message, detail);
}
