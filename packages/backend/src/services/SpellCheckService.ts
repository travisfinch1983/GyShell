/**
 * Backend spell-check via nspell + dictionary-en. Used by the chat
 * context menu — the UI sends a word, we return suggestions.
 *
 * Centralizing this on the backend (instead of the browser) lets us:
 *   - Use a real Hunspell dictionary (~1MB) without bloating the bundle
 *   - Keep behavior consistent across the LAN-IP and Cloudflare-URL
 *     access paths (per the LAN-fetch principle)
 *   - Cache results across all clients sharing this backend
 */

interface Nspell {
  correct: (w: string) => boolean
  suggest: (w: string) => string[]
}

let nspellInstance: Nspell | null = null
let nspellLoadingPromise: Promise<Nspell | null> | null = null
const suggestionCache = new Map<string, string[]>()
const MAX_CACHE_ENTRIES = 2000

async function loadDictionary(): Promise<Nspell | null> {
  if (nspellInstance) return nspellInstance
  if (nspellLoadingPromise) return nspellLoadingPromise

  nspellLoadingPromise = (async () => {
    // dictionary-en (v4+) is ESM and exports the loaded { aff, dic } object
    // directly as default. nspell is CommonJS and ships no types.
    const [nspellMod, dictionaryEnMod] = await Promise.all([
      // @ts-expect-error — nspell ships no type declarations
      import('nspell'),
      import('dictionary-en'),
    ])
    const nspell = (nspellMod as any).default || (nspellMod as any)
    const dict = (dictionaryEnMod as any).default || (dictionaryEnMod as any)
    nspellInstance = nspell(dict) as Nspell
    return nspellInstance
  })()

  return nspellLoadingPromise
}

export interface SpellCheckResult {
  word: string
  misspelled: boolean
  suggestions: string[]
}

/**
 * Check a single word. Returns up to 5 suggestions when misspelled.
 * Words containing non-letter characters (digits, punctuation, symbols)
 * skip the dictionary entirely — they're treated as correct so we don't
 * pollute the menu with suggestions for tokens like "v1.2.3".
 */
export async function spellCheckWord(rawWord: string): Promise<SpellCheckResult> {
  const word = String(rawWord || '').trim()
  if (!word) return { word, misspelled: false, suggestions: [] }
  if (!/^[A-Za-z'’]+$/.test(word)) {
    return { word, misspelled: false, suggestions: [] }
  }

  const cached = suggestionCache.get(word)
  if (cached) {
    return { word, misspelled: cached.length > 0, suggestions: cached }
  }

  let n: Nspell | null
  try {
    n = await loadDictionary()
  } catch (err) {
    console.warn('[SpellCheckService] dictionary load failed:', err)
    return { word, misspelled: false, suggestions: [] }
  }
  if (!n) return { word, misspelled: false, suggestions: [] }

  if (n.correct(word)) {
    cacheSet(word, [])
    return { word, misspelled: false, suggestions: [] }
  }
  const suggestions = n.suggest(word).slice(0, 5)
  cacheSet(word, suggestions)
  return { word, misspelled: true, suggestions }
}

function cacheSet(word: string, suggestions: string[]): void {
  if (suggestionCache.size >= MAX_CACHE_ENTRIES) {
    // Drop oldest by deleting the first key — Map preserves insertion order.
    const firstKey = suggestionCache.keys().next().value
    if (firstKey !== undefined) suggestionCache.delete(firstKey)
  }
  suggestionCache.set(word, suggestions)
}
