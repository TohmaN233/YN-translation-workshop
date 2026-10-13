import assert from 'node:assert/strict';import {build} from 'esbuild';import {spawn} from 'node:child_process';
import {mkdtemp,readdir,copyFile,writeFile,readFile,mkdir,rm} from 'node:fs/promises';import path from 'node:path';
const fixture=await mkdtemp(path.resolve('.tmp-electron-artifacts-'));
await build({entryPoints:['scripts/verify-electron-artifacts-main.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(fixture,'main.mjs'),
 banner:{js:'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);'},
 external:['electron','electron-updater','electron-updater/*','extract-zip','cheerio','cheerio/*','pdfjs-dist','pdfjs-dist/*','pdf-lib','@pdf-lib/fontkit','@napi-rs/canvas','@earendil-works/pi-ai','@earendil-works/pi-ai/*','@earendil-works/pi-agent-core','@earendil-works/pi-agent-core/*']});
for(const file of await readdir('dist/main')) if(file.endsWith('Worker.js'))await copyFile(path.join('dist/main',file),path.join(fixture,file));
let log='';const code=await new Promise((resolve,reject)=>{
 const child=spawn(path.resolve('node_modules/electron/dist/electron.exe'),['--disable-gpu','--no-sandbox',path.join(fixture,'main.mjs')],{cwd:process.cwd(),windowsHide:true,
  env:{...process.env,YN_ARTIFACT_VERIFY_DIR:fixture,YN_ELECTRON_VERIFY_HEADLESS:'1',YN_ELECTRON_VERIFY_OFFSCREEN:'1',ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},stdio:['ignore','pipe','pipe']});
 const timer=setTimeout(async()=>{await writeFile(path.join(fixture,'timeout.json'),JSON.stringify({pid:child.pid,fixture,processPreserved:true}));reject(new Error(`Artifact verifier timed out; PID ${child.pid} retained in ${fixture}, no process was killed.`));},180000);
 child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});child.stderr.on('data',b=>{log+=b;process.stderr.write(b)});
 child.on('error',error=>{clearTimeout(timer);reject(error)});child.on('close',code=>{clearTimeout(timer);resolve(code)});
 child.on('exit',(code,signal)=>{void writeFile(path.join(fixture,'exit.json'),JSON.stringify({code,signal,at:new Date().toISOString()}));});
});await writeFile(path.join(fixture,'run.log'),log);
assert.equal(code,0,`Artifact verifier failed; evidence kept in ${fixture}`);
const result=JSON.parse(await readFile(path.join(fixture,'result.json'),'utf8'));
const evidence=path.resolve('artifacts/artifact-scan-latency-2026-10-11');await mkdir(evidence,{recursive:true});
await writeFile(path.join(evidence,result.full?'electron-artifacts-full.json':'electron-artifacts-small.json'),JSON.stringify(result,null,2));
const target=path.resolve(fixture);assert.ok(target.startsWith(path.resolve('.tmp-electron-artifacts-')));
await rm(target,{recursive:true,force:true,maxRetries:20,retryDelay:100});
