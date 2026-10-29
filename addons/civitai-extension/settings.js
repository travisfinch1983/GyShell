/**
 * Shared settings for every extension context (content script, side panel, options).
 *
 * apiUrl  AI-Lab backend that takes /api/civitai/* (download, review queue)
 * webUrl  AI-Lab web UI; the side panel frames `${webUrl}/?embed=civitai-review`
 *
 * v1 stored a single `proxlabUrl`; it is used as apiUrl until an apiUrl is saved.
 */
const AILAB_DEFAULTS = {
  apiUrl: 'http://10.0.0.219:17890',
  webUrl: 'http://10.0.0.219:17889',
};

function ailabSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiUrl', 'webUrl', 'proxlabUrl'], (r) => {
      const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
      resolve({
        apiUrl: clean(r.apiUrl) || clean(r.proxlabUrl) || AILAB_DEFAULTS.apiUrl,
        webUrl: clean(r.webUrl) || AILAB_DEFAULTS.webUrl,
      });
    });
  });
}

/** { modelId, versionId|null } for a CivitAI model page URL, else null. */
function parseCivitaiModelUrl(href) {
  try {
    const u = new URL(href);
    if (!/(^|\.)civitai\.(com|red)$/.test(u.hostname)) return null;
    const m = u.pathname.match(/\/models\/(\d+)/);
    if (!m) return null;
    return { modelId: m[1], versionId: u.searchParams.get('modelVersionId') || null };
  } catch {
    return null;
  }
}
