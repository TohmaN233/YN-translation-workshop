import { openYnAgentTransport } from "./yn-agent-transport.mjs";

// Official stdio entry point. Use an installed/unpacked application EXE, never
// an installer or the NSIS portable launcher. Additional args support dev only.
const [executable, ...args] = process.argv.slice(2);
if (!executable) {
  process.stderr.write("Usage: node yn-agent-server.mjs <YN application executable> [application args]\n");
  process.exitCode = 1;
} else {
  let transport;
  try {
    transport = await openYnAgentTransport(executable, { args });
    const { socket, exited } = transport;
    let streamFailure;
    const closeInput = error => {
      streamFailure ??= error;
      process.stdin.unpipe(socket);
      process.stdin.pause();
      // A failed destination unpipes and pauses its source. Keep consuming
      // YN's remaining replies so output backpressure cannot block its Stop.
      socket.unpipe(process.stdout);
      socket.resume();
      socket.end(); // Native YN Stop, save, release, and exit.
    };
    socket.on("error", closeInput);
    process.stdin.on("error", closeInput);
    process.stdout.on("error", closeInput);
    socket.pipe(process.stdout);
    process.stdin.pipe(socket);
    const { code, signal } = await exited;
    process.stdin.unpipe(socket);
    process.stdin.pause();
    if (streamFailure) throw streamFailure;
    if (code !== 0) throw new Error(`YN Agent API exited with ${code ?? signal}.`);
  } catch (error) {
    process.stderr.write(`[yn-agent-server] ${error.stack ?? error}\n`);
    if (transport) { transport.socket.end(); await transport.exited; }
    process.exitCode = 1;
  }
}
