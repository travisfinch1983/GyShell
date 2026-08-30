/**
 * Page sandbox — the security boundary of the Pages tab.
 *
 * A page is agent-authored content rendered inside a privileged UI, so it gets
 * the SAME trust treatment as fleet-message fencing, with a rendering engine
 * attached. The mitigation is an ORIGIN BOUNDARY, not sanitisation:
 *
 *  - <iframe sandbox="allow-scripts"> WITHOUT allow-same-origin — the document
 *    becomes an opaque origin that cannot touch AI-Lab's DOM, storage, cookies
 *    or same-origin API routes. That one omission is the whole defence; do not
 *    "improve" it by adding allow-same-origin for any feature.
 *  - A CSP baked into the document head with no external hosts — the page
 *    cannot beacon out, pull a remote script, or probe the LAN. Images must be
 *    data:/blob:; styles and scripts must be inline.
 *
 * Verification is adversarial and lives here too: SANDBOX_PROBE_HTML is a page
 * that TRIES to escape (parent DOM, storage, backend API, LAN, external web)
 * and reports each attempt via postMessage. The panel exposes it as a
 * self-test so the boundary is re-checkable after any change, not assumed.
 */

/** The exact sandbox attribute value — scripts yes, same-origin NEVER. */
export const PAGE_SANDBOX = 'allow-scripts'

const CSP =
  "default-src 'none'; " +
  "img-src data: blob:; " +
  "media-src data: blob:; " +
  "style-src 'unsafe-inline'; " +
  "font-src data:; " +
  "script-src 'unsafe-inline'"

/** Minimal readable defaults; pages bring their own styling on top. */
const BASE_CSS = `
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 24px 28px; line-height: 1.6;
    font-family: system-ui, -apple-system, sans-serif;
    background: var(--page-bg); color: var(--page-fg);
    max-width: 900px; margin-inline: auto;
  }
  img { max-width: 100%; }
  pre { overflow-x: auto; padding: 10px 12px; border-radius: 6px; background: rgba(128,128,128,0.12); }
  code { font-family: ui-monospace, monospace; font-size: 0.92em; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid rgba(128,128,128,0.35); padding: 4px 10px; }
  blockquote { border-left: 3px solid rgba(128,128,128,0.4); margin-left: 0; padding-left: 14px; }
`

export function buildPageSrcdoc(html: string, theme: 'light' | 'dark'): string {
  const vars =
    theme === 'dark'
      ? '--page-bg: #16181d; --page-fg: #e6e6e2;'
      : '--page-bg: #ffffff; --page-fg: #1c1c1a;'
  return (
    '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style>:root{${vars}}${BASE_CSS}</style>` +
    '</head><body>' +
    html +
    '</body></html>'
  )
}

/**
 * The escape-attempt page. Every check REPORTS rather than assumes: blocked
 * means the boundary held, reached means it is broken and the tab must not
 * ship. Results arrive as {__pageProbe: {checks: [...], pass: boolean}}.
 */
export const SANDBOX_PROBE_HTML = `
<h1>Sandbox self-test</h1>
<p>This page attempts to escape the sandbox. Every attempt should fail.</p>
<pre id="out">running…</pre>
<script>
(async () => {
  const checks = [];
  const record = (name, escaped, detail) => checks.push({ name, escaped, detail: String(detail).slice(0, 120) });

  try { void parent.document.title; record('parent DOM', true, 'READ PARENT DOCUMENT'); }
  catch (e) { record('parent DOM', false, e.name); }

  try { localStorage.getItem('x'); record('localStorage', true, 'STORAGE ACCESSIBLE'); }
  catch (e) { record('localStorage', false, e.name); }

  try { document.cookie; record('cookies', document.cookie.length > 0, 'len=' + document.cookie.length); }
  catch (e) { record('cookies', false, e.name); }

  try {
    const r = await fetch('/api/cluster/hosts');
    record('backend API', true, 'HTTP ' + r.status);
  } catch (e) { record('backend API', false, e.name); }

  try {
    const r = await fetch('http://10.0.0.161:17900/health');
    record('LAN service', true, 'HTTP ' + r.status);
  } catch (e) { record('LAN service', false, e.name); }

  try {
    const r = await fetch('https://example.com/', { mode: 'no-cors' });
    record('external web', true, 'response received');
  } catch (e) { record('external web', false, e.name); }

  await new Promise((res) => {
    const img = new Image();
    const done = (escaped, detail) => { record('external img beacon', escaped, detail); res(); };
    img.onload = () => done(true, 'IMAGE LOADED');
    img.onerror = () => done(false, 'blocked');
    setTimeout(() => done(false, 'timeout (blocked)'), 3000);
    img.src = 'https://example.com/pixel.png';
  });

  const pass = checks.every((c) => !c.escaped);
  document.getElementById('out').textContent =
    checks.map((c) => (c.escaped ? 'ESCAPED  ' : 'blocked  ') + c.name + '  (' + c.detail + ')').join('\\n') +
    '\\n\\n' + (pass ? 'PASS — boundary held' : 'FAIL — BOUNDARY BROKEN');
  parent.postMessage({ __pageProbe: { checks, pass } }, '*');
})();
</script>
`
