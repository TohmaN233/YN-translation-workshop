import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { renderLineReviewHtml } from "../src/shared/core/html.ts";
import { splitTextLines } from "../src/shared/validation/translationValidator.ts";
import { lineReviewSidecarStatePath } from "../src/main/batchLineReviewTxt.ts";
const fixture = process.env.YN_ARTIFACT_VERIFY_DIR!;
if (!fixture) throw new Error("Missing isolated artifact fixture.");
app.setPath("userData", path.join(fixture, "user-data")); app.setAppPath(process.cwd()); app.disableHardwareAcceleration();
await import("../src/main/main.ts");
void app.whenReady().then(async () => {
  try {
    const full = process.env.YN_ARTIFACT_REAL === "1";
    const project = path.join(fixture, "Translation"), htmlPath = path.join(project, ".translation-workshop", "html", "review.html");
    const originalSource = "G:\\Baiduyun\\tp-megido-main\\data\\japanese_text_unique.txt";
    const originalCandidate = "G:\\Baiduyun\\tp-megido-main\\Translation\\AI_translation\\japanese_text_unique_translated.txt";
    const sourcePath = full ? originalSource : path.join(fixture, "chapter.txt");
    const candidatePath = path.join(project, "AI_translation", `${full ? "japanese_text_unique" : "chapter"}_translated.txt`);
    const glossaryPath = path.join(project, "terms.json");
    await mkdir(path.dirname(htmlPath), { recursive: true }); await mkdir(path.dirname(candidatePath), { recursive: true });
    if (full) {
      await copyFile(originalCandidate, candidatePath);
      await copyFile("G:\\Baiduyun\\tp-megido-main\\glossary\\megido72_terms_combined.json", glossaryPath);
      await mkdir(path.join(project, "AI_translation", "_workspace"), { recursive: true });
      await copyFile("G:\\Baiduyun\\tp-megido-main\\Translation\\AI_translation\\_workspace\\character_bible.md", path.join(project, "AI_translation", "_workspace", "character_bible.md"));
    } else {
      await writeFile(sourcePath, Array.from({length:20000}, (_,i) => `A sufficiently long sentence about term${i%2600}.`).join("\n"));
      await writeFile(candidatePath, Array.from({length:20000}, (_,i) => `关于术语${i%2600}的一句话。`).join("\n"));
      await writeFile(glossaryPath, JSON.stringify(Array.from({length:2600},(_,i)=>({source:`term${i}`,target:`术语${i}`}))));
    }
    const sourceText = await readFile(sourcePath, "utf8"), candidateText = await readFile(candidatePath, "utf8");
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const sourceHash = hash(sourceText), candidateHash = hash(candidateText), expectedLines = splitTextLines(candidateText);
    await writeFile(path.join(project, ".translation-workshop", "project.json"), JSON.stringify({ sourcePath, glossaryPath }));
    await writeFile(htmlPath, renderLineReviewHtml({ title: "Artifact responsiveness", sourceText, pageSize: 100,
      lineReviewPath: htmlPath, workflow: { sourcePath, validationSourcePath: sourcePath, outputDir: project, glossaryPath, advanced: { languagePair: full ? "ja->zh-CN" : "en->zh-CN" } } }));
    const win = new BrowserWindow({show:false,webPreferences:{preload:path.resolve("dist/main/preload.cjs"),contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    const errors: string[] = []; win.webContents.on("console-message", event => { if (/Uncaught|failed to persist/i.test(event.message)) errors.push(event.message); });
    app.on("child-process-gone", (_event, details) => console.error("artifact-child-process-gone", JSON.stringify(details)));
    await win.loadFile(htmlPath); await win.webContents.executeJavaScript("lastHostStateWrite");
    await new Promise(resolve => setTimeout(resolve, 500));
    let last = performance.now(), maxGap = 0;
    const timer = setInterval(() => { const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now; },10);
    const begin = Date.now();
    await win.webContents.executeJavaScript(`window.__artifactHeartbeat={max:0,last:performance.now(),ticks:0};window.__artifactTimer=setInterval(()=>{const h=window.__artifactHeartbeat,now=performance.now();h.max=Math.max(h.max,now-h.last);h.last=now;h.ticks++;},10);`);
    await win.webContents.executeJavaScript("discoverAgentArtifacts()");
    assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.artifact-import').length"),1);
    const refreshMs = Date.now()-begin;
    const importStart = Date.now();
    await win.webContents.executeJavaScript(`importArtifactAsDraft(${JSON.stringify(candidatePath)},${JSON.stringify(sourcePath)})`);
    const imported = await win.webContents.executeJavaScript(`({count:Object.keys(state.edits).length,first:state.edits[1],last:state.edits[${expectedLines.length}],binding:state.translationPath,busy:artifactImportBusy,pending:pendingLineMutations.size,status:document.getElementById('aiStatus').textContent,localBytes:(localStorage.getItem(key)||'').length,heartbeat:window.__artifactHeartbeat})`);
    const importMs = Date.now()-importStart;
    clearInterval(timer); await win.webContents.executeJavaScript("clearInterval(window.__artifactTimer)");
    assert.equal(imported.count,expectedLines.length,imported.status); assert.equal(imported.first,expectedLines[0]); assert.equal(imported.last,expectedLines.at(-1));
    assert.equal(imported.binding,candidatePath); assert.equal(imported.pending,0); assert.equal(imported.busy,false); assert.ok(imported.localBytes<10000);
    const stored=JSON.parse(await readFile(lineReviewSidecarStatePath(htmlPath),"utf8"));
    assert.equal(Object.keys(stored.edits).length,expectedLines.length);
    for(let i=0;i<expectedLines.length;i++) assert.equal(stored.edits[i+1],expectedLines[i],`Imported line ${i+1}`);
    assert.equal(hash(await readFile(sourcePath,"utf8")),sourceHash); assert.equal(hash(await readFile(candidatePath,"utf8")),candidateHash);
    const journal=(await readFile(path.join(project,".translation-workshop","agent","validation","events.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    assert.ok(journal.some(event=>event.phase==="artifact-import"&&event.cacheHit===true),"unchanged candidate import must reuse the previous check");
    assert.deepEqual(errors,[]);
    if (!full) {
      // Exercise the actual sparse save/debounce callsite, not a hand-authored
      // patch. Two rapid edits used to lose the first row after this refactor.
      await win.webContents.executeJavaScript(`(async()=>{state.edits[1]='manual one';state.status[1]='manual';save([1]);state.edits[2]='manual two';state.status[2]='manual';await save([2]);})()`);
      const edited=JSON.parse(await readFile(lineReviewSidecarStatePath(htmlPath),"utf8"));
      assert.equal(edited.edits[1],"manual one");assert.equal(edited.edits[2],"manual two");assert.equal(edited.edits[3],expectedLines[2]);
      await win.webContents.executeJavaScript(`(async()=>{delete state.edits[1];delete state.status[1];save([1]);state.edits[2]='manual two newer';await save([2]);})()`);
      const restored=JSON.parse(await readFile(lineReviewSidecarStatePath(htmlPath),"utf8"));
      assert.equal(restored.edits[1],undefined);assert.equal(restored.edits[2],"manual two newer");
      await copyFile(candidatePath,path.join(project,"AI_translation","chapter_alt1_translated.txt"));
      await copyFile(candidatePath,path.join(project,"AI_translation","chapter_alt2_translated.txt"));
      await win.webContents.executeJavaScript("void (window.__refreshTask=discoverAgentArtifacts())");
      const deadline=Date.now()+5000;
      while(!(await win.webContents.executeJavaScript("Boolean(document.querySelector('.artifact-import') && artifactRequestId)"))) {
        if(Date.now()>deadline)throw new Error("Multi-candidate refresh did not expose its first accepted card while checking the next candidate.");
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      const overlap=await win.webContents.executeJavaScript(`(async()=>{
        const oldRequest=artifactRequestId;
        const button=document.querySelector('.artifact-import');
        void importArtifactAsDraft(button.dataset.path,button.dataset.source);
        await new Promise(resolve=>setTimeout(resolve,20));
        await window.flushTranslationWorkshopLineReviewState();
        await window.__refreshTask;
        return {oldRequest,newRequest:artifactRequestId,busy:artifactImportBusy,first:state.edits[1],second:state.edits[2]};
      })()`);
      assert.ok(overlap.oldRequest);assert.equal(overlap.newRequest,"");assert.equal(overlap.busy,false);
      assert.equal(overlap.first,undefined);assert.equal(overlap.second,"manual two newer","close cancellation must retain the existing draft");
    }
    const result={artifactAcceptance:true,full,lineCount:expectedLines.length,refreshMs,importMs,mainMaxGapMs:maxGap,rendererMaxGapMs:imported.heartbeat.max,rendererTicks:imported.heartbeat.ticks,localBytes:imported.localBytes,memory:process.memoryUsage(),sourceAndCandidateUnchanged:true,cacheHit:true,visible:win.isVisible()};
    await writeFile(path.join(fixture,"result.json"),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
    assert.ok(maxGap<750,`Main was blocked for ${maxGap.toFixed(0)}ms`); assert.ok(imported.heartbeat.max<750,`Renderer was blocked for ${imported.heartbeat.max.toFixed(0)}ms`);
    await writeFile(path.join(fixture,"stage.json"),JSON.stringify({stage:"flushing-owner",at:new Date().toISOString()}));
    await win.webContents.executeJavaScript("window.flushTranslationWorkshopLineReviewState()");
    await writeFile(path.join(fixture,"stage.json"),JSON.stringify({stage:"reopening-tab",at:new Date().toISOString()}));
    const controlPath=path.join(fixture,"control.html");await writeFile(controlPath,"<!doctype html><title>Reopen control</title>");
    const control=new BrowserWindow({show:false,webPreferences:{preload:path.resolve("dist/main/preload.cjs"),contextIsolation:true,nodeIntegration:false}});
    await control.loadFile(controlPath);
    // Reopen after closing the prior document, matching the user's workflow.
    // Keeping two 85MB pages alive measures an unrelated memory stress case.
    win.close();
    const reopenStarted=Date.now();
    await control.webContents.executeJavaScript(`window.workshopHtml.openReviewHtml(${JSON.stringify({htmlPath,activate:false})})`);
    await writeFile(path.join(fixture,"stage.json"),JSON.stringify({stage:"tab-reopened",at:new Date().toISOString()}));
    const reopened = BrowserWindow.getAllWindows().flatMap(window => window.getBrowserViews()).map(view=>view.webContents)
      .find(contents => contents.getURL().includes("review.html"));
    assert.ok(reopened,"reopen must use the real HTML tab host and sidecar injection");
    const recovered=await reopened.executeJavaScript(`({count:Object.keys(state.edits).length,last:state.edits[${expectedLines.length}],binding:state.translationPath})`);
    assert.equal(recovered.count,expectedLines.length-(full?0:1));assert.equal(recovered.last,expectedLines.at(-1));assert.equal(recovered.binding,candidatePath);
    await writeFile(path.join(fixture,"result.json"),JSON.stringify({...result,reopenMs:Date.now()-reopenStarted,reopenedDraftVerified:true,rapidEditAndRestoreVerified:!full},null,2));
    control.close(); app.quit();
  } catch(error) { console.error(error); app.exit(1); }
}).catch(error=>{console.error(error);app.exit(1);});
