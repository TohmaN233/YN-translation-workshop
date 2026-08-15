import { app, BrowserWindow, nativeImage, webContents as electronWebContents, type BrowserView } from "electron";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderBatchLineReviewIndexHtml, renderLineReviewHtml } from "../src/shared/core/html.ts";

const root = process.cwd();
const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-electron-proposal-review-"));
const workspaceDir = path.join(outputDir, ".translation-workshop");
const htmlDir = path.join(workspaceDir, "html");
const reportDir = path.join(outputDir, "report");
const sourcePath = path.join(outputDir, "source.txt");
const translationPath = path.join(outputDir, "translation.txt");
const lineReviewPath = path.join(htmlDir, "line-review-fixture.html");
const lineReviewStatePath = path.join(workspaceDir, "state", `line-${path.basename(lineReviewPath)}.json`);
const reportPath = path.join(reportDir, "source.proofread.json");
const screenshotPath = path.join(root, "artifacts", "electron-proposal-review-auto-open.png");
const aggregateScreenshotPath = path.join(root, "artifacts", "electron-folder-proofread-aggregate.png");
const folderBatchScreenshotPath = path.join(root, "artifacts", "electron-folder-batch-index.png");
const folderSourceDir = path.join(outputDir, "folder-source");
const folderTranslationDir = path.join(outputDir, "AI_translation", "folder-source");
const folderSourceA = path.join(folderSourceDir, "chapter-a.txt");
const folderSourceB = path.join(folderSourceDir, "nested", "chapter-b.txt");
const folderSourceC = path.join(folderSourceDir, "untouched", "chapter-c.txt");
const folderSourceD = path.join(folderSourceDir, "no-findings", "chapter-d.txt");
const folderTranslationA = path.join(folderTranslationDir, "chapter-a_translated.txt");
const folderTranslationB = path.join(folderTranslationDir, "nested", "chapter-b_translated.txt");
const folderTranslationC = path.join(folderTranslationDir, "untouched", "chapter-c_translated.txt");
const folderTranslationD = path.join(outputDir, "AI_translation", "no-findings", "chapter-d_translated.txt");
const folderBatchDir = path.join(htmlDir, "folder-batch");
const folderLineA = path.join(folderBatchDir, "chapter-a.html");
const folderLineB = path.join(folderBatchDir, "chapter-b.html");
const folderLineC = path.join(folderBatchDir, "chapter-c.html");
const folderLineD = path.join(folderBatchDir, "chapter-d.html");
const folderLineCState = path.join(workspaceDir, "state", `line-${path.basename(folderLineC)}.json`);
const legacyFolderLineCDigest = createHash("sha256")
  .update(`${folderSourceC}\0${folderTranslationC}`)
  .digest("hex")
  .slice(0, 16);
const legacyFolderLineC = path.join(htmlDir, "proposal-line-review", `${legacyFolderLineCDigest}-chapter-c.txt.html`);
const legacyFolderLineCState = path.join(workspaceDir, "state", `line-${path.basename(legacyFolderLineC)}.json`);
const olderLegacyFolderLineC = path.join(htmlDir, "proposal-line-review", "older-duplicate-chapter-c.txt.html");
const olderLegacyFolderLineCState = path.join(workspaceDir, "state", `line-${path.basename(olderLegacyFolderLineC)}.json`);
const folderBatchIndex = path.join(htmlDir, "folder-batch.html");
const folderReportPath = path.join(reportDir, "folder.proofread.json");
const missingTranslationReportPath = path.join(reportDir, "folder-missing-translation.proofread.json");
const wrongTranslationReportPath = path.join(reportDir, "folder-wrong-translation.proofread.json");
const duplicateDocumentReportPath = path.join(reportDir, "folder-duplicate-document.proofread.json");
const malformedDuplicateDocumentReportPath = path.join(reportDir, "folder-malformed-duplicate-document.proofread.json");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

function visibleView(viewerWindow: BrowserWindow): BrowserView | undefined {
  return viewerWindow.getBrowserViews().find((view) => {
    const bounds = view.getBounds();
    return bounds.width > 0 && bounds.height > 0;
  });
}

async function activeView(viewerWindow: BrowserWindow): Promise<BrowserView> {
  return waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed()),
    "the active HTML BrowserView"
  ) as Promise<BrowserView>;
}

