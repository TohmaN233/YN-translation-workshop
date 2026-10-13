import assert from 'node:assert/strict';
import {build} from 'esbuild';import {spawn} from 'node:child_process';import {readFile,writeFile,copyFile,readdir,mkdtemp,mkdir,rm} from 'node:fs/promises';import path from 'node:path';
const dir=await mkdtemp(path.resolve('.tmp-electron-session-storage-'));
const accepted=[];
let observedMainFiles=0;
await build({entryPoints:['scripts/verify-electron-storage-main.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(dir,'electron-main.mjs'),
 banner:{js:'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);'},
 external:['electron','electron-updater','electron-updater/*','extract-zip','cheerio','cheerio/*','pdfjs-dist','pdfjs-dist/*','pdf-lib','@pdf-lib/fontkit','@napi-rs/canvas','@earendil-works/pi-ai','@earendil-works/pi-ai/*','@earendil-works/pi-agent-core','@earendil-works/pi-agent-core/*'],
 plugins:[{name:'observe-real-main-boundaries',setup(builder){builder.onLoad({filter:/[\\/]src[\\/]main[\\/]main\.ts$/},async args=>{
  let source=await readFile(args.path,'utf8');
  observedMainFiles++;
  assert.equal(source.split('const resolvedTargetPath = await resolveHtmlOpenTarget(targetPath);').length,2,'open instrumentation anchor must match once');
  source=source.replace('const resolvedTargetPath = await resolveHtmlOpenTarget(targetPath);','await (globalThis as any).__ynOpenGate?.(); const resolvedTargetPath = await resolveHtmlOpenTarget(targetPath);');
  const start=source.indexOf('async function flushHtmlViewerTabState('),end=source.indexOf('\nfunction disposeHtmlViewerTabs(',start);
  assert.ok(start>=0&&end>start,'real HTML save function must be present');
  const segment=source.slice(start,end);const closing=segment.lastIndexOf('}');
  assert.ok(closing>=0);assert.equal(source.split('function disposeHtmlViewerTabs(window: BrowserWindow, tabs: HtmlViewerTab[]): void {').length,2,'dispose instrumentation anchor must match once');
  source=source.slice(0,start)+segment.slice(0,closing)+'(globalThis as any).__ynFlushedTabs=((globalThis as any).__ynFlushedTabs??0)+1;\n'+segment.slice(closing)+source.slice(end);
  source=source.replace('function disposeHtmlViewerTabs(window: BrowserWindow, tabs: HtmlViewerTab[]): void {','function disposeHtmlViewerTabs(window: BrowserWindow, tabs: HtmlViewerTab[]): void { (globalThis as any).__ynDisposedTabs=tabs.length;');
  return {contents:source,loader:'ts'};
 });}}]});
assert.equal(observedMainFiles,1,'verifier must instrument the actual main module');
for(const worker of await readdir('dist/main'))if(worker.endsWith('Worker.js'))await copyFile(path.join('dist/main',worker),path.join(dir,worker));
for(const mode of ['normal','failure','close-failure','open-race']){
const failureMode=mode==='failure',closeFailureMode=mode==='close-failure',raceMode=mode==='open-race';
const code=await new Promise((resolve,reject)=>{
 const child=spawn(path.resolve('node_modules/electron/dist/electron.exe'),['--disable-gpu','--no-sandbox',path.join(dir,'electron-main.mjs')],
  {cwd:process.cwd(),windowsHide:true,env:{...process.env,YN_QUIT_CLOSE_FAILURE_FIXTURE:closeFailureMode?'1':'0',YN_SESSION_STORAGE_VERIFY_DIR:dir,YN_QUIT_OPEN_RACE_FIXTURE:raceMode?'1':'0',YN_QUIT_FAILURE_FIXTURE:failureMode?'1':'0',YN_ELECTRON_VERIFY_HEADLESS:'1',YN_ELECTRON_VERIFY_OFFSCREEN:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},stdio:['ignore','pipe','pipe']});
 let log='';const logPath=path.join(dir,`${mode}.log`);
 const timer=setTimeout(async()=>{
  try{
   await writeFile(logPath,log);await writeFile(path.join(dir,`${mode}-timeout.json`),JSON.stringify({mode,pid:child.pid,fixture:dir,logPath,processPreserved:true},null,2));
   reject(new Error(`Electron storage verifier timed out in ${mode}; PID ${child.pid} and fixture ${dir} retained, no process was killed.`));
  }catch(error){reject(error);}
 },120000);
 child.stdout.on('data',bytes=>{log+=bytes;process.stdout.write(bytes)});child.stderr.on('data',bytes=>{log+=bytes;process.stderr.write(bytes)});
 child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('close',async code=>{clearTimeout(timer);try{await writeFile(logPath,log);resolve(code);}catch(error){reject(error);}});
});assert.equal(code,0);
const resultPath=path.join(dir,failureMode?'electron-failure-result.json':closeFailureMode?'electron-close-failure-result.json':raceMode?'electron-open-race-result.json':'electron-result.json');
const result=JSON.parse(await readFile(resultPath,'utf8'));
assert.equal(result.closed,true);assert.equal(result.activeOwners,0);assert.ok(result.flushCalls>0);assert.ok(result.elapsedMs>=100);assert.equal(result.visible,false);assert.equal(result.externalSourceIpc,true);
const index=JSON.parse(await readFile(result.sessionFile+'.yn-index.json','utf8')).index;
assert.deepEqual(index.hostRestorePoint.current.proofread.documents.chapter.sampledLines,[20]);
if(failureMode||closeFailureMode)assert.equal(result.failureRecovered,true,'failed real-main quit must restore the usable window before retry');
if(raceMode){assert.equal(result.flushedTabs,1);assert.equal(result.disposedTabs,1);assert.ok(result.elapsedMs>=300,'quit must await the late open and its real renderer flush');}
await writeFile(resultPath,JSON.stringify({...result,restorePointVerified:true},null,2));
accepted.push({...result,restorePointVerified:true,mode});
console.log(JSON.stringify(accepted.at(-1)));
}
const out=path.resolve('artifacts/verification');await mkdir(out,{recursive:true});
await writeFile(path.join(out,'electron-session-storage.json'),JSON.stringify({sessionStorageAcceptance:true,accepted},null,2));
if(!path.resolve(dir).startsWith(path.resolve('.tmp-electron-session-storage-')))throw new Error('Unsafe verifier cleanup target.');
await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100});
