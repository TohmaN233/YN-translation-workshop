import { randomUUID } from "node:crypto";
import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core/node";

import type { PiSessionPromptRequest } from "../../../shared/agent/piSessionContract.ts";
import type { createPiModelSelection } from "./providerRegistry.ts";
import {
  isExpiredProviderAuthError,
  isNonRetryableAssignmentError,
  isParentTakeoverAssignmentError,
  isSubagentTransportExhaustedError,
  type ParentTakeoverAssignmentDetails
} from "./assignmentFailure.ts";
import { PiSessionRepository } from "./sessionRepository.ts";
import {
  createPiTranslationSubagentWorker,
  createPiProofreadSubagentWorker,
  createPiTranslationReviewSubagentWorker,
  createPiTranslationAuditSubagentWorker,
  runPiGeneralSubagent,
  runPiProofreadSubagent,
  runPiTranslationSubagent,
  type PiGeneralSubagentResult,
  type PiGeneralSubagentTask,
  type PiSubagentControl,
  type PiProofreadExactSearchCache,
  type PiProofreadPendingGlossaryCandidate,
  type PiProofreadSubagentResult,
  type PiProofreadSubagentTask,
  type PiTranslationSubagentResult,
  type PiTranslationSubagentTask,
  type PiTranslationStagingCheckpoint,
  type PiTranslationChunkReviewDecision,
  type PiTranslationChunkReviewRequest,
  type PiTranslationReviewAssignment,
  type PiTranslationReviewFailure,
  type PiTranslationReviewSubagentResult,
  type PiTranslationReviewTask
} from "./subagentRunner.ts";

export type YnSubagentKind = "general" | "translation" | "translation-review" | "proofread";
export type YnSubagentStatus = "running" | "completed" | "failed" | "stopped";
const MAX_PARENT_RESULT_SUMMARY_CHARS = 4_000;

function parentResultSummary(value: string): string {
  const text = value.trim();
  return text.length <= MAX_PARENT_RESULT_SUMMARY_CHARS
    ? text
    : `${text.slice(0, MAX_PARENT_RESULT_SUMMARY_CHARS)}\n[truncated]`;
}

export interface YnSubagentSnapshot {
  id: string;
  batchId: string;
  kind: YnSubagentKind;
  label: string;
  documentId?: string;
  fromLine?: number;
  toLine?: number;
  status: YnSubagentStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  documentIds?: string[];
  assignmentCount?: number;
  completedAssignments?: number;
  failureDisposition?: "parent_takeover_required" | "transport_retry_exhausted";
  parentTakeovers?: ParentTakeoverAssignmentDetails[];
  assignmentFailures?: YnSubagentAssignmentFailure[];
}

export interface YnSubagentAssignmentFailure {
  label: string;
  documentId?: string;
  fromLine?: number;
  toLine?: number;
  error: string;
  failureDisposition?: "parent_takeover_required" | "transport_retry_exhausted";
}

export interface YnSubagentBatchSnapshot {
  id: string;
  kind: YnSubagentKind;
  status: YnSubagentStatus;
  startedAt: number;
  completedAt?: number;
  subagents: YnSubagentSnapshot[];
  error?: string;
}

export interface YnSubagentBatchOutcome<TResult> {
  batch: YnSubagentBatchSnapshot;
  results: TResult[];
  failures: YnSubagentAssignmentFailure[];
  error?: unknown;
}

export interface YnSubagentInspection extends YnSubagentSnapshot {
  resultSummary?: string;
}

export interface YnSubagentSteerReceipt {
  deliveryId: string;
  status: "queued";
  consumed: Promise<void>;
}

interface YnSubagentRecord<TResult> extends YnSubagentSnapshot {
  result?: TResult;
  results: TResult[];
  control?: PiSubagentControl;
  childSessionPersisted: boolean;
  outputDir: string;
  promise: Promise<void>;
}

interface YnSubagentBatchRecord<TResult> {
  id: string;
  kind: YnSubagentKind;
  status: YnSubagentStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  abortController: AbortController;
  stopRequested: boolean;
  subagents: Array<YnSubagentRecord<TResult>>;
  promise: Promise<void>;
}

export interface YnSubagentWriteScope {
  documentId: string;
  fromLine: number;
  toLine: number;
  lines?: number[];
}

function writeScopesOverlap(left: YnSubagentWriteScope, right: YnSubagentWriteScope): boolean {
  if (
    left.documentId !== right.documentId
    || left.fromLine > right.toLine
    || right.fromLine > left.toLine
  ) return false;
  const leftLines = left.lines?.length ? new Set(left.lines) : undefined;
  const rightLines = right.lines?.length ? new Set(right.lines) : undefined;
  if (!leftLines && !rightLines) return true;
  if (leftLines && rightLines) return [...leftLines].some((line) => rightLines.has(line));
  const sparse = leftLines ?? rightLines!;
  const range = leftLines ? right : left;
  return [...sparse].some((line) => line >= range.fromLine && line <= range.toLine);
}

type PreparedTranslationReview =
  | { decision: PiTranslationChunkReviewDecision }
  | {
      request: PiSessionPromptRequest;
      task: PiTranslationReviewTask;
      read: (task: PiTranslationReviewTask, signal?: AbortSignal) => Promise<PiTranslationReviewAssignment>;
      submit: (
        task: PiTranslationReviewTask,
        failures: PiTranslationReviewFailure[],
        signal?: AbortSignal
      ) => Promise<PiTranslationChunkReviewDecision>;
    };

interface TranslationReviewPoolHandle {
  batchId: string;
  enqueue: (review: PiTranslationChunkReviewRequest) => Promise<PiTranslationChunkReviewDecision>;
  close: () => Promise<void>;
  abort: (reason?: unknown) => number;
}

interface StartBatchOptions<TTask, TResult> {
  batchId?: string;
  kind: YnSubagentKind;
  request: PiSessionPromptRequest;
  tasks: TTask[];
  initialPriorityTasks?: TTask[];
  additionalWriteScopes?: YnSubagentWriteScope[];
  maxWorkers?: number;
  maxAssignmentAttempts?: number;
  taskStage?: (task: TTask) => number;
  requestForTask?: (task: TTask) => PiSessionPromptRequest;
  signal?: AbortSignal;
  run: (
    task: TTask,
    request: PiSessionPromptRequest,
    signal: AbortSignal,
    subagentId: string,
    registerControl: (control: PiSubagentControl) => void
  ) => Promise<TResult>;
  createWorker?: (args: {
    firstTask: TTask;
    workerIndex: number;
    request: PiSessionPromptRequest;
    signal: AbortSignal;
    subagentId: string;
    label: string;
    registerControl: (control: PiSubagentControl) => void;
  }) => Promise<{
    run: (task: TTask, request: PiSessionPromptRequest, signal: AbortSignal) => Promise<TResult>;
    finish: (outcome: {
      status: "completed" | "failed" | "stopped";
      assignmentCount: number;
      completedAssignments: number;
      documentIds: string[];
      error?: string;
    }) => Promise<void>;
    dispose: () => Promise<void>;
  }>;
  createIdleWorker?: (args: {
    workerIndex: number;
    request: PiSessionPromptRequest;
    signal: AbortSignal;
    subagentId: string;
    label: string;
    registerControl: (control: PiSubagentControl) => void;
  }) => Promise<{
    run: (task: TTask, request: PiSessionPromptRequest, signal: AbortSignal) => Promise<TResult>;
    finish: (outcome: {
      status: "completed" | "failed" | "stopped";
      assignmentCount: number;
      completedAssignments: number;
      documentIds: string[];
      error?: string;
    }) => Promise<void>;
    dispose: () => Promise<void>;
  }>;
  label: (task: TTask) => string;
  workerLabel?: (workerIndex: number) => string;
  range: (task: TTask) => { fromLine?: number; toLine?: number };
  documentId?: (task: TTask) => string | undefined;
  writeScope?: (task: TTask) => YnSubagentWriteScope | undefined;
  onTaskCompleted?: (result: TResult, task: TTask) => Promise<void> | void;
  claimGate?: {
    isBlocked: () => boolean;
    wait: (signal: AbortSignal) => Promise<void>;
    notificationKey: () => string | undefined;
    onQuiescent: () => Promise<void> | void;
  };
  onSettled?: (outcome: YnSubagentBatchOutcome<TResult>) => Promise<void> | void;
  onParentTakeover?: (details: ParentTakeoverAssignmentDetails) => Promise<void> | void;
  parentCompletionContext?: (outcome: YnSubagentBatchOutcome<TResult>) => {
    content?: string;
    details?: Record<string, unknown>;
  } | undefined;
}

export function createYnSubagentBatchId(): string {
  return `batch_${randomUUID()}`;
}

export interface YnSubagentSupervisorOptions {
  publishCustomMessage: (message: AgentMessage) => Promise<void>;
  publishLiveCustomMessage?: (message: AgentMessage) => Promise<void>;
  notifyParent?: (message: AgentMessage) => Promise<void>;
  createModelSelection?: typeof createPiModelSelection;
}

