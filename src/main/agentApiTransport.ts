import { createConnection, type Socket } from "node:net";

export function connectAgentApiPipe(endpoint: string): Promise<Socket> {
  if (!endpoint) return Promise.reject(new Error("YN Agent API requires a local pipe endpoint."));
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: endpoint, allowHalfOpen: true });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
  });
}
