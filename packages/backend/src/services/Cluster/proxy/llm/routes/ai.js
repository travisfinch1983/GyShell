/**
 * ai.js — AI Pool API Routes
 *
 * Manages GPU pool assignments (ai-pool / reserved) and agent container
 * designations for the AI / LLM Pool feature. Persists state in
 * data/ai-config.json.
 *
 * @module routes/ai
 */

import express, { Router } from 'express';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, createReadStream, unlinkSync, copyFileSync, renameSync, openSync, readSync, closeSync } from 'fs';
import { join, dirname, extname, resolve as pathResolve, basename } from 'path';
import { spawn, execSync } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { getClusterGpus, getGpuVramUsage, getAllGpuSpecs } from '../services/gpu-specs.js';
import { estimateVram, getModelPresets, getQuantFormats } from '../services/vram-calc.js';
import { isDownloadAllowed } from '../download-scheduler.js';
import { findPlacements } from '../services/gpu-placer.js';
import { getAllProviders, getProvider } from '../services/providers.js';
import { ProviderInstaller } from '../services/provider-installer.js';
import { inspectModel, detectFormat, recommendedHeaderSize, safetensorsHeaderSize } from '../services/model-inspector.js';
import { getProviderSymlinks } from '../services/shared-folder-mappings.js';
import { LlmMetricsPoller } from '../services/metrics-poller.js';

// Per-provider VRAM reservation strategy:
//   null  = static LLM — trust live nvidia-smi (no hot-swap, VRAM won't change mid-run)
//   -1    = dynamic LLM — user-configurable, defaults to full GPU VRAM
//   N     = fixed estimate in MiB (TTS/STT providers, based on largest model per provider)
//   0     = CPU-only, no GPU VRAM reserved
const PROVIDER_VRAM_RESERVES = {
  koboldcpp: null, vllm: null, tabbyapi: null,
  lmdeploy: null, sglang: null, aphrodite: null,
  ollama: -1,
  alltalk: 4096, 'tts-webui': 4096, f5tts: 3072,
  kokoro: 2048, 'openedai-speech': 2048, 'proxlab-tts': 3072, 'qwen-tts': 4096, 's2-pro': 6144,
  'faster-whisper': 3072, piper: 0,
  'audio-tools': 4096,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.AILAB_PROXY_DATA_DIR || join(__dirname, '..', '..', 'data');
const aiConfigFile = join(dataDir, 'ai-config.json');
const gpuAssignFile = join(dataDir, 'gpu-assignments.json');
const activeServicesFile = join(dataDir, 'active-services.json');
const cacheManifestFile = join(dataDir, 'model-cache.json');
const modelIndexFile = join(dataDir, 'model-index.json');
const launchTemplatesFile = join(dataDir, 'launch-templates.json');
const hfDownloadsFile = join(dataDir, 'hf-downloads.json');
const hfHistoryFile = join(dataDir, 'hf-history.json');
const settingsFile = join(dataDir, 'proxlab-ui-settings.json'); // renamed: avoid gybackend settings.json collision
const serviceHistoryFile = join(dataDir, 'service-history.json');

function loadSettings() {
  try { if (existsSync(settingsFile)) return JSON.parse(readFileSync(settingsFile, 'utf-8')); } catch {}
  return {};
}

// The HuggingFace token the user enters in Settings is saved by the UI to cluster-settings.json
// under `tokens.hfToken` — NOT to proxlab-ui-settings.json's `ui.hfToken` that loadSettings() reads.
// Without this fallback the downloader stays unauthenticated, and HF throttles concurrent Xet-CDN
// transfers of large public files with HTTP 401. Read the cluster token as a fallback.
// Strip curl's progress-meter spam (carriage-return-overwritten lines) from a download log so the
// stored error shows the actual message (e.g. "curl: (22) ... 401") instead of a giant
// download-status table. Keeps real output lines (the curl error, "Running as unit", etc.).
function cleanCurlLog(s) {
  if (!s) return '';
  return s.split(/\r?\n/)
    .map((l) => l.split('\r').pop())  // collapse \r-overwritten progress updates to the final segment
    .filter((l) => l && l.trim()
      && !/Total\s+%|Dload|Upload|Average Speed|--:--:--|Xferd/.test(l)
      && !/^\s*\d+\s+[\d.]+[KMGT]?\s/.test(l))
    .join('\n').trim();
}

const clusterSettingsFile = join(dataDir, 'cluster-settings.json');
function loadClusterHfToken() {
  try {
    if (existsSync(clusterSettingsFile)) {
      return (JSON.parse(readFileSync(clusterSettingsFile, 'utf-8')).tokens || {}).hfToken || '';
    }
  } catch {}
  return '';
}

function loadAiConfig() {
  try {
    if (existsSync(aiConfigFile)) return JSON.parse(readFileSync(aiConfigFile, 'utf-8'));
  } catch {}
  return { pools: {}, agents: {}, version: 1 };
}

function saveAiConfig(data) {
  writeFileSync(aiConfigFile, JSON.stringify(data, null, 2));
}

function loadGpuAssignments() {
  try {
    if (existsSync(gpuAssignFile)) return JSON.parse(readFileSync(gpuAssignFile, 'utf-8'));
  } catch {}
  return {};
}

function saveGpuAssignments(data) {
  writeFileSync(gpuAssignFile, JSON.stringify(data, null, 2));
}

/** Active LLM services state (persisted across page reloads) */
function loadActiveServices() {
  try {
    if (existsSync(activeServicesFile)) {
      const state = JSON.parse(readFileSync(activeServicesFile, 'utf-8'));
      if (ensureProxySlots(state)) saveActiveServices(state);
      return state;
    }
  } catch {}
  return { services: {} };
}

/** Known STT provider IDs (module-level for slot classification) */
const STT_PROVIDERS_SET = new Set(['faster-whisper']);

/** Classify a service as llm, tts, stt, or tools (module-level, used by ensureProxySlots) */
function classifyServiceForSlot(svc) {
  if (svc.isTools) return 'tools';
  if (!svc.isTts) return 'llm';
  if (STT_PROVIDERS_SET.has(svc.providerId)) return 'stt';
  return 'tts';
}

/**
 * Backfill missing proxySlot on services created before stable-slot support.
 * Returns true if any slots were assigned (caller should save).
 */
function ensureProxySlots(state) {
  if (!state.services) return false;
  const byType = { llm: [], tts: [], stt: [], tools: [] };
  for (const svc of Object.values(state.services)) {
    const type = classifyServiceForSlot(svc);
    if (svc.proxySlot) byType[type].push(svc.proxySlot);
  }
  let changed = false;
  for (const svc of Object.values(state.services)) {
    if (svc.proxySlot) continue;
    const type = classifyServiceForSlot(svc);
    let slot = 1;
    while (byType[type].includes(slot)) slot++;
    svc.proxySlot = slot;
    byType[type].push(slot);
    changed = true;
  }
  return changed;
}

/** Assign the lowest unused proxy slot for a service type */
function assignProxySlot(state, svc) {
  const type = classifyServiceForSlot(svc);
  const used = Object.values(state.services)
    .filter(s => s !== svc && classifyServiceForSlot(s) === type)
    .map(s => s.proxySlot || 0);
  let slot = 1;
  while (used.includes(slot)) slot++;
  svc.proxySlot = slot;
}

function saveActiveServices(data) {
  writeFileSync(activeServicesFile, JSON.stringify(data, null, 2));
}

/** Service history — archived services for log retrieval after stop/fail */
function loadServiceHistory() {
  try {
    if (existsSync(serviceHistoryFile)) return JSON.parse(readFileSync(serviceHistoryFile, 'utf-8'));
  } catch {}
  return { services: [] };
}

function saveServiceHistory(data) {
  writeFileSync(serviceHistoryFile, JSON.stringify(data, null, 2));
}

const SERVICE_HISTORY_MAX = 100;

/** Archive a service entry to history before removing from active services */
function archiveService(svc, exitReason = 'stopped') {
  const history = loadServiceHistory();
  history.services.unshift({
    ...svc,
    stoppedAt: Date.now(),
    exitReason,
    logFile: svc.logFile || `/var/log/proxlab/${svc.tmuxSession}.log`,
  });
  // Cap history size
  if (history.services.length > SERVICE_HISTORY_MAX) {
    history.services = history.services.slice(0, SERVICE_HISTORY_MAX);
  }
  saveServiceHistory(history);
}

function loadCacheManifest() {
  try {
    if (existsSync(cacheManifestFile)) return JSON.parse(readFileSync(cacheManifestFile, 'utf-8'));
  } catch {}
  return { entries: [] };
}

function saveCacheManifest(data) {
  writeFileSync(cacheManifestFile, JSON.stringify(data, null, 2));
}

function loadModelIndex() {
  try {
    if (existsSync(modelIndexFile)) return JSON.parse(readFileSync(modelIndexFile, 'utf-8'));
  } catch {}
  return null;
}

function saveModelIndex(data) {
  writeFileSync(modelIndexFile, JSON.stringify(data, null, 2));
}

function loadLaunchTemplates() {
  try {
    if (existsSync(launchTemplatesFile)) return JSON.parse(readFileSync(launchTemplatesFile, 'utf-8'));
  } catch {}
  return { templates: [] };
}

function saveLaunchTemplates(data) {
  writeFileSync(launchTemplatesFile, JSON.stringify(data, null, 2));
}

function loadHfDownloads() {
  try {
    if (existsSync(hfDownloadsFile)) return JSON.parse(readFileSync(hfDownloadsFile, 'utf-8'));
  } catch {}
  return { downloads: [] };
}

function saveHfDownloads(data) {
  writeFileSync(hfDownloadsFile, JSON.stringify(data, null, 2));
}

function loadHfHistory() {
  try {
    if (existsSync(hfHistoryFile)) return JSON.parse(readFileSync(hfHistoryFile, 'utf-8'));
  } catch {}
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
    fileName,
    originalName,
    hfPath: entry.hfPath || '',
    targetDir: entry.targetDir || '',
    size: entry.size || entry.progress || 0,
    format: entry.format || null,
    quant: entry.quant || null,
    isModel,
  };

  // Aggregate by repo — find or create a repo-level entry
  let repoEntry = h.items.find(i => i.repo === repo && i.revision === revision);
  if (repoEntry) {
    if (!repoEntry.files.some(f => f.fileName === fileName)) {
      repoEntry.files.push(fileEntry);
      repoEntry.totalSize = (repoEntry.totalSize || 0) + (fileEntry.size || 0);
    }
    repoEntry.lastDownloadedAt = new Date().toISOString();
  } else {
    repoEntry = {
      repo,
      repoUrl: repo ? `https://huggingface.co/${repo}` : '',
      revision,
      targetDir: entry.targetDir || '',
      totalSize: fileEntry.size || 0,
      files: [fileEntry],
      downloadedAt: new Date().toISOString(),
      lastDownloadedAt: new Date().toISOString(),
    };
    h.items.unshift(repoEntry);
  }

  if (h.items.length > 5000) h.items = h.items.slice(0, 5000);
  saveHfHistory(h);
}

async function enrichHfHistoryEntry(entry) {
  if (!entry.repo) return;
  try {
    const ui = loadSettings().ui || {};
    const token = ui.hfToken || loadClusterHfToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    const repoUrl = `https://huggingface.co/api/models/${entry.repo}`;
    const resp = await fetch(repoUrl, { headers, timeout: 10000 });
    if (!resp.ok) return;
    const meta = await resp.json();

    const h = loadHfHistory();
    const item = h.items.find(i => i.repo === entry.repo && i.fileName === entry.fileName && i.completedAt === entry.completedAt);
    if (!item) return;

    item.repoMeta = {
      modelId: meta.id || '',
      author: meta.author || '',
      lastModified: meta.lastModified || '',
      tags: meta.tags || [],
      pipelineTag: meta.pipeline_tag || '',
      libraryName: meta.library_name || '',
      license: meta.cardData?.license || meta.license || '',
      downloads: meta.downloads || 0,
      likes: meta.likes || 0,
      siblings: (meta.siblings || []).map(s => ({
        rfilename: s.rfilename,
        size: s.size || 0,
      })),
    };

    // Try to get base model from tags or config
    const baseModelTag = (meta.tags || []).find(t => t.startsWith('base_model:'));
    if (baseModelTag) item.baseModel = baseModelTag.replace('base_model:', '');

    saveHfHistory(h);
    console.log(`[hf-history] Enriched: ${entry.repo}/${entry.fileName}`);
  } catch (err) {
    console.error(`[hf-history] Enrich failed for ${entry.repo}: ${err.message}`);
  }
}

/** Get the container cache path for a node (from per-node config or default) */
function getCachePath(node) {
  const cfg = loadAiConfig();
  const agent = cfg.agents?.[node];
  return agent?.cache?.containerPath || '/model-cache';
}

/** Check if caching is enabled for a node (default true for backward compat) */
function isCacheEnabled(node) {
  const cfg = loadAiConfig();
  const agent = cfg.agents?.[node];
  return agent?.cache?.enabled !== false;
}

/** Translate a container cache dir to the corresponding host path */
function toHostCachePath(node, containerCacheDir) {
  const cfg = loadAiConfig();
  const cache = cfg.agents?.[node]?.cache;
  const containerPath = cache?.containerPath || '/model-cache';
  const hostPath = cache?.hostPath || containerPath;
  if (containerCacheDir.startsWith(containerPath)) {
    return hostPath + containerCacheDir.substring(containerPath.length);
  }
  return '';
}

/** Map of cache-source container roots → cache-config field name for the host
 * mapping. Adding a new root means: add the prefix here + an input row in the
 * cache config UI. Order matters only for prefix-disambiguation (longer first).
 */
const CACHE_SOURCE_ROOTS = [
  { prefix: '/imagegen', hostField: 'imagegenHostPath', type: 'imagegen' },
  { prefix: '/models',   hostField: 'modelsHostPath',   type: 'llm' },
  { prefix: '/tts',      hostField: 'ttsHostPath',      type: 'tts' },
];

/** Translate a container source dir under any known root to the corresponding
 * host NAS path. Returns '' when no host mapping is configured for the relevant
 * root — caller falls back to `pct exec` cp.
 */
function toHostSourcePath(node, containerSourceDir) {
  const cfg = loadAiConfig();
  const cache = cfg.agents?.[node]?.cache;
  if (!cache) return '';
  for (const root of CACHE_SOURCE_ROOTS) {
    if (containerSourceDir.startsWith(root.prefix + '/') || containerSourceDir === root.prefix) {
      const hostRoot = cache[root.hostField];
      if (hostRoot) return hostRoot + containerSourceDir.substring(root.prefix.length);
      return '';
    }
  }
  return '';
}

/** Given a container source dir under one of the known roots, return the
 * matching cache dir on tmpfs. LLM entries (under /models/) drop the prefix
 * (legacy behavior), keeping the existing /model-cache/<family>/... shape.
 * Imagegen + TTS retain their prefix, giving /model-cache/imagegen/<cat>/...
 * and /model-cache/tts/<provider>/... shapes per Travis's request. Returns
 * null if sourceDir is not under any known root.
 */
function sourceToCacheDir(sourceDir, cachePath) {
  for (const root of CACHE_SOURCE_ROOTS) {
    if (sourceDir.startsWith(root.prefix + '/') || sourceDir === root.prefix) {
      // /models/foo → /model-cache/foo (legacy: prefix dropped)
      // /imagegen/foo → /model-cache/imagegen/foo (prefix retained, mirrors source tree)
      // /tts/foo → /model-cache/tts/foo (same)
      const keepPrefix = root.prefix !== '/models';
      const base = keepPrefix ? cachePath + root.prefix : cachePath;
      return base + sourceDir.substring(root.prefix.length);
    }
  }
  return null;
}

/** Infer cache entry type from source dir prefix. Returns null if no match. */
function inferCacheType(sourceDir) {
  for (const root of CACHE_SOURCE_ROOTS) {
    if (sourceDir.startsWith(root.prefix + '/') || sourceDir === root.prefix) return root.type;
  }
  return null;
}

// ─── Sequential Copy Queue (per-node) ──────────────────────────────────
// Ensures only one cache copy runs at a time per node, preventing:
//   1. Partial caches from interrupted parallel copies
//   2. Manifest race conditions (parallel read-modify-write)
const copyQueues = {}; // node → { active: bool, pending: [], currentCacheDir: string|null }

function startNextCopy(node, sshService, hookscriptDeploy) {
  const q = copyQueues[node];
  if (!q || q.active || q.pending.length === 0) return;
  q.active = true;
  const { hostIp, vmid, sourceDir, cacheDir, hostSrc, hostDst } = q.pending.shift();
  q.currentCacheDir = cacheDir;

  // rm -rf first to kill any orphan cp writes from a previous restart
  // (orphan pct exec cp processes survive ProxLab UI restarts; their writes
  //  go to unlinked inodes once the dir is removed, so they harmlessly drain)
  // Handles both single-file caches (imagegen checkpoints) and directory caches
  // (LLM model dirs). For files, place into parent dir at the same basename.
  //
  // After mkdir -p, chmod the FIRST-level subdir under the cache base to 1777
  // so unprivileged-LXC writers (Cinder's model-cache skill running under a
  // mapped UID) can also add entries there. Without this, mkdir -p lands at
  // default 0755 owned by host-root, and external writers get EPERM.
  // `base` is the cache root (host: hostDst's first 2 path segments;
  // container: cacheDir's first 1 segment + '/model-cache' prefix).
  const copyScript = (src, dst, base) => {
    // dst starts with base + '/<rootSubdir>/...'; extract rootSubdir and chmod it.
    const tail = dst.substring(base.length + 1);
    const rootSubdir = tail.split('/')[0]; // e.g. "imagegen", "tts", "Qwen3.6"
    const rootPath = `${base}/${rootSubdir}`;
    return `mkdir -p "${rootPath}" && chmod 1777 "${rootPath}" 2>/dev/null; ` +
      `if [ -f "${src}" ]; then ` +
      `rm -f "${dst}"; mkdir -p "$(dirname "${dst}")" && cp -a "${src}" "${dst}"; ` +
      `elif [ -d "${src}" ]; then ` +
      `rm -rf "${dst}"; mkdir -p "${dst}" && cp -a "${src}"/* "${dst}/"; ` +
      `else echo "ERR:source-not-found" >&2; exit 1; fi`;
  };
  // Container base = the cachePath we used to build cacheDir (e.g. /model-cache).
  // Host base = the hostCachePath prefix (derive by replacing cacheDir's prefix in hostDst).
  const containerBase = cacheDir.substring(0, cacheDir.indexOf('/', 1));
  const hostBase = hostDst ? hostDst.substring(0, hostDst.length - cacheDir.length + containerBase.length) : '';
  const cpCmd = (hostSrc && hostDst)
    ? `bash -c '${copyScript(hostSrc, hostDst, hostBase)}'`
    : `pct exec ${vmid} -- bash -c '${copyScript(sourceDir, cacheDir, containerBase)}'`;

  sshService.exec(hostIp, cpCmd, { timeout: 600000 }).then(async (result) => {
    const m = loadCacheManifest();
    const e = m.entries.find(x => x.node === node && x.cacheDir === cacheDir);
    if (result.code === 0 && e) {
      e.cachedAt = new Date().toISOString();
      // Get actual size
      const duDir = hostDst || null;
      const sizeCmd = duDir
        ? `du -sm "${duDir}" 2>/dev/null | cut -f1`
        : `pct exec ${vmid} -- du -sm "${cacheDir}" 2>/dev/null | cut -f1`;
      try {
        const sr = await sshService.exec(hostIp, sizeCmd, { timeout: 10000 });
        const sz = parseInt(sr.stdout.trim(), 10);
        if (sz > 0) e.sizeMB = sz;
      } catch {}
      saveCacheManifest(m);
      // Redeploy hookscript vars so reboot restores this model
      try {
        const assignments = loadGpuAssignments();
        const assign = assignments[String(vmid)];
        if (assign && hookscriptDeploy) {
          await hookscriptDeploy.deployContainerVars(vmid, assign);
        }
      } catch (err) {
        console.error(`[cache] Failed to redeploy vars for CT ${vmid}:`, err.message);
      }
    } else if (e) {
      m.entries = m.entries.filter(x => !(x.node === node && x.cacheDir === cacheDir));
      saveCacheManifest(m);
      console.error(`[cache] Copy failed for ${sourceDir} on ${node}:`, result.stderr);
    }
    q.active = false;
    q.currentCacheDir = null;
    startNextCopy(node, sshService, hookscriptDeploy);
  }).catch(err => {
    console.error(`[cache] SSH error caching ${sourceDir} on ${node}:`, err.message);
    const m = loadCacheManifest();
    m.entries = m.entries.filter(x => !(x.node === node && x.cacheDir === cacheDir));
    saveCacheManifest(m);
    q.active = false;
    q.currentCacheDir = null;
    startNextCopy(node, sshService, hookscriptDeploy);
  });
}

/** Parse GGUF/safetensors filename into format + quant for target path routing */
function parseFileTarget(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  if (ext === 'gguf') {
    const qm = fileName.match(/((?:I?Q\d+_K(?:_[SMLXS]+)?)|(?:Q\d+_\d+)|(?:IQ\d+_[A-Z]+)|(?:MXFP\d+)|(?:MVQ\d+)|(?:F16|F32|BF16|FP8|FP4))/i);
    return { format: 'GGUF', quant: qm?.[1]?.toUpperCase() || 'unknown' };
  }
  if (ext === 'safetensors') return { format: 'FP16', quant: null };
  return { format: ext.toUpperCase(), quant: null };
}

/** Get next available port starting from 5001, reclaiming gaps */
/** Ports reserved by in-flight launches (not yet registered in active-services.json) */
const pendingPorts = new Map(); // port → expiry timestamp

function getNextPort() {
  const state = loadActiveServices();
  const usedPorts = new Set(Object.values(state.services).map(s => s.port));
  // Also include ports reserved by launches that haven't registered yet
  const now = Date.now();
  for (const [p, expiry] of pendingPorts) {
    if (now > expiry) pendingPorts.delete(p);
    else usedPorts.add(p);
  }
  let port = 5001;
  while (usedPorts.has(port)) port++;
  // Reserve this port for 5 minutes (covers slow model loads)
  pendingPorts.set(port, now + 300_000);
  return port;
}

/**
 * Auto-sync AI Pool GPUs to agent containers when conflicts are cleared.
 *
 * For each node that has an AI agent designated:
 *   1. Collects AI Pool GPU PCI IDs for that node
 *   2. Checks if any non-agent container on that node still holds those GPUs
 *   3. If no conflicts and the agent's current assignment differs → syncs
 *   4. Records lastSyncTs on the agent entry
 *
 * @param {Object} deps - { pveApi, hookscriptDeploy }
 * @returns {Promise<{ synced: string[] }>} Node names that were synced
 */
export async function checkAndAutoSync({ pveApi, hookscriptDeploy }) {
  const cfg = loadAiConfig();
  const agents = cfg.agents || {};
  const pools = cfg.pools || {};
  const guests = pveApi.getGuests();
  const synced = [];

  // Build vmid → node map from PVE guests
  const vmidNodeMap = {};
  for (const g of guests) vmidNodeMap[String(g.vmid)] = g.node;

  // Build set of agent VMIDs
  const agentVmids = new Set();
  for (const agent of Object.values(agents)) {
    if (agent.vmid) agentVmids.add(String(agent.vmid));
  }

  for (const [node, agent] of Object.entries(agents)) {
    if (!agent.vmid) continue;
    const vmidStr = String(agent.vmid);

    // 1. Collect AI Pool GPU PCI IDs for this node
    const expectedGpus = [];
    for (const [key, val] of Object.entries(pools)) {
      if (val.mode !== 'ai-pool') continue;
      const [gpuNode, ...pciParts] = key.split(':');
      if (gpuNode === node) expectedGpus.push(pciParts.join(':'));
    }
    if (expectedGpus.length === 0) continue;

    // 2. Check for conflicts — non-agent containers on this node with AI Pool GPUs
    const assignments = loadGpuAssignments();
    const expectedSet = new Set(expectedGpus);
    let hasConflict = false;

    for (const [vmid, assign] of Object.entries(assignments)) {
      if (agentVmids.has(vmid)) continue; // agent assignments don't conflict
      const containerNode = vmidNodeMap[vmid];
      if (containerNode !== node) continue; // different node
      for (const pci of (assign.gpus || [])) {
        if (expectedSet.has(pci)) { hasConflict = true; break; }
      }
      if (hasConflict) break;
    }
    if (hasConflict) continue;

    // 3. Check if agent already has the exact expected GPU set
    const currentAssign = assignments[vmidStr];
    const currentGpus = currentAssign?.gpus || [];
    const currentSet = new Set(currentGpus);
    const sameSet = expectedGpus.length === currentGpus.length &&
      expectedGpus.every(g => currentSet.has(g));
    if (sameSet) continue;

    // 4. Sync — write gpu-assignments + deploy hookscripts
    const mountStyle = currentAssign?.mountStyle || 'old';
    const freshAssignments = loadGpuAssignments();
    freshAssignments[vmidStr] = { mountStyle, gpus: expectedGpus };
    saveGpuAssignments(freshAssignments);

    try {
      const deployResult = await hookscriptDeploy.saveAndDeploy(vmidStr, { mountStyle, gpus: expectedGpus });

      // Verify hookscript was actually registered (not just skipped)
      if (deployResult.hookscript?.action === 'skipped') {
        console.error(`Auto-sync hookscript skipped for ${node}: ${deployResult.hookscript.reason}`);
        continue;
      }

      // Only mark as synced if deploy actually succeeded
      agent.lastSyncTs = Date.now();
      synced.push(node);
    } catch (err) {
      console.error(`Auto-sync hookscript deploy failed for ${node}:`, err.message);
    }
  }

  // Save ai-config if any syncs occurred
  if (synced.length > 0) {
    saveAiConfig(cfg);
    console.log(`Auto-sync: synced AI Pool GPUs for nodes: ${synced.join(', ')}`);
  }

  return { synced };
}

/**
 * Create the AI Pool router.
 * @param {Object} config - App config
 * @param {Object} gpuMonitor - GPU monitor service
 * @param {Object} pveApi - PVE API service
 * @param {Object} sshService - SSH service
 * @param {Object} hookscriptDeploy - Hookscript deploy service
 */
