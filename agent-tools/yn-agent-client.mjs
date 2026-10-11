import { openYnAgentTransport } from "./yn-agent-transport.mjs";
import { createInterface } from "node:readline";

/** Official stdio client. Never creates a project or confirms on the user's behalf. */
export function connectYnAgent(executable, { args = [], cwd, onDiagnostic = text => process.stderr.write(text) } = {}) {
  let socket, child;
  const transport = openYnAgentTransport(executable, { args, cwd, onDiagnostic });
  const pending = new Map();
  let nextId = 0, readyValue, terminalError;
  let resolveReady, rejectReady, resolveExit, rejectExit;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exited = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  // Callers may await ready before exited; retain each rejection for them.
  void ready.catch(() => {}); void exited.catch(() => {});
  const fail = error => {
    terminalError ??= error;
    rejectReady(terminalError);
    for (const request of pending.values()) request.reject(terminalError);
    pending.clear();
    socket?.end(); // EOF asks YN to perform its own Stop/flush/exit.
  };
  void transport.then(value => {
    socket = value.socket; child = value.child;
    socket.on("error", fail);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("error", fail);
    lines.on("line", line => {
      if (!line.trim()) return; // Empty transport separators carry no packet.
      try {
        const packet = JSON.parse(line);
        if (packet.type === "fatal") { const error = new Error(packet.error.message); error.code = packet.error.code; fail(error); return; }
        if (packet.type === "ready") {
          if (readyValue || packet.protocol !== "yn-agent-api" || packet.protocolVersion !== 1) throw new Error("Unsupported YN Agent API handshake.");
          readyValue = packet; resolveReady(packet); return;
        }
        const request = pending.get(packet.id);
        if (!request || typeof packet.ok !== "boolean") throw new Error("Unexpected YN Agent API response.");
        pending.delete(packet.id);
        if (packet.ok) request.resolve(packet.result);
        else { const error = new Error(packet.error.message); error.code = packet.error.code; request.reject(error); }
      } catch (error) { fail(error); }
    });
    void value.exited.then(({ code }) => {
      if (code !== 0 || !readyValue || pending.size) fail(new Error(`YN Agent API exited unexpectedly (${code}).`));
      if (terminalError) rejectExit(terminalError); else resolveExit();
    }, error => { fail(error); rejectExit(error); });
  }, error => { fail(error); rejectExit(error); });
  const call = async (method, params = {}) => {
    await ready;
    if (terminalError) throw terminalError;
    if (child.exitCode !== null || socket.writableEnded) throw new Error("YN Agent API connection is closed.");
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (error) fail(error);
      });
    });
  };
  let closeTask;
  const close = () => closeTask ??= (async () => {
    if (child && child.exitCode !== null) { await exited; return; }
    let requestError;
    try { await call("shutdown"); } catch (error) { requestError = error; }
    socket?.end();
    try { await exited; }
    catch (exitError) {
      if (requestError && requestError !== exitError) throw new AggregateError([requestError, exitError], `YN shutdown failed: ${requestError.message}; ${exitError.message}`);
      throw exitError;
    }
    if (requestError) throw requestError;
  })();
  return { ready, call, close, exited };
}