await Promise.all([
  mkdir(htmlDir, { recursive: true }),
  mkdir(reportDir, { recursive: true }),
  mkdir(path.dirname(folderSourceB), { recursive: true }),
  mkdir(path.dirname(folderSourceC), { recursive: true }),
  mkdir(path.dirname(folderSourceD), { recursive: true }),
  mkdir(path.dirname(folderTranslationB), { recursive: true }),
  mkdir(path.dirname(folderTranslationC), { recursive: true }),
  mkdir(path.dirname(folderTranslationD), { recursive: true }),
  mkdir(folderBatchDir, { recursive: true }),
  mkdir(path.dirname(legacyFolderLineC), { recursive: true }),
  mkdir(path.dirname(legacyFolderLineCState), { recursive: true }),
  mkdir(path.dirname(screenshotPath), { recursive: true })
]);
await Promise.all([
  writeFile(sourcePath, "原文一\n原文二\n原文三。下一句。", "utf8"),
  writeFile(translationPath, "旧译一\n旧译二\n旧译三", "utf8"),
  writeFile(folderSourceA, "source a one\nsource a two", "utf8"),
  writeFile(folderSourceB, "source b one\nsource b two", "utf8"),
  writeFile(folderSourceC, "source c one\nsource c two", "utf8"),
  writeFile(folderSourceD, "source d one\nsource d two", "utf8"),
  writeFile(folderTranslationA, "旧译甲一\n旧译甲二", "utf8"),
  writeFile(folderTranslationB, "旧译乙一\n旧译乙二", "utf8"),
  writeFile(folderTranslationC, "旧译丙一\n旧译丙二", "utf8"),
  writeFile(folderTranslationD, "旧译丁一\n旧译丁二", "utf8")
]);
await writeFile(lineReviewPath, renderLineReviewHtml({
  title: "proposal auto-open fixture",
  sourceText: "原文一\n原文二\n原文三。下一句。",
  translationText: "旧译一\n旧译二\n旧译三",
  lineReviewPath,
  workflow: {
    sourcePath,
    validationSourcePath: sourcePath,
    translationPath,
    outputDir
  }
}), "utf8");
await writeFile(reportPath, JSON.stringify({
  schemaVersion: "1.0",
  documentId: "source",
  sourcePath,
  translationPath,
  generatedAt: new Date().toISOString(),
  mode: "split",
  findings: [{
    id: "H3-001",
    severity: "H3",
    type: "terminology",
    sourceLine: 1,
    translationLine: 1,
    sourceText: "原文一",
    currentTranslation: "旧译一",
    suggestedFix: "新译一",
    rationale: "fixture"
  }, {
    id: "M1-001",
    severity: "M1",
    type: "fluency",
    sourceLine: 2,
    translationLine: 2,
    sourceText: "原文二",
    currentTranslation: "旧译二",
    suggestedFix: "新译二",
    rationale: "fixture"
  }, {
    id: "M0-003",
    severity: "M0",
    type: "mechanical_scan",
    sourceLine: 3,
    translationLine: 3,
    sourceText: "原文三。下一句。",
    currentTranslation: "旧译三",
    suggestedFix: "旧译三",
    rationale: "句子边界数量异常，可能存在缺失。",
    needsVerification: true
  }]
}, null, 2), "utf8");
await Promise.all([
  [folderLineA, folderSourceA, "source a one\nsource a two", "chapter-a.txt"],
  [folderLineB, folderSourceB, "source b one\nsource b two", "nested/chapter-b.txt"],
  [folderLineC, folderSourceC, "source c one\nsource c two", "untouched/chapter-c.txt"],
  [folderLineD, folderSourceD, "source d one\nsource d two", "no-findings/chapter-d.txt"]
].map(([lineReviewPath, source, sourceText, documentId]) => writeFile(lineReviewPath, renderLineReviewHtml({
  title: `${documentId} line review`,
  sourceText,
  lineReviewPath,
  workflow: {
    sourcePath: source,
    validationSourcePath: source,
    sourcePromptPath: folderSourceDir,
    promptSourceKind: "folder",
    outputDir,
    inputMode: "separate"
  }
}), "utf8")));
await Promise.all([
  writeFile(folderLineCState, JSON.stringify({
    edits: { 1: "旧译丙一", 2: "旧译丙二" },
    status: { 1: "machine", 2: "machine" },
    documentRevision: 7,
    translationPath: folderTranslationC
  }, null, 2), "utf8"),
  writeFile(legacyFolderLineC, renderLineReviewHtml({
    title: "legacy duplicate chapter-c line review",
    sourceText: "source c one\nsource c two",
    translationText: "旧译丙一\n旧译丙二",
    lineReviewPath: legacyFolderLineC,
    workflow: {
      sourcePath: folderSourceC,
      validationSourcePath: folderSourceC,
      translationPath: folderTranslationC,
      editableTranslationPath: folderTranslationC,
      outputDir,
      inputMode: "separate"
    }
  }), "utf8"),
  writeFile(legacyFolderLineCState, JSON.stringify({
    edits: { 1: "新译丙一" },
    status: { 1: "manual" },
    revisions: { 1: 1 },
    revisionHistory: { 1: [{ revision: 1, text: "新译丙一", status: "manual", source: "proposal-apply" }] },
    documentRevision: 1,
    translationPath: folderTranslationC
  }, null, 2), "utf8"),
  writeFile(olderLegacyFolderLineC, renderLineReviewHtml({
    title: "older duplicate chapter-c line review",
    sourceText: "source c one\nsource c two",
    translationText: "旧译丙一\n旧译丙二",
    lineReviewPath: olderLegacyFolderLineC,
    workflow: {
      sourcePath: folderSourceC,
      validationSourcePath: folderSourceC,
      translationPath: folderTranslationC,
      editableTranslationPath: folderTranslationC,
      outputDir,
      inputMode: "separate"
    }
  }), "utf8"),
  writeFile(olderLegacyFolderLineCState, JSON.stringify({
    edits: { 1: "过时译丙一" },
    status: { 1: "manual" },
    revisions: { 1: 1 },
    documentRevision: 1,
    translationPath: folderTranslationC
  }, null, 2), "utf8")
]);
await Promise.all([
  utimes(olderLegacyFolderLineC, new Date(946684800000), new Date(946684800000)),
  utimes(olderLegacyFolderLineCState, new Date(946684800000), new Date(946684800000))
]);
await writeFile(folderBatchIndex, renderBatchLineReviewIndexHtml({
  title: "folder proofread aggregate fixture",
  files: [
    ["chapter-a.txt", folderSourceA, "folder-batch/chapter-a.html"],
    ["nested/chapter-b.txt", folderSourceB, "folder-batch/chapter-b.html"],
    ["untouched/chapter-c.txt", folderSourceC, "folder-batch/chapter-c.html"],
    ["no-findings/chapter-d.txt", folderSourceD, "folder-batch/chapter-d.html"]
  ].map(([sourceName, source, outputPath]) => ({
    sourceName,
    sourcePath: source,
    sourceLineCount: 2,
    status: "missing-translation" as const,
    outputPath
  })),
  workflow: {
    sourcePath: folderSourceDir,
    sourceKind: "folder",
    translationPath: folderTranslationDir,
    outputDir,
    inputMode: "separate"
  }
}), "utf8");
const folderReportDocument = {
  schemaVersion: "2.0",
  scope: { kind: "folder", sourcePath: folderSourceDir },
  generatedAt: new Date().toISOString(),
  mode: "split",
  findings: [{
    documentId: "chapter-a.txt",
    sourcePath: folderSourceA,
    translationPath: folderTranslationA,
    id: "H1-101",
    severity: "H1",
    type: "accuracy",
    sourceLine: 1,
    translationLine: 1,
    sourceText: "source a one",
    currentTranslation: "旧译甲一",
    suggestedFix: "新译甲一",
    rationale: "folder fixture a"
  }, {
    documentId: "nested/chapter-b.txt",
    sourcePath: folderSourceB,
    translationPath: folderTranslationB,
    id: "H1-102",
    severity: "H1",
    type: "accuracy",
    sourceLine: 2,
    translationLine: 2,
    sourceText: "source b two",
    currentTranslation: "旧译乙二",
    suggestedFix: "新译乙二",
    rationale: "folder fixture b"
  }, {
    documentId: "untouched/chapter-c.txt",
    sourcePath: folderSourceC,
    translationPath: folderTranslationC,
    id: "H1-103",
    severity: "H1",
    type: "accuracy",
    sourceLine: 1,
    translationLine: 1,
    sourceText: "source c one",
    currentTranslation: "旧译丙一",
    suggestedFix: "新译丙一",
    rationale: "folder fixture c"
  }]
};
const missingTranslationReportDocument = JSON.parse(JSON.stringify(folderReportDocument));
delete missingTranslationReportDocument.findings[0].translationPath;
const wrongTranslationReportDocument = JSON.parse(JSON.stringify(folderReportDocument));
wrongTranslationReportDocument.findings[0].translationPath = folderTranslationB;
const duplicateDocumentReportDocument = JSON.parse(JSON.stringify(folderReportDocument));
duplicateDocumentReportDocument.findings[2].documentId = "chapter-a.txt";
const malformedDuplicateDocumentReportDocument = JSON.parse(JSON.stringify(folderReportDocument));
malformedDuplicateDocumentReportDocument.findings[2].documentId = "chapter-a.txt";
delete malformedDuplicateDocumentReportDocument.findings[2].suggestedFix;

