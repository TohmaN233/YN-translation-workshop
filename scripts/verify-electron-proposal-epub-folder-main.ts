import { app, BrowserWindow, type BrowserView } from "electron";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractedWorkshopTextPath, workshopDirFromOutput } from "../src/main/agent/translationBindingResolve.ts";
import { resolveTranslationCandidatePath } from "../src/main/agent/writeTranslationChunk.ts";
import { readEpubText } from "../src/main/epubReader.ts";
import { createZipBuffer } from "../src/main/zipWriter.ts";
import { resolveReviewHtmlPaths } from "../src/main/reviewHtmlPortability.ts";
import { splitTextLines } from "../src/shared/validation/translationValidator.ts";

const root = process.cwd();
const outputDir = await mkdtemp(path.join(os.tmpdir(), "yn-electron-proposal-epub-folder-"));
const workspaceDir = workshopDirFromOutput(outputDir);
const reportPath = path.join(outputDir, "report", "folder.proofread.json");
const folderRootAliasReportPath = path.join(outputDir, "report", "folder-root-source.proofread.json");
const sameBasenameFixture = process.env.YN_EPUB_FOLDER_SAME_BASENAME === "1";
const artifactImportFixture = process.env.YN_EPUB_FOLDER_ARTIFACT_IMPORT === "1";
const nestedArtifactImportFixture = process.env.YN_EPUB_FOLDER_ARTIFACT_NESTED === "1";
const legacy61ArtifactImportFixture = process.env.YN_EPUB_FOLDER_ARTIFACT_LEGACY61 === "1";
const alphaEpubName = sameBasenameFixture ? "synthetic-book.epub" : "synthetic-alpha.epub";
const betaEpubName = sameBasenameFixture ? "synthetic-book.epub" : "synthetic-beta.epub";
const documents = artifactImportFixture ? [
  {
    sourcePath: nestedArtifactImportFixture
      ? path.join(outputDir, "alpha", "Synthetic「甲」.epub")
      : path.join(outputDir, "Synthetic「甲」.epub"),
    sourceLines: ["Synthetic source「甲」 — first line.", "Synthetic source「甲」 — second line.", "Synthetic source「甲」 — untouched third line."],
    translationLines: ["合成译文「甲」——第一行。", "合成译文「甲」——第二行。", "合成译文「甲」——未改动第三行。"],
    suggestion: "合成译文「甲」——已导入第一行。"
  },
  {
    sourcePath: nestedArtifactImportFixture
      ? path.join(outputDir, "beta", "Synthetic「甲」.epub")
      : path.join(outputDir, "Synthetic「乙」.epub"),
    sourceLines: ["Synthetic source「乙」 — first line.", "Synthetic source「乙」 — second line.", "Synthetic source「乙」 — untouched third line."],
    translationLines: ["合成译文「乙」——第一行。", "合成译文「乙」——第二行。", "合成译文「乙」——未改动第三行。"],
    suggestion: "合成译文「乙」——已导入第一行。"
  }
] : [
  {
    sourcePath: path.join(outputDir, "alpha", alphaEpubName),
    sourceLines: ["Synthetic alpha source one.", "Synthetic alpha source two.", "Synthetic alpha untouched three."],
    translationLines: ["Synthetic alpha draft one.", "Synthetic alpha draft two.", "Synthetic alpha draft untouched three."],
    suggestion: "Synthetic alpha revised one."
  },
  {
    sourcePath: path.join(outputDir, "beta", betaEpubName),
    sourceLines: ["Synthetic beta source one.", "Synthetic beta source two.", "Synthetic beta untouched three."],
    translationLines: ["Synthetic beta draft one.", "Synthetic beta draft two.", "Synthetic beta draft untouched three."],
    suggestion: "Synthetic beta revised one."
  }
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Timed out waiting for " + label + "; last value: " + JSON.stringify(last));
}

function visibleView(viewerWindow: BrowserWindow): BrowserView | undefined {
  return viewerWindow.getBrowserViews().find((view) => {
    const bounds = view.getBounds();
    return bounds.width > 0 && bounds.height > 0;
  });
}

function viewPath(view: BrowserView | undefined): string {
  if (!view || view.webContents.isDestroyed()) return "";
  const url = view.webContents.getURL();
  if (!url.startsWith("file:")) return "";
  return path.resolve(fileURLToPath(new URL(url)));
}

function resolveFixturePath(projectDir: string, value: string): string {
  return path.resolve(path.isAbsolute(value) ? value : path.join(projectDir, value));
}

async function readPayload(filePath: string, scriptId: "reviewData" | "batchData"): Promise<any> {
  const html = resolveReviewHtmlPaths(await readFile(filePath, "utf8"), filePath);
  const match = html.match(new RegExp('<script id="' + scriptId + '" type="application/json">([\\s\\S]*?)<\\/script>', "i"));
  assert(match, "Review HTML is missing " + scriptId + ": " + path.basename(filePath));
  return JSON.parse(match[1]);
}

