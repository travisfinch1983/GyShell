// ─────────────────────────────────────────────────────────────────────────────
// KV-cache integration glue  — the seam between proxy.js and the orchestrator
// ─────────────────────────────────────────────────────────────────────────────
// Owns: per-service settings (default OFF), the llama.cpp eligibility gate, and the
// per-service KvOrchestrator factory. One orchestrator per llama instance (its own slot
// pool + Upstream), but the SQLite index is SHARED by stable fingerprint so two instances
// with matching KV params share one Optane pool + index (plan §4a).
//
// The launch command is read once (over SSH from the llama host's /proc) to derive the
// stable fingerprint and the physical --slot-save-path (for the reaper). ai-lab.service
// runs as root on CT152 and has an SSH key to every node.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { computeKvFingerprint, STATE_SEQ_VERSION } from './fingerprint.js';
import { KvIndex } from './index-store.js';
import { Upstream } from './upstream.js';
import { KvOrchestrator } from './orchestrator.js';
import { reapFp } from './reaper.js';

const execFileAsync = promisify(execFile);
const SSH_KEY = process.env.AILAB_SSH_KEY || '/root/.ssh/id_ed25519';
const KV_DATA_DIR = process.env.AILAB_KV_DATA_DIR || '/opt/ai-lab/.gybackend-data/kvcache';
const SETTINGS_FILE = join(KV_DATA_DIR, 'kvcache-settings.json');
const LLAMA_PROVIDER = 'llama-server';

