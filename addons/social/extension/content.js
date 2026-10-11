// AI-Lab Login Bridge - "track this account" buttons.
//   Instagram: a floating button on profile pages.
//   X: a floating button on profile pages + a small "+" next to every author name (tweets, replies).
// Both sites are single-page apps, so the page is re-checked whenever the DOM or URL changes.
(() => {
  const host = location.hostname;
  const SITE = /instagram\.com$/.test(host) ? 'instagram' : 'twitter';
  const HANDLE_RE = SITE === 'instagram' ? /^[A-Za-z0-9._]{1,30}$/ : /^[A-Za-z0-9_]{1,15}$/;
  const RESERVED = new Set(SITE === 'instagram'
    ? ['p', 'reel', 'reels', 'explore', 'stories', 'direct', 'accounts', 'about', 'legal', 'developer', 'tv',
       'challenge', 'emails', 'web', 'session', 'privacy', 'terms', 'api', 'graphql', 'oauth', 'ar', 'lite',
       'topics', 'locations', 'tags', 'your_activity', 'notifications', 'create', 'meta_verified']
    : ['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'search', 'compose', 'login', 'logout',
       'signup', 'tos', 'privacy', 'jobs', 'premium', 'hashtag', 'communities', 'bookmarks', 'lists', 'topics',
       'verified-choose', 'account', 'intent', 'share', 'download', 'grok']);
  const LABEL = SITE === 'instagram' ? 'Instagram' : 'X';

  let tracked = new Set();
  const ask = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || { ok: false, error: chrome.runtime.lastError?.message || 'no answer' })));

  async function refresh(fresh) {
    const r = await ask({ type: 'tracked', site: SITE, fresh });
    if (r.ok) tracked = new Set(r.handles);
    return r;
  }

  function profileHandle() {
    const seg = location.pathname.split('/').filter(Boolean);
    if (!seg.length || RESERVED.has(seg[0].toLowerCase()) || !HANDLE_RE.test(seg[0])) return null;
    // X: /<handle>, /<handle>/media, /<handle>/with_replies... but not /<handle>/status/<id>
    if (SITE === 'twitter' && seg[1] === 'status') return null;
    // Instagram: /<handle>/, /<handle>/tagged/, /<handle>/reels/ - but not /<handle>/p/<id>
    if (SITE === 'instagram' && (seg[1] === 'p' || seg[1] === 'reel')) return null;
    return seg[0];
  }

  function paint(btn, handle, state, err) {
    const mini = btn.classList.contains('ailab-track-mini');
    btn.classList.toggle('done', state === 'done');
    btn.classList.toggle('err', state === 'err');
    if (state === 'done') { btn.textContent = mini ? '✓' : `✓ @${handle} tracked in AI-Lab`; btn.title = `@${handle} is tracked by AI-Lab's ${LABEL} scraper`; }
    else if (state === 'busy') { btn.textContent = mini ? '…' : 'Adding…'; }
    else if (state === 'err') {
      // show the reason ON the button - a tooltip-only error read as "it just doesn't work"
      const why = String(err || 'failed');
      btn.textContent = mini ? '!' : `AI-Lab: not added - ${why.length > 90 ? why.slice(0, 90) + '…' : why}`;
      btn.title = `${why}\n(click to retry)`;
      console.warn('[AI-Lab Login Bridge] track failed:', why);
    }
    else { btn.textContent = mini ? '+' : `+ Track @${handle} in AI-Lab`; btn.title = `Add @${handle} to AI-Lab's ${LABEL} scraper`; }
  }

  async function onTrack(e, btn, handle) {
    e.preventDefault(); e.stopPropagation();
    if (tracked.has(handle.toLowerCase())) return;
    paint(btn, handle, 'busy');
    const r = await ask({ type: 'track', site: SITE, handle });
    if (r.ok) { tracked.add(handle.toLowerCase()); repaintAll(); }
    else paint(btn, handle, 'err', r.error);
  }

  function makeBtn(cls, handle) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.dataset.handle = handle;
    b.addEventListener('click', (e) => onTrack(e, b, handle), true);
    paint(b, handle, tracked.has(handle.toLowerCase()) ? 'done' : 'idle');
    return b;
  }

  function repaintAll() {
    document.querySelectorAll('.ailab-track-fab, .ailab-track-mini').forEach((b) => {
      if (!b.classList.contains('err')) paint(b, b.dataset.handle, tracked.has(b.dataset.handle.toLowerCase()) ? 'done' : 'idle');
    });
  }

  function syncFab() {
    const h = profileHandle();
    let fab = document.querySelector('.ailab-track-fab');
    if (!h) { if (fab) fab.remove(); return; }
    if (fab && fab.dataset.handle === h) return;
    if (fab) fab.remove();
    document.body.appendChild(makeBtn('ailab-track-fab', h));
  }

  // X only: a "+" after each author name. [data-testid="User-Name"] wraps the name + @handle in tweets.
  function syncInline() {
    if (SITE !== 'twitter') return;
    document.querySelectorAll('[data-testid="User-Name"]:not([data-ailab])').forEach((el) => {
      el.setAttribute('data-ailab', '1');
      const a = [...el.querySelectorAll('a[href^="/"]')].find((x) => /^\/[A-Za-z0-9_]{1,15}$/.test(x.getAttribute('href')));
      if (!a) return;
      const handle = a.getAttribute('href').slice(1);
      if (RESERVED.has(handle.toLowerCase())) return;
      const row = el.firstElementChild || el;
      row.appendChild(makeBtn('ailab-track-mini', handle));
    });
  }

  let lastUrl = '', pending = false;
  function tick() {
    pending = false;
    if (location.href !== lastUrl) { lastUrl = location.href; refresh(false).then(repaintAll); }
    syncFab();
    syncInline();
  }
  const schedule = () => { if (!pending) { pending = true; setTimeout(tick, 400); } };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  refresh(true).then(() => { repaintAll(); tick(); });
})();
