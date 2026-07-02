import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import type {
  IGatewayRuntime,
  GatewayEvent,
  GatewayEventType,
  SessionContext,
  IClientTransport,
  StartTaskOptions,
  StartTaskInput,
  GatewaySessionSnapshot,
  GatewaySessionSummary
} from './types';
import type { UIHistoryService } from '../UIHistoryService';
import type { StoredChatSession } from '../ChatHistoryService';
import type {
  IAgentRuntime,
  ICommandPolicyRuntime,
  IGatewayTerminalRuntime,
  IMcpRuntime,
  ISettingsRuntime
} from '../runtimeContracts';
import { getRunExperimentalFlagsFromSettings } from '../AgentHelper/utils/experimental_flags';
import { TransportHub } from './TransportHub';

export class GatewayService extends EventEmitter implements IGatewayRuntime {
  private sessions: Map<string, SessionContext> = new Map();
  private eventBus: EventEmitter = new EventEmitter();
  private feedbackBus: EventEmitter = new EventEmitter();
  private feedbackCache: Map<string, any> = new Map();
  private transportHub: TransportHub = new TransportHub();

  constructor(
    private terminalService: IGatewayTerminalRuntime,
    private agentService: IAgentRuntime,
    private uiHistoryService: UIHistoryService,
    private commandPolicyService: ICommandPolicyRuntime,
    private settingsService: ISettingsRuntime,
    private mcpToolService: IMcpRuntime
  ) {
    super();

    this.terminalService.setRawEventPublisher((channel, data) => this.broadcastRaw(channel, data));
    this.agentService.setEventPublisher((sessionId, event) => {
      this.broadcast({
        type: 'agent:event',
        sessionId,
        payload: event
      });
    });
    this.agentService.setFeedbackWaiter((messageId, timeoutMs) => this.waitForFeedback(messageId, timeoutMs));
    this.commandPolicyService.setFeedbackWaiter((messageId, timeoutMs) =>
      this.waitForFeedback(messageId, timeoutMs)
    );
    
    this.setupInternalSubscriptions();
    this.setupServiceSubscriptions();
    this.setupAgentPoolBridge();
  }

  /**
   * Wire the AgentModelPool's per-agent in-flight counters to a broadcast
   * channel. The frontend subscribes via the web shim / electron preload's
   * `agents.onActiveCountsUpdated` listener and renders the counts as
   * badges on the sidebar agent icons.
   */
  private setupAgentPoolBridge() {
    void import('../AgentHelper/tools/delegate_agent_tool').then((mod) => {
      mod.setAgentPoolActivityObserver((counts) => {
        this.broadcastRaw('agents:active', counts);
      });
    }).catch((err) => {
      console.warn('[GatewayService] failed to wire agent pool bridge:', err);
    });
  }

  public registerTransport(transport: IClientTransport) {
    this.transportHub.register(transport);
  }

  public unregisterTransport(transportId: string) {
    this.transportHub.unregister(transportId);
  }

  private setupServiceSubscriptions() {
    // MCP tool status updates
    this.mcpToolService.on('updated', (summary) => {
      this.transportHub.send('tools:mcpUpdated', summary);
    });
  }

  private setupInternalSubscriptions() {
    // UIHistoryService subscribes to all agent events for persistence
    this.subscribe('agent:event', (event) => {
      const actions = this.uiHistoryService.recordEvent(event.sessionId!, event.payload);
      
      // 1. Send processed UI Actions (for core UI like message list)
      actions.forEach(action => this.transportHub.sendUIUpdate(action));
      // 2. Send raw Agent Event (for auxiliary components like Banners, status lights, etc.)
      this.transportHub.emitEvent(event);
    });
  }

  async createSession(): Promise<string> {
    const sessionId = uuidv4();
    const context = this.createEmptySessionContext(sessionId);
    this.sessions.set(sessionId, context);
    return sessionId;
  }

  getSession(sessionId: string): SessionContext | undefined {
    return this.sessions.get(sessionId);
  }

