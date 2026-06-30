/**
 * anthropic-proxy.js — Anthropic API Proxy via OAuth Credentials
 *
 * Ported from the Claude Code HA addon's api-proxy.js.
 * Uses Claude Code's stored OAuth credentials (~/.claude/.credentials.json)
 * to proxy requests to the Anthropic API.
 *
 * Exports:
 *   - proxyMessages(req, res)       — Native /v1/messages passthrough
 *   - proxyChatCompletions(req, res) — OpenAI-compat with format conversion
 *   - getAuthToken()                 — Get a valid OAuth access token
 *   - clearTokenCache()              — Invalidate cached token
 *   - isAuthenticated()              — Quick check if credentials exist
 *
 * @module lib/anthropic-proxy
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const CREDENTIALS_FILE = join(process.env.HOME || '/root', '.claude', '.credentials.json');
const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Prompt-cache tier for auto-injected breakpoints ('1h' keeps a paused chat warm
// far longer than the default 5-minute ephemeral cache). Override via env.
const CACHE_TTL = process.env.ANTHROPIC_CACHE_TTL || '1h';
const CACHE_INJECT = process.env.ANTHROPIC_CACHE_INJECT !== '0';

// Static long-lived token path: `claude setup-token` mints an OAuth token that works
// as a Bearer with no refresh dance — ideal on a headless box, and it can't disturb
// any interactive Claude login elsewhere. Preferred over the refreshable credentials
// file when present. Source order: env → token file → ~/.claude/.credentials.json.
const STATIC_TOKEN_ENV = (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_OAUTH_TOKEN || '').trim();
const TOKEN_FILE = process.env.CLAUDE_MAX_TOKEN_FILE || join(process.env.HOME || '/root', '.claude', 'max-oauth-token');

// Upstream retry-with-jitter for transient throttles (429) / overload (503/529).
// The MAX subscription is a shared quota across every cluster Claude + this proxy,
// so collisions are expected; retrying with backoff turns a hard failure into a
// brief stall. Honors Retry-After when sane, else exponential backoff, capped.
const RETRY_MAX = parseInt(process.env.ANTHROPIC_RETRY_MAX || '4', 10);
const RETRY_BASE_MS = parseInt(process.env.ANTHROPIC_RETRY_BASE_MS || '600', 10);
const RETRY_CAP_MS = parseInt(process.env.ANTHROPIC_RETRY_CAP_MS || '8000', 10);
const RETRYABLE = new Set([429, 503, 529]);

let cachedToken = null;
let cachedExpiry = 0;

async function readStaticToken() {
  if (STATIC_TOKEN_ENV) return STATIC_TOKEN_ENV;
  try {
    const t = (await readFile(TOKEN_FILE, 'utf-8')).trim();
    if (t) return t;
  } catch { /* no token file */ }
  return null;
}

async function readCredentials() {
  const raw = await readFile(CREDENTIALS_FILE, 'utf-8');
  return JSON.parse(raw);
}