/**
 * Session-scoped child lifecycle adapted from @gotgenes/pi-subagents'
 * SubagentManager/Subagent split. Spawning returns immediately; each record owns
 * its abort signal and completion promise. YN intentionally omits that package's
 * TUI and process-wide concurrency limiter. Prompt-defined children receive
 * read-only project tools; artifact mutations remain behind YN host validators.
 */
export class YnSubagentSupervisor {
  private readonly batches = new Map<string, YnSubagentBatchRecord<unknown>>();
  private readonly options: YnSubagentSupervisorOptions;
  private readonly activeBatchIds = new Set<string>();
  private readonly activeWriteScopes = new Map<string, YnSubagentWriteScope[]>();
  private readonly activeTranslationReviewPools = new Map<string, TranslationReviewPoolHandle>();
  private readonly activeTranslationBatchQueues = new Map<string, {
    owns: (task: PiTranslationSubagentTask) => boolean;
    enqueuePriority: (tasks: PiTranslationSubagentTask[]) => number;
  }>();

  constructor(options: YnSubagentSupervisorOptions) {
    this.options = options;
  }

  startGeneralBatch(options: {
    batchId?: string;
    request: PiSessionPromptRequest;
    tasks: PiGeneralSubagentTask[];
    maxWorkers: number;
    requestForTask?: (task: PiGeneralSubagentTask) => PiSessionPromptRequest;
    signal?: AbortSignal;
    onArtifactMutation?: (
      documentId: string | undefined,
      range?: { fromLine: number; toLine: number; lines?: number[] }
    ) => Promise<void> | void;
    parentCompletionContext?: (outcome: YnSubagentBatchOutcome<PiGeneralSubagentResult | PiTranslationSubagentResult>) => {
      content?: string;
      details?: Record<string, unknown>;
    } | undefined;
    onSettled?: (outcome: YnSubagentBatchOutcome<PiGeneralSubagentResult | PiTranslationSubagentResult>) => Promise<void> | void;
  }): YnSubagentBatchSnapshot {
    const persistentAuditWorkers = options.tasks.every((task) => task.mode === "translation_audit");
    return this.startBatch<PiGeneralSubagentTask, PiGeneralSubagentResult | PiTranslationSubagentResult>({
      ...options,
      kind: "general",
      label: (task) => task.label?.trim() || "Subagent task",
      range: (task) => ({ fromLine: task.fromLine, toLine: task.toLine }),
      documentId: (task) => task.documentId,
      writeScope: (task) => task.mode === "translation_repair"
        ? {
            documentId: task.documentId!,
            fromLine: task.fromLine!,
            toLine: task.toLine!,
            ...(task.lines?.length ? { lines: [...task.lines] } : {})
          }
        : undefined,
      parentCompletionContext: options.parentCompletionContext ?? (({ results }) => ({
        content: `General Pi subagents settled with ${results.length} result${results.length === 1 ? "" : "s"}. Resume the parent task using their evidence.`,
        details: {
          results: results.map((result) => ({
            subagentId: result.subagentId,
            label: result.label,
            documentId: result.documentId,
            fromLine: result.fromLine,
            toLine: result.toLine,
            resultSummary: parentResultSummary(result.resultSummary)
          }))
        }
      })),
      createWorker: persistentAuditWorkers ? async (worker) => {
        const persistent = await createPiTranslationAuditSubagentWorker({
          request: worker.request,
          task: worker.firstTask,
          subagentId: worker.subagentId,
          workerLabel: worker.label,
          publishCustomMessage: this.options.publishCustomMessage,
          publishLiveCustomMessage: this.options.publishLiveCustomMessage,
          createModelSelection: this.options.createModelSelection,
          registerControl: worker.registerControl,
          signal: worker.signal
        });
        return {
          run: (task, taskRequest, signal) => persistent.runAssignment({
            request: taskRequest,
            task,
            subagentId: worker.subagentId,
            publishCustomMessage: this.options.publishCustomMessage,
            publishLiveCustomMessage: this.options.publishLiveCustomMessage,
            createModelSelection: this.options.createModelSelection,
            signal
          }),
          finish: (outcome) => persistent.finish(outcome),
          dispose: () => persistent.dispose()
        };
      } : undefined,
      run: (task, taskRequest, signal, subagentId, registerControl) => task.mode === "translation_repair"
        ? runPiTranslationSubagent({
            request: taskRequest,
            task: {
              documentId: task.documentId,
              fromLine: task.fromLine!,
              toLine: task.toLine!,
              label: task.label,
              providerId: task.providerId,
              modelId: task.modelId,
              instruction: task.prompt,
              ...(task.lines?.length ? { selectedLines: [...task.lines] } : {})
            },
            subagentId,
            publishCustomMessage: this.options.publishCustomMessage,
            publishLiveCustomMessage: this.options.publishLiveCustomMessage,
            createModelSelection: this.options.createModelSelection,
            registerControl,
            onArtifactMutation: options.onArtifactMutation,
            executionMode: "bounded_repair",
            signal
          })
        : runPiGeneralSubagent({
            request: taskRequest,
            task,
            subagentId,
            publishCustomMessage: this.options.publishCustomMessage,
            publishLiveCustomMessage: this.options.publishLiveCustomMessage,
            createModelSelection: this.options.createModelSelection,
            registerControl,
            signal
          })
    });
  }

  startTranslationBatch(options: {
    batchId?: string;
    request: PiSessionPromptRequest;
    tasks: PiTranslationSubagentTask[];
    priorityTasks?: PiTranslationSubagentTask[];
    priorityWriteScopes?: YnSubagentWriteScope[];
    maxWorkers?: number;
    maxAssignmentAttempts?: number;
    taskStage?: (task: PiTranslationSubagentTask) => number;
    requestForTask?: (task: PiTranslationSubagentTask) => PiSessionPromptRequest;
    signal?: AbortSignal;
    onArtifactMutation?: (
      documentId: string | undefined,
      range?: { fromLine: number; toLine: number; lines?: number[] }
    ) => Promise<void> | void;
    onStagingCandidateCheckpoint?: (
      checkpoint: PiTranslationStagingCheckpoint
    ) => Promise<void> | void;
    onTaskCompleted?: (result: PiTranslationSubagentResult, task: PiTranslationSubagentTask) => Promise<void> | void;
    claimGate?: {
      isBlocked: () => boolean;
      wait: (signal: AbortSignal) => Promise<void>;
      notificationKey: () => string | undefined;
      onQuiescent: () => Promise<void> | void;
    };
    onChunkReadyForReview?: (
      review: PiTranslationChunkReviewRequest
    ) => Promise<PiTranslationChunkReviewDecision>;
    reviewWorkerCount?: number;
    prepareChunkReview?: (review: PiTranslationChunkReviewRequest) => Promise<PreparedTranslationReview>;
    onSettled?: (outcome: YnSubagentBatchOutcome<PiTranslationSubagentResult>) => Promise<void> | void;
    onParentTakeover?: (details: ParentTakeoverAssignmentDetails) => Promise<void> | void;
    parentCompletionContext?: (outcome: YnSubagentBatchOutcome<PiTranslationSubagentResult>) => {
      content?: string;
      details?: Record<string, unknown>;
    } | undefined;
  }): YnSubagentBatchSnapshot {
    if (!(options.reviewWorkerCount && options.prepareChunkReview) && !options.onChunkReadyForReview) {
      throw new Error(
        "Translation batches require a read-only review worker gate before any assignment can start."
      );
    }
    const reviewPool = options.reviewWorkerCount && options.prepareChunkReview
      ? this.startTranslationReviewPool({
          request: options.request,
          workerCount: options.reviewWorkerCount,
          prepare: options.prepareChunkReview,
          signal: options.signal
        })
      : undefined;
    const onSettled = options.onSettled;
    try {
      return this.startBatch<PiTranslationSubagentTask, PiTranslationSubagentResult>({
        ...options,
        initialPriorityTasks: options.priorityTasks,
        additionalWriteScopes: options.priorityWriteScopes,
        kind: "translation",
        label: (task) => task.label?.trim() || `Subagent L${task.fromLine}-L${task.toLine}`,
        range: (task) => task,
        documentId: (task) => task.documentId,
        writeScope: (task) => ({
          documentId: task.documentId
            ?? path.basename(options.request.sourcePath || "translation.txt"),
          fromLine: task.fromLine,
          toLine: task.toLine
        }),
        createWorker: options.maxWorkers === undefined ? undefined : async (worker) => {
          const persistent = await createPiTranslationSubagentWorker({
            request: worker.request,
            task: worker.firstTask,
            subagentId: worker.subagentId,
            workerLabel: worker.label,
            publishCustomMessage: this.options.publishCustomMessage,
            publishLiveCustomMessage: this.options.publishLiveCustomMessage,
            createModelSelection: this.options.createModelSelection,
            registerControl: worker.registerControl,
            onArtifactMutation: options.onArtifactMutation,
            onStagingCandidateCheckpoint: options.onStagingCandidateCheckpoint,
            onChunkReadyForReview: reviewPool?.enqueue ?? options.onChunkReadyForReview,
            signal: worker.signal
          });
          return {
            run: (task, taskRequest, signal) => persistent.runAssignment({
              request: taskRequest,
              task,
              subagentId: worker.subagentId,
              publishCustomMessage: this.options.publishCustomMessage,
              publishLiveCustomMessage: this.options.publishLiveCustomMessage,
              createModelSelection: this.options.createModelSelection,
              onArtifactMutation: options.onArtifactMutation,
              onStagingCandidateCheckpoint: options.onStagingCandidateCheckpoint,
              onChunkReadyForReview: reviewPool?.enqueue ?? options.onChunkReadyForReview,
              signal
            }),
            finish: (outcome) => persistent.finish(outcome),
            dispose: () => persistent.dispose()
          };
        },
        run: (task, taskRequest, signal, subagentId, registerControl) => runPiTranslationSubagent({
          request: taskRequest,
          task,
          subagentId,
          publishCustomMessage: this.options.publishCustomMessage,
          publishLiveCustomMessage: this.options.publishLiveCustomMessage,
          createModelSelection: this.options.createModelSelection,
          registerControl,
          onArtifactMutation: options.onArtifactMutation,
          onStagingCandidateCheckpoint: options.onStagingCandidateCheckpoint,
          onChunkReadyForReview: reviewPool?.enqueue ?? options.onChunkReadyForReview,
          signal
        }),
        onSettled: async (outcome) => {
          let reviewFailure: unknown;
          try {
            if (reviewPool) await reviewPool.close();
          } catch (error) {
            reviewFailure = error;
          }
          const settledOutcome = reviewFailure === undefined ? outcome : {
            ...outcome,
            batch: {
              ...outcome.batch,
              status: outcome.batch.status === "stopped" ? "stopped" as const : "failed" as const,
              error: reviewFailure instanceof Error ? reviewFailure.message : String(reviewFailure)
            },
            error: outcome.error ?? reviewFailure
          };
          await onSettled?.(settledOutcome);
          if (reviewFailure !== undefined) throw reviewFailure;
        }
      });
    } catch (error) {
      if (reviewPool) {
        reviewPool.abort(error);
        void reviewPool.close().catch(() => undefined);
      }
      throw error;
    }
  }