  async dispatchTask(sessionId: string, input: StartTaskInput, options?: StartTaskOptions): Promise<void> {
    let context = this.sessions.get(sessionId);
    if (!context) {
      context = this.createEmptySessionContext(sessionId);
      this.sessions.set(sessionId, context);
    }

    this.ensureSessionProfileLock(context);

    if (context.status !== 'idle') {
      await this.stopTask(sessionId, {
        waitForCompletion: true,
        preserveProfileLock: true
      });
    } else {
      // Handle race: status already idle but previous run finalization not finished yet.
      await this.waitForRunCompletionIfAny(sessionId);
    }

    const runId = uuidv4();
    const abortController = new AbortController();
    let resolveRunCompletion: () => void = () => {};
    const runCompletion = new Promise<void>((resolve) => {
      resolveRunCompletion = resolve;
    });

    context.activeRunId = runId;
    context.abortController = abortController;
    context.status = 'running';
    context.metadata.runCompletion = runCompletion;
    context.metadata.runId = runId;
    // View-context (req 3): stash the sender's current-view snapshot for this run
    // so AgentService can inject a cheap summary into the turn. Cleared each run.
    context.metadata.viewSnapshot = options?.viewSnapshot;

    try {
      // AgentService has been refactored as stateless run
      await this.agentService.run(context, input, abortController.signal, options?.startMode || 'normal');
    } catch (error: any) {
      const isAbortError =
        typeof this.agentService.isAbortError === 'function'
          ? this.agentService.isAbortError(error)
          : (error instanceof Error && (error.name === 'AbortError' || error.message === 'AbortError'));
      if (isAbortError) {
        // User stopped manually, not treated as an error, handled by stopTask
        return;
      }
      console.error(`[GatewayService] Task execution error (sessionId=${sessionId}):`, error);
      // Error broadcasting is now handled inside agentService.run for better detail capture,
      // but we keep a fallback here just in case.
    } finally {
      resolveRunCompletion();
      // clear completion tracker for this run id
      if (context.metadata.runId === runId) {
        delete context.metadata.runCompletion;
        delete context.metadata.runId;
      }
      if (context.activeRunId === runId) {
        // Unified cleanup of run state
        this.clearRunState(context);
        this.releaseSessionProfileLock(context);
        // 1. Send DONE action (for UI state like isThinking)
        this.broadcast({ type: 'agent:event', sessionId, payload: { type: 'done' } });
        // 2. Send SESSION_READY action (for admission control and queue scheduling)
        // This MUST be sent after clearRunState to ensure backend is truly idle
        this.transportHub.sendUIUpdate({ type: 'SESSION_READY', sessionId });
        this.uiHistoryService.flush(sessionId);
      }
    }
  }

  /**
   * ConversationBus seam (fleet vertical): run an agent's turn from delivered
   * inter-agent messages, reusing the full normal-dispatch lifecycle (profile
   * lock, abort wiring, DONE/SESSION_READY, transcript persistence). Resolves
   * when the turn completes so the bus can mark deliveries done in order.
   *
   * Single-flight is enforced UPSTREAM by the bus's per-agent inbox (one
   * in-flight run per sessionId), and delivery-triggered inference only reaches
   * here when the bus's kill switch (autonomousRoutingEnabled) is on and the
   * guards pass — so this is a thin, safe delegation, not a new code path.
   */
  async dispatchFromBus(sessionId: string, input: StartTaskInput): Promise<void> {
    return this.dispatchTask(sessionId, input, { startMode: 'normal' });
  }

