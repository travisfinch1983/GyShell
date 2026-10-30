// Prototype: auto-login reverse proxy for a Supermicro (ATEN) BMC's own HTML5 iKVM viewer.
// The proxy logs in server-side (BMC password never reaches the browser), injects the BMC
// session cookie into every request, and relays the viewer's WebSocket to wss://BMC/.
// Open http://<proxy>:<port>/ to land directly on the iKVM viewer.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT || 18992);
const BMC = process.env.BMC_HOST;
const USER = process.env.BMC_USER || 'tfinch';
const PASS = process.env.BMC_PASS;
const VENDOR = process.env.BMC_VENDOR || 'supermicro'; // supermicro | supermicro-redfish | megarac
const LANDING = { supermicro: '/cgi/url_redirect.cgi?url_name=man_ikvm_html5_bootstrap', megarac: '/viewer.html', 'supermicro-redfish': '/__ikvm' }[VENDOR];
let csrf = null;
const insecure = new https.Agent({ rejectUnauthorized: false, keepAlive: true }); // BMCs use self-signed certs
const log = (m) => console.log(new Date().toISOString(), m);

let sid = null;
let loginP = null;
function bmcRequest(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: BMC, port: 443, method, path, headers, agent: insecure, timeout: 30000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('BMC request timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function login() {
  if (VENDOR === 'supermicro-redfish') {
    const body = JSON.stringify({ UserName: USER, Password: PASS });
    const { res } = await bmcRequest('POST', '/redfish/v1/SessionService/Sessions', { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
    if (!res.headers['x-auth-token']) throw new Error(`BMC Redfish login failed (HTTP ${res.statusCode})`);
    sid = res.headers['x-auth-token'];
    log(`logged in to ${BMC} (${VENDOR})`);
    return;
  }
  if (VENDOR === 'megarac') {
    const form = `username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASS)}`;
    const { res, body } = await bmcRequest('POST', '/api/session', { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, form);
    const c = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).filter((x) => /^QSESSIONID=.+/.test(x)).pop();
    let j = {}; try { j = JSON.parse(body.toString()); } catch {}
    if (!c || !j.CSRFToken) throw new Error(`BMC login failed (HTTP ${res.statusCode})`);
    sid = c.slice('QSESSIONID='.length); csrf = j.CSRFToken;
  } else {
    const form = `name=${encodeURIComponent(USER)}&pwd=${encodeURIComponent(PASS)}`;
    const { res } = await bmcRequest('POST', '/cgi/login.cgi', { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, form);
    // The BMC first clears SID (empty value), then sets the real one — take the last non-empty.
    const sids = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).filter((c) => /^SID=.+/.test(c));
    if (!sids.length) throw new Error(`BMC login failed (HTTP ${res.statusCode}, no SID cookie)`);
    sid = sids[sids.length - 1].slice(4);
  }
  log(`logged in to ${BMC} (${VENDOR})`);
}
const cookieHeader = () => (VENDOR === 'megarac' ? `QSESSIONID=${sid}` : VENDOR === 'supermicro' ? `SID=${sid}` : '');
// Newer Supermicro (H12/X12+) firmware: Redfish hands out a one-time URI that serves the HTML5 iKVM page.
async function redfishIkvmPage() {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!sid) { loginP ||= login().finally(() => { loginP = null; }); await loginP; }
    const r = await bmcRequest('GET', '/redfish/v1/Managers/1/Oem/Supermicro/IKVM', { 'X-Auth-Token': sid }, null);
    if (r.res.statusCode === 401) { sid = null; continue; }
    const uri = JSON.parse(r.body.toString()).URI;
    if (!uri) throw new Error('BMC returned no IKVM URI');
    return bmcRequest('GET', uri, {}, null);
  }
  throw new Error('Redfish IKVM launch failed');
}
const loggedOut = (res, body) => res.statusCode === 401 || (res.headers['content-type'] || '').includes('html') && /cgi\/login|login\.cgi|name="pwd"/.test(body.subarray(0, 4000).toString());

const server = http.createServer(async (req, res) => {
  try {
    let path = req.url;
    if (path === '/') path = LANDING;
    if (VENDOR === 'supermicro-redfish' && path === '/__ikvm') {
      const r = await redfishIkvmPage();
      res.writeHead(r.res.statusCode, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end(r.body);
    }
    if (/login\.cgi|logout|^\/api\/session/.test(path) && req.method !== 'GET') { res.writeHead(403); return res.end('blocked by proxy'); }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!sid) { loginP ||= login().finally(() => { loginP = null; }); await loginP; }
      const headers = { ...req.headers, host: BMC, referer: `https://${BMC}/` };
      if (cookieHeader()) headers.cookie = cookieHeader(); else delete headers.cookie;
      if (VENDOR === 'supermicro-redfish') headers['x-auth-token'] = sid;
      if (csrf) headers['x-csrftoken'] = csrf;
      if (path === LANDING || path.split('?')[0] === '/viewer.html') { delete headers['if-none-match']; delete headers['if-modified-since']; }
      if (body) headers['content-length'] = body.length;
      const r = await bmcRequest(req.method, path, headers, body);
      if (attempt === 0 && loggedOut(r.res, r.body)) { log('session expired, logging in again'); sid = null; continue; }
      const h = { ...r.res.headers }; delete h['set-cookie']; delete h['content-length']; delete h['transfer-encoding'];
      let out = r.body;
      if (VENDOR === 'megarac' && path.split('?')[0] === '/viewer.html' && r.res.statusCode === 200) {
        if (h['content-encoding'] === 'gzip') { out = zlib.gunzipSync(out); delete h['content-encoding']; }
        // The MegaRAC viewer expects sessionStorage the main UI fills at login (CSRF "garc",
        // feature list). Seed it so the viewer can be opened directly.
        const proj = await bmcRequest('GET', '/api/configuration/project', { cookie: cookieHeader(), 'x-csrftoken': csrf }, null);
        const seed = { garc: csrf, features: proj.body.toString(), username: USER, privilege_id: '4', privilege: 'Administrator', extended_privilege: '259', session_id: '', kvm_access: '1', vmedia_access: '1', id: '2', since: String(Math.floor(Date.now() / 1000)) };
        const tag = `<script>(function(){var s=${JSON.stringify(seed)};for(var k in s)sessionStorage.setItem(k,s[k]);})();</script>`;
        out = Buffer.from(out.toString().replace(/<head>/i, '<head>' + tag));
        h['cache-control'] = 'no-store'; delete h['etag']; delete h['last-modified'];
      }
      res.writeHead(r.res.statusCode, h);
      return res.end(out);
    }
  } catch (e) {
    log('proxy error: ' + e.message);
    if (!res.headersSent) res.writeHead(502);
    res.end('BMC proxy error: ' + e.message);
  }
});

