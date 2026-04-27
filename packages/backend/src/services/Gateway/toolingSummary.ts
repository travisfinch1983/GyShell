import type { SkillInfo } from '../../skills/FileSkillStore'
import { BUILTIN_TOOL_INFO } from '../AgentHelper/tools'
import { DEFAULT_BUILT_IN_TOOL_PERMISSIONS, type ToolPermission } from '../../types'

export interface SkillStatusSummary {
  name: string
  description: string
  enabled: boolean
}

export interface BuiltInToolStatusSummary {
  name: string
  description: string
  enabled: boolean
  /** Per-tool permission policy. Used by the Tools settings UI to render the
   * 4-option selector (always-allow / ask-once-session / always-ask / disabled). */
  permission: ToolPermission
}

export function buildSkillStatusSummary(
  skills: SkillInfo[],
  enabledMap: Record<string, boolean> | undefined
): SkillStatusSummary[] {
  const state = enabledMap ?? {}
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    enabled: state[skill.name] !== false
  }))
}

export function buildBuiltInToolStatusSummary(
  enabledMap: Record<string, boolean> | undefined,
  permissionMap?: Record<string, ToolPermission>
): BuiltInToolStatusSummary[] {
  const state = enabledMap ?? {}
  const perms = permissionMap ?? {}
  return BUILTIN_TOOL_INFO.map((tool) => {
    const permission =
      perms[tool.name] ?? DEFAULT_BUILT_IN_TOOL_PERMISSIONS[tool.name] ?? 'always-ask'
    const enabled = permission !== 'disabled' && (state[tool.name] ?? true)
    return {
      name: tool.name,
      description: tool.description,
      enabled,
      permission,
    }
  })
}
