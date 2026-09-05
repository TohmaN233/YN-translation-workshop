import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { renderProposalReviewHtml } from "../../src/shared/core/html.ts";

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

await test("proposal review all issue filter uses an empty value", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  assert.match(source, /const label = value \|\| \(data\.labels\.allIssueTypes \|\| "All issue types"\);/);
  assert.match(source, /const typeMatches = !type \|\| code === type \|\| severity === type;/);
});

await test("accepting one proposal only removes that proposal issue marker", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  assert.match(
    source,
    /function removeReviewIssues[\s\S]*?const next = issues\.filter\(issue => issue\.source !== source \|\| issue\.proposalId !== proposalId\);/
  );
});

await test("proposal apply detects stale target text before overwriting line review edits", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  assert.match(source, /function currentLineReviewText\(row, lineState, line\)/);
  assert.match(source, /const currentText = currentLineReviewText\(row, lineState, line\);/);
  assert.match(source, /textSimilarity\(oldText, currentText\) < 0\.8/);
  assert.match(source, /return \{ ok: false, reason: "patch-conflict" \};/);
  assert.match(source, /state\.decisions\[item\.id\] = \{[\s\S]*conflictCurrentText: currentProposalLineText\(item, target\.lineState, lineRows\),[\s\S]*conflictCurrentRevision: lineReviewRevision\(target\.lineState, line\),[\s\S]*conflictRevisionHistory: lineReviewRevisionHistory\(target\.lineState, line\)/);
});

