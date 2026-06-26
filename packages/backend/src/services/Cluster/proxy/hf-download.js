/**
 * Native HuggingFace downloader — extracted from ProxLab's ai.js (/hf/* routes + helpers) into a
 * standalone Express router so it runs inside CT 152, writing to the local /ai-assets rbind mount.
 * curl spawns via systemd-run (survives backend restarts); permissions fixed locally (no SSH).
 * Routes: /hf/tree, /hf/download, /hf/downloads(+:id, reorder, :id/stop, :id/force), /hf/clear-completed, /hf/history.
 */
import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { spawn, execSync } from 'child_process';
import { isDownloadAllowed } from './download-scheduler.js';

const DATA_DIR = process.env.AILAB_PROXY_DATA_DIR || (process.cwd() + '/data');
const hfDownloadsFile = join(DATA_DIR, 'hf-downloads.json');
const hfHistoryFile = join(DATA_DIR, 'hf-history.json');
const settingsFile = join(DATA_DIR, 'settings.json');

function loadSettings() {
  try { if (existsSync(settingsFile)) return JSON.parse(readFileSync(settingsFile, 'utf-8')); } catch {}
  return {};
}
function loadHfDownloads() {
  try { if (existsSync(hfDownloadsFile)) return JSON.parse(readFileSync(hfDownloadsFile, 'utf-8')); } catch {}
  return { downloads: [] };
}
function saveHfDownloads(data) {
  writeFileSync(hfDownloadsFile, JSON.stringify(data, null, 2));
}
function loadHfHistory() {
  try { if (existsSync(hfHistoryFile)) return JSON.parse(readFileSync(hfHistoryFile, 'utf-8')); } catch {}
  return { items: [] };
}
function saveHfHistory(data) {
  writeFileSync(hfHistoryFile, JSON.stringify(data, null, 2));
}
function addToHfHistory(entry) {
  const h = loadHfHistory();
  const repo = entry.repo || '';
  const revision = entry.revision || 'main';
  const fileName = entry.fileName || '';
  const originalName = entry.hfPath ? entry.hfPath.split('/').pop() : fileName;
  const ext = fileName.split('.').pop().toLowerCase();
  const isModel = ['safetensors', 'gguf', 'ckpt', 'pt', 'pth', 'bin', 'onnx'].includes(ext);
  const fileEntry = {
    fileName, originalName, hfPath: entry.hfPath || '', targetDir: entry.targetDir || '',
    size: entry.size || entry.progress || 0, format: entry.format || null, quant: entry.quant || null, isModel,
  };
  let repoEntry = h.items.find(i => i.repo === repo && i.revision === revision);
  if (repoEntry) {
    if (!repoEntry.files.some(f => f.fileName === fileName)) {
      repoEntry.files.push(fileEntry);
      repoEntry.totalSize = (repoEntry.totalSize || 0) + (fileEntry.size || 0);
    }
    repoEntry.lastDownloadedAt = new Date().toISOString();
  } else {
    repoEntry = {
      repo, repoUrl: repo ? `https://huggingface.co/${repo}` : '', revision,
      targetDir: entry.targetDir || '', totalSize: fileEntry.size || 0, files: [fileEntry],
      downloadedAt: new Date().toISOString(), lastDownloadedAt: new Date().toISOString(),
    };
    h.items.unshift(repoEntry);
  }
  if (h.items.length > 5000) h.items = h.items.slice(0, 5000);
  saveHfHistory(h);
}
function parseFileTarget(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  if (ext === 'gguf') {
    const qm = fileName.match(/((?:I?Q\d+_K(?:_[SMLXS]+)?)|(?:Q\d+_\d+)|(?:IQ\d+_[A-Z]+)|(?:MXFP\d+)|(?:MVQ\d+)|(?:F16|F32|BF16|FP8|FP4))/i);
    return { format: 'GGUF', quant: qm?.[1]?.toUpperCase() || 'unknown' };
  }
  if (ext === 'safetensors') return { format: 'FP16', quant: null };
  return { format: ext.toUpperCase(), quant: null };
}
async function enrichHfHistoryEntry(entry) {
  if (!entry.repo) return;
  try {
    const ui = loadSettings().ui || {};
    const token = ui.hfToken || '';
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const resp = await fetch(`https://huggingface.co/api/models/${entry.repo}`, { headers });
    if (!resp.ok) return;
    const meta = await resp.json();
    const h = loadHfHistory();
    const item = h.items.find(i => i.repo === entry.repo && i.fileName === entry.fileName && i.completedAt === entry.completedAt);
    if (!item) return;
    item.repoMeta = {
      modelId: meta.id || '', author: meta.author || '', lastModified: meta.lastModified || '',
      tags: meta.tags || [], pipelineTag: meta.pipeline_tag || '', libraryName: meta.library_name || '',
      license: meta.cardData?.license || meta.license || '', downloads: meta.downloads || 0, likes: meta.likes || 0,
      siblings: (meta.siblings || []).map(s => ({ rfilename: s.rfilename, size: s.size || 0 })),
    };
    const baseModelTag = (meta.tags || []).find(t => t.startsWith('base_model:'));
    if (baseModelTag) item.baseModel = baseModelTag.replace('base_model:', '');
    saveHfHistory(h);
  } catch {}
}

