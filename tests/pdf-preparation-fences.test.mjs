import assert from 'node:assert/strict';
import fsp,{mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {createModels,fauxProvider,fauxAssistantMessage,fauxText,fauxToolCall} from '@earendil-works/pi-ai';
import {PiNativeSessionService} from '../src/main/agent/piNative/sessionService.ts';
import {preparePdfDocument,readPdfLayout} from '../src/main/pdfDocuments.ts';
import {configurePdfStructurePreparation,withPdfPreparationContext} from '../src/main/pdfStructurePreparation.ts';
import {generateBuiltinTaskReview} from '../src/main/builtinTaskDocuments.ts';
import {builtinTaskDefaults} from '../src/shared/builtinTasks.ts';
import {writeReviewHtml} from '../src/main/reviewHtmlPortability.ts';
import {transform} from 'esbuild';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
async function bounded(promise,label,ms=15000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}}
const checks=()=>({readingOrder:true,paragraphs:true,tables:true,figures:true,protectedContent:true});
const tool=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
const result=(context,name)=>JSON.parse(context.messages.filter(message=>message.role==='toolResult'&&message.toolName===name).at(-1).content[0].text);
async function files(root){const found=[];for(const item of await readdir(root,{withFileTypes:true})){const file=path.join(root,item.name);if(item.isDirectory())found.push(...await files(file));else found.push(file);}return found;}

