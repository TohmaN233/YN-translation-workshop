import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import electron from 'electron';
import {renderLineReviewHtml} from '../../src/shared/core/html.ts';

const root=await mkdtemp(path.join(os.tmpdir(),'yn-draft-import-'));
const cases=process.env.YN_IMPORT_CASE?[process.env.YN_IMPORT_CASE]:['file','file-manual','extracted-bound','artifact-legacy','artifact-edit','conflict','conflict-close','storage-failure','storage-conflict-text'];
let passed=false,output='';
try {
  for(const mode of cases){
    const project=path.join(root,mode),html=path.join(project,'.translation-workshop','html','review.html');
    await mkdir(path.dirname(html),{recursive:true});await mkdir(path.join(project,'AI_translation'),{recursive:true});
    const source=path.join(project,'source.txt'),candidate=mode==='extracted-bound'?path.join(project,'.translation-workshop','extracted-text','fixture','translation','source.translated.txt'):path.join(project,'AI_translation','source_translated.txt');
    await mkdir(path.dirname(candidate),{recursive:true});
    await writeFile(source,'The first sentence.\nThe second sentence.\nThe third sentence.');
    await writeFile(candidate,'第一句话。\n第二句话。\n第三句话。');
    await writeFile(html,renderLineReviewHtml({title:mode,sourceText:await readFile(source,'utf8'),lineReviewPath:html,workflow:{outputDir:project,sourcePath:source,languagePair:'en->zh-CN',...(mode==='extracted-bound'?{editableTranslationPath:candidate,translationPath:path.join(project,'original.epub'),promptTranslationPath:path.join(project,'original.epub')}:{})}}));
  }
  await writeFile(path.join(root,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');const mode=process.argv.find(x=>x.startsWith('--import-mode='))?.slice(14);localStorage.clear();if(mode==='artifact-legacy'||mode==='file-manual')localStorage.setItem('translation-workshop:line:'+location.pathname,JSON.stringify({documentRevision:8,edits:{2:'保留的人工修改'},status:{2:'manual'},revisionHistory:{2:[{text:'保留的人工修改'}]}}));contextBridge.exposeInMainWorld('workshopHtml',{openFile:()=>ipcRenderer.invoke('fixture:choose'),readTextFile:args=>ipcRenderer.invoke('fixture:text',args),readLineReviewState:args=>ipcRenderer.invoke('fixture:read',args),persistHtmlState:args=>ipcRenderer.invoke('fixture:persist',args),buildAgentImportPlan:args=>ipcRenderer.invoke('agent-artifacts:importPlan',args),cancelAgentArtifacts:args=>ipcRenderer.invoke('agent-artifacts:cancel',args),readProjectState:async()=>({}),updateProjectState:args=>ipcRenderer.invoke('fixture:project',args),onLineReviewStateUpdate:callback=>{const listener=(_event,payload)=>callback(payload);ipcRenderer.on('fixture:update',listener);return()=>ipcRenderer.removeListener('fixture:update',listener);}});`);
  const main=`
import assert from 'node:assert/strict';
import {app,BrowserWindow,ipcMain} from 'electron';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {commitLineReviewStateInWorker} from './src/main/lineReviewStateWorkerService.ts';
import {registerAgentArtifactIpc} from './src/main/ipc/agentArtifactHandlers.ts';
const root=${JSON.stringify(root)},cases=${JSON.stringify(cases)},result={cases:[],network:0,shows:0};let window,project,mode,queue=Promise.resolve(),requests=[],projectWrites=[],bulkEntered,releaseBulk,entered,release;
app.disableHardwareAcceleration();app.setPath('userData',path.join(root,'profile'));app.on('window-all-closed',()=>{});
const statePath=()=>path.join(project,'.translation-workshop','state','line-review.html.json');
const candidate=()=>mode==='extracted-bound'?path.join(project,'.translation-workshop','extracted-text','fixture','translation','source.translated.txt'):path.join(project,'AI_translation','source_translated.txt');
ipcMain.handle('fixture:choose',()=>candidate());
ipcMain.handle('fixture:text',async(_event,args)=>({path:args.path,text:await readFile(args.path,'utf8')}));
ipcMain.handle('fixture:project',(_event,args)=>{projectWrites.push(args.patch);return args.patch;});
ipcMain.handle('fixture:read',async()=>{try{return {state:JSON.parse(await readFile(statePath(),'utf8'))};}catch(error){if(error.code==='ENOENT')return {};throw error;}});
ipcMain.handle('fixture:persist',async(event,args)=>{
 requests.push({expectedRevision:args.expectedRevision,bulk:args.bulk,changedLines:args.changedLines,changedStateKeys:args.changedStateKeys});
 const task=queue.catch(()=>undefined).then(async()=>{
  if(mode==='conflict-close'&&args.bulk){bulkEntered();await release;}
  if(mode.startsWith('storage')&&args.bulk)throw new Error(mode==='storage-conflict-text'?'Fixture disk persistence failed: EACCES writing C:/The draft changed during import;/sidecar.json':'Fixture disk persistence failed');
  if(mode.startsWith('conflict')&&args.bulk)await commitLineReviewStateInWorker({statePath:statePath(),projectRoot:project,state:{edits:{3:'另一个窗口的新修改'}},changedLines:[3],changedStateKeys:[],mutationAccepted:true,hydrate:true});
  const state=await commitLineReviewStateInWorker({statePath:statePath(),projectRoot:project,state:args.state,changedLines:args.changedLines,changedStateKeys:args.changedStateKeys,mutationAccepted:true,hydrate:args.hydrate!==false,expectedRevision:args.expectedRevision});
  const payload={ok:true,state:args.bulk?{documentRevision:state.documentRevision}:state,lineReviewPath:args.lineReviewPath,changedLines:args.bulk?[]:args.changedLines,changedStateKeys:args.bulk?[]:args.changedStateKeys,partial:args.hydrate===false,ackOnly:args.bulk,clientId:args.clientId,mutationId:args.mutationId,mutationAccepted:true};
  if(!args.bulk)event.sender.send('fixture:update',payload);return payload;
 });queue=task;return task;
});
registerAgentArtifactIpc();
const timer=setTimeout(()=>{result.error='Import regression timed out';process.exitCode=1;void writeFile(root+'/result.json',JSON.stringify(result)).then(()=>app.quit());},30000);
function closeFixtureWindow(){
 const owned=window;
 return new Promise((resolve,reject)=>{
  owned.once('closed',resolve);
  owned.once('close',event=>{event.preventDefault();void owned.webContents.executeJavaScript('window.flushTranslationWorkshopLineReviewState()').then(()=>owned.destroy(),reject);});
  owned.close();
 });
}
void app.whenReady().then(async()=>{try{
 for(mode of cases){project=path.join(root,mode);requests=[];projectWrites=[];queue=Promise.resolve();entered=new Promise(r=>bulkEntered=r);release=new Promise(r=>releaseBulk=r);const item={mode};
  if(mode.startsWith('conflict')||mode.startsWith('storage')){await mkdir(path.dirname(statePath()),{recursive:true});await writeFile(statePath(),JSON.stringify({documentRevision:4,edits:{1:'原草稿'},status:{1:'manual'}}));}
  window=new BrowserWindow({show:false,webPreferences:{preload:root+'/preload.cjs',contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false,additionalArguments:['--import-mode='+mode]}});window.on('show',()=>result.shows++);window.webContents.session.webRequest.onBeforeRequest((d,c)=>{const remote=/^https?:/.test(d.url);if(remote)result.network++;c({cancel:remote});});
  try{
   await window.loadFile(path.join(project,'.translation-workshop','html','review.html'));await window.webContents.executeJavaScript('window.translationWorkshopLineReviewReady');
   assert.equal(await window.webContents.executeJavaScript('lanSyncToken'),'','the regression never starts LAN');
   const editableBefore=await window.webContents.executeJavaScript('workflow.paths.editableTranslationPath');
   if(mode.startsWith('file'))await window.webContents.executeJavaScript('chooseTranslationFile()');
   else if(mode==='extracted-bound')assert.equal(await window.webContents.executeJavaScript('syncFromBoundTranslationFile()'),true);
   else if(mode==='conflict-close'){
    const importing=window.webContents.executeJavaScript('importArtifactAsDraft('+JSON.stringify(candidate())+','+JSON.stringify(path.join(project,'source.txt'))+')');
    const rejected=assert.rejects(importing,/draft changed/);await entered;
    const closing=closeFixtureWindow();releaseBulk();await rejected;await closing;
    assert.equal(JSON.parse(await readFile(statePath(),'utf8')).edits[3],'另一个窗口的新修改');
    item.pass=true;item.closedDuringRejectedCommit=true;continue;
   }else if(mode.startsWith('storage')){
    await assert.rejects(window.webContents.executeJavaScript('importArtifactAsDraft('+JSON.stringify(candidate())+','+JSON.stringify(path.join(project,'source.txt'))+')'),/disk persistence failed/);
    await assert.rejects(window.webContents.executeJavaScript('window.flushTranslationWorkshopLineReviewState()'),/disk persistence failed/);
    assert.equal(JSON.parse(await readFile(statePath(),'utf8')).edits[1],'原草稿');
    assert.match(await window.webContents.executeJavaScript('document.querySelector("#aiStatus").textContent'),/disk persistence failed/);
    item.pass=true;item.realStorageFailureRemainsVisible=true;continue;
   }
   else if(mode==='conflict'){
    await assert.rejects(window.webContents.executeJavaScript('importArtifactAsDraft('+JSON.stringify(candidate())+','+JSON.stringify(path.join(project,'source.txt'))+')'),/draft changed/);
    assert.equal(JSON.parse(await readFile(statePath(),'utf8')).edits[3],'另一个窗口的新修改');
    assert.equal(await window.webContents.executeJavaScript('state.edits[1]'),'原草稿');
    assert.equal(await window.webContents.executeJavaScript('workflow.paths.editableTranslationPath'),editableBefore,'rejected import restores the original file binding');
   }else await window.webContents.executeJavaScript('importArtifactAsDraft('+JSON.stringify(candidate())+','+JSON.stringify(path.join(project,'source.txt'))+')');
   if(mode==='artifact-edit'){
    assert.equal(await window.webContents.executeJavaScript('canonicalStateHydrated'),true,'successful full import establishes canonical ownership');
    await window.webContents.executeJavaScript('const cell=document.querySelector(".target");cell.textContent="导入后的人工修改";cell.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText"}));true');
   }
   await window.webContents.executeJavaScript('window.flushTranslationWorkshopLineReviewState()');
   const stored=JSON.parse(await readFile(statePath(),'utf8'));item.requests=requests;item.projectWrites=projectWrites;item.storedRevision=stored.documentRevision;
   if(mode.startsWith('file')){assert.equal(await window.webContents.executeJavaScript('rowValue(data.rows[0])'),'第一句话。');assert.equal(requests.length,1,'file content and binding commit once');assert.equal(stored.syncedFile.replaceAll('\\\\','/'),'AI_translation/source_translated.txt');assert.equal(stored.translationPath.replaceAll('\\\\','/'),'AI_translation/source_translated.txt');}
   if(mode==='file-manual'){assert.equal(stored.edits[2],'保留的人工修改');assert.equal(stored.status[2],'manual');assert.ok(stored.revisionHistory[2].length);}
   if(mode==='extracted-bound'){
    assert.equal(requests.length,1,'extracted binding must also defer its separate save');
    assert.equal(await window.webContents.executeJavaScript('rowValue(data.rows[0])'),'第一句话。');
    assert.equal(await window.webContents.executeJavaScript('workflow.paths.translationPath'),path.join(project,'original.epub'));
    assert.equal(projectWrites.some(patch=>Object.hasOwn(patch,'translationPath')),false,'working projection cannot replace the original project binding');
   }
   if(mode==='artifact-edit')assert.equal(stored.edits[1],'导入后的人工修改');
   if(mode==='artifact-legacy'){assert.equal(stored.edits[1],'第一句话。');assert.ok(stored.revisionHistory[2].length,'import retains manual revision history');assert.equal(requests[0].expectedRevision,0,'missing sidecar CAS uses the canonical baseline, not browser revision');}
   assert.doesNotMatch(await window.webContents.executeJavaScript('document.querySelector("#aiStatus").textContent'),/局域网同步失败|LAN sync failed/,'ordinary import errors must not claim LAN failure');
   await closeFixtureWindow();item.pass=true;item.closeFlushPassed=true;item.nativeWindowClosed=true;
  }catch(error){item.pass=false;item.error=error.stack||String(error);process.exitCode=1;}finally{result.cases.push(item);window.destroy();window=undefined;}
 }
 assert.equal(result.network,0);assert.equal(result.shows,0);result.pass=result.cases.every(x=>x.pass);
}catch(error){result.error=error.stack||String(error);process.exitCode=1;}finally{clearTimeout(timer);await writeFile(root+'/result.json',JSON.stringify(result,null,2));if(window&&!window.isDestroyed())window.destroy();app.quit();}});
`;
  const external=['electron','cheerio','cheerio/*','pdf-lib','pdfjs-dist','pdfjs-dist/*','@pdf-lib/fontkit','@napi-rs/canvas','@earendil-works/pi-ai','@earendil-works/pi-ai/*','@earendil-works/pi-agent-core','@earendil-works/pi-agent-core/*'];
  await build({stdin:{contents:main,resolveDir:process.cwd(),sourcefile:'draft-import-main.ts'},bundle:true,platform:'node',format:'esm',outfile:path.join(root,'main.mjs'),external,banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'}});
  for(const [name,entry]of [['lineReviewStateWorker','src/main/lineReviewStateWorker.ts'],['translationValidationWorker','src/main/agent/piNative/translationValidationWorker.ts']])await build({entryPoints:[entry],bundle:true,platform:'node',format:'esm',outfile:path.join(root,name+'.js'),external});
  await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  const code=await new Promise((resolve,reject)=>{const child=spawn(electron,['--disable-gpu','--no-sandbox',path.join(root,'main.mjs')],{cwd:process.cwd(),windowsHide:true,env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},stdio:['ignore','pipe','pipe']});for(const s of[child.stdout,child.stderr])s.on('data',b=>{output+=b;});child.once('error',reject);child.once('close',resolve);});
  const result=JSON.parse(await readFile(path.join(root,'result.json'),'utf8'));console.log(JSON.stringify({root,...result},null,2));
  if(process.env.YN_IMPORT_EVIDENCE){await mkdir(process.env.YN_IMPORT_EVIDENCE,{recursive:true});await writeFile(path.join(process.env.YN_IMPORT_EVIDENCE,'result.json'),JSON.stringify({root,...result},null,2));await writeFile(path.join(process.env.YN_IMPORT_EVIDENCE,'electron.log'),output);}
  assert.equal(code,0,result.error||JSON.stringify(result.cases));assert.equal(result.pass,true);passed=true;
}finally{if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained import diagnostics: '+root+'\n'+output);}
