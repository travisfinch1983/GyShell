/**
 * GyShell Web Shim
 *
 * Provides window.gyshell API for the desktop renderer UI running in a browser.
 * Wraps the WebSocket GatewayClient to expose the same interface as the Electron preload.
 */

import { GatewayClient } from '../../../packages/mobile-web/src/gateway-client'

// ─── Gateway Client ──────────────────────────────────────────────────────────

const client = new GatewayClient()

const GATEWAY_TOKEN = (window as any).__GYSHELL_ACCESS_TOKEN__ || ''
const isSecure = window.location.protocol === 'https:'
// Derive the WS host from the current page host so this works for any deployment name.
// e.g. ai-lab.deeveeyant.com -> ai-lab-ws.deeveeyant.com
const pageHost = window.location.hostname
const wsHost = pageHost.includes('.')
  ? pageHost.replace(/^([^.]+)\./, '$1-ws.')
  : pageHost
const baseGatewayUrl =
  (window as any).__GYSHELL_GATEWAY_URL__ ||
  (isSecure
    ? `wss://${wsHost}`
    : `ws://${pageHost}:17888`)
const GATEWAY_URL = GATEWAY_TOKEN
  ? `${baseGatewayUrl}?access_token=${encodeURIComponent(GATEWAY_TOKEN)}`
  : baseGatewayUrl

let connected = false
let connecting = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = 2000
const MAX_BACKOFF_MS = 30000
const CONNECT_WAIT_MS = 12000
// Callers awaiting the socket (RPCs issued on load or during a reconnect). Resolved on connect.
let connectedWaiters: Array<() => void> = []
function resolveConnectedWaiters(): void {
  const w = connectedWaiters
  connectedWaiters = []
  for (const r of w) { try { r() } catch { /* noop */ } }
}

// The ONLY function that opens a socket. Single-flighted: never runs two at once; a failure
// schedules exactly ONE backoff retry. (Multiple reconnect drivers previously MULTIPLIED into
// a 30k/s storm on a persistent failure — this keeps it to one attempt at a time.)
async function connectOnce(): Promise<void> {
  if (connected || connecting) return
  connecting = true
  try {
    await client.connect(GATEWAY_URL, 5000)
    connected = true
    backoffMs = 2000
    resolveConnectedWaiters()
  } catch {
    connected = false
  } finally {
    connecting = false
  }
  if (!connected) scheduleReconnect()
}

function scheduleReconnect(): void {
  if (reconnectTimer || connected || connecting) return
  console.warn(`[gyshell-web] gateway offline — retrying in ${Math.round(backoffMs / 1000)}s`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connectOnce()
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
}

// RPC callers use this. Kicks a single background connect when idle, then WAITS (bounded) for
// the socket — so RPCs issued on load or mid-reconnect don't fire before it's open (that race
// caused the "Gateway socket is not connected" bootstrap failures). Never spawns parallel
// connects: many concurrent callers all await the one shared connection.
async function ensureConnected(): Promise<void> {
  if (connected) return
  if (!connecting && !reconnectTimer) void connectOnce()
  if (connected) return
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    connectedWaiters.push(finish)
    setTimeout(finish, CONNECT_WAIT_MS)
  })
}

client.on('status', (status) => {
  if (status === 'connected') {
    connected = true
    backoffMs = 2000
    resolveConnectedWaiters()
  } else if (status === 'disconnected') {
    connected = false
    scheduleReconnect()
  }
})

// ─── Wake-from-sleep liveness ────────────────────────────────────────────────
// A laptop sleep (or a dropped tunnel/VPN) leaves the socket HALF-OPEN: dead, but no close
// event ever fires. `connected` therefore stays true, ensureConnected() returns immediately,
// and every RPC fires into a void socket until it times out -- the "everything errors until I
// refresh the page" behaviour. GatewayClient's own gateway:ping heartbeat is supposed to catch
// this, but it is a setInterval (SUSPENDED while asleep, throttled in background tabs) and it
// silently no-ops whenever readyState is anything other than OPEN. So probe explicitly at the
// moments the user actually returns.
const LIVE_PROBE_TIMEOUT_MS = 5000
let probing = false

