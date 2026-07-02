import { z } from 'zod'
import type { ToolSpec } from './types.js'

interface FeedRecord {
  type: 'envelope' | 'delivery'
  envelope?: { to?: string; kind?: string }
  [key: string]: unknown
}

/**
 * Fleet tools — the claude-relay replacement surface. Sending appends to the
 * ConversationBus log and shows in the AI-Lab Fleet Feed immediately; whether
 * a delivery TRIGGERS the recipient's inference is governed by the bus's
 * autonomousRoutingEnabled kill switch, not by these tools.
 */
export const fleetTools: ToolSpec[] = [
  {
    name: 'fleet_send',
    description:
      'STATE-CHANGING: Send a message to an AI-Lab fleet agent (or "broadcast" for all, "user" for the ' +
      'human operator). Replaces claude-relay send_message. The message lands on the ConversationBus, ' +
      'appears in the Fleet Feed, and is queued for the recipient; whether delivery triggers the ' +
      'recipient to run is governed by the fleet kill switch (see fleet_status). Returns the appended ' +
      'envelope (note its busSeq for threading).',
    schema: {
      sender: z.string().min(1).describe('Your agent name (auto-registered on first send, e.g. "claude1")'),
      recipient: z.string().min(1).describe('Target agentId, "user", or "broadcast"'),
      message: z.string().min(1).describe('Message body (markdown ok)'),
    },
    method: 'POST',
    endpoint: '/api/fleet/send',
    body: (args) => ({ sender: args.sender, recipient: args.recipient, message: args.message }),
  },
  {
    name: 'fleet_read',
    description:
      'Read fleet messages from the ConversationBus with a cursor. Replaces claude-relay ' +
      'check_messages/history: pass afterSeq=-1 the first time, then the returned nextAfterSeq to get ' +
      'only new activity. Optionally filter to messages addressed to you (for=<your agent name>, ' +
      'includes broadcasts). Set raw=true to also see delivery-status records.',
    schema: {
      afterSeq: z.number().int().min(-1).default(-1).describe('Cursor: only records after this seq (-1 = from start)'),
      limit: z.number().int().positive().max(500).optional().describe('Max records per page (default 200)'),
      for: z.string().optional().describe('Only envelopes addressed to this agentId (or broadcast)'),
      raw: z.boolean().optional().describe('Return raw records including delivery updates (default: envelopes only)'),
    },
    endpoint: (args) =>
      `/api/fleet/feed?afterSeq=${encodeURIComponent(String(args.afterSeq ?? -1))}&limit=${encodeURIComponent(String(args.limit ?? 200))}`,
    transform: (data, args) => {
      const resp = data as { records?: FeedRecord[]; nextAfterSeq?: number; latestSeq?: number }
      if (args.raw) return resp
      const forAgent = typeof args.for === 'string' && args.for ? args.for : undefined
      const messages = (resp.records ?? [])
        .filter((r) => r.type === 'envelope')
        .map((r) => r.envelope!)
        .filter((e) => !forAgent || e.to === forAgent || e.to === 'broadcast')
      return { messages, nextAfterSeq: resp.nextAfterSeq, latestSeq: resp.latestSeq }
    },
  },
  {
    name: 'fleet_agents',
    description:
      'List all fleet agents (the directory): agentId, display name, kind (local AI-Lab agent / external ' +
      'relay / user), enabled flag, plus live presence (idle/thinking/queued/offline and queue depth).',
    schema: {},
    endpoint: '/api/fleet/agents',
  },
  {
    name: 'fleet_status',
    description:
      'Fleet guard status: whether autonomous routing (delivery-triggered inference) is enabled, the ' +
      'autonomy budget and current usage, rate-limit config, and the latest bus sequence number.',
    schema: {},
    endpoint: '/api/fleet/status',
  },
  {
    name: 'fleet_register',
    description:
      'STATE-CHANGING: Declare or update a fleet agent in the registry. Use to give an external agent a ' +
      'proper display name, or (advanced) to declare a local AI-Lab agent. Sending with a new name ' +
      'auto-registers a relay agent already — explicit registration is only needed to customize the entry.',
    schema: {
      agentId: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase slug (a-z, 0-9, -, _)')
        .describe('Stable agent id (lowercase slug)'),
      displayName: z.string().min(1).describe('Human-readable name shown in the Fleet Feed'),
      kind: z.enum(['local', 'relay']).default('relay').describe('relay = external agent; local = backed by an AI-Lab agent session'),
      relayRecipient: z.string().optional().describe('relay only: name on the legacy claude-relay directory'),
      profileId: z.string().optional().describe('local only: model profile for the agent session'),
      persona: z.string().optional().describe('local only: system-prompt preamble'),
      enabled: z.boolean().optional().describe('Disabled agents receive no deliveries (default true)'),
    },
    method: 'POST',
    endpoint: '/api/fleet/register',
    body: (args) =>
      Object.fromEntries(
        Object.entries({
          agentId: args.agentId,
          displayName: args.displayName,
          kind: args.kind ?? 'relay',
          relayRecipient: args.relayRecipient,
          profileId: args.profileId,
          persona: args.persona,
          enabled: args.enabled,
        }).filter(([, v]) => v !== undefined),
      ),
  },
]
