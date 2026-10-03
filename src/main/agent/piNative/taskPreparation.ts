import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import { Type } from "typebox";
import type { PiSessionPromptRequest } from "../../../shared/agent/piSessionContract.ts";
import { normalizeTaskPreparationRequest, type YnTaskPreparationRequest } from "../../../shared/agent/taskPreparation.ts";
import type { CanonicalCustomPreserveRule } from "../../../shared/validation/customPreserveRules.ts";
import { normalizeCustomPreserveRules } from "../../../shared/validation/customPreserveRules.ts";
import type { TaskAssetDraftInput, TaskAssetDraftReadInput } from "../../taskAssetDrafts.ts";

export interface YnTaskPreparationState extends YnTaskPreparationRequest {
  id: string;
  pendingRequest?: PiSessionPromptRequest;
  started?: boolean;
  completed?: boolean;
  stopped?: boolean;
}

export interface YnTaskPreparationContext extends YnTaskPreparationRequest {
  outputDir: string;
  sessionId: string;
  preparationId: string;
  lineReviewPath?: string;
}

export interface YnTaskPreparationHost {
  inspectSettings(context: YnTaskPreparationContext): Promise<unknown>;
  updateSettings(context: YnTaskPreparationContext, input: { settings: Record<string, unknown>; reason: string }, signal?: AbortSignal): Promise<unknown>;
  /** Scan real sources and trial the supplied regexes; Host retains hash-bound evidence. */
  inspectSources(context: YnTaskPreparationContext, input: { rules?: CanonicalCustomPreserveRule[] }, signal?: AbortSignal): Promise<unknown>;
  importAssets(context: YnTaskPreparationContext, input: TaskAssetDraftInput, signal?: AbortSignal): Promise<unknown>;
  readAssetDraft(context: YnTaskPreparationContext, input: TaskAssetDraftReadInput): Promise<unknown>;
  deleteAssetDraftEntries(context: YnTaskPreparationContext, input: { kind: "glossary" | "characters"; keys: string[]; expectedRevision: string }, signal?: AbortSignal): Promise<unknown>;
  checkAssetDraft(context: YnTaskPreparationContext, input: { expectedRevision: string; reviewSummary: string }, signal?: AbortSignal): Promise<unknown>;
  commitAssets(context: YnTaskPreparationContext, input: { expectedRevision: string }, signal?: AbortSignal): Promise<unknown>;
  /** Read fresh saved settings and enforce preservation trials before returning a full Workflow marker. */
  prepareWorkflow(context: YnTaskPreparationContext, input: { customPreserveRules?: CanonicalCustomPreserveRule[] }, signal?: AbortSignal): Promise<PiSessionPromptRequest>;
  /** Open final report; optional application is limited to HTML review state. Never export TXT. */
  finishWorkflow(context: YnTaskPreparationContext, input: { workflow: "translation" | "proofread"; autoApplyProofreadSuggestions: boolean }, signal?: AbortSignal): Promise<void>;
}

export function createTaskPreparationState(request: YnTaskPreparationRequest): YnTaskPreparationState {
  return { id: randomUUID(), ...normalizeTaskPreparationRequest(request)! };
}

export function normalizeTaskPreparationState(value: unknown): YnTaskPreparationState | undefined {
  if (value === undefined) return undefined;
  const request = normalizeTaskPreparationRequest(value)!;
  const input = value as YnTaskPreparationState;
  if (typeof input.id !== "string" || !input.id.trim()) throw new Error("Persisted task preparation has no id.");
  for (const flag of ["started", "completed", "stopped"] as const) {
    if (input[flag] !== undefined && typeof input[flag] !== "boolean") throw new Error(`Invalid task preparation ${flag}.`);
  }
  if (input.pendingRequest !== undefined) assertPreparedWorkflowRequest(input.pendingRequest, request.intent);
  return structuredClone({ ...request, id: input.id, pendingRequest: input.pendingRequest,
    started: input.started, completed: input.completed, stopped: input.stopped });
}

export function taskPreparationContext(state: YnTaskPreparationState, request: Pick<PiSessionPromptRequest, "outputDir" | "sessionId" | "lineReviewPath">): YnTaskPreparationContext {
  return { outputDir: request.outputDir, sessionId: request.sessionId, preparationId: state.id, lineReviewPath: request.lineReviewPath,
    intent: state.intent, autoApplyProofreadSuggestions: state.autoApplyProofreadSuggestions };
}

export function assertPreparedWorkflowRequest(request: PiSessionPromptRequest, intent: YnTaskPreparationRequest["intent"]): void {
  if (intent === "assets") throw new Error("Asset preparation cannot start a complete translation workflow.");
  const marker = new RegExp(`^(?:\\uFEFF)?Workflow: yn-${intent}-v1\\.(?:\\r?\\n|$)`, "u");
  if (!request || !marker.test(request.prompt) || request.workflowIntent !== intent) {
    throw new Error("Host prepared workflow must include the matching full Workflow marker and typed intent.");
  }
  for (const key of ["outputDir", "sessionId", "providerId", "modelId"] as const) {
    if (typeof request[key] !== "string" || !request[key].trim()) throw new Error(`Prepared workflow ${key} is required.`);
  }
}

