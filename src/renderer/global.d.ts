export {};

type WorkshopPromptKind = "translate" | "proofread";
type WorkshopWorkflowIntent = "translation" | "proofread";
type WorkshopWorkflowPromptMetadata = {
  workflowIntent: WorkshopWorkflowIntent;
  languagePair: string;
  style?: string;
  workDescription?: string;
  glossaryPath?: string;
  glossaryCandidates?: boolean;
  characterBible?: boolean;
  reuseExistingTranslation?: boolean;
  auditWhitelistLines?: number[];
  customPreserveRules?: Array<{ label?: string; pattern: string; flags: string }>;
  subagentEnabled?: boolean;
  subagentCount?: number;
  reviewSubagentCount?: number;
  subagentProviderId?: string;
  subagentModelId?: string;
  translationSplitSize?: number;
  folderTranslationOrder?: string;
  folderSourceDocuments?: Array<{ id: string; path: string }>;
  proofreadMode?: "split" | "montecarlo";
  proofreadSplitSize?: number;
  proofreadMontecarloSize?: number;
  proofreadMontecarloRoundMin?: number;
  proofreadMontecarloRoundMax?: number;
};
type WorkshopProofreadMode = "split" | "montecarlo";

type WorkshopPromptBuildArgs = {
  kind: WorkshopPromptKind;
  sourcePath?: string;
  sourceKind?: "file" | "folder";
  translationPath?: string;
  outputDir?: string;
  glossaryPath?: string;
  inputMode?: "separate" | "bilingual";
  advanced?: {
    languagePair?: string;
    style?: string;
    split?: boolean;
    splitSize?: number;
    customPreserveRules?: Array<{ label?: string; pattern: string; flags?: string }>;
    folderTranslationOrder?: string;
    workDescription?: string;
    translateOutputDir?: string;
    proofreadOutputDir?: string;
    proofreadMode?: WorkshopProofreadMode;
    candidateRatio?: number;
    montecarloSize?: number;
    montecarloRoundMin?: number;
    montecarloRoundMax?: number;
    subagentEnabled?: boolean;
    subagentCount?: number;
    reviewSubagentCount?: number;
    subagentProviderId?: string;
    subagentModelId?: string;
  };
};

type WorkshopProposalReviewResult = {
  outputPath?: string;
  proposalCount: number;
  reportPath?: string;
  lineReviewPath?: string;
  fallbackPrompt?: string;
};

type WorkshopLanSyncPatch = {
  type: "line-edit" | "line-restore" | "proposal-decision";
  line?: number;
  proposalId?: string;
  text?: string;
  status?: string;
  manualText?: string;
  clientId?: string;
  timestamp?: string;
};

type WorkshopLanSyncStartResult = {
  ok: boolean;
  token: string;
  localUrl: string;
  lanUrls: string[];
  externalTunnelNote: string;
};

type WorkshopValidationFinding = {
  code:
    | "line_count_mismatch"
    | "placeholder_mismatch"
    | "tag_mismatch"
    | "empty_line_displaced"
    | "likely_untranslated"
    | "glossary_missing"
    | "character_name_missing"
    | "character_voice_required_missing"
    | "character_voice_forbidden_term"
    | "style_forbidden_term"
    | "length_anomaly";
  severity: "blocking" | "warning";
  line?: number;
  detail: string;
};

type WorkshopTranslationValidationResult = {
  ok: boolean;
  sourceLineCount: number;
  candidateLineCount: number;
  blocking: WorkshopValidationFinding[];
  warnings: WorkshopValidationFinding[];
  styleScore?: number;
  voiceScore?: number;
  summary: string;
};

type WorkshopCandidateArtifact = {
  path: string;
  basename: string;
  size: number;
  modifiedAt: string;
  directory: string;
  sourcePath?: string;
  sourceBasename?: string;
};

type WorkshopCandidateImportPlan = {
  ok: boolean;
  validation: WorkshopTranslationValidationResult;
  edits: Record<number, string>;
  status: Record<number, "machine">;
  lineCount: number;
};

