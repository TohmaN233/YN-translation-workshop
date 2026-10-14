import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,cp,writeFile,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import electronPath from 'electron';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {connectYnAgent} from '../agent-tools/yn-agent-client.mjs';
import {createPdfStructureHttpProvider} from '../tests/helpers/pdf-structure-http-provider.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const evidence=path.join(root,'artifacts','pdf-preparation-electron-2026-10-14',String(process.pid));
const runtime=path.join(evidence,'app'),mainDir=path.join(runtime,'dist','main');
await mkdir(mainDir,{recursive:true});
const providerLog=[];
const provider=createPdfStructureHttpProvider({onRecord:value=>{providerLog.push(value);}});
const mock=await provider;
let api;
const external=['electron','electron-updater','electron-updater/*','extract-zip','cheerio','cheerio/*','pdfjs-dist','pdfjs-dist/*','pdf-lib','@pdf-lib/fontkit','@napi-rs/canvas','@earendil-works/pi-ai','@earendil-works/pi-ai/*','@earendil-works/pi-agent-core','@earendil-works/pi-agent-core/*'];
const banner={js:'import {createRequire as __ynRequire} from "node:module";const require=__ynRequire(import.meta.url);'};
const report={evidence,paidCalls:0};
const output=[];
try {
  await cp(path.join(root,'assets'),path.join(runtime,'assets'),{recursive:true});
  await cp(path.join(root,'dist','renderer'),path.join(runtime,'dist','renderer'),{recursive:true});
  await cp(path.join(root,'package.json'),path.join(runtime,'package.json'));
  await build({absWorkingDir:root,entryPoints:['src/main/preload.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(mainDir,'preload.cjs'),external:['electron']});
  const workers={sourcePreparationWorker:'src/main/agent/sourcePreparationWorker.ts',translationValidationWorker:'src/main/agent/piNative/translationValidationWorker.ts',proofreadPrescanWorker:'src/main/agent/piNative/proofreadPrescanWorker.ts',
    sessionIndexWorker:'src/main/agent/piNative/sessionIndexWorker.ts',sessionMaintenanceWorker:'src/main/agent/piNative/sessionMaintenanceWorker.ts',sessionHostReplayWorker:'src/main/agent/piNative/sessionHostReplayWorker.ts',
    lineReviewStateWorker:'src/main/lineReviewStateWorker.ts',pdfBindingWorker:'src/main/pdfBindingWorker.ts',pdfWorker:'src/main/pdfWorker.ts'};
  await Promise.all(Object.entries(workers).map(([name,source])=>build({absWorkingDir:root,entryPoints:[source],bundle:true,platform:'node',format:'esm',outfile:path.join(mainDir,name+'.js'),external,banner})));
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([600,800]).drawText('Mechanical source sentence\ncontinues in the next source line.',{x:40,y:740,size:12,lineHeight:14,font});
  const sourcePath=path.join(evidence,'source.pdf');await writeFile(sourcePath,await pdf.save());
  const settings={sourcePath,fileType:'pdf',inputMode:'separate',locale:'en-US',pageSize:1000,sourcePosition:2,translationPosition:1,languagePair:'en->zh-CN',glossaryCandidates:false,characterBible:false,subagentEnabled:false};
  const driver=`
import assert from 'node:assert/strict';
import {app,BrowserWindow,session} from 'electron';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {pdfProtectionHash} from './src/main/pdfTypes.ts';
import {piNativeSessionService} from './src/main/agent/piNative/sessionService.ts';
const evidence=${JSON.stringify(evidence)},runtime=${JSON.stringify(runtime)},control=${JSON.stringify(mock.controlUrl)},config=${JSON.stringify(mock.config)},settings=${JSON.stringify(settings)};
app.setAppPath(runtime);app.disableHardwareAcceleration();
const networkAttempts=[],opened=[],projects=[],result={};
let showEvents=0;
app.on('browser-window-created',(_event,window)=>{if(window.isVisible())showEvents++;window.on('show',()=>showEvents++);});
const productionExit=app.exit.bind(app);
const isSmoke=process.argv.some(arg=>arg.startsWith('--yn-portable-smoke='));
app.exit=(code=0)=>{writeFileSync(path.join(evidence,isSmoke?'smoke-window-events.json':'api-window-events.json'),JSON.stringify({code,opened,networkAttempts,showEvents},null,2));productionExit(code);};
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){networkAttempts.push(url.href);throw Error('External network blocked by PDF verifier: '+url.origin);}return originalFetch(input,init);};
app.on('web-contents-created',(_event,web)=>web.on('did-finish-load',()=>{const url=web.getURL();if(url.includes('/html/'))opened.push({url,at:Date.now()});}));
app.on('ready',()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,callback)=>{const url=new URL(details.url),local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);if(!local)networkAttempts.push(details.url);callback({cancel:!local});}));
await import('./src/main/main.ts');
if(!isSmoke&&!process.argv.some(arg=>arg.startsWith('--agent-api-pipe=')))void app.whenReady().then(async()=>{
  let visible=0;const observed=setInterval(()=>{visible+=BrowserWindow.getAllWindows().filter(window=>window.isVisible()).length;},20);
  const wait=async(read,accept,label)=>{const end=Date.now()+30000;let last;while(Date.now()<end){last=await read();if(accept(last))return last;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Timed out '+label+': '+JSON.stringify(last));};
  const listHtml=async(directory)=>{let files=[];for(const entry of await readdir(directory,{withFileTypes:true})){const target=path.join(directory,entry.name);if(entry.isDirectory())files.push(...await listHtml(target));else if(entry.name.endsWith('.html'))files.push(target);}return files;};
  try {
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,callback)=>{const url=new URL(details.url),local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);if(!local)networkAttempts.push(details.url);callback({cancel:!local});});
    const window=await wait(()=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('renderer/index.html')),Boolean,'production renderer');
    const web=window.webContents;
    await wait(()=>web.executeJavaScript('typeof window.workshop?.generateLineReview').catch(()=>''),value=>value==='function','production preload');
    const invoke=async(method,args)=>web.executeJavaScript('(async()=>{try{return {ok:true,value:await window.workshop.'+method+'('+JSON.stringify(args)+')}}catch(error){return {ok:false,message:error.message}}})()');
    const mode=async(value)=>{await fetch(control+'/fixture/mode',{method:'POST',body:JSON.stringify({mode:value})});};
    assert.equal((await invoke('saveAgentProviderConfig',{outputDir:'',activeProviderId:config.id,provider:config})).ok,true);
    await web.executeJavaScript('window.pdfPreparationProgress=[];window.workshop.onLineReviewGenerationProgress(progress=>window.pdfPreparationProgress.push({...progress,at:Date.now()}));true');
    for(const current of ['valid','malformed','audit-reject']) {
      await mode(current);const outputDir=path.join(evidence,current);projects.push(outputDir);await mkdir(outputDir,{recursive:true});
      const response=await invoke('generateLineReview',{...settings,outputDir,requestId:'manual-'+current,advanced:settings});
      if(current==='valid') {
        assert.equal(response.ok,true,JSON.stringify(response));result.manualHtml=response.value.outputPath;
        const html=await readFile(result.manualHtml,'utf8');assert.match(html,/Mechanical source sentence/);assert.match(html,/continues in the next source line/);
        const phases=await web.executeJavaScript('window.pdfPreparationProgress.filter(p=>p.requestId==="manual-valid").map(p=>p.phase).filter(Boolean)');
        assert.ok(phases.includes('structuring')&&phases.includes('auditing')&&phases.at(-1)==='accepted',JSON.stringify(phases));result.phases=phases;
      } else {
        assert.equal(response.ok,false,current+' must fail before HTML');assert.match(response.message,current==='malformed'?/current successfully checked draft revision/:new RegExp('independent audit found an unsupported source/render defect'));
        assert.deepEqual(await listHtml(outputDir),[]);result[current]={noHtml:true,message:response.message};
      }
    }
    await mode('hold');const stoppedDir=path.join(evidence,'stopped');projects.push(stoppedDir);await mkdir(stoppedDir,{recursive:true});
    await web.executeJavaScript('window.pendingPdfPreparation=window.workshop.generateLineReview('+JSON.stringify({...settings,outputDir:stoppedDir,requestId:'manual-stop'})+').then(value=>({ok:true,value}),error=>({ok:false,message:error.message}));true');
    await wait(async()=>{const records=await(await fetch(control+'/fixture/records')).json();return records.some(record=>record.mode==='hold'&&record.phase==='proposal');},Boolean,'real Pi HTTP stream');
    const stopped=await invoke('cancelHtmlPreparation','manual-stop');assert.equal(stopped.ok,true,JSON.stringify(stopped));
    const pending=await web.executeJavaScript('window.pendingPdfPreparation');assert.equal(pending.ok,false);assert.match(pending.message,/stopp|abort|cancel/i);assert.deepEqual(await listHtml(stoppedDir),[]);result.stop={noHtml:true,message:pending.message};
    await mode('valid');const builtinDir=path.join(evidence,'builtin');projects.push(builtinDir);await mkdir(builtinDir,{recursive:true});
    const builtin=await invoke('startBuiltinTask',{task:'translation',requestId:'builtin-pdf',settings:{...settings,outputDir:builtinDir}});assert.equal(builtin.ok,true,JSON.stringify(builtin));
    await invoke('agentSession.abort',{outputDir:builtinDir,sessionId:builtin.value.sessionId});
    const progress=await web.executeJavaScript('window.pdfPreparationProgress.filter(p=>p.requestId==="builtin-pdf")');
    const accepted=progress.find(entry=>entry.phase==='accepted');assert.ok(accepted);await wait(()=>opened.find(entry=>decodeURIComponent(entry.url).replace(/\\\\/g,'/').includes(builtinDir.replace(/\\\\/g,'/'))),Boolean,'accepted builtin HTML view');
    assert.ok(opened.filter(entry=>entry.url.includes('/html/')).every(entry=>entry.at>=accepted.at),'Builtin HTML must open after source acceptance');result.builtin={outputPath:builtin.value.outputPath,acceptedBeforeHtml:true};
    const layouts=[];const collect=async(directory)=>{for(const entry of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())await collect(file);else if(entry.name.endsWith('.pdf-layout.json'))layouts.push(file);}};await collect(path.join(evidence,'valid'));
    assert.equal(layouts.length,1);const layoutPath=layouts[0],bytes=await readFile(layoutPath),layout=JSON.parse(bytes);delete layout.preparation;layout.protectionHash=pdfProtectionHash(layout);await writeFile(layoutPath,JSON.stringify(layout));
    try {const created=await invoke('agentSession.createSession',{outputDir:path.join(evidence,'valid')});assert.equal(created.ok,true);const before=(await(await fetch(control+'/fixture/records')).json()).length;
      const legacy=await invoke('agentSession.sendPrompt',{outputDir:path.join(evidence,'valid'),sessionId:created.value.id,providerId:config.id,modelId:config.model,sourcePath:layoutPath.slice(0,-'.pdf-layout.json'.length),prompt:'Continue the existing PDF task.'});assert.equal(legacy.ok,false);assert.match(legacy.message,/no valid acceptance/);assert.equal((await(await fetch(control+'/fixture/records')).json()).length,before);result.missingReceiptRejected=true;
    } finally {await writeFile(layoutPath,bytes);}
    assert.equal(networkAttempts.length,0,JSON.stringify(networkAttempts));assert.equal(visible,0);assert.equal(showEvents,0);result.hidden=true;result.pass=true;
  } catch(error){result.pass=false;result.error=error.stack||String(error);result.errorCause=error.cause?.stack||String(error.cause??'');process.exitCode=1;}
  finally {clearInterval(observed);for(const project of projects)try{await piNativeSessionService.disposeWorkspace(project);}catch(error){result.cleanupError=String(error);result.pass=false;process.exitCode=1;}
    await writeFile(path.join(evidence,'ipc-result.json'),JSON.stringify({...result,opened,networkAttempts},null,2));console.log(JSON.stringify(result));app.quit();}
});
`;
  const entry=path.join(mainDir,'pdf-verifier.mjs');
  await build({absWorkingDir:root,stdin:{contents:driver,resolveDir:root,sourcefile:'pdf-verifier.ts'},bundle:true,platform:'node',format:'esm',outfile:entry,external,banner});
  const userData=path.join(evidence,'user-data');
  await mkdir(path.join(userData,'agent'),{recursive:true});
  await writeFile(path.join(userData,'agent','provider-config.json'),JSON.stringify({activeProviderId:mock.config.id,providers:{[mock.config.id]:mock.config}}));
  const common=['--disable-gpu','--no-sandbox',`--user-data-dir=${userData}`,entry];
  const env={...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true',YN_ELECTRON_VERIFY_HEADLESS:'1',YN_ELECTRON_VERIFY_OFFSCREEN:'1'};
  const code=await new Promise((resolve,reject)=>{const child=spawn(electronPath,common,{cwd:root,windowsHide:true,env,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{output.push(bytes.toString());});child.once('error',reject);child.once('close',resolve);});
  const ipc=JSON.parse(await readFile(path.join(evidence,'ipc-result.json'),'utf8'));assert.equal(code,0,ipc.error);assert.equal(ipc.pass,true,ipc.error);report.ipc=ipc;
  mock.setMode('valid');
  await mkdir(path.join(userData,'agent'),{recursive:true});await writeFile(path.join(userData,'agent','provider-config.json'),JSON.stringify({activeProviderId:mock.config.id,providers:{[mock.config.id]:mock.config}}));
  const priorEnv={headless:process.env.YN_ELECTRON_VERIFY_HEADLESS,offscreen:process.env.YN_ELECTRON_VERIFY_OFFSCREEN};
  process.env.YN_ELECTRON_VERIFY_HEADLESS='1';process.env.YN_ELECTRON_VERIFY_OFFSCREEN='1';
  try {
    api=connectYnAgent(electronPath,{args:common,cwd:root,onDiagnostic:text=>output.push(text)});await api.ready;
    const outputDir=path.join(evidence,'api'),before=mock.records.length;
    const planned=await api.call('plan',{task:'translation',settings:{...settings,outputDir}});
    await assert.rejects(api.call('start',{planId:planned.planId}),error=>error.code==='confirmation_required');
    assert.equal(mock.records.length,before,'API confirmation precedes source model requests');
    const started=await api.call('start',{planId:planned.planId,confirmed:true});assert.ok(started.outputPath);
    const completedAudit=mock.records.filter(record=>record.phase==='audit'&&record.event==='completed').at(-1);assert.ok(completedAudit);
    await api.call('stop',{outputDir,sessionId:started.sessionId});await api.close();api=undefined;
    const apiWindows=JSON.parse(await readFile(path.join(evidence,'api-window-events.json'),'utf8'));
    assert.equal(apiWindows.showEvents,0);assert.deepEqual(apiWindows.networkAttempts,[]);
    const apiHtml=apiWindows.opened.filter(entry=>decodeURIComponent(entry.url).replaceAll('\\','/').includes(outputDir.replaceAll('\\','/')));
    assert.ok(apiHtml.length,'The confirmed API opened its real HTML view');
    assert.ok(apiHtml.every(entry=>entry.at>=completedAudit.at),'API HTML must open after the independent native audit completed');
    report.api={confirmedBeforeModel:true,outputPath:started.outputPath,nativeAuditCompleted:true,acceptedBeforeHtml:true,hidden:true};
  } finally {for(const [key,value] of Object.entries(priorEnv)){const name=key==='headless'?'YN_ELECTRON_VERIFY_HEADLESS':'YN_ELECTRON_VERIFY_OFFSCREEN';if(value===undefined)delete process.env[name];else process.env[name]=value;}}
  // Exercise the production marker startup with a fresh, marker-owned model
  // profile. This validates seeding order from source without claiming that an
  // old release executable contains the current implementation.
  mock.setMode('valid');
  const smokeDir=path.join(evidence,'source-smoke'),smokeMarker=path.join(smokeDir,'ready.json'),smokeAgent=path.join(smokeDir,'user-data','agent');
  await mkdir(smokeAgent,{recursive:true});await writeFile(path.join(smokeAgent,'provider-config.json'),JSON.stringify({activeProviderId:mock.config.id,providers:{[mock.config.id]:mock.config}}));
  const beforeSmoke=mock.records.length;
  const smokeCode=await new Promise((resolve,reject)=>{const child=spawn(electronPath,[...common,`--yn-portable-smoke=${smokeMarker}`],{cwd:root,windowsHide:true,env,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>output.push(bytes.toString()));child.once('error',reject);child.once('close',resolve);});
  const smoke=JSON.parse(await readFile(smokeMarker,'utf8')),smokeWindows=JSON.parse(await readFile(path.join(evidence,'smoke-window-events.json'),'utf8'));
  assert.equal(smokeCode,0);assert.equal(smoke.pdfWorkerVerified,true);assert.equal(smoke.windowVisible,false);assert.equal(smokeWindows.showEvents,0);assert.deepEqual(smokeWindows.networkAttempts,[]);
  const smokeRecords=mock.records.slice(beforeSmoke);
  for(const name of ['readPdfStructureSource','readPdfStructureDraft','revisePdfStructureDraft','checkPdfStructureDraft','readPdfStructureAuditScope','submitPdfStructureAudit'])assert.ok(smokeRecords.some(record=>record.name===name),`Source marker smoke did not execute ${name}.`);
  assert.ok(smokeRecords.some(record=>record.phase==='audit'&&record.event==='completed'));
  report.sourceMarkerSmoke={nativePdfStructureVerified:true,pdfWorkerVerified:true,hidden:true,externalRequests:0,cleanExit:true};
  assert.ok(mock.records.some(record=>record.name==='readPdfStructureSource'));
  assert.ok(mock.records.some(record=>record.name==='checkPdfStructureDraft'));
  assert.ok(mock.records.some(record=>record.name==='revisePdfStructureDraft'));
  assert.ok(mock.records.some(record=>record.name==='readPdfStructureAuditScope'));
  assert.ok(mock.records.some(record=>record.name==='submitPdfStructureAudit'));
  assert.ok(!mock.records.some(record=>record.event==='fixture-error'),JSON.stringify(mock.records.filter(record=>record.event==='fixture-error')));
  report.pass=true;
} catch(error){report.pass=false;report.error=error.stack||String(error);process.exitCode=1;}
finally {
  if(api)await api.close().catch(error=>{report.cleanupError=String(error);});
  await mock.close();
  await writeFile(path.join(evidence,'provider-events.json'),JSON.stringify(providerLog,null,2));
  await writeFile(path.join(evidence,'electron.log'),output.join(''));
  await writeFile(path.join(evidence,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({pass:report.pass,evidence,error:report.error}));
}
