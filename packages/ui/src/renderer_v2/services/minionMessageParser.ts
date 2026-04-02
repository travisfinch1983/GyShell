/**
 * minionMessageParser — Parse model responses into structured blocks.
 *
 * Extracts <think> blocks, generates summaries, and splits body content.
 * Used by MinionRouter before injecting messages into the chat.
 */

export interface ParsedMinionResponse {
  /** Raw thinking content (null if no <think> block) */
  thinking: string | null
  /** Short summary (first sentence or ~120 chars) */
  summary: string
  /** Full response body with thinking stripped */
  body: string
}

/**
 * Parse a model response into structured blocks.
 *
 * - Extracts `<think>...</think>` blocks (Qwen 3.5 standard)
 * - Generates a summary from the first meaningful sentence
 * - Returns the clean body with thinking removed
 */
export function parseMinionResponse(raw: string): ParsedMinionResponse {
  let thinking: string | null = null
  let body = raw

  // Extract <think> blocks (may be multiple, concatenate them)
  const thinkBlocks: string[] = []
  body = body.replace(/<think>([\s\S]*?)<\/think>\s*/g, (_match, content) => {
    thinkBlocks.push(content.trim())
    return ''
  })
  body = body.trim()

  if (thinkBlocks.length > 0) {
    thinking = thinkBlocks.join('\n\n---\n\n')
  }

  // Generate summary from the cleaned body
  const summary = generateSummary(body)

  return { thinking, summary, body }
}

/**
 * Generate a short summary from the response body.
 *
 * Strategy:
 * 1. Take the first non-empty, non-header line
 * 2. If it ends with sentence punctuation within 150 chars, use the first sentence
 * 3. Otherwise truncate at ~120 chars on a word boundary
 */
function generateSummary(body: string): string {
  if (!body) return '(empty response)'

  // Skip markdown headers and blank lines to find first content line
  const lines = body.split('\n')
  let firstContent = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Skip markdown headers
    if (/^#{1,6}\s/.test(trimmed)) continue
    // Skip horizontal rules
    if (/^[-*_]{3,}$/.test(trimmed)) continue
    // Skip code fence starts
    if (/^```/.test(trimmed)) continue
    firstContent = trimmed
    break
  }

  if (!firstContent) {
    // All headers or code — use first line
    firstContent = lines.find(l => l.trim())?.trim() || body.trim()
  }

  // Strip leading markdown formatting (bold, italic, etc.)
  firstContent = firstContent.replace(/^\*{1,3}/, '').replace(/\*{1,3}$/, '').trim()
  // Strip leading list markers
  firstContent = firstContent.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim()

  // Try to get a complete first sentence
  const sentenceEnd = firstContent.search(/[.!?]\s|[.!?]$/)
  if (sentenceEnd !== -1 && sentenceEnd < 150) {
    return firstContent.substring(0, sentenceEnd + 1)
  }

  // Truncate on word boundary
  if (firstContent.length <= 120) return firstContent

  const truncated = firstContent.substring(0, 120)
  const lastSpace = truncated.lastIndexOf(' ')
  return (lastSpace > 60 ? truncated.substring(0, lastSpace) : truncated) + '...'
}
