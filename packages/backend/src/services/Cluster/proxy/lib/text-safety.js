// Text safety for anything crossing a serialisation boundary into a vector store.
//
// UNPAIRED UTF-16 SURROGATES are the one thing that passes every JS-side check and then fails at a
// stricter consumer. JSON.stringify does not throw on them (ES2019 well-formed stringify escapes
// them to \udXXX), and JSON.parse accepts the result back — so nothing in Node objects. But
// qdrant's serde parser and chromadb REJECT a lone \udXXX escape ("lone leading surrogate in hex
// escape"), while weaviate accepts it. A batch containing one is therefore stored by some backends
// and silently dropped by others, which is how three stores holding the same collection came to
// disagree by thousands of points (2026-09-16).
//
// They arise two ways: a source file genuinely containing one, or — far more often — truncating at
// a fixed length and cutting a pair in half, because JS string indices are UTF-16 CODE UNITS.
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Strip UNPAIRED surrogates only. Intact pairs survive — stripping indiscriminately would
 *  quietly corrupt every emoji and supplementary-plane character in the corpus. */
export const stripLoneSurrogates = (text) => String(text ?? '').replace(LONE_SURROGATE, '');

/** Truncate FIRST, then strip: truncation is what creates the dangling half. */
export const embedSafeText = (text, max = 5000) => stripLoneSurrogates(String(text ?? '').slice(0, max));

/**
 * JSON.stringify with every string value sanitised, enforced AT THE BOUNDARY.
 *
 * Four separate raw-text sites were found in one file over one day. That was not four mistakes —
 * it was one invariant enforced at producers instead of where stringify actually happens. A
 * replacer makes a fifth site structurally impossible: it covers every field (ids, paths, arbitrary
 * caller metadata), not just the ones someone remembered, and every caller including ones added
 * later that nobody will think to audit.
 *
 * ⚠ It sanitises IDS too. That is wanted — an id with a lone surrogate fails identically. But note
 * the one way it could bite: ids here are `${collection}::${filePath}::${chunkIndex}`, so a lone
 * surrogate in a FILE PATH yields a stored id that differs from the id a later run computes from a
 * repaired path, orphaning that point instead of overwriting it. Vanishingly unlikely, and strictly
 * better than the write failing outright — but it is the failure mode to suspect if a point ever
 * appears to duplicate rather than update.
 */
export const safeStringify = (obj) =>
  JSON.stringify(obj, (_k, v) => (typeof v === 'string' ? stripLoneSurrogates(v) : v));
