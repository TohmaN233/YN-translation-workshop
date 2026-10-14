import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import electron from 'electron';
import {renderLineReviewHtml} from '../../src/shared/core/html.ts';
import {prepareReviewHtmlOpen} from '../../src/main/reviewHtmlUpgrade.ts';

const root=await mkdtemp(path.join(os.tmpdir(),'yn-review-renderer-'));
const workspace=path.join(root,'.translation-workshop'),htmlPath=path.join(workspace,'html','large.html'),statePath=path.join(workspace,'state','line-large.html.json');
await mkdir(path.dirname(htmlPath),{recursive:true});await mkdir(path.dirname(statePath),{recursive:true});
let log='',finished=false;
try {
  const sourceText=Array.from({length:50000},(_,index)=>`Complete source row ${index+1}.`).join('\n');
  await writeFile(htmlPath,renderLineReviewHtml({title:'Large renderer restore',sourceText,translationText:'',pageSize:1000,lineReviewPath:htmlPath,workflow:{outputDir:root,sourcePath:path.join(root,'source.txt')}}));
  const context=await prepareReviewHtmlOpen(htmlPath);assert.equal(context.payload.rows.length,50000);
  const state={documentRevision:1,edits:Object.fromEntries(Array.from({length:50000},(_,index)=>[index+1,`Recovered row ${index+1}`])),status:{},revisions:{},revisionHistory:{},auditIssues:{},auditWhitelist:{}};
  await writeFile(statePath,JSON.stringify(state));
  const before=await readFile(statePath);
  const preload=path.join(root,'preload.cjs');
  await writeFile(preload,`const {contextBridge,ipcRenderer}=require('electron');const mode=process.argv.find(value=>value.startsWith('--fixture-mode='))?.slice('--fixture-mode='.length)||'canonical';if(!sessionStorage.getItem('fixture-initialized')){localStorage.clear();localStorage.setItem('translation-workshop:line:'+location.pathname,JSON.stringify(mode.startsWith('missing')?{documentRevision:8,edits:{1:'Local history without sidecar',...(mode==='missing-cas'?{3:'Stale legacy row three'}:{})}}:{documentRevision:1}));sessionStorage.setItem('fixture-initialized','true');}contextBridge.exposeInMainWorld('workshopHtml',{readLineReviewState:args=>ipcRenderer.invoke('fixture:read',{...args,mode}),persistHtmlState:args=>ipcRenderer.invoke('fixture:persist',args),onLineReviewStateUpdate:callback=>{const listener=(_event,payload)=>callback(payload);ipcRenderer.on('fixture:update',listener);return()=>ipcRenderer.removeListener('fixture:update',listener);},readProjectState:async()=>({}),onProjectStateUpdate:()=>()=>{}});`);
  const main=`
import assert from 'node:assert/strict';
import {app,BrowserWindow,ipcMain} from 'electron';
import {readFile,writeFile} from 'node:fs/promises';
import {commitLineReviewStateInWorker} from './src/main/lineReviewStateWorkerService.ts';
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
app.setPath('userData',${JSON.stringify(path.join(root,'user-data'))});
const htmlPath=${JSON.stringify(htmlPath)},statePath=${JSON.stringify(statePath)},root=${JSON.stringify(root)},missingStatePath=root+'/missing-sidecar.json',competingStatePath=root+'/competing-sidecar.json',requests=[],reads=[],modes=new Map();
let window;
ipcMain.handle('fixture:read',async(event,args)=>{
  modes.set(event.sender.id,args.mode);
  assert.equal(args.lineReviewPath.replace(/\\\\/g,'/'),htmlPath.replace(/\\\\/g,'/'));
  reads.push(args.mode);
  if(args.mode==='failure')throw new Error('Fixture canonical read failed');
  let state;
  try{state=JSON.parse(await readFile(args.mode==='missing'?missingStatePath:args.mode==='missing-cas'?competingStatePath:statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(args.mode.startsWith('race')){
    state={...state,documentRevision:args.mode==='race-newer'?3:1,edits:{...state.edits,1:'Snapshot row one'}};
    event.sender.send('fixture:update',{lineReviewPath:htmlPath,state:{documentRevision:2,edits:{1:'Concurrent canonical row one'}},changedLines:[1],partial:true});
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.deepEqual(await event.sender.executeJavaScript('({hydrated:canonicalStateHydrated,inert:document.body.inert})'),{hydrated:false,inert:true},'a delta cannot mark an unfinished full read as hydrated');
  }
  return {state};
});
ipcMain.handle('fixture:persist',async(event,args)=>{
  requests.push({changedLines:args.changedLines,changedStateKeys:args.changedStateKeys,hydrate:args.hydrate,expectedRevision:args.expectedRevision});
  const state=await commitLineReviewStateInWorker({statePath:modes.get(event.sender.id)==='missing'?missingStatePath:modes.get(event.sender.id)==='missing-cas'?competingStatePath:statePath,projectRoot:root,state:args.state,changedLines:args.changedLines,changedStateKeys:args.changedStateKeys,hydrate:args.hydrate!==false,mutationAccepted:true,expectedRevision:args.expectedRevision});
  return {ok:true,lineReviewPath:htmlPath,state,changedLines:args.changedLines,changedStateKeys:args.changedStateKeys,partial:args.hydrate===false,clientId:args.clientId,mutationId:args.mutationId,mutationAccepted:true};
});
const result={};
const timeout=setTimeout(()=>{result.pass=false;result.error='Renderer fixture did not reach complete editable state within 30 seconds.';process.exitCode=1;void writeFile(${JSON.stringify(path.join(root,'result.json'))},JSON.stringify(result,null,2)).then(()=>app.quit());},30000);
void (async()=>{
await app.whenReady();
try {
  window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
  let shows=0;window.on('show',()=>shows++);
  const started=performance.now();
  await window.loadFile(htmlPath);
  await window.webContents.executeJavaScript('window.translationWorkshopLineReviewReady');
  const ready=await window.webContents.executeJavaScript('({rowCount:data.rows.length,visibleRows:document.querySelectorAll(".row").length,first:document.querySelector(".target").textContent,editable:document.querySelector(".target").contentEditable,hydrated:canonicalStateHydrated})');
  assert.deepEqual(ready,{rowCount:50000,visibleRows:1000,first:'Recovered row 1',editable:'true',hydrated:true});
  result.completeEditableMs=performance.now()-started;
  assert.deepEqual(reads,['canonical'],'one explicit read restores canonical state, including when the saved local revision is equal');
  assert.equal(await window.webContents.executeJavaScript('document.body.inert'),false);
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(requests.length,0,'render, restore, animation frames and position saves must not send any sidecar transaction');
  result.initialPersistRequests=requests.length;
  await window.webContents.executeJavaScript('document.querySelector(".target").textContent="Actual edited row one";document.querySelector(".target").dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"}));true');
  await window.webContents.executeJavaScript('window.flushTranslationWorkshopLineReviewState()');
  assert.equal(requests.length,1,'one real edit uses the original sidecar transaction');
  assert.deepEqual(requests[0].changedLines,[1]);assert.equal(requests[0].hydrate,false);
  const committed=JSON.parse(await readFile(statePath,'utf8'));
  assert.equal(committed.edits[1],'Actual edited row one');assert.equal(committed.edits[50000],'Recovered row 50000');assert.ok(committed.documentRevision>1);assert.equal(committed.status[1],'manual');assert.ok(committed.revisionHistory[1].length);
  await assert.rejects(commitLineReviewStateInWorker({statePath,projectRoot:root,state:{edits:{1:'stale'}},changedLines:[1],changedStateKeys:[],hydrate:false,mutationAccepted:true,expectedRevision:1}),/draft changed/);
  assert.equal(JSON.parse(await readFile(statePath,'utf8')).edits[1],'Actual edited row one','stale CAS must not overwrite the actual edit');
  result.actualEditRequests=requests.length;result.originalWorkerCas=true;result.visible=window.isVisible();result.showEvents=shows;
  window.destroy();
  window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false,additionalArguments:['--fixture-mode=missing']}});
  await window.loadFile(htmlPath);
  await window.webContents.executeJavaScript('window.translationWorkshopLineReviewReady');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".target").textContent'),'Local history without sidecar','missing sidecar must preserve browser history');
  assert.equal(requests.length,1,'missing sidecar restoration must not create a sidecar');
  assert.equal(await window.webContents.executeJavaScript('JSON.parse(localStorage.getItem(key)).edits[1]'),'Local history without sidecar','the only durable copy must survive initialization');
  const reloaded=new Promise(resolve=>window.webContents.once('did-finish-load',resolve));window.webContents.reload();await reloaded;
  await window.webContents.executeJavaScript('window.translationWorkshopLineReviewReady');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".target").textContent'),'Local history without sidecar','a true reload must restore the retained durable history');
  assert.equal(requests.length,1,'reload still performs no initial sidecar write');
  await window.webContents.executeJavaScript('document.querySelectorAll(".target")[1].textContent="Actual second row after reload";document.querySelectorAll(".target")[1].dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"}));true');
  await window.webContents.executeJavaScript('window.flushTranslationWorkshopLineReviewState()');
  assert.equal(requests.length,2);assert.equal(requests[1].hydrate,true,'first actual mutation migrates the retained history');
  assert.equal(requests[1].expectedRevision,0,'first migration uses worker CAS against the observed absent sidecar');
  assert.deepEqual(requests[1].changedLines.map(Number).sort(),[1,2],'migration owns every retained legacy row');
  const migrated=JSON.parse(await readFile(missingStatePath,'utf8'));assert.equal(migrated.edits[1],'Local history without sidecar');assert.equal(migrated.edits[2],'Actual second row after reload');
  assert.equal(await window.webContents.executeJavaScript('JSON.parse(localStorage.getItem(key)).edits'),undefined,'only successful canonical hydration retires local line maps');
  result.missingSidecarPreservesHistory=true;
  result.missingSidecarHistorySurvivesReload=true;result.firstMutationMigratesHistory=true;
  window.destroy();
  window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false,additionalArguments:['--fixture-mode=race']}});
  await window.loadFile(htmlPath);await window.webContents.executeJavaScript('window.translationWorkshopLineReviewReady');
  assert.deepEqual(await window.webContents.executeJavaScript('({first:state.edits[1],tail:state.edits[50000],revision:state.documentRevision,hydrated:canonicalStateHydrated})'),{first:'Concurrent canonical row one',tail:'Recovered row 50000',revision:2,hydrated:true},'queued newer delta overlays the full snapshot without losing its tail');
  assert.equal(requests.length,2,'initial canonical races perform no writes');result.initialCanonicalRacePreservesTail=true;
  window.destroy();
  window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false,additionalArguments:['--fixture-mode=race-newer']}});
  await window.loadFile(htmlPath);await window.webContents.executeJavaScript('window.translationWorkshopLineReviewReady');
  assert.deepEqual(await window.webContents.executeJavaScript('({first:state.edits[1],tail:state.edits[50000],revision:state.documentRevision})'),{first:'Snapshot row one',tail:'Recovered row 50000',revision:3},'a newer full snapshot supersedes queued stale deltas');
  result.newerSnapshotRejectsStaleDelta=true;
  window.destroy();
  window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false,additionalArguments:['--fixture-mode=missing-cas']}});
  await window.loadFile(htmlPath);await window.webContents.executeJavaScript('window.translationWorkshopLineReviewReady');
  await commitLineReviewStateInWorker({statePath:competingStatePath,projectRoot:root,state:{edits:{1:'Other window canonical draft'}},changedLines:[1],changedStateKeys:[],hydrate:true,mutationAccepted:true,expectedRevision:0});
  await commitLineReviewStateInWorker({statePath:competingStatePath,projectRoot:root,state:{edits:{3:'New canonical row three'}},changedLines:[3],changedStateKeys:[],hydrate:true,mutationAccepted:true,expectedRevision:1});
  window.webContents.send('fixture:update',{lineReviewPath:htmlPath,state:{documentRevision:2,edits:{1:'Other window canonical draft'}},changedLines:[1],partial:true});
  await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const deadline=Date.now()+1000;const check=()=>{if(lastCanonicalRevision===2)resolve();else if(Date.now()>deadline)reject(new Error("Partial canonical event did not arrive"));else setTimeout(check,10);};check();})');
  assert.deepEqual(await window.webContents.executeJavaScript('({hydrated:canonicalStateHydrated,observed:lastCanonicalRevision,legacy:state.edits[3],baseline:legacyMigrationBaseRevision})'),{hydrated:false,observed:2,legacy:'Stale legacy row three',baseline:0},'an incomplete delta cannot advance the complete migration baseline');
  await window.webContents.executeJavaScript('document.querySelectorAll(".target")[1].textContent="Competing local edit";document.querySelectorAll(".target")[1].dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"}));true');
  await assert.rejects(window.webContents.executeJavaScript('window.flushTranslationWorkshopLineReviewState()'),/draft changed/);
  assert.equal(JSON.parse(await readFile(competingStatePath,'utf8')).edits[1],'Other window canonical draft','another window creating the sidecar must win over stale legacy migration');
  assert.equal(JSON.parse(await readFile(competingStatePath,'utf8')).edits[3],'New canonical row three','legacy data outside the partial notification must never overwrite newer canonical rows');
  assert.equal(await window.webContents.executeJavaScript('JSON.parse(localStorage.getItem(key)).edits[2]'),'Competing local edit','rejected migration keeps its only durable local copy');
  assert.equal(requests.length,3);assert.equal(requests[2].expectedRevision,0);assert.deepEqual(requests[2].changedLines.map(Number).sort(),[1,2,3]);result.competingMigrationCasRejects=true;result.partialNotificationCannotAdvanceMigrationCas=true;
  window.destroy();
  window=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false,additionalArguments:['--fixture-mode=failure']}});
  await window.loadFile(htmlPath);
  await assert.rejects(window.webContents.executeJavaScript('window.translationWorkshopLineReviewReady'),/Fixture canonical read failed/);
  assert.equal(await window.webContents.executeJavaScript('document.body.inert'),true);
  assert.match(await window.webContents.executeJavaScript('document.getElementById("aiStatus").textContent'),/Fixture canonical read failed/);
  assert.equal(requests.length,3,'failed read must not write a sidecar');
  result.failedReadRejectsReady=true;result.readRequests=reads.length;result.pass=true;
}catch(error){result.pass=false;result.error=error.stack||String(error);process.exitCode=1;}
finally {clearTimeout(timeout);await writeFile(${JSON.stringify(path.join(root,'result.json'))},JSON.stringify(result,null,2));if(window&&!window.isDestroyed())window.destroy();app.quit();}
})();
`;
  const external=['electron','pdf-lib','pdfjs-dist','pdfjs-dist/*','@pdf-lib/fontkit','@napi-rs/canvas','@earendil-works/pi-ai','@earendil-works/pi-ai/*','@earendil-works/pi-agent-core','@earendil-works/pi-agent-core/*'];
  await build({stdin:{contents:main,resolveDir:process.cwd(),sourcefile:'review-open-renderer.ts'},bundle:true,platform:'node',format:'esm',outfile:path.join(root,'main.mjs'),external});
  await build({entryPoints:['src/main/lineReviewStateWorker.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(root,'lineReviewStateWorker.js'),external});
  await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  const code=await new Promise((resolve,reject)=>{const child=spawn(electron,['--disable-gpu','--no-sandbox',path.join(root,'main.mjs')],{cwd:process.cwd(),windowsHide:true,env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes.toString();});child.once('error',reject);child.once('close',resolve);});finished=true;
  const result=JSON.parse(await readFile(path.join(root,'result.json'),'utf8'));
  assert.equal(code,0,result.error??log);assert.equal(result.pass,true,result.error);assert.equal(result.visible,false);assert.equal(result.showEvents,0);
  assert.ok(before.length>1000000,'restore fixture includes a genuinely large existing canonical sidecar');
  if(process.env.YN_REVIEW_OPEN_EVIDENCE){await mkdir(path.resolve(process.env.YN_REVIEW_OPEN_EVIDENCE),{recursive:true});await writeFile(path.join(process.env.YN_REVIEW_OPEN_EVIDENCE,'renderer.json'),JSON.stringify(result,null,2));}
  console.log(JSON.stringify(result));
}finally {if(finished)await rm(root,{recursive:true,force:true});else console.error('Retained hidden Electron diagnostic fixture '+root+'\n'+log);}