export function buildTaskPreparationPrompt(state: YnTaskPreparationState): string {
  return [
    "YN TASK PREPARATION:",
    `The user selected ${state.intent}. Saved project settings and source files are authoritative; inspectTaskSettings reads them.`,
    "Use existing read-only list/search/read tools for references, including absolute paths. Settings already confirmed in the UI need no repeated parameter interview.",
    state.intent === "translation"
      ? "This is preflight for the SAME translation started from the HTML parameter form, not a separate translation workflow. First inspectTaskSettings and inspectTaskSources. Compare all parameters with representative source samples (language direction, style/domain, paths, reuse, worker/split choices and existing rules); retain confirmed choices unless actual content contradicts them. Use updateTaskSettings to correct supported parameters in the internal settingsPath, never handwrite project.json. Review matched examples including literal /n and backslash escapes, propose narrow code/control preservation regexes, then trial selected rules INCLUDING existing rules with inspectTaskSources. Preserve tokens, not translatable prose. Finish all parameter updates before the final trial, then startPreparedWorkflow. It saves the same HTML parameter form and uses exactly its manual translation prompt and metadata. Do not translate or initialize translation assets in this preflight."
      : state.intent === "proofread"
        ? "Require an existing translation. Start the prepared proofread workflow using the saved settings."
        : "Read the user's reference materials and prepare structured glossary/character drafts. Do not ask mandatory questions or start translation.",
    ...(state.intent === "assets" ? [
    "REFERENCE ASSETS: importTaskAssets only upserts this preparation's editable draft; it never writes formal assets. Same source/name updates replace supplied fields, arrays replace earlier arrays, and null removes an optional field. Correct your own mistakes directly; do not put corrections into aliases or write repair scripts.",
    "After all reference batches are drafted, readTaskAssetDraft (both collections, all pages), review names and facts against the references, correct/delete inaccurate records, then checkTaskAssetDraft with the current revision and a concise review summary. Only after a successful check call commitTaskAssets to submit both formal assets together. Do not claim completion without a successful commit. Any later draft or formal asset change requires another check.",
    "Existing formal records retain authority. Resolve conflicts in your draft before committing; unrelated formal records and annotations are preserved. Interrupted/failed preparation leaves its draft available in this same session. When preparing translation/proofreading, commit any reference draft before startPreparedWorkflow."
    ] : ["Do not create reference drafts in translation/proofreading preflight. If this same preparation already owns an unfinished reference draft from an earlier turn, review/check/commit it before starting the workflow."]),
    "startPreparedWorkflow is a terminal tool: use it after preparation. Host replaces the tool/request baseline only after this Pi turn settles, in the same project session.",
    "Do not call resumeYnWorkflow to start a new task. It only resumes a parked or suspended workflow.",
    "Proofread auto-apply consent permits HTML review suggestions only; exporting or overwriting TXT requires the user's separate manual action.",
    ""
  ].join("\n");
}

