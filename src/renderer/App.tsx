import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { Clipboard, ExternalLink, FileSearch, FileText, FolderOpen, Languages, Minus, RefreshCw, Send, ShieldCheck, Square, Terminal as TerminalIcon, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { buildPrompt, skillPaths, type AgentType } from "../shared/core/prompts.ts";
import enUS from "../shared/i18n/en-US.json";
import zhCN from "../shared/i18n/zh-CN.json";
import appIcon from "./assets/app-icon.png";
import companionFull from "./assets/companion-full.png";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";

type Locale = "zh-CN" | "en-US";
type FileType = "auto" | "txt" | "epub";
type InputMode = "separate" | "bilingual";
type AgentTaskKind = "translate" | "proofread" | "generic";
type ProofreadMode = "split" | "montecarlo";
type AgentConsolePhase = "stopped" | "running" | "waiting" | "streaming" | "quiet";

interface AgentInstallCheck {
  agent: AgentType;
  cliFound: boolean;
  cliPath: string;
  skillsFound: boolean;
  installedSkillPaths: string[];
  missingSkillPaths: string[];
}

interface SkillInstallStatus {
  selectedAgent: AgentType;
  home: string;
  anyCliFound: boolean;
  selected: AgentInstallCheck;
  agents: Record<AgentType, AgentInstallCheck>;
}

interface FormState {
  agent: AgentType;
  locale: Locale;
  inputMode: InputMode;
  sourcePath: string;
  translationPath: string;
  outputDir: string;
  glossaryPath: string;
  fileType: FileType;
  pageSize: number;
  startPage: string;
  languagePair: string;
  style: string;
  translateOutputDir: string;
  proofreadOutputDir: string;
  split: boolean;
  splitSize: number;
  subagent: boolean;
  subagentCount: number;
  proofreadMode: ProofreadMode;
  candidateRatio: number;
  montecarloSize: number;
  montecarloRoundMin: number;
  montecarloRoundMax: number;
  reviewMode: string;
  translationType: string;
  workDescription: string;
  reportPath: string;
  sourcePosition: number;
  translationPosition: number;
}

type LoadedProjectState = Partial<FormState> & {
  lastHtml?: string;
  lastOutput?: string;
  lastLineReviewHtml?: string;
  lineReviewPath?: string;
  lastProposalReviewHtml?: string;
  sourceColumn?: number;
  translationColumn?: number;
};

const dictionaries = { "zh-CN": zhCN, "en-US": enUS };
const sourceFileFilters = [
  { name: "All source files", extensions: ["txt", "epub"] },
  { name: "EPUB books", extensions: ["epub"] },
  { name: "Text files", extensions: ["txt"] },
  { name: "All files", extensions: ["*"] }
];
const documentFileFilters = [
  { name: "All supported documents", extensions: ["txt", "md", "json", "epub"] },
  { name: "EPUB books", extensions: ["epub"] },
  { name: "Markdown reports", extensions: ["md"] },
  { name: "JSON glossary", extensions: ["json"] },
  { name: "Text files", extensions: ["txt"] },
  { name: "All files", extensions: ["*"] }
];
const glossaryFileFilters = [
  { name: "Glossary files", extensions: ["json", "tsv", "txt", "csv", "md"] },
  { name: "JSON glossary", extensions: ["json"] },
  { name: "TSV glossary", extensions: ["tsv"] },
  { name: "Text glossary", extensions: ["txt", "csv", "md"] },
  { name: "All files", extensions: ["*"] }
];

function App() {
  const [form, setForm] = useState<FormState>({
    agent: "codex",
    locale: "zh-CN",
    inputMode: "separate",
    sourcePath: "",
    translationPath: "",
    outputDir: "",
    glossaryPath: "",
    fileType: "auto",
    pageSize: 1000,
    startPage: "",
    languagePair: "ja->zh-CN",
    style: "game",
    translateOutputDir: "",
    proofreadOutputDir: "",
    split: true,
    splitSize: 2000,
    subagent: false,
    subagentCount: 3,
    proofreadMode: "split",
    candidateRatio: 1.5,
    montecarloSize: 3000,
    montecarloRoundMin: 2,
    montecarloRoundMax: 5,
    reviewMode: "split 1000",
    translationType: "game",
    workDescription: "",
    reportPath: "",
    sourcePosition: 2,
    translationPosition: 1
  });
  const [prompt, setPrompt] = useState("");
  const [promptKind, setPromptKind] = useState<AgentTaskKind>("translate");
  const [status, setStatus] = useState("");
  const [lastOutput, setLastOutput] = useState("");
  const [candidates, setCandidates] = useState<Array<{ path: string; size: number; modifiedAt: string }>>([]);
  const [reportCandidates, setReportCandidates] = useState<Array<{ path: string; size: number; modifiedMs: number; score: number; reasons: string[] }>>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [callAgentPanelOpen, setCallAgentPanelOpen] = useState(false);
  const [activeAgentPrompt, setActiveAgentPrompt] = useState("");
  const [agentConsoleRunning, setAgentConsoleRunning] = useState(false);
  const [agentConsolePhase, setAgentConsolePhase] = useState<AgentConsolePhase>("stopped");
  const [skillInstallCommand, setSkillInstallCommand] = useState("");
  const [skillInstallStatus, setSkillInstallStatus] = useState<SkillInstallStatus | undefined>();

  const t = dictionaries[form.locale];
  const agentSetup = useMemo(() => skillPaths[form.agent], [form.agent]);
  const bilingualPositionMode = form.inputMode === "bilingual";
  const agentTerminalElement = useRef<HTMLDivElement | null>(null);
  const agentTerminal = useRef<XTerm | undefined>(undefined);
  const agentTerminalFit = useRef<FitAddon | undefined>(undefined);
  const agentTerminalResizeObserver = useRef<ResizeObserver | undefined>(undefined);
  const agentConsoleAgent = useRef<AgentType>("codex");
  const agentConsoleSessionId = useRef("");
  const agentConsoleQuietTimer = useRef<number | undefined>(undefined);
  const lastLineReviewHtml = useRef("");
  const lastProposalReviewHtml = useRef("");
  const hydratingProject = useRef(false);
  const autoSaveTimer = useRef<number | undefined>(undefined);

  function fitAgentTerminal() {
    const terminal = agentTerminal.current;
    if (!terminal) {
      return;
    }
    try {
      agentTerminalFit.current?.fit();
      void window.workshop.resizeAgentConsole({ cols: terminal.cols, rows: terminal.rows });
    } catch {
      // The terminal can briefly have no measured cell size while the panel mounts.
    }
  }

  function writeAgentTerminal(data: string) {
    agentTerminal.current?.write(data);
  }

  function resetAgentTerminal() {
    agentTerminal.current?.reset();
    agentTerminal.current?.clear();
  }

  function markAgentConsoleStreaming() {
    setAgentConsolePhase("streaming");
    if (agentConsoleQuietTimer.current) {
      window.clearTimeout(agentConsoleQuietTimer.current);
    }
    agentConsoleQuietTimer.current = window.setTimeout(() => {
      setAgentConsolePhase((phase) => phase === "streaming" || phase === "waiting" ? "quiet" : phase);
    }, 2200);
  }

  function resetAgentConsoleTranscript() {
    resetAgentTerminal();
    void window.workshop.clearAgentConsoleOutput();
  }

  useEffect(() => {
    let stopped = false;
    async function refreshSkillSetup() {
      try {
        const [details, installStatus] = await Promise.all([
          window.workshop.skillInstallCommand({ agent: form.agent }),
          window.workshop.skillInstallStatus({ agent: form.agent })
        ]);
        if (!stopped) {
          setSkillInstallCommand(details.githubCommand || details.command);
          setSkillInstallStatus(installStatus);
        }
      } catch {
        if (!stopped) {
          setSkillInstallCommand("");
          setSkillInstallStatus(undefined);
        }
      }
    }
    void refreshSkillSetup();
    return () => {
      stopped = true;
    };
  }, [form.agent]);

  useEffect(() => {
    if (!agentTerminalElement.current || agentTerminal.current) {
      return undefined;
    }
    const terminal = new XTerm({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 8000,
      theme: {
        background: "#071523",
        foreground: "#dbeafe",
        cursor: "#ffffff",
        selectionBackground: "#355c7d"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(agentTerminalElement.current);
    terminal.onData((data) => {
      void window.workshop.writeAgentConsoleInput(data);
    });
    agentTerminal.current = terminal;
    agentTerminalFit.current = fitAddon;
    agentTerminalResizeObserver.current = new ResizeObserver(() => fitAgentTerminal());
    agentTerminalResizeObserver.current.observe(agentTerminalElement.current);
    window.requestAnimationFrame(() => {
      fitAgentTerminal();
      terminal.focus();
      void window.workshop.agentConsoleStatus().then((snapshot) => {
        setAgentConsoleRunning(Boolean(snapshot.running));
        if (snapshot.agent) {
          agentConsoleAgent.current = snapshot.agent;
        }
        if (snapshot.id) {
          agentConsoleSessionId.current = snapshot.id;
        }
        if (snapshot.output) {
          terminal.reset();
          terminal.write(snapshot.output);
        }
        setAgentConsolePhase(snapshot.running ? "running" : "stopped");
      }).catch(() => undefined);
    });
    return () => {
      agentTerminalResizeObserver.current?.disconnect();
      agentTerminalResizeObserver.current = undefined;
      agentTerminalFit.current = undefined;
      agentTerminal.current = undefined;
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    const stopData = window.workshop.onAgentConsoleData((payload) => {
      setAgentConsoleRunning(true);
      markAgentConsoleStreaming();
      if (payload.id && payload.id !== agentConsoleSessionId.current) {
        agentConsoleSessionId.current = payload.id;
        resetAgentTerminal();
      }
      writeAgentTerminal(payload.data);
    });
    const stopExit = window.workshop.onAgentConsoleExit((payload) => {
      setAgentConsoleRunning(false);
      setAgentConsolePhase("stopped");
      setStatus(`${t.agentConsoleStopped} (${payload.exitCode ?? "?"})`);
    });
    void window.workshop.agentConsoleStatus().then((snapshot) => {
      setAgentConsoleRunning(Boolean(snapshot.running));
      if (snapshot.agent) {
        agentConsoleAgent.current = snapshot.agent;
      }
      if (snapshot.id && snapshot.id !== agentConsoleSessionId.current) {
        agentConsoleSessionId.current = snapshot.id;
        resetAgentTerminal();
      }
      if (snapshot.output) {
        resetAgentTerminal();
        writeAgentTerminal(snapshot.output);
      }
      setAgentConsolePhase(snapshot.running ? "running" : "stopped");
    }).catch(() => undefined);
    return () => {
      if (agentConsoleQuietTimer.current) {
        window.clearTimeout(agentConsoleQuietTimer.current);
      }
      stopData();
      stopExit();
    };
  }, [t]);

  useEffect(() => {
    if (!form.outputDir || hydratingProject.current) {
      return undefined;
    }
    if (autoSaveTimer.current) {
      window.clearTimeout(autoSaveTimer.current);
    }
    autoSaveTimer.current = window.setTimeout(() => {
      void saveProject();
    }, 600);
    return () => {
      if (autoSaveTimer.current) {
        window.clearTimeout(autoSaveTimer.current);
      }
    };
  }, [form]);

  function patch(next: Partial<FormState>) {
    setForm((current) => ({ ...current, ...next }));
  }

  function asLoadedProject(value: unknown): LoadedProjectState | undefined {
    return value && typeof value === "object" ? value as LoadedProjectState : undefined;
  }

  function projectLastHtml(project: LoadedProjectState | undefined): string {
    const lastHtml = project?.lastHtml || project?.lastOutput || "";
    return typeof lastHtml === "string" ? lastHtml : "";
  }

  function joinUiPath(root: string, child: string) {
    const trimmed = root.replace(/[\\/]+$/, "");
    const separator = trimmed.includes("\\") ? "\\" : "/";
    return trimmed ? `${trimmed}${separator}${child}` : child;
  }

  function defaultTranslateOutputDir(outputDir = form.outputDir) {
    return joinUiPath(outputDir, "AI_translation");
  }

  function defaultProofreadOutputDir(outputDir = form.outputDir) {
    return joinUiPath(outputDir, "report");
  }

  async function loadProjectState(outputDir: string, openLastHtml: boolean) {
    const loaded = asLoadedProject(await window.workshop.loadProject(outputDir));
    if (!loaded) {
      hydratingProject.current = true;
      patch({ outputDir });
      window.setTimeout(() => {
        hydratingProject.current = false;
      }, 0);
      setLastOutput("");
      lastLineReviewHtml.current = "";
      lastProposalReviewHtml.current = "";
      setStatus(t.projectOpenedNoHtml);
      return;
    }
    const lastHtml = projectLastHtml(loaded);
    lastLineReviewHtml.current = loaded.lastLineReviewHtml || loaded.lineReviewPath || "";
    lastProposalReviewHtml.current = loaded.lastProposalReviewHtml || "";
    const projectOutputDir = typeof loaded.outputDir === "string" && loaded.outputDir ? loaded.outputDir : outputDir;
    hydratingProject.current = true;
    setForm((current) => ({
      ...current,
      agent: loaded.agent ?? current.agent,
      locale: loaded.locale ?? current.locale,
      inputMode: loaded.inputMode ?? current.inputMode,
      sourcePath: loaded.sourcePath ?? current.sourcePath,
      translationPath: loaded.translationPath ?? current.translationPath,
      outputDir: projectOutputDir,
      glossaryPath: loaded.glossaryPath ?? current.glossaryPath,
      fileType: loaded.fileType ?? current.fileType,
      pageSize: loaded.pageSize ?? current.pageSize,
      startPage: loaded.startPage ?? current.startPage,
      languagePair: loaded.languagePair ?? current.languagePair,
      style: loaded.style ?? current.style,
      translateOutputDir: loaded.translateOutputDir ?? current.translateOutputDir,
      proofreadOutputDir: loaded.proofreadOutputDir ?? current.proofreadOutputDir,
      split: loaded.split ?? current.split,
      splitSize: loaded.splitSize ?? current.splitSize,
      subagent: loaded.subagent ?? current.subagent,
      subagentCount: loaded.subagentCount ?? current.subagentCount,
      proofreadMode: loaded.proofreadMode ?? current.proofreadMode,
      candidateRatio: loaded.candidateRatio ?? current.candidateRatio,
      montecarloSize: loaded.montecarloSize ?? current.montecarloSize,
      montecarloRoundMin: loaded.montecarloRoundMin ?? current.montecarloRoundMin,
      montecarloRoundMax: loaded.montecarloRoundMax ?? current.montecarloRoundMax,
      reviewMode: loaded.reviewMode ?? current.reviewMode,
      translationType: loaded.translationType ?? current.translationType,
      workDescription: loaded.workDescription ?? current.workDescription,
      reportPath: loaded.reportPath ?? current.reportPath,
      sourcePosition: loaded.sourcePosition ?? loaded.sourceColumn ?? current.sourcePosition,
      translationPosition: loaded.translationPosition ?? loaded.translationColumn ?? current.translationPosition
    }));
    window.setTimeout(() => {
      hydratingProject.current = false;
    }, 0);
    setLastOutput(lastHtml);
    setStatus(lastHtml ? t.projectOpened : t.projectOpenedNoHtml);
    if (openLastHtml && lastHtml) {
      await window.workshop.openPath(lastHtml);
    }
  }

  async function openProject() {
    const selected = await window.workshop.openFolder();
    if (selected) {
      await loadProjectState(selected, true);
    }
  }

  async function openExistingHtml() {
    const selected = await window.workshop.openFile([
      { name: "HTML", extensions: ["html", "htm"] },
      { name: "All files", extensions: ["*"] }
    ]);
    if (!selected) {
      return;
    }
    setLastOutput(selected);
    setStatus(t.htmlOpened);
    await window.workshop.openPath(selected);
  }

  async function openReviewHtml() {
    const selected = await window.workshop.openFile([
      { name: "Review HTML", extensions: ["html", "htm"] },
      { name: "All files", extensions: ["*"] }
    ]);
    if (!selected) {
      return;
    }
    setLastOutput(selected);
    setStatus(t.reviewHtmlOpened ?? t.htmlOpened);
    await saveProject(selected, "proposal");
    await window.workshop.openReviewHtml({ htmlPath: selected, outputDir: form.outputDir || undefined });
  }

  async function pickFile(key: keyof Pick<FormState, "sourcePath" | "translationPath" | "glossaryPath" | "reportPath">) {
    const filters = key === "glossaryPath" ? glossaryFileFilters : documentFileFilters;
    const selected = await window.workshop.openFile(filters);
    if (selected) {
      patch({ [key]: selected } as Partial<FormState>);
    }
  }

  async function pickSourceFile(key: keyof Pick<FormState, "sourcePath" | "translationPath">) {
    const selected = await window.workshop.openFile(sourceFileFilters);
    if (selected) {
      const lower = selected.toLowerCase();
      patch({
        [key]: selected,
        fileType: lower.endsWith(".epub") ? "epub" : lower.endsWith(".txt") ? "txt" : form.fileType,
        sourcePosition: form.inputMode === "bilingual" ? 2 : form.sourcePosition,
        translationPosition: form.inputMode === "bilingual" ? 1 : form.translationPosition
      } as Partial<FormState>);
    }
  }

  async function pickSourceFolder(key: keyof Pick<FormState, "sourcePath" | "translationPath">) {
    const selected = await window.workshop.openFolder();
    if (selected) {
      patch({ [key]: selected, fileType: "auto" } as Partial<FormState>);
    }
  }

  async function pickOutput() {
    const selected = await window.workshop.openFolder();
    if (selected) {
      await loadProjectState(selected, false);
    }
  }

  function promptAdvanced() {
    return {
      languagePair: form.languagePair,
      style: form.style,
      translateOutputDir: form.translateOutputDir || defaultTranslateOutputDir(),
      proofreadOutputDir: form.proofreadOutputDir || defaultProofreadOutputDir(),
      split: form.split,
      splitSize: form.splitSize,
      subagent: form.subagent,
      subagentCount: form.subagentCount,
      proofreadMode: form.proofreadMode,
      candidateRatio: form.candidateRatio,
      montecarloSize: form.montecarloSize,
      montecarloRoundMin: form.montecarloRoundMin,
      montecarloRoundMax: form.montecarloRoundMax,
      workDescription: form.workDescription,
      reviewMode: form.reviewMode,
      translationType: form.translationType
    };
  }

  function buildDefaultAgentPrompt(kind: AgentTaskKind = promptKind) {
    return buildPrompt({
      kind: kind === "proofread" ? "proofread" : "translate",
      agent: form.agent,
      sourcePath: form.sourcePath,
      translationPath: form.translationPath || undefined,
      outputDir: form.outputDir,
      glossaryPath: form.glossaryPath || undefined,
      inputMode: form.inputMode,
      advanced: promptAdvanced()
    });
  }

  function ensureActiveAgentPrompt(kind: AgentTaskKind = promptKind) {
    const activePrompt = activeAgentPrompt || prompt || buildDefaultAgentPrompt(kind);
    if (!prompt) {
      setPrompt(activePrompt);
    }
    setActiveAgentPrompt(activePrompt);
    return activePrompt;
  }

  function setBilingualFileType(fileType: FileType) {
    patch({
      fileType,
      sourcePosition: form.inputMode === "bilingual" ? 2 : form.sourcePosition,
      translationPosition: form.inputMode === "bilingual" ? 1 : form.translationPosition
    });
  }

  function setSourcePosition(value: number) {
    const sourcePosition = value === 1 ? 1 : 2;
    patch({
      sourcePosition,
      translationPosition: form.translationPosition === sourcePosition ? (sourcePosition === 1 ? 2 : 1) : form.translationPosition
    });
  }

  function setTranslationPosition(value: number) {
    const translationPosition = value === 1 ? 1 : 2;
    patch({
      sourcePosition: form.sourcePosition === translationPosition ? (translationPosition === 1 ? 2 : 1) : form.sourcePosition,
      translationPosition
    });
  }

  async function saveProject(nextLastOutput = lastOutput, outputKind?: "line" | "proposal") {
    if (!form.outputDir) {
      return;
    }
    if (outputKind === "line") {
      lastLineReviewHtml.current = nextLastOutput;
    }
    if (outputKind === "proposal") {
      lastProposalReviewHtml.current = nextLastOutput;
    }
    await window.workshop.saveProject(form.outputDir, {
      ...form,
      lastHtml: nextLastOutput,
      lastOutput: nextLastOutput,
      ...(lastLineReviewHtml.current ? { lastLineReviewHtml: lastLineReviewHtml.current, lineReviewPath: lastLineReviewHtml.current } : {}),
      ...(lastProposalReviewHtml.current ? { lastProposalReviewHtml: lastProposalReviewHtml.current } : {}),
      updatedAt: new Date().toISOString()
    });
  }

  async function generateLineHtml() {
    if (!form.sourcePath || !form.outputDir) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    try {
      const sourcePosition = bilingualPositionMode ? (form.sourcePosition === 1 ? 1 : 2) : form.sourcePosition;
      const translationPosition = bilingualPositionMode
        ? (form.translationPosition === sourcePosition ? (sourcePosition === 1 ? 2 : 1) : (form.translationPosition === 2 ? 2 : 1))
        : form.translationPosition;
      const result = await window.workshop.generateLineReview({
        sourcePath: form.sourcePath,
        translationPath: form.translationPath || undefined,
        outputDir: form.outputDir,
        glossaryPath: form.glossaryPath || undefined,
        fileType: form.fileType,
        pageSize: form.pageSize,
        startPage: form.startPage ? Number(form.startPage) : undefined,
        locale: form.locale,
        inputMode: form.inputMode,
        sourcePosition,
        translationPosition,
        advanced: promptAdvanced()
      });
      setLastOutput(result.outputPath);
      if (result.fileCount) {
        setStatus(`${t.batchHtmlGenerated} ${result.matchedCount ?? 0}/${result.fileCount} ${t.batchMatched}, ${result.warningCount ?? 0} ${t.batchWarnings}`);
      } else {
        setStatus(t.htmlGenerated);
      }
      await saveProject(result.outputPath, "line");
      await window.workshop.openPath(result.outputPath);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  function generateTranslatePrompt() {
    const next = buildDefaultAgentPrompt("translate");
    setPromptKind("translate");
    setPrompt(next);
    setActiveAgentPrompt(next);
  }

  function generateProofreadPrompt() {
    if (!form.sourcePath || !form.translationPath) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    const next = buildDefaultAgentPrompt("proofread");
    setPromptKind("proofread");
    setPrompt(next);
    setActiveAgentPrompt(next);
  }

  async function copyPrompt() {
    await window.workshop.copyText(activeAgentPrompt || prompt);
    setStatus(t.copied);
  }

  async function copySkillInstallCommand() {
    const details = await window.workshop.skillInstallCommand({ agent: form.agent });
    const command = details.githubCommand || details.command;
    setSkillInstallCommand(command);
    await window.workshop.copyText(command);
    setStatus(t.copied);
  }

  function skillSetupMessage() {
    const selected = skillInstallStatus?.selected;
    if (!selected) {
      return "";
    }
    if (selected.cliFound && selected.skillsFound) {
      return form.agent === "codex"
        ? (t.skillStatusCodexReady ?? "Codex CLI was detected; Codex skills are installed.")
        : (t.skillStatusClaudeReady ?? "Claude Code CLI was detected; Claude commands are installed.");
    }
    const details = [
      !selected.cliFound
        ? form.agent === "codex"
          ? (t.skillCodexCliMissing ?? "Codex CLI was not detected.")
          : (t.skillClaudeCliMissing ?? "Claude Code CLI was not detected.")
        : "",
      !selected.skillsFound
        ? `${form.agent === "codex"
          ? (t.skillCodexFilesMissing ?? "Codex skills are not fully installed:")
          : (t.skillClaudeFilesMissing ?? "Claude commands are not fully installed:")} ${selected.missingSkillPaths.join(", ")}`
        : ""
    ].filter(Boolean);
    return `${details.join(" ")} ${t.skillOnlyOneAgentNote ?? "You only need to install and select the one Agent you plan to use."}`.trim();
  }

  function skillLayoutMessage() {
    return form.agent === "codex"
      ? (t.skillLayoutCodex ?? "Codex uses directory skills: each skill is a ~/.codex/skills/<name>/ folder with SKILL.md as the entry file.")
      : (t.skillLayoutClaude ?? "Claude Code uses slash commands: each command is a ~/.claude/commands/<name>.md file.");
  }

  function openCallAgentPanel() {
    setCallAgentPanelOpen(true);
    setActiveAgentPrompt(ensureActiveAgentPrompt());
    window.requestAnimationFrame(() => {
      fitAgentTerminal();
      agentTerminal.current?.focus();
    });
  }

  async function startAgentConsole() {
    if (!form.outputDir) {
      setStatus(t.agentConsoleNeedsOutput);
      return false;
    }
    const wasRunning = agentConsoleRunning;
    setCallAgentPanelOpen(true);
    agentConsoleAgent.current = form.agent;
    window.requestAnimationFrame(() => fitAgentTerminal());
    const result = await window.workshop.startAgentConsole({
      agent: form.agent,
      outputDir: form.outputDir,
      cols: agentTerminal.current?.cols ?? 120,
      rows: agentTerminal.current?.rows ?? 32
    });
    if (result.ok) {
      if (result.status?.id && result.status.id !== agentConsoleSessionId.current) {
        agentConsoleSessionId.current = result.status.id;
        resetAgentConsoleTranscript();
      }
      agentConsoleAgent.current = result.status?.agent ?? form.agent;
      setAgentConsoleRunning(Boolean(result.status?.running ?? true));
      setAgentConsolePhase("running");
      setStatus(result.message || t.agentConsoleStarted);
      if (!wasRunning) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
      }
      return true;
    }
    setStatus(result.message || t.agentUnavailable);
    return false;
  }

  async function sendInteractiveAgentMessage() {
    const message = ensureActiveAgentPrompt();
    if (!message.trim()) {
      return;
    }
    const started = await startAgentConsole();
    if (!started) {
      return;
    }
    setAgentConsolePhase("waiting");
    setActiveAgentPrompt("");
    setPrompt("");
    const result = await window.workshop.sendAgentConsoleInput(message);
    if (!result.ok) {
      setActiveAgentPrompt(message);
      setPrompt(message);
      setStatus(result.message || t.agentUnavailable);
      return;
    }
    setStatus(result.ok
      ? result.promptPath
        ? `${t.promptSentViaFile} ${result.promptPath}`
        : t.promptSentToAgent
      : (result.message || t.agentUnavailable));
  }

  async function stopAgentConsole() {
    await window.workshop.stopAgentConsole();
    setAgentConsoleRunning(false);
    setAgentConsolePhase("stopped");
    setStatus(t.agentConsoleStopped);
  }

  function clearAgentConsole() {
    resetAgentConsoleTranscript();
  }

  function agentConsolePhaseLabel() {
    if (!agentConsoleRunning && agentConsolePhase === "stopped") {
      return t.agentConsoleStopped;
    }
    if (agentConsolePhase === "waiting") {
      return t.agentConsoleWaiting ?? "等待 Agent 回复…";
    }
    if (agentConsolePhase === "streaming") {
      return t.agentConsoleStreaming ?? "Agent 输出中…";
    }
    if (agentConsolePhase === "quiet") {
      return t.agentConsoleQuiet ?? "输出已静默，可能已完成。";
    }
    return t.agentConsoleRunning ?? "控制台运行中";
  }

  async function syncTranslations() {
    if (!form.outputDir) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    const found = await window.workshop.scanTranslations(form.outputDir);
    setCandidates(found);
    setStatus(found.length ? t.candidateTranslations : t.noCandidates);
  }

  async function findProofreadReport() {
    if (!form.outputDir) {
      setStatus(t.requiredReviewReport);
      return "";
    }
    const found = await window.workshop.findProofreadReport(form.outputDir);
    setReportCandidates(found);
    if (found[0]) {
      patch({ reportPath: found[0].path });
      setStatus(`${t.reportFound} ${found[0].path}`);
      return found[0].path;
    }
    setStatus(t.noReports);
    return "";
  }

  async function generateReviewHtml(preferredReportPath?: string) {
    if (!form.outputDir) {
      setStatus(t.requiredReviewReport);
      return;
    }
    const reportPath = preferredReportPath || form.reportPath || await findProofreadReport();
    if (!reportPath) {
      return;
    }
    try {
      const result = await window.workshop.generateProposalReview({
        reportPath,
        outputDir: form.outputDir,
        pageSize: form.pageSize,
        startPage: form.startPage ? Number(form.startPage) : undefined,
        locale: form.locale
      });
      if (result.reportPath) {
        patch({ reportPath: result.reportPath });
      }
      if (result.lineReviewPath) {
        lastLineReviewHtml.current = result.lineReviewPath;
      }
      if (result.fallbackPrompt) {
        setPromptKind("proofread");
        setPrompt(result.fallbackPrompt);
        setActiveAgentPrompt(result.fallbackPrompt);
        setCallAgentPanelOpen(true);
        if (result.reportPath) {
          patch({ reportPath: result.reportPath });
        }
        setStatus(t.reviewFormatFallback ?? "AI report failed format validation. A repair prompt was generated.");
        return;
      }
      if (!result.outputPath) {
        setStatus("Review HTML generation failed.");
        return;
      }
      setLastOutput(result.outputPath);
      setStatus(`${t.reviewGenerated} (${result.proposalCount})`);
      await saveProject(result.outputPath, "proposal");
      await window.workshop.openPath(result.outputPath);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="shell">
      <section className="topbar">
        <div className="brandBlock">
          <img className="brandIcon" src={appIcon} alt="" aria-hidden="true" />
          <div>
            <h1>{t.appTitle}</h1>
            <p>{t.appSubtitle}</p>
          </div>
        </div>
        <div className="topActions">
          <IconButton icon={<TerminalIcon size={18} />} label={t.callAgent} onClick={openCallAgentPanel} primary={callAgentPanelOpen || agentConsoleRunning} />
          {agentConsoleRunning && (
            <span className={agentConsolePhase === "streaming" || agentConsolePhase === "waiting" ? "consoleLive topConsoleStatus" : "consoleIdle topConsoleStatus"}>
              {agentConsolePhaseLabel()}
            </span>
          )}
          <IconButton icon={<FolderOpen size={18} />} label={t.openProject} onClick={openProject} />
          <IconButton icon={<ExternalLink size={18} />} label={t.openHtml} onClick={openExistingHtml} />
          <div className="segmented">
            <button className={form.locale === "zh-CN" ? "active" : ""} onClick={() => patch({ locale: "zh-CN" })}>
              中文
            </button>
            <button className={form.locale === "en-US" ? "active" : ""} onClick={() => patch({ locale: "en-US" })}>
              English
            </button>
          </div>
        </div>
      </section>

      <section className="workspace">
        <aside className="panel">
          <div className="field">
            <label>{t.agent}</label>
            <div className="segmented full">
              <button className={form.agent === "codex" ? "active" : ""} onClick={() => patch({ agent: "codex" })}>
                {t.codex}
              </button>
              <button className={form.agent === "claude" ? "active" : ""} onClick={() => patch({ agent: "claude" })}>
                {t.claude}
              </button>
            </div>
          </div>

          <div className="setup">
            <strong>{t.setup}</strong>
            <span>{agentSetup.displayName}</span>
            <span>{t.bundledSkills ?? "内置 skills"}</span>
            <span>{skillLayoutMessage()}</span>
            {skillSetupMessage() && (
              <span className={skillInstallStatus?.selected.cliFound && skillInstallStatus.selected.skillsFound ? "setupOk" : "setupWarning"}>
                {skillSetupMessage()}
              </span>
            )}
            <code>{agentSetup.translate}</code>
            <code>{agentSetup.proofread}</code>
            <code>{agentSetup.installTarget}</code>
            <span>{t.installCommand ?? "本地 Node 安装命令"}</span>
            <code>{skillInstallCommand}</code>
            <div className="inlineActions">
              <button type="button" onClick={copySkillInstallCommand}>{t.copyInstallCommand ?? "复制安装命令"}</button>
            </div>
          </div>

          <PathField label={t.sourcePath} value={form.sourcePath} onChange={(value) => patch({ sourcePath: value })} onPickFile={() => pickSourceFile("sourcePath")} onPickFolder={() => pickSourceFolder("sourcePath")} buttonFileText={t.selectFile} buttonFolderText={t.selectFolder} />
          {form.inputMode === "separate" && (
            <PathField label={`${t.translationPath} (${t.optional})`} value={form.translationPath} onChange={(value) => patch({ translationPath: value })} onPickFile={() => pickSourceFile("translationPath")} onPickFolder={() => pickSourceFolder("translationPath")} buttonFileText={t.selectFile} buttonFolderText={t.selectFolder} />
          )}
          <Field label={t.outputDir} value={form.outputDir} onChange={(value) => patch({ outputDir: value })} onPick={pickOutput} buttonText={t.select} folder />
          <Field label={`${t.glossaryPath} (${t.optional})`} value={form.glossaryPath} onChange={(value) => patch({ glossaryPath: value })} onPick={() => pickFile("glossaryPath")} buttonText={t.select} />

          <div className="grid2">
            <label className="field">
              <span>{t.inputMode}</span>
              <select value={form.inputMode} onChange={(event) => patch({ inputMode: event.target.value as InputMode })}>
                <option value="separate">{t.separateFiles}</option>
                <option value="bilingual">{t.bilingualFile}</option>
              </select>
            </label>
            <label className="field">
              <span>{t.fileType}</span>
              <select value={form.fileType} onChange={(event) => setBilingualFileType(event.target.value as FileType)}>
                <option value="auto">auto</option>
                <option value="txt">txt</option>
                <option value="epub">epub</option>
              </select>
            </label>
            <label className="field">
              <span>{t.pageSize}</span>
              <input type="number" min={1} value={form.pageSize} onChange={(event) => patch({ pageSize: Number(event.target.value) })} />
            </label>
          </div>
          {form.inputMode === "bilingual" && (
            <div className="grid2">
              <label className="field">
                <span>{t.sourcePosition}</span>
                <select value={Math.min(2, Math.max(1, form.sourcePosition))} onChange={(event) => setSourcePosition(Number(event.target.value))}>
                  <option value={1}>{t.positionFirst}</option>
                  <option value={2}>{t.positionSecond}</option>
                </select>
              </label>
              <label className="field">
                <span>{t.translationPosition}</span>
                <select value={Math.min(2, Math.max(1, form.translationPosition))} onChange={(event) => setTranslationPosition(Number(event.target.value))}>
                  <option value={1}>{t.positionFirst}</option>
                  <option value={2}>{t.positionSecond}</option>
                </select>
              </label>
            </div>
          )}
          <label className="field">
            <span>{t.startPage}</span>
            <input value={form.startPage} onChange={(event) => patch({ startPage: event.target.value })} />
          </label>

          <button className="linkButton" onClick={() => setAdvancedOpen((value) => !value)}>
            {t.advanced}
          </button>
          {advancedOpen && (
            <div className="advanced">
              <strong>{t.sharedPromptParams ?? "Shared prompt parameters"}</strong>
              <label className="field"><span>{t.languagePair}</span><input value={form.languagePair} onChange={(event) => patch({ languagePair: event.target.value })} /></label>
              <label className="field"><span>{t.style}</span><input value={form.style} onChange={(event) => patch({ style: event.target.value })} /></label>
              <label className="field"><span>{t.workDescription}</span><textarea value={form.workDescription} placeholder="None" onChange={(event) => patch({ workDescription: event.target.value })} /></label>

              <strong>{t.translatePromptParams ?? "Translate prompt parameters"}</strong>
              <label className="field"><span>{t.translateOutputDir ?? "Translation output folder"}</span><input value={form.translateOutputDir || defaultTranslateOutputDir()} onChange={(event) => patch({ translateOutputDir: event.target.value })} /></label>
              <label className="field checkboxField">
                <input type="checkbox" checked={form.split} onChange={(event) => patch({ split: event.target.checked })} />
                <span>{t.split ?? "Split"}</span>
              </label>
              {form.split && (
                <label className="field"><span>{t.splitSize ?? "Split size"}</span><input type="number" min={1} value={form.splitSize} onChange={(event) => patch({ splitSize: Number(event.target.value) })} /></label>
              )}

              <strong>{t.proofreadPromptParams ?? "Proofread prompt parameters"}</strong>
              <label className="field"><span>{t.proofreadOutputDir ?? "Report output folder"}</span><input value={form.proofreadOutputDir || defaultProofreadOutputDir()} onChange={(event) => patch({ proofreadOutputDir: event.target.value })} /></label>
              <label className="field">
                <span>{t.proofreadMode ?? "Proofread mode"}</span>
                <select value={form.proofreadMode} onChange={(event) => patch({ proofreadMode: event.target.value as ProofreadMode })}>
                  <option value="split">split</option>
                  <option value="montecarlo">montecarlo</option>
                </select>
              </label>
              <label className="field"><span>{t.candidateRatio ?? "H9 candidate ratio"}</span><input type="number" min={0.1} step={0.1} value={form.candidateRatio} onChange={(event) => patch({ candidateRatio: Number(event.target.value) })} /></label>
              {form.proofreadMode === "montecarlo" ? (
                <>
                  <label className="field"><span>{t.montecarloSize ?? "Monte Carlo sample size"}</span><input type="number" min={1} value={form.montecarloSize} onChange={(event) => patch({ montecarloSize: Number(event.target.value) })} /></label>
                  <label className="field"><span>{t.montecarloRoundMin ?? "Min rounds"}</span><input type="number" min={1} value={form.montecarloRoundMin} onChange={(event) => patch({ montecarloRoundMin: Number(event.target.value) })} /></label>
                  <label className="field"><span>{t.montecarloRoundMax ?? "Max rounds"}</span><input type="number" min={1} value={form.montecarloRoundMax} onChange={(event) => patch({ montecarloRoundMax: Number(event.target.value) })} /></label>
                </>
              ) : (
                <>
                  <label className="field"><span>{t.splitSize ?? "Split size"}</span><input type="number" min={1} value={form.splitSize} onChange={(event) => patch({ splitSize: Number(event.target.value) })} /></label>
                  <label className="field checkboxField">
                    <input type="checkbox" checked={form.subagent} onChange={(event) => patch({ subagent: event.target.checked })} />
                    <span>{t.subagent ?? "Subagent"}</span>
                  </label>
                  {form.subagent && (
                    <label className="field"><span>{t.subagentCount ?? "Subagent count"}</span><input type="number" min={1} value={form.subagentCount} onChange={(event) => patch({ subagentCount: Number(event.target.value) })} /></label>
                  )}
                </>
              )}
            </div>
          )}
        </aside>

        <section className="panel mainPanel">
          <div className="notice">
            <ShieldCheck size={18} />
            <span>{t.sourceImmutable}</span>
          </div>
          <div className="notice muted">
            <Languages size={18} />
            <span>{form.inputMode === "bilingual" || form.translationPath ? t.modeCompare : t.modeTranslateOnly}</span>
          </div>

          <div className="actions">
            <IconButton icon={<FileText size={18} />} label={t.generateLineHtml} onClick={generateLineHtml} primary />
            <IconButton icon={<Languages size={18} />} label={t.generateTranslatePrompt} onClick={generateTranslatePrompt} />
            <IconButton icon={<ShieldCheck size={18} />} label={t.generateProofreadPrompt} onClick={generateProofreadPrompt} />
            <IconButton icon={<Clipboard size={18} />} label={t.copyPrompt} onClick={copyPrompt} disabled={!prompt && !activeAgentPrompt} />
            <IconButton icon={<RefreshCw size={18} />} label={t.syncTranslation} onClick={syncTranslations} />
            <IconButton icon={<ExternalLink size={18} />} label={t.openOutput} onClick={() => form.outputDir && window.workshop.openPath(form.outputDir)} disabled={!form.outputDir} />
          </div>

          <Field label={t.proofreadReport} value={form.reportPath} onChange={(value) => patch({ reportPath: value })} onPick={() => pickFile("reportPath")} buttonText={t.select} />
          <div className="actions compact">
            <IconButton icon={<FileSearch size={18} />} label={t.findProofreadReport} onClick={findProofreadReport} />
            <IconButton icon={<FileText size={18} />} label={t.generateReviewHtml} onClick={() => generateReviewHtml()} primary />
            <IconButton icon={<ExternalLink size={18} />} label={t.openReviewHtml} onClick={openReviewHtml} />
          </div>

          <label className="field promptBox">
            <span>{t.prompt}</span>
            <textarea value={prompt} onChange={(event) => {
              setPrompt(event.target.value);
              setActiveAgentPrompt(event.target.value);
            }} />
          </label>

          <section className="agentConsole agentConsoleFloating" hidden={!callAgentPanelOpen}>
              <header className="agentConsoleHeader">
                <strong>{t.agentTool}</strong>
                <span className={agentConsolePhase === "streaming" || agentConsolePhase === "waiting" ? "consoleLive" : "consoleIdle"}>
                  {agentConsolePhaseLabel()}
                </span>
                <div className="agentConsoleActions">
                  <IconButton icon={<Square size={16} />} label={t.stopAgentConsole} onClick={stopAgentConsole} disabled={!agentConsoleRunning} />
                  <IconButton icon={<Trash2 size={16} />} label={t.clearAgentConsole} onClick={clearAgentConsole} />
                  <IconButton icon={<Minus size={16} />} label={t.collapseAgentWindow} onClick={() => setCallAgentPanelOpen(false)} />
                </div>
              </header>
              <div className="agentConsoleInput">
                <IconButton icon={<TerminalIcon size={16} />} label={t.startInteractiveAgent} onClick={startAgentConsole} />
                <IconButton icon={<Send size={16} />} label={t.sendConsoleInput} onClick={sendInteractiveAgentMessage} />
              </div>
              <div className="agentConsoleOutput" ref={agentTerminalElement} aria-label={t.agentConsole} data-empty={t.agentConsoleEmpty} />
              <label className="field agentPromptInput">
                <span>{t.agentPromptInput}</span>
                <textarea
                  value={activeAgentPrompt}
                  placeholder={t.agentConsoleInput}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendInteractiveAgentMessage();
                    }
                  }}
                  onChange={(event) => {
                    setActiveAgentPrompt(event.target.value);
                    setPrompt(event.target.value);
                  }}
                />
              </label>
            </section>

          <div className="statusBar">
            <strong>{t.status}</strong>
            <span>{status || t.statusNote}</span>
          </div>
          <section className="companionGuide" aria-label={t.companionGuideTitle}>
            <div className="companionStage">
              <img className="companionPortrait" src={companionFull} alt="" aria-hidden="true" />
            </div>
            <div className="companionBubble">
              <strong>{t.companionGuideTitle}</strong>
              <p>{t.companionGuideLine1}</p>
              <p>{t.companionGuideLine2}</p>
              <p>{t.companionGuideLine3}</p>
            </div>
          </section>
          {lastOutput && (
            <div className="statusBar">
              <strong>{t.lastOutput}</strong>
              <code>{lastOutput}</code>
            </div>
          )}
          {candidates.length > 0 && (
            <div className="candidates">
              <strong>{t.candidateTranslations}</strong>
              {candidates.map((candidate) => (
                <button key={candidate.path} onClick={() => patch({ translationPath: candidate.path })}>
                  {candidate.path}
                </button>
              ))}
            </div>
          )}
          {reportCandidates.length > 0 && (
            <div className="candidates">
              <strong>{t.reportCandidates}</strong>
              {reportCandidates.map((candidate) => (
                <button key={candidate.path} onClick={() => patch({ reportPath: candidate.path })}>
                  {candidate.path} ({candidate.score})
                </button>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

function Field(props: { label: string; value: string; onChange: (value: string) => void; onPick: () => void; buttonText: string; folder?: boolean }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <div className="pathInput">
        <input value={props.value} onChange={(event) => props.onChange(event.target.value)} />
        <button type="button" onClick={props.onPick} title={props.label}>
          {props.folder ? <FolderOpen size={18} /> : <FileText size={18} />}
          <span>{props.buttonText}</span>
        </button>
      </div>
    </label>
  );
}

function PathField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onPickFile: () => void;
  onPickFolder: () => void;
  buttonFileText: string;
  buttonFolderText: string;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <div className="pathInput splitPickers">
        <input value={props.value} onChange={(event) => props.onChange(event.target.value)} />
        <button type="button" onClick={props.onPickFile} title={props.buttonFileText}>
          <FileText size={18} />
          <span>{props.buttonFileText}</span>
        </button>
        <button type="button" onClick={props.onPickFolder} title={props.buttonFolderText}>
          <FolderOpen size={18} />
          <span>{props.buttonFolderText}</span>
        </button>
      </div>
    </label>
  );
}

function IconButton(props: { icon: ReactNode; label: string; onClick: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <button className={props.primary ? "primary command" : "command"} onClick={props.onClick} disabled={props.disabled}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
