import { z } from 'zod'
import { spawn } from 'node:child_process'
import type { ToolExecutionContext } from '../types'

/**
 * headless_tools — model-private shell execution that doesn't touch the
 * user's UI terminal tabs.
 *
 * Each invocation spawns a fresh bash subprocess inside the AI-Lab backend
 * container, runs the command with a timeout, and returns the captured
 * stdout/stderr + exit code. Compared to `exec_command`:
 *
 *   - `exec_command` — runs in one of the user's visible terminal tabs.
 *     The user sees output in real time, can scroll back through it, and
 *     can intervene with their own input. Use this when the user has
 *     explicitly asked you to operate in their terminal, or when state
 *     should persist across calls (cd'ing into a directory, etc.).
 *
 *   - `exec_headless` (this tool) — runs in a one-shot subprocess hidden
 *     from the UI. Use as the default for any work the model needs to do
 *     on its own (querying files, running probes, gathering info, etc.).
 *     Each call is fully isolated — there's no persistent working
 *     directory, environment, or shell history between calls.
 *
 * The output is capped at MAX_OUTPUT_BYTES per stream to keep responses
 * within model context budgets; truncated runs return a `truncated` flag
 * so the model knows to narrow its query.
 */

export const EXEC_HEADLESS_DESCRIPTION =
  'Run a shell command in a one-shot headless subprocess inside the AI-Lab backend container. ' +
  'Use this as the DEFAULT for any work you need to do on your own — checking files, running probes, ' +
  'gathering information, executing scripts, etc. The user does NOT see this output; it returns to you. ' +
  'Each call is independent — no persistent working directory or shell history. ' +
  'Only use exec_command (the UI-terminal version) when the user has explicitly asked you to ' +
  'operate in one of their open terminal tabs, or when state must persist across calls (e.g. cd; ls).'

const MAX_OUTPUT_BYTES = 64 * 1024 // 64KB per stream
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000

