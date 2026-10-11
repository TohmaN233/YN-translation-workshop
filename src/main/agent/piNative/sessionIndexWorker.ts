import { parentPort, workerData } from "node:worker_threads";
import { TornJsonlTailError } from "./jsonlRecords.ts";
import { buildJsonlDiskIndex } from "./indexedJsonlStorage.ts";

if (!parentPort) throw new Error("Pi session index worker requires worker_threads.");
void buildJsonlDiskIndex(workerData.path, undefined, progress => parentPort!.postMessage({type:"progress",progress})).then(index => parentPort!.postMessage({type:"result",index}),error => {
  parentPort!.postMessage({type:"failure",message:error instanceof Error ? error.message : String(error),
    ...(error instanceof TornJsonlTailError ? {code:error.code,committedBytes:error.committedBytes,tailBytes:error.tailBytes} : {})});
});