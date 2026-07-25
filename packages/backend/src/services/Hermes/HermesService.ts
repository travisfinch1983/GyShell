import { randomUUID } from 'crypto'
import { HermesManagementService } from './HermesManagementService'
import { HermesAcpBridge, type AcpEvent, type AcpHistory } from './HermesAcpBridge'
import type { HermesAgentSpec } from '@gyshell/shared'

export interface HermesServiceConfig {
  host: string // CT158
  sshKeyPath: string // AI-Lab key authorized on CT158
  /** JSON file where applied specs are persisted (for read-back / edit). */
  specsFile?: string
  /** JSON file where Provider Services entries (keyed non-model providers) are persisted. */
  providerServicesFile?: string
  /** JSON file where global Support-Models roles persist. */
  supportModelsFile?: string
}

/**
 * HermesService — facade over the two backend-owned Hermes services (control plane):
 *   - HermesManagementService: create/configure/delete agent PROFILES (SSH + CLIs).
 *   - HermesAcpBridge: persistent, backend-owned ACP session runner (headless invariant).
 *
 * Adds `runTurn` (prompt → collect the assistant reply → resolve), used by both the HTTP
 * prompt route and (next increment) the ConversationBus autonomous subscriber. Streaming
 * observers use `bridge.onEvent` directly (SSE/WS). Everything here is server-side; a
 * browser is never required for an agent to run or be driven.
 */
export class HermesService {
  readonly mgmt: HermesManagementService
  readonly bridge: HermesAcpBridge
  /** In-flight on-demand screen captures: requestId → resolver(base64 image). */
  private readonly pendingCaptures = new Map<string, (image: string) => void>()

  constructor(cfg: HermesServiceConfig) {
    this.mgmt = new HermesManagementService({ host: cfg.host, sshKeyPath: cfg.sshKeyPath, specsFile: cfg.specsFile, providerServicesFile: cfg.providerServicesFile, supportModelsFile: cfg.supportModelsFile })
    this.bridge = new HermesAcpBridge({ host: cfg.host, sshKeyPath: cfg.sshKeyPath })
  }

  listAgents(): Promise<string[]> {
    return this.mgmt.listAgents()
  }

  /** The persisted spec for an agent, or undefined (never applied through AI-Lab). */
  getSpec(agentId: string): HermesAgentSpec | undefined {
    return this.mgmt.getSpec(agentId)
  }

  reconstructSpec(agentId: string): Promise<Record<string, any> | null> {
    return this.mgmt.reconstructSpec(agentId)
  }

  addDocFromTemplate(agentId: string, templateRel: string): Promise<string> {
    return this.mgmt.addDocFromTemplate(agentId, templateRel)
  }

  listDocs(agentId: string): Promise<Array<{ path: string; bytes: number; protected: boolean }>> {
    return this.mgmt.listDocs(agentId)
  }

  deleteDoc(agentId: string, relpath: string): Promise<void> {
    return this.mgmt.deleteDoc(agentId, relpath)
  }

  listMemoryDocs(agentId: string): Promise<Array<{ path: string; bytes: number; protected: boolean }>> {
    return this.mgmt.listMemoryDocs(agentId)
  }

  readDoc(agentId: string, relpath: string): Promise<string> {
    return this.mgmt.readDoc(agentId, relpath)
  }

  writeDoc(agentId: string, relpath: string, content: string): Promise<void> {
    return this.mgmt.writeDoc(agentId, relpath, content)
  }

  getAgentTools(agentId: string): Promise<{ selected: string[]; scoped: boolean; endpoint: string | null }> {
    return this.mgmt.getAgentTools(agentId)
  }

  previewFleetAddresses() {
    return this.mgmt.previewFleetAddresses()
  }

  reconcileFleetAddresses() {
    return this.mgmt.reconcileFleetAddresses()
  }

