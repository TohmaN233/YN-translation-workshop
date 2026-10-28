import { app, BrowserWindow, type BrowserView } from "electron";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractedWorkshopTextPath, workshopDirFromOutput } from "../src/main/agent/translationBindingResolve.ts";
import { readEpubText } from "../src/main/epubReader.ts";
import { readProjectJsonObject } from "../src/main/projectJson.ts";
import { resolveReviewHtmlPaths } from "../src/main/reviewHtmlPortability.ts";
import { createZipBuffer } from "../src/main/zipWriter.ts";
import { splitTextLines } from "../src/shared/validation/translationValidator.ts";

const root = process.cwd();
const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-electron-proposal-epub-"));
const workspaceDir = workshopDirFromOutput(outputDir);
const sourcePath = path.join(outputDir, "synthetic-book.epub");
const translationPath = path.join(outputDir, "synthetic-translation.txt");
const reportPath = path.join(outputDir, "report", "synthetic-proofread.json");
const projectJsonPath = path.join(workspaceDir, "project.json");
const sourceLines = ["Fixture source alpha", "Fixture source beta", "Fixture source gamma"];
const translationLines = ["Fixture draft alpha", "Fixture draft beta", "Fixture draft gamma"];
const suggestions = ["Fixture revised alpha", "Fixture revised beta"];
const skipManualImport = process.env.YN_EPUB_SKIP_MANUAL_IMPORT === "1";
let unimportedView: BrowserView | undefined;
const manualTranslation = "Fixture manual gamma";
if (skipManualImport) {
  sourceLines.push("Fixture source delta");
  translationLines.push("Fixture draft delta");
}
const expectedAppliedLines = [suggestions[0], suggestions[1], skipManualImport ? manualTranslation : translationLines[2], ...translationLines.slice(3)];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, label: string, timeoutMs = 12_000): Promise<T> {
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

async function assertMissing(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}

async function readReviewPayload(filePath: string): Promise<any> {
  const html = resolveReviewHtmlPaths(await readFile(filePath, "utf8"), filePath);
  const match = html.match(/<script id="reviewData" type="application\/json">([\s\S]*?)<\/script>/i);
  assert(match, `Line-review HTML is missing reviewData: ${path.basename(filePath)}`);
  return JSON.parse(match[1]);
}

async function writeSyntheticEpub(): Promise<void> {
  const chapter = `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Fixture chapter</title></head><body>${sourceLines.map((line) => `<p>${line}</p>`).join("")}</body></html>`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="fixture-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="fixture-id">synthetic-fixture</dc:identifier><dc:title>Synthetic Fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>`;
  const archive = createZipBuffer([
    { path: "mimetype", data: Buffer.from("application/epub+zip", "utf8"), store: true },
    { path: "META-INF/container.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`, "utf8") },
    { path: "EPUB/package.opf", data: Buffer.from(opf, "utf8") },
    { path: "EPUB/chapter.xhtml", data: Buffer.from(chapter, "utf8") }
  ]);
  await writeFile(sourcePath, archive);
}

console.log("[proposal-epub] entry-start");
app.setAppPath(root);
app.disableHardwareAcceleration();
console.log("[proposal-epub] importing-main");
await import("../src/main/main.ts");
console.log("[proposal-epub] main-import-complete");

async function run(): Promise<void> {
  console.log("[proposal-epub] stage=run-start");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeSyntheticEpub();
  await writeFile(translationPath, translationLines.join("\n"), "utf8");

  const mainWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("renderer/index.html")),
    Boolean,
    "the product renderer"
  ) as BrowserWindow;
  await waitFor(
    () => mainWindow.webContents.executeJavaScript('typeof window.workshop?.generateLineReview === "function" && typeof window.workshopHtml?.updateProjectState === "function"').catch(() => false),
    Boolean,
    "the product generation and project-state bridge"
  );
  console.log("[proposal-epub] stage=renderer-ready");

  const generated = await mainWindow.webContents.executeJavaScript(`window.workshop.generateLineReview(${JSON.stringify({
    sourcePath,
    outputDir,
    fileType: "epub",
    pageSize: 1000,
    locale: "en-US",
    inputMode: "separate"
  })})`) as { outputPath?: string };
  const originalLineReviewPath = generated.outputPath || "";
  assert(path.isAbsolute(originalLineReviewPath), "Empty-translation EPUB generation did not return an absolute line-review path");
  const projectionPath = extractedWorkshopTextPath(workspaceDir, sourcePath, "source");
  assert(JSON.stringify(splitTextLines(await readFile(projectionPath, "utf8"))) === JSON.stringify(sourceLines), "EPUB source projection did not contain the synthetic source lines");
  assert(JSON.stringify(splitTextLines(await readEpubText(sourcePath, workspaceDir, "synthetic-source"))) === JSON.stringify(sourceLines), "Synthetic EPUB text did not match its expected source lines");
  console.log("[proposal-epub] stage=empty-epub-html-generated");

  if (skipManualImport) {
    await mainWindow.webContents.executeJavaScript(`window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: originalLineReviewPath, outputDir })})`);
    const initialViewer = BrowserWindow.getAllWindows().find(candidate => candidate !== mainWindow && candidate.webContents.getURL().startsWith("data:text/html"));
    assert(initialViewer, "The unimported original EPUB page was not opened");
    const initialView = await activeView(initialViewer);
    unimportedView = initialView;
    await waitFor(() => initialView.webContents.executeJavaScript('typeof setBoundTranslationPath === "function" && !lineReviewInitializing').catch(() => false), Boolean, "the existing unimported EPUB editor");
    await initialView.webContents.executeJavaScript(`(async () => {
      setBoundTranslationPath(${JSON.stringify(translationPath)}, ${JSON.stringify(translationPath)}, { userSelected: true });
      await flushQueuedLineReviewStateWrite(); await lastHostStateWrite;
      if (data.rows.some(row => rowValue(row))) throw new Error('Binding a path must not masquerade as importing its text');
      state.syncedFile = ${JSON.stringify(translationPath)};
      state.syncedAt = 'synthetic-previous-import';
      await writeSyncedText(data.rows.map(() => '').join('\\n'));
      await save([], ['syncedFile', 'syncedAt']);
      const target = document.querySelector('.row[data-line="3"] .target');
      target.textContent = ${JSON.stringify(manualTranslation)};
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(manualTranslation)} }));
      await flushQueuedLineReviewStateWrite(); await lastHostStateWrite;
    })()`);
  }

  const projectPatchResult = await mainWindow.webContents.executeJavaScript(`window.workshopHtml.updateProjectState(${JSON.stringify({
    outputDir,
    patch: {
      sourcePath,
      sourceKind: "file",
      translationPath,
      translationBindingOrigin: "user",
      inputMode: "separate"
    }
  })})`);
  assert(projectPatchResult === true, "The project did not persist the same-source selected TXT binding");
  const project = await readProjectJsonObject(projectJsonPath, outputDir);
  assert(project?.sourcePath === sourcePath && project.translationPath === translationPath, "project.json did not decode to the synthetic EPUB plus selected TXT binding");
  console.log("[proposal-epub] stage=selected-txt-project-binding-persisted");

  const lineReviewStatePath = path.join(workspaceDir, "state", `line-${path.basename(originalLineReviewPath)}.json`);
  if (!skipManualImport) await assertMissing(lineReviewStatePath, "The empty-translation line review unexpectedly has a sidecar before its first proposal resolution");
  const unprepared = await readReviewPayload(originalLineReviewPath);
  assert(unprepared.workflow?.paths?.sourcePath === sourcePath, "Generated empty-translation HTML lost its physical EPUB source before proposal resolution");
  assert(unprepared.workflow?.paths?.validationSourcePath === projectionPath, "Generated empty-translation HTML lost its source projection before proposal resolution");
  assert(unprepared.rows.every((row: { translation?: string }) => !row.translation), "Generated empty-translation HTML was not empty before proposal resolution");

  const findings = suggestions.map((suggestedFix, index) => ({
    id: `M-EPUB-${index + 1}`,
    severity: "M1",
    type: "fluency",
    sourceLine: index + 1,
    translationLine: index + 1,
    sourceText: sourceLines[index],
    currentTranslation: translationLines[index],
    suggestedFix,
    rationale: "synthetic Electron regression fixture"
  }));
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: "1.0",
    documentId: "synthetic-book.epub",
    sourcePath: projectionPath,
    translationPath,
    generatedAt: new Date().toISOString(),
    mode: "split",
    findings
  }, null, 2), "utf8");

  const proposalGenerated = await mainWindow.webContents.executeJavaScript(`window.workshop.generateProposalReview(${JSON.stringify({
    reportPath,
    outputDir,
    lineReviewPath: originalLineReviewPath,
    pageSize: 1000,
    locale: "en-US"
  })})`) as { outputPath?: string };
  const proposalPath = proposalGenerated.outputPath || "";
  assert(path.isAbsolute(proposalPath), "Synthetic proofread report did not generate a proposal HTML");
  console.log("[proposal-epub] stage=proposal-report-generated");
  await mainWindow.webContents.executeJavaScript(`window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: proposalPath, outputDir })})`);
  const viewerWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate !== mainWindow && candidate.webContents.getURL().startsWith("data:text/html")),
    Boolean,
    "the HTML tab viewer"
  ) as BrowserWindow;
  const proposalView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && view.webContents.getURL().startsWith("file:") && path.basename(new URL(view.webContents.getURL()).pathname).startsWith("proposal-review-")),
    "the generated proposal review"
  ) as BrowserView;
  await waitFor(
    () => proposalView.webContents.executeJavaScript('typeof resolveProposalLineReviewDocument === "function" && document.querySelectorAll("#cards .card").length === 2').catch(() => false),
    Boolean,
    "the proposal resolver and both synthetic findings"
  );
  console.log("[proposal-epub] stage=proposal-view-ready-before-first-resolution");

  const concurrentResolution = await proposalView.webContents.executeJavaScript(`Promise.all([
    resolveProposalLineReviewDocument(data.proposals[0], { includeRows: true }),
    resolveProposalLineReviewDocument(data.proposals[0], { includeRows: false })
  ]).then(([withRows, metadataOnly]) => ({
    rowsPath: withRows.lineReviewPath,
    metadataPath: metadataOnly.lineReviewPath,
    rowCount: withRows.rows?.length || 0,
    metadataRowCount: metadataOnly.rows?.length || 0,
    translations: withRows.rows?.map(row => row.translation) || []
  }))`) as { rowsPath: string; metadataPath: string; rowCount: number; metadataRowCount: number; translations: string[] };
  console.log("[proposal-epub] concurrent-resolution=" + JSON.stringify(concurrentResolution));
  assert(concurrentResolution.rowsPath === originalLineReviewPath && concurrentResolution.metadataPath === originalLineReviewPath, "Concurrent apply/jump resolution did not reuse the original EPUB HTML");
  assert(concurrentResolution.rowCount === findings.length && concurrentResolution.metadataRowCount === 0, "Concurrent proposal resolution returned incomplete report rows or metadata payloads");
  assert(JSON.stringify(concurrentResolution.translations) === JSON.stringify(translationLines.slice(0, findings.length)), "Proposal resolution did not prepare the selected TXT into the original HTML before it was opened");
  const prepared = await readReviewPayload(originalLineReviewPath);
  assert(prepared.workflow?.paths?.sourcePath === sourcePath, "Resolver preparation replaced the physical EPUB source binding");
  assert(prepared.workflow?.paths?.validationSourcePath === projectionPath, "Resolver preparation replaced the source projection binding");
  assert(prepared.workflow?.paths?.translationPath === translationPath, "Resolver preparation did not bind the selected TXT path");
  assert(prepared.workflow?.epubExport?.mode === "all", "Resolver preparation did not preserve EPUB export options");
  console.log("[proposal-epub] stage=concurrent-resolver-reused-and-prepared-original-html");

  if (!skipManualImport) await mainWindow.webContents.executeJavaScript(`window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: originalLineReviewPath, outputDir })})`);
  const lineView = skipManualImport ? unimportedView! : await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && decodeURIComponent(new URL(view.webContents.getURL()).pathname).toLowerCase().endsWith(path.basename(originalLineReviewPath).toLowerCase())),
    "the resolver-prepared original line review"
  ) as BrowserView;
  const originalLineUi = await lineView.webContents.executeJavaScript(`({
    hasEpubButton: Boolean(document.querySelector("#exportEpub")),
    sourcePath: workflow.paths.sourcePath,
    validationSourcePath: workflow.paths.validationSourcePath,
    translationPath: workflow.paths.translationPath,
    rowTranslations: data.rows.map(row => rowValue(row))
  })`) as { hasEpubButton: boolean; sourcePath: string; validationSourcePath: string; translationPath: string; rowTranslations: string[] };
  assert(originalLineUi.hasEpubButton, "Resolver-prepared original line review did not expose the EPUB export button");
  assert(originalLineUi.sourcePath === sourcePath && originalLineUi.validationSourcePath === projectionPath, "Opened original line-review UI did not retain physical EPUB and projection paths");
  assert(originalLineUi.translationPath === translationPath, "Opened original line-review UI did not retain the selected TXT binding");
  if (!skipManualImport) assert(JSON.stringify(originalLineUi.rowTranslations) === JSON.stringify(translationLines), "Opened original line-review UI did not display the selected TXT rows");
  console.log("[proposal-epub] stage=original-line-review-opened");

  if (!skipManualImport) {
  await lineView.webContents.executeJavaScript(`(async () => {
    await syncLines(${JSON.stringify(translationLines)}, ${JSON.stringify(translationPath)}, { bindPath: true, userSelected: true });
    return true;
  })()`);
  await waitFor(
    async () => readProjectJsonObject(lineReviewStatePath, outputDir),
    (state) => state?.translationPath === translationPath && state?.syncedFile === translationPath,
    "the actual line-review syncLines import sidecar"
  );
  const imported = await lineView.webContents.executeJavaScript(`({
    translations: data.rows.map(row => rowValue(row)),
    syncedFile: state.syncedFile,
    path: workflow.paths.translationPath
  })`) as { translations: string[]; syncedFile: string; path: string };
  assert(JSON.stringify(imported.translations) === JSON.stringify(translationLines), "syncLines did not import every selected TXT row");
  assert(imported.syncedFile === translationPath && imported.path === translationPath, "syncLines did not preserve the selected TXT binding in HTML state");
  console.log("[proposal-epub] stage=syncLines-import-persisted");
  }

  await proposalView.webContents.executeJavaScript(`(() => {
    for (const item of data.proposals) state.decisions[item.id] = { status: "accepted", manualText: "" };
    save();
    render();
    document.querySelector("#applyProposalChanges").click();
  })()`);
  await waitFor(
    () => proposalView.webContents.executeJavaScript('document.querySelector("#proposalStatus")?.textContent || ""').catch(() => ""),
    (value) => /2/.test(String(value)) && !/failed|error/i.test(String(value)),
    "the real proposal suggestion apply"
  );
  const appliedState = await waitFor(
    async () => readProjectJsonObject(lineReviewStatePath, outputDir),
    (state) => state?.edits?.["1"] === suggestions[0] && state?.edits?.["2"] === suggestions[1],
    "the canonical line-review state after applying suggestions"
  );
  assert(appliedState.translationPath === translationPath, "Applying suggestions changed the selected TXT binding");
  console.log("[proposal-epub] stage=proposal-suggestions-applied");

  if (skipManualImport) {
    const actual = await waitFor(() => lineView.webContents.executeJavaScript('currentTargetLines()') as Promise<string[]>,
      lines => JSON.stringify(lines) === JSON.stringify(expectedAppliedLines), "full imported baseline plus preserved manual edit on the existing page");
    assert(JSON.stringify(actual) === JSON.stringify(expectedAppliedLines), `Applying to an already-open unimported page lost untouched translations: ${JSON.stringify(actual)}`);
  }

  const jumpButtonCount = await proposalView.webContents.executeJavaScript('document.querySelectorAll("button[data-jump-line]").length');
  assert(jumpButtonCount === findings.length, `Proposal review did not expose one jump action per synthetic finding: ${jumpButtonCount}`);
  await proposalView.webContents.executeJavaScript(`document.querySelector('button[data-jump-line="1"]')?.click()`);
  const jumpedView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && decodeURIComponent(new URL(view.webContents.getURL()).pathname).toLowerCase().endsWith(path.basename(originalLineReviewPath).toLowerCase()) && new URL(view.webContents.getURL()).hash.includes("line=1")),
    "the proposal jump to the linked EPUB line review"
  ) as BrowserView;
  const jumpedLine = await waitFor(
    () => jumpedView.webContents.executeJavaScript('document.querySelector(".row.jump-target")?.dataset.line || ""').catch(() => ""),
    (line) => String(line) === "1",
    "the active target line after proposal navigation"
  );
  assert(String(jumpedLine) === "1", "Jumping from the proposal did not activate the requested line");
  console.log("[proposal-epub] stage=proposal-jump-complete");

  await jumpedView.webContents.executeJavaScript('document.querySelector("#exportEpub").click()');
  const exportedPath = await waitFor(
    () => jumpedView.webContents.executeJavaScript('state.savedEpubFile || ""').catch(() => ""),
    (value) => typeof value === "string" && value.toLowerCase().endsWith(".translated.epub"),
    "the real EPUB export from the resolver-prepared HTML"
  );
  const exportedLines = splitTextLines(await readEpubText(String(exportedPath), workspaceDir, "synthetic-export"));
  assert(JSON.stringify(exportedLines) === JSON.stringify(expectedAppliedLines), `EPUB export did not use the imported and applied target lines: ${JSON.stringify(exportedLines)}`);
  console.log("[proposal-epub] stage=epub-export-verified");

  await rm(originalLineReviewPath);
  await assertMissing(originalLineReviewPath, "The original line-review HTML was not removed before fallback resolution");
  const fallback = await proposalView.webContents.executeJavaScript("resolveProposalLineReviewDocument(data.proposals[0])") as { lineReviewPath?: string; rows?: unknown[] };
  const fallbackPath = fallback.lineReviewPath || "";
  assert(path.isAbsolute(fallbackPath) && fallbackPath !== originalLineReviewPath, "A missing original HTML did not create a new proposal line-review fallback");
  const fallbackPayload = await readReviewPayload(fallbackPath);
  assert(fallbackPayload.workflow?.paths?.sourcePath === sourcePath, "Missing-HTML fallback lost the physical EPUB source identity");
  assert(fallbackPayload.workflow?.paths?.validationSourcePath === projectionPath, "Missing-HTML fallback lost the validated TXT projection");
  assert(fallbackPayload.workflow?.epubExport?.mode === "all", "Missing-HTML fallback lost EPUB export mode");
  await mainWindow.webContents.executeJavaScript(`window.workshop.openReviewHtml(${JSON.stringify({ htmlPath: fallbackPath, outputDir })})`);
  const fallbackView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && decodeURIComponent(new URL(view.webContents.getURL()).pathname).toLowerCase().endsWith(path.basename(fallbackPath).toLowerCase())),
    "the missing-HTML EPUB fallback review"
  ) as BrowserView;
  const fallbackUi = await fallbackView.webContents.executeJavaScript(`({
    hasEpubButton: Boolean(document.querySelector("#exportEpub")),
    sourcePath: workflow.paths.sourcePath,
    validationSourcePath: workflow.paths.validationSourcePath,
    targetLines: currentTargetLines(),
    previousExportAt: state.savedEpubAt || ""
  })`) as { hasEpubButton: boolean; sourcePath: string; validationSourcePath: string; targetLines: string[]; previousExportAt: string };
  assert(fallbackUi.hasEpubButton && fallbackUi.sourcePath === sourcePath && fallbackUi.validationSourcePath === projectionPath, "Missing-HTML fallback UI did not preserve the EPUB template and export action");
  await fallbackView.webContents.executeJavaScript('document.querySelector("#exportEpub").click()');
  await waitFor(
    () => fallbackView.webContents.executeJavaScript('state.savedEpubAt || ""').catch(() => ""),
    (value) => typeof value === "string" && Boolean(value) && value !== fallbackUi.previousExportAt,
    "an actual EPUB export from the missing-HTML fallback review"
  );
  const fallbackExportPath = await fallbackView.webContents.executeJavaScript('state.savedEpubFile || ""');
  const fallbackExportLines = splitTextLines(await readEpubText(String(fallbackExportPath), workspaceDir, "synthetic-fallback-export"));
  assert(JSON.stringify(fallbackExportLines) === JSON.stringify(fallbackUi.targetLines), "Missing-HTML fallback EPUB export did not use its current target rows");
  console.log("[proposal-epub] stage=missing-html-fallback-verified");

  console.log(JSON.stringify({
    ok: true,
    proposalEpub: true,
    resolverReusedOriginalHtml: true,
    simultaneousApplyAndJumpResolution: true,
    resolverPreparedSelectedTxt: true,
    physicalEpubTemplatePreserved: true,
    syncLinesImport: !skipManualImport,
    noManualImport: skipManualImport,
    proposalApplyAndJump: true,
    epubExport: true,
    missingHtmlFallbackExport: true,
    missingHtmlFallbackPreservedEpub: true
  }));
}

async function closeNormally(): Promise<void> {
  console.log("[proposal-epub] stage=normal-shutdown-start");
  const windows = BrowserWindow.getAllWindows().reverse();
  for (const window of windows) {
    if (!window.isDestroyed()) window.close();
  }
  if (BrowserWindow.getAllWindows().length > 0) {
    await waitFor(() => BrowserWindow.getAllWindows().length, (count) => count === 0, "all Electron windows to close normally", 20_000);
  }
  if (app.isReady()) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      app.once("will-quit", done);
      app.quit();
    });
  }
}

void app.whenReady().then(run).catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  try {
    await closeNormally();
  } catch (error) {
    process.exitCode = 1;
    console.error("Electron verifier could not complete normal shutdown", error instanceof Error ? error.stack || error.message : String(error));
  }
  await rm(outputDir, { recursive: true, force: true }).catch((error) => {
    process.exitCode = 1;
    console.error("Electron verifier could not remove its synthetic fixture directory", error);
  });
});