export const execHeadlessSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute (runs via /bin/bash -c).'),
  cwd: z
    .string()
    .optional()
    .describe('Working directory for the command. Defaults to the AI-Lab backend container root (/).'),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Hard timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}ms, max ${MAX_TIMEOUT_MS}ms). ` +
        'If the command runs past this, it is killed and you get a partial-output result.',
    ),
})

export type HeadlessToolResult =
  | { kind: 'text'; message: string }
  | { kind: 'error'; message: string }

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  truncated: boolean
}

async function execBash(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd: cwd || '/',
      env: { ...process.env, TERM: 'dumb' },
    })

    let stdout = ''
    let stderr = ''
    let truncated = false

    const appendStdout = (chunk: Buffer) => {
      if (stdout.length >= MAX_OUTPUT_BYTES) {
        truncated = true
        return
      }
      const remaining = MAX_OUTPUT_BYTES - stdout.length
      const text = chunk.toString('utf8')
      if (text.length > remaining) {
        stdout += text.slice(0, remaining)
        truncated = true
      } else {
        stdout += text
      }
    }
    const appendStderr = (chunk: Buffer) => {
      if (stderr.length >= MAX_OUTPUT_BYTES) {
        truncated = true
        return
      }
      const remaining = MAX_OUTPUT_BYTES - stderr.length
      const text = chunk.toString('utf8')
      if (text.length > remaining) {
        stderr += text.slice(0, remaining)
        truncated = true
      } else {
        stderr += text
      }
    }

    child.stdout?.on('data', appendStdout)
    child.stderr?.on('data', appendStderr)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const onAbort = () => {
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort)

    child.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        stdout,
        stderr: stderr + `\n[exec_headless: spawn error: ${err.message}]`,
        exitCode: null,
        signal: null,
        timedOut,
        truncated,
      })
    })

    child.on('close', (code, sig) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal: sig,
        timedOut,
        truncated,
      })
    })
  })
}

/**
 * Check the per-tool permission for exec_headless and either short-circuit
 * (always-allow / already-approved-this-session) or route through the same
 * approval prompt that exec_command uses, then remember the per-session
 * approval. Mirrors checkCommandPolicy in terminal_tools.ts but uses the
 * generic per-tool permission flow rather than the command-pattern policy
 * (which is for the user's UI terminals).
 */
async function checkHeadlessPermission(
  command: string,
  context: ToolExecutionContext,
): Promise<{ allowed: boolean; reason?: string }> {
  const perm = context.toolPermissions?.['exec_headless']
  if (perm === 'always-allow') return { allowed: true }
  if (perm === 'ask-once-session' && context.sessionApprovedTools?.has('exec_headless')) {
    return { allowed: true }
  }
  if (perm === 'disabled') {
    return { allowed: false, reason: 'exec_headless is disabled in Settings → Tools.' }
  }
  // For 'always-ask' and the first call of 'ask-once-session', use the same
  // requestApproval mechanism the user-terminal exec_command uses so the
  // approval banner shows up in the chat UI.
  const approved = await context.commandPolicyService.requestApproval({
    sessionId: context.sessionId,
    messageId: context.messageId,
    command,
    toolName: 'exec_headless',
    sendEvent: context.sendEvent,
    signal: context.signal,
  })
  if (!approved) {
    return { allowed: false, reason: `User rejected headless command: ${command}` }
  }
  if (perm === 'ask-once-session') {
    context.sessionApprovedTools?.add('exec_headless')
  }
  return { allowed: true }
}

export async function runExecHeadless(
  rawArgs: unknown,
  contextOrSignal?: ToolExecutionContext | AbortSignal,
): Promise<HeadlessToolResult> {
  const validated = execHeadlessSchema.safeParse(rawArgs)
  if (!validated.success) {
    return { kind: 'error', message: `exec_headless invalid arguments: ${validated.error.message}` }
  }
  const { command, cwd, timeoutMs } = validated.data
  const tMs = timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Accept either a full ToolExecutionContext (with permissions + approval
  // plumbing) or just an AbortSignal. The context form gives us the
  // per-tool permission gate; signal-only is a fallback used by older
  // call sites and skips the approval check entirely (the AgentService
  // dispatch path always passes a full context).
  const context =
    contextOrSignal && typeof (contextOrSignal as any).addEventListener !== 'function'
      ? (contextOrSignal as ToolExecutionContext)
      : null
  const signal: AbortSignal | undefined =
    context?.signal ?? (contextOrSignal as AbortSignal | undefined)

  if (context) {
    const check = await checkHeadlessPermission(command, context)
    if (!check.allowed) {
      return { kind: 'error', message: check.reason || 'exec_headless: permission denied.' }
    }
  }

  try {
    const result = await execBash(command, cwd, tMs, signal)
    const lines: string[] = []
    lines.push(`Command: ${command}`)
    if (cwd) lines.push(`Cwd: ${cwd}`)
    if (result.timedOut) {
      lines.push(`Status: TIMEOUT after ${tMs}ms (process killed with SIGKILL)`)
    } else if (result.signal) {
      lines.push(`Status: terminated by signal ${result.signal}`)
    } else {
      lines.push(`Exit code: ${result.exitCode}`)
    }
    if (result.truncated) {
      lines.push(`Note: output truncated to ${MAX_OUTPUT_BYTES} bytes per stream`)
    }
    if (result.stdout) {
      lines.push('--- stdout ---')
      lines.push(result.stdout.replace(/\s+$/, ''))
    } else {
      lines.push('--- stdout --- (empty)')
    }
    if (result.stderr) {
      lines.push('--- stderr ---')
      lines.push(result.stderr.replace(/\s+$/, ''))
    }
    return { kind: 'text', message: lines.join('\n') }
  } catch (err) {
    if ((err as any)?.name === 'AbortError') throw err
    return {
      kind: 'error',
      message: `exec_headless failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
