import path from 'node:path'
import process from 'node:process'
import fs from 'node:fs/promises'
import { TerminalService } from '../../services/TerminalService'
import { FileSystemService } from '../../services/FileSystemService'
import { AgentService_v2 } from '../../services/AgentService_v2'
import { UIHistoryService } from '../../services/UIHistoryService'
import { ChatHistoryService } from '../../services/ChatHistoryService'
import { GatewayService } from '../../services/Gateway/GatewayService'
import { WebSocketGatewayAdapter } from '../../services/Gateway/WebSocketGatewayAdapter'
import { clusterService } from '../../services/Cluster/ClusterService'
import { CatalogInstallService } from '../../services/Cluster/CatalogInstallService'
import { universalProxyService } from '../../services/Cluster/UniversalProxyService'
import { detectServiceTypes } from '../../services/Cluster/probeServiceType'
import { fetchCivitaiModel } from '../../services/Cluster/civitaiModel'
import { metricsService } from '../../services/Cluster/MetricsService'
import { clusterSettingsService } from '../../services/Cluster/ClusterSettingsService'
import { pveClient } from '../../services/Cluster/PveClient'
import {
  WebSocketGatewayControlService,
  resolveWsGatewayAccessFromHost,
  resolveWsGatewayPolicyFromEnv
} from '../../services/Gateway/WebSocketGatewayControlService'
import { NodeSettingsService } from '../../adapters/node/NodeSettingsService'
import { NodeCommandPolicyService } from '../../adapters/node/NodeCommandPolicyService'
import { NodeMcpToolService } from '../../adapters/node/NodeMcpToolService'
import { NodeSkillService } from '../../adapters/node/NodeSkillService'
import { NodeMemoryService } from '../../adapters/node/NodeMemoryService'
import { NodeAccessTokenService } from '../../adapters/node/NodeAccessTokenService'
import { ModelCapabilityService } from '../../services/ModelCapabilityService'
import {
  buildBuiltInToolStatusSummary,
  buildSkillStatusSummary
} from '../../services/Gateway/toolingSummary'
import { ImageAttachmentService } from '../../services/ImageAttachmentService'
import { TerminalStateStore } from '../../services/terminal/TerminalStateStore'
import { createAutoTerminalConfig } from '../../services/terminal/terminalConnectionSupport'
import { TerminalCommandDraftService } from '../../services/TerminalCommandDraftService'

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) return fallback
  return /^(1|true|yes|on)$/i.test(raw)
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] || '')
  if (!Number.isInteger(raw) || raw <= 0 || raw >= 65536) {
    return fallback
  }
  return raw
}

function resolveDataDir(): string {
  const custom = (process.env.GYBACKEND_DATA_DIR || '').trim()
  if (custom) {
    return path.resolve(custom)
  }
  return path.join(process.cwd(), '.gybackend-data')
}

async function saveTempPaste(dataDir: string, content: string): Promise<string> {
  const tmpDir = path.join(dataDir, 'tmp_pastes')
  await fs.mkdir(tmpDir, { recursive: true })
  const fileName = `paste_${Date.now()}_${Math.random().toString(16).slice(2, 10)}.txt`
  const filePath = path.join(tmpDir, fileName)
  await fs.writeFile(filePath, content, 'utf8')
  return filePath
}

