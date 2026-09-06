import { strict as assert } from "node:assert";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
  }
}

async function source(file) {
  return readFile(path.resolve(file), "utf8");
}

async function existingPath(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

async function productModuleGraph(roots) {
  const seen = new Set();
  const visit = async (file) => {
    const absolute = path.resolve(file);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    const text = await readFile(absolute, "utf8");
    const specs = [];
    for (const pattern of [
      /\bfrom\s+["'](\.[^"']+)["']/g,
      /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
      /\bimport\s+["'](\.[^"']+)["']/g
    ]) {
      for (const match of text.matchAll(pattern)) specs.push(match[1]);
    }
    for (const spec of specs) {
      const base = path.resolve(path.dirname(absolute), spec);
      const resolved = await existingPath([
        base,
        `${base}.ts`,
        `${base}.tsx`,
        path.join(base, "index.ts"),
        path.join(base, "index.tsx")
      ]);
      if (resolved && /\.[cm]?[jt]sx?$/.test(resolved)) await visit(resolved);
    }
  };
  for (const root of roots) await visit(root);
  return seen;
}

await test("product pins aligned Pi runtime packages and validates remote catalogs against installed APIs", async () => {
  const pkg = JSON.parse(await source("package.json"));
  const productAgentVersion = pkg.dependencies?.["@earendil-works/pi-agent-core"];
  const productAiVersion = pkg.dependencies?.["@earendil-works/pi-ai"];
  assert.match(productAgentVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(productAiVersion, productAgentVersion);
  const remoteCatalog = await source("src/main/agent/piNative/remotePiModelCatalog.ts");
  assert.match(remoteCatalog, /https:\/\/pi\.dev/);
  assert.match(remoteCatalog, /supportedApis\.has\(/);
  assert.match(remoteCatalog, /unsupported by the installed Pi provider runtime/);
});

await test("product parent and child runtimes are built on Pi core Agent and Pi JSONL sessions", async () => {
  const service = await source("src/main/agent/piNative/sessionService.ts");
  const repository = await source("src/main/agent/piNative/sessionRepository.ts");
  const runtime = await source("src/main/agent/piNative/sessionAgentRuntime.ts");
  const childRunner = await source("src/main/agent/piNative/subagentRunner.ts");
  const childSupervisor = await source("src/main/agent/piNative/subagentSupervisor.ts");
  const nativeSource = `${service}\n${repository}\n${runtime}\n${childRunner}\n${childSupervisor}`;
  for (const required of [
    "@earendil-works/pi-agent-core/node",
    "new Agent({",
    "convertToLlm,",
    "JsonlSessionRepo",
    "session.buildContext()",
    "session.appendMessage(",
    "active.runtime.prompt(",
    "active.runtime.steer(",
    "active.runtime.followUp(",
    "active.runtime.abort(",
    "new PiSessionAgentRuntime("
  ]) {
    assert.ok(nativeSource.includes(required), `native Pi service is missing ${required}`);
  }
  assert.match(childRunner, /new PiSessionRepository\([^)]*outputDir\)\.createChild\(/);
  assert.doesNotMatch(childRunner, /InMemorySessionRepo/);
  assert.match(childSupervisor, /record\.control = undefined/);
  assert.match(childSupervisor, /openChild\(record\.id\)/);
  assert.match(childSupervisor, /record\.results = \[\]/);
  assert.match(repository, /childRepo = new JsonlSessionRepo\(/);
  assert.match(repository, /return this\.childRepo\.create\(/);
  for (const forbidden of [
    "new AgentHarness(",
    "harness.prompt(",
    "YnPiRuntimeSession",
    "runPiAgentLoop",
    "startJobWithTimeline",
    "registerActiveJobRun",
    "waiting_for_human",
    "messageContract",
    "piRuntime/providerStream"
  ]) {
    assert.equal(nativeSource.includes(forbidden), false, `native Pi runtime still depends on ${forbidden}`);
  }
  assert.equal(runtime.includes("NodeExecutionEnv"), false);
  assert.equal(childRunner.includes("NodeExecutionEnv"), false);
  assert.match(runtime, /new Agent\(\{[\s\S]*?convertToLlm,/);
});

await test("native children receive the same canonical project assets enforced by host validation", async () => {
  const childRunner = await source("src/main/agent/piNative/subagentRunner.ts");
  assert.match(childRunner, /readProjectAssets/);
  assert.doesNotMatch(childRunner, /settings\/GLOSSARY|settings\/CHARACTER_BIBLE|settings\/STYLE_GUIDE/);
});

await test("production workflow prompt delegates queue mechanics to the Host", async () => {
  const prompt = await source("src/main/agent/piNative/systemPrompt.ts");
  assert.doesNotMatch(prompt, /run(?:Translation|Proofread)Subagents exactly once/i);
  assert.match(prompt, /Host queue owns assignment, validation, review, retry, and settlement/i);
  assert.doesNotMatch(prompt, /never overlap batches|non-overlapping replacement batch/i);
});

await test("Host source binding is declared by typed tool capability rather than a tool-name gate", async () => {
  const tools = await source("src/main/agent/piNative/ynDomainTools.ts");
  assert.match(tools, /interface YnDomainAgentTool extends AgentTool[\s\S]*requiresSourceManifest\?: true/);
  assert.match(tools, /requiresSourceManifest: true,[\s\S]*name: "runTranslationSubagents"/);
  assert.doesNotMatch(tools, /\b(?:const|let|var)\s+sourceBoundTools\b|sourceBoundTools\.has\(/);
});

await test("the compiled product graph contains no tool-name permission list", async () => {
  const graph = await productModuleGraph([
    "src/main/main.ts",
    "src/main/preload.ts",
    "src/renderer/App.tsx",
    "src/renderer/agent/embedded.tsx"
  ]);
  const forbidden = /\b(?:sourceBoundTools|allowedToolNames|blockedToolNames|toolNameBlacklist|toolNameWhitelist|suspendedWorkflowTools)\b/;
  for (const file of graph) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, forbidden, `product tool permission still depends on a name list in ${file}`);
  }
});

await test("current domain snapshots cannot persist legacy authorization or exact-count fields", async () => {
  const contract = await source("src/main/agent/piNative/domainRunContract.ts");
  const currentSnapshot = contract.slice(
    contract.indexOf("export interface YnDomainRunSnapshot"),
    contract.indexOf("export type YnDomainRunRestoreSnapshot")
  );
  const snapshotWriter = contract.slice(
    contract.indexOf("snapshot() {"),
    contract.indexOf("incompleteReasons,", contract.indexOf("snapshot() {"))
  );
  for (const legacy of [
    "explicitDelegationActive",
    "explicitDelegationCountMode",
    "userAuthorizedTranslationReuseAuditIds",
    "workflowDelegationCountMode",
    "explicitDelegationBatch",
    "proofreadMontecarloDecisionAuthorized"
  ]) {
    assert.equal(currentSnapshot.includes(legacy), false, `current snapshot still exposes legacy field ${legacy}`);
    assert.equal(snapshotWriter.includes(legacy), false, `snapshot writer still persists legacy field ${legacy}`);
  }
  assert.match(contract, /One-way persistence migration input/);
});

await test("prompt text and old exact-count contracts cannot authorize native child tools", async () => {
  const service = await source("src/main/agent/piNative/sessionService.ts");
  const tools = await source("src/main/agent/piNative/ynDomainTools.ts");
  const contract = await source("src/shared/agent/piSessionContract.ts");
  const domainContract = await source("src/main/agent/piNative/domainRunContract.ts");
  const proofreadPlan = await source("src/main/agent/piNative/proofreadPlan.ts");
  const product = `${service}\n${tools}\n${contract}\n${proofreadPlan}`;
  for (const forbidden of [
    "PiExplicitSubagentDelegation",
    "exactWorkerCount",
    "workflowDelegationCountMode",
    "explicitDelegationCountMode",
    "assertTranslationReuseDecisionReady"
  ]) {
    assert.equal(product.includes(forbidden), false, `product path still contains obsolete authorization ${forbidden}`);
  }
  assert.doesNotMatch(service, /request\.prompt\.(?:includes|match|search)|\/[^\n/]*subagent[^\n/]*\/[gimyus]*\.test\(request\.prompt/i);
  const createOptions = domainContract.slice(
    domainContract.indexOf("export interface CreateYnDomainRunContractOptions"),
    domainContract.indexOf("interface DocumentRunState")
  );
  assert.doesNotMatch(createOptions, /\bprompt\??\s*:/, "domain authorization must not accept prompt prose as input");
  assert.doesNotMatch(tools, /tasks\.length\s*>\s*(?:max|maximum|configured)|configured[^\n]*===\s*tasks\.length/i);
});

await test("full translation workers cannot claim the next assignment before independent review acceptance", async () => {
  const runner = await source("src/main/agent/piNative/subagentRunner.ts");
  assert.match(runner, /onChunkReadyForReview/);
  assert.match(runner, /decision\.accepted/);
  assert.match(runner, /reviewFeedback/);
  assert.match(runner, /createPiTranslationReviewSubagentWorker/);
  assert.match(runner, /promoteTranslationStagingRange/);
  assert.doesNotMatch(runner, /parent.*(?:approve|review).*chunk/i);
});

await test("agent-session IPC calls only the native Pi service", async () => {
  const handlers = await source("src/main/ipc/agentSessionHandlers.ts");
  assert.ok(handlers.includes("piNativeSessionService"));
  for (const forbidden of [
    "productSessionRuntime",
    "runProviderJob",
    "jobManager",
    "conversationStore",
    "waiting_for_human",
    "pendingWorkflowResume",
    "resumeFromJobId"
  ]) {
    assert.equal(handlers.includes(forbidden), false, `product IPC still contains legacy ${forbidden}`);
  }
});

await test("a shared Agent popout does not own or abort the workspace session", async () => {
  const host = await source("src/main/agent/piNative/agentChatWindowHost.ts");
  const main = await source("src/main/main.ts");
  assert.equal(host.includes("abortWorkspace"), false);
  assert.doesNotMatch(host, /window\.once\(["']closed["']/);
  assert.doesNotMatch(host, /window\.loadFile\(lineReviewPath/);
  assert.doesNotMatch(host, /embedded-html-popout/);
  assert.match(host, /params\.set\("lineReviewPath",\s*lineReviewPath\)/);
  assert.match(host, /options\.loadRendererRoute\(window,\s*`agent-chat-window/);
  assert.doesNotMatch(main, /abortWorkspace:\s*\(outputDir\)/);
  assert.match(main, /await piNativeSessionService\.suspendWorkspace\(tab\.workspaceDir\)/);
  assert.match(main, /htmlViewerWindow\.on\("close",\s*\(event\)\s*=>/);
  assert.match(main, /event\.preventDefault\(\)/);
});

await test("HTML viewer attaches each BrowserView once and switches tabs without listener leaks", async () => {
  const main = await source("src/main/main.ts");
  const activate = main.slice(
    main.indexOf("function activateHtmlViewerTab"),
    main.indexOf("async function rememberHtmlViewerTabProject")
  );
  const load = main.slice(
    main.indexOf("async function loadHtmlViewerTab"),
    main.indexOf("async function injectHtmlSidecarState")
  );
  assert.match(activate, /if \(activeHtmlViewerTab !== key\) \{[\s\S]*setTopBrowserView\(tab\.view\)/);
  assert.doesNotMatch(activate, /(?:add|remove|set)BrowserView\(/);
  assert.match(load, /htmlViewerWindow!\.addBrowserView\(view\)/);
  assert.match(main, /removeBrowserView\(tab\.view\);[\s\S]*tab\.view\.webContents\.close\(\)/);
  assert.match(main, /key === activeHtmlViewerTab[\s\S]*width: 0, height: 0/);
  assert.match(main, /async function flushHtmlViewerTabState\(tab: HtmlViewerTab\)/);
  assert.match(main, /await flushHtmlViewerTabState\(tab\);[\s\S]*await cancelHtmlViewerTabAgentRuns\(tab\);/);
  assert.match(main, /Promise\.all\(tabs\.map\(flushHtmlViewerTabState\)\)[\s\S]*Promise\.all\(tabs\.map\(cancelHtmlViewerTabAgentRuns\)\)/);
  const html = await source("src/shared/core/html.ts");
  const unload = html.slice(
    html.indexOf('addEventListener("beforeunload", () => {'),
    html.indexOf("render();", html.indexOf('addEventListener("beforeunload", () => {'))
  );
  assert.match(unload, /storeLineReviewStateLocally\(\)/);
  assert.doesNotMatch(unload, /\bsave\(\)/, "beforeunload must not start an unawaitable Host IPC write");
});

await test("renderer consumes native Pi messages and events without a legacy transcript reducer", async () => {
  const client = await source("src/renderer/agent/piweb/electronPiSessionClient.ts");
  const hook = await source("src/renderer/agent/piweb/useAgentSession.ts");
  const contract = await source("src/shared/agent/piSessionContract.ts");
  assert.ok(client.includes("agentSession"));
  assert.match(contract, /export type PiSessionRuntimeEvent = AgentHarnessEvent/);
  assert.match(contract, /event:\s*PiSessionRuntimeEvent/);
  assert.equal(contract.includes("event: unknown"), false);
  assert.equal(hook.includes("interface NativeHarnessEvent"), false);
  assert.equal(hook.includes("as NativeHarnessEvent"), false);
  assert.equal(client.includes("ynAgentAdapter"), false);
  assert.equal(client.includes("reducePiWebTranscript"), false);
  assert.equal(hook.includes("reducePiWebTranscript"), false);
  assert.equal(hook.includes("reconcileAcceptedRun"), false);
  assert.equal(hook.includes("activeRunId"), false);
  assert.equal(hook.includes("waiting_for_human"), false);
});

await test("slimmed pi-web input exposes only product-backed controls and commands", async () => {
  const input = await source("src/renderer/agent/piweb/ChatInput.tsx");
  const messageTypes = await source("src/renderer/agent/piweb/types.ts");
  const sessionTypes = await source("src/renderer/agent/piweb/sessionTypes.ts");
  const messageView = await source("src/renderer/agent/piweb/MessageView.tsx");
  const markdownBody = await source("src/renderer/agent/piweb/MarkdownBody.tsx");
  const sessionService = await source("src/main/agent/piNative/sessionService.ts");
  const sessionIpc = await source("src/main/ipc/agentSessionHandlers.ts");
  const sessionRequest = await source("src/main/ipc/agentSessionRequest.ts");
  const sessionContract = await source("src/shared/agent/piSessionContract.ts");
  const preload = await source("src/main/preload.ts");
  const sessionHook = await source("src/renderer/agent/piweb/useAgentSession.ts");
  const chatWindow = await source("src/renderer/agent/piweb/ChatWindow.tsx");
  for (const forbidden of ["soundEnabled"]) {
    assert.equal(input.includes(forbidden), false, `ChatInput still exposes unbacked ${forbidden}`);
  }
  assert.match(input, /interface AttachedImage/);
  assert.match(input, /processImageFiles/);
  assert.match(input, /data-agent-attach-image/);
  assert.match(sessionContract, /images\?:\s*PiSessionImageAttachment\[\]/);
  assert.match(sessionRequest, /function imageAttachments/);
  assert.match(sessionService, /runtime\.prompt\([^,]+,\s*\{ images \}\)/);
  assert.match(preload, /sendInput:\s*\(args:\s*unknown\)\s*=>\s*ipcRenderer\.invoke\("agent-session:input",\s*args\)/);
  assert.match(input, /data-agent-slash-menu/);
  assert.match(input, /onBuiltinCommand/);
  assert.match(input, /onCompact/);
  assert.match(input, /compactResult/);
  assert.match(input, /data-agent-auto-retry/);
  assert.match(sessionHook, /event\.type === "auto_retry_start"/);
  assert.match(sessionService, /active\.runtime\.compact\(/);
  assert.match(sessionService, /shouldCompact\(/);
  assert.match(sessionIpc, /agent-session:compact/);
  assert.match(preload, /agent-session:compact/);
  assert.match(sessionHook, /electronPiSessionClient\.compact\(/);
  assert.match(chatWindow, /name: "compact"/);
  for (const forbidden of [
    "ExtensionUiRequest",
    "CompactionEntry",
    "BranchSummaryEntry",
    "SessionTreeNode",
    "RpcSessionState"
  ]) {
    assert.equal(messageTypes.includes(forbidden), false, `pi-web message types still expose unused ${forbidden}`);
  }
  for (const forbidden of ["SlashCommandInfo", "BuiltinSlashCommandResult", "CompactResultInfo"]) {
    assert.equal(sessionTypes.includes(forbidden), false, `pi-web session types still expose unused ${forbidden}`);
  }
  for (const forbidden of ["onFork", "forking", "onNavigate", "prevAssistantEntryId", "onEditContent"]) {
    assert.equal(messageView.includes(forbidden), false, `MessageView still exposes unbacked ${forbidden}`);
  }
  assert.match(markdownBody, /from ["']react-markdown["']/);
  assert.match(markdownBody, /<ReactMarkdown/);
  assert.equal(markdownBody.includes("renderPlainMarkdown"), false, "Markdown must use the pi-web renderer rather than literal plain text");
});

await test("generated workflow metadata reaches native Pi prompt IPC with its typed language pair", async () => {
  const shared = await source("src/shared/agent/piSessionContract.ts");
  const html = await source("src/shared/core/html.ts");
  const embed = await source("src/shared/core/agentChatEmbed.ts");
  const embeddedEntry = await source("src/renderer/agent/embedded.tsx");
  const chatWindow = await source("src/renderer/agent/piweb/ChatWindow.tsx");
  const input = await source("src/renderer/agent/piweb/ChatInput.tsx");
  const hook = await source("src/renderer/agent/piweb/useAgentSession.ts");
  const handlers = await source("src/main/ipc/agentSessionHandlers.ts");
  const requestParser = await source("src/main/ipc/agentSessionRequest.ts");
  const service = await source("src/main/agent/piNative/sessionService.ts");
  const providerHandlers = await source("src/main/ipc/agentProviderHandlers.ts");
  assert.match(shared, /interface PiWorkflowPromptMetadata[\s\S]*workflowIntent:\s*PiWorkflowIntent;[\s\S]*languagePair:\s*string;/);
  assert.match(shared, /subagentProviderId\?:\s*string[\s\S]*subagentModelId\?:\s*string/);
  assert.match(shared, /subagentEnabled\?:\s*boolean[\s\S]*subagentCount\?:\s*number/);
  assert.match(shared, /subagentCount\?:\s*number[\s\S]*reviewSubagentCount\?:\s*number/);
  assert.match(shared, /glossaryPath\?:\s*string[\s\S]*glossaryCandidates\?:\s*boolean[\s\S]*characterBible\?:\s*boolean[\s\S]*reuseExistingTranslation\?:\s*boolean[\s\S]*auditWhitelistLines\?:\s*number\[\]/);
  assert.match(shared, /languagePair\?:\s*string/);
  assert.match(html, /promptSubagentModel/);
  assert.match(html, /promptSubagent/);
  assert.match(html, /promptSubagentCount/);
  assert.match(html, /promptReviewSubagentCount/);
  assert.match(html, /Files inside braces have no order preference/);
  assert.ok(html.includes("folderTranslationOrderHint: \"\\u5927\\u62ec\\u53f7\\u5185\\u7684\\u6587\\u4ef6\\u4e92\\u76f8\\u6ca1\\u6709\\u5148\\u540e\\u8981\\u6c42"));
  assert.doesNotMatch(html, /Files inside braces run in parallel/);
  assert.match(html, /listAgentConfiguredModels\(\{ outputDir \}\)/);
  assert.match(
    providerHandlers,
    /supportsImages:\s*entry\.supportsImages/,
    "configured-model IPC must preserve Pi image capability metadata"
  );
  assert.match(html, /auditWhitelistLines:\s*auditWhitelistLines\(\)/);
  assert.match(html, /reuseExistingTranslation:\s*settings\.reuseExistingTranslation/);
  assert.doesNotMatch(html, /promptWithAuditWhitelist|auditWhitelistInstruction/);
  assert.match(
    html,
    /replaceText\(promptText,\s*workflowMetadata\)/,
    "regenerating a workflow prompt must replace the preloaded default prompt and its metadata"
  );
  assert.match(embed, /workflowMetadata\(value\)/);
  assert.match(embed, /subagentProviderId/);
  assert.match(embed, /translationSplitSize/);
  assert.match(embed, /folderTranslationOrder/);
  assert.match(embed, /folderSourceDocuments/);
  assert.match(embed, /glossaryCandidates/);
  assert.match(embed, /characterBible/);
  assert.match(embed, /reuseExistingTranslation/);
  assert.match(embed, /auditWhitelistLines/);
  assert.match(embed, /if \(mountPromise\) return mountPromise/);
  assert.doesNotMatch(embed, /for \(let attempt = 0; attempt < 20/);
  assert.match(embeddedEntry, /onEmbeddedReady=\{resolve\}/);
  assert.match(chatWindow, /onEmbeddedReady\?\.\(\)/);
  assert.match(input, /workflowMetadataRef/);
  assert.match(
    input,
    /replaceText\(text:\s*string,\s*workflowMetadata\?:\s*PiWorkflowPromptMetadata\)/,
    "the Pi-web composer must expose an explicit generated-prompt replacement path"
  );
  assert.match(hook, /languagePair:\s*workflowMetadata\?\.languagePair \?\? route\.languagePair/);
  assert.match(hook, /subagentModelId:\s*workflowMetadata\?\.subagentModelId/);
  assert.match(hook, /subagentCount:\s*workflowMetadata\?\.subagentCount/);
  assert.match(hook, /reviewSubagentCount:\s*workflowMetadata\?\.reviewSubagentCount/);
  assert.match(hook, /translationSplitSize:\s*workflowMetadata\?\.translationSplitSize/);
  assert.match(hook, /folderTranslationOrder:\s*workflowMetadata\?\.folderTranslationOrder/);
  assert.match(hook, /folderSourceDocuments:\s*workflowMetadata\?\.folderSourceDocuments/);
  assert.match(hook, /glossaryPath:\s*workflowMetadata\?\.glossaryPath/);
  assert.match(hook, /glossaryCandidates:\s*workflowMetadata\?\.glossaryCandidates/);
  assert.match(hook, /characterBible:\s*workflowMetadata\?\.characterBible/);
  assert.match(hook, /reuseExistingTranslation:\s*workflowMetadata\?\.reuseExistingTranslation/);
  assert.match(hook, /auditWhitelistLines:\s*workflowMetadata\?\.auditWhitelistLines/);
  assert.match(hook, /customPreserveRules:\s*workflowMetadata\?\.customPreserveRules/);
  assert.match(handlers, /service\.prompt\(parsePiSessionPromptRequest\(raw\)\)/);
  assert.match(requestParser, /workflowIntent:\s*workflowIntent\(raw\?\.workflowIntent\),[\s\S]*languagePair:\s*optionalText\(raw\?\.languagePair\)[\s\S]*subagentProviderId/);
  assert.match(requestParser, /must be provided together/);
  const domainTools = await source("src/main/agent/piNative/ynDomainTools.ts");
  const findingsWriter = await source("src/main/agent/writeProofreadFindings.ts");
  assert.match(domainTools, /excludedLines:\s*request\.auditWhitelistLines/);
  assert.match(findingsWriter, /excludedLines\?:\s*number\[\]/);
  assert.match(domainTools, /task model override requires a providerId/);
  assert.match(domainTools, /provider-only task means that Pi should use that provider's configured/);
  assert.match(service, /assertWorkflowPromptMetadata\(request\);/);
});

await test("workflow UI exposes only native subagent enable/count controls", async () => {
  const productUi = await Promise.all([
    source("src/renderer/App.tsx"),
    source("src/renderer/global.d.ts"),
    source("src/shared/core/html.ts"),
    source("src/shared/core/prompts.ts")
  ]);
  assert.equal(productUi.some((text) => text.includes("subagentEnabled")), true, "product UI does not expose the typed enable flag");
  assert.equal(productUi.some((text) => text.includes("subagentCount")), true, "product UI does not expose the typed child count");
  assert.equal(productUi.some((text) => text.includes("reviewSubagentCount")), true, "product UI does not expose the typed review count");
  for (const forbidden of ["subagentParallel", "subagentConcurrency"]) {
    assert.equal(productUi.some((text) => text.includes(forbidden)), false, `product UI still exposes ${forbidden}`);
  }
  assert.equal(productUi.some((text) => /subagentMode\b/.test(text)), false, "product UI still exposes a subagent mode selector");
});

await test("full translation workflow has no serial parent chunk-review bridge", async () => {
  const supervisor = await source("src/main/agent/piNative/subagentSupervisor.ts");
  const tools = await source("src/main/agent/piNative/ynDomainTools.ts");
  const service = await source("src/main/agent/piNative/sessionService.ts");
  for (const legacy of [
    "requestParentTranslationChunkReview",
    "resolveParentTranslationChunkReview",
    "pendingParentNotificationReminder"
  ]) {
    assert.equal(supervisor.includes(legacy), false, `legacy parent review bridge remains: ${legacy}`);
    assert.equal(tools.includes(legacy), false, `domain tools still call legacy parent review bridge: ${legacy}`);
    assert.equal(service.includes(legacy), false, `session service still calls legacy parent review bridge: ${legacy}`);
  }
  assert.match(supervisor, /createPiTranslationReviewSubagentWorker/);
  assert.match(tools, /prepareChunkReview:\s*prepareTranslationChunkReview/);
});

await test("legacy Pi imitation runtime is outside the compiled product graph", async () => {
  const main = await source("src/main/main.ts");
  const productHandlers = await source("src/main/ipc/agentSessionHandlers.ts");
  assert.ok(main.includes("registerAgentSessionIpc"));
  assert.equal(productHandlers.includes("../agent/piRuntime/"), false);
  assert.equal(main.includes("registerAgentRuntimeIpc"), false);
});

await test("legacy PTY and CLI Agent Console are absent from every product entry surface", async () => {
  const productSources = await Promise.all([
    source("src/main/main.ts"),
    source("src/main/preload.ts"),
    source("src/renderer/App.tsx"),
    source("src/renderer/global.d.ts"),
    source("src/shared/core/html.ts")
  ]);
  const pkg = await source("package.json");
  const joined = `${productSources.join("\n")}\n${pkg}`;
  for (const forbidden of [
    "agent-console:",
    "startInteractiveAgentConsole",
    "interactiveAgentSession",
    "node-pty",
    "@xterm/",
    "prepare:xterm-assets",
    "skills:installCommand",
    "skills:status"
  ]) {
    assert.equal(joined.includes(forbidden), false, `product still contains legacy console token ${forbidden}`);
  }
});

await test("product contracts expose no external Agent mode or CLI provider type", async () => {
  const providerTypes = await source("src/shared/agent/providerConfigTypes.ts");
  const prompts = await source("src/shared/core/prompts.ts");
  const html = await source("src/shared/core/html.ts");
  const providerStore = await source("src/main/agent/providerConfigStore.ts");
  for (const forbidden of ["CliProviderConfig", 'type: "cli"', 'agent: "codex"', 'agent: "claude"']) {
    assert.equal(providerTypes.includes(forbidden), false, `provider contract still exposes ${forbidden}`);
  }
  for (const forbidden of ["AgentType", "skillPaths", "getAgentSetupText", "defaultAgent"]) {
    assert.equal(`${prompts}\n${html}`.includes(forbidden), false, `prompt/HTML contract still exposes ${forbidden}`);
  }
  assert.match(providerStore, /if \(providerType === "cli"\) \{\s+return undefined;/);
});

await test("generated HTML payload contains no dead legacy Agent runtime labels", async () => {
  const html = await source("src/shared/core/html.ts");
  for (const forbidden of [
    "agentChatCliHint",
    "agentChatJobs",
    "agentChatNoJobs",
    "agentChatJobStarted",
    "agentChatApprovalRequired",
    "agentChatApprovalQuestion",
    "agentChatApprovalMissing",
    "agentChatQueuedDone",
    "agentChatStopJob",
    "agentChatInterruptSent",
    "agentChatNoActiveJob"
  ]) {
    assert.equal(html.includes(forbidden), false, `generated HTML still embeds dead legacy label ${forbidden}`);
  }
  for (const current of ["openAgentChat", "agentChatPopout", "agentChatSettings", "agentChatLoading"]) {
    assert.ok(html.includes(current), `generated HTML lost current Agent entry label ${current}`);
  }
});

await test("renderer locale bundles contain no dead legacy Agent runtime namespace", async () => {
  for (const localePath of ["src/shared/i18n/en-US.json", "src/shared/i18n/zh-CN.json"]) {
    const locale = JSON.parse(await source(localePath));
    const legacyKeys = Object.keys(locale).filter((key) => key.startsWith("agentChat"));
    assert.deepEqual(legacyKeys, [], `${localePath} still ships legacy Agent labels: ${legacyKeys.join(", ")}`);
  }
});

await test("legacy runtime files are deleted and unreachable from every Electron product entry graph", async () => {
  const graph = await productModuleGraph([
    "src/main/main.ts",
    "src/main/preload.ts",
    "src/renderer/App.tsx",
    "src/renderer/agent/embedded.tsx"
  ]);
  const forbiddenFragments = [
    `${path.sep}agent${path.sep}piRuntime${path.sep}`,
    `${path.sep}agent${path.sep}runProviderJob.ts`,
    `${path.sep}agent${path.sep}conversationStore.ts`,
    `${path.sep}agent${path.sep}agentEventBroadcast.ts`,
    `${path.sep}agent${path.sep}hostTools.ts`,
    `${path.sep}ipc${path.sep}agentRuntimeHandlers.ts`
  ];
  for (const file of graph) {
    for (const fragment of forbiddenFragments) {
      assert.equal(file.includes(fragment), false, `product graph still reaches ${file}`);
    }
  }
  for (const file of [
    "src/main/agent/runProviderJob.ts",
    "src/main/agent/conversationStore.ts",
    "src/main/agent/agentEventBroadcast.ts",
    "src/main/agent/hostTools.ts",
    "src/main/ipc/agentRuntimeHandlers.ts",
    "src/main/agent/piRuntime/runPiAgentLoop.ts",
    "src/main/agent/concurrencyPool.ts",
    "src/main/agent/projectCommandTool.ts",
    "src/shared/core/skillInstall.ts"
  ]) {
    await assert.rejects(() => access(path.resolve(file)), /ENOENT/);
  }
});

console.log("");
console.log(`# tests ${passed + failed}`);
console.log(`# pass ${passed}`);
console.log(`# fail ${failed}`);
if (failed > 0) process.exitCode = 1;
