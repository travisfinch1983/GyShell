// Re-encode Express 5 wildcard params before they become an outbound request path.
//
// Express DECODES each segment of `{*rest}`, so a client that correctly sent
// /v1/models/(OR)%20deepseek/deepseek-v4-flash arrives here as ['models', '(OR) deepseek', ...].
// Joining that raw and handing it to http.request throws ERR_UNESCAPED_CHARACTERS (a space is
// not legal in a request path) — the caller got a 500 for a valid request, ~41 times per backend
// restart as every agent looked up its "(OR) …" model (maintenance-claude, 2026-10-26).
//
// Each segment is encodeURIComponent'd (so a decoded "/" inside a segment cannot invent a new path
// level), then the RFC 3986 pchar characters encodeURIComponent over-escapes (: @ ! $ & ' ( ) * + , ; =)
// are put back, so every path that worked before — e.g. Qdrant's `points:search` — is byte-identical.
const PCHAR_RESTORE = /%(3A|40|21|24|26|27|28|29|2A|2B|2C|3B|3D)/gi;

export function encodePathSegment(segment) {
  return encodeURIComponent(segment).replace(PCHAR_RESTORE, (m) => decodeURIComponent(m));
}

/**
 * Join Express 5 wildcard params (array of segments) into an outbound-safe path string.
 */
export function joinRestParam(rest) {
  if (rest == null) return rest;
  return (Array.isArray(rest) ? rest : [rest]).map((s) => encodePathSegment(String(s))).join('/');
}
