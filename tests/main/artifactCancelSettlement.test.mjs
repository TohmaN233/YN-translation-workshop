import assert from 'node:assert/strict';import {build} from 'esbuild';import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
const fixture=await mkdtemp(path.join(process.cwd(),'.tmp-artifact-cancel-'));
const handlers=new Map();globalThis.__artifactIpc={handle:(name,fn)=>handlers.set(name,fn)};
try{
 await build({entryPoints:['src/main/ipc/agentArtifactHandlers.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(fixture,'handler.mjs'),plugins:[{name:'settlement-seam',setup(b){
  b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'ipc'}));b.onLoad({filter:/.*/,namespace:'ipc'},()=>({contents:'export const ipcMain=globalThis.__artifactIpc;',loader:'js'}));
  b.onLoad({filter:/[\\/]artifactValidationService\.ts$/},()=>({contents:`import {ArtifactCancelledError} from ${JSON.stringify(path.resolve('src/main/agent/artifactCancellation.ts'))};
   export function runArtifactOperation(request,options){return new Promise((_,reject)=>{const fail=globalThis.__artifactCancelFailure;options.signal.addEventListener('abort',()=>setTimeout(()=>reject(fail?Object.assign(new Error('SQLite close failed after cancellation'),{code:'SQLITE_CLEANUP_FAILED'}):new ArtifactCancelledError()),request.args.requestId==='slow'?100:25),{once:true});});}`,loader:'ts'}));
 }}]});
 const {registerAgentArtifactIpc}=await import(pathToFileURL(path.join(fixture,'handler.mjs')).href);registerAgentArtifactIpc();
 const sender=id=>Object.assign(new EventEmitter(),{id,isDestroyed:()=>false,send:()=>{}});
 const owner=sender(1),other=sender(2);const args={projectDir:fixture,sourcePath:path.join(fixture,'source.txt'),candidatePath:path.join(fixture,'target.txt')};
 const call=(name,args,event={sender:owner})=>handlers.get(name)(event,args);
 globalThis.__artifactCancelFailure=true;
 const failed=call('agent-artifacts:validate',{...args,requestId:'failure'}).catch(e=>e);
 await assert.rejects(call('agent-artifacts:cancel',{requestId:'failure'}),/SQLite close failed/);
 assert.equal((await failed).code,'SQLITE_CLEANUP_FAILED');
 const quickFailure=call('agent-artifacts:validate',{...args,requestId:'quick'}).catch(e=>e);
 globalThis.__artifactCancelFailure=false;
 const slowCleanup=call('agent-artifacts:validate',{...args,requestId:'slow'}).catch(e=>e);
 const start=performance.now();await assert.rejects(call('agent-artifacts:cancel',{}),/SQLite close failed/);
 assert.ok(performance.now()-start>=80,'failure must still wait for slower worker cleanup');await quickFailure;await slowCleanup;
 globalThis.__artifactCancelFailure=false;
 const first=call('agent-artifacts:repairPrompt',args).catch(e=>e); // no renderer request ID
 const second=call('agent-artifacts:validate',{...args,requestId:'owner'}).catch(e=>e);
 const foreign=call('agent-artifacts:validate',{...args,requestId:'foreign'},{sender:other}).catch(e=>e);
 assert.equal((await call('agent-artifacts:cancel',{requestId:'foreign'})).ok,false);
 const began=performance.now();assert.equal((await call('agent-artifacts:cancel',{})).ok,true);assert.ok(performance.now()-began>=20);
 assert.equal((await first).code,'YN_ARTIFACT_CANCELLED');assert.equal((await second).code,'YN_ARTIFACT_CANCELLED');
 assert.equal((await call('agent-artifacts:cancel',{}, {sender:other})).ok,true);assert.equal((await foreign).code,'YN_ARTIFACT_CANCELLED');
 assert.equal(owner.listenerCount('destroyed'),0);assert.equal(other.listenerCount('destroyed'),0);
 console.log('Cancel waits for every owned worker, preserves cleanup errors and cannot stop other windows');
}finally{delete globalThis.__artifactIpc;delete globalThis.__artifactCancelFailure;await rm(fixture,{recursive:true,force:true});}
