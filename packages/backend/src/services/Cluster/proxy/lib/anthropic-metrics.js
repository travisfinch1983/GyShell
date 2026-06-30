/**
 * anthropic-metrics.js — push-based usage/perf metrics for the Claude Max proxy.
 *
 * Unlike the LLM metrics poller (which PULLS Prometheus from local services), the
 * Claude proxy has no scrapeable backend — we're a passthrough to api.anthropic.com.
 * So we RECORD on each proxied request from the response `usage` block + wall-clock
 * timing: token counts, prompt-cache creation/read (1h vs 5m), latency, and — for
 * streaming requests — TTFT and decode tok/s (observed end-to-end through the proxy).
 *
 * Per-model cumulative aggregates persist to anthropic-metrics.json (survives restart);
 * a small in-memory ring of recent requests is kept for a live feed (not persisted).
 *
 * @module lib/anthropic-metrics
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const DATA_DIR = process.env.AILAB_PROXY_DATA_DIR || join(process.cwd(), 'data');
const FILE = join(DATA_DIR, 'anthropic-metrics.json');
const STORE_VERSION = 1;
const RECENT_CAP = 200;

function blankRow(model) {
  return {
    model, requests: 0, errors: 0,
    cum_promptTokens: 0, cum_genTokens: 0,
    cum_cacheCreate: 0, cum_cacheCreate1h: 0, cum_cacheCreate5m: 0, cum_cacheRead: 0,
    cum_retries: 0,
    latencySumMs: 0, latencyCount: 0,
    ttftSumMs: 0, ttftCount: 0,
    decodeTpsSum: 0, decodeTpsCount: 0,
    lastTtftMs: null, lastDecodeTps: null,
    firstSeen: Date.now(), lastSeen: Date.now(),
  };
}

class AnthropicMetrics {
  constructor() {
    this.rows = new Map();   // model -> aggregate row
    this.recent = [];        // ring of recent request summaries (in-memory only)
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      const d = JSON.parse(readFileSync(FILE, 'utf8'));
      if (d && Array.isArray(d.rows)) for (const r of d.rows) if (r && r.model) this.rows.set(r.model, r);
    } catch { /* no prior file */ }
  }

  _save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        mkdirSync(dirname(FILE), { recursive: true });
        writeFileSync(FILE, JSON.stringify({ version: STORE_VERSION, rows: [...this.rows.values()] }));
      } catch { /* best-effort */ }
    }, 2000);
    this._saveTimer.unref?.();
  }

  _row(model) {
    const k = model || 'unknown';
    let r = this.rows.get(k);
    if (!r) { r = blankRow(k); this.rows.set(k, r); }
    return r;
  }

  /** A transient upstream throttle was retried — attribute it to the model. */
  recordRetry(model) {
    this._row(model).cum_retries++;
    this._save();
  }

  /** Record one completed (or failed) proxied request. */
  record(ev) {
    const r = this._row(ev.model);
    r.requests++;
    if (!ev.ok) r.errors++;
    r.cum_promptTokens += ev.inputTokens || 0;
    r.cum_genTokens += ev.outputTokens || 0;
    r.cum_cacheCreate += ev.cacheCreate || 0;
    r.cum_cacheCreate1h += ev.cacheCreate1h || 0;
    r.cum_cacheCreate5m += ev.cacheCreate5m || 0;
    r.cum_cacheRead += ev.cacheRead || 0;
    if (ev.latencyMs != null) { r.latencySumMs += ev.latencyMs; r.latencyCount++; }
    if (ev.ttftMs != null) { r.ttftSumMs += ev.ttftMs; r.ttftCount++; r.lastTtftMs = ev.ttftMs; }
    if (ev.decodeTps != null) { r.decodeTpsSum += ev.decodeTps; r.decodeTpsCount++; r.lastDecodeTps = ev.decodeTps; }
    r.lastSeen = Date.now();

    this.recent.push({
      t: Date.now(), model: r.model, endpoint: ev.endpoint, stream: !!ev.stream,
      ok: !!ev.ok, status: ev.status ?? null,
      in: ev.inputTokens || 0, out: ev.outputTokens || 0,
      cacheRead: ev.cacheRead || 0, cacheCreate: ev.cacheCreate || 0,
      latencyMs: ev.latencyMs ?? null, ttftMs: ev.ttftMs ?? null, decodeTps: ev.decodeTps ?? null,
    });
    if (this.recent.length > RECENT_CAP) this.recent.shift();
    this._save();
  }

  /** Computed view for the dashboard. */
  snapshot() {
    const rows = [...this.rows.values()].map((r) => {
      const totalIn = (r.cum_promptTokens || 0) + (r.cum_cacheCreate || 0) + (r.cum_cacheRead || 0);
      return {
        ...r,
        avgLatencyMs: r.latencyCount ? r.latencySumMs / r.latencyCount : null,
        avgTtftMs: r.ttftCount ? r.ttftSumMs / r.ttftCount : null,
        avgDecodeTps: r.decodeTpsCount ? r.decodeTpsSum / r.decodeTpsCount : null,
        cacheReadPct: totalIn ? r.cum_cacheRead / totalIn : 0,
        totalInputTokens: totalIn,
      };
    }).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return { rows, recent: this.recent.slice(-50).reverse(), generatedAt: Date.now() };
  }

  reset(model) {
    if (model) this.rows.delete(model);
    else { this.rows.clear(); this.recent = []; }
    this._save();
    return true;
  }
}

