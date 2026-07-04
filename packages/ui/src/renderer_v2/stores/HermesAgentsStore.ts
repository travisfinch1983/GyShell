/**
 * MobX store over the Hermes control-plane adapter (hermesApi.ts) — backs the
 * Agents primary tab: agent list, per-agent specs (read-back), the unified
 * model catalog for the builder's picker, and create/delete actions.
 *
 * Module singleton, same pattern as ClaudeInstancesStore.
 */
import { makeAutoObservable, runInAction } from 'mobx'
import type { CatalogModel, HermesAgentSpec } from '@gyshell/shared'
import { hermesApi } from './hermesApi'

class HermesAgentsStore {
  agents: string[] = []
  /** id → { model?, visionCapable? } (backend heuristic off the stored spec's model). */
  capabilities: Record<string, { model?: string; visionCapable?: boolean }> = {}
  /** id → spec from read-back; null = route answered nothing (spec unknown). */
  specs = new Map<string, HermesAgentSpec | null>()
  catalog: CatalogModel[] = []
  loaded = false
  catalogLoaded = false
  busyIds = new Set<string>()
  error: string | null = null

  constructor() {
    makeAutoObservable(this)
  }

  async refresh(): Promise<void> {
    try {
      const { agents, capabilities } = await hermesApi.listAgents()
      runInAction(() => {
        this.agents = agents
        this.capabilities = capabilities
        this.loaded = true
        this.error = null
      })
      // Best-effort spec read-back per agent (null until claude1's route lands).
      await Promise.all(
        agents.map(async (id) => {
          const spec = await hermesApi.getSpec(id)
          runInAction(() => this.specs.set(id, spec))
        }),
      )
    } catch (e) {
      runInAction(() => {
        this.loaded = true
        this.error = String((e as Error)?.message ?? e)
      })
    }
  }

  async loadCatalog(): Promise<void> {
    try {
      const catalog = await hermesApi.listCatalog()
      runInAction(() => {
        this.catalog = catalog
        this.catalogLoaded = true
      })
    } catch (e) {
      runInAction(() => {
        this.catalogLoaded = true
        this.error = String((e as Error)?.message ?? e)
      })
    }
  }

  /** Create/update an agent from a spec; refreshes the list on success. */
  async apply(spec: HermesAgentSpec): Promise<{ ok: boolean; error?: string }> {
    this.busyIds.add(spec.agentId)
    try {
      const r = await hermesApi.apply(spec)
      if (r.ok) {
        runInAction(() => this.specs.set(spec.agentId, spec))
        await this.refresh()
      }
      return r
    } finally {
      runInAction(() => this.busyIds.delete(spec.agentId))
    }
  }

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    this.busyIds.add(id)
    try {
      const r = await hermesApi.remove(id)
      if (r.ok) {
        runInAction(() => {
          this.agents = this.agents.filter((a) => a !== id)
          this.specs.delete(id)
        })
      }
      return r
    } finally {
      runInAction(() => this.busyIds.delete(id))
    }
  }
}

export const hermesAgentsStore = new HermesAgentsStore()
