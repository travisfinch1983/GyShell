// addons.js — runtime addon registry + reverse-proxy. Lets an addon appear as an Addons sub-tab
// with NO AI-Lab rebuild/restart: the addon runs as its own self-contained service (own port, own
// UI) and drops a manifest at <dataDir>/addons/<id>.json. The backend aggregates manifests
// (GET /api/addons), reverse-proxies /addons/<id>/* -> the addon's backend (HTTP + WebSocket), and
// serves /addons/_shared/theme.css so self-served addon UIs match the app's look.
import { Router } from 'express';
import http from 'http';
import net from 'net';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { URL } from 'url';

const ADDONS_DIR = process.env.AILAB_ADDONS_DIR
  || join(process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data', 'addons');
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Read every valid manifest from the addons dir (at call time — new addons need no restart). */
function loadManifests() {
  const out = [];
  try {
    if (!existsSync(ADDONS_DIR)) return out;
    for (const f of readdirSync(ADDONS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(readFileSync(join(ADDONS_DIR, f), 'utf-8'));
        if (!m || !ID_RE.test(m.id || '') || !m.backend) continue;
        out.push({
          id: m.id,
          label: m.label || m.id,
          icon: m.icon || 'blocks',
          backend: String(m.backend).replace(/\/+$/, ''),
          ui: m.ui || '/',
          healthPath: m.healthPath || null,
          enabled: m.enabled !== false,
          order: Number.isFinite(m.order) ? m.order : 100,
        });
      } catch { /* skip malformed manifest */ }
    }
  } catch { /* dir unreadable */ }
  out.sort((a, b) => a.order - b.order || String(a.label).localeCompare(String(b.label)));
  return out;
}
function manifestById(id) {
  return loadManifests().find((m) => m.id === id && m.enabled) || null;
}

// Mirror of the renderer's theme tokens (styles/global.scss) so an iframed addon that <link>s this
// and honors ?theme= matches the app. Dark is the app default; light is provided for when it lands.
const THEME_CSS = `:root{
  --app-bg:#0b0f14;--panel-bg:#0f1620;--panel-bg-2:#0c121a;
  --border:rgba(255,255,255,.08);--border-strong:rgba(255,255,255,.14);
  --fg:rgba(255,255,255,.92);--fg-muted:rgba(255,255,255,.66);--fg-faint:rgba(255,255,255,.46);
  --accent:#4ea1ff;--accent-rgb:78,161,255;--accent-2:#7c5cff;--danger:#ff5c7a;--success:#2ecc71;
  --control-bg:rgba(255,255,255,.06);--control-bg-hover:rgba(255,255,255,.09);--control-bg-active:rgba(255,255,255,.12);
  --shadow:0 10px 30px rgba(0,0,0,.45);
  --font-ui:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace;
}
:root[data-theme="light"]{
  --app-bg:#f6f8fb;--panel-bg:#fff;--panel-bg-2:#f0f3f7;
  --border:rgba(0,0,0,.10);--border-strong:rgba(0,0,0,.16);
  --fg:rgba(0,0,0,.90);--fg-muted:rgba(0,0,0,.62);--fg-faint:rgba(0,0,0,.42);
  --control-bg:rgba(0,0,0,.04);--control-bg-hover:rgba(0,0,0,.07);--control-bg-active:rgba(0,0,0,.10);
  --shadow:0 10px 30px rgba(0,0,0,.12);
}
html,body{background:var(--app-bg);color:var(--fg);font-family:var(--font-ui);margin:0;}
`;

// Full-theme fidelity shim (Claude2): addon iframes are SAME-ORIGIN under the proxy, so mirror EVERY
// live CSS custom property the app sets on the parent <html> (the terminal-scheme-derived tokens:
// --accent/--accent-2/--danger/--success/--warning/… not just dark/light) into the addon's own :root,
// and re-sync on any parent theme switch via MutationObserver. Addons include this with one <script>
// and become fully theme-faithful; theme.css stays as the pre-JS fallback.
const THEME_JS = `(function(){
  var root=document.documentElement;
  function sync(){
    try{
      var p=window.parent.document.documentElement, ps=p.style;
      for(var i=0;i<ps.length;i++){var k=ps[i];if(k.slice(0,2)==='--')root.style.setProperty(k,ps.getPropertyValue(k));}
      var dt=p.getAttribute('data-theme'); if(dt){root.setAttribute('data-theme',dt);} else {root.removeAttribute('data-theme');}
    }catch(e){/* cross-origin/no parent: keep theme.css defaults */}
  }
  sync();
  try{new MutationObserver(sync).observe(window.parent.document.documentElement,{attributes:true,attributeFilter:['style','data-theme','class']});}catch(e){}
  window.addEventListener('pageshow',sync);
})();
`;

/** GET /api/addons -> { addons: [...] } (read at request time; adding a manifest needs no restart). */
export function createAddonsRouter() {
  const router = Router();
  router.get('/', (_req, res) => res.json({ addons: loadManifests() }));
  return router;
}

/** /addons/* — the shared theme + an HTTP reverse-proxy to each addon's own backend (prefix-stripped). */
export function createAddonsProxyRouter() {
  const router = Router();
  router.get('/_shared/theme.css', (_req, res) => {
    res.type('text/css').set('Cache-Control', 'no-cache').send(THEME_CSS);
  });
  router.get('/_shared/theme.js', (_req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-cache').send(THEME_JS);
  });
  // /<id>/<rest...> (+ query) -> <backend>/<rest...>. Streamed (no body buffering) so uploads/downloads pass through.
  router.all(/^\/([a-z0-9][a-z0-9_-]{0,63})(?:\/.*)?$/, (req, res) => {
    const id = req.params[0];
    const m = manifestById(id);
    if (!m) return res.status(404).json({ error: `addon '${id}' not found or disabled` });
    let fwd = req.url.slice(id.length + 1) || '/';
    if (!fwd.startsWith('/')) fwd = '/' + fwd;
    const target = new URL(m.backend);
    const preq = http.request({
      protocol: target.protocol, hostname: target.hostname, port: Number(target.port) || 80,
      method: req.method, path: fwd,
      headers: { ...req.headers, host: target.host },
      timeout: 120000,
    }, (pres) => { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); });
    preq.on('error', (e) => { if (!res.headersSent) res.status(502).json({ error: `addon '${id}' unreachable: ${e.message}` }); });
    preq.on('timeout', () => preq.destroy());
    req.pipe(preq);
  });
  return router;
}

/** Attach the addon WebSocket reverse-proxy to the universal-proxy HTTP server (raw TCP pipe).
 * Coexists with the other upgrade handlers (the native Claude console) — each ignores URLs
 * that are not its prefix. attachClaudeTermUpgrade was removed with ttyd on 2026-09-01. */
export function attachAddonsUpgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    const mm = /^\/addons\/([a-z0-9][a-z0-9_-]{0,63})(\/[^?]*)?/.exec(req.url || '');
    if (!mm) return; // not an addon socket — leave it for other upgrade handlers
    const id = mm[1];
    const m = manifestById(id);
    if (!m) { socket.destroy(); return; }
    let fwd = (req.url || '').slice('/addons/'.length + id.length) || '/';
    if (!fwd.startsWith('/')) fwd = '/' + fwd;
    const target = new URL(m.backend);
    const up = net.connect(Number(target.port) || 80, target.hostname, () => {
      let h = `${req.method} ${fwd} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        h += `${k}: ${k.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}\r\n`;
      }
      h += '\r\n';
      up.write(h);
      if (head && head.length) up.write(head);
      socket.pipe(up); up.pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
}
