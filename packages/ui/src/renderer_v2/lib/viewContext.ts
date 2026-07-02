import type { ViewSnapshot } from '@gyshell/shared'

/**
 * View-context capture (req 3). Builds a ViewSnapshot of what the user is
 * looking at RIGHT NOW, at send time in the renderer (doc R2.1), so it can ride
 * the startTask payload and the agent can resolve context-dependent asks
 * ("do these settings look right?") without the user spelling out the tab.
 *
 * Describe adapters (R2.4) produce a stable one-line summary per panel kind and
 * fall back to a generic description so a missing adapter never blocks a send.
 * Keep summaries STABLE (no timestamps/counters) so the dedup hash matches
 * across unchanged turns.
 */

// Minimal shape we read off AppStore — kept loose to avoid a circular import.
interface ViewContextSource {
  layout?: {
    tree?: { focusedPanelId?: string; panelTabs?: Record<string, { activeTabId?: string; tabIds?: string[] }> }
    getPanelKindById?: (panelId: string) => string | null | undefined
  }
  chat?: { sessions?: Array<{ id: string; title?: string }> }
}

const KIND_DESCRIPTIONS: Record<string, string> = {
  chat: 'the AI chat',
  terminal: 'a terminal session',
  fileEditor: 'the file editor',
  filesystem: 'the file browser',
  monitor: 'the system/GPU monitor',
  llmLauncher: 'the LLM Launcher (configuring or launching a language-model service)',
  imagegen: 'the AI Image-Gen workspace',
  tts: 'the Text-to-Speech workspace',
  settings: 'the Settings panel',
  fleetFeed: 'the Fleet Feed (inter-agent message board)',
}

/** djb2 — small, stable, dependency-free. */
function stableHash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

function resolveTabTitle(app: ViewContextSource, panelKind: string, activeTabId?: string): string | undefined {
  if (!activeTabId) return undefined
  // Chat tabs are sessions — use the human session title.
  if (panelKind === 'chat') {
    const s = app.chat?.sessions?.find((x) => x.id === activeTabId)
    const t = s?.title?.trim()
    return t && t !== 'New Chat' ? t : undefined
  }
  return undefined
}

/**
 * Build the current-view snapshot. Returns undefined (never throws) when there's
 * no focused panel or anything goes wrong — a failed capture must not block send.
 */
export function buildViewSnapshot(app: ViewContextSource, clientId?: string): ViewSnapshot | undefined {
  try {
    const focusedPanelId = app.layout?.tree?.focusedPanelId
    if (!focusedPanelId || !app.layout?.getPanelKindById) return undefined
    const rawKind = app.layout.getPanelKindById(focusedPanelId)
    const activePanelKind = (rawKind ? String(rawKind) : 'unknown')
    const binding = app.layout.tree?.panelTabs?.[focusedPanelId]
    const activeTabId = binding?.activeTabId
    const activeTabTitle = resolveTabTitle(app, activePanelKind, activeTabId)
    const desc = KIND_DESCRIPTIONS[activePanelKind] || `the ${activePanelKind} panel`
    const summary = `The user is currently on ${desc}${activeTabTitle ? ` (tab: "${activeTabTitle}")` : ''}.`
    const hash = stableHash(`${activePanelKind}|${activeTabTitle || ''}|${summary}`)
    return {
      capturedAt: new Date().toISOString(),
      clientId,
      activePanelKind: activePanelKind as ViewSnapshot['activePanelKind'],
      focusedPanelId,
      activeTabId,
      activeTabTitle,
      summary,
      hash,
    }
  } catch {
    return undefined
  }
}
