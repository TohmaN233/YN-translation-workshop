import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { connectYnAgent } from "../agent-tools/yn-agent-client.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "yn-agent-client-"));
const executable = path.join(root, "fixture.mjs");
await writeFile(executable, `
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.argv.includes('exit-early')) process.exit(2);
const endpoint = process.argv.find(arg => arg.startsWith('--agent-api-pipe=')).slice('--agent-api-pipe='.length);
const socket = createConnection({path: endpoint, allowHalfOpen: true});
const huge = process.argv.includes('huge');
let eof = false, flushed = false;
const marker = process.argv.find(arg => arg.startsWith('marker='))?.slice(7);
const timer = huge ? setTimeout(() => { writeFileSync(marker, JSON.stringify({eof,flushed})); process.exit(2); }, 5000) : undefined;
socket.on('close', () => { if (timer) { clearTimeout(timer); writeFileSync(marker, JSON.stringify({eof,flushed})); } });
const write = packet => socket.write(JSON.stringify(packet) + '\\n');
socket.on('connect', () => {
  if (process.argv.includes('fatal')) { socket.end(JSON.stringify({type:'fatal', error:{code:'instance_in_use',message:'Already running'}})+'\\n'); process.exitCode=1; }
  else {
    write({type:'ready',protocol:'yn-agent-api',protocolVersion:1,version:'fixture'});
    if (process.argv.includes('disconnect')) { setTimeout(() => socket.destroy(), 30); setTimeout(() => process.exit(0), 200); }
  }
});
socket.on('end', () => { eof = true; socket.end(); });
createInterface({input:socket, crlfDelay:Infinity}).on('line', line => {
  const {id,method,params} = JSON.parse(line);
  if (method === 'huge') { socket.write(JSON.stringify({id,ok:true,result:'x'.repeat(8*1024*1024)})+'\\n', () => { flushed = true; }); return; }
  if (method === 'bad') { socket.write('broken-json\\n'); return; }
  if (method === 'error') { write({id,ok:false,error:{code:'fixture_error',message:'Explicit error'}}); return; }
  if (method === 'shutdown') { socket.end(JSON.stringify({id,ok:true,result:{stopped:true}})+'\\n'); return; }
  setTimeout(() => write({id,ok:true,result:params}), params.delay ?? 0);
});
`);
const connect = mode => connectYnAgent(process.execPath, { args: [executable, ...(mode ? [mode] : [])], onDiagnostic: () => {} });
try {
  const client = connect(); await client.ready;
  const slow = client.call("echo", { value: "slow", delay: 15 });
  const fast = client.call("echo", { value: "fast" });
  assert.equal((await fast).value, "fast"); assert.equal((await slow).value, "slow");
  await assert.rejects(client.call("error"), error => error.code === "fixture_error");
  const close = client.close(); assert.equal(client.close(), close); await close;
  await assert.rejects(client.call("echo"), /closed/);
  const fatal = connect("fatal");
  await assert.rejects(fatal.ready, error => error.code === "instance_in_use");
  await assert.rejects(fatal.exited, error => error.code === "instance_in_use");
  await assert.rejects(fatal.close(), error => error.code === "instance_in_use");
  const early = connect("exit-early");
  await assert.rejects(early.ready, /before connecting/); await assert.rejects(early.exited, /before connecting/);
  const malformed = connect(); await malformed.ready;
  await assert.rejects(malformed.call("bad"), /JSON/); await assert.rejects(malformed.exited, /JSON/);
  const uncaught = [];
  const observeUncaught = error => { uncaught.push(error); };
  process.on("uncaughtException", observeUncaught);
  try {
    const disconnected = connect("disconnect"); await disconnected.ready;
    await new Promise(resolve => setTimeout(resolve, 45));
    await assert.rejects(disconnected.call("echo", { text: "x".repeat(8 * 1024 * 1024) }));
    await assert.rejects(disconnected.exited); assert.deepEqual(uncaught, []);
  } finally { process.removeListener("uncaughtException", observeUncaught); }

  // A caller can queue stdin immediately, before Electron/pipe startup. EOF
  // preserves all queued responses and exits without external termination.
  const child = spawn(process.execPath, ["agent-tools/yn-agent-server.mjs", process.execPath, executable], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  child.stdin.end(`${JSON.stringify({id:1,method:'echo',params:{value:'early'}})}\n`);
  assert.equal(await exited, 0, stderr);
  const packets = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(packets[0].type, "ready"); assert.equal(packets[1].result.value, "early");
  const marker = path.join(root, "epipe.json");
  const pipeFailure = spawn(process.execPath, ["agent-tools/yn-agent-server.mjs", process.execPath, executable, "huge", `marker=${marker}`],
    { stdio: ["pipe", "pipe", "pipe"] });
  let failureDiagnostics = "";
  pipeFailure.stderr.on("data", data => { failureDiagnostics += data; });
  const pipeExited = new Promise((resolve, reject) => { pipeFailure.once("error", reject); pipeFailure.once("close", resolve); });
  await new Promise(resolve => pipeFailure.stdout.once("data", resolve));
  pipeFailure.stdout.destroy();
  pipeFailure.stdin.write(`${JSON.stringify({id:1,method:'huge',params:{}})}\n`);
  assert.equal(await pipeExited, 1); assert.match(failureDiagnostics, /EPIPE/);
  const { readFile } = await import("node:fs/promises");
  assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { eof: true, flushed: true });
  console.log("Official Agent transport/client: handshake, concurrent replies, typed failures, startup exit and stdio EOF passed.");
} finally { await rm(root, { recursive: true, force: true }); }
