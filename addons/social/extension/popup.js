// AI-Lab Login Bridge: reads the cookies of ONE site (on a button press) and POSTs them to the
// AI-Lab social addon, which keeps only the cookie values it needs.
const SITES = {
  ig: { site: 'instagram', label: 'Instagram', domains: ['instagram.com'], need: ['sessionid'] },
  x: { site: 'twitter', label: 'X', domains: ['x.com', 'twitter.com'], need: ['auth_token', 'ct0'] },
};
const $ = (id) => document.getElementById(id);
const say = (text, cls) => { $('msg').textContent = text; $('msg').className = 'msg ' + (cls || ''); };

chrome.storage.local.get({ base: 'http://10.0.0.219:17889' }, (v) => { $('base').value = v.base; });

async function send(key) {
  const s = SITES[key];
  const base = $('base').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(base)) { say('AI-Lab address must look like http://host:port', 'err'); return; }
  chrome.storage.local.set({ base });
  // permission to talk to this AI-Lab address (asked once per address)
  const origin = base + '/*';
  const granted = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
  if (!granted) { say('Permission to reach ' + base + ' was not granted.', 'err'); return; }

  const jar = {};
  for (const d of s.domains) {
    for (const c of await chrome.cookies.getAll({ domain: d })) jar[c.name] = c.value;
  }
  const missing = s.need.filter((n) => !jar[n]);
  if (missing.length) { say(`Not logged in to ${s.label} in this browser (missing ${missing.join(', ')}). Log in, then try again.`, 'err'); return; }

  try {
    const r = await fetch(`${base}/addons/social/${s.site}/api/cookies`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookies: JSON.stringify(jar) }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) {
      const left = (j.cookies && j.cookies.missing) || [];
      say(left.length ? `Sent, but AI-Lab still reports missing ${left.join(', ')}.` : `${s.label} login saved in AI-Lab (${Object.keys(jar).length} cookies).`, left.length ? 'err' : 'ok');
    } else {
      say(`AI-Lab answered ${r.status}: ${j.error || 'error'}`, 'err');
    }
  } catch (e) {
    say('Could not reach AI-Lab at ' + base + ': ' + e.message, 'err');
  }
}
$('ig').onclick = () => send('ig');
$('x').onclick = () => send('x');