async function refreshToken(creds) {
  const refreshTok = creds.claudeAiOauth?.refreshToken;
  if (!refreshTok) throw new Error('No refresh token available. Re-authenticate via the Claude tab.');

  console.log('[anthropic-proxy] Refreshing OAuth token...');

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshTok,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    cachedToken = null;
    cachedExpiry = 0;
    throw new Error(`Token refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const tokens = await res.json();
  creds.claudeAiOauth.accessToken = tokens.access_token;
  if (tokens.refresh_token) creds.claudeAiOauth.refreshToken = tokens.refresh_token;
  creds.claudeAiOauth.expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  const dir = dirname(CREDENTIALS_FILE);
  await mkdir(dir, { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(creds), { mode: 0o600 });

  console.log('[anthropic-proxy] Token refreshed successfully');
  return creds;
}

export async function getAuthToken() {
  // A static setup-token wins: it's long-lived and needs no refresh.
  const stat = await readStaticToken();
  if (stat) return stat;

  if (cachedToken && Date.now() < cachedExpiry - REFRESH_BUFFER_MS) {
    return cachedToken;
  }

  let creds;
  try {
    creds = await readCredentials();
  } catch {
    throw new Error('Not authenticated. Log in via the Claude tab first.');
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error('No access token found. Log in via the Claude tab first.');
  }

  const expiresAt = oauth.expiresAt ? new Date(oauth.expiresAt).getTime() : Infinity;
  if (Date.now() > expiresAt - REFRESH_BUFFER_MS) {
    creds = await refreshToken(creds);
  }

  cachedToken = creds.claudeAiOauth.accessToken;
  cachedExpiry = creds.claudeAiOauth.expiresAt
    ? new Date(creds.claudeAiOauth.expiresAt).getTime()
    : Date.now() + 3600_000;

  return cachedToken;
}

export function clearTokenCache() {
  cachedToken = null;
  cachedExpiry = 0;
}

/**
 * Quick sync check: do credentials exist on disk?
 */
export async function isAuthenticated() {
  if (await readStaticToken()) return true;
  try {
    await access(CREDENTIALS_FILE);
    const raw = await readFile(CREDENTIALS_FILE, 'utf-8');
    const creds = JSON.parse(raw);
    return !!creds.claudeAiOauth?.accessToken;
  } catch {
    return false;
  }
}

/**
 * Detailed auth status for UI display.
 */
export async function getAuthStatus() {
  if (await readStaticToken()) {
    return { authenticated: true, source: 'setup-token', hasRefreshToken: false, expiresAt: null, expired: false };
  }
  try {
    await access(CREDENTIALS_FILE);
    const raw = await readFile(CREDENTIALS_FILE, 'utf-8');
    const creds = JSON.parse(raw);
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return { authenticated: false, reason: 'no_token' };
    const expiresAt = oauth.expiresAt ? new Date(oauth.expiresAt).getTime() : null;
    const hasRefresh = !!oauth.refreshToken;
    const expired = expiresAt && Date.now() > expiresAt;
    return {
      authenticated: !expired,
      source: 'credentials',
      hasRefreshToken: hasRefresh,
      expiresAt: oauth.expiresAt || null,
      expired: !!expired,
    };
  } catch {
    return { authenticated: false, reason: 'no_credentials' };
  }
}

/**
 * Background token refresh — call on startup and every 30 minutes.
 * Silently refreshes the token if it's within 10 minutes of expiry.
 */
const BG_REFRESH_INTERVAL = 30 * 60 * 1000;
let bgRefreshTimer = null;

async function backgroundRefresh() {
  try {
    const creds = await readCredentials();
    const oauth = creds.claudeAiOauth;
    if (!oauth?.refreshToken) return;
    const expiresAt = oauth.expiresAt ? new Date(oauth.expiresAt).getTime() : 0;
    // Refresh if within 10 minutes of expiry (or already expired)
    if (Date.now() > expiresAt - 10 * 60 * 1000) {
      await refreshToken(creds);
    }
  } catch (err) {
    console.error(`[anthropic-proxy] Background refresh failed: ${err.message}`);
  }
}

export function startBackgroundRefresh() {
  if (bgRefreshTimer) return;
  // Initial refresh after 5 seconds (let server start up first)
  setTimeout(backgroundRefresh, 5000);
  bgRefreshTimer = setInterval(backgroundRefresh, BG_REFRESH_INTERVAL);
  console.log('[anthropic-proxy] Background token refresh enabled (every 30 min)');
}

export function stopBackgroundRefresh() {
  if (bgRefreshTimer) {
    clearInterval(bgRefreshTimer);
    bgRefreshTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Upstream helper — calls Anthropic /v1/messages with OAuth
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt-cache breakpoint injection — turns a blind passthrough into one that
// caches automatically. We place ephemeral breakpoints on (a) the system prompt
// and (b) the rolling tail of the conversation, so even naive OpenAI clients that
// resend the whole transcript every turn get prefix cache HITS instead of misses.
// Skipped if the caller already supplied any cache_control (don't exceed 4 marks).
// ---------------------------------------------------------------------------

function hasCacheControl(body) {
  try {
    if (Array.isArray(body.system) && body.system.some((b) => b && b.cache_control)) return true;
    for (const m of body.messages || []) {
      if (Array.isArray(m.content) && m.content.some((b) => b && b.cache_control)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

function markLastBlock(content) {
  // content may be a string or an array of blocks; normalize to a marked array.
  const cc = { type: 'ephemeral', ttl: CACHE_TTL };
  if (typeof content === 'string') {
    return content.length ? [{ type: 'text', text: content, cache_control: cc }] : content;
  }
  if (Array.isArray(content) && content.length) {
    const last = content[content.length - 1];
    if (last && typeof last === 'object') last.cache_control = cc;
  }
  return content;
}

function injectCacheControl(body) {
  if (!CACHE_INJECT || !body || hasCacheControl(body)) return body;
  // (a) system prompt
  if (typeof body.system === 'string' && body.system.length) {
    body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral', ttl: CACHE_TTL } }];
  } else if (Array.isArray(body.system) && body.system.length) {
    markLastBlock(body.system);
  }
  // (b) rolling conversation tail — breakpoint on the final message's last block
  const msgs = body.messages || [];
  if (msgs.length) {
    const lastMsg = msgs[msgs.length - 1];
    lastMsg.content = markLastBlock(lastMsg.content);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Claude Code identity handshake. The MAX/OAuth path GATES the premium models
// (Opus/Sonnet) behind a required first system block identifying the caller as
// Claude Code — without it they return a disguised `rate_limit_error` (Haiku is
// exempt). Real Claude Code always sends this; we replicate it. Persona/system
// text supplied by the caller is preserved as a SUBSEQUENT block, so personas
// still fully override behaviour (verified: no "I'm Claude Code" leakage).
// ---------------------------------------------------------------------------
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function ensureClaudeIdentity(body) {
  if (!body) return body;
  const cc = { type: 'text', text: CLAUDE_CODE_IDENTITY };
  const s = body.system;
  if (s == null) { body.system = [cc]; return body; }
  if (typeof s === 'string') { body.system = [cc, { type: 'text', text: s }]; return body; }
  if (Array.isArray(s)) {
    const first = s[0];
    const already = first && typeof first === 'object' && typeof first.text === 'string'
      && first.text.startsWith('You are Claude Code');
    if (!already) s.unshift(cc);
    return body;
  }
  body.system = [cc];
  return body;
}

// Single entry point applied to every upstream body: identity handshake (always)
// then cache-control breakpoints (optional). Order matters — identity first so the
// cache breakpoint lands on the (now last) caller-supplied system block.
function prepareBody(body) {
  ensureClaudeIdentity(body);
  return injectCacheControl(body);
}

function buildUpstreamHeaders(token, extraBeta) {
  // extended-cache-ttl enables the 1-hour cache tier used by injectCacheControl.
  const betaFlags = ['oauth-2025-04-20', 'extended-cache-ttl-2025-04-11'];
  if (extraBeta) {
    for (const flag of extraBeta.split(',')) {
      const trimmed = flag.trim();
      if (trimmed && !betaFlags.includes(trimmed)) betaFlags.push(trimmed);
    }
  }
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': betaFlags.join(','),
  };
}

async function callAnthropicMessages(body, token, betaHeader, signal) {
  const headers = buildUpstreamHeaders(token, betaHeader);
  const payload = JSON.stringify(body);
  let attempt = 0;
  while (true) {
    const res = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, { method: 'POST', headers, body: payload, signal });
    if (!RETRYABLE.has(res.status) || attempt >= RETRY_MAX || signal?.aborted) return res;
    // compute wait: honor a sane Retry-After (seconds), else exponential backoff, both capped + jittered
    const ra = parseFloat(res.headers.get('retry-after'));
    const backoff = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
    const base = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, RETRY_CAP_MS) : backoff;
    const waitMs = base + Math.floor(Math.random() * 250);
    try { await res.text(); } catch { /* drain body to free the socket */ }
    console.log(`[anthropic-proxy] upstream ${res.status}, retry ${attempt + 1}/${RETRY_MAX} in ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
    if (signal?.aborted) return res;
    attempt++;
  }
}

