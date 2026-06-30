// Dynacat config editor API — lets the Home tab read/validate/save the Dynacat dashboard YAML.
//
// Dynacat (the Home dashboard sidecar on :8081) is normally auto-generated every 10 min from cluster
// inventory by /opt/dynacat/gen-dynacat-config.py. This router lets the user hand-edit dynacat.yml: saving
// drops a `.manual-override` sentinel that the generator checks and skips on, so manual edits aren't
// clobbered. "Reset to auto-generated" removes the sentinel and regenerates. All local to CT152.
import { Router } from 'express';
import express from 'express';
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { execFileSync } from 'child_process';

const DIR = '/opt/dynacat';
const CFG = `${DIR}/dynacat.yml`;
const BIN = `${DIR}/dynacat`;
const OVERRIDE = `${DIR}/.manual-override`;
const GEN = `${DIR}/gen-dynacat-config.py`;

export function createDynacatRouter() {
  const router = Router();
  router.use(express.json({ limit: '2mb' }));

  const restart = () => { try { execFileSync('systemctl', ['restart', 'dynacat'], { timeout: 15000 }); } catch {} };

  // GET /api/dynacat/config — current YAML + whether manual-override (auto-regen paused) is active.
  router.get('/config', (_req, res) => {
    try {
      const yaml = existsSync(CFG) ? readFileSync(CFG, 'utf-8') : '';
      const manual = existsSync(OVERRIDE);
      const mtime = existsSync(CFG) ? statSync(CFG).mtimeMs : 0;
      res.json({ yaml, manualOverride: manual, mtime });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // PUT /api/dynacat/config { yaml } — validate, then save + pin manual mode + reload dynacat.
  router.put('/config', (req, res) => {
    const yaml = req.body?.yaml;
    if (typeof yaml !== 'string' || !yaml.trim()) return res.status(400).json({ error: 'yaml (non-empty string) required' });
    const tmp = `${CFG}.editor.tmp`;
    try {
      writeFileSync(tmp, yaml);
      // validate against the dynacat binary before committing
      try {
        execFileSync(BIN, ['-config', tmp, 'config:validate'], { timeout: 15000, stdio: 'pipe' });
      } catch (ve) {
        const out = `${ve?.stdout || ''}${ve?.stderr || ''}`.trim() || String(ve?.message || ve);
        try { unlinkSync(tmp); } catch {}
        return res.status(422).json({ ok: false, error: out });
      }
      writeFileSync(CFG, yaml);
      try { unlinkSync(tmp); } catch {}
      writeFileSync(OVERRIDE, `manual edit via AI-Lab Home editor\n`); // pause auto-regen
      restart();
      res.json({ ok: true, manualOverride: true });
    } catch (e) {
      try { unlinkSync(tmp); } catch {}
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // GET /api/dynacat/config-parsed — the config as structured JSON (for the GUI builder).
  // YAML↔JSON conversion uses PyYAML (already on CT152); avoids a node dep + a deploy install step.
  router.get('/config-parsed', (_req, res) => {
    try {
      const manual = existsSync(OVERRIDE);
      if (!existsSync(CFG)) return res.json({ config: {}, manualOverride: manual });
      const out = execFileSync('python3', ['-c',
        'import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))', CFG],
        { encoding: 'utf-8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
      res.json({ config: JSON.parse(out), manualOverride: manual });
    } catch (e) {
      res.status(500).json({ error: `${e?.stderr || ''}${e?.message || e}` });
    }
  });

  // PUT /api/dynacat/config-parsed { config } — serialize JSON→YAML, validate, then save + pin manual mode + reload.
  router.put('/config-parsed', (req, res) => {
    const config = req.body?.config;
    if (!config || typeof config !== 'object') return res.status(400).json({ ok: false, error: 'config (object) required' });
    const tmp = `${CFG}.editor.tmp`;
    let yaml;
    try {
      yaml = execFileSync('python3', ['-c',
        'import yaml,json,sys; sys.stdout.write(yaml.safe_dump(json.load(sys.stdin), sort_keys=False, allow_unicode=True, default_flow_style=False, width=4096))'],
        { input: JSON.stringify(config), encoding: 'utf-8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'YAML serialize failed: ' + `${e?.stderr || ''}${e?.message || e}` });
    }
    try {
      writeFileSync(tmp, yaml);
      try {
        execFileSync(BIN, ['-config', tmp, 'config:validate'], { timeout: 15000, stdio: 'pipe' });
      } catch (ve) {
        const out = `${ve?.stdout || ''}${ve?.stderr || ''}`.trim() || String(ve?.message || ve);
        try { unlinkSync(tmp); } catch {}
        return res.status(422).json({ ok: false, error: out, yaml });
      }
      writeFileSync(CFG, yaml);
      try { unlinkSync(tmp); } catch {}
      writeFileSync(OVERRIDE, `manual edit via AI-Lab Home builder\n`); // pause auto-regen
      restart();
      res.json({ ok: true, manualOverride: true, yaml });
    } catch (e) {
      try { unlinkSync(tmp); } catch {}
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // POST /api/dynacat/regenerate — hand control back to the generator (clear override + rebuild from inventory).
  router.post('/regenerate', (_req, res) => {
    try {
      if (existsSync(OVERRIDE)) unlinkSync(OVERRIDE);
      try {
        execFileSync('python3', [GEN], { timeout: 60000, stdio: 'pipe' });
      } catch (ge) {
        return res.status(500).json({ ok: false, error: `${ge?.stdout || ''}${ge?.stderr || ''}`.trim() || String(ge?.message || ge) });
      }
      const yaml = existsSync(CFG) ? readFileSync(CFG, 'utf-8') : '';
      res.json({ ok: true, manualOverride: false, yaml });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  return router;
}
