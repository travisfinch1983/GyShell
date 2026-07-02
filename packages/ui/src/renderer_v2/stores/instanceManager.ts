/**
 * Instance-manager adapter — Claude fleet consolidation Phase 3.
 *
 * ⚠ CONTRACT STATUS: MOCKED GUESS. claude1 owns the instance-manager (Phase 1)
 * and will freeze the real API contract; when it lands, update the types +
 * `RealInstanceManagerApi` endpoints in THIS FILE ONLY — the store and UI
 * consume the adapter interface and should not need changes.
 *
 * Until the real endpoint responds, the store falls back to a mock (in-memory,
 * clearly bannered in the UI) so the whole Phase-3 surface is buildable and
 * demoable now.
 */

export type InstanceStatus = 'running' | 'stopped' | 'auth-needed' | 'unknown'

export interface ClusterPermissions {
  /** vmid of the container this instance primarily operates in (advisory). */
  primaryVmid: number | null
  /** 'all', or the explicit vmid allow-list. Advisory — not hard-enforced. */
  allowed: 'all' | number[]
}

export interface ClaudeInstance {
  id: string
  name: string
  /** Unix user on CT161 backing this instance. */
  user: string
  status: InstanceStatus
  /** true right after create, until /login completes. */
  needsLogin?: boolean
  createdAt?: string
  permissions: ClusterPermissions
}

export type ControlAction = 'exit' | 'resume-continue' | 'resume-pick' | 'restart'

export interface InstanceManagerApi {
  /** Distinguishes the real backend from the mock so the UI can banner it. */
  readonly mocked: boolean
  list(): Promise<ClaudeInstance[]>
  create(name: string): Promise<ClaudeInstance>
  rename(id: string, name: string): Promise<void>
  remove(id: string): Promise<void>
  control(id: string, action: ControlAction): Promise<{ ok: boolean; error?: string }>
  setPermissions(id: string, permissions: ClusterPermissions): Promise<void>
  /** ttyd URL for the instance's terminal iframe. */
  termUrl(id: string): string
}

function bridge(): any {
  return (window as any).gyshell?.cluster
}

/** Guessed endpoint shapes — REPLACE with claude1's frozen contract. */
class RealInstanceManagerApi implements InstanceManagerApi {
  readonly mocked = false
  async list(): Promise<ClaudeInstance[]> {
    const r = await bridge().request('GET', '/api/claude/instances')
    return (r?.instances ?? []) as ClaudeInstance[]
  }
  async create(name: string): Promise<ClaudeInstance> {
    const r = await bridge().request('POST', '/api/claude/instances', { name })
    return r?.instance ?? r
  }
  async rename(id: string, name: string): Promise<void> {
    await bridge().request('PUT', `/api/claude/instances/${encodeURIComponent(id)}`, { name })
  }
  async remove(id: string): Promise<void> {
    await bridge().request('DELETE', `/api/claude/instances/${encodeURIComponent(id)}`)
  }
  async control(id: string, action: ControlAction): Promise<{ ok: boolean; error?: string }> {
    const r = await bridge().request('POST', `/api/claude/instances/${encodeURIComponent(id)}/control`, { action })
    return { ok: r?.ok !== false, error: r?.error }
  }
  async setPermissions(id: string, permissions: ClusterPermissions): Promise<void> {
    await bridge().request('PUT', `/api/claude/instances/${encodeURIComponent(id)}/permissions`, permissions)
  }
  termUrl(id: string): string {
    return `/api/claude/instances/${encodeURIComponent(id)}/term/`
  }
}

/** In-memory mock so the UI is fully demoable before Phases 1-2 land. */
class MockInstanceManagerApi implements InstanceManagerApi {
  readonly mocked = true
  private instances: ClaudeInstance[] = [
    {
      id: 'claude1',
      name: 'claude1',
      user: 'root',
      status: 'running',
      createdAt: '2026-07-02T00:00:00Z',
      permissions: { primaryVmid: 161, allowed: 'all' },
    },
    {
      id: 'fable-builder',
      name: 'fable-builder',
      user: 'fable',
      status: 'running',
      createdAt: '2026-07-02T01:00:00Z',
      permissions: { primaryVmid: 161, allowed: [152, 161] },
    },
  ]
  async list(): Promise<ClaudeInstance[]> {
    return this.instances.map((i) => ({ ...i, permissions: { ...i.permissions } }))
  }
  async create(name: string): Promise<ClaudeInstance> {
    const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '') || `instance-${this.instances.length}`
    if (this.instances.some((i) => i.id === id)) throw new Error(`instance "${id}" already exists`)
    const instance: ClaudeInstance = {
      id,
      name,
      user: id,
      status: 'auth-needed',
      needsLogin: true,
      createdAt: new Date().toISOString(),
      permissions: { primaryVmid: null, allowed: [] },
    }
    this.instances.push(instance)
    return { ...instance }
  }
  async rename(id: string, name: string): Promise<void> {
    const i = this.instances.find((x) => x.id === id)
    if (i) i.name = name
  }
  async remove(id: string): Promise<void> {
    this.instances = this.instances.filter((x) => x.id !== id)
  }
  async control(id: string, action: ControlAction): Promise<{ ok: boolean; error?: string }> {
    const i = this.instances.find((x) => x.id === id)
    if (!i) return { ok: false, error: 'not found' }
    if (action === 'exit') i.status = 'stopped'
    else i.status = 'running'
    return { ok: true }
  }
  async setPermissions(id: string, permissions: ClusterPermissions): Promise<void> {
    const i = this.instances.find((x) => x.id === id)
    if (i) i.permissions = { ...permissions, allowed: permissions.allowed === 'all' ? 'all' : [...permissions.allowed] }
  }
  termUrl(_id: string): string {
    return 'about:blank' // no live terminal in mock mode; the UI shows a placeholder instead
  }
}

/**
 * Probe the real API once; fall back to the mock when it isn't deployed yet.
 * The store surfaces `api.mocked` so the UI banners mock mode honestly.
 */
export async function resolveInstanceManagerApi(): Promise<InstanceManagerApi> {
  const real = new RealInstanceManagerApi()
  try {
    await real.list()
    return real
  } catch {
    return new MockInstanceManagerApi()
  }
}