  startTranslationReviewBatch(options: {
    batchId?: string;
    request: PiSessionPromptRequest;
    tasks: PiTranslationSubagentTask[];
    maxWorkers: number;
    signal?: AbortSignal;
    reviewRequestForTask: (
      task: PiTranslationSubagentTask,
      subagentId: string,
      signal: AbortSignal
    ) => Promise<PiTranslationChunkReviewRequest>;
    prepareChunkReview: (review: PiTranslationChunkReviewRequest) => Promise<PreparedTranslationReview>;
    onSettled?: (outcome: YnSubagentBatchOutcome<PiTranslationChunkReviewDecision>) => Promise<void> | void;
  }): YnSubagentBatchSnapshot {
    if (options.tasks.length === 0 || options.tasks.some((task) => task.reviewOnly !== true)) {
      throw new Error("A resumed translation review batch requires at least one review-only assignment.");
    }
    const pool = this.startTranslationReviewPool({
      batchId: options.batchId,
      request: options.request,
      workerCount: Math.min(options.maxWorkers, options.tasks.length),
      prepare: options.prepareChunkReview,
      signal: options.signal
    });
    const batch = this.batches.get(pool.batchId)! as YnSubagentBatchRecord<PiTranslationChunkReviewDecision>;
    const settle = async () => {
      const decisions: PiTranslationChunkReviewDecision[] = [];
      let failure: unknown;
      try {
        const requests = await Promise.all(options.tasks.map((task, index) => (
          options.reviewRequestForTask(task, `resume-review-${index + 1}`, batch.abortController.signal)
        )));
        decisions.push(...await Promise.all(requests.map((review) => pool.enqueue(review))));
      } catch (error) {
        failure = error;
        pool.abort(error);
      }
      try {
        await pool.close();
      } catch (error) {
        failure ??= error;
      }
      const snapshot = this.snapshot(batch);
      const outcome: YnSubagentBatchOutcome<PiTranslationChunkReviewDecision> = {
        batch: snapshot,
        results: decisions,
        failures: [],
        ...(failure === undefined ? {} : { error: failure })
      };
      try {
        await options.onSettled?.(outcome);
      } catch (error) {
        batch.status = "failed";
        batch.error = error instanceof Error ? error.message : String(error);
        failure ??= error;
      }
      if (!batch.stopRequested) {
        await this.options.notifyParent?.(this.parentCompletionMessage(
          this.snapshot(batch),
          {
            content: failure === undefined
              ? `Translation review resumed for ${decisions.length} accepted assignment${decisions.length === 1 ? "" : "s"}. Continue the Host queue without retranslating accepted scopes.`
              : `Translation review resume failed: ${failure instanceof Error ? failure.message : String(failure)}`
          }
        ));
      }
    };
    batch.promise = settle();
    void batch.promise.catch(() => undefined);
    return this.snapshot(batch);
  }

  startProofreadBatch(options: {
    batchId?: string;
    request: PiSessionPromptRequest;
    tasks: PiProofreadSubagentTask[];
    maxWorkers?: number;
    maxAssignmentAttempts?: number;
    taskStage?: (task: PiProofreadSubagentTask) => number;
    workers?: Array<{ label?: string; providerId?: string; modelId?: string }>;
    requestForTask?: (task: PiProofreadSubagentTask) => PiSessionPromptRequest;
    signal?: AbortSignal;
    onArtifactMutation?: (
      documentId: string | undefined,
      range?: { fromLine: number; toLine: number; lines?: number[] }
    ) => Promise<void> | void;
    onTaskCompleted?: (
      result: PiProofreadSubagentResult,
      task: PiProofreadSubagentTask
    ) => Promise<void> | void;
    pendingGlossaryCandidatesForTask?: (
      task: PiProofreadSubagentTask
    ) => PiProofreadPendingGlossaryCandidate[];
    parentCompletionContext?: (outcome: YnSubagentBatchOutcome<PiProofreadSubagentResult>) => {
      content?: string;
      details?: Record<string, unknown>;
    } | undefined;
    onSettled?: (outcome: YnSubagentBatchOutcome<PiProofreadSubagentResult>) => Promise<void> | void;
  }): YnSubagentBatchSnapshot {
    const proofreadSearchCache: PiProofreadExactSearchCache = new Map();
    return this.startBatch({
      ...options,
      kind: "proofread",
      label: (task) => task.label?.trim() || `Proofread L${task.fromLine}-L${task.toLine}`,
      range: (task) => task,
      documentId: (task) => task.documentId,
      parentCompletionContext: options.parentCompletionContext ?? (({ results }) => ({
        content: [
          `Proofreading children wrote ${results.reduce((sum, result) => sum + result.findingsWritten, 0)} structured finding(s).`,
          "Inspect and deduplicate their evidence-bound glossary candidates before deciding whether to update shared project assets."
        ].join(" "),
        details: {
          results: results.map((result) => ({
            subagentId: result.subagentId,
            label: result.label,
            fromLine: result.fromLine,
            toLine: result.toLine,
            findingsWritten: result.findingsWritten,
            glossaryCandidates: result.glossaryCandidates
          }))
        }
      })),
      workerLabel: (workerIndex) => options.workers?.[workerIndex]?.label?.trim() || `Worker ${workerIndex + 1}`,
      createIdleWorker: options.maxWorkers === undefined ? undefined : async (worker) => {
        const override = options.workers?.[worker.workerIndex];
        const persistent = await createPiProofreadSubagentWorker({
          request: worker.request,
          subagentId: worker.subagentId,
          workerLabel: worker.label,
          workerProviderId: override?.providerId,
          workerModelId: override?.modelId,
          publishCustomMessage: this.options.publishCustomMessage,
          publishLiveCustomMessage: this.options.publishLiveCustomMessage,
          createModelSelection: this.options.createModelSelection,
          registerControl: worker.registerControl,
          onArtifactMutation: options.onArtifactMutation,
          proofreadSearchCache,
          signal: worker.signal
        });
        return {
          run: (nextTask, taskRequest, signal) => persistent.runAssignment({
            request: taskRequest,
            task: {
              ...nextTask,
              ...(override?.providerId ? { providerId: override.providerId } : {}),
              ...(override?.modelId ? { modelId: override.modelId } : {})
            },
            subagentId: worker.subagentId,
            publishCustomMessage: this.options.publishCustomMessage,
            publishLiveCustomMessage: this.options.publishLiveCustomMessage,
            createModelSelection: this.options.createModelSelection,
            onArtifactMutation: options.onArtifactMutation,
            proofreadSearchCache,
            pendingProofreadGlossaryCandidates: options.pendingGlossaryCandidatesForTask?.(nextTask),
            signal
          }),
          finish: (outcome) => persistent.finish(outcome),
          dispose: () => persistent.dispose()
        };
      },
      run: (task, taskRequest, signal, subagentId, registerControl) => runPiProofreadSubagent({
        request: taskRequest,
        task,
        subagentId,
        publishCustomMessage: this.options.publishCustomMessage,
        publishLiveCustomMessage: this.options.publishLiveCustomMessage,
        createModelSelection: this.options.createModelSelection,
        registerControl,
        onArtifactMutation: options.onArtifactMutation,
        proofreadSearchCache,
        pendingProofreadGlossaryCandidates: options.pendingGlossaryCandidatesForTask?.(task),
        signal
      })
    });
  }

