import path from "node:path";

let globalAgentDir: string | undefined;

export function configureGlobalAgentDataDir(userDataDir: string): void {
  const resolved = path.join(path.resolve(userDataDir), "agent");
  if (globalAgentDir && globalAgentDir !== resolved) {
    throw new Error(`Global Agent data directory is already configured as ${globalAgentDir}.`);
  }
  globalAgentDir = resolved;
}

export function legacyAgentDataDir(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), "agent");
}

export function agentDataDir(workspaceDir: string): string {
  return globalAgentDir ?? legacyAgentDataDir(workspaceDir);
}

export function usesGlobalAgentDataDir(): boolean {
  return globalAgentDir !== undefined;
}