// ── settings (default OFF; the integration is inert until a service is toggled on) ──
let _settingsCache = null;
let _settingsExpires = 0;
function loadSettings() {
  const now = Date.now();
  if (_settingsCache && _settingsExpires > now) return _settingsCache;
  let s = { defaultEnabled: false, perService: {} };
  try { if (existsSync(SETTINGS_FILE)) s = { ...s, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { /* default */ }
  _settingsCache = s; _settingsExpires = now + 5_000;   // 5s TTL so toggles land promptly
  return s;
}
export function getKvSettings() { return loadSettings(); }
export function saveKvSettings(s) {
  mkdirSync(KV_DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  _settingsCache = null;   // invalidate
}

function svcSettings(svc) {
  const s = loadSettings();
  const per = (s.perService && s.perService[svc.id]) || {};
  const enabled = per.enabled != null ? !!per.enabled : !!s.defaultEnabled;
  return { enabled, config: per.config || {} };
}

/** llama.cpp service with its per-service KV toggle ON. Default OFF ⇒ unchanged behavior. */
export function isKvEligible(svc) {
  if (!svc || svc.providerId !== LLAMA_PROVIDER) return false;
  if (!svc.containerIp || !svc.port) return false;
  return svcSettings(svc).enabled;
}

// ── launch-command introspection over SSH (once per service) ──
async function readLaunchCommand(svc) {
  const remote =
    `for p in $(pgrep -f llama-server); do c=$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null); ` +
    `case "$c" in *"--port ${svc.port} "*|*"--port ${svc.port}") echo "$c"; break;; esac; done`;
  const { stdout } = await execFileAsync(
    'ssh',
    ['-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', `root@${svc.containerIp}`, remote],
    { timeout: 12_000, maxBuffer: 4 << 20 }
  );
  return (stdout || '').trim();
}

function extractSlotSavePath(cmd) {
  const m = String(cmd).match(/--slot-save-path[ =]+"?([^"\s]+)"?/);
  return m ? m[1] : null;
}

// SSH `rm -f` of snapshot .bin files on the llama host (bytes never transit the proxy).
async function deleteFiles(host, paths) {
  if (!paths || !paths.length) return;
  const CHUNK = 200;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const batch = paths.slice(i, i + CHUNK);
    await execFileAsync('ssh',
      ['-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', `root@${host}`, 'rm', '-f', ...batch],
      { timeout: 30_000 });
  }
}

// ── caches: orchestrator per instance (svc.id); index shared per fingerprint ──
const _orchBySvc = new Map();   // svc.id → Promise<KvOrchestrator>
const _indexByFp = new Map();   // fp     → KvIndex (one DatabaseSync handle, shared)

function getIndexForFp(fp) {
  let idx = _indexByFp.get(fp);
  if (!idx) {
    mkdirSync(KV_DATA_DIR, { recursive: true });
    idx = new KvIndex(join(KV_DATA_DIR, `${fp}.db`));
    _indexByFp.set(fp, idx);
  }
  return idx;
}

// One reaper per fingerprint (fps are 1:1 with a shared Optane dir). Multiple instances of
// the same fp refresh the ctx (host/savePath/budget) but reuse the single timer.
const _reaperByFp = new Map();   // fp → { ctx, timer }
function startReaperForFp(fp, ctx) {
  const existing = _reaperByFp.get(fp);
  if (existing) { Object.assign(existing.ctx, ctx); return; }
  const entry = { ctx, timer: null };
  const run = () => reapFp({
    index: getIndexForFp(fp), fp, host: entry.ctx.host, savePath: entry.ctx.savePath,
    budgetBytes: entry.ctx.budgetBytes, initialBudgetFraction: entry.ctx.initialBudgetFraction,
    currentVersion: STATE_SEQ_VERSION,
    deleteFiles, log: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
  }).catch((e) => console.warn(`[kv reaper] run error fp=${fp}: ${e?.message || e}`));
  entry.timer = setInterval(run, Math.max(30, entry.ctx.intervalSec) * 1000);
  if (entry.timer.unref) entry.timer.unref();
  _reaperByFp.set(fp, entry);
}

/** Force an immediate reaper sweep for a fingerprint (UI "reap now"). */
export async function reapNow(fp) {
  const e = _reaperByFp.get(fp);
  if (!e) return { error: 'no reaper for fp' };
  return reapFp({
    index: getIndexForFp(fp), fp, host: e.ctx.host, savePath: e.ctx.savePath,
    budgetBytes: e.ctx.budgetBytes, initialBudgetFraction: e.ctx.initialBudgetFraction,
    currentVersion: STATE_SEQ_VERSION,
    deleteFiles, log: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
  });
}

/**
 * Get (or lazily build) the orchestrator for a llama service. Cached per svc.id; the build
 * reads the launch command (fingerprint + physical save-path) and the live slot layout.
 * Throws on setup failure — callers should treat that as "KV unavailable, forward normally".
 */
export function getOrchestrator(svc) {
  const cached = _orchBySvc.get(svc.id);
  if (cached) return cached;
  const ready = (async () => {
    const cmd = await readLaunchCommand(svc);
    if (!cmd) throw new Error(`no launch command for ${svc.id}`);
    const fpInfo = computeKvFingerprint(cmd);
    const savePath = extractSlotSavePath(cmd);
    const up = new Upstream(`http://${svc.containerIp}:${svc.port}`);

    // Authoritative slot layout from /slots (falls back to svc.slots).
    let slotIds = [];
    let slotNCtx = Infinity;
    try {
      const slots = await up.slotList();
      slotIds = slots.map((s) => s.id);
      const ctxs = slots.map((s) => s.n_ctx).filter((n) => Number.isFinite(n));
      if (ctxs.length) slotNCtx = Math.min(...ctxs);
    } catch { /* fall back below */ }
    if (!slotIds.length) slotIds = Array.from({ length: svc.slots || 1 }, (_, i) => i);

    const { config } = svcSettings(svc);
    const orch = new KvOrchestrator({
      upstream: up, index: getIndexForFp(fpInfo.fp), fp: fpInfo.fp, slotName: fpInfo.slotName,
      stateSeqVersion: fpInfo.stateSeqVersion, slotIds, slotNCtx, config,
      log: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
    });
    orch.savePath = savePath;        // physical --slot-save-path dir (reaper, step 5)
    orch.svcId = svc.id;
    orch.startSweeper();
    startReaperForFp(fpInfo.fp, {
      host: svc.containerIp, savePath,
      budgetBytes: orch.cfg.optaneBudgetBytes, initialBudgetFraction: orch.cfg.initialBudgetFraction,
      intervalSec: orch.cfg.reaperIntervalSec,
    });
    console.log(`[kv] orchestrator ready svc=${svc.id} fp=${fpInfo.fp} slots=[${slotIds}] nctx=${slotNCtx} save=${savePath}`);
    // Cold-start seeder (2a): pre-warm slots from Optane initial prefixes. No-op unless deferToLlama.
    orch.seedColdStart().catch((e) => console.warn(`[kv] cold-seed error svc=${svc.id}: ${e?.message || e}`));
    return orch;
  })();
  _orchBySvc.set(svc.id, ready);
  ready.catch((e) => { console.warn(`[kv] setup failed for ${svc.id}: ${e?.message || e}`); _orchBySvc.delete(svc.id); });
  return ready;
}

/** Drop a cached orchestrator (call on service restart / param change). */
export function resetOrchestratorCache(svcId) {
  if (svcId) _orchBySvc.delete(svcId);
  else _orchBySvc.clear();
}

/** Per-fingerprint Optane pool stats (bytes/count vs budget) for the metrics panel. */
export function getKvIndexStats() {
  const out = {};
  for (const [fp, idx] of _indexByFp) {
    const st = idx.stats(fp);
    const r = _reaperByFp.get(fp);
    out[fp] = {
      bytes: st.b, count: st.n,
      byKind: st.byKind,
      budgetBytes: r?.ctx?.budgetBytes ?? null,
      initialBudgetFraction: r?.ctx?.initialBudgetFraction ?? null,
      host: r?.ctx?.host ?? null,
      savePath: r?.ctx?.savePath ?? null,
    };
  }
  return out;
}

/** Snapshot of all live orchestrators' stats (metrics tab, step 6). */
export async function getAllKvStats() {
  const out = {};
  for (const [id, ready] of _orchBySvc) {
    try { out[id] = (await ready).getStats(); } catch { out[id] = { error: true }; }
  }
  return out;
}
