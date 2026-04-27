import type { TerminalService } from '../TerminalService'
import type { CommandPolicyMode } from '../CommandPolicy/CommandPolicyService'
import type { ICommandPolicyRuntime } from '../runtimeContracts'
import type { ToolPermission } from '../../types'

export interface ToolExecutionContext {
  sessionId: string
  messageId: string
  terminalService: TerminalService
  sendEvent: (sessionId: string, event: any) => void
  waitForFeedback?: (messageId: string, timeoutMs?: number) => Promise<any | null>
  commandPolicyService: ICommandPolicyRuntime
  commandPolicyMode: CommandPolicyMode
  signal?: AbortSignal
  /**
   * Per-tool permission map (from settings.tools.builtInPermissions). Tools
   * use this to decide whether to short-circuit the user-approval prompt:
   * - 'always-allow' skips CommandPolicy / ask entirely
   * - 'ask-once-session' prompts the first time per session and remembers
   * - 'always-ask' falls through to the existing CommandPolicy behavior
   */
  toolPermissions?: Record<string, ToolPermission>
  /**
   * Set of tool names already approved for this session (drives the
   * 'ask-once-session' policy). Mutated when the user approves; cleared at
   * session end.
   */
  sessionApprovedTools?: Set<string>
}

export type ReadFileSupport = {
  image: boolean
}
