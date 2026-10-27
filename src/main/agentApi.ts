import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { PiSessionRunState, PiSessionSummary, PiSessionWarningReviewDecisionRequest, PiSessionWarningReviewDecisionResult } from "../shared/agent/piSessionContract.ts";
import { builtinTaskDefaults, restoreTaskInputTranslationPath, type BuiltinTaskSettings, type StartBuiltinTaskRequest } from "../shared/builtinTasks.ts";
import { validateBuiltinTaskSettings } from "./builtinTaskPreparationHost.ts";

export const AGENT_API_VERSION = 1;
export class AgentApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = "AgentApiError"; }
}
export interface AgentApiModel {
  providerId: string; modelId: string; thinkingLevel?: ThinkingLevel | "auto";
}
export interface AgentApiTaskResult { sessionId: string; outputPath?: string }
export interface AgentApiDependencies {
  version: string;
  cwd: string;
  readProject(outputDir: string): Promise<Record<string, unknown>>;
  model(outputDir: string): Promise<AgentApiModel>;
  start(request: StartBuiltinTaskRequest, options: {
    signal: AbortSignal; model: AgentApiModel; onSession(sessionId: string): void;
  }): Promise<AgentApiTaskResult>;
  sessions(outputDir: string): Promise<PiSessionSummary[]>;
  state(outputDir: string, sessionId: string): Promise<PiSessionRunState>;
  decideTranslationWarningReview(request: PiSessionWarningReviewDecisionRequest): Promise<PiSessionWarningReviewDecisionResult>;
  lastReply(outputDir: string, sessionId: string): string | undefined;
  stop(outputDir: string, sessionId: string): Promise<void>;
  resume(outputDir: string, sessionId: string, model: AgentApiModel, signal: AbortSignal, message?: string): Promise<unknown>;
  dispose(outputDir: string): Promise<void>;
}

// Only task-form fields are public. Host manifests, canonical identities and
// arbitrary project.json fields cannot be injected by an external caller.
const settingKeys = ["outputDir", "sourcePath", "translationPath", "glossaryPath", "locale", "fileType", "inputMode",
  "sourcePosition", "translationPosition", "pageSize", "materials", "languagePair", "style", "splitSize",
  "glossaryCandidates", "characterBible", "reuseExistingTranslation", "workDescription", "translateOutputDir",
  "proofreadOutputDir", "proofreadMode", "candidateRatio", "montecarloSize", "montecarloRoundMin", "montecarloRoundMax",
  "subagentEnabled", "subagentCount", "reviewSubagentCount", "subagentProviderId", "subagentModelId",
  "folderTranslationOrder", "customPreserveRules"] as const;
