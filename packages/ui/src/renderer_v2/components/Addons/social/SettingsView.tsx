import React, { useCallback, useEffect, useState } from 'react'
import { confirmStore } from '../../../stores/confirmStore'
import { socialApi, SITE_LABEL, LOGIN_KIND, type CookieInfo, type Site } from './socialApi'
import styles from '../rule34/Rule34.module.scss'

type Field = { key: string; label: string; hint?: string; kind?: 'bool' }

const SHARED: Field[] = [
  { key: 'storage_path', label: 'Library folder (all social sites)', hint: 'Files land in <folder>/<site>/<handle>/' },
  { key: 'poll_interval_h', label: 'Re-sync every (hours, 0 = manual only)' },
  { key: 'first_sync_limit', label: 'Files on an account\'s first sync (0 = whole history)' },
  { key: 'include_videos', label: 'Download videos + GIFs', kind: 'bool', hint: 'X / Instagram / RedGIFs GIFs arrive as short video files. Open one in the browser and press S to snap a frame into your training set. Off = images only' },
]
const PER_SITE: Record<Site, Field[]> = {
  instagram: [
    { key: 'instagram.include', label: 'Sections', hint: 'comma list: posts, reels, tagged, stories, highlights (stories/highlights need a login)' },
    { key: 'instagram.sleep', label: 'Delay between requests (sec, "6-12" = random)', hint: 'Lower = faster, but Instagram blocks aggressive clients' },
  ],
  twitter: [
    { key: 'twitter.sleep', label: 'Delay between requests (sec, "2-5" = random)' },
    { key: 'twitter.retweets', label: 'Include retweets', kind: 'bool' },
  ],
  redgifs: [
    { key: 'redgifs.sleep', label: 'Delay between requests (sec, "1-2" = random)' },
  ],
  bluesky: [
    { key: 'bluesky.sleep', label: 'Delay between requests (sec, "1-2" = random)' },
    { key: 'bluesky.reposts', label: 'Include reposts', kind: 'bool' },
    { key: 'bluesky.fast', label: 'Fast downloads (Bluesky image CDN)', kind: 'bool', hint: 'On: JPEG photos come from cdn.bsky.app at full resolution, ~15x faster (re-encoded, visually identical). Off: byte-exact originals from the author\'s server, throttled to ~90 KB/s.' },
  ],
}

const COOKIE_HELP: Partial<Record<Site, string>> = {
  instagram: 'Log in to instagram.com in a browser (ideally a spare account), then export its cookies with a '
    + '"cookies.txt" extension and paste the file here - or just paste sessionid=…. Only the cookie values are '
    + 'kept; nothing else from the paste is stored.',
  twitter: 'Log in to x.com in a browser, export its cookies with a "cookies.txt" extension and paste the file here - '
    + 'or paste "auth_token=…; ct0=…" (both are under DevTools > Application > Cookies > https://x.com). Use a spare '
    + 'account if you can: heavy scraping can get an account locked.',
}

