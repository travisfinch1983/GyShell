/**
 * ui-settings-service — server-side UI customization store (theme, language, terminal prefs,
 * panel tabs, chat prefs, command-draft, …). Single-user UI: these are persisted on the SERVER
 * and shared across every browser/machine, instead of per-browser localStorage. Read/written
 * over the gateway via `uiSettings:get` / `uiSettings:set`. set() MERGES partial patches (the UI
 * sends `{ themeId }`, `{ terminal }`, etc.) so one setting never clobbers the others.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const dir = process.env.GYBACKEND_DATA_DIR || path.join(process.cwd(), '.gybackend-data')
const FILE = path.join(dir, 'ui-settings.json')

type Any = Record<string, any>

function read(): Any {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function write(obj: Any): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), { mode: 0o600 })
  } catch {
    /* best-effort persistence */
  }
}

export const uiSettingsService = {
  get(): Any {
    return read()
  },
  set(patch: Any): Any {
    const cur = read()
    const next = { ...cur, ...(patch && typeof patch === 'object' ? patch : {}) }
    write(next)
    return next
  },
}
