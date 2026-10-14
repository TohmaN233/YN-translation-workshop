import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import electron from 'electron';
import {renderLineReviewHtml,renderBatchLineReviewIndexHtml,LINE_REVIEW_PROTOCOL_MARKER} from '../../src/shared/core/html.ts';

const root=await mkdtemp(path.join(os.tmpdir(),'yn-review-fixture-bridge-'));
const htmlDir=path.join(root,'.translation-workshop','html'),stateDir=path.join(root,'.translation-workshop','state');
let passed=false,log='';
try {
  await mkdir(htmlDir,{recursive:true});await mkdir(stateDir,{recursive:true});
  const single=path.join(htmlDir,'single.html'),index=path.join(htmlDir,'index.html'),children=[path.join(htmlDir,'a.html'),path.join(htmlDir,'b.html')];
  for(const file of [single,...children]) {
    const html=renderLineReviewHtml({title:path.basename(file),sourceText:'Original sentence.',translationText:'',lineReviewPath:file,workflow:{sourcePath:path.join(root,path.basename(file)+'.txt'),outputDir:root}});
    await writeFile(file,children.includes(file)?html.replace(LINE_REVIEW_PROTOCOL_MARKER,'translation-workshop-line-review-v55'):html);
    await writeFile(path.join(stateDir,'line-'+path.basename(file)+'.json'),JSON.stringify({documentRevision:1,edits:{1:'Saved '+path.basename(file)},status:{1:'manual'}}));
  }
  await writeFile(index,renderBatchLineReviewIndexHtml({title:'Fixture batch',files:children.map(file=>({sourceName:path.basename(file)+'.txt',sourcePath:path.join(root,path.basename(file)+'.txt'),outputPath:path.basename(file),status:'matched',sourceLineCount:1})),workflow:{sourcePath:root,sourceKind:'folder',outputDir:root}}));
  const siblingBefore=await readFile(children[1]),firstStateBefore=await readFile(path.join(stateDir,'line-a.html.json'));
  const main=`
import assert from 'node:assert/strict';
import {app,BrowserWindow,ipcMain} from 'electron';
import {readFile,writeFile} from 'node:fs/promises';
import {registerReviewHtmlFixtureReadIpc} from './tests/helpers/review-html-fixture-ipc.ts';
import {commitLineReviewStateInWorker} from './src/main/lineReviewStateWorkerService.ts';
app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});app.setPath('userData',${JSON.stringify(path.join(root,'user-data'))});
const root=${JSON.stringify(root)},single=${JSON.stringify(single)},index=${JSON.stringify(index)},children=${JSON.stringify(children)},stateDir=${JSON.stringify(stateDir)},result={};let window,writes=0,network=0,shows=0;
const timeout=setTimeout(()=>{result.error='Fixture bridge timed out';process.exitCode=1;void writeFile(root+'/result.json',JSON.stringify(result)).then(()=>app.quit());},20000);
void(async()=>{await app.whenReady();try{
  registerReviewHtmlFixtureReadIpc();ipcMain.handle('project:readState',()=>({}));ipcMain.handle('project:patch',()=>({}));ipcMain.handle('agent-interface:publish',()=>({ok:true}));ipcMain.handle('agent-artifacts:cancel',()=>({ok:true}));ipcMain.handle('agent-assets:read',()=>({glossary:{entries:[]},characterBible:{characters:[],source:''},styleGuide:''}));
  ipcMain.handle('html:persistState',async(_event,args)=>{writes++;const state=await commitLineReviewStateInWorker({statePath:stateDir+'/line-'+args.lineReviewPath.replace(/.*[\\\\/]/u,'')+'.json',projectRoot:root,state:args.state,changedLines:args.changedLines,changedStateKeys:args.changedStateKeys,hydrate:args.hydrate!==false,mutationAccepted:true,expectedRevision:args.expectedRevision});return {ok:true,lineReviewPath:args.lineReviewPath,state,partial:args.hydrate===false,changedLines:args.changedLines,clientId:args.clientId,mutationId:args.mutationId};});
  window=new BrowserWindow({show:false,webPreferences:{preload:root+'/preload.cjs',contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});window.on('show',()=>shows++);
  window.webContents.session.webRequest.onBeforeRequest((details,callback)=>{const remote=/^https?:/.test(details.url);if(remote)network++;callback({cancel:remote});});
  await window.loadFile(single);await window.webContents.executeJavaScript('window.translationWorkshopLineReviewReady');
  assert.deepEqual(await window.webContents.executeJavaScript('({text:document.querySelector(".target").textContent,inert:document.body.inert,editable:document.querySelector(".target").contentEditable})'),{text:'Saved single.html',inert:false,editable:'true'});assert.equal(writes,0);
  await window.loadFile(index);
  const childReady=async(name)=>{const end=Date.now()+6000;while(Date.now()<end){const value=await window.webContents.executeJavaScript('(async()=>{const frame=document.querySelector("#fileFrame")?.contentWindow;if(!frame?.translationWorkshopLineReviewReady)return;await frame.translationWorkshopLineReviewReady;return {title:frame.document.title,text:frame.document.querySelector(".target")?.textContent,inert:frame.document.body.inert}})()');if(value?.title===name)return value;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Child not ready: '+name);};
  assert.deepEqual(await childReady('a.html'),{title:'a.html',text:'Saved a.html',inert:false});assert.equal(writes,0);
  assert.equal(await readFile(stateDir+'/line-a.html.json','utf8'),${JSON.stringify(firstStateBefore.toString())},'restoring a child does not rewrite its sidecar');
  assert.equal(await readFile(children[1],'utf8'),${JSON.stringify(siblingBefore.toString())},'the unselected child stays untouched');
  await window.webContents.executeJavaScript('document.querySelector("#fileSelect").value="1";document.querySelector("#fileSelect").dispatchEvent(new Event("change"));true');
  assert.deepEqual(await childReady('b.html'),{title:'b.html',text:'Saved b.html',inert:false});assert.equal(writes,0);
  await window.webContents.executeJavaScript('const child=document.querySelector("#fileFrame").contentWindow;const editor=child.document.querySelector(".target");editor.textContent="Actual fixture edit";editor.dispatchEvent(new child.InputEvent("input",{bubbles:true,inputType:"insertText"}));child.flushTranslationWorkshopLineReviewState()');
  assert.equal(writes,1);assert.equal(JSON.parse(await readFile(stateDir+'/line-b.html.json','utf8')).edits[1],'Actual fixture edit');
  assert.equal(network,0);assert.equal(shows,0);assert.equal(window.isVisible(),false);Object.assign(result,{pass:true,readonlyTopAndChildren:true,initialWrites:0,actualWorkerEdits:writes,network,shows});
}catch(error){result.error=error.stack||String(error);process.exitCode=1;}finally{clearTimeout(timeout);await writeFile(root+'/result.json',JSON.stringify(result,null,2));if(window&&!window.isDestroyed())window.destroy();app.quit();}})();`;
  const external=['electron','pdf-lib','pdfjs-dist','pdfjs-dist/*','@pdf-lib/fontkit','@napi-rs/canvas','@earendil-works/pi-ai','@earendil-works/pi-ai/*','@earendil-works/pi-agent-core','@earendil-works/pi-agent-core/*'];
  await build({stdin:{contents:main,sourcefile:'review-fixture-main.ts',resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:path.join(root,'main.mjs'),external,banner:{js:'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);'}});
  await build({entryPoints:['src/main/preload.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(root,'preload.cjs'),external:['electron']});
  await build({entryPoints:['src/main/lineReviewStateWorker.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(root,'lineReviewStateWorker.js'),external});
  await writeFile(path.join(root,'package.json'),'{"type":"module"}');
  const code=await new Promise((resolve,reject)=>{const child=spawn(electron,['--disable-gpu','--no-sandbox',path.join(root,'main.mjs')],{cwd:process.cwd(),windowsHide:true,env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes.toString();});child.once('error',reject);child.once('close',resolve);});
  const result=JSON.parse(await readFile(path.join(root,'result.json'),'utf8'));assert.equal(code,0,result.error||log);assert.equal(result.pass,true,result.error);passed=true;console.log(JSON.stringify(result));
  if(process.env.YN_REVIEW_OPEN_EVIDENCE)await writeFile(path.join(process.env.YN_REVIEW_OPEN_EVIDENCE,'fixture-bridge.json'),JSON.stringify(result,null,2));
}finally{if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained fixture bridge diagnostics: '+root+'\n'+log);}