function forceReconnect(reason: string): void {
  // If a connect is already in flight, tearing it down and starting another just restarts the
  // race. Callers reach here on a failed liveness probe, where connecting is false.
  if (connecting) return
  console.warn(`[gyshell-web] gateway ${reason} — forcing reconnect`)
  connected = false
  try { client.disconnect() } catch { /* noop */ }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  backoffMs = 2000
  void connectOnce()
}

// A probe in flight is exposed so RPCs can WAIT for its verdict instead of racing it. Without
// this, switching back to a tab fired visibilitychange (starting the probe) while the panel it
// revealed immediately issued RPCs — those RPCs hit the not-yet-detected dead socket and failed
// with "RPC timeout"/"Socket closed" before forceReconnect had run. That is the "open the
// downloader after a while, get an RPC or gateway error, refresh the page" behaviour.
let probePromise: Promise<void> | null = null

/** Bounded probe: does the socket ACTUALLY answer, regardless of what readyState claims? */
async function verifyGatewayLive(): Promise<void> {
  if (probing) return probePromise ?? undefined
  probing = true
  probePromise = (async () => {
    try {
      if (!connected) { void connectOnce(); return }
      try {
        await client.request('gateway:ping', {}, LIVE_PROBE_TIMEOUT_MS)
      } catch {
        forceReconnect('did not answer after wake')
      }
    } finally {
      probing = false
      probePromise = null
    }
  })()
  return probePromise
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void verifyGatewayLive()
  })
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => { void verifyGatewayLive() })
  window.addEventListener('online', () => { void verifyGatewayLive() })
}

// ─── RPC Helper ──────────────────────────────────────────────────────────────

