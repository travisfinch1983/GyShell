/**
 * CivitAI to AI-Lab — content script (needs settings.js loaded first).
 *
 * Adds two buttons to CivitAI model pages:
 *   Download  quick path: a small dialog with the name box pre-filled from AI-Lab's filename
 *             template, then straight to the AI-Lab downloader. Only a name you CHANGED is sent
 *             as an override; an untouched box downloads under the template name and is not
 *             recorded as a manual rename.
 *   Review    opens the side panel, which runs AI-Lab's own Review screen for this page
 *             (versions, file ticks, Folder/Filename boxes, live name preview).
 */
(function () {
  'use strict';

  let lastUrl = '';

  function injectButtons() {
    if (document.getElementById('ailab-btn-container')) return;
    const container = document.createElement('div');
    container.id = 'ailab-btn-container';

    const dlBtn = document.createElement('button');
    dlBtn.id = 'ailab-dl-btn';
    dlBtn.className = 'ailab-btn ailab-btn-download';
    dlBtn.textContent = '⬇ Download';
    dlBtn.title = 'Download this version through AI-Lab (optionally under a custom name)';
    dlBtn.addEventListener('click', () => void showDownloadDialog());

    const revBtn = document.createElement('button');
    revBtn.id = 'ailab-rev-btn';
    revBtn.className = 'ailab-btn ailab-btn-review';
    revBtn.textContent = '📋 Review';
    revBtn.title = 'Open the AI-Lab Review panel for this model';
    revBtn.addEventListener('click', openReview);

    container.appendChild(dlBtn);
    container.appendChild(revBtn);
    document.body.appendChild(container);
  }

  function removeButtons() {
    document.getElementById('ailab-btn-container')?.remove();
    removeDialog();
  }

  function openReview() {
    // Must be sent synchronously from the click: the worker's sidePanel.open() rides on
    // this user gesture.
    chrome.runtime.sendMessage({ type: 'openReview' }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        const why = chrome.runtime.lastError?.message || resp?.error || 'unknown error';
        console.error('[ailab-civitai] could not open the side panel:', why);
        showToast('Could not open the panel. Click the extension icon instead.', 'error');
      }
    });
  }

  async function showDownloadDialog() {
    removeDialog();
    const parsed = parseCivitaiModelUrl(location.href);
    if (!parsed) return showToast('Not on a model page', 'error');
    const { apiUrl } = await ailabSettings();

    const dialog = document.createElement('div');
    dialog.id = 'ailab-confirm-dialog';
    dialog.className = 'ailab-confirm';
    dialog.innerHTML = `
      <div class="ailab-confirm-title">Download via AI-Lab</div>
      <div class="ailab-confirm-label">Filename (from your template; change it for a custom name)</div>
      <input type="text" class="ailab-confirm-input" id="ailab-confirm-name" spellcheck="false" placeholder="loading template name..." disabled>
      <div class="ailab-confirm-note" id="ailab-confirm-note"></div>
      <div class="ailab-confirm-buttons">
        <button id="ailab-confirm-ok" class="ailab-btn ailab-confirm-download" disabled>Download</button>
        <button id="ailab-confirm-cancel" class="ailab-btn ailab-btn-cancel">Cancel</button>
      </div>`;
    document.body.appendChild(dialog);
    const input = dialog.querySelector('#ailab-confirm-name');
    const ok = dialog.querySelector('#ailab-confirm-ok');
    const note = dialog.querySelector('#ailab-confirm-note');
    let templateName = '';

    const submit = () => {
      const typed = input.value.trim();
      removeDialog();
      // Same rule as the Review screen: an unchanged box is not an override.
      void download(parsed, typed && typed !== templateName ? typed : null);
    };
    ok.addEventListener('click', submit);
    dialog.querySelector('#ailab-confirm-cancel').addEventListener('click', removeDialog);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') removeDialog();
    });

    try {
      const resp = await fetch(`${apiUrl}/api/civitai/check-conflicts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: parsed.modelId, versionId: parsed.versionId }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      templateName = data.templateName || '';
      input.value = templateName;
      const bits = [];
      if (data.versionName) bits.push(`Version: ${data.versionName}`);
      if (data.conflicts?.length) bits.push(`${data.conflicts.length} file(s) already on disk`);
      note.textContent = bits.join(' · ');
    } catch (err) {
      console.error('[ailab-civitai] template name lookup failed:', err);
      note.textContent = `Could not reach AI-Lab for the template name (${err.message}). Leave blank to use the template.`;
      input.placeholder = 'leave blank for the template name';
    }
    if (!document.body.contains(dialog)) return; // cancelled while loading
    input.disabled = false;
    ok.disabled = false;
    input.focus();
    input.select();
  }

  function removeDialog() {
    document.getElementById('ailab-confirm-dialog')?.remove();
  }

  async function download(parsed, nameOverride) {
    const { apiUrl } = await ailabSettings();
    const btn = document.getElementById('ailab-dl-btn');
    const orig = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = '⌛ Sending...'; }
    try {
      const body = { modelId: parsed.modelId, versionId: parsed.versionId, pageUrl: location.href };
      if (nameOverride) body.extensionOverride = nameOverride;
      const resp = await fetch(`${apiUrl}/api/civitai/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.ok) {
        showToast(`Downloading: ${data.modelName || 'model'} (${data.filesQueued || 0} files)`, 'success');
      } else if (data.conflict) {
        showToast(`Conflict: ${data.modelName} was sent to the review queue`, 'warning');
      } else {
        showToast(`Error: ${data.error || `HTTP ${resp.status}`}`, 'error');
      }
    } catch (err) {
      console.error('[ailab-civitai] download request failed:', err);
      showToast(`Connection failed: ${err.message}`, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
    }
  }

  function showToast(message, type) {
    document.getElementById('ailab-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'ailab-toast';
    toast.className = `ailab-toast ailab-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (parseCivitaiModelUrl(location.href)) injectButtons();
    else removeButtons();
  }

  // CivitAI is a single-page app: watch for client-side navigation.
  new MutationObserver(checkUrl).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', checkUrl);
  checkUrl();
})();
