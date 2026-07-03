/**
 * Slash-command framework for the main chat composer (chat-rework task #5).
 *
 * Declarative registry consumed by (a) RichInput's palette (name/description/
 * argHint for the dropdown) and (b) ChatPanel's send interception. Every
 * command maps to a VERIFIED existing operation — nothing here fakes wiring;
 * ops without a backend (e.g. manual /compact) are deliberately absent.
 *
 * Handlers return a user-facing notice (shown transiently above the composer)
 * or null for silent success.
 */
import type { AppStore } from '../../stores/AppStore'
import { confirmStore } from '../../stores/confirmStore'
import { fleetStore } from '../../stores/FleetStore'

export interface SlashContext {
  store: AppStore
  sessionId: string
}

export interface SlashCommand {
  name: string
  description: string
  argHint?: string
  run: (ctx: SlashContext, args: string) => Promise<string | null>
}

function agentBridge(): any {
  return (window as any).gyshell?.agent
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'new',
    description: 'Start a fresh chat session (current one stays in history)',
    run: async ({ store }) => {
      store.chat.createSession('New Chat')
      return null
    },
  },
  {
    name: 'clear',
    description: 'Alias of /new — fresh session; history keeps the old one',
    run: async ({ store }) => {
      store.chat.createSession('New Chat')
      return null
    },
  },
  {
    name: 'rename',
    description: 'Rename the current session',
    argHint: 'new title',
    run: async ({ store, sessionId }, args) => {
      if (!args.trim()) return 'usage: /rename <new title>'
      await store.chat.renameChatSession(sessionId, args.trim())
      return `renamed ✓`
    },
  },
  {
    name: 'delete',
    description: 'Delete the current session (confirmed)',
    run: async ({ store, sessionId }) => {
      const ok = await confirmStore.confirm({
        title: 'Delete session',
        message: 'Delete this chat session and its history? This cannot be undone.',
        confirmText: 'Delete',
      })
      if (!ok) return null
      await store.chat.deleteChatSession(sessionId)
      return 'session deleted'
    },
  },
  {
    name: 'export',
    description: 'Download this session as markdown',
    run: async ({ sessionId }) => {
      await agentBridge()?.exportHistory?.(sessionId)
      return 'export started'
    },
  },
  {
    name: 'stop',
    description: 'Stop the in-flight turn',
    run: async ({ sessionId }) => {
      await agentBridge()?.stopTask?.(sessionId)
      return 'stop sent'
    },
  },
  {
    name: 'model',
    description: 'Switch the model profile (prefix match)',
    argHint: 'profile name',
    run: async ({ store }, args) => {
      const q = args.trim().toLowerCase()
      const profiles: Array<{ id: string; name: string }> = store.settings?.models?.profiles ?? []
      if (!q) return `profiles: ${profiles.map((p) => p.name).join(', ') || '(none)'}`
      const hit = profiles.find((p) => p.name.toLowerCase() === q) ?? profiles.find((p) => p.name.toLowerCase().startsWith(q))
      if (!hit) return `no profile matches "${args.trim()}"`
      store.setActiveProfile(hit.id)
      return `model profile → ${hit.name}`
    },
  },
  {
    name: 'dm',
    description: 'Send a fleet-bus DM to an agent',
    argHint: 'agent message…',
    run: async (_ctx, args) => {
      const m = args.trim().match(/^(\S+)\s+([\s\S]+)$/)
      if (!m) return 'usage: /dm <agent> <message>'
      await fleetStore.send(m[1], m[2])
      return `dm → ${m[1]} ✓ (see Fleet Feed)`
    },
  },
  {
    name: 'broadcast',
    description: 'Broadcast on the fleet bus',
    argHint: 'message…',
    run: async (_ctx, args) => {
      if (!args.trim()) return 'usage: /broadcast <message>'
      await fleetStore.send('broadcast', args.trim())
      return 'broadcast sent ✓ (see Fleet Feed)'
    },
  },
  {
    name: 'help',
    description: 'List slash commands',
    run: async () => SLASH_COMMANDS.map((c) => `/${c.name}${c.argHint ? ` <${c.argHint}>` : ''} — ${c.description}`).join('\n'),
  },
]

/** Palette matches while a command is being typed ("/", "/re"…). */
export function matchSlashCommands(draftText: string): SlashCommand[] {
  const m = draftText.match(/^\/([a-z]*)$/i)
  if (!m) return []
  const q = m[1].toLowerCase()
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
}

/**
 * Send-time interception. Returns null when the text is not a slash command
 * (falls through to a normal chat send). Unknown /words fall through too —
 * people legitimately type paths and /etc.
 */
export async function runSlashCommand(text: string, ctx: SlashContext): Promise<{ notice: string | null } | null> {
  const m = text.trim().match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i)
  if (!m) return null
  const cmd = SLASH_COMMANDS.find((c) => c.name === m[1].toLowerCase())
  if (!cmd) return null
  try {
    return { notice: await cmd.run(ctx, m[2] ?? '') }
  } catch (e) {
    return { notice: `/${cmd.name} failed: ${String((e as Error)?.message ?? e)}` }
  }
}
