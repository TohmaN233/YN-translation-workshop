import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const preload=new URL('./helpers/pdf-cancel-cleanup-preload.mjs',import.meta.url).href;
const fixture=fileURLToPath(new URL('./helpers/pdf-cancel-cleanup-fixture.mjs',import.meta.url));
for(const mode of ['cancel','progress']) {
  const child=spawn(process.execPath,['--experimental-strip-types','--import',preload,fixture,mode],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,log);assert.match(log,/"cleanupFailureVisible":true/);process.stdout.write(log);
}