export async function startGyBackend(): Promise<void> {
  const dataDir = resolveDataDir()
  process.env.GYSHELL_STORE_DIR = dataDir
  const defaultHost = (process.env.GYBACKEND_WS_HOST || '0.0.0.0').trim() || '0.0.0.0'
  const defaultPort = numberFromEnv('GYBACKEND_WS_PORT', 17888)
  const startupPolicy = resolveWsGatewayPolicyFromEnv({
    env: process.env,
    defaultPolicy: {
      access: resolveWsGatewayAccessFromHost(defaultHost),
      port: defaultPort,
      hostOverride: defaultHost
    },
    enableVarName: 'GYBACKEND_WS_ENABLE',
    hostVarName: 'GYBACKEND_WS_HOST',
    portVarName: 'GYBACKEND_WS_PORT'
  })
  const bootstrapLocalTerminal = boolFromEnv('GYBACKEND_BOOTSTRAP_LOCAL_TERMINAL', true)

  const settingsService = new NodeSettingsService(dataDir)
  const commandPolicyService = new NodeCommandPolicyService(dataDir)
  const mcpToolService = new NodeMcpToolService(dataDir)
  const skillService = new NodeSkillService(dataDir, settingsService)
  const memoryService = new NodeMemoryService(dataDir)
  const accessTokenService = new NodeAccessTokenService(dataDir)
  const modelCapabilityService = new ModelCapabilityService()
  const imageAttachmentService = new ImageAttachmentService(dataDir)

  const terminalStateStore = new TerminalStateStore(path.join(dataDir, 'terminal-tabs-state.json'))
  const terminalService = new TerminalService({
    terminalStateStore
  })
  const fileSystemService = new FileSystemService(terminalService)
  process.once('exit', () => {
    terminalService.flushPersistedState()
  })
  const uiHistoryService = new UIHistoryService()
  const chatHistoryService = new ChatHistoryService()
  const agentService = new AgentService_v2(
    terminalService,
    commandPolicyService,
    mcpToolService,
    skillService,
    memoryService,
    uiHistoryService,
    chatHistoryService,
    imageAttachmentService
  )

  const gatewayService = new GatewayService(
    terminalService,
    agentService,
    uiHistoryService,
    commandPolicyService,
    settingsService,
    mcpToolService
  )
  const terminalCommandDraftService = new TerminalCommandDraftService(terminalService, settingsService)
  const catalogInstallService = new CatalogInstallService({
    publish: (channel, data) => gatewayService.broadcastRaw(channel, data),
    keyPath: process.env.AILAB_SSH_KEY || path.join(dataDir, 'ssh', 'id_ed25519')
  })
  // AI-Lab Universal API Proxy — dedicated HTTP listener fronting running services by slot.
  void universalProxyService.start({ dataDir }).catch((e) => console.warn('[gybackend] universal proxy failed to start:', e))

  const terminalRestoreResult = await terminalService.restorePersistedTerminals()
  if (terminalRestoreResult.restored.length > 0 || terminalRestoreResult.failed.length > 0) {
    console.log(
      `[gybackend] Terminal restore completed. restored=${terminalRestoreResult.restored.length} failed=${terminalRestoreResult.failed.length}`
    )
    if (terminalRestoreResult.failed.length > 0) {
      terminalRestoreResult.failed.forEach((item) => {
        console.warn(`[gybackend] Terminal restore failed for ${item.id}: ${item.reason}`)
      })
    }
  }

  agentService.updateSettings(settingsService.getSettings())
  // Recover any turns interrupted by a prior backend restart (annotate the affected sessions).
  try {
    agentService.recoverInterruptedRuns?.()
  } catch (e) {
    console.warn('[gybackend] interrupted-run recovery failed:', e)
  }
  await skillService.reload()
  await mcpToolService.reloadAll()

  if (bootstrapLocalTerminal && terminalService.getDisplayTerminals().length === 0) {
    const terminalId = process.env.GYBACKEND_TERMINAL_ID || 'local-main'
    const terminalTitle = process.env.GYBACKEND_TERMINAL_TITLE || 'Local'
    const terminalCwd = process.env.GYBACKEND_TERMINAL_CWD
    const terminalShell = process.env.GYBACKEND_TERMINAL_SHELL

    try {
      await terminalService.createTerminal({
        type: 'local',
        id: terminalId,
        title: terminalTitle,
        cols: 120,
        rows: 32,
        cwd: terminalCwd,
        shell: terminalShell
      })
      console.log(`[gybackend] Bootstrapped terminal: ${terminalId}`)
    } catch (error) {
      console.warn('[gybackend] Failed to bootstrap default terminal:', error)
    }
  }

  const wsGatewayControlService = new WebSocketGatewayControlService({
    createAdapter: (host, port, ipFilter) =>
      new WebSocketGatewayAdapter(gatewayService, {
        host,
        port,
        accessTokenAuth: {
          verifyToken: (token: string) => accessTokenService.verifyToken(token),
          allowLocalhostWithoutToken: true
        },
        ipFilter,
        clusterBridge: {
          getStatus: () => clusterService.getStatus(),
          request: (method, path, body) => clusterService.request(method, path, body)
        },
        catalogInstallBridge: {
          start: (opts) => catalogInstallService.start(opts),
          input: (id, data) => catalogInstallService.input(id, data),
          resize: (id, cols, rows) => catalogInstallService.resize(id, cols, rows),
          close: (id) => catalogInstallService.close(id),
          listTemplates: (host) => catalogInstallService.listTemplates(host)
        },
        proxyBridge: {
          getState: () => universalProxyService.getState()
        },
        aiProbeBridge: {
          detectTypes: (items) => detectServiceTypes(items)
        },
        civitaiBridge: {
          fetchModel: (modelId) => fetchCivitaiModel(modelId)
        },
        metricsBridge: {
          queryRange: (query, rangeSeconds, stepSeconds) => metricsService.queryRange(query, rangeSeconds, stepSeconds),
          queryRangeBatch: (queries, rangeSeconds, stepSeconds) => metricsService.queryRangeBatch(queries, rangeSeconds, stepSeconds),
          query: (query) => metricsService.query(query),
          metricNames: () => metricsService.metricNames(),
          labelValues: (label) => metricsService.labelValues(label)
        },
        clusterSettingsBridge: {
          get: () => clusterSettingsService.get(),
          set: (patch) => clusterSettingsService.set(patch),
          reveal: () => clusterSettingsService.reveal(),
          testPve: () => pveClient.testConnection()
        },
        terminalBridge: {
          listTerminals: () =>
            terminalService.getDisplayTerminals().map((terminal) => ({
              id: terminal.id,
              title: terminal.title,
              type: terminal.type,
              cols: terminal.cols,
              rows: terminal.rows,
              runtimeState: terminal.runtimeState,
              lastExitCode: terminal.lastExitCode
            })),
          createTab: async (config) => {
            const snapshot = terminalService.getDisplayTerminals()
            const normalized = createAutoTerminalConfig(snapshot, config)
            const tab = await terminalService.createTerminal(normalized as any)
            return { id: tab.id }
          },
          write: async (terminalId, data) => {
            terminalService.write(terminalId, data)
          },
          writePaths: async (terminalId, paths) => {
            terminalService.writePaths(terminalId, paths)
          },
          resize: async (terminalId, cols, rows) => {
            terminalService.resize(terminalId, cols, rows)
          },
          kill: async (terminalId) => {
            // The Ai-Lab UI auto-spawns a replacement when the last
            // terminal tab is closed (see AppStore.closeTab), so the
            // "never kill the last one" guard the desktop app needed
            // is now actively harmful — it would leave the closed
            // session alive while the frontend creates a new one,
            // producing duplicate tabs.
            terminalService.kill(terminalId)
          },
          setSelection: async (terminalId, selectionText) => {
            terminalService.setSelection(terminalId, selectionText)
          },
          getBufferDelta: async (terminalId, fromOffset) => {
            const data = terminalService.getBufferDelta(terminalId, fromOffset)
            const offset = terminalService.getCurrentOffset(terminalId)
            return { data, offset }
          },
          generateCommandDraft: async (terminalId, prompt, profileId) => {
            return await terminalCommandDraftService.generateCommandDraft({
              terminalId,
              prompt,
              profileId
            })
          }
        },
        filesystemBridge: {
          listDirectory: async (terminalId, dirPath) => {
            return await fileSystemService.listDirectory(terminalId, dirPath)
          },
          readTextFile: async (terminalId, filePath, options) => {
            return await fileSystemService.readTextFile(terminalId, filePath, options)
          },
          readFileBase64: async (terminalId, filePath, options) => {
            return await fileSystemService.readFileBase64(terminalId, filePath, options)
          },
          writeTextFile: async (terminalId, filePath, content) => {
            await fileSystemService.writeTextFile(terminalId, filePath, content)
          },
          writeFileBase64: async (terminalId, filePath, contentBase64, options) => {
            await fileSystemService.writeFileBase64(terminalId, filePath, contentBase64, options)
          },
          transferEntries: async (sourceTerminalId, sourcePaths, targetTerminalId, targetDirPath, options) => {
            return await fileSystemService.transferEntries(
              sourceTerminalId,
              sourcePaths,
              targetTerminalId,
              targetDirPath,
              options
            )
          },
          createDirectory: async (terminalId, dirPath) => {
            await fileSystemService.createDirectory(terminalId, dirPath)
          },
          createFile: async (terminalId, filePath) => {
            await fileSystemService.createFile(terminalId, filePath)
          },
          deletePath: async (terminalId, targetPath, options) => {
            await fileSystemService.deletePath(terminalId, targetPath, options)
          },
          renamePath: async (terminalId, sourcePath, targetPath) => {
            await fileSystemService.renamePath(terminalId, sourcePath, targetPath)
          }
        },
        profileBridge: {
          getProfiles: () => {
            const snapshot = settingsService.getSettings()
            const modelNameById = new Map(snapshot.models.items.map((item) => [item.id, item.model]))
            return {
              activeProfileId: snapshot.models.activeProfileId,
              profiles: snapshot.models.profiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                globalModelId: profile.globalModelId,
                modelName: modelNameById.get(profile.globalModelId)
              }))
            }
          },
          setActiveProfile: (profileId: string) => {
            const snapshot = settingsService.getSettings()
            const exists = snapshot.models.profiles.some((profile) => profile.id === profileId)
            if (!exists) {
              throw new Error(`Profile not found: ${profileId}`)
            }

            settingsService.setSettings({
              models: {
                items: snapshot.models.items,
                profiles: snapshot.models.profiles,
                activeProfileId: profileId
              }
            })

            const next = settingsService.getSettings()
            agentService.updateSettings(next)

            const modelNameById = new Map(next.models.items.map((item) => [item.id, item.model]))
            return {
              activeProfileId: next.models.activeProfileId,
              profiles: next.models.profiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                globalModelId: profile.globalModelId,
                modelName: modelNameById.get(profile.globalModelId)
              }))
            }
          },
          listRemoteModels: (baseUrl: string, apiKey: string) =>
            modelCapabilityService.listRemoteModels(baseUrl, apiKey),
          probeModel: async (model: any) => {
            return await modelCapabilityService.probe(model)
          }
        },
        agentBridge: {
          exportHistory: async (sessionId, mode) => {
            await gatewayService.waitForRunCompletion(sessionId)
            const backendSession = agentService.exportChatSession(sessionId)
            if (!backendSession) {
              throw new Error(`Session with ID ${sessionId} not found`)
            }
            const uiSession = uiHistoryService.getSession(sessionId)
            if (mode === 'simple') {
              const markdown = uiHistoryService.toReadableMarkdown(
                uiSession?.messages || [],
                uiSession?.title || backendSession.title
              )
              return {
                sessionId,
                mode,
                title: uiSession?.title || backendSession.title,
                content: markdown
              }
            }
            return {
              sessionId: backendSession.id,
              mode,
              title: uiSession?.title || backendSession.title,
              lastCheckpointOffset: backendSession.lastCheckpointOffset,
              createdAt: new Date(backendSession.createdAt).toISOString(),
              updatedAt: new Date(backendSession.updatedAt).toISOString(),
              frontendMessages: uiSession?.messages || [],
              backendMessages: backendSession.messages.map((msg: any) => ({
                messageId: msg.id,
                messageType: msg.type,
                messageData: msg.data
              }))
            }
          },
          getAllChatHistory: () => agentService.getAllChatHistory(),
          loadChatSession: (sessionId) => agentService.loadChatSession(sessionId),
          getUiMessages: (sessionId) => uiHistoryService.getMessages(sessionId),
          formatMessagesMarkdown: (sessionId, messageIds) => {
            const session = uiHistoryService.getSession(sessionId)
            if (!session) return ''
            const idSet = new Set(messageIds || [])
            const filtered = session.messages.filter((m: any) => idSet.has(m.id))
            if (filtered.length === 0) return ''
            return uiHistoryService.toReadableMarkdown(filtered, session.title)
          }
        },
        systemBridge: {
          saveTempPaste: async (content: string) => {
            return await saveTempPaste(dataDir, content)
          },
          saveImageAttachment: async (payload: {
            dataBase64: string
            fileName?: string
            mimeType?: string
            previewDataUrl?: string
          }) => {
            return await imageAttachmentService.saveImageAttachment(payload)
          }
        },
        skillBridge: {
          reload: async () => {
            return await skillService.reload()
          },
          getAll: async () => {
            return await skillService.getAll()
          },
          getEnabled: async () => {
            return await skillService.getEnabledSkills()
          },
          create: async () => {
            return await skillService.createSkillFromTemplate()
          },
          importBatch: async (skills: Array<{ name: string; description: string; content: string }>) => {
            const created: any[] = []
            const failed: Array<{ name: string; error: string }> = []
            for (const entry of skills || []) {
              if (!entry?.name || typeof entry.name !== 'string') {
                failed.push({ name: String(entry?.name || '<unnamed>'), error: 'Missing name' })
                continue
              }
              try {
                const result = await skillService.createSkill(
                  entry.name,
                  entry.description || '',
                  entry.content || '',
                )
                created.push(result.skill)
              } catch (err) {
                failed.push({ name: entry.name, error: err instanceof Error ? err.message : String(err) })
              }
            }
            return { created, failed }
          },
          delete: async (fileName: string) => {
            await skillService.deleteSkillFile(fileName)
            return await skillService.getAll()
          },
          listSkills: async () => {
            const snapshot = settingsService.getSettings()
            const enabledMap = snapshot.tools?.skills ?? {}
            const skills = await skillService.getAll()
            return skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              enabled: enabledMap[skill.name] !== false
            }))
          },
          setSkillEnabled: async (name: string, enabled: boolean) => {
            const snapshot = settingsService.getSettings()
            const nextSkills = { ...(snapshot.tools?.skills ?? {}) }
            nextSkills[name] = enabled

            settingsService.setSettings({
              tools: {
                builtIn: snapshot.tools?.builtIn ?? {},
                skills: nextSkills
              }
            })

            const next = settingsService.getSettings()
            agentService.updateSettings(next)
            const skills = await skillService.getAll()
            const summary = buildSkillStatusSummary(skills, next.tools?.skills)
            gatewayService.broadcastRaw('skills:updated', summary)
            return summary
          }
        },
        memoryBridge: {
          get: async () => {
            return await memoryService.getMemorySnapshot()
          },
          setContent: async (content: string) => {
            const snapshot = await memoryService.writeMemory(content)
            gatewayService.broadcastRaw('memory:updated', snapshot)
            return snapshot
          }
        },
        settingsBridge: {
          getSettings: () => settingsService.getSettings(),
          setSettings: async (patch) => {
            if ((patch as any)?.gateway?.ws) {
              throw new Error('settings.gateway.ws is not configurable via websocket RPC.')
            }
            settingsService.setSettings(patch as any)
            const next = settingsService.getSettings()
            agentService.updateSettings(next)
            return next
          }
        },
        commandPolicyBridge: {
          getLists: async () => {
            return await commandPolicyService.getLists()
          },
          addRule: async (listName, rule) => {
            return await commandPolicyService.addRule(listName, rule)
          },
          deleteRule: async (listName, rule) => {
            return await commandPolicyService.deleteRule(listName, rule)
          }
        },
        toolsBridge: {
          reloadMcp: async () => {
            return await mcpToolService.reloadAll()
          },
          getMcp: () => mcpToolService.getSummaries(),
          setMcpEnabled: async (name, enabled) => {
            return await mcpToolService.setServerEnabled(name, enabled)
          },
          getBuiltIn: () => {
            const settings = settingsService.getSettings()
            return buildBuiltInToolStatusSummary(
              settings.tools?.builtIn,
              settings.tools?.builtInPermissions,
            )
          },
          setBuiltInEnabled: async (name, enabled) => {
            const settings = settingsService.getSettings()
            const nextBuiltIn = { ...(settings.tools?.builtIn ?? {}) }
            nextBuiltIn[name] = enabled
            settingsService.setSettings({
              tools: {
                builtIn: nextBuiltIn,
                builtInPermissions: settings.tools?.builtInPermissions,
                skills: settings.tools?.skills ?? {},
              },
            })
            const next = settingsService.getSettings()
            agentService.updateSettings(next)
            const summary = buildBuiltInToolStatusSummary(
              next.tools?.builtIn,
              next.tools?.builtInPermissions,
            )
            gatewayService.broadcastRaw('tools:builtInUpdated', summary)
            return summary
          },
          setBuiltInPermission: async (name, permission) => {
            const valid = new Set(['always-allow', 'ask-once-session', 'always-ask', 'disabled'])
            if (!valid.has(permission)) {
              throw new Error(`Invalid tool permission: ${permission}`)
            }
            const settings = settingsService.getSettings()
            const nextPerms = { ...(settings.tools?.builtInPermissions ?? {}) }
            nextPerms[name] = permission as any
            settingsService.setSettings({
              tools: {
                builtIn: settings.tools?.builtIn ?? {},
                builtInPermissions: nextPerms,
                skills: settings.tools?.skills ?? {},
              },
            })
            const next = settingsService.getSettings()
            agentService.updateSettings(next)
            const summary = buildBuiltInToolStatusSummary(
              next.tools?.builtIn,
              next.tools?.builtInPermissions,
            )
            gatewayService.broadcastRaw('tools:builtInUpdated', summary)
            return summary
          }
        }
      })
  })
  await wsGatewayControlService.applyPolicy(startupPolicy)

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[gybackend] Received ${signal}, shutting down...`)
    try {
      await wsGatewayControlService.stop()
    } catch (error) {
      console.warn('[gybackend] Failed to stop websocket adapter cleanly:', error)
    }

    for (const terminal of terminalService.getDisplayTerminals()) {
      terminalService.kill(terminal.id)
    }

    process.exit(0)
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  console.log('[gybackend] Started.')
  const wsState = wsGatewayControlService.getState()
  if (wsState.running && wsState.host) {
    console.log(`[gybackend] WebSocket RPC endpoint: ws://${wsState.host}:${wsState.port}`)
  } else {
    console.log('[gybackend] WebSocket RPC endpoint: disabled')
  }
  console.log(`[gybackend] Data directory: ${dataDir}`)
  console.log(`[gybackend] Settings file: ${settingsService.getSettingsPath()}`)
  console.log(`[gybackend] Memory file: ${await memoryService.getMemoryFilePath()}`)
  console.log(`[gybackend] Access token file: ${accessTokenService.getStorageFilePath()}`)
}
