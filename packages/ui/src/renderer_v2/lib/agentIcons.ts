/**
 * Curated set of lucide icons available for agent identification. Both the
 * agent editor's icon picker and the sidebar's icon-strip renderer read from
 * this single source so adding a new icon is a one-line change.
 *
 * Names are stored on AgentDefinition.icon as the lucide component name.
 * Unknown / missing names fall back to AGENT_FALLBACK_ICON.
 */
import {
  Bot,
  Globe,
  ScrollText,
  Hammer,
  Bug,
  Search,
  Brain,
  MessageCircle,
  Code,
  Wrench,
  BookOpen,
  Lightbulb,
  Sparkles,
  Layers,
  Database,
  Compass,
  Telescope,
  PenTool,
  Rocket,
  Microscope,
  type LucideIcon,
} from 'lucide-react'

/** Ordered list of agent-icon options shown in the editor's picker. */
export const AGENT_ICON_REGISTRY: Array<{ name: string; icon: LucideIcon }> = [
  { name: 'Bot', icon: Bot },
  { name: 'Globe', icon: Globe },
  { name: 'ScrollText', icon: ScrollText },
  { name: 'Hammer', icon: Hammer },
  { name: 'Bug', icon: Bug },
  { name: 'Search', icon: Search },
  { name: 'Brain', icon: Brain },
  { name: 'MessageCircle', icon: MessageCircle },
  { name: 'Code', icon: Code },
  { name: 'Wrench', icon: Wrench },
  { name: 'BookOpen', icon: BookOpen },
  { name: 'Lightbulb', icon: Lightbulb },
  { name: 'Sparkles', icon: Sparkles },
  { name: 'Layers', icon: Layers },
  { name: 'Database', icon: Database },
  { name: 'Compass', icon: Compass },
  { name: 'Telescope', icon: Telescope },
  { name: 'PenTool', icon: PenTool },
  { name: 'Rocket', icon: Rocket },
  { name: 'Microscope', icon: Microscope },
]

const ICON_BY_NAME = new Map(AGENT_ICON_REGISTRY.map((e) => [e.name, e.icon]))

/** Default icon used when an agent's icon name is missing or unrecognized. */
export const AGENT_FALLBACK_ICON: LucideIcon = Bot

/** Resolve an icon name to its lucide component. */
export function resolveAgentIcon(name: string | undefined): LucideIcon {
  if (!name) return AGENT_FALLBACK_ICON
  return ICON_BY_NAME.get(name) || AGENT_FALLBACK_ICON
}
