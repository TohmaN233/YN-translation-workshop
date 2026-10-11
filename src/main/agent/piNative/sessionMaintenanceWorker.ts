import { parentPort, workerData } from "node:worker_threads";
import { compactPiSessionFile } from "./sessionStorageMaintenance.ts";

const controller = new AbortController();
let publishReady: (() => void) | undefined;
let rejectPublish: ((reason: unknown) => void) | undefined;
parentPort!.on("message", (message) => {
  if (message.type === "cancel") {
    controller.abort(new DOMException("Session preparation stopped.", "AbortError"));
    rejectPublish?.(controller.signal.reason);
  } else if (message.type === "publish-ready") publishReady?.();
});
try {
  const receipt = await compactPiSessionFile(workerData.path, {
    signal: controller.signal,
    onProgress: (progress) => parentPort!.postMessage({ type: "progress", progress }),
    beforePublish: () => {
      controller.signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => { publishReady = resolve; rejectPublish = reject; });
    }
  });
  parentPort!.postMessage({ type: "complete", receipt });
} catch (error) {
  parentPort!.postMessage({ type: "failure", message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error" });
  process.exitCode = 1;
} finally { parentPort!.close(); }
