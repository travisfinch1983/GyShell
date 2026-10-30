// Remote consoles — see the KVM screen of a machine (and power it) from inside AI-Lab.
//
//   Intel AMT       our own relay: AMT redirection (TCP 16994, digest auth) → RFB translation → noVNC in the page.
//   Supermicro/AMI  auto-login reverse proxy of the BMC's OWN HTML5 iKVM viewer (skips the slow dashboard).
//
// BMC/AMT passwords are read from the credential vault server-side and never reach the browser.
// Proven by hand first: infra/prototypes/remote-consoles/README.md (traps live there too).
// NOTE: like the rest of AI-Lab this has no app-level auth — whoever can reach :17889/:17890 can use it.
import express, { Router } from 'express';
import net from 'node:net';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
// Intel AMT's RLE (encoding 16) tiles ride one zlib stream per session; pako (vendored with noVNC)
// gives a synchronous streaming inflate that keeps the window across tiles.
import { inflateInit2, inflate as pakoInflate } from '../../../../vendor/novnc-1.7.0/vendor/pako/lib/zlib/inflate.js';
import ZStream from '../../../../vendor/novnc-1.7.0/vendor/pako/lib/zlib/zstream.js';

const DATA_DIR = process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data';
const TARGETS_FILE = path.join(DATA_DIR, 'consoles.json');
const CREDS_FILE = path.join(DATA_DIR, 'credentials.json');
const NOVNC_DIR = fileURLToPath(new URL('../../../../vendor/novnc-1.7.0', import.meta.url));
const log = (...a) => console.log('[consoles]', ...a);

// kind: amt | supermicro (X11, /cgi/login.cgi) | supermicro-redfish (H12/X12+, one-time Redfish IKVM URI) | megarac (AMI SP-X)
const DEFAULT_TARGETS = [
  { id: 'esp32-net', name: 'esp32-net (trailer)', kind: 'amt', host: '10.50.0.6', credId: 'cred-0881b9af', user: 'admin' },
  { id: 'px-epyc', name: 'px-epyc', kind: 'supermicro-redfish', host: '10.0.20.10', credId: 'cred-d74574cc' },
  { id: 'px-gpu', name: 'px-gpu', kind: 'megarac', host: '10.0.20.20', credId: 'cred-d74574cc' },
  { id: 'px-nas', name: 'px-nas', kind: 'supermicro', host: '10.0.20.30', credId: 'cred-d74574cc' },
  { id: 'px-gateway', name: 'px-gateway', kind: 'supermicro', host: '10.0.20.40', credId: 'cred-d74574cc' },
];

function loadTargets() {
  try {
    const t = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'));
    if (Array.isArray(t)) return t;
  } catch (e) {
    if (e.code !== 'ENOENT') log('consoles.json unreadable, using defaults:', e.message);
  }
  try { fs.writeFileSync(TARGETS_FILE, JSON.stringify(DEFAULT_TARGETS, null, 2)); log('seeded', TARGETS_FILE); }
  catch (e) { log('could not seed consoles.json:', e.message); }
  return DEFAULT_TARGETS;
}
const findTarget = (id) => loadTargets().find((t) => t.id === id) || null;

function credsFor(t) {
  const all = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  const list = Array.isArray(all) ? all : all.entries || []; // credentials.json = { version, entries: [...] }
  const c = list.find((x) => x && x.id === t.credId);
  if (!c || !c.password) throw new Error(`credential ${t.credId} for ${t.id} not found`);
  return { user: t.user || c.username, pass: c.password };
}

