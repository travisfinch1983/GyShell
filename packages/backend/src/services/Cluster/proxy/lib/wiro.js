/**
 * Wiro.ai behind the universal proxy (claude1, 2026-10-10; Travis via claude2).
 *
 * Callers (agents, Builder Studio, tools) use Wiro's image/video models WITHOUT holding the key: the source record
 * (Settings › Cluster › External Services, transport "wiro") carries it and every upstream call gets it added here.
 *
 *   GET  /imagegen/v1/wiro/tools?search=&category=&limit=&start=   catalogue (Tool/List, summary)
 *   GET  /imagegen/v1/wiro/tools/:owner/:project                   parameters + price (Tool/Detail)
 *   POST /imagegen/v1/wiro/run/:owner/:project[?wait=1&timeout=600&fetch=0]
 *        body = JSON, or multipart/form-data (files: inputImage, repeated) - passed through byte for byte.
 *        No wait: {taskid}. wait=1: polls until the task ends and returns outputs; outputs are copied into AI-Lab
 *        (fetch=0 skips that) and served from /imagegen/v1/wiro/files/:taskid/:name.
 *   GET  /imagegen/v1/wiro/task/:id[?fetch=1]                     status/result (Task/Detail)
 *   POST /imagegen/v1/wiro/task/:id/cancel                        Task/Cancel (queued) then Task/Kill (running)
 *   GET  /imagegen/v1/wiro/files/:taskid/:name                    a fetched output file
 *   GET  /imagegen/v1/wiro/usage                                  spend today vs budget + recent tasks
 *
 * Gotchas (claude2's findings): Cloudflare 403s non-browser-ish User-Agents, so a curl UA is sent; Wiro's own output
 * URLs are public-by-link, so we hand back local copies rather than making callers depend on them.
 * Spend: every finished task's totalcost goes to wiro-ledger.jsonl; a run is refused once today's spend (UTC) reaches
 * the source's dailyBudgetUsd (default 25). Agents can spend real money here - the cap is the backstop.
 */
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

const UA = 'curl/8.5.0';
const DONE = new Set(['task_postprocess_end', 'task_cancel']);
const SAFE = /^[A-Za-z0-9._-]{1,200}$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4',
  webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', json: 'application/json', txt: 'text/plain' };