export function createHfRouter() {
  const router = Router();
  // ── routes + helpers (ported from ProxLab ai.js 5265-6004) ──
  async function walkHfTree(repo, revision, token, pathPrefix = '') {
    const url = `https://huggingface.co/api/models/${repo}/tree/${revision}${pathPrefix ? '/' + pathPrefix : ''}`;
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${resp.status} — ${resp.statusText}: ${text.slice(0, 200)}`);
    }
    const entries = await resp.json();
    const files = [];
    for (const entry of entries) {
      if (entry.type === 'file') {
        files.push({ path: entry.path, size: entry.size || 0 });
      } else if (entry.type === 'directory') {
        const subFiles = await walkHfTree(repo, revision, token, entry.path);
        files.push(...subFiles);
      }
    }
    return files;
  }

  /** Fetch branches/refs for a HuggingFace repo */
  async function fetchHfBranches(repo, token) {
    const url = `https://huggingface.co/api/models/${repo}/refs`;
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const resp = await fetch(url, { headers });
      if (!resp.ok) return ['main'];
      const data = await resp.json();
      const branches = (data.branches || []).map(b => b.ref || b.name).filter(Boolean);
      const tags = (data.tags || []).map(t => t.ref || t.name).filter(Boolean);
      return [...new Set([...branches, ...tags])];
    } catch {
      return ['main'];
    }
  }

  /** POST /hf/tree — Browse HuggingFace repo file tree */
  router.post('/hf/tree', async (req, res) => {
    try {
      const { repo, revision = 'main', token } = req.body;
      if (!repo) return res.status(400).json({ error: 'repo is required' });

      // Use saved token if none provided in request
      const ui = loadSettings().ui || {};
      const effectiveToken = token || ui.hfToken || '';

      // Fetch branches in parallel with file tree
      const [files, branches] = await Promise.all([
        walkHfTree(repo, revision, effectiveToken),
        fetchHfBranches(repo, effectiveToken),
      ]);

      // Smart path suggestion: split repo name into family + variant
      const repoName = repo.split('/').pop() || repo;
      const cleaned = repoName.replace(/[-_]?(GGUF|EXL2|AWQ|GPTQ|FP16|FP32|BF16|safetensors)$/gi, '');
      // Try splitting family vs variant: look for size/version patterns
      const splitMatch = cleaned.match(/^(.+?)[-_]((?:\d+[Bb].*|[Vv]\d+.*|[Mm]\d+.*|Small|Medium|Large|XL|XXL).*)$/);
      let suggestedFamily, suggestedVariant;
      if (splitMatch) {
        suggestedFamily = splitMatch[1];
        suggestedVariant = splitMatch[2];
      } else {
        suggestedFamily = cleaned;
        suggestedVariant = '';
      }

      // Auto-analyze repo type from file listing
      const analysis = analyzeRepoFiles(files, repo);

      res.json({ files, suggestedFamily, suggestedVariant, analysis, branches });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  /**
   * Analyze a HuggingFace repo's file listing to determine model type.
   * Returns { repoType, modelTypes (dropdown options), suggestedFolder, suggestedName, ggufQuants, components }
   */
  function analyzeRepoFiles(files, repo) {
    const paths = files.map(f => f.path);
    const exts = paths.map(p => p.split('.').pop().toLowerCase());
    const repoName = (repo || '').split('/').pop() || 'unknown';
    const suggestedName = repoName.replace(/[-_]?(GGUF|EXL2|AWQ|GPTQ|FP16|FP32|BF16|safetensors)$/gi, '')
      .replace(/[_\s]+/g, '-').toLowerCase();

    const hasGguf = paths.some(p => p.endsWith('.gguf'));
    const hasModelIndex = paths.includes('model_index.json');
    const hasAdapterConfig = paths.includes('adapter_config.json') || paths.some(p => p.endsWith('adapter_model.safetensors'));
    const hasSafetensors = paths.some(p => p.endsWith('.safetensors'));
    const hasConfig = paths.includes('config.json');
    const hasVaeFolder = paths.some(p => p.startsWith('vae/'));
    const hasTextEncoderFolder = paths.some(p => p.startsWith('text_encoder/') || p.startsWith('text_encoder_2/'));
    const hasTokenizer = paths.some(p => p.startsWith('tokenizer/') || p.includes('tokenizer.json') || p.includes('tokenizer.model'));

    // Group GGUF files by quant
    const ggufQuants = [];
    if (hasGguf) {
      for (const f of files) {
        if (!f.path.endsWith('.gguf')) continue;
        const { quant } = parseFileTarget(f.path.split('/').pop());
        ggufQuants.push({ path: f.path, name: f.path.split('/').pop(), size: f.size, quant });
      }
      ggufQuants.sort((a, b) => b.size - a.size);
    }

    // Group diffusers components by subfolder
    const components = {};
    if (hasModelIndex) {
      for (const f of files) {
        const parts = f.path.split('/');
        if (parts.length > 1) {
          const comp = parts[0];
          if (!components[comp]) components[comp] = { files: [], totalSize: 0 };
          components[comp].files.push(f);
          components[comp].totalSize += f.size || 0;
        } else {
          // Root-level files (model_index.json, etc.)
          if (!components['_root']) components['_root'] = { files: [], totalSize: 0 };
          components['_root'].files.push(f);
          components['_root'].totalSize += f.size || 0;
        }
      }
    }

    // Non-model files (extras)
    const extras = files.filter(f => {
      const ext = f.path.split('.').pop().toLowerCase();
      return ['md', 'txt', 'json', 'yaml', 'yml', 'gitattributes', 'jpg', 'jpeg', 'png', 'gif'].includes(ext)
        && !f.path.includes('tokenizer') && f.path !== 'model_index.json' && f.path !== 'config.json'
        && f.path !== 'adapter_config.json';
    });

    // ── Determine repo type ──
    let repoType = 'unknown';
    let suggestedFolder = '';

    // Image Gen types
    if (hasModelIndex) {
      repoType = 'diffusers';
      suggestedFolder = 'diffusers';
    } else if (hasAdapterConfig) {
      repoType = 'lora';
      suggestedFolder = 'loras';
    } else if (hasGguf && !hasConfig) {
      // Pure GGUF quant repo
      repoType = 'gguf';
      suggestedFolder = 'diffusion-models'; // default for image gen, overridden for LLM
    } else if (hasGguf && hasConfig) {
      // GGUF with config — likely LLM
      repoType = 'gguf-llm';
      suggestedFolder = '';
    } else if (hasVaeFolder && !hasTextEncoderFolder && !hasModelIndex) {
      repoType = 'vae';
      suggestedFolder = 'vae';
    } else if (hasTextEncoderFolder && !hasVaeFolder && !hasModelIndex) {
      repoType = 'text-encoder';
      suggestedFolder = 'text-encoders';
    } else if (hasSafetensors && !hasModelIndex && !hasAdapterConfig) {
      // Single or multi-shard safetensors — could be a full SD1.5/2 single-file
      // checkpoint OR a UNET/transformer-only model where the VAE + text encoder
      // ship in separate repos (LTX-2, Flux dev, Wan, etc.).
      const rootSafetensors = files.filter(f => f.path.endsWith('.safetensors') && !f.path.includes('/'));
      const totalRootSize = rootSafetensors.reduce((s, f) => s + (f.size || 0), 0);
      const hasCkpt = paths.some(p => p.endsWith('.ckpt'));
      const nameHints = /unet|transformer|dit|diffusion[-_]?model|ltx|flux|wan|hunyuan|cogvideo|mochi|allegro/i;
      const looksLikeUnet = !hasCkpt
        && !hasVaeFolder && !hasTextEncoderFolder && !hasTokenizer
        && rootSafetensors.length > 0
        && (totalRootSize > 5 * 1024 ** 3 || nameHints.test(repoName) || rootSafetensors.some(f => nameHints.test(f.path)));
      if (looksLikeUnet) {
        repoType = 'unet';
        suggestedFolder = 'diffusion-models';
      } else {
        repoType = 'safetensors';
        suggestedFolder = 'checkpoints'; // conservative default
      }
    } else {
      repoType = 'unknown';
      suggestedFolder = '';
    }

    // Human-readable summary surfaced in the UI so the user knows
    // what type the repo was detected as before they pick a destination.
    const TYPE_LABELS = {
      'diffusers': { label: 'Diffusers pipeline (multi-component)', hint: 'Contains model_index.json with vae/, text_encoder/, unet/ subfolders. Save the whole tree to diffusers/.' },
      'lora':      { label: 'LoRA adapter', hint: 'adapter_config.json present. Save to loras/.' },
      'gguf':      { label: 'GGUF image-gen quants', hint: 'Pure GGUF — no config.json. Save to diffusion-models/.' },
      'gguf-llm':  { label: 'GGUF LLM weights', hint: 'GGUF with config.json — LLM. Save under your LLM family folder.' },
      'vae':       { label: 'VAE weights', hint: 'Only a vae/ subfolder, no UNET / text encoder. Save to vae/.' },
      'text-encoder': { label: 'Text encoder weights', hint: 'Only a text_encoder/ subfolder. Save to text-encoders/.' },
      'unet':      { label: 'UNET / transformer only (no VAE or text encoder embedded)', hint: 'Single-file diffusion model — needs a companion VAE + text encoder from a different repo. Save to diffusion-models/, NOT checkpoints/.' },
      'safetensors': { label: 'Full single-file checkpoint (SD1.5 / SD2 style)', hint: 'Likely a full pipeline embedded in one safetensors. Save to checkpoints/.' },
      'unknown':   { label: 'Unknown structure', hint: 'Inspect the file listing manually.' },
    };
    const typeMeta = TYPE_LABELS[repoType] || TYPE_LABELS['unknown'];

    return {
      repoType,
      suggestedFolder,
      suggestedName,
      analysisLabel: typeMeta.label,
      analysisHint: typeMeta.hint,
      ggufQuants,
      components,
      extras: extras.map(f => ({ path: f.path, size: f.size })),
      flags: { hasGguf, hasModelIndex, hasAdapterConfig, hasSafetensors, hasConfig, hasVaeFolder, hasTextEncoderFolder, hasTokenizer },
    };
  }

  /**
   * Fix permissions on downloaded files via SSH to the ZFS host.
   * Unprivileged LXC containers can't chmod on bind mounts.
   * Maps container path /ai-assets/* to host path /mnt/flashpool/ai-assets/*
   */
  function fixDownloadPermissions(targetDir, fileName) {
    // AI-Lab runs inside CT 152 with /ai-assets rbind-mounted locally — chmod directly, no SSH.
    try {
      if (targetDir && targetDir.startsWith('/ai-assets/')) {
        execSync(`chmod -R 777 "${targetDir}" 2>/dev/null`, { timeout: 10000 });
        if (fileName) execSync(`chmod 777 "${targetDir}/${fileName}" 2>/dev/null`, { timeout: 10000 });
      }
    } catch {}
  }

  /** Start the next queued download(s), respecting concurrency limit. */
  async function processHfQueue(node) {
    if (!isDownloadAllowed('hf')) return;
    const manifest = loadHfDownloads();
    const ui = loadSettings().ui || {};

    // Max concurrent from: queued entry's maxActive > settings > default 3
    const firstQueued = manifest.downloads.find(d => d.status === 'queued');
    const maxConcurrent = firstQueued?.maxActive || ui.hfMaxActive || 3;

    const activeCount = manifest.downloads.filter(d => d.status === 'downloading').length;
    if (activeCount >= maxConcurrent) return;

    const slotsAvailable = maxConcurrent - activeCount;
    const queued = manifest.downloads.filter(d => d.status === 'queued');
    const toStart = queued.slice(0, slotsAvailable);
    if (toStart.length === 0) return;

    for (const next of toStart) {
      next.status = 'downloading';
      next.startedAt = new Date().toISOString();
      saveHfDownloads(manifest);

      const token = next.token || ui.hfToken || '';
      const revision = next.revision || 'main';
      const hfPath = (next.hfPath || next.fileName).split('/').map(s => encodeURIComponent(s)).join('/');
      const url = `https://huggingface.co/${next.repo}/resolve/${revision}/${hfPath}`;
      const targetFile = join(next.targetDir, next.fileName);

      // curl: single-connection, resume-capable, reliable per-file download.
      // Download to .part file, resume with -C -, rename to final on success.
      const partFile = targetFile + '.part';
      // If a legacy partial exists at the final path (pre-.part code), move it
      // to .part so curl can resume it.
      if (existsSync(targetFile) && !existsSync(partFile)) {
        const expectedBytes = next.size || 0;
        if (expectedBytes > 0) {
          const actualBytes = statSync(targetFile).size;
          if (actualBytes < expectedBytes * 0.95) {
            renameSync(targetFile, partFile);
          }
        }
      }
      const args = ['-L', '-o', partFile, '--retry', '3', '--retry-delay', '5', '-C', '-'];
      if (token) args.push('-H', `Authorization: Bearer ${token}`);
      args.push(url);

      // On success (exit 0), mv .part to final path
      const curlCmd = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      const fullCmd = `umask 000 && curl ${curlCmd} && mv '${partFile.replace(/'/g, "'\\''")}' '${targetFile.replace(/'/g, "'\\''")}'`;

      try {
        mkdirSync(next.targetDir, { recursive: true });

        // Use systemd-run --scope so curl survives proxlab-ui restarts
        const logPath = `/tmp/hfdl-${next.id}.log`;
        const scopeName = `hfdl-${next.id}`;
        const scopeCmd = `systemd-run --scope --unit=${scopeName} bash -c '${fullCmd.replace(/'/g, "'\\''")}' > '${logPath}' 2>&1`;

        const child = spawn('bash', ['-c', scopeCmd], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        // Find the real curl PID inside the scope
        let realPid = child.pid;
        try {
          execSync('sleep 0.5');
          const grepResult = execSync(`pgrep -f '${partFile.replace(/'/g, "")}' 2>/dev/null || true`).toString().trim();
          if (grepResult) realPid = parseInt(grepResult.split('\n')[0], 10);
        } catch {}

        next.pid = realPid;
        console.log(`[hf-download] Started PID ${realPid} (scope ${scopeName}): ${next.fileName} -> ${next.targetDir}`);
        saveHfDownloads(manifest);
      } catch (err) {
        next.status = 'failed';
        next.error = `Start failed: ${err.message}`;
        console.error(`[hf-download] Failed to start: ${err.message}`);
        saveHfDownloads(manifest);
      }
    }

    // If any failed, try to start next queued items
    const hasMoreQueued = manifest.downloads.some(d => d.status === 'queued');
    if (hasMoreQueued) {
      setTimeout(() => processHfQueue(node), 2000);
    }
  }

  /** Resolve a smart download destination from category + destType + file-manager config.
   *  Falls back to legacy /models/{family} path if file-manager config not available. */
  function resolveSmartDest(category, destType, subfolder) {
    try {
      const fmCfgPath = join(DATA_DIR, 'file-manager.json');
      const fmCfg = JSON.parse(readFileSync(fmCfgPath, 'utf8'));

      const destMap = {
        'image-gen': {
          'checkpoint': '/checkpoints/',
          'diffusion-model': '/diffusion-models/',
          'diffusers': '/diffusers/',
          'lora': '/loras/',
          'vae': '/vae/',
          'text-encoder': '/text-encoders/',
          'controlnet': '/controlnet/',
          'upscaler': '/upscale-models/',
          'embedding': '/embeddings/',
        },
        'llm': {
          'gguf': '/',
          'full-weights': '/',
          'lora': '/loras/',
        },
        'tts': {
          'tts-model': '/',
          'rvc-model': '/',
          'whisper': '/',
          '*': '/',
        },
      };

      const basePath = fmCfg.tabs?.[category]?.basePath;
      if (!basePath) {
        console.error(`[hf-download] No basePath for category=${category}`);
        return null;
      }

      const typeMap = destMap[category] || {};
      const subPath = typeMap[destType] || typeMap['*'] || '/';
      return `${basePath}${subPath}${subfolder}`;
    } catch (err) {
      console.error(`[hf-download] resolveSmartDest error:`, err.message);
      return null;
    }
  }

  /**
   * Resolve LLM subfolder path from filename and repo context.
   * Matches ProxLab's model scanner folder structure:
   *   {base}/GGUF/{quant_level}/       — Q4_K_M, Q8_0, IQ3_S, F16, BF16
   *   {base}/EXL2/{bpw}/               — 4.0, 5.5, 8.0
   *   {base}/EXL3/{bpw}/               — 4.0, 5.5, 8.0
   *   {base}/GPTQ/{bits}-bit/          — 4-bit, 8-bit
   *   {base}/AWQ/{bits}-bit/           — 4-bit, 8-bit
   *   {base}/NVFP4/                    — NVIDIA FP4
   *   {base}/FP16-Safetensors/         — FP16 full weights
   *   {base}/BF16-Safetensors/         — BF16 full weights
   */
  function resolveLlmSubfolder(base, fileName, repoName) {
    const lower = fileName.toLowerCase();
    const ext = fileName.split('.').pop().toLowerCase();
    const repoLower = (repoName || '').toLowerCase();

    // ── GGUF files ──
    if (ext === 'gguf') {
      if (lower.includes('mmproj')) return `${base}/GGUF/mmproj`;
      const qm = fileName.match(/((?:I?Q\d+_K(?:_[SMLXS]+)?)|(?:Q\d+_\d+)|(?:IQ\d+_[A-Z]+)|(?:IQ\d+_XS)|(?:F16|F32|BF16))/i);
      const quant = qm ? qm[1].toUpperCase() : 'unknown';
      return `${base}/GGUF/${quant}`;
    }

    // ── Safetensors — detect quant format from filename or repo name ──
    if (ext === 'safetensors' || ext === 'bin' || ext === 'pt') {

      // EXL3 (check before EXL2 since EXL3 is newer)
      if (lower.includes('exl3') || repoLower.includes('exl3')) {
        const bpwMatch = fileName.match(/(\d+\.?\d*)bpw/i) || fileName.match(/exl3[_-]?(\d+\.?\d*)/i);
        const bpw = bpwMatch ? bpwMatch[1] : 'unknown';
        return `${base}/EXL3/${bpw}`;
      }

      // EXL2
      if (lower.includes('exl2') || repoLower.includes('exl2')) {
        const bpwMatch = fileName.match(/(\d+\.?\d*)bpw/i) || fileName.match(/exl2[_-]?(\d+\.?\d*)/i);
        const bpw = bpwMatch ? bpwMatch[1] : 'unknown';
        return `${base}/EXL2/${bpw}`;
      }

      // GPTQ
      if (lower.includes('gptq') || repoLower.includes('gptq')) {
        const bits = fileName.match(/(\d+)[_-]?bit/i) || repoLower.match(/gptq[_-]?(\d+)/i);
        return `${base}/GPTQ/${bits ? bits[1] + '-bit' : '4-bit'}`;
      }

      // AWQ
      if (lower.includes('awq') || repoLower.includes('awq')) {
        const bits = fileName.match(/(\d+)[_-]?bit/i) || repoLower.match(/awq[_-]?(\d+)/i);
        return `${base}/AWQ/${bits ? bits[1] + '-bit' : '4-bit'}`;
      }

      // NVFP4
      if (lower.includes('nvfp4') || lower.includes('nf4') || repoLower.includes('nvfp4')) {
        return `${base}/NVFP4`;
      }

      // FP16 vs BF16 detection
      if (lower.includes('fp16') || repoLower.includes('fp16')) {
        return `${base}/FP16-Safetensors`;
      }

      // Default to BF16-Safetensors for unquantized full weights
      return `${base}/BF16-Safetensors`;
    }

    // JSON configs, tokenizers, etc. — check if they belong with a specific format
    // For EXL2/EXL3/GPTQ/AWQ repos, configs go in the same format folder
    if (ext === 'json' || ext === 'py' || ext === 'model' || ext === 'txt') {
      if (repoLower.includes('exl3')) return `${base}/EXL3`;
      if (repoLower.includes('exl2')) return `${base}/EXL2`;
      if (repoLower.includes('gptq')) return `${base}/GPTQ`;
      if (repoLower.includes('awq')) return `${base}/AWQ`;
      if (repoLower.includes('nvfp4')) return `${base}/NVFP4`;
      if (repoLower.includes('gguf')) return `${base}/GGUF`;
      // Full weight repos — configs go with the weights
      return `${base}/BF16-Safetensors`;
    }

    return base;
  }

  /** POST /hf/download — Queue selected files for download */
  router.post('/hf/download', async (req, res) => {
    try {
      const {
        repo, revision = 'main', files, node, token,
        // Legacy fields
        family, variant, targetBase,
        // Smart routing fields
        category, destType, subfolder, preserveStructure,
      } = req.body;

      // Resolve destination: smart routing takes precedence over legacy
      let base;
      if (category && destType && subfolder) {
        base = resolveSmartDest(category, destType, subfolder);
        if (!base) {
          return res.status(400).json({ error: `Cannot resolve path for category=${category}, destType=${destType}` });
        }
      } else {
        // Legacy fallback
        base = targetBase || `/models/${family}${variant ? '/' + variant : ''}`;
      }

      if (!repo || !files?.length || !node || !base) {
        return res.status(400).json({ error: 'repo, files, node, and destination are required' });
      }

      const ui = loadSettings().ui || {};
      const effectiveToken = token || ui.hfToken || null;

      const manifest = loadHfDownloads();
      const queued = [];

      // Create individual queue entries per file
      for (const f of files) {
        const fileName = f.path.split('/').pop();

        // Build filter for this specific file
        let hfFilter = fileName;
        if (fileName.endsWith('.gguf')) {
          const qm = fileName.match(/((?:I?Q\d+_K(?:_[SMLXS]+)?)|(?:Q\d+_\d+)|(?:IQ\d+_[A-Z]+)|(?:F16|F32|BF16))/i);
          if (qm) hfFilter = qm[1];
        }

        // Determine target directory based on category and file type
        let targetDir;
        let skipFile = false;
        if (preserveStructure) {
          const hfDir = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : '';
          targetDir = hfDir ? `${base}/${hfDir}` : base;
        } else if (category === 'llm') {
          // README.md goes in the base (variant) folder, not quant subfolder
          if (fileName.toLowerCase() === 'readme.md') {
            targetDir = base;
            // Skip if already exists and replaceReadme not set
            if (!req.body.replaceReadme && existsSync(join(base, 'README.md'))) {
              skipFile = true;
            }
          } else {
            targetDir = resolveLlmSubfolder(base, fileName, repo);
          }
        } else {
          targetDir = base;
        }

        if (skipFile) continue;

        const id = Math.random().toString(16).slice(2, 10);
        const entry = {
          id,
          repo,
          revision,
          fileName,
          hfPath: f.path,
          hfFilter,
          size: f.size || 0,
          targetDir,
          node: node || '_local',
          token: effectiveToken,
          concurrent: req.body.concurrent || null,
          maxActive: req.body.maxActive || null,
          excludeExtras: !req.body.includeExtras,
          status: 'queued',
          progress: 0,
          pid: null,
          startedAt: null,
          completedAt: null,
          error: null,
        };
        manifest.downloads.push(entry);
        queued.push(entry);
      }

      saveHfDownloads(manifest);
      processHfQueue(node || '_local');
      res.json({ queued });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /hf/downloads — Poll download status with live progress */
  router.get('/hf/downloads', async (req, res) => {
    try {
      const manifest = loadHfDownloads();

      // Check progress for active downloads
      for (const dl of manifest.downloads) {
        if (dl.status !== 'downloading' || !dl.pid) continue;

        try {
          // Check if process is still running (local)
          let isRunning = false;
          try {
            process.kill(dl.pid, 0); // signal 0 = just check if alive
            isRunning = true;
          } catch { isRunning = false; }

          // Get downloaded file size — check both .part (in-progress) and final path
          let currentSize = 0;
          const targetFile = join(dl.targetDir, dl.fileName);
          const partFile = targetFile + '.part';
          try {
            if (existsSync(partFile)) {
              currentSize = statSync(partFile).size;
            } else if (existsSync(targetFile)) {
              currentSize = statSync(targetFile).size;
            }
          } catch {}

          // Track speed
          const now = Date.now();
          const lastPoll = dl._lastPollTime || now;
          const lastSize = dl._lastPollSize || 0;
          const elapsed = (now - lastPoll) / 1000;
          if (elapsed > 0 && currentSize > lastSize) {
            dl.speed = Math.round((currentSize - lastSize) / elapsed);
          } else if (elapsed > 10) {
            dl.speed = 0;
          }
          dl._lastPollTime = now;
          dl._lastPollSize = currentSize;

          if (!isRunning) {
            // Process finished — check if curl succeeded (final file exists, .part gone)
            const finalExists = existsSync(targetFile);
            const partExists = existsSync(partFile);
            let finalSize = 0;
            try { if (finalExists) finalSize = statSync(targetFile).size; } catch {}

            const expectedSize = dl.size || 0;
            const isComplete = finalExists && !partExists && (
              expectedSize > 0 ? (finalSize >= expectedSize * 0.95) : (finalSize > 1000)
            );

            let logContent = '';
            try {
              logContent = readFileSync(`/tmp/hfdl-${dl.id}.log`, 'utf8').trim().slice(-500);
            } catch {}

            if (isComplete) {
              dl.status = 'complete';
              dl.progress = finalSize;
              dl.completedAt = new Date().toISOString();
              fixDownloadPermissions(dl.targetDir, dl.fileName);
              // Parse format/quant from filename for history
              const parsed = parseFileTarget(dl.fileName);
              dl.format = parsed.format;
              dl.quant = parsed.quant;
              addToHfHistory(dl);
              // Enrich with repo metadata in background (non-blocking)
              enrichHfHistoryEntry({ repo: dl.repo, fileName: dl.fileName, completedAt: dl.completedAt }).catch(() => {});
            } else if (partExists && currentSize > 0) {
              // Incomplete but has partial data — auto-requeue for resume
              dl.status = 'queued';
              dl.pid = null;
              dl.error = null;
            } else if (logContent.includes('error') || logContent.includes('Error') || logContent.includes('failed') || currentSize === 0) {
              dl.status = 'failed';
              dl.error = logContent.slice(-300) || 'Download failed — no output';
            } else {
              dl.status = 'failed';
              dl.error = 'Download process exited unexpectedly';
            }
            dl.checkFailures = 0;
            saveHfDownloads(manifest);
            processHfQueue(dl.node);
          } else {
            dl.progress = currentSize;
            dl.checkFailures = 0;
            saveHfDownloads(manifest);
          }
        } catch (err) {
          dl.checkFailures = (dl.checkFailures || 0) + 1;
          if (dl.checkFailures >= 3) {
            dl.status = 'failed';
            dl.error = `Check failed: ${err.message}`;
            saveHfDownloads(manifest);
            processHfQueue(dl.node);
          }
        }
      }

      // Process queue on every poll — start queued items if slots available
      const hasQueued = manifest.downloads.some(d => d.status === 'queued');
      if (hasQueued) {
        const nodes = [...new Set(manifest.downloads.filter(d => d.status === 'queued').map(d => d.node || '_local'))];
        for (const n of nodes) processHfQueue(n);
      }

      // Strip tokens and internal tracking fields from response
      const safe = manifest.downloads.map(d => {
        const { token, _lastPollTime, _lastPollSize, ...rest } = d;
        return rest;
      });
      res.json({ downloads: safe });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** DELETE /hf/downloads/:id — Cancel or remove a download */
  router.delete('/hf/downloads/:id', async (req, res) => {
    const manifest = loadHfDownloads();
    const idx = manifest.downloads.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Download not found' });

    const dl = manifest.downloads[idx];
    const nodeToResume = dl.node;

    // Remove from manifest FIRST (always succeeds even if SSH times out)
    manifest.downloads.splice(idx, 1);
    saveHfDownloads(manifest);

    // Kill local process and clean up partial file
    if (dl.status === 'downloading' && dl.pid) {
      try { process.kill(dl.pid, 'SIGTERM'); } catch {}
    }
    if (dl.targetDir && dl.fileName) {
      const partialFile = join(dl.targetDir, dl.fileName);
      try { if (existsSync(partialFile)) { unlinkSync(partialFile); console.log(`[hf-download] Cleaned up partial: ${partialFile}`); } } catch {}
    }

    // Don't auto-start next queued item when user is manually clearing the queue
    res.json({ deleted: true });
  });

  /** DELETE /hf/downloads — Bulk clear queued and failed entries (keep active + completed) */
  router.delete('/hf/downloads', (req, res) => {
    const manifest = loadHfDownloads();
    manifest.downloads = manifest.downloads.filter(d => d.status === 'downloading' || d.status === 'complete' || d.status === 'completed');
    saveHfDownloads(manifest);
    res.json({ cleared: true });
  });

  /** POST /hf/downloads/reorder — Reorder HF download queue */
  router.post('/hf/downloads/reorder', (req, res) => {
    const { id, position, targetId, before } = req.body;
    const manifest = loadHfDownloads();
    const idx = manifest.downloads.findIndex(d => d.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const [item] = manifest.downloads.splice(idx, 1);
    if (targetId) {
      let targetIdx = manifest.downloads.findIndex(d => d.id === targetId);
      if (targetIdx === -1) targetIdx = manifest.downloads.length;
      manifest.downloads.splice(before ? targetIdx : targetIdx + 1, 0, item);
    } else if (position === 'top') {
      const firstNonActive = manifest.downloads.findIndex(d => d.status !== 'downloading');
      manifest.downloads.splice(firstNonActive >= 0 ? firstNonActive : 0, 0, item);
    } else {
      manifest.downloads.push(item);
    }
    saveHfDownloads(manifest);
    res.json({ ok: true });
  });

  /** POST /hf/downloads/:id/stop — Stop download but keep in queue */
  router.post('/hf/downloads/:id/stop', (req, res) => {
    const manifest = loadHfDownloads();
    const dl = manifest.downloads.find(d => d.id === req.params.id);
    if (!dl) return res.status(404).json({ error: 'Not found' });
    if (dl.status === 'downloading' && dl.pid) {
      try { process.kill(dl.pid, 'SIGTERM'); } catch {}
      console.log(`[hf-download] STOP: ${dl.fileName} PID ${dl.pid}`);
    }
    dl.status = 'queued';
    dl.pid = null;
    saveHfDownloads(manifest);
    res.json({ ok: true });
  });

  /** POST /hf/downloads/:id/force — Force-start ignoring concurrency/scheduler */
  router.post('/hf/downloads/:id/force', async (req, res) => {
    const manifest = loadHfDownloads();
    const dl = manifest.downloads.find(d => d.id === req.params.id);
    if (!dl) return res.status(404).json({ error: 'Not found' });
    if (dl.status === 'downloading' && dl.pid) {
      return res.json({ ok: true, message: 'Already downloading' });
    }
    dl.status = 'queued';
    dl.pid = null;
    saveHfDownloads(manifest);
    await processHfQueue(dl.node || '_local');
    res.json({ ok: true });
  });

  /** POST /hf/clear-completed — Clear only completed entries (history) */
  router.post('/hf/clear-completed', (req, res) => {
    const manifest = loadHfDownloads();
    manifest.downloads = manifest.downloads.filter(d => d.status !== 'complete' && d.status !== 'completed');
    saveHfDownloads(manifest);
    res.json({ cleared: true });
  });

  /** GET /hf/history — Get HuggingFace download history */
  router.get('/hf/history', (req, res) => {
    const h = loadHfHistory();
    res.json(h);
  });
  return router;
}
