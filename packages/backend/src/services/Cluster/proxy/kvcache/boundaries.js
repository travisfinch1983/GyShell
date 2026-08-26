// ─────────────────────────────────────────────────────────────────────────────
// Boundary computation  (pure — no network)
// ─────────────────────────────────────────────────────────────────────────────
// Faithful port of the shim's chunk_boundary_hashes + prompt extraction, with two
// corrections baked in:
//   • Fable bug (d): the shim hashed a homebrew "<role>…" render, NOT the tokens llama
//     actually processes, so its boundaries drifted from real KV positions. Here the
//     caller feeds us the tokens from llama's own /apply-template → /tokenize pipeline,
//     so a boundary hash lands on a real KV position.
//   • Multimodal option B (plan §4.7): cap the cacheable prefix at the FIRST image so we
//     cache/reuse the pure-text head (system prompt + context) of a vision chat and skip
//     everything from the image on (llama's check_no_mtmd would block saving an
//     image-holding slot anyway).
//
// The boundary hash is salted with the STABLE fingerprint (fpSalt) so two separate
// llama.cpp instances that share a fp compute IDENTICAL boundary hashes for identical
// token prefixes — the mechanism behind the cross-instance shared pool (plan §4a).

import { createHash } from 'crypto';

/**
 * Rolling boundary hashes over a token sequence.
 * Emits [n, hash] at every position where n % chunkSize === 0 (n = 1-based token count).
 * hash = sha256( fpSalt ‖ 0x00 ‖ le32(t0) ‖ le32(t1) ‖ … ‖ le32(t_{n-1}) ).
 * Content-addressed: identical (fp, prefix) ⇒ identical hash ⇒ one index row.
 *
 * @param {number[]} tokens
 * @param {number}   chunkSize   boundary granularity in tokens (DEFAULT_CONFIG.chunkSize)
 * @param {string}   fpSalt      the stable fingerprint (shared-pool key)
 * @returns {Array<[number,string]>}  [(n_tokens, hex), …], ascending
 */
export function chunkBoundaryHashes(tokens, chunkSize, fpSalt) {
  const out = [];
  if (!tokens || tokens.length === 0 || chunkSize <= 0) return out;
  const h = createHash('sha256');
  h.update(Buffer.from(String(fpSalt), 'utf8'));
  h.update(Buffer.from([0]));
  const buf = Buffer.allocUnsafe(4);
  for (let i = 0; i < tokens.length; i++) {
    buf.writeUInt32LE(tokens[i] >>> 0, 0);
    h.update(buf);                       // update() copies bytes synchronously; buf reuse is safe
    const n = i + 1;
    if (n % chunkSize === 0) {
      out.push([n, h.copy().digest('hex')]);   // hash.copy() (Node ≥13.1) snapshots without ending h
    }
  }
  return out;
}

/** True if any message carries image content (content-array with an image part). */
export function hasMultimodalContent(messages) {
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    if (isImageBearing(m)) return true;
  }
  return false;
}

function isImageBearing(m) {
  const c = m && m.content;
  if (!Array.isArray(c)) return false;
  return c.some(isImagePart);
}

function isImagePart(p) {
  if (!p || typeof p !== 'object') return false;
  const t = p.type;
  return t === 'image_url' || t === 'input_image' || t === 'image' || !!p.image_url;
}

/**
 * Multimodal option B: return the messages truncated to the pure-text prefix that precedes
 * the FIRST image. Whole text messages before the first image are kept verbatim; if the
 * first image sits inside a mixed content-array message, the text parts of that message
 * that come BEFORE the image are kept (as a text-only message) and everything from the
 * image on is dropped.
 *
 * @returns {{ messages: any[], capped: boolean }}  capped=true if an image was found & cut
 */
export function capMessagesAtFirstImage(messages) {
  if (!Array.isArray(messages)) return { messages: messages || [], capped: false };
  const kept = [];
  for (const m of messages) {
    if (!isImageBearing(m)) { kept.push(m); continue; }
    // First image is in this message. Keep only the text parts before it.
    const parts = m.content;
    const head = [];
    for (const p of parts) {
      if (isImagePart(p)) break;
      head.push(p);
    }
    if (head.length) {
      const text = head.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
      if (text) kept.push({ role: m.role, content: text });
    }
    return { messages: kept, capped: true };
  }
  return { messages: kept, capped: false };
}