  syncAgentTools(agentId: string, treeNames: string[]): Promise<{ endpoint: string; toolCount: number }> {
    // After the toolset is synced, reload the agent's live sessions so the change takes effect
    // immediately (via --resume: new tools, same history) with no manual restart.
    return this.mgmt.syncAgentTools(agentId, treeNames).then((r) => { this.bridge.reloadAgentSessions(agentId); return r })
  }

  resetAgentTools(agentId: string): Promise<void> {
    return this.mgmt.resetAgentTools(agentId).then(() => { this.bridge.reloadAgentSessions(agentId) })
  }

  /** Is the agent actually serving the tools its group holds? (Hermes gives up on MCP
   *  reconnect after 5 failures and then runs toolless until its gateway restarts.) */
  getToolHealth(agentId: string) {
    return this.mgmt.getToolHealth(agentId)
  }

  /** Restart the agent's gateway so it re-reads config and reconnects its MCP link. */
  reconnectAgentTools(agentId: string) {
    return this.mgmt.reconnectAgentTools(agentId).then((r) => { this.bridge.reloadAgentSessions(agentId); return r })
  }

  /** Tool-group snapshots taken before each change, newest first. */
  listToolBackups(agentId: string) {
    return this.mgmt.listToolBackups(agentId)
  }

  /** Restore a snapshot (revalidated against the live registry) and reconnect. */
  restoreToolBackup(agentId: string, file: string) {
    return this.mgmt.restoreToolBackup(agentId, file).then((r) => { this.bridge.reloadAgentSessions(agentId); return r })
  }

  /** Reload an agent's live sessions to pick up config/tool changes (new tools, same history). */
  reloadAgentSessions(agentId: string): { reloaded: number; deferred: number } {
    return this.bridge.reloadAgentSessions(agentId)
  }

  /** Edit / Regenerate / Delete the tail turn of a conversation (native rewind + session reload). */
  rewindTail(sessionKey: string, mode: 'edit' | 'regenerate' | 'delete', editedText?: string): Promise<{ ok: true; mode: string; rewound: number; targetText: string }> {
    return this.bridge.rewindTail(sessionKey, mode, editedText)
  }

  nativeToolCatalog(): Promise<Array<{ name: string; category: string }>> {
    return this.mgmt.nativeToolCatalog()
  }
  getAgentNativeTools(agentId: string): Promise<{ tools: Array<{ name: string; category: string; enabled: boolean }>; pluginInstalled: boolean }> {
    return this.mgmt.getAgentNativeTools(agentId)
  }
  setAgentNativeTools(agentId: string, disabled: string[]): Promise<{ applied: number; disabled: string[] }> {
    return this.mgmt.setAgentNativeTools(agentId, disabled)
  }
  setGlobalNativeTools(disabled: string[]): Promise<{ agents: number }> {
    return this.mgmt.setGlobalNativeTools(disabled)
  }

  listAgentLibraryDocs(agentId: string): Promise<Array<{ name: string; title: string; skill: string | null; pointed: boolean }>> {
    return this.mgmt.listAgentLibraryDocs(agentId)
  }

  listLibraryDocs(): Promise<Array<{ name: string; title: string; skills: string[] }>> {
    return this.mgmt.listLibraryDocs()
  }

  bondDoc(name: string, skill: string, bonded: boolean): Promise<void> { return this.mgmt.bondDoc(name, skill, bonded) }
  readLibraryDoc(name: string): Promise<string> { return this.mgmt.readLibraryDoc(name) }
  writeLibraryDoc(name: string, content: string): Promise<void> { return this.mgmt.writeLibraryDoc(name, content) }
  setAgentLibraryDoc(agentId: string, name: string, assigned: boolean): Promise<void> { return this.mgmt.setAgentLibraryDoc(agentId, name, assigned) }

  listAgentSkills(agentId: string): Promise<Array<{ ref: string; name: string; category: string; description: string; source: string; assigned: boolean }>> {
    return this.mgmt.listAgentSkills(agentId)
  }

  assignSkill(agentId: string, ref: string): Promise<void> {
    return this.mgmt.assignSkill(agentId, ref)
  }

