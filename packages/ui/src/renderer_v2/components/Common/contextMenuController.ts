/**
 * Singleton controller for the in-app right-click context menu.
 *
 * The legacy design used Electron's native `Menu.popup` via IPC, which is
 * a no-op when the UI is served over the web (browser hits
 * `gyshell-web-shim.ts` where the function literally does nothing). Both
 * the electron preload bridge and the web shim now forward to this
 * controller, and a single React component (ContextMenuOverlay) renders
 * the popover — same visual everywhere, no platform branching at the
 * call sites.
 */

export type ContextMenuAction = 'copy' | 'paste' | 'replace'

export interface ContextMenuOpenPayload {
  id: string
  canCopy: boolean
  canPaste: boolean
  /** Pixel coordinates of the click. The overlay clamps to the viewport. */
  x: number
  y: number
  /**
   * Optional spelling suggestions to render above Copy/Paste with a
   * separator. Clicking one fires a 'replace' action with the suggestion
   * string in `payload`. The caller is responsible for replacing the
   * misspelled word in its own DOM/state.
   */
  suggestions?: string[]
}

export interface ContextMenuActionEvent {
  id: string
  action: ContextMenuAction
  /** For 'replace' actions, the suggestion string the user picked. */
  payload?: string
}

type OpenHandler = (payload: ContextMenuOpenPayload) => void
type ActionListener = (data: ContextMenuActionEvent) => void

let openHandler: OpenHandler | null = null
const actionListeners = new Set<ActionListener>()

/** ContextMenuOverlay registers itself here on mount. */
export function setContextMenuOpenHandler(fn: OpenHandler | null): void {
  openHandler = fn
}

/** Called by the preload bridge / web shim to request the menu. */
export function showContextMenu(payload: ContextMenuOpenPayload): void {
  if (!openHandler) {
    // Overlay isn't mounted yet — silently drop. This matches the electron
    // IPC behavior (which would also fail if the window weren't ready).
    return
  }
  openHandler(payload)
}

/** ContextMenuOverlay calls this when the user clicks an item. */
export function dispatchContextMenuAction(data: ContextMenuActionEvent): void {
  for (const listener of actionListeners) {
    try {
      listener(data)
    } catch {
      // listener errors don't break siblings
    }
  }
}

/** Call sites subscribe via window.gyshell.ui.onContextMenuAction → here. */
export function subscribeContextMenuAction(cb: ActionListener): () => void {
  actionListeners.add(cb)
  return () => actionListeners.delete(cb)
}
