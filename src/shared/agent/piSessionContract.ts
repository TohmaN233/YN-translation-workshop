import type { AgentHarnessEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { CanonicalCustomPreserveRule } from "../validation/customPreserveRules.ts";

export const YN_WORKFLOW_SUBAGENT_COUNT = 2;
export const YN_DEFAULT_SPLIT_SIZE = 1_000;
export type PiWorkflowIntent = "translation" | "proofread";
export type PiProofreadMode = "split" | "montecarlo";

export function resolveWorkflowSubagentCount(enabled?: boolean, count?: number): number {
  if (enabled === false) return 0;
  if (count === undefined) return YN_WORKFLOW_SUBAGENT_COUNT;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`subagentCount must be a positive integer, received ${count}.`);
  }
  return count;
}

export function maximumWorkflowSubagents(
  enabled: boolean | undefined,
  count: number | undefined,
  sourceLineCount: number
): number {
  if (!Number.isInteger(sourceLineCount) || sourceLineCount < 1) {
    throw new Error(`sourceLineCount must be a positive integer, received ${sourceLineCount}.`);
  }
  return sourceLineCount === 1 ? 0 : Math.min(sourceLineCount, resolveWorkflowSubagentCount(enabled, count));
}

export type PiSourceSelection =
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string };

export interface PiFolderSourceDocument {
  id: string;
  path: string;
}

export interface PiWorkflowPromptMetadata {
  workflowIntent: PiWorkflowIntent;
  languagePair: string;
  style?: string;
  workDescription?: string;
  glossaryPath?: string;
  glossaryCandidates?: boolean;
  characterBible?: boolean;
  reuseExistingTranslation?: boolean;
  auditWhitelistLines?: number[];
  customPreserveRules?: CanonicalCustomPreserveRule[];
  subagentEnabled?: boolean;
  subagentCount?: number;
  reviewSubagentCount?: number;
  subagentProviderId?: string;
  subagentModelId?: string;
  translationSplitSize?: number;
  folderTranslationOrder?: string;
  folderSourceDocuments?: PiFolderSourceDocument[];
  proofreadMode?: PiProofreadMode;
  proofreadSplitSize?: number;
  proofreadMontecarloSize?: number;
  proofreadMontecarloRoundMin?: number;
  proofreadMontecarloRoundMax?: number;
}

export interface PiSessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface PiSessionBootstrap {
  sessions: PiSessionSummary[];
  activeSessionId: string;
}

export interface PiChildSessionMessagesRequest {
  outputDir: string;
  parentSessionId: string;
  childSessionId: string;
}

export interface PiSessionEventEnvelope {
  workspaceDir: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  event: PiSessionRuntimeEvent;
}

export interface PiSessionRunState {
  sessionId: string;
  sequence: number;
  running: boolean;
  phase: "idle" | "turn" | "compaction" | "branch_summary" | "retry";
  streamingMessage: AgentMessage | null;
  model: Pick<Model<any>, "provider" | "id" | "name"> | null;
  thinkingLevel: ThinkingLevel;
  queuedSteer: AgentMessage[];
  queuedFollowUp: AgentMessage[];
  queuedNextTurn: AgentMessage[];
  subagentMessages: AgentMessage[];
  compacting: boolean;
  contextUsage?: PiSessionContextUsage;
  lastCompaction?: PiSessionCompactionResult;
  compactionError?: string;
  error?: string;
}

export interface PiSessionStateEnvelope {
  workspaceDir: string;
  state: PiSessionRunState;
  selectionChange: boolean;
}

export interface PiSessionContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export interface PiSessionCompactionResult {
  reason: "manual" | "threshold" | "overflow";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter: number;
  timestamp: number;
  details?: unknown;
}

export type PiSessionRuntimeEvent = AgentHarnessEvent
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string;
    }
  | {
      type: "compaction_start";
      reason: "threshold" | "overflow";
    }
  | {
      type: "compaction_end";
      reason: "threshold" | "overflow";
      result?: PiSessionCompactionResult;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    };

export interface PiSessionPromptRequest {
  outputDir: string;
  sessionId: string;
  prompt: string;
  images?: PiSessionImageAttachment[];
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel | "auto";
  workflowIntent?: PiWorkflowIntent;
  languagePair?: string;
  style?: string;
  workDescription?: string;
  glossaryPath?: string;
  glossaryCandidates?: boolean;
  characterBible?: boolean;
  reuseExistingTranslation?: boolean;
  auditWhitelistLines?: number[];
  customPreserveRules?: CanonicalCustomPreserveRule[];
  subagentEnabled?: boolean;
  subagentCount?: number;
  reviewSubagentCount?: number;
  subagentProviderId?: string;
  subagentModelId?: string;
  translationSplitSize?: number;
  folderTranslationOrder?: string;
  folderSourceDocuments?: PiFolderSourceDocument[];
  sourcePath?: string;
  sourceSelection?: PiSourceSelection;
  translationPath?: string;
  translationBindingOrigin?: "user" | "canonical";
  lineReviewPath?: string;
  proofreadMode?: PiProofreadMode;
  proofreadSplitSize?: number;
  proofreadMontecarloSize?: number;
  proofreadMontecarloRoundMin?: number;
  proofreadMontecarloRoundMax?: number;
}

export interface PiSessionImageAttachment {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiSessionPromptAcceptance {
  accepted: true;
  sessionId: string;
}

export interface PiSessionCompactRequest {
  outputDir: string;
  sessionId: string;
  providerId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel | "auto";
  customInstructions?: string;
}

export type PiSessionInputKind = "steer" | "followUp";

export interface PiSessionInputRequest {
  outputDir: string;
  sessionId: string;
  kind: PiSessionInputKind;
  text: string;
  images?: PiSessionImageAttachment[];
}