  unassignSkill(agentId: string, ref: string): Promise<void> {
    return this.mgmt.unassignSkill(agentId, ref)
  }

  listLibrarySkills(): Promise<Array<{ ref: string; name: string; dir: string; category: string; description: string; source: string; tags: string[] }>> {
    return this.mgmt.listLibrarySkills()
  }

  readLibrarySkill(ref: string): Promise<string> {
    return this.mgmt.readLibrarySkill(ref)
  }

  writeLibrarySkill(ref: string, content: string): Promise<void> {
    return this.mgmt.writeLibrarySkill(ref, content)
  }
  setSkillTags(ref: string, tags: string[]): Promise<void> { return this.mgmt.setSkillTags(ref, tags) }
  listSkillTags(): Promise<Array<{ tag: string; count: number }>> { return this.mgmt.listSkillTags() }
  searchSkills(q: string): Promise<Array<{ ref: string; name: string; dir: string; category: string; description: string; source: string; tags: string[] }>> { return this.mgmt.searchSkills(q) }

  readSoul(agentId: string): Promise<string> {
    return this.mgmt.readSoul(agentId)
  }

  writeSoul(agentId: string, content: string): Promise<void> {
    return this.mgmt.writeSoul(agentId, content)
  }

  applySpec(spec: HermesAgentSpec): Promise<{ created: boolean; home: string }> {
    return this.mgmt.applySpec(spec)
  }

  getUserDoc(): Promise<string> { return this.mgmt.getUserDoc() }
  setUserDoc(markdown: string): Promise<{ agentsUpdated: number }> { return this.mgmt.setUserDoc(markdown) }

  getSupportModels(): ReturnType<HermesManagementService['getSupportModels']> {
    return this.mgmt.getSupportModels()
  }
  setSupportModels(roles: Parameters<HermesManagementService['setSupportModels']>[0], applyKeys?: string[]): Promise<{ agentsUpdated: number }> {
    return this.mgmt.setSupportModels(roles, applyKeys)
  }
  getAuxTasks(): ReturnType<HermesManagementService['getAuxTasks']> {
    return this.mgmt.getAuxTasks()
  }

  async deleteAgent(agentId: string): Promise<void> {
    this.bridge.stopSession(agentId)
    await this.mgmt.deleteAgent(agentId)
  }

  /** Ensure a live session and return its `ready` event (models/modes/commands).
   *  `sessionKey` scopes the session (a per-conversation id for chat tabs); defaults to
   *  the agentId (one-session-per-agent, e.g. the bus subscriber). */
  ensureReady(agentId: string, sessionKey: string = agentId): Promise<AcpEvent> {
    return this.bridge.ensureReady(sessionKey, agentId)
  }

  /** Subscribe to a session's normalized event stream (for SSE/WS observers). */
  onEvent(sessionKey: string, cb: (ev: AcpEvent) => void): () => void {
    return this.bridge.onEvent(sessionKey, cb)
  }

  /** End + WIPE a session (kill the backend process, drop its transcript). Used when a
   *  chat tab is closed so a same-agent reopen starts a brand-new conversation. */
  stopSession(sessionKey: string): void {
    this.bridge.stopSession(sessionKey)
  }

  /** Server-authoritative turn state (idle|busy) for a conversation — drives the UI Stop button. */
  getStatus(sessionKey: string): 'idle' | 'busy' {
    return this.bridge.getStatus(sessionKey)
  }

  /** Stop the in-flight turn (Stop button) — server forwards ACP session/cancel to the model. */
  cancelTurn(sessionKey: string): void {
    this.bridge.cancel(sessionKey)
  }

  /** Swap the model for a live conversation (per-conversation override; survives reconnect). */
  setSessionModel(sessionKey: string, modelId: string): void {
    this.bridge.setModel(sessionKey, modelId)
  }

  listConversations(): Array<{ conversationId: string; agentId: string; title?: string; lastActive: number }> {
    return this.bridge.listConversations()
  }

