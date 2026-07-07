import { makeAutoObservable, runInAction } from 'mobx'
import { hermesApi } from './hermesApi'
import { newUuid } from '../lib/uuid'

export interface ConvMeta { conversationId: string; agentId: string; title?: string; lastActive: number; local?: boolean }

/**
 * Shared, cross-panel source of truth for Hermes conversations. The full-page Chat tab
 * (AgentChatPanel) and the GlobalChat side panel BOTH read + mutate this store, so deleting a
 * conversation in one panel removes it from the other instantly (both are MobX observers).
 * Server-backed via GET /api/hermes/conversations; also holds local-only (unsent) new chats.
 */
class HermesConversationsStore {
  private map = new Map<string, ConvMeta>()
  constructor() { makeAutoObservable(this) }

  get list(): ConvMeta[] {
    return [...this.map.values()].sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))
  }
  has(conversationId: string): boolean { return this.map.has(conversationId) }

  /** Reconcile with the server registry: upsert server entries (authoritative), keep local-only
   *  new chats, and drop previously-server entries that vanished (deleted on another panel/device). */
  async refresh(): Promise<void> {
    const server = await hermesApi.conversations()
    runInAction(() => {
      const ids = new Set(server.map((c) => c.conversationId))
      for (const c of server) this.map.set(c.conversationId, { ...c, local: false })
      for (const [id, c] of [...this.map]) if (!ids.has(id) && !c.local) this.map.delete(id)
    })
  }

  /** Register an already-open conversation (e.g. a GlobalChat tab) so it shows in the other panel too. */
  ensure(conversationId: string, agentId: string): void {
    if (!this.map.has(conversationId)) runInAction(() => this.map.set(conversationId, { conversationId, agentId, lastActive: Date.now(), local: true }))
  }

  newChat(agentId: string): string {
    const cid = newUuid()
    runInAction(() => this.map.set(cid, { conversationId: cid, agentId, title: '', lastActive: Date.now(), local: true }))
    return cid
  }

  /** Delete everywhere: drop from the shared list (every panel re-renders) then wipe the backend. */
  async remove(conversationId: string, agentId: string): Promise<void> {
    runInAction(() => this.map.delete(conversationId))
    try { await hermesApi.endConversation(agentId, conversationId) } catch { /* best-effort */ }
  }
}

export const hermesConversationsStore = new HermesConversationsStore()
