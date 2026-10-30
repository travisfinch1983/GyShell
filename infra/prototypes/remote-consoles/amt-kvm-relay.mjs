// Prototype: browser (noVNC over WebSocket) <-> Intel AMT KVM redirection (TCP 16994).
// The relay performs AMT's redirection handshake + digest auth server-side, then pipes the
// raw RFB stream, so AMT credentials never reach the browser. Protocol per MeshCommander
// amt-redir-ws-0.1.0.js (Apache-2.0).
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 18990);
const AMT_HOST = process.env.AMT_HOST || '127.0.0.1';
const AMT_PORT = Number(process.env.AMT_PORT || 16994);
const AMT_USER = process.env.AMT_USER || 'admin';
const AMT_PASS = process.env.AMT_PASS;
const STATIC = path.join(path.dirname(new URL(import.meta.url).pathname), 'novnc/package');
const AUTH_URI = '/RedirectionService';
const DISPLAY_NAME = process.env.DISPLAY_NAME || 'Intel AMT console';

const md5 = (s) => crypto.createHash('md5').update(s, 'latin1').digest('hex');
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const lstr = (s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s, 'latin1')]);

// Connect to AMT and complete the redirection handshake. Resolves with { sock, rest }
// where rest is any RFB bytes that arrived with the final handshake message.
function amtKvmConnect(log) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(AMT_PORT, AMT_HOST);
    let acc = Buffer.alloc(0);
    let done = false;
    const fail = (msg) => { if (!done) { done = true; sock.destroy(); reject(new Error(msg)); } };
    sock.setTimeout(15000, () => fail('AMT handshake timeout'));
    sock.on('error', (e) => fail('AMT socket: ' + e.message));
    sock.on('connect', () => sock.write(Buffer.from([0x10, 0x01, 0, 0, 0x4b, 0x56, 0x4d, 0x52]))); // StartRedirectionSession KVMR
    const onData = (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      for (;;) {
        if (acc.length < 1) return;
        const cmd = acc[0];
        let size = 0;
        if (cmd === 0x11) { // StartRedirectionSessionReply
          if (acc.length < 13) return;
          if (acc[1] !== 0) return fail('StartRedirectionSession refused, status ' + acc[1]);
          size = 13 + acc[12];
          if (acc.length < size) return;
          sock.write(Buffer.from([0x13, 0, 0, 0, 0, 0, 0, 0, 0])); // query auth methods
        } else if (cmd === 0x14) { // AuthenticateSessionReply
          if (acc.length < 9) return;
          const len = acc.readUInt32LE(5);
          size = 9 + len;
          if (acc.length < size) return;
          const status = acc[1], authType = acc[4], data = acc.subarray(9, size);
          if (authType === 0) {
            if (!data.includes(4)) return fail('AMT offers no digest auth: ' + [...data]);
            const body = Buffer.concat([lstr(AMT_USER), Buffer.from([0, 0]), lstr(AUTH_URI), Buffer.from([0, 0, 0, 0])]);
            sock.write(Buffer.concat([Buffer.from([0x13, 0, 0, 0, 4]), u32(body.length), body]));
          } else if ((authType === 3 || authType === 4) && status === 1) {
            let p = 0;
            const take = () => { const n = data[p]; const s = data.subarray(p + 1, p + 1 + n).toString('latin1'); p += n + 1; return s; };
            const realm = take(), nonce = take();
            const qop = authType === 4 ? take() : null;
            const cnonce = crypto.randomBytes(16).toString('hex'), nc = '00000002';
            const extra = authType === 4 ? `${nc}:${cnonce}:${qop}:` : '';
            const digest = md5(`${md5(`${AMT_USER}:${realm}:${AMT_PASS}`)}:${nonce}:${extra}${md5('POST:' + AUTH_URI)}`);
            const parts = [lstr(AMT_USER), lstr(realm), lstr(nonce), lstr(AUTH_URI), lstr(cnonce), lstr(nc), lstr(digest)];
            if (authType === 4) parts.push(lstr(qop));
            const body = Buffer.concat(parts);
            sock.write(Buffer.concat([Buffer.from([0x13, 0, 0, 0, authType]), u32(body.length), body]));
          } else if (status === 0) {
            log('AMT auth OK');
            sock.write(Buffer.from([0x40, 0, 0, 0, 0, 0, 0, 0])); // start KVM data channel
          } else {
            return fail(`AMT auth failed (status ${status}, type ${authType})`);
          }
        } else if (cmd === 0x41) { // KVM channel open; everything after these 8 bytes is RFB
          if (acc.length < 8) return;
          done = true;
          sock.setTimeout(0);
          sock.removeListener('data', onData);
          return resolve({ sock, rest: acc.subarray(8) });
        } else if (cmd === 0xf0) { // session is being recorded (informational)
          size = 1;
        } else {
          return fail('Unknown AMT redirection command 0x' + cmd.toString(16));
        }
        acc = acc.subarray(size);
      }
    };
    sock.on('data', onData);
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/console.html';
  const here = path.dirname(new URL(import.meta.url).pathname);
  const file = p === '/console.html' ? path.join(here, 'console.html') : path.join(STATIC, path.normalize(p));
  if (p !== '/console.html' && !file.startsWith(STATIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const wss = new WebSocketServer({ server, path: '/kvm' });
// ---- RFB translation -------------------------------------------------------------------
// AMT announces "RFB 004.000", which makes noVNC fall back to an 8-bit mode AMT renders badly.
// So the relay presents itself as a plain RFB 3.8 server, keeps AMT on its native RGB565,
// asks only for Raw (+DesktopSize), and expands each Raw rectangle to 32 bpp in the pixel
// format the browser asked for.
function makeTranslator(log, sendToBrowser, sendToAmt) {
  // server -> browser
  let sAcc = Buffer.alloc(0), sStage = 'version', rects = 0;
  let src = { bpp: 16, rmax: 31, gmax: 63, bmax: 31, rsh: 11, gsh: 5, bsh: 0, be: false };
  let dst = { rsh: 0, gsh: 8, bsh: 16 }; // noVNC default; replaced by its SetPixelFormat
  let lut = null;
  const buildLut = () => {
    lut = new Uint32Array(65536);
    for (let p = 0; p < 65536; p++) {
      const r = (p >> src.rsh) & src.rmax, g = (p >> src.gsh) & src.gmax, b = (p >> src.bsh) & src.bmax;
      const r8 = Math.round(r * 255 / src.rmax), g8 = Math.round(g * 255 / src.gmax), b8 = Math.round(b * 255 / src.bmax);
      lut[p] = ((r8 << dst.rsh) | (g8 << dst.gsh) | (b8 << dst.bsh)) >>> 0;
    }
  };
  buildLut();
  const convert = (px) => { // RGB565 little-endian -> 32 bpp little-endian
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
        src = { bpp: pf[0], be: !!pf[2], rmax: pf.readUInt16BE(4), gmax: pf.readUInt16BE(6), bmax: pf.readUInt16BE(8), rsh: pf[10], gsh: pf[11], bsh: pf[12] };
        if (src.bpp !== 16 || src.be) throw new Error('unexpected AMT pixel format ' + JSON.stringify(src));
        buildLut();
        const amtName = sAcc.subarray(24, 24 + nl).toString();
        // Advertise 32 bpp depth 24, and rename the desktop: noVNC forces its 8-bit mode when it
        // sees the literal name "Intel(r) AMT KVM", which this relay makes unnecessary.
        const name = Buffer.from(DISPLAY_NAME);
        const init = Buffer.concat([sAcc.subarray(0, 20), Buffer.alloc(4), name]);
        Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
        init.writeUInt32BE(name.length, 20);
        log(`AMT screen ${init.readUInt16BE(0)}x${init.readUInt16BE(2)} "${amtName}" -> "${DISPLAY_NAME}"`);
        out.push(init); sAcc = sAcc.subarray(24 + nl); sStage = 'msg'; continue;
      }
      if (sStage === 'msg') {
        if (sAcc.length < 1) break;
        const t = sAcc[0];
        if (t === 0) { if (sAcc.length < 4) break; rects = sAcc.readUInt16BE(2); out.push(sAcc.subarray(0, 4)); sAcc = sAcc.subarray(4); sStage = rects ? 'recthdr' : 'msg'; continue; }
        if (t === 2) { out.push(sAcc.subarray(0, 1)); sAcc = sAcc.subarray(1); continue; }
        if (t === 3) { if (sAcc.length < 8) break; const n = 8 + sAcc.readUInt32BE(4); if (sAcc.length < n) break; out.push(sAcc.subarray(0, n)); sAcc = sAcc.subarray(n); continue; }
        if (t === 1) { if (sAcc.length < 6) break; const n = 6 + 6 * sAcc.readUInt16BE(4); if (sAcc.length < n) break; out.push(sAcc.subarray(0, n)); sAcc = sAcc.subarray(n); continue; }
        throw new Error('unknown AMT server message type ' + t);
      }
      if (sStage === 'recthdr') {
        if (sAcc.length < 12) break;
        const w = sAcc.readUInt16BE(4), h = sAcc.readUInt16BE(6), enc = sAcc.readInt32BE(8);
        if (enc === 0) { const need = 12 + w * h * 2; if (sAcc.length < need) break; out.push(sAcc.subarray(0, 12)); out.push(convert(sAcc.subarray(12, need))); sAcc = sAcc.subarray(need); }
        else if (enc === -223) { out.push(sAcc.subarray(0, 12)); sAcc = sAcc.subarray(12); log(`desktop size ${w}x${h}`); }
        else throw new Error('AMT sent unrequested encoding ' + enc);
        if (--rects === 0) sStage = 'msg';
        continue;
      }
    }
    if (out.length) sendToBrowser(Buffer.concat(out));
    if (sAcc.length) sAcc = Buffer.from(sAcc); // detach from large chunk buffers
  };

  // browser -> server
  let cAcc = Buffer.alloc(0), cStage = 'version';
  const fromBrowser = (chunk) => {
    cAcc = cAcc.length ? Buffer.concat([cAcc, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (cStage === 'version') { if (cAcc.length < 12) break; out.push(Buffer.from('RFB 003.008\n')); cAcc = cAcc.subarray(12); cStage = 'sectype'; continue; }
      if (cStage === 'sectype') { if (cAcc.length < 1) break; out.push(cAcc.subarray(0, 1)); cAcc = cAcc.subarray(1); cStage = 'clientinit'; continue; }
      if (cStage === 'clientinit') { if (cAcc.length < 1) break; out.push(cAcc.subarray(0, 1)); cAcc = cAcc.subarray(1); cStage = 'msg'; continue; }
      if (cAcc.length < 1) break;
      const t = cAcc[0];
      if (t === 0) { // SetPixelFormat: honour it locally, AMT stays on RGB565
        if (cAcc.length < 20) break;
        const pf = cAcc.subarray(4, 20);
        if (pf[0] !== 32 || !pf[3]) throw new Error('browser asked for unsupported pixel format bpp=' + pf[0]);
        dst = { rsh: pf[10], gsh: pf[11], bsh: pf[12] }; buildLut();
        cAcc = cAcc.subarray(20); continue;
      }
      if (t === 2) { // SetEncodings -> Raw + DesktopSize only
        if (cAcc.length < 4) break; const n = 4 + 4 * cAcc.readUInt16BE(2); if (cAcc.length < n) break;
        out.push(Buffer.from([2, 0, 0, 2, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x21])); cAcc = cAcc.subarray(n); continue;
      }
      const fixed = { 3: 10, 4: 8, 5: 6 }[t];
      if (fixed) { if (cAcc.length < fixed) break; out.push(cAcc.subarray(0, fixed)); cAcc = cAcc.subarray(fixed); continue; }
      if (t === 6) { if (cAcc.length < 8) break; const n = 8 + cAcc.readUInt32BE(4); if (cAcc.length < n) break; out.push(cAcc.subarray(0, n)); cAcc = cAcc.subarray(n); continue; }
      throw new Error('unknown browser message type ' + t);
    }
    if (out.length) sendToAmt(Buffer.concat(out));
    if (cAcc.length) cAcc = Buffer.from(cAcc);
  };
  return { fromAmt, fromBrowser };
}

wss.on('connection', async (ws, req) => {
  const id = crypto.randomBytes(3).toString('hex');
  const log = (m) => console.log(new Date().toISOString(), `[${id}]`, m);
  log('browser connected from ' + req.socket.remoteAddress);
  // Queue browser bytes that arrive while the AMT handshake is still running.
  const early = [];
  const earlyHandler = (d) => early.push(Buffer.from(d));
  ws.on('message', earlyHandler);
  let sock, rest;
  try {
    ({ sock, rest } = await amtKvmConnect(log));
  } catch (e) {
    log('connect failed: ' + e.message);
    return ws.close(1011, e.message.slice(0, 120));
  }
  let up = 0, down = 0, closed = false;
  const end = (why) => { if (closed) return; closed = true; log(`closed (${why}) up=${up}B down=${down}B`); try { sock.destroy(); } catch {} try { ws.close(); } catch {} };
  const tr = makeTranslator(log, (b) => { down += b.length; if (ws.readyState === 1) ws.send(b); }, (b) => { up += b.length; sock.write(b); });
  const guard = (fn) => (d) => { try { fn(Buffer.from(d)); } catch (e) { end('protocol: ' + e.message); } };
  ws.off('message', earlyHandler);
  const onBrowser = guard(tr.fromBrowser), onAmt = guard(tr.fromAmt);
  ws.on('message', onBrowser);
  sock.on('data', onAmt);
  if (rest.length) onAmt(rest);
  for (const d of early) onBrowser(d);
  sock.on('close', () => end('amt'));
  sock.on('error', (e) => end('amt error ' + e.message));
  ws.on('close', () => end('browser'));
});

if (!AMT_PASS) { console.error('AMT_PASS not set'); process.exit(1); }
server.listen(PORT, () => console.log(`amt-kvm-relay on :${PORT} -> ${AMT_HOST}:${AMT_PORT}`));
