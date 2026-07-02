/**
 * Instance-manager adapter — Claude fleet consolidation Phase 3.
 *
 * CONTRACT: FROZEN (ratified with claude1). The AI-Lab backend (CT152)
 * exposes /api/claude/instances* and proxies/SSHes to CT161 to manage the
 * per-user instances. If the contract ever changes, update THIS FILE ONLY —
 * the store and UI consume the adapter interface.
 *
 * The mock stays as a probe-fallback so the UI keeps working (bannered) until
 * claude1's Phase-1 backend lands.
 */

export type InstanceStatus = 'running' | 'stopped' | 'needs-login' | 'starting'

/** PUT /:id/permissions body. Advisory — not hard-enforced. */
export interface ClusterPermissions {
  /** vmid of the container this instance primarily operates in. */
  primaryVmid?: number | null
  /** 'all', or the explicit vmid allow-list. */
  allowed: 'all' | number[]
}

export interface ClaudeInstance {
  id: string
  name: string
  status: InstanceStatus
  primaryVmid?: number | null
  allowed: 'all' | number[]
  createdAt: string
  /** ttyd proxy path for this instance's dtach session. */
  termPath: string
}

export type ControlAction = 'exit' | 'resume-continue' | 'resume-pick' | 'restart'

export interface InstanceManagerApi {
  /** Distinguishes the real backend from the mock so the UI can banner it. */
  readonly mocked: boolean
  list(): Promise<ClaudeInstance[]>
  create(name: string): Promise<ClaudeInstance>
  rename(id: string, name: string): Promise<ClaudeInstance>
  remove(id: string): Promise<void>
  control(id: string, action: ControlAction): Promise<{ ok: boolean; status?: InstanceStatus; error?: string }>
  setPermissions(id: string, permissions: ClusterPermissions): Promise<ClaudeInstance>
}

function bridge(): any {
  return (window as any).gyshell?.cluster
}

/** The frozen contract endpoints. */
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
  async rename(id: string, name: string): Promise<ClaudeInstance> {
    const r = await bridge().request('POST', `/api/claude/instances/${encodeURIComponent(id)}/rename`, { name })
    return r?.instance ?? r
  }
  async remove(id: string): Promise<void> {
    await bridge().request('DELETE', `/api/claude/instances/${encodeURIComponent(id)}`)
  }
  async control(id: string, action: ControlAction): Promise<{ ok: boolean; status?: InstanceStatus; error?: string }> {
    const r = await bridge().request('POST', `/api/claude/instances/${encodeURIComponent(id)}/control`, { action })
    return { ok: r?.ok !== false, status: r?.status, error: r?.error }
  }
  async setPermissions(id: string, permissions: ClusterPermissions): Promise<ClaudeInstance> {
    const r = await bridge().request('PUT', `/api/claude/instances/${encodeURIComponent(id)}/permissions`, permissions)
    return r?.instance ?? r
  }
}

/** In-memory mock so the UI stays demoable until the Phase-1 backend lands. */
class MockInstanceManagerApi implements InstanceManagerApi {
  readonly mocked = true
  private instances: ClaudeInstance[] = [
    {
      id: 'claude1',
      name: 'claude1',
      status: 'running',
      primaryVmid: 161,
      allowed: 'all',
      createdAt: '2026-07-02T00:00:00Z',
      termPath: 'about:blank',
    },
    {
      id: 'fable-builder',
      name: 'fable-builder',
      status: 'running',
      primaryVmid: 161,
      allowed: [152, 161],
      createdAt: '2026-07-02T01:00:00Z',
      termPath: 'about:blank',
    },
  ]
  private clone(i: ClaudeInstance): ClaudeInstance {
    return { ...i, allowed: i.allowed === 'all' ? 'all' : [...i.allowed] }
  }
  async list(): Promise<ClaudeInstance[]> {
    return this.instances.map((i) => this.clone(i))
  }
  async create(name: string): Promise<ClaudeInstance> {
    const id = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+/, '') || `instance-${this.instances.length}`
    if (this.instances.some((i) => i.id === id)) throw new Error(`instance "${id}" already exists`)
    const instance: ClaudeInstance = {
      id,
      name,
      status: 'needs-login',
      primaryVmid: null,
      allowed: [],
      createdAt: new Date().toISOString(),
      termPath: 'about:blank',
    }
    this.instances.push(instance)
    return this.clone(instance)
  }
  async rename(id: string, name: string): Promise<ClaudeInstance> {
    const i = this.instances.find((x) => x.id === id)
    if (!i) throw new Error('not found')
    i.name = name
    return this.clone(i)
  }
  async remove(id: string): Promise<void> {
    this.instances = this.instances.filter((x) => x.id !== id)
  }
  async control(id: string, action: ControlAction): Promise<{ ok: boolean; status?: InstanceStatus; error?: string }> {
    const i = this.instances.find((x) => x.id === id)
    if (!i) return { ok: false, error: 'not found' }
    i.status = action === 'exit' ? 'stopped' : 'running'
    return { ok: true, status: i.status }
  }
  async setPermissions(id: string, permissions: ClusterPermissions): Promise<ClaudeInstance> {
    const i = this.instances.find((x) => x.id === id)
    if (!i) throw new Error('not found')
    i.primaryVmid = permissions.primaryVmid ?? null
    i.allowed = permissions.allowed === 'all' ? 'all' : [...permissions.allowed]
    return this.clone(i)
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
