import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { AGENT_API_VERSION, AgentApiError, agentApiError } from "./agentApi.ts";

/** One JSON object per line. stdout belongs exclusively to this protocol. */
export async function serveAgentApiStdio(options: {
  api: { call(method: string, params?: unknown): Promise<unknown>; close(): Promise<void> };
  input: Readable; output: Writable; version: string;
}): Promise<void> {
  const { api, input, output } = options;
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  const ids = new Set<string>();
  let closing = false;
  let outputFailure: Error | undefined;
  const write = (value: unknown) => new Promise<void>((resolve, reject) => {
    if (outputFailure) { reject(outputFailure); return; }
    output.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve());
  });
  let closeTask: Promise<void> | undefined;
  const close = () => closeTask ??= (async () => {
    closing = true;
    lines.close();
    await api.close();
  })();
  const onOutputError = (error: Error) => { outputFailure = error; void close().catch(error => console.error("[agent-api:shutdown]", error)); };
  output.on("error", onOutputError);
  let fatal: unknown;
  try {
    const inputClosed = new Promise<void>((resolve, reject) => { lines.once("close", resolve); lines.once("error", reject); });
    lines.on("line", line => {
      if (closing) return;
      if (!line.trim()) return;
      let id: string | number | null = null;
      let method = "";
      let acceptedShutdown = false;
      const task = (async () => {
        try {
          let request;
          try { request = JSON.parse(line); }
          catch { throw new AgentApiError("invalid_request", "Input line is not valid JSON."); }
          if (!request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).some(key => !["id", "method", "params"].includes(key))
            || !(typeof request.id === "string" && request.id.trim() || typeof request.id === "number" && Number.isSafeInteger(request.id))
            || typeof request.method !== "string") throw new AgentApiError("invalid_request", "Expected {id, method, params}.");
          id = request.id; method = request.method;
          const key = JSON.stringify(id);
          if (ids.has(key)) throw new AgentApiError("duplicate_id", "Request id is already in flight.");
          ids.add(key);
          try {
            const result = await api.call(method, request.params);
            acceptedShutdown = method === "shutdown";
            await write({ id, ok: true, result });
          }
          finally { ids.delete(key); }
        } catch (error) {
          console.error("[agent-api:request]", { id, method, error: agentApiError(error) });
          await write({ id, ok: false, error: agentApiError(error) });
        }
        if (acceptedShutdown) await close();
      })();
      pending.add(task);
      void task.catch(error => { fatal = error; void close().catch(error => { fatal = error; }); }).finally(() => pending.delete(task));
    });
    await write({ type: "ready", protocol: "yn-agent-api", protocolVersion: AGENT_API_VERSION, version: options.version });
    await inputClosed;
    await close();
    await Promise.allSettled([...pending]);
    if (fatal || outputFailure) throw fatal ?? outputFailure;
  } finally {
    await close();
    output.removeListener("error", onOutputError);
  }
}
