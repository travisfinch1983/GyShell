/**
 * GyShell Web Shim
 *
 * Provides window.gyshell API for the desktop renderer UI running in a browser.
 * Wraps the WebSocket GatewayClient to expose the same interface as the Electron preload.
 *
 * This allows the desktop renderer (packages/ui/src/renderer_v2) to work
 * unchanged in a web browser by routing all IPC calls through WebSocket RPC.
 */

import { GatewayClient } from '../../../packages/mobile-web/src/gateway-client'
import type { GatewayEvent, UIUpdateAction } from '../../../packages/mobile-web/src/types'

// ─── Gateway Client ──────────────────────────────────────────────────────────

const client = new GatewayClient()

// Auto-connect to the backend gateway
const GATEWAY_URL =
  (window as any).__GYSHELL_GATEWAY_URL__ ||
  `ws://${window.location.hostname}:17888`

let connected = false
let connecting = false

async function ensureConnected(): Promise<void> {
  if (connected) return
  if (connecting) {
    // Wait for in-flight connection
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (connected) {
          clearInterval(check)
          resolve()
        }
      }, 100)
    })
    return
  }
  connecting = true
  try {
    await client.connect(GATEWAY_URL, 5000)
    connected = true
  } catch (e) {
    console.error('[gyshell-web] Connection failed:', e)
    // Retry in 3 seconds
    setTimeout(() => {
      connecting = false
      ensureConnected()
    }, 3000)
    throw e
  } finally {
    connecting = false
  }
}

client.on('status', (status) => {
  connected = status === 'connected'
  if (status === 'disconnected') {
    // Auto-reconnect
    setTimeout(() => ensureConnected().catch(() => {}), 2000)
  }
})

// ─── RPC Helper ──────────────────────────────────────────────────────────────

async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  await ensureConnected()
  return client.request<T>(method, params)
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

type CleanupFn = () => void

// Track raw channel listeners
const rawListeners = new Map<string, Set<(data: any) => void>>()

function onRaw(channel: string, callback: (data: any) => void): CleanupFn {
  if (!rawListeners.has(channel)) {
    rawListeners.set(channel, new Set())
  }
  rawListeners.get(channel)!.add(callback)
  return () => {
    rawListeners.get(channel)?.delete(callback)
  }
}

// Route incoming gateway events to listeners
client.on('raw', (channel: string, payload: unknown) => {
  const listeners = rawListeners.get(channel)
  if (listeners) {
    listeners.forEach((cb) => {
      try {
        cb(payload)
      } catch (e) {
        console.error(`[gyshell-web] Listener error for ${channel}:`, e)
      }
    })
  }
})

// UI Update listeners
const uiUpdateListeners = new Set<(action: UIUpdateAction) => void>()
client.on('uiUpdate', (action) => {
  uiUpdateListeners.forEach((cb) => {
    try {
      cb(action)
    } catch (e) {
      console.error('[gyshell-web] UI update listener error:', e)
    }
  })
})

// Gateway event listeners
const gatewayEventListeners = new Set<(event: GatewayEvent) => void>()
client.on('gatewayEvent', (event) => {
  gatewayEventListeners.forEach((cb) => {
    try {
      cb(event)
    } catch (e) {
      console.error('[gyshell-web] Gateway event listener error:', e)
    }
  })
})

// ─── window.gyshell API Shim ─────────────────────────────────────────────────

