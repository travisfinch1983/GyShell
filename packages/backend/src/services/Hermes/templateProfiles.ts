/** Profile dirs that are TEMPLATES, not addressable agents.
 *
 *  `hermes -p default` means "no profile": it reads/writes the GLOBAL ~/.hermes/config.yaml, which
 *  `hermes profile create <id> --clone` copies into every new agent. profiles/default/ additionally
 *  holds the canonical memory-plugin files new agents are provisioned from.
 *
 *  So a template is load-bearing CONFIG, never a conversation: it must not be listed as an agent,
 *  spawned as a chat session, or health-checked. (2026-09-29: 'default' was being resurrected as a
 *  ghost chat session on every AI-Lab restart and polled its MCP group every 3 minutes, and every
 *  support-role save warned "vision role not applied to agent 'default'".) */
export const TEMPLATE_PROFILES: ReadonlySet<string> = new Set<string>(['default', 'zztmpl', 'zzglob'])

export const isTemplateProfile = (id: string | undefined | null): boolean => !!id && TEMPLATE_PROFILES.has(id)
