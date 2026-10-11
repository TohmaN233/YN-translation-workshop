import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serveAgentApiStdio } from "../src/main/agentApiStdio.ts";

const input = new PassThrough(), output = new PassThrough();
let stdout = "", closes = 0, release;
output.on("data", chunk => { stdout += chunk; });
const gate = new Promise(resolve => { release = resolve; });
const server = serveAgentApiStdio({ input, output, version: "test", api: {
  call: async method => { if (method === "start") await gate; return { method }; },
  close: async () => { closes += 1; release(); }
} });
// Input can arrive immediately, before the ready write's callback.
input.write('bad json\n{"id":1,"method":"start"}\n{"id":1,"method":"describe"}\n{"id":2,"method":"stop"}\n');
await new Promise(resolve => setImmediate(resolve));
let lines = stdout.trim().split("\n").map(line => JSON.parse(line));
assert.equal(lines[0].type, "ready");
assert.ok(lines.some(item => item.error?.code === "duplicate_id"));
assert.ok(lines.some(item => item.id === 2 && item.ok)); // Stop overtakes blocked start.
input.end(); await server;
lines = stdout.trim().split("\n").map(line => JSON.parse(line));
assert.ok(lines.some(item => item.id === 1 && item.ok));
assert.equal(closes, 1);

const in2 = new PassThrough(), out2 = new PassThrough();
out2.resume();
const failure = serveAgentApiStdio({ input: in2, output: out2, version: "test", api: { call: async () => ({}), close: async () => { throw new Error("Stop persistence failed"); } } });
in2.end(); await assert.rejects(failure, /Stop persistence failed/);
console.log("Agent API stdio: immediate input, parse errors, concurrent Stop, EOF and visible cleanup errors passed.");
