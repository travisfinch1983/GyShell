import type { HermesAgentSpec } from '@gyshell/shared'

/** Pure merge logic for the bulk agent editor (AgentBulkEditor.tsx) — kept free of React so it can be tested. */

export type Val = string | number | boolean | string[]


/** Normalised per-agent values for every bulk-editable spec field ('' / 0 / false = unset). */
export const specValues = (s: HermesAgentSpec): Record<string, Val> => ({
  model: s.model ?? '',
  personality: s.persona?.personality ?? '',
  mode: s.mode ?? 'default',
  maxTokens: s.maxTokens ? String(s.maxTokens) : '',
  fallback: s.fallback ?? [],
  'sub.model': s.subAgents?.model ?? '',
  'sub.reasoningEffort': s.subAgents?.reasoningEffort ?? '',
  'sub.maxConcurrent': s.subAgents?.maxConcurrent ?? 0,
  'sub.maxSpawnDepth': s.subAgents?.maxSpawnDepth ?? 0,
  'sub.autoApproveDangerous': s.subAgents?.autoApproveDangerous ?? false,
  'tts.provider': s.tts?.provider ?? '',
  'tts.voiceId': s.tts?.voiceId ?? '',
  'tts.modelId': s.tts?.modelId ?? '',
  'tts.preset': s.tts?.preset ?? '',
  'tts.rvcEnabled': s.tts?.rvcEnabled ?? false,
  'tts.rvcModel': s.tts?.rvcModel ?? '',
})

/** Build one agent's new spec: its stored spec + ONLY the touched fields. */
export const applyBulkEdits = (s: HermesAgentSpec, edits: Record<string, Val>): unknown => {
  const cur = specValues(s)
  const v = { ...cur }
  for (const [k, val] of Object.entries(edits)) {
    if (!(k in v)) continue
    // int fields are edited as strings (blank allowed); store them as numbers
    v[k] = (k === 'sub.maxConcurrent' || k === 'sub.maxSpawnDepth') ? Number(val) || 0 : val
  }
  // Changing the chat-voice provider invalidates that agent's provider-specific fields —
  // exactly what the single editor does — unless the bulk edit set them too.
  if ('tts.provider' in edits && edits['tts.provider'] !== cur['tts.provider']) {
    for (const k of ['tts.voiceId', 'tts.modelId', 'tts.preset', 'tts.rvcModel']) if (!(k in edits)) v[k] = ''
    if (!('tts.rvcEnabled' in edits)) v['tts.rvcEnabled'] = false
  }
  const model = v.model as string
  const sub = {
    model: (v['sub.model'] as string) || undefined,
    reasoningEffort: ((v['sub.reasoningEffort'] as string) || undefined) as 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none' | undefined,
    maxConcurrent: (v['sub.maxConcurrent'] as number) > 0 ? (v['sub.maxConcurrent'] as number) : undefined,
    maxSpawnDepth: (v['sub.maxSpawnDepth'] as number) > 0 ? (v['sub.maxSpawnDepth'] as number) : undefined,
    autoApproveDangerous: (v['sub.autoApproveDangerous'] as boolean) || undefined,
  }
  const provider = v['tts.provider'] as string
  const rvcEnabled = v['tts.rvcEnabled'] as boolean
  const personality = v.personality as string
  const maxTokens = v.maxTokens as string
  return {
    ...s,
    model,
    persona: s.persona || personality ? { ...(s.persona ?? {}), personality: personality || undefined } : undefined,
    mode: v.mode,
    maxTokens: /^[0-9]+$/.test(maxTokens) && Number(maxTokens) > 0 ? Number(maxTokens) : undefined,
    // A chain entry equal to the (possibly new) primary is pointless; the single editor never allows it.
    fallback: (v.fallback as string[]).filter((f) => f !== model),
    subAgents: Object.values(sub).some((x) => x !== undefined) ? sub : undefined,
    tts: provider
      ? {
          provider,
          voiceId: (v['tts.voiceId'] as string) || undefined,
          modelId: (v['tts.modelId'] as string) || undefined,
          ...(provider === 'ailab'
            ? { rvcEnabled: rvcEnabled || undefined, rvcModel: (rvcEnabled && (v['tts.rvcModel'] as string)) || undefined, preset: (v['tts.preset'] as string) || undefined }
            : {}),
        }
      : undefined,
  }
}