async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  // Settle any in-flight liveness probe first, so an RPC issued the instant a tab regains focus
  // waits for the verdict rather than firing into a socket already known to be suspect.
  if (probePromise) { try { await probePromise } catch { /* probe never rejects meaningfully */ } }
  await ensureConnected()
  try {
    return await client.request<T>(method, params, timeoutMs)
  } catch (e) {
    // Retry ONLY when the request provably never left the client: request() throws this before
    // touching the socket. Anything else (socket closed mid-flight, RPC timeout) may already have
    // been executed server-side, and blindly retrying could apply a mutation twice.
    const msg = e instanceof Error ? e.message : String(e)
    if (!/socket is not connected/i.test(msg)) throw e
    // Deliberately do NOT forceReconnect() here. rpc() is the highest-concurrency path in the
    // app: when a panel mounts, a dozen calls can fail together, and a forceReconnect per
    // failure tears down the socket the previous one just opened — a connect/disconnect storm
    // in which no RPC ever completes. ensureConnected() is single-flighted, and the socket is
    // already gone (that is precisely why this threw), so there is nothing to tear down.
    console.warn(`[gyshell-web] "${method}" found the socket closed before sending — awaiting reconnect, retrying once`)
    await ensureConnected()
    return await client.request<T>(method, params, timeoutMs)
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

type CleanupFn = () => void
const rawListeners = new Map<string, Set<(data: any) => void>>()

function onRaw(channel: string, callback: (data: any) => void): CleanupFn {
  if (!rawListeners.has(channel)) rawListeners.set(channel, new Set())
  rawListeners.get(channel)!.add(callback)
  return () => { rawListeners.get(channel)?.delete(callback) }
}

client.on('raw', (channel: string, payload: unknown) => {
  rawListeners.get(channel)?.forEach((cb) => { try { cb(payload) } catch {} })
})

// ─── window.gyshell API ──────────────────────────────────────────────────────

const noop = async () => {}
const noopCleanup = (): CleanupFn => () => {}

const gyshellApi = {
  system: {
    platform: 'linux' as NodeJS.Platform,
    openExternal: async (url: string) => { window.open(url, '_blank') },
    saveTempPaste: (content: string) => rpc('system:saveTempPaste', { content }),
    saveImageAttachment: (payload: any) => rpc('system:saveImageAttachment', { payload }),
  },

  gateway: {
    isSameMachine: async () => false,
  },

  cluster: {
    // Backend-proxied (rule #1): the backend fetches ProxLab/PVE, never the browser.
    getStatus: () => rpc('cluster:getStatus'),
    request: (method: string, path: string, body?: unknown) =>
      rpc('cluster:request', { method, path, body }),
  },

  discovery: {
    // Server-side model/service discovery (rule #1): the backend runs the loop + owns
    // connection status; the browser just reads the cached snapshot on demand over the
    // gateway. ZERO browser fetches to any model/service.
    get: () => rpc('discovery:get'),
  },

  // Helper-Scripts installer stream (backend relays to ProxLab's node PTY; rule #1).
  catalogInstall: {
    start: (params: { host: string; command: string; cols?: number; rows?: number; setup?: { path: string; content: string } }) =>
      rpc('catalogInstall:start', params),
    listTemplates: (host: string) => rpc('catalogInstall:listTemplates', { host }),
    input: (id: string, data: string) => rpc('catalogInstall:input', { id, data }),
    resize: (id: string, cols: number, rows: number) => rpc('catalogInstall:resize', { id, cols, rows }),
    close: (id: string) => rpc('catalogInstall:close', { id }),
    onData: (cb: (data: any) => void): CleanupFn => onRaw('catalogInstall:data', cb),
    onExit: (cb: (data: any) => void): CleanupFn => onRaw('catalogInstall:exit', cb),
  },

  // AI-Lab Universal API Proxy routing state (the proxy itself is a separate HTTP listener).
  proxy: {
    getState: () => rpc('proxy:state'),
  },

  // Capability-based service-type detection (backend probes the endpoints).
  ai: {
    probeTypes: (items: Array<{ id: string; endpoint?: string }>) => rpc('ai:probeTypes', { items }),
  },

  // CivitAI model fetch for the Review browser (backend proxies civitai.com).
  civitai: {
    model: (modelId: string) => rpc('civitai:model', { modelId }),
  },

  metrics: {
    // Native charts (rule #1): backend queries Prometheus, UI renders with uPlot.
    queryRange: (query: string, rangeSeconds?: number, stepSeconds?: number) =>
      rpc('metrics:queryRange', { query, rangeSeconds, stepSeconds }),
    queryRangeBatch: (queries: string[], rangeSeconds?: number, stepSeconds?: number) =>
      rpc('metrics:queryRangeBatch', { queries, rangeSeconds, stepSeconds }),
    query: (query: string) => rpc('metrics:query', { query }),
    metricNames: () => rpc('metrics:metricNames'),
    labelValues: (label: string) => rpc('metrics:labelValues', { label }),
  },

  clusterSettings: {
    // Native settings on CT 152 (AI-Lab is the new ProxLab) — rule #1, backend-stored.
    get: () => rpc('clusterSettings:get'),
    set: (patch: unknown) => rpc('clusterSettings:set', { patch }),
    reveal: () => rpc('clusterSettings:reveal'),
    testPve: () => rpc('clusterSettings:testPve'),
  },

  notifications: {
    onEvent: (cb: (evt: any) => void): CleanupFn => onRaw('notify:event', cb),
    onDebug: (cb: (entry: any) => void): CleanupFn => onRaw('notify:debug', cb),
    onHealth: (cb: (health: any[]) => void): CleanupFn => onRaw('notify:health', cb),
    onAcked: (cb: (data: any) => void): CleanupFn => onRaw('notify:acked', cb),
    onTasks: (cb: (data: any) => void): CleanupFn => onRaw('notify:tasks', cb),
  },
  fleet: {
    // Fleet vertical: feed replay/live-tail, sends, guard config.
    send: (request: any) => rpc('fleet:send', request),
    replay: (afterSeq: number, limit?: number) => rpc('fleet:replay', { afterSeq, limit }),
    status: () => rpc('fleet:status'),
    setGuardConfig: (patch: any) => rpc('fleet:setGuardConfig', patch),
    onRecord: (cb: (record: any) => void): CleanupFn => onRaw('fleet:record', cb),
  },

  windowing: {
    openDetached: noop,
    onMainWindowClosing: noopCleanup,
  },

  windowControls: {
    minimize: noop,
    maximize: async () => {
      if (document.fullscreenElement) document.exitFullscreen()
      else document.documentElement.requestFullscreen()
    },
    close: async () => { window.close() },
  },

  settings: {
    get: () => rpc('settings:get'),
    set: (settings: any) => rpc('settings:set', { settings }),
    setWsGatewayAccess: (access: any) => rpc('settings:setWsGatewayAccess', { access }),
    setWsGatewayConfig: (ws: any) => rpc('settings:setWsGatewayConfig', { ws }),
    openCommandPolicyFile: noop,
    getCommandPolicyLists: () => rpc('settings:getCommandPolicyLists'),
    addCommandPolicyRule: (listName: string, rule: any) =>
      rpc('settings:addCommandPolicyRule', { listName, rule }),
    deleteCommandPolicyRule: (listName: string, rule: any) =>
      rpc('settings:deleteCommandPolicyRule', { listName, rule }),
  },

  accessTokens: {
    // access-tokens not exposed via WebSocket — stub with empty
    list: async () => [],
    create: async (_name: string) => { console.warn('[gyshell-web] Token management not available in web mode') },
    delete: async (_id: string) => { console.warn('[gyshell-web] Token management not available in web mode') },
  },

  uiSettings: {
    // Server-side + shared across all browsers/machines (rule #1 / single-user). Theme,
    // language, terminal, panel tabs, chat prefs, etc. persist on the backend and are served
    // to every UI. set() sends a partial patch that the server MERGES (never clobbers others).
    get: () => rpc('uiSettings:get'),
    set: (patch: any) => rpc('uiSettings:set', { patch }),
  },

  terminal: {
    list: () => rpc('terminal:list'),
    createTab: (config: any) => rpc('terminal:createTab', { config }),
    write: (terminalId: string, data: string) => rpc('terminal:write', { terminalId, data }),
    writePaths: (terminalId: string, paths: string[]) => rpc('terminal:writePaths', { terminalId, paths }),
    resize: (terminalId: string, cols: number, rows: number) =>
      rpc('terminal:resize', { terminalId, cols, rows }),
    kill: (terminalId: string) => rpc('terminal:kill', { terminalId }),
    setSelection: (terminalId: string, selectionText: string) =>
      rpc('terminal:setSelection', { terminalId, selectionText }),
    getBufferDelta: (terminalId: string, fromOffset: number) =>
      rpc('terminal:getBufferDelta', { terminalId, fromOffset }),
    generateCommandDraft: (terminalId: string, prompt: string, profileId?: string) =>
      rpc('terminal:generateCommandDraft', { terminalId, prompt, profileId }),
    onData: (cb: (data: any) => void): CleanupFn => onRaw('terminal:data', cb),
    onExit: (cb: (data: any) => void): CleanupFn => onRaw('terminal:exit', cb),
    onTabsUpdated: (cb: (data: any) => void): CleanupFn => onRaw('terminal:tabs', cb),
    onRecoveryHint: (cb: (data: any) => void): CleanupFn => onRaw('terminal:recoveryHint', cb),
  },

  filesystem: {
    list: (terminalId: string, dirPath: string) => rpc('filesystem:list', { terminalId, dirPath }),
    readTextFile: (terminalId: string, filePath: string, options?: any) =>
      rpc('filesystem:readTextFile', { terminalId, filePath, options }),
    readFileBase64: (terminalId: string, filePath: string, options?: any) =>
      rpc('filesystem:readFileBase64', { terminalId, filePath, options }),
    writeTextFile: (terminalId: string, filePath: string, content: string) =>
      rpc('filesystem:writeTextFile', { terminalId, filePath, content }),
    renamePath: (terminalId: string, oldPath: string, newPath: string) =>
      rpc('filesystem:rename', { terminalId, oldPath, newPath }),
    createFile: (terminalId: string, filePath: string) =>
      rpc('filesystem:createFile', { terminalId, filePath }),
    createDirectory: (terminalId: string, dirPath: string) =>
      rpc('filesystem:createDirectory', { terminalId, dirPath }),
    delete: (terminalId: string, entryPath: string) =>
      rpc('filesystem:delete', { terminalId, entryPath }),
    transferEntries: (terminalId: string, entries: any[], destination: string, mode: string) =>
      rpc('filesystem:transferEntries', { terminalId, entries, destination, mode }),
    onTransferProgress: (cb: (data: any) => void): CleanupFn => onRaw('filesystem:transferProgress', cb),
  },

  monitor: {
    subscribe: () => rpc('monitor:subscribe'),
    unsubscribe: () => rpc('monitor:unsubscribe'),
    stop: () => rpc('monitor:unsubscribe'),
    snapshot: () => rpc('monitor:snapshot'),
    onSnapshot: (cb: (data: any) => void): CleanupFn => onRaw('monitor:snapshot', cb),
  },

  ui: {
    showContextMenu: async (payload: any) => {
      // Lazy import keeps the controller module out of the shim's
      // import-time graph (the shim runs before React is ready).
      const ctl = await import(
        '../../../packages/ui/src/renderer_v2/components/Common/contextMenuController'
      )
      ctl.showContextMenu({
        id: payload.id,
        canCopy: !!payload.canCopy,
        canPaste: !!payload.canPaste,
        x: typeof payload.x === 'number' ? payload.x : 0,
        y: typeof payload.y === 'number' ? payload.y : 0,
        suggestions: Array.isArray(payload.suggestions) ? payload.suggestions : undefined,
      })
    },
    onContextMenuAction: (cb: any) => {
      // Synchronous subscribe — the controller is already loaded by the
      // time the React tree mounts and starts adding listeners.
      // We use a dynamic require pattern via a module-scope cached promise
      // so subsequent calls don't re-import.
      let unsubscribed = false
      let cleanup: (() => void) | null = null
      void import(
        '../../../packages/ui/src/renderer_v2/components/Common/contextMenuController'
      ).then((ctl) => {
        if (unsubscribed) return
        cleanup = ctl.subscribeContextMenuAction(cb)
      })
      return () => {
        unsubscribed = true
        if (cleanup) cleanup()
      }
    },
    spellCheck: (word: string) => rpc('ui:spellCheck', { word }),
  },

  agent: {
    startTask: (sessionId: string, message: string, options?: any) =>
      rpc('agent:startTask', { sessionId, userInput: message, options }, 600000),
    stopTask: (sessionId: string) => rpc('agent:stopTask', { sessionId }),
    replyMessage: (sessionId: string, message: string, options?: any) =>
      rpc('agent:replyMessage', { messageId: sessionId, payload: message, ...options }),
    deleteChatSession: (sessionId: string) => rpc('agent:deleteChatSession', { sessionId }),
    renameSession: (sessionId: string, name: string) =>
      rpc('agent:renameSession', { sessionId, newTitle: name }),
    rollbackToMessage: (sessionId: string, messageId: string) =>
      rpc('agent:rollbackToMessage', { sessionId, messageId }),
    formatMessagesMarkdown: (sessionId: string, messageIds?: string[]) =>
      rpc('agent:formatMessagesMarkdown', {
        sessionId,
        messageIds: Array.isArray(messageIds) ? messageIds : [],
      }).catch(() => ''),
    exportHistory: async (sessionId: string) => {
      const data = await rpc<string>('agent:exportHistory', { sessionId })
      const blob = new Blob([data as string], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `chat-${sessionId}.md`; a.click()
      URL.revokeObjectURL(url)
    },
    getAllChatHistory: () => rpc('agent:getAllChatHistory'),
    loadChatSession: (sessionId: string) => rpc('agent:loadChatSession', { sessionId }),
    getUiMessages: (sessionId: string) => rpc('agent:getUiMessages', { sessionId }),
    getSessionSnapshot: (sessionId: string) =>
      // Handler is registered as `session:get` (not `agent:getSessionSnapshot`)
      // and wraps its result as `{ session }`. Unwrap so callers see the bare
      // snapshot like the original electron preload behavior.
      rpc('session:get', { sessionId })
        .then((r: any) => r?.session ?? null)
        .catch(() => null),
    getProfiles: () => rpc('models:getProfiles'),
    setActiveProfile: (profileId: string) => rpc('models:setActiveProfile', { profileId }),
    probeModel: (config: any) => rpc('models:probe', { model: config }),
    onEvent: (cb: (event: any) => void): CleanupFn => {
      return client.on('gatewayEvent', (event) => {
        if (event.type === 'agent:event') cb(event)
      })
    },
    onUiUpdate: (cb: (action: any) => void): CleanupFn => {
      return client.on('uiUpdate', cb)
    },
  },

  models: {
    probe: async (config: any) => {
      console.log('[gyshell-web] models.probe called with:', JSON.stringify({model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey ? '***' : 'missing'}))
      const result = await rpc('models:probe', { model: config })
      console.log('[gyshell-web] models.probe result:', JSON.stringify(result))
      return result
    },
    probeCapabilities: (config: any) => rpc('models:probe', { model: config }),
    listRemote: (baseUrl: string, apiKey: string) => rpc('models:listRemote', { baseUrl, apiKey }),
  },

  tools: {
    reloadMcp: () => rpc('tools:reloadMcp'),
    getMcp: () => rpc('tools:getMcp'),
    getMcpServers: () => rpc('tools:getMcp'),
    setMcpEnabled: (serverId: string, enabled: boolean) =>
      rpc('tools:setMcpEnabled', { serverId, enabled }),
    getBuiltIn: () => rpc('tools:getBuiltIn'),
    getBuiltInTools: () => rpc('tools:getBuiltIn'),
    setBuiltInEnabled: (toolId: string, enabled: boolean) =>
      rpc('tools:setBuiltInEnabled', { name: toolId, enabled }),
    setBuiltInPermission: (toolId: string, permission: string) =>
      rpc('tools:setBuiltInPermission', { name: toolId, permission }),
    openMcpConfig: noop,
    onMcpUpdated: (cb: (data: any) => void): CleanupFn => onRaw('tools:mcpUpdated', cb),
    onBuiltInUpdated: (cb: (data: any) => void): CleanupFn => onRaw('tools:builtInUpdated', cb),
  },

  themes: {
    getCustom: () => rpc('themes:getCustom').catch(() => []),
    loadCustom: () => rpc('themes:loadCustom').catch(() => []),
    reloadCustom: () => rpc('themes:reloadCustom').catch(() => []),
    getCustomCSS: () => rpc('themes:getCustomCSS').catch(() => ''),
    openCustomConfig: noop,
  },

  skills: {
    reload: () => rpc('skills:reload'),
    getAll: () => rpc('skills:getAll'),
    getEnabled: () => rpc('skills:getEnabled').catch(() => []),
    create: (name?: string) => rpc('skills:create', { name }),
    importBatch: (skills: Array<{ name: string; description: string; content: string }>) =>
      rpc('skills:import', { skills }),
    delete: (fileName: string) => rpc('skills:delete', { fileName }),
    setEnabled: (name: string, enabled: boolean) => rpc('skills:setEnabled', { name, enabled }),
    listFolderSkills: () => rpc('skills:listFolderSkills').catch(() => []),
    openFolder: noop,
    openFile: (_fileName: string) => noop(),
    onUpdated: (cb: (data: any) => void): CleanupFn => onRaw('skills:updated', cb),
  },

  memory: {
    get: () => rpc('memory:get'),
    setContent: (content: string) => rpc('memory:setContent', { content }),
    openFile: noop,
  },

  agents: {
    getAll: () => rpc('agents:getAll').catch(() => []),
    save: (agent: any) => rpc('agents:save', { agent }),
    delete: (id: string) => rpc('agents:delete', { id }),
    onActiveCountsUpdated: (cb: (counts: Record<string, number>) => void): CleanupFn =>
      onRaw('agents:active', cb),
  },

  version: {
    getCurrent: () => rpc('version:getCurrent').catch(() => ({ version: 'web' })),
    getUpdateInfo: () => rpc('version:getUpdateInfo').catch(() => null),
    getState: async () => ({ current: 'web', latest: 'web', updateAvailable: false }),
    check: async () => ({ updateAvailable: false }),
  },

  mobileWeb: {
    getStatus: () => rpc('mobileWeb:getStatus').catch(() => ({ running: false })),
    start: (config: any) => rpc('mobileWeb:start', { config }),
    stop: () => rpc('mobileWeb:stop'),
    setPort: (port: number) => rpc('mobileWeb:setPort', { port }),
  },
}

// ─── Install ─────────────────────────────────────────────────────────────────

;(window as any).gyshell = gyshellApi

// Start connecting — the rpc() helper will await this before any call
ensureConnected().catch(() => {
  console.warn('[gyshell-web] Initial connection failed, will retry on first RPC call')
})

export { gyshellApi, client, ensureConnected }