async function writeSyntheticEpub(document: typeof documents[number]): Promise<Buffer> {
  const chapter = '<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Synthetic chapter</title></head><body>'
    + document.sourceLines.map((line) => "<p>" + line + "</p>").join("")
    + "</body></html>";
  const opf = '<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="fixture-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="fixture-id">synthetic-folder-fixture</dc:identifier><dc:title>Synthetic folder fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>';
  const archive = createZipBuffer([
    { path: "mimetype", data: Buffer.from("application/epub+zip", "utf8"), store: true },
    { path: "META-INF/container.xml", data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', "utf8") },
    { path: "EPUB/package.opf", data: Buffer.from(opf, "utf8") },
    { path: "EPUB/chapter.xhtml", data: Buffer.from(chapter, "utf8") }
  ]);
  await mkdir(path.dirname(document.sourcePath), { recursive: true });
  await writeFile(document.sourcePath, archive);
  return Buffer.from(archive);
}

for (const document of documents) {
  (document as typeof document & { originalBytes?: Buffer }).originalBytes = await writeSyntheticEpub(document);
}

app.setAppPath(root);
app.disableHardwareAcceleration();
await import("../src/main/main.ts");

async function run(): Promise<void> {
  const mainWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("renderer/index.html")),
    Boolean,
    "the product renderer"
  ) as BrowserWindow;
  await waitFor(
    () => mainWindow.webContents.executeJavaScript('typeof window.workshop?.generateLineReview === "function" && typeof window.workshop?.generateProposalReview === "function"').catch(() => false),
    Boolean,
    "the product folder-review bridge"
  );

  const generated = await mainWindow.webContents.executeJavaScript(
    "window.workshop.generateLineReview(" + JSON.stringify({
      sourcePath: outputDir,
      outputDir,
      fileType: "epub",
      pageSize: 1000,
      locale: "en-US",
      inputMode: "separate"
    }) + ")"
  ) as { outputPath?: string; fileCount?: number };
  const batchIndexPath = generated.outputPath || "";
  assert(path.isAbsolute(batchIndexPath), "Actual folder EPUB generation did not return an absolute batch index");
  assert(generated.fileCount === documents.length, "Actual folder EPUB generation did not index both synthetic books");
  console.log("[proposal-epub-folder] stage=actual-folder-index-generated");

  const batchData = await readPayload(batchIndexPath, "batchData") as { files?: Array<{ sourceName: string; sourcePath: string; outputPath: string }> };
  assert(Array.isArray(batchData.files) && batchData.files.length === documents.length, "Generated batch index does not contain both synthetic books");
  const routedDocuments = batchData.files.map((file) => {
    const document = documents.find((candidate) => path.resolve(candidate.sourcePath).toLowerCase() === path.resolve(file.sourcePath).toLowerCase());
    assert(document, "Generated batch index contains an unexpected source path: " + file.sourcePath);
    return {
      document,
      documentId: file.sourceName,
      sourcePath: path.resolve(file.sourcePath),
      childPath: path.resolve(path.dirname(batchIndexPath), file.outputPath),
      projectionPath: extractedWorkshopTextPath(workspaceDir, file.sourcePath, "source"),
      translationPath: resolveTranslationCandidatePath({
        outputDir,
        sourcePaths: [file.sourcePath],
        documentId: file.sourceName
      })
    };
  });
  assert(new Set(routedDocuments.map((item) => item.documentId.toLowerCase())).size === documents.length,
    "Folder EPUBs did not retain distinct document IDs");

  for (const routed of routedDocuments) {
    const projectionLines = splitTextLines(await readFile(routed.projectionPath, "utf8"));
    if (JSON.stringify(projectionLines) !== JSON.stringify(routed.document.sourceLines)) {
      const evidence = {
        sourcePath: routed.sourcePath,
        projectionPath: routed.projectionPath,
        sourceLines: routed.document.sourceLines,
        actualProjectionLines: projectionLines
      };
      console.error("[proposal-epub-folder] source-projection-mismatch " + JSON.stringify(evidence));
      await writeFile(path.join(outputDir, "source-projection-mismatch.json"), JSON.stringify(evidence, null, 2), "utf8");
      throw new Error("Actual EPUB source projection did not match its independent synthetic source lines: " + JSON.stringify(evidence));
    }
    const childPayload = await readPayload(routed.childPath, "reviewData");
    assert(childPayload.workflow?.paths?.sourcePath === routed.sourcePath,
      "Generated batch child lost its original EPUB source path: " + routed.documentId);
    assert(childPayload.workflow?.paths?.validationSourcePath === routed.projectionPath,
      "Generated batch child lost its extracted source TXT binding: " + routed.documentId);
    assert(childPayload.workflow?.epubExport?.mode === "all",
      "Generated batch child lost its original EPUB export template: " + routed.documentId);
    assert(childPayload.workflow?.paths?.editableTranslationPath
      && path.resolve(childPayload.workflow.paths.editableTranslationPath).toLowerCase() !== path.resolve(routed.translationPath).toLowerCase(),
    "The blank child must begin with its extracted draft path so the report's canonical TXT route exercises rebinding: " + routed.documentId);
    assert(childPayload.rows.every((row: { translation?: string }) => !row.translation),
      "Generated folder index did not start with blank EPUB translations: " + routed.documentId);

    await mkdir(path.dirname(routed.translationPath), { recursive: true });
    await writeFile(routed.translationPath, routed.document.translationLines.join("\n"), "utf8");
  }
  assert(new Set(routedDocuments.map((item) => path.resolve(item.translationPath).toLowerCase())).size === documents.length,
    "Folder EPUBs collided on their canonical translation targets");

  if (artifactImportFixture) {
    assert(new Set(routedDocuments.map((item) => path.basename(item.projectionPath).toLowerCase())).size === 1,
      "Synthetic Unicode EPUB names must collide on the sanitized projection basename to exercise artifact identity matching");
    if (nestedArtifactImportFixture) {
      assert(new Set(routedDocuments.map((item) => path.basename(item.sourcePath).toLowerCase())).size === 1
        && new Set(routedDocuments.map((item) => path.dirname(item.translationPath).toLowerCase())).size === documents.length,
      "Nested same-basename EPUBs must retain separate canonical candidate directories");
    } else {
      assert(new Set(routedDocuments.map((item) => path.basename(item.translationPath).toLowerCase())).size === documents.length,
        "Synthetic Unicode EPUB names did not retain distinct canonical candidate basenames");
    }
    assert(!legacy61ArtifactImportFixture || nestedArtifactImportFixture,
      "The legacy v61 artifact fixture requires nested same-basename EPUBs");

    const pairedReviewGenerated = await mainWindow.webContents.executeJavaScript(
      "window.workshop.generateLineReview(" + JSON.stringify({
        sourcePath: outputDir,
        translationPath: path.join(outputDir, "AI_translation"),
        outputDir,
        fileType: "epub",
        pageSize: 1000,
        locale: "en-US",
        inputMode: "separate"
      }) + ")"
    ) as { outputPath?: string; fileCount?: number; matchedCount?: number; warningCount?: number };
    const pairedIndexPath = pairedReviewGenerated.outputPath || "";
    assert(path.isAbsolute(pairedIndexPath)
      && pairedReviewGenerated.fileCount === documents.length
      && pairedReviewGenerated.matchedCount === documents.length
      && pairedReviewGenerated.warningCount === 0,
    "Actual folder generation did not match both paired canonical TXT candidates: " + JSON.stringify(pairedReviewGenerated));
    const pairedBatchData = await readPayload(pairedIndexPath, "batchData") as {
      files?: Array<{ sourceName: string; sourcePath: string; outputPath: string; status: string; translationPath?: string }>
    };
    assert(Array.isArray(pairedBatchData.files) && pairedBatchData.files.length === documents.length,
      "Actual paired-TXT folder review did not contain both synthetic EPUBs");
    for (const routed of routedDocuments) {
      const pairedFile = pairedBatchData.files.find((file) => path.resolve(file.sourcePath).toLowerCase() === path.resolve(routed.sourcePath).toLowerCase());
      assert(pairedFile?.status === "matched" && pairedFile.translationPath
        && path.resolve(pairedFile.translationPath).toLowerCase() === path.resolve(routed.translationPath).toLowerCase(),
      "Actual folder matching selected the wrong paired TXT for " + routed.documentId + ": " + JSON.stringify(pairedFile));
      const pairedChildPath = path.resolve(path.dirname(pairedIndexPath), pairedFile.outputPath);
      const pairedChild = await readPayload(pairedChildPath, "reviewData");
      assert(JSON.stringify(pairedChild.rows.map((row: { translation?: string }) => row.translation))
        === JSON.stringify(routed.document.translationLines),
      "Actual paired-TXT folder child loaded another book's translation lines: " + routed.documentId);
    }
    console.log("[proposal-epub-folder-artifact-import] stage=paired-folder-txt-matched");

    const blankIndexMetadata = await readPayload(batchIndexPath, "batchData") as {
      folderAgentRoute?: { advanced?: { folderSourceDocuments?: Array<{ id: string; path: string }> } };
    };
    const folderSourceDocuments = blankIndexMetadata.folderAgentRoute?.advanced?.folderSourceDocuments;
    assert(Array.isArray(folderSourceDocuments) && folderSourceDocuments.length === documents.length,
      "Actual blank folder index is missing its source projection metadata for legacy-child preparation");
    for (const routed of routedDocuments) {
      const indexedSource = folderSourceDocuments.find((entry) => entry.id === routed.documentId);
      assert(indexedSource && resolveFixturePath(outputDir, indexedSource.path).toLowerCase() === path.resolve(routed.projectionPath).toLowerCase(),
        "Actual blank folder index does not contain this child's exact projection binding: " + routed.documentId + ": " + JSON.stringify(indexedSource));
    }

    if (legacy61ArtifactImportFixture) {
      for (const routed of routedDocuments) {
        const childHtml = await readFile(routed.childPath, "utf8");
        const payloadMatch = childHtml.match(/(<script id="reviewData" type="application\/json">)([\s\S]*?)(<\/script>)/i);
        assert(payloadMatch, "Generated child is missing reviewData before legacy v61 fixture downgrade: " + routed.documentId);
        const childPayload = JSON.parse(payloadMatch[2]);
        assert(childPayload.workflow?.paths?.validationSourcePath
          && resolveFixturePath(outputDir, childPayload.workflow.paths.validationSourcePath).toLowerCase() === path.resolve(routed.projectionPath).toLowerCase(),
        "Generated child did not begin with its independent source projection binding: " + JSON.stringify({
          documentId: routed.documentId,
          sourcePath: routed.sourcePath,
          expectedProjection: routed.projectionPath,
          actualValidationSourcePath: childPayload.workflow?.paths?.validationSourcePath
        }));
        delete childPayload.workflow.paths.validationSourcePath;
        if (childPayload.workflow.advanced) delete childPayload.workflow.advanced.folderSourceDocuments;
        const downgradedPayload = JSON.stringify(childPayload).replace(/</g, "\\u003c");
        const downgradedHtml = childHtml.replace(payloadMatch[0], payloadMatch[1] + downgradedPayload + payloadMatch[3])
          .replace(/(<meta name="translation-workshop-line-review" content=")translation-workshop-line-review-v\d+("\s*>)/i,
            "$1translation-workshop-line-review-v61$2");
        assert(downgradedHtml !== childHtml
          && /<meta name="translation-workshop-line-review" content="translation-workshop-line-review-v61"/i.test(downgradedHtml),
        "Could not create the synthetic legacy v61 child payload: " + routed.documentId);
        await writeFile(routed.childPath, downgradedHtml, "utf8");
      }
      console.log("[proposal-epub-folder-artifact-import] stage=children-downgraded-to-v61");
    }

    await mainWindow.webContents.executeJavaScript(
      "window.workshop.openReviewHtml(" + JSON.stringify({ htmlPath: batchIndexPath, outputDir }) + ")"
    );
    const viewerWindow = await waitFor(
      () => BrowserWindow.getAllWindows().find((candidate) => candidate !== mainWindow && candidate.webContents.getURL().startsWith("data:text/html")),
      Boolean,
      "the HTML tab viewer for artifact import"
    ) as BrowserWindow;
    const batchView = await waitFor(
      () => visibleView(viewerWindow),
      (view) => viewPath(view) === path.resolve(batchIndexPath),
      "the generated folder index for artifact import"
    ) as BrowserView;
    await waitFor(
      () => batchView.webContents.executeJavaScript('Boolean(document.querySelector("#fileFrame")?.contentDocument?.querySelector(".row"))').catch(() => false),
      Boolean,
      "the first actual EPUB child for artifact import"
    );

    const readChild = async <T>(expression: string): Promise<T> => batchView.webContents.executeJavaScript(
      'document.querySelector("#fileFrame").contentWindow.eval(' + JSON.stringify(expression) + ')'
    ) as Promise<T>;
    const readCards = async () => readChild<Array<{
      path: string;
      sourcePath: string;
      unmatched: boolean;
      canImport: boolean;
      validation: string;
    }>>('Array.from(document.querySelectorAll(".artifact-card")).map(card => ({'
      + 'path: card.querySelector(".artifact-actions button[data-path]")?.getAttribute("data-path") || card.querySelector(".artifact-meta")?.textContent?.trim() || "",'
      + 'sourcePath: card.querySelector(".artifact-import")?.getAttribute("data-source") || "",'
      + 'unmatched: Boolean(card.querySelector(".artifact-meta.warn")), '
      + 'canImport: Boolean(card.querySelector(".artifact-import")), '
      + 'validation: card.textContent || "" }))');

    for (const [documentIndex, routed] of routedDocuments.entries()) {
      if (documentIndex > 0) {
        await batchView.webContents.executeJavaScript(
          '(() => { const select = document.querySelector("#fileSelect"); select.value = '
            + JSON.stringify(String(documentIndex))
            + '; select.dispatchEvent(new Event("change", { bubbles: true })); })()'
        );
      }
      await waitFor(
        () => readChild<string>("workflow.paths.sourcePath").catch(() => ""),
        (sourcePath) => resolveFixturePath(outputDir, sourcePath).toLowerCase() === path.resolve(routed.sourcePath).toLowerCase(),
        "the selected synthetic EPUB child " + routed.documentId
      );
      const childInitial = await readChild<{
        sourcePath: string;
        validationSourcePath: string;
        outputDir: string;
        promptSourceKind: string;
        folderSourceDocuments: Array<{ id: string; path: string }>;
        exportAvailable: boolean;
        targetLines: string[];
      }>('({ sourcePath: workflow.paths.sourcePath, validationSourcePath: workflow.paths.validationSourcePath, '
        + 'outputDir: workflow.paths.outputDir, promptSourceKind: workflow.paths.promptSourceKind, '
        + 'folderSourceDocuments: workflow.advanced?.folderSourceDocuments || [], '
        + 'exportAvailable: Boolean(document.querySelector("#exportEpub")), targetLines: currentTargetLines() })');
      assert(resolveFixturePath(outputDir, childInitial.sourcePath).toLowerCase() === path.resolve(routed.sourcePath).toLowerCase(),
        "Selected folder child lost its original EPUB binding: " + routed.documentId);
      assert(resolveFixturePath(outputDir, childInitial.outputDir).toLowerCase() === path.resolve(outputDir).toLowerCase(),
        "Selected folder child lost its artifact project directory: " + JSON.stringify({ documentId: routed.documentId, outputDir: childInitial.outputDir }));
      if (legacy61ArtifactImportFixture) {
        const upgradedSource = childInitial.folderSourceDocuments.find((entry) => entry.id === routed.documentId);
        assert(upgradedSource && resolveFixturePath(outputDir, upgradedSource.path).toLowerCase() === path.resolve(routed.projectionPath).toLowerCase(),
          "Legacy v61 upgrade did not recover this child's projection from the actual folder index metadata: " + routed.documentId + ": " + JSON.stringify(upgradedSource));
        const upgradedHtml = await readFile(routed.childPath, "utf8");
        assert(!/content="translation-workshop-line-review-v61"/i.test(upgradedHtml),
          "Legacy child protocol was not upgraded to the current line-review version: " + routed.documentId);
        console.log("[proposal-epub-folder-artifact-import] stage=legacy-v61-upgraded-from-index-" + documentIndex);
      } else {
        assert(resolveFixturePath(outputDir, childInitial.validationSourcePath).toLowerCase() === path.resolve(routed.projectionPath).toLowerCase(),
          "Selected folder child lost its extracted source projection binding: " + routed.documentId);
      }
      assert(childInitial.exportAvailable && childInitial.targetLines.every((line) => !line),
        "Artifact-import child must be a blank EPUB review with export available: " + routed.documentId);

      await readChild<boolean>('(() => { document.querySelector("#refreshAgentArtifacts").click(); return true; })()');
      const cardsAfterScan = await waitFor(
        async () => {
          const status = await readChild<string>('document.querySelector("#agentArtifactsStatus")?.textContent || ""').catch(() => "");
          return { status, cards: await readCards().catch(() => []) };
        },
        (result) => /Rescanned 1 artifact\(s\) from disk\./.test(result.status),
        "actual artifact scan for " + routed.documentId,
        30_000
      );
      const expectedCandidatePath = path.resolve(routed.translationPath).toLowerCase();
      const artifact = cardsAfterScan.cards.find((card) => path.resolve(card.path).toLowerCase() === expectedCandidatePath);
      assert(artifact, "Artifact scan did not surface the canonical candidate for " + routed.documentId + ": " + JSON.stringify(cardsAfterScan));
      const expectedProjectionPath = path.resolve(routed.projectionPath).toLowerCase();
      assert(!artifact.unmatched && resolveFixturePath(outputDir, artifact.sourcePath).toLowerCase() === expectedProjectionPath,
        "Folder EPUB candidate is source-unmatched instead of binding its extracted projection: " + JSON.stringify({
          documentId: routed.documentId, candidatePath: routed.translationPath, projectionPath: routed.projectionPath,
          sourcePath: artifact.sourcePath, unmatched: artifact.unmatched, status: cardsAfterScan.status
        }));
      assert(artifact.canImport,
        "Matched candidate did not finish deterministic validation and expose its real Import as draft button: " + JSON.stringify(artifact));
      assert(!/source not matched|未匹配到原文/i.test(artifact.validation),
        "Current child candidate still displays Source not matched: " + JSON.stringify(artifact));

      const candidateBeforeImport = await readFile(routed.translationPath, "utf8");
      await readChild<boolean>(
        '(() => { const card = Array.from(document.querySelectorAll(".artifact-card")).find(item => '
          + '(item.querySelector(".artifact-import")?.getAttribute("data-path") || "").toLowerCase() === '
          + JSON.stringify(expectedCandidatePath)
          + '); const button = card?.querySelector(".artifact-import"); if (!button) throw new Error("Missing actual candidate Import as draft button"); button.click(); return true; })()'
      );
      const importStatus = await waitFor(
        () => readChild<string>('document.querySelector("#aiStatus")?.textContent || ""').catch(() => ""),
        (value) => /Imported as draft|Import blocked|Import failed/.test(value),
        "actual candidate draft import for " + routed.documentId,
        30_000
      );
      assert(/Imported as draft/.test(importStatus),
        "Actual artifact Import as draft failed for " + routed.documentId + ": " + importStatus);

      const importedChild = await readChild<{
        sourcePath: string;
        validationSourcePath: string;
        translationPath: string;
        targetLines: string[];
      }>('({ sourcePath: workflow.paths.sourcePath, validationSourcePath: workflow.paths.validationSourcePath, '
        + 'translationPath: workflow.paths.translationPath, targetLines: currentTargetLines() })');
      assert(resolveFixturePath(outputDir, importedChild.sourcePath).toLowerCase() === path.resolve(routed.sourcePath).toLowerCase()
        && resolveFixturePath(outputDir, importedChild.validationSourcePath).toLowerCase() === path.resolve(routed.projectionPath).toLowerCase()
        && resolveFixturePath(outputDir, importedChild.translationPath).toLowerCase() === expectedCandidatePath,
      "Artifact import changed the child's EPUB, projection, or canonical candidate binding: " + routed.documentId);
      assert(JSON.stringify(importedChild.targetLines) === JSON.stringify(routed.document.translationLines),
        "Artifact import did not install the complete matching TXT baseline: " + routed.documentId);
      const sidecarPath = path.join(workspaceDir, "state", "line-" + path.basename(routed.childPath) + ".json");
      const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
      assert(JSON.stringify(Object.keys(sidecar.edits || {}).sort((a, b) => Number(a) - Number(b))) === JSON.stringify(["1", "2", "3"])
        && JSON.stringify([sidecar.edits?.["1"], sidecar.edits?.["2"], sidecar.edits?.["3"]]) === JSON.stringify(routed.document.translationLines),
      "Artifact import did not persist every candidate line in the matching child sidecar: " + routed.documentId);
      assert(await readFile(routed.translationPath, "utf8") === candidateBeforeImport,
        "Draft import overwrote the source candidate TXT instead of importing into line-review state: " + routed.documentId);

      await readChild<boolean>('document.querySelector("#exportEpub").click(); true');
      const exportPath = await waitFor(
        () => readChild<string>("state.savedEpubFile || \"\"").catch(() => ""),
        (value) => value.toLowerCase().endsWith(".translated.epub"),
        "actual EPUB export after candidate import for " + routed.documentId
      );
      const exportedLines = splitTextLines(await readEpubText(exportPath, workspaceDir,
        "synthetic-artifact-import-" + routed.documentId.replace(/[^a-z0-9]+/gi, "-")));
      assert(JSON.stringify(exportedLines) === JSON.stringify(routed.document.translationLines),
        "EPUB export did not use the matching imported candidate lines: " + routed.documentId);
      assert(JSON.stringify(await readFile(routed.sourcePath)) === JSON.stringify((routed.document as typeof routed.document & { originalBytes?: Buffer }).originalBytes),
        "Artifact import/export modified the matching original EPUB: " + routed.documentId);
      console.log("[proposal-epub-folder-artifact-import] stage=imported-and-exported-" + documentIndex);
    }

    console.log(JSON.stringify({
      ok: true,
      proposalEpubFolderArtifactImport: true,
      actualFolderIndex: true,
      actualArtifactDiscoveryAndImportUi: true,
      syntheticUnicodeBasenameCollision: true,
      twoCandidateSidecarsAndEpubExports: true,
      originalEpubBytesUnchanged: true
    }));
    return;
  }

  const findings = routedDocuments.map((routed, index) => ({
    documentId: routed.documentId,
    sourcePath: routed.projectionPath,
    translationPath: routed.translationPath,
    id: "H1-FOLDER-EPUB-" + (index + 1),
    severity: "H1",
    type: "accuracy",
    sourceLine: 1,
    translationLine: 1,
    sourceText: routed.document.sourceLines[0],
    currentTranslation: routed.document.translationLines[0],
    suggestedFix: routed.document.suggestion,
    rationale: "independent synthetic Electron regression fixture"
  }));
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: "2.0",
    scope: { kind: "folder", sourcePath: outputDir },
    generatedAt: new Date().toISOString(),
    mode: "split",
    findings
  }, null, 2), "utf8");

  await mainWindow.webContents.executeJavaScript(
    "window.workshop.openReviewHtml(" + JSON.stringify({ htmlPath: batchIndexPath, outputDir }) + ")"
  );
  const viewerWindow = await waitFor(
    () => BrowserWindow.getAllWindows().find((candidate) => candidate !== mainWindow && candidate.webContents.getURL().startsWith("data:text/html")),
    Boolean,
    "the HTML tab viewer"
  ) as BrowserWindow;
  const batchView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => viewPath(view) === path.resolve(batchIndexPath),
    "the generated folder index"
  ) as BrowserView;
  await waitFor(
    () => batchView.webContents.executeJavaScript('Boolean(document.querySelector("#fileFrame")?.contentDocument?.querySelector(".row"))').catch(() => false),
    Boolean,
    "the selected blank EPUB child"
  );

  const proposalGenerated = await mainWindow.webContents.executeJavaScript(
    "window.workshop.generateProposalReview(" + JSON.stringify({
      reportPath,
      lineReviewPath: batchIndexPath,
      outputDir,
      pageSize: 1000,
      locale: "en-US"
    }) + ")"
  ) as { outputPath?: string; proposalCount?: number; lineReviewPath?: string };
  const proposalPath = proposalGenerated.outputPath || "";
  assert(path.isAbsolute(proposalPath) && proposalGenerated.proposalCount === documents.length,
    "Synthetic aggregate folder report did not produce both proposal cards");
  assert(proposalGenerated.lineReviewPath && path.resolve(proposalGenerated.lineReviewPath) === path.resolve(batchIndexPath),
    "Aggregate folder report did not link the actual generated batch index");
  await mainWindow.webContents.executeJavaScript(
    "window.workshop.openReviewHtml(" + JSON.stringify({ htmlPath: proposalPath, outputDir }) + ")"
  );
  const proposalView = await waitFor(
    () => visibleView(viewerWindow),
    (view) => Boolean(view && !view.webContents.isDestroyed() && path.basename(viewPath(view)).startsWith("proposal-review-")),
    "the aggregate folder proposal review"
  ) as BrowserView;
  await waitFor(
    () => proposalView.webContents.executeJavaScript('typeof resolveProposalLineReviewDocument === "function" && document.querySelectorAll("#cards .card").length === 2').catch(() => false),
    Boolean,
    "both synthetic folder EPUB findings"
  );

  const rootAliasDocument = routedDocuments[0];
  const folderRootAliasFinding = {
    documentId: rootAliasDocument.documentId,
    sourcePath: outputDir,
    translationPath: rootAliasDocument.translationPath,
    id: "H1-FOLDER-ROOT-ALIAS",
    severity: "H1",
    type: "accuracy",
    sourceLine: 1,
    translationLine: 1,
    sourceText: rootAliasDocument.document.sourceLines[0],
    currentTranslation: rootAliasDocument.document.translationLines[0],
    suggestedFix: rootAliasDocument.document.suggestion,
    rationale: "synthetic negative folder-root source identity fixture"
  };
  await writeFile(folderRootAliasReportPath, JSON.stringify({
    schemaVersion: "2.0",
    scope: { kind: "folder", sourcePath: outputDir },
    generatedAt: new Date().toISOString(),
    mode: "split",
    findings: [folderRootAliasFinding]
  }, null, 2), "utf8");

  const assertFolderRootSourceRejected = async (stage: "before-apply" | "after-apply") => {
    const result = await proposalView.webContents.executeJavaScript(
      '(async () => { try { const resolved = await htmlBridge().resolveProposalLineReviewDocument('
        + JSON.stringify({
          outputDir,
          reportPath: folderRootAliasReportPath,
          lineReviewPath: batchIndexPath,
          documentId: rootAliasDocument.documentId,
          sourcePath: outputDir,
          translationPath: rootAliasDocument.translationPath,
          locale: "en-US",
          includeRows: false
        })
        + '); return { accepted: true, lineReviewPath: resolved?.lineReviewPath || "" }; }'
        + ' catch (error) { return { accepted: false, error: error?.message || String(error) }; } })()'
    ) as { accepted: boolean; lineReviewPath?: string; error?: string };
    assert(!result.accepted,
      "Folder scope root was accepted as a same-child source alias " + stage + ": " + JSON.stringify(result));
    assert(/source|bound|child|document/i.test(result.error || ""),
      "Folder-root alias rejection did not identify the source binding: " + JSON.stringify(result));
    console.log("[proposal-epub-folder] stage=folder-root-source-rejected-" + stage);
  };

  await assertFolderRootSourceRejected("before-apply");

  await proposalView.webContents.executeJavaScript(
    '(() => { for (const item of data.proposals) state.decisions[item.id] = { status: "accepted", manualText: "" }; save(); render(); document.querySelector("#applyProposalChanges").click(); })()'
  );
  const applyStatus = await waitFor(
    () => proposalView.webContents.executeJavaScript('document.querySelector("#proposalStatus")?.textContent || ""').catch(() => ""),
    (value) => /Failed to apply|Proposals applied/i.test(String(value)),
    "the real aggregate proposal apply result"
  );
  assert(!/Proofread report source does not match batch child/.test(String(applyStatus)),
    "The real folder EPUB proposal apply hit the exact source mismatch guard: " + applyStatus);
  assert(/Proposals applied:\s*2\s*\/\s*Skipped:\s*0/i.test(String(applyStatus)),
    "The real folder EPUB proposal apply did not apply both suggestions: " + applyStatus);
  console.log("[proposal-epub-folder] stage=both-proposal-suggestions-applied");
  await assertFolderRootSourceRejected("after-apply");

  for (const routed of routedDocuments) {
    const sidecarPath = path.join(workspaceDir, "state", "line-" + path.basename(routed.childPath) + ".json");
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    assert(sidecar.edits?.["1"] === routed.document.suggestion,
      "Proposal suggestion was not committed to the matching child sidecar: " + routed.documentId);
    const preparedChild = await readPayload(routed.childPath, "reviewData");
    assert(preparedChild.workflow?.paths?.sourcePath === routed.sourcePath
      && preparedChild.workflow?.paths?.validationSourcePath === routed.projectionPath,
    "Proposal synchronization did not preserve the EPUB and extracted source bindings: " + routed.documentId);
    assert(preparedChild.workflow?.paths?.translationPath
      && path.resolve(preparedChild.workflow.paths.translationPath).toLowerCase() === path.resolve(routed.translationPath).toLowerCase(),
    "Proposal synchronization did not rebind the canonical translation path: " + routed.documentId);
    assert(preparedChild.workflow?.epubExport?.mode === "all",
      "Proposal synchronization lost the original EPUB export template: " + routed.documentId);
    assert(JSON.stringify(preparedChild.rows.map((row: { translation?: string }) => row.translation))
      === JSON.stringify(routed.document.translationLines),
    "Proposal synchronization lost the complete untouched TXT baseline: " + routed.documentId);
    assert(JSON.stringify(await readFile(routed.sourcePath)) === JSON.stringify((routed.document as typeof routed.document & { originalBytes?: Buffer }).originalBytes),
      "Proposal apply modified an original EPUB source: " + routed.documentId);
  }

  for (const routed of routedDocuments) {
    const findingId = findings.find((finding) => finding.documentId === routed.documentId)!.id;
    await proposalView.webContents.executeJavaScript(
      '(() => { const card = Array.from(document.querySelectorAll("#cards .card")).find(item => item.dataset.id === '
        + JSON.stringify(findingId)
        + '); if (!card) throw new Error("Missing finding card"); card.querySelector("button[data-jump-line]")?.click(); })()'
    );
    const jumpedView = await waitFor(
      () => visibleView(viewerWindow),
      (view) => viewPath(view) === path.resolve(routed.childPath),
      "proposal jump to existing EPUB child " + routed.documentId
    ) as BrowserView;
    const jumpedLine = await waitFor(
      () => jumpedView.webContents.executeJavaScript('document.querySelector(".row.jump-target")?.dataset.line || ""').catch(() => ""),
      (line) => String(line) === "1",
      "the proposal line target in " + routed.documentId
    );
    assert(String(jumpedLine) === "1", "Proposal jump did not activate line one in " + routed.documentId);
    const childUi = await jumpedView.webContents.executeJavaScript('({ exportAvailable: Boolean(document.querySelector("#exportEpub")), sourcePath: workflow.paths.sourcePath, targetLines: currentTargetLines() })') as {
      exportAvailable: boolean; sourcePath: string; targetLines: string[];
    };
    assert(childUi.exportAvailable && path.resolve(childUi.sourcePath).toLowerCase() === path.resolve(routed.sourcePath).toLowerCase(),
      "Proposal jump opened a child without its matching EPUB source/export action: " + routed.documentId);
    const expectedLines = [routed.document.suggestion, ...routed.document.translationLines.slice(1)];
    assert(JSON.stringify(childUi.targetLines) === JSON.stringify(expectedLines),
      "Jumped child did not retain the full target baseline around its applied suggestion: " + routed.documentId);
    await jumpedView.webContents.executeJavaScript('document.querySelector("#exportEpub").click()');
    const exportPath = await waitFor(
      () => jumpedView.webContents.executeJavaScript('state.savedEpubFile || ""').catch(() => ""),
      (value) => typeof value === "string" && value.toLowerCase().endsWith(".translated.epub"),
      "the EPUB export from " + routed.documentId
    );
    const exportedLines = splitTextLines(await readEpubText(String(exportPath), workspaceDir, "synthetic-folder-export-" + routed.documentId.replace(/[^a-z0-9]+/gi, "-")));
    assert(JSON.stringify(exportedLines) === JSON.stringify(expectedLines),
      "EPUB export did not use the correct synthetic translation for " + routed.documentId);
    assert(JSON.stringify(await readFile(routed.sourcePath)) === JSON.stringify((routed.document as typeof routed.document & { originalBytes?: Buffer }).originalBytes),
      "EPUB export modified the matching original source: " + routed.documentId);
  }

  console.log(JSON.stringify({
    ok: true,
    proposalEpubFolder: true,
    actualFolderIndex: true,
    distinctFolderRoutes: true,
    sameBasenameFixture,
    canonicalTxtRebinding: true,
    proposalApplyAndJump: true,
    bothEpubExports: true,
    originalEpubBytesUnchanged: true
  }));
}

async function closeNormally(): Promise<void> {
  console.log("[proposal-epub-folder] stage=normal-shutdown-start");
  for (const window of BrowserWindow.getAllWindows().reverse()) {
    if (!window.isDestroyed()) window.close();
  }
  if (BrowserWindow.getAllWindows().length > 0) {
    await waitFor(() => BrowserWindow.getAllWindows().length, (count) => count === 0, "all Electron windows to close normally", 20_000);
  }
  if (app.isReady()) {
    await new Promise<void>((resolve) => {
      app.once("will-quit", resolve);
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
  if (process.env.YN_EPUB_FOLDER_KEEP_FIXTURE === "1") {
    console.error("[proposal-epub-folder] retaining synthetic fixture directory " + outputDir);
  } else {
    await rm(outputDir, { recursive: true, force: true }).catch((error) => {
      process.exitCode = 1;
      console.error("Electron verifier could not remove its synthetic fixture directory", error);
    });
  }
});
