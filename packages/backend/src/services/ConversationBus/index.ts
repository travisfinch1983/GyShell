// ConversationBus itself was retired on 2026-08-27 — fleet messaging lives in fleetd now.
// These two remain because neither was ever messaging plumbing: AgentRegistry is the agent
// index, and ContextPackStore assembles per-agent context into a run's system prompt.
//
// The directory name is historical. See contextPackSeam.extreme.spec.ts for their coverage.
export { AgentRegistry } from './AgentRegistry'
export { ContextPackStore } from './ContextPackStore'
