import assert from "node:assert/strict";
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { connectYnAgent } from "../agent-tools/yn-agent-client.mjs";
import { createZipBuffer } from "../src/main/zipWriter.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(path.join(root, ".tmp-electron-agent-api-"));
const evidenceDir = path.join(root, "artifacts", "agent-api"); await mkdir(evidenceDir, { recursive: true });
const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const external = ["electron", "electron-updater", "electron-updater/*", "extract-zip", "cheerio", "cheerio/*", "@earendil-works/pi-ai", "@earendil-works/pi-ai/*", "@earendil-works/pi-agent-core", "@earendil-works/pi-agent-core/*"];
const output = path.join(fixture, "main.mjs");
await build({ absWorkingDir: root, entryPoints: ["scripts/verify-electron-agent-api-main.ts"], bundle: true,
  platform: "node", format: "esm", outfile: output, external,
  banner: { js: 'import { createRequire as __ynCreateRequire } from "node:module"; const require = __ynCreateRequire(import.meta.url);' } });
for (const name of ["sourcePreparationWorker", "translationValidationWorker", "proofreadPrescanWorker", "sessionIndexWorker", "sessionMaintenanceWorker", "sessionHostReplayWorker"]) {
  await copyFile(path.join(root, "dist", "main", `${name}.js`), path.join(fixture, `${name}.js`));
}
let stderr = "";
const args = ["--disable-gpu", "--no-sandbox", `--user-data-dir=${path.join(fixture, "user-data")}`, output];
const oldFixture = process.env.YN_AGENT_API_FIXTURE;
process.env.YN_AGENT_API_FIXTURE = fixture;
const yn = connectYnAgent(electron, { args, cwd: root, onDiagnostic: text => { stderr += text; } });
let eofClient, resumedClient;
async function openStdioLauncher() {
  const child = spawn(process.execPath, [path.join(root, "agent-tools", "yn-agent-server.mjs"), electron, ...args],
    { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", data => { stderr += data; });
  let resolveReady, rejectReady, nextId = 0;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", line => {
    if (!line.trim()) return;
    const packet = JSON.parse(line);
    if (packet.type === "ready") { resolveReady(packet); return; }
    if (packet.type === "fatal") { rejectReady(new Error(packet.error.message)); return; }
    const request = pending.get(packet.id); pending.delete(packet.id);
    if (packet.ok) request.resolve(packet.result); else request.reject(new Error(packet.error.message));
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", error => { rejectReady(error); reject(error); });
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`Stdio launcher exited ${code}`)));
  });
  const close = async () => { child.stdin.end(); await exited; };
  const call = async (method, params) => {
    await ready; const id = ++nextId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({id,method,params})}\n`); });
  };
  return { ready, call, close };
}
const waitFor = async (read, accept, label) => {
  const until = Date.now() + 20000;
  let latest;
  while (Date.now() < until) { latest = await read(); if (accept(latest)) return latest; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(`${label}: ${JSON.stringify(latest)}`);
};
const terminal = async task => {
  const state = await waitFor(() => yn.call("status", { outputDir: task.outputDir, sessionId: task.sessionId }), state => !state.running && state.lastReply, "native terminal state");
  assert.equal(state.error, undefined); return state;
};
const records = [];
try {
  const ready = await yn.ready; assert.equal(ready.protocolVersion, 1);
  const busy = connectYnAgent(electron, { args, cwd: root, onDiagnostic: text => { stderr += text; } });
  await assert.rejects(busy.ready, error => error.code === "instance_in_use");
  await assert.rejects(busy.exited, error => error.code === "instance_in_use");
  const sourcePath = path.join(fixture, "source.txt"); await writeFile(sourcePath, "Hello {name}");
  const base = { sourcePath, languagePair: "en->zh-CN", glossaryCandidates: false, characterBible: false };
  const plan = await yn.call("plan", { task: "translation", settings: { ...base, outputDir: path.join(fixture, "translation") } });
  assert.equal(existsSync(plan.settings.outputDir), false); assert.equal(plan.settings.splitSize, 500); assert.equal(plan.settings.subagentCount, 3);
  await assert.rejects(yn.call("start", { planId: plan.planId }), error => error.code === "confirmation_required");
  assert.equal(existsSync(plan.settings.outputDir), false);
  const [task, duplicate] = await Promise.all([yn.call("start", { planId: plan.planId, confirmed: true }), yn.call("start", { planId: plan.planId, confirmed: true })]);
  assert.deepEqual(task, duplicate); records.push(await terminal(task));
  const rawProject = JSON.parse(await readFile(path.join(task.outputDir, ".translation-workshop", "project.json"), "utf8"));
  assert.equal(rawProject.builtinTaskSessionId, task.sessionId);
  assert.ok(!path.isAbsolute(rawProject.lineReviewPath)); assert.equal(rawProject.splitSize, 500);

  const translationPath = path.join(task.outputDir, "AI_translation", "source_translated.txt");
  assert.equal(await readFile(translationPath, "utf8"), "你好 {name}");
  const proofPlan = await yn.call("plan", { task: "proofread", settings: { ...base, outputDir: path.join(fixture, "proofread"), translationPath, splitSize: 37 }, autoApplyProofreadSuggestions: true });
  const proofTask = await yn.call("start", { planId: proofPlan.planId, confirmed: true }); records.push(await terminal(proofTask));
  const sidecarDir = path.join(proofTask.outputDir, ".translation-workshop", "state");
  await waitFor(async () => (await readdir(sidecarDir)).filter(file => file.startsWith("line-") && file.endsWith(".json")), files => files.length, "proofread sidecar");
  const edits = await Promise.all((await readdir(sidecarDir)).filter(file => file.startsWith("line-") && file.endsWith(".json")).map(file => readFile(path.join(sidecarDir, file), "utf8")));
  assert.ok(edits.some(text => Object.values(JSON.parse(text).edits ?? {}).includes("您好 {name}")));
  assert.equal(await readFile(translationPath, "utf8"), "你好 {name}", "Autoapply cannot export TXT");

  const folder = path.join(fixture, "input-folder"); await mkdir(folder);
  await writeFile(path.join(folder, "a.txt"), "Hello {name}"); await writeFile(path.join(folder, "b.txt"), "Hello {name}");
  const bilingual = path.join(fixture, "bilingual.txt"); await writeFile(bilingual, "旧译 {name}\nHello {name}");
  const epub = path.join(fixture, "source.epub");
  await writeFile(epub, createZipBuffer([
    { path: "mimetype", data: Buffer.from("application/epub+zip") },
    { path: "META-INF/container.xml", data: Buffer.from('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>') },
    { path: "content.opf", data: Buffer.from('<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book"><metadata/><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>') },
    { path: "chapter.xhtml", data: Buffer.from('<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><p>Hello {name}</p></body></html>') }
  ]));
  for (const [name, settings] of [["folder", { ...base, sourcePath: folder, folderTranslationOrder: "{a.txt b.txt}", subagentEnabled: false }],
    ["bilingual", { ...base, sourcePath: bilingual, inputMode: "bilingual" }], ["epub", { ...base, sourcePath: epub, fileType: "epub" }]]) {
    const planned = await yn.call("plan", { task: "translation", settings: { ...settings, outputDir: path.join(fixture, name) } });
    if (name === "folder") assert.equal(planned.settings.folderTranslationOrder, "{a.txt b.txt}");
    const started = await yn.call("start", { planId: planned.planId, confirmed: true }); records.push(await terminal(started));
    assert.ok(started.outputPath);
  }
  // A new task may bind the same project to a new session. An old session must
  // not silently inherit that new task's HTML/parameters or request a model.
  const assetsPlan = await yn.call("plan", { task: "assets", settings: { outputDir: task.outputDir, materials: "Alice is a calm mage." } });
  const assetsTask = await yn.call("start", { planId: assetsPlan.planId, confirmed: true }); records.push(await terminal(assetsTask));
  await assert.rejects(yn.call("resume", { outputDir: task.outputDir, sessionId: task.sessionId }), error => error.code === "session_context_changed");
  const sessions = await yn.call("sessions", { outputDir: task.outputDir }); assert.equal(sessions.sessions.length, 2);

  const heldPlan = await yn.call("plan", { task: "assets", settings: { outputDir: path.join(fixture, "hold"), materials: "Alice is a mage." } });
  const held = await yn.call("start", { planId: heldPlan.planId, confirmed: true });
  await waitFor(() => existsSync(path.join(held.outputDir, "waiting.txt")), Boolean, "native tool awaiting Stop");
  const stopped = await yn.call("stop", { outputDir: held.outputDir, sessionId: held.sessionId });
  assert.equal(stopped.running, false);
  await yn.call("resume", { outputDir: held.outputDir, sessionId: held.sessionId }); records.push(await terminal(held));
  assert.equal(await readFile(sourcePath, "utf8"), "Hello {name}");
  await yn.close();
  const accepted = JSON.parse(await readFile(path.join(fixture, "acceptance.json"), "utf8"));
  assert.equal(accepted.code, 0); assert.equal(accepted.visibleWindows, 0); assert.equal(accepted.nativeOwners, 0);
  assert.equal(accepted.parityChecks, 5); assert.ok(accepted.maxWindows > 0); assert.equal(accepted.paidCalls, 0);
  eofClient = await openStdioLauncher(); await eofClient.ready;
  const eofPlan = await eofClient.call("plan", { task: "assets", settings: { outputDir: path.join(fixture, "eof"), materials: "Alice is a mage." } });
  const unfinished = await eofClient.call("start", { planId: eofPlan.planId, confirmed: true });
  await waitFor(() => existsSync(path.join(unfinished.outputDir, "waiting.txt")), Boolean, "native EOF cancellation tool");
  await eofClient.close();
  const eofAccepted = JSON.parse(await readFile(path.join(fixture, "acceptance.json"), "utf8"));
  assert.equal(eofAccepted.code, 0); assert.equal(eofAccepted.nativeOwners, 0); assert.equal(eofAccepted.visibleWindows, 0);
  const draftsDir = path.join(unfinished.outputDir, ".translation-workshop", "agent", "asset-drafts");
  const drafts = await readdir(draftsDir); assert.equal(drafts.length, 1);
  const draft = JSON.parse(await readFile(path.join(draftsDir, drafts[0]), "utf8"));
  assert.equal(draft.committed, undefined); assert.ok(draft.glossary.some(entry => entry.source === "Draft"));
  resumedClient = connectYnAgent(electron, { args, cwd: root, onDiagnostic: text => { stderr += text; } }); await resumedClient.ready;
  const coldSessions = await resumedClient.call("sessions", { outputDir: unfinished.outputDir });
  assert.ok(coldSessions.sessions.some(session => session.id === unfinished.sessionId));
  await resumedClient.call("resume", { outputDir: unfinished.outputDir, sessionId: unfinished.sessionId });
  const coldState = await waitFor(() => resumedClient.call("status", { outputDir: unfinished.outputDir, sessionId: unfinished.sessionId }),
    state => !state.running && state.lastReply, "cold resume completion");
  assert.equal(coldState.error, undefined);
  assert.ok(JSON.parse(await readFile(path.join(draftsDir, drafts[0]), "utf8")).committed);
  const canonicalGlossary = JSON.parse(await readFile(path.join(unfinished.outputDir, ".translation-workshop", "glossary.json"), "utf8"));
  assert.ok(canonicalGlossary.entries.some(entry => entry.source === "Alice" && entry.target === "爱丽丝"));
  await resumedClient.close();
  const coldAccepted = JSON.parse(await readFile(path.join(fixture, "acceptance.json"), "utf8"));
  assert.equal(coldAccepted.nativeOwners, 0); assert.equal(coldAccepted.code, 0); assert.equal(coldAccepted.visibleWindows, 0);
  await writeFile(path.join(evidenceDir, "electron-acceptance.json"), JSON.stringify({ ...accepted, records, confirmedPlanning: true, idempotentStart: true,
    singleInstance: true, nativeStopResume: true, oldSessionMismatchRejected: true, htmlOnlyAutoapply: true,
    stdioLauncherEof: eofAccepted, coldResume: coldAccepted, draftPreservedAndCommitted: true }, null, 2));
  console.log(JSON.stringify({ agentApiAcceptance: true, ...accepted }));
} catch (error) {
  console.error("[agent-api-verifier]", error);
  if (existsSync(path.join(fixture, "acceptance.json"))) await copyFile(path.join(fixture, "acceptance.json"), path.join(evidenceDir, "failed-acceptance.json"));
  throw error;
} finally {
  try { await Promise.all([yn.close(), eofClient?.close(), resumedClient?.close()]); }
  finally {
    await writeFile(path.join(evidenceDir, "electron-stderr.log"), stderr);
    if (oldFixture === undefined) delete process.env.YN_AGENT_API_FIXTURE; else process.env.YN_AGENT_API_FIXTURE = oldFixture;
    if (!path.resolve(fixture).startsWith(`${root}${path.sep}.tmp-electron-agent-api-`)) throw new Error("Unsafe fixture cleanup.");
    await rm(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