export function createTaskPreparationTools(options: {
  state: YnTaskPreparationState;
  request: PiSessionPromptRequest;
  host: YnTaskPreparationHost;
  persist: () => Promise<void>;
}): AgentTool[] {
  const { state, request, host } = options;
  const context = () => taskPreparationContext(state, request);
  const result = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
  return [
    { name: "inspectTaskSettings", label: "Inspect saved task settings", description: "Read current project settings and source/translation bindings.",
      parameters: Type.Object({}), executionMode: "sequential", async execute() { return result(await host.inspectSettings(context())); } },
    { name: "updateTaskSettings", label: "Update shared task parameters", description: "Correct content-conflicting parameters in the same internal project settings used by the HTML form. Use only editableParameters returned by inspectTaskSettings. Give a concise evidence-based reason; retain confirmed choices otherwise. Does not start a second workflow or write arbitrary files. Trial preservation rules again after changes.",
      parameters: Type.Object({ settings: Type.Record(Type.String(), Type.Unknown()), reason: Type.String() }),
      executionMode: "sequential", async execute(_id, input, signal) { return result(await host.updateSettings(context(), input as { settings: Record<string, unknown>; reason: string }, signal)); } },
    { name: "inspectTaskSources", label: "Inspect source preservation", description: "Scan sources for control prefixes/code, trial preservation regexes and inspect match examples. Retain existing rules.",
      parameters: Type.Object({ rules: Type.Optional(Type.Array(Type.Object({ label: Type.Optional(Type.String()), pattern: Type.String(), flags: Type.Optional(Type.String()) }))) }),
      executionMode: "sequential", async execute(_id, input, signal) {
        const params = input as { rules?: CanonicalCustomPreserveRule[] };
        return result(await host.inspectSources(context(), { ...(params.rules ? { rules: normalizeCustomPreserveRules(params.rules) } : {}) }, signal));
      } },
    { name: "importTaskAssets", label: "Edit reference draft", description: "Upsert this preparation's mutable draft, never formal assets. Correct prior values freely by source/name; supplied arrays replace prior arrays, null removes optional fields. Glossary: source, target, aliases (target-language variants), alternatives, info, status. Characters: name, target, aliases, gender, pronouns, genderConfidence, voice, identity, role, relationships, termsOfAddress, catchphrases, evidence; requiredTerms: source -> target dialogue mappings; forbiddenTerms: array. Scalar fields must be one line at final check. Do not invent facts. Use deleteTaskAssetDraftEntries to remove unwanted records. Review, check and commit only after all batches are ready.",
      parameters: Type.Object({ glossary: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))), characters: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))), expectedRevision: Type.Optional(Type.String()) }),
      executionMode: "sequential", async execute(_id, input, signal) { return result(await host.importAssets(context(), input as TaskAssetDraftInput, signal)); } },
    { name: "readTaskAssetDraft", label: "Read reference draft", description: "Read complete structured draft records with revision. Follow nextOffset until null for both collections before final review.",
      parameters: Type.Object({ kind: Type.Union([Type.Literal("glossary"), Type.Literal("characters")]), offset: Type.Optional(Type.Integer()), limit: Type.Optional(Type.Integer()) }),
      executionMode: "sequential", async execute(_id, input) { return result(await host.readAssetDraft(context(), input as TaskAssetDraftReadInput)); } },
    { name: "deleteTaskAssetDraftEntries", label: "Delete draft entries", description: "Delete unwanted records from this preparation's draft by source/name. Formal assets remain unchanged. Supply the current draft revision.",
      parameters: Type.Object({ kind: Type.Union([Type.Literal("glossary"), Type.Literal("characters")]), keys: Type.Array(Type.String()), expectedRevision: Type.String() }),
      executionMode: "sequential", async execute(_id, input, signal) { return result(await host.deleteAssetDraftEntries(context(), input as { kind: "glossary" | "characters"; keys: string[]; expectedRevision: string }, signal)); } },
    { name: "checkTaskAssetDraft", label: "Check reference draft", description: "After reviewing reference facts and correcting the draft, validate canonical schemas, lossless serialization and conflicts with current formal assets. This check writes no formal asset. Fix reported errors in the draft and check again.",
      parameters: Type.Object({ expectedRevision: Type.String(), reviewSummary: Type.String() }),
      executionMode: "sequential", async execute(_id, input, signal) { return result(await host.checkAssetDraft(context(), input as { expectedRevision: string; reviewSummary: string }, signal)); } },
    { name: "commitTaskAssets", label: "Submit checked reference assets", description: "Atomically promote the checked, unchanged draft to both formal assets. Requires a successful current check. Failure retains the draft and rolls back formal writes. A successful result completes materials preparation.",
      parameters: Type.Object({ expectedRevision: Type.String() }),
      executionMode: "sequential", async execute(_id, input, signal) {
        const committed = await host.commitAssets(context(), input as { expectedRevision: string }, signal);
        if (state.intent === "assets") { state.completed = true; await options.persist(); }
        return result(committed);
      } },
    ...(state.intent === "assets" ? [] : [{ name: "startPreparedWorkflow", label: "Start prepared task", description: "Validate preparation against fresh settings and start the complete native YN workflow. Ends this preparation tool turn.",
      parameters: Type.Object({ customPreserveRules: Type.Optional(Type.Array(Type.Object({ label: Type.Optional(Type.String()), pattern: Type.String(), flags: Type.Optional(Type.String()) }))) }), executionMode: "sequential" as const, async execute(_id: string, input: { customPreserveRules?: CanonicalCustomPreserveRule[] }, signal?: AbortSignal) {
        if ((state.pendingRequest && !state.stopped) || state.started) throw new Error("This preparation already started a workflow.");
        // An explicit retry replaces a parked preparation. Failed fresh Host
        // validation must never fall through to its old prepared request.
        if (state.pendingRequest) {
          state.pendingRequest = undefined;
          await options.persist();
        }
        state.stopped = false;
        const prepared = await host.prepareWorkflow(context(), { ...(input.customPreserveRules ? { customPreserveRules: normalizeCustomPreserveRules(input.customPreserveRules) } : {}) }, signal);
        signal?.throwIfAborted();
        if (state.stopped) throw new DOMException("Task preparation was stopped before workflow handoff.", "AbortError");
        assertPreparedWorkflowRequest(prepared, state.intent);
        state.pendingRequest = structuredClone(prepared);
        await options.persist();
        return result({ prepared: true, workflow: state.intent });
      } }])
  ] as AgentTool[];
}