// The viewer opens ws://<proxy>:<port>/ (path "") and speaks ATEN RFB; relay it to the BMC.
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  log('viewer websocket from ' + req.socket.remoteAddress + ' path ' + req.url + ' protocols=' + (req.headers['sec-websocket-protocol'] || '-'));
  const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const up = new WebSocket(`wss://${BMC}${req.url}`, protocols, { rejectUnauthorized: false, perMessageDeflate: false, origin: `https://${BMC}`, headers: { ...(cookieHeader() ? { cookie: cookieHeader() } : {}), ...(csrf ? { 'x-csrftoken': csrf } : {}) } });
  up.binaryType = 'nodebuffer';
  const pending = [];
  ws.on('message', (d, isBinary) => (up.readyState === 1 ? up.send(d, { binary: isBinary }) : pending.push([d, isBinary])));
  up.on('open', () => { log('BMC websocket open'); for (const [d, b] of pending) up.send(d, { binary: b }); });
  up.on('message', (d, isBinary) => { if (ws.readyState === 1) ws.send(d, { binary: isBinary }); });
  const end = (why) => { log('websocket closed: ' + why); try { ws.close(); } catch {} try { up.close(); } catch {} };
  up.on('close', (c) => end('bmc ' + c)); up.on('error', (e) => end('bmc error ' + e.message));
  up.on('unexpected-response', (_q, r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => end(`bmc refused upgrade ${r.statusCode}: ${b.slice(0, 200)}`)); });
  ws.on('close', () => end('viewer'));
});

if (!BMC || !PASS) { console.error('BMC_HOST and BMC_PASS required'); process.exit(1); }
server.listen(PORT, () => log(`bmc-proxy on :${PORT} -> https://${BMC}`));
