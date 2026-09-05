import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

import { renderLineReviewHtml } from "../../src/shared/core/html.ts";

const html = renderLineReviewHtml({
  title: "LAN line review",
  sourceText: "source",
  translationText: "translation",
  lineReviewPath: "C:\\project\\line-review.html"
});

function functionSource(name, nextName) {
  const start = html.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist in generated line-review HTML`);
  const end = html.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return html.slice(start, end);
}

const updateEditedTarget = functionSource("updateEditedTarget", "restoreCurrentLine");
assert.match(updateEditedTarget, /persistLineReviewPatch\(\{ type: "line-edit"/);
assert.doesNotMatch(updateEditedTarget, /save\(\[Number\(line\)\]\)/);
assert.ok(
  updateEditedTarget.indexOf("lanSyncStopping || lanSyncStarting") < updateEditedTarget.indexOf("state.edits[line] = text"),
  "line edits must be rejected before local state changes while LAN sync starts or stops"
);

const restoreCurrentLine = functionSource("restoreCurrentLine", "jumpToSearchMatch");
assert.ok(
  restoreCurrentLine.indexOf("lanSyncStopping || lanSyncStarting") < restoreCurrentLine.indexOf("delete state.edits[line]"),
  "restore must be rejected before local state changes while LAN sync starts or stops"
);

const queueLanSyncPatch = functionSource("queueLanSyncPatch", "applyRemoteLanSyncPatch");
assert.match(queueLanSyncPatch, /return new Promise/);
assert.doesNotMatch(queueLanSyncPatch, /\.catch\(\(\) => \{\}\)/);
assert.match(queueLanSyncPatch, /dispatchPendingLanSyncPatch\(key\)\.catch\(reportLineReviewPersistFailure\)/);

const applyRemoteLanSyncPatch = functionSource("applyRemoteLanSyncPatch", "applyRemoteLanSyncCommand");
assert.doesNotMatch(applyRemoteLanSyncPatch, /save\(\[line\]\)/);
assert.doesNotMatch(applyRemoteLanSyncPatch, /recordLineRevision/);

const mainSource = await readFile("src/main/main.ts", "utf8");
const desktopIpcStart = mainSource.indexOf('ipcMain.handle("lan-sync:patch"');
const desktopIpcEnd = mainSource.indexOf('ipcMain.handle("lan-sync:stop"', desktopIpcStart);
assert.ok(desktopIpcStart >= 0 && desktopIpcEnd > desktopIpcStart);
const desktopIpc = mainSource.slice(desktopIpcStart, desktopIpcEnd);
assert.match(desktopIpc, /await commitLanSyncPatch\(session, patch, persistLanSyncPatch, broadcastLanSyncPatch\)/);
assert.doesNotMatch(desktopIpc, /applyLanSyncPatchToSession/);

const startIpcStart = mainSource.indexOf('ipcMain.handle("lan-sync:start"');
assert.ok(startIpcStart >= 0 && desktopIpcStart > startIpcStart);
const startIpc = mainSource.slice(startIpcStart, desktopIpcStart);
assert.match(startIpc, /assertLanSyncStartOwnership\(args, senderPath\)/);
assert.match(startIpc, /await registerLanSyncSession\(session, lanSyncSessions, \(\) => !event\.sender\.isDestroyed\(\)\)/);
assert.match(startIpc, /lanSyncOwnerDestroyedHandlers/);
assert.doesNotMatch(startIpc, /event\.sender\.once\("destroyed", \(\) =>/);
assert.ok(
  startIpc.indexOf('event.sender.once("destroyed", handleOwnerDestroyed)') < startIpc.indexOf("await ensureLanSyncServer()"),
  "owner destruction must be observed before the Start handler's first asynchronous operation"
);
assert.match(startIpc, /if \(!registered \|\| event\.sender\.isDestroyed\(\)\) \{\s*await stopLanSyncSession\(session, lanSyncSessions\);/);

const startLanSync = functionSource("startLanSync", "reportLineReviewPersistFailure");
assert.match(startLanSync, /if \(lanSyncToken \|\| lanSyncStarting \|\| lanSyncStopping\) return;/);
assert.match(startLanSync, /lanSyncStarting = true;/);
assert.match(startLanSync, /lanSyncStarting = false;/);
const renderLanSyncLinks = functionSource("renderLanSyncLinks", "startLanSync");
assert.match(renderLanSyncLinks, /if \(lanUrls\[0\]\)/);
assert.doesNotMatch(renderLanSyncLinks, /lanUrls\.forEach/);

const lineStopStart = html.indexOf('stopLanSyncButton?.addEventListener("click"');
const lineStopEnd = html.indexOf("async function syncLines", lineStopStart);
assert.ok(lineStopStart >= 0 && lineStopEnd > lineStopStart);
const lineStop = html.slice(lineStopStart, lineStopEnd);
assert.match(lineStop, /if \(lanSyncStopping \|\| lanSyncStarting\) return;/);
assert.match(lineStop, /lanSyncStopping = true;/);
assert.ok(
  lineStop.indexOf('await invokeBridge()?.stopLanSync?.(token)') < lineStop.indexOf('lanSyncToken = ""'),
  "line review must keep the active token until Host Stop succeeds"
);

const remotePostPatchStart = mainSource.indexOf("async function postPatch(patch)");
const remotePostPatchEnd = mainSource.indexOf("let timers = new Map()", remotePostPatchStart);
assert.ok(remotePostPatchStart >= 0 && remotePostPatchEnd > remotePostPatchStart);
const remotePostPatch = mainSource.slice(remotePostPatchStart, remotePostPatchEnd);
assert.match(remotePostPatch, /const response = await fetch/);
assert.match(remotePostPatch, /if \(!response\.ok\) throw new Error/);

console.log("ok generated line-review HTML uses one canonical LAN mutation path");
