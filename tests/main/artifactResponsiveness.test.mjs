import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,mkdir,writeFile,rm,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const fixture=await mkdtemp(path.join(process.cwd(),'.tmp-artifact-responsive-'));
const handlers=new Map();globalThis.__artifactIpc={handle:(name,fn)=>handlers.set(name,fn)};
try{
 await build({entryPoints:['src/main/ipc/agentArtifactHandlers.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(fixture,'handlers.mjs'),
  external:['pdfjs-dist','pdf-lib','@pdf-lib/fontkit','@napi-rs/canvas'],
  plugins:[{name:'ipc',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'ipc'}));b.onLoad({filter:/.*/,namespace:'ipc'},()=>({contents:'export const ipcMain=globalThis.__artifactIpc;',loader:'js'}));}}]});
 await build({entryPoints:['src/main/agent/piNative/translationValidationWorker.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(fixture,'translationValidationWorker.js'),external:['pdfjs-dist','pdfjs-dist/*','pdf-lib','@pdf-lib/fontkit','@napi-rs/canvas']});
 const project=path.join(fixture,'project'),source=path.join(fixture,'source.txt'),candidate=path.join(project,'AI_translation','source_translated.txt');
 await mkdir(path.dirname(candidate),{recursive:true});await mkdir(path.join(project,'.translation-workshop'),{recursive:true});
 const glossary=Array.from({length:2600},(_,i)=>({source:'term'+i,target:'术语'+i}));
 await writeFile(path.join(project,'.translation-workshop','project.json'),JSON.stringify({glossaryPath:path.join(project,'terms.json')}));
 await writeFile(path.join(project,'terms.json'),JSON.stringify(glossary));
 await writeFile(source,Array.from({length:20000},(_,i)=>`A sufficiently long sentence about term${i%2600}.`).join('\n'));
 await writeFile(candidate,Array.from({length:20000},(_,i)=>`关于术语${i%2600}的一句话。`).join('\n'));
 const {registerAgentArtifactIpc}=await import(pathToFileURL(path.join(fixture,'handlers.mjs')).href);registerAgentArtifactIpc();
 const args={projectDir:project,sourcePath:source,candidatePath:candidate,languagePair:'en->zh-CN',glossaryPath:path.join(project,'terms.json')};
 let maxGap=0,last=performance.now();const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now},10);
 const validation=await handlers.get('agent-artifacts:validate')({},args);
 await new Promise(r=>setTimeout(r,20));clearInterval(timer);
 assert.equal(validation.ok,true);assert.ok(maxGap<250,`Artifact validation blocked the main event loop for ${maxGap.toFixed(0)}ms`);
 console.log(`Artifact main heartbeat max ${maxGap.toFixed(1)}ms`);
}finally{delete globalThis.__artifactIpc;await rm(fixture,{recursive:true,force:true});}