export const makeSettingsView = (site: Site): React.FC => {
  const api = socialApi(site)
  const View: React.FC = () => {
    const [form, setForm] = useState<Record<string, string>>({})
    const [cookies, setCookies] = useState<CookieInfo | null>(null)
    const [paste, setPaste] = useState('')
    const [bsHandle, setBsHandle] = useState('')
    const [bsPass, setBsPass] = useState('')
    const [busy, setBusy] = useState(false)
    const [msg, setMsg] = useState('')

    const load = useCallback(async () => {
      const d = await api.settings()
      setForm(d.settings ?? {})
      setCookies(d.cookies ?? null)
    }, [])
    useEffect(() => { void load() }, [load])

    const flash = (t: string) => { setMsg(t); setTimeout(() => setMsg(''), 4000) }

    const save = async (e: React.FormEvent) => {
      e.preventDefault()
      setBusy(true)
      try {
        const keys = [...SHARED, ...PER_SITE[site]].map((f) => f.key)
        const r = await api.saveSettings(Object.fromEntries(keys.map((k) => [k, form[k] ?? ''])))
        flash(r?.ok ? 'Saved' : (r?.error || 'Save failed'))
        await load()
      } finally { setBusy(false) }
    }

    const saveCookies = async (text = paste) => {
      if (!text.trim()) return
      setBusy(true)
      try {
        const r = await api.saveCookies(text)
        if (r?.ok) { setPaste(''); setBsPass(''); setCookies(r.cookies); flash(r.cookies.missing.length ? `Saved, but still missing ${r.cookies.missing.join(', ')}` : 'Login saved') }
        else flash(r?.error || 'Could not read any cookies from that')
      } finally { setBusy(false) }
    }

    const clearCookies = async () => {
      if (!(await confirmStore.confirm({ title: 'Forget login', message: `Delete the stored ${SITE_LABEL[site]} cookies?`, confirmText: 'Forget' }))) return
      await api.clearCookies(); await load(); flash('Login removed')
    }

    const field = (f: Field) => (
      <div key={f.key} className={styles.fieldCol}>
        <span>{f.label}</span>
        {f.kind === 'bool' ? (
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" checked={form[f.key] === '1'} onChange={(e) => setForm({ ...form, [f.key]: e.target.checked ? '1' : '0' })} />
            {form[f.key] === '1' ? 'on' : 'off'}
          </label>
        ) : (
          <input className={styles.input} value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
        )}
        {f.hint && <span className={styles.faint} style={{ fontSize: 10.5 }}>{f.hint}</span>}
      </div>
    )

    return (
      <div className={styles.view}>
        <div className={styles.headRow}>
          <span style={{ fontWeight: 600 }}>{SITE_LABEL[site]} settings</span>
          <span className={styles.spacer} />
          {msg && <span className={styles.msg}>{msg}</span>}
        </div>

        {LOGIN_KIND[site] === 'app_password' && (
          <div className={styles.card}>
            <div className={styles.cardTitle}>Login (optional)</div>
            <div className={styles.cardSub}>
              Most profiles download without a login. Some accounts hide their posts from logged-out viewers - for those,
              add an <b>app password</b> (bsky.app → Settings → Privacy and security → App passwords). Never your real password:
              an app password can be revoked on its own and can't change your account. It is stored on the AI-Lab server and never sent back to the browser.
            </div>
            <div style={{ marginBottom: 8, fontSize: 12 }}>
              {cookies?.set
                ? <span className={styles.ok} style={{ fontWeight: 600 }}>App password stored</span>
                : <span className={styles.dim}>No login stored - public profiles work.</span>}
            </div>
            <div className={styles.headRow}>
              <input className={styles.input} value={bsHandle} onChange={(e) => setBsHandle(e.target.value)} placeholder="your handle (name.bsky.social)" style={{ minWidth: 200 }} />
              <input className={styles.input} type="password" value={bsPass} onChange={(e) => setBsPass(e.target.value)} placeholder="app password (xxxx-xxxx-xxxx-xxxx)" style={{ minWidth: 200 }} autoComplete="new-password" />
              <button className={styles.btnPrimary} disabled={busy || !bsHandle.trim() || !bsPass.trim()}
                onClick={() => void saveCookies(`handle=${bsHandle.trim().replace(/^@/, '')}; app_password=${bsPass.trim()}`)}>Save login</button>
              {cookies?.set && <button className={styles.btnDanger} disabled={busy} onClick={clearCookies}>Forget login</button>}
            </div>
          </div>
        )}

        {LOGIN_KIND[site] === 'cookies' && <div className={styles.card}>
          <div className={styles.cardTitle}>Login (browser cookies)</div>
          <div className={styles.cardSub}>
            <b>Easiest:</b> install the <a href="/addons/social/extension.zip" download style={{ color: 'var(--accent)' }}>AI-Lab Login Bridge</a> browser
            extension (unzip, then chrome://extensions → Developer mode → Load unpacked → pick the folder). Log in to the site in that browser,
            click the extension, press "Send {SITE_LABEL[site]} login". It can only read instagram.com / x.com cookies, and only when you press the button.
          </div>
          <div className={styles.cardSub}>Or by hand: {COOKIE_HELP[site]}</div>
          <div style={{ marginBottom: 8, fontSize: 12 }}>
            {cookies?.set ? (
              <>
                <span className={cookies.missing.length ? styles.err : styles.ok} style={{ fontWeight: 600 }}>
                  {cookies.missing.length ? `Incomplete - missing ${cookies.missing.join(', ')}` : 'Logged in'}
                </span>
                <span className={styles.dim}> · {cookies.names.length} cookies stored ({cookies.names.slice(0, 8).join(', ')}{cookies.names.length > 8 ? ', …' : ''})</span>
              </>
            ) : (
              <span className={styles.dim}>No login stored{site === 'instagram' ? ' - public profiles still work, with limits.' : ' - X timelines will fail until you add one.'}</span>
            )}
          </div>
          <textarea className={styles.input} value={paste} onChange={(e) => setPaste(e.target.value)} rows={4}
            placeholder={site === 'instagram' ? 'cookies.txt contents, or sessionid=…' : 'cookies.txt contents, or auth_token=…; ct0=…'}
            style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-mono)', resize: 'vertical' }} />
          <div className={styles.headRow} style={{ marginTop: 6 }}>
            <button className={styles.btnPrimary} disabled={busy || !paste.trim()} onClick={() => void saveCookies()}>Save login</button>
            {cookies?.set && <button className={styles.btnDanger} disabled={busy} onClick={clearCookies}>Forget login</button>}
          </div>
        </div>}

        <form className={styles.card} onSubmit={save}>
          <div className={styles.cardTitle}>{SITE_LABEL[site]}</div>
          <div className={styles.formGrid} style={{ marginTop: 8 }}>{PER_SITE[site].map(field)}</div>
          <div className={styles.cardTitle} style={{ marginTop: 6 }}>Shared by all the social sites (Instagram, X, RedGIFs, Bluesky)</div>
          <div className={styles.formGrid} style={{ marginTop: 8 }}>{SHARED.map(field)}</div>
          <div className={styles.headRow}>
            <button type="submit" className={styles.btnPrimary} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
            <button type="button" className={styles.btn} disabled={busy} title="Re-read the library folder: index files added by hand, drop rows whose file is gone"
              onClick={async () => { const r = await api.rescan(); flash(`Rescanned - ${r?.indexed ?? 0} new files indexed`) }}>Rescan library</button>
          </div>
        </form>
      </div>
    )
  }
  return View
}
