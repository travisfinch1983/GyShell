const apiInput = document.getElementById('apiUrl');
const webInput = document.getElementById('webUrl');
const msg = document.getElementById('msg');

ailabSettings().then((s) => {
  apiInput.value = s.apiUrl;
  webInput.value = s.webUrl;
});

async function probe(url, path) {
  try {
    const r = await fetch(url + path, { method: 'GET' });
    return r.ok;
  } catch {
    return false;
  }
}

document.getElementById('save').addEventListener('click', async () => {
  const clean = (u) => u.trim().replace(/\/+$/, '');
  const apiUrl = clean(apiInput.value);
  const webUrl = clean(webInput.value);
  await chrome.storage.local.set({ apiUrl, webUrl });
  msg.textContent = 'Saved. Checking...';
  const apiOk = await probe(apiUrl, '/api/civitai/queue/count');
  msg.textContent = apiOk ? 'Saved. AI-Lab API answered.' : 'Saved, but the AI-Lab API did not answer at that URL.';
});