if(process.env.YN_TEST_PDF_RECEIPT_RACE_SOURCE){
 const source=process.env.YN_TEST_PDF_RECEIPT_RACE_SOURCE,root=process.env.YN_TEST_PDF_RECEIPT_RACE_ROOT;
 await assert.rejects(readPdfLayout(source,root),/cache epoch|evidence changed|binding changed/,'third-stat mutation cannot seal a newly invalid evidence epoch');
 assert.equal(JSON.parse(await readFile(source+'.pdf-structure.json.race-marker','utf8')).calls,3);
 await assert.rejects(readPdfLayout(source,root),/audit failed/,'invalid audit cannot stay warm-accepted on next access');
 console.log('ok receipt mutation at the third worker stat is rejected before sealing and on next read');
}else{
 async function fixture(name,{proposalDelay,separateParagraph=false}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'yn-pdf-fence-'+name+'-')),original=path.join(root,'source.pdf');
  const pdf=await PDFDocument.create(),page=pdf.addPage([600,800]),font=await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('A complete source paragraph begins here and',{x:40,y:700,size:12,font});
  page.drawText('continues with its actual second visual line.',{x:40,y:683,size:12,font});
  if(separateParagraph)page.drawText('Another complete source paragraph.',{x:40,y:630,size:12,font});
  const bytes=await pdf.save();await writeFile(original,bytes);
  const provider=fauxProvider({provider:'pdf-fence-'+name,tokensPerSecond:100000,models:[{id:'fixture',reasoning:false,contextWindow:64000,maxTokens:4096}]}),models=createModels();models.setProvider(provider.provider);
  const service=new PiNativeSessionService({createTools:()=>{throw Error('Structure fence may not use ordinary Host tools');},createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id})});
  let nativeStages=0;
  configurePdfStructurePreparation(async request=>{
   nativeStages++;const audit=request.tools.some(item=>item.name==='readPdfPreparedStructure');
   provider.setResponses([
    tool('readPdfStructureSource',{fromLine:1,toLine:separateParagraph?3:2}),
    async context=>{const rows=result(context,'readPdfStructureSource').rows;assert.equal(rows.length,separateParagraph?3:2);
     if(audit)return tool('readPdfPreparedStructure',{fromLine:1,toLine:separateParagraph?2:1});
     if(proposalDelay){proposalDelay.entered.resolve();await proposalDelay.release.promise;}
     return fauxAssistantMessage(fauxText(JSON.stringify({version:1,paragraphs:[{physicalLines:rows.slice(0,2).map(row=>row.physicalLine),kind:'paragraph',reason:'Actual aligned visual lines inspected.'},...(separateParagraph?[{physicalLines:[rows[2].physicalLine],kind:'paragraph',reason:'Separate source paragraph inspected.'}]:[])],tables:[],audit:{...checks(),issues:[]}})));
    },
    ...(audit?[async context=>{const rows=result(context,'readPdfPreparedStructure').rows;assert.equal(rows.length,separateParagraph?2:1);assert.deepEqual(rows[0].physicalLines,[1,2]);return tool('submitPdfStructureAudit',{version:1,checks:checks(),issues:[]});},fauxAssistantMessage(fauxText('Audit submitted.'))]:[])
   ]);
   return service.runPdfStructurePreparation(request);
  });
  const workspace=path.join(root,'.translation-workshop'),settings=builtinTaskDefaults({outputDir:root,sourcePath:original,sourceKind:'file',fileType:'pdf',inputMode:'separate',locale:'en-US',glossaryCandidates:false,characterBible:false});
  return {root,original,workspace,service,provider,html:path.join(workspace,'html','builtin-fence.html'),
   get nativeStages(){return nativeStages;},prepare:signal=>preparePdfDocument(original,workspace,{signal}),
   generate:signal=>withPdfPreparationContext({signal},()=>generateBuiltinTaskReview(settings,'translation','fence',signal)),
   async close(){await service.disposeWorkspace(root);assert.equal(digest(await readFile(original)),digest(bytes));await rm(root,{recursive:true,force:true});}};
 }
 for(const kind of ['manifest','html']){
  const f=await fixture('temporary-stop-'+kind),controller=new AbortController(),originalWrite=fsp.writeFile;let intercepted;
  fsp.writeFile=async function(file,...args){
   const written=await originalWrite.call(this,file,...args),name=String(file);
   if(!intercepted&&(kind==='manifest'?/\.pdf-layout\.json\..*\.tmp$/u:/builtin-fence\.html\..*\.tmp$/u).test(name)){
    intercepted=name;controller.abort(new DOMException('Stop at '+kind+' temporary write','AbortError'));
   }
   return written;
  };syncBuiltinESMExports();
  try{
   await assert.rejects(f.generate(controller.signal),/Stop at|abort|cancel/i);assert.ok(intercepted,'test reaches actual '+kind+' temporary write');
   assert.equal(existsSync(f.html),false);const remaining=await files(f.root);assert.ok(!remaining.some(file=>file.endsWith('.tmp')),'cooperative Stop removes temporary files');
   assert.equal(remaining.some(file=>file.endsWith('.pdf-layout.json')),kind==='html','only completed acceptance before HTML may remain retained');
   assert.equal(f.nativeStages,2,'both real native requests settled before commit fence');
   console.log('ok Stop during '+kind+' temporary write prevents publication and removes temporary files');
  }finally{fsp.writeFile=originalWrite;syncBuiltinESMExports();await f.close();}
 }
 {
  const delay={entered:deferred(),release:deferred()},f=await fixture('queue-barrier',{proposalDelay:delay});
  try{
   const first=f.prepare();await bounded(delay.entered.promise,'first real native proposal not entered');
   const controller=new AbortController();let cancelled=false,thirdDone=false;
   const second=f.prepare(controller.signal).catch(error=>{cancelled=true;assert.match(error.message,/queued request/);});controller.abort(Error('Stop queued request only'));
   await bounded(second,'cancelled queued preparation did not settle independently',1500);assert.equal(cancelled,true);
   const third=f.prepare().then(value=>{thirdDone=true;return value;});await new Promise(resolve=>setImmediate(resolve));assert.equal(thirdDone,false);assert.equal(f.nativeStages,1);
   delay.release.resolve();const [a,c]=await bounded(Promise.all([first,third]),'first and successor did not complete');assert.equal(a.sourcePath,c.sourcePath);assert.equal(f.nativeStages,2,'successor barrier reuses accepted projection instead of starting an overlapping proposal');
   console.log('ok queued same-PDF Stop settles immediately while successor retains the first request barrier');
  }finally{delay.release.resolve();await f.close();}
 }
 {
  const f=await fixture('html-and-epoch',{separateParagraph:true});
  try{
   const document=await f.prepare(),layout=await readPdfLayout(document.sourcePath,f.root);
   const paths={sourcePath:f.original,validationSourcePath:document.sourcePath,outputDir:f.root};
   for(const kind of ['empty','duplicate']){
    const output=path.join(f.workspace,kind+'.html'),rows=kind==='empty'?[]:layout.blocks.map(()=>({line:1,source:layout.blocks[0].text}));
    if(kind==='duplicate')assert.equal(rows.length,layout.blocks.length,'same-count duplicate numbers must reject beyond count checks');
    const html='<!doctype html><script id="reviewData" type="application/json">'+JSON.stringify({rows,workflow:{paths}})+'</script>';
    await assert.rejects(writeReviewHtml(output,html),/row coverage/);assert.equal(existsSync(output),false);
    console.log('ok '+kind+' HTML row coverage cannot publish accepted-source omissions or duplicates');
   }
   const receipt=document.sourcePath+'.pdf-structure.json',before=await readFile(receipt);
   try{
    const script=fileURLToPath(import.meta.url),preload=new URL('./helpers/pdf-receipt-race-preload.mjs',import.meta.url).href;
    const child=spawn(process.execPath,['--import',preload,script],{cwd:process.cwd(),env:{...process.env,YN_TEST_PDF_RECEIPT_RACE_SOURCE:document.sourcePath,YN_TEST_PDF_RECEIPT_RACE_ROOT:f.root},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
    const code=await bounded(new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}), 'receipt race worker subprocess did not settle');assert.equal(code,0,output);process.stdout.write(output);
   }finally{await writeFile(receipt,before);}
  }finally{await f.close();}
 }
 {
  const f=await fixture('wrapped-native-failure');
  try{
   const aggregate=new AggregateError([new DOMException('Stopped native request','AbortError'),Error('Native storage close failed')],'Native cancellation cleanup failed');
   configurePdfStructurePreparation(async()=>{throw aggregate;});let failure;
   await assert.rejects(f.prepare(),error=>{failure=error;return error.name==='NonRetryableAssignmentError'&&error.cause===aggregate;});
   const main=await readFile(new URL('../src/main/main.ts',import.meta.url),'utf8'),start=main.indexOf('function isExpectedHtmlPreparationCancellation('),end=main.indexOf('const htmlPreparationOperations=',start);
   assert.ok(start>=0&&end>start);const compiled=(await transform(main.slice(start,end),{loader:'ts',format:'cjs'})).code;
   const classify=new Function(compiled+';return isExpectedHtmlPreparationCancellation;')(),controller=new AbortController();controller.abort(new DOMException('User Stop','AbortError'));
   assert.equal(classify(failure,controller.signal),false,'wrapped aggregate cleanup failure must remain visible to the actual main cancellation classifier');
   assert.ok(!(await files(f.root)).some(file=>file.endsWith('.html')||file.endsWith('.pdf-layout.json')));
   console.log('ok wrapped native aggregate cleanup failure preserves cause and remains visible during main Stop classification');
  }finally{await f.close();}
 }
}
