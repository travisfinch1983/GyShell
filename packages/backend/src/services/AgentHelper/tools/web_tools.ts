import { z } from 'zod'

export const WEB_FETCH_DESCRIPTION =
  'Fetch the contents of a URL and return its text. HTML is stripped to readable text. ' +
  'Use this to read documentation pages, GitHub READMEs, blog posts, etc. Output is capped at ~50KB; ' +
  'pass an extractionPrompt if you only need a specific section so the caller can summarise downstream. ' +
  'Only http/https URLs are accepted.'

export const WEB_SEARCH_DESCRIPTION =
  'Search the web for a query and return up to 10 result entries with title, URL, and snippet. ' +
  'Uses DuckDuckGo as the backend (no API key). Use this when you need to discover URLs to follow up on with web_fetch.'

export const webFetchSchema = z.object({
  url: z.string().url().describe('Absolute http(s) URL to fetch'),
  extractionPrompt: z
    .string()
    .optional()
    .describe('Optional hint about what content to extract (echoed to caller; not used by fetch itself).'),
})

export const webSearchSchema = z.object({
  query: z.string().min(1).describe('Search query string. Engine bangs work too: prefix with !goc (google), !bi (bing), !yh (yahoo), !ddg (duckduckgo).'),
  maxResults: z.number().int().min(1).max(20).optional().describe('Maximum results (default 10)'),
  engine: z.enum(['google', 'bing', 'yahoo', 'duckduckgo']).optional()
    .describe('Preferred search engine (default: the instance mix). Same effect as a query bang.'),
})

export type WebToolResult =
  | { kind: 'text'; message: string }
  | { kind: 'error'; message: string }

const MAX_BYTES = 50 * 1024
const FETCH_TIMEOUT_MS = 15_000

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '(c)',
  reg: '(r)',
  hellip: '...',
  mdash: '--',
  ndash: '-',
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, raw) => {
    if (raw.startsWith('#x') || raw.startsWith('#X')) {
      const code = parseInt(raw.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    }
    if (raw.startsWith('#')) {
      const code = parseInt(raw.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    }
    return ENTITY_MAP[raw.toLowerCase()] ?? ''
  })
}

function htmlToText(html: string): { title: string; body: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : ''
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const decoded = decodeEntities(stripped)
  const body = decoded
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, body }
}

