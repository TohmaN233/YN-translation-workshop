import {
  Agent,
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  compact as compactSession,
  convertToLlm,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type Session,
  type ThinkingLevel
} from "@earendil-works/pi-agent-core/node";
import {
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Model,
  type Models,
  type SimpleStreamOptions
} from "@earendil-works/pi-ai";
import { runWithProviderFetchDiagnostics } from "../providers/proxyFetch.ts";

import type {
  PiSessionCompactionResult,
  PiSessionRuntimeEvent as PiRuntimeEvent
} from "../../../shared/agent/piSessionContract.ts";
import { compactSubagentCards } from "./subagentMessages.ts";

type RuntimeListener = (event: PiRuntimeEvent, signal?: AbortSignal) => Promise<void> | void;

interface PendingSessionMessage {
  message: AgentMessage;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface PendingQueueConsumption {
  kind: "steer" | "followUp";
  retainOnSettle: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class PiQueuedInputNotConsumedError extends Error {}

export interface PiSessionAgentRuntimeOptions {
  session: Session;
  sessionId: string;
  models: Models;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  tools: AgentTool[];
  providerStreamTimeouts?: PiProviderStreamTimeouts;
  retry?: Partial<PiAutoRetrySettings>;
  deferThresholdCompaction?: () => boolean;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal
  ) => Promise<AfterToolCallResult | undefined>;
}

export interface PiProviderStreamTimeouts {
  inactivityMs: number;
}

interface PiProviderErrorCause {
  name?: string;
  message: string;
  code?: string | number;
  errno?: string | number;
  syscall?: string;
  address?: string;
  port?: string | number;
  type?: string;
  stack?: string;
  cause?: PiProviderErrorCause;
}

interface PiProviderErrorDiagnostic {
  provider: string;
  model: string;
  api: string;
  source: "fetch_exception" | "provider_stream_error" | "stream_timeout";
  error: PiProviderErrorCause;
  details?: Record<string, unknown>;
}

export interface PiAutoRetrySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
}

export const DEFAULT_PI_PROVIDER_STREAM_TIMEOUTS: PiProviderStreamTimeouts = {
  // Reasoning models such as Grok 4.6 can stay silent for minutes before the first token.
  inactivityMs: 3_000_000
};

export const DEFAULT_PI_AUTO_RETRY_SETTINGS: PiAutoRetrySettings = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2_000
};

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function providerTimeoutError(
  model: Model<any>,
  partial: AssistantMessage | undefined,
  message: string
): AssistantMessage {
  return {
    role: "assistant",
    content: partial?.content ?? [],
    api: partial?.api ?? model.api,
    provider: partial?.provider ?? model.provider,
    model: partial?.model ?? model.id,
    ...(partial?.responseModel ? { responseModel: partial.responseModel } : {}),
    ...(partial?.responseId ? { responseId: partial.responseId } : {}),
    usage: partial?.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now()
  };
}

function eventAssistantMessage(event: AssistantMessageEvent): AssistantMessage | undefined {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return event.partial;
}

