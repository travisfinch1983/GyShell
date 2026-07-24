// ─────────────────────────────────────────────────────────────────────────────
// Upstream  — thin HTTP client to a llama-server instance
// ─────────────────────────────────────────────────────────────────────────────
// Faithful port of the shim's Upstream. The proxy already talks to this llama-server for
// the forward; this client covers the KV-specific side calls (tokenize / apply-template /
// slot save|restore|list). The saved KV .bin bytes NEVER transit here — save/restore are
// control calls; llama reads/writes the bytes on its own host Optane (--slot-save-path).
//
// Correctness note (Fable bug d fix): boundaries are computed over the tokens llama
// ACTUALLY processes, so we tokenize the output of /apply-template with add_special +
// parse_special true (special tokens like <|im_start|> collapse to their real ids), rather
// than the shim's homebrew "<role>…" concatenation.

const jsonHeaders = { 'Content-Type': 'application/json' };

export class Upstream {
  /** @param {string} baseUrl  e.g. http://10.0.0.235:5001  @param {object} [opts] */
  constructor(baseUrl, opts = {}) {
    this.base = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 600_000;
    this.apiKey = opts.apiKey || null;
  }

  async _fetch(path, { method = 'GET', body, timeoutMs } = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const headers = { ...jsonHeaders };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
      const res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`upstream ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  /** Apply the model's chat template to messages → the exact prompt string llama processes. */
  async applyTemplate(messages, tools) {
    const body = { messages };
    if (tools && tools.length) body.tools = tools;
    const j = await this._fetch('/apply-template', { method: 'POST', body, timeoutMs: 30_000 });
    return j.prompt ?? '';
  }

  /** Tokenize a raw string as llama processes it (special tokens parsed to their ids). */
  async tokenize(content) {
    const j = await this._fetch('/tokenize', {
      method: 'POST',
      body: { content, add_special: true, parse_special: true },
      timeoutMs: 30_000,
    });
    // /tokenize returns {tokens:[…]} (ints) unless with_pieces; we never ask for pieces.
    return Array.isArray(j.tokens) ? j.tokens.map((t) => (typeof t === 'number' ? t : t.id)) : [];
  }

  /** Full-state save of a slot's KV to `filename` under the instance's --slot-save-path. */
  async slotSave(slotId, filename) {
    return this._fetch(`/slots/${slotId}?action=save`, {
      method: 'POST',
      body: { filename },
      timeoutMs: 120_000,
    });
  }

  /** Restore a saved KV state from `filename` into slot `slotId`. */
  async slotRestore(slotId, filename) {
    return this._fetch(`/slots/${slotId}?action=restore`, {
      method: 'POST',
      body: { filename },
      timeoutMs: 120_000,
    });
  }

  /** Current slot states (id, is_processing, n_prompt_tokens, …). */
  async slotList() {
    return this._fetch('/slots', { method: 'GET', timeoutMs: 10_000 });
  }

  /**
   * Prime a scratch slot to exactly `n` tokens then stop, so its KV holds that exact prefix
   * and can be full-state-saved as an exact-boundary snapshot (scheme B, background worker).
   * Faithful to the shim's /shim/prime path: n_predict:1, cache_prompt:true, temp 0.
   */
  async prime(prompt, slotId, { nPredict = 0 } = {}) {
    // prompt may be a string OR an array of token ids (llama /completion accepts both).
    // n_predict:0 = prefill only, so the slot ends holding EXACTLY the primed tokens (no
    // generated tail) → a full-state save yields an exact-boundary snapshot (n==file_total_n).
    return this._fetch('/completion', {
      method: 'POST',
      body: {
        prompt,
        n_predict: nPredict,
        id_slot: slotId,
        cache_prompt: true,
        stream: false,
        temperature: 0.0,
      },
      timeoutMs: 600_000,
    });
  }
}
