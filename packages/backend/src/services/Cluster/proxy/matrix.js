/**
 * matrix.js — Matrix homeserver controls (continuwuity on the US VPS, deeveeyant.com).
 *
 * Sign-up mode is the one control so far:
 *   closed    nobody can register
 *   token     registration needs a token; accounts are active immediately
 *   approval  registration needs a token AND new accounts start SUSPENDED until Travis runs
 *             `!admin users unsuspend @name:deeveeyant.com` (the server posts a notice in the admin room)
 * Every open mode needs a token because continuwuity RELEASE builds compile out challenge-free
 * registration (enable_challengeless_registration() is hard-coded false).
 *
 * The VPS is reached with a RESTRICTED key: authorized_keys forces it to run
 * /usr/local/bin/matrix-signups-remote, which accepts only a validated mode (+ optional token) and
 * runs matrix-signups. That script applies the change (SIGUSR1 reload, restart only as fallback)
 * and VERIFIES it against the registration API before reporting, so the UI never shows a mode the
 * server is not actually in. Mounted at /api/matrix.
 */
import { Router } from 'express';
import { execFile } from 'child_process';

const VPS = process.env.AILAB_MATRIX_VPS || 'root@107.173.17.151';
const KEY = process.env.AILAB_MATRIX_SIGNUPS_KEY || '/root/.ssh/matrix_signups_key';
const MODES = new Set(['closed', 'token', 'approval']);

function remote(args) {
  return new Promise((resolve) => {
    execFile('ssh', ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', VPS, args.join(' ')],
      { timeout: 90_000 }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') });
      });
  });
}

/** Parse matrix-signups output: `server: <mode> ... (recorded: <x>)`, optional `TOKEN: <t>`. */
function parse(out) {
  const lines = out.split('\n');
  const serverLine = [...lines].reverse().find((l) => l.startsWith('server: ')) || '';
  const raw = serverLine.replace(/^server:\s*/, '').trim();
  const mode = /^approval/.test(raw) ? 'approval' : /^token/.test(raw) ? 'token' : /^closed/.test(raw) ? 'closed' : 'unknown';
  const token = (lines.find((l) => l.startsWith('TOKEN: ')) || '').replace(/^TOKEN:\s*/, '').trim() || undefined;
  const failed = lines.find((l) => l.startsWith('FAILED') || l.startsWith('refused'));
  const via = (lines.find((l) => l.startsWith('applied via ')) || '').replace(/^applied via\s*/, '') || undefined;
  return { mode, token, failed, via };
}

export function createMatrixRouter() {
  const router = Router();

  router.get('/signups', async (_req, res) => {
    const r = await remote(['status']);
    if (!r.ok) return res.status(502).json({ error: `VPS unreachable: ${r.err.trim().slice(0, 300)}` });
    const p = parse(r.out);
    res.json({ mode: p.mode });
  });

  router.post('/signups', async (req, res) => {
    const mode = req.body && req.body.mode;
    const token = req.body && req.body.token ? String(req.body.token) : '';
    if (!MODES.has(mode)) return res.status(400).json({ error: "mode must be 'closed', 'token' or 'approval'" });
    if (token && !/^[A-Za-z0-9]{8,64}$/.test(token)) return res.status(400).json({ error: 'token must be 8-64 letters/digits' });
    if (token && mode === 'closed') return res.status(400).json({ error: 'a token only applies to token/approval mode' });
    const r = await remote(token ? [mode, token] : [mode]);
    const p = parse(r.out);
    if (!r.ok || p.failed) {
      return res.status(502).json({ error: p.failed || r.err.trim().slice(0, 300) || 'change not applied', mode: p.mode });
    }
    // The token is returned ONCE so it can be shared; it is not stored by AI-Lab.
    res.json({ ok: true, mode: p.mode, token: p.token, via: p.via });
  });

  return router;
}