  async stopTask(
    sessionId: string,
    options?: { waitForCompletion?: boolean; preserveProfileLock?: boolean }
  ): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (context && context.abortController) {
      const runCompletion = context.metadata.runCompletion as Promise<void> | undefined;
      context.abortController.abort();
      this.clearRunState(context);
      if (!options?.preserveProfileLock) {
        this.releaseSessionProfileLock(context);
      }
      // Sync UI and disk immediately on a real stop.
      // For inserted-message restart flow, dispatchTask will continue with a new run immediately,
      // so we intentionally avoid emitting SESSION_READY here.
      if (!options?.preserveProfileLock) {
        this.broadcast({ type: 'agent:event', sessionId, payload: { type: 'done' } });
        this.transportHub.sendUIUpdate({ type: 'SESSION_READY', sessionId });
        this.uiHistoryService.flush(sessionId);
      }
      if (options?.waitForCompletion && runCompletion) {
        await runCompletion.catch(() => undefined);
      }
      return;
    }
    if (context && options?.waitForCompletion) {
      const runCompletion = context.metadata.runCompletion as Promise<void> | undefined;
      if (runCompletion) {
        await runCompletion.catch(() => undefined);
      }
    }
  }

  async waitForRunCompletion(sessionId: string): Promise<void> {
    await this.waitForRunCompletionIfAny(sessionId);
  }

  listSessionSummaries(): GatewaySessionSummary[] {
    const uiSummaryById = new Map(
      this.uiHistoryService
        .getAllSessionSummaries()
        .map((session) => [session.id, session] as const)
    );
    const storedById = new Map(
      this.agentService
        .listStoredChatSessions()
        .map((session) => [session.id, session] as const)
    );
    const knownSessionIds = new Set<string>([
      ...uiSummaryById.keys(),
      ...storedById.keys(),
      ...this.sessions.keys()
    ]);

    return Array.from(knownSessionIds)
      .map((sessionId) => {
        const uiSummary = uiSummaryById.get(sessionId);
        const storedSession = storedById.get(sessionId);
        const context = this.sessions.get(sessionId);
        const isBusy = context ? context.status !== 'idle' : false;
        const lockedProfileId = isBusy && context ? context.lockedProfileId || null : null;

        return {
          id: sessionId,
          title: this.resolveSessionTitle(
            uiSummary?.title,
            storedSession?.title,
            context
          ),
          updatedAt: this.resolveSessionUpdatedAt(
            uiSummary?.updatedAt,
            storedSession?.updatedAt,
            context
          ),
          messagesCount: this.resolveSessionMessageCount(uiSummary, storedSession),
          lastMessagePreview: this.normalizeSessionPreview(
            uiSummary?.lastMessagePreview || ''
          ),
          isBusy,
          lockedProfileId
        };
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getSessionSnapshot(sessionId: string): GatewaySessionSnapshot | null {
    const session = this.uiHistoryService.getSession(sessionId);
    const storedSession = this.agentService.exportChatSession(sessionId);
    const context = this.sessions.get(sessionId);
    if (!session && !storedSession && !context) return null;

    const resolvedSessionId = session?.id || storedSession?.id || sessionId;
    const isBusy = context ? context.status !== 'idle' : false;
    const lockedProfileId = isBusy ? context?.lockedProfileId || null : null;
    return {
      id: resolvedSessionId,
      title: this.resolveSessionTitle(
        session?.title,
        storedSession?.title,
        context
      ),
      updatedAt: this.resolveSessionUpdatedAt(
        session?.updatedAt,
        storedSession?.updatedAt,
        context
      ),
      messages: (session?.messages || []).map((message) => ({
        ...message,
        metadata: message.metadata ? { ...message.metadata } : undefined
      })),
      isBusy,
      lockedProfileId
    };
  }

  submitFeedback(messageId: string, payload: any): { ok: true } {
    this.feedbackCache.set(messageId, payload);
    this.feedbackBus.emit(`feedback:${messageId}`, payload);
    return { ok: true };
  }

  async deleteChatSession(sessionId: string): Promise<void> {
    await this.stopTask(sessionId);
    this.agentService.deleteChatSession(sessionId);
    this.uiHistoryService.deleteSession(sessionId);
    this.sessions.delete(sessionId);
  }

  renameSession(sessionId: string, newTitle: string): void {
    this.agentService.renameChatSession(sessionId, newTitle);
  }

  async rollbackSessionToMessage(
    sessionId: string,
    messageId: string
  ): Promise<{ ok: boolean; removedCount: number }> {
    await this.stopTask(sessionId);
    this.broadcast({
      type: 'agent:event',
      sessionId,
      payload: {
        type: 'rollback',
        messageId
      }
    });
    return this.agentService.rollbackToMessage(sessionId, messageId);
  }

  private async waitForRunCompletionIfAny(sessionId: string): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (!context) return;
    const runCompletion = context.metadata.runCompletion as Promise<void> | undefined;
    if (runCompletion) {
      await runCompletion.catch(() => undefined);
    }
  }

  private clearRunState(context: SessionContext) {
    context.status = 'idle';
    context.activeRunId = null;
    context.abortController = null;
    // Clean up cache for this session's messages if any remain
    // (In a real scenario, we might need a way to map messageId to sessionId here,
    // but for now, the cache is self-cleaning on read)
  }

  private releaseSessionProfileLock(context: SessionContext) {
    if (context.lockedProfileId) {
      this.agentService.releaseSessionModelBinding(context.sessionId);
    }
    context.lockedProfileId = null;
    context.lockedExperimentalFlags = null;
  }

  private createEmptySessionContext(sessionId: string): SessionContext {
    return {
      sessionId,
      activeRunId: null,
      lockedProfileId: null,
      lockedExperimentalFlags: null,
      abortController: null,
      status: 'idle',
      metadata: {
        createdAt: Date.now()
      }
    };
  }

  private resolveSessionTitle(
    uiTitle?: string,
    storedTitle?: string,
    context?: SessionContext
  ): string {
    const preferredTitle = [uiTitle, storedTitle]
      .find((value) => typeof value === 'string' && value.trim().length > 0);
    if (preferredTitle) {
      return preferredTitle;
    }
    if (context) {
      return 'New Chat';
    }
    return 'Recovered Session';
  }

  private resolveSessionUpdatedAt(
    uiUpdatedAt?: number,
    storedUpdatedAt?: number,
    context?: SessionContext
  ): number {
    if (typeof uiUpdatedAt === 'number' && Number.isFinite(uiUpdatedAt)) {
      return uiUpdatedAt;
    }
    if (typeof storedUpdatedAt === 'number' && Number.isFinite(storedUpdatedAt)) {
      return storedUpdatedAt;
    }
    const contextCreatedAt = context?.metadata?.createdAt;
    if (typeof contextCreatedAt === 'number' && Number.isFinite(contextCreatedAt)) {
      return contextCreatedAt;
    }
    return Date.now();
  }

  private resolveSessionMessageCount(
    uiSummary:
      | { messagesCount?: number }
      | undefined,
    storedSession?: StoredChatSession
  ): number {
    if (
      typeof uiSummary?.messagesCount === 'number' &&
      Number.isFinite(uiSummary.messagesCount)
    ) {
      return uiSummary.messagesCount;
    }
    if (Array.isArray(storedSession?.messages)) {
      return storedSession.messages.length;
    }
    return 0;
  }

  private ensureSessionProfileLock(context: SessionContext): void {
    if (context.lockedProfileId) return;
    const settings = this.settingsService.getSettings();
    context.lockedProfileId = settings.models.activeProfileId || '';
    context.lockedExperimentalFlags = getRunExperimentalFlagsFromSettings(settings);
    this.transportHub.sendUIUpdate({
      type: 'SESSION_PROFILE_LOCKED',
      sessionId: context.sessionId,
      lockedProfileId: context.lockedProfileId || null
    });
  }

  async pauseTask(sessionId: string): Promise<void> {
    const context = this.sessions.get(sessionId);
    if (context) context.status = 'paused';
  }

  async resumeTask(_sessionId: string): Promise<void> {
    // Future implementation of re-trigger logic
  }

  // Event distribution method, renamed to broadcast to avoid conflict with EventEmitter's emit
  broadcast(event: Omit<GatewayEvent, 'id' | 'timestamp'>): void {
    const fullEvent: GatewayEvent = {
      ...event,
      id: uuidv4(),
      timestamp: Date.now()
    };

    // 1. Internal bus distribution (for other Services like UIHistoryService)
    this.eventBus.emit(fullEvent.type, fullEvent);

    // 2. Send to frontend via all transports.
    // agent:event is emitted by the internal subscription path after UI action generation,
    // so we skip direct fan-out here to avoid duplicate delivery.
    if (fullEvent.type !== 'agent:event') {
      this.transportHub.emitEvent(fullEvent);
    }
  }

  // Raw data distribution for non-GatewayEvent messages (e.g. terminal data)
  broadcastRaw(channel: string, data: any): void {
    this.transportHub.send(channel, data);
  }

  subscribe(type: GatewayEventType, handler: (event: GatewayEvent) => void): () => void {
    this.eventBus.on(type, handler);
    return () => this.eventBus.off(type, handler);
  }

  async waitForFeedback<T>(messageId: string, timeoutMs: number = 120000): Promise<T | null> {
    // 1. Check cache first (in case frontend replied before backend started waiting)
    if (this.feedbackCache.has(messageId)) {
      const cached = this.feedbackCache.get(messageId);
      this.feedbackCache.delete(messageId);
      console.log(`[GatewayService] Using cached feedback for messageId=${messageId}`);
      return cached as T;
    }

    return new Promise((resolve) => {
      const eventName = `feedback:${messageId}`;
      const timer = setTimeout(() => {
        this.feedbackBus.off(eventName, handler);
        resolve(null);
      }, timeoutMs);

      const handler = (payload: T) => {
        clearTimeout(timer);
        this.feedbackBus.off(eventName, handler);
        this.feedbackCache.delete(messageId); // Cleanup cache if it was set during waiting
        resolve(payload);
      };

      this.feedbackBus.on(eventName, handler);
    });
  }

  private normalizeSessionPreview(input: string): string {
    return String(input || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }
}