function streamPiProviderWithTimeouts(args: {
  models: Models;
  model: Model<any>;
  context: Context;
  options?: SimpleStreamOptions;
  timeouts: PiProviderStreamTimeouts;
  onProviderError?: (diagnostic: PiProviderErrorDiagnostic) => Promise<void>;
}): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const controller = new AbortController();
  let finished = false;
  let latest: AssistantMessage | undefined;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const reportedDiagnostics = new Set<string>();

  const reportProviderError = async (diagnostic: PiProviderErrorDiagnostic) => {
    const fingerprint = JSON.stringify({
      provider: diagnostic.provider,
      model: diagnostic.model,
      api: diagnostic.api,
      error: diagnostic.error,
      details: diagnostic.details
    });
    if (reportedDiagnostics.has(fingerprint)) return;
    await args.onProviderError?.(diagnostic);
    reportedDiagnostics.add(fingerprint);
  };

  const cleanup = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    args.options?.signal?.removeEventListener("abort", onParentAbort);
  };
  const failForTimeout = (timeoutMs: number) => {
    if (finished) return;
    finished = true;
    cleanup();
    const timeoutCause = new Error(`Pi provider stream inactivity timeout after ${timeoutMs}ms`);
    controller.abort(timeoutCause);
    const error = providerTimeoutError(
      args.model,
      latest,
      `Pi provider stream inactivity timeout after ${timeoutMs}ms. The request was aborted and may be retried.`
    );
    void (async () => {
      try {
        await reportProviderError({
          provider: args.model.provider,
          model: args.model.id,
          api: args.model.api,
          source: "stream_timeout",
          error: serializeProviderErrorCause(timeoutCause),
          details: { phase: "stream_inactivity_timeout", timeoutMs }
        });
      } catch (diagnosticError) {
        error.errorMessage += ` Durable transport diagnostics failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`;
      }
      output.push({ type: "error", reason: "error", error });
      output.end(error);
    })();
  };
  const armInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(
      () => failForTimeout(args.timeouts.inactivityMs),
      args.timeouts.inactivityMs
    );
  };
  const onParentAbort = () => {
    if (finished) return;
    finished = true;
    cleanup();
    controller.abort(args.options?.signal?.reason);
    const aborted = providerTimeoutError(
      args.model,
      latest,
      args.options?.signal?.reason instanceof Error
        ? args.options.signal.reason.message
        : "Pi provider request was aborted."
    );
    aborted.stopReason = "aborted";
    output.push({ type: "error", reason: "aborted", error: aborted });
    output.end(aborted);
  };

  args.options?.signal?.addEventListener("abort", onParentAbort, { once: true });
  if (args.options?.signal?.aborted) onParentAbort();
  if (!finished) {
    armInactivityTimer();
  }

  queueMicrotask(async () => {
    if (finished) return;
    try {
      const stream = runWithProviderFetchDiagnostics(
        async (error) => {
          await reportProviderError({
            provider: args.model.provider,
            model: args.model.id,
            api: args.model.api,
            source: "fetch_exception",
            error: serializeProviderErrorCause(error)
          });
        },
        () => args.models.streamSimple(args.model, args.context, {
          ...args.options,
          signal: controller.signal
        })
      );
      for await (const event of stream) {
        if (finished) break;
        latest = eventAssistantMessage(event);
        armInactivityTimer();
        if (event.type === "error") {
          const diagnostic = providerStreamErrorDiagnostic(args.model, event.error);
          if (diagnostic) await reportProviderError(diagnostic);
        }
        output.push(event);
        if (event.type === "done" || event.type === "error") {
          finished = true;
          cleanup();
          output.end(event.type === "done" ? event.message : event.error);
        }
      }
    } catch (error) {
      if (finished) return;
      finished = true;
      cleanup();
      const message = error instanceof Error ? error.message : String(error);
      const assistant = providerTimeoutError(args.model, latest, message);
      output.push({ type: "error", reason: "error", error: assistant });
      output.end(assistant);
    }
  });

  return output;
}

function serializeProviderErrorCause(error: unknown, depth = 0): PiProviderErrorCause {
  const bounded = (value: unknown, max = 4_000) => String(value).slice(0, max);
  if (error === null || (typeof error !== "object" && !(error instanceof Error))) {
    return { message: bounded(error) };
  }
  const record = error as Error & Record<string, unknown>;
  const message = error instanceof Error
    ? error.message
    : typeof record.message === "string"
      ? record.message
      : JSON.stringify(error);
  const diagnostic: PiProviderErrorCause = {
    ...(typeof record.name === "string" ? { name: bounded(record.name, 160) } : {}),
    message: bounded(message),
    ...(typeof record.stack === "string" ? { stack: bounded(record.stack, 8_000) } : {})
  };
  for (const key of ["code", "errno", "syscall", "address", "port", "type"] as const) {
    const value = record[key];
    if (typeof value === "string") diagnostic[key] = bounded(value, 500) as never;
    else if (typeof value === "number") diagnostic[key] = value as never;
  }
  if (depth < 4 && record.cause !== undefined) {
    diagnostic.cause = serializeProviderErrorCause(record.cause, depth + 1);
  }
  return diagnostic;
}