export const anthropicMetrics = new AnthropicMetrics();

// ── streaming meter: accumulate usage + token timing from SSE events ──
export function newMeter(model) {
  return { model, inTok: 0, outTok: 0, cCreate: 0, cCreate1h: 0, cCreate5m: 0, cRead: 0, tFirst: null, tLast: null };
}
export function meterEvent(m, ev) {
  if (!ev || !ev.type) return;
  if (ev.type === 'message_start') {
    const u = ev.message?.usage || {};
    if (u.input_tokens != null) m.inTok = u.input_tokens;
    if (u.cache_creation_input_tokens != null) m.cCreate = u.cache_creation_input_tokens;
    if (u.cache_read_input_tokens != null) m.cRead = u.cache_read_input_tokens;
    const cc = u.cache_creation;
    if (cc) { m.cCreate1h = cc.ephemeral_1h_input_tokens || 0; m.cCreate5m = cc.ephemeral_5m_input_tokens || 0; }
    if (ev.message?.model) m.model = ev.message.model;
  } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
    const now = Date.now();
    if (m.tFirst == null) m.tFirst = now;
    m.tLast = now;
  } else if (ev.type === 'message_delta') {
    const u = ev.usage || {};
    if (u.output_tokens != null) m.outTok = u.output_tokens;
  }
}
export function finalizeStreamRecord(m, startMs, endpoint, ok, status) {
  const ttftMs = m.tFirst ? (m.tFirst - startMs) : null;
  const decodeTps = (m.tFirst && m.tLast && m.tLast > m.tFirst && m.outTok)
    ? m.outTok / ((m.tLast - m.tFirst) / 1000) : null;
  return {
    model: m.model, endpoint, stream: true, ok, status,
    inputTokens: m.inTok, outputTokens: m.outTok,
    cacheCreate: m.cCreate, cacheCreate1h: m.cCreate1h, cacheCreate5m: m.cCreate5m, cacheRead: m.cRead,
    latencyMs: Date.now() - startMs, ttftMs, decodeTps,
  };
}

// usage block (non-streaming response) -> record event fields
export function usageToRecord(usage, { model, endpoint, ok, status, latencyMs }) {
  const u = usage || {};
  const cc = u.cache_creation || {};
  return {
    model, endpoint, stream: false, ok, status,
    inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
    cacheCreate1h: cc.ephemeral_1h_input_tokens || 0,
    cacheCreate5m: cc.ephemeral_5m_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    latencyMs, ttftMs: null, decodeTps: null,
  };
}