async function fetchWithLimit(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<{
  status: number
  contentType: string
  text: string
  truncated: boolean
}> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)

  try {
    const res = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) Ai-Lab/1.0 (+web_fetch) AppleWebKit/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml,text/plain,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        ...headers,
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    const contentType = res.headers.get('content-type') ?? ''
    const buf = await res.arrayBuffer()
    const truncated = buf.byteLength > MAX_BYTES
    const sliced = truncated ? buf.slice(0, MAX_BYTES) : buf
    const text = new TextDecoder('utf-8', { fatal: false }).decode(sliced)
    return { status: res.status, contentType, text, truncated }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function runWebFetch(args: unknown, signal?: AbortSignal): Promise<WebToolResult> {
  const validated = webFetchSchema.safeParse(args)
  if (!validated.success) {
    return { kind: 'error', message: `web_fetch invalid arguments: ${validated.error.message}` }
  }
  const { url, extractionPrompt } = validated.data
  if (!/^https?:\/\//i.test(url)) {
    return { kind: 'error', message: 'web_fetch only supports http(s) URLs.' }
  }
  try {
    const { status, contentType, text, truncated } = await fetchWithLimit(url, {}, signal)
    if (status >= 400) {
      return { kind: 'error', message: `web_fetch ${url} returned HTTP ${status}` }
    }
    let output = text
    let title = ''
    if (/html|xml/i.test(contentType) || /<html[\s>]/i.test(text.slice(0, 500))) {
      const parsed = htmlToText(text)
      title = parsed.title
      output = parsed.body
    }
    const header = [
      `URL: ${url}`,
      `Status: ${status}`,
      `Content-Type: ${contentType}`,
      title ? `Title: ${title}` : '',
      truncated ? `Note: response truncated to ${MAX_BYTES} bytes` : '',
      extractionPrompt ? `Extraction hint (caller's): ${extractionPrompt}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    return { kind: 'text', message: `${header}\n\n${output}` }
  } catch (err) {
    if ((err as any)?.name === 'AbortError') throw err
    return {
      kind: 'error',
      message: `web_fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export async function runWebSearch(args: unknown, signal?: AbortSignal): Promise<WebToolResult> {
  const validated = webSearchSchema.safeParse(args)
  if (!validated.success) {
    return { kind: 'error', message: `web_search invalid arguments: ${validated.error.message}` }
  }
  const { query, maxResults, engine } = validated.data
  const limit = maxResults ?? 10

  // PRIMARY: the lab's self-hosted SearXNG (no rate limits, engine choice). Raw google is
  // captcha-blocked from our IP, so 'google' maps to the working google-cse engine (!goc).
  // Engine can come from the arg OR a bang already in the query (SearXNG parses both).
  const BANG: Record<string, string> = { google: '!goc', bing: '!bi', yahoo: '!yh', duckduckgo: '!ddg' }
  const searxQuery = engine && !query.trimStart().startsWith('!') ? `${BANG[engine]} ${query}` : query
  const searxBase = process.env.AILAB_SEARXNG_URL || 'http://127.0.0.1:8888'
  try {
    const sr = await fetch(`${searxBase}/search?q=${encodeURIComponent(searxQuery)}&format=json`, {
      signal: signal ?? AbortSignal.timeout(25_000), headers: { Accept: 'application/json' },
    })
    if (sr.ok) {
      const data = (await sr.json()) as { results?: Array<{ title?: string; url?: string; content?: string; engine?: string }> }
      const rs = (data.results ?? []).slice(0, limit)
      if (rs.length > 0) {
        const formatted = rs
          .map((r, i) => `${i + 1}. ${r.title ?? ''}${r.engine ? ` [${r.engine}]` : ''}\n   ${r.url ?? ''}\n   ${(r.content ?? '').slice(0, 300)}`)
          .join('\n\n')
        return { kind: 'text', message: `Search: ${searxQuery}\n\n${formatted}` }
      }
      // 0 results is a real answer from a working backend — do NOT fall through to the
      // rate-limited scraper for it; tell the caller honestly.
      return { kind: 'text', message: `No results for "${searxQuery}" (searxng). Try different terms or another engine bang (!goc !bi !yh !ddg).` }
    }
    console.warn(`[web_search] searxng returned HTTP ${sr.status} — falling back to DDG scrape`)
  } catch (err) {
    if ((err as any)?.name === 'AbortError') throw err
    console.warn(`[web_search] searxng unreachable (${err instanceof Error ? err.message : String(err)}) — falling back to DDG scrape`)
  }

  // FALLBACK: legacy DuckDuckGo HTML scrape (rate-limit prone) — only when SearXNG is down.
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  try {
    const { status, text } = await fetchWithLimit(url, {}, signal)
    if (status >= 400) {
      return { kind: 'error', message: `web_search backend returned HTTP ${status}` }
    }
    const results: { title: string; url: string; snippet: string }[] = []
    const blockRe =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    while ((m = blockRe.exec(text)) && results.length < limit) {
      const href = m[1]
      const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim()
      const snippet = decodeEntities(m[3].replace(/<[^>]+>/g, '')).trim()
      let resolvedUrl = href
      if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
        try {
          const parsed = new URL(`https:${href}`)
          resolvedUrl = decodeURIComponent(parsed.searchParams.get('uddg') ?? href)
        } catch {
          /* leave as-is */
        }
      } else if (href.startsWith('/l/?uddg=')) {
        try {
          const parsed = new URL(`https://duckduckgo.com${href}`)
          resolvedUrl = decodeURIComponent(parsed.searchParams.get('uddg') ?? href)
        } catch {
          /* leave as-is */
        }
      }
      results.push({ title, url: resolvedUrl, snippet })
    }
    if (results.length === 0) {
      return {
        kind: 'text',
        message: `⚠ DEGRADED SEARCH (SearXNG down, legacy DDG scraper): no results parsed for "${query}" — the scraper is rate-limit and captcha prone, so this is NOT an authoritative "no results". Retry later or use a different engine.`,
      }
    }
    const formatted = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join('\n\n')
    // The route travels IN the result: the model treats tool output as
    // authoritative, and a degraded scraper's thin results read as "that's all
    // there is" unless the output says which path produced them.
    return { kind: 'text', message: `Search (DEGRADED — SearXNG down, legacy scraper): ${query}\n\n${formatted}\n\n⚠ Results came from the rate-limited fallback scraper and may be incomplete.` }
  } catch (err) {
    if ((err as any)?.name === 'AbortError') throw err
    return {
      kind: 'error',
      message: `web_search failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
