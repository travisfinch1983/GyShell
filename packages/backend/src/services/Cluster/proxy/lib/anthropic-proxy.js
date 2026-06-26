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

let cachedToken = null;
let cachedExpiry = 0;

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

function buildUpstreamHeaders(token, extraBeta) {
  const betaFlags = ['oauth-2025-04-20'];
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
  return fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
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

  return anthropicBody;
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
    const upstream = await callAnthropicMessages(req.body, token, req.headers['anthropic-beta'], controller.signal);

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
