import assert from "node:assert/strict";
import path from "node:path";
import { PiNativeSessionService } from "../../src/main/agent/piNative/sessionService.ts";

const service = new PiNativeSessionService();
const root = path.resolve(".tmp-disposal-synthetic");
let finishSlow, slowSettled = false;
const gate = new Promise(resolve => { finishSlow = resolve; });
const released = [], closed = [];
const key = id => `${root.toLowerCase()}::${id}`;
for (const id of ["failed", "slow"]) {
  service.active.set(key(id), { sessionId: id, running: false, compacting: false, subagents: { hasRunning: () => false },
    unsubscribe: () => released.push(`unsubscribe:${id}`), runtime: { dispose: () => released.push(`runtime:${id}`) },
    session: { close: async () => { closed.push(id); if (id === "failed") throw new Error("Close flush failed"); } } });
}
service.abort = async (_root, id) => { if (id === "failed") throw new Error("Stop persistence failed"); await gate; slowSettled = true; };
// The actual production disposeWorkspace implementation runs on the real
// service; only I/O owners are synthetic, so no model or disk is touched.
const disposing = service.disposeWorkspace(root);
await new Promise(resolve => setImmediate(resolve));
assert.equal(slowSettled, false); assert.equal(closed.length, 0);
finishSlow();
await assert.rejects(disposing, error => error instanceof AggregateError && /Stop persistence failed/.test(error.message) && /Close flush failed/.test(error.message));
assert.equal(slowSettled, true); assert.deepEqual(closed, ["failed", "slow"]);
assert.equal(released.length, 4); assert.equal(service.active.has(key("slow")), false);
assert.equal(service.active.has(key("failed")), true);
service.active.clear();
service.active.set(key("unsettled"), { sessionId: "unsettled", running: true, compacting: false, subagents: { hasRunning: () => true } });
service.abort = async () => { throw new Error("Stop did not settle"); };
await assert.rejects(service.disposeWorkspace(root), /native work did not settle/);
assert.equal(service.active.has(key("unsettled")), true);
service.active.clear();
console.log("Native workspace disposal: all Stop operations settle, independent handles close, errors aggregate, active owners remain guarded.");
