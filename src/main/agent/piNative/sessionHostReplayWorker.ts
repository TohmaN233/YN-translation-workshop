import { parentPort, workerData } from "node:worker_threads";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { StorageBackedSession, type JsonlSessionMetadata } from "@earendil-works/pi-agent-core/node";
import { IndexedJsonlStorage } from "./indexedJsonlStorage.ts";
import { registerDiskSession, unregisterDiskSession } from "./sessionAccess.ts";
import {
  replayYnSessionHostState,
  type YnHostStateReplayResult
} from "./proofreadSessionState.ts";

interface ReplayWorkerInput {
  path: string;
  metadata: JsonlSessionMetadata;
  ownerSessionId: string;
  projectRoot?: string;
  skipDerivedRestore?: boolean;
}

function serializeError(value: unknown): Record<string, unknown> {
  const error = value instanceof Error ? value : new Error(String(value));
  const code = "code" in error ? (error as Error & { code?: unknown }).code : undefined;
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(typeof code === "string" ? { code } : {})
  };
}

async function run(): Promise<void> {
  if (!parentPort) throw new Error("Pi Host-state replay worker requires worker_threads.");
  const input = workerData as ReplayWorkerInput;
  if (!input || typeof input.path !== "string" || !input.metadata || typeof input.ownerSessionId !== "string") {
    throw new Error("Pi Host-state replay worker received invalid input.");
  }
  if (input.metadata.id !== input.ownerSessionId || input.metadata.path !== input.path) {
    throw new Error("Pi Host-state replay worker input does not match its session owner or path.");
  }

  let storage: IndexedJsonlStorage | undefined;
  let session: StorageBackedSession<JsonlSessionMetadata> | undefined;
  let result: YnHostStateReplayResult | undefined;
  let failure: unknown;
  try {
    storage = await IndexedJsonlStorage.open(input.path, BACKGROUND_CONTEXT);
    if (storage.header.id !== input.metadata.id || storage.header.cwd !== input.metadata.cwd) {
      throw new Error(`Pi session storage identity changed during Host-state replay: ${input.metadata.id}.`);
    }
    session = new StorageBackedSession(input.metadata, storage);
    registerDiskSession(session,storage);
    result = await replayYnSessionHostState(session, input.ownerSessionId, {
      ...(input.skipDerivedRestore ? {skipDerivedRestore:true} : {}),
      ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
      onReplayProgress: (processedEntries, totalEntries) => {
        parentPort!.postMessage({ type: "progress", processedEntries, totalEntries });
      }
    });
  } catch (error) {
    failure = error;
  }

  try {
    if (session) unregisterDiskSession(session);
    if (session) await session.close(BACKGROUND_CONTEXT);
    else if (storage) await storage.close(BACKGROUND_CONTEXT);
  } catch (cleanupError) {
    failure = failure === undefined
      ? cleanupError
      : new AggregateError([failure, cleanupError], "Pi Host-state replay and worker storage cleanup both failed.");
  }

  if (failure !== undefined) parentPort.postMessage({ type: "failure", error: serializeError(failure) });
  else parentPort.postMessage({ type: "result", result });
}

void run().catch((error) => {
  parentPort?.postMessage({ type: "failure", error: serializeError(error) });
});