export function createWiroRoutes(router, { loadSources, dataDir, bufferBody, emitNotification }) {
  const filesDir = join(dataDir, 'wiro-files');
  const ledgerFile = join(dataDir, 'wiro-ledger.jsonl');
  mkdirSync(filesDir, { recursive: true });

  const source = () => (loadSources() || []).find((s) => s && s.transport === 'wiro' && s.enabled !== false);
  const base = (s) => String(s.baseUrl || 'https://api.wiro.ai/v1').replace(/\/+$/, '');
  const headers = (s, extra = {}) => ({ 'x-api-key': String(s.apiKey || ''), 'User-Agent': UA, Accept: 'application/json', ...extra });

  async function call(s, path, body, { raw, contentType, timeoutMs = 60000 } = {}) {
    const r = await fetch(`${base(s)}${path}`, {
      method: 'POST',
      headers: headers(s, { 'Content-Type': contentType || 'application/json' }),
      body: raw !== undefined ? raw : JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = null; }
    if (!r.ok || !j) throw Object.assign(new Error(`wiro ${path}: HTTP ${r.status} ${text.slice(0, 300)}`), { status: r.status >= 400 ? r.status : 502 });
    if (j.result === false || (Array.isArray(j.errors) && j.errors.length)) {
      throw Object.assign(new Error(`wiro ${path}: ${JSON.stringify(j.errors || j).slice(0, 400)}`), { status: 400 });
    }
    return j;
  }

  function ledger(entry) {
    try { appendFileSync(ledgerFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
    catch (e) { console.warn(`[wiro] ledger write failed: ${e.message}`); }
  }
  function ledgerRows() {
    try { return existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
    catch (e) { console.warn(`[wiro] ledger unreadable: ${e.message}`); return []; }
  }
  function spentToday() {
    const day = new Date().toISOString().slice(0, 10);
    const seen = new Set();
    let usd = 0;
    for (const r of ledgerRows().reverse()) {          // last record per task wins
      if (!r.taskid || seen.has(r.taskid) || !String(r.at).startsWith(day)) continue;
      seen.add(r.taskid);
      usd += Number(r.totalcost || 0);
    }
    return usd;
  }
  const budget = (s) => Number(s.dailyBudgetUsd ?? 25);

  // Wiro leaves debugerror empty when its safety guard blocks a prompt; the reason is only in debugoutput
  // (e.g. "[BLOCKED] Prompt contains child-related keyword: \"pupils\""). Surface it so callers can rephrase.
  function failureText(t) {
    if (!t.pexit || t.pexit === '0') return null;
    const lines = String(t.debugoutput || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const hit = lines.filter((l) => /block|violation|policy|error|fail/i.test(l));
    return (hit.length ? hit : lines.slice(-3)).join(' | ').slice(0, 500) || null;
  }

  function summarize(t) {
    return {
      taskid: t.id, status: t.status, done: DONE.has(t.status),
      failed: DONE.has(t.status) && (t.status === 'task_cancel' || (t.pexit && t.pexit !== '0') || !!t.debugerror),
      error: t.debugerror || failureText(t), totalcost: Number(t.totalcost || 0), elapsedseconds: Number(t.elapsedseconds || 0),
      outputs: (t.outputs || []).map((o) => ({ name: o.name, contenttype: o.contenttype, size: Number(o.size || 0), url: o.url })),
    };
  }

  async function detail(s, id) {
    const j = await call(s, '/Task/Detail', { taskid: String(id) });
    const t = (j.tasklist || [])[0];
    if (!t) throw Object.assign(new Error(`wiro task ${id} not found`), { status: 404 });
    return t;
  }

  async function fetchOutputs(taskid, outs) {
    const dir = join(filesDir, String(taskid));
    mkdirSync(dir, { recursive: true });
    for (const o of outs) {
      const name = basename(String(o.name || 'output'));
      if (!SAFE.test(name) || !o.url) continue;
      const p = join(dir, name);
      if (!existsSync(p)) {
        const r = await fetch(o.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120000) });
        if (!r.ok) throw new Error(`fetching output ${name}: HTTP ${r.status}`);
        writeFileSync(p, Buffer.from(await r.arrayBuffer()));
      }
      o.local = `/api/proxy/imagegen/v1/wiro/files/${taskid}/${encodeURIComponent(name)}`;
    }
    return outs;
  }

  async function finish(s, taskid, model, caller, fetch_) {
    // A poll from someone else (or without headers) must not re-attribute the task: the submission record knows who ran what.
    const sub = ledgerRows().find((r) => String(r.taskid) === String(taskid) && r.status === 'submitted');
    if (sub) { model = sub.model || model; caller = sub.caller || caller; }
    const t = await detail(s, taskid);
    const r = summarize(t);
    if (r.done) {
      ledger({ taskid, model, caller, status: t.status, totalcost: r.totalcost, elapsedseconds: r.elapsedseconds, failed: r.failed });
      if (r.failed) console.warn(`[wiro] task ${taskid} (${model}) ended ${t.status}: ${r.error || 'no error text'}`);
      if (!r.failed && fetch_ && r.outputs.length) await fetchOutputs(taskid, r.outputs);
    }
    return r;
  }

  const fail = (res, e) => {
    console.warn(`[wiro] ${e.message}`);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  };
  const need = (res) => {
    const s = source();
    if (!s) { res.status(503).json({ ok: false, error: 'no enabled Wiro source (Settings › Cluster › External Services, transport "wiro")' }); return null; }
    if (!s.apiKey) { res.status(503).json({ ok: false, error: 'the Wiro source has no API key' }); return null; }
    return s;
  };
  const callerOf = (req) => String(req.headers['x-ailab-caller'] || req.headers['x-agent-id'] || req.ip || '?').slice(0, 80);

  router.get('/imagegen/v1/wiro/tools', async (req, res) => {
    const s = need(res); if (!s) return;
    try {
      const q = req.query || {};
      const j = await call(s, '/Tool/List', {
        search: q.search || '', categories: q.category ? String(q.category).split(',') : [], tags: [], slugowner: q.owner || '',
        limit: String(Math.min(Number(q.limit || 20), 100)), start: String(Number(q.start || 0)),
        ...(q.sort ? { sort: String(q.sort) } : {}), ...(q.order ? { order: String(q.order) } : {}),
        hideworkflows: true, summary: true,
      });
      res.json({ ok: true, total: Number(j.total || 0), tools: (j.tool || []).map((t) => ({
        owner: t.slugowner, project: t.slugproject, title: t.title, description: t.description, categories: t.categories,
        dynamicprice: t.dynamicprice, cps: t.cps })) });
    } catch (e) { fail(res, e); }
  });

  router.get('/imagegen/v1/wiro/tools/:owner/:project', async (req, res) => {
    const s = need(res); if (!s) return;
    try {
      const j = await call(s, '/Tool/Detail', { slugowner: req.params.owner, slugproject: req.params.project });
      const t = (j.tool || [])[0];
      if (!t) return res.status(404).json({ ok: false, error: 'no such Wiro tool' });
      res.json({ ok: true, owner: t.slugowner, project: t.slugproject, title: t.title, description: t.description,
        parameters: t.parameters, dynamicprice: t.dynamicprice, approximatelycost: t.approximatelycost, cps: t.cps });
    } catch (e) { fail(res, e); }
  });

  router.post('/imagegen/v1/wiro/run/:owner/:project', async (req, res) => {
    const s = need(res); if (!s) return;
    const model = `${req.params.owner}/${req.params.project}`;
    const caller = callerOf(req);
    try {
      const spent = spentToday();
      if (spent >= budget(s)) {
        emitNotification?.('warning', 'wiro', 'Wiro daily budget reached',
          `Refused ${model} for ${caller}: $${spent.toFixed(2)} spent today (UTC) of the $${budget(s)} budget. Raise dailyBudgetUsd on the Wiro source to allow more.`);
        return res.status(402).json({ ok: false, error: `Wiro daily budget reached: $${spent.toFixed(2)} of $${budget(s)} spent today (UTC)` });
      }
      const raw = await bufferBody(req);
      const ct = String(req.headers['content-type'] || 'application/json');
      const j = await call(s, `/Run/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.project)}`, null,
        { raw: raw.length ? raw : Buffer.from('{}'), contentType: ct, timeoutMs: 120000 });
      const taskid = j.taskid;
      ledger({ taskid, model, caller, status: 'submitted', totalcost: 0 });
      console.log(`[wiro] ${caller} ran ${model} -> task ${taskid}`);
      if (!/^(1|true|yes)$/i.test(String(req.query.wait || ''))) return res.status(202).json({ ok: true, taskid, status: `/api/proxy/imagegen/v1/wiro/task/${taskid}` });
      const deadline = Date.now() + Math.min(Number(req.query.timeout || 600), 1800) * 1000;
      const fetch_ = !/^(0|false|no)$/i.test(String(req.query.fetch || ''));
      for (;;) {
        const r = await finish(s, taskid, model, caller, fetch_);
        if (r.done) return res.status(r.failed ? 502 : 200).json({ ok: !r.failed, ...r });
        if (Date.now() > deadline) return res.status(202).json({ ok: true, taskid, pending: true, status: r.status, note: 'still running - poll /task/:id' });
        await new Promise((ok) => setTimeout(ok, 2000));
      }
    } catch (e) { fail(res, e); }
  });

  router.get('/imagegen/v1/wiro/task/:id', async (req, res) => {
    const s = need(res); if (!s) return;
    try {
      const fetch_ = /^(1|true|yes)$/i.test(String(req.query.fetch || ''));
      const r = await finish(s, req.params.id, req.query.model || '?', callerOf(req), fetch_);
      res.json({ ok: true, ...r });
    } catch (e) { fail(res, e); }
  });

  router.post('/imagegen/v1/wiro/task/:id/cancel', async (req, res) => {
    const s = need(res); if (!s) return;
    const out = {};
    for (const op of ['Cancel', 'Kill']) {
      try { await call(s, `/Task/${op}`, { taskid: String(req.params.id) }); out[op.toLowerCase()] = 'ok'; }
      catch (e) { out[op.toLowerCase()] = e.message; }
    }
    res.json({ ok: Object.values(out).includes('ok'), ...out });
  });

  router.get('/imagegen/v1/wiro/files/:taskid/:name', (req, res) => {
    const { taskid, name } = req.params;
    if (!SAFE.test(taskid) || !SAFE.test(name)) return res.status(400).json({ ok: false, error: 'bad path' });
    const p = join(filesDir, taskid, name);
    if (!existsSync(p)) return res.status(404).json({ ok: false, error: 'not fetched (GET /task/:id?fetch=1 first)' });
    res.setHeader('Content-Type', MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream');
    res.setHeader('Content-Length', statSync(p).size);
    createReadStream(p).pipe(res);
  });

  router.get('/imagegen/v1/wiro/usage', (_req, res) => {
    const s = source();
    const rows = ledgerRows();
    res.json({ ok: true, configured: !!s, spentTodayUsd: Number(spentToday().toFixed(4)), dailyBudgetUsd: s ? budget(s) : null,
      recent: rows.slice(-25).reverse() });
  });
}
