import {app,BrowserWindow,dialog} from 'electron';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {createModels,fauxProvider,fauxAssistantMessage,fauxText} from '@earendil-works/pi-ai';
import {piNativeSessionService} from '../src/main/agent/piNative/sessionService.ts';
import {getDiskSessionAccess} from '../src/main/agent/piNative/sessionAccess.ts';

const evidence=process.env.YN_SESSION_STORAGE_VERIFY_DIR;
if(!evidence)throw new Error('Missing isolated session-storage verifier directory.');
const fixture=path.join(evidence,'electron-project');
app.setPath('userData',path.join(fixture,'user-data'));app.setAppPath(process.cwd());app.disableHardwareAcceleration();
const provider=fauxProvider({tokensPerSecond:100000});provider.setResponses([fauxAssistantMessage(fauxText('Ready'))]);
const models=createModels();models.setProvider(provider.provider);
const options=(piNativeSessionService as any).options;
options.createTools=()=>[];
options.createModelSelection=async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id});
const failureMode=process.env.YN_QUIT_FAILURE_FIXTURE==='1';
const closeFailureMode=process.env.YN_QUIT_CLOSE_FAILURE_FIXTURE==='1';
const raceMode=process.env.YN_QUIT_OPEN_RACE_FIXTURE==='1';
let openEntered!:()=>void,releaseOpen!:()=>void;
const openBegan=new Promise<void>(resolve=>{openEntered=resolve}),openGate=new Promise<void>(resolve=>{releaseOpen=resolve});
if(raceMode)(globalThis as any).__ynOpenGate=async()=>{openEntered();await openGate;};
let sessionFile='',flushCalls=0,closed=false,started=0,ipcAccepted=false,failureRecovered=false,restoreSave=()=>{};
if(failureMode||closeFailureMode)dialog.showMessageBox=async(options:any)=>{
 assert.match(options.message,/Exit cancelled/);
 const windows=BrowserWindow.getAllWindows();assert.ok(windows.length);assert.ok(windows.every(win=>win.isEnabled()));
 assert.equal((piNativeSessionService as any).shuttingDown,false);failureRecovered=true;
 if(failureMode){assert.equal(closed,false);assert.equal((piNativeSessionService as any).active.size,1);}else{assert.equal(closed,true);assert.equal((piNativeSessionService as any).active.size,0);}
 restoreSave();
 setImmediate(()=>app.quit());return {response:0,checkboxChecked:false};
};
app.on('quit',()=>{
 writeFileSync(path.join(evidence,failureMode?'electron-failure-result.json':closeFailureMode?'electron-close-failure-result.json':raceMode?'electron-open-race-result.json':'electron-result.json'),JSON.stringify({desktopQuit:true,closed,flushCalls,failureRecovered,elapsedMs:Date.now()-started,
  openRace:raceMode,flushedTabs:(globalThis as any).__ynFlushedTabs??0,disposedTabs:(globalThis as any).__ynDisposedTabs??0,
  activeOwners:piNativeSessionService.active.size,externalSourceIpc:ipcAccepted,sessionFile,paidCalls:0,visible:BrowserWindow.getAllWindows().some(win=>win.isVisible())},null,2));
});
await import('../src/main/main.ts');
void app.whenReady().then(async()=>{
 try{
  const project=path.join(fixture,'Translation'),source=path.join(fixture,'data','chapter.txt'),candidate=path.join(project,'AI_translation','chapter_translated.txt');
  await mkdir(path.dirname(source),{recursive:true});await mkdir(path.dirname(candidate),{recursive:true});
  await writeFile(source,'Hello Bob.');await writeFile(candidate,'你好，鲍勃。');
  const selected=await piNativeSessionService.createSession(project);
  await piNativeSessionService.prompt({outputDir:project,sessionId:selected.id,prompt:'Hello',providerId:provider.provider.id,modelId:provider.getModel().id});
  const active=[...(piNativeSessionService as any).active.values()][0];await active.promptTask;
  for(let i=0;i<20;i++){
   active.hostState.proofread.documents.chapter={sampledLines:[i+1],reportInitialized:true,completedSplitScopes:[],glossaryCandidates:[]};
   await active.persistHostState();
  }
  sessionFile=active.session.metadata.path;
  const storage=getDiskSessionAccess(active.session)!.storage,flush=storage.flushDerivedIndex.bind(storage),close=active.session.close.bind(active.session);
  if(failureMode){const internal=storage as any,refresh=internal.refreshIndex;internal.refreshIndex=async()=>{throw new Error('Injected actual desktop index save failure')};restoreSave=()=>{internal.refreshIndex=refresh;};}
  storage.flushDerivedIndex=async(...args:any[])=>{flushCalls++;await new Promise(resolve=>setTimeout(resolve,100));return flush(...args);};
  active.session.close=async(...args:any[])=>{await close(...args);closed=true;if(closeFailureMode)throw new Error('Injected terminal native close failure');};
  const page=path.join(fixture,'test.html');await writeFile(page,'<!doctype html><title>Artifact IPC</title>');
  const win=new BrowserWindow({show:false,webPreferences:{preload:path.resolve('dist/main/preload.cjs'),contextIsolation:true,nodeIntegration:false}});
  await win.loadFile(page);
  const args={projectDir:project,sourcePath:source,candidatePath:candidate,languagePair:'en->zh-CN',locale:'zh-CN'};
  const discovery=await win.webContents.executeJavaScript(`window.workshopHtml.discoverAgentArtifacts(${JSON.stringify({projectDir:project,sourcePaths:[source]})})`);
  assert.equal(discovery[0].sourcePath,source);
  const plan=await win.webContents.executeJavaScript(`window.workshopHtml.buildAgentImportPlan(${JSON.stringify(args)})`);assert.equal(plan.ok,true);assert.equal(plan.edits[1],'你好，鲍勃。');
  ipcAccepted=true;assert.equal(BrowserWindow.getAllWindows().some(win=>win.isVisible()),false);
  if(raceMode){
   const review=path.join(fixture,'review.html');await writeFile(review,'<!doctype html><script>window.flushTranslationWorkshopLineReviewState=async()=>{await new Promise(resolve=>setTimeout(resolve,150));};</script>');
   void win.webContents.executeJavaScript(`window.workshopHtml.openReviewHtml(${JSON.stringify({htmlPath:review,activate:false})})`).catch(error=>console.error('Open IPC failed',error));
   await openBegan;started=Date.now();app.quit();setTimeout(releaseOpen,150);
  }else{started=Date.now();app.quit();}
 }catch(error){console.error(error);app.exit(1);}
}).catch(error=>{console.error(error);app.exit(1);});