type WorkshopAgentArtifactApi = {
  discoverAgentArtifacts: (args: { projectDir: string; sourcePaths?: string[] }) => Promise<WorkshopCandidateArtifact[]>;
  validateAgentArtifact: (args: { projectDir: string; sourcePath: string; candidatePath: string; locale?: "zh-CN" | "en-US"; languagePair?: string; glossaryPath?: string }) => Promise<WorkshopTranslationValidationResult>;
  buildAgentImportPlan: (args: { projectDir: string; sourcePath: string; candidatePath: string; locale?: "zh-CN" | "en-US"; languagePair?: string; glossaryPath?: string }) => Promise<WorkshopCandidateImportPlan>;
  buildAgentRepairPrompt: (args: { projectDir: string; sourcePath: string; candidatePath: string; locale?: "zh-CN" | "en-US" }) => Promise<string>;
};

type WorkshopAgentSessionApi = {
  loadBootstrap: (args: { outputDir: string }) => Promise<import("../shared/agent/piSessionContract.ts").PiSessionBootstrap>;
  loadMessages: (args: { outputDir: string; sessionId: string }) => Promise<import("@earendil-works/pi-agent-core").AgentMessage[]>;
  loadSubagentMessages: (args: import("../shared/agent/piSessionContract.ts").PiChildSessionMessagesRequest) => Promise<import("@earendil-works/pi-agent-core").AgentMessage[]>;
  loadRunState: (args: { outputDir: string; sessionId: string }) => Promise<import("../shared/agent/piSessionContract.ts").PiSessionRunState>;
  loadRecentEvents: (args: { outputDir: string; sessionId: string; afterSequence?: number }) => Promise<import("../shared/agent/piSessionContract.ts").PiSessionEventEnvelope[]>;
  createSession: (args: { outputDir: string }) => Promise<import("../shared/agent/piSessionContract.ts").PiSessionSummary>;
  selectSession: (args: { outputDir: string; sessionId: string }) => Promise<{ ok: true }>;
  deleteSession: (args: { outputDir: string; sessionId: string }) => Promise<{ removed: boolean }>;
  sendPrompt: (args: import("../shared/agent/piSessionContract.ts").PiSessionPromptRequest) => Promise<import("../shared/agent/piSessionContract.ts").PiSessionPromptAcceptance>;
  compact: (args: import("../shared/agent/piSessionContract.ts").PiSessionCompactRequest) => Promise<import("../shared/agent/piSessionContract.ts").PiSessionCompactionResult>;
  abort: (args: { outputDir: string; sessionId: string }) => Promise<{ ok: true }>;
  sendInput: (args: import("../shared/agent/piSessionContract.ts").PiSessionInputRequest) => Promise<{ ok: true }>;
  onEvent: (callback: (payload: import("../shared/agent/piSessionContract.ts").PiSessionEventEnvelope) => void) => () => void;
  onSessionUpdate: (callback: (payload: import("../shared/agent/piSessionContract.ts").PiSessionStateEnvelope) => void) => () => void;
};

