import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkProposalSafety } from "../shared/core/proposalSafety.ts";
import { isMechanicalScanProposal, parseProofreadFindingsJson, type ReviewProposal } from "../shared/core/reviewReport.ts";
import { splitTextLines, validateTranslationCandidate, type ValidationOptions } from "../shared/validation/translationValidator.ts";
import { withTranslationCandidateLock } from "./agent/writeTranslationChunk.ts";
import { proofreadSuggestedFixPreservesControlPrefix } from "./agent/writeProofreadFindings.ts";
import { writeTextFilesAtomically } from "./atomicFile.ts";

export interface AutomationProofreadDocument {
  documentId: string;
  sourcePath: string;
  translationPath: string;
  lineReviewPath: string;
  statePath: string;
  validationOptions?: ValidationOptions;
}

/** Main supplies authoritative HTML/batch routing and the existing sidecar write locks. */
export interface AutomationProofreadHost {
  prepareDocuments(args: { outputDir: string; reportPath: string; proposals: ReviewProposal[] }): Promise<AutomationProofreadDocument[]>;
  withStateLocks<T>(statePaths: string[], task: () => Promise<T>): Promise<T>;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
}
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function hash(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
async function optionalFile(file: string): Promise<Buffer | undefined> {
  try { return await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function assertOwnedParent(rootReal: string, file: string): Promise<void> {
  let parent = path.dirname(file);
  for (;;) {
    try {
      if (!within(rootReal, await realpath(parent))) throw new Error(`Project write parent resolves outside the project: ${file}.`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const ancestor = path.dirname(parent);
      if (ancestor === parent) throw error;
      parent = ancestor;
    }
  }
}
function dictionary(value: unknown, label: string): Record<string, unknown> {
  return value === undefined ? {} : object(value, label);
}
function readRevision(state: Record<string, unknown>, line: number): number {
  const revision = dictionary(state.revisions, "Line revisions")[String(line)] ?? 0;
  if (!Number.isInteger(revision) || Number(revision) < 0) throw new Error(`Invalid line revision on ${line}.`);
  return Number(revision);
}

function strictReportProposals(content: string): ReviewProposal[] {
  const report = object(JSON.parse(content), "Proofread report");
  if (report.schemaVersion !== "1.0" && report.schemaVersion !== "2.0") throw new Error("Only normalized proofreading findings JSON can be applied.");
  if (!Array.isArray(report.findings)) throw new Error("Proofread report must contain findings.");
  const rawFindings = report.findings;
  if (typeof report.generatedAt !== "string" || !report.generatedAt.trim()) throw new Error("Proofread report has no generation metadata.");
  if (report.schemaVersion === "2.0") {
    const scope = object(report.scope, "Folder proofreading scope");
    if (scope.kind !== "folder" || typeof scope.sourcePath !== "string" || !path.isAbsolute(scope.sourcePath)) throw new Error("Folder proofreading scope is invalid.");
  }
  for (const [index, value] of report.findings.entries()) {
    const finding = object(value, `Finding ${index + 1}`);
    const route = report.schemaVersion === "1.0" ? report : finding;
    for (const key of ["documentId", "sourcePath", "translationPath"]) {
      if (typeof route[key] !== "string" || !String(route[key]).trim()) throw new Error(`Finding ${index + 1} lacks ${key}.`);
    }
    if (!path.isAbsolute(String(route.sourcePath)) || !path.isAbsolute(String(route.translationPath))) throw new Error(`Finding ${index + 1} requires absolute source and translation bindings.`);
    for (const key of ["id", "severity", "type", "suggestedFix", "rationale"]) {
      if (typeof finding[key] !== "string" || !String(finding[key]).trim()) throw new Error(`Finding ${index + 1} has invalid ${key}.`);
    }
    for (const key of ["sourceText", "currentTranslation"]) if (typeof finding[key] !== "string") throw new Error(`Finding ${index + 1} has invalid ${key}.`);
    if (!Number.isInteger(finding.sourceLine) || Number(finding.sourceLine) < 1 || finding.translationLine !== finding.sourceLine) throw new Error(`Finding ${index + 1} has invalid aligned line numbers.`);
    if (finding.needsVerification === true || isMechanicalScanProposal(finding)) throw new Error(`Finding ${String(finding.id)} is not a finalized semantic replacement.`);
    if (finding.needsVerification !== undefined && typeof finding.needsVerification !== "boolean") throw new Error(`Finding ${String(finding.id)} has invalid verification metadata.`);
    if (finding.baseRevision !== undefined && (!Number.isInteger(finding.baseRevision) || Number(finding.baseRevision) < 0)) throw new Error(`Finding ${String(finding.id)} has invalid revision metadata.`);
    if (/[\r\n]/.test(String(finding.suggestedFix))) throw new Error(`Finding ${String(finding.id)} cannot insert extra lines.`);
  }
  const proposals = parseProofreadFindingsJson(content);
  if (proposals.length !== report.findings.length) throw new Error("Proofread report contains an unparseable finding.");
  proposals.forEach((proposal, index) => {
    const finding = rawFindings[index] as Record<string, unknown>;
    // Display normalization trims text; mutation binding must retain the exact Host evidence.
    proposal.src = String(finding.sourceText);
    proposal.current = String(finding.currentTranslation);
    proposal.oldText = finding.oldText === undefined ? proposal.current : String(finding.oldText);
    if (!proofreadSuggestedFixPreservesControlPrefix({ sourceText: proposal.src, currentTranslation: proposal.current, suggestedFix: proposal.suggestion })) throw new Error(`Finding ${proposal.id} has an unsafe control prefix.`);
  });
  return proposals;
}

export async function applyAutomationProofread(args: {
  outputDir: string;
  reportPath: string;
  expectedReportHash: string;
  signal?: AbortSignal;
}, host: AutomationProofreadHost) {
  args.signal?.throwIfAborted();
  if (!path.isAbsolute(args.outputDir) || !path.isAbsolute(args.reportPath)) throw new Error("Proofread application requires absolute project and report paths.");
  if (!/^[a-f0-9]{64}$/i.test(args.expectedReportHash)) throw new Error("Proofread application requires the finalized report SHA-256.");
  const root = path.basename(args.outputDir).toLowerCase() === ".translation-workshop" ? path.dirname(path.resolve(args.outputDir)) : path.resolve(args.outputDir);
  const workspace = path.join(root, ".translation-workshop");
  const rootReal = await realpath(root);
  if (!within(root, path.resolve(args.reportPath)) || !/\.json$/i.test(args.reportPath)) throw new Error("Proofread report must be project-owned findings JSON.");
  if (!within(rootReal, await realpath(args.reportPath))) throw new Error("Proofread report resolves outside the project.");
  const reportBytes = await readFile(args.reportPath);
  if (hash(reportBytes) !== args.expectedReportHash.toLowerCase()) throw new Error("Proofread report changed after finalization.");
  const proposals = strictReportProposals(reportBytes.toString("utf8"));
  if (proposals.length === 0) return { reportPath: args.reportPath, changedPaths: [], backupPaths: [], counts: { findings: 0, changedLines: 0, changedFiles: 0, alreadyApplied: 0 }, documents: [] };
  const documents = await host.prepareDocuments({ outputDir: root, reportPath: args.reportPath, proposals });
  const sourceRealPaths = await Promise.all(documents.map((document) => realpath(document.sourcePath)));
  const routed = new Map<string, AutomationProofreadDocument>();
  const targetPaths = new Set<string>();
  const statePaths = new Set<string>();
  for (const document of documents) {
    if (routed.has(document.documentId)) throw new Error(`Duplicate proofreading document route: ${document.documentId}.`);
    for (const field of ["sourcePath", "translationPath", "lineReviewPath", "statePath"] as const) if (!path.isAbsolute(document[field])) throw new Error(`Host returned a relative ${field}.`);
    if (!/\.txt$/i.test(document.translationPath)) throw new Error("Proofreading requires a bound translation TXT reference.");
    if (!within(path.join(workspace, "state"), document.statePath) || !/\.json$/i.test(document.statePath) || !within(workspace, document.lineReviewPath)) throw new Error("Host returned a line-review state outside the project workspace.");
    await assertOwnedParent(rootReal, document.statePath);
    const targetInfo = await stat(document.translationPath);
    if (!targetInfo.isFile()) throw new Error("Bound proofreading translation must be a readable file.");
    const targetReal = await realpath(document.translationPath);
    if (sourceRealPaths.some((source) => samePath(source, targetReal))) throw new Error("Proofreading translation binding cannot reference a source file.");
    const key = path.resolve(document.translationPath).toLowerCase();
    const stateKey = path.resolve(document.statePath).toLowerCase();
    if (targetPaths.has(key) || statePaths.has(stateKey)) throw new Error("Proofreading document routes overlap.");
    targetPaths.add(key); statePaths.add(stateKey); routed.set(document.documentId, document);
  }
  for (const proposal of proposals) {
    const document = routed.get(proposal.documentId ?? "");
    if (!document || !samePath(document.sourcePath, proposal.sourcePath ?? "") || !samePath(document.translationPath, proposal.translationPath ?? "")) throw new Error(`Finding ${proposal.id} does not match the authoritative translation binding.`);
  }
  const lockCandidates = async <T>(files: string[], work: () => Promise<T>): Promise<T> => files.length ? withTranslationCandidateLock(files[0], () => lockCandidates(files.slice(1), work)) : work();
  return host.withStateLocks(documents.map((document) => document.statePath).sort(), () => lockCandidates(documents.map((document) => document.translationPath).sort(), async () => {
    args.signal?.throwIfAborted();
    if (hash(await readFile(args.reportPath)) !== args.expectedReportHash.toLowerCase()) throw new Error("Proofread report changed before application.");
    const updates: Array<{ targetPath: string; text: string }> = [];
    const snapshots: Array<{ targetPath: string; previous?: Buffer }> = [];
    const referenceSnapshots: Array<{ path: string; bytes: Buffer }> = [];
    const committed: Array<{ lineReviewPath: string; statePath: string; state: Record<string, unknown>; changedLines: number[] }> = [];
    let changedLines = 0;
    let alreadyApplied = 0;
    for (const document of documents) {
      const sourceBytes = await readFile(document.sourcePath);
      referenceSnapshots.push({ path: document.sourcePath, bytes: sourceBytes });
      const translationBytes = await readFile(document.translationPath);
      referenceSnapshots.push({ path: document.translationPath, bytes: translationBytes });
      const sourceLines = splitTextLines(sourceBytes.toString("utf8"));
      const translationText = translationBytes.toString("utf8");
      const originalLines = splitTextLines(translationText);
      const lines = [...originalLines];
      if (sourceLines.length !== lines.length) throw new Error(`Aligned line counts changed for ${document.documentId}.`);
      const stateBytes = await optionalFile(document.statePath);
      if (stateBytes !== undefined) {
        const info = await lstat(document.statePath);
        if (!info.isFile() || info.isSymbolicLink() || !within(rootReal, await realpath(document.statePath))) throw new Error("Line-review sidecar is not a project-owned regular file.");
      }
      const state = stateBytes === undefined ? {} : object(JSON.parse(stateBytes.toString("utf8")), "Line-review state");
      state.edits = { ...dictionary(state.edits, "Line edits") };
      state.status = { ...dictionary(state.status, "Line status") };
      state.revisions = { ...dictionary(state.revisions, "Line revisions") };
      state.revisionHistory = { ...dictionary(state.revisionHistory, "Line history") };
      for (const [key, value] of Object.entries(dictionary(state.edits, "Line edits"))) {
        const line = Number(key);
        if (!Number.isInteger(line) || line < 1 || line > lines.length || typeof value !== "string") throw new Error(`Invalid line-review edit on line ${key}.`);
        lines[line - 1] = value;
      }
      const changed: number[] = [];
      const replacements = new Map<number, string>();
      for (const proposal of proposals.filter((item) => item.documentId === document.documentId)) {
        const line = Number(proposal.line);
        const newText = proposal.suggestion.trim();
        const index = line - 1;
        const history = dictionary(state.revisionHistory, "Line history")[String(line)];
        if (history !== undefined && !Array.isArray(history)) throw new Error(`Invalid revision history on line ${line}.`);
        const edits = dictionary(state.edits, "Line edits");
        const currentText = edits[String(line)] === undefined ? originalLines[index] : edits[String(line)];
        if (typeof currentText !== "string") throw new Error(`Finding ${proposal.id} has no aligned current translation.`);
        const last = Array.isArray(history) ? history.at(-1) : undefined;
        const revision = readRevision(state, line);
        const appliedEdit = last?.source === "proposal-apply" && last?.text === currentText && last?.revision === revision;
        if (last?.source === "desktop-edit" || (edits[String(line)] !== undefined && !appliedEdit && (currentText !== originalLines[index] || dictionary(state.status, "Line status")[String(line)] === "manual"))) throw new Error(`Finding ${proposal.id} conflicts with a pending manual line-review edit (manual-edit).`);
        if (proposal.src !== sourceLines[index]) throw new Error(`Finding ${proposal.id} has stale source text.`);
        const baselineMatches = proposal.current === originalLines[index] && (proposal.oldText === undefined || proposal.oldText === originalLines[index]);
        if (!baselineMatches && !(appliedEdit && originalLines[index] === newText)) throw new Error(`Finding ${proposal.id} has stale translation text.`);
        if (currentText === newText) { alreadyApplied += 1; continue; }
        if (currentText !== originalLines[index]) throw new Error(`Finding ${proposal.id} conflicts with an existing applied HTML suggestion.`);
        const safety = checkProposalSafety({ sourceText: proposal.src, rowSource: sourceLines[index], rowExists: index >= 0 && index < sourceLines.length, currentText, intendedText: newText, oldText: proposal.oldText ?? proposal.current, revision, baseRevision: proposal.baseRevision, lastRevisionSource: last?.source });
        if (!safety.ok) throw new Error(`Finding ${proposal.id} failed proposal safety: ${safety.reason}.`);
        const prior = replacements.get(line);
        if (prior !== undefined && prior !== newText) throw new Error(`Conflicting finalized findings target line ${line} of ${document.documentId}.`);
        replacements.set(line, newText);
      }
      for (const [line, newText] of replacements) {
        lines[line - 1] = newText;
        const key = String(line);
        const revision = readRevision(state, line) + 1;
        dictionary(state.edits, "Line edits")[key] = newText;
        dictionary(state.status, "Line status")[key] = "manual";
        dictionary(state.revisions, "Line revisions")[key] = revision;
        const histories = dictionary(state.revisionHistory, "Line history");
        histories[key] = [...(Array.isArray(histories[key]) ? histories[key] : []), { revision, text: newText, status: "manual", source: "proposal-apply" }].slice(-12);
        changed.push(line);
      }
      if (!changed.length) continue;
      const validation = validateTranslationCandidate(sourceLines.join("\n"), lines.join("\n"), document.validationOptions);
      if (!validation.ok) throw new Error(`Applied proofreading fails translation validation for ${document.documentId}: ${validation.blocking.map((finding) => `${finding.line}:${finding.code}`).join(", ")}.`);
      updates.push({ targetPath: document.statePath, text: `${JSON.stringify(state, null, 2)}\n` });
      snapshots.push({ targetPath: document.statePath, previous: stateBytes });
      committed.push({ lineReviewPath: document.lineReviewPath, statePath: document.statePath, state, changedLines: changed });
      changedLines += changed.length;
    }
    for (const snapshot of snapshots) if (snapshot.previous !== undefined && !snapshot.previous.equals(await readFile(snapshot.targetPath))) throw new Error(`File changed during proofreading application: ${snapshot.targetPath}.`);
    for (const reference of referenceSnapshots) if (!reference.bytes.equals(await readFile(reference.path))) throw new Error(`Read-only reference changed during proofreading application: ${reference.path}.`);
    if (hash(await readFile(args.reportPath)) !== args.expectedReportHash.toLowerCase()) throw new Error("Proofread report changed during application.");
    const createdStates: string[] = [];
    args.signal?.throwIfAborted();
    try {
      for (const snapshot of snapshots) if (snapshot.previous === undefined) {
        await mkdir(path.dirname(snapshot.targetPath), { recursive: true });
        await writeFile(snapshot.targetPath, "", { flag: "wx" });
        createdStates.push(snapshot.targetPath);
      }
      await writeTextFilesAtomically(updates);
    } catch (error) {
      const failures: unknown[] = [error];
      for (const statePath of createdStates) try { await rm(statePath, { force: true }); } catch (cleanupError) { failures.push(cleanupError); }
      if (failures.length > 1) throw new AggregateError(failures, "Proofread commit failed and sidecar cleanup failed.");
      throw error;
    }
    return { reportPath: args.reportPath, changedPaths: committed.map((item) => item.statePath), backupPaths: [], counts: { findings: proposals.length, changedLines, changedFiles: committed.length, alreadyApplied }, documents: committed };
  }));
}