const gyshellApi = {
  system: {
    platform: 'linux' as NodeJS.Platform, // Assume linux for web
    openExternal: async (url: string) => {
      window.open(url, '_blank')
    },
    saveTempPaste: (content: string) => rpc('system:saveTempPaste', { content }),
    saveImageAttachment: (payload: any) => rpc('system:saveImageAttachment', { payload }),
  },

  gateway: {
    isSameMachine: async () => false, // Web client is always remote
  },

  windowing: {
    openDetached: async (_token: string, _sourceId: string) => {
      // Not supported in web — could open new tab in future
      console.warn('[gyshell-web] Detached windows not supported in web mode')
    },
    onMainWindowClosing: (_callback: () => void): CleanupFn => {
      // No-op for web — browser handles tab close
      return () => {}
    },
  },

  windowControls: {
    minimize: async () => {},   // No-op for web
    maximize: async () => {
      if (document.fullscreenElement) {
        document.exitFullscreen()
      } else {
        document.documentElement.requestFullscreen()
      }
    },
    close: async () => {
      window.close()
    },
  },

  settings: {
    get: () => rpc('settings:get'),
    set: (settings: any) => rpc('settings:set', { settings }),
    setWsGatewayAccess: (access: any) => rpc('settings:setWsGatewayAccess', { access }),
    setWsGatewayConfig: (ws: any) => rpc('settings:setWsGatewayConfig', { ws }),
    openCommandPolicyFile: async () => {
      console.warn('[gyshell-web] Cannot open files in web mode')
    },
    getCommandPolicyLists: () => rpc('settings:getCommandPolicyLists'),
    addCommandPolicyRule: (listName: string, rule: any) =>
      rpc('settings:addCommandPolicyRule', { listName, rule }),
    deleteCommandPolicyRule: (listName: string, rule: any) =>
      rpc('settings:deleteCommandPolicyRule', { listName, rule }),
  },

  accessTokens: {
    list: () => rpc('access-tokens:list'),
    create: (name: string) => rpc('access-tokens:create', { name }),
    delete: (id: string) => rpc('access-tokens:delete', { id }),
  },

  uiSettings: {
    get: () => rpc('ui-settings:get'),
    set: (settings: any) => rpc('ui-settings:set', { settings }),
  },

  terminal: {
    list: () => rpc('terminal:list'),
    createTab: (config: any) => rpc('terminal:createTab', { config }),
    write: (terminalId: string, data: string) =>
      rpc('terminal:write', { terminalId, data }),
    writePaths: (terminalId: string, paths: string[]) =>
      rpc('terminal:writePaths', { terminalId, paths }),
    resize: (terminalId: string, cols: number, rows: number) =>
      rpc('terminal:resize', { terminalId, cols, rows }),
    kill: (terminalId: string) => rpc('terminal:kill', { terminalId }),
    setSelection: (terminalId: string, selectionText: string) =>
      rpc('terminal:setSelection', { terminalId, selectionText }),
    getBufferDelta: (terminalId: string, fromOffset: number) =>
      rpc('terminal:getBufferDelta', { terminalId, fromOffset }),
    generateCommandDraft: (terminalId: string, prompt: string, profileId?: string) =>
      rpc('terminal:generateCommandDraft', { terminalId, prompt, profileId }),
    onData: (callback: (data: any) => void): CleanupFn =>
      onRaw('terminal:data', callback),
    onExit: (callback: (data: any) => void): CleanupFn =>
      onRaw('terminal:exit', callback),
    onTabsUpdated: (callback: (data: any) => void): CleanupFn =>
      onRaw('terminal:tabs', callback),
    onRecoveryHint: (callback: (data: any) => void): CleanupFn =>
      onRaw('terminal:recoveryHint', callback),
  },

  filesystem: {
    list: (terminalId: string, dirPath: string) =>
      rpc('filesystem:list', { terminalId, dirPath }),
    readTextFile: (terminalId: string, filePath: string, options?: any) =>
      rpc('filesystem:readTextFile', { terminalId, filePath, options }),
    readFileBase64: (terminalId: string, filePath: string, options?: any) =>
      rpc('filesystem:readFileBase64', { terminalId, filePath, options }),
    writeTextFile: (terminalId: string, filePath: string, content: string) =>
      rpc('filesystem:writeTextFile', { terminalId, filePath, content }),
    rename: (terminalId: string, oldPath: string, newPath: string) =>
      rpc('filesystem:rename', { terminalId, oldPath, newPath }),
    delete: (terminalId: string, entryPath: string) =>
      rpc('filesystem:delete', { terminalId, entryPath }),
    createDirectory: (terminalId: string, dirPath: string) =>
      rpc('filesystem:createDirectory', { terminalId, dirPath }),
    transferEntries: (terminalId: string, entries: any[], destination: string, mode: string) =>
      rpc('filesystem:transferEntries', { terminalId, entries, destination, mode }),
    onTransferProgress: (callback: (data: any) => void): CleanupFn =>
      onRaw('filesystem:transferProgress', callback),
    getContextualPath: (terminalId: string) =>
      rpc('filesystem:getContextualPath', { terminalId }),
  },

  monitor: {
    subscribe: () => rpc('monitor:subscribe'),
    unsubscribe: () => rpc('monitor:unsubscribe'),
    snapshot: () => rpc('monitor:snapshot'),
    onSnapshot: (callback: (data: any) => void): CleanupFn =>
      onRaw('monitor:snapshot', callback),
  },

  ui: {
    showContextMenu: async (_menuTemplate: any[]) => {
      // Native context menus not available in web — could implement custom menu
      console.warn('[gyshell-web] Native context menus not available in web mode')
    },
    onContextMenuAction: (_callback: (data: any) => void): CleanupFn => {
      return () => {}
    },
  },

  agent: {
    startTask: (sessionId: string, message: string, options?: any) =>
      rpc('agent:startTask', { sessionId, message, ...options }),
    stopTask: (sessionId: string) => rpc('agent:stopTask', { sessionId }),
    replyMessage: (sessionId: string, message: string, options?: any) =>
      rpc('agent:replyMessage', { sessionId, message, ...options }),
    deleteChatSession: (sessionId: string) =>
      rpc('agent:deleteChatSession', { sessionId }),
    exportHistory: async (sessionId: string) => {
      const data = await rpc<string>('agent:exportHistory', { sessionId })
      // Download as file in browser
      const blob = new Blob([data as string], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `chat-${sessionId}.md`
      a.click()
      URL.revokeObjectURL(url)
    },
    getAllChatHistory: () => rpc('agent:getAllChatHistory'),
    loadChatSession: (sessionId: string) =>
      rpc('agent:loadChatSession', { sessionId }),
    getUiMessages: (sessionId: string) =>
      rpc('agent:getUiMessages', { sessionId }),
    getSessionSnapshot: (sessionId: string) =>
      rpc('agent:getSessionSnapshot', { sessionId }),
    getProfiles: () => rpc('agent:getProfiles'),
    setActiveProfile: (profileId: string) =>
      rpc('agent:setActiveProfile', { profileId }),
    probeModel: (config: any) => rpc('agent:probeModel', { config }),
    onEvent: (callback: (event: any) => void): CleanupFn => {
      const unsub = client.on('gatewayEvent', (event) => {
        if (event.type === 'agent:event') {
          callback(event)
        }
      })
      return unsub
    },
    onUiUpdate: (callback: (action: any) => void): CleanupFn => {
      const unsub = client.on('uiUpdate', callback)
      return unsub
    },
  },

  models: {
    probeCapabilities: (config: any) => rpc('models:probeCapabilities', { config }),
  },

  tools: {
    reloadMcp: () => rpc('tools:reloadMcp'),
    getMcpServers: () => rpc('tools:getMcpServers'),
    setMcpEnabled: (serverId: string, enabled: boolean) =>
      rpc('tools:setMcpEnabled', { serverId, enabled }),
    getBuiltInTools: () => rpc('tools:getBuiltInTools'),
    setBuiltInEnabled: (toolId: string, enabled: boolean) =>
      rpc('tools:setBuiltInEnabled', { toolId, enabled }),
    onMcpUpdated: (callback: (data: any) => void): CleanupFn =>
      onRaw('tools:mcpUpdated', callback),
    onBuiltInUpdated: (callback: (data: any) => void): CleanupFn =>
      onRaw('tools:builtInUpdated', callback),
  },

  themes: {
    loadCustom: () => rpc('themes:loadCustom'),
    getCustomCSS: () => rpc('themes:getCustomCSS'),
  },

  skills: {
    reload: () => rpc('skills:reload'),
    getAll: () => rpc('skills:getAll'),
    create: (name: string) => rpc('skills:create', { name }),
    setEnabled: (id: string, enabled: boolean) =>
      rpc('skills:setEnabled', { id, enabled }),
    listFolderSkills: () => rpc('skills:listFolderSkills'),
    onUpdated: (callback: (data: any) => void): CleanupFn =>
      onRaw('skills:updated', callback),
  },

  memory: {
    get: () => rpc('memory:get'),
    setContent: (content: string) => rpc('memory:setContent', { content }),
    openFile: async () => {
      console.warn('[gyshell-web] Cannot open files in web mode')
    },
  },

  version: {
    getCurrent: () => rpc('version:getCurrent'),
    getUpdateInfo: () => rpc('version:getUpdateInfo'),
  },

  mobileWeb: {
    getStatus: () => rpc('mobileWeb:getStatus'),
    start: (config: any) => rpc('mobileWeb:start', { config }),
    stop: () => rpc('mobileWeb:stop'),
  },
}

// ─── Install the shim ────────────────────────────────────────────────────────

;(window as any).gyshell = gyshellApi

// Start connecting immediately
ensureConnected().catch(() => {
  console.warn('[gyshell-web] Initial connection failed, will retry...')
})

export { gyshellApi, client, ensureConnected }
