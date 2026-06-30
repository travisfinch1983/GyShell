/**
 * anthropic-proxy.js — Anthropic API Proxy Sub-Router
 *
 * Mounted BEFORE express.json() for raw body streaming.
 * Routes:
 *   GET  /v1/models              — List Claude models (OpenAI format)
 *   POST /v1/messages            — Native Anthropic passthrough
 *   POST /v1/chat/completions    — OpenAI-compat with format conversion
 *
 * Per-model shortcut routes (force model regardless of request body):
 *   /opus/v1/...                 — Always uses the latest Opus
 *   /sonnet/v1/...               — Always uses the latest Sonnet
 *   /haiku/v1/...                — Always uses the latest Haiku
 *
 * Uses manual JSON body parsing (same pattern as existing proxy.js).
 *
 * @module routes/anthropic-proxy
 */

import { Router } from 'express';
import { proxyMessages, proxyChatCompletions, isAuthenticated, getAuthStatus, startBackgroundRefresh } from './lib/anthropic-proxy.js';

// Latest version of each Anthropic model family available on the MAX subscription.
// The shortName drives the per-model shortcut routes (/opus, /sonnet, /haiku).
const CLAUDE_MODELS = [
  { id: 'claude-opus-4-8', shortName: 'opus', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', shortName: 'sonnet', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', shortName: 'haiku', label: 'Haiku 4.5' },
];

/**
 * Middleware: manually parse JSON body for proxy routes.
 * We can't use express.json() since this router is mounted before it.
 */
function parseJsonBody(req, res, next) {
  if (req.method !== 'POST') return next();

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    try {
      req.body = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: { type: 'invalid_request_error', message: 'Invalid JSON body' } });
    }
    next();
  });
  req.on('error', (err) => {
    res.status(400).json({ error: { type: 'invalid_request_error', message: err.message } });
  });
}

/** Middleware: force-set model in request body */
function forceModel(modelId) {
  return (req, res, next) => {
    if (!req.body) req.body = {};
    req.body.model = modelId;
    next();
  };
}

export function createAnthropicProxyRouter() {
  const router = Router();

  // Start background token refresh
  startBackgroundRefresh();

  // Auth status endpoint for UI
  router.get('/status', async (req, res) => {
    const status = await getAuthStatus();
    res.json(status);
  });

  // Models endpoint (OpenAI-compatible)
  router.get('/v1/models', (req, res) => {
    res.json({
      object: 'list',
      data: CLAUDE_MODELS.map(m => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'anthropic',
      })),
    });
  });

  // Native Anthropic messages
  router.post('/v1/messages', parseJsonBody, proxyMessages);

  // OpenAI-compatible chat completions
  router.post('/v1/chat/completions', parseJsonBody, proxyChatCompletions);

  // Per-model shortcut routes — user picks the URL, model is forced
  for (const m of CLAUDE_MODELS) {
    router.get(`/${m.shortName}/v1/models`, (req, res) => {
      res.json({
        object: 'list',
        data: [{ id: m.id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'anthropic' }],
      });
    });
    router.post(`/${m.shortName}/v1/messages`, parseJsonBody, forceModel(m.id), proxyMessages);
    router.post(`/${m.shortName}/v1/chat/completions`, parseJsonBody, forceModel(m.id), proxyChatCompletions);
  }

  return router;
}

export { CLAUDE_MODELS, isAuthenticated, getAuthStatus };
