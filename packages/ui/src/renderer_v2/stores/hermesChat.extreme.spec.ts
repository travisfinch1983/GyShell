/**
 * HermesChatStore reducer spec — folds the SSE event union into the transcript.
 * Run: ./node_modules/.bin/tsx packages/ui/src/renderer_v2/stores/hermesChat.extreme.spec.ts
 *
 * The message/thought/usage fixtures mirror a REAL captured scout turn
 * (2026-07-03, /api/hermes/agents/scout/stream) — shapes, not paraphrases.
 * Exercises reduce()/state() only (no EventSource / DOM).
 */
import { hermesStreamEventSchema } from '@gyshell/shared'
import { hermesChatStore, type ChatItem } from './HermesChatStore'

let failures = 0
function assertEqual<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) console.log(`PASS ${label}`)
  else {
    failures++
    console.error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`)
  }
}

function feed(agentId: string, raw: unknown) {
  const r = hermesStreamEventSchema.safeParse(raw)
  if (!r.success) return false
  hermesChatStore.reduce(agentId, r.data)
  return true
}

const kinds = (id: string) => hermesChatStore.state(id).items.map((i: ChatItem) => i.kind)

// ── case 1: full captured-turn sequence folds correctly ─────────────────────
{
  const id = 'case1'
  feed(id, { t: 'ready', session_id: 'a2cc0b45', models: [{ model_id: 'custom:Qwen3.6', name: 'Qwen3.6', description: 'Provider: Custom endpoint • current' }], current_model: 'custom:Qwen3.6', modes: [{ id: 'default' }] })
  feed(id, { t: 'commands', commands: [{ name: 'help', description: 'List available commands' }, { name: 'model', description: 'Show current model', input: { hint: 'model name to switch to' } }] })
  hermesChatStore.state(id).items.push({ id: 9001, kind: 'user', text: 'what model?', ts: 1 })
  feed(id, { t: 'thought', text: 'The user asks ' })
  feed(id, { t: 'thought', text: 'about the model.' })
  feed(id, { t: 'message', text: "I'm running on " })
  feed(id, { t: 'message', text: 'Qwen3.6 via a custom provider.' })
  feed(id, { t: 'usageUpdate', raw: { size: 262144, used: 11767, session_update: 'usage_update' } })
  feed(id, { t: 'turn_done', stop_reason: 'end_turn' })

  // ready is HEADER state (sessionId/currentModel), never a chat item — the
  // old "attached — session…" row stacked once per tab-swap re-attach.
  assertEqual(kinds(id), ['user', 'thought', 'assistant', 'system'], 'case1: item kinds in order (no attached row)')
  const s = hermesChatStore.state(id)
  assertEqual(s.items[1].text, 'The user asks about the model.', 'case1: thought chunks accumulate')
  assertEqual(s.items[2].text, "I'm running on Qwen3.6 via a custom provider.", 'case1: message chunks accumulate')
  assertEqual(s.items[2].streaming, false, 'case1: turn_done clears streaming')
  assertEqual(s.usage, { used: 11767, size: 262144 }, 'case1: usage meter from real payload')
  assertEqual(s.commands.length, 2, 'case1: slash catalog stored')
  assertEqual(s.currentModel, 'custom:Qwen3.6', 'case1: model from ready')
  assertEqual(s.sessionId, 'a2cc0b45', 'case1: session id captured as header state')
  assertEqual(s.busy, false, 'case1: busy cleared')
}

// ── case 2: tool cards update by id; unknown ids append ─────────────────────
{
  const id = 'case2'
  feed(id, { t: 'tool_start', id: 'tc-1', title: 'web.search', kind: 'fetch', raw: {} })
  feed(id, { t: 'message', text: 'Searching…' })
  feed(id, { t: 'tool_progress', id: 'tc-1', status: 'completed', raw: {} })
  feed(id, { t: 'tool_progress', id: 'tc-2', status: 'running', raw: {} })

  const s = hermesChatStore.state(id)
  assertEqual(kinds(id), ['tool', 'assistant', 'tool'], 'case2: progress for known id updates in place')
  assertEqual(s.items[0].status, 'completed', 'case2: tc-1 status updated')
  assertEqual(s.items[2].status, 'running', 'case2: unknown id appends a card')
}

// ── case 3: message after turn_done starts a NEW bubble ─────────────────────
{
  const id = 'case3'
  feed(id, { t: 'message', text: 'first turn' })
  feed(id, { t: 'turn_done', stop_reason: 'end_turn' })
  feed(id, { t: 'message', text: 'second turn' })
  const s = hermesChatStore.state(id)
  assertEqual(kinds(id), ['assistant', 'system', 'assistant'], 'case3: post-turn message opens a new bubble')
  assertEqual(s.items[2].streaming, true, 'case3: new bubble streams')
}

// ── case 4: thought → message → thought makes separate blocks ───────────────
{
  const id = 'case4'
  feed(id, { t: 'thought', text: 'a' })
  feed(id, { t: 'message', text: 'b' })
  feed(id, { t: 'thought', text: 'c' })
  assertEqual(kinds(id), ['thought', 'assistant', 'thought'], 'case4: interleaved blocks stay separate')
}

// ── case 5: schema rejects unknown variants (forward-compat drop) ───────────
{
  assertEqual(feed('case5', { t: 'someFutureEvent', raw: {} }), false, 'case5: unknown t is dropped at parse')
  assertEqual(feed('case5', 'not an object'), false, 'case5: garbage dropped')
  assertEqual(hermesChatStore.state('case5').items.length, 0, 'case5: nothing rendered')
}

// ── case 6: error event surfaces and clears busy ────────────────────────────
{
  const id = 'case6'
  hermesChatStore.state(id).busy = true
  feed(id, { t: 'error', where: 'prompt', message: 'boom' })
  const s = hermesChatStore.state(id)
  assertEqual(s.items[0].kind, 'error', 'case6: error row rendered')
  assertEqual(s.items[0].text, '[prompt] boom', 'case6: where prefix')
  assertEqual(s.busy, false, 'case6: busy cleared on error')
}

// ── case 7: mode/session-info passthroughs are inert; plans render + upsert ──
{
  const id = 'case7'
  feed(id, { t: 'currentModeUpdate', raw: {} })
  feed(id, { t: 'sessionInfoUpdate', raw: {} })
  feed(id, { t: 'agentPlanUpdate', raw: { entries: [] } }) // empty plan → nothing
  assertEqual(hermesChatStore.state(id).items.length, 0, 'case7: passthroughs render nothing')
  feed(id, { t: 'agentPlanUpdate', raw: { entries: [{ content: 'step 1', status: 'in_progress' }, { content: 'step 2' }] } })
  feed(id, { t: 'plan', raw: { entries: [{ content: 'step 1', status: 'completed' }, { content: 'step 2', status: 'in_progress' }] } })
  const s7 = hermesChatStore.state(id)
  assertEqual(s7.items.length, 1, 'case7: plan updates upsert ONE card')
  assertEqual(s7.items[0].plan?.map((e) => e.status), ['completed', 'in_progress'], 'case7: latest plan wins')
}

// ── case 7b: stream events mark busy (turns started by OTHER clients) ───────
{
  const id = 'case7b'
  feed(id, { t: 'message', text: 'someone else prompted' })
  assertEqual(hermesChatStore.state(id).busy, true, 'case7b: message chunk sets busy')
  feed(id, { t: 'turn_done', stop_reason: 'end_turn' })
  assertEqual(hermesChatStore.state(id).busy, false, 'case7b: turn_done clears busy')
}

// ── case 7c: capture_request is a SIGNAL — parses, renders nothing ──────────
{
  const id = 'case7c'
  assertEqual(feed(id, { t: 'capture_request', requestId: 'req-1' }), true, 'case7c: capture_request parses')
  assertEqual(hermesChatStore.state(id).items.length, 0, 'case7c: no transcript row for the signal')
}

// ── case 8: permission_auto_allow renders a system notice ───────────────────
{
  const id = 'case8'
  feed(id, { t: 'permission_auto_allow', option_id: 'allow-workspace' })
  const s = hermesChatStore.state(id)
  assertEqual(s.items[0].kind, 'system', 'case8: system row')
  assertEqual(s.items[0].text.includes('allow-workspace'), true, 'case8: option id shown')
}

// ── case 9: re-attach ready adds ZERO items (tab swaps must not stack rows) ──
{
  const id = 'case9'
  feed(id, { t: 'message', text: 'before drop' })
  feed(id, { t: 'turn_done', stop_reason: 'end_turn' })
  feed(id, { t: 'ready', session_id: 'a2cc0b45', models: null, current_model: 'custom:Qwen3.6', modes: null })
  feed(id, { t: 'ready', session_id: 'a2cc0b45', models: null, current_model: 'custom:Qwen3.6', modes: null })
  assertEqual(kinds(id), ['assistant', 'system'], 'case9: reattach keeps prior transcript, adds no items')
  assertEqual(hermesChatStore.state(id).sessionId, 'a2cc0b45', 'case9: session id updated in header state')
}

if (failures) {
  console.error(`\n${failures} FAILURES`)
  process.exit(1)
}
console.log('\nALL PASS')