  list(): YnSubagentBatchSnapshot[] {
    return [...this.batches.values()]
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((batch) => this.snapshot(batch));
  }

  hasRunning(): boolean {
    return this.activeBatchIds.size > 0;
  }

  async waitForTerminalSettlements(): Promise<void> {
    const terminalBatches = [...this.activeBatchIds]
      .map((batchId) => this.batches.get(batchId))
      .filter((batch): batch is YnSubagentBatchRecord<unknown> => Boolean(
        batch
        && batch.subagents.length > 0
        && batch.subagents.every((subagent) => subagent.status !== "running")
      ));
    await Promise.all(terminalBatches.map((batch) => batch.promise));
  }

  hasWriteConflict(scope: YnSubagentWriteScope): boolean {
    for (const activeScopes of this.activeWriteScopes.values()) {
      if (activeScopes.some((active) => writeScopesOverlap(active, scope))) return true;
    }
    return false;
  }

  private releaseWriteScope(batchId: string, scope: YnSubagentWriteScope): boolean {
    const scopes = this.activeWriteScopes.get(batchId);
    if (!scopes) return false;
    const remaining = scopes.filter((active) => !writeScopesOverlap(active, scope));
    if (remaining.length === scopes.length) return false;
    if (remaining.length > 0) this.activeWriteScopes.set(batchId, remaining);
    else this.activeWriteScopes.delete(batchId);
    console.info(JSON.stringify({
      event: "yn.translation.takeover.write_scope_released",
      batchId,
      documentId: scope.documentId,
      fromLine: scope.fromLine,
      toLine: scope.toLine,
      remainingScopes: remaining.length
    }));
    return true;
  }

  async notifyParent(message: AgentMessage): Promise<void> {
    if (!this.options.notifyParent) {
      throw new Error("The parent Pi runtime is unavailable for subagent completion.");
    }
    await this.options.notifyParent(message);
  }

  enqueueTranslationPriorityTasks(batchId: string, tasks: PiTranslationSubagentTask[]): number {
    const queue = this.activeTranslationBatchQueues.get(batchId);
    if (!queue) throw new Error(`Translation child batch ${batchId} has no active assignment queue.`);
    return queue.enqueuePriority(tasks);
  }

  enqueueTranslationPriorityTasksIfActive(batchId: string, tasks: PiTranslationSubagentTask[]): number {
    const queue = this.activeTranslationBatchQueues.get(batchId);
    return queue ? queue.enqueuePriority(tasks) : 0;
  }

  translationPriorityBatchOwner(task: PiTranslationSubagentTask): string | undefined {
    const owners = [...this.activeTranslationBatchQueues]
      .filter(([, queue]) => queue.owns(task))
      .map(([batchId]) => batchId);
    if (owners.length > 1) {
      throw new Error(
        `Terminology repair ${task.documentId ?? "translation"} L${task.fromLine}-L${task.toLine} has multiple active batch owners: ${owners.join(", ")}.`
      );
    }
    return owners[0];
  }

  async inspect(subagentId: string): Promise<YnSubagentInspection> {
    const record = this.requireSubagent(subagentId);
    const result = record.result as { resultSummary?: string } | undefined;
    return {
      id: record.id,
      batchId: record.batchId,
      kind: record.kind,
      label: record.label,
      ...(record.documentId ? { documentId: record.documentId } : {}),
      fromLine: record.fromLine,
      toLine: record.toLine,
      status: record.status,
      startedAt: record.startedAt,
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(record.error ? { error: record.error } : {}),
      ...(record.documentIds ? { documentIds: record.documentIds } : {}),
      ...(record.assignmentCount === undefined ? {} : { assignmentCount: record.assignmentCount }),
      ...(record.completedAssignments === undefined ? {} : { completedAssignments: record.completedAssignments }),
      ...(record.failureDisposition ? { failureDisposition: record.failureDisposition } : {}),
      ...(record.parentTakeovers?.length ? { parentTakeovers: record.parentTakeovers } : {}),
      ...(result?.resultSummary ? { resultSummary: result.resultSummary } : {})
    };
  }

  async inspectTranscript(subagentId: string): Promise<AgentMessage[]> {
    const record = this.requireSubagent(subagentId);
    if (record.status === "running" && record.control) {
      return record.control.inspect();
    }
    if (record.status !== "running" && record.childSessionPersisted) {
      // The session-scoped supervisor minted this child ID and never accepts an
      // arbitrary ID into its records, so reopening that exact child is the
      // ownership boundary after the live control closure has been released.
      const child = await new PiSessionRepository(record.outputDir).openChild(record.id);
      return (await child.buildContext()).messages;
    }
    return [];
  }