const insecure = new https.Agent({ rejectUnauthorized: false, keepAlive: true }); // BMC/AMT certs are self-signed
function bmcRequest(host, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port: 443, method, path: p, headers, agent: insecure, timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('BMC request timeout')));
    req.on('error', reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

// ---- BMC sessions ------------------------------------------------------------------------------------
const sessions = new Map(); // id -> { sid, csrf, loginP }
function sessionOf(t) { if (!sessions.has(t.id)) sessions.set(t.id, { sid: null, csrf: null, loginP: null }); return sessions.get(t.id); }

async function bmcLogin(t, st) {
  const { user, pass } = credsFor(t);
  if (t.kind === 'supermicro-redfish') {
    const body = Buffer.from(JSON.stringify({ UserName: user, Password: pass }));
    const { res } = await bmcRequest(t.host, 'POST', '/redfish/v1/SessionService/Sessions', { 'Content-Type': 'application/json', 'Content-Length': body.length }, body);
    if (!res.headers['x-auth-token']) throw new Error(`Redfish login failed (HTTP ${res.statusCode})`);
    st.sid = res.headers['x-auth-token'];
  } else if (t.kind === 'megarac') {
    const body = Buffer.from(`username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`);
    const { res, body: rb } = await bmcRequest(t.host, 'POST', '/api/session', { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length }, body);
    const c = (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).filter((x) => /^QSESSIONID=.+/.test(x)).pop();
    let j = {}; try { j = JSON.parse(rb.toString()); } catch { /* not JSON = failed */ }
    if (!c || !j.CSRFToken) throw new Error(`BMC login failed (HTTP ${res.statusCode})`);
    st.sid = c.slice('QSESSIONID='.length); st.csrf = j.CSRFToken;
  } else {
    const body = Buffer.from(`name=${encodeURIComponent(user)}&pwd=${encodeURIComponent(pass)}`);
    const { res } = await bmcRequest(t.host, 'POST', '/cgi/login.cgi', { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length }, body);
    // The BMC clears SID first (empty value) and then sets the real one — take the last non-empty.
    const sids = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).filter((c) => /^SID=.+/.test(c));
    if (!sids.length) throw new Error(`BMC login failed (HTTP ${res.statusCode}, no SID cookie)`);
    st.sid = sids[sids.length - 1].slice(4);
  }
  log(`logged in to ${t.id} (${t.kind})`);
}
async function ensureLogin(t) {
  const st = sessionOf(t);
  if (st.sid) return st;
  st.loginP ||= bmcLogin(t, st).finally(() => { st.loginP = null; });
  await st.loginP;
  return st;
}
function authHeaders(t, st) {
  if (t.kind === 'supermicro-redfish') return { 'x-auth-token': st.sid };
  if (t.kind === 'megarac') return { cookie: `QSESSIONID=${st.sid}`, 'x-csrftoken': st.csrf };
  return { cookie: `SID=${st.sid}` };
}
const looksLoggedOut = (res, body, ctype) => res.statusCode === 401
  || (/html/.test(ctype) && /login\.cgi|sessionTimeout\s*\(|name="pwd"/.test(body.subarray(0, 6000).toString('latin1')));

// Injected into every proxied BMC page: send the viewer's absolute-path XHR/fetch/WebSocket traffic back
// through this proxy instead of AI-Lab's own /api, and keep its "top.location = logout" from leaving AI-Lab.
function shimScript(id) {
  return `<script>(function(){var P='/api/consoles/${id}/bmc',W='/api/consoles/${id}/ws';
function fix(u){try{var x=new URL(u,location.href);if(x.host!==location.host||x.pathname.indexOf('/api/consoles/')===0)return u;return P+x.pathname+x.search+x.hash}catch(e){return u}}
var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fix(String(u));return o.apply(this,arguments)};
if(window.fetch){var f=window.fetch;window.fetch=function(i,n){return f.call(this,typeof i==='string'?fix(i):i,n)}}
var WS=window.WebSocket;function S(u,p){var x=new URL(u,location.href);if(x.host===location.host&&x.pathname.indexOf('/api/consoles/')!==0)x.pathname=W+(x.pathname==='/'?'':x.pathname);x.protocol=location.protocol==='https:'?'wss:':'ws:';return p===undefined?new WS(x.toString()):new WS(x.toString(),p)}
S.prototype=WS.prototype;S.CONNECTING=0;S.OPEN=1;S.CLOSING=2;S.CLOSED=3;window.WebSocket=S;
document.addEventListener('mousedown',function(){try{window.focus()}catch(e){}},true);
// Switching machines tears this frame down; end the KVM session cleanly first, or AMI MegaRAC keeps the master
// slot reserved for a "reconnect" and every later session comes up view-only (partial access).
window.addEventListener('pagehide',function(){try{if(window._video&&window._video.stop)window._video.stop()}catch(e){}});})();</script>`;
}

// The MegaRAC viewer expects sessionStorage the main UI fills at login (CSRF "garc", feature list, KVM rights).
async function megaracSeed(t, st) {
  const proj = await bmcRequest(t.host, 'GET', '/api/configuration/project', authHeaders(t, st), null);
  const seed = {
    garc: st.csrf, features: proj.body.toString(), username: credsFor(t).user, privilege_id: '4', privilege: 'Administrator',
    extended_privilege: '259', session_id: '', kvm_access: '1', vmedia_access: '1', id: '2', since: String(Math.floor(Date.now() / 1000)),
  };
  return `<script>(function(){var s=${JSON.stringify(seed)};for(var k in s)sessionStorage.setItem(k,s[k]);})();</script>`;
}

async function proxyBmc(t, req, res) {
  const prefix = `/api/consoles/${t.id}/bmc`;
  const bmcPath = req.originalUrl.slice(prefix.length) || '/';
  if (/\/cgi\/(login|logout)\.cgi|^\/api\/session/.test(bmcPath) && req.method !== 'GET') {
    res.status(403).end('blocked by the AI-Lab console proxy'); return;
  }
  const body = Buffer.isBuffer(req.body) ? req.body : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const st = await ensureLogin(t);
    const headers = { ...req.headers };
    for (const h of ['host', 'cookie', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port']) delete headers[h];
    Object.assign(headers, authHeaders(t, st), { host: t.host, referer: `https://${t.host}/`, 'accept-encoding': 'gzip, deflate' });
    if (/^\/(viewer\.html|cgi\/url_redirect\.cgi|redfish\/.*\.IKVM)/.test(bmcPath)) { delete headers['if-none-match']; delete headers['if-modified-since']; }
    if (body) headers['content-length'] = body.length;
    const r = await bmcRequest(t.host, req.method, bmcPath, headers, body);
    const h = { ...r.res.headers };
    let out = r.body;
    const ctype = String(h['content-type'] || '');
    const rewrite = /text\/html|text\/css/.test(ctype) || /\.(html|css)(\?|$)/.test(bmcPath);
    if (rewrite && h['content-encoding'] === 'gzip') { out = zlib.gunzipSync(out); delete h['content-encoding']; }
    else if (rewrite && h['content-encoding'] === 'deflate') { out = zlib.inflateSync(out); delete h['content-encoding']; }
    if (attempt === 0 && (r.res.statusCode === 401 || (rewrite && looksLoggedOut(r.res, out, ctype)))) { log(`${t.id}: session expired, logging in again`); sessionOf(t).sid = null; continue; }
    for (const k of ['set-cookie', 'content-length', 'transfer-encoding', 'x-frame-options', 'content-security-policy', 'strict-transport-security', 'connection', 'keep-alive']) delete h[k];
    if (h.location) h.location = String(h.location).replace(new RegExp(`^https?://${t.host.replace(/\./g, '\\.')}(:443)?`), '').replace(/^\/(?!\/)/, `${prefix}/`);
    if (rewrite) {
      let s = out.toString('latin1');
      if (/html/.test(ctype) || /\.html(\?|$)/.test(bmcPath)) {
        s = s.replace(/(\s(?:src|href|action)\s*=\s*["'])\/(?!\/)/gi, `$1${prefix}/`);
        let inject = shimScript(t.id);
        if (t.kind === 'megarac' && /^\/viewer\.html/.test(bmcPath)) inject += await megaracSeed(t, st);
        s = /<head[^>]*>/i.test(s) ? s.replace(/<head[^>]*>/i, (m) => m + inject) : inject + s;
        h['cache-control'] = 'no-store'; delete h.etag; delete h['last-modified'];
      }
      s = s.replace(/url\(\s*(['"]?)\/(?!\/)/gi, `url($1${prefix}/`);
      out = Buffer.from(s, 'latin1');
    }
    res.writeHead(r.res.statusCode, h);
    res.end(out);
    return;
  }
}

async function redfishIkvmUri(t) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const st = await ensureLogin(t);
    const r = await bmcRequest(t.host, 'GET', '/redfish/v1/Managers/1/Oem/Supermicro/IKVM', authHeaders(t, st), null);
    if (r.res.statusCode === 401) { st.sid = null; continue; }
    const uri = JSON.parse(r.body.toString()).URI;
    if (!uri) throw new Error('BMC returned no IKVM URI');
    return uri;
  }
  throw new Error('Redfish IKVM launch failed');
}

// ---- Intel AMT: redirection handshake + RFB translation ------------------------------------------------
const md5 = (s) => crypto.createHash('md5').update(s, 'latin1').digest('hex');
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const lstr = (s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s, 'latin1')]);
const AMT_AUTH_URI = '/RedirectionService';

// Resolves { sock, rest } once AMT has opened the KVM channel; `rest` = RFB bytes that came with the last message.
function amtKvmConnect(t, note) {
  const { user, pass } = credsFor(t);
  return new Promise((resolve, reject) => {
    const sock = net.connect(t.port || 16994, t.host);
    let acc = Buffer.alloc(0), done = false;
    const fail = (msg) => { if (!done) { done = true; sock.destroy(); reject(new Error(msg)); } };
    sock.setTimeout(15000, () => fail('AMT handshake timeout'));
    sock.on('error', (e) => fail('AMT socket: ' + e.message));
    sock.on('close', () => fail('AMT closed the connection during the handshake (it refuses a new session for ~45 s after the last one)'));
    sock.on('connect', () => sock.write(Buffer.from([0x10, 0x01, 0, 0, 0x4b, 0x56, 0x4d, 0x52]))); // StartRedirectionSession "KVMR"
    const onData = (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      for (;;) {
        if (!acc.length) return;
        const cmd = acc[0];
        let size = 0;
        if (cmd === 0x11) {
          if (acc.length < 13) return;
          if (acc[1] !== 0) return fail('AMT refused the KVM session, status ' + acc[1]);
          size = 13 + acc[12]; if (acc.length < size) return;
          sock.write(Buffer.from([0x13, 0, 0, 0, 0, 0, 0, 0, 0])); // query auth methods
        } else if (cmd === 0x14) {
          if (acc.length < 9) return;
          size = 9 + acc.readUInt32LE(5); if (acc.length < size) return;
          const status = acc[1], authType = acc[4], data = acc.subarray(9, size);
          if (authType === 0) {
            if (!data.includes(4)) return fail('AMT offers no digest auth');
            const b = Buffer.concat([lstr(user), Buffer.from([0, 0]), lstr(AMT_AUTH_URI), Buffer.from([0, 0, 0, 0])]);
            sock.write(Buffer.concat([Buffer.from([0x13, 0, 0, 0, 4]), u32le(b.length), b]));
          } else if ((authType === 3 || authType === 4) && status === 1) {
            let p = 0;
            const take = () => { const n = data[p]; const s = data.subarray(p + 1, p + 1 + n).toString('latin1'); p += n + 1; return s; };
            const realm = take(), nonce = take(), qop = authType === 4 ? take() : null;
            const cnonce = crypto.randomBytes(16).toString('hex'), nc = '00000002';
            const extra = authType === 4 ? `${nc}:${cnonce}:${qop}:` : '';
            const digest = md5(`${md5(`${user}:${realm}:${pass}`)}:${nonce}:${extra}${md5('POST:' + AMT_AUTH_URI)}`);
            const parts = [lstr(user), lstr(realm), lstr(nonce), lstr(AMT_AUTH_URI), lstr(cnonce), lstr(nc), lstr(digest)];
            if (authType === 4) parts.push(lstr(qop));
            const b = Buffer.concat(parts);
            sock.write(Buffer.concat([Buffer.from([0x13, 0, 0, 0, authType]), u32le(b.length), b]));
          } else if (status === 0) {
            sock.write(Buffer.from([0x40, 0, 0, 0, 0, 0, 0, 0])); // open the KVM data channel
          } else {
            return fail(`AMT authentication failed (status ${status})`);
          }
        } else if (cmd === 0x41) {
          if (acc.length < 8) return;
          done = true; sock.setTimeout(0); sock.removeListener('data', onData); sock.removeAllListeners('close');
          note('AMT KVM channel open');
          return resolve({ sock, rest: acc.subarray(8) });
        } else if (cmd === 0xf0) {
          size = 1; // session is being recorded (informational)
        } else {
          return fail('unknown AMT redirection command 0x' + cmd.toString(16));
        }
        acc = acc.subarray(size);
      }
    };
    sock.on('data', onData);
  });
}

// AMT announces "RFB 004.000" + desktop "Intel(r) AMT KVM", which makes noVNC fall back to an 8-bit mode AMT
// renders badly. Present a plain RFB 3.8 server instead: keep AMT on native RGB565, ask only for Raw +
// DesktopSize, and expand each Raw rectangle to the 32 bpp format the browser asked for.
function makeRfbTranslator(t, note, toBrowser, toAmt) {
  let sAcc = Buffer.alloc(0), sStage = 'version', rects = 0;
  let src = { rmax: 31, gmax: 63, bmax: 31, rsh: 11, gsh: 5, bsh: 0 };
  let dst = { rsh: 0, gsh: 8, bsh: 16 };
  let lut;
  const buildLut = () => {
    lut = new Uint32Array(65536);
    for (let p = 0; p < 65536; p++) {
      const r = (p >> src.rsh) & src.rmax, g = (p >> src.gsh) & src.gmax, b = (p >> src.bsh) & src.bmax;
      lut[p] = ((Math.round(r * 255 / src.rmax) << dst.rsh) | (Math.round(g * 255 / src.gmax) << dst.gsh) | (Math.round(b * 255 / src.bmax) << dst.bsh)) >>> 0;
    }
  };
  buildLut();
  const inflateTile = makeTileInflater();
  const toRgbx = (pix) => { const out = Buffer.allocUnsafe(pix.length * 4); for (let i = 0; i < pix.length; i++) out.writeUInt32LE(lut[pix[i]], 4 * i); return out; };
  const convert = (px) => {
    const n = px.length >> 1, out = Buffer.allocUnsafe(n * 4);
    for (let i = 0; i < n; i++) out.writeUInt32LE(lut[px[2 * i] | (px[2 * i + 1] << 8)], 4 * i);
    return out;
  };
  const fromAmt = (chunk) => {
    sAcc = sAcc.length ? Buffer.concat([sAcc, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (sStage === 'version') { if (sAcc.length < 12) break; out.push(Buffer.from('RFB 003.008\n')); sAcc = sAcc.subarray(12); sStage = 'sectypes'; continue; }
      if (sStage === 'sectypes') { if (sAcc.length < 1 || sAcc.length < 1 + sAcc[0]) break; const n = 1 + sAcc[0]; out.push(sAcc.subarray(0, n)); sAcc = sAcc.subarray(n); sStage = 'secresult'; continue; }
      if (sStage === 'secresult') { if (sAcc.length < 4) break; out.push(sAcc.subarray(0, 4)); sAcc = sAcc.subarray(4); sStage = 'serverinit'; continue; }
      if (sStage === 'serverinit') {
        if (sAcc.length < 24) break; const nl = sAcc.readUInt32BE(20); if (sAcc.length < 24 + nl) break;
        const pf = sAcc.subarray(4, 20);
        if (pf[0] !== 16 || pf[2]) throw new Error(`unexpected AMT pixel format bpp=${pf[0]} be=${pf[2]}`);
        src = { rmax: pf.readUInt16BE(4), gmax: pf.readUInt16BE(6), bmax: pf.readUInt16BE(8), rsh: pf[10], gsh: pf[11], bsh: pf[12] };
        buildLut();
        const name = Buffer.from(t.name || t.id);
        const init = Buffer.concat([sAcc.subarray(0, 20), Buffer.alloc(4), name]);
        Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
        init.writeUInt32BE(name.length, 20);
        note(`screen ${init.readUInt16BE(0)}x${init.readUInt16BE(2)}`);
        out.push(init); sAcc = sAcc.subarray(24 + nl); sStage = 'msg'; continue;
      }
      if (sStage === 'msg') {
        if (!sAcc.length) break;
        const ty = sAcc[0];
        if (ty === 0) { if (sAcc.length < 4) break; rects = sAcc.readUInt16BE(2); out.push(sAcc.subarray(0, 4)); sAcc = sAcc.subarray(4); sStage = rects ? 'rect' : 'msg'; continue; }
        if (ty === 2) { out.push(sAcc.subarray(0, 1)); sAcc = sAcc.subarray(1); continue; }
        if (ty === 3) { if (sAcc.length < 8) break; const n = 8 + sAcc.readUInt32BE(4); if (sAcc.length < n) break; out.push(sAcc.subarray(0, n)); sAcc = sAcc.subarray(n); continue; }
        if (ty === 1) { if (sAcc.length < 6) break; const n = 6 + 6 * sAcc.readUInt16BE(4); if (sAcc.length < n) break; out.push(sAcc.subarray(0, n)); sAcc = sAcc.subarray(n); continue; }
        throw new Error('unknown AMT server message type ' + ty);
      }
      if (sStage === 'rect') {
        if (sAcc.length < 12) break;
        const w = sAcc.readUInt16BE(4), h = sAcc.readUInt16BE(6), enc = sAcc.readInt32BE(8);
        if (enc === 0) { const need = 12 + w * h * 2; if (sAcc.length < need) break; out.push(sAcc.subarray(0, 12)); out.push(convert(sAcc.subarray(12, need))); sAcc = sAcc.subarray(need); }
        else if (enc === 16) {
          if (sAcc.length < 16) break;
          const need = 16 + sAcc.readUInt32BE(12); if (sAcc.length < need) break;
          const tile = decodeAmtTile(inflateTile(sAcc.subarray(16, need)), w, h);
          const hdr = Buffer.from(sAcc.subarray(0, 12)); hdr.writeInt32BE(0, 8); // hand the browser plain Raw
          out.push(hdr); out.push(toRgbx(tile)); sAcc = sAcc.subarray(need);
        }
        else if (enc === -223) { out.push(sAcc.subarray(0, 12)); sAcc = sAcc.subarray(12); }
        else throw new Error('AMT sent an encoding that was not requested: ' + enc);
        if (--rects === 0) sStage = 'msg';
        continue;
      }
    }
    if (out.length) toBrowser(Buffer.concat(out));
    if (sAcc.length) sAcc = Buffer.from(sAcc); // detach from the large chunk
  };
  let cAcc = Buffer.alloc(0), cStage = 'version';
  const fromBrowser = (chunk) => {
    cAcc = cAcc.length ? Buffer.concat([cAcc, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (cStage === 'version') { if (cAcc.length < 12) break; out.push(Buffer.from('RFB 003.008\n')); cAcc = cAcc.subarray(12); cStage = 'sectype'; continue; }
      if (cStage === 'sectype') { if (!cAcc.length) break; out.push(cAcc.subarray(0, 1)); cAcc = cAcc.subarray(1); cStage = 'clientinit'; continue; }
      if (cStage === 'clientinit') { if (!cAcc.length) break; out.push(cAcc.subarray(0, 1)); cAcc = cAcc.subarray(1); cStage = 'msg'; continue; }
      if (!cAcc.length) break;
      const ty = cAcc[0];
      if (ty === 0) {
        if (cAcc.length < 20) break;
        const pf = cAcc.subarray(4, 20);
        if (pf[0] !== 32 || !pf[3]) throw new Error('browser asked for an unsupported pixel format bpp=' + pf[0]);
        dst = { rsh: pf[10], gsh: pf[11], bsh: pf[12] }; buildLut();
        cAcc = cAcc.subarray(20); continue;
      }
      if (ty === 2) {
        if (cAcc.length < 4) break; const n = 4 + 4 * cAcc.readUInt16BE(2); if (cAcc.length < n) break;
        // RLE (16) first: a text console compresses ~100x vs Raw, which matters over the trailer's uplink.
        out.push(Buffer.from([2, 0, 0, 3, 0, 0, 0, 16, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x21])); cAcc = cAcc.subarray(n); continue;
      }
      const fixed = { 3: 10, 4: 8, 5: 6 }[ty];
      if (fixed) { if (cAcc.length < fixed) break; out.push(cAcc.subarray(0, fixed)); cAcc = cAcc.subarray(fixed); continue; }
      if (ty === 6) { if (cAcc.length < 8) break; const n = 8 + cAcc.readUInt32BE(4); if (cAcc.length < n) break; out.push(cAcc.subarray(0, n)); cAcc = cAcc.subarray(n); continue; }
      throw new Error('unknown browser message type ' + ty);
    }
    if (out.length) toAmt(Buffer.concat(out));
    if (cAcc.length) cAcc = Buffer.from(cAcc);
  };
  return { fromAmt, fromBrowser };
}

function makeTileInflater() {
  const strm = new ZStream();
  // AMT 15 sends a zlib-WRAPPED stream (first tile starts 78 9c), not raw deflate as MeshCommander's -15 suggests.
  if (inflateInit2(strm, 15) !== 0) throw new Error('inflateInit2 failed');
  const outBuf = new Uint8Array(256 * 1024);
  return (input) => {
    strm.input = input; strm.next_in = 0; strm.avail_in = input.length;
    const parts = [];
    do {
      strm.output = outBuf; strm.next_out = 0; strm.avail_out = outBuf.length;
      const ret = pakoInflate(strm, 2 /* Z_SYNC_FLUSH */);
      if (ret < 0 && ret !== -5 /* Z_BUF_ERROR = no progress possible, fine */) throw new Error(`AMT RLE inflate error ${ret} (len ${input.length}, head ${Buffer.from(input.subarray(0, 12)).toString('hex')})`);
      if (strm.next_out) parts.push(Buffer.from(outBuf.subarray(0, strm.next_out)));
      if (ret === -5) break;
    } while (strm.avail_in > 0 || strm.avail_out === 0);
    return Buffer.concat(parts);
  };
}

// One AMT RLE tile (<= 64x64) of RGB565 pixels -> Uint16Array of w*h pixels.
function decodeAmtTile(d, w, h) {
  const n = w * h, px = new Uint16Array(n);
  let p = 0, i = 0;
  const sub = d[p++];
  const rd16 = () => { const v = d[p] | (d[p + 1] << 8); p += 2; return v; };
  const runLen = () => { let r = 1, b; do { b = d[p++]; r += b; } while (b === 255 && p < d.length); return r; };
  if (sub === 0) { for (; i < n; i++) px[i] = rd16(); }
  else if (sub === 1) { px.fill(rd16()); }
  else if (sub >= 2 && sub <= 16) {
    const pal = []; for (let k = 0; k < sub; k++) pal.push(rd16());
    const br = sub === 2 ? 1 : sub <= 4 ? 2 : 4, bm = (1 << br) - 1;
    while (i < n && p < d.length) { const v = d[p++]; for (let b = 8 - br; b >= 0 && i < n; b -= br) px[i++] = pal[(v >> b) & bm]; }
  } else if (sub === 128) {
    while (i < n && p < d.length) { const c = rd16(); const r = runLen(); px.fill(c, i, Math.min(n, i + r)); i += r; }
  } else if (sub > 129) {
    const pal = []; for (let k = 0; k < sub - 128; k++) pal.push(rd16());
    while (i < n && p < d.length) { const idx = d[p++]; const c = pal[idx & 127]; const r = idx > 127 ? runLen() : 1; px.fill(c, i, Math.min(n, i + r)); i += r; }
  } else {
    throw new Error('unsupported AMT RLE subencoding ' + sub);
  }
  return px;
}

function amtPage(t) {
  const name = String(t.name || t.id).replace(/[<&"]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<style>html,body{margin:0;height:100%;background:#000;color:#ccc;font:12px system-ui,sans-serif}#s{position:absolute;inset:0}
#m{position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:5;background:#222d;padding:5px 12px;border-radius:5px;max-width:80%}</style></head>
<body><div id="m">connecting…</div><div id="s"></div>
<script type="module">
import RFB from '/api/consoles/_novnc/core/rfb.js';
const m = document.getElementById('m');
const rfb = new RFB(document.getElementById('s'), (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/consoles/${t.id}/ws');
rfb.scaleViewport = true;
rfb.addEventListener('connect', () => { m.textContent = 'connected'; setTimeout(() => { m.style.display = 'none'; }, 1500); });
rfb.addEventListener('disconnect', (e) => { m.style.display = ''; m.textContent = e.detail.clean ? 'disconnected — reload to reconnect' : 'connection lost — AMT needs ~45 s between sessions; reload to retry'; });
window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data === 'ctrl-alt-del') rfb.sendCtrlAltDel(); });
</script></body></html>`;
}

// ---- power -------------------------------------------------------------------------------------------
const IPMI_ACTIONS = { status: 'status', on: 'on', off: 'off', soft: 'soft', reset: 'reset', cycle: 'cycle' };
function ipmiPower(t, action) {
  const { user, pass } = credsFor(t);
  return new Promise((resolve, reject) => {
    execFile('ipmitool', ['-I', 'lanplus', '-C', '3', '-H', t.host, '-U', user, '-E', 'chassis', 'power', IPMI_ACTIONS[action]],
      { env: { ...process.env, IPMI_PASSWORD: pass }, timeout: 30000 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));
  });
}

// Minimal WS-Man over HTTP digest for AMT power.
async function amtWsman(t, action, resourceUri, bodyXml, selectors = '') {
  const { user, pass } = credsFor(t);
  const xml = `<?xml version="1.0" encoding="utf-8"?><Envelope xmlns="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"><Header><a:Action>${action}</a:Action><a:To>/wsman</a:To><w:ResourceURI>${resourceUri}</w:ResourceURI><a:MessageID>uuid:${crypto.randomUUID()}</a:MessageID><a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo><w:OperationTimeout>PT60S</w:OperationTimeout>${selectors}</Header><Body>${bodyXml}</Body></Envelope>`;
  const url = `http://${t.host}:16992/wsman`;
  const headers = { 'Content-Type': 'application/soap+xml;charset=UTF-8' };
  const first = await fetch(url, { method: 'POST', headers, body: xml, signal: AbortSignal.timeout(20000) });
  if (first.status !== 401) return { status: first.status, text: await first.text() };
  const chal = first.headers.get('www-authenticate') || '';
  const g = (k) => (chal.match(new RegExp(`${k}="([^"]*)"`)) || [])[1];
  const realm = g('realm'), nonce = g('nonce'), qop = (g('qop') || '').split(',')[0].trim(), opaque = g('opaque');
  const cnonce = crypto.randomBytes(8).toString('hex'), nc = '00000001';
  const ha1 = md5(`${user}:${realm}:${pass}`), ha2 = md5('POST:/wsman');
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  let auth = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="/wsman", response="${response}"`;
  if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) auth += `, opaque="${opaque}"`;
  const second = await fetch(url, { method: 'POST', headers: { ...headers, Authorization: auth }, body: xml, signal: AbortSignal.timeout(20000) });
  return { status: second.status, text: await second.text() };
}
const CIM = 'http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/';
const AMT_POWER_STATE = { on: 2, cycle: 5, off: 8, reset: 10, soft: 12 }; // CIM PowerState values AMT accepts
const AMT_STATE_NAME = { 2: 'on', 3: 'sleep (light)', 4: 'sleep (deep)', 6: 'off (hard)', 7: 'hibernate', 8: 'off (soft)', 9: 'power cycle', 13: 'off' };
async function amtPower(t, action) {
  if (action === 'status') {
    const r = await amtWsman(t, 'http://schemas.xmlsoap.org/ws/2004/09/enumeration/Enumerate', `${CIM}CIM_AssociatedPowerManagementService`, '<Enumerate xmlns="http://schemas.xmlsoap.org/ws/2004/09/enumeration"><w:OptimizeEnumeration/><w:MaxElements>5</w:MaxElements></Enumerate>');
    let text = r.text;
    const ctx = (text.match(/EnumerationContext>([^<]+)</) || [])[1];
    if (!/PowerState>\d+</.test(text) && ctx) { // AMT ignores OptimizeEnumeration — Pull the items
      const p = await amtWsman(t, 'http://schemas.xmlsoap.org/ws/2004/09/enumeration/Pull', `${CIM}CIM_AssociatedPowerManagementService`, `<Pull xmlns="http://schemas.xmlsoap.org/ws/2004/09/enumeration"><EnumerationContext>${ctx}</EnumerationContext><MaxElements>5</MaxElements></Pull>`);
      text = p.text;
    }
    const st = Number((text.match(/PowerState>(\d+)</) || [])[1]);
    if (!st) throw new Error(`AMT power status unreadable (HTTP ${r.status})`);
    return `Chassis Power is ${AMT_STATE_NAME[st] || 'state ' + st}`;
  }
  const ps = AMT_POWER_STATE[action];
  if (!ps) throw new Error('unsupported action ' + action);
  const sel = `<w:SelectorSet><w:Selector Name="CreationClassName">CIM_PowerManagementService</w:Selector><w:Selector Name="Name">Intel(r) AMT Power Management Service</w:Selector><w:Selector Name="SystemCreationClassName">CIM_ComputerSystem</w:Selector><w:Selector Name="SystemName">Intel(r) AMT</w:Selector></w:SelectorSet>`;
  const body = `<h:RequestPowerStateChange_INPUT xmlns:h="${CIM}CIM_PowerManagementService"><h:PowerState>${ps}</h:PowerState><h:ManagedElement><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address><a:ReferenceParameters><w:ResourceURI>${CIM}CIM_ComputerSystem</w:ResourceURI><w:SelectorSet><w:Selector Name="CreationClassName">CIM_ComputerSystem</w:Selector><w:Selector Name="Name">ManagedSystem</w:Selector></w:SelectorSet></a:ReferenceParameters></h:ManagedElement></h:RequestPowerStateChange_INPUT>`;
  const r = await amtWsman(t, `${CIM}CIM_PowerManagementService/RequestPowerStateChange`, `${CIM}CIM_PowerManagementService`, body, sel);
  const rv = (r.text.match(/ReturnValue>(\d+)</) || [])[1];
  if (rv !== '0') throw new Error(`AMT refused the power change (ReturnValue ${rv ?? '?'}, HTTP ${r.status})`);
  return `power ${action} requested`;
}

// ---- router + upgrade ----------------------------------------------------------------------------------
export function createConsolesRouter() {
  const router = Router();
  router.use('/_novnc', express.static(NOVNC_DIR, { fallthrough: false, maxAge: '1d' }));

  router.get('/', (_req, res) => {
    res.json({ consoles: loadTargets().map(({ id, name, kind, host }) => ({ id, name, kind, host })) });
  });

  router.get('/:id/view', async (req, res) => {
    const t = findTarget(req.params.id);
    if (!t) return res.status(404).send('unknown console');
    try {
      const base = `/api/consoles/${t.id}/bmc`;
      if (t.kind === 'amt') return res.type('html').set('cache-control', 'no-store').send(amtPage(t));
      if (t.kind === 'supermicro') return res.redirect(302, `${base}/cgi/url_redirect.cgi?url_name=man_ikvm_html5_bootstrap`);
      if (t.kind === 'megarac') return res.redirect(302, `${base}/viewer.html`);
      if (t.kind === 'supermicro-redfish') return res.redirect(302, base + await redfishIkvmUri(t));
      res.status(400).send('unsupported console kind ' + t.kind);
    } catch (e) {
      log(`${t.id} view failed:`, e.message);
      res.status(502).send(`Could not open the ${t.name} console: ${e.message}`);
    }
  });

  router.all('/:id/bmc/*rest', express.raw({ type: () => true, limit: '20mb' }), async (req, res) => {
    const t = findTarget(req.params.id);
    if (!t || t.kind === 'amt') return res.status(404).end();
    try { await proxyBmc(t, req, res); } catch (e) {
      log(`${t.id} proxy error ${req.method} ${req.originalUrl}:`, e.message);
      if (!res.headersSent) res.status(502).end('console proxy error: ' + e.message); else res.end();
    }
  });

  router.post('/:id/power', express.json(), async (req, res) => {
    const t = findTarget(req.params.id);
    const action = String(req.body?.action || 'status');
    if (!t) return res.status(404).json({ error: 'unknown console' });
    if (!IPMI_ACTIONS[action]) return res.status(400).json({ error: 'unknown action ' + action });
    try {
      const out = t.kind === 'amt' ? await amtPower(t, action) : await ipmiPower(t, action);
      if (action !== 'status') log(`${t.id}: power ${action} -> ${out}`);
      res.json({ ok: true, result: out });
    } catch (e) {
      log(`${t.id}: power ${action} failed:`, e.message);
      res.status(502).json({ ok: false, error: e.message });
    }
  });
  return router;
}

export function attachConsolesUpgrade(server) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: (protos) => [...protos][0] || false });
  server.on('upgrade', (req, socket, head) => {
    const m = (req.url || '').match(/^\/api\/consoles\/([^/?]+)\/ws(\/[^?]*)?(\?.*)?$/);
    if (!m) return; // other listeners own their paths
    const t = findTarget(decodeURIComponent(m[1]));
    if (!t) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const note = (msg) => log(`${t.id} [${req.socket.remoteAddress}] ${msg}`);
      if (t.kind === 'amt') void relayAmt(t, ws, note);
      else void relayBmc(t, ws, (m[2] || '/') + (m[3] || ''), req.headers['sec-websocket-protocol'], note);
    });
  });
}

async function relayAmt(t, ws, note) {
  const early = [];
  const queue = (d) => early.push(Buffer.from(d));
  ws.on('message', queue);
  let sock, rest;
  try { ({ sock, rest } = await amtKvmConnect(t, note)); } catch (e) {
    note('connect failed: ' + e.message);
    try { ws.close(1011, e.message.slice(0, 120)); } catch { /* already gone */ }
    return;
  }
  let closed = false, amtB = 0, webB = 0;
  const end = (why) => { if (closed) return; closed = true; note(`closed: ${why} (from AMT ${amtB}B, to browser ${webB}B)`); try { sock.destroy(); } catch { /* gone */ } try { ws.close(); } catch { /* gone */ } };
  const tr = makeRfbTranslator(t, note, (b) => { webB += b.length; if (ws.readyState === 1) ws.send(b); }, (b) => sock.write(b));
  const guard = (fn) => (d) => { try { fn(Buffer.from(d)); } catch (e) { end('protocol: ' + e.message); } };
  ws.off('message', queue);
  const fromBrowser = guard(tr.fromBrowser), fromAmtRaw = guard(tr.fromAmt);
  const fromAmt = (d) => { amtB += d.length; fromAmtRaw(d); };
  ws.on('message', fromBrowser);
  sock.on('data', fromAmt);
  if (rest.length) fromAmt(rest);
  for (const d of early) fromBrowser(d);
  sock.on('close', () => end('amt'));
  sock.on('error', (e) => end('amt error ' + e.message));
  ws.on('close', () => end('browser'));
}

async function relayBmc(t, ws, upstreamPath, protoHeader, note) {
  const pending = [];
  const queue = (d, isBinary) => pending.push([d, isBinary]);
  ws.on('message', queue);
  let st;
  try { st = await ensureLogin(t); } catch (e) { note('login failed: ' + e.message); ws.close(1011, 'BMC login failed'); return; }
  const protocols = String(protoHeader || '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers = authHeaders(t, st);
  delete headers['x-auth-token'];
  // 🛑 AMI MegaRAC answers 400 to a websocket upgrade without Origin; the ws library drops a plain
  // `origin` header, so it has to go through its `origin` option.
  const up = new WebSocket(`wss://${t.host}${upstreamPath}`, protocols, { rejectUnauthorized: false, perMessageDeflate: false, origin: `https://${t.host}`, headers });
  up.binaryType = 'nodebuffer';
  let closed = false;
  const end = (why) => { if (closed) return; closed = true; note(`closed: ${why} (browser->bmc ${upN} msgs/${upB}B, bmc->browser ${downN} msgs/${downB}B)`); try { ws.close(); } catch { /* gone */ } try { up.close(); } catch { /* gone */ } };
  ws.off('message', queue);
  let upN = 0, upB = 0, downN = 0, downB = 0;
  ws.on('message', (d, isBinary) => {
    upN++; upB += d.length;
    if (process.env.CONSOLES_TRACE && upN <= 400 && !(d.length === 10 && d[0] === 3)) note(`web> ${isBinary ? 'bin' : 'txt'} ${d.length}B ${Buffer.from(d).subarray(0, 24).toString(isBinary ? 'hex' : 'latin1')}`);
    if (up.readyState === 1) up.send(d, { binary: isBinary }); else pending.push([d, isBinary]);
  });
  up.on('open', () => { note('BMC websocket open'); for (const [d, b] of pending) up.send(d, { binary: b }); pending.length = 0; });
  up.on('message', (d, isBinary) => { downN++; downB += d.length; if (ws.readyState === 1) ws.send(d, { binary: isBinary }); });
  up.on('unexpected-response', (_q, r) => end(`BMC refused the websocket (HTTP ${r.statusCode})`));
  up.on('close', (c) => end('bmc ' + c));
  up.on('error', (e) => end('bmc error ' + e.message));
  ws.on('close', () => end('browser'));
}
