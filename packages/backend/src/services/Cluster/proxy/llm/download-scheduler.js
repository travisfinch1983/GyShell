/**
 * Re-export of the canonical scheduler — DO NOT restore a local copy.
 *
 * 🛑 This file used to be a byte-similar duplicate whose ONLY divergence was the
 * store path: it read cwd()/data while the UI's PUT route (civitai.js) wrote
 * AILAB_PROXY_DATA_DIR. Two files, one name — so pausing HF downloads confirmed
 * {ok:true} in the UI and never took effect at the queue-pump gate
 * (ai.js isDownloadAllowed), because the gate's copy fell back to DEFAULTS
 * manualState:'running' on the missing file (Observability Sweep T1, 2026-08-30).
 * One module, one path, and the gate and the UI cannot disagree again.
 */
export * from '../download-scheduler.js';
