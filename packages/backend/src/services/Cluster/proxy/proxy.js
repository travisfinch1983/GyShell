/**
 * proxy.js — Reverse Proxy for LLM/TTS/STT Services
 *
 * Routes requests to active services by type with dynamic numbered slots:
 *   /api/proxy/llm/v1/*   → Universal LLM (routes by model name, aggregates models)
 *   /api/proxy/llm/N/*    → Nth active LLM (static slot, numbered from 1)
 *   /api/proxy/tts/*      → 1st active TTS (default)
 *   /api/proxy/tts/N/*    → Nth active TTS (unlimited)
 *   /api/proxy/stt/*      → 1st active STT (default)
 *   /api/proxy/stt/N/*    → Nth active STT (unlimited)
 *   GET /api/proxy/services → Current routing targets
 *
 * LLM endpoints are always numbered (/llm/1/v1/*, /llm/2/v1/*).
 * The default /llm/v1/* endpoint is the universal router, NOT slot 1.
 *
 * Mounted BEFORE express.json() so request bodies pass through raw
 * for streaming (SSE), binary (audio), and multipart (STT uploads).
 *
 * @module routes/proxy
 */

import { Router } from 'express';
import http from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { isAuthenticated, getAuthStatus, CLAUDE_MODELS } from './anthropic-proxy.js';
import { extractToolCalls, recordToolUsage } from './tool-call-metrics.js';
import { createBalanceHistory } from './balance-history.js';
import { resolveModelCapabilities } from './model-capabilities.js';
import { refreshPool, pickInstance, markFailure, markSuccess, invalidatePools } from './servicePools.js';
import { listBackends, emptyReason, nextIndex, createHealthCache,
         setProviderCaps, getModelCatalog, selectBackends,
         invalidateModelCatalog, isPooledTtsProvider } from './audio-registry.js';
import { getPipelineConfig, savePipelineConfig, applyPipelineDefaults,
         PIPELINE_DEFAULTS } from './audio-pipeline.js';
import { isKvEligible, getOrchestrator, getKvSettings, saveKvSettings, getAllKvStats, getKvIndexStats, reapNow, resetOrchestratorCache } from './kvcache/integration.js';

// ─── kvcache-proxy companion detection ──────────────────────────────────
// Convention: each LLM service that has a kvcache-proxy companion listens
// on (service_port + 1000). We probe /shim/stats once, cache the result
// per-service with a short TTL, and route LLM completion traffic through
// the proxy port when present.
const _kvcacheProxyCache = new Map();  // svc-key -> { port: number|null, expires: ms }
const _KV_TTL_HIT_MS = 60_000;
const _KV_TTL_MISS_MS = 10_000;

async function getKvcacheProxyPort(svc) {
  if (!svc?.containerIp || !svc?.port) return null;
  const key = `${svc.containerIp}:${svc.port}`;
  const now = Date.now();
  const cached = _kvcacheProxyCache.get(key);
  if (cached && cached.expires > now) return cached.port;
  const probePort = Number(svc.port) + 1000;
  let proxyPort = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 800);
    const r = await fetch(`http://${svc.containerIp}:${probePort}/shim/stats`, { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json();
      if (j?.config?.proxy_port === probePort) proxyPort = probePort;
    }
  } catch { /* shim absent */ }
  _kvcacheProxyCache.set(key, {
    port: proxyPort,
    expires: now + (proxyPort ? _KV_TTL_HIT_MS : _KV_TTL_MISS_MS),
  });
  return proxyPort;
}

async function getForwardPort(svc) {
  const _p = await getKvcacheProxyPort(svc);
  console.log('[kvcache-route]', (svc && svc.containerIp) + ':' + (svc && svc.port), '->', _p ? (_p + ' SHIM') : ((svc && svc.port) + ' direct'));
  return _p ?? svc.port;
}
// ────────────────────────────────────────────────────────────────────────


/**
 * Transcode raw audio bytes from one container format to another using ffmpeg.
 * Used to coerce RVC pipeline output (always WAV) into whatever format the
 * client asked for (mp3 / opus / flac / etc). ffmpeg auto-detects the input
 * format from headers when -f isn't specified on input. Spawns one ffmpeg per
 * call — fine for occasional TTS responses, would want pooling/streaming if
 * we ever did bulk transcoding.
 */
function transcodeAudio(inputBuffer, targetFormat, options = {}) {
  return new Promise((resolve, reject) => {
    // Speech-tuned codec settings. TTS output is mono speech — defaults
    // pick low bitrates that produce dramatically smaller files than the
    // music-leaning defaults without audible quality loss for narration.
    // OpenClaw embeds audio as base64 in the chat log; 64k mono mp3
    // (~8 KB/sec) lets a 30-second reply land under their default 500K-char
    // chat history limit, where the previous 128k stereo defaults blew past it.
    const codecMap = {
      mp3:  ['-ac', '1', '-codec:a', 'libmp3lame', '-b:a', options.bitrate || '64k', '-f', 'mp3'],
      opus: ['-ac', '1', '-codec:a', 'libopus',    '-b:a', options.bitrate || '48k', '-f', 'opus'],
      flac: ['-ac', '1', '-codec:a', 'flac',                                          '-f', 'flac'],
      wav:  [          '-codec:a', 'pcm_s16le',                                       '-f', 'wav'],
    };
    const codec = codecMap[targetFormat];
    if (!codec) return reject(new Error(`unsupported target format: ${targetFormat}`));
    const args = ['-loglevel', 'error', '-i', 'pipe:0', ...codec, 'pipe:1'];
    const ff = spawn('ffmpeg', args);
    const chunks = [];
    let stderr = '';
    ff.stdout.on('data', (chunk) => chunks.push(chunk));
    ff.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 200)}`));
      resolve(Buffer.concat(chunks));
    });
    ff.on('error', reject);
    ff.stdin.on('error', reject);
    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_DATA_DIR = process.env.AILAB_PROXY_DATA_DIR || join(__dirname, '..', '..', 'data');
const activeServicesFile = join(PROXY_DATA_DIR, 'active-services.json');
const voicePresetsFile = join(PROXY_DATA_DIR, 'voice-presets.json');

// ─── MCP Tool Integration ──────────────────────────────────────────────────
const MCPJUNGLE_URL = process.env.MCPJUNGLE_URL || 'http://127.0.0.1:8080';
const MCP_TOOL_CACHE_TTL = 60_000; // 60 seconds
const mcpSettingsFile = join(PROXY_DATA_DIR, 'mcp-settings.json');

function loadMcpSettings() {
  try {
    if (existsSync(mcpSettingsFile)) return JSON.parse(readFileSync(mcpSettingsFile, 'utf-8'));
  } catch {}
  return {};
}

function saveMcpSettings(settings) {
  writeFileSync(mcpSettingsFile, JSON.stringify(settings, null, 2));
}

function getMcpMaxRounds() {
  return loadMcpSettings().maxToolRounds || 20;
}

/** Update MCP settings (called from server.js API route) */
export function updateMcpSettings(updates) {
  const current = loadMcpSettings();
  Object.assign(current, updates);
  saveMcpSettings(current);
  return current;
}

/** Get current MCP settings */
export function getMcpSettings() {
  const defaults = { maxToolRounds: 20, toolInjection: true };
  return { ...defaults, ...loadMcpSettings() };
}

const _mcpState = {
  sessionId: null,
  tools: [],        // raw MCP tools
  openaiTools: [],  // OpenAI function-calling format
  updated: 0,
  healthy: true,
  lastError: null,
};

/** Send a JSON-RPC request to MCPJungle */
async function mcpRequest(method, params) {
  const headers = { 'Content-Type': 'application/json' };
  if (_mcpState.sessionId) headers['Mcp-Session-Id'] = _mcpState.sessionId;

  const payload = { jsonrpc: '2.0', id: Date.now(), method };
  if (params) payload.params = params;

  // Initialize session if needed
  if (!_mcpState.sessionId) {
    try {
      const initResp = await fetch(`${MCPJUNGLE_URL}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'proxlab', version: '1.0.0' } },
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (initResp.ok) {
        _mcpState.sessionId = initResp.headers.get('Mcp-Session-Id');
        if (_mcpState.sessionId) headers['Mcp-Session-Id'] = _mcpState.sessionId;
        // Send initialized notification
        await fetch(`${MCPJUNGLE_URL}/mcp`, {
          method: 'POST', headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }
    } catch (e) {
      _mcpState.healthy = false;
      _mcpState.lastError = e.message;
      return null;
    }
  }

  try {
    const resp = await fetch(`${MCPJUNGLE_URL}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const data = await resp.json();
      _mcpState.healthy = true;
      _mcpState.lastError = null;
      return data.result || data;
    }
  } catch (e) {
    _mcpState.healthy = false;
    _mcpState.lastError = e.message;
  }
  return null;
}

/** Fetch and cache MCP tools in OpenAI format. Fails silently. */
async function getMcpTools() {
  if (_mcpState.openaiTools.length && (Date.now() - _mcpState.updated) < MCP_TOOL_CACHE_TTL) {
    return _mcpState.openaiTools;
  }
  try {
    const result = await mcpRequest('tools/list');
    if (!result || !result.tools) return _mcpState.openaiTools;
    _mcpState.tools = result.tools;
    _mcpState.openaiTools = result.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }));
    _mcpState.updated = Date.now();
  } catch (e) {
    console.warn(`[mcp] Failed to refresh tools: ${e.message}`);
  }
  return _mcpState.openaiTools;
}

/** Execute a tool via MCPJungle */
async function callMcpTool(name, args) {
  try {
    const result = await mcpRequest('tools/call', { name, arguments: args });
    if (result && result.content) {
      return result.content
        .map(b => (typeof b === 'string' ? b : b.text || JSON.stringify(b)))
        .join('\n');
    }
    return JSON.stringify(result);
  } catch (e) {
    return `Tool call failed: ${e.message}`;
  }
}

/** Get MCP health status for the UI */
export function getMcpHealth() {
  return {
    healthy: _mcpState.healthy,
    tools: _mcpState.openaiTools.length,
    lastError: _mcpState.lastError,
    cachedAt: _mcpState.updated ? new Date(_mcpState.updated).toISOString() : null,
  };
}

/** Known STT provider IDs */
const STT_PROVIDERS = new Set(['faster-whisper']);

/** Keywords that identify embedding models */
const EMBED_KEYWORDS = ['embed', 'bge-', 'e5-', 'gte-', 'encoding', 'encoder'];
/** Keywords that identify reranker models */
const RERANK_KEYWORDS = ['rerank', 'ranker', 'cross-encoder'];

// ─── TTS/STT Provider Capabilities ─────────────────────────────────────────
// `clipVoice` = synthesises from a reference voice CLIP (as opposed to a fixed
// set of baked-in speakers). Together with `openai` it decides pool membership:
// clip engines share the same NAS voice library, so a voice name means the same
// thing on every pooled backend and /tts/v1/voices stays one flat namespace.
// Fixed-voice engines would collide voice IDs across providers.
//
// VERIFICATION STATUS — proxlab-tts is confirmed by live use. s2-pro is
// confirmed by its own API shape (reference clips passed as `references: [...]`).
// qwen-tts is marked from its documented 3-second voice cloning but has NOT been
// probed live; it only enters the pool once an instance is actually launched, at
// which point a wrong flag shows up as a visible voice-resolution failure rather
// than silent misrouting. Non-clip engines are unaffected either way.
const TTS_PROVIDER_CAPS = {
  'proxlab-tts':     { openai: true,  clipVoice: true,  voices: '/v1/voices', models: '/v1/models', formats: ['wav','mp3','opus','flac'] },
  'qwen-tts':        { openai: true,  clipVoice: true,  voices: '/v1/audio/voices', models: '/v1/models', formats: ['wav','mp3','opus','flac','pcm'] },
  // S2-Pro doesn't expose a /v1/voices listing — voices are reference-
  // clip-driven (pass `references: [...]` in the speech body). Listing
  // null so the UI knows to skip the dropdown population.
  's2-pro':          { openai: true,  clipVoice: true,  voices: null,                models: '/v1/models', formats: ['wav','mp3','opus','flac','pcm'] },
  // Fixed baked-in speakers — not clip-driven, so not pooled.
  'kokoro':          { openai: true,  clipVoice: false, voices: '/v1/voices', models: null,         formats: ['wav','mp3','opus','flac'] },
  // Wraps several backends, some clip-based and some not — ambiguous, left out.
  'openedai-speech': { openai: true,  clipVoice: false, voices: '/v1/voices', models: null,         formats: ['wav','mp3','opus','flac'] },
  // Clip-capable but NOT OpenAI-compatible, so it cannot join an OpenAI-shaped pool.
  'alltalk':         { openai: false, clipVoice: true,  voices: null,         models: null,         formats: ['wav'] },
  'f5tts':           { openai: false, clipVoice: true,  voices: null,         models: null,         formats: ['wav'] },
  'tts-webui':       { openai: false, clipVoice: false, voices: null,         models: null,         formats: ['wav'] },
  'piper':           { openai: false, clipVoice: false, voices: null,         models: null,         formats: ['wav'] },
};

// Hand the capability table to the registry so pool membership has one source.
setProviderCaps(TTS_PROVIDER_CAPS);

const STT_PROVIDER_CAPS = {
  'faster-whisper': { openai: true, models: '/v1/models', formats: ['wav','mp3','flac','webm','ogg'] },
};

const _healthCache = { tts: {}, stt: {}, updatedAt: 0 };
const HEALTH_CACHE_TTL = 10_000; // 10 seconds

// ─── External Services ──────────────────────────────────────────────────────
const externalServicesFile = join(PROXY_DATA_DIR, 'external-services.json');

function loadExternalServices() {
  try {
    if (existsSync(externalServicesFile)) return JSON.parse(readFileSync(externalServicesFile, 'utf-8'));
  } catch {}
  return [];
}

function saveExternalServices(svcs) {
  writeFileSync(externalServicesFile, JSON.stringify(svcs, null, 2));
}

export { loadExternalServices, saveExternalServices };

// ─── External Model Sources ───────────────────────────────────────────────────
// API model providers (Claude/DeepSeek/OpenRouter/…) fronted by this one proxy so
// every model — local + external — shows up in /v1/models tagged, and metrics flow
// through one place. See /claude/plans/ailab-hermes-integration.md + the shared
// ExternalModelSource contract. Records:
//   { id, tag, displayName, transport, baseUrl, apiKeyRef?, discovery, models[], enabled }
const externalModelSourcesFile = join(PROXY_DATA_DIR, 'external-model-sources.json');

function loadExternalModelSources() {
  try {
    if (existsSync(externalModelSourcesFile)) return JSON.parse(readFileSync(externalModelSourcesFile, 'utf-8'));
  } catch {}
  return [];
}

function saveExternalModelSources(sources) {
  writeFileSync(externalModelSourcesFile, JSON.stringify(sources, null, 2));
}

export { loadExternalModelSources, saveExternalModelSources };

// Credit-tracker phase 2 — periodic balance snapshots (append-only JSONL) → burn-rate / runway.
// Singleton so a single snapshotter runs regardless of how many times the router is created.
const balanceHistory = createBalanceHistory({
  historyFile: join(PROXY_DATA_DIR, 'balance-history.jsonl'),
  loadSources: () => loadExternalModelSources().filter((s) => s && s.enabled !== false),
  fetchBalance: (s) => fetchExternalSourceBalance(s),
});

// Resolve a source's API key. Primary: the inline `apiKey` from the dedicated model-endpoints
// vault section (external-model-sources.json — kept separate from general credentials so the
// backend never parses keys out of mixed creds). Fallback: env var <ID>_API_KEY. (apiKeyRef →
// general-vault resolution is a future add.)
function resolveExternalSourceKey(source) {
  if (source.apiKey && String(source.apiKey).trim()) return String(source.apiKey);
  const envName = `${String(source.id || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
  return process.env[envName] || '';
}

// Transport-specific endpoints + auth headers. Different upstreams disagree on both the
// URL shape and the auth scheme:
//   - openai_chat (DeepSeek, OpenRouter, vLLM, …): {baseUrl}/models + /chat/completions,
//     Bearer auth. baseUrl already carries any /v1 the provider needs.
//   - anthropic (Anthropic direct API): the NATIVE /v1/models endpoint requires
//     `x-api-key` + `anthropic-version` (Bearer is rejected there), while chat rides
//     Anthropic's OpenAI-compat /v1/chat/completions surface which DOES accept Bearer.
//     baseUrl is the bare host (https://api.anthropic.com); we add /v1 ourselves.
// (Verified empirically 2026-07-03: native models 200 w/ x-api-key, 401 w/ Bearer; compat
//  chat/completions accepts Bearer.)
function externalTransportEndpoints(source) {
  const base = String(source.baseUrl).replace(/\/+$/, '');
  const transport = source.transport || 'openai_chat';
  if (transport === 'anthropic') {
    const host = base.replace(/\/v1$/, '');
    return {
      modelsUrl: `${host}/v1/models`,
      modelsHeaders: (key) => (key ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : {}),
      chatUrl: `${host}/v1/chat/completions`,
      chatHeaders: (key) => (key ? { authorization: `Bearer ${key}` } : {}),
    };
  }
  return {
    modelsUrl: `${base}/models`,
    modelsHeaders: (key) => (key ? { Authorization: `Bearer ${key}` } : {}),
    chatUrl: `${base}/chat/completions`,
    chatHeaders: (key) => (key ? { authorization: `Bearer ${key}` } : {}),
  };
}

// Model ids a source exposes: discovery 'list' => source.models; 'auto' => GET the
// transport's models endpoint (optionally allow-filtered by source.models). Best-effort —
// unreachable/unauthorized sources yield [].
async function fetchExternalSourceModels(source) {
  if (source.discovery === 'list') return Array.isArray(source.models) ? source.models : [];
  try {
    const key = resolveExternalSourceKey(source);
    const ep = externalTransportEndpoints(source);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch(ep.modelsUrl, { signal: ctrl.signal, headers: ep.modelsHeaders(key) });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const json = await resp.json();
    let ids = (json.data || json.models || []).map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean);
    if (Array.isArray(source.models) && source.models.length) {
      const allow = new Set(source.models);
      ids = ids.filter((id) => allow.has(id));
    }
    return ids;
  } catch {
    return [];
  }
}

// Discover the FULL upstream model list for a source WITH metadata (name/context/pricing),
// IGNORING the source's `models` allow-filter. Used by the Settings UI to render the per-model
// enable checkboxes + cost columns so a user can curate (e.g. 20 of OpenRouter's ~340). Pricing
// from OpenAI-compat/OpenRouter `/models` is per-TOKEN; we surface per-1M-tokens for readability.
async function fetchExternalSourceModelsRaw(source) {
  if (source.discovery === 'list') {
    return (Array.isArray(source.models) ? source.models : []).map((id) => ({ id, name: id }));
  }
  try {
    const key = resolveExternalSourceKey(source);
    const ep = externalTransportEndpoints(source);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(ep.modelsUrl, { signal: ctrl.signal, headers: ep.modelsHeaders(key) });
    clearTimeout(timer);
    if (!resp.ok) return [];
    const json = await resp.json();
    const raw = json.data || json.models || [];
    const num = (v) => (v == null || v === '' ? null : Number(v));
    const perM = (v) => { const n = num(v); return n == null || Number.isNaN(n) ? null : n * 1e6; };
    return raw.map((m) => {
      if (typeof m === 'string') return { id: m, name: m };
      const p = m.pricing || {};
      return {
        id: m.id,
        name: m.name || m.id,
        contextLength: m.context_length ?? m.context_window ?? m.top_provider?.context_length ?? null,
        pricing: {
          inputPerM: perM(p.prompt ?? p.input),
          outputPerM: perM(p.completion ?? p.output),
          cacheReadPerM: perM(p.input_cache_read ?? p.cache_read),
          cacheWritePerM: perM(p.input_cache_write ?? p.cache_write),
          currency: 'USD',
        },
      };
    }).filter((m) => m.id);
  } catch {
    return [];
  }
}

// Query an external source's account credit/balance where the provider exposes it. Normalized:
//   { supported, currency, balance, totalCredits, totalUsage, usage:{...}, available, reason, checkedAt }
// OpenRouter: /api/v1/credits (+ /api/v1/key for daily/weekly/monthly usage). DeepSeek: /user/balance.
// Anthropic: no balance on a standard key (admin key required) → supported:false. Used for the
// AI-Lab credit tracker (current balance + historical snapshots → cost-over-time).
async function fetchExternalSourceBalance(source) {
  const key = resolveExternalSourceKey(source);
  const host = String(source.baseUrl || '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const out = { supported: false, currency: 'USD', checkedAt: Date.now() };
  const h = key ? { Authorization: `Bearer ${key}` } : {};
  const j = async (url, headers) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try { const r = await fetch(url, { signal: ctrl.signal, headers }); clearTimeout(t); return r.ok ? await r.json() : null; }
    catch { clearTimeout(t); return null; }
  };
  if (/openrouter\.ai/.test(host)) {
    const c = await j('https://openrouter.ai/api/v1/credits', h);
    const k = await j('https://openrouter.ai/api/v1/key', h);
    if (c && c.data) {
      const tc = Number(c.data.total_credits), tu = Number(c.data.total_usage);
      out.supported = true; out.kind = 'balance'; out.totalCredits = tc; out.totalUsage = tu;
      out.balance = (Number.isFinite(tc) && Number.isFinite(tu)) ? tc - tu : null;
      if (k && k.data) out.usage = { total: k.data.usage, daily: k.data.usage_daily, weekly: k.data.usage_weekly, monthly: k.data.usage_monthly };
    } else { out.reason = 'openrouter credits unavailable (key/network)'; }
    return out;
  }
  if (/deepseek\.com/.test(host)) {
    const b = await j(host + '/user/balance', { ...h, Accept: 'application/json' });
    const info = b && Array.isArray(b.balance_infos) && b.balance_infos[0];
    if (info) {
      out.supported = true; out.kind = 'balance'; out.currency = info.currency || 'USD';
      out.balance = Number(info.total_balance);
      out.granted = Number(info.granted_balance); out.toppedUp = Number(info.topped_up_balance);
      out.available = !!b.is_available;
    } else { out.reason = 'deepseek balance unavailable (key/network)'; }
    return out;
  }
  if (source.transport === 'anthropic') {
    const admin = source.adminApiKey;
    if (!admin) { out.reason = 'add an Anthropic Admin API key (sk-ant-admin…) below to see usage/cost'; return out; }
    // Anthropic has no "balance" concept — report SPEND (cost report) for the current calendar month.
    const now = new Date(out.checkedAt);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const url = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(monthStart)}`;
    const cr = await j(url, { 'x-api-key': admin, 'anthropic-version': '2023-06-01' });
    if (cr) {
      let spend = 0, found = false;
      for (const bucket of (cr.data || [])) {
        for (const r of (bucket.results || bucket.result || [])) {
          const amt = Number(r.amount ?? r.cost ?? r.cost_usd);
          if (!Number.isNaN(amt)) { spend += amt; found = true; if (r.currency) out.currency = r.currency; }
        }
      }
      out.supported = true; out.kind = 'spend'; out.spendMonth = found ? spend : null;
    } else { out.reason = 'Anthropic cost report unavailable — check the admin key (needs sk-ant-admin…)'; }
    return out;
  }
  out.reason = 'no balance API for this provider';
  return out;
}

// Forward a chat/completions request to an external model source's upstream API. The
// [TAG] is already stripped by the caller (upstreamModel is the real id). Injects the
// vaulted/env key, rewrites body.model, and streams the response straight back (SSE-safe).

// ─── Prompt caching (external sources) ────────────────────────────────────────────────────
//
// Clients send plain OpenAI-shaped requests and set NO cache_control — the proxy injects it so
// caching is transparent. Verified on OpenRouter + anthropic/claude-opus-5: an identical
// 5.5k-token prompt cost $0.0346 (cache_write_tokens 5503) then $0.0029 (cached_tokens 5503).
//
// CAPABILITY IS DERIVED FROM PRICING, not a hand-maintained vendor list.
//
// An upstream that publishes an `input_cache_write` price is telling us it bills for EXPLICIT
// cache breakpoints — i.e. it acts on cache_control. An upstream that caches automatically has
// a cache READ discount and no write price, so it lands outside this set and we inject nothing
// (there is nothing to inject; it caches with or without us).
//
// This replaced a `/^anthropic\//` allowlist that was wrong twice over: it skipped OpenRouter's
// `~anthropic/...-latest` aliases (leading tilde) so they ran uncached forever, and it ignored
// the Google/OpenAI/Qwen models that do bill cache writes.
const ANTHROPIC_MODEL_RE = /^~?anthropic\//i;
const cacheCapability = new Map();                 // sourceId -> { ids:Set<string>, updatedAt }
const _capInflight = new Map();
const CACHE_CAP_TTL = 6 * 60 * 60 * 1000;          // 6h — published prices move rarely

/** Build + store the explicit-cache set for a source from an already-fetched raw model list. */
function setCacheCapability(source, rawModels) {
  const ids = new Set(
    (rawModels || []).filter((m) => Number(m?.pricing?.cacheWritePerM) > 0).map((m) => m.id),
  );
  cacheCapability.set(source.id, { ids, updatedAt: Date.now() });
  console.log(`[proxy:cache] ${source.id}: ${ids.size}/${(rawModels || []).length} models bill for cache writes (explicit cache_control)`);
  return ids;
}

/** Refresh the capability set out-of-band. Never awaited on the request path. */
function refreshCacheCapability(source) {
  const entry = cacheCapability.get(source.id);
  if (entry && Date.now() - entry.updatedAt < CACHE_CAP_TTL) return;
  if (_capInflight.has(source.id)) return;
  const p = fetchExternalSourceModelsRaw(source)
    .then((models) => { if (models && models.length) setCacheCapability(source, models); })
    .catch((e) => {
      // Loud: silently falling back would mean caching quietly stops for most models.
      console.warn(`[proxy:cache] capability refresh failed for ${source.id}: ${e.message} — only Anthropic models will be cached until it succeeds`);
    })
    .finally(() => _capInflight.delete(source.id));
  _capInflight.set(source.id, p);
}

function cachingSupported(source, upstreamModel) {
  const m = String(upstreamModel || '');
  if (source.transport === 'anthropic') return true;   // native Anthropic source — always explicit
  if (ANTHROPIC_MODEL_RE.test(m)) return true;         // verified by measurement; never gated on a fetch
  refreshCacheCapability(source);                      // fire-and-forget; warms for later calls
  const entry = cacheCapability.get(source.id);
  return entry ? entry.ids.has(m) : false;             // cold ⇒ don't guess
}

/** Anthropic is the only dialect that understands a cache_control `ttl`; others take the bare
 *  breakpoint. Sending an unknown field to a strict upstream is how you break every call. */
function ttlSupported(source, upstreamModel) {
  return source.transport === 'anthropic' || ANTHROPIC_MODEL_RE.test(String(upstreamModel || ''));
}

// Per-model toggles live in source.modelOptions. ABSENT MEANS ON — Travis's requirement is
// that every caching option defaults to enabled, so config is opt-OUT.
function cacheOptsFor(source, upstreamModel) {
  const mo = (source.modelOptions || {})[upstreamModel] || {};
  return {
    ephemeral: mo.cacheEphemeral !== false,   // 5-minute breakpoints
    extended:  mo.cacheExtended  !== false,   // 1-hour TTL on the stable system prefix
  };
}

/** Normalise a message's content to a block array so cache_control has somewhere to attach. */
function asBlocks(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return null;
}

/**
 * Inject cache breakpoints into an OpenAI-shaped payload. Mutates and returns `parsed`.
 *
 * TWO breakpoints, deliberately:
 *   1. the LAST system block  — the big stable prefix; gets the 1h TTL when extended is on
 *   2. the last message BEFORE the final user turn — the conversation prefix, which grows each
 *      turn, so it only ever gets the 5-minute ephemeral TTL
 * Anthropic allows up to 4; two covers the wins without burning the budget.
 *
 * Below ~1024 tokens the provider silently ignores cache_control, so short prompts cost
 * nothing and need no special-casing here.
 */
function applyPromptCaching(parsed, source, upstreamModel) {
  if (!parsed || !Array.isArray(parsed.messages)) return false;
  if (!cachingSupported(source, upstreamModel)) return false;
  const opts = cacheOptsFor(source, upstreamModel);
  // `ephemeral` is the MASTER switch: off ⇒ inject nothing. A toggle labelled "Cache" that
  // still wrote breakpoints when unticked would be a control that doesn't control anything.
  if (!opts.ephemeral) return false;

  let marked = 0;
  const mark = (msg, ttl) => {
    const blocks = asBlocks(msg.content);
    if (!blocks || !blocks.length) return false;
    const last = blocks[blocks.length - 1];
    if (!last || typeof last !== 'object') return false;
    last.cache_control = ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
    msg.content = blocks;
    marked += 1;
    return true;
  };

  // 1. last system message — longest-lived content, so it earns the 1h TTL.
  for (let i = parsed.messages.length - 1; i >= 0; i--) {
    if (parsed.messages[i] && parsed.messages[i].role === 'system') {
      mark(parsed.messages[i], opts.extended && ttlSupported(source, upstreamModel) ? '1h' : undefined);
      break;
    }
  }

  // 2. conversation prefix: the message just before the final user turn. Ephemeral only —
  //    this boundary moves every turn, so a long TTL would just churn cache writes.
  if (opts.ephemeral && parsed.messages.length >= 3) {
    for (let i = parsed.messages.length - 2; i >= 0; i--) {
      const r = parsed.messages[i] && parsed.messages[i].role;
      if (r === 'system') break;
      if (r === 'assistant' || r === 'user') { mark(parsed.messages[i]); break; }
    }
  }
  // Report what was ACTUALLY marked, not merely what was permitted. The stats counter reads
  // this: reporting "injected" for a request the per-model toggle had disabled would make the
  // tally lie about its own behaviour.
  return marked > 0;
}


// ─── Cache-usage observability ────────────────────────────────────────────────────────────
//
// Injecting cache_control silently is not good enough: if an upstream quietly ignores it, or a
// prompt sits under the ~1024-token minimum, everything still "works" and nobody ever finds out
// the cache is dead. So tally what the upstream REPORTS back and expose it per model.
//
// In-memory, reset on proxy restart — `since` is returned so the UI can say so honestly rather
// than implying an all-time total.
const cacheStats = new Map();      // `${sourceId}::${model}` -> counters
const cacheStatsSince = Date.now();

const _n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Normalise the three usage dialects (OpenAI, OpenRouter, Anthropic) into one shape. */
function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const d = u.prompt_tokens_details || u.input_tokens_details || {};
  const cc = u.cache_creation || {};
  return {
    input: _n(u.prompt_tokens ?? u.input_tokens),
    output: _n(u.completion_tokens ?? u.output_tokens),
    // OpenAI/OpenRouter report reads under prompt_tokens_details.cached_tokens; Anthropic uses
    // cache_read_input_tokens. Writes are only ever reported by providers with EXPLICIT caching.
    cacheRead: _n(d.cached_tokens ?? u.cached_tokens ?? u.cache_read_input_tokens ?? u.cache_read_tokens),
    // OpenRouter nests BOTH counters under prompt_tokens_details (cached_tokens +
    // cache_write_tokens); Anthropic puts creation at the top level. Checking only the top
    // level made every write read as 0 — verified against a live response before fixing.
    cacheWrite: _n(
      d.cache_write_tokens ?? u.cache_creation_input_tokens ?? u.cache_write_tokens ??
      (_n(cc.ephemeral_5m_input_tokens) + _n(cc.ephemeral_1h_input_tokens) || undefined),
    ),
    cost: _n(u.cost),
  };
}

/**
 * Pull the LAST usage object out of a response body — handles both a plain JSON completion and
 * an SSE stream (where usage arrives in a trailing chunk).
 */
function extractUsage(text) {
  if (!text) return null;
  let last = null;
  const t = text.trimStart();
  if (t.startsWith('{')) {
    try { const j = JSON.parse(t); if (j && j.usage) last = j.usage; } catch { /* truncated tail */ }
  }
  if (!last) {
    const re = /^data:\s*(\{.*\})\s*$/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      try { const j = JSON.parse(m[1]); if (j && j.usage) last = j.usage; } catch { /* partial chunk */ }
    }
  }
  return normalizeUsage(last);
}

/** Record one completed upstream call. `injected` = did we actually add cache_control? */
function recordCacheUsage(source, model, text, injected) {
  try {
    const u = extractUsage(text);
    const k = `${source.id}::${model}`;
    const s = cacheStats.get(k) || { requests: 0, injected: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, lastAt: null };
    s.requests += 1;
    if (injected) s.injected += 1;
    if (u) {
      s.input += u.input; s.output += u.output;
      s.cacheRead += u.cacheRead; s.cacheWrite += u.cacheWrite; s.cost += u.cost;
    }
    s.lastAt = Date.now();
    cacheStats.set(k, s);
    if (u && (u.cacheRead || u.cacheWrite)) {
      console.log(`[proxy:cache] ${k} read=${u.cacheRead} write=${u.cacheWrite} in=${u.input} out=${u.output}`);
    } else if (injected) {
      // Loud on purpose: injected but nothing came back means the cache is doing nothing.
      console.log(`[proxy:cache] ${k} injected but upstream reported NO cache tokens (prompt under the ~1024-token minimum, or ignored)`);
    }
  } catch (e) {
    console.warn(`[proxy:cache] usage tally failed for ${source?.id}/${model}: ${e.message}`);
  }
}

async function forwardToExternalSource(res, source, upstreamModel, parsed) {
  const key = resolveExternalSourceKey(source);
  const ep = externalTransportEndpoints(source);
  const url = ep.chatUrl;
  const headers = { 'content-type': 'application/json', ...ep.chatHeaders(key) };

  // Inject cache breakpoints BEFORE serialising. No-op for models that don't support it.
  let cacheInjected = false;
  if (cachingSupported(source, upstreamModel)) {
    cacheInjected = applyPromptCaching(parsed, source, upstreamModel);
    // The 1h TTL is gated behind a beta header on native Anthropic. Harmless elsewhere, but
    // only send it where it means something.
    const co = cacheOptsFor(source, upstreamModel);
    if (cacheInjected && source.transport === 'anthropic' && co.ephemeral && co.extended) {
      headers['anthropic-beta'] = 'extended-cache-ttl-2025-04-11';
    }
  }
  const outBody = JSON.stringify({ ...parsed, model: upstreamModel });

  let upstream;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300000);
    upstream = await fetch(url, { method: 'POST', headers, body: outBody, signal: ctrl.signal });
    upstream._timer = timer;
  } catch (e) {
    return res.status(502).json({ error: `external source '${source.id}' unreachable: ${e.message}` });
  }
  res.status(upstream.status);
  const ct = upstream.headers.get('content-type');
  if (ct) res.setHeader('content-type', ct);
  if (!upstream.body) { if (upstream._timer) clearTimeout(upstream._timer); return res.end(); }
  try {
    const { Readable } = await import('node:stream');
    const node = Readable.fromWeb(upstream.body);
    // Observe a CAPPED copy for the usage tally. The client's bytes still go straight through
    // via pipe(); this only ever reads, never gates or rewrites the stream, so a failure here
    // cannot stall a response. Usage lives at the tail of both dialects, so keep the tail.
    const CAP = 256 * 1024;
    let seen = '';
    node.on('data', (chunk) => {
      try {
        seen += chunk.toString('utf8');
        if (seen.length > CAP) seen = seen.slice(-CAP);
      } catch { /* binary/undecodable — tally is best-effort, the stream is not */ }
    });
    node.on('end', () => {
      if (upstream._timer) clearTimeout(upstream._timer);
      recordCacheUsage(source, upstreamModel, seen, cacheInjected);
      seen = '';
    });
    node.on('error', () => { try { res.end(); } catch {} });
    node.pipe(res);
  } catch (e) {
    if (upstream._timer) clearTimeout(upstream._timer);
    try { res.status(502).json({ error: `external stream error: ${e.message}` }); } catch {}
  }
}

