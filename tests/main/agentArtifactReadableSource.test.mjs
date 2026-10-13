import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';import {pathToFileURL} from 'node:url';
const fixture=await mkdtemp(path.join(process.cwd(),'.tmp-artifact-readable-'));
const handlers=new Map();globalThis.__artifactIpc={handle:(name,fn)=>handlers.set(name,fn)};
try{
 const entry=path.join(fixture,'handlers.mjs');
 await build({entryPoints:['src/main/ipc/agentArtifactHandlers.ts'],bundle:true,platform:'node',format:'esm',outfile:entry,
  external:['pdfjs-dist','pdf-lib','@pdf-lib/fontkit','@napi-rs/canvas'],
  plugins:[{name:'ipc-boundary',setup(builder){builder.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'ipc'}));builder.onLoad({filter:/.*/,namespace:'ipc'},()=>({contents:'export const ipcMain=globalThis.__artifactIpc;',loader:'js'}));}}]});
 await build({entryPoints:['src/main/agent/piNative/translationValidationWorker.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(fixture,'translationValidationWorker.js'),external:['pdfjs-dist','pdfjs-dist/*','pdf-lib','@pdf-lib/fontkit','@napi-rs/canvas']});
 const {registerAgentArtifactIpc}=await import(pathToFileURL(entry).href);registerAgentArtifactIpc();
 const source=path.join(fixture,'data','chapter.txt'),project=path.join(fixture,'Translation'),candidate=path.join(project,'AI_translation','chapter_translated.txt');
 await mkdir(path.dirname(source),{recursive:true});await mkdir(path.dirname(candidate),{recursive:true});
 await writeFile(source,'Hello Bob.');await writeFile(candidate,'你好，鲍勃。');
 const args={projectDir:project,sourcePath:source,candidatePath:candidate,languagePair:'en->zh-CN',locale:'zh-CN'};
 const call=(name,value)=>handlers.get(name)({},value);
 const artifacts=await call('agent-artifacts:discover',{projectDir:project,sourcePaths:[source]});
 assert.equal(artifacts.length,1);assert.equal(artifacts[0].sourcePath,source,'an explicit source outside Translation remains bound');
 assert.equal((await call('agent-artifacts:validate',args)).ok,true);
 const plan=await call('agent-artifacts:importPlan',args);assert.equal(plan.ok,true);assert.equal(plan.edits[1],'你好，鲍勃。');
 assert.ok(await call('agent-artifacts:repairPrompt',args));
 await assert.rejects(call('agent-artifacts:validate',{...args,candidatePath:source}),/inside the project/);
 await assert.rejects(call('agent-artifacts:discover',{projectDir:project,sourcePaths:['']}),/Path is required/);
 assert.equal(await readFile(source,'utf8'),'Hello Bob.');assert.equal(await readFile(candidate,'utf8'),'你好，鲍勃。');
 console.log('Actual artifact IPC handlers discover, validate and import an external read-only source while retaining candidate boundaries');
}finally{delete globalThis.__artifactIpc;await rm(fixture,{recursive:true,force:true});}
