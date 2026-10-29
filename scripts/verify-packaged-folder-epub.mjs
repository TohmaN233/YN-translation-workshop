import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createZipBuffer} from '../src/main/zipWriter.ts';
import {builtinTaskDefaults} from '../src/shared/builtinTasks.ts';
const layout=process.argv[2]??'same',entry=process.argv[3]??'html';
assert(['same','nested','separate'].includes(layout),'Layout must be same, nested, or separate.');
assert(['html','homepage'].includes(entry),'Entry must be html or homepage.');
const root=process.cwd(),dir=await mkdtemp(path.join(root,'.tmp','packaged-epub-start-'));
const sourcePath=path.join(dir,'books'),outputDir=layout==='same'?sourcePath:layout==='nested'?path.join(sourcePath,'project-output'):path.join(dir,'project');
await mkdir(outputDir,{recursive:true});await mkdir(sourcePath,{recursive:true});
for(const [id,text] of [['alpha.epub','Independent startup alpha paragraph.'],['beta.epub','Independent startup beta paragraph.']])await writeFile(path.join(sourcePath,id),createZipBuffer([
 {path:'mimetype',data:Buffer.from('application/epub+zip'),store:true},
 {path:'META-INF/container.xml',data:Buffer.from('<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>')},
 {path:'EPUB/package.opf',data:Buffer.from('<package><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>')},
 {path:'EPUB/body.xhtml',data:Buffer.from('<html><body><p>'+text+'</p></body></html>')}
]));
const records=[],results=[],childSources=[];let sequence=0,inspection,inspectionError,workerError;
const plain=value=>typeof value==='string'?value:(value??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
const server=createServer(async(request,response)=>{
 try{
  if(request.method==='GET'&&request.url.endsWith('/models')){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({object:'list',data:[{id:'epub-fixture',object:'model'}]}));return;}
  let body='';for await(const bytes of request)body+=bytes;body=JSON.parse(body);
  const tools=new Set((body.tools??[]).map(tool=>tool.function.name)),calls=new Map();
  for(const message of body.messages??[])for(const call of message.tool_calls??[])calls.set(call.id,{name:call.function.name,args:JSON.parse(call.function.arguments||'{}')});
  const reads=name=>(body.messages??[]).filter(message=>message.role==='tool'&&calls.get(message.tool_call_id)?.name===name).map(message=>{let value;try{value=JSON.parse(plain(message.content));}catch{value=plain(message.content);}return value;});
  const inspected=reads('inspectTranslationContext');
  if(inspected.length){const last=inspected.at(-1);if(typeof last==='object'&&last?.sourceSelection?.documentCount===2)inspection=last;else inspectionError=last;}
  const n=++sequence;records.push({n,tools:[...tools],lastToolResults:(body.messages??[]).filter(message=>message.role==='tool').slice(-2)});
  let action;
  if(tools.has('readAssignedSource')){
   const source=reads('readAssignedSource').at(-1);
   if(!source)action={name:'readAssignedSource',args:{}};
   else if(!/Independent startup (alpha|beta) paragraph\./.test(JSON.stringify(source))){workerError=source;}
   else if(!reads('repairAssignedTranslation').length){childSources.push(source);action={name:'repairAssignedTranslation',args:{entries:[{line:1,translation:'独立合成译文。'}]}};}
   else action={name:'validateAssignedTranslation',args:{}};
  }else if(tools.has('readAssignedTranslationReview')){
   action=reads('readAssignedTranslationReview').length?{name:'submitTranslationReview',args:{failures:[]}}:{name:'readAssignedTranslationReview',args:{}};
  }else if(tools.has('inspectTaskSettings')){
   if(!reads('inspectTaskSettings').length)action={name:'inspectTaskSettings',args:{}};
   else if(!reads('inspectTaskSources').length)action={name:'inspectTaskSources',args:{rules:[]}};
   else action={name:'startPreparedWorkflow',args:{customPreserveRules:[]}};
  }else if(tools.has('inspectTranslationContext')&&!inspected.length)action={name:'inspectTranslationContext',args:{}};
  else if(inspection&&tools.has('runTranslationSubagents')&&!reads('runTranslationSubagents').length)action={name:'runTranslationSubagents',args:{}};
  response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
  const chunk=(delta,finish_reason=null)=>response.write('data: '+JSON.stringify({id:'epub-'+n,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'epub-fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
  chunk({role:'assistant'});
  if(!action)return; // Hold only after capturing real Host inspection; UI Stop cancels it.
  records.at(-1).action=action;console.log('WIRE',n,action.name);
  chunk({tool_calls:[{index:0,id:'epub-tool-'+n,type:'function',function:{name:action.name,arguments:JSON.stringify(action.args)}}]});chunk({},'tool_calls');response.end('data: [DONE]\n\n');
 }catch(error){records.push({fixtureError:String(error)});response.writeHead(500);response.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const providerPort=server.address().port;
const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const child=spawn(path.join(root,'release/win-unpacked/translation-workshop.exe'),['--disable-gpu','--no-sandbox','--remote-debugging-port='+port,'--user-data-dir='+path.join(dir,'profile')],{cwd:root,windowsHide:true,env:{...process.env,YN_ELECTRON_VERIFY_HEADLESS:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',exited=false;child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
const completed=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});}));
async function wait(read,accept,label,ms=20000){const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Timed out: '+label);}
const connections=[];let browser;
async function connect(target){
 const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 let id=0;const pending=new Map();ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(!message.id)return;const item=pending.get(message.id);if(!item)return;pending.delete(message.id);message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result?.value;};
 const api={ws,call,evaluate};connections.push(api);return api;
}
const targets=async()=>{try{return await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();}catch{return[];}};
let main,popup,sessionId,failure;
try{
 const target=await wait(async()=> (await targets()).find(target=>target.type==='page'&&target.url.includes('renderer/index.html')&&!target.url.includes('#agent')),Boolean,'packaged main target');main=await connect(target);
 browser=await connect(await(await fetch('http://127.0.0.1:'+port+'/json/version')).json());
 await wait(()=>main.evaluate('Boolean(window.workshop?.startBuiltinTask)'),Boolean,'actual packaged bridge');
 const config={id:'epub-local',presetId:'custom-api',type:'openai_compatible',name:'Local EPUB startup verification',model:'epub-fixture',models:['epub-fixture'],enabled:true,baseUrl:'http://127.0.0.1:'+providerPort+'/v1',auth:{kind:'api_key',key:'local-test-only'}};
 await main.evaluate('window.workshop.saveAgentProviderConfig('+JSON.stringify({outputDir:'',provider:config})+')');
 const settings=builtinTaskDefaults({outputDir,sourcePath,sourceKind:'folder',fileType:'epub',inputMode:'separate',locale:'en-US',languagePair:'en->zh-CN',glossaryCandidates:false,characterBible:false,subagentCount:2});
 if(entry==='html'){
  await main.evaluate('window.workshop.saveProject('+JSON.stringify(outputDir)+','+JSON.stringify(settings)+')');
  const generated=await main.evaluate('window.workshop.generateLineReview('+JSON.stringify({...settings,translationPath:''})+')');
  await main.evaluate('window.workshop.openReviewHtml('+JSON.stringify({htmlPath:generated.outputPath,outputDir})+')');
  const indexTarget=await wait(async()=>(await targets()).find(target=>target.url.includes(path.basename(generated.outputPath))),Boolean,'manual folder index');popup=await connect(indexTarget);
  await wait(()=>popup.evaluate('(async()=>{const w=document.querySelector("#fileFrame")?.contentWindow;if(!w?.translationWorkshopLineReviewReady)return false;await w.translationWorkshopLineReviewReady;return Boolean(w.translationWorkshopTaskParameters);})()'),Boolean,'manual selected child');
  await popup.evaluate('(()=>{const w=document.querySelector("#fileFrame").contentWindow;w.document.getElementById("translatePrompt").click();w.document.getElementById("applyPromptSettings").click();})()');
  await wait(()=>popup.evaluate('Boolean(document.querySelector("#fileFrame").contentWindow.document.querySelector("[data-agent-model-button]"))'),Boolean,'manual model ready');
  await wait(()=>popup.evaluate('(()=>{const button=document.querySelector("#fileFrame").contentWindow.document.querySelector("button[aria-label=Send]");return Boolean(button&&!button.disabled);})()'),Boolean,'manual send ready');
  await popup.evaluate('document.querySelector("#fileFrame").contentWindow.document.querySelector("button[aria-label=Send]").click()');
  const bootstrap=await wait(()=>main.evaluate('window.workshop.agentSession.loadBootstrap('+JSON.stringify({outputDir})+')'),value=>Boolean(value.activeSessionId),'manual native session');sessionId=bootstrap.activeSessionId;results.push({generated,sessionId});
 }else{
  const started=await main.evaluate('window.workshop.startBuiltinTask('+JSON.stringify({task:'translation',settings})+')');sessionId=started.sessionId;results.push({started});
 }
 await wait(()=>inspection||inspectionError,Boolean,'Host source inspection',30000);
 assert(!inspectionError,'Actual packaged startup cannot enumerate its extracted TXT: '+JSON.stringify(inspectionError));
 assert.equal(inspection.sourceSelection.documentCount,2);assert(inspection.sourcePath.endsWith('.txt'));assert.deepEqual(inspection.sourceSelection.documents.map(document=>document.id).sort(),['alpha.epub','beta.epub']);
 results.push({sourcePath:inspection.sourcePath,documents:inspection.sourceSelection.documents});
 const cards=await wait(async()=>{
  if(workerError)throw Error('Native child source read failed: '+JSON.stringify(workerError));
  const messages=await main.evaluate('window.workshop.agentSession.loadMessages('+JSON.stringify({outputDir,sessionId})+')');
  return messages.filter(message=>message.role==='custom'&&/^subagent\.(translation|translation-review)$/.test(message.customType)&&message.details?.status==='completed');
 },cards=>new Set(cards.map(card=>card.details.subagentId)).size===4,'two native translations and reviews',30000);
 results.push({completedCards:cards.map(card=>({kind:card.customType,documentId:card.details.documentId,status:card.details.status}))});
 assert(childSources.some(source=>JSON.stringify(source).includes('alpha')));assert(childSources.some(source=>JSON.stringify(source).includes('beta')));
 console.log('PASS actual packaged translation startup read both extracted EPUB TXT files and completed both native translation/review assignments.');
}catch(error){failure=String(error);console.error(error.stack??error);if(popup)try{console.error('POPUP',await popup.evaluate('(document.querySelector("#fileFrame")?.contentWindow.document||document).body.innerText.slice(-7000)'));}catch{}}
finally{
 if(main&&sessionId)try{await main.evaluate('window.workshop.agentSession.abort('+JSON.stringify({outputDir,sessionId})+')');}catch(error){failure??=String(error);}
 if(browser)void browser.call('Browser.close').catch(()=>{});
 let settleTimer;
 const outcome=await Promise.race([completed,new Promise(resolve=>{settleTimer=setTimeout(()=>resolve({timeout:true,pid:child.pid}),10000);settleTimer.unref();})]);clearTimeout(settleTimer);
 for(const connection of connections)connection.ws.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 const receipt={pass:!failure&&outcome.code===0,layout,entry,dir,pid:child.pid,exited,outcome,failure,inspection,inspectionError,workerError,childSources,results,records,stdout,stderr};await writeFile(`.tmp/packaged-epub-start-${layout}-${entry}.json`,JSON.stringify(receipt,null,2));
 if(outcome.timeout)console.error('Verifier process retained:',child.pid);
 if(failure||outcome.code!==0)process.exitCode=1;
}
