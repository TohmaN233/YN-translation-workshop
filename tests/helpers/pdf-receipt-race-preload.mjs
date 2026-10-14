import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {isMainThread} from 'node:worker_threads';
import path from 'node:path';
// Only the explicit test subprocess's worker mutates this owned fixture.
const target=process.env.YN_TEST_PDF_RECEIPT_RACE_SOURCE;
if(target&&!isMainThread){
 const receipt=target+'.pdf-structure.json',original=fsp.stat;let calls=0;
 fsp.stat=async function(file,...args){
  if(path.resolve(String(file)).toLowerCase()===path.resolve(receipt).toLowerCase()&&++calls===3){
   const data=JSON.parse(await fsp.readFile(receipt,'utf8'));data.audit.checks.paragraphs=false;
   await fsp.writeFile(receipt,JSON.stringify(data));
   await fsp.writeFile(receipt+'.race-marker',JSON.stringify({calls,mutation:'third-worker-stat'}));
  }
  return original.call(this,file,...args);
 };
 syncBuiltinESMExports();
}