type WorkshopAgentProviderApi = {
  listAgentProviders: (args?: { outputDir?: string }) => Promise<Array<{
    id: string;
    presetId?: string;
    name: string;
    type: "openai_compatible";
    requiresAuth?: boolean;
    auth?: string;
    description?: string;
    defaultModel?: string;
    enabled?: boolean;
    capabilities?: {
      authModes?: Array<"api_key" | "oauth">;
      cacheStrategy?: "none" | "prompt_cache_key" | "anthropic_cache_control";
      supportsPromptCache?: boolean;
      supportsReasoning?: boolean;
      modelSource?: "pi_registry" | "explicit";
    };
  }>>;
  getAgentProviderConfig: (args: { outputDir: string }) => Promise<{ activeProviderId: string; providers: Record<string, unknown> }>;
  saveAgentProviderConfig: (args: unknown) => Promise<{ activeProviderId: string; providers: Record<string, unknown> }>;
  setAgentProviderEnabled: (args: { outputDir: string; providerId: string; enabled: boolean }) => Promise<{ activeProviderId: string; providers: Record<string, unknown> }>;
  deleteAgentProviderProfile: (args: { outputDir: string; providerId: string }) => Promise<{ activeProviderId: string; providers: Record<string, unknown> }>;
  validateAgentProvider: (args: { outputDir?: string; providerId: string }) => Promise<{ ok: boolean; detail?: string }>;
  connectAgentProviderOAuth: (args: { outputDir: string; providerId: string; mode?: "pkce" | "import" | "device"; profileId?: string; label?: string }) => Promise<{ ok: boolean; message?: string }>;
  listAgentModels: (args: { outputDir?: string; providerId: string }) => Promise<Array<{ id: string; label: string; description?: string }>>;
  listAgentConfiguredModels: (args: { outputDir: string }) => Promise<Array<{ providerId: string; providerName: string; modelId: string; modelName: string; supportsImages: boolean; thinkingLevels?: Array<"off" | "minimal" | "low" | "medium" | "high" | "xhigh"> }>>;
  listAgentOAuthProfiles: (args: { outputDir: string; providerId: string }) => Promise<{ activeProfileId: string; profiles: Array<{ id: string; label: string; updatedAt: string }> }>;
  setAgentOAuthProfile: (args: { outputDir: string; profileId: string }) => Promise<{ ok: boolean; activeProfileId: string }>;
  onAgentProviderUpdate: (callback: (payload: { scope?: "global"; workspaceDir: string; config: { activeProviderId: string; providers: Record<string, unknown> } }) => void) => () => void;
};