app.setAppPath(root);
app.disableHardwareAcceleration();
await import("../src/main/main.ts");

async function run(): Promise<void> {
  const mainWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("renderer/index.html")),
    Boolean,
    "the product renderer"
  );
  assert(mainWindow, "Product renderer was not created");
  await waitFor(
    () => mainWindow.webContents.executeJavaScript('typeof window.workshop?.openReviewHtml === "function"').catch(() => false),
    Boolean,
    "the preload review bridge"
  );
  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: lineReviewPath, outputDir })})`
  );
  const viewerWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate !== mainWindow && candidate.webContents.getURL().startsWith("data:text/html")),
    Boolean,
    "the HTML tab viewer"
  );
  assert(viewerWindow, "HTML tab viewer was not created");
  const lineView = await activeView(viewerWindow);
  await waitFor(
    () => lineView.webContents.executeJavaScript('Boolean(document.querySelector("#generateReviewHtml"))').catch(() => false),
    Boolean,
    "the generate review action"
  );
  await lineView.webContents.executeJavaScript(`syncLines(["旧译一", "旧译二", "旧译三"], ${JSON.stringify(translationPath)})`);
  const syncedFixture = await lineView.webContents.executeJavaScript('data.rows.map((row) => rowValue(row))');
  assert(JSON.stringify(syncedFixture) === JSON.stringify(["旧译一", "旧译二", "旧译三"]), "Line review did not expose synced translations through rowValue");
  await lineView.webContents.executeJavaScript(`(async () => {
    state.auditIssues[3] = [
      { code: "M0", severity: "M0", message: "句子边界数量异常", source: "host-mechanical-scan", proposalId: "M0-003" },
      { code: "H3", severity: "H3", message: "术语仍需确认", source: "semantic-fixture", proposalId: "H3-other" }
    ];
    state.auditVisible = true;
    render();
    await save([3], ["auditIssues", "auditVisible"]);
  })()`);
  await lineView.webContents.executeJavaScript('document.querySelector(\'.row[data-line="3"] .audit-marker\').click()');
  await waitFor(
    () => lineView.webContents.executeJavaScript(`Boolean(state.auditWhitelist?.[3]) && state.auditIssues?.[3]?.length === 1 && state.auditIssues[3][0].code === "H3"`).catch(() => false),
    Boolean,
    "the homepage audit marker false-positive transaction"
  );
  await waitFor(
    async () => {
      try {
        return JSON.parse(await readFile(lineReviewStatePath, "utf8"));
      } catch {
        return null;
      }
    },
    (state) => Boolean(state?.auditWhitelist?.[3])
      && state?.auditIssues?.[3]?.length === 1
      && state.auditIssues[3][0].code === "H3",
    "the durable homepage audit marker transaction"
  );
  await lineView.webContents.reload();
  await waitFor(
    () => lineView.webContents.executeJavaScript(`Boolean(state.auditWhitelist?.[3]) && state.auditIssues?.[3]?.length === 1 && state.auditIssues[3][0].code === "H3"`).catch(() => false),
    Boolean,
    "the homepage audit marker state after a cold reload"
  );
  console.log("[proposal-review] homepage-mechanical-false-positive-atomic");
  await lineView.webContents.executeJavaScript(`(async () => {
    await toggleAuditWhitelistLine(3);
    state.auditIssues[3] = [
      { code: "M0", severity: "M0", message: "句子边界数量异常", source: "host-mechanical-scan", proposalId: "M0-003" },
      { code: "H3", severity: "H3", message: "术语仍需确认", source: "semantic-fixture", proposalId: "H3-other" }
    ];
    applyingCanonicalState = true;
    try { render(); } finally { applyingCanonicalState = false; }
    await save([3], ["auditIssues"]);
  })()`);
  const consoleErrors: string[] = [];
  lineView.webContents.on("console-message", (details) => {
    if (details.level === "warning" || details.level === "error") consoleErrors.push(details.message);
  });
  await lineView.webContents.executeJavaScript('document.querySelector("#generateReviewHtml").click()');

  await waitFor(
    () => viewerWindow.webContents.executeJavaScript('document.querySelectorAll("#tabs button[data-key]").length').catch(() => 0),
    (count) => count === 2,
    "the automatically opened proposal tab"
  );
  const proposalView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => {
      if (!view || view.webContents.isDestroyed()) return false;
      const url = view.webContents.getURL();
      return url.startsWith("file:") && path.basename(fileURLToPath(url)).startsWith("proposal-review-");
    },
    "the active proposal review"
  );
  assert(proposalView, "Generated proposal review did not become active");
  const proposalPath = fileURLToPath(proposalView.webContents.getURL());
  const initialState = await proposalView.webContents.executeJavaScript(`({
    readyState: document.readyState,
    cards: document.querySelectorAll("#cards .card").length,
    issueOptions: document.querySelectorAll("#issueFilter option").length,
    hasApply: Boolean(document.querySelector("#applyProposalChanges")),
    bodyText: document.body.innerText
  })`);
  assert(initialState.readyState === "complete", "Proposal review did not finish loading");
  assert(initialState.cards === 3, `Proposal review did not render every semantic and mechanical finding card: ${JSON.stringify(initialState)}`);
  assert(initialState.issueOptions >= 5, "Proposal review filter did not initialize all/severity/exact options");
  assert(initialState.hasApply, "Proposal review actions did not initialize");

  await proposalView.webContents.executeJavaScript(`(() => {
    document.querySelector("#lanSyncPin").value = "123456";
    document.querySelector("#startLanSync").click();
  })()`);
  const proposalLanUrl = await waitFor(
    () => proposalView.webContents.executeJavaScript(`[...document.querySelectorAll("#lanSyncLinks a")].map(a => a.href).find(href => href.includes("127.0.0.1")) || ""`),
    (value) => typeof value === "string" && value.includes("127.0.0.1"),
    "the proposal LAN workspace URL"
  );
  const proposalSessionUrl = new URL(proposalLanUrl);
  const proposalToken = decodeURIComponent(proposalSessionUrl.pathname.split("/").filter(Boolean).at(-1) || "");
  const proposalAuthResponse = await fetch(`${proposalSessionUrl.origin}/api/auth/${encodeURIComponent(proposalToken)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "123456" })
  });
  assert(proposalAuthResponse.ok, `Proposal LAN authentication failed: ${proposalAuthResponse.status}`);
  const proposalAuth = await proposalAuthResponse.json() as { authToken?: string };
  assert(proposalAuth.authToken, "Proposal LAN authentication token was missing");
  const proposalPatchResponse = await fetch(`${proposalSessionUrl.origin}/api/patch/${encodeURIComponent(proposalToken)}?auth=${encodeURIComponent(proposalAuth.authToken)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "proposal-decision",
      proposalId: "H3-001",
      status: "accepted",
      manualText: "",
      clientId: "proposal-verifier"
    })
  });
  assert(proposalPatchResponse.ok, `Remote proposal decision failed: ${proposalPatchResponse.status} ${await proposalPatchResponse.text()}`);
  const proposalSidecarPath = path.join(workspaceDir, "state", `proposal-${path.basename(proposalPath)}.json`);
  const persistedProposalDecision = await waitFor(
    async () => JSON.parse(await readFile(proposalSidecarPath, "utf8")),
    (value) => value?.decisions?.["H3-001"]?.status === "accepted",
    "the durable remote proposal decision"
  );
  assert(persistedProposalDecision.decisions["H3-001"].manualText === "", "Remote proposal manual text was not persisted");
  console.log("[proposal-review] lan-proposal-decision-durable-before-200");
  await proposalView.webContents.executeJavaScript(`(() => {
    const search = document.querySelector("#search");
    search.value = "no-such-finding";
    search.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  const filteredState = await proposalView.webContents.executeJavaScript(`({
    cards: document.querySelectorAll("#cards .card").length,
    text: document.querySelector("#cards")?.innerText || ""
  })`);
  assert(filteredState.cards === 0 && filteredState.text.length > 0, "Opened proposal HTML did not respond to user input");
  await proposalView.webContents.executeJavaScript(`(() => {
    const search = document.querySelector("#search");
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await waitFor(
    () => proposalView.webContents.executeJavaScript('document.querySelectorAll("#cards .card").length').catch(() => 0),
    (count) => count === 3,
    "all proposal cards after clearing the search"
  );

  await proposalView.webContents.executeJavaScript(`(() => {
    const filter = document.querySelector("#issueFilter");
    filter.value = "H3";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(
    () => proposalView.webContents.executeJavaScript('document.querySelectorAll("#cards .card").length').catch(() => 0),
    (count) => count === 1,
    "the H3-only proposal category"
  );
  await proposalView.webContents.executeJavaScript(`(() => {
    const filter = document.querySelector("#issueFilter");
    filter.value = "";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(
    () => proposalView.webContents.executeJavaScript('document.querySelectorAll("#cards .card").length').catch(() => 0),
    (count) => count === 3,
    "all proposal categories after clearing the category filter"
  );
  console.log("[proposal-review] category-filter-reset");

  const mechanicalState = await proposalView.webContents.executeJavaScript(`({
    cards: document.querySelectorAll(".mechanical-scan-card").length,
    hasConfirm: Boolean(document.querySelector('.mechanical-scan-card [data-mechanical-action="confirm"]')),
    hasFalsePositive: Boolean(document.querySelector('.mechanical-scan-card [data-mechanical-action="false-positive"]')),
    hasSuggestion: Boolean(document.querySelector(".mechanical-scan-card textarea, .mechanical-scan-card .suggestion"))
  })`);
  assert(mechanicalState.cards === 1, "Proposal review did not isolate the mechanical scan item");
  assert(mechanicalState.hasConfirm && mechanicalState.hasFalsePositive, "Mechanical scan item did not expose both verification decisions");
  assert(!mechanicalState.hasSuggestion, "Mechanical scan item incorrectly exposed a translation replacement control");
  await proposalView.webContents.executeJavaScript('document.querySelector(\'.mechanical-scan-card [data-mechanical-action="false-positive"]\').click()');
  await waitFor(
    () => proposalView.webContents.executeJavaScript('state.decisions["M0-003"]?.status || ""').catch(() => ""),
    (status) => status === "rejected",
    "the mechanical false-positive decision"
  );
  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: lineReviewPath, outputDir })})`
  );
  const whitelistedLineView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && view.webContents.getURL().includes("line-review-fixture.html")),
    "the line review after dismissing the mechanical false positive"
  );
  assert(whitelistedLineView, "Mechanical false-positive decision did not return to a readable line review");
  const whitelistSnapshot = await whitelistedLineView.webContents.executeJavaScript(`({
    whitelisted: Boolean(state.auditWhitelist?.[3]),
    issueCount: Array.isArray(state.auditIssues?.[3]) ? state.auditIssues[3].length : 0,
    markerText: document.querySelector('.row[data-line="3"] .audit-marker')?.textContent || ""
  })`);
  assert(whitelistSnapshot.whitelisted, "Mechanical false positive did not enter the canonical audit whitelist");
  assert(whitelistSnapshot.issueCount === 1, "Mechanical false positive removed an unrelated semantic issue");
  assert(whitelistSnapshot.markerText === "✓", "Homepage did not replace the dismissed mechanical warning with its whitelist state");
  const whitelistFile = JSON.parse(await readFile(path.join(workspaceDir, "audit-whitelist.json"), "utf8"));
  const whitelistDocument = Object.values(whitelistFile.documents || {})[0] as { lines?: number[] } | undefined;
  assert(
    whitelistFile.version === 2 && JSON.stringify(whitelistDocument?.lines) === "[3]",
    `Mechanical false positive was not persisted to the project audit whitelist: ${JSON.stringify(whitelistFile)}`
  );
  await whitelistedLineView.webContents.reload();
  await waitFor(
    () => whitelistedLineView.webContents.executeJavaScript(`Boolean(state.auditWhitelist?.[3]) && (state.auditIssues?.[3]?.[0]?.code || "") === "H3"`).catch(() => false),
    Boolean,
    "the mechanical false-positive decision after a cold line-view reload"
  );
  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: fileURLToPath(proposalView.webContents.getURL()), outputDir })})`
  );
  await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && view.webContents.getURL().includes("proposal-review-")),
    "the proposal review after mechanical verification"
  );

  await proposalView.webContents.executeJavaScript(`(() => {
    state.decisions["H3-001"] = {
      status: "conflict",
      manualText: "",
      conflictReason: "patch-conflict",
      conflictCurrentText: "",
      conflictCurrentRevision: 0,
      conflictRevisionHistory: []
    };
    save();
    render();
  })()`);
  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: fileURLToPath(proposalView.webContents.getURL()), outputDir })})`
  );
  await waitFor(
    () => proposalView.webContents.executeJavaScript('document.querySelectorAll(".card.conflict").length').catch(() => -1),
    (count) => count === 0,
    "stale synced-translation conflict reconciliation"
  );

  await proposalView.webContents.executeJavaScript(`(() => {
    state.decisions["H3-001"] = { status: "accepted", manualText: "" };
    state.decisions["M1-001"] = { status: "accepted", manualText: "" };
    save();
    render();
    document.querySelector("#applyProposalChanges").click();
  })()`);
  await waitFor(
    () => proposalView.webContents.executeJavaScript('document.querySelector("#proposalStatus")?.textContent || ""').catch(() => ""),
    (value) => typeof value === "string" && value.includes("2"),
    "the proposal apply completion status"
  );
  assert(visibleView(viewerWindow)?.webContents.id === proposalView.webContents.id, "Proposal apply unexpectedly opened a line-review tab");
  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: lineReviewPath, outputDir })})`
  );
  const appliedLineView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && view.webContents.getURL().includes("line-review-fixture.html")),
    "the explicitly reopened line review after applying proposals"
  );
  assert(appliedLineView, "Applying proposals did not return to the linked line review");
  const proposalApplySnapshot = await proposalView.webContents.executeJavaScript(`({
    decisions: JSON.parse(JSON.stringify(state.decisions || {})),
    statusText: document.querySelector("#proposalStatus")?.textContent || ""
  })`);
  const appliedSnapshot = await appliedLineView.webContents.executeJavaScript(`({
    rows: data.rows.map((row) => rowValue(row)),
    edits: JSON.parse(JSON.stringify(state.edits || {})),
    status: JSON.parse(JSON.stringify(state.status || {})),
    storageKey: typeof lineReviewStorageKey === "function" ? lineReviewStorageKey() : "",
    stored: JSON.parse(localStorage.getItem(typeof lineReviewStorageKey === "function" ? lineReviewStorageKey() : "") || "{}")
  })`);
  const appliedRows = appliedSnapshot.rows;
  assert(
    JSON.stringify(appliedRows) === JSON.stringify(["新译一", "新译二", "旧译三"]),
    `Proposal apply did not update the synced line-review translations: ${JSON.stringify({ appliedSnapshot, proposalApplySnapshot })}`
  );

  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: proposalPath, outputDir })})`
  );
  const reopenedProposalView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && view.webContents.getURL().includes(path.basename(proposalPath))),
    "the reopened proposal review"
  );
  assert(reopenedProposalView, "Proposal review did not reopen");
  const reopenedConflictCount = await reopenedProposalView.webContents.executeJavaScript('document.querySelectorAll(".card.conflict").length');
  assert(reopenedConflictCount === 0, "Reopening produced a false patch-conflict after applying synced translations");

  assert(visibleView(viewerWindow)?.webContents.id === reopenedProposalView.webContents.id, "Reopened proposal review was not the active HTML tab");
  if (process.env.YN_ELECTRON_VERIFY_HEADLESS !== "1") {
    viewerWindow.show();
    viewerWindow.focus();
  }
  const screenshotPng = (await reopenedProposalView.webContents.capturePage()).toPNG();
  assert(!nativeImage.createFromBuffer(screenshotPng).isEmpty(), "Proposal review screenshot was empty");
  await writeFile(screenshotPath, screenshotPng);

  const concurrentProposalState = await reopenedProposalView.webContents.executeJavaScript(`(async () => {
    const item = data.proposals[0];
    const document = await resolveProposalLineReviewDocument(item);
    const base = {
      reportPath: data.reportPath,
      documentId: document.documentId,
      sourcePath: document.sourcePath,
      translationPath: document.translationPath,
      lineReviewPath: document.lineReviewPath,
      changedStateKeys: []
    };
    await Promise.all([
      htmlBridge().applyProposalLineReviewStates({ documents: [{
        ...base,
        lineState: { edits: { 1: "并发更新一" } },
        changedLines: [1],
        expectedLineRevisions: { 1: Number(document.state?.revisions?.[1] || 0) }
      }] }),
      htmlBridge().applyProposalLineReviewStates({ documents: [{
        ...base,
        lineState: { edits: { 2: "并发更新二" } },
        changedLines: [2],
        expectedLineRevisions: { 2: Number(document.state?.revisions?.[2] || 0) }
      }] })
    ]);
    return document.lineReviewPath;
  })()`);
  const concurrentStatePath = path.join(workspaceDir, "state", `line-${path.basename(concurrentProposalState)}.json`);
  const concurrentState = JSON.parse(await readFile(concurrentStatePath, "utf8"));
  assert(
    concurrentState.edits?.[1] === "并发更新一" && concurrentState.edits?.[2] === "并发更新二",
    `Concurrent proposal updates lost a committed line: ${JSON.stringify(concurrentState)}`
  );

  await writeFile(folderReportPath, JSON.stringify(folderReportDocument, null, 2), "utf8");
  const aggregateResult = await mainWindow.webContents.executeJavaScript(
    `window.workshop.generateProposalReview(${JSON.stringify({
      reportPath: folderReportPath,
      lineReviewPath: folderLineA,
      outputDir,
      pageSize: 1000,
      locale: "zh-CN"
    })})`
  ) as { outputPath?: string; proposalCount?: number; lineReviewPath?: string };
  assert(aggregateResult.outputPath && aggregateResult.proposalCount === 3, "Folder aggregate proposal HTML was not generated from one report");
  assert(
    aggregateResult.lineReviewPath && path.resolve(aggregateResult.lineReviewPath) === path.resolve(folderBatchIndex),
    `Folder aggregate did not retain its batch line-review index: ${JSON.stringify(aggregateResult)}`
  );
  const generatedAggregateHtml = await readFile(aggregateResult.outputPath, "utf8");
  const encodedBatchIndex = JSON.stringify(folderBatchIndex).slice(1, -1);
  const encodedFirstChild = JSON.stringify(folderLineA).slice(1, -1);
  assert(generatedAggregateHtml.includes(encodedBatchIndex), "Folder aggregate did not embed its canonical batch index");
  await writeFile(
    aggregateResult.outputPath,
    generatedAggregateHtml.replace(encodedBatchIndex, encodedFirstChild),
    "utf8"
  );
  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: aggregateResult.outputPath, outputDir })})`
  );
  const aggregateView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && view.webContents.getURL().includes(path.basename(aggregateResult.outputPath!))),
    "the folder aggregate proposal review"
  );
  assert(aggregateView, "Folder aggregate proposal review did not open");
  const repairedAggregateHtml = await readFile(aggregateResult.outputPath, "utf8");
  const repairedProposalData = JSON.parse(
    repairedAggregateHtml.match(/<script id="proposalData" type="application\/json">([\s\S]*?)<\/script>/i)?.[1] || "{}"
  );
  assert(
    repairedProposalData.lineReviewPath && path.resolve(repairedProposalData.lineReviewPath) === path.resolve(folderBatchIndex),
    `Legacy folder proposal child route was not repaired to its batch index: ${JSON.stringify(repairedProposalData.lineReviewPath)}`
  );
  const aggregateInitial = await aggregateView.webContents.executeJavaScript(`({
    cards: document.querySelectorAll("#cards .card").length,
    documents: [...document.querySelectorAll("#documentFilter option")].map(option => option.textContent),
    outputDir: data.outputDir,
    proposals: data.proposals,
    bodyText: document.body.innerText
  })`);
  assert(aggregateInitial.cards === 3, "Folder aggregate did not render every document from one report");
  assert(aggregateInitial.documents.length === 4, `Folder filter did not contain All plus three files: ${JSON.stringify(aggregateInitial)}`);
  assert(
    aggregateInitial.bodyText.includes("chapter-a.txt")
      && aggregateInitial.bodyText.includes("nested/chapter-b.txt")
      && aggregateInitial.bodyText.includes("untouched/chapter-c.txt"),
    "Folder findings did not expose their owning files"
  );
  const stagedA = await aggregateView.webContents.executeJavaScript(`(async () => {
    const item = data.proposals.find(proposal => proposal.documentId === "chapter-a.txt");
    const document = await readLinkedLineReviewDocument(item);
    const target = readLineReviewState(document.state, document.lineReviewPath);
    state.decisions["H1-101"] = { status: "accepted", manualText: "" };
    state.decisions["H1-102"] = { status: "conflict", manualText: "" };
    delete state.decisions["H1-103"];
    return { storageKey: target.storageKey, before: localStorage.getItem(target.storageKey) };
  })()`) as { storageKey: string; before: string | null };
  await writeFile(folderReportPath, JSON.stringify(wrongTranslationReportDocument, null, 2), "utf8");
  const failedApply = await aggregateView.webContents.executeJavaScript(`(async () => {
    let error = "";
    try { await applyProposalChanges(); } catch (caught) { error = caught?.message || String(caught); }
    return {
      error,
      after: localStorage.getItem(${JSON.stringify(stagedA.storageKey)}),
      decision: state.decisions["H1-101"]?.status || ""
    };
  })()`) as { error: string; after: string | null; decision: string };
  assert(/translation/i.test(failedApply.error), `Host transaction failure was not surfaced: ${JSON.stringify(failedApply)}`);
  assert(failedApply.after === stagedA.before, "Failed Host transaction published staged line state to localStorage");
  assert(failedApply.decision === "accepted", "Failed Host transaction did not restore proposal decisions");
  await writeFile(folderReportPath, JSON.stringify(folderReportDocument, null, 2), "utf8");
  await aggregateView.webContents.executeJavaScript(`(() => {
    delete state.decisions["H1-101"];
    delete state.decisions["H1-102"];
    delete state.decisions["H1-103"];
    save();
    render();
  })()`);
  await aggregateView.webContents.executeJavaScript(`(() => {
    const filter = document.querySelector("#documentFilter");
    filter.value = "nested/chapter-b.txt";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  const aggregateFiltered = await aggregateView.webContents.executeJavaScript(`({
    cards: document.querySelectorAll("#cards .card").length,
    text: document.querySelector("#cards")?.innerText || ""
  })`);
  assert(aggregateFiltered.cards === 1 && aggregateFiltered.text.includes("chapter-b.txt"), "Folder findings could not be filtered by file");
  assert(!aggregateFiltered.text.includes("chapter-a.txt"), "Folder file filter leaked another document");
  await aggregateView.webContents.executeJavaScript('document.querySelector("[data-jump-line]").click()');
  const generatedLineBView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && view.webContents.getURL().includes(path.basename(folderLineB))),
    "the canonical chapter-b line review"
  );
  assert(generatedLineBView, "Jump did not open the canonical batch child HTML");
  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: aggregateResult.outputPath, outputDir })})`
  );
  await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && view.webContents.getURL().includes(path.basename(aggregateResult.outputPath!))),
    "the aggregate proposal review after line jump"
  );
  await aggregateView.webContents.executeJavaScript(`(() => {
    document.querySelector("#applyProposalChanges").click();
  })()`);
  await waitFor(
    () => aggregateView.webContents.executeJavaScript('document.querySelector("#proposalStatus")?.textContent || ""').catch(() => ""),
    (value) => typeof value === "string" && /:\s*3\s*\//.test(value),
    "one-click application of every unreviewed folder suggestion"
  );
  assert(visibleView(viewerWindow)?.webContents.id === aggregateView.webContents.id, "Cross-file apply opened every child instead of staying in the aggregate report");
  const resolvedFolderDocuments = await aggregateView.webContents.executeJavaScript(`Promise.all(
    [...linkedLineReviewDocumentPromises.entries()].map(async ([key, pending]) => {
      const document = await pending;
      return { key, lineReviewPath: document?.lineReviewPath || "" };
    })
  )`) as Array<{ key: string; lineReviewPath: string }>;
  const resolvedLineAPath = resolvedFolderDocuments.find((item) => item.key === "chapter-a.txt")?.lineReviewPath || "";
  const resolvedLineBPath = resolvedFolderDocuments.find((item) => item.key === "nested/chapter-b.txt")?.lineReviewPath || "";
  const resolvedLineCPath = resolvedFolderDocuments.find((item) => item.key === "untouched/chapter-c.txt")?.lineReviewPath || "";
  assert(resolvedLineAPath && path.resolve(resolvedLineAPath) === path.resolve(folderLineA), `Chapter A did not retain its canonical batch child: ${JSON.stringify(resolvedFolderDocuments)}`);
  assert(resolvedLineBPath && path.resolve(resolvedLineBPath) === path.resolve(folderLineB), `Chapter B did not retain its canonical batch child: ${JSON.stringify(resolvedFolderDocuments)}`);
  assert(resolvedLineCPath && path.resolve(resolvedLineCPath) === path.resolve(folderLineC), `Chapter C did not retain its canonical batch child: ${JSON.stringify(resolvedFolderDocuments)}`);
  const wrongDocumentRejected = await aggregateView.webContents.executeJavaScript(`(async () => {
    const item = data.proposals.find(proposal => proposal.documentId === "nested/chapter-b.txt");
    const result = await htmlBridge().applyProposalLineReviewStates({ documents: [{
      reportPath: data.reportPath,
      documentId: item.documentId,
      sourcePath: item.sourcePath,
      translationPath: item.translationPath,
      lineReviewPath: ${JSON.stringify(folderLineA)},
      lineState: { edits: { 2: "不应写入" } },
      changedLines: [2],
      changedStateKeys: []
    }] });
    return result?.ok === false ? String(result.error || "rejected") : "";
  })()`);
  assert(/not bound to proofread document/i.test(wrongDocumentRejected), `Host accepted a proposal routed to the wrong file: ${wrongDocumentRejected}`);
  await Promise.all([
    writeFile(missingTranslationReportPath, JSON.stringify(missingTranslationReportDocument, null, 2), "utf8"),
    writeFile(wrongTranslationReportPath, JSON.stringify(wrongTranslationReportDocument, null, 2), "utf8"),
    writeFile(duplicateDocumentReportPath, JSON.stringify(duplicateDocumentReportDocument, null, 2), "utf8"),
    writeFile(malformedDuplicateDocumentReportPath, JSON.stringify(malformedDuplicateDocumentReportDocument, null, 2), "utf8")
  ]);
  const missingTranslationRejected = await aggregateView.webContents.executeJavaScript(`(async () => {
    const result = await htmlBridge().applyProposalLineReviewStates({ documents: [{
      reportPath: ${JSON.stringify(missingTranslationReportPath)},
      documentId: "chapter-a.txt",
      sourcePath: ${JSON.stringify(folderSourceA)},
      translationPath: ${JSON.stringify(folderTranslationA)},
      lineReviewPath: ${JSON.stringify(folderLineA)},
      lineState: { edits: { 1: "不应写入" } },
      changedLines: [1],
      changedStateKeys: []
    }] });
    return result?.ok === false ? String(result.error || "rejected") : "";
  })()`);
  assert(/translation path/i.test(missingTranslationRejected), `Host borrowed a missing schema-2 translation path from IPC: ${missingTranslationRejected}`);
  const wrongTranslationRejected = await aggregateView.webContents.executeJavaScript(`(async () => {
    const result = await htmlBridge().applyProposalLineReviewStates({ documents: [{
      reportPath: ${JSON.stringify(wrongTranslationReportPath)},
      documentId: "chapter-a.txt",
      sourcePath: ${JSON.stringify(folderSourceA)},
      translationPath: ${JSON.stringify(folderTranslationA)},
      lineReviewPath: ${JSON.stringify(folderLineA)},
      lineState: { edits: { 1: "不应写入" } },
      changedLines: [1],
      changedStateKeys: []
    }] });
    return result?.ok === false ? String(result.error || "rejected") : "";
  })()`);
  assert(/translation/i.test(wrongTranslationRejected), `Host accepted the same source with a different translation artifact: ${wrongTranslationRejected}`);
  const duplicateDocumentRejected = await aggregateView.webContents.executeJavaScript(`(async () => {
    const result = await htmlBridge().applyProposalLineReviewStates({ documents: [{
      reportPath: ${JSON.stringify(duplicateDocumentReportPath)},
      documentId: "chapter-a.txt",
      sourcePath: ${JSON.stringify(folderSourceA)},
      translationPath: ${JSON.stringify(folderTranslationA)},
      lineReviewPath: ${JSON.stringify(folderLineA)},
      lineState: { edits: { 1: "不应写入" } },
      changedLines: [1],
      changedStateKeys: []
    }] });
    return result?.ok === false ? String(result.error || "rejected") : "";
  })()`);
  assert(/multiple file routes/i.test(duplicateDocumentRejected), `Host accepted an ambiguous schema-2 document id: ${duplicateDocumentRejected}`);
  const malformedDuplicateDocumentRejected = await aggregateView.webContents.executeJavaScript(`(async () => {
    const result = await htmlBridge().applyProposalLineReviewStates({ documents: [{
      reportPath: ${JSON.stringify(malformedDuplicateDocumentReportPath)},
      documentId: "chapter-a.txt",
      sourcePath: ${JSON.stringify(folderSourceA)},
      translationPath: ${JSON.stringify(folderTranslationA)},
      lineReviewPath: ${JSON.stringify(folderLineA)},
      lineState: { edits: { 1: "不应写入" } },
      changedLines: [1],
      changedStateKeys: []
    }] });
    return result?.ok === false ? String(result.error || "rejected") : "";
  })()`);
  assert(/multiple file routes/i.test(malformedDuplicateDocumentRejected),
    `Host ignored an ambiguous schema-2 route because its finding was malformed: ${malformedDuplicateDocumentRejected}`);
  const [folderStateA, folderStateB, folderStateC] = await Promise.all([
    readFile(path.join(workspaceDir, "state", `line-${path.basename(resolvedLineAPath)}.json`), "utf8").then(JSON.parse),
    readFile(path.join(workspaceDir, "state", `line-${path.basename(resolvedLineBPath)}.json`), "utf8").then(JSON.parse),
    readFile(path.join(workspaceDir, "state", `line-${path.basename(resolvedLineCPath)}.json`), "utf8").then(JSON.parse)
  ]);
  assert(folderStateA.edits?.[1] === "新译甲一", "Cross-file apply did not update chapter-a state");
  assert(folderStateB.edits?.[2] === "新译乙二", "Cross-file apply did not update chapter-b state");
  assert(folderStateC.edits?.[1] === "新译丙一", "One-click apply did not update the unreviewed chapter-c state");
  const synchronizedChildren = await Promise.all([folderLineA, folderLineB, folderLineC, folderLineD].map(async (childPath) => {
    const html = await readFile(childPath, "utf8");
    const match = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i);
    const payload = match ? JSON.parse(match[1]) : undefined;
    return {
      childPath,
      translationPath: payload?.workflow?.paths?.translationPath || "",
      translations: payload?.rows?.map((row: { translation?: unknown }) => String(row.translation || "")) || []
    };
  }));
  assert(
    synchronizedChildren.every((child) => child.translationPath && child.translations.every(Boolean)),
    `Batch children were not synchronized with their current translation artifacts: ${JSON.stringify(synchronizedChildren)}`
  );
  const legacyProposalChildren = await readdir(path.join(htmlDir, "proposal-line-review")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert(legacyProposalChildren.length === 0, `Batch proposal apply created duplicate child HTML files: ${JSON.stringify(legacyProposalChildren)}`);

  await mainWindow.webContents.executeJavaScript(
    `window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: folderBatchIndex, outputDir })})`
  );
  const batchView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && view.webContents.getURL().includes(path.basename(folderBatchIndex))),
    "the synchronized folder batch review"
  );
  assert(batchView, "Folder batch review did not open for TXT write verification");
  const batchIndexUi = await batchView.webContents.executeJavaScript(`({
    hasMatchStatus: Boolean(document.querySelector("#activeStatus")),
    fileLabels: [...document.querySelectorAll("#fileSelect option")].map(option => option.textContent || "")
  })`) as { hasMatchStatus: boolean; fileLabels: string[] };
  assert(!batchIndexUi.hasMatchStatus, "Folder batch index still exposed same-name translation status");
  assert(
    batchIndexUi.fileLabels.every((label) => !/translation|\u8bd1\u6587|\u5339\u914d/i.test(label)),
    `Folder batch file labels still exposed stale match state: ${JSON.stringify(batchIndexUi.fileLabels)}`
  );
  const folderBatchPng = (await batchView.webContents.capturePage()).toPNG();
  assert(!nativeImage.createFromBuffer(folderBatchPng).isEmpty(), "Folder batch index screenshot was empty");
  await writeFile(folderBatchScreenshotPath, folderBatchPng);
  await batchView.webContents.executeJavaScript('document.querySelector("#writeAllTxt").click()');
  await waitFor(
    () => batchView.webContents.executeJavaScript('document.querySelector("#batchWriteStatus")?.textContent || ""').catch(() => ""),
    (value) => typeof value === "string" && /4/.test(value),
    "the folder batch TXT write"
  );
  const writtenFolderTranslations = await Promise.all(
    [folderTranslationA, folderTranslationB, folderTranslationC, folderTranslationD].map((filePath) => readFile(filePath, "utf8"))
  );
  assert(writtenFolderTranslations[0] === "新译甲一\n旧译甲二", `Chapter A TXT missed its accepted edit: ${JSON.stringify(writtenFolderTranslations)}`);
  assert(writtenFolderTranslations[1] === "旧译乙一\n新译乙二", `Chapter B TXT missed its accepted edit: ${JSON.stringify(writtenFolderTranslations)}`);
  assert(writtenFolderTranslations[2] === "新译丙一\n旧译丙二", `Chapter C TXT missed its accepted edit: ${JSON.stringify(writtenFolderTranslations)}`);
  assert(writtenFolderTranslations[3] === "旧译丁一\n旧译丁二", `No-finding chapter D did not retain its synchronized translation: ${JSON.stringify(writtenFolderTranslations)}`);
  const aggregatePng = (await aggregateView.webContents.capturePage()).toPNG();
  assert(!nativeImage.createFromBuffer(aggregatePng).isEmpty(), "Folder aggregate screenshot was empty");
  await writeFile(aggregateScreenshotPath, aggregatePng);

  const project = JSON.parse(await readFile(path.join(workspaceDir, "project.json"), "utf8"));
  assert(typeof project.lastProposalReviewHtml === "string", "Embedded generation did not persist the proposal review path");
  assert(path.basename(project.lastProposalReviewHtml).startsWith("proposal-review-"), "Persisted proposal path was stale");
  const state = JSON.parse(await readFile(path.join(workspaceDir, "state.json"), "utf8"));
  assert(path.basename(state.lastHtml).startsWith("proposal-review-"), "Main-side last HTML state was not updated");
  assert(consoleErrors.length === 0, `Line review logged errors while generating proposal HTML: ${consoleErrors.join(" | ")}`);

  const viewerTabIdsBeforeClose = viewerWindow.getBrowserViews().map((view) => view.webContents.id);
  viewerWindow.close();
  viewerWindow.close();
  await waitFor(
    () => viewerWindow.isDestroyed() && viewerTabIdsBeforeClose.every((id) => !electronWebContents.fromId(id)),
    Boolean,
    "all HTML BrowserViews to be disposed with the viewer window"
  );

  console.log(JSON.stringify({
    ok: true,
    proposalReviewAutoOpen: true,
    proposalReviewInteractive: true,
    folderProofreadAggregate: true,
    folderProofreadCrossFileApply: true,
    folderProofreadOneClickApplyAllSuggestions: true,
    folderProofreadLegacyChildMigrated: true,
    folderProofreadFailedApplyRollback: true,
    folderProofreadWrongDocumentRejected: true,
    folderProofreadMissingTranslationRejected: true,
    folderProofreadWrongTranslationRejected: true,
    folderProofreadAmbiguousDocumentRejected: true,
    folderProofreadMalformedAmbiguousDocumentRejected: true,
    repeatedViewerCloseWaitedForFlush: true,
    concurrentProposalApplySerialized: true,
    viewerBrowserViewsDisposed: true,
    lanProposalDecisionDurable: true,
    screenshot: screenshotPath,
    aggregateScreenshot: aggregateScreenshotPath,
    folderBatchScreenshot: folderBatchScreenshotPath
  }));
}

void app.whenReady().then(run).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
  }
  await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  app.exit(process.exitCode ?? 0);
});
