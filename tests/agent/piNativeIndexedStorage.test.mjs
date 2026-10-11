import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, appendFile, stat, rm, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants as bufferConstants } from "node:buffer";
import { BACKGROUND_CONTEXT as ctx, withAbortSignal, MemorySessionRepo, StorageBackedSession, value, list, setValue, insertEntry, createForkSnapshot } from "@earendil-works/pi-agent-core/node";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { IndexedJsonlStorage, JsonlAppendFailedError, JsonlSourceChangedError } from "../../src/main/agent/piNative/indexedJsonlStorage.ts";
import { readJsonlRecords, TornJsonlTailError } from "../../src/main/agent/piNative/jsonlRecords.ts";

const root = await mkdtemp(path.join(os.tmpdir(),"yn-indexed-storage-"));
let counter = 0;
const header = id => ({kind:"header",v:4,storageVersion:1,id,cwd:root,createdAt:1});
async function fixture() {
  const file = path.join(root,`${counter++}.jsonl`);
  await writeFile(file,`${JSON.stringify(header(path.basename(file)))}\n`);
  const storage = await IndexedJsonlStorage.open(file,ctx,{onProgress:()=>{}});
  return {storage,file,async [Symbol.asyncDispose]() {await storage.close(ctx);}};
}
const message = text => ({role:"user",content:[{type:"text",text}],timestamp:1});
try {
  for (const test of createStorageConformance(fixture)) { await test.run(); }
  console.log("Pi native Storage conformance passed.");

  const f = await fixture();
  const meta = {id:f.storage.header.id,createdAt:1,storageVersion:1};
  const indexedSession = new StorageBackedSession(meta,f.storage);
  const memory = await new MemorySessionRepo().create({id:meta.id},ctx);
  for (const session of [indexedSession,memory]) {
    const branch = await session.createBranch("main",null,ctx);
    await branch.appendMessage(message("日文🙂"),ctx);
    await branch.appendCustomEntry("host",{payload:"正文"},ctx);
    await session.setValue(value("custom","設定"),{text:"state"},ctx);
    await session.appendList(list("custom","list"),{n:1},ctx);
    await session.appendList(list("custom","list"),{n:2},ctx);
  }
  // Entry ids are generated independently; compare native shape and query results excluding ids/timestamps.
  const project = entries => entries.map(e=>({type:e.type,customType:e.customType,message:e.message,data:e.data,seq:e.seq}));
  assert.deepEqual(project(await indexedSession.findEntries(undefined,ctx)),project(await memory.findEntries(undefined,ctx)));
  assert.deepEqual(await indexedSession.readList(list("custom","list"),{order:"desc",limit:1},ctx),await memory.readList(list("custom","list"),{order:"desc",limit:1},ctx));
  assert.deepEqual(await indexedSession.getValue(value("custom","設定"),ctx),await memory.getValue(value("custom","設定"),ctx));
  const fork = createForkSnapshot({entries:await f.storage.scanEntries({},ctx),scalarValues:await f.storage.scanValues(value("pi.branch.tip"),ctx)},{scope:"tree"});
  assert(fork); // Native fork policy can query the lazy backend without a materialized history store.
  await indexedSession.close(ctx); await memory.close(ctx);
  const progress=[];
  let reopened = await IndexedJsonlStorage.open(f.file,ctx,{onProgress:p=>progress.push(p)});
  assert(progress.some(p=>p.phase === "rebuild")); // Commits make the original sidecar stale.
  await reopened.close(ctx); progress.length=0;
  reopened = await IndexedJsonlStorage.open(f.file,ctx,{onProgress:p=>progress.push(p)});
  assert(progress.some(p=>p.phase === "cache-hit"));
  assert.equal(progress.at(-1)?.phase,"complete","cache hits must finish the UI preparation lifecycle");
  const entries = await reopened.scanEntries({},ctx);
  entries[0].message.content[0].text="caller mutation";
  assert.equal((await reopened.getEntries([entries[0].id],ctx)).get(entries[0].id).message.content[0].text,"日文🙂");
  await appendFile(f.file,'{"kind":"value","op":"set","namespace":"external","key":"","value":3,"seq":1000}\n');
  await assert.rejects(reopened.getStats(ctx),JsonlSourceChangedError);
  await reopened.close(ctx);
  reopened=await IndexedJsonlStorage.open(f.file,ctx,{onProgress:()=>{}});
  assert.equal((await reopened.getValue(value("external"),ctx)).value,3);
  await reopened.close(ctx);
  const sidecar = `${f.file}.yn-index.json`;
  const invalidIndex=JSON.parse(await readFile(sidecar,"utf8")); invalidIndex.index.entries[0].offset=1;
  await writeFile(sidecar,JSON.stringify(invalidIndex));
  progress.length=0; reopened=await IndexedJsonlStorage.open(f.file,ctx,{onProgress:p=>progress.push(p)});
  assert(progress.some(p=>p.reason?.includes("checksum"))); await reopened.close(ctx);

  const tail = path.join(root,"tail.jsonl");
  const complete = `${JSON.stringify(header("tail"))}\n{"kind":"value","op":"set","namespace":"x","key":"","value":"🙂","seq":1}\n`;
  await writeFile(tail,`${complete}{"seq":`);
  let completeRecords=0;
  await assert.rejects(async()=>{for await(const r of readJsonlRecords(tail)){completeRecords++;}},error=>error instanceof TornJsonlTailError && error.committedBytes === Buffer.byteLength(complete) && error.tailBytes === 7);
  assert.equal(completeRecords,2);
  await assert.rejects(IndexedJsonlStorage.open(tail,ctx,{onProgress:()=>{}}),TornJsonlTailError);
  assert.equal(await readFile(tail,"utf8"),`${complete}{"seq":`);
  const malformed = path.join(root,"malformed.jsonl");
  await writeFile(malformed,`${JSON.stringify(header("bad"))}\n{"kind":"entry","id":"missing-parent","parentId":"absent","type":"custom","customType":"x","seq":1,"timestamp":1}\n`);
  await assert.rejects(IndexedJsonlStorage.open(malformed,ctx,{onProgress:()=>{}}),/Missing parent entry/);
  await writeFile(malformed,`${JSON.stringify(header("bad"))}\n{"not":"native"}\n`);
  await assert.rejects(IndexedJsonlStorage.open(malformed,ctx,{onProgress:()=>{}}),/write sequence/);

  const abort = new AbortController(); abort.abort(new Error("cancel index"));
  await assert.rejects(IndexedJsonlStorage.open(f.file,withAbortSignal(abort.signal,ctx)),/cancel index/);
  const during = new AbortController();
  await assert.rejects(IndexedJsonlStorage.open(f.file,withAbortSignal(during.signal,ctx),{onProgress:()=>during.abort(new Error("cancel running index"))}),/cancel running index/);

  // Stop may arrive while async stat is yielding, before a worker listener exists.
  const statRacePath = path.join(root,"stat-race.jsonl");
  await writeFile(statRacePath,`${JSON.stringify(header("stat-race"))}\n${JSON.stringify({kind:"value",op:"set",namespace:"test",key:"payload",value:"x".repeat(12*1024*1024),seq:1})}\n`);
  const statRace = new AbortController(), raceProgress=[];
  const raceOpen = IndexedJsonlStorage.open(statRacePath,withAbortSignal(statRace.signal,ctx),{onProgress:p=>raceProgress.push(p)});
  setImmediate(()=>statRace.abort(new Error("cancel during source stat")));
  await assert.rejects(raceOpen,/cancel during source stat/);
  assert.deepEqual(raceProgress,[],"a cancelled stat must not start an index worker");
  await assert.rejects(stat(`${statRacePath}.yn-index.json`),{code:"ENOENT"});

  const failed=await fixture();
  const originalWrite=failed.storage.handle.write.bind(failed.storage.handle);
  failed.storage.handle.write=async()=>{throw new Error("injected append failure");};
  await assert.rejects(failed.storage.commit([setValue(value("x"),1)],ctx),JsonlAppendFailedError);
  failed.storage.handle.write=originalWrite;
  await assert.rejects(failed.storage.commit([setValue(value("x"),2)],ctx),JsonlAppendFailedError);
  await failed.storage.close(ctx);
  const afterFailure=await IndexedJsonlStorage.open(failed.file,ctx,{onProgress:()=>{}});
  await afterFailure.commit([setValue(value("x"),3)],ctx); assert.equal((await afterFailure.getValue(value("x"),ctx)).value,3); await afterFailure.close(ctx);

  const tornAppend=await fixture();
  const realWrite=tornAppend.storage.handle.write.bind(tornAppend.storage.handle); let writes=0;
  tornAppend.storage.handle.write=async(buffer,offset,length,position)=>{if(writes++) throw new Error("injected partial append"); return realWrite(buffer,offset,Math.min(5,length),position);};
  await assert.rejects(tornAppend.storage.commit([setValue(value("x"),1)],ctx),JsonlAppendFailedError);
  await tornAppend.storage.close(ctx);
  await assert.rejects(IndexedJsonlStorage.open(tornAppend.file,ctx,{onProgress:()=>{}}),TornJsonlTailError);

  const synced=await fixture();
  synced.storage.handle.sync=async()=>{throw new Error("injected fsync failure");};
  await assert.rejects(synced.storage.commit([setValue(value("durable"),4)],ctx),JsonlAppendFailedError);
  await assert.rejects(synced.storage.commit([setValue(value("durable"),5)],ctx),JsonlAppendFailedError);
  await synced.storage.close(ctx);
  const recoveredSync=await IndexedJsonlStorage.open(synced.file,ctx,{onProgress:()=>{}});
  assert.equal((await recoveredSync.getValue(value("durable"),ctx)).value,4);
  await recoveredSync.commit([setValue(value("durable"),6)],ctx);
  assert.equal((await recoveredSync.getValue(value("durable"),ctx)).value,6); await recoveredSync.close(ctx);

  const overlap=await fixture();
  let reachedSync,releaseSync;
  const syncReached=new Promise(resolve=>{reachedSync=resolve;});
  const syncGate=new Promise(resolve=>{releaseSync=resolve;});
  const nativeSync=overlap.storage.handle.sync.bind(overlap.storage.handle);
  overlap.storage.handle.sync=async()=>{reachedSync();await syncGate;await nativeSync();};
  const overlappingCommit=overlap.storage.commit([insertEntry({id:"concurrent",parentId:null,type:"message",message:message("committed")})],ctx);
  await syncReached;
  let readFinished=false;
  const overlappingRead=overlap.storage.getStats(ctx).then(result=>{readFinished=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(readFinished,false,"read admission must wait for the owner's durable append and index advancement");
  releaseSync(); await overlappingCommit;
  assert.equal((await overlappingRead).messageCount,1);
  await overlap.storage.close(ctx);

  const unicodePath=path.join(root,"unicode.jsonl"), unicode="日🙂".repeat(100000);
  await writeFile(unicodePath,`${JSON.stringify(header("unicode"))}\r\n${JSON.stringify({kind:"entry",seq:1,id:"u",parentId:null,timestamp:1,type:"custom",customType:"unicode",data:unicode})}\r\n`);
  let unicodeOffset=0,unicodeLines=0;
  for await(const r of readJsonlRecords(unicodePath)){assert.equal(r.offset,unicodeOffset);unicodeOffset+=r.length;unicodeLines++;if(r.kind === "transaction")assert.equal(r.writes[0].data,unicode);}
  assert.equal(unicodeLines,2);assert.equal(unicodeOffset,(await stat(unicodePath)).size);

  // A real valid file above V8's maximum string length proves that neither parser nor index uses whole-file UTF-8 strings.
  const largePath=path.join(root,"large.jsonl");
  const handle=await open(largePath,"wx");
  await handle.write(`${JSON.stringify(header("large"))}\n`);
  const payload="x".repeat(1024*1024);
  let bytes=0,n=0;
  while(bytes <= bufferConstants.MAX_STRING_LENGTH) {
    n++; const line=JSON.stringify({kind:"entry",seq:n,id:`e${n}`,parentId:n===1?null:`e${n-1}`,timestamp:1,type:"custom",customType:"history",data:{payload}})+"\n";
    await handle.write(line); bytes+=Buffer.byteLength(line);
  }
  await handle.close();
  assert((await stat(largePath)).size > bufferConstants.MAX_STRING_LENGTH);
  const large=await IndexedJsonlStorage.open(largePath,ctx,{onProgress:()=>{}});
  assert.equal(large.index.entries.length,n);
  assert(large.index.entries.every(e=>!("data" in e) && !("message" in e)));
  const structure=await large.scanBranchStructure({start:`e${n}`,limit:3},ctx); assert.equal(structure.length,3);
  assert.equal(large.getCacheDiagnostics().transactions,0);
  for(let i=1;i<=20;i++) assert.equal((await large.getEntries([`e${i}`],ctx)).get(`e${i}`).data.payload.length,payload.length);
  assert(large.getCacheDiagnostics().estimatedBytes <= large.getCacheDiagnostics().maxBytes);
  assert(large.getCacheDiagnostics().transactions < 20);
  assert((await stat(`${largePath}.yn-index.json`)).size < 1024*1024);
  await large.close(ctx);
  console.log(`Lazy indexed storage parity, cache, mutation/failure/abort and ${bytes}-byte (>V8 string limit) streaming tests passed.`);
} finally { await rm(root,{recursive:true,force:true}); }