const DURABLE_PROVIDER_DETAIL_KEYS = new Set([
  "configuredTransport",
  "attemptedTransport",
  "transport",
  "phase",
  "requestBytes",
  "responseStatus",
  "fallbackAttempted",
  "fallbackMode",
  "webSocketCloseCode",
  "webSocketFailureCount"
]);

function durableProviderDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const details: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!DURABLE_PROVIDER_DETAIL_KEYS.has(key)) continue;
    if (typeof raw === "string") details[key] = raw.slice(0, 1_000);
    else if (typeof raw === "number" || typeof raw === "boolean" || raw === null) details[key] = raw;
  }
  return details;
}

function providerStreamErrorDiagnostic(
  model: Model<any>,
  error: AssistantMessage
): PiProviderErrorDiagnostic | undefined {
  const diagnostics = (error as AssistantMessage & { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics)) return undefined;
  const raw = diagnostics.find((candidate) => (
    candidate !== null
    && typeof candidate === "object"
    && (candidate as unknown as Record<string, unknown>).type === "provider_transport_failure"
  )) as unknown as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const cause = serializeProviderErrorCause(
    raw.error ?? { name: "ProviderStreamError", message: error.errorMessage ?? "Provider stream failed." }
  );
  const details = durableProviderDetails(raw.details);
  const websocketFailure = /websocket/iu.test(`${cause.name ?? ""} ${cause.message}`)
    || cause.code === 1006
    || cause.code === "1006";
  if (websocketFailure && details.webSocketFailureCount === undefined) {
    details.webSocketFailureCount = 1;
  }
  return {
    provider: model.provider,
    model: model.id,
    api: model.api,
    source: "provider_stream_error",
    error: cause,
    ...(Object.keys(details).length > 0 ? { details } : {})
  };
}

function userMessage(text: string, images?: ImageContent[]): AgentMessage {
  const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
  if (images) content.push(...images);
  return { role: "user", content, timestamp: Date.now() };
}

function removeMessage(queue: AgentMessage[], message: AgentMessage): boolean {
  const index = queue.findIndex((candidate) => candidate === message);
  if (index < 0) return false;
  queue.splice(index, 1);
  return true;
}

/**
 * Pi-native session runtime source-adapted from pi AgentSession around the core
 * Agent. Native custom messages let background child completion trigger a parent
 * turn without manufacturing an empty user message. JSONL persistence remains
 * the Session's responsibility and every live event remains a native Pi event.
 */
export class PiSessionAgentRuntime {
  private readonly sessionId: string;
  private readonly session: Session;
  private readonly models: Models;
  private readonly agent: Agent;
  private readonly listeners = new Set<RuntimeListener>();
  private readonly queuedSteer: AgentMessage[] = [];
  private readonly queuedFollowUp: AgentMessage[] = [];
  private readonly queuedNextTurn: AgentMessage[] = [];
  private readonly pendingQueueConsumptions = new Map<AgentMessage, PendingQueueConsumption>();
  private readonly pendingSessionMessages: PendingSessionMessage[] = [];
  private readonly unsubscribeAgent: () => void;
  private sessionOperationTail: Promise<void> = Promise.resolve();
  private sessionFailure?: unknown;
  private phase: "idle" | "running" | "settling" = "idle";
  private initialized = false;
  private initializeTask?: Promise<void>;
  private lastAssistantMessage?: AssistantMessage;
  private overflowRecoveryAttempted = false;
  private readonly retrySettings: PiAutoRetrySettings;
  private retryAttempt = 0;
  private retryAbortController?: AbortController;
  private readonly deferThresholdCompaction: () => boolean;
  private resetContextActive = false;
  private resetContextStartEntryId?: string;