// ---------------------------------------------------------------------------
// OpenAI <-> Anthropic format conversion
// ---------------------------------------------------------------------------

function openaiToAnthropic(body) {
  const { model, messages, max_tokens, temperature, tools, tool_choice, stream } = body;

  let system = undefined;
  const anthropicMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = system ? system + '\n\n' + msg.content : msg.content;
    } else if (msg.role === 'tool') {
      const toolResult = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content,
      };
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(toolResult);
      } else {
        anthropicMessages.push({ role: 'user', content: [toolResult] });
      }
    } else if (msg.role === 'assistant') {
      const content = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments,
          });
        }
      }
      anthropicMessages.push({
        role: 'assistant',
        content: content.length ? content : [{ type: 'text', text: msg.content || '' }],
      });
    } else {
      anthropicMessages.push({ role: msg.role, content: msg.content });
    }
  }

  const anthropicBody = {
    model,
    messages: anthropicMessages,
    max_tokens: max_tokens || 4096,
  };

  if (system) anthropicBody.system = system;
  if (temperature !== undefined) anthropicBody.temperature = temperature;
  if (stream) anthropicBody.stream = true;

  if (tools?.length) {
    anthropicBody.tools = tools.map(t => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description,
        input_schema: fn.parameters || { type: 'object', properties: {} },
      };
    });

    if (tool_choice === 'none') {
      anthropicBody.tool_choice = { type: 'none' };
    } else if (tool_choice === 'auto' || tool_choice === undefined) {
      anthropicBody.tool_choice = { type: 'auto' };
    } else if (tool_choice === 'required') {
      anthropicBody.tool_choice = { type: 'any' };
    } else if (typeof tool_choice === 'object' && tool_choice.function?.name) {
      anthropicBody.tool_choice = { type: 'tool', name: tool_choice.function.name };
    }
  }

  return prepareBody(anthropicBody);
}