/**
 * Load active services from disk, backfilling proxySlot if missing.
 * @returns {{ services: Object }}
 */
function loadActiveServices() {
  try {
    if (existsSync(activeServicesFile)) {
      const state = JSON.parse(readFileSync(activeServicesFile, 'utf-8'));
      if (ensureProxySlots(state)) {
        writeFileSync(activeServicesFile, JSON.stringify(state, null, 2));
      }
      return state;
    }
  } catch {}
  return { services: {} };
}

/** Backfill missing proxySlot on legacy services. Returns true if any changed. */
function ensureProxySlots(state) {
  if (!state.services) return false;
  const byType = { llm: [], tts: [], stt: [], embed: [], rerank: [] };
  for (const svc of Object.values(state.services)) {
    const type = classifyService(svc);
    if (svc.proxySlot) {
      if (!byType[type]) byType[type] = [];
      byType[type].push(svc.proxySlot);
    }
  }
  let changed = false;
  for (const svc of Object.values(state.services)) {
    if (svc.proxySlot) continue;
    const type = classifyService(svc);
    if (!byType[type]) byType[type] = [];
    let slot = 1;
    while (byType[type].includes(slot)) slot++;
    svc.proxySlot = slot;
    byType[type].push(slot);
    changed = true;
  }
  return changed;
}

/**
 * Classify a service as llm, tts, stt, embed, or rerank.
 * @param {Object} svc - Active service entry
 * @returns {'llm'|'tts'|'stt'|'embed'|'rerank'}
 */
const IMAGE_GEN_PROVIDERS = new Set(['comfyui', 'sdnext', 'fooocus', 'invokeai']);

/** Map of short names → provider IDs for named image gen proxies */
const IMAGEGEN_ALIASES = {
  comfyui:  'comfyui',
  sdnext:   'sdnext',
  fooocus:  'fooocus',
  invokeai: 'invokeai',
  fluxgym:  'fluxgym',
};

/**
 * Find the Nth active service matching a specific providerId.
 * @param {string} providerId
 * @param {number} nth - 1-based index
 * @returns {Object|null}
 */
function findImageGenByProvider(providerId, nth = 1) {
  const state = loadActiveServices();
  const matches = Object.values(state.services)
    .filter(svc => svc.providerId === providerId && svc.containerIp && svc.port)
    .sort((a, b) => (a.proxySlot || 999) - (b.proxySlot || 999));
  return matches[nth - 1] || null;
}

/**
 * THE single service classifier. Exported so the API layer renders exactly what the proxy
 * routes — there used to be a second, weaker copy in llm/routes/ai.js that had no embed or
 * rerank case, so rerankers and embedders showed up on service cards as plain LLMs.
 *
 * EXPLICIT FLAGS FIRST, then model-name keywords. The flags are set deliberately at launch, so
 * they must outrank name-sniffing: 'encoder' is an EMBED_KEYWORDS entry, and a TTS model with
 * "encoder" in its name would otherwise be classified as an embedder. Embedders and rerankers
 * carry no flag of their own, which is why they fall back to keywords.
 *
 * Provider sets AND flags are both consulted — the two old copies each checked only one
 * (proxy.js the provider sets, ai.js the flags), so each mislabelled what the other caught.
 */
export function classifyService(svc) {
  if (svc.isTools) return 'tools';
  if (svc.isImageGen || IMAGE_GEN_PROVIDERS.has(svc.providerId)) return 'image';
  // STT before the isTts check: STT providers carry isTts=false.
  if (svc.isStt || STT_PROVIDERS.has(svc.providerId)) return 'stt';
  if (svc.isTts) return 'tts';
  const modelLower = (svc.model || '').toLowerCase();
  if (EMBED_KEYWORDS.some(kw => modelLower.includes(kw))) return 'embed';
  if (RERANK_KEYWORDS.some(kw => modelLower.includes(kw))) return 'rerank';
  return 'llm';
}

/**
 * Find all active services of a given type, ordered by proxySlot (stable sort).
 * @param {'llm'|'tts'|'stt'} type
 * @returns {Object[]}
 */
function findServicesByType(type) {
  const state = loadActiveServices();
  return Object.values(state.services)
    .filter((svc) => classifyService(svc) === type && svc.containerIp && svc.port)
    .sort((a, b) => (a.proxySlot || 999) - (b.proxySlot || 999));
}

/**
 * Find a specific service by type and stored proxySlot number.
 * @param {'llm'|'tts'|'stt'} type
 * @param {number} slot
 * @returns {Object|undefined}
 */
function findServiceBySlot(type, slot) {
  const state = loadActiveServices();
  return Object.values(state.services)
    .find(svc => classifyService(svc) === type && svc.containerIp && svc.port && svc.proxySlot === slot);
}

/**
 * Format a service for the /services JSON response.
 */
function formatService(svc) {
  return {
    pooled: isPooledTtsProvider(svc.providerId),
    id: svc.id,
    providerId: svc.providerId,
    providerName: svc.providerName,
    containerIp: svc.containerIp,
    port: svc.port,
    endpoint: svc.endpoint,
    model: svc.model || null,
    node: svc.node,
  };
}

/**
 * Proxy a request to a target service using raw pipe-through.
 * Handles streaming (SSE), binary (audio), and multipart transparently.
 */