declare global {
  interface Window {
    workshop: WorkshopAgentArtifactApi & WorkshopAgentProviderApi & {
      agentSession: WorkshopAgentSessionApi;
      publishAgentInterfaceContext: (args: import("../shared/agent/ynInterfaceContext.ts").YnInterfaceContext) => Promise<import("../shared/agent/ynInterfaceContext.ts").YnInterfaceContextPublishResult>;
      openFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | undefined>;
      openFileOrFolder: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | undefined>;
      openFolder: () => Promise<string | undefined>;
      openProjectFolder: () => Promise<string | undefined>;
      loadProject: (outputDir?: string) => Promise<unknown>;
      readProjectState: (outputDir?: string) => Promise<Record<string, unknown>>;
      saveProject: (outputDir: string, state: unknown) => Promise<boolean>;
      onProjectStateUpdate: (callback: (payload: { outputDir: string; state: Record<string, unknown>; patch: Record<string, unknown> }) => void) => () => void;
      readProjectAssets: (args: { outputDir: string }) => Promise<{
        paths?: {
          glossary?: string;
          characterBible?: string;
          styleGuide?: string;
          translationMemory?: string;
        };
        available?: {
          glossary?: boolean;
          characterBible?: boolean;
          styleGuide?: boolean;
          translationMemory?: boolean;
        };
        glossary?: { entries?: unknown[] };
        characterBible?: { characters?: unknown[] };
        styleGuide?: string;
        translationMemory?: { segmentCount?: number };
      }>;
      importProjectGlossaryFile: (args: { outputDir: string; path: string }) => Promise<{
        paths?: { glossary?: string };
        glossary?: { entries?: unknown[] };
      }>;
      replaceProjectGlossary: (args: { outputDir: string; entries: Record<string, unknown>[] }) => Promise<{
        paths?: { glossary?: string };
        glossary?: { entries?: unknown[] };
      }>;
      updateProjectGlossaryEntry: (args: { outputDir: string; entry: Record<string, unknown>; boundGlossaryPath?: string }) => Promise<{
        paths?: { glossary?: string };
        glossary?: { entries?: unknown[] };
      }>;
      readWorkspaceAssetsStatus: (args: { outputDir: string }) => Promise<{
        paths: { glossaryCandidates: string; characterBible: string };
        counts: { glossaryCandidates: number; characterBibleLines: number };
        available: { glossaryCandidates: boolean; characterBible: boolean };
        pending: { glossaryCandidates: number };
        actions: { importGlossaryCandidates: boolean };
      }>;
      importGeneratedGlossaryCandidates: (args: { outputDir: string }) => Promise<{
        assets: unknown;
        counts: { imported: number; added: number; deduplicated: number; aliasesAdded: number };
      }>;
      onWorkspaceAssetsStatus: (callback: (payload: {
        outputDir: string;
        status: {
          paths: { glossaryCandidates: string; characterBible: string };
          counts: { glossaryCandidates: number; characterBibleLines: number };
          available: { glossaryCandidates: boolean; characterBible: boolean };
          pending: { glossaryCandidates: number };
          actions: { importGlossaryCandidates: boolean };
        };
      }) => void) => () => void;
      onProjectAssetsUpdate: (callback: (payload: { outputDir: string; assets: {
        paths?: { glossary?: string; characterBible?: string; styleGuide?: string };
        available?: { glossary?: boolean; characterBible?: boolean; styleGuide?: boolean; translationMemory?: boolean };
        glossary?: { entries?: unknown[] };
        characterBible?: { characters?: unknown[]; source?: string };
        styleGuide?: string;
      } }) => void) => () => void;
      saveProjectAssets: (args: {
        outputDir: string;
        glossaryEntry?: Record<string, unknown>;
        characterEntry?: Record<string, unknown>;
        styleGuide?: string;
      }) => Promise<{
        paths?: {
          glossary?: string;
          characterBible?: string;
          styleGuide?: string;
          translationMemory?: string;
        };
        available?: {
          glossary?: boolean;
          characterBible?: boolean;
          styleGuide?: boolean;
          translationMemory?: boolean;
        };
        glossary?: { entries?: unknown[] };
        characterBible?: { characters?: unknown[] };
        styleGuide?: string;
        translationMemory?: { segmentCount?: number };
      }>;
      listAssetProposals: (args: { outputDir: string }) => Promise<Array<{ id: string; kind: string; status: string; entry?: Record<string, unknown>; reason?: string; createdAt: string }>>;
      approveAssetProposal: (args: { outputDir: string; proposalId: string; entry?: Record<string, unknown> }) => Promise<{ id: string; status: string }>;
      buildPrompt: (args: WorkshopPromptBuildArgs) => Promise<string>;
      generateLineReview: (args: unknown) => Promise<{ outputPath: string; fileCount?: number; matchedCount?: number; warningCount?: number }>;
      generateProposalReview: (args: unknown) => Promise<WorkshopProposalReviewResult>;
      openReviewHtml: (args: { htmlPath: string; outputDir?: string; activate?: boolean }) => Promise<{ ok: boolean }>;
      findProofreadReport: (outputDir: string) => Promise<Array<{ path: string; size: number; modifiedMs: number; score: number; reasons: string[] }>>;
      scanTranslations: (outputDir: string) => Promise<Array<{ path: string; size: number; modifiedAt: string }>>;
      copyText: (text: string) => Promise<boolean>;
      openPath: (targetPath: string) => Promise<string>;
      openAgentChat: () => Promise<{ ok: boolean; message?: string }>;
      openAgentChatWindow: (args: { outputDir?: string; locale?: "zh-CN" | "en-US"; languagePair?: string; lineReviewPath?: string; sourcePath?: string; sourceKind?: "file" | "folder"; translationPath?: string; initialPrompt?: string; initialWorkflowIntent?: "translation" | "proofread"; initialLanguagePair?: string }) => Promise<{ ok: boolean; message?: string }>;
      onOpenAgentChat: (callback: () => void) => () => void;
      agentChatEmbeddedEntryUrl: () => Promise<{ ok: boolean; url?: string; cssUrl?: string; message?: string }>;
    };
    workshopHtml?: WorkshopAgentArtifactApi & WorkshopAgentProviderApi & {
      agentSession: WorkshopAgentSessionApi;
      publishAgentInterfaceContext: (args: import("../shared/agent/ynInterfaceContext.ts").YnInterfaceContext) => Promise<import("../shared/agent/ynInterfaceContext.ts").YnInterfaceContextPublishResult>;
      openFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | undefined>;
      readProjectAssets: (args: { outputDir: string }) => Promise<{
        paths?: { glossary?: string; characterBible?: string; styleGuide?: string };
        glossary?: { entries?: unknown[] };
        characterBible?: { characters?: unknown[]; source?: string };
        styleGuide?: string;
      }>;
      importProjectGlossaryFile: (args: { outputDir: string; path: string }) => Promise<{
        paths?: { glossary?: string };
        glossary?: { entries?: unknown[] };
      }>;
      replaceProjectGlossary: (args: { outputDir: string; entries: Record<string, unknown>[] }) => Promise<{
        paths?: { glossary?: string };
        glossary?: { entries?: unknown[] };
      }>;
      updateProjectGlossaryEntry: (args: { outputDir: string; entry: Record<string, unknown>; boundGlossaryPath?: string }) => Promise<{
        paths?: { glossary?: string };
        glossary?: { entries?: unknown[] };
      }>;
      readWorkspaceAssetsStatus: (args: { outputDir: string }) => Promise<{
        paths: { glossaryCandidates: string; characterBible: string };
        counts: { glossaryCandidates: number; characterBibleLines: number };
        available: { glossaryCandidates: boolean; characterBible: boolean };
        pending: { glossaryCandidates: number };
        actions: { importGlossaryCandidates: boolean };
      }>;
      importGeneratedGlossaryCandidates: (args: { outputDir: string }) => Promise<{
        assets: { paths?: { glossary?: string }; glossary?: { entries?: unknown[] } };
        counts: { imported: number; added: number; deduplicated: number; aliasesAdded: number };
      }>;
      onWorkspaceAssetsStatus: (callback: (payload: {
        outputDir: string;
        status: {
          paths: { glossaryCandidates: string; characterBible: string };
          counts: { glossaryCandidates: number; characterBibleLines: number };
          available: { glossaryCandidates: boolean; characterBible: boolean };
          pending: { glossaryCandidates: number };
          actions: { importGlossaryCandidates: boolean };
        };
      }) => void) => () => void;
      onProjectAssetsUpdate: (callback: (payload: { outputDir: string; assets: {
        paths?: { glossary?: string; characterBible?: string; styleGuide?: string };
        glossary?: { entries?: unknown[] };
        characterBible?: { characters?: unknown[]; source?: string };
        styleGuide?: string;
      } }) => void) => () => void;
      readTextFile: (args: { path: string }) => Promise<{ ok: boolean; path: string; text: string }>;
      readProjectState: (outputDir?: string) => Promise<Record<string, unknown>>;
      updateProjectState: (args: { outputDir?: string; patch?: unknown }) => Promise<boolean>;
      onProjectStateUpdate: (callback: (payload: { outputDir: string; state: Record<string, unknown>; patch: Record<string, unknown> }) => void) => () => void;
      writeTextFile: (args: { path: string; text: string; outputDir?: string }) => Promise<{ ok: boolean; path: string; backupPath?: string }>;
      writeBatchLineReviewTxt: () => Promise<{
        ok: boolean;
        written: Array<{ path: string; backupPath?: string; lineCount: number }>;
      }>;
      writeAuditWhitelistFile: (args: { outputDir?: string; documentId?: string; sourcePath?: string; lines?: number[]; lineReviewPath?: string; lineState?: unknown; changedLines?: number[] }) => Promise<{ ok: boolean; path: string; backupPath?: string; lineCount: number; lineReviewPath?: string; state?: Record<string, unknown>; changedLines?: number[] }>;
      writeEpubFile: (args: { templatePath: string; lines: string[]; outputDir?: string; mode?: "all" | "pair-position"; replacePosition?: number; pairSize?: number }) => Promise<{ ok: boolean; path: string; changedDocuments: number }>;
      generateProposalReview: (args: unknown) => Promise<WorkshopProposalReviewResult>;
      buildPrompt: (args: WorkshopPromptBuildArgs) => Promise<string>;
      applyLineReviewState: (args: { lineReviewPath?: string; lineState?: unknown; line?: number; lines?: number[]; activate?: boolean }) => Promise<{ ok: boolean }>;
      prepareProposalLineReviewBatch: (args: { outputDir?: string; reportPath?: string; lineReviewPath?: string; locale?: "zh-CN" | "en-US"; documents?: Array<{ documentId?: string; sourcePath?: string; translationPath?: string }> }) => Promise<{
        ok: boolean;
        batch: boolean;
        synchronized: number;
        migrated: number;
        error?: string;
      }>;
      resolveProposalLineReviewDocument: (args: { outputDir?: string; reportPath?: string; lineReviewPath?: string; documentId?: string; sourcePath?: string; translationPath?: string; locale?: "zh-CN" | "en-US" }) => Promise<{
        documentId: string;
        sourcePath: string;
        translationPath?: string;
        title?: string;
        rows: Array<{ line: number; source: string; translation?: string; status?: string }>;
        state: Record<string, unknown>;
        pageSize?: number;
        lineReviewPath: string;
      }>;
      applyProposalLineReviewStates: (args: { documents: Array<{ reportPath?: string; documentId?: string; sourcePath?: string; translationPath?: string; lineReviewPath?: string; lineState?: unknown; changedLines?: number[]; changedStateKeys?: string[] }> }) => Promise<{
        ok: boolean;
        error?: string;
        documents: Array<{ lineReviewPath: string; state: Record<string, unknown>; changedLines: number[]; changedStateKeys: string[] }>;
      }>;
      persistHtmlState: (args: { kind: "line" | "proposal"; lineReviewPath?: string; state: unknown; changedLines?: number[]; changedStateKeys?: string[]; clientId?: string; mutationId?: string }) => Promise<{
        ok: boolean;
        path?: string;
        lineReviewPath?: string;
        state?: Record<string, unknown>;
        changedLines?: number[];
        changedStateKeys?: string[];
        clientId?: string;
        mutationId?: string;
      }>;
      onLineReviewStateUpdate: (callback: (payload: {
        lineReviewPath?: string;
        state?: Record<string, unknown>;
        changedLines?: number[];
        changedStateKeys?: string[];
        clientId?: string;
        mutationId?: string;
      }) => void) => () => void;
      readLineReviewDocument: (args: { lineReviewPath: string }) => Promise<{
        title?: string;
        rows: Array<{ line: number; source: string; translation?: string; status?: string }>;
        state: Record<string, unknown>;
        pageSize?: number;
        lineReviewPath?: string;
      }>;
      startLanSync: (args: unknown) => Promise<WorkshopLanSyncStartResult>;
      sendLanSyncPatch: (args: { token?: string; patch: WorkshopLanSyncPatch }) => Promise<{ ok: boolean }>;
      stopLanSync: (token: string) => Promise<{ ok: boolean }>;
      onLanSyncPatch: (callback: (payload: { token: string; patch: WorkshopLanSyncPatch }) => void) => () => void;
      onLanSyncCommand: (callback: (payload: { token: string; command: { type: "open-agent-os" } }) => void) => () => void;
      findProofreadReport: (outputDir: string) => Promise<Array<{ path: string; size: number; modifiedMs: number; score: number; reasons: string[] }>>;
      openPath: (targetPath: string) => Promise<string>;
      openAgentChatWindow: (args: { outputDir?: string; locale?: "zh-CN" | "en-US"; languagePair?: string; lineReviewPath?: string; sourcePath?: string; sourceKind?: "file" | "folder"; translationPath?: string; initialPrompt?: string; initialWorkflowIntent?: "translation" | "proofread"; initialLanguagePair?: string }) => Promise<{ ok: boolean; message?: string }>;
      agentChatEmbeddedEntryUrl: () => Promise<{ ok: boolean; url?: string; cssUrl?: string; message?: string }>;
    };
    workshopTabs?: {
      activate: (key: string) => Promise<boolean>;
      close: (key: string) => Promise<boolean>;
    };
    YnPiWebAgentEmbedded?: {
      mount: (target: HTMLElement, route: { outputDir?: string; locale?: "zh-CN" | "en-US"; languagePair?: string; sourcePath?: string; sourceKind?: "file" | "folder"; translationPath?: string; lineReviewPath?: string }) => Promise<void>;
      close?: () => void;
      popout?: () => void;
      insertText?: (text: string, workflowMetadata?: WorkshopWorkflowPromptMetadata) => void;
      insertIfEmpty?: (text: string, workflowMetadata?: WorkshopWorkflowPromptMetadata) => void;
      replaceText?: (text: string, workflowMetadata?: WorkshopWorkflowPromptMetadata) => void;
      openSettings?: () => void;
    };
  }
}
