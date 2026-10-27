import { app, BrowserWindow, ipcMain } from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { PiNativeSessionService } from "../src/main/agent/piNative/sessionService.ts";
import { PiSessionRepository } from "../src/main/agent/piNative/sessionRepository.ts";
import { createYnDomainRunContract } from "../src/main/agent/piNative/domainRunContract.ts";
import { createYnDomainTools } from "../src/main/agent/piNative/ynDomainTools.ts";
import { appendYnSessionHostState, createProofreadHostState, createTranslationAlignmentHostState } from "../src/main/agent/piNative/proofreadSessionState.ts";
import { appendSessionMessage } from "../src/main/agent/piNative/sessionAccess.ts";
import { openAgentChatWindow } from "../src/main/agent/piNative/agentChatWindowHost.ts";
import { registerAgentSessionIpc } from "../src/main/ipc/agentSessionHandlers.ts";
import { patchProjectState, readProjectState } from "../src/main/projectState.ts";

const root = process.cwd();
const workspace = process.env.YN_ELECTRON_WARNING_CHOICE_WORKSPACE
  ?? await mkdtemp(path.join(os.tmpdir(), "yn-host-warning-ui-"));
await mkdir(workspace, { recursive: true });
app.disableHardwareAcceleration();
app.setPath("userData", path.join(workspace, "profile"));
app.on("window-all-closed", () => {});
const models = createModels();
const provider = fauxProvider({ provider: "warning-ui", tokensPerSecond: 1_000_000, tokenSize: { min: 100_000, max: 100_000 } });
models.setProvider(provider.provider);
let decision: "review" | "skip" = "skip";
let modelSelections = 0;
let modelCalls = 0;
let finished = 0;
const windows = new Map<number, string>();
const ownedProjects: string[] = [];

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function waitFor(read: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    if (await read()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function closeWindow(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return;
  const closed = new Promise<void>(resolve => window.once("closed", () => resolve()));
  window.close();
  await closed;
}
const service = new PiNativeSessionService({
  createModelSelection: async () => {
    modelSelections++;
    assert(decision !== "skip", "No must not select or prepare a model");
    return { models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id };
  },
  buildSystemPrompt: () => "Complete the authorized synthetic review with the Host tools.",
  enforceDomainCompletion: true,
  createTools: context => [...createYnDomainTools(context), {
    name: "finishSyntheticWarningReview", label: "Finish review", description: "Complete the synthetic review stage.",
    parameters: Type.Object({}),
    async execute() {
      assert(context.domainRun?.fullWorkflow, "Yes must restore the full workflow");
      assert(context.domainRun.translationWarningReviewDecision === "review", "Host must record review before the model runs");
      context.domainRun.recordFinalValidation("translation", "source.txt");
      await context.persistHostState?.();
      finished++;
      return { content: [{ type: "text", text: "Synthetic review complete." }] };
    }
  }]
});

async function run(): Promise<void> {
  registerAgentSessionIpc({ service, resolveInterfaceWorkspace: sender => windows.get(sender.id), broadcast: (channel, payload) => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(channel, payload);
  } });
  ipcMain.handle("agent-provider:getConfig", () => ({
    activeProviderId: provider.provider.id,
    providers: { [provider.provider.id]: { id: provider.provider.id, name: "Synthetic provider", type: "openai_compatible", model: provider.getModel().id, enabled: true, auth: { kind: "api_key", key: "fixture" } } }
  }));
  ipcMain.handle("agent-provider:listConfiguredModels", () => [{
    providerId: provider.provider.id, modelId: provider.getModel().id,
    modelName: "Synthetic model", supportsImages: false, thinkingLevels: []
  }]);
  ipcMain.handle("project:readState", (_event, outputDir: string) => readProjectState(outputDir));
  const screenshot = path.join(root, "artifacts", "electron-warning-review-choice.png");
  await mkdir(path.dirname(screenshot), { recursive: true });

  for (const action of ["skip", "review"] as const) {
    decision = action;
    modelSelections = 0;
    modelCalls = 0;
    finished = 0;
    const outputDir = path.join(workspace, action);
    await mkdir(outputDir, { recursive: true });
    ownedProjects.push(outputDir);
    const sourcePath = path.join(outputDir, "source.txt");
    const source = "Synthetic first sentence.\nSynthetic second sentence.";
    await writeFile(sourcePath, source, "utf8");
    await patchProjectState(outputDir, { sourcePath, sourceKind: "file", languagePair: "en->zh-CN", subagentEnabled: false });
    const repository = new PiSessionRepository(outputDir);
    const sessionId = `warning-ui-${action}`;
    const owner = await repository.create(sessionId);
    const domain = createYnDomainRunContract({ workflowIntent: "translation", fullWorkflow: true, subagentEnabled: false });
    domain.recordInspection({ sourceLineCount: 2, documents: [{ id: "source.txt", sourceLineCount: 2 }], glossaryCandidateExists: true, characterBibleExists: true });
    domain.recordTranslationWrite("translation");
    domain.recordTranslationValidation("translation", 1, "source.txt");
    domain.notePendingTranslationWarningReview();
    await appendSessionMessage(owner, { role: "user", content: [{ type: "text", text: "Synthetic translation task." }], timestamp: Date.now() });
    await appendYnSessionHostState(owner, { schemaVersion: 1, ownerSessionId: sessionId, domainRun: domain.snapshot(), proofread: createProofreadHostState(), translationAlignment: createTranslationAlignmentHostState() });
    await owner.close(BACKGROUND_CONTEXT);
    await repository.writeActiveSessionId(sessionId);
    provider.setResponses([
      fauxAssistantMessage(fauxText("One page is complete; more review remains.")),
      fauxAssistantMessage(fauxToolCall("finishSyntheticWarningReview", {}, { id: "finish-review" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("All authorized review is complete."))
    ].map(response => () => { modelCalls++; return response; }));

    const open = async () => (await openAgentChatWindow({
      args: { outputDir, sourcePath, sourceKind: "file", languagePair: "en->zh-CN", locale: "zh-CN" },
      preloadPath: path.join(root, "dist", "main", "preload.cjs"),
      onWindowCreated: window => {
        windows.set(window.webContents.id, outputDir);
        window.webContents.on("console-message", (_event, _level, message) => console.log(`Renderer: ${message}`));
      },
      loadRendererRoute: (window, route) => window.loadFile(path.join(root, "dist", "renderer", "index.html"), { hash: route })
    })).window;
    let window = await open();
    const shown = () => window.webContents.executeJavaScript('Boolean(document.querySelector("[data-agent-warning-review=true]"))');
    try {
      await waitFor(shown, `${action} Host question on cold open`);
    } catch (error) {
      console.error("Cold Host state", JSON.stringify(await service.getRunState(outputDir, sessionId)));
      console.error("Renderer state", await window.webContents.executeJavaScript("JSON.stringify({url:location.href,text:document.body.innerText})"));
      throw error;
    }
    assert(modelSelections === 0 && modelCalls === 0, "Showing a cold question must not prepare a model");
    if (action === "skip") {
      const image = await window.webContents.capturePage();
      assert(!image.isEmpty(), "Host question screenshot was empty");
      await writeFile(screenshot, image.toPNG());
      await closeWindow(window);
      window = await open();
      await waitFor(shown, "the same pending choice after closing and reopening");
    }
    await waitFor(() => window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-agent-warning-review-decision="${action}"]:not(:disabled)'))`), "enabled decision control");
    await window.webContents.executeJavaScript(`document.querySelector('[data-agent-warning-review-decision="${action}"]').click()`);
    await waitFor(async () => !(await shown()), "Host choice to disappear after a successful decision");
    if (action === "review") await waitFor(async () => finished === 1 && !(await service.getRunState(outputDir, sessionId)).running, "automatic completion after a premature model final");
    assert(action !== "skip" || (modelSelections === 0 && modelCalls === 0), "No must send zero model requests");
    assert(action !== "review" || finished === 1, "Yes must continue the original workflow");
    assert(await readFile(sourcePath, "utf8") === source, "The source fixture changed");
    await closeWindow(window);
    await service.disposeWorkspace(outputDir);
  }
  console.log(JSON.stringify({ hostWarningChoice: true, coldReopenChoice: true, skipZeroModelRequests: true, reviewHostContinued: true, screenshot }));
}

void app.whenReady().then(run).catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}).finally(async () => {
  for (const window of BrowserWindow.getAllWindows()) await closeWindow(window);
  for (const outputDir of ownedProjects) await service.disposeWorkspace(outputDir);
  app.quit();
});