function proxyRequest(req, res, targetHost, targetPort, targetPath) {
  const proxyReq = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${targetHost}:${targetPort}`,
      },
    },
    (proxyRes) => {
      const isSSE = (proxyRes.headers['content-type'] || '').includes('event-stream');
      res.writeHead(proxyRes.statusCode, proxyRes.headers);

      if (isSSE) {
        // Streaming SSE: forward chunks + inject empty-delta heartbeats during
        // upstream silence so consumer-side idle timers (e.g. OpenClaw's 120-300s
        // LLM idle timeout) don't fire during long prompt-processing phases.
        // OpenAI SDK parses these as valid chunks, idle timer resets, the empty
        // delta is invisible to the user.
        const HEARTBEAT_INTERVAL_MS = 30 * 1000;
        let hbTimer = null;
        const sendHeartbeat = () => {
          if (res.writableEnded) return;
          const payload = {
            id: 'hb-' + Date.now(),
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            model: 'keep-alive',
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          scheduleHeartbeat();
        };
        const scheduleHeartbeat = () => {
          if (hbTimer) clearTimeout(hbTimer);
          hbTimer = setTimeout(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
        };
        const clearHeartbeat = () => {
          if (hbTimer) { clearTimeout(hbTimer); hbTimer = null; }
        };

        scheduleHeartbeat();
        proxyRes.on('data', (chunk) => { res.write(chunk); scheduleHeartbeat(); });
        proxyRes.on('end', () => { clearHeartbeat(); res.end(); });
        proxyRes.on('error', () => { clearHeartbeat(); if (!res.writableEnded) res.end(); });
        res.on('close', clearHeartbeat);
      } else {
        proxyRes.pipe(res);
      }
    }
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
  });

  req.pipe(proxyReq);
}

/**
 * Join Express 5 wildcard params (array of segments) into a path string.
 */
function joinRestParam(rest) {
  return Array.isArray(rest) ? rest.join('/') : rest;
}

// ─── Model → Service Cache (for universal routing) ─────────────────────

/** @type {{ models: Object[], byModel: Map<string, Object>, updatedAt: number }} */
let modelCache = { models: [], byModel: new Map(), updatedAt: 0 };
const MODEL_CACHE_TTL = 30_000; // 30 seconds

/**
 * Force the next refreshModelCache / refreshEmbedModelCache call to refetch.
 * Call this after mutating any service's aliasOverride or registering / removing
 * a service so /v1/models reflects the change immediately rather than waiting
 * for the 30-second TTL.
 */
export function invalidateModelCache() {
  modelCache.updatedAt = 0;
  embedModelCache.updatedAt = 0;
  // Pools are rebuilt from the live registry, so a newly registered/removed embed or rerank
  // instance joins or leaves the rotation immediately rather than after the 30s TTL.
  invalidatePools();
}

/**
 * Refresh the model->service mapping cache by querying each LLM backend's /v1/models.
 *
 * When multiple backends serve the same model ID, generates decorated aliases
 * so each instance is individually addressable:
 *   - bare ID ("koboldcpp/Qwen3.5-27B") -> first instance (stable, lowest slot)
 *   - decorated ID ("koboldcpp/Qwen3.5-27B@2") -> second instance
 *   - decorated ID ("koboldcpp/Qwen3.5-27B@3") -> third instance, etc.
 * The @N suffix uses a 1-based occurrence counter (not the raw slot number)
 * so clients see a clean sequence regardless of slot gaps.
 */
async function refreshModelCache() {
  if (Date.now() - modelCache.updatedAt < MODEL_CACHE_TTL) return modelCache;

  const services = findServicesByType('llm');
  const rawModels = []; // { model, svc } pairs collected from all backends
  const byModel = new Map();

  await Promise.all(services.map(async (svc) => {
    const slot = svc.proxySlot || 0;
    try {
      const url = `http://${svc.containerIp}:${svc.port}/v1/models`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) return;
      const json = await resp.json();
      const models = json.data || [];
      for (const m of models) {
        // svc.aliasOverride lets users rename a running service's API name
        // without restarting it. The override replaces m.id BEFORE dedup so
        // collisions on the override name get the @N suffix correctly.
        if (svc.aliasOverride && typeof svc.aliasOverride === 'string') {
          rawModels.push({ m: { ...m, id: svc.aliasOverride }, svc, slot });
        } else {
          rawModels.push({ m, svc, slot });
        }
      }
    } catch {}
  }));

  // Sort by slot for stable ordering
  rawModels.sort((a, b) => a.slot - b.slot);

  // Track how many times each base model ID has appeared
  const idCount = new Map(); // baseId -> count seen so far
  const allModels = [];

  for (const { m, svc, slot } of rawModels) {
    const baseId = m.id;
    const count = (idCount.get(baseId) || 0) + 1;
    idCount.set(baseId, count);

    const enriched = {
      ...m,
      _proxlab_slot: slot,
      _proxlab_node: svc.node,
      _proxlab_provider: svc.providerId,
      _proxlab_slots: Number.isFinite(svc.slots) && svc.slots > 0 ? svc.slots : 1,
      _proxlab_service_id: svc.id,
      capabilities: resolveModelCapabilities(baseId),
    };

    if (count === 1) {
      // First occurrence — register under bare ID
      allModels.push(enriched);
      byModel.set(baseId, svc);
    } else {
      // Duplicate — register under decorated ID (baseId@N)
      const decoratedId = `${baseId}@${count}`;
      allModels.push({ ...enriched, id: decoratedId, _proxlab_base_id: baseId });
      byModel.set(decoratedId, svc);
    }
  }

  // Second pass: if a model had duplicates, also register the first one with @1
  // so the full set @1..@N is available (bare ID still works as default)
  for (const [baseId, total] of idCount) {
    if (total > 1) {
      const firstSvc = byModel.get(baseId);
      byModel.set(`${baseId}@1`, firstSvc);
    }
  }

  // Append external API sources (tagged). Routing markers live in a SEPARATE map so
  // local model routing is completely untouched until the forwarding branch consumes
  // externalByModel — a tagged model in the catalog is display/discovery-only for now.
  const externalByModel = new Map();
  try {
    const sources = loadExternalModelSources().filter((s) => s && s.enabled !== false);
    const perSource = await Promise.all(
      sources.map(async (source) => ({ source, ids: await fetchExternalSourceModels(source) })),
    );
    for (const { source, ids } of perSource) {
      for (const upstreamModel of ids) {
        const taggedId = `[${source.tag}] ${upstreamModel}`;
        allModels.push({
          id: taggedId,
          object: 'model',
          owned_by: source.id,
          _external_source: source.id,
          _external_tag: source.tag,
          _upstream_model: upstreamModel,
          _proxlab_provider: 'external',
          capabilities: resolveModelCapabilities(upstreamModel),
        });
        externalByModel.set(taggedId, { source, upstreamModel });
      }
    }
  } catch { /* external sources are best-effort; never break the local catalog */ }

  modelCache = { models: allModels, byModel, externalByModel, updatedAt: Date.now() };
  return modelCache;
}

// ─── Embed/Rerank Model Cache (same dedup pattern as LLM) ───────────────

/** @type {{ models: Object[], byModel: Map<string, Object>, updatedAt: number }} */
let embedModelCache = { models: [], byModel: new Map(), updatedAt: 0 };

/**
 * Refresh embed model cache with dedup — same @N decoration as LLM cache.
 */
async function refreshEmbedModelCache() {
  if (Date.now() - embedModelCache.updatedAt < MODEL_CACHE_TTL) return embedModelCache;

  const services = findServicesByType('embed');
  const rawModels = [];
  const byModel = new Map();

  await Promise.all(services.map(async (svc) => {
    const slot = svc.proxySlot || 0;
    try {
      const url = `http://${svc.containerIp}:${svc.port}/v1/models`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) return;
      const json = await resp.json();
      for (const m of (json.data || [])) {
        if (svc.aliasOverride && typeof svc.aliasOverride === 'string') {
          rawModels.push({ m: { ...m, id: svc.aliasOverride }, svc, slot });
        } else {
          rawModels.push({ m, svc, slot });
        }
      }
    } catch {}
  }));

  rawModels.sort((a, b) => a.slot - b.slot);

  const idCount = new Map();
  const allModels = [];

  for (const { m, svc, slot } of rawModels) {
    const baseId = m.id;
    const count = (idCount.get(baseId) || 0) + 1;
    idCount.set(baseId, count);

    const enriched = { ...m, _proxlab_slot: slot, _proxlab_provider: svc.providerId };

    if (count === 1) {
      allModels.push(enriched);
      byModel.set(baseId, svc);
    } else {
      const decoratedId = `${baseId}@${count}`;
      allModels.push({ ...enriched, id: decoratedId, _proxlab_base_id: baseId });
      byModel.set(decoratedId, svc);
    }
  }

  for (const [baseId, total] of idCount) {
    if (total > 1) byModel.set(`${baseId}@1`, byModel.get(baseId));
  }

  embedModelCache = { models: allModels, byModel, updatedAt: Date.now() };
  return embedModelCache;
}

/**
 * Buffer the raw request body (needed since proxy.js is mounted before express.json()).
 * @returns {Promise<Buffer>}
 */
function bufferBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Proxy a buffered request body to a target service.
 */
function proxyBuffered(req, res, targetHost, targetPort, targetPath, body, capture, onDone) {
  let doneFired = false;
  const fireDone = (ok) => { if (!doneFired) { doneFired = true; try { onDone && onDone({ completed: ok }); } catch {} } };
  const proxyReq = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${targetHost}:${targetPort}`,
        'content-length': body.length,
      },
    },
    (proxyRes) => {
      const isSSE = (proxyRes.headers['content-type'] || '').includes('event-stream');
      res.writeHead(proxyRes.statusCode, proxyRes.headers);

      // Optional response capture (tool-call metrics) — accumulate a text copy without disturbing the
      // client stream, then hand it to `capture` on end. Capped so a runaway response can't bloat memory.
      let capBuf = capture ? '' : null;
      const CAP_MAX = 2 * 1024 * 1024;
      const capAppend = (chunk) => { if (capBuf != null && capBuf.length < CAP_MAX) capBuf += chunk.toString(); };
      const capDone = () => { if (capture) { try { capture(capBuf, isSSE); } catch {} } };

      if (isSSE) {
        // Streaming SSE: forward chunks + inject empty-delta heartbeats during
        // upstream silence so consumer-side idle timers (e.g. OpenClaw's 120-300s
        // LLM idle timeout) don't fire during long prompt-processing phases.
        // OpenAI SDK parses these as valid chunks, idle timer resets, the empty
        // delta is invisible to the user.
        const HEARTBEAT_INTERVAL_MS = 30 * 1000;
        let hbTimer = null;
        const sendHeartbeat = () => {
          if (res.writableEnded) return;
          const payload = {
            id: 'hb-' + Date.now(),
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            model: 'keep-alive',
          };
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          scheduleHeartbeat();
        };
        const scheduleHeartbeat = () => {
          if (hbTimer) clearTimeout(hbTimer);
          hbTimer = setTimeout(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
        };
        const clearHeartbeat = () => {
          if (hbTimer) { clearTimeout(hbTimer); hbTimer = null; }
        };

        scheduleHeartbeat();
        proxyRes.on('data', (chunk) => { res.write(chunk); capAppend(chunk); scheduleHeartbeat(); });
        proxyRes.on('end', () => { clearHeartbeat(); res.end(); capDone(); fireDone(true); });
        proxyRes.on('error', () => { clearHeartbeat(); if (!res.writableEnded) res.end(); fireDone(false); });
        res.on('close', () => { clearHeartbeat(); fireDone(false); });
      } else if (capture) {
        proxyRes.on('data', (chunk) => { res.write(chunk); capAppend(chunk); });
        proxyRes.on('end', () => { res.end(); capDone(); fireDone(true); });
        proxyRes.on('error', () => { if (!res.writableEnded) res.end(); fireDone(false); });
        res.on('close', () => fireDone(false));
      } else {
        proxyRes.pipe(res);
        proxyRes.on('end', () => fireDone(true));
        proxyRes.on('error', () => fireDone(false));
        res.on('close', () => fireDone(false));
      }
    }
  );
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `Proxy error: ${err.message}` });
    }
    fireDone(false);
  });
  proxyReq.end(body);
}

/**
 * Find a service by type, checking managed services first, then external.
 * Returns { host, port } for both types.
 */
function findServiceOrExternal(type) {
  const managed = findServicesByType(type);
  if (managed.length) return { svc: managed[0], isExternal: false };
  const external = loadExternalServices().filter(e => e.type === type);
  if (external.length) {
    try {
      const url = new URL(external[0].url);
      return {
        svc: { containerIp: url.hostname, port: parseInt(url.port) || 80, ...external[0] },
        isExternal: true,
      };
    } catch {}
  }
  return { svc: null, isExternal: false };
}

/**
 * Handle model-based routing: read model from request body, look up cache, proxy.
 * If a decorated model ID (e.g. "model@2") is used, strips the @N suffix
 * before forwarding so the backend receives the original model name.
 */
async function handleModelRouting(req, res, path) {
  const body = await bufferBody(req);
  let modelId = null;
  try {
    const parsed = JSON.parse(body.toString());
    modelId = parsed.model;
  } catch {}

  let svc = null;
  if (modelId) {
    const cache = await refreshModelCache();
    svc = cache.byModel.get(modelId) || null;
  }

  // Fall back to slot 1
  // Only fall back to an arbitrary LLM service when NO model was requested. If a model WAS
  // named but is unreachable, do NOT silently reroute to the wrong model (see error below).
  if (!svc && !modelId) {
    const services = findServicesByType('llm');
    svc = services[0];
  }

  if (!svc) {
    if (modelId) {
      return res.status(503).json({
        error: `Assigned model '${modelId}' is not reachable — it is offline or not loaded, and no reachable fallback is available.`,
        hint: 'Launch the assigned model, or assign an online fallback model. The agent was NOT silently rerouted to another model.',
        requestedModel: modelId,
      });
    }
    return res.status(503).json({
      error: 'No active LLM service available',
      hint: 'Start an LLM service in ProxLab to enable proxying',
    });
  }

  const forwardPort = await getForwardPort(svc);

  // Strip @N suffix from decorated model IDs before forwarding
  if (modelId && modelId.includes('@')) {
    try {
      const parsed = JSON.parse(body.toString());
      parsed.model = modelId.replace(/@\d+$/, '');
      const rewritten = Buffer.from(JSON.stringify(parsed));
      return proxyBuffered(req, res, svc.containerIp, forwardPort, path, rewritten);
    } catch {}
  }

  proxyBuffered(req, res, svc.containerIp, forwardPort, path, body);
}

/**
 * Handle chat completions with MCP tool injection and tool-use loop.
 * Falls back to normal proxy if MCP is unavailable.
 */
async function handleChatWithTools(req, res) {
  // Simple pass-through: resolve model, proxy to backend.
  // No MCP tool injection — each frontend handles its own tools.
  const rawBody = await bufferBody(req);
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  let svc = null;
  if (parsed.model) {
    const cache = await refreshModelCache();
    // External model source (tag-prefixed, e.g. "[DS] deepseek-v4-pro"): forward to its
    // upstream API with the tag stripped + key injected. Local routing untouched below.
    const ext = cache.externalByModel && cache.externalByModel.get(parsed.model);
    if (ext) {
      return forwardToExternalSource(res, ext.source, ext.upstreamModel, parsed);
    }
    svc = cache.byModel.get(parsed.model) || null;
    if (svc && parsed.model.includes("@")) {
      parsed.model = parsed.model.replace(/@\d+$/, "");
    }
  }
  // Only fall back to an arbitrary LLM service when NO model was requested. A named-but-
  // unreachable model must error, not silently reroute (lets Hermes' fallback chain react).
  if (!svc && !parsed.model) {
    const services = findServicesByType("llm");
    svc = services[0];
  }
  if (!svc) {
    if (parsed.model) {
      return res.status(503).json({
        error: `Assigned model '${parsed.model}' is not reachable — it is offline or not loaded, and no reachable fallback is available.`,
        hint: "Launch the assigned model, or assign an online fallback model. The agent was NOT silently rerouted to another model.",
        requestedModel: parsed.model,
      });
    }
    return res.status(503).json({
      error: "No active LLM service available",
      hint: "Start an LLM service in ProxLab to enable proxying",
    });
  }

  // Strip @N suffix if present
  if (parsed.model && parsed.model.includes("@")) {
    parsed.model = parsed.model.replace(/@\d+$/, "");
  }

  // ─── Native Optane KV-cache (llama.cpp only, per-service toggle, default OFF) ───
  // When active we ARE the KV layer, so forward DIRECT to llama (bypass the +1000 shim).
  let _kvOrch = null, _kvTicket = null;
  if (isKvEligible(svc)) {
    try {
      _kvOrch = await getOrchestrator(svc);
      _kvTicket = await _kvOrch.prepare(parsed);   // mutates parsed: id_slot + cache_prompt
    } catch (e) {
      console.warn('[kv] prepare skipped:', e?.message || e);
      _kvOrch = null; _kvTicket = null;
    }
  }

  const body = Buffer.from(JSON.stringify(parsed));

  // Temporary diagnostic: when PROXLAB_DEBUG_PROMPTS=1, dump each outgoing
  // chat.completions body to /tmp/proxlab-prompt-dumps/<ts>-<model>.json so we
  // can diff consecutive prompts and identify per-turn-changing prefix bits
  // that defeat llama.cpp's hybrid-model prefix cache.
  if (process.env.PROXLAB_DEBUG_PROMPTS === '1') {
    try {
      const dir = '/tmp/proxlab-prompt-dumps';
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safe = (parsed.model || 'unknown').replace(/[^\w.-]/g, '_').slice(0, 80);
      writeFileSync(`${dir}/${ts}__${safe}.json`, body);
    } catch (e) { console.error('[proxlab-debug-prompts]', e.message); }
  }

  const forwardPort = _kvOrch ? svc.port : await getForwardPort(svc);
  // Tool-call metrics: only capture the response when the request actually offered tools (cheap no-op otherwise).
  const requestTools = Array.isArray(parsed.tools) ? parsed.tools : null;
  const capture = requestTools
    ? (text, isSSE) => {
        try { recordToolUsage({ svc, requestTools, toolCalls: extractToolCalls(text, isSSE) }); } catch {}
      }
    : undefined;
  const _kvOnDone = _kvTicket
    ? ({ completed }) => { try { _kvOrch.release(_kvTicket, { completed }); } catch {} }
    : undefined;
  proxyBuffered(req, res, svc.containerIp, forwardPort, "/v1/chat/completions", body, capture, _kvOnDone);
}

/**
 * Check provider health via /health then /v1/models fallback.
 * @returns {Promise<boolean>}
 */
async function checkProviderHealth(host, port) {
  for (const path of ['/health', '/v1/models']) {
    try {
      const resp = await fetch(`http://${host}:${port}${path}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) return true;
    } catch {}
  }
  return false;
}

/**
 * Build a provider info object for discovery responses.
 */
function buildProviderInfo(svc, caps, healthy) {
  return {
    slot: svc.proxySlot || 0,
    providerId: svc.providerId,
    providerName: svc.providerName || svc.providerId,
    host: svc.containerIp,
    port: svc.port,
    node: svc.node || null,
    gpus: svc.gpus || [],
    capabilities: {
      openai_compatible: caps?.openai || false,
      voices: !!caps?.voices,
      models: !!caps?.models,
      formats: caps?.formats || [],
    },
    status: healthy ? 'healthy' : 'unhealthy',
  };
}

/**
 * Create the proxy router.
 * @returns {Router}
 */
/**
 * @param {import('../services/ssh.js').SSHService} [sshService]
 *   SSH connection pool. Optional — only the cloned-speech route needs it
 *   to read voice files from the chatterbox host. If omitted, the route
 *   throws a 503.
 */