  async steer(subagentId: string, text: string): Promise<YnSubagentSteerReceipt> {
    const instruction = text.trim();
    if (!instruction) throw new Error("Subagent steering text is required.");
    const record = this.requireSubagent(subagentId);
    if (record.status !== "running") {
      throw new Error(`Subagent ${subagentId} is ${record.status}; only a running child can be steered.`);
    }
    if (!record.control) throw new Error(`Subagent ${subagentId} is still starting.`);
    try {
      const deliveryId = `steer_${randomUUID()}`;
      const { consumed } = await record.control.steer(instruction);
      return { deliveryId, status: "queued", consumed };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Pi child ${record.label} did not accept Steer: ${reason}`);
    }
  }

  abortAll(reason: unknown = new DOMException("Parent Pi session stopped.", "AbortError")): number {
    let count = 0;
    for (const pool of this.activeTranslationReviewPools.values()) count += pool.abort(reason);
    for (const batchId of this.activeBatchIds) {
      if (this.activeTranslationReviewPools.has(batchId)) continue;
      const batch = this.batches.get(batchId);
      if (!batch) continue;
      count += batch.subagents.filter((subagent) => subagent.status === "running").length;
      batch.stopRequested = true;
      if (!batch.abortController.signal.aborted) batch.abortController.abort(reason);
    }
    return count;
  }

  async waitForAll(): Promise<void> {
    while (this.activeBatchIds.size > 0) {
      const active = [...this.activeBatchIds]
        .map((batchId) => this.batches.get(batchId)?.promise)
        .filter((promise): promise is Promise<void> => promise !== undefined);
      if (active.length === 0) return;
      await Promise.allSettled(active);
    }
  }

  private startTranslationReviewPool(options: {
    batchId?: string;
    request: PiSessionPromptRequest;
    workerCount: number;
    prepare: (review: PiTranslationChunkReviewRequest) => Promise<PreparedTranslationReview>;
    signal?: AbortSignal;
  }): TranslationReviewPoolHandle {
    if (!Number.isInteger(options.workerCount) || options.workerCount < 1) {
      throw new Error(`reviewWorkerCount must be a positive integer, received ${options.workerCount}.`);
    }
    const batchId = options.batchId?.trim() || createYnSubagentBatchId();
    if (this.batches.has(batchId) || this.activeBatchIds.has(batchId)) {
      throw new Error(`Pi child batch ${batchId} already exists in this session.`);
    }
    const startedAt = Date.now();
    const abortController = new AbortController();
    type ReviewQueueItem = {
      prepared: Exclude<PreparedTranslationReview, { decision: PiTranslationChunkReviewDecision }>;
      attempts: number;
      resolve: (decision: PiTranslationChunkReviewDecision) => void;
      reject: (error: unknown) => void;
    };
    const queue: ReviewQueueItem[] = [];
    const waiters = new Set<() => void>();
    const workerPromises: Promise<void>[] = [];
    let activeAssignments = 0;
    let closed = false;
    let firstFailure: unknown;
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const batch: YnSubagentBatchRecord<PiTranslationReviewSubagentResult> = {
      id: batchId,
      kind: "translation-review",
      status: "running",
      startedAt,
      abortController,
      stopRequested: false,
      subagents: [],
      promise: completion
    };
    this.batches.set(batchId, batch as YnSubagentBatchRecord<unknown>);
    this.activeBatchIds.add(batchId);

    const wakeWorkers = () => {
      for (const wake of waiters) wake();
      waiters.clear();
    };
    const claim = async (): Promise<ReviewQueueItem | undefined> => {
      while (!abortController.signal.aborted) {
        const item = queue.shift();
        if (item) {
          activeAssignments += 1;
          return item;
        }
        if (closed) return undefined;
        await new Promise<void>((resolve) => waiters.add(resolve));
      }
      return undefined;
    };
    const rejectQueued = (reason: unknown) => {
      for (const item of queue.splice(0)) item.reject(reason);
    };
    const abort = (reason: unknown = new DOMException("Translation review pool stopped.", "AbortError")): number => {
      if (abortController.signal.aborted) return 0;
      batch.stopRequested = true;
      const count = batch.subagents.filter((record) => record.status === "running").length;
      abortController.abort(reason);
      rejectQueued(reason);
      wakeWorkers();
      return count;
    };
    const abortFromParent = () => abort(
      options.signal?.reason ?? new DOMException("Parent Pi turn stopped.", "AbortError")
    );
    options.signal?.addEventListener("abort", abortFromParent, { once: true });

    const spawnWorker = (workerIndex: number) => {
      const id = `subagent_${randomUUID()}`;
      const record: YnSubagentRecord<PiTranslationReviewSubagentResult> = {
        id,
        batchId,
        kind: "translation-review",
        label: `Review Worker ${workerIndex + 1}`,
        status: "running",
        startedAt: Date.now(),
        assignmentCount: 0,
        completedAssignments: 0,
        results: [],
        childSessionPersisted: false,
        outputDir: options.request.outputDir,
        promise: Promise.resolve()
      };
      batch.subagents.push(record);
      record.promise = Promise.resolve().then(async () => {
        let persistent: Awaited<ReturnType<typeof createPiTranslationReviewSubagentWorker>> | undefined;
        let workerFailure: unknown;
        try {
          let item = await claim();
          while (item) {
            const { prepared } = item;
            record.label = prepared.task.label?.trim()
              || `Review ${prepared.task.documentId} L${prepared.task.fromLine}-${prepared.task.toLine}`;
            record.assignmentCount = (record.assignmentCount ?? 0) + 1;
            record.documentId = prepared.task.documentId;
            record.fromLine = prepared.task.fromLine;
            record.toLine = prepared.task.toLine;
            if (prepared.task.documentId && !record.documentIds?.includes(prepared.task.documentId)) {
              record.documentIds = [...(record.documentIds ?? []), prepared.task.documentId];
            }
            try {
              const context = {
                request: prepared.request ?? options.request,
                task: prepared.task,
                subagentId: id,
                workerLabel: record.label,
                workerProviderId: options.request.subagentProviderId,
                workerModelId: options.request.subagentModelId,
                publishCustomMessage: this.options.publishCustomMessage,
                publishLiveCustomMessage: this.options.publishLiveCustomMessage,
                createModelSelection: this.options.createModelSelection,
                registerControl: (control: PiSubagentControl) => {
                  record.control = control;
                  record.childSessionPersisted = true;
                },
                readAssignment: prepared.read,
                submitAssignment: prepared.submit,
                signal: abortController.signal
              };
              persistent ??= await createPiTranslationReviewSubagentWorker(context);
              const result = await persistent.runAssignment(context);
              record.result = result;
              record.results.push(result);
              record.completedAssignments = (record.completedAssignments ?? 0) + 1;
              item.resolve(result.decision);
            } catch (error) {
              if (!abortController.signal.aborted && item.attempts < 2) {
                item.attempts += 1;
                queue.unshift(item);
                wakeWorkers();
              } else {
                workerFailure = error;
                firstFailure ??= error;
                item.reject(error);
                abort(error);
              }
              break;
            } finally {
              activeAssignments = Math.max(0, activeAssignments - 1);
            }
            item = await claim();
          }
        } catch (error) {
          workerFailure = error;
          firstFailure ??= error;
          abort(error);
        } finally {
          record.status = abortController.signal.aborted
            ? "stopped"
            : workerFailure === undefined ? "completed" : "failed";
          record.completedAt = Date.now();
          record.error = workerFailure === undefined
            ? undefined
            : workerFailure instanceof Error ? workerFailure.message : String(workerFailure);
          if (persistent) {
            await persistent.finish({
              status: record.status,
              assignmentCount: record.assignmentCount ?? 0,
              completedAssignments: record.completedAssignments ?? 0,
              documentIds: [...(record.documentIds ?? [])],
              ...(record.error ? { error: record.error } : {})
            }).catch((error) => {
              firstFailure ??= error;
              record.status = "failed";
              record.error = error instanceof Error ? error.message : String(error);
            });
            await persistent.dispose().catch((error) => {
              firstFailure ??= error;
              record.status = "failed";
              record.error = error instanceof Error ? error.message : String(error);
            });
          }
          record.control = undefined;
        }
      });
      workerPromises.push(record.promise);
      void record.promise.finally(() => {
        if (!closed && !abortController.signal.aborted && queue.length > 0) ensureWorkers();
      }).catch(() => undefined);
    };
    const ensureWorkers = () => {
      const desired = Math.min(options.workerCount, queue.length + activeAssignments);
      while (batch.subagents.filter((record) => record.status === "running").length < desired) {
        spawnWorker(batch.subagents.length);
      }
    };

    const enqueue = async (review: PiTranslationChunkReviewRequest): Promise<PiTranslationChunkReviewDecision> => {
      if (closed || abortController.signal.aborted) {
        throw abortController.signal.reason ?? new Error("Translation review pool is closed.");
      }
      const prepared = await options.prepare(review);
      if ("decision" in prepared) return prepared.decision;
      const decision = new Promise<PiTranslationChunkReviewDecision>((resolve, reject) => {
        queue.push({ prepared, attempts: 1, resolve, reject });
      });
      ensureWorkers();
      wakeWorkers();
      return decision;
    };
    let closePromise: Promise<void> | undefined;
    const close = () => closePromise ??= (async () => {
      closed = true;
      wakeWorkers();
      await Promise.allSettled(workerPromises);
      batch.completedAt = Date.now();
      if (firstFailure !== undefined) {
        batch.status = batch.stopRequested ? "stopped" : "failed";
        batch.error = firstFailure instanceof Error ? firstFailure.message : String(firstFailure);
      } else {
        batch.status = abortController.signal.aborted ? "stopped" : "completed";
      }
      options.signal?.removeEventListener("abort", abortFromParent);
      this.activeTranslationReviewPools.delete(batchId);
      this.activeBatchIds.delete(batchId);
      for (const record of batch.subagents) record.results = [];
      resolveCompletion();
      if (firstFailure !== undefined) throw firstFailure;
    })();
    const handle: TranslationReviewPoolHandle = { batchId, enqueue, close, abort };
    this.activeTranslationReviewPools.set(batchId, handle);
    return handle;
  }

  private startBatch<TTask, TResult>(options: StartBatchOptions<TTask, TResult>): YnSubagentBatchSnapshot {
    if (options.signal?.aborted) {
      throw new DOMException("Subagent delegation was aborted.", "AbortError");
    }
    const writeScopes = [
      ...(options.writeScope
        ? options.tasks.map((task) => options.writeScope!(task)).filter((scope): scope is YnSubagentWriteScope => scope !== undefined)
        : []),
      ...(options.additionalWriteScopes ?? [])
    ];
    for (const scope of writeScopes) {
      if (!scope.documentId?.trim()) throw new Error("A write-capable Pi child assignment requires a documentId.");
      if (!Number.isInteger(scope.fromLine) || !Number.isInteger(scope.toLine) || scope.fromLine < 1 || scope.toLine < scope.fromLine) {
        throw new Error(`Invalid Pi child write scope ${scope.documentId} L${scope.fromLine}-L${scope.toLine}.`);
      }
      if (scope.lines?.length) {
        const unique = new Set(scope.lines);
        if (
          unique.size !== scope.lines.length
          || scope.lines.some((line) => (
            !Number.isInteger(line) || line < scope.fromLine || line > scope.toLine
          ))
        ) {
          throw new Error(`Invalid sparse Pi child write scope ${scope.documentId} L${scope.fromLine}-L${scope.toLine}.`);
        }
      }
      for (const [activeId, activeScopes] of this.activeWriteScopes) {
        const conflict = activeScopes.find((active) => writeScopesOverlap(active, scope));
        if (conflict) {
          throw new Error(
            `Pi child write scope ${scope.documentId} L${scope.fromLine}-L${scope.toLine} overlaps active batch ${activeId} L${conflict.fromLine}-L${conflict.toLine}.`
          );
        }
      }
    }
    const batchId = options.batchId?.trim() || createYnSubagentBatchId();
    if (this.batches.has(batchId) || this.activeBatchIds.has(batchId)) {
      throw new Error(`Pi child batch ${batchId} already exists in this session.`);
    }
    const startedAt = Date.now();
    if (options.tasks.length === 0) throw new Error("A Pi child batch requires at least one assignment.");
    const requestedWorkers = options.maxWorkers ?? options.tasks.length;
    if (!Number.isInteger(requestedWorkers) || requestedWorkers < 1) {
      throw new Error(`maxWorkers must be a positive integer, received ${requestedWorkers}.`);
    }
    const workerCount = options.taskStage && options.createIdleWorker
      ? requestedWorkers
      : Math.min(requestedWorkers, options.tasks.length);
    const maxAssignmentAttempts = options.maxAssignmentAttempts ?? (options.createWorker || options.createIdleWorker ? 2 : 1);
    if (!Number.isInteger(maxAssignmentAttempts) || maxAssignmentAttempts < 1) {
      throw new Error(`maxAssignmentAttempts must be a positive integer, received ${maxAssignmentAttempts}.`);
    }
    const priorityTaskIdentities = new Set(options.initialPriorityTasks ?? []);
    if ([...priorityTaskIdentities].some((task) => !options.tasks.includes(task))) {
      throw new Error("Every initial priority assignment must also belong to the reserved batch task list.");
    }
    const ordinaryTasks = options.tasks.filter((task) => !priorityTaskIdentities.has(task));
    const priorityTasks: TTask[] = [...priorityTaskIdentities];
    const firstTasksComeFromQueue = Boolean(options.taskStage || priorityTasks.length > 0);
    const initialTasks = firstTasksComeFromQueue ? [] : ordinaryTasks.slice(0, workerCount);
    const queuedTasks = firstTasksComeFromQueue ? [...ordinaryTasks] : ordinaryTasks.slice(workerCount);
    const priorityTaskKeys = new Set<string>();
    if (options.kind === "translation") {
      for (const task of priorityTasks) {
        const translationTask = task as unknown as PiTranslationSubagentTask;
        const scope = options.writeScope?.(task);
        if (!scope) throw new Error("An initial terminology repair requires an owned translation write scope.");
        priorityTaskKeys.add(
          `${scope.documentId}\0${scope.fromLine}\0${scope.toLine}\0${JSON.stringify(translationTask.reviewFeedback ?? [])}`
        );
      }
    }
    let activePriorityTasks = 0;
    let fatalPriorityFailure: unknown;
    const priorityWaiters = new Set<() => void>();
    const wakePriorityWaiters = () => {
      for (const wake of priorityWaiters) wake();
      priorityWaiters.clear();
    };
    let activeAssignments = 0;
    let notifiedGateKey: string | undefined;
    let gateNotification: Promise<void> | undefined;
    const notifyBlockedGateWhenQuiescent = async () => {
      if (!options.claimGate?.isBlocked() || activeAssignments > 0) return;
      const key = options.claimGate.notificationKey();
      if (!key || key === notifiedGateKey) return;
      if (gateNotification) {
        await gateNotification;
        return;
      }
      gateNotification = Promise.resolve(options.claimGate.onQuiescent());
      try {
        await gateNotification;
        notifiedGateKey = key;
      } finally {
        gateNotification = undefined;
      }
    };
    const waitForClaimGate = async () => {
      if (!options.claimGate?.isBlocked()) return;
      await notifyBlockedGateWhenQuiescent();
      await options.claimGate.wait(abortController.signal);
    };
    const stageNumbers = options.taskStage
      ? [...new Set(ordinaryTasks.map((task) => options.taskStage!(task)))].sort((left, right) => left - right)
      : [];
    for (const stage of stageNumbers) {
      if (!Number.isInteger(stage) || stage < 0) throw new Error(`Task stage must be a non-negative integer, received ${stage}.`);
    }
    const stagedQueues = new Map(stageNumbers.map((stage) => [
      stage,
      ordinaryTasks.filter((task) => options.taskStage!(task) === stage)
    ]));
    const stagedActive = new Map(stageNumbers.map((stage) => [stage, 0]));
    let stageIndex = 0;
    let fatalStagedFailure: { error: unknown; stage: number } | undefined;
    const stageWaiters = new Set<() => void>();
    const wakeStageWaiters = () => {
      for (const wake of stageWaiters) wake();
      stageWaiters.clear();
    };
    const taskAttempts = new Map<TTask, number>();
    const authReplacementAttempts = new Map<TTask, number>();
    const requeueTask = (task: TTask): void => {
      if (priorityTaskIdentities.has(task)) {
        priorityTasks.unshift(task);
        return;
      }
      if (options.taskStage) {
        const stage = options.taskStage(task);
        const queue = stagedQueues.get(stage);
        if (!queue) {
          throw new Error(`Cannot requeue an assignment for unknown stage ${stage}.`);
        }
        queue.unshift(task);
        return;
      }
      queuedTasks.unshift(task);
    };
    const claimNextTask = async (): Promise<TTask | undefined> => {
      await waitForClaimGate();
      while (priorityTasks.length === 0 && activePriorityTasks > 0 && !fatalPriorityFailure) {
        if (abortController.signal.aborted) return undefined;
        await new Promise<void>((resolve) => priorityWaiters.add(resolve));
        await waitForClaimGate();
      }
      if (fatalPriorityFailure || abortController.signal.aborted) return undefined;
      const priorityTask = priorityTasks.shift();
      if (priorityTask) {
        activePriorityTasks += 1;
        return priorityTask;
      }
      if (options.taskStage) {
        while (stageIndex < stageNumbers.length) {
          if (abortController.signal.aborted) return undefined;
          const stage = stageNumbers[stageIndex]!;
          if (fatalStagedFailure && stage > fatalStagedFailure.stage) return undefined;
          const queue = stagedQueues.get(stage)!;
          const task = queue.shift();
          if (task) {
            stagedActive.set(stage, (stagedActive.get(stage) ?? 0) + 1);
            return task;
          }
          if ((stagedActive.get(stage) ?? 0) === 0) {
            if (fatalStagedFailure) return undefined;
            stageIndex += 1;
            wakeStageWaiters();
            continue;
          }
          if (fatalStagedFailure) return undefined;
          await new Promise<void>((resolve) => stageWaiters.add(resolve));
        }
        return undefined;
      }
      return queuedTasks.shift();
    };
    const completeTask = (task: TTask, failed = false) => {
      if (priorityTaskIdentities.has(task)) {
        activePriorityTasks = Math.max(0, activePriorityTasks - 1);
        if (failed) fatalPriorityFailure ??= new Error("A terminology repair assignment failed; later translation assignments remain blocked.");
        wakePriorityWaiters();
        return;
      }
      if (!options.taskStage) return;
      const stage = options.taskStage(task);
      stagedActive.set(stage, Math.max(0, (stagedActive.get(stage) ?? 0) - 1));
      wakeStageWaiters();
    };
    const abortController = new AbortController();
    abortController.signal.addEventListener("abort", wakeStageWaiters, { once: true });
    abortController.signal.addEventListener("abort", wakePriorityWaiters, { once: true });
    let stopRequestedByParent = false;
    const abortFromParent = () => {
      if (!abortController.signal.aborted) {
        stopRequestedByParent = true;
        abortController.abort(options.signal?.reason ?? new DOMException("Parent Pi turn stopped.", "AbortError"));
        wakeStageWaiters();
      }
    };
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
    if (options.signal?.aborted) abortFromParent();

    if (options.kind === "translation") {
      this.activeTranslationBatchQueues.set(batchId, {
        owns: (translationTask) => {
          const task = translationTask as unknown as TTask;
          const scope = options.writeScope?.(task);
          return Boolean(scope && writeScopes.some((candidate) => (
            candidate.documentId === scope.documentId
            && candidate.fromLine <= scope.fromLine
            && candidate.toLine >= scope.toLine
          )));
        },
        enqueuePriority: (tasks) => {
          let added = 0;
          for (const translationTask of tasks) {
            const task = translationTask as unknown as TTask;
            const scope = options.writeScope?.(task);
            if (!scope) throw new Error("A terminology repair assignment requires an owned translation write scope.");
            const owned = writeScopes.some((candidate) => (
              candidate.documentId === scope.documentId
              && candidate.fromLine <= scope.fromLine
              && candidate.toLine >= scope.toLine
            ));
            if (!owned) {
              throw new Error(
                `Terminology repair ${scope.documentId} L${scope.fromLine}-L${scope.toLine} is outside batch ${batchId} ownership.`
              );
            }
            const key = `${scope.documentId}\0${scope.fromLine}\0${scope.toLine}\0${JSON.stringify(translationTask.reviewFeedback ?? [])}`;
            if (priorityTaskKeys.has(key)) continue;
            priorityTaskKeys.add(key);
            priorityTaskIdentities.add(task);
            priorityTasks.push(task);
            added += 1;
          }
          wakePriorityWaiters();
          return added;
        }
      });
    }

    let firstFailure: unknown;
    const recordSeeds: Array<TTask | undefined> = options.taskStage
      && (options.createWorker || options.createIdleWorker) || priorityTasks.length > 0
      ? Array.from({ length: workerCount }, () => undefined)
      : initialTasks;
    const records: YnSubagentRecord<TResult>[] = [];
    const createBatchWorkerRecord = (
      firstTask: TTask | undefined,
      workerIndex: number,
      taskAlreadyClaimed = false
    ): YnSubagentRecord<TResult> => {
      const id = `subagent_${randomUUID()}`;
      const range = firstTask ? options.range(firstTask) : {};
      const firstDocumentId = firstTask ? options.documentId?.(firstTask) : undefined;
      const documentIds = firstDocumentId ? [firstDocumentId] : [];
      const record: YnSubagentRecord<TResult> = {
        id,
        batchId,
        kind: options.kind,
        label: options.workerLabel?.(workerIndex)
          || (firstTask ? options.label(firstTask) : "")
          || `Worker ${workerIndex + 1}`,
        ...(firstDocumentId ? { documentId: firstDocumentId } : {}),
        fromLine: range.fromLine,
        toLine: range.toLine,
        status: "running",
        startedAt: Date.now(),
        ...(documentIds.length > 0 ? { documentIds } : {}),
        assignmentCount: 0,
        completedAssignments: 0,
        results: [],
        childSessionPersisted: false,
        outputDir: options.request.outputDir,
        promise: Promise.resolve()
      };
      record.promise = Promise.resolve()
        .then(async () => {
          let workerFailure: unknown;
          let replaceWorkerAfterFailure = false;
          const rememberFailure = (error: unknown) => {
            workerFailure ??= error;
            firstFailure ??= error;
            record.error = error instanceof Error ? error.message : String(error);
          };
          let persistentWorker: Awaited<ReturnType<NonNullable<typeof options.createWorker>>> | undefined;
          try {
            const registerControl = (control: PiSubagentControl) => {
              record.control = control;
              record.childSessionPersisted = true;
            };
            const bindRecordToTask = (task: TTask) => {
              const taskRange = options.range(task);
              record.label = options.workerLabel?.(workerIndex)
                || options.label(task)
                || record.label;
              record.documentId = options.documentId?.(task);
              record.fromLine = taskRange.fromLine;
              record.toLine = taskRange.toLine;
              if (record.documentId && !record.documentIds?.includes(record.documentId)) {
                record.documentIds = [...(record.documentIds ?? []), record.documentId];
              }
            };
            let task: TTask | undefined;
            if (options.createWorker) {
              task = taskAlreadyClaimed
                ? firstTask
                : firstTasksComeFromQueue ? await claimNextTask() : firstTask;
              if (task !== undefined) {
                if (!firstTasksComeFromQueue && !taskAlreadyClaimed) await waitForClaimGate();
                bindRecordToTask(task);
                try {
                  persistentWorker = await options.createWorker({
                    firstTask: task,
                    workerIndex,
                    request: options.requestForTask?.(task) ?? options.request,
                    signal: abortController.signal,
                    subagentId: id,
                    label: record.label,
                    registerControl
                  });
                } catch (error) {
                  completeTask(task, true);
                  if (options.taskStage && fatalStagedFailure === undefined) {
                    fatalStagedFailure = { error, stage: options.taskStage(task) };
                    wakeStageWaiters();
                  }
                  throw error;
                }
              }
            } else {
              persistentWorker = await options.createIdleWorker?.({
                  workerIndex,
                  request: options.request,
                  signal: abortController.signal,
                  subagentId: id,
                  label: record.label,
                  registerControl
                });
              task = taskAlreadyClaimed
                ? firstTask
                : firstTasksComeFromQueue ? await claimNextTask() : firstTask;
            }
            while (task !== undefined) {
              if (abortController.signal.aborted) break;
              if (!options.taskStage && !priorityTaskIdentities.has(task)) await waitForClaimGate();
              bindRecordToTask(task);
              const assignmentAttempt = (taskAttempts.get(task) ?? 0) + 1;
              taskAttempts.set(task, assignmentAttempt);
              record.assignmentCount = (record.assignmentCount ?? 0) + 1;
              let retryCurrentTask = false;
              let stopWorkerAfterFailure = false;
              let replacedExpiredAuth = false;
              activeAssignments += 1;
              try {
                const taskRequest = options.requestForTask?.(task) ?? options.request;
                const result = persistentWorker
                  ? await persistentWorker.run(task, taskRequest, abortController.signal)
                  : await options.run(
                    task,
                    taskRequest,
                    abortController.signal,
                    id,
                    (control) => {
                      record.control = control;
                      record.childSessionPersisted = true;
                    }
                  );
                record.result = result;
                record.results.push(result);
                record.completedAssignments = (record.completedAssignments ?? 0) + 1;
                await options.onTaskCompleted?.(result, task);
              } catch (error) {
                const nonRetryable = isNonRetryableAssignmentError(error);
                if (
                  !abortController.signal.aborted
                  && !nonRetryable
                  && assignmentAttempt < maxAssignmentAttempts
                ) {
                  retryCurrentTask = true;
                } else {
                  if (isParentTakeoverAssignmentError(error)) {
                    record.failureDisposition = error.failureDisposition;
                    record.parentTakeovers = [...(record.parentTakeovers ?? []), error.details];
                    replaceWorkerAfterFailure = true;
                    if (options.onParentTakeover) {
                      try {
                        await options.onParentTakeover(error.details);
                        const takeoverDocumentId = error.details.documentId?.trim();
                        if (takeoverDocumentId) {
                          this.releaseWriteScope(batchId, {
                            documentId: takeoverDocumentId,
                            fromLine: error.details.fromLine,
                            toLine: error.details.toLine
                          });
                        }
                      } catch (handoffError) {
                        const handoffMessage = handoffError instanceof Error
                          ? handoffError.message
                          : String(handoffError);
                        console.error(JSON.stringify({
                          event: "yn.translation.takeover.handoff_failed",
                          batchId,
                          documentId: error.details.documentId,
                          fromLine: error.details.fromLine,
                          toLine: error.details.toLine,
                          rejectedLines: error.details.rejectedLines,
                          error: handoffMessage
                        }));
                        rememberFailure(handoffError);
                      }
                    }
                  }
                  if (isSubagentTransportExhaustedError(error)) {
                    record.failureDisposition = error.failureDisposition;
                  }
                                    if (isExpiredProviderAuthError(error) && task) {
                    const attempts = (authReplacementAttempts.get(task) ?? 0) + 1;
                    authReplacementAttempts.set(task, attempts);
                    if (attempts <= 1) {
                      console.warn(JSON.stringify({
                        event: "yn.translation.auth_expired_replace_worker",
                        batchId,
                        documentId: options.documentId?.(task),
                        fromLine: options.range(task).fromLine,
                        toLine: options.range(task).toLine,
                        attempt: attempts,
                        error: error instanceof Error ? error.message : String(error)
                      }));
                      requeueTask(task);
                      replaceWorkerAfterFailure = true;
                      stopWorkerAfterFailure = true;
                      replacedExpiredAuth = true;
                    }
                  }
                  if (replacedExpiredAuth) {
                    // Keep the assignment in queue for a fresh runtime; do not fail the batch.
                  } else {
                  stopWorkerAfterFailure = true;
                  const failedRange = options.range(task);
                  record.assignmentFailures = [
                    ...(record.assignmentFailures ?? []),
                    {
                      label: options.label(task) || record.label,
                      ...(options.documentId?.(task) ? { documentId: options.documentId(task) } : {}),
                      fromLine: failedRange.fromLine,
                      toLine: failedRange.toLine,
                      error: error instanceof Error ? error.message : String(error),
                      ...(isParentTakeoverAssignmentError(error) || isSubagentTransportExhaustedError(error)
                        ? { failureDisposition: error.failureDisposition }
                        : {})
                    }
                  ];
                  rememberFailure(error);
                  if (options.taskStage && fatalStagedFailure === undefined) {
                    fatalStagedFailure = { error, stage: options.taskStage(task) };
                    wakeStageWaiters();
                  }
                  }
                }
              }
              activeAssignments = Math.max(0, activeAssignments - 1);
              await notifyBlockedGateWhenQuiescent();
              if (!retryCurrentTask) {
                completeTask(task, stopWorkerAfterFailure && !replacedExpiredAuth);
                task = stopWorkerAfterFailure ? undefined : await claimNextTask();
              }
            }
          } catch (error) {
            rememberFailure(error);
          } finally {
            record.status = abortController.signal.aborted
              ? "stopped"
              : workerFailure === undefined ? "completed" : "failed";
            record.completedAt = Date.now();
            if (persistentWorker) {
              try {
                await persistentWorker.finish({
                  status: record.status,
                  assignmentCount: record.assignmentCount ?? 0,
                  completedAssignments: record.completedAssignments ?? 0,
                  documentIds: [...(record.documentIds ?? [])],
                  ...(record.error ? { error: record.error } : {})
                });
              } catch (error) {
                rememberFailure(error);
                record.status = "failed";
              }
              try {
                await persistentWorker.dispose();
              } catch (error) {
                rememberFailure(error);
                record.status = "failed";
              }
            }
            record.control = undefined;
          }
          if (replaceWorkerAfterFailure && !abortController.signal.aborted) {
            const replacementTask = await claimNextTask();
            if (replacementTask !== undefined) {
              const replacement = createBatchWorkerRecord(replacementTask, workerIndex, true);
              records.push(replacement);
              await replacement.promise;
            }
          }
        });
      return record;
    };
    for (const [workerIndex, firstTask] of recordSeeds.entries()) {
      records.push(createBatchWorkerRecord(firstTask, workerIndex));
    }

    const batch: YnSubagentBatchRecord<TResult> = {
      id: batchId,
      kind: options.kind,
      status: "running",
      startedAt,
      abortController,
      stopRequested: stopRequestedByParent,
      subagents: records,
      promise: Promise.resolve()
    };
    this.batches.set(batchId, batch as YnSubagentBatchRecord<unknown>);
    this.activeBatchIds.add(batchId);
    if (writeScopes.length > 0) this.activeWriteScopes.set(batchId, writeScopes);
    batch.promise = Promise.allSettled(records.map((record) => record.promise))
      .then(async () => {
        batch.completedAt = Date.now();
        if (firstFailure !== undefined) {
          batch.status = batch.stopRequested || stopRequestedByParent ? "stopped" : "failed";
          batch.error = firstFailure instanceof Error ? firstFailure.message : String(firstFailure);
        } else {
          batch.status = "completed";
        }
        let snapshot = this.snapshot(batch);
        let outcome: YnSubagentBatchOutcome<TResult> = {
          batch: snapshot,
          results: records.flatMap((record) => record.results),
          failures: records.flatMap((record) => record.assignmentFailures ?? []),
          ...(firstFailure === undefined ? {} : { error: firstFailure })
        };
        try {
          await options.onSettled?.(outcome);
        } catch (error) {
          batch.status = "failed";
          batch.error = error instanceof Error ? error.message : String(error);
          snapshot = this.snapshot(batch);
          outcome = {
            batch: snapshot,
            results: records.flatMap((record) => record.results),
            failures: records.flatMap((record) => record.assignmentFailures ?? []),
            error
          };
        }
        if (!batch.stopRequested && !stopRequestedByParent) {
          await this.options.notifyParent?.(this.parentCompletionMessage(
            snapshot,
            options.parentCompletionContext?.(outcome)
          ));
        }
      })
      .finally(() => {
        options.signal?.removeEventListener("abort", abortFromParent);
        this.activeWriteScopes.delete(batchId);
        this.activeTranslationBatchQueues.delete(batchId);
        this.activeBatchIds.delete(batchId);
        for (const record of records) record.results = [];
      });
    void batch.promise.catch(() => undefined);
    return this.snapshot(batch);
  }

  private snapshot<TResult>(batch: YnSubagentBatchRecord<TResult>): YnSubagentBatchSnapshot {
    return {
      id: batch.id,
      kind: batch.kind,
      status: batch.status,
      startedAt: batch.startedAt,
      ...(batch.completedAt === undefined ? {} : { completedAt: batch.completedAt }),
      ...(batch.error ? { error: batch.error } : {}),
      subagents: batch.subagents.map((subagent) => ({
        id: subagent.id,
        batchId: subagent.batchId,
        kind: subagent.kind,
        label: subagent.label,
        ...(subagent.documentId ? { documentId: subagent.documentId } : {}),
        fromLine: subagent.fromLine,
        toLine: subagent.toLine,
        status: subagent.status,
        startedAt: subagent.startedAt,
        ...(subagent.completedAt === undefined ? {} : { completedAt: subagent.completedAt }),
        ...(subagent.error ? { error: subagent.error } : {}),
        ...(subagent.documentIds ? { documentIds: subagent.documentIds } : {}),
        ...(subagent.assignmentCount === undefined ? {} : { assignmentCount: subagent.assignmentCount }),
        ...(subagent.completedAssignments === undefined ? {} : { completedAssignments: subagent.completedAssignments }),
        ...(subagent.failureDisposition ? { failureDisposition: subagent.failureDisposition } : {}),
        ...(subagent.parentTakeovers?.length ? { parentTakeovers: subagent.parentTakeovers } : {}),
        ...(subagent.assignmentFailures?.length ? { assignmentFailures: subagent.assignmentFailures } : {})
      }))
    };
  }

  private requireSubagent(subagentId: string): YnSubagentRecord<unknown> {
    for (const batch of this.batches.values()) {
      const record = batch.subagents.find((subagent) => subagent.id === subagentId);
      if (record) return record;
    }
    throw new Error(`Subagent ${subagentId} was not found in this Pi session.`);
  }

  private parentCompletionMessage(
    batch: YnSubagentBatchSnapshot,
    context?: { content?: string; details?: Record<string, unknown> }
  ): AgentMessage {
    const completionSubagents = batch.subagents.map((child) => ({
      id: child.id,
      label: child.label,
      status: child.status,
      ...(child.documentId ? { documentId: child.documentId } : {}),
      ...(child.fromLine === undefined ? {} : { fromLine: child.fromLine }),
      ...(child.toLine === undefined ? {} : { toLine: child.toLine }),
      ...(child.assignmentCount === undefined ? {} : { assignmentCount: child.assignmentCount }),
      ...(child.completedAssignments === undefined ? {} : { completedAssignments: child.completedAssignments }),
      ...(child.error ? { error: child.error } : {}),
      ...(child.failureDisposition ? { failureDisposition: child.failureDisposition } : {})
    }));
    const children = completionSubagents
      .map((child) => {
        const assignmentProgress = child.assignmentCount === undefined
          ? ""
          : `; completed ${child.completedAssignments ?? 0}/${child.assignmentCount} assignment(s)`;
        const currentScope = child.documentId
          ? `; latest document ${child.documentId}`
          : child.fromLine === undefined || child.toLine === undefined
            ? ""
            : `; latest range L${child.fromLine}-L${child.toLine}`;
        return `${child.label}: ${child.status}${assignmentProgress}${currentScope}${child.error ? ` (${child.error})` : ""}`;
      })
      .join("\n");
    const parentTakeoverRequired = batch.subagents.some(
      (child) => child.failureDisposition === "parent_takeover_required"
    );
    const transportRetryExhausted = batch.subagents.some(
      (child) => child.failureDisposition === "transport_retry_exhausted"
    );
    const parentTakeovers = batch.subagents.flatMap((child) => (
      (child.parentTakeovers ?? []).map((takeover) => ({ subagentId: child.id, ...takeover }))
    ));
    const parentTakeoverReady = context?.details?.parentTakeoverReady === true;
    const assignmentFailures = batch.subagents.flatMap((child) => child.assignmentFailures ?? []);
    return {
      role: "custom",
      customType: "subagent-completion",
      content: [
        `HOST WORKFLOW EVENT: the background ${batch.kind} child batch ${batch.id} is ${batch.status}.`,
        children,
        context?.content?.trim() || "",
        batch.status === "completed"
          ? "The background wait is over. Do not keep waiting or repeat a prior status response. Resume the parent workflow now: inspect the child artifacts, merge as needed, run the final host validation, and report the result."
          : transportRetryExhausted
            ? "The provider transport remained unavailable after the bounded native Pi retry budget. Do not automatically start another child batch or drain more assignments. Report this recoverable pause to the user and wait for an explicit continuation after connectivity is available; accepted artifacts and outstanding Host debt remain intact."
            : parentTakeoverRequired && parentTakeoverReady
            ? `The failed assignment exhausted its bounded child repair path and has already been transferred to the parent-owned repair path. Exact evidence is available in ${JSON.stringify(parentTakeovers)}. Continue now without asking the user and without starting another child batch: follow completionContext.parentTakeovers, repair only those rows through writeTranslationChunk, complete the parent alignment audit, and run final validation.`
            : parentTakeoverRequired
            ? `The failed assignment exhausted its bounded child repair path, but the Host could not complete the parent takeover handoff. Exact retained evidence is available in ${JSON.stringify(parentTakeovers)}. Report this Host handoff failure without starting another child batch or claiming completion.`
            : "The assignment exhausted its bounded retry path. Do not automatically start another batch or let this worker claim more tasks. Report the recoverable pause and wait for an explicit user continuation; accepted results and exact outstanding Host debt remain intact."
      ].join("\n"),
      display: false,
      details: {
        batchId: batch.id,
        kind: batch.kind,
        status: batch.status,
        subagents: completionSubagents,
        ...(parentTakeoverRequired ? { failureDisposition: "parent_takeover_required" } : {}),
        ...(transportRetryExhausted ? { failureDisposition: "transport_retry_exhausted" } : {}),
        ...(parentTakeovers.length > 0 ? { parentTakeovers } : {}),
        ...(assignmentFailures.length > 0 ? { assignmentFailures } : {}),
        ...(context?.details ? { completionContext: context.details } : {}),
        deliverAs: "followUp",
        triggerTurn: true
      },
      timestamp: Date.now()
    };
  }
}
