import { contextBridge, ipcRenderer } from "electron";

const agentArtifactApi = {
  discoverAgentArtifacts: (args: { projectDir: string; sourcePaths?: string[] }) =>
    ipcRenderer.invoke("agent-artifacts:discover", args),
  validateAgentArtifact: (args: { projectDir: string; sourcePath: string; candidatePath: string; locale?: "zh-CN" | "en-US"; languagePair?: string }) =>
    ipcRenderer.invoke("agent-artifacts:validate", args),
  buildAgentImportPlan: (args: { projectDir: string; sourcePath: string; candidatePath: string; locale?: "zh-CN" | "en-US"; languagePair?: string }) =>
    ipcRenderer.invoke("agent-artifacts:importPlan", args),
  buildAgentRepairPrompt: (args: { projectDir: string; sourcePath: string; candidatePath: string; locale?: "zh-CN" | "en-US"; languagePair?: string }) =>
    ipcRenderer.invoke("agent-artifacts:repairPrompt", args)
};

const agentProviderApi = {
  listAgentProviders: (args?: { outputDir?: string }) => ipcRenderer.invoke("agent-provider:list", args),
  getAgentProviderConfig: (args: { outputDir: string }) => ipcRenderer.invoke("agent-provider:getConfig", args),
  saveAgentProviderConfig: (args: unknown) => ipcRenderer.invoke("agent-provider:saveConfig", args),
  setAgentProviderEnabled: (args: { outputDir: string; providerId: string; enabled: boolean }) =>
    ipcRenderer.invoke("agent-provider:setEnabled", String(args.outputDir), String(args.providerId), Boolean(args.enabled)),
  deleteAgentProviderProfile: (args: { outputDir: string; providerId: string }) =>
    ipcRenderer.invoke("agent-provider:deleteProfile", String(args.outputDir), String(args.providerId)),
  validateAgentProvider: (args: { outputDir?: string; providerId: string }) => ipcRenderer.invoke("agent-provider:validate", args),
  connectAgentProviderOAuth: (args: { outputDir: string; providerId: string; mode?: "pkce" | "import" | "device"; profileId?: string; label?: string }) =>
    ipcRenderer.invoke("agent-provider:connectOAuth", args),
  listAgentModels: (args: { outputDir?: string; providerId: string }) =>
    ipcRenderer.invoke("agent-provider:listModels", args),
  listAgentConfiguredModels: (args: { outputDir: string }) =>
    ipcRenderer.invoke("agent-provider:listConfiguredModels", args),
  listAgentOAuthProfiles: (args: { outputDir: string; providerId: string }) =>
    ipcRenderer.invoke("agent-provider:listOAuthProfiles", args),
  setAgentOAuthProfile: (args: { outputDir: string; profileId: string }) =>
    ipcRenderer.invoke("agent-provider:setOAuthProfile", args),
  onAgentProviderUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("agent-provider:update", listener);
    return () => ipcRenderer.removeListener("agent-provider:update", listener);
  }
};

const onAgentSessionEvent = (callback: (payload: unknown) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on("agent-session:event", listener);
  return () => ipcRenderer.removeListener("agent-session:event", listener);
};

const onAgentSessionUpdate = (callback: (snapshot: unknown) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown) => callback(snapshot);
  ipcRenderer.on("agent-session:update", listener);
  return () => ipcRenderer.removeListener("agent-session:update", listener);
};