  /** On-demand screen capture for the page-aware `view_screen` MCP tool. Emits a
   *  `capture_request` to the most-recent conversation's stream, waits for the frontend to
   *  POST the image, writes it to the agent's workspace on CT158, and returns the LOCAL path
   *  its `vision_analyze` tool can read (an internal URL would be SSRF-blocked; a file is not). */
  async captureScreen(opts: { timeoutMs?: number } = {}): Promise<{ path: string }> {
    const target = this.bridge.mostRecentSession()
    if (!target) throw new Error('no active conversation to capture the screen for')
    const requestId = randomUUID()
    const image = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingCaptures.delete(requestId); reject(new Error('screen capture timed out — is the chat open?')) }, opts.timeoutMs ?? 20_000)
      this.pendingCaptures.set(requestId, (img) => { clearTimeout(timer); resolve(img) })
      if (!this.bridge.emitToSession(target.sessionKey, { t: 'capture_request', requestId })) {
        clearTimeout(timer); this.pendingCaptures.delete(requestId); reject(new Error('no live session to request a capture'))
      }
    })
    return { path: await this.mgmt.writeAgentScreenshot(target.agentId, image) }
  }

  /** Frontend calls this (via POST) once it has captured the screen, keyed by requestId. */
  resolveCapture(requestId: string, image: string): boolean {
    const r = this.pendingCaptures.get(requestId)
    if (!r) return false
    this.pendingCaptures.delete(requestId)
    r(image)
    return true
  }

  /** Fire a prompt WITHOUT waiting for the turn to finish — the reply arrives over the
   *  event stream (/stream). Used by the streaming chat so the HTTP call returns fast
   *  (an LLM turn can take minutes; the cluster-proxy RPC would otherwise time out). */
  async sendPrompt(agentId: string, text: string, opts: { context?: string; screenshot?: string; images?: string[]; sessionKey?: string } = {}): Promise<void> {
    const key = opts.sessionKey ?? agentId
    await this.bridge.ensureReady(key, agentId)
    this.bridge.prompt(key, text, { context: opts.context, screenshot: opts.screenshot, images: opts.images })
  }

  /**
   * Buffered transcript for a live session (read-back on reload). `since` returns only the
   * events after that seq. undefined if the backend-owned session isn't running (nothing
   * buffered — the transcript's lifetime is the session's, per the headless invariant).
   */
  getHistory(sessionKey: string, since = 0): AcpHistory | undefined {
    return this.bridge.getHistory(sessionKey, since)
  }

  /**
   * Drive one turn and resolve with the assembled assistant reply. Ensures the session,
   * prompts, collects `message` chunks until `turn_done`. Used by the HTTP prompt route
   * and the (deferred) bus subscriber.
   */
  async runTurn(agentId: string, text: string, opts: { timeoutMs?: number; context?: string; screenshot?: string; images?: string[]; sessionKey?: string } = {}): Promise<{ reply: string; stopReason?: string }> {
    const key = opts.sessionKey ?? agentId
    await this.bridge.ensureReady(key, agentId)
    const parts: string[] = []
    return new Promise<{ reply: string; stopReason?: string }>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`hermes runTurn timeout for ${agentId}`)) }, opts.timeoutMs ?? 240_000)
      const off = this.bridge.onEvent(key, (ev) => {
        if (ev.t === 'message') {
          parts.push(String((ev as { text?: unknown }).text ?? ''))
        } else if (ev.t === 'turn_done') {
          clearTimeout(timer); off()
          resolve({ reply: parts.join(''), stopReason: (ev as { stop_reason?: string }).stop_reason })
        } else if (ev.t === 'error') {
          clearTimeout(timer); off()
          reject(new Error(String((ev as { message?: unknown }).message ?? 'hermes acp error')))
        }
      })
      try {
        this.bridge.prompt(key, text, { context: opts.context, screenshot: opts.screenshot, images: opts.images })
      } catch (e) {
        clearTimeout(timer); off(); reject(e as Error)
      }
    })
  }

  dispose(): void {
    this.bridge.disposeAll()
  }
}
