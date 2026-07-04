import { ImageUpscale, type LucideIcon } from 'lucide-react'

/**
 * Addon registry — external webUIs folded into AI-Lab as Addons-tab sub-tabs.
 *
 * ADDING AN ADDON IS A ONE-ENTRY OPERATION here, plus its proxy route in
 * apps/web/vite.config.ts (rule #1: backend-proxied, never browser→LAN —
 * follow the '/addon/upscaler' entry: target env-overridable, strip prefix).
 * Convention: `path` = '/addon/<id>' same-origin, iframed by AddonsPanel.
 *
 * `subtabs`: for addon UIs that are themselves tabbed/multi-page — each inner
 * sub-tab is just a different path under the same proxy. Omit for single-page.
 */
export interface AddonSubtab {
  id: string
  label: string
  /** same-origin path for this inner view (usually `${addon.path}/<page>`). */
  path: string
}

export interface AddonDef {
  id: string
  label: string
  Icon?: LucideIcon
  /** same-origin proxied root path of the addon UI. */
  path: string
  subtabs?: AddonSubtab[]
}

export const ADDONS: AddonDef[] = [
  {
    id: 'upscaler',
    label: 'Upscaler',
    Icon: ImageUpscale,
    // CT161 (10.0.0.231:7700) via the '/addon/upscaler' proxy — target is the
    // ADDON_UPSCALER_URL env on ai-lab-web, adjustable without a code change.
    path: '/addon/upscaler',
  },
]
