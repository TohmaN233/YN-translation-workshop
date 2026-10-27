import { app, BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText, getCurrentTools,
  type TranscriptContext, type FauxResponseStep, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { piNativeSessionService, type PiNativeSessionServiceOptions } from "../src/main/agent/piNative/sessionService.ts";
import { configureGlobalAgentDataDir } from "../src/main/agent/agentDataDir.ts";
import { writeProviderConfig } from "../src/main/agent/providerConfigStore.ts";
import { resolveTranslationCandidatePath } from "../src/main/agent/writeTranslationChunk.ts";
import { resolveProofreadReportPath } from "../src/main/agent/writeProofreadFindings.ts";

const fixture = process.env.YN_AGENT_API_FIXTURE!;
app.setAppPath(process.cwd()); app.disableHardwareAcceleration();
configureGlobalAgentDataDir(app.getPath("userData"));
await writeProviderConfig(fixture, { activeProviderId: "custom-api", providers: { "custom-api": {
  id: "custom-api", type: "openai_compatible", name: "Offline Agent API fixture", model: "fixture", models: ["fixture"],
  baseUrl: "http://127.0.0.1:1/v1", enabled: true
} } });
let visibleWindows = 0, maxWindows = 0, modelSelections = 0, parityChecks = 0;
const continuedProjections: string[] = [];
const instrumented = new Set<number>();
const observed = setInterval(() => {
  const windows = BrowserWindow.getAllWindows();
  for(const view of windows.flatMap(window=>window.getBrowserViews())) {
    const web=view.webContents;
    if(instrumented.has(web.id))continue;instrumented.add(web.id);
    const execute=web.executeJavaScript.bind(web);
    web.executeJavaScript=async (script,userGesture)=>{
      const result=await execute(script,userGesture);
      if(script.includes("translationWorkshopTaskParameters.prepare") && existsSync(path.join(fixture,"pause-prepare.txt"))) {
        writeFileSync(path.join(fixture,"prepare-waiting.txt"),String(modelSelections));
        while(!existsSync(path.join(fixture,"release-prepare.txt")))await new Promise(resolve=>setTimeout(resolve,10));
      }
      return result;
    };
  }
  maxWindows = Math.max(maxWindows, windows.length); visibleWindows += windows.filter(window => window.isVisible()).length;
}, 10);
const exit = app.exit.bind(app);
app.exit = (code = 0) => {
  clearInterval(observed);
  visibleWindows += BrowserWindow.getAllWindows().filter(window => window.isVisible()).length;
  writeFileSync(path.join(fixture, "acceptance.json"), JSON.stringify({ code, visibleWindows, maxWindows,
    modelSelections, parityChecks, continuedProjections, nativeOwners: (piNativeSessionService as any).active.size, paidCalls: 0 }, null, 2));
  exit(code);
};
process.on("uncaughtException", error => { console.error("[agent-api-fixture:uncaught]", error); app.exit(1); });
process.on("unhandledRejection", error => { console.error("[agent-api-fixture:unhandled]", error); app.exit(1); });
const providers = new Map<string, ReturnType<typeof fauxProvider>>();
const seenSessions = new Set<string>();
const call = (name: string, args: any = {}) => fauxAssistantMessage(fauxToolCall(name, args, { id: name }), { stopReason: "toolUse" });
const done = (text: string) => fauxAssistantMessage(fauxText(text));
const last = (context: any) => {
  const message = context.messages.filter((message: any) => message.role === "toolResult").at(-1);
  if (message.isError) throw new Error(`Fixture tool failed: ${JSON.stringify(message.content)}`);
  return JSON.parse(message.content.find((block: any) => block.type === "text").text);
};
function assets() {
  return [call("importTaskAssets", { glossary: [{ source: "Alice", target: "爱丽丝" }], characters: [{ name: "Alice", target: "爱丽丝", voice: "calm" }] }),
    call("readTaskAssetDraft", { kind: "glossary" }), call("readTaskAssetDraft", { kind: "characters" }),
    (context: any) => call("checkTaskAssetDraft", { expectedRevision: last(context).revision, reviewSummary: "Checked Alice against the supplied reference." }),
    (context: any) => call("commitTaskAssets", { expectedRevision: last(context).revision }), done("Assets committed.")];
}

/** The PDF in verify-electron-agent-api.mjs is exactly one plain paragraph.
 * Read actual native tool evidence in each fresh proposal/audit context; never
 * invent source IDs, revisions or Host audit receipts. */
function pdfStructureResponse(context: TranscriptContext) {
  const tools = new Set(getCurrentTools(context.messages).map(tool => tool.name));
  const audit = tools.has("submitPdfStructureAudit");
  if (!audit && !tools.has("readPdfStructureDraft")) return undefined;
  const checks = { readingOrder: true, paragraphs: true, tables: true, figures: true, protectedContent: true };
  const calls = new Map(context.messages.flatMap(message => message.role === "assistant"
    ? message.content.filter(block => block.type === "toolCall").map(block => [block.id, block] as const) : []));
  const results = (name: string) => context.messages.flatMap(message => {
    if (message.role !== "toolResult" || message.toolName !== name) return [];
    if (message.isError) throw new Error(`PDF fixture ${name} failed: ${JSON.stringify(message.content)}`);
    const toolCall = calls.get(message.toolCallId);
    if (!toolCall) throw new Error(`PDF fixture result has no native tool call: ${message.toolCallId}`);
    const text = message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    return [{ args: toolCall.arguments, value: JSON.parse(text) }];
  });
  const request = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(
    fauxToolCall(name, args, { id: `${name}-${context.messages.length}` }), { stopReason: "toolUse" });
  const nextRead = (name: string, fromKey: string, toKey: string) => {
    const seen = results(name), total = seen.at(-1)?.value.total;
    if (total === undefined) return request(name, { [fromKey]: 1, [toKey]: 1 });
    if (!Number.isInteger(total) || total < 1) throw new Error(`PDF fixture ${name} returned invalid total.`);
    const read = new Set(seen.flatMap(result => Array.from({ length: Number(result.args[toKey]) - Number(result.args[fromKey]) + 1 }, (_, offset) => Number(result.args[fromKey]) + offset)));
    for (let start = 1; start <= total; start += 1) if (!read.has(start)) return request(name, { [fromKey]: start, [toKey]: Math.min(total, start + 499) });
    return undefined;
  };
  if (audit) {
    const unread = nextRead("readPdfStructureAuditScope", "fromRecord", "toRecord");
    if (unread) return unread;
    const packets = results("readPdfStructureAuditScope"), rows = packets.flatMap(result => result.value.rows);
    const sources = rows.filter(row => row.record === "source"), prepared = rows.filter(row => row.record === "prepared");
    const metadata = packets.at(-1)!.value, source = sources[0], owner = prepared[0];
    if (metadata.kind !== "local" || sources.length !== 1 || prepared.length !== 1
      || source.text !== "Hello {name}" || owner.text !== source.text || owner.kind !== "paragraph"
      || owner.ownerAnchor !== source.physicalLine || JSON.stringify(owner.physicalLines) !== JSON.stringify([source.physicalLine])
      || metadata.startOwnerPhysicalLine !== source.physicalLine
      || JSON.stringify(metadata.outgoingEdges) !== JSON.stringify([{ beforePhysicalLine: source.physicalLine, afterPhysicalLine: "END" }])
      || metadata.tables?.length || metadata.tableFrames?.length || metadata.figureIndex?.references?.length || metadata.figureIndex?.groups?.length
      || source.protection || owner.protection) throw new Error("PDF API fixture evidence no longer describes its one unchanged plain paragraph.");
    if (!results("submitPdfStructureAudit").length) return request("submitPdfStructureAudit", { version: 1, checks, issues: [] });
    return done("Independent synthetic PDF packet audit submitted through the Host tool.");
  }
  const unreadSource = nextRead("readPdfStructureSource", "fromLine", "toLine");
  if (unreadSource) return unreadSource;
  const unreadDraft = nextRead("readPdfStructureDraft", "fromParagraph", "toParagraph");
  if (unreadDraft) return unreadDraft;
  const sources = results("readPdfStructureSource").flatMap(result => result.value.rows);
  const drafts = results("readPdfStructureDraft"), paragraphs = drafts.flatMap(result => result.value.paragraphs);
  if (sources.length !== 1 || sources[0].text !== "Hello {name}" || paragraphs.length !== 1 || paragraphs[0].kind !== "paragraph"
    || JSON.stringify(paragraphs[0].physicalLines) !== JSON.stringify([sources[0].physicalLine])
    || drafts.some(result => result.value.tables.length)) throw new Error("PDF API fixture source/draft evidence changed unexpectedly.");
  const checked = results("checkPdfStructureDraft").at(-1)?.value;
  if (!checked) return request("checkPdfStructureDraft", {});
  if (!checked.valid || checked.revision !== drafts.at(-1)!.value.revision || checked.needsSemanticRepair) throw new Error(`PDF API fixture draft did not pass its current Host check: ${JSON.stringify(checked)}`);
  return done(JSON.stringify({ version: 1, useDraft: true, revision: checked.revision, audit: { ...checks, issues: [] } }));
}

const options = (piNativeSessionService as unknown as { options: PiNativeSessionServiceOptions }).options;
options.createModelSelection = async ({ workspaceDir }) => {
  modelSelections += 1;
  writeFileSync(path.join(fixture,"model-selections.txt"),String(modelSelections));
  let provider = providers.get(workspaceDir);
  if (!provider) {
    provider = fauxProvider({ tokensPerSecond: 1_000_000, tokenSize: { min: 100_000, max: 100_000 } });
    const mode = path.basename(workspaceDir);
    const normalResponses: FauxResponseStep[] = mode === "assets" || mode === "eof" && existsSync(path.join(workspaceDir, "waiting.txt")) ? assets() : mode === "hold" || mode === "eof"
      ? [call("importTaskAssets", { glossary: [{ source: "Draft", target: "草稿" }], characters: [] }), call("fixtureWaitForStop"), ...assets()]
      : mode === "proofread" ? [call("startPreparedWorkflow"), call("completeFixtureWorkflow"), done("Proofreading completed.")]
        : [call("inspectTaskSettings"), call("inspectTaskSources"), call("inspectTaskSources", { rules: [] }),
          call("startPreparedWorkflow", { customPreserveRules: [] }), call("completeFixtureWorkflow"), done("Translation completed.")];
    if (mode === "pdf") {
      const currentProvider = provider;
      const respond: FauxResponseFactory = async (context, streamOptions, state, model) => {
        currentProvider.appendResponses([respond]);
        const structure = pdfStructureResponse(context);
        if (structure) return structure;
        const step = normalResponses.shift();
        if (!step) throw new Error("PDF API fixture exhausted its normal task responses.");
        return typeof step === "function" ? step(context, streamOptions, state, model) : step;
      };
      provider.setResponses([respond]);
    } else provider.setResponses(normalResponses);
    providers.set(workspaceDir, provider);
  }
  const models = createModels(); models.setProvider(provider.provider);
  return { models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id };
};
options.createTools = context => {
  const mode = path.basename(context.request.outputDir);
  if (["bilingual", "epub", "pdf"].includes(mode) && !context.request.taskPreparation) {
    if (!context.request.sourcePath?.endsWith(".txt") || !context.request.sourcePath.includes("extracted-text")) {
      throw new Error(`Continuation lost the ${mode} text projection: ${context.request.sourcePath}`);
    }
    if (!/^(?:\uFEFF)?Workflow:/u.test(context.request.prompt)) {
      continuedProjections.push(mode);
      providers.get(context.request.outputDir)!.setResponses([done("Existing projected task continued.")]);
    }
  }
  if (!seenSessions.has(context.request.sessionId)) {
    seenSessions.add(context.request.sessionId);
    const mode = path.basename(context.request.outputDir);
    if (context.request.taskPreparation?.intent === "assets" && mode !== "hold" && mode !== "eof") providers.get(context.request.outputDir)!.setResponses(assets());
  }
  return [
  { name: "fixtureWaitForStop", label: "Offline cancellation fixture", description: "Wait for native cancellation.", parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      await writeFile(path.join(context.request.outputDir, "waiting.txt"), "native tool entered");
      await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
      return { content: [{ type: "text", text: "Native cancellation received" }] };
    }
  },
  { name: "completeFixtureWorkflow", label: "Offline native completion", description: "Complete the deterministic one-line fixture.", parameters: Type.Object({}),
    async execute() {
      try {
      const request = context.request, domain = context.domainRun!;
      const view = BrowserWindow.getAllWindows().flatMap(window => window.getBrowserViews()).find(view =>
        decodeURI(view.webContents.getURL()).replace(/\\/g, "/").includes(request.lineReviewPath!.replace(/\\/g, "/")));
      if (!view) throw new Error("Native request has no hidden HTML parameter form.");
      const kind = request.workflowIntent === "translation" ? "translate" : "proofread";
      const packet = await view.webContents.executeJavaScript(`(async () => {
        const page = window.translationWorkshopTaskParameters ? window : document.getElementById('fileFrame').contentWindow;
        return page.translationWorkshopTaskParameters.prepare(${JSON.stringify(kind)});
      })()`);
      if (packet.prompt !== request.prompt) throw new Error("External API and HTML prompts differ.");
      for (const key of Object.keys(packet.metadata)) if (JSON.stringify(packet.metadata[key]) !== JSON.stringify((request as any)[key])) throw new Error(`API metadata differs: ${key}`);
      parityChecks += 1;
      const documents = request.folderSourceDocuments ?? [{ id: path.basename(request.sourcePath!), path: request.sourcePath! }];
      domain.recordInspection({ sourceLineCount: documents.length, glossaryCandidateExists: true, characterBibleExists: true,
        ...(request.sourceSelection?.kind === "folder" ? { documents: documents.map(document => ({ id: document.id, sourceLineCount: 1 })) } : {}) });
      if (kind === "translate") {
        for (const document of documents) {
          if (request.sourceSelection?.kind === "folder") domain.selectDocument(document.id);
          const target = resolveTranslationCandidatePath({ outputDir: request.outputDir, sourcePaths: [document.path], documentId: document.id });
          await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, "你好 {name}");
          domain.recordTranslationWrite("translation"); domain.recordTranslationValidation("translation", 0,
            request.sourceSelection?.kind === "folder" ? document.id : undefined);
        }
      } else {
        const sourceText = await readFile(request.sourcePath!, "utf8"), currentTranslation = await readFile(request.translationPath!, "utf8");
        const documentId = path.basename(request.sourcePath!);
        const reportPath = resolveProofreadReportPath({ outputDir: request.outputDir, sourcePaths: [request.sourcePath!], documentId, kind: "findings_json" });
        await mkdir(path.dirname(reportPath), { recursive: true });
        await writeFile(reportPath, JSON.stringify({ schemaVersion: "1.0", documentId, sourcePath: request.sourcePath, translationPath: request.translationPath,
          generatedAt: new Date().toISOString(), mode: "split", findings: [{ id: "fixture-finding", severity: "minor", type: "style", sourceLine: 1, translationLine: 1,
            sourceText, currentTranslation, suggestedFix: "您好 {name}", rationale: "Use a formal greeting." }] }));
        domain.recordProofreadPrescan(); domain.recordSourceRead(); domain.recordTranslationRead();
        domain.recordProofreadParentRead("source", 1, 1); domain.recordProofreadParentRead("translation", 1, 1); domain.recordProofreadParentSemanticReview(1, 1);
        domain.recordProofreadArtifactMutation(); domain.recordProofreadRangeValidated(domain.activeDocumentId!, 1, 1); domain.recordProofreadReportFinalized();
      }
      if (domain.incompleteReasons().length) throw new Error(`Incomplete fixture: ${domain.incompleteReasons()}`);
      return { content: [{ type: "text", text: "Accepted" }] };
      } catch (error) { console.error("[agent-api-fixture:complete]", context.request.outputDir, error); throw error; }
    }
  }
];
};
const nativeAbort=piNativeSessionService.abort.bind(piNativeSessionService);
piNativeSessionService.abort=async (...args)=>{
  if(existsSync(path.join(fixture,"prepare-waiting.txt")))writeFileSync(path.join(fixture,"prepare-stop-requested.txt"),"cancelled");
  return nativeAbort(...args);
};
await import("../src/main/main.ts");
