// AI-Lab Login Bridge - background worker. Content scripts on instagram.com / x.com can't call AI-Lab
// themselves (cross-origin), so they message this worker, which holds the host permission for the
// AI-Lab address the user granted in the popup.
const DEFAULT_BASE = 'http://10.0.0.219:17889';
const cache = {};   // site -> { at, set: Set<lowercase handle> }

async function base() {
  const v = await chrome.storage.local.get({ base: DEFAULT_BASE });
  return v.base.replace(/\/+$/, '');
}

async function tracked(site, fresh) {
  const c = cache[site];
  if (!fresh && c && Date.now() - c.at < 60000) return c.set;
  const r = await fetch(`${await base()}/addons/social/${site}/`);
  if (!r.ok) throw new Error(`AI-Lab answered HTTP ${r.status}`);
  const j = await r.json();
  const set = new Set((j.accounts || []).map((a) => String(a.handle).toLowerCase()));
  cache[site] = { at: Date.now(), set };
  return set;
}

async function track(site, handle) {
  const r = await fetch(`${await base()}/addons/social/${site}/api/accounts/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handles: handle }),
  });
  const j = await r.json().catch(() => ({}));
  if (j.ok) (cache[site] ||= { at: Date.now(), set: new Set() }).set.add(handle.toLowerCase());
  return j.ok ? { ok: true } : { ok: false, error: j.error || `HTTP ${r.status}` };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === 'tracked') return reply({ ok: true, handles: [...await tracked(msg.site, msg.fresh)] });
      if (msg.type === 'track') return reply(await track(msg.site, msg.handle));
      reply({ ok: false, error: 'unknown request' });
    } catch (e) {
      const m = String(e && e.message || e);
      reply({ ok: false, error: /Failed to fetch|NetworkError/i.test(m)
        ? `can't reach AI-Lab at ${await base()} - open the extension popup and press "Save address" once` : m });
    }
  })();
  return true;   // async reply
});
