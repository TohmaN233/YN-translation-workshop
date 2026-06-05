import { contextBridge, ipcRenderer } from "electron";

function onAgentConsoleData(callback: (payload: { id: string; data: string }) => void) {
  const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }) => callback(payload);
  ipcRenderer.on("agent-console:data", listener);
  return () => ipcRenderer.removeListener("agent-console:data", listener);
}

function onAgentConsoleExit(callback: (payload: { id: string; exitCode: number | null; signal?: number }) => void) {
  const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; exitCode: number | null; signal?: number }) => callback(payload);
  ipcRenderer.on("agent-console:exit", listener);
  return () => ipcRenderer.removeListener("agent-console:exit", listener);
}

const agentConsoleApi = {
  startAgentConsole: (args: unknown) => ipcRenderer.invoke("agent-console:start", args),
  sendAgentConsoleInput: (data: string) => ipcRenderer.invoke("agent-console:input", { data }),
  writeAgentConsoleInput: (data: string) => ipcRenderer.invoke("agent-console:write", { data }),
  clearAgentConsoleOutput: () => ipcRenderer.invoke("agent-console:clear"),
  resizeAgentConsole: (args: unknown) => ipcRenderer.invoke("agent-console:resize", args),
  stopAgentConsole: () => ipcRenderer.invoke("agent-console:stop"),
  agentConsoleStatus: () => ipcRenderer.invoke("agent-console:status"),
  onAgentConsoleData,
  onAgentConsoleExit
};

contextBridge.exposeInMainWorld("workshop", {
  openFile: (filters?: Electron.FileFilter[]) => ipcRenderer.invoke("dialog:openFile", filters),
  openFileOrFolder: (filters?: Electron.FileFilter[]) => ipcRenderer.invoke("dialog:openFileOrFolder", filters),
  openFolder: () => ipcRenderer.invoke("dialog:openFolder"),
  loadProject: (outputDir?: string) => ipcRenderer.invoke("project:load", outputDir),
  saveProject: (outputDir: string, state: unknown) => ipcRenderer.invoke("project:save", outputDir, state),
  buildPrompt: (args: unknown) => ipcRenderer.invoke("prompts:build", args),
  generateLineReview: (args: unknown) => ipcRenderer.invoke("html:generateLineReview", args),
  generateProposalReview: (args: unknown) => ipcRenderer.invoke("html:generateProposalReview", args),
  openReviewHtml: (args: unknown) => ipcRenderer.invoke("html:openReviewHtml", args),
  findProofreadReport: (outputDir: string) => ipcRenderer.invoke("reports:findProofreadReport", outputDir),
  scanTranslations: (outputDir: string) => ipcRenderer.invoke("files:scanTranslations", outputDir),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:writeText", text),
  openPath: (targetPath: string) => ipcRenderer.invoke("shell:openPath", targetPath),
  skillInstallCommand: (args: unknown) => ipcRenderer.invoke("skills:installCommand", args),
  skillInstallStatus: (args: unknown) => ipcRenderer.invoke("skills:status", args),
  ...agentConsoleApi
});

contextBridge.exposeInMainWorld("workshopHtml", {
  openFile: (filters?: Electron.FileFilter[]) => ipcRenderer.invoke("dialog:openFile", filters),
  readTextFile: (args: { path: string }) => ipcRenderer.invoke("files:readTextFile", args),
  updateProjectState: (args: { outputDir?: string; patch?: unknown }) => ipcRenderer.invoke("project:patch", args),
  writeTextFile: (args: { path: string; text: string; outputDir?: string }) => ipcRenderer.invoke("files:writeTextFile", args),
  writeGlossaryFile: (args: { path: string; text: string; outputDir?: string }) => ipcRenderer.invoke("files:writeGlossaryFile", args),
  writeAuditWhitelistFile: (args: { outputDir?: string; sourcePath?: string; lines?: number[] }) => ipcRenderer.invoke("files:writeAuditWhitelistFile", args),
  writeEpubFile: (args: { templatePath: string; lines: string[]; outputDir?: string; mode?: "all" | "pair-position"; replacePosition?: number; pairSize?: number }) => ipcRenderer.invoke("files:writeEpubFile", args),
  generateProposalReview: (args: unknown) => ipcRenderer.invoke("html:generateProposalReview", args),
  buildPrompt: (args: unknown) => ipcRenderer.invoke("prompts:build", args),
  applyLineReviewState: (args: { lineReviewPath?: string; lineState?: unknown; line?: number; activate?: boolean }) => ipcRenderer.invoke("html:applyLineReviewState", args),
  startLanSync: (args: unknown) => ipcRenderer.invoke("lan-sync:start", args),
  sendLanSyncPatch: (args: unknown) => ipcRenderer.invoke("lan-sync:patch", args),
  stopLanSync: (token: string) => ipcRenderer.invoke("lan-sync:stop", token),
  onLanSyncPatch: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("lan-sync:patch", listener);
    return () => ipcRenderer.removeListener("lan-sync:patch", listener);
  },
  findProofreadReport: (outputDir: string) => ipcRenderer.invoke("reports:findProofreadReport", outputDir),
  openPath: (targetPath: string) => ipcRenderer.invoke("shell:openPath", targetPath),
  skillInstallCommand: (args: unknown) => ipcRenderer.invoke("skills:installCommand", args),
  skillInstallStatus: (args: unknown) => ipcRenderer.invoke("skills:status", args),
  ...agentConsoleApi
});

contextBridge.exposeInMainWorld("workshopTabs", {
  activate: (key: string) => ipcRenderer.invoke("html-tabs:activate", key),
  close: (key: string) => ipcRenderer.invoke("html-tabs:close", key)
});