await test("folder proposal review filters by document and routes jump/apply through document-aware Host APIs", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  const preload = await readFile("src/main/preload.ts", "utf8");
  const main = await readFile("src/main/main.ts", "utf8");
  assert.match(source, /id="documentFilter"/);
  assert.match(source, /function documentFilterOptions\(\)/);
  assert.match(source, /const documentMatches = !documentId \|\| proposalDocumentKey\(item\) === documentId;/);
  assert.match(source, /proposalDocumentLabel\(item\)/);
  assert.match(source, /bridge\?\.resolveProposalLineReviewDocument/);
  assert.match(source, /bridge\?\.prepareProposalLineReviewBatch/);
  assert.match(source, /bridge\?\.applyProposalLineReviewStates/);
  assert.match(source, /groupProposalsByDocument/);
  assert.match(preload, /html:resolveProposalLineReviewDocument/);
  assert.match(preload, /html:prepareProposalLineReviewBatch/);
  assert.match(preload, /html:applyProposalLineReviewStates/);
  assert.match(main, /ipcMain\.handle\("html:resolveProposalLineReviewDocument"/);
  assert.match(main, /ipcMain\.handle\("html:prepareProposalLineReviewBatch"/);
  assert.match(main, /ipcMain\.handle\("html:applyProposalLineReviewStates"/);
  assert.match(main, /writeTextFilesAtomically/);
  assert.match(main, /await assertLineReviewMatchesProposalRouting\(requestedLineReviewPath, routing\);/);
  assert.match(main, /const needsLoad = upgradedOnDisk \|\| repairedOnDisk \|\|/);
  assert.match(main, /const openRouting = metadataOnly[\s\S]*?await openLineReviewRouting\(requestedLineReviewPath\)/);
  assert.match(main, /const document = metadataOnly && openRouting[\s\S]*?rows: \[\],[\s\S]*?state: \{\},/);
  assert.doesNotMatch(main, /html\.includes\('id="reviewData"'\)/, "proposal scripts mention reviewData and must not be misclassified as line-review documents");
});

await test("proposal LAN controls expose only the selected primary address", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  const occurrences = source.match(/if \(lanUrls\[0\]\) \{/g) ?? [];
  assert.equal(occurrences.length, 2, "line and proposal review must both show one selected LAN address");
  assert.doesNotMatch(source, /lanUrls\.forEach\(\(url, index\) =>/);
});

await test("folder proposal cards expose their document without changing single-file cards", () => {
  const html = renderProposalReviewHtml({
    title: "folder proofread",
    proposals: [{
      id: "H1-001",
      documentId: "nested/chapter-a.txt",
      sourcePath: "D:\\project\\source\\nested\\chapter-a.txt",
      translationPath: "D:\\project\\AI_translation\\nested\\chapter-a_translated.txt",
      line: 12,
      src: "source",
      current: "译文",
      problemType: "H1 accuracy",
      problem: "issue",
      suggestion: "修订译文",
      status: "unreviewed"
    }]
  });
  assert.match(html, /id="documentFilter"/);
  assert.match(html, /nested\/chapter-a\.txt/);
});

await test("mechanical scan cards support confirm or false-positive decisions without applying text", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  assert.match(source, /function isMechanicalScan\(item\)/);
  assert.match(source, /data-mechanical-action="confirm"/);
  assert.match(source, /data-mechanical-action="false-positive"/);
  assert.match(source, /lineState\.auditWhitelist\[line\] = true/);
  assert.match(source, /removeMechanicalScanIssue\(lineState, line, item\.id\)/);
  assert.match(source, /writeAuditWhitelistFile/);
  assert.match(source, /lineReviewPath: data\.lineReviewPath/);
  assert.match(source, /lineState/);
  assert.match(source, /changedLines: \[line\]/);
  assert.match(source, /if \(isMechanicalScan\(item\)\) return "";/);
});

await test("mechanical false-positive persistence is one atomic main-process transaction", async () => {
  const htmlSource = await readFile("src/shared/core/html.ts", "utf8");
  const mainSource = await readFile("src/main/main.ts", "utf8");
  assert.match(htmlSource, /async function toggleAuditWhitelistLine\(line\)/);
  assert.match(htmlSource, /removeMechanicalAuditIssues\(state, line\)/);
  assert.match(htmlSource, /lineReviewPath: data\.lineReviewPath/);
  assert.match(htmlSource, /lineState: state/);
  assert.match(htmlSource, /changedLines: \[line\]/);
  assert.match(mainSource, /writeTextFilesAtomically/);
  assert.match(mainSource, /lineReviewPath\?: string/);
  assert.match(mainSource, /lineState\?: unknown/);
  assert.match(mainSource, /changedLines\?: number\[\]/);
});

await test("mechanical ownership is defensive for legacy proposal shapes", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  assert.match(source, /function isMechanicalScan\(item\)[\s\S]*?\^M0\(\?:-\|\$\)/);
  assert.match(source, /String\(item\?\.problemType \|\| ""\)/);
});

await test("proposal apply reads the linked line review canonical rowValue and state", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  const mainSource = await readFile("src/main/main.ts", "utf8");
  assert.match(source, /bridge\?\.readLineReviewDocument/);
  assert.match(source, /const linkedDocument = await readLinkedLineReviewDocument\(candidates\[0\]\);/);
  assert.match(source, /const baseTarget = readLineReviewState\(linkedDocument\?\.state, linkedDocument\?\.lineReviewPath \|\| data\.lineReviewPath\)/);
  assert.match(source, /const target = cloneLineReviewTarget\(baseTarget\);/);
  assert.match(source, /const lineRows = linkedDocument\?\.rows \|\| \[\];/);
  assert.match(source, /function reconcileStoredProposalConflicts\(lineState, rows, documentKey = "", setDecision/);
  assert.match(source, /proposalDocumentKey\(item\) \|\| "__single__"\) !== documentKey/);
  assert.match(source, /if \(!proposalSafetyCheck\(item, lineState, rows\)\.ok\) continue;/);
  assert.match(source, /setDecision\(item\.id, \{ status: "accepted", manualText: "" \}\);/);
  assert.match(mainSource, /await loadHtmlViewerTab\(normalizedPath\);/);
  assert.doesNotMatch(mainSource, /loadHtmlViewerTab\([^)]*, \{ attach:/);
});

await test("cross-file one-click apply includes unreviewed suggestions and publishes state after Host commit", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  const applyStart = source.indexOf("function applyProposalChanges()");
  const applyEnd = source.indexOf('cards.addEventListener("click"', applyStart);
  const applySource = source.slice(applyStart, applyEnd);
  assert.match(applySource, /const candidates = group\.items\.filter/);
  assert.match(applySource, /decisionForProposalApply\(item\)/);
  assert.match(applySource, /decision\.status === "accepted" \|\| decision\.status === "manual"/);
  assert.match(applySource, /if \(candidates\.length === 0\) continue;/);
  assert.match(applySource, /readLinkedLineReviewDocument\(candidates\[0\]\)/);
  assert.match(applySource, /rollbackProposalDecisionChanges/);
  assert.doesNotMatch(applySource, /state\.decisions = decisionsBefore/);
  assert.match(applySource, /proposalApplyInFlight/);
  assert.match(applySource, /prepareProposalLineReviewBatch/);
  assert.match(applySource, /linkedLineReviewDocumentPromises\.clear\(\)/);
  assert.match(applySource, /if \(prepared\?\.ok === false\)/);
  assert.match(applySource, /traceProposalApply\("committed"/);

  const buttonStart = source.indexOf("async function applyProposalChangesFromButton()", applyStart);
  const buttonEnd = source.indexOf('cards.addEventListener("click"', buttonStart);
  const buttonSource = source.slice(buttonStart, buttonEnd);
  assert.match(buttonSource, /button\.disabled = true/);
  assert.match(buttonSource, /await applyProposalChanges\(\)/);
  assert.match(buttonSource, /proposalApplyFailed/);
  assert.match(buttonSource, /button\.disabled = false/);

  const persistStart = source.indexOf("async function persistProposalDocumentStates(commits)");
  const persistEnd = source.indexOf("async function connectLineReview()", persistStart);
  const persistSource = source.slice(persistStart, persistEnd);
  const hostCommit = persistSource.indexOf("bridge.applyProposalLineReviewStates");
  const localPublish = persistSource.indexOf("localStorage.setItem");
  assert.ok(hostCommit >= 0 && localPublish > hostCommit, "line state must not publish locally before the Host transaction");
  assert.match(persistSource, /if \(!bridge\?\.applyProposalLineReviewStates\) \{/);
  assert.match(persistSource, /throw new Error\("Atomic proposal apply requires the Electron Host transaction API\."\);/);
  assert.doesNotMatch(persistSource, /persistLineReviewState\(/, "cross-file proposal apply must not fall back to partial per-document writes");
});

await test("proposal apply only treats the exact normalized suggestion as already applied", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  const safetyStart = source.indexOf("function proposalSafetyCheck(");
  const safetyEnd = source.indexOf("function reconcileStoredProposalConflicts(", safetyStart);
  const safetySource = source.slice(safetyStart, safetyEnd);
  assert.match(safetySource, /comparableText\(intendedText\) === comparableText\(currentText\)/);
  assert.doesNotMatch(safetySource, /textSimilarity\(intendedText, currentText\)\s*>?=/);
});

await test("proposal review exposes conflict resolution actions without bypassing source checks", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  assert.match(source, /function conflictControls\(item, decision\)/);
  assert.match(source, /id="conflictSummary"/);
  assert.match(source, /function renderConflictSummary\(\)/);
  assert.match(source, /data-conflict-jump=/);
  assert.match(source, /data-conflict-action="keep-current"/);
  assert.match(source, /data-conflict-action="accept-agent"/);
  assert.match(source, /data-conflict-action="manual-merge"/);
  assert.match(source, /function conflictMergePane\(label, value, kind/);
  assert.match(source, /function conflictDiffHtml\(value, compareValue, kind\)/);
  assert.match(source, /function conflictHistoryHtml\(item, decision\)/);
  assert.match(source, /function lineReviewRevisionHistory\(lineState, line\)/);
  assert.match(source, /function recordTargetLineRevision\(lineState, line, text, status, source\)/);
  assert.match(source, /conflict-diff-old/);
  assert.match(source, /conflict-diff-new/);
  assert.match(source, /conflict-history/);
  assert.match(source, /data-conflict-preview=/);
  assert.match(source, /function currentProposalLineText\(item, lineState, rows\)/);
  assert.match(source, /function proposalSafetyCheck\(item, lineState, rows, options = \{\}\)/);
  assert.match(source, /reason: "manual-edit"/);
  assert.match(source, /intendedText: text/);
  assert.match(source, /decision\.status === "manual"/);

  assert.match(source, /if \(sourceScore < 0\.8\) return \{ ok: false, reason: "source-mismatch" \};[\s\S]*if \(options\.allowStaleTarget === true\) return \{ ok: true, reason: "" \};/);
  assert.match(source, /allowStaleTarget: decision\.status === "manual" \|\| decision\.overrideConflict === true/);
  assert.match(source, /conflictCurrentText: currentProposalLineText\(item, target\.lineState, lineRows\)/);
  assert.match(source, /conflictRevisionHistory: lineReviewRevisionHistory\(target\.lineState, line\)/);
  assert.match(source, /rawDecision = \{ \.\.\.previous, status: "accepted", manualText: "", overrideConflict: true \};/);
  assert.match(source, /rawDecision = \{ \.\.\.previous, status: "manual", manualText: textarea\?\.value \|\| proposalSuggestionText\(item\), overrideConflict: true \};/);
});

await test("proposal review LAN sync preserves conflict override decisions", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  assert.match(source, /overrideConflict: patch\.overrideConflict === true/);
  assert.match(source, /conflictReason: patch\.conflictReason \|\| ""/);
  assert.match(source, /overrideConflict: rawDecision\.overrideConflict === true/);
  assert.match(source, /function storeProposalStateLocally\(\)/);
  const proposalScriptStart = source.indexOf("function proposalReviewScript()");
  const remoteStart = source.indexOf("function applyRemoteLanSyncPatch(payload)", proposalScriptStart);
  const remoteEnd = source.indexOf("function applyRemoteLanSyncCommand(payload)", remoteStart);
  assert.ok(remoteStart >= 0 && remoteEnd > remoteStart);
  const remoteSource = source.slice(remoteStart, remoteEnd);
  assert.match(remoteSource, /storeProposalStateLocally\(\)/);
  assert.doesNotMatch(remoteSource, /\bsave\(\)/, "a committed remote decision must not start a second sidecar write");
});

await test("proposal review rejects duplicate LAN Start while active or transitioning", async () => {
  const source = await readFile("src/shared/core/html.ts", "utf8");
  const proposalScriptStart = source.indexOf("function proposalReviewScript()");
  const start = source.indexOf("async function startLanSync()", proposalScriptStart);
  const end = source.indexOf("function reportProposalLanSyncFailure", start);
  assert.ok(start >= 0 && end > start);
  const startSource = source.slice(start, end);
  assert.match(startSource, /if \(lanSyncToken \|\| lanSyncStarting \|\| lanSyncStopping\) return;/);
  assert.match(startSource, /lanSyncStarting = true;/);
  assert.match(startSource, /lanSyncStarting = false;/);
});

await test("proposal review initializes conflict cards in a minimal DOM", async () => {
  const html = renderProposalReviewHtml({
    title: "proposal runtime test",
    lineReviewPath: "C:\\work\\line-review.html",
    proposals: [{
      id: "H3-999",
      documentId: "chapter-a.txt",
      sourcePath: "C:\\work\\chapter-a.txt",
      translationPath: "C:\\work\\chapter-a_translated.txt",
      line: 1,
      src: "岡部は言った。",
      current: "旧译文",
      oldText: "旧译文",
      baseRevision: 1,
      problemType: "H3 terminology",
      problem: "术语不一致",
      suggestion: "新译文",
      status: "conflict"
    }, {
      id: "M1-001",
      documentId: "chapter-b.txt",
      sourcePath: "C:\\work\\chapter-b.txt",
      translationPath: "C:\\work\\chapter-b_translated.txt",
      line: 2,
      src: "別の原文",
      current: "另一条旧译文",
      oldText: "另一条旧译文",
      baseRevision: 0,
      problemType: "M1 fluency",
      problem: "表达生硬",
      suggestion: "另一条新译文",
      status: "unreviewed"
    }, {
      id: "M0-012",
      documentId: "chapter-b.txt",
      sourcePath: "C:\\work\\chapter-b.txt",
      translationPath: "C:\\work\\chapter-b_translated.txt",
      line: 3,
      src: "Two source sentences. Another sentence.",
      current: "一个译句。",
      oldText: "一个译句。",
      problemType: "M0 mechanical_scan",
      problem: "Possible sentence boundary mismatch.",
      suggestion: "一个译句。",
      kind: "mechanical_scan",
      needsVerification: true,
      status: "unreviewed"
    }, {
      id: "H2-004",
      documentId: "chapter-c.txt",
      sourcePath: "C:\\work\\chapter-c.txt",
      translationPath: "C:\\work\\chapter-c_translated.txt",
      line: 1,
      src: "未处理原文",
      current: "未处理旧译",
      oldText: "未处理旧译",
      problemType: "H2 omission",
      problem: "未处理问题",
      suggestion: "自动应用译文",
      status: "unreviewed"
    }]
  });
  const dataMatch = html.match(/<script id="proposalData" type="application\/json">([\s\S]*?)<\/script>/i);
  const scriptMatch = html.match(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(dataMatch, "expected proposal JSON data");
  assert.ok(scriptMatch, "expected proposal review script");

  class FakeElement {
    constructor(id = "") {
      this.id = id;
      this.value = "";
      this.textContent = "";
      this.dataset = {};
      this.style = { setProperty() {} };
      this.options = [];
      this.hidden = false;
      this.onclick = null;
      this.listeners = new Map();
    }
    set innerHTML(value) {
      this._innerHTML = String(value);
      if (this.id === "issueFilter" || this.id === "documentFilter") {
        this.options = [...this._innerHTML.matchAll(/<option value="([^"]*)"/g)].map(match => ({ value: match[1] }));
      }
    }
    get innerHTML() {
      return this._innerHTML || "";
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    focus() {}
  }

  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  element("proposalData").textContent = dataMatch[1];
  const resolvedDocuments = [];
  const appliedDocuments = [];
  const openedPaths = [];
  const context = {
    document: {
      title: "proposal runtime test",
      documentElement: { lang: "zh-CN", style: { setProperty() {} } },
      body: new FakeElement("body"),
      getElementById: element,
      querySelectorAll: () => []
    },
    window: {},
    workshopHtml: {
      openPath: async (targetPath) => { openedPaths.push(targetPath); },
      resolveProposalLineReviewDocument: async (args) => {
        resolvedDocuments.push({ documentId: args.documentId, includeRows: args.includeRows !== false });
        const chapterB = args.documentId === "chapter-b.txt";
        const chapterC = args.documentId === "chapter-c.txt";
        return {
          rows: chapterB
            ? [{ line: 2, source: "別の原文", translation: "另一条旧译文" }]
            : chapterC
              ? [{ line: 1, source: "未处理原文", translation: "未处理旧译" }]
              : [{ line: 1, source: "岡部は言った。", translation: "旧译文" }],
          state: {},
          lineReviewPath: `C:\\work\\${args.documentId}.html`
        };
      },
      applyProposalLineReviewStates: async ({ documents }) => {
        appliedDocuments.push(...documents.map((document) => JSON.parse(JSON.stringify(document))));
        return {
          ok: true,
          documents: documents.map((document) => ({
            lineReviewPath: document.lineReviewPath,
            state: document.lineState
          }))
        };
      }
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    location: { pathname: "/proposal-runtime-test.html", protocol: "http:", href: "http://127.0.0.1/proposal-runtime-test.html" },
    console: { warn() {}, error() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    Blob: class {},
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout() {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    addEventListener() {},
    scrollTo() {},
    scrollY: 0
  };
  context.window = context;

  vm.runInNewContext(scriptMatch[1], context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resolvedDocuments, [], "opening a report without stored conflicts must not preload its complete linked document");
  await vm.runInContext("jumpToLineReviewLine(data.proposals.find((item) => item.documentId === 'chapter-b.txt'))", context);
  assert.deepEqual(
    resolvedDocuments,
    [{ documentId: "chapter-b.txt", includeRows: false }],
    "jumping to one source line must request metadata without loading every linked row"
  );
  assert.deepEqual(openedPaths, ["C:\\work\\chapter-b.txt.html#line=2"]);
  resolvedDocuments.length = 0;
  await vm.runInContext("applyProposalChanges()", context);
  assert.deepEqual(
    resolvedDocuments.map((request) => request.documentId).sort(),
    ["chapter-b.txt", "chapter-c.txt"],
    "one-click apply must resolve every unreviewed suggestion while skipping conflicts and mechanical evidence"
  );
  assert.ok(resolvedDocuments.every((request) => request.includeRows), "proposal application must still request complete rows for safety checks");
  assert.equal(
    await vm.runInContext(`(async () => (await linkedLineReviewDocumentPromises.get("chapter-b.txt:rows"))?.state?.edits?.[2])()`, context),
    "另一条新译文",
    "a successful Host commit must replace the canonical cached line state"
  );
  assert.equal(
    await vm.runInContext(`(async () => (await linkedLineReviewDocumentPromises.get("chapter-c.txt:rows"))?.state?.edits?.[1])()`, context),
    "自动应用译文",
    "one-click apply must commit an untouched folder document suggestion"
  );
  resolvedDocuments.length = 0;
  appliedDocuments.length = 0;
  vm.runInContext(`
    state.decisions["M1-001"] = { status: "rejected", manualText: "" };
    state.decisions["H2-004"] = { status: "rejected", manualText: "" };
    data.proposals.push({
      id: "M1-002",
      documentId: "chapter-b.txt",
      sourcePath: "C:\\work\\chapter-b.txt",
      translationPath: "C:\\work\\chapter-b_translated.txt",
      line: 2,
      src: "別の原文",
      current: "另一条新译文",
      oldText: "另一条新译文",
      baseRevision: 1,
      problemType: "M1 fluency",
      problem: "second sequential proposal",
      suggestion: "另一条最终译文",
      status: "unreviewed"
    });
    state.decisions["M1-002"] = { status: "accepted", manualText: "" };
  `, context);
  await vm.runInContext("applyProposalChanges()", context);
  assert.equal(appliedDocuments.length, 1, "a second proposal for the same line must commit against the first saved state");
  assert.equal(appliedDocuments[0].lineState.edits[2], "另一条最终译文");
  assert.equal(appliedDocuments[0].expectedLineRevisions[2], 1);

  let rejectProposalApply;
  let failedApplyCalls = 0;
  context.window.workshopHtml.applyProposalLineReviewStates = async () => {
    failedApplyCalls += 1;
    return await new Promise((resolve, reject) => { rejectProposalApply = reject; });
  };
  vm.runInContext('state.decisions["H2-004"] = { status: "accepted", manualText: "" }', context);
  const failedApply = vm.runInContext("applyProposalChanges()", context);
  while (!rejectProposalApply) await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext(`
    lanSyncToken = "proposal-concurrent";
    applyRemoteLanSyncPatch({
      token: "proposal-concurrent",
      patch: { type: "proposal-decision", proposalId: "REMOTE-ONLY", status: "rejected", manualText: "" }
    });
  `, context);
  rejectProposalApply(new Error("host write failed"));
  await assert.rejects(Promise.resolve(failedApply), /host write failed/i);
  assert.equal(failedApplyCalls, 1);
  assert.equal(
    vm.runInContext('state.decisions["REMOTE-ONLY"]?.status', context),
    "rejected",
    "a Host failure must not erase a concurrent LAN/user decision"
  );

  let resolveLockedApply;
  let lockedApplyCalls = 0;
  context.window.workshopHtml.applyProposalLineReviewStates = async ({ documents }) => {
    lockedApplyCalls += 1;
    return await new Promise((resolve) => {
      resolveLockedApply = () => resolve({
        ok: true,
        documents: documents.map((document) => ({
          lineReviewPath: document.lineReviewPath,
          state: document.lineState
        }))
      });
    });
  };
  const firstLockedApply = vm.runInContext("applyProposalChanges()", context);
  const secondLockedApply = vm.runInContext("applyProposalChanges()", context);
  while (!resolveLockedApply) await new Promise((resolve) => setImmediate(resolve));
  resolveLockedApply();
  await Promise.all([Promise.resolve(firstLockedApply), Promise.resolve(secondLockedApply)]);
  assert.equal(lockedApplyCalls, 1, "double-clicking Apply must share one Host transaction");
  const alreadyApplied = context.proposalSafetyCheck(
    {
      id: "H3-999",
      line: 1,
      src: "岡部は言った。",
      current: "旧译文",
      oldText: "旧译文",
      baseRevision: 1,
      suggestion: "新译文"
    },
    {
      edits: { 1: "新译文" },
      revisions: { 1: 2 },
      revisionHistory: {}
    },
    [{ line: 1, source: "岡部は言った。", translation: "旧译文" }]
  );
  assert.deepEqual(
    { ok: alreadyApplied.ok, alreadyApplied: alreadyApplied.alreadyApplied },
    { ok: true, alreadyApplied: true },
    "reopening an already-applied suggestion must resolve idempotently instead of becoming patch-conflict"
  );
  const customManual = context.proposalSafetyCheck(
    {
      id: "H3-777",
      line: 1,
      src: "岡部は言った。",
      current: "新译文",
      oldText: "旧译文",
      suggestion: "新译文"
    },
    {
      edits: { 1: "新译文" },
      status: { 1: "manual" },
      revisions: { 1: 2 },
      revisionHistory: {}
    },
    [{ line: 1, source: "岡部は言った。", translation: "旧译文" }],
    { allowStaleTarget: true, intendedText: "我手改后的译文" }
  );
  assert.equal(customManual.alreadyApplied, undefined);
  assert.equal(customManual.ok, true, "a later manual replacement must not be treated as already-applied official suggestion");
  const manualProtected = context.proposalSafetyCheck(
    {
      id: "H3-888",
      line: 1,
      src: "岡部は言った。",
      current: "旧译文",
      oldText: "旧译文",
      suggestion: "新译文"
    },
    {
      edits: { 1: "我手改后的译文" },
      status: { 1: "manual" },
      revisions: { 1: 3 },
      revisionHistory: { 1: [{ revision: 3, text: "我手改后的译文", status: "manual", source: "desktop-edit" }] }
    },
    [{ line: 1, source: "岡部は言った。", translation: "旧译文" }]
  );
  assert.deepEqual(
    { ok: manualProtected.ok, reason: manualProtected.reason },
    { ok: false, reason: "manual-edit" },
    "re-applying accepted suggestions must not overwrite a later line-review manual edit"
  );
  const cardsHtml = element("cards").innerHTML;
  const conflictSummaryHtml = element("conflictSummary").innerHTML;
  assert.match(cardsHtml, /data-conflict-action="keep-current"/);
  assert.match(cardsHtml, /data-conflict-action="accept-agent"/);
  assert.match(cardsHtml, /data-conflict-action="manual-merge"/);
  assert.match(cardsHtml, /data-conflict-preview="source"/);
  assert.match(cardsHtml, /data-conflict-preview="current"/);
  assert.match(cardsHtml, /data-conflict-preview="agent"/);
  assert.match(cardsHtml, /conflict-diff-old/);
  assert.match(cardsHtml, /conflict-diff-new/);
  assert.match(cardsHtml, /版本历史/);
  assert.match(cardsHtml, /base r1/);
  assert.match(cardsHtml, /岡部は言った。/);
  assert.match(cardsHtml, /旧译文/);
  assert.match(cardsHtml, /新译文/);
  const mechanicalCard = cardsHtml.match(/<article class="card mechanical-scan-card"[^>]*data-id="M0-012"[\s\S]*?<\/article>/)?.[0] || "";
  assert.match(mechanicalCard, /机械扫描/);
  assert.match(mechanicalCard, /data-mechanical-action="confirm"/);
  assert.match(mechanicalCard, /data-mechanical-action="false-positive"/);
  assert.doesNotMatch(mechanicalCard, /<textarea|建议译文/);
  assert.match(conflictSummaryHtml, /H3-999/);
  assert.match(conflictSummaryHtml, /data-conflict-jump="H3-999"/);

  const issueFilter = element("issueFilter");
  issueFilter.value = "H3";
  issueFilter.onchange();
  assert.match(element("cards").innerHTML, /H3-999/);
  assert.doesNotMatch(element("cards").innerHTML, /M1-001/);

  issueFilter.value = "";
  issueFilter.onchange();
  assert.match(element("cards").innerHTML, /H3-999/);
  assert.match(element("cards").innerHTML, /M1-001/);

  const documentFilter = element("documentFilter");
  documentFilter.value = "chapter-b.txt";
  documentFilter.onchange();
  assert.doesNotMatch(element("cards").innerHTML, /H3-999/);
  assert.match(element("cards").innerHTML, /M1-001/);
  documentFilter.value = "";
  documentFilter.onchange();

  let canonicalStateWrites = 0;
  context.window.workshopHtml = {
    persistHtmlState: async () => {
      canonicalStateWrites += 1;
      return { ok: true };
    }
  };
  context.localStorage.setItem = () => { throw new Error("local storage blocked"); };
  vm.runInContext("save()", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(canonicalStateWrites, 1, "a localStorage failure must not block canonical Host persistence");
  assert.match(element("proposalStatus").textContent, /local storage blocked/i);

  context.localStorage.setItem = () => {};
  context.window.workshopHtml.persistHtmlState = async () => ({ ok: false });
  vm.runInContext("save()", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(element("proposalStatus").textContent, /rejected|save failed/i,
    "a canonical Host rejection must remain visible instead of being treated as success");

  const deferredTimers = new Map();
  let nextTimerId = 10;
  context.setTimeout = (fn) => {
    const timerId = nextTimerId++;
    deferredTimers.set(timerId, fn);
    return timerId;
  };
  context.clearTimeout = (timerId) => deferredTimers.delete(timerId);
  const sentPatches = [];
  const stoppedTokens = [];
  context.window.workshopHtml = {
    sendLanSyncPatch: async (payload) => {
      sentPatches.push(payload);
      return { ok: true };
    },
    stopLanSync: async (token) => {
      stoppedTokens.push(token);
      return { ok: true };
    }
  };
  vm.runInContext(`
    lanSyncToken = "proposal-token-old";
    persistOrSyncProposalDecision({
      type: "proposal-decision",
      proposalId: "M1-001",
      status: "accepted",
      manualText: ""
    });
  `, context);
  assert.equal(sentPatches.length, 0, "proposal decision should remain pending during the debounce window");
  const staleTimerCallbacks = [...deferredTimers.values()];
  const stopHandler = element("stopLanSync").listeners.get("click");
  assert.equal(typeof stopHandler, "function", "proposal review should register an executable stop handler");
  await stopHandler();
  assert.deepEqual(sentPatches.map((entry) => entry.token), ["proposal-token-old"]);
  assert.deepEqual(stoppedTokens, ["proposal-token-old"]);
  assert.equal(vm.runInContext("lanSyncToken", context), "");
  for (const callback of staleTimerCallbacks) await callback();
  assert.equal(sentPatches.length, 1, "a stale debounce callback must not submit into a later session");

  context.window.workshopHtml.sendLanSyncPatch = async () => ({ ok: false });
  vm.runInContext(`
    lanSyncToken = "proposal-token-rejected";
    persistOrSyncProposalDecision({
      type: "proposal-decision",
      proposalId: "M1-001",
      status: "rejected",
      manualText: ""
    });
  `, context);
  await stopHandler();
  assert.equal(
    vm.runInContext("lanSyncToken", context),
    "proposal-token-rejected",
    "host rejection must keep the active session available for recovery"
  );
  assert.deepEqual(stoppedTokens, ["proposal-token-old"], "a rejected proposal write must block Stop");
  assert.match(element("proposalStatus").textContent, /rejected the LAN proposal decision/i);

  vm.runInContext("lanSyncStopping = false", context);
  deferredTimers.clear();
  sentPatches.length = 0;
  stoppedTokens.length = 0;
  let resolveFirstPatch;
  context.window.workshopHtml.sendLanSyncPatch = async (payload) => {
    sentPatches.push(payload);
    if (sentPatches.length === 1) {
      return await new Promise((resolve) => { resolveFirstPatch = resolve; });
    }
    return { ok: true };
  };
  vm.runInContext(`
    lanSyncToken = "proposal-token-drain";
    persistOrSyncProposalDecision({
      type: "proposal-decision",
      proposalId: "M1-001",
      status: "accepted",
      manualText: "A"
    });
  `, context);
  const drainingStop = stopHandler();
  await Promise.resolve();
  assert.equal(sentPatches.length, 1, "Stop should begin by flushing the queued decision");
  const lateRequest = vm.runInContext(`persistOrSyncProposalDecision({
    type: "proposal-decision",
    proposalId: "H3-999",
    status: "manual",
    manualText: "B"
  })`, context);
  resolveFirstPatch({ ok: true });
  await drainingStop;
  for (const callback of [...deferredTimers.values()]) await callback();
  await Promise.resolve(lateRequest).catch(() => {});
  assert.equal(sentPatches.length, 1,
    "a decision submitted while Stop is draining must not be sent after the LAN session closes");
  assert.deepEqual(stoppedTokens, ["proposal-token-drain"]);
});

await test("line review revisions are persisted and merged across desktop and LAN sync paths", async () => {
  const htmlSource = await readFile("src/shared/core/html.ts", "utf8");
  const mainSource = await readFile("src/main/main.ts", "utf8");
  const lanSyncStateSource = await readFile("src/main/lanSyncState.ts", "utf8");
  const lanSyncRuntimeSource = await readFile("src/main/lanSyncRuntime.ts", "utf8");
  assert.match(htmlSource, /state\.revisions \|\|= \{\};/);
  assert.match(htmlSource, /state\.revisionHistory \|\|= \{\};/);
  assert.match(htmlSource, /recordLineRevision\(line, text, "manual", "desktop-edit"\)/);
  assert.match(htmlSource, /recordTargetLineRevision\(target\.lineState, line, text, "manual", "proposal-apply"\)/);
  assert.match(htmlSource, /lineState\.revisionHistory \|\|= \{\};/);
  assert.match(htmlSource, /lineState\.revisionHistory\[key\] = history\.slice\(-12\);/);
  assert.match(lanSyncStateSource, /export function recordLineStateRevision/);
  assert.match(lanSyncRuntimeSource, /recordLineStateRevision\(lineDocument\.state, line/);
  assert.match(mainSource, /for \(const field of \["edits", "status", "revisions", "revisionHistory", "auditIssues", "auditWhitelist"\]\)/);
  assert.match(mainSource, /if \(Object\.prototype\.hasOwnProperty\.call\(incomingMap, key\)\) nextMap\[key\] = incomingMap\[key\];/);
  assert.match(mainSource, /else delete nextMap\[key\];/);
  assert.match(mainSource, /await save\(affectedLines\.length > 0 \? affectedLines/);
  assert.match(mainSource, /state\.revisions = mergedState\.revisions;/);
  assert.match(mainSource, /state\.revisionHistory = mergedState\.revisionHistory;/);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