const booleanKeys = new Set(["glossaryCandidates", "characterBible", "reuseExistingTranslation", "subagentEnabled"]);
const numberKeys = new Set(["sourcePosition", "translationPosition", "pageSize", "splitSize", "candidateRatio",
  "montecarloSize", "montecarloRoundMin", "montecarloRoundMax", "subagentCount", "reviewSubagentCount"]);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentApiError("invalid_request", "Expected an object.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new AgentApiError("invalid_request", `Unsupported field: ${key}`);
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AgentApiError("invalid_request", `${name} must be a non-empty string.`);
  return value;
}
function projectDir(value: unknown): string {
  const dir = text(value, "outputDir");
  if (!path.isAbsolute(dir)) throw new AgentApiError("invalid_request", "outputDir must be absolute.");
  return path.resolve(path.basename(dir).toLowerCase() === ".translation-workshop" ? path.dirname(dir) : dir);
}
function pickSettings(value: Record<string, unknown>): Partial<BuiltinTaskSettings> {
  return Object.fromEntries(settingKeys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
function validateOverrides(value: Record<string, unknown>): void {
  keys(value, settingKeys);
  for (const [key, item] of Object.entries(value)) {
    if (key === "customPreserveRules") continue; // Canonical validator below.
    const kind = booleanKeys.has(key) ? "boolean" : numberKeys.has(key) ? "number" : "string";
    if (typeof item !== kind) throw new AgentApiError("invalid_request", `${key} must be a ${kind}.`);
    if (kind === "number" && (!Number.isFinite(item) || Number(item) <= 0
      || (key !== "candidateRatio" && !Number.isInteger(item)))) throw new AgentApiError("invalid_request", `${key} must be positive${key === "candidateRatio" ? "" : " and integral"}.`);
  }
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function failure(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function settleStop(stop: () => Promise<void>, operations: Promise<unknown>[]): Promise<void> {
  const [native, ...adapters] = await Promise.allSettled([Promise.resolve().then(stop), ...operations]);
  const errors = [native, ...adapters.filter(result => result.status !== "rejected"
    || !(result.reason instanceof Error && result.reason.name === "AbortError"))]
    .flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, `Task Stop failed: ${errors.map(failure).join("; ")}`);
}
export function agentApiError(error: unknown): { code: string; message: string } {
  return { code: error instanceof AgentApiError ? error.code : "operation_failed", message: failure(error) };
}

/** Do not attach an older task's Host to the latest task's parameter HTML. */
export function assertAgentApiTaskSession(project: Record<string, unknown>, sessionId: string): void {
  const html = project.lineReviewPath ?? project.lastLineReviewHtml;
  const bound = project.builtinTaskSessionId
    ?? (typeof html === "string" ? /^builtin-(.+)\.html$/i.exec(path.basename(html))?.[1] : undefined);
  if (bound !== undefined && (typeof bound !== "string" || bound !== sessionId)) {
    throw new AgentApiError("session_context_changed", "This project is bound to a different built-in task. Resume its bound session; do not attach an older Host to the current parameters.");
  }
}

/** Attempt every independent cleanup, even when native Stop failed. */
export async function settleAgentApiWorkspace(options: {
  dispose(): Promise<void>; flush: Array<() => Promise<void>>; drain(): Promise<void>;
}): Promise<void> {
  const results = await Promise.allSettled([Promise.resolve().then(options.dispose), ...options.flush.map(flush => Promise.resolve().then(flush))]);
  results.push(...await Promise.allSettled([Promise.resolve().then(options.drain)]));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, `Agent API workspace cleanup failed: ${errors.map(failure).join("; ")}`);
}

interface Plan {
  request: StartBuiltinTaskRequest; model: AgentApiModel; snapshot: string;
  controller: AbortController; sessionId?: string; started?: Promise<AgentApiTaskResult>;
}

/** Transport-neutral adapter. All model work stays in the existing Pi service. */
export function createAgentApi(deps: AgentApiDependencies) {
  const plans = new Map<string, Plan>();
  const owned = new Set<string>();
  const workspaces = new Set<string>();
  const resuming = new Map<string, { controller: AbortController; task: Promise<unknown> }>();
  let closing = false;
  let closeTask: Promise<void> | undefined;
  const identity = (outputDir: string, sessionId: string) => JSON.stringify([outputDir.toLowerCase(), sessionId]);
  const session = async (params: Record<string, unknown>) => {
    keys(params, ["outputDir", "sessionId", "message"]);
    const outputDir = projectDir(params.outputDir), sessionId = text(params.sessionId, "sessionId");
    if (!owned.has(identity(outputDir, sessionId))) {
      if (!(await deps.sessions(outputDir)).some(item => item.id === sessionId)) throw new AgentApiError("session_not_found", "Session does not belong to this project.");
      owned.add(identity(outputDir, sessionId));
    }
    return { outputDir, sessionId };
  };
  const status = async (outputDir: string, sessionId: string) => {
    const state = await deps.state(outputDir, sessionId);
    const reply = deps.lastReply(outputDir, sessionId);
    return { outputDir, sessionId, running: state.running, phase: state.phase, sequence: state.sequence,
      model: state.model, thinkingLevel: state.thinkingLevel, compacting: state.compacting,
      contextUsage: state.contextUsage, error: state.error, compactionError: state.compactionError, warningReview: state.warningReview,
      lastReply: reply?.slice(0, 16000), lastReplyTruncated: (reply?.length ?? 0) > 16000 };
  };
  const close = (): Promise<void> => {
    if (closeTask) return closeTask;
    closing = true;
    for (const plan of plans.values()) plan.controller.abort(new DOMException("Agent API connection closed.", "AbortError"));
    for (const operation of resuming.values()) operation.controller.abort(new DOMException("Agent API connection closed.", "AbortError"));
    closeTask = (async () => {
      // Wait for in-flight project/session creation before disposing the final
      // owners. The start adapter observes cancellation before every handoff.
      const starts = [...plans.values()].flatMap(plan => plan.started ? [plan.started] : []);
      await Promise.allSettled([...starts, ...[...resuming.values()].map(operation => operation.task)]);
      const cleanup = await Promise.allSettled([...workspaces].map(dir => deps.dispose(dir)));
      const errors = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      // A start failure is returned to its caller; cleanup failures are never hidden.
      if (errors.length) throw new AggregateError(errors, `Agent API shutdown failed: ${errors.map(failure).join("; ")}`);
    })();
    return closeTask;
  };
  const call = async (method: string, raw: unknown = {}): Promise<unknown> => {
    const params = object(raw);
    if (closing) throw new AgentApiError("closing", "Agent API is shutting down.");
    if (method === "describe") {
      keys(params, []);
      return { protocol: "yn-agent-api", protocolVersion: AGENT_API_VERSION, version: deps.version,
        methods: ["describe", "plan", "start", "sessions", "status", "stop", "resume", "reply", "decideTranslationWarningReview", "shutdown"],
        settings: settingKeys, instructions: "Call plan first. Show the location, parameters, model and proofreading application choice to the user. Ask for confirmation and wait for their answer before start. Changed parameters require a new plan. Keep stdin open while tasks run. YN uses its configured provider, not the caller's model. TXT export remains manual." };
    }
    if (method === "plan") {
      keys(params, ["task", "settings", "preservationInstructions", "autoApplyProofreadSuggestions"]);
      if (!["translation", "proofread", "assets"].includes(String(params.task))) throw new AgentApiError("invalid_request", "task must be translation, proofread or assets.");
      const overrides = params.settings === undefined ? {} : object(params.settings);
      validateOverrides(overrides);
      if (params.preservationInstructions !== undefined && typeof params.preservationInstructions !== "string") throw new AgentApiError("invalid_request", "preservationInstructions must be a string.");
      if (params.autoApplyProofreadSuggestions !== undefined && typeof params.autoApplyProofreadSuggestions !== "boolean") throw new AgentApiError("invalid_request", "autoApplyProofreadSuggestions must be a boolean.");
      if (params.task !== "proofread" && params.autoApplyProofreadSuggestions !== undefined) throw new AgentApiError("invalid_request", "Auto-application is only available for proofreading.");
      const source = overrides.sourcePath;
      if (source && !path.isAbsolute(String(source))) throw new AgentApiError("invalid_request", "sourcePath must be absolute.");
      const outputDir = projectDir(overrides.outputDir ?? path.join(source ? path.dirname(String(source)) : deps.cwd, "Translation"));
      const project = await deps.readProject(outputDir);
      const saved = restoreTaskInputTranslationPath(project, pickSettings(project) as BuiltinTaskSettings);
      const current = { ...saved, ...overrides, outputDir };
      // Infer the real kind before defaults strip inapplicable folder fields.
      // The caller cannot supply a false Host manifest or sourceKind.
      const sourceInfo = params.task !== "assets" && current.sourcePath ? await stat(current.sourcePath) : undefined;
      const settings = builtinTaskDefaults({ ...current, sourceKind: sourceInfo ? (sourceInfo.isDirectory() ? "folder" : "file")
        : project.sourceKind === "folder" ? "folder" : "file" });
      if (params.task === "translation" && !settings.reuseExistingTranslation) settings.translationPath = "";
      for (const [key, allowed] of [["locale", ["zh-CN", "en-US"]], ["fileType", ["auto", "txt", "epub", "pdf"]],
        ["inputMode", ["separate", "bilingual"]], ["proofreadMode", ["split", "montecarlo"]]] as const) {
        if (!allowed.includes(settings[key] as never)) throw new AgentApiError("invalid_request", `Invalid ${key}.`);
      }
      for (const key of ["translationPath", "glossaryPath", "translateOutputDir", "proofreadOutputDir"] as const) {
        if (settings[key] && !path.isAbsolute(settings[key]!)) throw new AgentApiError("invalid_request", `${key} must be absolute.`);
      }
      const request = { task: params.task, settings, preservationInstructions: params.preservationInstructions,
        autoApplyProofreadSuggestions: params.task === "proofread" ? params.autoApplyProofreadSuggestions === true : undefined } as StartBuiltinTaskRequest;
      request.settings = await validateBuiltinTaskSettings(request);
      const model = await deps.model(outputDir);
      if (closing) throw new AgentApiError("closing", "Agent API is shutting down.");
      const planId = randomUUID();
      plans.set(planId, { request, model, snapshot: fingerprint({ project, model }), controller: new AbortController() });
      const question = settings.locale === "zh-CN"
        ? `是否同意在 ${outputDir} 使用以上参数和 ${model.providerId}/${model.modelId} 启动 YN？${params.task === "proofread" ? `校对意见自动应用到 HTML：${request.autoApplyProofreadSuggestions ? "是" : "否"}；最终 TXT 仍需手动写入。` : ""}`
        : `Start YN in ${outputDir} with these parameters and ${model.providerId}/${model.modelId}?${params.task === "proofread" ? ` Apply proofreading suggestions to HTML automatically: ${request.autoApplyProofreadSuggestions ? "yes" : "no"}. TXT export remains manual.` : ""}`;
      return { planId, confirmationRequired: true, question, ...request, model,
        settingsPath: path.join(outputDir, ".translation-workshop", "project.json"),
        existingProject: Object.keys(project).length > 0 };
    }
    if (method === "start") {
      keys(params, ["planId", "confirmed"]);
      if (params.confirmed !== true) throw new AgentApiError("confirmation_required", "Ask the user and wait for confirmation before creating a project or starting a task.");
      const plan = plans.get(text(params.planId, "planId"));
      if (!plan) throw new AgentApiError("plan_not_found", "Create a plan in this connection before starting.");
      if (plan.controller.signal.aborted) throw new AgentApiError("stopped", "This plan was stopped. Create a new plan.");
      if (!plan.started) {
        plan.started = (async () => {
          const outputDir = plan.request.settings.outputDir;
          const [project, model] = await Promise.all([deps.readProject(outputDir), deps.model(outputDir)]);
          if (fingerprint({ project, model }) !== plan.snapshot) throw new AgentApiError("plan_changed", "Project settings or model changed. Create a new plan and confirm it again.");
          plan.controller.signal.throwIfAborted();
          workspaces.add(outputDir);
          return deps.start(plan.request, { signal: plan.controller.signal, model: plan.model, onSession: sessionId => {
            plan.sessionId = sessionId; owned.add(identity(outputDir, sessionId));
          } });
        })();
      }
      const result = await plan.started;
      return { ...result, outputDir: plan.request.settings.outputDir };
    }
    if (method === "sessions") {
      keys(params, ["outputDir"]);
      const outputDir = projectDir(params.outputDir);
      return { outputDir, sessions: await deps.sessions(outputDir) };
    }
    if (method === "stop" && params.planId !== undefined) {
      keys(params, ["planId"]);
      const plan = plans.get(text(params.planId, "planId"));
      if (!plan) throw new AgentApiError("plan_not_found", "Unknown plan.");
      plan.controller.abort(new DOMException("Agent API task was stopped.", "AbortError"));
      // Cancelling the adapter signals the native prompt, even while its
      // acceptance is preparing storage. Do not serialize Stop behind start.
      await settleStop(() => plan.sessionId ? deps.stop(plan.request.settings.outputDir, plan.sessionId) : Promise.resolve(),
        plan.started ? [plan.started] : []);
      return { stopped: true };
    }
    if (method === "decideTranslationWarningReview") {
      keys(params, ["outputDir", "sessionId", "reviewId", "decision"]);
      const { outputDir, sessionId } = await session({ outputDir: params.outputDir, sessionId: params.sessionId });
      if (closing) throw new AgentApiError("closing", "Agent API is shutting down.");
      if (params.decision !== "review" && params.decision !== "skip") throw new AgentApiError("invalid_params", "decision must be review or skip.");
      workspaces.add(outputDir);
      return deps.decideTranslationWarningReview({ outputDir, sessionId, reviewId: text(params.reviewId, "reviewId"), decision: params.decision });
    }
    if (method === "status" || method === "stop" || method === "resume" || method === "reply") {
      keys(params, method === "reply" ? ["outputDir", "sessionId", "message"] : ["outputDir", "sessionId"]);
      const message = method === "reply" ? text(params.message, "message") : undefined;
      const { outputDir, sessionId } = await session(params);
      if (method === "status") return status(outputDir, sessionId);
      if (closing) throw new AgentApiError("closing", "Agent API is shutting down.");
      workspaces.add(outputDir);
      if (method === "stop") {
        const key = identity(outputDir, sessionId);
        const resume = resuming.get(key);
        resume?.controller.abort();
        const stoppedPlans = [...plans.values()].filter(plan => plan.sessionId && identity(plan.request.settings.outputDir, plan.sessionId) === key);
        for (const plan of stoppedPlans) plan.controller.abort();
        await settleStop(() => deps.stop(outputDir, sessionId),
          [...stoppedPlans.flatMap(plan => plan.started ? [plan.started] : []), ...(resume ? [resume.task] : [])]);
        return { stopped: true, ...await status(outputDir, sessionId) };
      }
      const key = identity(outputDir, sessionId);
      if (resuming.has(key)) throw new AgentApiError("busy", "The session is already resuming.");
      const controller = new AbortController();
      const task = (async () => {
        if ((await deps.state(outputDir, sessionId)).running) throw new AgentApiError("busy", "The session is already running.");
        const model = await deps.model(outputDir);
        controller.signal.throwIfAborted();
        return deps.resume(outputDir, sessionId, model, controller.signal, message);
      })();
      resuming.set(key, { controller, task });
      try { await task; } finally { resuming.delete(key); }
      return { accepted: true, outputDir, sessionId };
    }
    if (method === "shutdown") { keys(params, []); await close(); return { stopped: true }; }
    throw new AgentApiError("unknown_method", `Unknown method: ${method}`);
  };
  return { call, close };
}
