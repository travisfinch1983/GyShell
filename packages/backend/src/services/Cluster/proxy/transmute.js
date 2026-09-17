/**
 * transmute.js — reverse proxy to the NATIVE Transmute install (file conversion).
 *
 * Transmute (MIT, github.com/transmute-app/transmute) runs as its own systemd
 * service on this container (/opt/transmute, uvicorn on :3313) — installed from
 * source per Travis's no-extra-virtualization preference, NOT docker. This router
 * makes it a first-class AI-Lab surface: /api/transmute/<rest> streams to
 * http://127.0.0.1:3313/api/<rest> with the service API key injected SERVER-SIDE,
 * so the native Files→Convert page never handles auth at all.
 *
 * Streaming both ways (the addons.js pattern): uploads are multipart and outputs
 * can be large — nothing is buffered here.
 *
 * Credentials live in .gybackend-data/transmute.json ({ url, apiKey }), written
 * once at provision time. Re-read on mtime change so a key rotation needs no
 * restart. Also mirrored to the credential vault for Travis.
 */
import { Router } from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CONF_FILE = path.join(process.env.AILAB_PROXY_DATA_DIR || '/opt/ai-lab/.gybackend-data', 'transmute.json');

let _conf = null;
let _confMtime = 0;
function loadConf() {
  try {
    const st = fs.statSync(CONF_FILE);
    if (!_conf || st.mtimeMs !== _confMtime) {
      _conf = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'));
      _confMtime = st.mtimeMs;
    }
  } catch {
    _conf = null;
  }
  return _conf;
}

export function createTransmuteRouter() {
  const router = Router();

  // Lightweight status for the UI + a CAPABILITY WATERMARK for monitoring: the
  // upstream registry silently skips converters whose binaries are missing (no
  // log line, no endpoint — the skip is invisible), so this surfaces the
  // registered set where a watcher can diff it. Installing calibre/drawio later
  // shows up here as new names, not as formats quietly appearing in a dropdown.
  // Never exposes the key.
  router.get('/_status', (_req, res) => {
    const conf = loadConf();
    if (!conf || !conf.url || !conf.apiKey) {
      return res.json({ configured: false, up: false });
    }
    const target = new URL(conf.url);
    const preq = http.request({
      hostname: target.hostname, port: Number(target.port) || 80,
      method: 'GET', path: '/api/converters', timeout: 6000,
      headers: { authorization: `Bearer ${conf.apiKey}` },
    }, (pres) => {
      let buf = '';
      pres.on('data', (c) => { buf += c; });
      pres.on('end', () => {
        if ((pres.statusCode || 500) >= 500) return res.json({ configured: true, up: false });
        try {
          const names = (JSON.parse(buf).converters || []).map((c) => c.name).sort();
          // Expectation, not just fact: converters we installed binaries/patches for.
          // A Transmute update that silently reverts a local patch (drawio -p fix,
          // vtracer addition) surfaces here as missingExpected instead of as a user
          // hitting a conversion that fails with no error. List lives in the config
          // so it updates without a restart.
          const expected = Array.isArray(conf.expectedConverters) ? conf.expectedConverters : [];
          const missingExpected = expected.filter((n) => !names.includes(n));
          res.json({ configured: true, up: true, converters: names.length, converterNames: names, missingExpected });
        } catch {
          // Service answered but not with the converter list — up, capability unknown.
          res.json({ configured: true, up: true, converters: null });
        }
      });
    });
    preq.on('error', () => res.json({ configured: true, up: false }));
    preq.on('timeout', () => { preq.destroy(); });
    preq.end();
  });

  // /api/transmute/<rest> -> <url>/api/<rest>, streamed, bearer injected.
  router.all(/^\/(.*)$/, (req, res) => {
    const conf = loadConf();
    if (!conf || !conf.url || !conf.apiKey) {
      return res.status(503).json({ error: 'transmute is not configured (missing .gybackend-data/transmute.json)' });
    }
    const target = new URL(conf.url);
    const fwd = '/api/' + (req.params[0] || '') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
    const headers = { ...req.headers, host: target.host, authorization: `Bearer ${conf.apiKey}` };
    // The browser never authenticates here; strip anything it might have sent.
    delete headers.cookie;
    const preq = http.request({
      hostname: target.hostname, port: Number(target.port) || 80,
      method: req.method, path: fwd, headers,
      // Conversions can legitimately take a while on big media files.
      timeout: 600000,
    }, (pres) => { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); });
    preq.on('error', (e) => { if (!res.headersSent) res.status(502).json({ error: `transmute unreachable: ${e.message}` }); });
    preq.on('timeout', () => preq.destroy());
    req.pipe(preq);
  });

  return router;
}