  constructor(options: PiSessionAgentRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.session = options.session;
    this.models = options.models;
    this.retrySettings = { ...DEFAULT_PI_AUTO_RETRY_SETTINGS, ...options.retry };
    this.deferThresholdCompaction = options.deferThresholdCompaction ?? (() => false);
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        tools: options.tools,
        messages: []
      },
      sessionId: options.sessionId,
      convertToLlm,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      afterToolCall: options.afterToolCall,
      streamFn: (model, context, streamOptions) => streamPiProviderWithTimeouts({
        models: this.models,
        model,
        context,
        options: streamOptions,
        timeouts: options.providerStreamTimeouts ?? DEFAULT_PI_PROVIDER_STREAM_TIMEOUTS,
        onProviderError: async (diagnostic) => {
          await this.appendCustomEntry("yn_provider_transport_error", {
            timestamp: Date.now(),
            sessionId: this.sessionId,
            ...diagnostic
          });
        }
      })
    });
    this.unsubscribeAgent = this.agent.subscribe((event, signal) => this.handleAgentEvent(event, signal));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initializeTask ??= this.runSessionOperation(() => this.session.buildContext()).then((context) => {
      this.agent.state.messages = compactSubagentCards(context.messages);
      this.initialized = true;
    });
    try {
      await this.initializeTask;
    } finally {
      if (!this.initialized) this.initializeTask = undefined;
    }
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(input: string | AgentMessage | AgentMessage[], options?: { images?: ImageContent[] }): Promise<void> {
    await this.initialize();
    await this.compactBeforePromptIfNeeded();
    const initial = typeof input === "string"
      ? [userMessage(input, options?.images)]
      : Array.isArray(input) ? input : [input];
    const queued = this.queuedNextTurn.splice(0);
    if (queued.length > 0) await this.emitQueueUpdate();
    this.phase = "running";
    try {
      await this.agent.prompt([...queued, ...initial]);
      while (await this.handlePostAgentRun()) {
        await this.agent.continue();
      }
      await this.drainPendingQueueConsumptions();
    } finally {
      this.phase = "settling";
      try {
        await this.flushPendingSessionMessages();
      } finally {
        this.phase = "idle";
        await this.rejectUnconsumedQueueMessages(
          new PiQueuedInputNotConsumedError("Pi turn finished before a queued Steer or Follow-up message could be consumed.")
        );
        await this.emit({ type: "settled", nextTurnCount: this.queuedNextTurn.length });
      }
    }
  }

  async steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    await this.steerMessage(userMessage(text, options?.images));
  }

  async steerAndWaitForConsumption(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    const { consumed } = await this.queueSteer(text, options);
    await consumed;
  }

  async queueSteer(
    text: string,
    options?: { images?: ImageContent[] }
  ): Promise<{ consumed: Promise<void> }> {
    return this.enqueueQueuedMessage("steer", userMessage(text, options?.images), false);
  }

  async steerMessage(message: AgentMessage): Promise<void> {
    await this.enqueueQueuedMessage("steer", message, true);
  }

  async followUp(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    await this.followUpMessage(userMessage(text, options?.images));
  }

  async followUpMessage(message: AgentMessage): Promise<void> {
    await this.enqueueQueuedMessage("followUp", message, true);
  }

  async followUpMessageAndWaitForConsumption(message: AgentMessage): Promise<void> {
    const { consumed } = await this.enqueueQueuedMessage("followUp", message, false);
    await consumed;
  }

  async nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    this.queuedNextTurn.push(userMessage(text, options?.images));
    await this.emitQueueUpdate();
  }

  async appendMessage(message: AgentMessage): Promise<void> {
    if (this.phase !== "idle") {
      await new Promise<void>((resolve, reject) => {
        this.pendingSessionMessages.push({ message, resolve, reject });
      });
      return;
    }
    await this.persistExternalMessage(message);
  }

  async appendCustomEntry(customType: string, data: unknown): Promise<void> {
    await this.runSessionOperation(async () => {
      await this.session.appendCustomEntry(customType, data);
    });
  }

  async compact(customInstructions?: string): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  }> {
    if (this.agent.state.isStreaming) throw new Error("compact() requires an idle Pi Agent");
    const fullBranchEntries = await this.runSessionOperation(() => this.session.getBranch());
    let branchEntries = fullBranchEntries;
    if (this.resetContextActive) {
      if (!this.resetContextStartEntryId) throw new Error("Nothing to compact");
      const resetStartIndex = fullBranchEntries.findIndex((entry) => entry.id === this.resetContextStartEntryId);
      if (resetStartIndex < 0) {
        throw new Error(`Pi reset-context entry ${this.resetContextStartEntryId} is missing from the active branch.`);
      }
      branchEntries = fullBranchEntries.slice(resetStartIndex);
    }
    const preparationResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS);
    if (!preparationResult.ok) throw preparationResult.error;
    if (!preparationResult.value) throw new Error("Nothing to compact");
    const result = await compactSession(
      preparationResult.value,
      this.models,
      this.agent.state.model,
      customInstructions,
      undefined,
      this.agent.state.thinkingLevel
    );
    if (!result.ok) throw result.error;
    await this.runSessionOperation(() => this.session.appendCompaction(
      result.value.summary,
      result.value.firstKeptEntryId,
      result.value.tokensBefore,
      result.value.details
    ));
    const context = await this.runSessionOperation(() => this.session.buildContext());
    this.agent.state.messages = compactSubagentCards(context.messages);
    this.initialized = true;
    return result.value;
  }

  getModel(): Model<any> {
    return this.agent.state.model;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getThinkingLevel(): ThinkingLevel {
    return this.agent.state.thinkingLevel;
  }

  getMessages(): AgentMessage[] {
    return [...this.agent.state.messages];
  }

  reconfigure(options: { systemPrompt: string; tools: AgentTool[] }): void {
    if (this.phase !== "idle" || this.agent.state.isStreaming) {
      throw new Error("Pi runtime can only be reconfigured while idle.");
    }
    this.agent.state.systemPrompt = options.systemPrompt;
    this.agent.state.tools = options.tools;
  }

  resetContext(): void {
    if (this.phase !== "idle" || this.agent.state.isStreaming) {
      throw new Error("Pi runtime context can only be reset while idle.");
    }
    if (
      this.queuedSteer.length > 0
      || this.queuedFollowUp.length > 0
      || this.queuedNextTurn.length > 0
      || this.pendingQueueConsumptions.size > 0
    ) {
      throw new Error("Pi runtime context cannot reset while queued user input is pending.");
    }
    this.agent.reset();
    this.initialized = true;
    this.resetContextActive = true;
    this.resetContextStartEntryId = undefined;
  }

  async abort(): Promise<{ clearedSteer: AgentMessage[]; clearedFollowUp: AgentMessage[] }> {
    const clearedSteer = this.queuedSteer.splice(0);
    const clearedFollowUp = this.queuedFollowUp.splice(0);
    this.agent.clearAllQueues();
    this.retryAbortController?.abort(new Error("Retry cancelled"));
    this.agent.abort();
    await this.emitQueueUpdate();
    await this.agent.waitForIdle();
    await this.rejectUnconsumedQueueMessages(
      new PiQueuedInputNotConsumedError("Pi turn stopped before a queued Steer or Follow-up message could be consumed.")
    );
    await this.emit({
      type: "abort",
      clearedSteer: clearedSteer.filter((message) => message.role === "user"),
      clearedFollowUp: clearedFollowUp.filter((message) => message.role === "user")
    });
    return {
      clearedSteer: clearedSteer.filter((message) => message.role === "user"),
      clearedFollowUp: clearedFollowUp.filter((message) => message.role === "user")
    };
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  acceptsQueuedInput(): boolean {
    return this.phase === "running" && this.agent.state.isStreaming;
  }

  dispose(): void {
    this.retryAbortController?.abort(new Error("Runtime disposed"));
    // A runtime can be replaced after Pi emits `settled` but while its outer
    // prompt task is still finalizing. Always abort the native Agent before
    // detaching listeners so no provider stream can outlive its owner.
    this.agent.clearAllQueues();
    this.agent.abort();
    this.unsubscribeAgent();
    this.listeners.clear();
  }

  private async handleAgentEvent(event: AgentEvent, signal: AbortSignal): Promise<void> {
    if (event.type === "message_start" && event.message.role === "user") {
      this.overflowRecoveryAttempted = false;
    }
    if (event.type === "message_end") {
      const entryId = await this.runSessionOperation(() => this.session.appendMessage(event.message));
      this.captureResetContextStart(entryId);
      if (event.message.role === "assistant") {
        this.lastAssistantMessage = event.message;
        if (event.message.stopReason !== "error") {
          this.overflowRecoveryAttempted = false;
          if (this.retryAttempt > 0) {
            await this.emit({
              type: "auto_retry_end",
              success: true,
              attempt: this.retryAttempt
            }, signal);
            this.retryAttempt = 0;
          }
        }
      }
      const queueChanged = removeMessage(this.queuedSteer, event.message)
        || removeMessage(this.queuedFollowUp, event.message);
      const consumption = this.pendingQueueConsumptions.get(event.message);
      if (consumption) {
        this.pendingQueueConsumptions.delete(event.message);
        consumption.resolve();
      }
      if (queueChanged) await this.emitQueueUpdate(signal);
      await this.emit(event as PiRuntimeEvent, signal);
      return;
    }
    if (event.type === "turn_end") {
      await this.emit(event as PiRuntimeEvent, signal);
      await this.flushPendingSessionMessages();
      return;
    }
    if (event.type === "agent_end") {
      await this.flushPendingSessionMessages();
      await this.emit(event as PiRuntimeEvent, signal);
      return;
    }
    await this.emit(event as PiRuntimeEvent, signal);
  }

  private async handlePostAgentRun(): Promise<boolean> {
    const assistant = this.lastAssistantMessage;
    this.lastAssistantMessage = undefined;
    if (!assistant) return false;
    const model = this.agent.state.model;
    const sameModel = assistant.provider === model.provider && assistant.model === model.id;

    if (
      sameModel
      && !isContextOverflow(assistant, model.contextWindow)
      && isRetryableAssistantError(assistant)
      && await this.prepareRetry(assistant)
    ) {
      return true;
    }

    if (assistant.stopReason === "error" && this.retryAttempt > 0) {
      await this.emit({
        type: "auto_retry_end",
        success: false,
        attempt: this.retryAttempt,
        finalError: assistant.errorMessage
      });
      this.retryAttempt = 0;
    }
    if (!sameModel) return false;
    if (!isContextOverflow(assistant, model.contextWindow)) {
      if (assistant.stopReason === "aborted") return false;
      const directContextTokens = assistant.usage ? calculateContextTokens(assistant.usage) : 0;
      const contextTokens = assistant.stopReason === "error" || directContextTokens === 0
        ? estimateContextTokens(this.agent.state.messages).tokens
        : directContextTokens;
      return !this.deferThresholdCompaction()
        && shouldCompact(contextTokens, model.contextWindow, DEFAULT_COMPACTION_SETTINGS)
        ? this.runAutoCompaction("threshold", false)
        : false;
    }

    const willRetry = assistant.stopReason !== "stop";
    if (!willRetry) return this.runAutoCompaction("overflow", false);

    if (this.overflowRecoveryAttempted) {
      await this.emit({
        type: "compaction_end",
        reason: "overflow",
        aborted: false,
        willRetry: false,
        errorMessage: "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
      });
      return false;
    }

    this.overflowRecoveryAttempted = true;
    const messages = this.agent.state.messages;
    const last = messages[messages.length - 1];
    if (last === assistant) {
      this.agent.state.messages = messages.slice(0, -1);
    }
    return this.runAutoCompaction("overflow", true);
  }

  /** Source-adapted from Pi AgentSession's pre-prompt threshold check. */
  private async compactBeforePromptIfNeeded(): Promise<void> {
    if (this.deferThresholdCompaction()) return;
    const messages = this.resetContextActive
      ? this.agent.state.messages
      : (await this.runSessionOperation(() => this.session.buildContext())).messages;
    const tokens = estimateContextTokens(messages).tokens;
    const model = this.agent.state.model;
    if (!shouldCompact(tokens, model.contextWindow, DEFAULT_COMPACTION_SETTINGS)) return;
    await this.runAutoCompaction("threshold", false);
  }

  /** Source-adapted from Pi AgentSession's native retry path. */
  private async prepareRetry(message: AssistantMessage): Promise<boolean> {
    if (!this.retrySettings.enabled) return false;
    this.retryAttempt += 1;
    if (this.retryAttempt > this.retrySettings.maxRetries) {
      this.retryAttempt -= 1;
      return false;
    }
    const delayMs = this.retrySettings.baseDelayMs * 2 ** (this.retryAttempt - 1);
    const retryAbortController = new AbortController();
    this.retryAbortController = retryAbortController;
    try {
      await this.emit({
        type: "auto_retry_start",
        attempt: this.retryAttempt,
        maxAttempts: this.retrySettings.maxRetries,
        delayMs,
        errorMessage: message.errorMessage || "Unknown error"
      });

      const messages = this.agent.state.messages;
      if (messages[messages.length - 1] === message) {
        this.agent.state.messages = messages.slice(0, -1);
      }

      await abortableDelay(delayMs, retryAbortController.signal);
    } catch (error) {
      if (!retryAbortController.signal.aborted) throw error;
      const attempt = this.retryAttempt;
      this.retryAttempt = 0;
      await this.emit({
        type: "auto_retry_end",
        success: false,
        attempt,
        finalError: "Retry cancelled"
      });
      return false;
    } finally {
      if (this.retryAbortController === retryAbortController) {
        this.retryAbortController = undefined;
      }
    }
    return true;
  }

  private async runAutoCompaction(
    reason: "overflow" | "threshold",
    willRetry: boolean
  ): Promise<boolean> {
    await this.emit({ type: "compaction_start", reason });
    try {
      const nativeResult = await this.compact();
      if (willRetry) {
        const messages = this.agent.state.messages;
        const last = messages[messages.length - 1];
        if (last?.role === "assistant" && last.stopReason !== "stop") {
          this.agent.state.messages = messages.slice(0, -1);
        }
      }
      const context = await this.runSessionOperation(() => this.session.buildContext());
      const estimatedTokensAfter = estimateContextTokens(context.messages).tokens;
      const result: PiSessionCompactionResult = {
        reason,
        summary: nativeResult.summary,
        firstKeptEntryId: nativeResult.firstKeptEntryId,
        tokensBefore: nativeResult.tokensBefore,
        estimatedTokensAfter,
        timestamp: Date.now(),
        details: nativeResult.details
      };

      await this.emit({
        type: "compaction_end",
        reason,
        result,
        aborted: false,
        willRetry
      });
      return willRetry;
    } catch (error) {
      await this.emit({
        type: "compaction_end",
        reason,
        aborted: error instanceof Error && error.name === "AbortError",
        willRetry: false,
        errorMessage: `${reason === "overflow" ? "Context overflow recovery" : "Auto-compaction"} failed: ${error instanceof Error ? error.message : String(error)}`
      });
      return false;
    }
  }

  private async persistExternalMessage(message: AgentMessage): Promise<void> {
    const entryId = await this.runSessionOperation(() => this.session.appendMessage(message));
    this.captureResetContextStart(entryId);
    if (this.initialized) this.agent.state.messages = [...this.agent.state.messages, message];
  }

  private captureResetContextStart(entryId: string): void {
    if (this.resetContextActive && !this.resetContextStartEntryId) {
      this.resetContextStartEntryId = entryId;
    }
  }

  private async flushPendingSessionMessages(): Promise<void> {
    while (this.pendingSessionMessages.length > 0) {
      const pending = this.pendingSessionMessages.shift()!;
      try {
        await this.persistExternalMessage(pending.message);
        pending.resolve();
      } catch (error) {
        pending.reject(error);
        for (const remaining of this.pendingSessionMessages.splice(0)) remaining.reject(error);
        throw error;
      }
    }
  }

  private runSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sessionOperationTail.then(async () => {
      if (this.sessionFailure !== undefined) throw this.sessionFailure;
      return operation();
    });
    this.sessionOperationTail = result.then(
      () => undefined,
      (error) => {
        this.sessionFailure ??= error;
      }
    );
    return result;
  }

  private async enqueueQueuedMessage(
    kind: "steer" | "followUp",
    message: AgentMessage,
    retainOnSettle: boolean
  ): Promise<{ consumed: Promise<void> }> {
    if (this.phase !== "running" || !this.agent.state.isStreaming) {
      throw new Error(`Pi turn is idle or settling and is no longer accepting ${kind === "steer" ? "Steer" : "Follow-up"} input.`);
    }
    let resolveConsumption!: () => void;
    let rejectConsumption!: (error: Error) => void;
    const consumed = new Promise<void>((resolve, reject) => {
      resolveConsumption = resolve;
      rejectConsumption = reject;
    });
    void consumed.catch(() => undefined);
    this.pendingQueueConsumptions.set(message, {
      kind,
      retainOnSettle,
      resolve: resolveConsumption,
      reject: rejectConsumption
    });
    try {
      if (kind === "steer") {
        this.queuedSteer.push(message);
        this.agent.steer(message);
      } else {
        this.queuedFollowUp.push(message);
        this.agent.followUp(message);
      }
      await this.emitQueueUpdate();
      return { consumed };
    } catch (error) {
      if (this.pendingQueueConsumptions.delete(message)) {
        removeMessage(kind === "steer" ? this.queuedSteer : this.queuedFollowUp, message);
        resolveConsumption();
      }
      throw error;
    }
  }

  private async drainPendingQueueConsumptions(): Promise<void> {
    while (
      [...this.pendingQueueConsumptions.values()].some((consumption) => !consumption.retainOnSettle)
      && this.agent.hasQueuedMessages()
    ) {
      const before = {
        pending: this.pendingQueueConsumptions.size,
        steer: this.queuedSteer.length,
        followUp: this.queuedFollowUp.length
      };
      await this.agent.continue();
      const noProgress = this.pendingQueueConsumptions.size === before.pending
        && this.queuedSteer.length === before.steer
        && this.queuedFollowUp.length === before.followUp;
      if (noProgress && this.agent.hasQueuedMessages()) {
        throw new PiQueuedInputNotConsumedError(
          "Pi Agent.continue() returned without consuming any queued Steer or Follow-up message."
        );
      }
    }
  }

  private async rejectUnconsumedQueueMessages(error: Error): Promise<void> {
    if (this.pendingQueueConsumptions.size === 0) return;
    const pending = [...this.pendingQueueConsumptions.entries()];
    this.pendingQueueConsumptions.clear();
    for (const [message, consumption] of pending) {
      if (consumption.retainOnSettle) continue;
      removeMessage(consumption.kind === "steer" ? this.queuedSteer : this.queuedFollowUp, message);
    }
    this.agent.clearSteeringQueue();
    this.agent.clearFollowUpQueue();
    try {
      await this.emitQueueUpdate();
    } finally {
      for (const [, consumption] of pending) consumption.reject(error);
    }
  }

  private async emitQueueUpdate(signal?: AbortSignal): Promise<void> {
    await this.emit({
      type: "queue_update",
      steer: this.queuedSteer.filter((message) => message.role === "user"),
      followUp: this.queuedFollowUp.filter((message) => message.role === "user"),
      nextTurn: [...this.queuedNextTurn]
    }, signal);
  }

  private async emit(event: PiRuntimeEvent, signal?: AbortSignal): Promise<void> {
    for (const listener of this.listeners) await listener(event, signal);
  }
}
