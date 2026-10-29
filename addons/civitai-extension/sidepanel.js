/**
 * Side panel: frames AI-Lab's Review screen (`${webUrl}/?embed=civitai-review`) and keeps it on
 * the CivitAI model open in the active tab. See CivitaiReviewEmbed.tsx in AI-Lab for the
 * message protocol. Names, folders and previews all come from AI-Lab itself, so template
 * changes made in AI-Lab apply here immediately; nothing is synced or copied.
 */
const frame = document.getElementById('frame');
const statusEl = document.getElementById('status');
const hint = document.getElementById('hint');
const queueBtn = document.getElementById('queueBtn');

let settings = null;
let webOrigin = '';
let embedReady = false;
let current = null;   // { modelId, versionId, url } shown (or being loaded) in the embed
let pending = null;   // page to load once the embed reports ready

function setStatus(html) { statusEl.innerHTML = html; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let toastTimer = null;
function toast(text, kind) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.className = kind;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 4000);
}

function post(msg) {
  frame.contentWindow?.postMessage({ source: 'ailab-civitai-ext', ...msg }, webOrigin);
}

/** Point the embed at a tab URL. Reloads only when the model or version actually changes. */
function show(url) {
  const parsed = url ? parseCivitaiModelUrl(url) : null;
  hint.style.display = parsed ? 'none' : 'block';
  queueBtn.disabled = !parsed;
  if (!parsed) {
    if (!current) setStatus('No CivitAI model in this tab');
    return;
  }
  if (current && current.modelId === parsed.modelId && current.versionId === parsed.versionId) return;
  current = { ...parsed, url };
  setStatus(`Loading model <b>${esc(parsed.modelId)}</b>...`);
  if (embedReady) post({ type: 'load', url });
  else pending = url;
}

async function syncToActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  show(tab?.url || '');
}

window.addEventListener('message', (e) => {
  if (e.origin !== webOrigin) return;
  const d = e.data;
  if (!d || d.source !== 'ailab-civitai-review') return;
  if (d.type === 'ready') {
    embedReady = true;
    if (pending) { post({ type: 'load', url: pending }); pending = null; }
    else if (!current) setStatus('Connected to AI-Lab');
  } else if (d.type === 'loaded') {
    setStatus(`<b>${esc(d.modelName || d.modelId)}</b>`);
  } else if (d.type === 'downloaded') {
    const v = Array.isArray(d.versions) && d.versions.length ? ` (${d.versions.join(', ')})` : '';
    toast(`Sent to AI-Lab: ${d.modelName || 'model'}${v}`, 'ok');
  }
});

queueBtn.addEventListener('click', async () => {
  if (!current) return;
  queueBtn.disabled = true;
  try {
    const resp = await fetch(`${settings.apiUrl}/api/civitai/queue/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: current.modelId, versionId: current.versionId, pageUrl: current.url }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    toast(`Queued for review in AI-Lab: ${data.modelName || 'model'}`, 'ok');
  } catch (err) {
    console.error('[ailab-civitai] queue/add failed:', err);
    toast(`Could not queue: ${err.message}`, 'err');
  } finally {
    queueBtn.disabled = false;
  }
});

document.getElementById('reloadBtn').addEventListener('click', () => {
  embedReady = false;
  pending = current?.url || null;
  current = null;
  frame.src = frame.src;
  void syncToActiveTab();
});
document.getElementById('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.tabs.onActivated.addListener(() => void syncToActiveTab());
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url && tab.active) show(info.url);
});

(async () => {
  settings = await ailabSettings();
  try {
    webOrigin = new URL(settings.webUrl).origin;
  } catch {
    setStatus('The AI-Lab web URL in Options is not valid');
    return;
  }
  frame.src = `${settings.webUrl}/?embed=civitai-review`;
  // If the embed never says ready, AI-Lab is unreachable or too old for embed mode.
  setTimeout(() => {
    if (!embedReady) setStatus(`No answer from AI-Lab at ${esc(settings.webUrl)}. Check Options.`);
  }, 15000);
  await syncToActiveTab();
})();