const agentSessionApi = {
  loadBootstrap: (args: { outputDir: string }) => ipcRenderer.invoke("agent-session:bootstrap", args),
  loadMessages: (args: { outputDir: string; sessionId: string }) => ipcRenderer.invoke("agent-session:messages", args),
  loadSubagentMessages: (args: { outputDir: string; parentSessionId: string; childSessionId: string }) =>
    ipcRenderer.invoke("agent-session:childMessages", args),
  loadRunState: (args: { outputDir: string; sessionId: string }) => ipcRenderer.invoke("agent-session:runState", args),
  loadRecentEvents: (args: { outputDir: string; sessionId: string; afterSequence?: number }) => ipcRenderer.invoke("agent-session:events", args),
  createSession: (args: { outputDir: string }) => ipcRenderer.invoke("agent-session:create", args),
  selectSession: (args: { outputDir: string; sessionId: string }) => ipcRenderer.invoke("agent-session:select", args),
  deleteSession: (args: { outputDir: string; sessionId: string }) => ipcRenderer.invoke("agent-session:delete", args),
  sendPrompt: (args: unknown) => ipcRenderer.invoke("agent-session:send", args),
  compact: (args: unknown) => ipcRenderer.invoke("agent-session:compact", args),
  abort: (args: { outputDir: string; sessionId: string }) => ipcRenderer.invoke("agent-session:abort", args),
  sendInput: (args: unknown) => ipcRenderer.invoke("agent-session:input", args),
  onEvent: onAgentSessionEvent,
  onSessionUpdate: onAgentSessionUpdate
};

const uiBridgeApi = {
  openAgentChat: () => ipcRenderer.invoke("ui:openAgentChat"),
  openAgentChatWindow: (args: { outputDir?: string; locale?: "zh-CN" | "en-US"; languagePair?: string; lineReviewPath?: string; sourcePath?: string; sourceKind?: "file" | "folder"; translationPath?: string; initialPrompt?: string; initialWorkflowIntent?: "translation" | "proofread"; initialLanguagePair?: string }) =>
    ipcRenderer.invoke("ui:openAgentChatWindow", args),
  agentChatEmbeddedEntryUrl: () => ipcRenderer.invoke("ui:agentChatEmbeddedEntryUrl"),
  onOpenAgentChat: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("ui:open-agent-chat", listener);
    return () => ipcRenderer.removeListener("ui:open-agent-chat", listener);
  }
};

const interfaceContextApi = {
  publishAgentInterfaceContext: (args: unknown) => ipcRenderer.invoke("agent-interface:publish", args)
};

contextBridge.exposeInMainWorld("workshop", {
  openFile: (filters?: Electron.FileFilter[]) => ipcRenderer.invoke("dialog:openFile", filters),
  openFileOrFolder: (filters?: Electron.FileFilter[]) => ipcRenderer.invoke("dialog:openFileOrFolder", filters),
  openFolder: () => ipcRenderer.invoke("dialog:openFolder"),
  openProjectFolder: () => ipcRenderer.invoke("dialog:openProjectFolder"),
  loadProject: (outputDir?: string) => ipcRenderer.invoke("project:load", outputDir),
  readProjectState: (outputDir?: string) => ipcRenderer.invoke("project:readState", outputDir),
  saveProject: (outputDir: string, state: unknown) => ipcRenderer.invoke("project:save", outputDir, state),
  onProjectStateUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("project:stateUpdate", listener);
    return () => ipcRenderer.removeListener("project:stateUpdate", listener);
  },
  readProjectAssets: (args: { outputDir: string }) => ipcRenderer.invoke("agent-assets:read", args),
  importProjectGlossaryFile: (args: { outputDir: string; path: string }) => ipcRenderer.invoke("agent-assets:importGlossaryFile", args),
  replaceProjectGlossary: (args: { outputDir: string; entries: Record<string, unknown>[] }) => ipcRenderer.invoke("agent-assets:replaceGlossary", args),
  updateProjectGlossaryEntry: (args: { outputDir: string; entry: Record<string, unknown> }) => ipcRenderer.invoke("agent-assets:updateGlossaryEntry", args),
  readWorkspaceAssetsStatus: (args: { outputDir: string }) => ipcRenderer.invoke("agent-assets:workspaceStatus", args),
  importGeneratedGlossaryCandidates: (args: { outputDir: string }) => ipcRenderer.invoke("agent-assets:importGeneratedGlossary", args),
  onWorkspaceAssetsStatus: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("agent-assets:workspaceUpdate", listener);
    return () => ipcRenderer.removeListener("agent-assets:workspaceUpdate", listener);
  },
  onProjectAssetsUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("agent-assets:projectUpdate", listener);
    return () => ipcRenderer.removeListener("agent-assets:projectUpdate", listener);
  },
  saveProjectAssets: (args: unknown) => ipcRenderer.invoke("agent-assets:save", args),
  listAssetProposals: (args: { outputDir: string }) => ipcRenderer.invoke("agent-assets:listProposals", args),
  approveAssetProposal: (args: { outputDir: string; proposalId: string; entry?: Record<string, unknown> }) => ipcRenderer.invoke("agent-assets:approveProposal", args),
  buildPrompt: (args: unknown) => ipcRenderer.invoke("prompts:build", args),
  generateLineReview: (args: unknown) => ipcRenderer.invoke("html:generateLineReview", args),
  generateProposalReview: (args: unknown) => ipcRenderer.invoke("html:generateProposalReview", args),
  openReviewHtml: (args: unknown) => ipcRenderer.invoke("html:openReviewHtml", args),
  findProofreadReport: (outputDir: string) => ipcRenderer.invoke("reports:findProofreadReport", outputDir),
  scanTranslations: (outputDir: string) => ipcRenderer.invoke("files:scanTranslations", outputDir),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:writeText", text),
  openPath: (targetPath: string) => ipcRenderer.invoke("shell:openPath", targetPath),
  ...agentArtifactApi,
  ...agentProviderApi,
  agentSession: agentSessionApi,
  ...interfaceContextApi,
  ...uiBridgeApi
});