export function createProxyRouter(sshService) {
  const router = Router();

  // Start the credit-tracker snapshotter (idempotent — guarded internally).
  balanceHistory.start();

  // ─── Native Optane KV-cache: stats + settings + reaper (step 6) ───────────
  router.get('/kvcache/stats', async (_req, res) => {
    try {
      const eligible = findServicesByType('llm')
        .filter((svc) => svc.providerId === 'llama-server' && svc.containerIp && svc.port)
        .map((svc) => ({
          id: svc.id, name: svc.aliasOverride || svc.model || svc.id, model: svc.model,
          port: svc.port, containerIp: svc.containerIp, node: svc.node, slots: svc.slots,
        }));
      res.json({ eligible, services: await getAllKvStats(), pools: getKvIndexStats(), settings: getKvSettings() });
    } catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
  });
  router.get('/kvcache/settings', (_req, res) => res.json(getKvSettings()));
  router.post('/kvcache/settings', async (req, res) => {
    try {
      const updates = JSON.parse((await bufferBody(req)).toString());
      const cur = getKvSettings();
      if (typeof updates.defaultEnabled === 'boolean') cur.defaultEnabled = updates.defaultEnabled;
      if (updates.perService && typeof updates.perService === 'object') {
        cur.perService = cur.perService || {};
        for (const [id, v] of Object.entries(updates.perService)) {
          const prev = cur.perService[id] || {};
          const merged = { ...prev, ...v };
          if (v.config || prev.config) merged.config = { ...(prev.config || {}), ...(v.config || {}) };  // deep-merge tunables
          cur.perService[id] = merged;
        }
      }
      saveKvSettings(cur);
      resetOrchestratorCache();   // rebuild orchestrators so config/enable changes take effect
      res.json(cur);
    } catch (e) { res.status(400).json({ error: e?.message || String(e) }); }
  });
  router.post('/kvcache/reap/:fp', async (req, res) => {
    try { res.json(await reapNow(req.params.fp)); }
    catch (e) { res.status(500).json({ error: e?.message || String(e) }); }
  });

  // GET /services — Return current routing targets for diagnostics
  router.get('/services', async (req, res) => {
    const anthropicAuth = await isAuthenticated().catch(() => false);
    const external = loadExternalServices();
    res.json({
      llm: findServicesByType('llm').map((svc) => ({ slot: svc.proxySlot || 0, ...formatService(svc) })),
      tts: findServicesByType('tts').map((svc) => ({ slot: svc.proxySlot || 0, ...formatService(svc) })),
      stt: findServicesByType('stt').map((svc) => ({ slot: svc.proxySlot || 0, ...formatService(svc) })),
      embed: findServicesByType('embed').map((svc) => ({ slot: svc.proxySlot || 0, ...formatService(svc) })),
      rerank: findServicesByType('rerank').map((svc) => ({ slot: svc.proxySlot || 0, ...formatService(svc) })),
      image: findServicesByType('image').map((svc) => ({ slot: svc.proxySlot || 0, ...formatService(svc) })),
      imagegen: Object.fromEntries(
        Object.entries(IMAGEGEN_ALIASES).map(([alias, pid]) => {
          const matches = findServicesByType('image').filter(s => s.providerId === pid);
          return [alias, matches.map((svc, i) => ({
            instance: i + 1,
            url: i === 0 ? `/api/proxy/imagegen/${alias}` : `/api/proxy/imagegen/${i + 1}/${alias}`,
            ...formatService(svc),
          }))];
        }).filter(([, v]) => v.length)
      ),
      multiTts: {
        tts: findAllTtsPoolServices().map(svc => ({ slot: svc.proxySlot || 0, ...formatService(svc) })),
        rvc: findAllRvcServices().map(svc => ({ slot: svc.proxySlot || 0, ...formatService(svc) })),
        // `pooled` tells the UI which providers the balanced TTS pool covers, so
        // it no longer has to hardcode a provider id to make that call itself.
        pipelines: Math.min(findAllTtsPoolServices().length, findAllRvcServices().length),
        ttsCount: findAllTtsPoolServices().length,
      },
      external: external.map((svc, i) => ({ slot: i + 1, ...svc })),
      anthropic: {
        configured: true,
        authenticated: anthropicAuth,
        authStatus: await getAuthStatus().catch(() => ({ authenticated: false })),
        models: CLAUDE_MODELS.map(m => ({ id: m.id, shortName: m.shortName, label: m.label })),
      },
    });
  });

  // ─── Generic passthrough for user-supplied (custom) endpoints ──────
  // The TTS-test "Custom endpoint" field lets the user type any URL. Fetching it directly from the browser
  // would hit a private LAN IP from a remote (https) origin → Chrome Private-Network-Access permission
  // prompt + mixed-content + unreachable. Routing it through here keeps every LAN fetch on the backend.
  router.all('/passthrough', async (req, res) => {
    let target = req.query.url;
    if (!target) return res.status(400).json({ error: 'url query param required' });
    target = preferLanEndpoint(String(target));
    try {
      const headers = {};
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
      if (req.headers['accept']) headers['accept'] = req.headers['accept'];
      const init = { method: req.method, headers, signal: AbortSignal.timeout(600000) };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const body = await bufferBody(req);
        if (body && body.length) init.body = body;
      }
      const r = await fetch(target, init);
      res.status(r.status);
      const ct = r.headers.get('content-type'); if (ct) res.setHeader('content-type', ct);
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      res.status(502).json({ error: 'passthrough failed: ' + (e?.message || e) });
    }
  });

  // ─── Universal LLM Endpoint: /llm/v1/* ─────────────────────────────
  // This is a dedicated universal router — separate from numbered slots.
  // GET  /llm/v1/models           → aggregated model list from all backends
  // POST /llm/v1/chat/completions → routes by model name in request body
  // POST /llm/v1/completions      → routes by model name in request body
  // ALL  /llm/v1/*                → any other /v1 path, routes by model or slot 1

  router.get('/llm/v1/models', async (req, res) => {
    try {
      const cache = await refreshModelCache();
      res.json({ object: 'list', data: cache.models });
    } catch (err) {
      res.status(500).json({ error: `Failed to aggregate models: ${err.message}` });
    }
  });

  // GET /llm/catalog → CatalogModel[] (UI-shaped): the same aggregate as /v1/models but with
  // {id, tag, sourceId, upstreamModel, displayName, kind} per entry, so the builder's model
  // picker doesn't have to regex [TAG] out of ids. LOCAL ids stay untagged (tag carried in
  // metadata) so existing OpenAI consumers are unaffected; EXTERNAL ids are already [TAG]-prefixed.
  router.get('/llm/catalog', async (req, res) => {
    try {
      const cache = await refreshModelCache();
      const data = (cache.models || []).map((m) => {
        if (m._external_source) {
          return {
            id: m.id,
            tag: m._external_tag,
            sourceId: m._external_source,
            upstreamModel: m._upstream_model,
            displayName: m._upstream_model || m.id,
            kind: 'external',
          };
        }
        return {
          id: m.id,
          tag: 'AI-LAB',
          sourceId: 'ai-lab',
          upstreamModel: String(m.id || '').replace(/@\d+$/, ''),
          displayName: m.id,
          kind: 'local',
        };
      });
      res.json({ object: 'list', data });
    } catch (err) {
      res.status(500).json({ error: `Failed to build catalog: ${err.message}` });
    }
  });

  router.post('/llm/v1/chat/completions', (req, res) => {
    handleChatWithTools(req, res);
  });

  router.post('/llm/v1/completions', async (req, res) => {
    // Convert completions requests to chat/completions internally.
    // The raw completions API bypasses ChatML templating, so models with
    // thinking behavior (abliterated/heretic variants) emit <think> blocks
    // that never close. Chat/completions goes through the chat template
    // where the NoThink adapter properly suppresses thinking.
    const body = await bufferBody(req);
    let parsed;
    try { parsed = JSON.parse(body.toString()); } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const modelId = parsed.model;
    let svc = null;
    if (modelId) {
      const cache = await refreshModelCache();
      svc = cache.byModel.get(modelId) || null;
    }
    if (!svc) {
      const services = findServicesByType("llm");
      svc = services[0];
    }
    if (!svc) {
      return res.status(503).json({ error: "No active LLM service available" });
    }

    // Strip @N suffix from decorated model IDs
    const cleanModel = modelId ? modelId.replace(/@\d+$/, "") : modelId;

    // Build a chat/completions request from the completions request
    const chatBody = {
      model: cleanModel,
      messages: [{ role: "user", content: parsed.prompt || "" }],
      max_tokens: parsed.max_tokens || parsed.max_completion_tokens || 2048,
      temperature: parsed.temperature,
      top_p: parsed.top_p,
      stream: parsed.stream || false,
      stop: parsed.stop,
    };
    // Remove undefined keys
    Object.keys(chatBody).forEach(k => chatBody[k] === undefined && delete chatBody[k]);

    const chatBuf = Buffer.from(JSON.stringify(chatBody));
    const forwardPort = await getForwardPort(svc);

    const proxyReq = http.request({
      hostname: svc.containerIp,
      port: forwardPort,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: `${svc.containerIp}:${forwardPort}`,
        "content-length": chatBuf.length,
      },
    }, (proxyRes) => {
      const isSSE = (proxyRes.headers["content-type"] || "").includes("event-stream");

      if (isSSE) {
        // Streaming: convert chat.completion.chunk → text_completion chunk format
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        let pending = "";
        proxyRes.on("data", (chunk) => {
          pending += chunk.toString("utf8");
          const parts = pending.split("\n\n");
          pending = parts.pop();
          for (const part of parts) {
            if (!part.startsWith("data: ")) { res.write(part + "\n\n"); continue; }
            if (part === "data: [DONE]") { res.write(part + "\n\n"); continue; }
            try {
              const obj = JSON.parse(part.slice(6));
              // Convert chat.completion.chunk to text_completion format
              if (obj.choices) {
                for (const c of obj.choices) {
                  if (c.delta?.content != null) {
                    c.text = c.delta.content;
                    delete c.delta;
                  }
                }
              }
              if (obj.object === "chat.completion.chunk") obj.object = "text_completion";
              res.write("data: " + JSON.stringify(obj) + "\n\n");
            } catch { res.write(part + "\n\n"); }
          }
        });
        proxyRes.on("end", () => {
          if (pending.trim()) res.write(pending);
          res.end();
        });
      } else {
        // Non-streaming: convert chat.completion → text_completion format
        const chunks = [];
        proxyRes.on("data", c => chunks.push(c));
        proxyRes.on("end", () => {
          let respBody = Buffer.concat(chunks).toString("utf8");
          try {
            const chatResp = JSON.parse(respBody);
            // Convert response format
            if (chatResp.choices) {
              for (const c of chatResp.choices) {
                if (c.message?.content != null) {
                  c.text = c.message.content;
                  delete c.message;
                }
              }
            }
            if (chatResp.object === "chat.completion") chatResp.object = "text_completion";
            respBody = JSON.stringify(chatResp);
          } catch {}
          const buf = Buffer.from(respBody);
          const headers = { ...proxyRes.headers };
          headers["content-length"] = String(buf.length);
          delete headers["transfer-encoding"];
          res.writeHead(proxyRes.statusCode, headers);
          res.end(buf);
        });
      }
    });
    proxyReq.on("error", (err) => {
    });
    proxyReq.end(chatBuf);
  });

  // Catch-all for any other /llm/v1/* path (e.g. /v1/embeddings) — model routing
  router.all('/llm/v1/{*rest}', (req, res) => {
    const downstreamPath = '/v1/' + joinRestParam(req.params.rest);
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') {
      // No body to parse — fall back to slot 1
      const services = findServicesByType('llm');
      const svc = services[0];
      if (!svc) {
        return res.status(503).json({
          error: 'No active LLM service available',
          hint: 'Start an LLM service in ProxLab to enable proxying',
        });
      }
      proxyRequest(req, res, svc.containerIp, svc.port, downstreamPath);
    } else {
      handleModelRouting(req, res, downstreamPath);
    }
  });

  // ─── Universal Embeddings Endpoint: /embed/v1/* ──────────────────────
  // GET  /embed/v1/models     → aggregated model list with @N dedup
  // POST /embed/v1/embeddings → routes by model name in body, falls back to slot 1

  router.get('/embed/v1/models', async (req, res) => {
    try {
      const cache = await refreshPool('embed', findServicesByType);
      res.json({ object: 'list', data: cache.models });
    } catch (err) {
      res.status(500).json({ error: `Failed to aggregate embed models: ${err.message}` });
    }
  });

  router.all('/embed/v1/{*rest}', async (req, res) => {
    const downstreamPath = '/v1/' + joinRestParam(req.params.rest);

    if (req.method === 'GET' || req.method === 'HEAD') {
      const { svc } = findServiceOrExternal('embed');
      if (!svc) return res.status(503).json({ error: 'No active embedding service', hint: 'Start an embeddings model or add an external embedding service' });
      proxyRequest(req, res, svc.containerIp, svc.port, downstreamPath);
      return;
    }

    const body = await bufferBody(req);
    let modelId = null;
    try { modelId = JSON.parse(body.toString()).model; } catch {}

    // A BARE model id round-robins across every healthy instance serving it; a decorated
    // `model@2` pins that one instance (which is the whole point of the alias).
    let svc = null, baseId = null;
    if (modelId) {
      const cache = await refreshPool('embed', findServicesByType);
      ({ svc, baseId } = pickInstance('embed', cache, modelId));
    }
    if (!svc) {
      const { svc: fallback } = findServiceOrExternal('embed');
      svc = fallback;
    }
    if (!svc) return res.status(503).json({ error: 'No active embedding service', hint: 'Start an embeddings model or add an external embedding service' });

    // Downstream backends only know their own undecorated model id.
    let out = body;
    if (modelId && baseId && modelId !== baseId) {
      try {
        const parsed = JSON.parse(body.toString());
        parsed.model = baseId;
        out = Buffer.from(JSON.stringify(parsed));
      } catch {}
    }
    proxyBuffered(req, res, svc.containerIp, svc.port, downstreamPath, out, undefined,
      ({ completed }) => { if (completed) markSuccess(svc); else markFailure(svc); });
  });

  // ─── Universal Rerank Endpoint: /rerank/v1/* & /rerank/v2/* ─────────
  // Aggregated reranker model list, same shape as /embed/v1/models (this did not exist before —
  // there was no way to see which rerankers the proxy could reach).
  for (const ver of ['v1', 'v2']) {
    router.get(`/rerank/${ver}/models`, async (req, res) => {
      try {
        const cache = await refreshPool('rerank', findServicesByType);
        res.json({ object: 'list', data: cache.models });
      } catch (err) {
        res.status(500).json({ error: `Failed to aggregate rerank models: ${err.message}` });
      }
    });
  }

  for (const ver of ['v1', 'v2']) {
    router.all(`/rerank/${ver}/{*rest}`, async (req, res) => {
      const downstreamPath = `/${ver}/` + joinRestParam(req.params.rest);

      if (req.method === 'GET' || req.method === 'HEAD') {
        const { svc } = findServiceOrExternal('rerank');
        if (!svc) return res.status(503).json({ error: 'No active reranker service', hint: 'Add a reranker model or external reranker service' });
        return proxyRequest(req, res, svc.containerIp, svc.port, downstreamPath);
      }

      // Rerankers previously ignored the requested model entirely and used whichever service
      // sorted first. Now they route by model and load-balance across its instances, exactly
      // like embeddings.
      const body = await bufferBody(req);
      let modelId = null;
      try { modelId = JSON.parse(body.toString()).model; } catch {}

      let svc = null, baseId = null;
      if (modelId) {
        const cache = await refreshPool('rerank', findServicesByType);
        ({ svc, baseId } = pickInstance('rerank', cache, modelId));
      }
      if (!svc) {
        const { svc: fallback } = findServiceOrExternal('rerank');
        svc = fallback;
      }
      if (!svc) return res.status(503).json({ error: 'No active reranker service', hint: 'Add a reranker model or external reranker service' });

      let out = body;
      if (modelId && baseId && modelId !== baseId) {
        try {
          const parsed = JSON.parse(body.toString());
          parsed.model = baseId;
          out = Buffer.from(JSON.stringify(parsed));
        } catch {}
      }
      proxyBuffered(req, res, svc.containerIp, svc.port, downstreamPath, out, undefined,
        ({ completed }) => { if (completed) markSuccess(svc); else markFailure(svc); });
    });
  }

  // ─── External Services CRUD ─────────────────────────────────────────
  router.get('/external', (req, res) => res.json(loadExternalServices()));

  router.post('/external', (req, res) => {
    const body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      try {
        const svc = JSON.parse(Buffer.concat(body).toString());
        if (!svc.name || !svc.type || !svc.url) return res.status(400).json({ error: 'name, type, and url are required' });
        const external = loadExternalServices();
        const idx = external.findIndex(e => e.name === svc.name);
        if (idx >= 0) external[idx] = svc; else external.push(svc);
        saveExternalServices(external);
        res.json({ ok: true, count: external.length });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
  });

  // Health check all external services (server-side, avoids browser CORS/network issues)
  router.get('/external/health', async (req, res) => {
    const external = loadExternalServices();
    const results = {};
    await Promise.all(external.map(async (ext) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        // Try /health first, then /v1/models, then HEAD on root
        let ok = false;
        for (const path of ['/health', '/v1/models', '/healthz', '']) {
          try {
            const r = await fetch(`${ext.url}${path}`, { signal: ctrl.signal, method: path === '' ? 'HEAD' : 'GET' });
            if (r.ok || r.status === 404) { ok = true; break; }
          } catch {}
        }
        clearTimeout(timer);
        results[ext.name] = ok;
      } catch {
        results[ext.name] = false;
      }
    }));
    res.json(results);
  });

  router.delete('/external/:name', (req, res) => {
    const external = loadExternalServices().filter(e => e.name !== req.params.name);
    saveExternalServices(external);
    res.json({ ok: true, count: external.length });
  });

  // ─── External Model Sources CRUD (API providers behind the one proxy) ──────
  // Their models appear in /llm/v1/models tag-prefixed ([DS]/[MAX]/[OC]/…). Routing
  // (forwarding a tagged request to the upstream w/ key + metrics) is the next
  // increment; these routes + the tagged catalog are additive and safe today.
  // List model endpoints. The raw apiKey is NEVER returned — masked to ***<last4> + hasKey flag
  // (the full key is used only server-side by the forwarder). The UI edits without re-seeing it.
  router.get('/external-sources', (req, res) => {
    const redacted = loadExternalModelSources().map((s) => ({
      ...s,
      apiKey: s.apiKey ? `***${String(s.apiKey).slice(-4)}` : undefined,
      hasKey: !!s.apiKey,
      adminApiKey: s.adminApiKey ? `***${String(s.adminApiKey).slice(-4)}` : undefined,
      hasAdminKey: !!s.adminApiKey,
    }));
    res.json(redacted);
  });

  router.post('/external-sources', (req, res) => {
    const body = [];
    req.on('data', c => body.push(c));
    req.on('end', () => {
      try {
        const src = JSON.parse(Buffer.concat(body).toString());
        if (!src.id || !src.tag || !src.baseUrl || !src.transport) {
          return res.status(400).json({ error: 'id, tag, transport, and baseUrl are required' });
        }
        const sources = loadExternalModelSources();
        const idx = sources.findIndex(s => s.id === src.id);
        // Edit-without-re-entering-key: if the incoming apiKey is blank or a mask (***xxxx),
        // preserve the stored key rather than overwriting it.
        if (idx >= 0 && (!src.apiKey || String(src.apiKey).startsWith('***'))) {
          src.apiKey = sources[idx].apiKey;
        }
        // Same masked-edit preservation for the separate admin/usage key.
        if (idx >= 0 && (!src.adminApiKey || String(src.adminApiKey).startsWith('***'))) {
          src.adminApiKey = sources[idx].adminApiKey;
        }
        if (idx >= 0) sources[idx] = src; else sources.push(src);
        saveExternalModelSources(sources);
        invalidateModelCache();
        res.json({ ok: true, count: sources.length });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
  });

  router.delete('/external-sources/:id', (req, res) => {
    const sources = loadExternalModelSources().filter(s => s.id !== req.params.id);
    saveExternalModelSources(sources);
    invalidateModelCache();
    // Prune the source's balance-history rows so a reused id can't inherit its dead series.
    try { balanceHistory.prune(req.params.id); } catch { /* history prune is best-effort */ }
    res.json({ ok: true, count: sources.length });
  });

  // Full upstream model list for a source WITH metadata + per-model enabled flag — powers the
  // Settings per-model checkboxes (curate which models are proxied / shown). `enabled` reflects
  // the source's `models` allow-filter (empty allow-list ⇒ allowAll ⇒ every model enabled).
  router.get('/external-sources/:id/available', async (req, res) => {
    try {
      const source = loadExternalModelSources().find(s => s.id === req.params.id);
      if (!source) return res.status(404).json({ error: 'source not found' });
      const allow = Array.isArray(source.models) ? source.models : [];
      const allowAll = allow.length === 0;
      const allowSet = new Set(allow);
      // cacheSupported comes from the forwarder's OWN rule, so the UI can only ever offer a
      // toggle for something the proxy will genuinely act on.
      const raw = await fetchExternalSourceModelsRaw(source);
      if (raw.length) setCacheCapability(source, raw);   // UI and forwarder read the same set
      const models = raw
        .map(m => ({
          ...m,
          enabled: allowAll || allowSet.has(m.id),
          cacheSupported: cachingSupported(source, m.id),
          cacheOptions: cacheOptsFor(source, m.id),
        }));
      res.json({ sourceId: source.id, tag: source.tag, allowAll, count: models.length, models });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Prompt-cache token tallies per model for this source, as REPORTED BY THE UPSTREAM.
  // In-memory since the proxy last started (`since`), so the UI can label it truthfully.
  router.get('/external-sources/:id/cache-stats', (req, res) => {
    const prefix = `${req.params.id}::`;
    const models = {};
    for (const [k, v] of cacheStats.entries()) {
      if (k.startsWith(prefix)) models[k.slice(prefix.length)] = v;
    }
    res.json({ sourceId: req.params.id, since: cacheStatsSince, models });
  });

  // Live account credit/balance for one source (OpenRouter/DeepSeek supported; Anthropic not).
  router.get('/external-sources/:id/balance', async (req, res) => {
    try {
      const source = loadExternalModelSources().find(s => s.id === req.params.id);
      if (!source) return res.status(404).json({ error: 'source not found' });
      res.json({ sourceId: source.id, tag: source.tag, displayName: source.displayName, ...(await fetchExternalSourceBalance(source)) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Balances for ALL sources at once (powers the credit-tracker UI + the history snapshotter).
  router.get('/external-sources-balances', async (_req, res) => {
    try {
      const sources = loadExternalModelSources();
      const balances = await Promise.all(sources.map(async (s) => ({
        sourceId: s.id, tag: s.tag, displayName: s.displayName, ...(await fetchExternalSourceBalance(s)),
      })));
      res.json({ balances, checkedAt: Date.now() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Credit-tracker phase 2 — historical balance series + derived burn-rate/runway for one source.
  // ?days=N windows the series (default 30, 1..365). burnPerDay method: usage-delta (top-up-robust)
  // > spend-delta (Anthropic) > balance-delta (fallback). runwayDays = balance / burnPerDay.
  router.get('/external-sources/:id/balance-history', (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
      res.json(balanceHistory.historyFor(req.params.id, Date.now() - days * 86400000));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Take a balance snapshot now (on-demand; the snapshotter also runs on its own interval).
  router.post('/external-sources-balances/snapshot', async (_req, res) => {
    try {
      const rows = await balanceHistory.snapshot(Date.now());
      res.json({ ok: true, snapshotted: rows.length, checkedAt: Date.now() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ─── Named Image Gen Proxies ─────────────────────────────────────────
  // /imagegen/comfyui/*       → first active ComfyUI instance
  // /imagegen/2/comfyui/*     → second active ComfyUI instance
  // /imagegen/sdnext, /imagegen/fooocus, /imagegen/invokeai, etc.

  /**
   * Resolve an image gen provider from the URL.
   * Handles both /imagegen/:name/* and /imagegen/:num/:name/*
   */
  function resolveImageGen(req, res) {
    const first = req.params.first.toLowerCase();

    // Check if first segment is a number (instance selector)
    if (/^\d+$/.test(first)) {
      const num = parseInt(first, 10);
      const name = (req.params.second || '').toLowerCase();
      const providerId = IMAGEGEN_ALIASES[name];
      if (!providerId || num < 1) {
        return res.status(400).json({ error: `Unknown image gen provider: ${name}`, available: Object.keys(IMAGEGEN_ALIASES) });
      }
      const svc = findImageGenByProvider(providerId, num);
      if (!svc) {
        return res.status(503).json({ error: `No active ${name} instance #${num}`, hint: `Start a ${name} service in ProxLab` });
      }
      // rest starts after :second
      const rest = req.params.rest ? '/' + joinRestParam(req.params.rest) : '/';
      return proxyRequest(req, res, svc.containerIp, svc.port, rest);
    }

    // First segment is the provider name
    const providerId = IMAGEGEN_ALIASES[first];
    if (!providerId) {
      return res.status(400).json({ error: `Unknown image gen provider: ${first}`, available: Object.keys(IMAGEGEN_ALIASES) });
    }
    const svc = findImageGenByProvider(providerId, 1);
    if (!svc) {
      return res.status(503).json({ error: `No active ${first} instance`, hint: `Start a ${first} service in ProxLab` });
    }
    // Everything after :first is the downstream path
    const parts = [req.params.second, req.params.rest ? joinRestParam(req.params.rest) : null].filter(Boolean);
    const downstreamPath = parts.length ? '/' + parts.join('/') : '/';
    return proxyRequest(req, res, svc.containerIp, svc.port, downstreamPath);
  }

  // Match /imagegen/:first/:second/* (covers both numbered and sub-path cases)
  router.all('/imagegen/:first/:second/{*rest}', resolveImageGen);
  // Match /imagegen/:first/:second (no trailing segments)
  router.all('/imagegen/:first/:second', resolveImageGen);
  // Match /imagegen/:first (root path, e.g. /imagegen/sdnext)
  router.all('/imagegen/:first', (req, res) => {
    req.params.second = null;
    req.params.rest = null;
    resolveImageGen(req, res);
  });

  // List all named image gen endpoints
  router.get('/imagegen', (req, res) => {
    const state = loadActiveServices();
    const result = {};
    for (const [alias, providerId] of Object.entries(IMAGEGEN_ALIASES)) {
      const instances = Object.values(state.services)
        .filter(svc => svc.providerId === providerId && svc.containerIp && svc.port)
        .sort((a, b) => (a.proxySlot || 999) - (b.proxySlot || 999))
        .map((svc, i) => ({
          instance: i + 1,
          url: i === 0 ? `/api/proxy/imagegen/${alias}` : `/api/proxy/imagegen/${i + 1}/${alias}`,
          ...formatService(svc),
        }));
      if (instances.length) result[alias] = instances;
    }
    res.json(result);
  });

  // Shared health cache for every audio backend. Without this each request
  // fanned out a fresh probe to every instance; the TTL collapses the burst a
  // single synthesis triggers while still noticing a dead backend in seconds.
  const audioHealth = createHealthCache(checkProviderHealth);

  /** JSON GET used when asking a backend what models it serves. */
  async function fetchJsonForCatalog(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /**
   * Resolve a caller's `model` into the backends that can serve it plus the bare
   * model id to forward.
   *
   * Returns { backends, model, matched, reason }. `backends` empty means nothing
   * serves it — the caller should 503 with `reason`, NOT fall back to another
   * model. Silent substitution is how a pool ends up quietly serving the wrong
   * voice for weeks.
   */
  async function resolveTtsSelection(healthyTts, rawModel) {
    const { models } = await getModelCatalog(healthyTts, fetchJsonForCatalog);
    const sel = selectBackends(models, rawModel);
    const bare = rawModel && rawModel.includes('/') ? rawModel.slice(rawModel.indexOf('/') + 1) : rawModel;
    return { backends: sel.backends, model: bare, matched: sel.matched, reason: sel.reason };
  }

  // ── Audio pipeline config (persisted post-processing defaults) ──────────
  // GET  returns the live config plus the shipped defaults, so the UI can show
  //      what "reset" would mean without hardcoding a copy of them.
  router.get('/audio-pipeline/settings', (_req, res) => {
    res.json({ config: getPipelineConfig(), defaults: PIPELINE_DEFAULTS });
  });

  router.post('/audio-pipeline/settings', async (req, res) => {
    try {
      const updates = JSON.parse((await bufferBody(req)).toString());
      if (!updates || typeof updates !== 'object' || !updates.post) {
        return res.status(400).json({ error: 'expected { post: { <group>: {...} } }' });
      }
      // No enabled-without-model check any more: `allowed` is a permission, and
      // permitting RVC without picking a house speaker is perfectly valid — the
      // caller names its own. The old check belonged to the force semantics.
      const saved = savePipelineConfig(updates);
      console.log(`[audio-pipeline] updated: rvc.allowed=${saved.post.rvc.allowed} `
        + `fallbackModel=${saved.post.rvc.model || 'none'}`);
      res.json({ config: saved, defaults: PIPELINE_DEFAULTS });
    } catch (e) {
      res.status(400).json({ error: e?.message || String(e) });
    }
  });

  // --- RVC Voice Conversion Pipeline (TTS -> RVC) ---
  // POST /rvc/convert — Direct RVC conversion (proxy to RVC service)
  // POST /rvc/pipeline — Full pipeline: TTS generates audio, then RVC converts voice
  // GET  /rvc/models  — List available RVC voice models
  // GET  /rvc/health  — RVC service health

  // Single RVC backend (balanced). Returns null when none is registered — the
  // callers all already guard on that and return 503.
  //
  // This used to filter providerId === 'proxlab-rvc' and fall back to a hardcoded
  // ai-gpu host/port. Since every row is written as 'rvc', the filter never
  // matched and all four /rvc/* routes ran on the fallback permanently; it only
  // appeared to work because the hardcoded host happened to be right.
  function findRvcService() {
    const all = findAllRvcServices();
    if (all.length === 0) return null;
    return all[nextIndex('post:rvc', all.length)];
  }

  function findAllRvcServices() {
    return listBackends(loadActiveServices().services, 'post');
  }

  /**
   * TTS backends eligible for the balanced pool (clip-style providers only).
   * Fixed-voice engines like kokoro stay reachable on their slot endpoints but
   * never join the pool — see audio-registry.js for why.
   */
  function findAllTtsPoolServices() {
    return listBackends(loadActiveServices().services, 'tts');
  }

  /** Discover healthy proxlab-tts + proxlab-rvc instances, return paired pipelines. */
  async function buildHealthyPipelines() {
    const allTts = findAllTtsPoolServices();
    const allRvc = findAllRvcServices();

    const [ttsHealth, rvcHealth] = await Promise.all([
      audioHealth.withHealth(allTts),
      audioHealth.withHealth(allRvc),
    ]);

    let healthyTts = ttsHealth.filter(h => h.healthy).map(h => h.svc);
    const healthyRvc = rvcHealth.filter(h => h.healthy).map(h => h.svc);
    const pipelineCount = Math.min(healthyTts.length, healthyRvc.length);

    const pipelines = [];
    for (let i = 0; i < pipelineCount; i++) {
      pipelines.push({ ttsSvc: healthyTts[i], rvcSvc: healthyRvc[i] });
    }

    return {
      pipelines,
      pipelineCount,
      ttsInstances: { total: allTts.length, healthy: healthyTts.length, services: allTts, healthResults: ttsHealth },
      rvcInstances: { total: allRvc.length, healthy: healthyRvc.length, services: allRvc, healthResults: rvcHealth },
    };
  }

  /**
   * Split text into sentences, protecting common abbreviations and
   * coalescing short fragments. TTS models hallucinate badly when fed
   * single-clause input — they often invent prefix sounds or words to
   * fill the rhythm. Merging short sentences with the next one until a
   * minimum word count is met gives the model enough context to behave.
   *
   * minWords default 8 picked empirically — covers the common pain
   * cases ("Hi.", "Got it.", "Sure!") without forcing genuinely
   * complete short sentences ("The cat sat on the mat.") to fuse with
   * neighbours.
   */
  function splitSentences(text, minWords = 8) {
    const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Ave|Blvd|Gen|Gov|Sgt|Cpl|Pvt|Capt|Lt|Col|Maj|Rev|Fr|etc|vs|approx|dept|est|vol|no|fig|ref|e\.g|i\.e|a\.m|p\.m|U\.S\.A|U\.S|U\.K)\./gi;
    let working = text;
    const placeholders = [];
    working = working.replace(ABBREV, (match) => {
      const idx = placeholders.length;
      placeholders.push(match);
      return `__ABBR${idx}__`;
    });
    // Also protect decimal numbers (e.g. "3.5")
    working = working.replace(/(\d)\.(\d)/g, (match) => {
      const idx = placeholders.length;
      placeholders.push(match);
      return `__ABBR${idx}__`;
    });
    const raw = working
      .split(/(?<=[.!?])\s+|\n+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    const restored = raw.map(s => {
      let r = s;
      for (let i = 0; i < placeholders.length; i++) {
        r = r.replaceAll(`__ABBR${i}__`, placeholders[i]);
      }
      return r;
    });
    return mergeShortSentences(restored, minWords);
  }

  /**
   * Greedy merge: walk the sentences and keep concatenating until the
   * running buffer hits minWords. If the buffer is short when we run
   * out of input, fold it into the previous chunk so we never emit a
   * trailing fragment shorter than the threshold (unless the whole
   * input is shorter, in which case there's nothing to merge with).
   */
  function mergeShortSentences(sentences, minWords) {
    if (!Array.isArray(sentences) || sentences.length <= 1) {
      return sentences;
    }
    const wc = (s) => s.trim().split(/\s+/).filter(Boolean).length;
    const out = [];
    let buf = '';
    for (const s of sentences) {
      buf = buf ? `${buf} ${s}` : s;
      if (wc(buf) >= minWords) {
        out.push(buf);
        buf = '';
      }
    }
    if (buf) {
      if (out.length > 0) {
        out[out.length - 1] = `${out[out.length - 1]} ${buf}`;
      } else {
        out.push(buf);
      }
    }
    return out;
  }

  /**
   * Build multipart/form-data body for RVC /convert.
   * Returns { body: Buffer, contentType: string }
   */
  function buildRvcMultipart(audioBuffer, params) {
    const boundary = `----ProxLabRVC${Date.now()}${Math.random().toString(36).slice(2)}`;
    const fields = [
      { name: 'model_name', value: params.rvc_model },
      { name: 'f0_method', value: params.f0_method || 'rmvpe' },
      { name: 'f0_up_key', value: String(params.f0_up_key ?? 0) },
      { name: 'index_rate', value: String(params.index_rate ?? 0.75) },
      { name: 'filter_radius', value: String(params.filter_radius ?? 3) },
      { name: 'rms_mix_rate', value: String(params.rms_mix_rate ?? 0.25) },
      { name: 'protect', value: String(params.protect ?? 0.33) },
      { name: 'resample_sr', value: String(params.resample_sr ?? 48000) },
      { name: 'output_format', value: params.output_format || 'wav' },
    ];
    const parts = [];
    for (const f of fields) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`));
    }
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tts_output.wav"\r\nContent-Type: audio/wav\r\n\r\n`
    ));
    parts.push(audioBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  /**
   * Process one sentence: TTS → optional RVC → { audio: base64, duration_ms }
   */
  async function processSentence(sentence, ttsSvc, rvcSvc, params) {
    const ttsBase = `http://${ttsSvc.containerIp}:${ttsSvc.port}`;
    const ttsBody = {
      input: sentence,
      voice: params.voice || 'default',
      speed: params.speed || 1.0,
      response_format: 'wav',
      model: params.model || 'chatterbox-turbo',
    };
    // Pass through model-specific params if present
    if (params.temperature != null) ttsBody.temperature = params.temperature;
    if (params.top_k != null) ttsBody.top_k = params.top_k;
    if (params.top_p != null) ttsBody.top_p = params.top_p;
    if (params.repetition_penalty != null) ttsBody.repetition_penalty = params.repetition_penalty;
    if (params.exaggeration != null) ttsBody.exaggeration = params.exaggeration;
    if (params.cfg_weight != null) ttsBody.cfg_weight = params.cfg_weight;
    if (params.min_p != null) ttsBody.min_p = params.min_p;

    const t0 = Date.now();
    const ttsResp = await fetch(`${ttsBase}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ttsBody),
      signal: AbortSignal.timeout(60_000),
    });
    if (!ttsResp.ok) {
      const errText = await ttsResp.text().catch(() => 'unknown');
      throw new Error(`TTS failed (${ttsResp.status}): ${errText.slice(0, 200)}`);
    }
    let audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
    const tts_time_ms = Date.now() - t0;

    let rvc_time_ms = 0;
    if (rvcSvc && params.rvc_model) {
      const rvcBase = `http://${rvcSvc.containerIp}:${rvcSvc.port}`;
      const { body: multipartBody, contentType } = buildRvcMultipart(audioBuffer, params);
      const rt0 = Date.now();
      const rvcResp = await fetch(`${rvcBase}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: multipartBody,
        signal: AbortSignal.timeout(60_000),
      });
      if (!rvcResp.ok) {
        const errText = await rvcResp.text().catch(() => 'unknown');
        throw new Error(`RVC failed (${rvcResp.status}): ${errText.slice(0, 200)}`);
      }
      audioBuffer = Buffer.from(await rvcResp.arrayBuffer());
      rvc_time_ms = Date.now() - rt0;
    }

    // Estimate duration from WAV header
    let duration_ms = 0;
    if (audioBuffer.length > 44) {
      const sampleRate = audioBuffer.readUInt32LE(24);
      const bitsPerSample = audioBuffer.readUInt16LE(34);
      const numChannels = audioBuffer.readUInt16LE(22);
      const dataSize = audioBuffer.readUInt32LE(40);
      if (sampleRate > 0 && bitsPerSample > 0 && numChannels > 0) {
        const bytesPerSample = (bitsPerSample / 8) * numChannels;
        const totalSamples = dataSize / bytesPerSample;
        duration_ms = Math.round((totalSamples / sampleRate) * 1000);
      }
    }

    return {
      audio: audioBuffer.toString('base64'),
      duration_ms,
      tts_time_ms,
      rvc_time_ms,
      total_time_ms: tts_time_ms + rvc_time_ms,
      audio_bytes: audioBuffer.length,
      tts_host: `${ttsSvc.containerIp}:${ttsSvc.port}`,
      rvc_host: rvcSvc ? `${rvcSvc.containerIp}:${rvcSvc.port}` : null,
    };
  }

  router.get('/rvc/health', async (req, res) => {
    const svc = findRvcService();
    if (!svc) return res.status(503).json({ error: 'No active RVC service' });
    try {
      const r = await fetch(`http://${svc.containerIp}:${svc.port}/health`);
      const data = await r.json();
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: `RVC health check failed: ${err.message}` });
    }
  });

  router.get('/rvc/models', async (req, res) => {
    const svc = findRvcService();
    if (!svc) return res.status(503).json({ error: 'No active RVC service' });
    try {
      const r = await fetch(`http://${svc.containerIp}:${svc.port}/models`);
      const data = await r.json();
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: `RVC models fetch failed: ${err.message}` });
    }
  });

  // Direct RVC convert — proxy multipart upload to RVC service
  router.post('/rvc/convert', (req, res) => {
    const svc = findRvcService();
    if (!svc) return res.status(503).json({ error: 'No active RVC service' });
    proxyRequest(req, res, svc.containerIp, svc.port, '/convert');
  });

  // Full TTS -> RVC pipeline
  router.post('/rvc/pipeline', async (req, res) => {
    const rvcSvc = findRvcService();
    if (!rvcSvc) return res.status(503).json({ error: 'No active RVC service' });

    const ttsSvcs = findServicesByType('tts').filter(s => s.providerId !== 'proxlab-rvc');
    if (!ttsSvcs.length) return res.status(503).json({ error: 'No active TTS service' });

    // Parse JSON body manually (this router is mounted before express.json)
    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const {
      input, voice, speed, response_format,
      tts_slot,
      rvc_model, f0_method = 'rmvpe', f0_up_key = 0,
      index_rate = 0.75, filter_radius = 3,
      rms_mix_rate = 0.25, protect = 0.33,
      resample_sr = 48000, output_format = 'wav',
    } = body;

    if (!input) return res.status(400).json({ error: 'input is required' });
    if (!rvc_model) return res.status(400).json({ error: 'rvc_model is required' });

    // Pick TTS service by slot or default to first
    let ttsSvc = ttsSvcs[0];
    if (tts_slot) {
      const slotSvc = findServiceBySlot('tts', tts_slot);
      if (slotSvc && slotSvc.providerId !== 'proxlab-rvc') ttsSvc = slotSvc;
    }

    const ttsBase = `http://${ttsSvc.containerIp}:${ttsSvc.port}`;

    try {
      // Step 1: Generate TTS audio
      console.log(`[rvc-pipeline] TTS: ${ttsBase} voice=${voice || 'default'}`);
      const ttsBody = { input, voice: voice || 'default' };
      if (speed) ttsBody.speed = speed;
      // Always request WAV from TTS for maximum quality input to RVC
      // (MP3 compression at 80kbps/24kHz adds artifacts before conversion)
      ttsBody.response_format = 'wav';

      const ttsResp = await fetch(`${ttsBase}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ttsBody),
      });

      if (!ttsResp.ok) {
        const errText = await ttsResp.text().catch(() => 'unknown error');
        return res.status(502).json({ error: `TTS failed (${ttsResp.status}): ${errText.slice(0, 300)}` });
      }

      const ttsAudio = Buffer.from(await ttsResp.arrayBuffer());
      console.log(`[rvc-pipeline] TTS returned ${ttsAudio.length} bytes`);

      // Step 2: Send TTS audio to RVC for voice conversion
      const rvcBase = `http://${rvcSvc.containerIp}:${rvcSvc.port}`;
      const { body: multipartBody, contentType } = buildRvcMultipart(ttsAudio, {
        rvc_model, f0_method, f0_up_key, index_rate,
        filter_radius, rms_mix_rate, protect, resample_sr, output_format,
      });

      console.log(`[rvc-pipeline] RVC: ${rvcBase} model=${rvc_model}`);
      const rvcResp = await fetch(`${rvcBase}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: multipartBody,
      });

      if (!rvcResp.ok) {
        const errText = await rvcResp.text().catch(() => 'unknown error');
        return res.status(502).json({ error: `RVC failed (${rvcResp.status}): ${errText.slice(0, 300)}` });
      }

      const rvcAudio = Buffer.from(await rvcResp.arrayBuffer());
      const inferenceTime = rvcResp.headers.get('X-Inference-Time');
      console.log(`[rvc-pipeline] RVC returned ${rvcAudio.length} bytes (inference: ${inferenceTime}s)`);

      const mimeMap = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg' };
      res.set('Content-Type', mimeMap[output_format] || 'audio/wav');
      res.set('Content-Disposition', `attachment; filename="rvc_output.${output_format}"`);
      if (inferenceTime) res.set('X-RVC-Inference-Time', inferenceTime);
      res.send(rvcAudio);
    } catch (err) {
      console.error(`[rvc-pipeline] Error: ${err.message}`);
      res.status(500).json({ error: `Pipeline error: ${err.message}` });
    }
  });

  // ─── Audio Tools Proxy ─────────────────────────────────────────────────
  // Pass-through proxy to the audio-tools FastAPI service (Demucs + Resemble Enhance + FLowHigh)

  function findAudioToolsService() {
    const state = loadActiveServices();
    const registered = Object.values(state.services).find(
      svc => svc.providerId === 'audio-tools' && svc.containerIp && svc.port
    );
    if (registered) return registered;
    // Always-on fallback — audio-tools runs as a managed service on ai-gpu
    return { providerId: 'audio-tools', containerIp: '10.0.0.235', port: 8890 };
  }

  router.all('/audio-tools/{*rest}', (req, res) => {
    const svc = findAudioToolsService();
    if (!svc) {
      return res.status(503).json({ error: 'Audio Tools service is not running' });
    }
    const downstreamPath = '/' + joinRestParam(req.params.rest);
    proxyRequest(req, res, svc.containerIp, svc.port, downstreamPath);
  });

  router.get('/audio-tools', (req, res) => {
    const svc = findAudioToolsService();
    if (!svc) {
      return res.status(503).json({ error: 'Audio Tools service is not running' });
    }
    res.json({ status: 'available', endpoint: `http://${svc.containerIp}:${svc.port}`, ...formatService(svc) });
  });

  // ─── Multi-TTS Pipeline API ─────────────────────────────────────────────
  // N-way TTS+RVC pipeline using all healthy proxlab-tts + proxlab-rvc instances

  // GET /multi-tts/status — Pipeline count, per-instance health, ready state
  router.get('/multi-tts/status', async (req, res) => {
    try {
      const { pipelines, pipelineCount, ttsInstances, rvcInstances } = await buildHealthyPipelines();
      res.json({
        ready: pipelineCount > 0,
        pipelines: pipelineCount,
        tts: {
          total: ttsInstances.total,
          healthy: ttsInstances.healthy,
          instances: ttsInstances.healthResults.map(h => ({
            slot: h.svc.proxySlot || 0,
            host: h.svc.containerIp,
            port: h.svc.port,
            node: h.svc.node || null,
            healthy: h.healthy,
          })),
        },
        rvc: {
          total: rvcInstances.total,
          healthy: rvcInstances.healthy,
          instances: rvcInstances.healthResults.map(h => ({
            slot: h.svc.proxySlot || 0,
            host: h.svc.containerIp,
            port: h.svc.port,
            node: h.svc.node || null,
            healthy: h.healthy,
          })),
        },
      });
    } catch (err) {
      res.status(500).json({ error: `Status check failed: ${err.message}` });
    }
  });

  // GET the aggregated voice list. Exposed on several paths because different clients
  // look in different places: the marinara engine UI expects /audio/voices, OpenAI-shaped
  // clients expect /v1/audio/voices, and AI-Lab's own UI uses /multi-tts/voices. One
  // handler, several spellings — cheaper than making each client configurable.
  router.get([
    '/multi-tts/voices',
    '/multi-tts/audio/voices',
    '/multi-tts/v1/audio/voices',
    '/tts/audio/voices',
    '/tts/v1/audio/voices',
  ], async (req, res) => {
    const allTts = findAllTtsPoolServices();
    if (allTts.length === 0) return res.status(503).json({ error: 'No proxlab-tts services registered' });

    const voiceMap = new Map();
    await Promise.all(allTts.map(async svc => {
      try {
        // Try /v1/voices first (proxlab-tts), then /v1/audio/voices as fallback
        let r = await fetch(`http://${svc.containerIp}:${svc.port}/v1/voices`, {
          signal: AbortSignal.timeout(5000),
        }).catch(() => null);
        if (!r?.ok) {
          r = await fetch(`http://${svc.containerIp}:${svc.port}/v1/audio/voices`, {
            signal: AbortSignal.timeout(5000),
          }).catch(() => null);
        }
        if (!r?.ok) return;
        const data = await r.json();
        const voices = data.voices || data;
        if (Array.isArray(voices)) {
          for (const v of voices) {
            const name = typeof v === 'string' ? v : v.name || v.id;
            if (name && !voiceMap.has(name)) voiceMap.set(name, v);
          }
        }
      } catch {}
    }));

    res.json({ voices: Array.from(voiceMap.values()), count: voiceMap.size });
  });

  // POST /multi-tts/voices — Upload a new voice profile (multipart proxy to first healthy TTS)
  router.post('/multi-tts/voices', async (req, res) => {
    const allTts = findAllTtsPoolServices();
    if (allTts.length === 0) return res.status(503).json({ error: 'No proxlab-tts services registered' });

    // Find first healthy instance
    let target;
    for (const svc of allTts) {
      if (await checkProviderHealth(svc.containerIp, svc.port)) { target = svc; break; }
    }
    if (!target) return res.status(503).json({ error: 'No healthy TTS service available' });

    // Proxy the multipart upload directly
    proxyRequest(req, res, target.containerIp, target.port, '/v1/voices');
  });

  // DELETE /multi-tts/voices/:name — Delete a voice profile from first healthy TTS
  router.delete('/multi-tts/voices/:name', async (req, res) => {
    const allTts = findAllTtsPoolServices();
    if (allTts.length === 0) return res.status(503).json({ error: 'No proxlab-tts services registered' });

    let target;
    for (const svc of allTts) {
      if (await checkProviderHealth(svc.containerIp, svc.port)) { target = svc; break; }
    }
    if (!target) return res.status(503).json({ error: 'No healthy TTS service available' });

    proxyRequest(req, res, target.containerIp, target.port, `/v1/voices/${encodeURIComponent(req.params.name)}`);
  });

  // GET /multi-tts/rvc-models — RVC models from all RVC instances
  router.get('/multi-tts/rvc-models', async (req, res) => {
    const allRvc = findAllRvcServices();
    if (allRvc.length === 0) return res.status(503).json({ error: 'No RVC services registered' });

    const modelMap = new Map();
    await Promise.all(allRvc.map(async svc => {
      try {
        const r = await fetch(`http://${svc.containerIp}:${svc.port}/models`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return;
        const data = await r.json();
        const models = data.models || data;
        if (Array.isArray(models)) {
          for (const m of models) {
            const name = typeof m === 'string' ? m : m.name || m.model_name;
            if (name && !modelMap.has(name)) modelMap.set(name, m);
          }
        }
      } catch {}
    }));

    res.json({ models: Array.from(modelMap.values()), count: modelMap.size });
  });

  // POST /multi-tts/speech — Single TTS+RVC request, returns audio binary
  router.post('/multi-tts/speech', async (req, res) => {
    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    if (!body.input?.trim()) return res.status(400).json({ error: 'input is required' });
    if (!body.rvc_model) return res.status(400).json({ error: 'rvc_model is required' });

    const { pipelines } = await buildHealthyPipelines();
    if (pipelines.length === 0) {
      return res.status(503).json({ error: 'No healthy TTS+RVC pipelines available' });
    }

    const params = {
      voice: body.voice || 'default',
      speed: body.speed || 1.0,
      model: body.model || 'chatterbox-turbo',
      rvc_model: body.rvc_model,
      f0_method: body.f0_method || 'rmvpe',
      f0_up_key: body.f0_up_key ?? 0,
      index_rate: body.index_rate ?? 0.75,
      filter_radius: body.filter_radius ?? 3,
      rms_mix_rate: body.rms_mix_rate ?? 0.25,
      protect: body.protect ?? 0.33,
      resample_sr: body.resample_sr ?? 48000,
      output_format: body.output_format || 'wav',
    };

    // Try each pipeline until one succeeds
    let lastErr;
    for (const pipeline of pipelines) {
      try {
        const result = await processSentence(body.input.trim(), pipeline.ttsSvc, pipeline.rvcSvc, params);
        const audioBuffer = Buffer.from(result.audio, 'base64');
        const mimeMap = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg' };
        res.set('Content-Type', mimeMap[params.output_format] || 'audio/wav');
        res.set('Content-Disposition', `attachment; filename="multi_tts_output.${params.output_format}"`);
        res.set('X-Duration-Ms', String(result.duration_ms));
        return res.send(audioBuffer);
      } catch (err) {
        lastErr = err;
        console.error(`[multi-tts/speech] Pipeline failed: ${err.message}`);
      }
    }
    res.status(502).json({ error: `All pipelines failed: ${lastErr?.message}` });
  });

  // POST /multi-tts/v1/audio/speech — OpenAI-compatible TTS endpoint with load balancing
  // Accepts standard OpenAI fields (model, input, voice, response_format, speed)
  // plus optional RVC fields (rvc_model, f0_method, f0_up_key, etc.)
  // When rvc_model is omitted, proxies directly to a TTS backend (supports all formats).
  // When rvc_model is provided, routes through TTS→RVC pipeline (returns wav).
  /**
   * THE universal TTS speech endpoint. Registered on both paths so the two can
   * never diverge again — before phase 3, /tts/v1 was a separate single-provider
   * route that took services[0], which is why a composite provider/model ID
   * worked on /multi-tts and 400'd on /tts/v1.
   *
   * /multi-tts/* is retained as an alias and logs a deprecation line naming the
   * caller, so we can see who still depends on it before it goes.
   */
  router.post(['/tts/v1/audio/speech', '/multi-tts/v1/audio/speech'], async (req, res) => {
    if (req.path.startsWith('/multi-tts')) {
      console.warn(`[deprecated] ${req.path} — use /tts/v1/audio/speech `
        + `(caller ${req.ip || 'unknown'}, ua=${(req.headers['user-agent'] || 'none').slice(0, 60)})`);
    }

    const rawBody = await bufferBody(req);
    let body;
    try {
      body = JSON.parse(rawBody.toString());
    } catch {
      // Non-JSON: stream it through untouched, as the old /tts/v1 route did —
      // but to a BALANCED backend rather than always the first service.
      const pool = findAllTtsPoolServices();
      if (pool.length === 0) {
        return res.status(503).json({ error: emptyReason('tts', { registered: 0 }) });
      }
      const pick = pool[nextIndex('tts:raw', pool.length)];
      return proxyBuffered(req, res, pick.containerIp, pick.port, '/v1/audio/speech', rawBody);
    }

    // Explicit slot pin. proxy_notes keeps individual endpoints addressable, so a
    // caller naming a slot bypasses the pool entirely and gets exactly that service.
    if (body.provider) {
      const slot = body.provider;
      delete body.provider;               // never forward our own routing field
      const svc = findServiceBySlot('tts', slot);
      if (!svc) return res.status(404).json({ error: `No TTS service in slot ${slot}` });
      const caps = TTS_PROVIDER_CAPS[svc.providerId];
      if (!caps || !caps.openai) {
        return res.status(400).json({
          error: `Provider ${svc.providerId} (slot ${slot}) does not support the OpenAI speech API`,
          providerId: svc.providerId,
        });
      }
      return proxyBuffered(req, res, svc.containerIp, svc.port, '/v1/audio/speech',
                           Buffer.from(JSON.stringify(body)));
    }

    // Merge persisted post-processing defaults. Request fields still win, and
    // `rvc: false` forces the pipeline off for this one call — otherwise a
    // configured default speaker could never be bypassed.
    applyPipelineDefaults(body);
    // If the gate stripped a requested speaker, say so in a header rather than
    // pretending the request was honoured as sent.
    if (body._rvcBlocked) {
      console.warn(`[audio-pipeline] ${body._rvcBlocked}`);
      res.set('X-AiLab-Warning', body._rvcBlocked);
      delete body._rvcBlocked;
    }

    if (!body.input?.trim()) return res.status(400).json({ error: 'input is required' });

    const { pipelines, ttsInstances } = await buildHealthyPipelines();
    let healthyTts = ttsInstances.healthResults.filter(h => h.healthy).map(h => h.svc);
    if (healthyTts.length === 0) {
      return res.status(503).json({
        error: emptyReason('tts', { registered: ttsInstances.total, healthy: 0 }),
      });
    }

    const responseFormat = body.response_format || 'mp3';
    const mimeMap = { wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/opus', flac: 'audio/flac' };

    // Round-robin TTS instance selection
    // Per-selector rotation. One shared counter across all models interleaved
    // them against a mismatched base; keying by model keeps each model's copies
    // balancing among themselves.
    // Narrow to the backends that actually serve the requested model before
    // balancing, so rotation happens WITHIN a selector rather than across
    // unrelated models.
    const _sel = await resolveTtsSelection(healthyTts, body.model);
    if (_sel.backends.length === 0) {
      return res.status(503).json({ error: _sel.reason || `no backend serves '${body.model}'` });
    }
    healthyTts = _sel.backends;
    // Forward the BARE model. Backends are pool-unaware and reject
    // "provider/model" outright, so the composite must not survive past here.
    if (_sel.model) body.model = _sel.model;
    const ttsIdx = nextIndex(`tts:${_sel.matched || 'default'}`, healthyTts.length);
    const ttsSvc = healthyTts[ttsIdx];
    const tryOrder = [ttsSvc, ...healthyTts.filter(s => s !== ttsSvc)];

    // --- TTS-only path (no RVC): proxy directly to backend with requested format ---
    if (!body.rvc_model) {
      let lastErr;
      for (const svc of tryOrder) {
        try {
          const ttsBase = `http://${svc.containerIp}:${svc.port}`;
          const ttsPayload = {
              input: body.input.trim(),
              voice: body.voice || 'default',
              speed: body.speed || 1.0,
              response_format: responseFormat,
              model: body.model || 'chatterbox-turbo',
          };
          // Pass through generation params
          for (const k of ['temperature', 'top_k', 'top_p', 'repetition_penalty', 'exaggeration', 'cfg_weight', 'min_p']) {
            if (body[k] != null) ttsPayload[k] = body[k];
          }
          const ttsResp = await fetch(`${ttsBase}/v1/audio/speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ttsPayload),
            signal: AbortSignal.timeout(60_000),
          });
          if (!ttsResp.ok) {
            const errText = await ttsResp.text().catch(() => 'unknown');
            throw new Error(`TTS ${ttsResp.status}: ${errText.slice(0, 200)}`);
          }
          const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
          res.set('Content-Type', mimeMap[responseFormat] || 'audio/mpeg');
          return res.send(audioBuffer);
        } catch (err) {
          lastErr = err;
          console.error(`[multi-tts/v1/audio/speech] TTS ${svc.containerIp}:${svc.port} failed: ${err.message}`);
        }
      }
      return res.status(502).json({ error: `All TTS instances failed: ${lastErr?.message}` });
    }

    // --- TTS+RVC path: pipeline returns wav ---
    const params = {
      voice: body.voice || 'default',
      speed: body.speed || 1.0,
      model: body.model || 'chatterbox-turbo',
      rvc_model: body.rvc_model,
      f0_method: body.f0_method || 'rmvpe',
      f0_up_key: body.f0_up_key ?? 0,
      index_rate: body.index_rate ?? 0.75,
      filter_radius: body.filter_radius ?? 3,
      rms_mix_rate: body.rms_mix_rate ?? 0.25,
      protect: body.protect ?? 0.33,
      resample_sr: body.resample_sr ?? 48000,
      output_format: 'wav',
    };

    let lastErr;
    for (const svc of tryOrder) {
      try {
        const pipelineRvc = pipelines.find(p => p.ttsSvc === svc)?.rvcSvc
          || (pipelines.length > 0 ? pipelines[0].rvcSvc : null);
        if (!pipelineRvc) throw new Error('No healthy RVC instance for pipeline');
        const result = await processSentence(body.input.trim(), svc, pipelineRvc, params);
        const audioBuffer = Buffer.from(result.audio, 'base64');
        res.set('Content-Type', mimeMap.wav);
        res.set('X-Duration-Ms', String(result.duration_ms));
        return res.send(audioBuffer);
      } catch (err) {
        lastErr = err;
        console.error(`[multi-tts/v1/audio/speech] Pipeline ${svc.containerIp}:${svc.port} failed: ${err.message}`);
      }
    }
    res.status(502).json({ error: `All pipelines failed: ${lastErr?.message}` });
  });

  /**
   * If the user-supplied endpoint URL points at a non-LAN hostname
   * (e.g. a Cloudflare tunnel domain), translate it to the matching
   * LAN service's `http://<containerIp>:<port>` URL when we have one
   * registered. Avoids round-tripping through Cloudflare (502s, idle
   * timeouts, mixed-content quirks) for backend-to-backend calls
   * inside the cluster — the cluster knows its own services.
   *
   * Returns the original URL unchanged when:
   *   • The hostname is already a LAN IP / localhost / 0.0.0.0
   *   • No service of the given providerId is registered
   *   • The URL is malformed
   *
   * NOTE: This is intentionally conservative — we only translate when
   * the URL is clearly a non-LAN host AND we have a matching service.
   * If the user pastes a totally unrelated external URL, we leave it
   * alone so they can intentionally hit external services.
   */
  function preferLanEndpoint(userUrl, providerId) {
    if (!userUrl) return userUrl;
    let parsed;
    try {
      parsed = new URL(userUrl);
    } catch {
      return userUrl;
    }
    const host = parsed.hostname;
    // RFC 1918 + loopback + link-local — these are already LAN-direct,
    // no translation needed.
    if (
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
      /^127\./.test(host) ||
      host === 'localhost' ||
      host === '0.0.0.0'
    ) {
      return userUrl;
    }
    try {
      const state = loadActiveServices();
      const svc = Object.values(state.services || {}).find(
        (s) => s?.providerId === providerId && s?.containerIp && s?.port,
      );
      if (svc) return `http://${svc.containerIp}:${svc.port}`;
    } catch {}
    return userUrl;
  }

  /**
   * Discover where chatterbox stores its voice library on a given
   * host by parsing the running server.py command line for the
   * `--voices` argument. Cached for VOICE_ROOT_TTL_MS so the SSH
   * round-trip happens at most once every few minutes per host.
   * Falls back to /root/voices (chatterbox's own default) if no
   * `--voices` flag is found in the running process.
   */
  const _voiceRootCache = new Map(); // host -> { path, ts }
  const VOICE_ROOT_TTL_MS = 5 * 60 * 1000;
  async function getChatterboxVoiceRoot(host, ssh) {
    const cached = _voiceRootCache.get(host);
    if (cached && (Date.now() - cached.ts) < VOICE_ROOT_TTL_MS) return cached.path;
    const cmd = "ps -eo args 2>/dev/null | grep -E 'proxlab-tts/server\\.py' | grep -v grep | head -1";
    const { stdout } = await ssh.exec(host, cmd, { timeout: 5000 });
    const match = (stdout || '').match(/--voices\s+(\S+)/);
    const path = match ? match[1].trim() : '/root/voices';
    _voiceRootCache.set(host, { path, ts: Date.now() });
    return path;
  }

  /**
   * POST /multi-tts/v1/audio/cloned-speech
   *
   * Synthesize speech using a chatterbox-style saved voice
   * (`<voice_root>/<name>/{ref.wav,ref.txt}` where voice_root is
   * whatever path chatterbox was launched with via --voices) as the
   * reference clip, driven through Qwen3-TTS's /v1/audio/voice-clone
   * endpoint.
   *
   * Request body:
   *   voice_name      — name of a folder under /root/voices on the
   *                     chatterbox container (the canonical voice library).
   *   input           — text to synthesize.
   *   target_endpoint — Qwen-TTS base URL (no trailing /v1). Inferred
   *                     from the active services registry if omitted.
   *   response_format — wav|mp3|opus|flac|pcm (default wav).
   *   speed           — 0.5..2.0 multiplier (default 1.0).
   *
   * Mode auto-pick:
   *   • If ref.txt exists with non-empty content → ICL mode (highest
   *     quality; transcript guides cloning).
   *   • Else → x_vector_only_mode (no transcript needed).
   *
   * Voice file lookup:
   *   • Read via SSH from the host running the active proxlab-tts
   *     (chatterbox) service. Voices live at /root/voices/<name>/ on
   *     that container — same path chatterbox itself reads.
   */
  router.post('/multi-tts/v1/audio/cloned-speech', async (req, res) => {
    // Parse JSON body manually — this router is mounted before
    // express.json() so req.body is undefined on routes that don't
    // do their own buffering.
    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    const voiceName = String(body.voice_name || '').trim();
    const input = String(body.input || '').trim();
    const responseFormat = String(body.response_format || 'wav');
    const speed = Number.isFinite(body.speed) ? Number(body.speed) : 1.0;
    let targetEndpoint = String(body.target_endpoint || '').replace(/\/+$/, '').replace(/\/v1(\/.*)?$/, '');

    if (!voiceName) return res.status(400).json({ error: 'voice_name is required' });
    if (!input) return res.status(400).json({ error: 'input is required' });
    // Defense in depth — voice_name maps to a directory name on the file
    // system, so allow only safe characters. Anything fancy is a bug or
    // an attempt at command injection through the SSH exec below.
    if (!/^[A-Za-z0-9][A-Za-z0-9 _\-.]{0,127}$/.test(voiceName)) {
      return res.status(400).json({ error: 'voice_name contains invalid characters' });
    }

    // Find the chatterbox host that owns the voice library. We read from
    // the first registered chatterbox service by convention — there's
    // typically one canonical voice library per cluster.
    const chatterbox = findAllTtsPoolServices()[0];
    if (!chatterbox?.containerIp) {
      return res.status(503).json({ error: 'No proxlab-tts (chatterbox) service registered — cannot resolve voice library' });
    }

    // Translate Cloudflare / external URLs to the matching LAN service
    // when proxlab knows about it. Avoids needless round-trips through
    // Cloudflare for backend-to-backend cluster calls.
    targetEndpoint = preferLanEndpoint(targetEndpoint, 'qwen-tts');

    // Find a target Qwen-TTS endpoint if the caller didn't supply one
    // and the LAN translation didn't yield anything.
    if (!targetEndpoint) {
      try {
        const state = loadActiveServices();
        const qwen = Object.values(state.services || {}).find((s) => s?.providerId === 'qwen-tts' && s?.containerIp && s?.port);
        if (qwen) targetEndpoint = `http://${qwen.containerIp}:${qwen.port}`;
      } catch {}
    }
    if (!targetEndpoint) {
      return res.status(503).json({ error: 'No Qwen-TTS endpoint available — pass target_endpoint or launch a qwen-tts service' });
    }

    if (!sshService) {
      return res.status(503).json({ error: 'cloned-speech route requires sshService — server.js needs to pass it into createProxyRouter()' });
    }

    // Discover where chatterbox is reading voices from by inspecting
    // the running process — `--voices` could be /root/voices, or
    // /tts/voices/f5-tts (shared CIFS mount), or whatever the user
    // configured. Cached per-host for 5 min so we don't re-ssh on
    // every synth call. Falls back to /root/voices if the process
    // has no --voices flag (chatterbox's own default).
    let voiceRoot;
    try {
      voiceRoot = await getChatterboxVoiceRoot(chatterbox.containerIp, sshService);
    } catch (err) {
      return res.status(502).json({ error: `Failed to discover voice library path on ${chatterbox.containerIp}: ${err.message}` });
    }

    // Read ref.wav (binary → base64 on remote so stdout is text-safe)
    // and ref.txt (optional). Voice path quoted with single quotes —
    // safe since the regex above forbids any single quote.
    const voiceDir = `'${voiceRoot}/${voiceName}'`;
    const wavCmd = `base64 -w0 ${voiceDir}/ref.wav 2>/dev/null`;
    const txtCmd = `cat ${voiceDir}/ref.txt 2>/dev/null || true`;

    let refAudioB64 = '';
    let refText = '';
    try {
      const wavRes = await sshService.exec(chatterbox.containerIp, wavCmd, { timeout: 15000 });
      if (wavRes.code !== 0 || !wavRes.stdout?.trim()) {
        return res.status(404).json({ error: `Voice "${voiceName}" not found on chatterbox host (${chatterbox.containerIp}) — expected ${voiceRoot}/${voiceName}/ref.wav` });
      }
      refAudioB64 = wavRes.stdout.trim();
      const txtRes = await sshService.exec(chatterbox.containerIp, txtCmd, { timeout: 5000 });
      refText = (txtRes.stdout || '').trim();
    } catch (err) {
      return res.status(502).json({ error: `Failed to read voice file from chatterbox host: ${err.message}` });
    }

    const useIcl = refText.length > 0;
    const cloneBody = {
      input,
      ref_audio: refAudioB64,
      response_format: responseFormat,
      speed,
      // x_vector_only_mode=true skips the transcript requirement; we use
      // it as the fallback when no ref.txt is present.
      x_vector_only_mode: !useIcl,
    };
    if (useIcl) cloneBody.ref_text = refText;
    if (Number.isFinite(body.temperature)) cloneBody.temperature = Number(body.temperature);
    if (Number.isFinite(body.top_p)) cloneBody.top_p = Number(body.top_p);
    if (typeof body.language === 'string' && body.language && body.language !== 'Auto') {
      cloneBody.language = body.language;
    }

    // Chunked synthesis. The voice-clone endpoint returns a single
    // buffered WAV per call, so a 1700-char input on the slow official
    // backend can run >100s and trip Cloudflare's 524 timeout. Split
    // text at sentence boundaries (8-word minimum to avoid hallucination
    // on too-short fragments), synthesize each chunk sequentially, and
    // stream the PCM bytes through a single streaming-WAV response so
    // the browser starts playing within seconds and stays within the
    // Cloudflare time-to-first-byte budget regardless of total length.
    const inputChunks = splitSentences(input, 8);
    if (inputChunks.length === 0) {
      return res.status(400).json({ error: 'No synthesizable content after sentence parsing' });
    }

    /** Lay out a streaming WAV header. We populate the file-size and
     *  data-chunk-size fields with 0xFFFFFFFF placeholders since we
     *  don't know the totals — browsers play streaming WAVs that have
     *  these placeholders as long as bytes keep arriving. */
    function makeStreamingWavHeader(sampleRate, channels, bitsPerSample) {
      const byteRate = (sampleRate * channels * bitsPerSample) / 8;
      const blockAlign = (channels * bitsPerSample) / 8;
      const buf = Buffer.alloc(44);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(0xFFFFFFFF, 4);    // file size — unknown
      buf.write('WAVE', 8);
      buf.write('fmt ', 12);
      buf.writeUInt32LE(16, 16);            // fmt chunk size
      buf.writeUInt16LE(1, 20);             // PCM
      buf.writeUInt16LE(channels, 22);
      buf.writeUInt32LE(sampleRate, 24);
      buf.writeUInt32LE(byteRate, 28);
      buf.writeUInt16LE(blockAlign, 32);
      buf.writeUInt16LE(bitsPerSample, 34);
      buf.write('data', 36);
      buf.writeUInt32LE(0xFFFFFFFF, 40);    // data size — unknown
      return buf;
    }

    /** Find the 'data' marker in a WAV file and return the byte
     *  offset where PCM samples begin. Defensive against extra
     *  metadata chunks (LIST, JUNK, etc) that some encoders insert
     *  between fmt and data. Returns 44 (the canonical no-extras
     *  offset) as a fallback. */
    function findWavDataOffset(buf) {
      // Limit search to a reasonable header region.
      const limit = Math.min(buf.length - 8, 4096);
      for (let i = 12; i < limit; i++) {
        if (
          buf[i] === 0x64 && buf[i + 1] === 0x61 &&
          buf[i + 2] === 0x74 && buf[i + 3] === 0x61
        ) {
          return i + 8; // skip 'data' (4) + size field (4)
        }
      }
      return 44;
    }

    /** Read sample rate from a WAV header. */
    function readWavSampleRate(buf) {
      try {
        return buf.readUInt32LE(24);
      } catch {
        return 24000;
      }
    }

    let headerSent = false;
    let chunksSucceeded = 0;
    let totalPcmBytes = 0;
    const synthStart = Date.now();

    for (let i = 0; i < inputChunks.length; i++) {
      const chunkText = inputChunks[i];
      const chunkBody = {
        input: chunkText,
        ref_audio: refAudioB64,
        response_format: 'wav',
        speed,
        x_vector_only_mode: !useIcl,
      };
      if (useIcl) chunkBody.ref_text = refText;
      if (Number.isFinite(body.temperature)) chunkBody.temperature = Number(body.temperature);
      if (Number.isFinite(body.top_p)) chunkBody.top_p = Number(body.top_p);
      if (typeof body.language === 'string' && body.language && body.language !== 'Auto') {
        chunkBody.language = body.language;
      }

      let chunkBuf;
      try {
        const cloneRes = await fetch(`${targetEndpoint}/v1/audio/voice-clone`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(chunkBody),
        });
        if (!cloneRes.ok) {
          const errText = await cloneRes.text().catch(() => '');
          if (!headerSent) {
            return res.status(cloneRes.status).json({ error: `Qwen voice-clone failed on chunk 1: ${errText.slice(0, 500)}` });
          }
          // Mid-stream failure — we've already sent some PCM. Best we
          // can do is stop and let the player wrap up the partial stream.
          console.warn(`[cloned-speech] chunk ${i + 1}/${inputChunks.length} failed: ${errText.slice(0, 200)}`);
          break;
        }
        chunkBuf = Buffer.from(await cloneRes.arrayBuffer());
      } catch (err) {
        if (!headerSent) {
          return res.status(502).json({ error: `Voice-clone request failed on chunk 1: ${err.message}` });
        }
        console.warn(`[cloned-speech] chunk ${i + 1}/${inputChunks.length} threw: ${err.message}`);
        break;
      }

      const dataOffset = findWavDataOffset(chunkBuf);
      const pcm = chunkBuf.slice(dataOffset);

      if (!headerSent) {
        // Use the first chunk's actual sample rate to seed the
        // streaming header — different Qwen3-TTS variants may run
        // at different rates (12Hz model defaults to 24kHz mono
        // int16, but check the bytes rather than assume).
        const sampleRate = readWavSampleRate(chunkBuf);
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('X-Voice-Clone-Mode', useIcl ? 'icl' : 'x_vector');
        res.setHeader('X-Chunks-Total', String(inputChunks.length));
        res.write(makeStreamingWavHeader(sampleRate, 1, 16));
        headerSent = true;
      }
      res.write(pcm);
      chunksSucceeded += 1;
      totalPcmBytes += pcm.length;
    }

    const elapsedMs = Date.now() - synthStart;
    if (!headerSent) {
      // No chunks succeeded and we never sent headers — already returned above.
      return;
    }
    console.log(`[cloned-speech] ${chunksSucceeded}/${inputChunks.length} chunks · ${totalPcmBytes} pcm bytes · ${elapsedMs}ms total`);
    res.end();
  });

  // GET /multi-tts/v1/models — Aggregated models from all TTS instances
  /**
   * Union of every model served by the pool, as composite `provider/model` IDs.
   *
   * The previous version asked only the FIRST healthy instance and fell back to a
   * literal chatterbox list — so a pool serving anything else still advertised
   * chatterbox, and an EMPTY pool advertised models that did not exist at all.
   * Both are gone: what you see is what is actually running.
   */
  router.get('/multi-tts/v1/models', async (req, res) => {
    const allTts = findAllTtsPoolServices();
    const healthy = (await audioHealth.withHealth(allTts)).filter((h) => h.healthy).map((h) => h.svc);

    const { models, errors } = await getModelCatalog(healthy, fetchJsonForCatalog);
    for (const e of errors) console.warn(`[tts/models] ${e}`);

    res.json({
      object: 'list',
      data: models.map((m) => ({
        id: m.compositeId,
        object: 'model',
        owned_by: m.ownedBy || m.providerId,
        provider: m.providerId,
        model: m.model,
        instances: m.backends.length,
      })),
      // Bare model IDs remain valid selectors; surfaced so a caller can see both
      // spellings without having to split the composite themselves.
      aliases: [...new Set(models.map((m) => m.model))],
      ...(errors.length ? { errors } : {}),
    });
  });

  // GET /multi-tts/v1/voices — Voice list (proxied from first healthy TTS)
  router.get('/multi-tts/v1/voices', async (req, res) => {
    const { ttsInstances } = await buildHealthyPipelines();
    let healthyTts = ttsInstances.healthResults.filter(h => h.healthy).map(h => h.svc);
    if (healthyTts.length === 0) {
      return res.status(503).json({ error: 'No healthy TTS instances' });
    }
    try {
      const svc = healthyTts[0];
      const resp = await fetch(`http://${svc.containerIp}:${svc.port}/v1/voices`, {
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json();
      return res.json(data);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ─── Voice Presets (saved voice configurations) ────────────────────────────

  function loadVoicePresets() {
    try {
      if (existsSync(voicePresetsFile)) return JSON.parse(readFileSync(voicePresetsFile, 'utf-8'));
    } catch {}
    return {};
  }

  function saveVoicePresets(presets) {
    writeFileSync(voicePresetsFile, JSON.stringify(presets, null, 2));
  }

  // GET /multi-tts/voice-presets — List all saved voice presets
  router.get('/multi-tts/voice-presets', (req, res) => {
    res.json(loadVoicePresets());
  });

  // GET /multi-tts/voice-presets/:name — Get a single preset by name
  router.get('/multi-tts/voice-presets/:name', (req, res) => {
    const presets = loadVoicePresets();
    const preset = presets[req.params.name];
    if (!preset) return res.status(404).json({ error: 'Preset not found' });
    res.json(preset);
  });

  // POST /multi-tts/voice-presets — Save a voice preset
  // Body: { name, voice, model, speed, temperature, top_k, top_p, repetition_penalty, exaggeration, cfg_weight, min_p, rvc_model?, rvc_params? }
  router.post('/multi-tts/voice-presets', async (req, res) => {
    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    if (!body.name || typeof body.name !== 'string') {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!body.voice) {
      return res.status(400).json({ error: 'voice is required' });
    }

    // Presets store voice CHARACTER (clip + chatterbox params + optional RVC).
    // Output FORMAT (mp3/wav/opus/flac) is the client's runtime concern, not a
    // voice characteristic — it's determined by what the caller requests in the
    // OpenAI body.response_format. response_format is intentionally NOT stored.
    const preset = {
      voice: body.voice,
      model: body.model || 'chatterbox-turbo',
      speed: body.speed ?? 1.0,
      temperature: body.temperature,
      top_k: body.top_k,
      top_p: body.top_p,
      repetition_penalty: body.repetition_penalty,
      exaggeration: body.exaggeration,
      cfg_weight: body.cfg_weight,
      min_p: body.min_p,
    };
    // Optional RVC settings
    if (body.rvc_model) {
      preset.rvc_model = body.rvc_model;
      preset.rvc_params = {
        f0_method: body.rvc_params?.f0_method || 'rmvpe',
        f0_up_key: body.rvc_params?.f0_up_key ?? 0,
        index_rate: body.rvc_params?.index_rate ?? 0.75,
        rms_mix_rate: body.rvc_params?.rms_mix_rate ?? 0.25,
        protect: body.rvc_params?.protect ?? 0.33,
      };
    }
    // Strip undefined values
    for (const k of Object.keys(preset)) {
      if (preset[k] === undefined) delete preset[k];
    }

    const presets = loadVoicePresets();
    presets[body.name] = { ...preset, updatedAt: Date.now() };
    saveVoicePresets(presets);
    res.json({ ok: true, name: body.name, preset: presets[body.name] });
  });

  // DELETE /multi-tts/voice-presets/:name — Delete a voice preset
  router.delete('/multi-tts/voice-presets/:name', (req, res) => {
    const presets = loadVoicePresets();
    if (!presets[req.params.name]) return res.status(404).json({ error: 'Preset not found' });
    delete presets[req.params.name];
    saveVoicePresets(presets);
    res.json({ ok: true });
  });
  // ─── preset-tts listing endpoints ────────────────────────────────────────
  // Discovery for OpenAI-compat clients pointed at /preset-tts/v1 (Marinara, OpenClaw):
  // without these their voice/model dropdowns cannot populate.
  //
  // /voices lists PRESET NAMES, deliberately NOT the 44 raw voice clips that
  // /multi-tts/voices returns. The speech endpoint below resolves body.voice against the
  // PRESET table and silently falls back to Shadowheart on a miss — so a dropdown full of
  // raw clip names would leave every single selection producing Shadowheart while the UI
  // claimed otherwise. Listing presets makes the dropdown's values actually selectable.
  router.get(['/preset-tts/v1/voices', '/preset-tts/v1/audio/voices'], (req, res) => {
    try {
      const presets = loadVoicePresets();
      // Same envelope as /multi-tts/voices so clients need no special-casing; `voice` and
      // `model` are echoed so a UI can show what a preset actually resolves to.
      const voices = Object.entries(presets).map(([name, p]) => ({
        id: name,
        voice: p?.voice ?? null,
        model: p?.model ?? null,
      }));
      res.json({ voices });
    } catch (err) {
      // Never answer an empty list on failure: "no presets exist" and "the preset store
      // could not be read" must not look identical to a populating dropdown.
      console.error(`[preset-tts] could not list presets: ${err.message}`);
      res.status(500).json({ error: `could not read the voice preset store: ${err.message}` });
    }
  });

  // /models mirrors /multi-tts/v1/models so a model field can populate. NOTE the preset
  // WINS: the speech handler builds its payload as { ...preset, input }, so a preset's own
  // model overrides whatever the client sends. This list exists for discovery, not control.
  router.get('/preset-tts/v1/models', async (req, res) => {
    try {
      const { ttsInstances } = await buildHealthyPipelines();
      const healthy = ttsInstances.healthResults.filter(h => h.healthy).map(h => h.svc);
      if (healthy.length === 0) {
        return res.status(503).json({ error: emptyReason('tts', { registered: ttsInstances.healthResults.length, healthy: 0 }) });
      }
      const seen = new Map();
      for (const svc of healthy) {
        const provider = svc.providerId;
        const model = svc.model || svc.modelVariant || 'chatterbox-turbo';
        const id = `${provider}/${model}`;
        if (!seen.has(id)) seen.set(id, { id, object: 'model', owned_by: provider, provider, model, instances: 0 });
        seen.get(id).instances += 1;
      }
      res.json({ object: 'list', data: [...seen.values()] });
    } catch (err) {
      console.error(`[preset-tts] could not list models: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // GET/POST /preset-tts/v1/audio/speech — OpenAI-compatible TTS endpoint that
  // routes by VOICE PRESET NAME (looked up from body.voice). Intended for any
  // OpenAI-compat TTS client whose UI only exposes a voice/model field but no
  // chatterbox-specific knobs (e.g. OpenClaw). Caller sets `voice` to the name
  // of a preset saved via /multi-tts/voice-presets, and the endpoint applies the
  // full preset (voice clip + chatterbox params + optional RVC pipeline). Falls
  // back to the "Shadowheart" preset if the requested name isn't found.
  router.post('/preset-tts/v1/audio/speech', async (req, res) => {
    const presets = loadVoicePresets();

    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      body = {};
    }

    // Resolve preset by name from the request's voice field, with Shadowheart
    // as the fallback. The X-Voice-Preset response header advertises which
    // preset actually got used — useful for debugging unexpected voice output.
    const requestedName = (body.voice || '').trim();
    const matchedName = (requestedName && presets[requestedName]) ? requestedName : null;
    const preset = matchedName ? presets[matchedName] : presets['Shadowheart'];
    const resolvedName = matchedName || 'Shadowheart';
    if (!preset) return res.status(503).json({ error: `No voice preset matched "${requestedName}" and Shadowheart fallback missing` });

    // Build payload from preset, only take input text from the request.
    // Strip any response_format that might be in legacy presets — output
    // format is purely the client's choice (see preset-save endpoint for why).
    const merged = { ...preset, input: body.input || '' };
    delete merged.response_format;
    const responseFormat = body.response_format || 'mp3';

    const { pipelines, ttsInstances } = await buildHealthyPipelines();
    let healthyTts = ttsInstances.healthResults.filter(h => h.healthy).map(h => h.svc);
    if (healthyTts.length === 0) return res.status(503).json({ error: 'No healthy TTS instances available' });

    const mimeMap = { wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/opus', flac: 'audio/flac' };
    // Per-selector rotation. One shared counter across all models interleaved
    // them against a mismatched base; keying by model keeps each model's copies
    // balancing among themselves.
    // Narrow to the backends that actually serve the requested model before
    // balancing, so rotation happens WITHIN a selector rather than across
    // unrelated models.
    const _sel = await resolveTtsSelection(healthyTts, body.model);
    if (_sel.backends.length === 0) {
      return res.status(503).json({ error: _sel.reason || `no backend serves '${body.model}'` });
    }
    healthyTts = _sel.backends;
    // Forward the BARE model. Backends are pool-unaware and reject
    // "provider/model" outright, so the composite must not survive past here.
    if (_sel.model) body.model = _sel.model;
    const ttsIdx = nextIndex(`tts:${_sel.matched || 'default'}`, healthyTts.length);
    const ttsSvc = healthyTts[ttsIdx];
    const tryOrder = [ttsSvc, ...healthyTts.filter(s => s !== ttsSvc)];

    let lastErr;
    for (const svc of tryOrder) {
      try {
        const ttsBase = `http://${svc.containerIp}:${svc.port}`;
        const ttsPayload = {
          input: merged.input.trim(),
          voice: merged.voice || 'default',
          speed: merged.speed || 1.0,
          response_format: responseFormat,
          model: merged.model || 'chatterbox',
        };
        for (const k of ['temperature', 'top_k', 'top_p', 'repetition_penalty', 'exaggeration', 'cfg_weight', 'min_p']) {
          if (merged[k] != null) ttsPayload[k] = merged[k];
        }

        // If preset has RVC, route through a TTS+RVC pipeline using the
        // standard processSentence helper. pipelines is an array of healthy
        // {ttsSvc, rvcSvc} pairs (already filtered by buildHealthyPipelines).
        if (merged.rvc_model && pipelines.length > 0) {
          const pipeline = pipelines[0];
          const pipelineParams = {
            voice: merged.voice || 'default',
            speed: merged.speed || 1.0,
            model: merged.model || 'chatterbox',
            rvc_model: merged.rvc_model,
            ...(merged.rvc_params || {}),
          };
          for (const k of ['temperature', 'top_k', 'top_p', 'repetition_penalty', 'exaggeration', 'cfg_weight', 'min_p']) {
            if (merged[k] != null) pipelineParams[k] = merged[k];
          }
          try {
            const result = await processSentence(merged.input.trim(), pipeline.ttsSvc, pipeline.rvcSvc, pipelineParams);
            let audioBuffer = Buffer.from(result.audio, 'base64');
            // processSentence's RVC pipeline always returns WAV. Transcode to
            // the client's requested format if it asked for something else.
            // Browsers can play WAV fine, but OpenClaw embeds attachments with
            // the requested Content-Type — mismatched container vs codec breaks
            // playback. Honoring the client's format keeps everything aligned.
            if (responseFormat !== 'wav') {
              audioBuffer = await transcodeAudio(audioBuffer, responseFormat);
            }
            res.set('Content-Type', mimeMap[responseFormat] || 'audio/mpeg');
            res.set('X-Voice-Preset', resolvedName);
            return res.send(audioBuffer);
          } catch (pipeErr) {
            console.error(`[preset-tts] pipeline failed for "${resolvedName}", falling back to TTS-only: ${pipeErr.message}`);
            // Fall through to the TTS-only path below
          }
        }

        const ttsResp = await fetch(`${ttsBase}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ttsPayload),
          signal: AbortSignal.timeout(60_000),
        });
        if (!ttsResp.ok) {
          const errText = await ttsResp.text().catch(() => 'unknown');
          throw new Error(`TTS ${ttsResp.status}: ${errText.slice(0, 200)}`);
        }
        const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
        res.set('Content-Type', mimeMap[responseFormat] || 'audio/mpeg');
        res.set('X-Voice-Preset', resolvedName);
        return res.send(audioBuffer);
      } catch (err) {
        lastErr = err;
        console.error(`[preset-tts] TTS ${svc.containerIp}:${svc.port} failed: ${err.message}`);
      }
    }
    res.status(502).json({ error: `All TTS instances failed: ${lastErr?.message}` });
  });


  // POST /multi-tts/v1/audio/speech-preset/:name — Generate speech using a saved preset
  // Body: { input: "text", ...overrides }
  router.post('/multi-tts/v1/audio/speech-preset/:name', async (req, res) => {
    const presets = loadVoicePresets();
    const preset = presets[req.params.name];
    if (!preset) return res.status(404).json({ error: `Voice preset "${req.params.name}" not found` });

    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      body = {};
    }

    // Merge preset defaults with any overrides from request body
    const merged = { ...preset, ...body, voice: body.voice || preset.voice, model: body.model || preset.model };
    // If preset has RVC, merge those too
    if (preset.rvc_model && !body.rvc_model) {
      merged.rvc_model = preset.rvc_model;
      if (preset.rvc_params) Object.assign(merged, preset.rvc_params);
    }

    // Forward to the main speech endpoint internally
    const { pipelines, ttsInstances } = await buildHealthyPipelines();
    let healthyTts = ttsInstances.healthResults.filter(h => h.healthy).map(h => h.svc);
    if (healthyTts.length === 0) {
      return res.status(503).json({ error: 'No healthy TTS instances available' });
    }

    const responseFormat = merged.response_format || 'mp3';
    const mimeMap = { wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/opus', flac: 'audio/flac' };

    // Per-selector rotation. One shared counter across all models interleaved
    // them against a mismatched base; keying by model keeps each model's copies
    // balancing among themselves.
    // Narrow to the backends that actually serve the requested model before
    // balancing, so rotation happens WITHIN a selector rather than across
    // unrelated models.
    const _sel = await resolveTtsSelection(healthyTts, body.model);
    if (_sel.backends.length === 0) {
      return res.status(503).json({ error: _sel.reason || `no backend serves '${body.model}'` });
    }
    healthyTts = _sel.backends;
    // Forward the BARE model. Backends are pool-unaware and reject
    // "provider/model" outright, so the composite must not survive past here.
    if (_sel.model) body.model = _sel.model;
    const ttsIdx = nextIndex(`tts:${_sel.matched || 'default'}`, healthyTts.length);
    const ttsSvc = healthyTts[ttsIdx];
    const tryOrder = [ttsSvc, ...healthyTts.filter(s => s !== ttsSvc)];

    if (!merged.rvc_model) {
      let lastErr;
      for (const svc of tryOrder) {
        try {
          const ttsBase = `http://${svc.containerIp}:${svc.port}`;
          const ttsPayload = {
            input: (merged.input || '').trim(),
            voice: merged.voice || 'default',
            speed: merged.speed || 1.0,
            response_format: responseFormat,
            model: merged.model || 'chatterbox-turbo',
          };
          for (const k of ['temperature', 'top_k', 'top_p', 'repetition_penalty', 'exaggeration', 'cfg_weight', 'min_p']) {
            if (merged[k] != null) ttsPayload[k] = merged[k];
          }
          const ttsResp = await fetch(`${ttsBase}/v1/audio/speech`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ttsPayload),
            signal: AbortSignal.timeout(60_000),
          });
          if (!ttsResp.ok) {
            const errText = await ttsResp.text().catch(() => 'unknown');
            throw new Error(`TTS ${ttsResp.status}: ${errText.slice(0, 200)}`);
          }
          const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
          res.set('Content-Type', mimeMap[responseFormat] || 'audio/mpeg');
          res.set('X-Voice-Preset', req.params.name);
          return res.send(audioBuffer);
        } catch (err) {
          lastErr = err;
        }
      }
      return res.status(502).json({ error: `All TTS instances failed: ${lastErr?.message}` });
    }

    // TTS+RVC path
    let lastErr;
    for (const svc of tryOrder) {
      try {
        const pipelineRvc = pipelines.find(p => p.ttsSvc === svc)?.rvcSvc
          || (pipelines.length > 0 ? pipelines[0].rvcSvc : null);
        if (!pipelineRvc) throw new Error('No healthy RVC instance for pipeline');
        const result = await processSentence((merged.input || '').trim(), svc, pipelineRvc, {
          voice: merged.voice || 'default',
          speed: merged.speed || 1.0,
          model: merged.model || 'chatterbox-turbo',
          rvc_model: merged.rvc_model,
          f0_method: merged.f0_method || 'rmvpe',
          f0_up_key: merged.f0_up_key ?? 0,
          index_rate: merged.index_rate ?? 0.75,
          filter_radius: merged.filter_radius ?? 3,
          rms_mix_rate: merged.rms_mix_rate ?? 0.25,
          protect: merged.protect ?? 0.33,
          output_format: 'wav',
        });
        const audioBuffer = Buffer.from(result.audio, 'base64');
        res.set('Content-Type', mimeMap.wav);
        res.set('X-Voice-Preset', req.params.name);
        res.set('X-Duration-Ms', String(result.duration_ms));
        return res.send(audioBuffer);
      } catch (err) {
        lastErr = err;
      }
    }
    res.status(502).json({ error: `All pipelines failed: ${lastErr?.message}` });
  });

  // POST /multi-tts/stream — SSE streaming with N-way pipeline parallelism
  router.post('/multi-tts/stream', async (req, res) => {
    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // Resolve sentences
    let sentences;
    if (Array.isArray(body.sentences) && body.sentences.length > 0) {
      sentences = body.sentences.map(s => s.trim()).filter(Boolean);
    } else if (typeof body.input === 'string' && body.input.trim()) {
      sentences = splitSentences(body.input);
    } else {
      return res.status(400).json({ error: 'Provide "sentences" array or "input" text' });
    }
    if (sentences.length === 0) {
      return res.status(400).json({ error: 'No sentences to process' });
    }
    const useRvc = !!body.rvc_model;

    // Build healthy pipelines
    const { pipelines, pipelineCount, ttsInstances, rvcInstances } = await buildHealthyPipelines();

    // TTS-only mode: just need healthy TTS instances
    const effectivePipelines = useRvc ? pipelines : ttsInstances.healthResults.filter(h => h.healthy).map(h => ({ ttsSvc: h.svc, rvcSvc: null }));
    const effectiveCount = effectivePipelines.length;
    if (effectiveCount === 0) {
      return res.status(503).json({ error: useRvc ? 'No healthy TTS+RVC pipelines available' : 'No healthy TTS instances available' });
    }

    const params = {
      voice: body.voice || 'default',
      speed: body.speed || 1.0,
      model: body.model || 'chatterbox-turbo',
      rvc_model: body.rvc_model,
      f0_method: body.f0_method || 'rmvpe',
      f0_up_key: body.f0_up_key ?? 0,
      index_rate: body.index_rate ?? 0.75,
      filter_radius: body.filter_radius ?? 3,
      rms_mix_rate: body.rms_mix_rate ?? 0.25,
      protect: body.protect ?? 0.33,
      resample_sr: body.resample_sr ?? 48000,
      output_format: body.output_format || 'wav',
    };
    // Pass through model-specific TTS generation params
    for (const k of ['temperature', 'top_k', 'top_p', 'repetition_penalty', 'exaggeration', 'cfg_weight', 'min_p']) {
      if (body[k] != null) params[k] = body[k];
    }

    // SSE setup
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const t0 = Date.now();
    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    function sendEvent(eventName, data) {
      if (clientDisconnected) return;
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    sendEvent('info', {
      sentences: sentences.length,
      pipelines: effectiveCount,
      tts_instances: ttsInstances.healthy,
      rvc_instances: useRvc ? rvcInstances.healthy : 0,
      params,
    });

    // Results buffer — stores completed results by index
    const results = new Array(sentences.length);
    let nextToSend = 0;

    function flushResults() {
      while (nextToSend < sentences.length && results[nextToSend] !== undefined) {
        const r = results[nextToSend];
        if (r.error) {
          sendEvent('error', { index: nextToSend, text: sentences[nextToSend], error: r.error });
        } else {
          sendEvent('audio', {
            index: nextToSend,
            text: sentences[nextToSend],
            audio: r.audio,
            duration_ms: r.duration_ms,
            tts_time_ms: r.tts_time_ms,
            rvc_time_ms: r.rvc_time_ms,
            total_time_ms: r.total_time_ms,
            audio_bytes: r.audio_bytes,
            tts_host: r.tts_host,
            rvc_host: r.rvc_host,
          });
        }
        nextToSend++;
      }
    }

    // Dispatch sentences round-robin to pipeline queues
    const pipelineQueues = Array.from({ length: effectiveCount }, () => []);
    sentences.forEach((_, idx) => {
      pipelineQueues[idx % effectiveCount].push(idx);
    });

    const pipelinePromises = pipelineQueues.map(async (queue, pipelineIdx) => {
      const pipeline = effectivePipelines[pipelineIdx];
      for (const sentenceIdx of queue) {
        if (clientDisconnected) return;
        try {
          const result = await processSentence(
            sentences[sentenceIdx], pipeline.ttsSvc, pipeline.rvcSvc, params
          );
          results[sentenceIdx] = result;
        } catch (err) {
          console.error(`[multi-tts/stream] Pipeline ${pipelineIdx} sentence ${sentenceIdx} error: ${err.message}`);
          // Fallback: try ALL other pipelines
          let recovered = false;
          for (let fb = 1; fb < effectiveCount; fb++) {
            const fbIdx = (pipelineIdx + fb) % effectiveCount;
            try {
              results[sentenceIdx] = await processSentence(
                sentences[sentenceIdx], effectivePipelines[fbIdx].ttsSvc, effectivePipelines[fbIdx].rvcSvc, params
              );
              recovered = true;
              break;
            } catch {}
          }
          if (!recovered) {
            results[sentenceIdx] = { error: err.message };
          }
        }
        flushResults();
      }
    });

    await Promise.all(pipelinePromises);
    flushResults();

    sendEvent('done', {
      sentences: sentences.length,
      pipelines: effectiveCount,
      elapsed_ms: Date.now() - t0,
    });

    res.end();
  });

  // ─── /tts/stream [DEPRECATED] → Use /multi-tts/stream ───────────────────
  router.post('/tts/stream', (req, res) => {
    res.status(301).json({
      error: 'Deprecated. Use /multi-tts/stream instead.',
      redirect: '/api/proxy/multi-tts/stream',
    });
  });

  // ─── TTS Discovery Routes ──────────────────────────────────────────────────

  router.get('/tts/v1/providers', async (req, res) => {
    const ttsServices = findServicesByType('tts').filter(s => s.providerId !== 'proxlab-rvc');
    const now = Date.now();
    const needsRefresh = (now - _healthCache.updatedAt) > HEALTH_CACHE_TTL;

    const providers = await Promise.all(ttsServices.map(async (svc) => {
      const key = `${svc.containerIp}:${svc.port}`;
      let healthy;
      if (needsRefresh || _healthCache.tts[key] === undefined) {
        healthy = await checkProviderHealth(svc.containerIp, svc.port);
        _healthCache.tts[key] = healthy;
      } else {
        healthy = _healthCache.tts[key];
      }
      const caps = TTS_PROVIDER_CAPS[svc.providerId] || { openai: false, voices: null, models: null, formats: ['wav'] };
      return buildProviderInfo(svc, caps, healthy);
    }));

    if (needsRefresh) _healthCache.updatedAt = now;
    const healthyCount = providers.filter(p => p.status === 'healthy').length;

    res.json({
      providers,
      count: providers.length,
      dual_pipeline_available: healthyCount >= 2,
    });
  });

  router.get('/tts/v1/providers/:slot/voices', (req, res) => {
    const slot = parseInt(req.params.slot, 10);
    if (isNaN(slot) || slot < 1) return res.status(400).json({ error: 'Invalid slot number' });

    const svc = findServiceBySlot('tts', slot);
    if (!svc) return res.status(404).json({ error: `No TTS service in slot ${slot}` });

    const caps = TTS_PROVIDER_CAPS[svc.providerId];
    if (!caps || !caps.voices) {
      return res.status(404).json({
        error: `Provider ${svc.providerId} does not support voice listing`,
        providerId: svc.providerId,
      });
    }

    proxyRequest(req, res, svc.containerIp, svc.port, caps.voices);
  });

  router.get('/tts/v1/providers/:slot/models', (req, res) => {
    const slot = parseInt(req.params.slot, 10);
    if (isNaN(slot) || slot < 1) return res.status(400).json({ error: 'Invalid slot number' });

    const svc = findServiceBySlot('tts', slot);
    if (!svc) return res.status(404).json({ error: `No TTS service in slot ${slot}` });

    const caps = TTS_PROVIDER_CAPS[svc.providerId];
    if (!caps || !caps.models) {
      return res.status(404).json({
        error: `Provider ${svc.providerId} does not support model listing`,
        providerId: svc.providerId,
      });
    }

    proxyRequest(req, res, svc.containerIp, svc.port, caps.models);
  });

  // ─── STT Discovery Routes ──────────────────────────────────────────────────

  router.get('/stt/v1/providers', async (req, res) => {
    const sttServices = findServicesByType('stt');
    const now = Date.now();
    const needsRefresh = (now - _healthCache.updatedAt) > HEALTH_CACHE_TTL;

    const providers = await Promise.all(sttServices.map(async (svc) => {
      const key = `${svc.containerIp}:${svc.port}`;
      let healthy;
      if (needsRefresh || _healthCache.stt[key] === undefined) {
        healthy = await checkProviderHealth(svc.containerIp, svc.port);
        _healthCache.stt[key] = healthy;
      } else {
        healthy = _healthCache.stt[key];
      }
      const caps = STT_PROVIDER_CAPS[svc.providerId] || { openai: false, models: null, formats: ['wav'] };
      return buildProviderInfo(svc, caps, healthy);
    }));

    if (needsRefresh) _healthCache.updatedAt = now;

    res.json({
      providers,
      count: providers.length,
    });
  });

  router.get('/stt/v1/providers/:slot/models', (req, res) => {
    const slot = parseInt(req.params.slot, 10);
    if (isNaN(slot) || slot < 1) return res.status(400).json({ error: 'Invalid slot number' });

    const svc = findServiceBySlot('stt', slot);
    if (!svc) return res.status(404).json({ error: `No STT service in slot ${slot}` });

    const caps = STT_PROVIDER_CAPS[svc.providerId];
    if (!caps || !caps.models) {
      return res.status(404).json({
        error: `Provider ${svc.providerId} does not support model listing`,
        providerId: svc.providerId,
      });
    }

    proxyRequest(req, res, svc.containerIp, svc.port, caps.models);
  });

  // ─── Enhanced TTS Speech with provider routing ────────────────────────────

  // ─── Enhanced STT Transcription with provider routing ─────────────────────

  router.post('/stt/v1/audio/transcriptions', async (req, res) => {
    const body = await bufferBody(req);
    const contentType = req.headers['content-type'] || '';
    let providerSlot = null;

    if (contentType.includes('multipart/form-data')) {
      // Extract provider field from multipart body
      const bodyStr = body.toString('latin1');
      const match = bodyStr.match(/Content-Disposition:\s*form-data;\s*name="provider"\r?\n\r?\n(\d+)/i);
      if (match) providerSlot = parseInt(match[1], 10);
    } else {
      try {
        const parsed = JSON.parse(body.toString());
        providerSlot = parsed.provider || null;
      } catch {}
    }

    let svc;
    if (providerSlot) {
      svc = findServiceBySlot('stt', providerSlot);
      if (!svc) return res.status(404).json({ error: `No STT service in slot ${providerSlot}` });
    } else {
      // Balance across every HEALTHY STT backend. This used to take [0], so one
      // instance served every transcription and the rest sat idle.
      const all = listBackends(loadActiveServices().services, 'stt');
      if (all.length === 0) {
        return res.status(503).json({ error: emptyReason('stt', { registered: 0 }) });
      }
      const healthy = (await audioHealth.withHealth(all)).filter(h => h.healthy).map(h => h.svc);
      if (healthy.length === 0) {
        return res.status(503).json({
          error: emptyReason('stt', { registered: all.length, healthy: 0 }),
        });
      }
      svc = healthy[nextIndex('stt:default', healthy.length)];
    }

    proxyBuffered(req, res, svc.containerIp, svc.port, '/v1/audio/transcriptions', body);
  });

  // ─── Dramabox proxy (LAN-internal, lets HTTPS proxlab UI hit it) ────
  // Browser → /api/proxy/dramabox/<path> → dramabox containerIp:port/<path>
  // The dramabox service lives inside CT 177 listening on http only, so a
  // browser loaded from https://proxlab.deeveeyant.com would otherwise be
  // blocked by mixed-content. Routing through the backend keeps the LAN
  // call server-side.
  router.all('/dramabox{/*rest}', async (req, res) => {
    const svc = findServicesByType('tts').find((s) => s.providerId === 'dramabox');
    if (!svc) return res.status(503).json({ error: 'No active dramabox service' });
    const rest = req.params.rest;
    const subPath = Array.isArray(rest) ? rest.join('/') : (rest || '');
    const targetPath = '/' + subPath + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
    const body = ['GET', 'HEAD', 'DELETE'].includes(req.method) ? Buffer.alloc(0) : await bufferBody(req);
    proxyBuffered(req, res, svc.containerIp, svc.port, targetPath, body);
  });

  // --- Dynamic numbered slots for all service types ---
  for (const type of ['llm', 'tts', 'stt', 'embed', 'rerank', 'image']) {
    const label = type.toUpperCase();

    router.all(`/${type}/:slot/{*rest}`, (req, res) => {
      const slotRaw = req.params.slot;
      const slot = parseInt(slotRaw, 10);
      const isNumericSlot = /^\d+$/.test(slotRaw);

      if (isNumericSlot && slot >= 1) {
        // Numbered slot: route by stored proxySlot (stable across service removals)
        const svc = findServiceBySlot(type, slot);
        if (!svc) {
          const total = findServicesByType(type).length;
          return res.status(503).json({
            error: `No active ${label} service in slot ${slot}`,
            hint: `${total} ${label} service(s) running. Slot ${slot} is not assigned.`,
            available: total,
          });
        }
        const downstreamPath = '/' + joinRestParam(req.params.rest);
        proxyRequest(req, res, svc.containerIp, svc.port, downstreamPath);
      } else if (type !== 'llm') {
        // TTS/STT: non-numeric segment (e.g. "v1") — route to slot 1, include segment in path
        const services = findServicesByType(type);
        const svc = services[0];
        if (!svc) {
          return res.status(503).json({
            error: `No active ${label} service available`,
            hint: `Start a ${label} service in ProxLab to enable proxying`,
          });
        }
        const downstreamPath = '/' + slotRaw + '/' + joinRestParam(req.params.rest);
        proxyRequest(req, res, svc.containerIp, svc.port, downstreamPath);
      } else {
        // LLM with non-numeric, non-"v1" segment — shouldn't normally happen
        // but return a helpful error rather than silently routing
        res.status(400).json({
          error: `Invalid LLM proxy path: /llm/${slotRaw}/...`,
          hint: 'Use /llm/v1/* for universal routing or /llm/{N}/v1/* for a specific slot',
        });
      }
    });

    // Single-segment paths (e.g. /embed/props, /rerank/health) — forward to slot 1
    if (type !== 'llm') {
      router.all(`/${type}/:path`, (req, res) => {
        const services = findServicesByType(type);
        const svc = services[0];
        if (!svc) {
          return res.status(503).json({ error: `No active ${label} service available` });
        }
        proxyRequest(req, res, svc.containerIp, svc.port, '/' + req.params.path);
      });
    }
  }

  return router;
}
