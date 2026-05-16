export {};

type WorkshopAgentConsoleStatus = {
  running: boolean;
  id?: string;
  agent?: "codex" | "claude";
  outputDir?: string;
  startedAt?: string;
  output?: string;
};

type WorkshopAgentConsoleResult = {
  ok: boolean;
  message?: string;
  status?: WorkshopAgentConsoleStatus;
};

type WorkshopAgentConsoleExit = {
  id: string;
  exitCode: number | null;
  signal?: number;
};

type WorkshopAgentConsoleData = {
  id: string;
  data: string;
};

type WorkshopSkillInstallAgent = "codex" | "claude" | "all";
type WorkshopPromptKind = "translate" | "proofread";
type WorkshopProofreadMode = "split" | "montecarlo";

type WorkshopPromptBuildArgs = {
  kind: WorkshopPromptKind;
  agent?: "codex" | "claude";
  sourcePath?: string;
  translationPath?: string;
  outputDir?: string;
  glossaryPath?: string;
  inputMode?: "separate" | "bilingual";
  advanced?: {
    languagePair?: string;
    style?: string;
    split?: boolean;
    splitSize?: number;
    subagent?: boolean;
    subagentCount?: number;
    workDescription?: string;
    translateOutputDir?: string;
    proofreadOutputDir?: string;
    proofreadMode?: WorkshopProofreadMode;
    candidateRatio?: number;
    montecarloSize?: number;
    montecarloRoundMin?: number;
    montecarloRoundMax?: number;
  };
};

type WorkshopSkillInstallDetails = {
  repoRoot: string;
  command: string;
  args: string[];
};

type WorkshopAgentInstallCheck = {
  agent: "codex" | "claude";
  cliFound: boolean;
  cliPath: string;
  skillsFound: boolean;
  installedSkillPaths: string[];
  missingSkillPaths: string[];
};

type WorkshopSkillInstallStatus = {
  selectedAgent: "codex" | "claude";
  home: string;
  anyCliFound: boolean;
  selected: WorkshopAgentInstallCheck;
  agents: {
    codex: WorkshopAgentInstallCheck;
    claude: WorkshopAgentInstallCheck;
  };
};

type WorkshopAgentConsoleApi = {
  startAgentConsole: (args: { agent?: "codex" | "claude"; outputDir?: string; cols?: number; rows?: number }) => Promise<WorkshopAgentConsoleResult>;
  sendAgentConsoleInput: (data: string) => Promise<{ ok: boolean; message?: string }>;
  writeAgentConsoleInput: (data: string) => Promise<{ ok: boolean; message?: string }>;
  clearAgentConsoleOutput: () => Promise<{ ok: boolean; message?: string }>;
  resizeAgentConsole: (args: { cols?: number; rows?: number }) => Promise<{ ok: boolean; message?: string }>;
  stopAgentConsole: () => Promise<{ ok: boolean; message?: string }>;
  agentConsoleStatus: () => Promise<WorkshopAgentConsoleStatus>;
  onAgentConsoleData: (callback: (payload: WorkshopAgentConsoleData) => void) => () => void;
  onAgentConsoleExit: (callback: (payload: WorkshopAgentConsoleExit) => void) => () => void;
};

declare global {
  interface Window {
    workshop: WorkshopAgentConsoleApi & {
      openFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | undefined>;
      openFileOrFolder: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | undefined>;
      openFolder: () => Promise<string | undefined>;
      loadProject: (outputDir?: string) => Promise<unknown>;
      saveProject: (outputDir: string, state: unknown) => Promise<boolean>;
      buildPrompt: (args: WorkshopPromptBuildArgs) => Promise<string>;
      generateLineReview: (args: unknown) => Promise<{ outputPath: string; fileCount?: number; matchedCount?: number; warningCount?: number }>;
      generateProposalReview: (args: unknown) => Promise<{ outputPath: string; proposalCount: number; reportPath?: string }>;
      findProofreadReport: (outputDir: string) => Promise<Array<{ path: string; size: number; modifiedMs: number; score: number; reasons: string[] }>>;
      scanTranslations: (outputDir: string) => Promise<Array<{ path: string; size: number; modifiedAt: string }>>;
      copyText: (text: string) => Promise<boolean>;
      openPath: (targetPath: string) => Promise<string>;
      skillInstallCommand: (args: { agent?: WorkshopSkillInstallAgent }) => Promise<WorkshopSkillInstallDetails>;
      skillInstallStatus: (args: { agent?: WorkshopSkillInstallAgent }) => Promise<WorkshopSkillInstallStatus>;
    };
    workshopHtml?: WorkshopAgentConsoleApi & {
      readTextFile: (args: { path: string }) => Promise<{ ok: boolean; path: string; text: string }>;
      writeTextFile: (args: { path: string; text: string; outputDir?: string }) => Promise<{ ok: boolean; path: string; backupPath?: string }>;
      writeGlossaryFile: (args: { path: string; text: string; outputDir?: string }) => Promise<{ ok: boolean; path: string; backupPath?: string }>;
      writeAuditWhitelistFile: (args: { outputDir?: string; sourcePath?: string; lines?: number[] }) => Promise<{ ok: boolean; path: string; backupPath?: string; lineCount: number }>;
      writeEpubFile: (args: { templatePath: string; lines: string[]; outputDir?: string; mode?: "all" | "pair-position"; replacePosition?: number; pairSize?: number }) => Promise<{ ok: boolean; path: string; changedDocuments: number }>;
      generateProposalReview: (args: unknown) => Promise<{ outputPath: string; proposalCount: number; reportPath?: string }>;
      buildPrompt: (args: WorkshopPromptBuildArgs) => Promise<string>;
      applyLineReviewState: (args: { lineReviewPath?: string; lineState?: unknown; line?: number }) => Promise<{ ok: boolean }>;
      findProofreadReport: (outputDir: string) => Promise<Array<{ path: string; size: number; modifiedMs: number; score: number; reasons: string[] }>>;
      openPath: (targetPath: string) => Promise<string>;
      skillInstallCommand: (args: { agent?: WorkshopSkillInstallAgent }) => Promise<WorkshopSkillInstallDetails>;
      skillInstallStatus: (args: { agent?: WorkshopSkillInstallAgent }) => Promise<WorkshopSkillInstallStatus>;
    };
    workshopTabs?: {
      activate: (key: string) => Promise<boolean>;
    };
  }
}