export function createAiRouter(config, gpuMonitor, pveApi, sshService, hookscriptDeploy) {
  const router = Router();

  /** Resolve container-local CUDA device indices to physical PCI IDs */
  function resolveServiceGpuPciIds(vmid, cudaDevices) {
    const assignments = loadGpuAssignments();
    const assign = assignments[String(vmid)];
    if (!assign?.gpus?.length) return [];
    return cudaDevices
      .filter(idx => idx >= 0 && idx < assign.gpus.length)
      .map(idx => assign.gpus[idx]);
  }

  /** Extract content between marker lines from pct exec output (filters noise/ANSI) */
  function extractBetweenMarkers(text, startMarker, endMarker) {
    const startIdx = text.indexOf(startMarker);
    const endIdx = text.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return '';
    return text.substring(startIdx + startMarker.length, endIdx).trim();
  }

  /** GET / — Full AI config */
  router.get('/config', (req, res) => {
    res.json(loadAiConfig());
  });

  /** PUT /config/pools — Batch-update all GPU pool assignments */
  router.put('/config/pools', async (req, res) => {
    const { pools } = req.body;
    if (!pools || typeof pools !== 'object') {
      return res.status(400).json({ error: 'pools object required' });
    }

    // Validate pool modes
    for (const [key, val] of Object.entries(pools)) {
      if (val.mode !== 'ai-pool' && val.mode !== 'reserved') {
        return res.status(400).json({ error: `Invalid mode "${val.mode}" for ${key}` });
      }
    }

    const cfg = loadAiConfig();
    const oldPools = cfg.pools || {};

    // Detect GPUs removed from AI Pool → auto-remove from agent containers
    const removedFromPool = []; // [{ node, pciId }]
    for (const [key, oldVal] of Object.entries(oldPools)) {
      if (oldVal.mode === 'ai-pool') {
        const newVal = pools[key];
        if (!newVal || newVal.mode !== 'ai-pool') {
          // This GPU was in AI Pool but is no longer
          const colonIdx = key.indexOf(':');
          const node = key.substring(0, colonIdx);
          const pciId = key.substring(colonIdx + 1);
          removedFromPool.push({ node, pciId });
        }
      }
    }

    // Remove these GPUs from agent container assignments
    if (removedFromPool.length > 0) {
      const assignments = loadGpuAssignments();
      let assignmentsChanged = false;

      for (const { node, pciId } of removedFromPool) {
        const agentVmid = cfg.agents?.[node]?.vmid;
        if (!agentVmid) continue;
        const vmidStr = String(agentVmid);
        const assignment = assignments[vmidStr];
        if (!assignment?.gpus) continue;
        const idx = assignment.gpus.indexOf(pciId);
        if (idx >= 0) {
          assignment.gpus.splice(idx, 1);
          assignmentsChanged = true;
          if (assignment.gpus.length === 0) delete assignments[vmidStr];
        }
      }

      if (assignmentsChanged) saveGpuAssignments(assignments);
    }

    cfg.pools = pools;
    saveAiConfig(cfg);

    // Auto-sync: newly pool-eligible GPUs may now have no conflicts
    let autoSynced = [];
    try {
      const result = await checkAndAutoSync({ pveApi, hookscriptDeploy });
      autoSynced = result.synced;
    } catch (err) {
      console.error('Auto-sync after pool save failed:', err.message);
    }

    res.json({ ok: true, poolCount: Object.keys(pools).length, removedFromAgents: removedFromPool.length, autoSynced });
  });

  /** GET /agents — All agent designations enriched with container info */
  router.get('/agents', (req, res) => {
    const cfg = loadAiConfig();
    const guests = pveApi.getGuests();
    const assignments = loadGpuAssignments();
    const enriched = {};

    for (const [node, agent] of Object.entries(cfg.agents || {})) {
      const guest = guests.find(g => g.vmid === agent.vmid);
      const vmid = String(agent.vmid);

      // Compute needsSync: compare current pool GPUs vs deployed assignments
      const poolGpus = [];
      for (const [key, val] of Object.entries(cfg.pools || {})) {
        if (val.mode !== 'ai-pool') continue;
        const [gpuNode, ...pciParts] = key.split(':');
        if (gpuNode === node) poolGpus.push(pciParts.join(':'));
      }
      const deployedGpus = assignments[vmid]?.gpus || [];
      const needsSync = JSON.stringify(poolGpus.sort()) !== JSON.stringify(deployedGpus.sort());

      enriched[node] = {
        vmid: agent.vmid,
        name: guest?.name || null,
        status: guest?.status || null,
        type: guest?.type || null,
        lastSyncTs: agent.lastSyncTs || null,
        uptime: guest?.uptime ?? null,
        cache: agent.cache || null,
        needsSync,
      };
    }

    res.json(enriched);
  });

  /**
   * PUT /agents/:node — Designate agent container for a node.
   * After designating, triggers auto-sync to assign AI Pool GPUs
   * and deploy hookscripts to the new agent container.
   */
  router.put('/agents/:node', async (req, res) => {
    const { vmid } = req.body;
    if (!vmid || typeof vmid !== 'number') {
      return res.status(400).json({ error: 'vmid (number) required' });
    }

    const node = req.params.node;
    if (!node || node === 'undefined' || node === 'null') {
      return res.status(400).json({ error: 'Invalid node name' });
    }
    const cfg = loadAiConfig();
    if (!cfg.agents) cfg.agents = {};
    cfg.agents[node] = { vmid };
    saveAiConfig(cfg);

    // Auto-deploy SSH key to the agent container via PVE host (pct exec)
    // so provider installs and status checks can SSH directly to the container
    let sshKeyDeployed = false;
    try {
      const nodeMap = pveApi.getNodeMap();
      const hostIp = nodeMap[node]?.ip;
      const pubKeyPath = config.ssh.privateKeyPath + '.pub';
      if (hostIp && existsSync(pubKeyPath)) {
        const pubKey = readFileSync(pubKeyPath, 'utf-8').trim();
        const keyFingerprint = pubKey.split(' ')[1] || '';
        const cmd = `pct exec ${vmid} -- bash -c 'mkdir -p /root/.ssh && grep -qF "${keyFingerprint}" /root/.ssh/authorized_keys 2>/dev/null || echo "${pubKey}" >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys'`;
        await sshService.exec(hostIp, cmd, { timeout: 15000 });
        sshKeyDeployed = true;
        console.log(`[agent] SSH key deployed to CT ${vmid} on ${node}`);
      }
    } catch (err) {
      console.warn(`[agent] SSH key deploy to CT ${vmid} failed: ${err.message}`);
    }

    // Auto-sync: assign AI Pool GPUs to the new agent immediately
    let autoSynced = [];
    try {
      const result = await checkAndAutoSync({ pveApi, hookscriptDeploy });
      autoSynced = result.synced;
    } catch (err) {
      console.error('Auto-sync after agent promotion failed:', err.message);
    }

    res.json({ ok: true, node, vmid, autoSynced, sshKeyDeployed });
  });

  /**
   * DELETE /agents/:node — Remove agent designation (demotion).
   * Cleans up: removes GPU assignments from the old container,
   * unregisters hookscript, and removes vars files.
   */
  router.delete('/agents/:node', async (req, res) => {
    const node = req.params.node;
    const cfg = loadAiConfig();
    const agent = cfg.agents?.[node];
    const oldVmid = agent?.vmid;

    // Remove agent from config
    if (cfg.agents) delete cfg.agents[node];
    saveAiConfig(cfg);

    // Clean up old container's GPU assignment + hookscript
    let cleanup = {};
    if (oldVmid) {
      const vmidStr = String(oldVmid);
      const assignments = loadGpuAssignments();

      if (assignments[vmidStr]) {
        delete assignments[vmidStr];
        saveGpuAssignments(assignments);
      }

      try {
        cleanup = await hookscriptDeploy.saveAndRemove(vmidStr);
      } catch (err) {
        cleanup = { error: err.message };
        console.error(`Cleanup hookscript for demoted CT ${oldVmid} failed:`, err.message);
      }
    }

    res.json({ ok: true, node, oldVmid, cleanup });
  });

  /** PUT /agents/:node/cache — Save per-node cache config */
  router.put('/agents/:node/cache', (req, res) => {
    const { node } = req.params;
    const { enabled, hostPath, containerPath, modelsHostPath, imagegenHostPath, ttsHostPath } = req.body;
    const cfg = loadAiConfig();
    if (!cfg.agents?.[node]) return res.status(404).json({ error: 'Unknown agent node' });
    cfg.agents[node].cache = {
      enabled: !!enabled,
      hostPath: (hostPath || '/model-cache').replace(/\/+$/, ''),
      containerPath: (containerPath || '/model-cache').replace(/\/+$/, ''),
      modelsHostPath: (modelsHostPath || '').replace(/\/+$/, ''),
      imagegenHostPath: (imagegenHostPath || '').replace(/\/+$/, ''),
      ttsHostPath: (ttsHostPath || '').replace(/\/+$/, ''),
    };
    saveAiConfig(cfg);
    res.json({ ok: true });
  });

  /**
   * POST /agents/:node/sync-gpus — Assign AI Pool GPUs to agent container.
   * Reads AI Pool GPUs for the node, writes gpu-assignments.json for the
   * agent VMID, and deploys hookscripts.
   */
  router.post('/agents/:node/sync-gpus', async (req, res) => {
    const node = req.params.node;
    const cfg = loadAiConfig();
    const agent = cfg.agents?.[node];

    if (!agent) {
      return res.status(400).json({ error: `No agent designated for node ${node}` });
    }

    // Collect AI Pool GPU PCI IDs for this node
    const aiGpus = [];
    for (const [key, val] of Object.entries(cfg.pools || {})) {
      if (val.mode !== 'ai-pool') continue;
      const [gpuNode, ...pciParts] = key.split(':');
      if (gpuNode === node) {
        aiGpus.push(pciParts.join(':'));
      }
    }

    if (aiGpus.length === 0) {
      return res.json({ ok: true, vmid: agent.vmid, gpus: [], message: 'No AI Pool GPUs on this node' });
    }

    const vmid = String(agent.vmid);
    const mountStyle = req.body.mountStyle || 'old';

    try {
      // Update gpu-assignments.json — detect if anything actually changed
      const assignments = loadGpuAssignments();
      const prev = assignments[vmid]?.gpus || [];
      const changed = JSON.stringify(prev.sort()) !== JSON.stringify(aiGpus.sort());
      assignments[vmid] = { mountStyle, gpus: aiGpus };
      saveGpuAssignments(assignments);

      // Deploy hookscripts
      let hookResult = {};
      try {
        hookResult = await hookscriptDeploy.saveAndDeploy(vmid, { mountStyle, gpus: aiGpus });
      } catch (hookErr) {
        hookResult = { error: hookErr.message };
      }

      // Only update sync timestamp if GPUs actually changed (prevents false "needs reboot")
      if (changed) {
        agent.lastSyncTs = Date.now();
        saveAiConfig(cfg);
      }

      res.json({ ok: true, vmid: agent.vmid, gpus: aiGpus, changed, hookscript: hookResult });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /deploy-hookscripts — Force-redeploy all ProxLab hookscripts.
   * Resets the static deploy flag, deploys master/common/gpu-hook scripts,
   * then deploys vars and registers hookscripts for all containers in
   * gpu-assignments.json.
   */
  router.post('/deploy-hookscripts', async (req, res) => {
    try {
      const force = req.body?.force === true;

      // Force redeploy of static files
      hookscriptDeploy.staticDeployed = false;

      const assignments = loadGpuAssignments();
      const results = {};

      for (const [vmid, assignment] of Object.entries(assignments)) {
        try {
          const r = await hookscriptDeploy.saveAndDeploy(vmid, assignment, { force });
          results[vmid] = { ok: true, ...r };
        } catch (err) {
          results[vmid] = { ok: false, error: err.message };
        }
      }

      res.json({ ok: true, deployed: Object.keys(assignments).length, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Model Scanner ────────────────────────────────────────────────────

  let modelScanCache = { data: null, ts: 0 };
  const MODEL_SCAN_TTL = 5 * 60 * 1000; // 5 minutes
  let scanTimer = null;

  /** Build the shell script that walks /models. Optional familyFilter limits to one family. */
  function buildScanScript(familyFilter) {
    const findPath = familyFilter
      ? `/models/${familyFilter}`
      : '/models';
    return `
      if [ ! -d ${findPath} ]; then echo "NO_MODELS_DIR"; exit 0; fi
      TAB=$(printf '\\t')

      # Normalize: rename directories with spaces → hyphens (family + variant levels)
      for d in /models/*/; do
        [ -d "$d" ] || continue
        base=$(basename "$d")
        clean=$(echo "$base" | tr ' ' '-')
        if [ "$base" != "$clean" ]; then
          target="/models/$clean"
          if [ -d "$target" ]; then
            # Merge contents into existing hyphenated dir
            for sub in "$d"*/; do
              [ -d "$sub" ] || continue
              subbase=$(basename "$sub")
              [ ! -e "$target/$subbase" ] && mv "$sub" "$target/" 2>/dev/null
            done
            rmdir "$d" 2>/dev/null
          else
            mv "$d" "$target" 2>/dev/null
          fi
        fi
      done
      for d in /models/*/*/; do
        [ -d "$d" ] || continue
        parent=$(dirname "$d")
        base=$(basename "$d")
        clean=$(echo "$base" | tr ' ' '-')
        if [ "$base" != "$clean" ]; then
          target="$parent/$clean"
          if [ -d "$target" ]; then
            for sub in "$d"*/; do
              [ -d "$sub" ] || continue
              subbase=$(basename "$sub")
              [ ! -e "$target/$subbase" ] && mv "$sub" "$target/" 2>/dev/null
            done
            rmdir "$d" 2>/dev/null
          else
            mv "$d" "$target" 2>/dev/null
          fi
        fi
      done

      # Helper: check if a directory contains real model files (not just empty scaffold)
      has_model_files() {
        local d="$1"
        find "$d" -maxdepth 1 -type f \\( \
          -name '*.safetensors' -o -name '*.bin' -o -name '*.pt' -o \
          -name '*.gguf' -o -name '*.onnx' -o -name '*.msgpack' \
        \\) 2>/dev/null | head -1 | grep -q .
      }

      find ${findPath} -mindepth ${familyFilter ? '1' : '2'} -maxdepth ${familyFilter ? '1' : '2'} -type d 2>/dev/null | sort | while read variant_dir; do
        family=$(basename "$(dirname "$variant_dir")")
        variant=$(basename "$variant_dir")
        formats=""
        for fmt_dir in "$variant_dir"/*/; do
          [ -d "$fmt_dir" ] || continue
          fmt=$(basename "$fmt_dir")
          case "$fmt" in
            FP16-Safetensors|FP16)
              if has_model_files "$fmt_dir"; then
                size=$(du -sm "$fmt_dir" 2>/dev/null | cut -f1)
                formats="$formats\${TAB}FP16:$fmt_dir:$size"
              fi
              ;;
            BF16-Safetensors|BF16)
              if has_model_files "$fmt_dir"; then
                size=$(du -sm "$fmt_dir" 2>/dev/null | cut -f1)
                formats="$formats\${TAB}BF16:$fmt_dir:$size"
              fi
              ;;
            GGUF)
              for quant_dir in "$fmt_dir"*/; do
                [ -d "$quant_dir" ] || continue
                quant=$(basename "$quant_dir")
                [ "$quant" = "mmproj" ] && continue
                gguf_file=$(find "$quant_dir" -maxdepth 1 -name '*.gguf' -type f 2>/dev/null | sort | head -1)
                if [ -n "$gguf_file" ]; then
                  size=$(du -sm "$quant_dir" 2>/dev/null | cut -f1)
                  formats="$formats\${TAB}GGUF/$quant:$gguf_file:$size"
                fi
              done
              for gguf_file in "$fmt_dir"*.gguf; do
                [ -f "$gguf_file" ] || continue
                fname=$(basename "$gguf_file" .gguf)
                quant=$(echo "$fname" | grep -oiE '(i?q[0-9]+_[a-z0-9_]+|[qf][0-9]+_[0-9]|fp16|fp32|bf16)' | tail -1 | tr '[:lower:]' '[:upper:]')
                [ -z "$quant" ] && quant="$fname"
                size=$(du -sm "$gguf_file" 2>/dev/null | cut -f1)
                formats="$formats\${TAB}GGUF/$quant:$gguf_file:$size"
              done
              if [ -d "$fmt_dir/mmproj" ]; then
                for mp_file in "$fmt_dir/mmproj"/*.gguf; do
                  [ -f "$mp_file" ] || continue
                  mp_name=$(basename "$mp_file" .gguf)
                  mp_size=$(du -sm "$mp_file" 2>/dev/null | cut -f1)
                  formats="$formats\${TAB}MMPROJ/$mp_name:$mp_file:$mp_size"
                done
              fi
              ;;
            EXL2)
              for bpw_dir in "$fmt_dir"*/; do
                [ -d "$bpw_dir" ] || continue
                has_model_files "$bpw_dir" || continue
                bpw=$(basename "$bpw_dir")
                size=$(du -sm "$bpw_dir" 2>/dev/null | cut -f1)
                formats="$formats\${TAB}EXL2/$bpw:$bpw_dir:$size"
              done
              ;;
            EXL3)
              for bpw_dir in "$fmt_dir"*/; do
                [ -d "$bpw_dir" ] || continue
                has_model_files "$bpw_dir" || continue
                bpw=$(basename "$bpw_dir")
                size=$(du -sm "$bpw_dir" 2>/dev/null | cut -f1)
                formats="$formats\${TAB}EXL3/$bpw:$bpw_dir:$size"
              done
              ;;
            AWQ|GPTQ)
              has_subdirs=0
              for sub_dir in "$fmt_dir"*/; do
                [ -d "$sub_dir" ] || continue
                has_model_files "$sub_dir" || continue
                sub=$(basename "$sub_dir")
                size=$(du -sm "$sub_dir" 2>/dev/null | cut -f1)
                formats="$formats\${TAB}$fmt/$sub:$sub_dir:$size"
                has_subdirs=1
              done
              if [ "$has_subdirs" = "0" ]; then
                has_model_files "$fmt_dir" || continue
                bits=""
                cfg_file="$fmt_dir/config.json"
                if [ -f "$cfg_file" ]; then
                  bits=$(python3 -c "import json,sys;c=json.load(open(sys.argv[1]));qc=c.get('quantization_config',{});print(qc.get('bits',''))" "$cfg_file" 2>/dev/null)
                fi
                if [ -n "$bits" ]; then
                  sub="$bits-bit"
                else
                  sub="4-bit"
                fi
                size=$(du -sm "$fmt_dir" 2>/dev/null | cut -f1)
                formats="$formats\${TAB}$fmt/$sub:$fmt_dir:$size"
              fi
              ;;
          esac
        done
        # Extract architecture metadata from config.json if present
        arch=""
        if [ -n "$formats" ]; then
          cfg=$(find "$variant_dir" -name "config.json" -maxdepth 3 -type f 2>/dev/null | head -1)
          if [ -n "$cfg" ]; then
            arch=$(python3 -c "
import json, sys
c = json.load(open(sys.argv[1]))
tc = c.get('text_config', c)
out = {}
for k in ['num_hidden_layers','num_attention_heads','num_key_value_heads','head_dim','hidden_size','intermediate_size']:
  if k in tc: out[k] = tc[k]
lt = tc.get('layer_types', [])
if lt: out['kvLayers'] = sum(1 for t in lt if t == 'full_attention')
if out: print(json.dumps(out))
" "$cfg" 2>/dev/null || true)
          fi
          echo "MODEL|$family|$variant|$formats|$arch"
        fi
      done
    `.trim();
  }

  /** Find first running agent container. Returns { node, vmid, hostIp } or null. */
  function findRunningAgent() {
    const cfg = loadAiConfig();
    const agents = cfg.agents || {};
    const guests = pveApi.getGuests();
    const nodeMap = pveApi.getNodeMap();

    for (const [node, agent] of Object.entries(agents)) {
      if (!agent.vmid) continue;
      const guest = guests.find(g => g.vmid === agent.vmid);
      if (guest?.status === 'running') {
        const hostIp = nodeMap[node]?.ip;
        if (hostIp) return { node, vmid: agent.vmid, hostIp };
      }
    }
    return null;
  }

  /** Parse MODEL| lines from scan output into model objects. */
  function parseScanOutput(stdout) {
    const models = [];
    const lines = stdout.split('\n').filter(l => l.startsWith('MODEL|'));

    for (const line of lines) {
      // Split on | — format: MODEL|family|variant|formats|archJson
      const parts = line.split('|');
      const family = parts[1];
      const variant = parts[2];
      // Formats are in parts[3], architecture JSON (if any) in the last part
      const formatsStr = parts[3]?.trim() || '';
      const archStr = parts[parts.length - 1]?.trim();
      const formats = {};

      for (const entry of formatsStr.split(/\t/).filter(Boolean)) {
        // Format: TYPE/SUB:path:size — path may contain colons (unlikely) so split carefully
        const firstColon = entry.indexOf(':');
        const typeAndPath = firstColon > -1 ? entry.substring(0, firstColon) : entry;
        const rest = firstColon > -1 ? entry.substring(firstColon + 1) : '';
        const lastColon = rest.lastIndexOf(':');
        const path = lastColon > -1 ? rest.substring(0, lastColon) : rest;
        const sizeStr = lastColon > -1 ? rest.substring(lastColon + 1) : null;
        const slashIdx = typeAndPath.indexOf('/');

        if (slashIdx > -1) {
          const formatType = typeAndPath.substring(0, slashIdx);
          const subType = typeAndPath.substring(slashIdx + 1);
          if (!formats[formatType]) formats[formatType] = {};
          formats[formatType][subType] = {
            path: path?.replace(/\/$/, '') || '',
            sizeMB: sizeStr ? parseInt(sizeStr, 10) : null,
          };
        } else {
          formats[typeAndPath] = {
            path: path?.replace(/\/$/, '') || '',
            sizeMB: sizeStr ? parseInt(sizeStr, 10) : null,
          };
        }
      }

      // Parse architecture metadata from config.json (if found during scan)
      let arch = null;
      if (archStr && archStr.startsWith('{')) {
        try {
          const raw = JSON.parse(archStr);
          arch = {
            layers: raw.num_hidden_layers || null,
            kvHeads: raw.num_key_value_heads || null,
            headDim: raw.head_dim || null,
            hiddenSize: raw.hidden_size || null,
            intermediateSize: raw.intermediate_size || null,
            kvLayers: raw.kvLayers || null,
          };
        } catch { /* ignore malformed JSON */ }
      }

      if (Object.keys(formats).length > 0) {
        const entry = { family, variant, formats };
        if (arch) entry.arch = arch;
        models.push(entry);
      }
    }
    return models;
  }

  // ─── HuggingFace Architecture Enrichment ─────────────────────────────

  const HF_ORG_MAP = {
    'Qwen3.5': 'Qwen', 'Qwen-3': 'Qwen', 'Qwen-2.5': 'Qwen', 'Qwen3': 'Qwen',
    'Llama-3': 'meta-llama', 'Llama-3.1': 'meta-llama', 'Llama-3.3': 'meta-llama',
    'Gemma-2': 'google', 'Gemma-3': 'google', 'MedGemma': 'google',
    'Mistral': 'mistralai', 'Mixtral': 'mistralai',
    'Phi-3': 'microsoft', 'Phi-4': 'microsoft',
    'DeepSeek': 'deepseek-ai',
    'Behemoth': 'TheDrummer', 'Rocinante': 'TheDrummer',
    'Cydonia': 'TheDrummer', 'Donnager': 'TheDrummer',
    'GLM': 'THUDM',
    'MiniMax': 'MiniMaxAI',
    'Step': 'stepfun-ai',
    'Aya-Expanse': 'CohereForAI',
    'InternLM': 'internlm',
  };

  function resolveHfRepo(family, variant) {
    const org = HF_ORG_MAP[family];
    if (!org) return null;
    const modelName = `${family.replace(/-/g, '')}-${variant}`.replace(/\s+/g, '-');
    return `${org}/${modelName}`;
  }

  function parseArchFromConfig(jsonStr) {
    try {
      const raw = JSON.parse(jsonStr);
      const tc = raw.text_config || raw;
      const arch = {
        layers: tc.num_hidden_layers || null,
        kvHeads: tc.num_key_value_heads || null,
        headDim: tc.head_dim || null,
        hiddenSize: tc.hidden_size || null,
        intermediateSize: tc.intermediate_size || null,
        kvLayers: null,
      };
      const lt = tc.layer_types;
      if (Array.isArray(lt) && lt.length > 0) {
        arch.kvLayers = lt.filter(t => t === 'full_attention').length;
      }
      if (!arch.layers) return null;
      return arch;
    } catch { return null; }
  }

  async function enrichArchitectureFromHF(models, target) {
    const missing = models.filter(m => !m.arch);
    if (missing.length === 0) return;

    // Build batch download commands for models we can resolve to HF repos
    const downloads = [];
    for (const m of missing) {
      const repo = resolveHfRepo(m.family, m.variant);
      if (!repo) continue;
      const destDir = `/models/${m.family}/${m.variant}`;
      downloads.push({
        model: m,
        repo,
        cmd: `curl -sfL "https://huggingface.co/${repo}/resolve/main/config.json" -o "${destDir}/config.json" 2>/dev/null`,
        readCmd: `cat "${destDir}/config.json" 2>/dev/null`,
      });
    }

    if (downloads.length === 0) return;

    // Download all missing config.json files in one SSH command
    const dlScript = downloads.map(d => d.cmd).join('\n');
    try {
      const b64 = Buffer.from(dlScript).toString('base64');
      await sshService.exec(target.hostIp,
        `pct exec ${target.vmid} -- bash -c 'echo ${b64} | base64 -d | bash'`,
        { timeout: 60000 });
    } catch {
      // Download failures are non-blocking
      return;
    }

    // Now read the downloaded configs and parse architecture
    const readScript = downloads.map(d => `echo "CFG|${d.model.family}|${d.model.variant}|$(${d.readCmd})"`).join('\n');
    try {
      const b64 = Buffer.from(readScript).toString('base64');
      const result = await sshService.exec(target.hostIp,
        `pct exec ${target.vmid} -- bash -c 'echo ${b64} | base64 -d | bash'`,
        { timeout: 30000 });

      for (const line of (result.stdout || '').split('\n')) {
        if (!line.startsWith('CFG|')) continue;
        const [, fam, vari, ...jsonParts] = line.split('|');
        const jsonStr = jsonParts.join('|').trim();
        if (!jsonStr || !jsonStr.startsWith('{')) continue;
        const arch = parseArchFromConfig(jsonStr);
        if (arch) {
          const m = models.find(x => x.family === fam && x.variant === vari);
          if (m) m.arch = arch;
        }
      }
    } catch {
      // Parse failures are non-blocking
    }
  }

  /** Run a full or filtered scan via SSH + pct exec. Returns { models, scannedAt, scannedFrom, vmid }. */
  async function runScan(familyFilter) {
    const target = findRunningAgent();
    if (!target) throw new Error('No running agent container found. Start an agent first.');

    const scanScript = buildScanScript(familyFilter);
    const b64Script = Buffer.from(scanScript).toString('base64');
    const cmd = `pct exec ${target.vmid} -- bash -c 'echo ${b64Script} | base64 -d | bash'`;
    const result = await sshService.exec(target.hostIp, cmd, { timeout: 120000 });
    const models = parseScanOutput(result.stdout);

    // Enrich models missing architecture metadata from HuggingFace
    await enrichArchitectureFromHF(models, target);

    return {
      models,
      scannedAt: new Date().toISOString(),
      scannedFrom: target.node,
      vmid: target.vmid,
    };
  }

  /** Persist scan result to disk and in-memory cache. */
  function cacheResult(data) {
    modelScanCache = { data, ts: Date.now() };
    saveModelIndex(data);
  }

  /**
   * GET /models/scan — Serve model index from disk (instant), or run full SSH scan with ?refresh=1.
   * First-ever load (no index file) triggers a full scan automatically.
   */
  router.get('/models/scan', async (req, res) => {
    const forceRefresh = req.query.refresh === '1';

    if (!forceRefresh) {
      // Serve from in-memory cache if fresh
      if (modelScanCache.data && (Date.now() - modelScanCache.ts) < MODEL_SCAN_TTL) {
        return res.json(modelScanCache.data);
      }
      // Serve from disk index
      const diskIndex = loadModelIndex();
      if (diskIndex) {
        modelScanCache = { data: diskIndex, ts: Date.now() };
        return res.json(diskIndex);
      }
      // No index at all — fall through to full scan
    }

    try {
      const data = await runScan();
      cacheResult(data);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: `Scan failed: ${err.message}` });
    }
  });

  /**
   * POST /models/scan/family — Targeted rescan for one family (or family/variant).
   * Body: { family, variant? }
   * Merges results into existing index, replacing matching entries.
   */
  router.post('/models/scan/family', async (req, res) => {
    const { family, variant } = req.body || {};
    if (!family) return res.status(400).json({ error: 'family is required' });

    try {
      const data = await runScan(family);
      const scannedModels = variant
        ? data.models.filter(m => m.variant === variant)
        : data.models;

      // Merge into existing index
      const existing = loadModelIndex() || { models: [], scannedAt: null, scannedFrom: null, vmid: null };
      // Remove old entries for this family (or family+variant)
      const filtered = existing.models.filter(m => {
        if (m.family !== family) return true;
        if (variant && m.variant !== variant) return true;
        return false;
      });
      // Add fresh scan results
      filtered.push(...scannedModels);
      filtered.sort((a, b) => a.family.localeCompare(b.family) || a.variant.localeCompare(b.variant));

      const merged = {
        models: filtered,
        scannedAt: data.scannedAt,
        scannedFrom: data.scannedFrom,
        vmid: data.vmid,
      };
      cacheResult(merged);
      res.json(merged);
    } catch (err) {
      res.status(500).json({ error: `Family scan failed: ${err.message}` });
    }
  });

  /**
   * POST /models/enrich — Re-fetch config.json from HuggingFace for all models missing architecture.
   * Useful after adding new models without rescanning.
   */
  router.post('/models/enrich', async (req, res) => {
    try {
      const target = findRunningAgent();
      if (!target) return res.status(500).json({ error: 'No running agent container found.' });

      const existing = loadModelIndex();
      if (!existing?.models?.length) return res.status(400).json({ error: 'No model index found. Run a scan first.' });

      const before = existing.models.filter(m => m.arch).length;
      await enrichArchitectureFromHF(existing.models, target);
      const after = existing.models.filter(m => m.arch).length;

      cacheResult(existing);
      res.json({ enriched: after - before, total: existing.models.length, withArch: after });
    } catch (err) {
      res.status(500).json({ error: `Enrichment failed: ${err.message}` });
    }
  });

  /** Background scan — runs silently, logs result. */
  async function backgroundScan() {
    try {
      const data = await runScan();
      cacheResult(data);
      console.log(`[model-index] Background scan complete: ${data.models.length} models`);
    } catch (err) {
      console.error(`[model-index] Background scan failed: ${err.message}`);
    }
  }

  function startScanTimer(intervalMinutes) {
    if (scanTimer) clearInterval(scanTimer);
    if (intervalMinutes <= 0) return;
    scanTimer = setInterval(backgroundScan, intervalMinutes * 60 * 1000);
  }

  function stopScanTimer() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  }

  // ─── Model Folder Scaffolding ────────────────────────────────────────

  /**
   * POST /models/scaffold — Create missing format/quant sub-directories for models.
   *
   * Scans /models/{family}/{variant}/ and creates the full directory structure
   * for all supported quantization formats and sizes.
   *
   * Body: { dryRun? }  — if true, only report what would be created
   *
   * Returns: { created: string[], existing: string[], errors: string[] }
   */
  router.post('/models/scaffold', async (req, res) => {
    const { dryRun = false } = req.body || {};

    const cfg = loadAiConfig();
    const agents = cfg.agents || {};
    const guests = pveApi.getGuests();
    const nodeMap = pveApi.getNodeMap();

    // Find first running agent container
    let targetVmid = null, targetHostIp = null;
    for (const [node, agent] of Object.entries(agents)) {
      if (!agent.vmid) continue;
      const guest = guests.find(g => g.vmid === agent.vmid);
      if (guest?.status === 'running') {
        const hostIp = nodeMap[node]?.ip;
        if (hostIp) {
          targetVmid = agent.vmid;
          targetHostIp = hostIp;
          break;
        }
      }
    }

    if (!targetVmid) {
      return res.status(400).json({ error: 'No running agent container found.' });
    }

    // Define the canonical folder structure
    const ggufQuants = [
      'Q8_0', 'Q6_K', 'Q6_K_L', 'Q5_K_M', 'Q5_K_S', 'Q5_K_L',
      'Q4_K_M', 'Q4_K_S', 'Q4_K_L', 'Q4_0',
      'Q3_K_M', 'Q3_K_S', 'Q3_K_L',
      'Q2_K', 'Q2_K_S',
      'IQ4_XS', 'IQ3_M', 'IQ3_S', 'IQ2_M',
    ];
    const exlBpws = ['2.0', '2.5', '3.0', '3.5', '4.0', '4.25', '4.5', '4.75', '5.0', '5.5', '6.0', '8.0'];
    const awqBits = ['4-bit', '8-bit'];
    const gptqBits = ['2-bit', '3-bit', '4-bit', '8-bit'];

    const formatDefs = {
      GGUF: ggufQuants,
      EXL2: exlBpws,
      EXL3: exlBpws,
      AWQ: awqBits,
      GPTQ: gptqBits,
      'FP16-Safetensors': [],
      'BF16-Safetensors': [],
    };

    // Build the scaffold script
    const action = dryRun ? 'echo "WOULD_CREATE|$dir"' : 'mkdir -p "$dir" && echo "CREATED|$dir"';
    const formatLines = [];
    for (const [fmt, subs] of Object.entries(formatDefs)) {
      if (subs.length === 0) {
        formatLines.push(`dir="$variant_dir/${fmt}"; [ -d "$dir" ] && echo "EXISTS|$dir" || { ${action}; }`);
      } else {
        for (const sub of subs) {
          formatLines.push(`dir="$variant_dir/${fmt}/${sub}"; [ -d "$dir" ] && echo "EXISTS|$dir" || { ${action}; }`);
        }
      }
    }

    const scaffoldScript = [
      'if [ ! -d /models ]; then echo "ERROR|/models directory not found"; exit 0; fi',
      'find /models -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sort | while read variant_dir; do',
      ...formatLines.map(l => '  ' + l),
      'done',
    ].join('\n');

    try {
      const b64Script = Buffer.from(scaffoldScript).toString('base64');
      const cmd = `pct exec ${targetVmid} -- bash -c 'echo ${b64Script} | base64 -d | bash'`;
      const result = await sshService.exec(targetHostIp, cmd, { timeout: 60000 });

      const created = [];
      const existing = [];
      const wouldCreate = [];
      const errors = [];

      for (const line of result.stdout.split('\n').filter(Boolean)) {
        const pipeIdx = line.indexOf('|');
        if (pipeIdx < 0) continue;
        const status = line.substring(0, pipeIdx);
        const path = line.substring(pipeIdx + 1);
        if (status === 'CREATED') created.push(path);
        else if (status === 'EXISTS') existing.push(path);
        else if (status === 'WOULD_CREATE') wouldCreate.push(path);
        else if (status === 'ERROR') errors.push(path);
      }

      // Invalidate model scan cache since folders changed
      if (!dryRun && created.length > 0) {
        modelScanCache = { data: null, ts: 0 };
      }

      res.json({
        dryRun,
        created: dryRun ? wouldCreate : created,
        existing: existing.length,
        errors,
      });
    } catch (err) {
      res.status(500).json({ error: `Scaffold failed: ${err.message}` });
    }
  });

  // ─── Model Inspection ─────────────────────────────────────────────────

  /**
   * POST /models/inspect — Inspect a model file's internal structure.
   *
   * Reads the header of a GGUF or SafeTensors file from an agent container
   * and returns layer-by-layer tensor info, metadata, and size summary.
   *
   * Body: { path }  — full path to the model file on the agent (e.g. /models/qwen3/.../Q6_K/model.gguf)
   *   OR: { dir }   — directory path; will auto-find the first .gguf or .safetensors file
   *
   * Query: ?compact=1 — omit per-tensor details, return only layer summaries
   *
   * Returns: { format, metadata, layers, nonLayerGroups, summary }
   */
  router.post('/models/inspect', async (req, res) => {
    const { path: filePath, dir } = req.body;
    const compact = req.query.compact === '1';

    if (!filePath && !dir) {
      return res.status(400).json({ error: 'path or dir is required' });
    }

    // Find a running agent container
    const cfg = loadAiConfig();
    const guests = pveApi.getGuests();
    const nodeMap = pveApi.getNodeMap();
    let targetHostIp, targetVmid;

    for (const [node, agent] of Object.entries(cfg.agents || {})) {
      if (!agent.vmid) continue;
      const guest = guests.find(g => g.vmid === agent.vmid);
      if (guest?.status === 'running') {
        const hostIp = nodeMap[node]?.ip;
        if (hostIp) {
          targetHostIp = hostIp;
          targetVmid = agent.vmid;
          break;
        }
      }
    }

    if (!targetHostIp) {
      return res.status(400).json({ error: 'No running agent container found' });
    }

    try {
      // Step 1: Resolve file path — if a dir was given, find the model file
      let resolvedPath = filePath;
      if (dir) {
        // Find model files — search recursively (some HF downloads nest in subdirs)
        const findCmd = `pct exec ${targetVmid} -- bash -c 'find "${dir}" -maxdepth 3 \\( -name "*.gguf" -o -name "*.safetensors" \\) -type f 2>/dev/null | sort | head -60'`;
        const lsResult = await sshService.exec(targetHostIp, findCmd, { timeout: 15000 });
        const files = lsResult.stdout.trim().split('\n').filter(f => f && (f.endsWith('.gguf') || f.endsWith('.safetensors')));

        // Prefer .gguf shard 1, then .safetensors shard 1
        const gguf = files.find(f => f.endsWith('.gguf'));
        const safetensor = files.find(f => f.endsWith('.safetensors'));
        if (gguf) {
          resolvedPath = gguf;
        } else if (safetensor) {
          resolvedPath = safetensor;
        } else {
          return res.status(404).json({ error: `No .gguf or .safetensors file found in ${dir}`, files });
        }
      }

      // Step 2: Get file size (filter pct exec noise — it can emit ANSI codes and PVE warnings)
      const sizeCmd = `pct exec ${targetVmid} -- bash -c 'stat -c "%s" "${resolvedPath}"'`;
      const sizeResult = await sshService.exec(targetHostIp, sizeCmd, { timeout: 10000 });
      const sizeLine = sizeResult.stdout.trim().split('\n').filter(l => /^\d+$/.test(l.trim())).pop();
      const fileSize = parseInt(sizeLine, 10);
      if (!fileSize || isNaN(fileSize)) {
        return res.status(404).json({ error: `File not found or empty: ${resolvedPath}`, raw: sizeResult.stdout });
      }

      // Step 3: Determine format and how many bytes to read
      // Read first 16 bytes to detect format (use MARKER to isolate output from pct exec noise)
      const peekCmd = `pct exec ${targetVmid} -- bash -c 'echo "===B64START==="; dd if="${resolvedPath}" bs=16 count=1 2>/dev/null | base64; echo "===B64END==="'`;
      const peekResult = await sshService.exec(targetHostIp, peekCmd, { timeout: 10000 });
      const peekB64 = extractBetweenMarkers(peekResult.stdout, '===B64START===', '===B64END===');
      const peekBuf = Buffer.from(peekB64, 'base64');
      const format = detectFormat(peekBuf);

      let readBytes;
      if (format === 'gguf') {
        readBytes = recommendedHeaderSize(fileSize);
      } else if (format === 'safetensors') {
        // For safetensors, first read just the header length (8 bytes), then read header
        const headerLen = Number(peekBuf.readBigUInt64LE(0));
        readBytes = Math.min(8 + headerLen + 64, fileSize); // +64 for safety margin
      } else {
        return res.status(400).json({ error: `Unknown format for ${resolvedPath}` });
      }

      // Step 4: Read header bytes via base64-encoded dd (use markers to isolate from pct noise)
      const readMB = Math.ceil(readBytes / (1024 * 1024));
      const ddCmd = `pct exec ${targetVmid} -- bash -c 'echo "===B64START==="; dd if="${resolvedPath}" bs=1M count=${readMB} 2>/dev/null | base64 -w0; echo; echo "===B64END==="'`;
      const ddResult = await sshService.exec(targetHostIp, ddCmd, { timeout: 60000 });
      const headerB64 = extractBetweenMarkers(ddResult.stdout, '===B64START===', '===B64END===');
      const headerBuf = Buffer.from(headerB64, 'base64');

      // Step 5: Parse first shard
      const fileName = resolvedPath.split('/').pop();
      const result = inspectModel(headerBuf, { fileName, fileSize });
      result.inspectedPath = resolvedPath;
      result.fileSizeMB = Math.round(fileSize / (1024 * 1024));

      // Step 6: Handle multi-shard models
      const shardMatch = fileName.match(/-(\d+)-of-(\d+)\.(gguf|safetensors)$/i);
      const parentDir = resolvedPath.substring(0, resolvedPath.lastIndexOf('/'));
      if (shardMatch) {
        const totalShards = parseInt(shardMatch[2], 10);
        const ext = shardMatch[3];

        if (totalShards > 1) {
          result.multiShard = true;
          result.shardCount = totalShards;

          if (ext === 'safetensors') {
            // ── SafeTensors multi-shard: use index.json + extrapolation ──
            // Instead of reading all N shards (slow over SSH), read the index.json
            // which lists all tensor names, then extrapolate layer sizes from shard 1.
            try {
              const indexPath = `${parentDir}/model.safetensors.index.json`;
              const idxCmd = `pct exec ${targetVmid} -- bash -c 'echo "===B64START==="; cat "${indexPath}" 2>/dev/null | base64 -w0; echo; echo "===B64END==="'`;
              const idxResult = await sshService.exec(targetHostIp, idxCmd, { timeout: 15000 });
              const idxB64 = extractBetweenMarkers(idxResult.stdout, '===B64START===', '===B64END===');
              if (idxB64) {
                const indexJson = JSON.parse(Buffer.from(idxB64, 'base64').toString('utf8'));
                const weightMap = indexJson.weight_map || {};

                // Build per-layer tensor name lists from the index
                const allTensorNames = Object.keys(weightMap);
                const layerTensorsByIdx = {};
                const nonLayerTensorNames = [];

                for (const name of allTensorNames) {
                  let layerIdx = null;
                  const m = name.match(/layers?\.(\d+)\./);
                  if (m) layerIdx = parseInt(m[1], 10);
                  if (layerIdx !== null) {
                    if (!layerTensorsByIdx[layerIdx]) layerTensorsByIdx[layerIdx] = [];
                    layerTensorsByIdx[layerIdx].push(name);
                  } else {
                    nonLayerTensorNames.push(name);
                  }
                }

                // We have per-tensor sizes from shard 1. Use them as a template.
                // For each tensor in the index, find a matching tensor shape from our parsed shard.
                const tensorSizeCache = {};
                for (const layer of result.layers) {
                  for (const t of (layer.tensors || [])) {
                    // Key: the "role" part after removing the layer prefix
                    // e.g., "model.layers.0.self_attn.q_proj.weight" → "self_attn.q_proj.weight"
                    const role = t.name.replace(/^.*?layers?\.\d+\./, '');
                    tensorSizeCache[role] = t.sizeBytes;
                  }
                }
                // Also cache non-layer tensor sizes
                for (const [, group] of Object.entries(result.nonLayerGroups || {})) {
                  for (const t of (group.tensors || [])) {
                    tensorSizeCache[t.name] = t.sizeBytes;
                  }
                }

                // Rebuild complete layer map using extrapolation
                const fullLayers = [];
                for (const [idxStr, tensors] of Object.entries(layerTensorsByIdx)) {
                  const idx = parseInt(idxStr, 10);
                  let layerBytes = 0;
                  for (const tName of tensors) {
                    const role = tName.replace(/^.*?layers?\.\d+\./, '');
                    layerBytes += tensorSizeCache[role] || 0;
                  }
                  fullLayers.push({ index: idx, totalBytes: layerBytes, totalMB: Math.round(layerBytes / (1024 * 1024) * 10) / 10 });
                }
                fullLayers.sort((a, b) => a.index - b.index);

                // Calculate non-layer sizes
                let nonLayerBytes = 0;
                for (const name of nonLayerTensorNames) {
                  nonLayerBytes += tensorSizeCache[name] || 0;
                }

                result.layers = fullLayers;
                result.summary.totalLayers = fullLayers.length;
                result.summary.totalTensors = allTensorNames.length;

                const layerSizes = fullLayers.map(l => l.totalBytes);
                const totalLayerBytes = layerSizes.reduce((a, b) => a + b, 0);
                result.summary.totalModelBytes = totalLayerBytes + nonLayerBytes;
                result.summary.totalModelMB = Math.round((totalLayerBytes + nonLayerBytes) / (1024 * 1024));
                result.summary.layerMB = {
                  min: layerSizes.length ? Math.round(Math.min(...layerSizes) / (1024 * 1024) * 10) / 10 : 0,
                  max: layerSizes.length ? Math.round(Math.max(...layerSizes) / (1024 * 1024) * 10) / 10 : 0,
                  avg: layerSizes.length ? Math.round(layerSizes.reduce((a, b) => a + b, 0) / layerSizes.length / (1024 * 1024) * 10) / 10 : 0,
                };
                result.summary.nonLayerBytes = nonLayerBytes;
                result.note = `Layer sizes extrapolated from shard 1 tensor shapes across all ${totalShards} shards via index.json`;
              }
            } catch (idxErr) {
              result.note = `Could not read index.json: ${idxErr.message}. Showing shard 1 only.`;
            }
          } else {
            // ── GGUF multi-shard: parse each shard header ──
            result.shardFiles = [fileName];

            for (let s = 2; s <= totalShards; s++) {
              const shardSuffix = `-${String(s).padStart(shardMatch[1].length, '0')}-of-${shardMatch[2]}.${ext}`;
              const shardPattern = fileName.replace(/-\d+-of-\d+\.\w+$/, shardSuffix);
              const shardPath = `${parentDir}/${shardPattern}`;

              try {
                const sSizeCmd = `pct exec ${targetVmid} -- bash -c 'stat -c "%s" "${shardPath}"'`;
                const sSizeResult = await sshService.exec(targetHostIp, sSizeCmd, { timeout: 10000 });
                const sSizeLine = sSizeResult.stdout.trim().split('\n').filter(l => /^\d+$/.test(l.trim())).pop();
                const sFileSize = parseInt(sSizeLine, 10);
                if (!sFileSize) continue;

                const sReadMB = Math.ceil(recommendedHeaderSize(sFileSize) / (1024 * 1024));
                const sDdCmd = `pct exec ${targetVmid} -- bash -c 'echo "===B64START==="; dd if="${shardPath}" bs=1M count=${sReadMB} 2>/dev/null | base64 -w0; echo; echo "===B64END==="'`;
                const sDdResult = await sshService.exec(targetHostIp, sDdCmd, { timeout: 60000 });
                const sB64 = extractBetweenMarkers(sDdResult.stdout, '===B64START===', '===B64END===');
                const sBuf = Buffer.from(sB64, 'base64');
                const shardResult = inspectModel(sBuf, { fileName: shardPattern, fileSize: sFileSize });

                for (const layer of shardResult.layers) {
                  const existing = result.layers.find(l => l.index === layer.index);
                  if (existing) {
                    existing.totalBytes += layer.totalBytes;
                    existing.totalMB = Math.round(existing.totalBytes / (1024 * 1024) * 10) / 10;
                    if (!compact) existing.tensors = (existing.tensors || []).concat(layer.tensors || []);
                  } else {
                    result.layers.push(layer);
                  }
                }
                for (const [cat, group] of Object.entries(shardResult.nonLayerGroups || {})) {
                  if (!result.nonLayerGroups[cat]) {
                    result.nonLayerGroups[cat] = group;
                  } else {
                    result.nonLayerGroups[cat].totalBytes += group.totalBytes;
                    result.nonLayerGroups[cat].totalMB = Math.round(result.nonLayerGroups[cat].totalBytes / (1024 * 1024) * 10) / 10;
                    if (!compact) {
                      result.nonLayerGroups[cat].tensors = (result.nonLayerGroups[cat].tensors || []).concat(group.tensors || []);
                    }
                  }
                }
                result.fileSizeMB += Math.round(sFileSize / (1024 * 1024));
                result.shardFiles.push(shardPattern);
              } catch (shardErr) {
                result.shardErrors = result.shardErrors || [];
                result.shardErrors.push({ shard: s, error: shardErr.message });
              }
            }

            // Recalculate summary after merging all shards
            result.layers.sort((a, b) => a.index - b.index);
            const layerSizes = result.layers.map(l => l.totalBytes);
            const totalLayerBytes = layerSizes.reduce((a, b) => a + b, 0);
            const totalNonLayerBytes = Object.values(result.nonLayerGroups || {}).reduce((a, g) => a + (g.totalBytes || 0), 0);
            const allTensorCount = result.layers.reduce((n, l) => n + (l.tensors?.length || 0), 0)
              + Object.values(result.nonLayerGroups || {}).reduce((n, g) => n + (g.tensors?.length || 0), 0);
            result.summary = {
              ...result.summary,
              totalTensors: allTensorCount || result.summary.totalTensors,
              totalLayers: result.layers.length,
              totalModelBytes: totalLayerBytes + totalNonLayerBytes,
              totalModelMB: Math.round((totalLayerBytes + totalNonLayerBytes) / (1024 * 1024)),
              layerMB: {
                min: layerSizes.length ? Math.round(Math.min(...layerSizes) / (1024 * 1024) * 10) / 10 : 0,
                max: layerSizes.length ? Math.round(Math.max(...layerSizes) / (1024 * 1024) * 10) / 10 : 0,
                avg: layerSizes.length ? Math.round(layerSizes.reduce((a, b) => a + b, 0) / layerSizes.length / (1024 * 1024) * 10) / 10 : 0,
              },
              nonLayerBytes: totalNonLayerBytes,
            };
          }
        }
      }

      // Compact mode: strip per-tensor details
      if (compact) {
        for (const layer of result.layers) {
          delete layer.tensors;
        }
        for (const group of Object.values(result.nonLayerGroups || {})) {
          delete group.tensors;
        }
      }

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `Inspection failed: ${err.message}` });
    }
  });

  // ─── Model Launch ──────────────────────────────────────────────────────

  /** GET /next-port — a conflict-free port for the launcher (blank Port field = auto-assign). Scans
   *  active-services + in-flight reservations; reserves the returned port for ~5 min. */
  router.get('/next-port', (_req, res) => {
    try { res.json({ port: getNextPort() }); }
    catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
  });

  /**
   * POST /launch — Launch a model on an agent container via tmux.
   * Writes the command to a temp script, wraps in tmux new-session + attach.
   *
   * Body: { node, providerId, command, port, tmuxSession }
   * Returns: { vmid, pveHostIp, node, tmuxSession, port, command }
   *   where command is the combined bash one-liner that creates the script,
   *   starts tmux, and attaches.
   */
  router.post('/launch', (req, res) => {
    const { node, providerId, port, tmuxSession } = req.body;
    let command = req.body.command;

    // Cache-proof guard: older launcher JS baked literal single quotes into the
    // --chat-template-kwargs value, emitting ''\''{...}'\''' which bash collapses to
    // '{...}' (literal quotes) and breaks llama.cpp's JSON parser. Re-emit the JSON
    // object with exactly one layer of shell quoting. Idempotent on clean commands;
    // also covers vLLM's --default-chat-template-kwargs.
    if (typeof command === 'string') {
      command = command.replace(
        /(--(?:default-)?chat-template-kwargs)\s+\S*?(\{[^}]*\})\S*/g,
        "$1 '$2'");
    }

    if (!node || !providerId || !command) {
      return res.status(400).json({ error: 'node, providerId, and command are required' });
    }

    if (!getProvider(providerId)) {
      return res.status(404).json({ error: `Unknown provider: ${providerId}` });
    }

    const cfg = loadAiConfig();
    const agent = cfg.agents?.[node];
    if (!agent?.vmid) {
      return res.status(400).json({ error: `No agent designated for node ${node}` });
    }

    const nodeMap = pveApi.getNodeMap();
    const pveHostIp = nodeMap[node]?.ip;
    if (!pveHostIp) {
      return res.status(400).json({ error: `Cannot resolve PVE host IP for node ${node}` });
    }

    // Build tmux-wrapped command using temp-script approach to avoid quote nesting
    const session = tmuxSession || `${providerId}-${port || 5001}`;
    const scriptPath = `/tmp/.llm-${session}.sh`;
    const logFile = `/var/log/proxlab/${session}.log`;

    // The command from frontend is a raw multi-line string (export + exec line)
    // We encode it as base64 to avoid any quoting issues through pct exec layers.
    // Trap EXIT to keep the terminal open on crash so the user can read errors.
    // Diagnostic header echoes key launch variables so the log captures what was actually used.
    const diag = [
      'echo -e "\\e[36m─── ProxLab Launch ───\\e[0m"',
      `echo -e "\\e[36mProvider:\\e[0m  ${providerId}"`,
      `echo -e "\\e[36mNode:\\e[0m      ${node}"`,
      `echo -e "\\e[36mSession:\\e[0m   ${session}"`,
      `echo -e "\\e[36mPort:\\e[0m      ${port || 'auto'}"`,
      'echo -e "\\e[36mCUDA_VISIBLE_DEVICES:\\e[0m ${CUDA_VISIBLE_DEVICES:-not set}"',
    ];
    // For kcpps launches, decode the base64 config to extract model path + settings
    const b64Match = command.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/);
    if (b64Match) {
      try {
        const kcpps = JSON.parse(Buffer.from(b64Match[1], 'base64').toString());
        diag.push(`echo -e "\\e[36mModel:\\e[0m     ${kcpps.model_param || 'unknown'}"`);
        diag.push(`echo -e "\\e[36mFlash Attn:\\e[0m ${kcpps.flashattention ? 'enabled' : 'disabled'}"`);
        diag.push(`echo -e "\\e[36mContext:\\e[0m    ${kcpps.contextsize || '?'}"`);
        diag.push(`echo -e "\\e[36mGPU Layers:\\e[0m ${kcpps.gpulayers || '?'}"`);
        diag.push(`echo -e "\\e[36mQuantKV:\\e[0m    ${kcpps.quantkv || 0}"`);
        diag.push(`echo -e "\\e[36mSmartCache:\\e[0m ${kcpps.smartcache || 0}"`);
        if (kcpps.tensor_split) diag.push(`echo -e "\\e[36mTensor Split:\\e[0m ${JSON.stringify(kcpps.tensor_split)}"`);
      } catch {}
    }
    diag.push('echo -e "\\e[36m─────────────────────\\e[0m"');

    const scriptContent = `#!/bin/bash\ntrap 'echo -e "\\n\\e[33m[Process exited with code \\$?]\\e[0m"; read -r -p "Press Enter to close..."' EXIT\n${diag.join('\n')}\n${command}\n`;
    const b64Script = Buffer.from(scriptContent).toString('base64');

    // Combined command: decode script, create detached tmux session, then attach.
    // Split into new-session -d + attach so tmux creation doesn't need a TTY
    // (pct exec doesn't always forward the PTY for new-session in attached mode).
    // After creating the session, tmux pipe-pane captures all pane output to a
    // persistent log file at /var/log/proxlab/ so logs survive service shutdown.
    const combinedCommand = `bash -c 'tmux kill-session -t "${session}" 2>/dev/null; echo ${b64Script} | base64 -d > ${scriptPath} && chmod +x ${scriptPath} && tmux new-session -d -s "${session}" "bash ${scriptPath}" && mkdir -p /var/log/proxlab && : > ${logFile} && tmux pipe-pane -t "${session}" -o "cat >> ${logFile}" && exec tmux attach -t "${session}"'`;

    res.json({
      vmid: agent.vmid,
      pveHostIp,
      node,
      tmuxSession: session,
      port: port || null,
      command: combinedCommand,
    });
  });

  // ─── Launch as Systemd Service ──────────────────────────────────────────

  /**
   * POST /launch-service — Create a persistent systemd service inside a container.
   * Instead of tmux, writes a launch script + unit file, enables the service,
   * and registers it as an active service with isSystemService: true.
   *
   * Body: same as /launch plus model metadata fields for service registration.
   */
  router.post('/launch-service', async (req, res) => {
    const { node, providerId, port, tmuxSession,
            model, modelFamily, modelVariant, quantFormat, quantSize, contextSize,
            cudaDevices, gpuPciIds: explicitGpuPciIds,
            reservedVramMB: reqReservedVramMB, isTts, isTools, isImageGen, isStt,
            slots: reqSlots } = req.body;
    let command = req.body.command;

    // Cache-proof guard: older launcher JS baked literal single quotes into the
    // --chat-template-kwargs value, emitting ''\''{...}'\''' which bash collapses to
    // '{...}' (literal quotes) and breaks llama.cpp's JSON parser. Re-emit the JSON
    // object with exactly one layer of shell quoting. Idempotent on clean commands;
    // also covers vLLM's --default-chat-template-kwargs.
    if (typeof command === 'string') {
      command = command.replace(
        /(--(?:default-)?chat-template-kwargs)\s+\S*?(\{[^}]*\})\S*/g,
        "$1 '$2'");
    }

    if (!node || !providerId || !command) {
      return res.status(400).json({ error: 'node, providerId, and command are required' });
    }
    if (!getProvider(providerId)) {
      return res.status(404).json({ error: `Unknown provider: ${providerId}` });
    }

    const cfg = loadAiConfig();
    const agent = cfg.agents?.[node];
    if (!agent?.vmid) {
      return res.status(400).json({ error: `No agent designated for node ${node}` });
    }

    const nodeMap = pveApi.getNodeMap();
    const pveHostIp = nodeMap[node]?.ip;
    if (!pveHostIp) {
      return res.status(400).json({ error: `Cannot resolve PVE host IP for node ${node}` });
    }

    const session = tmuxSession || `${providerId}-${port || 5001}`;
    const unitName = `proxlab-${session}`;
    const scriptPath = `/opt/proxlab/services/${session}.sh`;
    const logFile = `/var/log/proxlab/${session}.log`;

    // Check for duplicate: is this unit already active?
    try {
      const checkResult = await sshService.exec(pveHostIp,
        `pct exec ${agent.vmid} -- systemctl is-active ${unitName} 2>/dev/null`, { timeout: 5000 });
      if (checkResult.code === 0) {
        return res.status(409).json({ error: `Service ${unitName} is already running` });
      }
    } catch {} // not running or systemctl not found — proceed

    // Rewrite model paths to use cache when available
    // For kcpps configs, replace /models/ paths with /model-cache/ if the file exists in cache
    let finalCommand = command;
    let mcHelper = '';
    if (isCacheEnabled(node)) {
      const cachePath = getCachePath(node);
      // ── Dynamic model-path resolution (#265) ──
      // Wrap every /models/<rel> or <cachePath>/<rel> token in the command with a shell
      // resolver `mc`, so the generated script re-picks cache-if-present-else-NAS on EVERY
      // start/restart/boot — never frozen at creation. Handles either baked form (a legacy
      // script with a /model-cache path resolves back to /models when the cache is absent).
      // (kcpps base64 + tts/imagegen dir swaps below are untouched: those paths aren't literal
      //  /models tokens, so the regex skips them.)
      const escCache = cachePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const modelPathRe = new RegExp('((?:/models|' + escCache + ')/[^\\s"\'\\\\]+)', 'g');
      if (modelPathRe.test(finalCommand)) {
        finalCommand = finalCommand.replace(modelPathRe, (m) => "$(mc '" + m + "')");
        mcHelper =
          'mc(){ p="$1"; case "$p" in\n' +
          '  ' + cachePath + '/*) c="$p"; n="/models/${p#' + cachePath + '/}";;\n' +
          '  /models/*) n="$p"; c="' + cachePath + '/${p#/models/}";;\n' +
          '  *) printf "%s" "$p"; return ;; esac\n' +
          '  if [ -e "$c" ]; then printf "%s" "$c"; else printf "%s" "$n"; fi; }\n';
      }
      const b64Cfg = command.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/);
      if (b64Cfg) {
        try {
          const kcpps = JSON.parse(Buffer.from(b64Cfg[1], 'base64').toString());
          let changed = false;
          for (const field of ['model_param', 'mmproj']) {
            if (kcpps[field] && typeof kcpps[field] === 'string' && kcpps[field].startsWith('/models/')) {
              const cachePth = kcpps[field].replace(/^\/models\//, cachePath + '/');
              // Check if cached file exists (via pct exec)
              try {
                const hostIp = agent.hostIp || pveApi.getNodeMap()[node]?.ip;
                const checkCmd = `pct exec ${agent.vmid} -- test -f "${cachePth}" && echo EXISTS || echo MISS`;
                const checkResult = await sshService.exec(hostIp, checkCmd, { timeout: 5000 });
                if (checkResult.stdout.trim() === 'EXISTS') {
                  console.log(`[svc-launch] Cache hit: ${kcpps[field]} → ${cachePth}`);
                  kcpps[field] = cachePth;
                  changed = true;
                }
              } catch {}
            }
          }
          if (changed) {
            const newB64 = Buffer.from(JSON.stringify(kcpps)).toString('base64');
            finalCommand = command.replace(b64Cfg[1], newB64);
          }
        } catch {}
      }

      // Generic pass: rewrite cached /imagegen/ and /tts/ paths appearing as
      // literal strings in the command. Used by TTS provider launchers and any
      // other non-kcpps service that references model paths directly in argv.
      // Uses the manifest (sourceDir → cacheDir) as source of truth; longest
      // match wins so nested paths resolve correctly.
      const manifest = loadCacheManifest();
      const cachedDirs = manifest.entries
        .filter(e => e.node === node && e.cachedAt && (e.type === 'imagegen' || e.type === 'tts'))
        .map(e => ({ sourceDir: e.sourceDir, cacheDir: e.cacheDir }))
        .sort((a, b) => b.sourceDir.length - a.sourceDir.length);
      let rewriteCount = 0;
      for (const { sourceDir, cacheDir } of cachedDirs) {
        if (finalCommand.includes(sourceDir)) {
          finalCommand = finalCommand.split(sourceDir).join(cacheDir);
          rewriteCount++;
        }
      }
      if (rewriteCount > 0) {
        console.log(`[svc-launch] Rewrote ${rewriteCount} cached imagegen/tts path(s) for ${providerId}`);
      }
    }

    // Every llama.cpp / ik_llama.cpp launch gets a persistent Optane KV slot, ALWAYS named from a content
    // fingerprint: slug(model-file)-<fp>, where fp hashes only what changes the KV bytes (model file +
    // ctx + cache dtypes) — never the name override and never the GPUs/node. So the same model+settings
    // deterministically maps to one slot regardless of port, GPUs, or cosmetic alias. No tiering / no
    // honoring of a hand-set path (the launcher field is hidden); any existing --slot-save-path is replaced.
    // (Distinct from the metrics-row fingerprint, which DOES key on hardware — it identifies a perf run.)
    const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
    if (/^llama-server/.test(providerId)) {
      const mp = (finalCommand.match(/--model[ =]+"?([^"\s\\]+)"?/) || [])[1] || '';
      const modelName = mp.split('/').filter(Boolean).pop() || '';
      const ctx = (finalCommand.match(/--ctx-size[ =]+(\d+)/) || [])[1] || '';
      const ck = (finalCommand.match(/--cache-type-k[ =]+(\S+)/) || [])[1] || '';
      const cv = (finalCommand.match(/--cache-type-v[ =]+(\S+)/) || [])[1] || '';
      const fp = createHash('sha1').update([modelName, ctx, ck, cv].join('|')).digest('hex').slice(0, 8);
      const optanePath = `/optane-sock0/kvcache/${slug(modelName) ? `${slug(modelName)}-${fp}` : `svc-${port || 'x'}-${fp}`}`;
      if (/--slot-save-path[ =]/.test(finalCommand)) {
        finalCommand = finalCommand.replace(/--slot-save-path[ =]"?[^"\s\\]+"?/, `--slot-save-path ${optanePath}`);
      } else {
        finalCommand = finalCommand.replace(/\s+$/, '') + ` --slot-save-path ${optanePath}`;
      }
      console.log(`[svc-launch] Optane KV slot-save -> ${optanePath} (content fingerprint, always)`);
    }

    // Build the launch script content
    // PyInstaller-based providers (KoboldCpp) need isolated TMPDIR to prevent
    // _MEI* temp directory collisions that cause silent freezes
    const needsTmpdir = ['koboldcpp'].includes(providerId);
    const tmpdirLine = needsTmpdir ? `export TMPDIR="/tmp/proxlab-${session}"\nmkdir -p "$TMPDIR"\n` : '';
    // Ensure any --slot-save-path / --slots-save-path / --kv-save-path directory exists before exec.
    // Without this, llama-server bails on first start after a host reboot when the path lives in tmpfs.
    const slotPathDirs = [];
    const pathFlagRe = /--(?:slot|slots|kv)-save-path[ =]"?([^"\s\\]+)"?/g;
    let _m;
    while ((_m = pathFlagRe.exec(finalCommand)) !== null) {
      if (_m[1] && !slotPathDirs.includes(_m[1])) slotPathDirs.push(_m[1]);
    }
    const mkdirBlock = slotPathDirs.length
      ? slotPathDirs.map(p => `mkdir -p "${p}"`).join('\n') + '\n'
      : '';
    const scriptContent = `#!/bin/bash
# ProxLab managed service — ${providerId} on port ${port || 'auto'}
# Generated: ${new Date().toISOString()}
${mcHelper}${tmpdirLine}${mkdirBlock}${finalCommand}
`;
    const b64Script = Buffer.from(scriptContent).toString('base64');

    // Build the systemd unit file
    const unitContent = `[Unit]
Description=ProxLab ${providerId} service (${session})
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
ExecStart=/bin/bash ${scriptPath}
Restart=on-failure
RestartSec=30
TimeoutStartSec=600
TimeoutStopSec=60
StandardOutput=append:${logFile}
StandardError=append:${logFile}
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
`;
    const b64Unit = Buffer.from(unitContent).toString('base64');

    try {
      // Create directories, decode script + unit, enable service.
      // Use --no-block for start so systemctl returns immediately after
      // queueing the start job — avoids timing out while systemd waits
      // on the service process.
      const setupCmd = [
        `pct exec ${agent.vmid} -- bash -c '`,
        `mkdir -p /opt/proxlab/services /var/log/proxlab`,
        ` && echo ${b64Script} | base64 -d > ${scriptPath}`,
        ` && chmod +x ${scriptPath}`,
        ` && echo ${b64Unit} | base64 -d > /etc/systemd/system/${unitName}.service`,
        ` && systemctl daemon-reload`,
        ` && systemctl enable ${unitName}`,
        ` && systemctl start --no-block ${unitName}`,
        `'`,
      ].join('');

      const result = await sshService.exec(pveHostIp, setupCmd, { timeout: 60000 });
      if (result.code !== 0) {
        return res.status(500).json({
          error: `Failed to create service: ${(result.stderr || result.stdout || '').substring(0, 500)}`,
        });
      }
    } catch (err) {
      return res.status(500).json({ error: `SSH failed: ${err.message}` });
    }

    // Register as active service (reuses same logic as POST /active-services)
    const serviceId = `${session}-${Date.now()}`;
    const guests = pveApi.getGuests();
    const guest = guests.find(g => g.vmid === agent.vmid);
    let containerIp = guest?.ip || null;
    const containerName = guest?.name || `CT ${agent.vmid}`;

    if (!containerIp) {
      const guestCfg = pveApi.getGuestConfigCached?.(agent.vmid);
      if (guestCfg?.net0) {
        const ipMatch = guestCfg.net0.match(/ip=([\d.]+)/);
        if (ipMatch) containerIp = ipMatch[1];
      }
    }
    if (!containerIp && pveHostIp && agent.vmid) {
      try {
        const ipResult = await sshService.exec(pveHostIp, `pct exec ${agent.vmid} -- hostname -I`, { timeout: 5000 });
        const ipMatch = ipResult.stdout.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
        if (ipMatch) containerIp = ipMatch[1];
      } catch {}
    }

    const provider = getProvider(providerId);
    let apiPath;
    if (isTools) {
      apiPath = '';
    } else if (isTts) {
      apiPath = TTS_ENDPOINT_SUFFIXES[providerId] || '';
    } else if (isImageGen) {
      apiPath = '';
    } else {
      apiPath = providerId === 'ollama' ? '' : '/v1';
    }
    const endpoint = containerIp
      ? `http://${containerIp}:${port}${apiPath}`
      : `http://<container-ip>:${port}${apiPath}`;

    const state = loadActiveServices();
    state.services[serviceId] = {
      id: serviceId,
      providerId,
      providerName: provider?.name || providerId,
      port,
      node,
      vmid: agent.vmid,
      containerName,
      tmuxSession: session,
      pveHostIp,
      containerIp,
      endpoint,
      isTts: isTts || false,
      ...(isTools ? { isTools: true } : {}),
      model: model || null,
      modelFamily: modelFamily || null,
      modelVariant: modelVariant || null,
      quantFormat: quantFormat || null,
      quantSize: quantSize || null,
      contextSize: contextSize || null,
      // Concurrent-request slot count for this service. For llama-server this
      // is --parallel, for KoboldCpp it's --multiuser. Used by AI-Lab's agent
      // pool to size its load-balanced lanes per assigned model. Defaults to 1
      // when the launcher didn't specify (matches each provider's CLI default).
      slots: Number.isFinite(reqSlots) && reqSlots > 0 ? Math.floor(reqSlots) : 1,
      startedAt: Date.now(),
      logFile,
      // System service fields
      isSystemService: true,
      systemdUnit: unitName,
      scriptPath,
    };

    const gpuPciIds = (Array.isArray(explicitGpuPciIds) && explicitGpuPciIds.length > 0)
      ? explicitGpuPciIds
      : resolveServiceGpuPciIds(agent.vmid, cudaDevices || [0]);
    const defaultReserve = PROVIDER_VRAM_RESERVES[providerId];
    state.services[serviceId].gpuPciIds = gpuPciIds;
    state.services[serviceId].reservedVramMB = reqReservedVramMB ?? defaultReserve;

    // Assign stable proxy slot
    assignProxySlot(state, state.services[serviceId]);

    // Release pending port reservation now that the service is registered
    pendingPorts.delete(port);

    saveActiveServices(state);
    broadcast({ type: 'service-added', service: state.services[serviceId] });
    res.json({ ok: true, service: state.services[serviceId] });
  });

  // ─── File Browse + Audio Extraction ──────────────────────────────────────

  const BROWSE_ROOTS = ['/', '/claude', '/root', '/tmp'];
  const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.webm', '.mov', '.flv', '.wmv', '.m4v', '.ts', '.mpg', '.mpeg', '.3gp']);
  const AUDIO_EXTS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.opus']);
  const MEDIA_EXTS = new Set([...VIDEO_EXTS, ...AUDIO_EXTS]);

  /** GET /browse-files?dir=/path — List files and directories for the file browser */
  router.get('/browse-files', (req, res) => {
    const dir = pathResolve(req.query.dir || '/claude');

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      const dirs = [];
      const files = [];

      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const fullPath = join(dir, e.name);
        try {
          if (e.isDirectory()) {
            dirs.push({ name: e.name, path: fullPath });
          } else if (e.isFile()) {
            const ext = extname(e.name).toLowerCase();
            if (MEDIA_EXTS.has(ext)) {
              const stat = statSync(fullPath);
              files.push({
                name: e.name,
                path: fullPath,
                size: stat.size,
                ext,
                isVideo: VIDEO_EXTS.has(ext),
                isAudio: AUDIO_EXTS.has(ext),
              });
            }
          }
        } catch {}
      }

      dirs.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));

      res.json({ dir, dirs, files });
    } catch (err) {
      res.status(400).json({ error: `Cannot read directory: ${err.message}` });
    }
  });

  /** POST /extract-audio — Extract audio track from a video/audio file using FFmpeg */
  router.post('/extract-audio', (req, res) => {
    const filePath = req.body?.path;
    if (!filePath) return res.status(400).json({ error: 'path is required' });

    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const ext = extname(filePath).toLowerCase();
    if (ext === '.wav') {
      return res.sendFile(pathResolve(filePath));
    }

    try {
      const ffmpeg = spawn('ffmpeg', [
        '-i', filePath,
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', '44100',
        '-ac', '1',
        '-f', 'wav',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      res.set('Content-Type', 'audio/wav');
      res.set('Content-Disposition', 'attachment; filename="extracted_audio.wav"');

      ffmpeg.stdout.pipe(res);

      let stderr = '';
      ffmpeg.stderr.on('data', chunk => { stderr += chunk.toString(); });

      ffmpeg.on('close', code => {
        if (code !== 0 && !res.headersSent) {
          console.error(`[extract-audio] FFmpeg error: ${stderr.slice(-500)}`);
          res.status(500).json({ error: `FFmpeg failed (code ${code})` });
        }
      });

      ffmpeg.on('error', err => {
        if (!res.headersSent) {
          res.status(500).json({ error: `FFmpeg spawn failed: ${err.message}` });
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Save Audio (Audio Ripper) ────────────────────────────────────────

  /** POST /save-audio — Save audio data to server filesystem */
  router.post('/save-audio', express.raw({ type: 'audio/*', limit: '200mb' }), (req, res) => {
    const outputPath = req.query.path;
    if (!outputPath) return res.status(400).json({ error: 'path query param required' });
    const allowed = ['/claude/', '/tts/', '/tmp/'];
    if (!allowed.some(p => outputPath.startsWith(p))) {
      return res.status(403).json({ error: 'Path not in allowed directories (/claude/, /tts/, /tmp/)' });
    }
    try {
      const dir = pathResolve(outputPath, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(outputPath, req.body);
      res.json({ ok: true, path: outputPath, size: req.body.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Audio Workspace (server-side Voice Manager processing) ─────────────

  const WORKSPACE_ROOT = '/tmp/proxlab-workspace';
  const workspaceTimers = new Map();
  const workspaceSourceIndex = new Map(); // sourcePath -> workspaceId
  let sourceIndexLoaded = false;
  const wsUpload = multer({ dest: '/tmp/proxlab-workspace-uploads/', limits: { fileSize: 500 * 1024 * 1024 } });

  /** Lazily populate source index by scanning existing workspace directories */
  function ensureSourceIndex() {
    if (sourceIndexLoaded) return;
    sourceIndexLoaded = true;
    try {
      if (!existsSync(WORKSPACE_ROOT)) return;
      for (const dir of readdirSync(WORKSPACE_ROOT)) {
        const metaPath = join(WORKSPACE_ROOT, dir, 'meta.json');
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
            if (meta.sourcePath) workspaceSourceIndex.set(meta.sourcePath, dir);
          } catch {}
        }
      }
    } catch {}
  }

  function touchWorkspace(id) {
    if (workspaceTimers.has(id)) clearTimeout(workspaceTimers.get(id));
    workspaceTimers.set(id, setTimeout(() => {
      try { rmSync(join(WORKSPACE_ROOT, id), { recursive: true, force: true }); } catch {}
      workspaceTimers.delete(id);
      // Remove from source index
      for (const [src, wsId] of workspaceSourceIndex) {
        if (wsId === id) { workspaceSourceIndex.delete(src); break; }
      }
    }, 2 * 60 * 60 * 1000));
  }

  /** Parse WAV header and compute min/max peaks for waveform rendering */
  function readWavPeaks(wavPath, bucketCount) {
    const buf = readFileSync(wavPath);
    // Find 'fmt ' chunk
    let fmtOffset = -1;
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf[i] === 0x66 && buf[i+1] === 0x6D && buf[i+2] === 0x74 && buf[i+3] === 0x20) {
        fmtOffset = i; break;
      }
    }
    if (fmtOffset < 0) throw new Error('Invalid WAV: no fmt chunk');

    const channels = buf.readUInt16LE(fmtOffset + 10);
    const sampleRate = buf.readUInt32LE(fmtOffset + 12);
    const bitsPerSample = buf.readUInt16LE(fmtOffset + 22);
    const bytesPerSample = bitsPerSample / 8;

    // Find 'data' chunk
    let dataOffset = -1, dataSize = 0;
    for (let i = fmtOffset + 8; i < buf.length - 8; i++) {
      if (buf[i] === 0x64 && buf[i+1] === 0x61 && buf[i+2] === 0x74 && buf[i+3] === 0x61) {
        dataOffset = i + 8;
        dataSize = buf.readUInt32LE(i + 4);
        break;
      }
    }
    if (dataOffset < 0) throw new Error('Invalid WAV: no data chunk');

    const totalSamples = Math.floor(dataSize / (bytesPerSample * channels));
    const duration = totalSamples / sampleRate;
    const samplesPerBucket = Math.max(1, Math.floor(totalSamples / bucketCount));
    const peaks = [];

    for (let b = 0; b < bucketCount; b++) {
      let min = 1, max = -1;
      const startSample = b * samplesPerBucket;
      const endSample = Math.min(startSample + samplesPerBucket, totalSamples);
      for (let s = startSample; s < endSample; s++) {
        const bytePos = dataOffset + s * bytesPerSample * channels;
        if (bytePos + bytesPerSample > buf.length) break;
        let val;
        if (bitsPerSample === 16) {
          val = buf.readInt16LE(bytePos) / 32768;
        } else if (bitsPerSample === 32) {
          val = buf.readFloatLE(bytePos);
        } else {
          val = (buf.readUInt8(bytePos) - 128) / 128;
        }
        if (val < min) min = val;
        if (val > max) max = val;
      }
      if (min > max) { min = 0; max = 0; }
      peaks.push([parseFloat(min.toFixed(4)), parseFloat(max.toFixed(4))]);
    }

    return { peaks, duration, sampleRate, channels, bitsPerSample, totalSamples };
  }

  /** Read basic WAV metadata from header (only reads first 512 bytes) */
  function readWavInfo(wavPath) {
    const fileSize = statSync(wavPath).size;
    const headerSize = Math.min(fileSize, 512);
    const fd = openSync(wavPath, 'r');
    const buf = Buffer.alloc(headerSize);
    readSync(fd, buf, 0, headerSize, 0);
    closeSync(fd);

    let fmtOffset = -1;
    for (let i = 0; i < buf.length - 4; i++) {
      if (buf[i] === 0x66 && buf[i+1] === 0x6D && buf[i+2] === 0x74 && buf[i+3] === 0x20) {
        fmtOffset = i; break;
      }
    }
    if (fmtOffset < 0) throw new Error('Invalid WAV');
    const channels = buf.readUInt16LE(fmtOffset + 10);
    const sampleRate = buf.readUInt32LE(fmtOffset + 12);
    const bitsPerSample = buf.readUInt16LE(fmtOffset + 22);

    // Find data chunk size
    let dataSize = 0;
    for (let i = fmtOffset + 8; i < Math.min(buf.length - 8, 500); i++) {
      if (buf[i] === 0x64 && buf[i+1] === 0x61 && buf[i+2] === 0x74 && buf[i+3] === 0x61) {
        dataSize = buf.readUInt32LE(i + 4);
        break;
      }
    }
    const totalSamples = Math.floor(dataSize / ((bitsPerSample / 8) * channels));
    const duration = totalSamples / sampleRate;

    return { duration, sampleRate, channels, bitsPerSample, fileSize };
  }

  /** Find audio-tools service (mirrors proxy.js findAudioToolsService) */
  function findAudioToolsSvc() {
    const state = loadActiveServices();
    const registered = Object.values(state.services || {}).find(
      svc => svc.providerId === 'audio-tools' && svc.containerIp && svc.port
    );
    if (registered) return { host: registered.containerIp, port: registered.port };
    return { host: '10.0.0.235', port: 8890 };
  }

  /** Find first healthy TTS service (mirrors proxy.js) */
  function findTtsSvc() {
    const state = loadActiveServices();
    const registered = Object.values(state.services || {})
      .filter(svc => svc.providerId === 'proxlab-tts' && svc.containerIp && svc.port)
      .sort((a, b) => (a.proxySlot || 999) - (b.proxySlot || 999));
    if (registered.length > 0) return { host: registered[0].containerIp, port: registered[0].port };
    return { host: '10.0.0.235', port: 8880 };
  }

  /** Convert file to mono 16-bit WAV using FFmpeg */
  function convertToWav(inputPath, outputPath) {
    execSync(`ffmpeg -y -i ${JSON.stringify(inputPath)} -vn -acodec pcm_s16le -ac 1 -f wav ${JSON.stringify(outputPath)}`, { stdio: 'pipe', timeout: 120000 });
  }

  /** POST /workspace — Create a new audio workspace (or resume existing) */
  router.post('/workspace', wsUpload.single('file'), async (req, res) => {
    try {
      ensureSourceIndex();

      // Determine sourcePath fingerprint
      let sourcePath;
      let filename = 'audio.wav';
      if (req.file) {
        filename = req.file.originalname || 'upload.wav';
        sourcePath = `upload:${filename}:${req.file.size}`;
      } else if (req.body?.source === 'server' && req.body?.path) {
        sourcePath = req.body.path;
        filename = basename(sourcePath);
      }

      // Check for existing workspace with same source
      if (sourcePath && workspaceSourceIndex.has(sourcePath)) {
        const existingId = workspaceSourceIndex.get(sourcePath);
        const existingWork = join(WORKSPACE_ROOT, existingId, 'working.wav');
        if (existsSync(existingWork)) {
          // Resume existing workspace
          touchWorkspace(existingId);
          const info = readWavInfo(existingWork);
          const meta = JSON.parse(readFileSync(join(WORKSPACE_ROOT, existingId, 'meta.json'), 'utf-8'));
          // Clean up uploaded temp file if any
          if (req.file?.path) try { unlinkSync(req.file.path); } catch {}
          return res.json({ id: existingId, filename: meta.filename || filename, ...info, resumed: true });
        }
        // Stale entry — remove
        workspaceSourceIndex.delete(sourcePath);
      }

      // Create new workspace
      const id = randomUUID();
      const wsDir = join(WORKSPACE_ROOT, id);
      const histDir = join(wsDir, 'history');
      mkdirSync(histDir, { recursive: true });

      const origPath = join(wsDir, 'original.wav');
      const workPath = join(wsDir, 'working.wav');

      if (req.file) {
        // Local file upload
        const ext = extname(filename).toLowerCase();
        if (ext === '.wav') {
          renameSync(req.file.path, origPath);
        } else {
          convertToWav(req.file.path, origPath);
          try { unlinkSync(req.file.path); } catch {}
        }
      } else if (req.body?.source === 'server' && req.body?.path) {
        // Server file
        const serverPath = req.body.path;
        if (!existsSync(serverPath)) return res.status(404).json({ error: 'File not found' });
        const ext = extname(serverPath).toLowerCase();
        if (ext === '.wav') {
          copyFileSync(serverPath, origPath);
        } else {
          convertToWav(serverPath, origPath);
        }
      } else {
        return res.status(400).json({ error: 'Provide a file upload or { source: "server", path: "..." }' });
      }

      copyFileSync(origPath, workPath);
      // Cache original peaks for layered waveform display
      const origPeaksData = readWavPeaks(origPath, 800);
      writeFileSync(join(wsDir, 'original.peaks.json'), JSON.stringify(origPeaksData.peaks));
      const info = readWavInfo(workPath);
      writeFileSync(join(wsDir, 'meta.json'), JSON.stringify({
        id, filename, sourcePath: sourcePath || null, createdAt: Date.now(), historyCount: 0, steps: [],
      }));

      // Register in source index
      if (sourcePath) workspaceSourceIndex.set(sourcePath, id);

      touchWorkspace(id);
      res.json({ id, filename, ...info });
    } catch (err) {
      // Clean up uploaded file on error
      if (req.file?.path) try { unlinkSync(req.file.path); } catch {}
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /workspace/:id/info — Audio metadata for working file */
  router.get('/workspace/:id/info', (req, res) => {
    const wsDir = join(WORKSPACE_ROOT, req.params.id);
    const workPath = join(wsDir, 'working.wav');
    if (!existsSync(workPath)) return res.status(404).json({ error: 'Workspace not found' });
    touchWorkspace(req.params.id);
    try {
      const info = readWavInfo(workPath);
      const meta = JSON.parse(readFileSync(join(wsDir, 'meta.json'), 'utf-8'));
      res.json({ ...info, filename: meta.filename, sourcePath: meta.sourcePath || null, historyCount: meta.historyCount || 0, steps: meta.steps || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /workspace/:id/peaks — Waveform peaks data for canvas rendering */
  router.get('/workspace/:id/peaks', (req, res) => {
    const wsDir = join(WORKSPACE_ROOT, req.params.id);
    const target = req.query.source === 'original' ? 'original.wav' : 'working.wav';
    const wavPath = join(wsDir, target);
    if (!existsSync(wavPath)) return res.status(404).json({ error: 'Workspace not found' });
    touchWorkspace(req.params.id);
    try {
      const width = Math.max(100, Math.min(4000, parseInt(req.query.width) || 800));
      const data = readWavPeaks(wavPath, width);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /workspace/:id/layers — All step peaks for layered waveform rendering */
  router.get('/workspace/:id/layers', (req, res) => {
    const wsDir = join(WORKSPACE_ROOT, req.params.id);
    if (!existsSync(join(wsDir, 'working.wav'))) return res.status(404).json({ error: 'Workspace not found' });
    touchWorkspace(req.params.id);

    try {
      const meta = JSON.parse(readFileSync(join(wsDir, 'meta.json'), 'utf-8'));
      const steps = meta.steps || [];
      const layers = [];

      // Find last trim step — pre-trim layers are invalid (different duration)
      let baseIdx = -1;
      for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].type === 'trim') { baseIdx = i; break; }
      }

      // Base layer: original peaks or post-trim peaks
      if (baseIdx >= 0) {
        const trimHistIdx = steps[baseIdx].histIdx != null ? steps[baseIdx].histIdx : baseIdx;
        const trimPeaksPath = join(wsDir, 'history', `${trimHistIdx}.peaks.json`);
        if (existsSync(trimPeaksPath)) {
          layers.push({ type: 'base', peaks: JSON.parse(readFileSync(trimPeaksPath, 'utf-8')) });
        }
      } else {
        const origPeaksPath = join(wsDir, 'original.peaks.json');
        if (existsSync(origPeaksPath)) {
          layers.push({ type: 'original', peaks: JSON.parse(readFileSync(origPeaksPath, 'utf-8')) });
        } else {
          // Compute and cache original peaks (backward compat for old workspaces)
          const origPath = join(wsDir, 'original.wav');
          if (existsSync(origPath)) {
            const origPeaks = readWavPeaks(origPath, 800);
            writeFileSync(origPeaksPath, JSON.stringify(origPeaks.peaks));
            layers.push({ type: 'original', peaks: origPeaks.peaks });
          }
        }
      }

      // Add each step's peaks after the base
      for (let i = (baseIdx >= 0 ? baseIdx + 1 : 0); i < steps.length; i++) {
        const stepHistIdx = steps[i].histIdx != null ? steps[i].histIdx : i;
        const peaksPath = join(wsDir, 'history', `${stepHistIdx}.peaks.json`);
        if (existsSync(peaksPath)) {
          layers.push({ type: steps[i].type, peaks: JSON.parse(readFileSync(peaksPath, 'utf-8')) });
        }
      }

      res.json({ layers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /workspace/:id/rollback/:step — Roll back to state before step N (cascading) */
  router.post('/workspace/:id/rollback/:step', (req, res) => {
    const wsDir = join(WORKSPACE_ROOT, req.params.id);
    const workPath = join(wsDir, 'working.wav');
    if (!existsSync(workPath)) return res.status(404).json({ error: 'Workspace not found' });
    touchWorkspace(req.params.id);

    const stepIdx = parseInt(req.params.step);

    try {
      const meta = JSON.parse(readFileSync(join(wsDir, 'meta.json'), 'utf-8'));
      if (isNaN(stepIdx) || stepIdx < 0 || stepIdx >= (meta.steps || []).length) {
        return res.status(400).json({ error: 'Invalid step index' });
      }

      // Restore the snapshot from BEFORE this step
      const snapHistIdx = meta.steps[stepIdx].histIdx != null ? meta.steps[stepIdx].histIdx : stepIdx;
      const snapPath = join(wsDir, 'history', `${snapHistIdx}.wav`);
      if (!existsSync(snapPath)) return res.status(400).json({ error: 'Snapshot not found' });
      copyFileSync(snapPath, workPath);

      // Delete all history files for steps being removed (using each step's histIdx)
      const stepsToRemove = (meta.steps || []).slice(stepIdx);
      for (const s of stepsToRemove) {
        const hIdx = s.histIdx != null ? s.histIdx : stepIdx;
        try { unlinkSync(join(wsDir, 'history', `${hIdx}.wav`)); } catch {}
        try { unlinkSync(join(wsDir, 'history', `${hIdx}.peaks.json`)); } catch {}
      }

      // Truncate steps and update history count
      meta.steps = (meta.steps || []).slice(0, stepIdx);
      meta.historyCount = snapHistIdx;
      writeFileSync(join(wsDir, 'meta.json'), JSON.stringify(meta));

      const info = readWavInfo(workPath);
      res.json({ ok: true, ...info, historyCount: meta.historyCount, steps: meta.steps });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /workspace/:id/audio — Stream audio for HTML5 audio playback with Range support */
  router.get('/workspace/:id/audio', (req, res) => {
    const wsDir = join(WORKSPACE_ROOT, req.params.id);
    const target = req.query.source === 'original' ? 'original.wav' : 'working.wav';
    const wavPath = join(wsDir, target);
    if (!existsSync(wavPath)) return res.status(404).json({ error: 'Workspace not found' });
    touchWorkspace(req.params.id);

    const stat = statSync(wavPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'audio/wav',
      });
      createReadStream(wavPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'audio/wav',
        'Accept-Ranges': 'bytes',
      });
      createReadStream(wavPath).pipe(res);
    }
  });

  /** POST /workspace/:id/process — Run audio processing via audio-tools service */
  router.post('/workspace/:id/process', async (req, res) => {
    const wsDir = join(WORKSPACE_ROOT, req.params.id);
    const workPath = join(wsDir, 'working.wav');
    if (!existsSync(workPath)) return res.status(404).json({ error: 'Workspace not found' });
    touchWorkspace(req.params.id);

    const { action, shifts, timestep } = req.body || {};
    if (!['isolate', 'denoise', 'upscale', 'pipeline'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action. Use: isolate, denoise, upscale, pipeline' });
    }

    try {
      // Save undo snapshot (don't bump historyCount yet — only on success)
      const meta = JSON.parse(readFileSync(join(wsDir, 'meta.json'), 'utf-8'));
      const histIdx = meta.historyCount || 0;
      copyFileSync(workPath, join(wsDir, 'history', `${histIdx}.wav`));

      // Build multipart form and send to audio-tools
      const svc = findAudioToolsSvc();
      const wavBuf = readFileSync(workPath);

      const boundary = '----ProxLabBoundary' + Date.now();
      const parts = [];

      // File part
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
      parts.push(wavBuf);
      parts.push('\r\n');

      // Extra params
      if (['isolate', 'pipeline'].includes(action)) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="shifts"\r\n\r\n${shifts || '1'}\r\n`);
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="overlap"\r\n\r\n0.25\r\n`);
      }
      if (['upscale', 'pipeline'].includes(action)) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="timestep"\r\n\r\n${timestep || '1'}\r\n`);
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="target_sr"\r\n\r\n48000\r\n`);
      }
      parts.push(`--${boundary}--\r\n`);

      const bodyBufs = parts.map(p => typeof p === 'string' ? Buffer.from(p) : p);
      const body = Buffer.concat(bodyBufs);

      const t0 = Date.now();
      const resp = await fetch(`http://${svc.host}:${svc.port}/v1/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'Unknown error');
        throw new Error(`Audio-tools ${action} failed (HTTP ${resp.status}): ${errText.slice(0, 300)}`);
      }

      const resultBuf = Buffer.from(await resp.arrayBuffer());
      writeFileSync(workPath, resultBuf);

      // Success — now bump historyCount, cache peaks, and record step
      meta.historyCount = histIdx + 1;
      const stepPeaks = readWavPeaks(workPath, 800);
      writeFileSync(join(wsDir, 'history', `${histIdx}.peaks.json`), JSON.stringify(stepPeaks.peaks));
      if (!meta.steps) meta.steps = [];
      meta.steps.push({ type: action, ts: Date.now(), histIdx });
      writeFileSync(join(wsDir, 'meta.json'), JSON.stringify(meta));

      const elapsed = Date.now() - t0;
      const info = readWavInfo(workPath);
      res.json({ ok: true, ...info, elapsed, historyCount: meta.historyCount, steps: meta.steps });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /workspace/:id/trim — Trim working audio to selection */
  router.post('/workspace/:id/trim', (req, res) => {
    const wsDir = join(WORKSPACE_ROOT, req.params.id);
    const workPath = join(wsDir, 'working.wav');
    if (!existsSync(workPath)) return res.status(404).json({ error: 'Workspace not found' });
    touchWorkspace(req.params.id);

    const { start, end } = req.body || {};
    if (start == null || end == null || start >= end) {
      return res.status(400).json({ error: 'Provide valid start and end times' });
    }

    try {
      // Save undo snapshot (don't bump historyCount yet — only on success)
      const meta = JSON.parse(readFileSync(join(wsDir, 'meta.json'), 'utf-8'));
      const histIdx = meta.historyCount || 0;
      copyFileSync(workPath, join(wsDir, 'history', `${histIdx}.wav`));

      const trimmedPath = join(wsDir, 'trimmed.wav');
      execSync(`ffmpeg -y -i ${JSON.stringify(workPath)} -ss ${parseFloat(start)} -to ${parseFloat(end)} -c copy ${JSON.stringify(trimmedPath)}`, { stdio: 'pipe', timeout: 30000 });
      renameSync(trimmedPath, workPath);

      // Success — bump historyCount, cache peaks, record step
      meta.historyCount = histIdx + 1;
      const stepPeaks = readWavPeaks(workPath, 800);
      writeFileSync(join(wsDir, 'history', `${histIdx}.peaks.json`), JSON.stringify(stepPeaks.peaks));
      if (!meta.steps) meta.steps = [];
      meta.steps.push({ type: 'trim', ts: Date.now(), histIdx });
      writeFileSync(join(wsDir, 'meta.json'), JSON.stringify(meta));

      const info = readWavInfo(workPath);
      res.json({ ok: true, ...info, historyCount: meta.historyCount, steps: meta.steps });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /workspace/:id/undo — Revert to previous version */
  router.post('/workspace/:id/undo', (req, res) => {
    const wsDir = join(WORKSPACE_ROOT, req.params.id);
    const workPath = join(wsDir, 'working.wav');
    if (!existsSync(workPath)) return res.status(404).json({ error: 'Workspace not found' });
    touchWorkspace(req.params.id);

    try {
      const meta = JSON.parse(readFileSync(join(wsDir, 'meta.json'), 'utf-8'));
      if (!meta.steps || meta.steps.length <= 0) {
        return res.status(400).json({ error: 'Nothing to undo' });
      }
      const poppedStep = meta.steps.pop();
      const histIdx = poppedStep.histIdx != null ? poppedStep.histIdx : (meta.historyCount || 1) - 1;
      const snapPath = join(wsDir, 'history', `${histIdx}.wav`);
      if (!existsSync(snapPath)) return res.status(400).json({ error: 'Snapshot not found' });

      copyFileSync(snapPath, workPath);
      try { unlinkSync(snapPath); } catch {}
      try { unlinkSync(join(wsDir, 'history', `${histIdx}.peaks.json`)); } catch {}
      meta.historyCount = histIdx;
      writeFileSync(join(wsDir, 'meta.json'), JSON.stringify(meta));

      const info = readWavInfo(workPath);
      res.json({ ok: true, ...info, historyCount: meta.historyCount, steps: meta.steps || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /workspace/:id/reset — Reset to original */
  router.post('/workspace/:id/reset', (req, res) => {
    const wsDir = join(WORKSPACE_ROOT, req.params.id);
    const origPath = join(wsDir, 'original.wav');
    const workPath = join(wsDir, 'working.wav');
    if (!existsSync(origPath)) return res.status(404).json({ error: 'Workspace not found' });
    touchWorkspace(req.params.id);

    try {
      copyFileSync(origPath, workPath);
      // Delete all history snapshots
      const histDir = join(wsDir, 'history');
      if (existsSync(histDir)) {
        for (const f of readdirSync(histDir)) {
          try { unlinkSync(join(histDir, f)); } catch {}
        }
      }
      const meta = JSON.parse(readFileSync(join(wsDir, 'meta.json'), 'utf-8'));
      meta.historyCount = 0;
      meta.steps = [];
      writeFileSync(join(wsDir, 'meta.json'), JSON.stringify(meta));

      const info = readWavInfo(workPath);
      res.json({ ok: true, ...info, historyCount: 0, steps: [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /workspace/:id/save-voice — Save as TTS voice (server-to-server) */
  router.post('/workspace/:id/save-voice', async (req, res) => {
    const wsDir = join(WORKSPACE_ROOT, req.params.id);
    const workPath = join(wsDir, 'working.wav');
    if (!existsSync(workPath)) return res.status(404).json({ error: 'Workspace not found' });
    touchWorkspace(req.params.id);

    const { name, start, end } = req.body || {};
    if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
      return res.status(400).json({ error: 'Name must be alphanumeric (hyphens/underscores OK)' });
    }

    try {
      // If start/end provided, trim to a temp file first
      let uploadPath = workPath;
      if (start != null && end != null && (start > 0 || end < Infinity)) {
        const tmpPath = join(wsDir, 'save-trim.wav');
        execSync(`ffmpeg -y -i ${JSON.stringify(workPath)} -ss ${parseFloat(start)} -to ${parseFloat(end)} -c copy ${JSON.stringify(tmpPath)}`, { stdio: 'pipe', timeout: 30000 });
        uploadPath = tmpPath;
      }

      // Validate duration
      const info = readWavInfo(uploadPath);
      if (info.duration < 5) {
        return res.status(400).json({ error: `Clip too short (${info.duration.toFixed(1)}s). Chatterbox requires >5 seconds.` });
      }

      // Upload to TTS service
      const tts = findTtsSvc();
      const wavBuf = readFileSync(uploadPath);
      const boundary = '----ProxLabBoundary' + Date.now();
      const parts = [];
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
      parts.push(wavBuf);
      parts.push('\r\n');
      parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`);
      parts.push(`--${boundary}--\r\n`);

      const bodyBufs = parts.map(p => typeof p === 'string' ? Buffer.from(p) : p);
      const body = Buffer.concat(bodyBufs);

      const resp = await fetch(`http://${tts.host}:${tts.port}/v1/voices`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => 'Unknown error');
        throw new Error(`TTS upload failed (HTTP ${resp.status}): ${errText.slice(0, 300)}`);
      }

      // Clean up temp file
      if (uploadPath !== workPath) try { unlinkSync(uploadPath); } catch {}

      // Clean up workspace after successful save
      const wsId = req.params.id;
      try {
        // Read meta to get sourcePath before deleting
        const metaPath = join(wsDir, 'meta.json');
        if (existsSync(metaPath)) {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          if (meta.sourcePath) workspaceSourceIndex.delete(meta.sourcePath);
        }
        rmSync(wsDir, { recursive: true, force: true });
        if (workspaceTimers.has(wsId)) {
          clearTimeout(workspaceTimers.get(wsId));
          workspaceTimers.delete(wsId);
        }
      } catch {}

      res.json({ ok: true, name, duration: info.duration, workspaceClosed: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /workspace/:id/download — Download working WAV */
  router.get('/workspace/:id/download', (req, res) => {
    const wsDir = join(WORKSPACE_ROOT, req.params.id);
    const workPath = join(wsDir, 'working.wav');
    if (!existsSync(workPath)) return res.status(404).json({ error: 'Workspace not found' });
    touchWorkspace(req.params.id);
    res.download(workPath, 'processed_audio.wav');
  });

  /** DELETE /workspace/:id — Cleanup workspace */
  router.delete('/workspace/:id', (req, res) => {
    const id = req.params.id;
    const wsDir = join(WORKSPACE_ROOT, id);
    try {
      // Remove from source index
      const metaPath = join(wsDir, 'meta.json');
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          if (meta.sourcePath) workspaceSourceIndex.delete(meta.sourcePath);
        } catch {}
      }
      rmSync(wsDir, { recursive: true, force: true });
      if (workspaceTimers.has(id)) {
        clearTimeout(workspaceTimers.get(id));
        workspaceTimers.delete(id);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Active Services ────────────────────────────────────────────────────

  /** GET /next-port — Return next available port for LLM launch */
  router.get('/next-port', (req, res) => {
    res.json({ port: getNextPort() });
  });

  /** Known STT provider IDs for service type classification */
  const STT_PROVIDERS = new Set(['faster-whisper']);

  /** Classify a service as llm, tts, stt, or tools */
  function classifyServiceType(svc) {
    if (svc.isTools) return 'tools';
    if (svc.isImageGen) return 'image';
    if (svc.isStt || STT_PROVIDERS.has(svc.providerId)) return 'stt';
    if (svc.isTts) return 'tts';
    return 'llm';
  }

  /** GET /active-services — List all active services with computed serviceType */
  router.get('/active-services', (req, res) => {
    const state = loadActiveServices();
    // Enrich each service with a computed serviceType field
    const enriched = { ...state };
    if (enriched.services) {
      for (const svc of Object.values(enriched.services)) {
        svc.serviceType = classifyServiceType(svc);
      }
    }
    res.json(enriched);
  });

  /** TTS endpoint suffixes — providers with OpenAI-compatible APIs get /v1 */
  const TTS_ENDPOINT_SUFFIXES = {
    kokoro: '/v1',
    'openedai-speech': '/v1',
    'faster-whisper': '/v1',
    'proxlab-tts': '/v1',
    'qwen-tts': '/v1',
    's2-pro': '/v1',
  };

  /** TTS health check paths — varies by provider */
  const TTS_HEALTH_PATHS = {
    alltalk: '/api/ready',
    f5tts: '/',
    kokoro: '/v1/models',
    'openedai-speech': '/v1/models',
    'tts-webui': '/',
    piper: '/voices',
    'faster-whisper': '/v1/models',
    'proxlab-tts': '/health',
    'qwen-tts': '/health',
    's2-pro': '/health',
    'proxlab-rvc': '/health',
    rvc: '/health',
    dramabox: '/health',
  };

  /** Custom health check paths for non-LLM/TTS services (image gen, tools, etc.) */
  const CUSTOM_HEALTH_PATHS = {
    rembg: '/health',
    // Lightweight liveness check — /sdapi/v1/start returns ~2 bytes in <5ms.
    // Avoid /sdapi/v1/sd-models, which iterates the full checkpoints_list and
    // serializes every model on disk to JSON on every poll (37KB+).
    sdnext: '/sdapi/v1/start',
    'automatic1111': '/sdapi/v1/start',
    comfyui: '/',
    'audio-tools': '/health',
  };

  /**
   * POST /active-services — Register a new active service (after OK/detach).
   * Body: { id, providerId, port, node, vmid, tmuxSession, pveHostIp, model?, isTts? }
   */
  router.post('/active-services', async (req, res) => {
    const { id, providerId, port, node, vmid, tmuxSession, pveHostIp,
            model, modelFamily, modelVariant, quantFormat, quantSize, contextSize,
            isTts, isImageGen, isStt, isTools, cudaDevices, gpuPciIds: explicitGpuPciIds,
            reservedVramMB: reqReservedVramMB,
            isSystemService, systemdUnit, slots: reqSlots } = req.body;
    if (!id || !providerId || !port || !tmuxSession) {
      return res.status(400).json({ error: 'id, providerId, port, and tmuxSession are required' });
    }

    // Resolve container IP and name for the endpoint URL
    const guests = pveApi.getGuests();
    const guest = guests.find(g => g.vmid === vmid);
    let containerIp = guest?.ip || null;
    const containerName = guest?.name || `CT ${vmid}`;

    // If PVE tags didn't have an IP, try the cached guest config (net0 static IP)
    if (!containerIp) {
      const cfg = pveApi.getGuestConfigCached?.(vmid);
      if (cfg?.net0) {
        const ipMatch = cfg.net0.match(/ip=([\d.]+)/);
        if (ipMatch) containerIp = ipMatch[1];
      }
    }

    // Last resort: SSH to host and get the container IP via hostname -I
    if (!containerIp && pveHostIp && vmid) {
      try {
        const result = await sshService.exec(pveHostIp, `pct exec ${vmid} -- hostname -I`, { timeout: 5000 });
        const ipMatch = result.stdout.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
        if (ipMatch) containerIp = ipMatch[1];
      } catch {}
    }

    // Build endpoint URL — TTS, tools, and LLM providers have different path suffixes
    const provider = getProvider(providerId);
    let apiPath;
    if (isTools) {
      apiPath = '';
    } else if (isTts) {
      apiPath = TTS_ENDPOINT_SUFFIXES[providerId] || '';
    } else if (isImageGen) {
      apiPath = '';
    } else {
      apiPath = providerId === 'ollama' ? '' : '/v1';
    }
    const endpoint = containerIp
      ? `http://${containerIp}:${port}${apiPath}`
      : `http://<container-ip>:${port}${apiPath}`;

    const state = loadActiveServices();
    state.services[id] = {
      id,
      providerId,
      providerName: provider?.name || providerId,
      port,
      node,
      vmid,
      containerName,
      tmuxSession,
      pveHostIp,
      containerIp,
      endpoint,
      isTts: isTts || false,
      ...(isImageGen ? { isImageGen: true } : {}),
      ...(isStt ? { isStt: true } : {}),
      ...(isTools ? { isTools: true } : {}),
      model: model || null,
      modelFamily: modelFamily || null,
      modelVariant: modelVariant || null,
      quantFormat: quantFormat || null,
      quantSize: quantSize || null,
      contextSize: contextSize || null,
      slots: Number.isFinite(reqSlots) && reqSlots > 0 ? Math.floor(reqSlots) : 1,
      startedAt: Date.now(),
      logFile: `/var/log/proxlab/${tmuxSession}.log`,
      ...(isSystemService ? { isSystemService: true } : {}),
      ...(systemdUnit ? { systemdUnit } : {}),
    };

    // Use explicit PCI IDs from frontend if provided, else resolve from CUDA indices
    const gpuPciIds = (Array.isArray(explicitGpuPciIds) && explicitGpuPciIds.length > 0)
      ? explicitGpuPciIds
      : resolveServiceGpuPciIds(vmid, cudaDevices || [0]);
    const defaultReserve = PROVIDER_VRAM_RESERVES[providerId];
    state.services[id].gpuPciIds = gpuPciIds;
    state.services[id].reservedVramMB = reqReservedVramMB ?? defaultReserve;

    // Assign stable proxy slot (lowest unused for this service type)
    assignProxySlot(state, state.services[id]);

    // Release pending port reservation now that the service is registered
    pendingPorts.delete(port);

    saveActiveServices(state);
    broadcast({ type: 'service-added', service: state.services[id] });

    res.json({ ok: true, service: state.services[id] });
  });

  /**
   * POST /active-services/rescan-slots — One-shot backfill that re-reads each
   * llama-server/koboldcpp launch script via SSH, parses out --parallel /
   * --multiuser, and updates svc.slots in place. Useful for services that
   * were registered before the slots field flowed through (or with a stale
   * frontend that didn't include it in the body). Idempotent — running it
   * twice is harmless.
   */
  router.post('/active-services/rescan-slots', async (_req, res) => {
    const state = loadActiveServices();
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const results = [];
    for (const svc of Object.values(state.services)) {
      if (svc.providerId !== 'llama-server' && svc.providerId !== 'llama-server-mtp' && svc.providerId !== 'koboldcpp') {
        skipped += 1;
        continue;
      }
      if (!svc.pveHostIp || !svc.vmid || !svc.scriptPath) {
        skipped += 1;
        continue;
      }
      try {
        const cmd = `pct exec ${svc.vmid} -- cat ${svc.scriptPath}`;
        const out = await sshService.exec(svc.pveHostIp, cmd, { timeout: 5000 });
        const text = out.stdout || '';
        let n = 1;
        if (svc.providerId === 'llama-server' || svc.providerId === 'llama-server-mtp') {
          const m = text.match(/--parallel[\s=]+(\d+)/);
          if (m) n = parseInt(m[1], 10);
        } else if (svc.providerId === 'koboldcpp') {
          const m = text.match(/multiuser["\s:=]+(\d+)/i) || text.match(/--multiuser[\s=]+(\d+)/);
          if (m) n = parseInt(m[1], 10);
        }
        const oldSlots = svc.slots ?? 1;
        if (n !== oldSlots) {
          svc.slots = n;
          updated += 1;
          results.push({ id: svc.id, providerId: svc.providerId, oldSlots, newSlots: n });
        } else {
          skipped += 1;
        }
      } catch (err) {
        failed += 1;
        results.push({ id: svc.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (updated > 0) {
      saveActiveServices(state);
      try {
        const proxyMod = await import('./proxy.js');
        proxyMod.invalidateModelCache?.();
      } catch {}
    }
    res.json({ updated, skipped, failed, results });
  });

  /**
   * GET /active-services/:id/identifier — Resolve a service's current effective
   * model identifier. If aliasOverride is set, returns that. Otherwise fetches
   * the backend's own /v1/models and returns the first model id reported.
   * Used by the rename modal to pre-fill the input with the actual name the
   * API is currently serving (which can differ from svc.model, since svc.model
   * is a variant/path label, not the API-visible identifier).
   */
  router.get('/active-services/:id/identifier', async (req, res) => {
    const state = loadActiveServices();
    const svc = state.services[req.params.id];
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (svc.aliasOverride) return res.json({ identifier: svc.aliasOverride, source: 'override' });
    try {
      const url = `http://${svc.containerIp}:${svc.port}/v1/models`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) return res.json({ identifier: '', source: 'unavailable' });
      const json = await resp.json();
      const first = (json.data || [])[0];
      return res.json({ identifier: first?.id || '', source: 'backend' });
    } catch {
      return res.json({ identifier: '', source: 'unavailable' });
    }
  });

  /**
   * POST /active-services/:id/identifier — Update a service's runtime alias.
   * Sets svc.aliasOverride so the proxy's /v1/models renames the model
   * immediately without restarting the backend. Empty string clears the
   * override (reverting to whatever name the backend itself reports).
   */
  router.post('/active-services/:id/identifier', async (req, res) => {
    const { identifier } = req.body || {};
    if (identifier !== undefined && typeof identifier !== 'string') {
      return res.status(400).json({ error: 'identifier must be a string' });
    }
    const state = loadActiveServices();
    const svc = state.services[req.params.id];
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const trimmed = typeof identifier === 'string' ? identifier.trim() : '';
    if (trimmed) {
      svc.aliasOverride = trimmed;
    } else {
      delete svc.aliasOverride;
    }
    saveActiveServices(state);
    try {
      const proxyMod = await import('./proxy.js');
      proxyMod.invalidateModelCache?.();
    } catch {}
    broadcast({ type: 'service-updated', serviceId: req.params.id, aliasOverride: svc.aliasOverride || null });
    res.json({ ok: true, aliasOverride: svc.aliasOverride || null });
  });

  /** DELETE /active-services/:id — Unregister a service (doesn't kill tmux) */
  router.delete('/active-services/:id', (req, res) => {
    const state = loadActiveServices();
    const svc = state.services[req.params.id];
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    archiveService(svc, 'unregistered');
    delete state.services[req.params.id];
    saveActiveServices(state);
    broadcast({ type: 'service-removed', serviceId: req.params.id });
    res.json({ ok: true });
  });

  /**
   * POST /active-services/:id/kill — Kill tmux session (or systemd service) via SSH, then unregister.
   */
  router.post('/active-services/:id/kill', async (req, res) => {
    const state = loadActiveServices();
    const svc = state.services[req.params.id];
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    try {
      if (svc.isSystemService) {
        // Stop + disable + remove unit file + launch script + daemon-reload
        const cleanupCmd = [
          `pct exec ${svc.vmid} -- bash -c '`,
          `systemctl stop ${svc.systemdUnit} 2>/dev/null;`,
          ` systemctl disable ${svc.systemdUnit} 2>/dev/null;`,
          ` rm -f /etc/systemd/system/${svc.systemdUnit}.service;`,
          ` rm -f ${svc.scriptPath};`,
          ` systemctl daemon-reload`,
          `'`,
        ].join('');
        await sshService.exec(svc.pveHostIp, cleanupCmd, { timeout: 15000 });
      } else {
        const killCmd = `pct exec ${svc.vmid} -- tmux kill-session -t '${svc.tmuxSession.replace(/'/g, "'\\''")}'`;
        await sshService.exec(svc.pveHostIp, killCmd, { timeout: 10000 });
      }
    } catch (err) {
      console.log(`${svc.isSystemService ? 'systemd' : 'tmux'} kill for ${svc.tmuxSession}: ${err.message}`);
    }

    archiveService(svc, 'stopped');
    delete state.services[req.params.id];
    saveActiveServices(state);
    broadcast({ type: 'service-removed', serviceId: req.params.id });
    res.json({ ok: true });
  });

  /**
   * POST /active-services/:id/suspend — Stop a systemd service without removing it (temporary pause).
   */
  router.post('/active-services/:id/suspend', async (req, res) => {
    const state = loadActiveServices();
    const svc = state.services[req.params.id];
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (!svc.isSystemService) return res.status(400).json({ error: 'Only systemd services support suspend' });

    try {
      // To reliably suspend: disable (prevent boot start), then add a drop-in override
      // that sets Restart=no so systemd won't auto-restart, then stop the unit.
      const cmd = `pct exec ${svc.vmid} -- bash -c '
        systemctl disable ${svc.systemdUnit} 2>/dev/null
        mkdir -p /etc/systemd/system/${svc.systemdUnit}.service.d
        echo -e "[Service]\\nRestart=no" > /etc/systemd/system/${svc.systemdUnit}.service.d/suspend.conf
        systemctl daemon-reload
        systemctl stop ${svc.systemdUnit}
      '`;
      await sshService.exec(svc.pveHostIp, cmd, { timeout: 60000 });
      svc.suspended = true;
      saveActiveServices(state);
      broadcast({ type: 'service-updated', service: svc });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /active-services/:id/start — Start a stopped systemd service (also resets failure state).
   */
  router.post('/active-services/:id/start', async (req, res) => {
    const state = loadActiveServices();
    const svc = state.services[req.params.id];
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (!svc.isSystemService) return res.status(400).json({ error: 'Only systemd services support start' });

    try {
      const cmd = `pct exec ${svc.vmid} -- bash -c '
        rm -f /etc/systemd/system/${svc.systemdUnit}.service.d/suspend.conf
        rmdir /etc/systemd/system/${svc.systemdUnit}.service.d 2>/dev/null
        systemctl daemon-reload
        systemctl enable ${svc.systemdUnit} 2>/dev/null
        systemctl reset-failed ${svc.systemdUnit} 2>/dev/null
        systemctl start ${svc.systemdUnit}
      '`;
      await sshService.exec(svc.pveHostIp, cmd, { timeout: 15000 });
      svc.startedAt = new Date().toISOString();
      delete svc.suspended;
      saveActiveServices(state);
      broadcast({ type: 'service-updated', service: svc });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /active-services/:id/restart — Restart a systemd service (also resets failure state).
   */
  router.post('/active-services/:id/restart', async (req, res) => {
    const state = loadActiveServices();
    const svc = state.services[req.params.id];
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (!svc.isSystemService) return res.status(400).json({ error: 'Only systemd services support restart' });

    try {
      const cmd = `pct exec ${svc.vmid} -- bash -c '
        rm -f /etc/systemd/system/${svc.systemdUnit}.service.d/suspend.conf
        rmdir /etc/systemd/system/${svc.systemdUnit}.service.d 2>/dev/null
        systemctl daemon-reload
        systemctl enable ${svc.systemdUnit} 2>/dev/null
        systemctl reset-failed ${svc.systemdUnit} 2>/dev/null
        systemctl restart ${svc.systemdUnit}
      '`;
      await sshService.exec(svc.pveHostIp, cmd, { timeout: 15000 });
      svc.startedAt = new Date().toISOString();
      delete svc.suspended;
      saveActiveServices(state);
      broadcast({ type: 'service-updated', service: svc });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /active-services/prune — Health-check all services, remove dead ones.
   * Uses `tmux has-session` or `systemctl is-active` via SSH depending on service type.
   */
  router.post('/active-services/prune', async (req, res) => {
    const state = loadActiveServices();
    const pruned = [];
    let patched = false;

    for (const [id, svc] of Object.entries(state.services)) {
      try {
        let checkCmd;
        if (svc.isSystemService) {
          checkCmd = `pct exec ${svc.vmid} -- systemctl is-active ${svc.systemdUnit}`;
        } else {
          checkCmd = `pct exec ${svc.vmid} -- tmux has-session -t '${svc.tmuxSession.replace(/'/g, "'\\''")}'`;
        }
        const result = await sshService.exec(svc.pveHostIp, checkCmd, { timeout: 5000 });
        if (result.code !== 0) {
          archiveService(svc, 'failed');
          delete state.services[id];
          pruned.push(id);
        } else {
          // Patch missing containerIp/endpoint for services registered before the SSH fallback fix
          if (!svc.containerIp && svc.pveHostIp && svc.vmid) {
            try {
              const ipResult = await sshService.exec(svc.pveHostIp, `pct exec ${svc.vmid} -- hostname -I`, { timeout: 5000 });
              const ipMatch = ipResult.stdout.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
              if (ipMatch) {
                const ip = ipMatch[1];
                svc.containerIp = ip;
                let apiPath;
                if (svc.isTts) {
                  apiPath = TTS_ENDPOINT_SUFFIXES[svc.providerId] || '';
                } else {
                  apiPath = svc.providerId === 'ollama' ? '' : '/v1';
                }
                svc.endpoint = `http://${ip}:${svc.port}${apiPath}`;
                patched = true;
              }
            } catch {}
          }
          // Backfill missing gpuPciIds / model metadata for services registered
          // via a crashed handler path or pre-VRAM-tracking. Single enrichment
          // fills both from the launch script when fields are missing.
          const needsGpuBackfill = !svc.gpuPciIds || svc.gpuPciIds.length === 0;
          const needsModelBackfill = !svc.model && svc.tmuxSession;
          if ((needsGpuBackfill || needsModelBackfill) && svc.vmid && svc.tmuxSession) {
            const enriched = await enrichFromScript(svc.pveHostIp, svc.vmid, svc.tmuxSession, svc.providerId);
            if (needsGpuBackfill) {
              const cudaDevices = enriched.cudaDevices?.length ? enriched.cudaDevices : [0];
              const resolved = resolveServiceGpuPciIds(svc.vmid, cudaDevices);
              if (resolved.length > 0) {
                svc.gpuPciIds = resolved;
                svc.reservedVramMB = PROVIDER_VRAM_RESERVES[svc.providerId] ?? null;
                patched = true;
              }
            }
            if (needsModelBackfill && enriched.model) {
              svc.model = enriched.model;
              svc.modelFamily = enriched.modelFamily || null;
              svc.modelVariant = enriched.modelVariant || null;
              svc.quantFormat = enriched.quantFormat || null;
              svc.quantSize = enriched.quantSize || null;
              svc.contextSize = enriched.contextSize || svc.contextSize || null;
              patched = true;
            }
          }
        }
      } catch (err) {
        // SSH failed (timeout, network issue) — do NOT assume service is dead
        console.log(`Prune: SSH check failed for ${id} (${svc.tmuxSession}): ${err.message} — skipping`);
      }
    }

    if (pruned.length > 0 || patched) saveActiveServices(state);
    for (const id of pruned) {
      broadcast({ type: 'service-removed', serviceId: id });
    }
    res.json({ ok: true, pruned, remaining: Object.keys(state.services).length });
  });

  /**
   * POST /active-services/scan-orphans — Find systemd services that exist on
   * containers but aren't tracked in active-services.json.
   * Auto-adopts discoverable services into the registry so they appear as cards.
   * Body: { cleanup?: boolean } — if true, stops + removes truly unknown orphans
   */

  // Map unit-name prefix (after stripping "proxlab-") to provider ID.
  // Only needed when the unit prefix differs from the actual provider ID.
  const UNIT_PREFIX_TO_PROVIDER = {
    'tts': 'proxlab-tts',
  };

  // Provider flags for adopted services
  const TTS_PROVIDER_IDS = new Set(['proxlab-tts', 'qwen-tts', 's2-pro', 'alltalk', 'f5tts', 'kokoro', 'openedai-speech', 'tts-webui', 'piper']);
  const STT_PROVIDER_IDS = new Set(['faster-whisper']);
  const TOOLS_PROVIDER_IDS = new Set(['audio-tools']);
  const IMAGEGEN_PROVIDER_IDS = new Set(['comfyui', 'sdnext', 'fooocus', 'invokeai', 'rembg', 'spar3d']);

  /** Parse a systemd unit name like "proxlab-koboldcpp-5002" into { providerId, port, session } */
  function parseOrphanUnit(unitName) {
    const rest = unitName.replace(/^proxlab-/, '');
    const portMatch = rest.match(/-(\d{4,5})$/);
    if (!portMatch) return null;
    const port = parseInt(portMatch[1], 10);
    const prefix = rest.slice(0, -(portMatch[0].length));
    const providerId = UNIT_PREFIX_TO_PROVIDER[prefix] || prefix;
    return { providerId, port, session: rest };
  }

  /**
   * Parse a NAS model path into family/variant/quant fields.
   * Paths: /models/{family}/{variant}/{format}/{quant}/{file} or /model-cache/...
   */
  function parseModelPath(modelPath) {
    if (!modelPath) return {};
    const m = modelPath.match(/\/(?:models|model-cache)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (!m) {
      // Fallback: just use filename
      const fname = modelPath.split('/').pop()?.replace(/\.\w+$/, '') || null;
      return { model: fname };
    }
    return {
      model: m[5].replace(/\.\w+$/, ''),
      modelFamily: m[1],
      modelVariant: m[2],
      quantFormat: m[3],
      quantSize: m[4],
    };
  }

  /** Extract model info from a launch script via SSH */
  async function enrichFromScript(hostIp, vmid, session, providerId) {
    try {
      const scriptPath = `/opt/proxlab/services/${session}.sh`;
      const readCmd = `pct exec ${vmid} -- cat ${scriptPath} 2>/dev/null`;
      const result = await sshService.exec(hostIp, readCmd, { timeout: 5000 });
      const script = result.stdout || '';

      // Extract CUDA_VISIBLE_DEVICES for GPU info
      const cudaMatch = script.match(/CUDA_VISIBLE_DEVICES=([0-9,]+)/);
      const cudaDevices = cudaMatch ? cudaMatch[1].split(',').map(Number) : [];

      if (providerId === 'koboldcpp') {
        // KoboldCpp: base64-encoded .kcpps config
        const b64Match = script.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/);
        if (b64Match) {
          const cfg = JSON.parse(Buffer.from(b64Match[1], 'base64').toString());
          const parsed = parseModelPath(cfg.model_param);
          return {
            ...parsed,
            contextSize: cfg.contextsize || null,
            cudaDevices,
          };
        }
      } else {
        // Other providers: look for --model flag
        const modelMatch = script.match(/--model\s+(\S+)/);
        if (modelMatch) {
          return { ...parseModelPath(modelMatch[1]), cudaDevices };
        }
      }
      return { cudaDevices };
    } catch {
      return {};
    }
  }

  router.post('/active-services/scan-orphans', async (req, res) => {
    const cleanup = req.body?.cleanup === true;
    const cfg = loadAiConfig();
    const nodeMap = pveApi.getNodeMap();
    const state = loadActiveServices();

    // Build set of registered systemd unit names
    const registeredUnits = new Set();
    for (const svc of Object.values(state.services)) {
      if (svc.systemdUnit) registeredUnits.add(svc.systemdUnit);
    }

    const orphans = [];
    const adopted = [];

    for (const [node, agent] of Object.entries(cfg.agents || {})) {
      const hostIp = nodeMap[node]?.ip || agent.hostIp;
      const vmid = agent.vmid;
      if (!hostIp || !vmid) continue;

      // Resolve container IP once per container
      let containerIp = null;
      const guests = pveApi.getGuests();
      const guest = guests.find(g => g.vmid === vmid);
      containerIp = guest?.ip || null;
      if (!containerIp) {
        try {
          const ipResult = await sshService.exec(hostIp, `pct exec ${vmid} -- hostname -I`, { timeout: 5000 });
          const ipMatch = ipResult.stdout.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
          if (ipMatch) containerIp = ipMatch[1];
        } catch {}
      }
      const containerName = guest?.name || `CT ${vmid}`;

      try {
        // List all proxlab-* service units that are loaded
        const listCmd = `pct exec ${vmid} -- bash -c "systemctl list-units 'proxlab-*' --no-pager --no-legend --plain 2>/dev/null | awk '{print \\$1}'"`;
        const result = await sshService.exec(hostIp, listCmd, { timeout: 10000 });
        const units = result.stdout.split('\n').map(l => l.trim()).filter(l => l.endsWith('.service'));

        for (const unitFile of units) {
          const unitName = unitFile.replace(/\.service$/, '');
          if (registeredUnits.has(unitName)) continue;

          const parsed = parseOrphanUnit(unitName);
          if (!parsed) continue;
          const { providerId, port, session } = parsed;

          // Try to auto-adopt: provider must be known OR be a known pipeline service (rvc)
          const provider = getProvider(providerId);
          const isKnown = provider || providerId === 'rvc';

          if (isKnown && !cleanup) {
            // Build a proper service entry and register it
            const isTts = TTS_PROVIDER_IDS.has(providerId) || providerId === 'rvc';
            const isStt = STT_PROVIDER_IDS.has(providerId);
            const isTools = TOOLS_PROVIDER_IDS.has(providerId);
            let apiPath = '';
            if (isTools) apiPath = '';
            else if (isTts) apiPath = TTS_ENDPOINT_SUFFIXES[providerId] || '';
            else if (isStt) apiPath = TTS_ENDPOINT_SUFFIXES[providerId] || '';
            else if (IMAGEGEN_PROVIDER_IDS.has(providerId)) apiPath = '';
            else apiPath = providerId === 'ollama' ? '' : '/v1';

            const serviceId = `${session}-${Date.now()}`;
            const endpoint = containerIp ? `http://${containerIp}:${port}${apiPath}` : null;
            const logFile = `/var/log/proxlab/${session}.log`;

            // Enrich with model info from launch script
            const enriched = await enrichFromScript(hostIp, vmid, session, providerId);

            // Resolve GPU PCI IDs from script's CUDA_VISIBLE_DEVICES
            const gpuPciIds = resolveServiceGpuPciIds(vmid, enriched.cudaDevices?.length ? enriched.cudaDevices : [0]);
            const defaultReserve = PROVIDER_VRAM_RESERVES[providerId] ?? null;

            const svcEntry = {
              id: serviceId,
              providerId,
              providerName: provider?.name || (providerId === 'rvc' ? 'RVC Voice Conversion' : providerId),
              port,
              node,
              vmid,
              containerName,
              tmuxSession: session,
              pveHostIp: hostIp,
              containerIp,
              endpoint,
              isTts,
              ...(isStt ? { isStt: true } : {}),
              ...(isTools ? { isTools: true } : {}),
              model: enriched.model || null,
              modelFamily: enriched.modelFamily || null,
              modelVariant: enriched.modelVariant || null,
              quantFormat: enriched.quantFormat || null,
              quantSize: enriched.quantSize || null,
              contextSize: enriched.contextSize || null,
              startedAt: Date.now(),
              logFile,
              isSystemService: true,
              systemdUnit: unitName,
              scriptPath: `/opt/proxlab/services/${session}.sh`,
              gpuPciIds,
              reservedVramMB: defaultReserve,
            };

            assignProxySlot(state, svcEntry);
            state.services[serviceId] = svcEntry;
            registeredUnits.add(unitName);
            adopted.push({ unitName, serviceId, providerId, port });
            console.log(`[orphan-scan] Auto-adopted: ${unitName} → ${serviceId} (${providerId})`);
          } else if (!isKnown) {
            // Truly unknown orphan
            const orphan = { node, vmid, hostIp, unitName, unitFile, port };
            if (cleanup) {
              try {
                const cleanCmd = `pct exec ${vmid} -- bash -c 'systemctl stop ${unitName} 2>/dev/null; systemctl disable ${unitName} 2>/dev/null; rm -f /etc/systemd/system/${unitFile}; rm -f /opt/proxlab/services/${unitName.replace("proxlab-", "")}.sh; systemctl daemon-reload'`;
                await sshService.exec(hostIp, cleanCmd, { timeout: 15000 });
                orphan.cleaned = true;
              } catch (err) {
                orphan.cleaned = false;
                orphan.error = err.message;
              }
            }
            orphans.push(orphan);
          }
        }
      } catch (err) {
        console.error(`[orphan-scan] ${node} CT${vmid}: SSH error: ${err.message}`);
      }
    }

    // Save state if any services were adopted
    if (adopted.length > 0) {
      saveActiveServices(state);
      for (const a of adopted) {
        broadcast({ type: 'service-added', service: state.services[a.serviceId] });
      }
    }

    res.json({ ok: true, orphans, adopted, cleanup });
  });

  /**
   * GET /active-services/:id/stats — Fetch TPS metrics from a running provider.
   * Reaches the provider's metrics/stats endpoint via its container IP.
   *
   * Supported:
   *   - vLLM / Aphrodite: GET /metrics (Prometheus) → avg_generation_throughput_toks_per_s
   *   - KoboldCpp: GET /api/extra/perf (JSON) → last_token_count / last_eval_time
   *   - TabbyAPI: GET /v1/model (JSON) → just health check
   *   - Others: health-only (no TPS)
   */
  router.get('/active-services/:id/stats', async (req, res) => {
    const state = loadActiveServices();
    const svc = state.services[req.params.id];
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (!svc.containerIp) return res.json({ alive: false, reason: 'no container IP' });

    const baseUrl = `http://${svc.containerIp}:${svc.port}`;
    const result = { alive: false, tps: null, systemdState: null };

    // For systemd services, also check the unit state (activating, active, failed, inactive)
    if (svc.isSystemService && svc.pveHostIp && svc.vmid && svc.systemdUnit) {
      try {
        const stateCmd = `pct exec ${svc.vmid} -- systemctl show ${svc.systemdUnit} --property=ActiveState,SubState --no-pager 2>/dev/null`;
        const stateResult = await sshService.exec(svc.pveHostIp, stateCmd, { timeout: 5000 });
        const activeMatch = stateResult.stdout.match(/ActiveState=(\S+)/);
        const subMatch = stateResult.stdout.match(/SubState=(\S+)/);
        if (activeMatch) {
          result.systemdState = activeMatch[1]; // active, activating, inactive, failed, deactivating
          result.systemdSubState = subMatch?.[1] || null; // running, start, dead, failed, etc.
        }
      } catch {}
    }

    // Auto-correct stale suspended flag: if systemd says active but flag says suspended, clear it
    if (svc.suspended && result.systemdState === 'active') {
      delete svc.suspended;
      saveActiveServices(state);
    }
    if (svc.suspended) result.suspended = true;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);

      if (svc.isTts) {
        // TTS health check — use provider-specific paths, no TPS
        const healthPath = TTS_HEALTH_PATHS[svc.providerId] || '/';
        const resp = await fetch(`${baseUrl}${healthPath}`, { signal: controller.signal });
        clearTimeout(timeout);
        result.alive = resp.ok;
      } else if (svc.providerId === 'vllm' || svc.providerId === 'aphrodite') {
        // Prometheus /metrics endpoint
        const resp = await fetch(`${baseUrl}/metrics`, { signal: controller.signal });
        clearTimeout(timeout);
        if (resp.ok) {
          result.alive = true;
          const text = await resp.text();
          // Parse: vllm:avg_generation_throughput_toks_per_s or aphrodite:...
          const prefix = svc.providerId === 'aphrodite' ? 'aphrodite' : 'vllm';
          const match = text.match(new RegExp(`${prefix}:avg_generation_throughput_toks_per_s\\s+([\\d.]+)`));
          if (match) result.tps = parseFloat(match[1]);
          // Also try the generic metric name
          if (result.tps === null) {
            const genMatch = text.match(/avg_generation_throughput_toks_per_s\s+([\d.]+)/);
            if (genMatch) result.tps = parseFloat(genMatch[1]);
          }
        }
      } else if (svc.providerId === 'koboldcpp') {
        // KoboldCpp /api/extra/perf
        const resp = await fetch(`${baseUrl}/api/extra/perf`, { signal: controller.signal });
        clearTimeout(timeout);
        if (resp.ok) {
          result.alive = true;
          const data = await resp.json();
          // KoboldCpp returns: { last_process, last_eval, last_token_count, ... }
          if (data.last_eval > 0 && data.last_token_count > 0) {
            result.tps = data.last_token_count / data.last_eval;
          }
          if (data.idle) result.idle = true;
        }
      } else if (svc.providerId === 'llama-server' || svc.providerId === 'llama-server-mtp') {
        // llama.cpp exposes Prometheus metrics at /metrics when launched with --metrics.
        // Fall back to /health (always available) if metrics are off.
        let metricsOk = false;
        try {
          const resp = await fetch(`${baseUrl}/metrics`, { signal: controller.signal });
          if (resp.ok) {
            metricsOk = true;
            result.alive = true;
            const text = await resp.text();
            // llamacpp:predicted_tokens_seconds is a gauge with the rolling predicted tok/s
            const m = text.match(/llamacpp:predicted_tokens_seconds\s+([\d.eE+-]+)/);
            if (m) result.tps = parseFloat(m[1]);
          }
        } catch {}
        if (!metricsOk) {
          const resp = await fetch(`${baseUrl}/health`, { signal: controller.signal });
          result.alive = resp.ok;
        }
        clearTimeout(timeout);
      } else {
        // Check custom health paths first, then generic OpenAI-compatible fallback
        const healthPath = CUSTOM_HEALTH_PATHS[svc.providerId]
          || (svc.providerId === 'ollama' ? '/api/tags' : '/v1/models');
        const resp = await fetch(`${baseUrl}${healthPath}`, { signal: controller.signal });
        clearTimeout(timeout);
        result.alive = resp.ok;
      }
    } catch {
      // Timeout or connection refused — service is down
      result.alive = false;
    }

    // Resolve the model identifier the API serves under. aliasOverride wins
    // (no network round-trip needed); otherwise hit the backend's /v1/models.
    // Skipped for TTS / Ollama / non-LLM providers where /v1/models doesn't
    // apply or returns something unrelated.
    if (svc.aliasOverride) {
      result.modelIdentifier = svc.aliasOverride;
    } else if (result.alive && !svc.isTts && svc.providerId !== 'ollama') {
      try {
        const ctrl2 = new AbortController();
        const t2 = setTimeout(() => ctrl2.abort(), 3000);
        const r2 = await fetch(`${baseUrl}/v1/models`, { signal: ctrl2.signal });
        clearTimeout(t2);
        if (r2.ok) {
          const json = await r2.json();
          result.modelIdentifier = (json.data || [])[0]?.id || '';
        }
      } catch { /* leave undefined */ }
    }

    // kvcache-proxy companion probe: by convention, the shim listens on
    // service_port + 1000. Fast (1.5s timeout); included only when present.
    try {
      const kvPort = Number(svc.port) + 1000;
      const ctrlK = new AbortController();
      const tK = setTimeout(() => ctrlK.abort(), 1500);
      const rK = await fetch(`http://${svc.containerIp}:${kvPort}/shim/stats`, { signal: ctrlK.signal });
      clearTimeout(tK);
      if (rK.ok) {
        const json = await rK.json();
        const s = json.stats || {};
        const idx = json.index || {};
        result.kvcacheProxy = {
          enabled: true,
          port: kvPort,
          url: `http://${svc.containerIp}:${kvPort}`,
          hits: s.cache_hits || 0,
          misses: s.cache_misses || 0,
          requests: s.requests || 0,
          autoSaves: s.auto_saves || 0,
          evictions: s.evictions || 0,
          entries: idx.entries || 0,
          bytes: idx.bytes || 0,
        };
      }
    } catch { /* shim absent / unreachable / wrong-shape; that's fine */ }

    res.json(result);
  });

  /**
   * POST /active-services/:id/swap — Hot-swap model on a running KoboldCpp service.
   * Reads existing kcpps, resolves new model path, calls /api/admin/reload_config.
   */
  router.post('/active-services/:id/swap', async (req, res) => {
    const state = loadActiveServices();
    const svc = state.services[req.params.id];
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (svc.providerId !== 'koboldcpp') {
      return res.status(400).json({ error: 'Only KoboldCpp supports hot-swap' });
    }

    const { family, variant, quant } = req.body;
    if (!family || !variant || !quant) {
      return res.status(400).json({ error: 'family, variant, and quant are required' });
    }

    const { vmid, pveHostIp, port, containerIp, tmuxSession } = svc;
    const sessionSafe = tmuxSession.replace(/'/g, "'\\''");

    try {
      // 1. Read current kcpps from container
      const readCmd = `pct exec ${vmid} -- cat /tmp/.kcpps-${sessionSafe}.kcpps`;
      const readResult = await sshService.exec(pveHostIp, readCmd, { timeout: 10000 });
      if (readResult.code !== 0 || !readResult.stdout.trim()) {
        return res.status(500).json({ error: 'Failed to read kcpps config from container' });
      }

      let kcpps;
      try {
        kcpps = JSON.parse(readResult.stdout);
      } catch {
        return res.status(500).json({ error: 'Failed to parse kcpps config' });
      }

      // 2. Resolve new model path — search cache then NAS for any format
      // quant might be "Q6_K" (GGUF), "FP16", "4-bit" (AWQ), etc.
      const cachePath = getCachePath(svc.node);
      const resolveCmd = `pct exec ${vmid} -- bash -c '
        for base in "${cachePath}" "/models"; do
          # Try GGUF/{quant}/ structure (most common for koboldcpp)
          f=$(find "$base/${family}/${variant}/GGUF/${quant}" -maxdepth 1 -name "*.gguf" -type f 2>/dev/null | sort | head -1)
          [ -n "$f" ] && echo "$f" && exit 0
          # Try {format}/ structure where quant IS the format name (FP16, AWQ, etc.)
          f=$(find "$base/${family}/${variant}/${quant}" -maxdepth 1 \\( -name "*.gguf" -o -name "*.safetensors" -o -name "*.bin" \\) -type f 2>/dev/null | sort | head -1)
          [ -n "$f" ] && echo "$f" && exit 0
          # Try {format}/{quant}/ for nested formats (AWQ/4-bit, EXL2/4.0bpw)
          f=$(find "$base/${family}/${variant}/"*"/${quant}" -maxdepth 1 \\( -name "*.gguf" -o -name "*.safetensors" -o -name "*.bin" \\) -type f 2>/dev/null | sort | head -1)
          [ -n "$f" ] && echo "$f" && exit 0
        done
      '`;
      const pathResult = await sshService.exec(pveHostIp, resolveCmd, { timeout: 15000 });
      const modelPath = pathResult.stdout.trim();
      if (!modelPath) {
        return res.status(404).json({ error: `Model not found: ${family}/${variant}/${quant}` });
      }

      // 3. Check if new model has an mmproj file nearby (GGUF vision models)
      const modelDir = modelPath.replace(/\/[^/]+$/, '');
      const mmprojCmd = `pct exec ${vmid} -- bash -c 'ls ${modelDir}/mmproj*.gguf 2>/dev/null | head -1'`;
      const mmprojResult = await sshService.exec(pveHostIp, mmprojCmd, { timeout: 5000 });
      const mmprojPath = mmprojResult.stdout.trim();

      // 4. Update kcpps — preserve all settings except model path + mmproj
      kcpps.model_param = modelPath;
      if (mmprojPath) {
        kcpps.mmproj = mmprojPath;
      } else {
        delete kcpps.mmproj;
      }

      // 5. Write updated kcpps back to container
      const kcppsB64 = Buffer.from(JSON.stringify(kcpps, null, 2)).toString('base64');
      const writeCmd = `pct exec ${vmid} -- bash -c 'echo "${kcppsB64}" | base64 -d > /tmp/.kcpps-${sessionSafe}.kcpps'`;
      await sshService.exec(pveHostIp, writeCmd, { timeout: 10000 });

      // 6. Call KoboldCpp admin reload API
      const reloadUrl = `http://${containerIp}:${port}/api/admin/reload_config`;
      const reloadBody = { filename: `/tmp/.kcpps-${sessionSafe}.kcpps` };

      // Include admin password if set in kcpps
      const adminPassword = kcpps.adminpassword || '';
      const headers = { 'Content-Type': 'application/json' };
      if (adminPassword) {
        headers['Authorization'] = `Bearer ${adminPassword}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      const reloadResp = await fetch(reloadUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(reloadBody),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!reloadResp.ok) {
        const errText = await reloadResp.text();
        return res.status(502).json({ error: `KoboldCpp reload failed (${reloadResp.status}): ${errText}` });
      }

      // 7. Update active-services.json with new model info
      const freshState = loadActiveServices();
      const freshSvc = freshState.services[req.params.id];
      if (freshSvc) {
        freshSvc.model = `${family}/${variant}`;
        freshSvc.modelFamily = family;
        freshSvc.modelVariant = variant;
        freshSvc.quantFormat = quant;
        // Extract size from path if possible
        const sizeMatch = modelPath.match(/(\d+\.?\d*)\s*GB/i);
        freshSvc.quantSize = sizeMatch ? sizeMatch[1] + ' GB' : null;
        saveActiveServices(freshState);
      }

      res.json({ ok: true, model: `${family}/${variant}`, quant, modelPath });

    } catch (err) {
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: 'KoboldCpp reload timed out (120s)' });
      }
      console.error(`[swap] Error swapping model on ${svc.id}:`, err);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── VRAM Calculator & Placement ────────────────────────────────────────

  /** GET /models — Available model presets and quant formats */
  router.get('/models', (req, res) => {
    res.json({
      presets: getModelPresets(),
      quants: getQuantFormats(),
    });
  });

  /** GET /gpu-specs — GPU hardware specs database */
  router.get('/gpu-specs', (req, res) => {
    res.json(getAllGpuSpecs());
  });

  /** GET /agent-gpus — AI-container GPUs enumerated for downstream services
   * (e.g. immich-upscale-companion). Returns, per registered AI container:
   * vmid, name, container IP, host node, and the GPUs assigned to it, with
   * each GPU's CUDA index (in PCI_BUS_ID order — assumes the container sets
   * CUDA_DEVICE_ORDER=PCI_BUS_ID, which is the standard pattern).
   *
   * Response: { agents: [{ vmid, name, ip, host_node, gpus: [{ cuda_index, pci_id, name, vram_mb, arch }] }] }
   */
  router.get('/agent-gpus', (req, res) => {
    try {
      const aiConfig = loadAiConfig();
      const gpuAssignments = loadGpuAssignments();
      const inventory = gpuMonitor.getEnrichedInventory();
      const gpuConfig = gpuMonitor.getConfig();
      const clusterGpus = getClusterGpus(inventory, gpuConfig, aiConfig);
      // Build pci -> enriched lookup, keyed by node:pciId
      const pciLookup = Object.fromEntries(
        clusterGpus.map(g => [`${g.node}:${g.pciId}`, g])
      );
      const guests = pveApi.getGuests();
      const guestByVmid = Object.fromEntries(guests.map(g => [String(g.vmid), g]));

      const agents = [];
      for (const [nodeName, agentCfg] of Object.entries(aiConfig?.agents || {})) {
        const vmid = agentCfg?.vmid;
        if (!vmid) continue;
        const guest = guestByVmid[String(vmid)];
        const ip = guest?.ip || null;
        const assignmentPciList = (gpuAssignments?.[String(vmid)]?.gpus) || [];
        if (!ip || !assignmentPciList.length) continue;
        // Sort PCI IDs ascending — this matches what the container sees when
        // CUDA_DEVICE_ORDER=PCI_BUS_ID is set.
        const sortedPci = [...assignmentPciList].sort();
        const gpus = sortedPci.map((pciId, idx) => {
          const enriched = pciLookup[`${nodeName}:${pciId}`] || {};
          return {
            cuda_index: idx,
            pci_id: pciId,
            name: enriched.friendlyName || 'Unknown',
            vram_mb: enriched.vramMB || 0,
            arch: enriched.spec?.arch || null,
            provider: enriched.provider || null,
          };
        });
        agents.push({
          vmid,
          name: guest?.name || nodeName,
          ip,
          host_node: nodeName,
          gpus,
        });
      }
      res.json({ agents });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /estimate — Estimate VRAM and find GPU placements.
   *
   * Body: { params, quant, contextSize, layers?, kvHeads?, headDim?,
   *         preset?, kvDtype?, poolOnly? }
   *
   * If `preset` is provided, architecture fields are auto-filled.
   * If `poolOnly` is true (default), only AI Pool GPUs are considered.
   */
  router.post('/estimate', (req, res) => {
    try {
      const { preset, quant, contextSize, poolOnly = true, bpw } = req.body;
      let { params, layers, kvHeads, headDim, kvDtype, kvLayers } = req.body;

      // Fill from preset if provided
      if (preset) {
        const presets = getModelPresets();
        const p = presets[preset];
        if (!p) return res.status(400).json({ error: `Unknown preset: ${preset}` });
        params = params || p.params;
        layers = layers || p.layers;
        kvHeads = kvHeads || p.kvHeads;
        headDim = headDim || p.headDim;
        kvLayers = kvLayers || p.kvLayers || null;
      }

      if (!params || (!quant && !bpw) || !contextSize) {
        return res.status(400).json({ error: 'params, quant (or bpw), and contextSize are required' });
      }

      // Estimate VRAM — bpw override skips QUANT_BPW lookup
      const estimate = estimateVram({
        params, quant, contextSize, layers, kvHeads, headDim,
        kvDtype: kvDtype || 'fp16',
        kvLayers: kvLayers || null,
        ...(bpw ? { bpw } : {}),
      });

      // Get available GPUs with live VRAM awareness
      const inventory = gpuMonitor.getEnrichedInventory();
      const gpuConfig = gpuMonitor.getConfig();
      const aiConfig = loadAiConfig();

      // Build spec lookup for VRAM totals, then compute per-GPU usage
      const clusterGpusRaw = getClusterGpus(inventory, gpuConfig, aiConfig);
      const gpuSpecLookup = Object.fromEntries(
        clusterGpusRaw.map(g => [g.configKey, { vramMB: g.vramMB }])
      );
      const gpuMetrics = gpuMonitor.getLatest();
      const activeServicesData = loadActiveServices();
      const vramUsage = getGpuVramUsage(gpuMetrics, activeServicesData, gpuSpecLookup);

      let clusterGpus = getClusterGpus(inventory, gpuConfig, aiConfig, vramUsage);

      // Filter to AI Pool GPUs only if requested
      if (poolOnly) {
        clusterGpus = clusterGpus.filter(g => g.poolMode === 'ai-pool');
      }

      // Find placements
      const placements = findPlacements({
        requiredMB: estimate.totalMB,
        weightsMB: estimate.weightsMB,
        kvCacheMB: estimate.kvCacheMB,
        availableGpus: clusterGpus,
        modelOpts: { params, quant, contextSize, layers, kvHeads, headDim, kvDtype, kvLayers },
      });

      // Simplify GPU objects in placement results for the API response
      const simplifiedPlacements = placements.map(p => ({
        ...p,
        gpus: p.gpus.map(g => ({
          node: g.node,
          pciId: g.pciId,
          friendlyName: g.friendlyName,
          vramMB: g.vramMB,
          availableVramMB: g.availableVramMB,
          liveUsedMB: g.liveUsedMB || 0,
          reservedMB: g.reservedMB || 0,
          model: g.spec?.model || null,
          arch: g.spec?.arch || null,
        })),
      }));

      res.json({
        estimate,
        placements: simplifiedPlacements,
        availableGpuCount: clusterGpus.length,
        poolOnly,
        availableGpus: clusterGpus.map(g => ({
          node: g.node, pciId: g.pciId, friendlyName: g.friendlyName,
          vramMB: g.vramMB, availableVramMB: g.availableVramMB,
          liveUsedMB: g.liveUsedMB || 0, reservedMB: g.reservedMB || 0,
          provider: g.provider, model: g.spec?.model || null, arch: g.spec?.arch || null,
        })),
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── Driver Detection ────────────────────────────────────────────────────

  /**
   * GET /drivers/:node — Detect GPU driver versions on host and in agent container.
   * SSHes to the PVE host for host driver, then via pct exec for container driver.
   * Returns { nvidia: { host, container, match } }
   */
  router.get('/drivers/:node', async (req, res) => {
    const node = req.params.node;
    const nodeMap = pveApi.getNodeMap();
    const hostIp = nodeMap[node]?.ip;

    if (!hostIp) {
      return res.status(404).json({ error: `Node not found: ${node}` });
    }

    const result = { nvidia: null, intel: null };

    try {
      // Host NVIDIA driver version — extract just the version number
      // nvidia-smi output may be mixed with SSH login banners, so extract the last line
      const hostResult = await sshService.exec(hostIp, 'nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | tail -1', { timeout: 10000 });
      const hostDriverRaw = hostResult.stdout.trim();
      // NVIDIA driver versions are like "580.126.09" — find the last match
      const hostDriverMatches = hostDriverRaw.match(/\b(\d{3,}\.\d+\.\d+)\b/g);
      const hostDriver = hostDriverMatches ? hostDriverMatches[hostDriverMatches.length - 1] : '';

      if (hostDriver && hostResult.code === 0) {
        result.nvidia = { host: hostDriver, container: null, match: false };

        // Container driver version (if agent exists)
        const cfg = loadAiConfig();
        const agent = cfg.agents?.[node];
        if (agent?.vmid) {
          try {
            const containerResult = await sshService.exec(
              hostIp,
              `pct exec ${agent.vmid} -- nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | tail -1`,
              { timeout: 15000 }
            );
            const containerRaw = containerResult.stdout.trim();
            const containerMatches = containerRaw.match(/\b(\d{3,}\.\d+\.\d+)\b/g);
            const containerDriver = containerMatches ? containerMatches[containerMatches.length - 1] : '';
            if (containerDriver && containerResult.code === 0) {
              result.nvidia.container = containerDriver;
              result.nvidia.match = hostDriver === containerDriver;
            }
          } catch {
            // Container may be stopped or nvidia-smi not installed
          }
        }
      }
    } catch {
      // nvidia-smi not available on host
    }

    res.json(result);
  });

  // ─── Provider Installation ────────────────────────────────────────────────

  const providerInstaller = new ProviderInstaller({ sshService, pveApi, gpuMonitor });

  /**
   * POST /providers/:id/prepare-install — Upload install scripts to LXC.
   * Returns connection info for the frontend to open a terminal and run the install.
   *
   * Body: { node: 'epyc-px' }
   * Returns: { vmid, pveHostIp, node, providerId, command }
   */
  router.post('/providers/:id/prepare-install', async (req, res) => {
    const providerId = req.params.id;
    const provider = getProvider(providerId);
    if (!provider) {
      return res.status(404).json({ error: `Unknown provider: ${providerId}` });
    }

    const { node, installExtras, downloadModels } = req.body;
    if (!node) {
      return res.status(400).json({ error: 'node is required' });
    }

    const cfg = loadAiConfig();
    const agent = cfg.agents?.[node];
    if (!agent?.vmid) {
      return res.status(400).json({ error: `No agent designated for node ${node}` });
    }

    const vmid = agent.vmid;
    const nodeMap = pveApi.getNodeMap();
    const pveHostIp = nodeMap[node]?.ip;

    if (!pveHostIp) {
      return res.status(400).json({ error: `Cannot resolve PVE host IP for node ${node}` });
    }

    try {
      // Resolve GPU info for this node
      const archs = providerInstaller.getAgentGpuArchs(node, vmid).join(',');
      const vendor = providerInstaller.getAgentGpuVendor(node, vmid);

      // Get all scripts needed for this provider's install chain
      const scripts = providerInstaller.getInstallScripts(providerId, vendor);

      // Get host driver version for NVIDIA containers
      let hostDriverVersion = '';
      if (vendor === 'NVIDIA') {
        try {
          const driverResult = await sshService.exec(pveHostIp, 'nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | tail -1', { timeout: 10000 });
          const driverRaw = driverResult.stdout.trim();
          const driverMatches = driverRaw.match(/\b(\d{3,}\.\d+\.\d+)\b/g);
          hostDriverVersion = driverMatches ? driverMatches[driverMatches.length - 1] : '';
        } catch {}
      }

      // Upload scripts to LXC via pct exec using base64 encoding
      // This avoids all shell quoting issues with heredocs through multiple shell layers
      const dirs = new Set();
      for (const s of scripts) {
        const dir = s.remotePath.substring(0, s.remotePath.lastIndexOf('/'));
        dirs.add(dir);
      }
      const mkdirCmd = `pct exec ${vmid} -- bash -c 'mkdir -p ${[...dirs].join(' ')}'`;
      await sshService.exec(pveHostIp, mkdirCmd, { timeout: 15000 });

      // Clear any previous state file so the install starts fresh
      const clearStateCmd = `pct exec ${vmid} -- rm -f /tmp/proxlab-install/.state-${providerId}`;
      await sshService.exec(pveHostIp, clearStateCmd, { timeout: 5000 }).catch(() => {});

      // Upload each script via base64
      for (const script of scripts) {
        const b64 = Buffer.from(script.content).toString('base64');
        const uploadCmd = `pct exec ${vmid} -- bash -c 'echo ${b64} | base64 -d > ${script.remotePath} && chmod +x ${script.remotePath}'`;
        const result = await sshService.exec(pveHostIp, uploadCmd, { timeout: 30000 });
        if (result.code !== 0) {
          return res.status(500).json({ error: `Failed to upload ${script.name}: ${result.stderr}` });
        }
      }

      // Load shared folder config for mount parent path
      const sharedFoldersFile = join(dataDir, 'shared-folders.json');
      let sharedMountParent = '/mnt/shared';
      try {
        if (existsSync(sharedFoldersFile)) {
          const sf = JSON.parse(readFileSync(sharedFoldersFile, 'utf-8'));
          sharedMountParent = sf.containerMountParent || '/mnt/shared';
        }
      } catch {}

      // Resolve the install chain from providers.js (single source of truth)
      // Replace {vendor} placeholders with the actual vendor
      const vendorLower = vendor.toLowerCase();
      const installChain = (provider.installChain || [])
        .map(s => s.replace(/\{vendor\}/g, vendorLower));

      // Create a run.sh wrapper with all env vars baked in
      // This avoids quoting issues and keeps the pct exec command clean
      const runScript = [
        '#!/bin/bash',
        `export PROXLAB_PROVIDER="${providerId}"`,
        `export PROXLAB_GPU_ARCHS="${archs}"`,
        `export PROXLAB_GPU_VENDOR="${vendor}"`,
        `export PROXLAB_INSTALL_DIR="/opt/${providerId}"`,
        `export PROXLAB_SCRIPT_DIR="/tmp/proxlab-install"`,
        `export PROXLAB_CACHE_DIR=""`,
        // Pass install chain so orchestrator doesn't need its own hardcoded copy
        `export PROXLAB_INSTALL_CHAIN="${installChain.join(' ')}"`,
        hostDriverVersion ? `export PROXLAB_HOST_DRIVER_VERSION="${hostDriverVersion}"` : '',
        // Install extras and model downloads (optional, from provider card checkboxes)
        Array.isArray(installExtras) && installExtras.length > 0
          ? `export PROXLAB_INSTALL_EXTRAS="${installExtras.join(',')}"` : '',
        Array.isArray(downloadModels) && downloadModels.length > 0
          ? `export PROXLAB_DOWNLOAD_MODELS="${downloadModels.join(',')}"` : '',
        // Shared folder mount parent (for symlink helper)
        `export PROXLAB_SHARED_MOUNT_PARENT="${sharedMountParent}"`,
        '',
        'exec bash /tmp/proxlab-install/orchestrator.sh',
      ].filter(Boolean).join('\n');

      const runB64 = Buffer.from(runScript).toString('base64');
      const runUpload = `pct exec ${vmid} -- bash -c 'echo ${runB64} | base64 -d > /tmp/proxlab-install/run.sh && chmod +x /tmp/proxlab-install/run.sh'`;
      const runResult = await sshService.exec(pveHostIp, runUpload, { timeout: 15000 });
      if (runResult.code !== 0) {
        return res.status(500).json({ error: `Failed to upload run.sh: ${runResult.stderr}` });
      }

      // Command for pct exec — clean, no quoting needed
      const command = 'bash /tmp/proxlab-install/run.sh';

      res.json({
        vmid,
        pveHostIp,
        node,
        providerId,
        command,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /providers/:id/prepare-update — Upload provider script and return terminal command.
   * Same flow as prepare-install but runs the 'update' action on just the provider script.
   *
   * Body: { node }
   */
  router.post('/providers/:id/prepare-update', async (req, res) => {
    const providerId = req.params.id;
    const provider = getProvider(providerId);
    if (!provider) return res.status(404).json({ error: `Unknown provider: ${providerId}` });

    const { node } = req.body;
    if (!node) return res.status(400).json({ error: 'node is required' });

    const cfg = loadAiConfig();
    const agent = cfg.agents?.[node];
    if (!agent?.vmid) return res.status(400).json({ error: `No agent designated for node ${node}` });

    const vmid = agent.vmid;
    const nodeMap = pveApi.getNodeMap();
    const pveHostIp = nodeMap[node]?.ip;
    if (!pveHostIp) return res.status(400).json({ error: `Cannot resolve PVE host IP for node ${node}` });

    try {
      const archs = providerInstaller.getAgentGpuArchs(node, vmid).join(',');
      const vendor = providerInstaller.getAgentGpuVendor(node, vmid);

      // Upload just the provider script (no prereqs/orchestrator needed for update)
      const scripts = providerInstaller.getInstallScripts(providerId, vendor);
      const providerScript = scripts.find(s => s.name === `providers/${providerId}`);
      if (!providerScript) return res.status(500).json({ error: `Provider script not found for ${providerId}` });

      const mkdirCmd = `pct exec ${vmid} -- mkdir -p /tmp/proxlab-install/providers`;
      await sshService.exec(pveHostIp, mkdirCmd, { timeout: 10000 });

      const b64 = Buffer.from(providerScript.content).toString('base64');
      const uploadCmd = `pct exec ${vmid} -- bash -c 'echo ${b64} | base64 -d > ${providerScript.remotePath} && chmod +x ${providerScript.remotePath}'`;
      await sshService.exec(pveHostIp, uploadCmd, { timeout: 15000 });

      // Build a simple update wrapper script
      const updateScript = [
        '#!/bin/bash',
        `export PROXLAB_GPU_ARCHS="${archs}"`,
        `export PROXLAB_GPU_VENDOR="${vendor}"`,
        `export PROXLAB_INSTALL_DIR="/opt/${providerId}"`,
        `export PROXLAB_CONDA_ENV="${providerId}"`,
        `export PATH="/opt/conda/bin:$PATH"`,
        '',
        `echo "Updating ${providerId}..."`,
        `bash ${providerScript.remotePath} update`,
        `echo ""`,
        `echo "Update complete."`,
      ].join('\n');

      const updateB64 = Buffer.from(updateScript).toString('base64');
      const updateUpload = `pct exec ${vmid} -- bash -c 'echo ${updateB64} | base64 -d > /tmp/proxlab-install/update-${providerId}.sh && chmod +x /tmp/proxlab-install/update-${providerId}.sh'`;
      await sshService.exec(pveHostIp, updateUpload, { timeout: 15000 });

      res.json({
        vmid,
        pveHostIp,
        node,
        providerId,
        command: `bash /tmp/proxlab-install/update-${providerId}.sh`,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /providers/:id/install-complete — Persist install status after terminal install.
   * Called by frontend when it detects PROXLAB_STATUS= in terminal output.
   *
   * Body: { node, status, version }
   */
  router.post('/providers/:id/install-complete', (req, res) => {
    const providerId = req.params.id;
    if (!getProvider(providerId)) {
      return res.status(404).json({ error: `Unknown provider: ${providerId}` });
    }

    const { node, status, version } = req.body;
    if (!node || !status) {
      return res.status(400).json({ error: 'node and status are required' });
    }

    const cfg = loadAiConfig();
    const agent = cfg.agents?.[node];
    if (!agent) {
      return res.status(400).json({ error: `No agent for node ${node}` });
    }

    if (!agent.providers) agent.providers = {};

    if (status === 'installed') {
      agent.providers[providerId] = {
        installed: true,
        version: version || null,
        installedAt: Date.now(),
      };
    } else if (status === 'not_installed') {
      delete agent.providers[providerId];
    } else {
      // error or unknown — mark as not installed
      delete agent.providers[providerId];
    }

    saveAiConfig(cfg);
    res.json({ ok: true, node, providerId, status, version });
  });

  /**
   * POST /providers/verify — Live-check installed providers via pct exec.
   * For each agent with providers marked as installed, checks if the .version
   * marker file still exists in the install dir. Updates ai-config.json to
   * remove stale entries.
   */
  router.post('/providers/verify', async (req, res) => {
    const cfg = loadAiConfig();
    const agents = cfg.agents || {};
    const nodeMap = pveApi.getNodeMap();
    const allProviders = getAllProviders();
    const changes = [];

    for (const [node, agent] of Object.entries(agents)) {
      if (!agent.vmid || !agent.providers) continue;

      const installedIds = Object.keys(agent.providers).filter(id => agent.providers[id]?.installed);
      if (installedIds.length === 0) continue;

      const hostIp = nodeMap[node]?.ip;
      if (!hostIp) continue;

      // Build a single command that checks all providers at once
      const checks = installedIds.map(id => `[ -f /opt/${id}/.version ] && echo "${id}:installed:\\$(cat /opt/${id}/.version)" || echo "${id}:missing"`).join('; ');

      try {
        const result = await sshService.exec(hostIp, `pct exec ${agent.vmid} -- bash -c '${checks}'`, { timeout: 15000 });
        const lines = result.stdout.split('\n').filter(Boolean);

        for (const line of lines) {
          // Strip ANSI/banner noise — only parse lines matching our format
          const m = line.match(/^(\w+):(installed|missing)(?::(.+))?$/);
          if (!m) continue;
          const [, id, status, version] = m;

          if (status === 'missing' && agent.providers[id]?.installed) {
            delete agent.providers[id];
            changes.push({ node, provider: id, action: 'removed_stale' });
          } else if (status === 'installed' && version) {
            // Update version if it changed
            if (agent.providers[id]) {
              agent.providers[id].version = version.trim();
            }
          }
        }
      } catch {
        // SSH/pct failed — container might be stopped; skip verification for this node
      }
    }

    if (changes.length > 0) {
      saveAiConfig(cfg);
    }

    res.json({ verified: true, changes });
  });

  /**
   * GET /providers — List all provider definitions with per-agent install status.
   * Reads cached status from ai-config.json (no live SSH checks).
   */
  router.get('/providers', (req, res) => {
    const cfg = loadAiConfig();
    const agents = cfg.agents || {};
    const providers = getAllProviders().map(p => {
      const agentStatus = {};
      for (const [node, agent] of Object.entries(agents)) {
        const provData = agent.providers?.[p.id];
        agentStatus[node] = provData
          ? { installed: provData.installed, version: provData.version || null, installedAt: provData.installedAt || null, updateAvailable: provData.updateAvailable || null }
          : { installed: false };
      }
      return { ...p, agents: agentStatus };
    });
    res.json({ providers });
  });

  /**
   * POST /providers/:id/install — Install provider on AI agents.
   * Body: { nodes?: string[] } — specific nodes, or all agents.
   * Long-running (up to 10 min per node). Frontend shows spinner.
   */
  router.post('/providers/:id/install', async (req, res) => {
    const providerId = req.params.id;
    if (!getProvider(providerId)) {
      return res.status(404).json({ error: `Unknown provider: ${providerId}` });
    }

    try {
      const cfg = loadAiConfig();
      const opts = {};
      if (req.body?.nodes && Array.isArray(req.body.nodes)) {
        opts.nodes = req.body.nodes;
      }

      const results = await providerInstaller.installProvider(providerId, cfg, opts);

      // Persist install status in ai-config.json
      for (const [node, result] of Object.entries(results)) {
        if (!cfg.agents[node]) continue;
        if (!cfg.agents[node].providers) cfg.agents[node].providers = {};
        if (result.ok && result.status === 'installed') {
          cfg.agents[node].providers[providerId] = {
            installed: true,
            version: result.version || null,
            installedAt: Date.now(),
          };
        }
      }
      saveAiConfig(cfg);

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /providers/:id/uninstall — Uninstall provider from AI agents.
   * Uses pct exec via PVE host (not direct SSH to container).
   * Always clears the config entry regardless of whether rm succeeds.
   * Body: { nodes?: string[] }
   */
  router.post('/providers/:id/uninstall', async (req, res) => {
    const providerId = req.params.id;
    if (!getProvider(providerId)) {
      return res.status(404).json({ error: `Unknown provider: ${providerId}` });
    }

    const cfg = loadAiConfig();
    const agents = cfg.agents || {};
    const nodeMap = pveApi.getNodeMap();
    const targetNodes = (req.body?.nodes && Array.isArray(req.body.nodes))
      ? req.body.nodes
      : Object.keys(agents);
    const results = {};

    for (const node of targetNodes) {
      const agent = agents[node];
      if (!agent?.vmid) {
        results[node] = { ok: false, error: 'No agent designated' };
        continue;
      }

      const hostIp = nodeMap[node]?.ip;
      if (!hostIp) {
        results[node] = { ok: false, error: 'Cannot resolve PVE host IP' };
        continue;
      }

      const installDir = `/opt/${providerId}`;

      // Remove install directory via pct exec (best-effort)
      try {
        await sshService.exec(hostIp, `pct exec ${agent.vmid} -- rm -rf ${installDir}`, { timeout: 15000 });
        results[node] = { ok: true, status: 'not_installed' };
      } catch {
        // Even if rm fails, still clear the config entry
        results[node] = { ok: true, status: 'not_installed', note: 'rm failed but config cleared' };
      }

      // Always clear the config entry
      if (agent.providers?.[providerId]) {
        delete agent.providers[providerId];
      }
    }

    saveAiConfig(cfg);
    res.json({ results });
  });

  /**
   * POST /providers/:id/status — Live status check on all agents via SSH.
   * Body: { nodes?: string[] }
   */
  router.post('/providers/:id/status', async (req, res) => {
    const providerId = req.params.id;
    if (!getProvider(providerId)) {
      return res.status(404).json({ error: `Unknown provider: ${providerId}` });
    }

    try {
      const cfg = loadAiConfig();
      const opts = {};
      if (req.body?.nodes && Array.isArray(req.body.nodes)) {
        opts.nodes = req.body.nodes;
      }

      const results = await providerInstaller.checkStatus(providerId, cfg, opts);

      // Update cached status in ai-config.json
      for (const [node, result] of Object.entries(results)) {
        if (!cfg.agents[node]) continue;
        if (!cfg.agents[node].providers) cfg.agents[node].providers = {};
        if (result.ok) {
          if (result.status === 'installed') {
            cfg.agents[node].providers[providerId] = {
              installed: true,
              version: result.version || null,
              installedAt: cfg.agents[node].providers[providerId]?.installedAt || null,
            };
          } else {
            delete cfg.agents[node].providers[providerId];
          }
        }
      }
      saveAiConfig(cfg);

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /providers/:id/check-update — Check for available updates.
   * Body: { nodes?: string[] }
   */
  router.post('/providers/:id/check-update', async (req, res) => {
    const providerId = req.params.id;
    if (!getProvider(providerId)) {
      return res.status(404).json({ error: `Unknown provider: ${providerId}` });
    }
    try {
      const cfg = loadAiConfig();
      const opts = req.body?.nodes ? { nodes: req.body.nodes } : {};
      const results = await providerInstaller.checkUpdate(providerId, cfg, opts);

      // Store update info in ai-config
      for (const [node, result] of Object.entries(results)) {
        if (!cfg.agents[node]?.providers?.[providerId]) continue;
        if (result.updateAvailable) {
          cfg.agents[node].providers[providerId].updateAvailable = result.updateAvailable;
        } else {
          delete cfg.agents[node].providers[providerId].updateAvailable;
        }
      }
      saveAiConfig(cfg);

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /providers/:id/update — Update provider on agents.
   * Body: { nodes?: string[] }
   */
  router.post('/providers/:id/update', async (req, res) => {
    const providerId = req.params.id;
    if (!getProvider(providerId)) {
      return res.status(404).json({ error: `Unknown provider: ${providerId}` });
    }
    try {
      const cfg = loadAiConfig();
      const opts = req.body?.nodes ? { nodes: req.body.nodes } : {};
      const results = await providerInstaller.updateProvider(providerId, cfg, opts);

      // Update cached version info
      for (const [node, result] of Object.entries(results)) {
        if (!cfg.agents[node]) continue;
        if (!cfg.agents[node].providers) cfg.agents[node].providers = {};
        if (result.ok && result.status === 'installed') {
          cfg.agents[node].providers[providerId] = {
            installed: true,
            version: result.version || null,
            installedAt: cfg.agents[node].providers[providerId]?.installedAt || null,
          };
          delete cfg.agents[node].providers[providerId].updateAvailable;
        }
      }
      saveAiConfig(cfg);

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Model Cache (tmpfs RAM Drive) ──────────────────────────────────────

  /** Helper: resolve node name to agent vmid + PVE host IP */
  function resolveAgent(node) {
    const cfg = loadAiConfig();
    const agent = cfg.agents?.[node];
    if (!agent?.vmid) return null;
    const hostIp = pveApi.getNodeMap()[node]?.ip;
    if (!hostIp) return null;
    return { vmid: agent.vmid, hostIp, node };
  }

  /** GET /models/cache — List cached models with live status + capacity */
  router.get('/models/cache', async (req, res) => {
    try {
      const manifest = loadCacheManifest();
      const entries = manifest.entries || [];
      const capacities = {};

      // Group entries by node
      const byNode = {};
      for (const e of entries) {
        if (!byNode[e.node]) byNode[e.node] = [];
        byNode[e.node].push(e);
      }

      // For each node, verify files + get capacity
      const cfg = loadAiConfig();
      const nodeMap = pveApi.getNodeMap();
      const agents = cfg.agents || {};

      for (const [node, agent] of Object.entries(agents)) {
        if (!agent.vmid) continue;
        if (!isCacheEnabled(node)) continue;
        const hostIp = nodeMap[node]?.ip;
        if (!hostIp) continue;

        const cachePath = getCachePath(node);
        const cacheConfig = cfg.agents?.[node]?.cache;
        const hostCachePath = cacheConfig?.hostPath || '';
        const useHostPaths = !!(hostCachePath && cacheConfig?.modelsHostPath);
        const nodeEntries = byNode[node] || [];

        // Build verification + df command — use host paths when available
        const dfPath = useHostPaths ? hostCachePath : cachePath;
        let verifyScript = `df -m "${dfPath}" 2>/dev/null | tail -1`;
        if (nodeEntries.length > 0) {
          const checks = nodeEntries.map(e => {
            const checkDir = useHostPaths ? toHostCachePath(node, e.cacheDir) : e.cacheDir;
            // `-e` matches both file (single-file cache) and directory entries.
            if (!e.cachedAt) {
              return `if [ -e "${checkDir}" ]; then sz=$(du -sm "${checkDir}" 2>/dev/null | cut -f1); echo "SZ:${e.cacheDir}:$sz"; else echo "MISS:${e.cacheDir}"; fi`;
            }
            return `[ -e "${checkDir}" ] && echo "OK:${e.cacheDir}" || echo "MISS:${e.cacheDir}"`;
          }).join('; ');
          verifyScript = `${checks}; ${verifyScript}`;
        }

        try {
          // Run directly on host when host paths configured, else via pct exec
          const cmd = useHostPaths
            ? `bash -c '${verifyScript}'`
            : `pct exec ${agent.vmid} -- bash -c '${verifyScript}'`;
          const result = await sshService.exec(hostIp, cmd, { timeout: 15000 });
          const lines = result.stdout.split('\n').filter(Boolean);

          for (const line of lines) {
            if (line.startsWith('SZ:')) {
              const parts = line.substring(3).split(':');
              const dir = parts[0];
              const currentMB = parseInt(parts[1], 10) || 0;
              const entry = nodeEntries.find(e => e.cacheDir === dir);
              if (entry) { entry.status = 'caching'; entry.progressMB = currentMB; }
            } else if (line.startsWith('OK:')) {
              const dir = line.substring(3);
              const entry = nodeEntries.find(e => e.cacheDir === dir);
              if (entry) entry.status = 'cached';
            } else if (line.startsWith('MISS:')) {
              const dir = line.substring(5);
              const entry = nodeEntries.find(e => e.cacheDir === dir);
              if (entry) entry.status = entry.cachedAt ? 'missing' : 'caching';
            } else if (/^\S+\s+\d+/.test(line)) {
              const parts = line.trim().split(/\s+/);
              capacities[node] = {
                totalMB: parseInt(parts[1], 10) || 0,
                usedMB: parseInt(parts[2], 10) || 0,
                freeMB: parseInt(parts[3], 10) || 0,
                vmid: agent.vmid,
              };
            }
          }
        } catch {
          for (const e of nodeEntries) e.status = 'unknown';
        }

        // Capacity fallback if no entries triggered the df
        if (!capacities[node]) {
          try {
            const cmd = useHostPaths
              ? `df -m "${dfPath}" 2>/dev/null | tail -1`
              : `pct exec ${agent.vmid} -- df -m ${cachePath} 2>/dev/null | tail -1`;
            const result = await sshService.exec(hostIp, cmd, { timeout: 10000 });
            const parts = result.stdout.trim().split(/\s+/);
            if (parts.length >= 4) {
              capacities[node] = {
                totalMB: parseInt(parts[1], 10) || 0,
                usedMB: parseInt(parts[2], 10) || 0,
                freeMB: parseInt(parts[3], 10) || 0,
                vmid: agent.vmid,
              };
            }
          } catch {}
        }
      }

      // Mark entries with status from copy queue (queued vs caching)
      for (const e of entries) {
        if (!e.status && !e.cachedAt) {
          // Check if this entry is queued or actively copying
          const q = copyQueues[e.node];
          if (q?.currentCacheDir === e.cacheDir) {
            e.status = 'caching';
          } else if (q?.pending.some(p => p.cacheDir === e.cacheDir)) {
            e.status = 'queued';
            e.queuePosition = q.pending.findIndex(p => p.cacheDir === e.cacheDir) + 1;
          } else {
            e.status = 'caching';
          }
        }
        if (!e.status) e.status = e.cachedAt ? 'cached' : 'caching';
      }

      res.json({ entries, capacities });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /models/cached — Lightweight list of cached models that also have a launch template */
  router.get('/models/cached', (req, res) => {
    const manifest = loadCacheManifest();
    const cached = (manifest.entries || []).filter(e => e.cachedAt);
    const { node } = req.query;
    const filtered = node ? cached.filter(e => e.node === node) : cached;

    // Only return entries that have a matching launch template (kcpps ready)
    const templates = loadLaunchTemplates().templates || [];
    const templateKeys = new Set(templates.map(t => `${t.family}|${t.variant}|${t.quant}`));
    const ready = filtered.filter(e => templateKeys.has(`${e.family}|${e.variant}|${e.quant}`));

    res.json({ entries: ready });
  });

  /** GET /cache/browse — Browse the imagegen or tts tree on a node.
   *
   * Query: node, root (imagegen|tts|models), path (relative, optional)
   * Returns { cwd, dirs: [name], files: [{ name, sizeMB }] }
   *
   * Used by the model cacher UI to let the user point-and-click at a folder
   * to cache, without having to type the full /imagegen/... path manually.
   */
  router.get('/cache/browse', async (req, res) => {
    const { node, root, path: relPath } = req.query;
    if (!node || !root) return res.status(400).json({ error: 'node and root required' });
    const rootSpec = CACHE_SOURCE_ROOTS.find(r => r.type === root || r.prefix === '/' + root);
    if (!rootSpec) return res.status(400).json({ error: `unknown root: ${root}` });

    const cfg = loadAiConfig();
    const cache = cfg.agents?.[node]?.cache;
    if (!cache) return res.status(400).json({ error: `cache not configured for ${node}` });
    const hostRoot = cache[rootSpec.hostField];
    if (!hostRoot) return res.status(400).json({ error: `no host path for ${rootSpec.prefix} on ${node}` });

    // Prevent path-traversal: reject any '..' segments
    const safe = (relPath || '').split('/').filter(s => s && s !== '..').join('/');
    const absPath = safe ? `${hostRoot}/${safe}` : hostRoot;

    const agent = resolveAgent(node);
    if (!agent) return res.status(400).json({ error: `no agent for ${node}` });
    const hostIp = agent.hostIp || pveApi.getNodeMap()[node]?.ip;
    if (!hostIp) return res.status(400).json({ error: `no host IP for ${node}` });

    // Single ls call with size in bytes; trailing slash on dirs marks them.
    // Inner awk uses single quotes — base64-encode the script to avoid
    // breaking the outer bash -c '...' quoting.
    const script = `cd "${absPath}" 2>/dev/null && ls -la --time-style=+%s 2>/dev/null | awk 'NR>1 && $NF != "." && $NF != ".." { type=substr($1,1,1); size=$5; name=$NF; for(i=8;i<NF;i++) name=$i" "name; printf "%s\\t%s\\t%s\\n", type, size, name }' || echo "ERR:no-dir"`;
    const b64 = Buffer.from(script).toString('base64');
    try {
      const result = await sshService.exec(hostIp, `echo ${b64} | base64 -d | bash`, { timeout: 10000 });
      if (result.stdout.includes('ERR:no-dir')) return res.status(404).json({ error: `path not found: ${absPath}` });
      const dirs = [];
      const files = [];
      for (const line of result.stdout.split('\n').filter(Boolean)) {
        const [type, sizeStr, ...nameParts] = line.split('\t');
        const name = nameParts.join('\t');
        if (!name) continue;
        if (type === 'd') dirs.push(name);
        else if (type === '-' || type === 'l') files.push({ name, sizeMB: Math.round((parseInt(sizeStr, 10) || 0) / 1024 / 1024) });
      }
      dirs.sort();
      files.sort((a, b) => a.name.localeCompare(b.name));
      // Return container-relative path so the UI can pass it back to POST /models/cache
      const containerPath = rootSpec.prefix + (safe ? '/' + safe : '');
      res.json({ cwd: containerPath, hostPath: absPath, dirs, files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /models/cache — Cache a model (copy NAS → tmpfs).
   *
   * Accepts sources under /models/ (LLM, legacy), /imagegen/, or /tts/.
   * `type` is inferred from the sourceDir prefix unless passed explicitly.
   * For LLM entries, family/variant/quant are required (used as the manifest
   * lookup key by other features). For imagegen/tts, only sourceDir is
   * required; displayName is derived from the source path's last 1-3 segments.
   */
  router.post('/models/cache', async (req, res) => {
    const { node, family, variant, quant, sourceDir, sizeMB, type: explicitType, displayName } = req.body;
    if (!node || !sourceDir) {
      return res.status(400).json({ error: 'node and sourceDir are required' });
    }

    const cacheType = explicitType || inferCacheType(sourceDir);
    if (!cacheType) {
      return res.status(400).json({ error: 'sourceDir must start with /models/, /imagegen/, or /tts/' });
    }

    if (cacheType === 'llm' && (!family || !variant || !quant)) {
      return res.status(400).json({ error: 'family, variant, quant are required for LLM entries' });
    }

    const agent = resolveAgent(node);
    if (!agent) return res.status(400).json({ error: `No agent for node ${node}` });

    const cachePath = getCachePath(node);
    const cacheDir = sourceToCacheDir(sourceDir, cachePath);
    if (!cacheDir || cacheDir === sourceDir) {
      return res.status(400).json({ error: 'unable to map sourceDir to a cache path' });
    }

    // Check for duplicate
    const manifest = loadCacheManifest();
    const existing = manifest.entries.find(e => e.node === node && e.cacheDir === cacheDir);
    if (existing) {
      return res.status(409).json({ error: 'Model already cached or caching', entry: existing });
    }

    const hostSrc = toHostSourcePath(node, sourceDir);
    const hostDst = toHostCachePath(node, cacheDir);

    // Free-space pre-check
    try {
      const dfTarget = hostDst
        ? hostDst.substring(0, hostDst.lastIndexOf('/'))
        : cachePath;
      const dfCmd = hostDst
        ? `df -m "${dfTarget}" 2>/dev/null | tail -1`
        : `pct exec ${agent.vmid} -- df -m "${cachePath}" 2>/dev/null | tail -1`;
      const dfResult = await sshService.exec(agent.hostIp, dfCmd, { timeout: 10000 });
      const parts = dfResult.stdout.trim().split(/\s+/);
      const freeMB = parseInt(parts[3], 10) || 0;
      if (sizeMB && freeMB > 0 && sizeMB > freeMB) {
        return res.status(400).json({
          error: 'insufficient_space',
          freeMB,
          requiredMB: sizeMB,
          message: `Not enough cache space: ${Math.round(freeMB / 1024)} GB free, need ${Math.round(sizeMB / 1024)} GB`,
        });
      }
    } catch {} // If df fails, allow the cache attempt anyway

    // Add entry with cachedAt=null (in-progress). type defaults to 'llm' (no
    // field written) for legacy compatibility with pre-existing entries.
    const entry = {
      node, vmid: agent.vmid,
      sourceDir, cacheDir,
      sizeMB: sizeMB || null, cachedAt: null,
    };
    if (cacheType === 'llm') {
      entry.family = family;
      entry.variant = variant;
      entry.quant = quant;
    } else {
      entry.type = cacheType;
      entry.displayName = displayName || sourceDir.split('/').slice(-3).join('/');
    }
    manifest.entries.push(entry);
    saveCacheManifest(manifest);

    // Enqueue copy — sequential per node to prevent partial caches and manifest races
    if (!copyQueues[node]) copyQueues[node] = { active: false, pending: [], currentCacheDir: null };
    copyQueues[node].pending.push({ hostIp: agent.hostIp, vmid: agent.vmid, sourceDir, cacheDir, hostSrc, hostDst });
    startNextCopy(node, sshService, hookscriptDeploy);

    res.json({ entry, status: 'caching' });
  });

  /** POST /models/cache/reconcile — Manual kickstart of the auto model-cacher (#266).
   * Re-runs the same reconcile that fires on boot: repopulate any manifest entry whose tmpfs
   * copy is missing/truncated (via the sequential per-node copy queue) and clean orphans.
   * Returns a summary + current per-node queue depth. */
  router.post('/models/cache/reconcile', async (req, res) => {
    try {
      const summary = await runCacheReconcile('manual');
      const queues = {};
      for (const [node, q] of Object.entries(copyQueues)) {
        queues[node] = { active: q.active, pending: q.pending.length, current: q.currentCacheDir };
      }
      res.json({ ...summary, queues });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /models/cache/reconcile — Report the last reconcile summary + live queue depth. */
  router.get('/models/cache/reconcile', (req, res) => {
    const queues = {};
    for (const [node, q] of Object.entries(copyQueues)) {
      queues[node] = { active: q.active, pending: q.pending.length, current: q.currentCacheDir };
    }
    res.json({ running: cacheReconcileRunning, last: lastCacheReconcile, queues });
  });

  /** DELETE /models/cache — Remove a cached model.
   *
   * Two identification modes:
   *   1. Legacy: ?node=&family=&variant=&quant=  (LLM entries only)
   *   2. Generic: ?node=&cacheDir=  (works for any entry type, including imagegen/tts)
   */
  router.delete('/models/cache', async (req, res) => {
    const { node, family, variant, quant, cacheDir } = req.query;
    if (!node || (!cacheDir && (!family || !variant || !quant))) {
      return res.status(400).json({ error: 'node + cacheDir, OR node + family + variant + quant required' });
    }

    const agent = resolveAgent(node);
    if (!agent) return res.status(400).json({ error: `No agent for node ${node}` });

    const manifest = loadCacheManifest();
    const idx = cacheDir
      ? manifest.entries.findIndex(e => e.node === node && e.cacheDir === cacheDir)
      : manifest.entries.findIndex(e => e.node === node && e.family === family && e.variant === variant && e.quant === quant);
    if (idx === -1) return res.status(404).json({ error: 'Cache entry not found' });

    const entry = manifest.entries[idx];

    // Remove from disk — prefer host-side rm to avoid cgroup charges
    try {
      const hostDir = toHostCachePath(node, entry.cacheDir);
      const rmCmd = hostDir
        ? `rm -rf "${hostDir}"`
        : `pct exec ${agent.vmid} -- rm -rf "${entry.cacheDir}"`;
      await sshService.exec(agent.hostIp, rmCmd, { timeout: 30000 });
    } catch (err) {
      console.error(`[cache] Failed to rm ${entry.cacheDir}:`, err.message);
    }

    // Remove from manifest
    manifest.entries.splice(idx, 1);
    saveCacheManifest(manifest);

    // Redeploy hookscript vars
    try {
      const assignments = loadGpuAssignments();
      const assign = assignments[String(agent.vmid)];
      if (assign && hookscriptDeploy) {
        await hookscriptDeploy.deployContainerVars(agent.vmid, assign);
      }
    } catch (err) {
      console.error(`[cache] Failed to redeploy vars for CT ${agent.vmid}:`, err.message);
    }

    res.json({ deleted: true });
  });

  // ─── Launch Templates CRUD ──────────────────────────────────────────────

  /** GET /templates — List all saved launch templates */
  router.get('/templates', (req, res) => {
    res.json(loadLaunchTemplates());
  });

  /** POST /templates — Create or update a launch template */
  router.post('/templates', (req, res) => {
    const { id, name, providerId, family, variant, format, quant, settings } = req.body;
    if (!name || !providerId) {
      return res.status(400).json({ error: 'name and providerId are required' });
    }

    const data = loadLaunchTemplates();
    const now = new Date().toISOString();

    if (id) {
      // Update existing
      const idx = data.templates.findIndex(t => t.id === id);
      if (idx !== -1) {
        data.templates[idx] = { ...data.templates[idx], name, providerId, family, variant, format, quant, settings, updatedAt: now };
        saveLaunchTemplates(data);
        return res.json(data.templates[idx]);
      }
    }

    // Create new
    const newId = Math.random().toString(16).slice(2, 8);
    const template = { id: newId, name, createdAt: now, updatedAt: now, providerId, family, variant, format, quant, settings };
    data.templates.push(template);
    saveLaunchTemplates(data);
    res.json(template);
  });

  /** DELETE /templates/:id — Remove a launch template */
  router.delete('/templates/:id', (req, res) => {
    const data = loadLaunchTemplates();
    const idx = data.templates.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Template not found' });
    data.templates.splice(idx, 1);
    saveLaunchTemplates(data);
    res.json({ deleted: true });
  });

  // ─── HuggingFace Model Downloader ───────────────────────────────────

  /** Recursively walk HF tree API and return flat file list */
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
      const effectiveToken = token || ui.hfToken || loadClusterHfToken();

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
   * GET /hf/families — list existing model-family folders (immediate subdirs of the category's
   * basePath) so the downloader's "Save location" can offer them as a picker. Local fs read on CT152
   * (the ZFS bind mount), no SSH.
   */
  router.get('/hf/families', (req, res) => {
    try {
      const category = req.query.category || 'llm';
      const fmCfg = JSON.parse(readFileSync(join(dataDir, 'file-manager.json'), 'utf8'));
      const basePath = fmCfg.tabs?.[category]?.basePath;
      if (!basePath || !existsSync(basePath)) return res.json({ families: [] });
      const families = readdirSync(basePath, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
        .map(d => d.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      res.json({ families });
    } catch (err) {
      res.status(500).json({ error: err.message, families: [] });
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

    // Essential config/tokenizer/index sidecars — REQUIRED to load any model.
    // Must always be surfaced (and default-checked) in the UI, or quantized LLM
    // repos (EXL2/EXL3/AWQ/GPTQ) download as unusable weight-only folders.
    const ESSENTIAL_NAMES = new Set(['config.json','configuration.json','tokenizer_config.json',
      'tokenizer.json','tokenizer.model','vocab.json','merges.txt','special_tokens_map.json',
      'added_tokens.json','generation_config.json','preprocessor_config.json',
      'video_preprocessor_config.json','quantization_config.json','quant_config.json',
      'model.safetensors.index.json','chat_template.json','chat_template.jinja']);
    const isEssentialSidecar = (p) => {
      const name = p.split('/').pop().toLowerCase();
      return ESSENTIAL_NAMES.has(name) || name.includes('tokenizer')
        || name.endsWith('.index.json') || name.endsWith('chat_template.jinja');
    };
    const essentials = files.filter(f => isEssentialSidecar(f.path));

    // Non-model files (extras) — truly optional (README, images, license, .gitattributes).
    const extras = files.filter(f => {
      const ext = f.path.split('.').pop().toLowerCase();
      return ['md', 'txt', 'json', 'yaml', 'yml', 'gitattributes', 'jpg', 'jpeg', 'png', 'gif'].includes(ext)
        && !isEssentialSidecar(f.path) && f.path !== 'model_index.json'
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
    } else if (hasSafetensors && hasConfig && hasTokenizer && !hasModelIndex && !hasAdapterConfig) {
      // Transformers-format LLM: config.json + tokenizer + sharded safetensors.
      // Covers full-precision AND quantized (EXL2/EXL3/AWQ/GPTQ) LLMs — NOT an SD checkpoint.
      const isQuant = /(exl2|exl3|exllama|awq|gptq|int4|int8|w4a16|w8a16|marlin|bnb|nf4|hqq|4bit|8bit)/i.test(repoName)
        || paths.includes('quantization_config.json') || paths.includes('quant_config.json');
      repoType = isQuant ? 'llm-quant' : 'llm';
      suggestedFolder = '';
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
      'llm':       { label: 'LLM weights (Transformers safetensors)', hint: 'Full-precision LLM (config + tokenizer + shards). Save under your LLM family folder; grab ALL config + tokenizer files.' },
      'llm-quant': { label: 'Quantized LLM (EXL2 / EXL3 / AWQ / GPTQ)', hint: 'Quantized LLM weights + config/tokenizer. Save under your LLM family folder; download every config + tokenizer file or it will not load.' },
      'unknown':   { label: 'Unknown structure', hint: 'Inspect the file listing manually.' },
    };
    const typeMeta = TYPE_LABELS[repoType] || TYPE_LABELS['unknown'];

    // Model artifacts for non-GGUF / non-diffusers repos (plain safetensors, full/quant LLM,
    // transformers repos with custom .py code, e.g. deepseek-ai/DeepSeek-OCR-2). Their weights +
    // custom code live in NO other returned list (ggufQuants is GGUF-only, components is diffusers-
    // only, essentials is just config/tokenizer sidecars, extras is README/images) — so the picker
    // showed "0 files available to download". Surface every real artifact (weights + code + essential
    // sidecars), excluding only the truly-optional extras and GGUF (handled by ggufQuants).
    const extraSet = new Set(extras.map(e => e.path));
    const weightFiles = (!hasGguf && !hasModelIndex)
      ? files
          .filter(f => !extraSet.has(f.path) && !f.path.endsWith('.gguf'))
          .map(f => ({ path: f.path, name: f.path.split('/').pop(), size: f.size || 0 }))
          .sort((a, b) => (b.size || 0) - (a.size || 0))
      : [];

    return {
      repoType,
      suggestedFolder,
      suggestedName,
      analysisLabel: typeMeta.label,
      analysisHint: typeMeta.hint,
      ggufQuants,
      weightFiles,
      components,
      essentials: essentials.map(f => ({ path: f.path, size: f.size })),
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
    // Map container path to host path
    const hostPath = targetDir.replace(/^\/ai-assets\//, '/mnt/flashpool/ai-assets/');
    if (hostPath === targetDir) return; // No mapping — skip

    // Read the file-manager config to get the host IP
    let hostIp = '10.0.0.17'; // default PBS host
    try {
      const fmCfg = JSON.parse(readFileSync(join(dataDir, 'file-manager.json'), 'utf8'));
      for (const tab of Object.values(fmCfg.tabs || {})) {
        if (tab.hostIp) { hostIp = tab.hostIp; break; }
      }
    } catch {}

    const filePath = fileName ? `${hostPath}/${fileName}` : hostPath;
    const cmd = `chmod -R 777 "${hostPath}" 2>/dev/null; chmod 777 "${filePath}" 2>/dev/null`;
    sshService.exec(hostIp, cmd, { timeout: 10000 }).catch(err => {
      console.warn(`[hf-download] chmod failed on ${hostIp}: ${err.message}`);
    });
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

      const token = next.token || ui.hfToken || loadClusterHfToken();
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
      // -f (--fail): on HTTP >= 400 (expired signed CDN URL, 416 from a stale-range resume, 5xx,
      // gated/404) curl exits non-zero instead of writing the error body to the output file. Without
      // it, curl saved e.g. a tiny error page as the .part, exited 0, the `&& mv` promoted it to the
      // final path, and the monitor reported a bogus "Download process exited unexpectedly".
      const args = ['-fL', '-o', partFile, '--retry', '3', '--retry-delay', '5', '-C', '-'];
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
      const fmCfgPath = join(dataDir, 'file-manager.json');
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

      // EXL3 (check before EXL2 since EXL3 is newer). bpw is usually only in the
      // REPO name (shards are named model-0000x-of-...), so check repoLower too.
      if (lower.includes('exl3') || repoLower.includes('exl3')) {
        const bpwMatch = fileName.match(/(\d+\.?\d*)bpw/i) || repoLower.match(/(\d+\.?\d*)bpw/i)
          || fileName.match(/exl3[_-]?(\d+\.?\d*)/i) || repoLower.match(/exl3[_-]?(\d+\.?\d*)/i);
        const bpw = bpwMatch ? bpwMatch[1] : 'unknown';
        return `${base}/EXL3/${bpw}`;
      }

      // EXL2
      if (lower.includes('exl2') || repoLower.includes('exl2')) {
        const bpwMatch = fileName.match(/(\d+\.?\d*)bpw/i) || repoLower.match(/(\d+\.?\d*)bpw/i)
          || fileName.match(/exl2[_-]?(\d+\.?\d*)/i) || repoLower.match(/exl2[_-]?(\d+\.?\d*)/i);
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
      const effectiveToken = token || ui.hfToken || loadClusterHfToken() || null;

      const manifest = loadHfDownloads();
      const queued = [];

      // LLM sidecar configs/tokenizers MUST land in the SAME quant subfolder as
      // the weight shards. Derive that folder once from the selected weights so
      // configs are not orphaned one level up (where they also clobber other
      // quants of the same format).
      let llmWeightDir = null;
      if (category === 'llm' && !preserveStructure) {
        const wf = (files || []).find(f => /\.(safetensors|bin|pt)$/i.test((f.path || '').split('/').pop()));
        if (wf) llmWeightDir = resolveLlmSubfolder(base, wf.path.split('/').pop(), repo);
      }

      // Guarantee the essential sidecars an LLM needs to load are always queued.
      // Config/tokenizer files sometimes get left out of the selection, producing a
      // downloaded-but-unloadable model (AutoTokenizer falls back to AutoConfig and
      // dies on unknown model_type). Pull any missing essentials from the repo tree.
      if (category === 'llm' && !preserveStructure && llmWeightDir) {
        const ESSENTIAL = ['config.json','configuration.json','tokenizer_config.json',
          'tokenizer.json','tokenizer.model','vocab.json','merges.txt','special_tokens_map.json',
          'added_tokens.json','generation_config.json','preprocessor_config.json','video_preprocessor_config.json',
          'quantization_config.json','quant_config.json','model.safetensors.index.json',
          'chat_template.jinja','chat_template.json'];
        try {
          const tree = await walkHfTree(repo, revision, effectiveToken);
          const have = new Set((files || []).map(f => (f.path || '').split('/').pop().toLowerCase()));
          let added = 0;
          for (const t of tree) {
            const nm = (t.path || '').split('/').pop();
            if (nm && ESSENTIAL.includes(nm.toLowerCase()) && !have.has(nm.toLowerCase())) {
              files.push({ path: t.path, size: t.size || 0 });
              have.add(nm.toLowerCase());
              added++;
            }
          }
          if (added) console.log(`[hf-download] auto-included ${added} essential sidecar file(s) for ${repo}`);
        } catch (e) {
          console.warn(`[hf-download] essential-sidecar backfill skipped for ${repo}: ${e.message}`);
        }
      }

      const mkEntry = (f, targetDir, fileName, hfFilter) => ({
        id: Math.random().toString(16).slice(2, 10),
        repo, revision, fileName, hfPath: f.path, hfFilter,
        size: f.size || 0, targetDir, node: node || '_local', token: effectiveToken,
        concurrent: req.body.concurrent || null, maxActive: req.body.maxActive || null,
        excludeExtras: !req.body.includeExtras, status: 'queued', progress: 0,
        pid: null, startedAt: null, completedAt: null, error: null,
      });

      // Distinct quant/model subfolders that actually receive a model file — the README gets
      // copied into EACH of these (not the parent GGUF/EXL2/AWQ folder) so every quant folder is
      // self-contained.
      const modelDirs = new Set();

      // Create individual queue entries per file
      for (const f of files) {
        const fileName = f.path.split('/').pop();

        // README is handled separately below (copied into every quant subfolder), not placed at base.
        if (category === 'llm' && !preserveStructure && fileName.toLowerCase() === 'readme.md') continue;

        // Build filter for this specific file
        let hfFilter = fileName;
        if (fileName.endsWith('.gguf')) {
          const qm = fileName.match(/((?:I?Q\d+_K(?:_[SMLXS]+)?)|(?:Q\d+_\d+)|(?:IQ\d+_[A-Z]+)|(?:F16|F32|BF16))/i);
          if (qm) hfFilter = qm[1];
        }

        // Determine target directory based on category and file type
        let targetDir;
        if (preserveStructure) {
          const hfDir = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : '';
          targetDir = hfDir ? `${base}/${hfDir}` : base;
        } else if (category === 'llm') {
          if (fileName.toLowerCase().endsWith('.gguf')) {
            // GGUF: each quant level is its own subfolder (resolved per-file)
            targetDir = resolveLlmSubfolder(base, fileName, repo);
          } else if (llmWeightDir) {
            // weights + their config/tokenizer sidecars co-locate in one folder
            targetDir = llmWeightDir;
          } else {
            targetDir = resolveLlmSubfolder(base, fileName, repo);
          }
        } else {
          targetDir = base;
        }

        if (category === 'llm' && !preserveStructure) modelDirs.add(targetDir);
        const entry = mkEntry(f, targetDir, fileName, hfFilter);
        manifest.downloads.push(entry);
        queued.push(entry);
      }

      // ALWAYS copy the repo README into EVERY quant / model subfolder (Q8_0, Q6_K_XL, 4-bit,
      // 4.00bpw, mmproj, ...) so each downloaded folder is self-contained — overwriting any existing
      // copy so README updates are captured. The README is never in hfSelectedFiles (the picker only
      // sends model files), so backfill it from the repo tree.
      if (category === 'llm' && !preserveStructure && modelDirs.size) {
        let readme = (files || []).find(f => (f.path || '').split('/').pop().toLowerCase() === 'readme.md');
        if (!readme) {
          try {
            const tree = await walkHfTree(repo, revision, effectiveToken);
            const t = tree.find(x => (x.path || '').toLowerCase() === 'readme.md');
            if (t) readme = { path: t.path, size: t.size || 0 };
          } catch (e) {
            console.warn(`[hf-download] README backfill skipped for ${repo}: ${e.message}`);
          }
        }
        if (readme) {
          for (const dir of modelDirs) {
            const entry = mkEntry(readme, dir, 'README.md', 'README.md');
            manifest.downloads.push(entry);
            queued.push(entry);
          }
        }
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
              logContent = cleanCurlLog(readFileSync(`/tmp/hfdl-${dl.id}.log`, 'utf8'));
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
              dl.error = logContent || 'Download failed — no output';
            } else {
              dl.status = 'failed';
              const exp = expectedSize ? `${expectedSize}` : 'unknown';
              dl.error = `Download incomplete: got ${finalSize || currentSize} of ${exp} bytes${logContent ? ` — ${logContent}` : ''}`;
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

  /** POST /hf/retry — Retry a failed download */
  router.post('/hf/retry', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const manifest = loadHfDownloads();
    const dl = manifest.downloads.find(d => d.id === id);
    if (!dl) return res.status(404).json({ error: 'Download not found' });
    if (dl.status !== 'failed') return res.status(400).json({ error: 'Can only retry failed downloads' });

    dl.status = 'queued';
    dl.error = null;
    dl.pid = null;
    dl.progress = 0;
    dl.startedAt = null;
    dl.completedAt = null;
    dl.checkFailures = 0;
    saveHfDownloads(manifest);
    processHfQueue(dl.node);
    res.json({ ok: true, id });
  });

  /** GET /hf/history — Get immutable HF download history */
  router.get('/hf/history', (req, res) => {
    const h = loadHfHistory();
    res.json(h);
  });

  /** Startup validation / auto model-cacher (#266): detect missing/truncated cache entries,
   * auto-restore them via the sequential copy queue, and clean orphans. Runs on boot (wired in
   * UniversalProxyService.start) and on manual kickstart (POST /models/cache/reconcile). The cache
   * manifest (model-cache.json) IS the explicit "keep cached" set — this reconciles the on-disk
   * tmpfs cache (cleared by host reboots) back to that set. Returns a summary object. */
  async function validateAndRestoreCache() {
    const summary = {
      startedAt: new Date().toISOString(),
      totalEntries: 0, present: 0, missing: 0, truncated: 0, requeued: 0, orphansRemoved: 0,
      skippedNodes: [], byNode: {},
    };
    const manifest = loadCacheManifest();
    const entries = manifest.entries || [];
    summary.totalEntries = entries.length;
    if (entries.length === 0) {
      console.log('[cache-validate] No cache entries, skipping validation');
      summary.note = 'manifest-empty';
      return summary;
    }

    const cfg = loadAiConfig();
    const nodeMap = pveApi.getNodeMap();
    let manifestChanged = false;

    // Group entries by node
    const byNode = {};
    for (const e of entries) {
      if (!byNode[e.node]) byNode[e.node] = [];
      byNode[e.node].push(e);
    }

    for (const [node, nodeEntries] of Object.entries(byNode)) {
      const agent = cfg.agents?.[node];
      if (!agent?.vmid || !isCacheEnabled(node)) {
        summary.skippedNodes.push(`${node} (${!agent?.vmid ? 'no-vmid' : 'cache-disabled'})`);
        continue;
      }
      const hostIp = nodeMap[node]?.ip;
      if (!hostIp) {
        summary.skippedNodes.push(`${node} (no-host-ip; PVE not ready?)`);
        continue;
      }
      const ns = summary.byNode[node] = { entries: nodeEntries.length, present: 0, missing: 0, truncated: 0, requeued: 0, orphansRemoved: 0 };

      const cachePath = getCachePath(node);
      const cacheConfig = cfg.agents?.[node]?.cache;
      const hostCachePath = cacheConfig?.hostPath || '';

      // Use host paths for validation when available (avoids pct exec cgroup charges)
      const useHostPaths = !!(hostCachePath && cacheConfig?.modelsHostPath);

      // Build a single SSH command that checks all entries + lists orphans
      const checks = nodeEntries.map(e => {
        const checkDir = useHostPaths ? toHostCachePath(node, e.cacheDir) : e.cacheDir;
        return `if [ -d "${checkDir}" ]; then sz=$(du -sm "${checkDir}" 2>/dev/null | cut -f1); echo "EXISTS:${e.cacheDir}:$sz"; else echo "MISS:${e.cacheDir}"; fi`;
      });
      // Find all gguf directories in cache (for orphan detection)
      const findPath = useHostPaths ? hostCachePath : cachePath;
      checks.push(`find ${findPath} -name "*.gguf" -printf "%h\\n" 2>/dev/null | sort -u | while read d; do echo "DIR:$d"; done`);

      try {
        const cmd = useHostPaths
          ? `bash -c '${checks.join("; ")}'`
          : `pct exec ${agent.vmid} -- bash -c '${checks.join("; ")}'`;
        const result = await sshService.exec(hostIp, cmd, { timeout: 30000 });
        const lines = result.stdout.split('\n').filter(Boolean);

        const existingDirs = new Set();
        const foundCacheDirs = new Set();

        for (const line of lines) {
          if (line.startsWith('EXISTS:')) {
            const parts = line.substring(7).split(':');
            const dir = parts[0];
            const actualMB = parseInt(parts[1], 10) || 0;
            existingDirs.add(dir);

            const entry = nodeEntries.find(e => e.cacheDir === dir);
            if (entry && entry.cachedAt && entry.sizeMB) {
              // Size check: if actual < 90% of expected, likely truncated
              if (actualMB < entry.sizeMB * 0.9) {
                console.log(`[cache-validate] ${node}: ${dir} truncated (${actualMB}MB vs expected ${entry.sizeMB}MB), will re-cache`);
                const rmDir = useHostPaths ? toHostCachePath(node, dir) : null;
                const rmCmd = rmDir ? `rm -rf "${rmDir}"` : `pct exec ${agent.vmid} -- rm -rf "${dir}"`;
                await sshService.exec(hostIp, rmCmd, { timeout: 15000 }).catch(() => {});
                entry.cachedAt = null;
                manifestChanged = true;
                summary.truncated++; ns.truncated++;
              } else { summary.present++; ns.present++; }
            } else { summary.present++; ns.present++; }
          } else if (line.startsWith('MISS:')) {
            const dir = line.substring(5);
            const entry = nodeEntries.find(e => e.cacheDir === dir);
            summary.missing++; ns.missing++;
            if (entry && entry.cachedAt) {
              console.log(`[cache-validate] ${node}: ${dir} missing from cache, will re-cache`);
              entry.cachedAt = null;
              manifestChanged = true;
            }
          } else if (line.startsWith('DIR:')) {
            foundCacheDirs.add(line.substring(4));
          }
        }

        // Orphan cleanup — dirs in cache that aren't in the manifest
        // When using host paths, translate manifest dirs to host paths for comparison
        const manifestHostDirs = useHostPaths
          ? new Set(nodeEntries.map(e => toHostCachePath(node, e.cacheDir)).filter(Boolean))
          : new Set(nodeEntries.map(e => e.cacheDir));
        for (const dir of foundCacheDirs) {
          if (!manifestHostDirs.has(dir)) {
            console.log(`[cache-validate] ${node}: orphan directory ${dir}, removing`);
            // dir is already in the right path space (host or container) depending on useHostPaths
            await sshService.exec(hostIp, `rm -rf "${dir}"`, { timeout: 15000 }).catch(() => {});
            summary.orphansRemoved++; ns.orphansRemoved++;
          }
        }

        // Enqueue re-cache for missing/truncated entries via sequential copy queue
        for (const entry of nodeEntries) {
          if (entry.cachedAt === null) {
            console.log(`[cache-validate] ${node}: queuing re-cache ${entry.sourceDir} → ${entry.cacheDir}`);
            const hSrc = toHostSourcePath(node, entry.sourceDir);
            const hDst = toHostCachePath(node, entry.cacheDir);
            if (!copyQueues[node]) copyQueues[node] = { active: false, pending: [], currentCacheDir: null };
            copyQueues[node].pending.push({
              hostIp, vmid: agent.vmid, sourceDir: entry.sourceDir,
              cacheDir: entry.cacheDir, hostSrc: hSrc, hostDst: hDst,
            });
            summary.requeued++; ns.requeued++;
          }
        }
        startNextCopy(node, sshService, hookscriptDeploy);
      } catch (err) {
        console.error(`[cache-validate] ${node}: SSH error during validation:`, err.message);
        ns.error = err.message;
      }
    }

    if (manifestChanged) saveCacheManifest(manifest);
    summary.finishedAt = new Date().toISOString();
    console.log(`[cache-validate] complete — ${summary.present} present, ${summary.missing} missing, ${summary.truncated} truncated, ${summary.requeued} requeued, ${summary.orphansRemoved} orphans removed`);
    return summary;
  }
  // Track the last reconcile summary so the manual endpoint / UI can report it.
  let lastCacheReconcile = null;
  let cacheReconcileRunning = false;
  async function runCacheReconcile(trigger) {
    if (cacheReconcileRunning) return { skipped: 'already-running', lastCacheReconcile };
    cacheReconcileRunning = true;
    try {
      const s = await validateAndRestoreCache();
      s.trigger = trigger;
      lastCacheReconcile = s;
      return s;
    } finally {
      cacheReconcileRunning = false;
    }
  }

  // ─── WebSocket Broadcast ──────────────────────────────────────────────
  let broadcastFn = null;
  function broadcast(msg) { if (broadcastFn) broadcastFn(msg); }

  // ─── Service Health Watchdog ────────────────────────────────────────────
  // Polls health endpoints of all active services every 30s.
  // If a service fails consecutive checks beyond its threshold, auto-restarts via systemd.
  // Services get a startup grace period where health checks are skipped.
  const watchdogFailCounts = {};  // { serviceId: consecutiveFailures }
  const WATCHDOG_INTERVAL = 30000;
  const WATCHDOG_MAX_FAILS_DEFAULT = 5;  // ~2.5 min default (5 x 30s)
  let watchdogEnabled = true;
  let watchdogTimer = null;

  // Per-provider startup grace periods (seconds) — how long to skip health checks after start/restart
  const STARTUP_GRACE = {
    sdnext:    300,  // 5 min — pip installs, model scanning
    comfyui:   180,  // 3 min — custom node loading
    fooocus:   180,
    invokeai:  180,
    vllm:      120,  // 2 min — model loading
    koboldcpp: 90,
    'llama-server': 90,
    'llama-server-mtp': 90,
    default:   60,   // 1 min for everything else
  };

  // Per-provider max fail thresholds (overrides default)
  const WATCHDOG_MAX_FAILS = {
    sdnext:    10,   // 5 min (10 x 30s) — very slow startup
    comfyui:   8,
    vllm:      6,
    default:   WATCHDOG_MAX_FAILS_DEFAULT,
  };

  /** Health check paths by provider */
  const HEALTH_PATHS = {
    koboldcpp: '/api/v1/info/version',
    'llama-server': '/health',
    'llama-server-mtp': '/health',
    vllm: '/health',
    tabbyapi: '/health',
    lmdeploy: '/health',
    sglang: '/health',
    aphrodite: '/health',
    'proxlab-tts': '/health',
    'qwen-tts': '/health',
    's2-pro': '/health',
    alltalk: '/api/ready',
    kokoro: '/v1/models',
    'openedai-speech': '/v1/models',
    piper: '/voices',
    'faster-whisper': '/v1/models',
    comfyui: '/',
    sdnext: '/sdapi/v1/start',
    fooocus: '/',
    invokeai: '/api/v1/app/version',
  };

  // ─── Training Config Management ────────────────────────────────────────

  /** Training tool config paths and CLI commands */
  const TRAINING_TOOLS = {
    simpletuner: {
      installDir: '/opt/simpletuner',
      configDir: '/opt/simpletuner/configs',
      templateCmd: '/opt/conda/envs/simpletuner/bin/simpletuner examples list 2>/dev/null | sed "s/\\x1b\\[[0-9;]*m//g" | grep -v "^$" | grep -v "Available" | sed "s/^\\s*//"',
      templateCopyCmd: (name, dest) => `/opt/conda/envs/simpletuner/bin/simpletuner examples copy ${name} --output ${dest}`,
      configFormat: 'json',
      trainCmd: (configPath) => `cd /opt/simpletuner && /opt/conda/envs/simpletuner/bin/python -m simpletuner train --env ${configPath}`,
    },
    onetrainer: {
      installDir: '/opt/onetrainer',
      configDir: '/opt/onetrainer/training_configs',
      templateDir: '/opt/onetrainer/training_presets',
      configFormat: 'json',
      trainCmd: (configPath) => `cd /opt/onetrainer && /opt/conda/envs/onetrainer/bin/python scripts/train.py --config-path ${configPath}`,
    },
    'ai-toolkit': {
      installDir: '/opt/ai-toolkit',
      configDir: '/opt/ai-toolkit/config/user',
      templateDir: '/opt/ai-toolkit/config/examples',
      configFormat: 'yaml',
      trainCmd: (configPath) => `cd /opt/ai-toolkit && /opt/conda/envs/ai-toolkit/bin/python run.py ${configPath}`,
    },
  };

  /** Resolve agent container for a training provider */
  function resolveTrainingAgent(providerId) {
    const cfg = loadAiConfig();
    for (const [node, agent] of Object.entries(cfg.agents || {})) {
      if (!agent.vmid) continue;
      const provData = agent.providers?.[providerId];
      if (provData?.installed) {
        const nodeMap = pveApi.getNodeMap();
        const hostIp = nodeMap[node]?.ip;
        if (hostIp) return { node, vmid: agent.vmid, hostIp };
      }
    }
    return null;
  }

  /**
   * GET /training/:provider/templates — List available config templates
   */
  router.get('/training/:provider/templates', async (req, res) => {
    const tool = TRAINING_TOOLS[req.params.provider];
    if (!tool) return res.status(404).json({ error: 'Unknown training provider' });

    const agent = resolveTrainingAgent(req.params.provider);
    if (!agent) return res.status(400).json({ error: 'Provider not installed on any agent' });

    try {
      let templates = [];
      if (tool.templateCmd) {
        // SimpleTuner uses CLI to list examples
        const result = await sshService.exec(agent.hostIp, `pct exec ${agent.vmid} -- bash -c '${tool.templateCmd}'`, { timeout: 15000 });
        templates = result.stdout.trim().split('\n').filter(Boolean).map(name => ({ name: name.trim(), type: 'example' }));
      } else if (tool.templateDir) {
        // OneTrainer/AI Toolkit have template directories
        const ext = tool.configFormat === 'yaml' ? 'yaml' : 'json';
        const result = await sshService.exec(agent.hostIp, `pct exec ${agent.vmid} -- find ${tool.templateDir} -maxdepth 1 -name '*.${ext}' -type f 2>/dev/null | sort`, { timeout: 10000 });
        templates = result.stdout.trim().split('\n').filter(Boolean).map(path => {
          const name = path.split('/').pop().replace(`.${ext}`, '');
          return { name, path, type: 'preset' };
        });
      }
      res.json({ templates });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /training/:provider/config/:name — Read a config file
   */
  router.get('/training/:provider/config/:name', async (req, res) => {
    const tool = TRAINING_TOOLS[req.params.provider];
    if (!tool) return res.status(404).json({ error: 'Unknown training provider' });

    const agent = resolveTrainingAgent(req.params.provider);
    if (!agent) return res.status(400).json({ error: 'Provider not installed' });

    try {
      const name = req.params.name;
      let filePath;

      // Check user configs first, then templates
      const ext = tool.configFormat === 'yaml' ? 'yaml' : 'json';
      const userPath = `${tool.configDir}/${name}.${ext}`;
      const checkUser = await sshService.exec(agent.hostIp, `pct exec ${agent.vmid} -- cat '${userPath}' 2>/dev/null`, { timeout: 10000 });

      if (checkUser.code === 0 && checkUser.stdout.trim()) {
        filePath = userPath;
        res.json({ name, path: filePath, format: tool.configFormat, content: checkUser.stdout, source: 'user' });
      } else if (tool.templateDir) {
        // Try template directory
        const templatePath = `${tool.templateDir}/${name}.${ext}`;
        const checkTemplate = await sshService.exec(agent.hostIp, `pct exec ${agent.vmid} -- cat '${templatePath}' 2>/dev/null`, { timeout: 10000 });
        if (checkTemplate.code === 0) {
          res.json({ name, path: templatePath, format: tool.configFormat, content: checkTemplate.stdout, source: 'template' });
        } else {
          res.status(404).json({ error: `Config '${name}' not found` });
        }
      } else if (tool.templateCmd) {
        // SimpleTuner: copy example to get the config
        const tmpDir = `/tmp/proxlab-train-${Date.now()}`;
        const copyCmd = tool.templateCopyCmd(name, tmpDir);
        await sshService.exec(agent.hostIp, `pct exec ${agent.vmid} -- bash -c '${copyCmd}'`, { timeout: 30000 });
        const readCmd = `pct exec ${agent.vmid} -- cat ${tmpDir}/config.json 2>/dev/null`;
        const result = await sshService.exec(agent.hostIp, readCmd, { timeout: 10000 });
        // Clean up temp
        sshService.exec(agent.hostIp, `pct exec ${agent.vmid} -- rm -rf ${tmpDir}`, { timeout: 5000 }).catch(() => {});
        if (result.stdout.trim()) {
          res.json({ name, format: 'json', content: result.stdout, source: 'example' });
        } else {
          res.status(404).json({ error: `Example '${name}' not found` });
        }
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /training/:provider/config/:name — Save a config file
   */
  router.put('/training/:provider/config/:name', async (req, res) => {
    const tool = TRAINING_TOOLS[req.params.provider];
    if (!tool) return res.status(404).json({ error: 'Unknown training provider' });

    const agent = resolveTrainingAgent(req.params.provider);
    if (!agent) return res.status(400).json({ error: 'Provider not installed' });

    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    try {
      const ext = tool.configFormat === 'yaml' ? 'yaml' : 'json';
      const filePath = `${tool.configDir}/${req.params.name}.${ext}`;

      // Create config dir if needed, write file via base64 to avoid quoting issues
      const b64 = Buffer.from(content).toString('base64');
      const writeCmd = `pct exec ${agent.vmid} -- bash -c 'mkdir -p ${tool.configDir} && echo ${b64} | base64 -d > ${filePath}'`;
      await sshService.exec(agent.hostIp, writeCmd, { timeout: 15000 });

      res.json({ ok: true, path: filePath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /training/:provider/datasets — List dataset directories
   */
  router.get('/training/:provider/datasets', async (req, res) => {
    const agent = resolveTrainingAgent(req.params.provider);
    if (!agent) return res.status(400).json({ error: 'Provider not installed' });

    try {
      // Look for dataset directories in common locations
      const cmd = `pct exec ${agent.vmid} -- bash -c '
        for dir in /mnt/shared/datasets /opt/*/datasets /root/datasets; do
          if [ -d "$dir" ]; then
            find "$dir" -maxdepth 2 -type d 2>/dev/null
          fi
        done
      '`;
      const result = await sshService.exec(agent.hostIp, cmd, { timeout: 15000 });
      const dirs = result.stdout.trim().split('\n').filter(Boolean);
      res.json({ datasets: dirs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  async function watchdogCheck() {
    if (!watchdogEnabled) return;
    const state = loadActiveServices();
    const services = Object.entries(state.services || {});
    if (!services.length) return;

    for (const [id, svc] of services) {
      if (!svc.isSystemService || !svc.containerIp || !svc.port) continue;
      if (svc.suspended) continue;

      // Startup grace period — skip health checks for newly started/restarted services
      const graceSec = STARTUP_GRACE[svc.providerId] || STARTUP_GRACE.default;
      const startedAt = svc.startedAt ? new Date(svc.startedAt).getTime() : 0;
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed < graceSec) continue; // Still in grace period

      const maxFails = WATCHDOG_MAX_FAILS[svc.providerId] || WATCHDOG_MAX_FAILS.default;
      const healthPath = HEALTH_PATHS[svc.providerId] || '/health';
      const url = `http://${svc.containerIp}:${svc.port}${healthPath}`;

      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const resp = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);

        if (resp.ok) {
          if (watchdogFailCounts[id]) {
            console.log(`[watchdog] ${svc.providerId}:${svc.port} recovered`);
            delete watchdogFailCounts[id];
            broadcast({ type: 'watchdog-recovered', serviceId: id, name: svc.providerId });
          }
        } else {
          throw new Error(`HTTP ${resp.status}`);
        }
      } catch (e) {
        watchdogFailCounts[id] = (watchdogFailCounts[id] || 0) + 1;
        const fails = watchdogFailCounts[id];
        console.warn(`[watchdog] ${svc.providerId}:${svc.port} failed (${fails}/${maxFails}): ${e.message}`);

        if (fails >= maxFails) {
          console.warn(`[watchdog] Auto-restarting ${svc.providerId}:${svc.port} after ${fails} consecutive failures`);
          try {
            const cmd = `pct exec ${svc.vmid} -- bash -c 'systemctl reset-failed ${svc.systemdUnit} 2>/dev/null; systemctl restart ${svc.systemdUnit}'`;
            await sshService.exec(svc.pveHostIp, cmd, { timeout: 15000 });
            svc.startedAt = new Date().toISOString();
            saveActiveServices(state);
            broadcast({ type: 'watchdog-restart', serviceId: id, name: svc.providerId });
            console.log(`[watchdog] ${svc.providerId}:${svc.port} restart issued`);
          } catch (restartErr) {
            console.error(`[watchdog] Failed to restart ${svc.providerId}:${svc.port}: ${restartErr.message}`);
          }
          delete watchdogFailCounts[id];
        }
      }
    }
  }

  function startWatchdog() {
    if (watchdogTimer) return;
    // Delay first check 60s to let services finish starting
    setTimeout(() => {
      watchdogCheck();
      watchdogTimer = setInterval(watchdogCheck, WATCHDOG_INTERVAL);
    }, 60000);
    console.log(`[watchdog] Service health monitoring started (every ${WATCHDOG_INTERVAL / 1000}s, ${WATCHDOG_MAX_FAILS} fails to restart)`);
  }

  function stopWatchdog() {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  }

  /** GET /watchdog/status */
  router.get('/watchdog/status', (req, res) => {
    res.json({ enabled: watchdogEnabled, interval: WATCHDOG_INTERVAL, maxFails: WATCHDOG_MAX_FAILS, failCounts: watchdogFailCounts });
  });

  /** PUT /watchdog/status — enable/disable */
  router.put('/watchdog/status', (req, res) => {
    if (req.body.enabled !== undefined) {
      watchdogEnabled = req.body.enabled;
      if (!watchdogEnabled) stopWatchdog();
      else startWatchdog();
    }
    res.json({ enabled: watchdogEnabled });
  });

  /** Ensure SSH key is deployed to all designated agent containers */
  async function ensureAgentSshKeys() {
    const cfg = loadAiConfig();
    const agents = cfg.agents || {};
    const pubKeyPath = config.ssh.privateKeyPath + '.pub';
    if (!existsSync(pubKeyPath)) return;
    const pubKey = readFileSync(pubKeyPath, 'utf-8').trim();
    const keyFingerprint = pubKey.split(' ')[1] || '';
    const nodeMap = pveApi.getNodeMap();

    for (const [node, agent] of Object.entries(agents)) {
      if (!agent.vmid) continue;
      const hostIp = nodeMap[node]?.ip;
      if (!hostIp) continue;
      try {
        // Check if key is already there
        const checkCmd = `pct exec ${agent.vmid} -- grep -qF "${keyFingerprint}" /root/.ssh/authorized_keys 2>/dev/null && echo OK || echo MISSING`;
        const result = await sshService.exec(hostIp, checkCmd, { timeout: 10000 });
        if (result.stdout.trim() === 'MISSING') {
          const addCmd = `pct exec ${agent.vmid} -- bash -c 'mkdir -p /root/.ssh && echo "${pubKey}" >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys'`;
          await sshService.exec(hostIp, addCmd, { timeout: 10000 });
          console.log(`[agent] SSH key deployed to CT ${agent.vmid} on ${node}`);
        }
      } catch (err) {
        console.warn(`[agent] SSH key check for CT ${agent.vmid} on ${node} failed: ${err.message}`);
      }
    }
  }

  // ─── Central Directives (shared Claude Code instructions) ────────────
  const directivesPath = '/claude/CENTRAL-DIRECTIVES.md';

  /** GET /directives — read the central directives file */
  router.get('/directives', (req, res) => {
    try {
      if (!existsSync(directivesPath)) return res.json({ content: '' });
      const content = readFileSync(directivesPath, 'utf-8');
      res.json({ content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** PUT /directives — write the central directives file */
  router.put('/directives', (req, res) => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
      writeFileSync(directivesPath, content, 'utf-8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Sampler Presets ────────────────────────────────────────────────────
  // Persisted at data/sampler-presets.json. Built-in (read-only) presets are
  // hardcoded on the frontend — only USER-defined presets live here.
  // Schema: { presets: [{ id, name, readOnly, providerId?, values: {...} }] }

  const samplerPresetsPath = join(dataDir, 'sampler-presets.json');

  function loadSamplerPresets() {
    try {
      if (existsSync(samplerPresetsPath)) {
        const raw = JSON.parse(readFileSync(samplerPresetsPath, 'utf-8'));
        if (Array.isArray(raw?.presets)) return raw;
      }
    } catch {}
    return { presets: [] };
  }
  function saveSamplerPresets(state) {
    writeFileSync(samplerPresetsPath, JSON.stringify(state, null, 2), 'utf-8');
  }
  const isPlainValues = (v) =>
    v && typeof v === 'object' && !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean');

  router.get('/sampler-presets', (_req, res) => {
    res.json(loadSamplerPresets());
  });
  router.post('/sampler-presets', (req, res) => {
    const { name, providerId, readOnly, values } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
    if (!isPlainValues(values)) return res.status(400).json({ error: 'values must be a flat object of primitives' });
    const state = loadSamplerPresets();
    const id = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const preset = {
      id, name: name.trim(),
      readOnly: !!readOnly,
      ...(providerId ? { providerId } : {}),
      values,
    };
    state.presets.push(preset);
    saveSamplerPresets(state);
    res.json({ preset });
  });
  router.put('/sampler-presets/:id', (req, res) => {
    const { values, name, readOnly } = req.body || {};
    const state = loadSamplerPresets();
    const idx = state.presets.findIndex((p) => p.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    // The frontend gates updates with the Read-Only checkbox. The lock is a
    // soft UI guard, not a hard backend constraint — users explicitly
    // unlocking a preset should be able to update it (they may need to fix
    // a value they accidentally saved). The previous 403 made overrides
    // impossible without deleting and recreating the preset.
    if (values !== undefined) {
      if (!isPlainValues(values)) return res.status(400).json({ error: 'values must be a flat object of primitives' });
      state.presets[idx].values = values;
    }
    if (typeof name === 'string' && name.trim()) state.presets[idx].name = name.trim();
    if (typeof readOnly === 'boolean') state.presets[idx].readOnly = readOnly;
    saveSamplerPresets(state);
    res.json({ preset: state.presets[idx] });
  });
  router.delete('/sampler-presets/:id', (req, res) => {
    const state = loadSamplerPresets();
    const idx = state.presets.findIndex((p) => p.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    if (state.presets[idx].readOnly) return res.status(403).json({ error: 'Preset is read-only' });
    state.presets.splice(idx, 1);
    saveSamplerPresets(state);
    res.json({ ok: true });
  });

  // ── LLM metrics dashboard: persistent per-(model+backend+settings) performance rows ──
  let metricsPoller = null;
  try {
    metricsPoller = new LlmMetricsPoller({
      dataDir,
      gpuMonitor,
      getActiveServices: () => loadActiveServices(), // full records (config + isTts/etc flags)
      getServiceHistory: () => loadServiceHistory(),
      interval: 20000,
    });
    metricsPoller.start();
  } catch (e) { console.warn('[ai] LLM metrics poller failed to start:', e?.message); }

  // GET all rows for the dashboard (every model ever run, running + stopped)
  router.get('/llm-metrics', (req, res) => {
    if (!metricsPoller) return res.json({ rows: [], generatedAt: Date.now() });
    res.json({ rows: metricsPoller.getRows(), generatedAt: Date.now() });
  });
  // DELETE a single row (e.g. retire a stale config)
  router.delete('/llm-metrics/:fp', (req, res) => {
    const ok = metricsPoller?.deleteRow(req.params.fp);
    res.json({ ok: !!ok });
  });

  // Lean per-(model+config) tool-call metrics for external consumers (e.g. openclaw-claude).
  // API-level, authoritative; structure = malformed/schema-invalid args, hallucination = tool name not offered.
  router.get('/tool-call-metrics', (req, res) => {
    if (!metricsPoller) return res.json({ models: [], generatedAt: Date.now() });
    const ratio = (e, t) => (t ? Math.round((e / t) * 1000) / 1000 : 0);
    const models = metricsPoller.getRows()
      .filter((r) => (r.toolCalls || 0) > 0)
      .map((r) => ({
        model: r.model, config: r.displayName || r.model, provider: r.provider, fingerprint: r.fingerprint,
        running: !!r.running,
        totalToolCalls: r.toolCalls || 0,
        structureErrors: r.toolErrStructure || 0,
        structureErrorRatio: ratio(r.toolErrStructure || 0, r.toolCalls || 0),
        hallucinationErrors: r.toolErrHallucination || 0,
        hallucinationErrorRatio: ratio(r.toolErrHallucination || 0, r.toolCalls || 0),
      }));
    res.json({ models, generatedAt: Date.now(), note: 'API-level counts at the AI-Lab proxy boundary; authoritative for the dashboard.' });
  });

  return {
    router,
    metricsPoller,
    startScanTimer,
    stopScanTimer,
    startWatchdog,
    stopWatchdog,
    validateAndRestoreCache,
    runCacheReconcile,
    ensureAgentSshKeys,
    setBroadcast: (fn) => { broadcastFn = fn; },
  };
}
