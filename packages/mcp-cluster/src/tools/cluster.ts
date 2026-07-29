import { z } from 'zod'
import type { ToolSpec } from './types.js'

/**
 * Cluster + credential-vault tools — the proxlab-cluster replacement.
 * ProxLab (CT107) is decommissioned and GONE; these point at AI-Lab's
 * ported inventory + credential-vault REST. Same tool NAMES as the old
 * proxlab-cluster MCP so agents only swap the server prefix.
 */
const clean = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

export const clusterTools: ToolSpec[] = [
  {
    name: 'list_credentials',
    description:
      'List credential-vault entries (secrets MASKED). Replaces proxlab-cluster list_credentials. Each ' +
      'entry has id, name, type, url, username. Use get_credential with the id to reveal the secret. ' +
      'Optional query filters by name substring.',
    schema: { query: z.string().optional().describe('Filter entries whose name contains this (case-insensitive)') },
    endpoint: '/api/ai/credentials',
    transform: (data, args) => {
      const entries = (data as any)?.entries ?? data
      const list = Array.isArray(entries) ? entries : []
      const q = typeof args.query === 'string' ? args.query.toLowerCase() : ''
      return { entries: q ? list.filter((e: any) => String(e.name || '').toLowerCase().includes(q)) : list }
    },
  },
  {
    name: 'get_credential',
    description:
      'Retrieve ONE credential-vault entry with the secret REVEALED (tokenSecret / password / bearerToken / ' +
      'sshKeyPath). Replaces proxlab-cluster get_credential. Pass the entry id from list_credentials.',
    schema: { id: z.string().min(1).describe('Credential id, e.g. cred-1bfb909a (from list_credentials)') },
    endpoint: (args) => `/api/ai/credentials/${encodeURIComponent(String(args.id))}?reveal=1`,
  },
  {
    name: 'store_credential',
    description:
      'STATE-CHANGING: Add a new credential-vault entry. Replaces proxlab-cluster store_credential. Provide ' +
      'name + type and the relevant secret fields (any of url, username, password, tokenId, tokenSecret, ' +
      'sshKeyPath, bearerToken, notes).',
    schema: {
      name: z.string().min(1).describe('Display name'),
      type: z.string().min(1).describe('e.g. api_token, ssh_key, user_pass, bearer'),
      url: z.string().optional(), username: z.string().optional(), password: z.string().optional(),
      tokenId: z.string().optional(), tokenSecret: z.string().optional(),
      sshKeyPath: z.string().optional(), bearerToken: z.string().optional(), notes: z.string().optional(),
    },
    method: 'POST',
    endpoint: '/api/ai/credentials',
    body: (args) => clean(args),
  },
  {
    name: 'update_credential',
    description:
      'STATE-CHANGING: Update an existing credential-vault entry by id. Replaces proxlab-cluster ' +
      'update_credential. Only the fields you pass are changed.',
    schema: {
      id: z.string().min(1).describe('Credential id to update'),
      name: z.string().optional(), type: z.string().optional(), url: z.string().optional(),
      username: z.string().optional(), password: z.string().optional(), tokenId: z.string().optional(),
      tokenSecret: z.string().optional(), sshKeyPath: z.string().optional(), bearerToken: z.string().optional(),
      notes: z.string().optional(),
    },
    method: 'PUT',
    endpoint: (args) => `/api/ai/credentials/${encodeURIComponent(String(args.id))}`,
    body: (args) => clean(Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'id'))),
  },
  {
    name: 'cluster_search',
    description:
      'Search the cluster for a container/VM by name, vmid, IP, or tag. Replaces proxlab-cluster ' +
      'cluster_search. Search by container NAME ALONE (no extra context words). Returns matching guests ' +
      'with vmid, name, node, ip, status.',
    schema: { query: z.string().min(1).describe('Name / vmid / ip / tag substring') },
    endpoint: '/api/guests',
    transform: (data, args) => {
      const guests = (data as any)?.guests ?? data
      const q = String(args.query || '').toLowerCase()
      const list = (Array.isArray(guests) ? guests : []).filter((g: any) => {
        const tags = Array.isArray(g.tags) ? g.tags.join(' ') : String(g.tags || '')
        return [g.name, g.vmid, g.ip, tags].some((f: any) => String(f ?? '').toLowerCase().includes(q))
      })
      return { matches: list.map((g: any) => ({ vmid: g.vmid, name: g.name, node: g.node, ip: g.ip, status: g.status, type: g.type })) }
    },
  },
  {
    name: 'get_guest',
    description:
      'Get one guest (LXC/VM) by vmid or exact name — vmid, name, node, ip, status, resources, tags. ' +
      'Replaces proxlab-cluster get_guest.',
    schema: {
      vmid: z.union([z.string(), z.number()]).optional().describe('Container/VM id'),
      name: z.string().optional().describe('Exact guest name'),
    },
    endpoint: '/api/guests',
    transform: (data, args) => {
      const guests = (data as any)?.guests ?? data
      const list = Array.isArray(guests) ? guests : []
      const g = list.find((x: any) =>
        (args.vmid !== undefined && String(x.vmid) === String(args.vmid)) ||
        (args.name && String(x.name).toLowerCase() === String(args.name).toLowerCase()))
      return g || { error: 'guest not found' }
    },
  },
  {
    name: 'list_hosts',
    description: 'List the physical cluster hosts / PVE nodes with live status (cpu, mem, disk). Replaces proxlab-cluster list_hosts.',
    schema: {},
    endpoint: '/api/pve/status',
    transform: (data) => {
      const d = data as any
      return { cluster: d?.cluster, nodes: d?.nodes, counts: { containers: (d?.containers ?? []).length, vms: (d?.vms ?? []).length } }
    },
  },
  {
    name: 'get_host',
    description: 'Get one cluster host/node by name from the inventory (hardware, resources). Replaces proxlab-cluster get_host.',
    schema: { name: z.string().min(1).describe('Host/node name, e.g. px-epyc') },
    endpoint: '/api/ai/inventory',
    transform: (data, args) => {
      const entries = (data as any)?.entries ?? data
      const list = Array.isArray(entries) ? entries : []
      const q = String(args.name || '').toLowerCase()
      const exact = list.find((e: any) => String(e.name || e.host || '').toLowerCase() === q)
      return exact || list.filter((e: any) => String(e.name || e.host || '').toLowerCase().includes(q))
    },
  },
  {
    name: 'list_inventory',
    description: 'Full cluster inventory — hosts + hardware + scan config. Replaces proxlab-cluster inventory listing.',
    schema: {},
    endpoint: '/api/ai/inventory',
  },
]
