import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { writeAndEditSchema, writeAndEdit } from './tools/edit_tools'
import { readFileSchema, runReadFile } from './tools/read_tools'
import { 
  execCommandSchema, 
  readTerminalTabSchema, 
  readCommandOutputSchema,
  writeStdinSchema,
  runCommand, 
  runCommandNowait, 
  readTerminalTab, 
  readCommandOutput,
  writeStdin
} from './tools/terminal_tools'
import { 
  BUILTIN_TOOL_INFO, 
  buildReadFileDescription,
  WAIT_TERMINAL_IDLE_DESCRIPTION
} from './prompts'
import type { ReadFileSupport } from './types'
import { waitSchema, waitTerminalIdleSchema, waitCommandEndSchema, wait, waitTerminalIdle, waitCommandEnd } from './tools/wait_tools'
import {
  skillToolSchema,
  buildSkillToolDescription,
  createSkillSchema,
  runCreateSkillTool
} from './tools/skill_tools'
import {
  webFetchSchema,
  webSearchSchema,
  WEB_FETCH_DESCRIPTION,
  WEB_SEARCH_DESCRIPTION,
  runWebFetch,
  runWebSearch
} from './tools/web_tools'
import {
  delegateAgentSchema,
  buildDelegateAgentDescription,
  runDelegateAgent
} from './tools/delegate_agent_tool'
import {
  memoryListCollectionsSchema,
  memoryRecallSchema,
  memorySaveSchema,
  memoryCreateCollectionSchema,
  memoryDeleteSchema,
  MEMORY_LIST_COLLECTIONS_DESCRIPTION,
  MEMORY_RECALL_DESCRIPTION,
  MEMORY_SAVE_DESCRIPTION,
  MEMORY_CREATE_COLLECTION_DESCRIPTION,
  MEMORY_DELETE_DESCRIPTION,
  runMemoryListCollections,
  runMemoryRecall,
  runMemorySave,
  runMemoryCreateCollection,
  runMemoryDelete
} from './tools/memory_tools'

// Re-export schemas for AgentService to use
export { 
  editFileSchema, 
  writeAndEditSchema 
} from './tools/edit_tools'

export { 
  execCommandSchema, 
  readTerminalTabSchema, 
  readCommandOutputSchema,
  writeStdinSchema
} from './tools/terminal_tools'

export { readFileSchema } from './tools/read_tools'
export { waitSchema, waitTerminalIdleSchema, waitCommandEndSchema } from './tools/wait_tools'
export { skillToolSchema, createSkillSchema, buildSkillToolDescription } from './tools/skill_tools'

export { BUILTIN_TOOL_INFO } from './prompts'

export type { ToolExecutionContext, ReadFileSupport } from './types'

// Build Tool Definitions
export function buildToolsForModel(readFileSupport: ReadFileSupport) {
  return [
    {
      name: 'exec_command',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'exec_command')?.description ?? '',
      schema: execCommandSchema
    },
    {
      name: 'read_terminal_tab',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'read_terminal_tab')?.description ?? '',
      schema: readTerminalTabSchema
    },
    {
      name: 'read_command_output',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'read_command_output')?.description ?? '',
      schema: readCommandOutputSchema
    },
    {
      name: 'read_file',
      description: buildReadFileDescription(readFileSupport),
      schema: readFileSchema,
    },
    {
      name: 'write_stdin',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'write_stdin')?.description ?? '',
      schema: writeStdinSchema
    },
    {
      name: 'create_or_edit',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'create_or_edit')?.description ?? '',
      schema: writeAndEditSchema
    },
    {
      name: 'skill',
      description: buildSkillToolDescription([]), // Placeholder, will be updated by AgentService
      schema: skillToolSchema
    },
    {
      name: 'create_skill',
      description: 'Create a new skill in GyShell skills. This tool only creates new skills and does not modify or overwrite existing ones. If the skill name already exists, the call must fail and you should choose a different name. If you need to modify an existing skill, use the create_or_edit tool to edit that skill\'s md file directly.',
      schema: createSkillSchema
    },
    {
      name: 'wait',
      description: BUILTIN_TOOL_INFO.find((t) => t.name === 'wait')?.description ?? '',
      schema: waitSchema
    },
    {
      name: 'wait_terminal_idle',
      description: WAIT_TERMINAL_IDLE_DESCRIPTION,
      schema: waitTerminalIdleSchema
    },
    {
      name: 'wait_command_end',
      description: 'Wait for the currently running command in the terminal tab to finish. Use this when you started a command with nowait but now need its output or exit code to proceed.',
      schema: waitCommandEndSchema
    },
    {
      name: 'web_fetch',
      description: WEB_FETCH_DESCRIPTION,
      schema: webFetchSchema
    },
    {
      name: 'web_search',
      description: WEB_SEARCH_DESCRIPTION,
      schema: webSearchSchema
    },
    {
      name: 'delegate_agent',
      description: buildDelegateAgentDescription([]), // updated dynamically by AgentService
      schema: delegateAgentSchema
    },
    {
      name: 'memory_list_collections',
      description: MEMORY_LIST_COLLECTIONS_DESCRIPTION,
      schema: memoryListCollectionsSchema
    },
    {
      name: 'memory_recall',
      description: MEMORY_RECALL_DESCRIPTION,
      schema: memoryRecallSchema
    },
    {
      name: 'memory_save',
      description: MEMORY_SAVE_DESCRIPTION,
      schema: memorySaveSchema
    },
    {
      name: 'memory_create_collection',
      description: MEMORY_CREATE_COLLECTION_DESCRIPTION,
      schema: memoryCreateCollectionSchema
    },
    {
      name: 'memory_delete',
      description: MEMORY_DELETE_DESCRIPTION,
      schema: memoryDeleteSchema
    }
  ].map((tool) => convertToOpenAITool(tool))
}

export const TOOLS_FOR_MODEL = buildToolsForModel({ image: false })

// Aggregated Tool Implementations
export const toolImplementations = {
  runCommand,
  runCommandNowait,
  readTerminalTab,
  readCommandOutput,
  writeStdin,
  wait,
  waitTerminalIdle,
  writeAndEdit,
  runReadFile,
  runCreateSkillTool,
  waitCommandEnd,
  runWebFetch,
  runWebSearch,
  runDelegateAgent,
  runMemoryListCollections,
  runMemoryRecall,
  runMemorySave,
  runMemoryCreateCollection,
  runMemoryDelete
}

// Re-export web tool helpers for AgentService dispatch
export { runWebFetch, runWebSearch, webFetchSchema, webSearchSchema } from './tools/web_tools'
export {
  delegateAgentSchema,
  buildDelegateAgentDescription,
  runDelegateAgent,
  MAX_DELEGATE_DEPTH,
  MAX_DELEGATE_TURNS,
} from './tools/delegate_agent_tool'
export type { DelegateAgentDeps, DelegateAgentResult } from './tools/delegate_agent_tool'
