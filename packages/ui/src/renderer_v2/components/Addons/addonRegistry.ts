import type React from 'react'
import { AtSign, Blocks, Camera, Download, ImageDown, ImageUpscale, type LucideIcon } from 'lucide-react'
import { DashboardView } from './upscaler/DashboardView'
import { BrowseView } from './upscaler/BrowseView'
import { HistoryView } from './upscaler/HistoryView'
import { SyncView } from './upscaler/SyncView'
import { DashboardView as R34DashboardView } from './rule34/DashboardView'
import { BrowserView as R34BrowserView } from './rule34/BrowserView'
import { SettingsView as R34SettingsView } from './rule34/SettingsView'
import { makeDashboardView as socialDashboard } from './social/DashboardView'
import { makeBrowserView as socialBrowser } from './social/BrowserView'
import { makeSettingsView as socialSettings } from './social/SettingsView'
import { BrowserView as FanslyBrowserView } from './fansly/BrowserView'

/**
 * Addon registry — SELF-CONTAINED addon modules as Addons-tab sub-tabs.
 * Schema ratified with claude1 (2026-07-04):
 *
 *  - MANIFEST (data-serializable — mirrors the module's addon.json at
 *    /opt/ai-lab/addons/<id>/): { id, label, icon?, basePath, views:
 *    [{id, label, kind: 'native'|'embed', path?}] }. The backend supervises
 *    the addon's local server and proxies it SAME-ORIGIN under basePath.
 *  - NATIVE_VIEWS: client-side lookup `${addonId}.${viewId}` → React
 *    component (a manifest can't carry code). Embed addons are pure data;
 *    native addons = one manifest + ONE lookup line per view.
 *
 * claude2: adding an embed addon = one manifest entry here (zero framework
 * edits). Adding a native addon = manifest entry + one NATIVE_VIEWS line per
 * view. This static list swaps to the backend's addon.json endpoint when it
 * lands — same shape by design.
 */
export interface AddonViewDef {
  id: string
  label: string
  kind: 'native' | 'embed'
  /** embed views: same-origin path (absolute, or relative to basePath). */
  path?: string
}

export interface AddonManifest {
  id: string
  label: string
  /** icon slug (data-serializable) — mapped to lucide via ADDON_ICONS. */
  icon?: string
  /** same-origin proxied root of the addon module: `/addons/<id>`. */
  basePath: string
  views: AddonViewDef[]
}

export const ADDON_ICONS: Record<string, LucideIcon> = {
  upscale: ImageUpscale,
  r34: ImageDown,
  instagram: Camera,
  twitter: AtSign,
  download: Download,
  default: Blocks,
}

/** Native view components, keyed `${addonId}.${viewId}`. One line per view. */
export const NATIVE_VIEWS: Record<string, React.ComponentType> = {
  'upscaler.dashboard': DashboardView,
  'upscaler.browse': BrowseView,
  'upscaler.history': HistoryView,
  'upscaler.sync': SyncView,
  'rule34.dashboard': R34DashboardView,
  'rule34.browser': R34BrowserView,
  'rule34.settings': R34SettingsView,
  // Instagram + X share ONE backend (addons/social) and one set of view factories, bound per site.
  'instagram.dashboard': socialDashboard('instagram'),
  'instagram.browser': socialBrowser('instagram'),
  'instagram.settings': socialSettings('instagram'),
  'twitter.dashboard': socialDashboard('twitter'),
  'twitter.browser': socialBrowser('twitter'),
  'twitter.settings': socialSettings('twitter'),
  'fansly.browser': FanslyBrowserView,
}

export const ADDONS: AddonManifest[] = [
  {
    id: 'upscaler',
    label: 'Upscaler',
    icon: 'upscale',
    // Bundled module at /opt/ai-lab/addons/upscaler (FastAPI, backend-supervised);
    // JSON API under /addons/upscaler/api/* — claude1's half, in flight.
    basePath: '/addons/upscaler',
    views: [
      { id: 'dashboard', label: 'Dashboard', kind: 'native' },
      { id: 'browse', label: 'Browse', kind: 'native' },
      { id: 'history', label: 'History', kind: 'native' },
      { id: 'sync', label: 'Sync', kind: 'native' },
      // 'compare' is a detail view reached from history/browse (overlay), not a tab.
    ],
  },
  {
    id: 'rule34',
    label: 'Rule34 Scraper',
    icon: 'r34',
    // Bundled module at /opt/ai-lab/addons/rule34 (FastAPI, systemd ailab-addon-rule34.service);
    // JSON API under /addons/rule34/api/* — scrape/download/browse rule34.xxx posts.
    basePath: '/addons/rule34',
    views: [
      { id: 'dashboard', label: 'Dashboard', kind: 'native' },
      { id: 'browser', label: 'Browser', kind: 'native' },
      { id: 'settings', label: 'Settings', kind: 'native' },
    ],
  },
  // Instagram + X/Twitter scrapers: ONE bundled module at /opt/ai-lab/addons/social (FastAPI + gallery-dl,
  // systemd ailab-addon-social.service @ :8097), proxied under /addons/social; site routes are /<site>/*.
  {
    id: 'instagram',
    label: 'Instagram',
    icon: 'instagram',
    basePath: '/addons/social/instagram',
    views: [
      { id: 'dashboard', label: 'Dashboard', kind: 'native' },
      { id: 'browser', label: 'Browser', kind: 'native' },
      { id: 'settings', label: 'Settings', kind: 'native' },
    ],
  },
  {
    id: 'twitter',
    label: 'X / Twitter',
    icon: 'twitter',
    basePath: '/addons/social/twitter',
    views: [
      { id: 'dashboard', label: 'Dashboard', kind: 'native' },
      { id: 'browser', label: 'Browser', kind: 'native' },
      { id: 'settings', label: 'Settings', kind: 'native' },
    ],
  },
  // Fansly/Coomer/Kemono scraper: /opt/ai-lab/addons/fansly (ailab-addon-fansly.service @ :8096). Its runtime
  // manifest (.gybackend-data/addons/fansly.json) still drives the backend proxy at /addons/fansly, so it stays;
  // AddonsPanel hides the runtime tab for any id compiled here. Scraper = the addon's own page; Browser = native.
  {
    id: 'fansly',
    label: 'Fansly Scraper',
    icon: 'download',
    basePath: '/addons/fansly',
    views: [
      { id: 'scraper', label: 'Scraper', kind: 'embed', path: '' },
      { id: 'browser', label: 'Browser', kind: 'native' },
    ],
  },
]