contextBridge.exposeInMainWorld("workshopHtml", {
  openFile: (filters?: Electron.FileFilter[]) => ipcRenderer.invoke("dialog:openFile", filters),
  readProjectAssets: (args: { outputDir: string }) => ipcRenderer.invoke("agent-assets:read", args),
  importProjectGlossaryFile: (args: { outputDir: string; path: string }) => ipcRenderer.invoke("agent-assets:importGlossaryFile", args),
  replaceProjectGlossary: (args: { outputDir: string; entries: Record<string, unknown>[] }) => ipcRenderer.invoke("agent-assets:replaceGlossary", args),
  updateProjectGlossaryEntry: (args: { outputDir: string; entry: Record<string, unknown> }) => ipcRenderer.invoke("agent-assets:updateGlossaryEntry", args),
  readWorkspaceAssetsStatus: (args: { outputDir: string }) => ipcRenderer.invoke("agent-assets:workspaceStatus", args),
  importGeneratedGlossaryCandidates: (args: { outputDir: string }) => ipcRenderer.invoke("agent-assets:importGeneratedGlossary", args),
  onWorkspaceAssetsStatus: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("agent-assets:workspaceUpdate", listener);
    return () => ipcRenderer.removeListener("agent-assets:workspaceUpdate", listener);
  },
  onProjectAssetsUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("agent-assets:projectUpdate", listener);
    return () => ipcRenderer.removeListener("agent-assets:projectUpdate", listener);
  },
  readTextFile: (args: { path: string }) => ipcRenderer.invoke("files:readTextFile", args),
  readProjectState: (outputDir?: string) => ipcRenderer.invoke("project:readState", outputDir),
  updateProjectState: (args: { outputDir?: string; patch?: unknown }) => ipcRenderer.invoke("project:patch", args),
  onProjectStateUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("project:stateUpdate", listener);
    return () => ipcRenderer.removeListener("project:stateUpdate", listener);
  },
  writeTextFile: (args: { path: string; text: string; outputDir?: string }) => ipcRenderer.invoke("files:writeTextFile", args),
  writeBatchLineReviewTxt: () => ipcRenderer.invoke("html:writeBatchLineReviewTxt"),
  writeAuditWhitelistFile: (args: { outputDir?: string; documentId?: string; sourcePath?: string; lines?: number[]; lineReviewPath?: string; lineState?: unknown; changedLines?: number[] }) => ipcRenderer.invoke("files:writeAuditWhitelistFile", args),
  writeEpubFile: (args: { templatePath: string; lines: string[]; outputDir?: string; mode?: "all" | "pair-position"; replacePosition?: number; pairSize?: number }) => ipcRenderer.invoke("files:writeEpubFile", args),
  generateProposalReview: (args: unknown) => ipcRenderer.invoke("html:generateProposalReview", args),
  openReviewHtml: (args: unknown) => ipcRenderer.invoke("html:openReviewHtml", args),
  buildPrompt: (args: unknown) => ipcRenderer.invoke("prompts:build", args),
  applyLineReviewState: (args: { lineReviewPath?: string; lineState?: unknown; line?: number; lines?: number[]; activate?: boolean }) => ipcRenderer.invoke("html:applyLineReviewState", args),
  prepareProposalLineReviewBatch: (args: { outputDir?: string; reportPath?: string; lineReviewPath?: string; locale?: "zh-CN" | "en-US"; documents?: Array<{ documentId?: string; sourcePath?: string; translationPath?: string }> }) =>
    ipcRenderer.invoke("html:prepareProposalLineReviewBatch", args),
  resolveProposalLineReviewDocument: (args: { outputDir?: string; reportPath?: string; lineReviewPath?: string; documentId?: string; sourcePath?: string; translationPath?: string; locale?: "zh-CN" | "en-US" }) =>
    ipcRenderer.invoke("html:resolveProposalLineReviewDocument", args),
  applyProposalLineReviewStates: (args: { documents: Array<{ reportPath?: string; documentId?: string; sourcePath?: string; translationPath?: string; lineReviewPath?: string; lineState?: unknown; changedLines?: number[]; changedStateKeys?: string[]; expectedLineRevisions?: Record<string, number> }> }) =>
    ipcRenderer.invoke("html:applyProposalLineReviewStates", args),
  persistHtmlState: (args: { kind: "line" | "proposal"; lineReviewPath?: string; state: unknown; changedLines?: number[]; changedStateKeys?: string[]; clientId?: string; mutationId?: string }) => ipcRenderer.invoke("html:persistState", args),
  onLineReviewStateUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("html:lineReviewStateUpdate", listener);
    return () => ipcRenderer.removeListener("html:lineReviewStateUpdate", listener);
  },
  readLineReviewDocument: (args: { lineReviewPath: string }) => ipcRenderer.invoke("html:readLineReviewDocument", args),
  startLanSync: (args: unknown) => ipcRenderer.invoke("lan-sync:start", args),
  sendLanSyncPatch: (args: unknown) => ipcRenderer.invoke("lan-sync:patch", args),
  stopLanSync: (token: string) => ipcRenderer.invoke("lan-sync:stop", token),
  onLanSyncPatch: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("lan-sync:patch", listener);
    return () => ipcRenderer.removeListener("lan-sync:patch", listener);
  },
  onLanSyncCommand: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("lan-sync:command", listener);
    return () => ipcRenderer.removeListener("lan-sync:command", listener);
  },
  findProofreadReport: (outputDir: string) => ipcRenderer.invoke("reports:findProofreadReport", outputDir),
  openPath: (targetPath: string) => ipcRenderer.invoke("shell:openPath", targetPath),
  ...agentArtifactApi,
  ...agentProviderApi,
  agentSession: agentSessionApi,
  ...interfaceContextApi,
  openAgentChatWindow: uiBridgeApi.openAgentChatWindow,
  agentChatEmbeddedEntryUrl: uiBridgeApi.agentChatEmbeddedEntryUrl
});

contextBridge.exposeInMainWorld("workshopTabs", {
  activate: (key: string) => ipcRenderer.invoke("html-tabs:activate", key),
  close: (key: string) => ipcRenderer.invoke("html-tabs:close", key)
});
