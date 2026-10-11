import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

/** Electron's Windows GUI executable has no usable piped stdin. A private
 * local pipe carries the same NDJSON protocol; Node owns the caller's stdio. */
export async function openYnAgentTransport(executable, { args = [], cwd, onDiagnostic = text => process.stderr.write(text) } = {}) {
  const id = randomUUID();
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\yn-agent-${id}` : path.join(tmpdir(), `yn-agent-${id}.sock`);
  const server = createServer({ allowHalfOpen: true });
  let resolveConnection, rejectConnection, resolveExit, rejectExit, accepted = false;
  const connection = new Promise((resolve, reject) => { resolveConnection = resolve; rejectConnection = reject; });
  const exited = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  void connection.catch(() => {}); void exited.catch(() => {});
  server.on("error", error => { rejectConnection(error); rejectExit(error); });
  server.on("connection", socket => {
    if (accepted) { onDiagnostic("[yn-agent-transport] Rejected a second pipe connection.\n"); socket.destroy(); return; }
    accepted = true;
    server.close();
    resolveConnection(socket);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  const child = spawn(executable, [...args, `--agent-api-pipe=${endpoint}`], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", chunk => onDiagnostic(chunk.toString()));
  // The protocol travels through the pipe. Native Electron startup can write
  // an empty CRLF to stdout; preserve any other output as diagnostics.
  child.stdout.on("data", chunk => { if (chunk.toString().trim()) onDiagnostic(chunk.toString()); });
  child.on("error", error => { server.close(); rejectConnection(error); rejectExit(error); });
  child.on("close", (code, signal) => {
    server.close();
    if (!accepted) rejectConnection(new Error(`YN exited before connecting its Agent API (${code ?? signal}).`));
    resolveExit({ code, signal });
  });
  return { socket: await connection, child, exited };
}