function anthropicToOpenai(anthropicResp, model) {
  let textContent = '';
  const toolCalls = [];

  for (const block of anthropicResp.content || []) {
    if (block.type === 'text') {
      textContent += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const stopMap = { end_turn: 'stop', tool_use: 'tool_calls', max_tokens: 'length', stop_sequence: 'stop' };
  const finishReason = stopMap[anthropicResp.stop_reason] || 'stop';

  const message = { role: 'assistant', content: textContent || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${anthropicResp.id || Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicResp.model || model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: anthropicResp.usage?.input_tokens || 0,
      completion_tokens: anthropicResp.usage?.output_tokens || 0,
      total_tokens: (anthropicResp.usage?.input_tokens || 0) + (anthropicResp.usage?.output_tokens || 0),
    },
  };
}

function convertStreamEvent(event, state) {
  const chunks = [];

  switch (event.type) {
    case 'message_start': {
      state.model = event.message?.model;
      state.id = event.message?.id;
      chunks.push({
        id: `chatcmpl-${state.id || Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      });
      break;
    }
    case 'content_block_start': {
      if (event.content_block?.type === 'tool_use') {
        state.toolIndex = (state.toolIndex ?? -1) + 1;
        state.currentToolId = event.content_block.id;
        chunks.push({
          id: `chatcmpl-${state.id}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: state.toolIndex,
                id: event.content_block.id,
                type: 'function',
                function: { name: event.content_block.name, arguments: '' },
              }],
            },
            finish_reason: null,
          }],
        });
      }
      break;
    }
    case 'content_block_delta': {
      if (event.delta?.type === 'text_delta') {
        chunks.push({
          id: `chatcmpl-${state.id}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
        });
      } else if (event.delta?.type === 'input_json_delta') {
        chunks.push({
          id: `chatcmpl-${state.id}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: state.toolIndex,
                function: { arguments: event.delta.partial_json },
              }],
            },
            finish_reason: null,
          }],
        });
      }
      break;
    }
    case 'message_delta': {
      const stopMap = { end_turn: 'stop', tool_use: 'tool_calls', max_tokens: 'length', stop_sequence: 'stop' };
      const fr = stopMap[event.delta?.stop_reason] || 'stop';
      chunks.push({
        id: `chatcmpl-${state.id}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{ index: 0, delta: {}, finish_reason: fr }],
      });
      if (event.usage) {
        chunks[chunks.length - 1].usage = {
          prompt_tokens: event.usage.input_tokens || 0,
          completion_tokens: event.usage.output_tokens || 0,
          total_tokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
        };
      }
      break;
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Express handlers
// ---------------------------------------------------------------------------

export async function proxyMessages(req, res) {
  let token;
  try {
    token = await getAuthToken();
  } catch (err) {
    return res.status(401).json({
      type: 'error',
      error: { type: 'authentication_error', message: err.message },
    });
  }

  const isStreaming = req.body?.stream === true;
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  console.log('[anthropic-proxy] POST /v1/messages (native)');

  try {
    const upstream = await callAnthropicMessages(prepareBody(req.body), token, req.headers['anthropic-beta'], controller.signal);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.log(`[anthropic-proxy] Upstream ${upstream.status}: ${errorBody.slice(0, 200)}`);
      return res.status(upstream.status).setHeader('Content-Type', 'application/json').end(errorBody);
    }

    if (isStreaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        if (err.name !== 'AbortError') console.log(`[anthropic-proxy] Stream error: ${err.message}`);
      } finally {
        res.end();
      }
    } else {
      const body = await upstream.text();
      res.status(200).setHeader('Content-Type', 'application/json').end(body);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.log(`[anthropic-proxy] Proxy error: ${err.message}`);
    res.status(502).json({ type: 'error', error: { type: 'proxy_error', message: err.message } });
  }
}

export async function proxyChatCompletions(req, res) {
  let token;
  try {
    token = await getAuthToken();
  } catch (err) {
    return res.status(401).json({ error: { type: 'authentication_error', message: err.message } });
  }

  const isStreaming = req.body?.stream === true;
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let anthropicBody;
  try {
    anthropicBody = openaiToAnthropic(req.body);
  } catch (err) {
    return res.status(400).json({ error: { type: 'invalid_request_error', message: `Format conversion error: ${err.message}` } });
  }

  console.log(`[anthropic-proxy] POST /v1/chat/completions -> /v1/messages (model: ${anthropicBody.model})`);

  try {
    const upstream = await callAnthropicMessages(anthropicBody, token, req.headers['anthropic-beta'], controller.signal);

    if (!upstream.ok) {
      const errorBody = await upstream.text();
      console.log(`[anthropic-proxy] Upstream ${upstream.status}: ${errorBody.slice(0, 200)}`);
      try {
        const parsed = JSON.parse(errorBody);
        return res.status(upstream.status).json({ error: parsed.error || parsed });
      } catch {
        return res.status(upstream.status).json({ error: { message: errorBody.slice(0, 500) } });
      }
    }

    if (isStreaming) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      const state = {};
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (!data || data === '[DONE]') continue;
              try {
                const event = JSON.parse(data);
                const chunks = convertStreamEvent(event, state);
                for (const chunk of chunks) {
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                }
              } catch { /* skip unparseable lines */ }
            }
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') console.log(`[anthropic-proxy] Stream error: ${err.message}`);
      } finally {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } else {
      const body = await upstream.json();
      const openaiResp = anthropicToOpenai(body, req.body.model);
      res.json(openaiResp);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.log(`[anthropic-proxy] Proxy error: ${err.message}`);
    res.status(502).json({ error: { type: 'proxy_error', message: err.message } });
  }
}
