import { app, BrowserWindow } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
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
const observed = setInterval(() => {
  const windows = BrowserWindow.getAllWindows();
  maxWindows = Math.max(maxWindows, windows.length); visibleWindows += windows.filter(window => window.isVisible()).length;
}, 10);
const exit = app.exit.bind(app);
app.exit = (code = 0) => {
  clearInterval(observed);
  visibleWindows += BrowserWindow.getAllWindows().filter(window => window.isVisible()).length;
  writeFileSync(path.join(fixture, "acceptance.json"), JSON.stringify({ code, visibleWindows, maxWindows,
    modelSelections, parityChecks, nativeOwners: (piNativeSessionService as any).active.size, paidCalls: 0 }, null, 2));
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
const options = (piNativeSessionService as unknown as { options: PiNativeSessionServiceOptions }).options;
options.createModelSelection = async ({ workspaceDir }) => {
  modelSelections += 1;
  let provider = providers.get(workspaceDir);
  if (!provider) {
    provider = fauxProvider({ tokensPerSecond: 1_000_000, tokenSize: { min: 100_000, max: 100_000 } });
    const mode = path.basename(workspaceDir);
    provider.setResponses(mode === "assets" || mode === "eof" && existsSync(path.join(workspaceDir, "waiting.txt")) ? assets() : mode === "hold" || mode === "eof"
      ? [call("importTaskAssets", { glossary: [{ source: "Draft", target: "草稿" }], characters: [] }), call("fixtureWaitForStop"), ...assets()]
      : mode === "proofread" ? [call("startPreparedWorkflow"), call("completeFixtureWorkflow"), done("Proofreading completed.")]
        : [call("inspectTaskSettings"), call("inspectTaskSources"), call("inspectTaskSources", { rules: [] }),
          call("startPreparedWorkflow", { customPreserveRules: [] }), call("completeFixtureWorkflow"), done("Translation completed.")]);
    providers.set(workspaceDir, provider);
  }
  const models = createModels(); models.setProvider(provider.provider);
  return { models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id };
};
options.createTools = context => {
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
await import("../src/main/main.ts");
