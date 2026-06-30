/**
 * anthropic-capture.js — opt-in request capture + diff for debugging prompt-cache misses.
 *
 * When a client (some chat UIs) injects per-send dynamic content (a timestamp, a token
 * counter, reordered history) into the prompt PREFIX, every turn becomes a cache miss
 * even in a continuing conversation. To find exactly where, enable capture, send two
 * consecutive messages, and GET /debug/diff — it reports the first character at which the
 * two upstream prefixes diverge, with a context window from each.
 *
 * OFF by default. Captures live in memory only (never persisted), capped to a small ring,
 * and auto-disable after an idle window so full prompt text isn't retained indefinitely.
 *
 * @module lib/anthropic-capture
 */
import crypto from 'node:crypto';

const sha8 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

/** Flatten a prepared Anthropic body into the canonical prefix string Anthropic caches against. */
function canon(body) {
  const parts = [];
  const sys = body?.system;
  if (typeof sys === 'string') parts.push('SYSTEM: ' + sys);
  else if (Array.isArray(sys)) sys.forEach((b, i) => parts.push(`SYSTEM[${i}]: ` + (b?.text ?? JSON.stringify(b))));
  for (const [i, m] of (body?.messages || []).entries()) {
    const c = m?.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.map((b) => (b?.text ?? (b?.type === 'tool_result' ? `[tool_result ${b.tool_use_id}] ` + (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) : JSON.stringify(b)))).join('')
      : JSON.stringify(c);
    parts.push(`MSG[${i}] ${m?.role}: ` + text);
  }
  return parts.join('\n');
}

function blockSummary(body) {
  const out = [];
  const sys = body?.system;
  if (typeof sys === 'string') out.push({ label: 'system', len: sys.length, hash: sha8(sys) });
  else if (Array.isArray(sys)) sys.forEach((b, i) => { const t = b?.text ?? JSON.stringify(b); out.push({ label: `system[${i}]`, len: t.length, hash: sha8(t) }); });
  for (const [i, m] of (body?.messages || []).entries()) {
    const c = m?.content;
    const t = typeof c === 'string' ? c : JSON.stringify(c);
    out.push({ label: `msg[${i}]:${m?.role}`, len: t.length, hash: sha8(t) });
  }
  return out;
}

class AnthropicCapture {
  constructor() {
    this.enabled = false;
    this.max = 8;
    this.ring = [];
    this._offTimer = null;
  }

  setEnabled(on, max) {
    this.enabled = !!on;
    if (max) this.max = Math.max(2, Math.min(50, max | 0));
    if (this._offTimer) { clearTimeout(this._offTimer); this._offTimer = null; }
    if (this.enabled) {
      // auto-disable after 30 min idle so we don't retain prompt text forever
      this._offTimer = setTimeout(() => { this.enabled = false; this.ring = []; }, 30 * 60 * 1000);
      this._offTimer.unref?.();
    } else {
      this.ring = [];
    }
    return this.state();
  }

  record(body, endpoint) {
    if (!this.enabled) return;
    const prefix = canon(body);
    this.ring.push({ t: Date.now(), endpoint, model: body?.model, len: prefix.length, prefix, blocks: blockSummary(body) });
    while (this.ring.length > this.max) this.ring.shift();
  }

  state() { return { enabled: this.enabled, max: this.max, captured: this.ring.length }; }

  list(full = false) {
    return {
      ...this.state(),
      captures: this.ring.map((c, i) => ({
        index: i, t: c.t, endpoint: c.endpoint, model: c.model, prefixLen: c.len, blocks: c.blocks,
        ...(full ? { prefix: c.prefix } : {}),
      })),
    };
  }

  /** Diff two captures (default: the two most recent) and locate the first divergence. */
  diff(aIdx, bIdx) {
    const n = this.ring.length;
    if (n < 2) return { error: 'need at least 2 captures', captured: n };
    const a = this.ring[aIdx != null ? aIdx : n - 2];
    const b = this.ring[bIdx != null ? bIdx : n - 1];
    if (!a || !b) return { error: 'invalid capture index', captured: n };

    // block-level summary
    const blocks = [];
    const maxB = Math.max(a.blocks.length, b.blocks.length);
    for (let i = 0; i < maxB; i++) {
      const ba = a.blocks[i], bb = b.blocks[i];
      blocks.push({
        label: bb?.label || ba?.label,
        changed: !ba || !bb || ba.hash !== bb.hash || ba.len !== bb.len,
        a: ba ? { len: ba.len, hash: ba.hash } : null,
        b: bb ? { len: bb.len, hash: bb.hash } : null,
      });
    }

    // first character divergence in the full canonical prefix
    const pa = a.prefix, pb = b.prefix;
    let i = 0;
    const lim = Math.min(pa.length, pb.length);
    while (i < lim && pa[i] === pb[i]) i++;
    const identical = i === pa.length && pa.length === pb.length;
    const win = 70;
    return {
      identical,
      lenA: pa.length, lenB: pb.length,
      firstDivergenceAt: identical ? null : i,
      contextA: identical ? null : pa.slice(Math.max(0, i - win), i + win),
      contextB: identical ? null : pb.slice(Math.max(0, i - win), i + win),
      blocks,
    };
  }
}

export const anthropicCapture = new AnthropicCapture();
