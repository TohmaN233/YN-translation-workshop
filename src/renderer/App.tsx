import { Clipboard, ExternalLink, FileSearch, FileText, FolderOpen, Languages, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { buildPrompt } from "../shared/core/prompts.ts";
import { YN_DEFAULT_SPLIT_SIZE } from "../shared/agent/piSessionContract.ts";
import { getWorkflowTemplate, workflowTemplates, type WorkflowTemplateId } from "../shared/agent/workflowTemplates.ts";
import {
  normalizeCustomPreserveRules,
  type CanonicalCustomPreserveRule,
  type CustomPreserveRule
} from "../shared/validation/customPreserveRules.ts";
import enUS from "../shared/i18n/en-US.json";
import zhCN from "../shared/i18n/zh-CN.json";
import appIcon from "./assets/app-icon.png";
import companionFull from "./assets/companion-full.png";
import { parsePiWebAgentWindowRoute, PiWebAgentWindow } from "./agent/PiWebAgentWindow.tsx";
import { rebuildNewProjectForm } from "./newProjectForm.ts";
import "./styles.css";

type Locale = "zh-CN" | "en-US";
type FileType = "auto" | "txt" | "epub";
type InputMode = "separate" | "bilingual";
type AgentTaskKind = "translate" | "proofread";
type ProofreadMode = "split" | "montecarlo";

interface AssetProposal {
  id: string;
  kind: string;
  status: string;
  entry?: Record<string, unknown>;
  reason?: string;
  createdAt: string;
}

interface ProjectAssetSummary {
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
  characterBible?: { characters?: unknown[]; source?: string };
  styleGuide?: string;
  translationMemory?: { segmentCount?: number };
}

interface WorkspaceAssetSummary {
  paths: { glossaryCandidates: string; characterBible: string };
  counts: { glossaryCandidates: number; characterBibleLines: number };
  available: { glossaryCandidates: boolean; characterBible: boolean };
  pending: { glossaryCandidates: number };
  actions: { importGlossaryCandidates: boolean };
}

interface AssetEditorState {
  glossarySource: string;
  glossaryTarget: string;
  glossaryAliases: string;
  glossaryInfo: string;
  glossaryStatus: "confirmed" | "auto" | "pending";
  characterName: string;
  characterTarget: string;
  characterAliases: string;
  characterGender: string;
  characterPronouns: string;
  characterGenderConfidence: "confirmed" | "inferred" | "unknown";
  characterTermsOfAddress: string;
  characterRequiredTerms: string;
  characterForbiddenTerms: string;
  styleGuide: string;
}

interface CustomPreserveRuleDraft {
  label: string;
  pattern: string;
  flags: string;
}

interface FormState {
  locale: Locale;
  inputMode: InputMode;
  sourcePath: string;
  sourceKind: "file" | "folder";
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
  glossaryCandidates: boolean;
  characterBible: boolean;
  proofreadMode: ProofreadMode;
  candidateRatio: number;
  montecarloSize: number;
  montecarloRoundMin: number;
  montecarloRoundMax: number;
  translationType: string;
  workDescription: string;
  reportPath: string;
  sourcePosition: number;
  translationPosition: number;
  workflowTemplateId: WorkflowTemplateId;
  agentProxyEnabled: boolean;
  agentProxyUrl: string;
}

type LoadedProjectState = Partial<FormState> & {
  lastHtml?: string;
  lastOutput?: string;
  lastLineReviewHtml?: string;
  lineReviewPath?: string;
  lastProposalReviewHtml?: string;
  sourceColumn?: number;
  translationColumn?: number;
  customPreserveRules?: CustomPreserveRule[];
};

const dictionaries = { "zh-CN": zhCN, "en-US": enUS };
const projectFormKeys = [
  "locale", "inputMode", "sourcePath", "sourceKind", "translationPath", "glossaryPath",
  "fileType", "pageSize", "startPage", "languagePair", "style", "translateOutputDir",
  "proofreadOutputDir", "split", "splitSize", "glossaryCandidates", "characterBible",
  "proofreadMode", "candidateRatio", "montecarloSize", "montecarloRoundMin",
  "montecarloRoundMax", "translationType", "workDescription", "reportPath",
  "sourcePosition", "translationPosition", "workflowTemplateId", "agentProxyEnabled", "agentProxyUrl"
] as const;

function formPatchFromProjectState(value: Record<string, unknown>): Partial<FormState> {
  const patch: Record<string, unknown> = {};
  for (const key of projectFormKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) patch[key] = value[key];
  }
  return patch as Partial<FormState>;
}

function sameProjectPath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

function preserveRuleDrafts(value: unknown): CustomPreserveRuleDraft[] {
  return normalizeCustomPreserveRules(value).map((rule) => ({
    label: rule.label ?? "",
    pattern: rule.pattern,
    flags: rule.flags
  }));
}
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

function initialFormState(): FormState {
  return {
    locale: "zh-CN",
    inputMode: "separate",
    sourcePath: "",
    sourceKind: "file",
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
    splitSize: YN_DEFAULT_SPLIT_SIZE,
    glossaryCandidates: true,
    characterBible: true,
    proofreadMode: "split",
    candidateRatio: 1.5,
    montecarloSize: 3000,
    montecarloRoundMin: 2,
    montecarloRoundMax: 5,
    translationType: "game",
    workDescription: "",
    reportPath: "",
    sourcePosition: 2,
    translationPosition: 1,
    workflowTemplateId: "initial_translation",
    agentProxyEnabled: false,
    agentProxyUrl: "http://127.0.0.1:3067"
  };
}

function App() {
  const agentWindowRoute = parsePiWebAgentWindowRoute();
  if (agentWindowRoute) {
    return <PiWebAgentWindow route={agentWindowRoute} />;
  }

  const [form, setForm] = useState<FormState>(initialFormState);
  const [prompt, setPrompt] = useState("");
  const [promptKind, setPromptKind] = useState<AgentTaskKind>("translate");
  const [status, setStatus] = useState("");
  const [lastOutput, setLastOutput] = useState("");
  const [candidates, setCandidates] = useState<Array<{ path: string; size: number; modifiedAt: string }>>([]);
  const [reportCandidates, setReportCandidates] = useState<Array<{ path: string; size: number; modifiedMs: number; score: number; reasons: string[] }>>([]);
  const [assetProposals, setAssetProposals] = useState<AssetProposal[]>([]);
  const [startupSuggestionIndex, setStartupSuggestionIndex] = useState(0);
  const [projectAssets, setProjectAssets] = useState<ProjectAssetSummary | undefined>();
  const [workspaceAssets, setWorkspaceAssets] = useState<WorkspaceAssetSummary | undefined>();
  const [assetEditor, setAssetEditor] = useState<AssetEditorState>({
    glossarySource: "",
    glossaryTarget: "",
    glossaryAliases: "",
    glossaryInfo: "",
    glossaryStatus: "confirmed",
    characterName: "",
    characterTarget: "",
    characterAliases: "",
    characterGender: "",
    characterPronouns: "",
    characterGenderConfidence: "unknown",
    characterTermsOfAddress: "",
    characterRequiredTerms: "",
    characterForbiddenTerms: "",
    styleGuide: ""
  });
  const [customPreserveRuleDrafts, setCustomPreserveRuleDrafts] = useState<CustomPreserveRuleDraft[]>([]);
  const [savedCustomPreserveRules, setSavedCustomPreserveRules] = useState<CanonicalCustomPreserveRule[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const t = dictionaries[form.locale];
  const bilingualPositionMode = form.inputMode === "bilingual";
  const lastLineReviewHtml = useRef("");
  const lastProposalReviewHtml = useRef("");
  const hydratingProject = useRef(false);
  const autoSaveTimer = useRef<number | undefined>(undefined);
  const suppressNextAutoSave = useRef(false);
  const projectTextFieldEditing = useRef(false);
  const formRef = useRef(form);
  const workspaceAssetsRequestId = useRef(0);
  const userSelectedFormKeys = useRef(new Set<keyof FormState>());
  formRef.current = form;

  useEffect(() => {
    document.documentElement.lang = form.locale;
  }, [form.locale]);

  useEffect(() => {
    if (!form.outputDir || hydratingProject.current || projectTextFieldEditing.current) {
      return undefined;
    }
    if (suppressNextAutoSave.current) {
      suppressNextAutoSave.current = false;
      if (autoSaveTimer.current) {
        window.clearTimeout(autoSaveTimer.current);
        autoSaveTimer.current = undefined;
      }
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

  useEffect(() => window.workshop.onWorkspaceAssetsStatus(({ outputDir, status: nextStatus }) => {
    if (form.outputDir && outputDir.toLowerCase() === form.outputDir.toLowerCase()) {
      setWorkspaceAssets(nextStatus);
    }
  }), [form.outputDir]);

  useEffect(() => window.workshop.onProjectStateUpdate(({ outputDir, state }) => {
    if (!form.outputDir || !sameProjectPath(outputDir, form.outputDir)) return;
    if (projectTextFieldEditing.current) {
      if (autoSaveTimer.current) {
        window.clearTimeout(autoSaveTimer.current);
        autoSaveTimer.current = undefined;
      }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(state, "customPreserveRules")) {
      const rules = normalizeCustomPreserveRules(state.customPreserveRules);
      setSavedCustomPreserveRules(rules);
      setCustomPreserveRuleDrafts(preserveRuleDrafts(rules));
    }
    const next = formPatchFromProjectState(state);
    if (autoSaveTimer.current) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = undefined;
    }
    setForm((current) => {
      const changed = Object.entries(next).some(([key, value]) => current[key as keyof FormState] !== value);
      if (changed) suppressNextAutoSave.current = true;
      return changed ? { ...current, ...next } : current;
    });
  }), [form.outputDir]);

  useEffect(() => window.workshop.onProjectAssetsUpdate(({ outputDir, assets }) => {
    if (!form.outputDir || !sameProjectPath(outputDir, form.outputDir)) return;
    const nextAssets = assets as ProjectAssetSummary;
    setProjectAssets(nextAssets);
    setAssetEditor((previous) => ({ ...previous, styleGuide: String(nextAssets.styleGuide ?? "") }));
  }), [form.outputDir]);

  useEffect(() => {
    if (!form.outputDir) {
      setProjectAssets(undefined);
      setAssetProposals([]);
      return;
    }
    let cancelled = false;
    void Promise.all([
      window.workshop.readProjectAssets({ outputDir: form.outputDir }),
      window.workshop.listAssetProposals({ outputDir: form.outputDir })
    ]).then(([assets, proposals]) => {
      if (cancelled) return;
      const nextAssets = assets as ProjectAssetSummary;
      setProjectAssets(nextAssets);
      setAssetEditor((previous) => ({ ...previous, styleGuide: String(nextAssets.styleGuide ?? "") }));
      setAssetProposals(proposals.filter((proposal) => proposal.status === "pending"));
    }).catch(showActionError);
    return () => {
      cancelled = true;
    };
  }, [form.outputDir]);

  function patch(next: Partial<FormState>) {
    for (const key of Object.keys(next) as Array<keyof FormState>) {
      userSelectedFormKeys.current.add(key);
    }
    updateForm(next);
  }

  function updateForm(next: Partial<FormState>) {
    setForm((current) => ({ ...current, ...next }));
  }

  function isDeferredProjectTextField(target: EventTarget | null) {
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return false;
    return Boolean(target.closest("label.field") && !target.closest(".promptBox"));
  }

  function beginProjectTextFieldEdit(target: EventTarget | null) {
    if (!isDeferredProjectTextField(target)) return;
    projectTextFieldEditing.current = true;
    if (autoSaveTimer.current) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = undefined;
    }
  }

  function commitProjectTextFieldEdit(target: EventTarget | null) {
    if (!isDeferredProjectTextField(target)) return;
    projectTextFieldEditing.current = false;
    if (autoSaveTimer.current) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = undefined;
    }
    window.setTimeout(() => void saveProject().catch(showActionError), 0);
  }

  function showActionError(error: unknown) {
    setStatus(error instanceof Error ? error.message : String(error));
  }

  function asLoadedProject(value: unknown): LoadedProjectState | undefined {
    return value && typeof value === "object" ? value as LoadedProjectState : undefined;
  }

  function projectLastHtml(project: LoadedProjectState | undefined): string {
    const lastHtml = project?.lastLineReviewHtml || project?.lineReviewPath || project?.lastHtml || project?.lastOutput || "";
    return typeof lastHtml === "string" ? lastHtml : "";
  }

  async function openLoadedProjectHtml(project: LoadedProjectState | undefined, outputDir: string) {
    const proposalReviewHtml = project?.lastProposalReviewHtml || "";
    const lineReviewHtml = project?.lastLineReviewHtml || project?.lineReviewPath || "";
    if (lineReviewHtml) {
      await window.workshop.openPath(lineReviewHtml);
    } else if (proposalReviewHtml) {
      await window.workshop.openReviewHtml({ htmlPath: proposalReviewHtml, outputDir });
    } else {
      const fallbackHtml = projectLastHtml(project);
      if (fallbackHtml) await window.workshop.openPath(fallbackHtml);
    }
    if (lineReviewHtml && proposalReviewHtml) {
      void window.workshop.openReviewHtml({
        htmlPath: proposalReviewHtml,
        outputDir,
        activate: false
      }).catch(showActionError);
    }
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
    const assetsRequestId = ++workspaceAssetsRequestId.current;
    setWorkspaceAssets(undefined);
    const loaded = asLoadedProject(await window.workshop.loadProject(outputDir));
    if (!loaded) {
      const selectedKeys = [...userSelectedFormKeys.current];
      hydratingProject.current = true;
      setForm((current) => rebuildNewProjectForm(initialFormState(), current, selectedKeys, outputDir));
      userSelectedFormKeys.current.clear();
      setSavedCustomPreserveRules([]);
      setCustomPreserveRuleDrafts([]);
      window.setTimeout(() => {
        hydratingProject.current = false;
      }, 0);
      setLastOutput("");
      lastLineReviewHtml.current = "";
      lastProposalReviewHtml.current = "";
      setStatus(t.projectOpenedNoHtml);
      void window.workshop.readWorkspaceAssetsStatus({ outputDir }).then((nextStatus) => {
        if (workspaceAssetsRequestId.current === assetsRequestId) setWorkspaceAssets(nextStatus);
      }).catch(showActionError);
      return;
    }
    const lastHtml = projectLastHtml(loaded);
    lastLineReviewHtml.current = loaded.lastLineReviewHtml || loaded.lineReviewPath || "";
    lastProposalReviewHtml.current = loaded.lastProposalReviewHtml || "";
    const projectOutputDir = typeof loaded.outputDir === "string" && loaded.outputDir ? loaded.outputDir : outputDir;
    const loadedCustomPreserveRules = normalizeCustomPreserveRules(loaded.customPreserveRules);
    setSavedCustomPreserveRules(loadedCustomPreserveRules);
    setCustomPreserveRuleDrafts(preserveRuleDrafts(loadedCustomPreserveRules));
    hydratingProject.current = true;
    const defaults = initialFormState();
    const loadedForm = formPatchFromProjectState(loaded);
    setForm({
      ...defaults,
      ...loadedForm,
      sourceKind: loaded.sourceKind === "folder" ? "folder" : "file",
      outputDir: projectOutputDir,
      translateOutputDir: loaded.translateOutputDir ?? defaultTranslateOutputDir(projectOutputDir),
      proofreadOutputDir: loaded.proofreadOutputDir ?? defaultProofreadOutputDir(projectOutputDir),
      sourcePosition: loaded.sourcePosition ?? loaded.sourceColumn ?? defaults.sourcePosition,
      translationPosition: loaded.translationPosition ?? loaded.translationColumn ?? defaults.translationPosition,
      workflowTemplateId: getWorkflowTemplate(loaded.workflowTemplateId).id,
      agentProxyEnabled: loaded.agentProxyEnabled ?? false,
      agentProxyUrl: loaded.agentProxyUrl ?? "http://127.0.0.1:3067"
    });
    userSelectedFormKeys.current.clear();
    window.setTimeout(() => {
      hydratingProject.current = false;
    }, 0);
    setLastOutput(lastHtml);
    setStatus(lastHtml ? t.projectOpened : t.projectOpenedNoHtml);
    if (openLastHtml && lastHtml) {
      await openLoadedProjectHtml(loaded, projectOutputDir);
    }
    void window.workshop.readWorkspaceAssetsStatus({ outputDir: projectOutputDir }).then((nextStatus) => {
      if (workspaceAssetsRequestId.current === assetsRequestId) setWorkspaceAssets(nextStatus);
    }).catch(showActionError);
  }

  async function openProject() {
    try {
      const selected = await window.workshop.openProjectFolder();
      if (selected) {
        await loadProjectState(selected, true);
      }
    } catch (error) {
      showActionError(error);
    }
  }

  async function openExistingHtml() {
    try {
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
    } catch (error) {
      showActionError(error);
    }
  }

  async function openReviewHtml() {
    try {
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
    } catch (error) {
      showActionError(error);
    }
  }

  async function pickFile(key: keyof Pick<FormState, "sourcePath" | "translationPath" | "glossaryPath" | "reportPath">) {
    try {
      const filters = key === "glossaryPath" ? glossaryFileFilters : documentFileFilters;
      const selected = await window.workshop.openFile(filters);
      if (selected) {
        patch({ [key]: selected } as Partial<FormState>);
      }
    } catch (error) {
      showActionError(error);
    }
  }

  async function pickSourceFile(key: keyof Pick<FormState, "sourcePath" | "translationPath">) {
    try {
      const selected = await window.workshop.openFile(sourceFileFilters);
      if (selected) {
        const lower = selected.toLowerCase();
        patch({
          [key]: selected,
          ...(key === "sourcePath" ? { sourceKind: "file" as const } : {}),
          fileType: key === "sourcePath"
            ? (lower.endsWith(".epub") ? "epub" : lower.endsWith(".txt") ? "txt" : form.fileType)
            : form.fileType,
          sourcePosition: form.inputMode === "bilingual" ? 2 : form.sourcePosition,
          translationPosition: form.inputMode === "bilingual" ? 1 : form.translationPosition
        } as Partial<FormState>);
      }
    } catch (error) {
      showActionError(error);
    }
  }

  async function pickSourceFolder(key: keyof Pick<FormState, "sourcePath" | "translationPath">) {
    try {
      const selected = await window.workshop.openFolder();
      if (selected) {
        patch({
          [key]: selected,
          fileType: "auto",
          ...(key === "sourcePath" ? { sourceKind: "folder" as const } : {})
        } as Partial<FormState>);
      }
    } catch (error) {
      showActionError(error);
    }
  }

  async function pickOutput() {
    try {
      const selected = await window.workshop.openFolder();
      if (selected) {
        await loadProjectState(selected, false);
      }
    } catch (error) {
      showActionError(error);
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
      glossaryCandidates: form.glossaryCandidates,
      characterBible: form.characterBible,
      proofreadMode: form.proofreadMode,
      candidateRatio: form.candidateRatio,
      montecarloSize: form.montecarloSize,
      montecarloRoundMin: form.montecarloRoundMin,
      montecarloRoundMax: form.montecarloRoundMax,
      workDescription: form.workDescription,
      workflowTemplateId: form.workflowTemplateId,
      translationType: form.translationType,
      customPreserveRules: savedCustomPreserveRules
    };
  }

  function buildDefaultAgentPrompt(kind: AgentTaskKind = promptKind) {
    return buildPrompt({
      kind: kind === "proofread" ? "proofread" : "translate",
      sourcePath: form.sourcePath,
      sourceKind: form.sourceKind,
      translationPath: form.translationPath || undefined,
      outputDir: form.outputDir,
      glossaryPath: form.glossaryPath || undefined,
      inputMode: form.inputMode,
      advanced: promptAdvanced()
    });
  }

  function workflowArtifactInstruction(templateId: WorkflowTemplateId) {
    const artifact = getWorkflowTemplate(templateId).outputArtifact;
    return [
      `Primary artifact: ${artifact.pathHint}`,
      `Artifact kind: ${artifact.kind}`,
      "Use this artifact as the durable output for the selected workflow."
    ].join("\n");
  }

  function buildWorkflowTemplatePrompt(templateId: WorkflowTemplateId) {
    const template = getWorkflowTemplate(templateId);
    return [buildDefaultAgentPrompt(template.promptKind), workflowArtifactInstruction(template.id)].join("\n");
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
    const formSnapshot = formRef.current;
    if (!formSnapshot.outputDir) {
      return;
    }
    if (outputKind === "line") {
      lastLineReviewHtml.current = nextLastOutput;
    }
    if (outputKind === "proposal") {
      lastProposalReviewHtml.current = nextLastOutput;
    }
    await window.workshop.saveProject(formSnapshot.outputDir, {
      ...formSnapshot,
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
    patch({ workflowTemplateId: "initial_translation" });
    setPrompt(next);
  }

  function generateProofreadPrompt() {
    if (!form.sourcePath || !form.translationPath) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    const next = buildDefaultAgentPrompt("proofread");
    setPromptKind("proofread");
    patch({ workflowTemplateId: "proofread" });
    setPrompt(next);
  }

  function selectWorkflowTemplate(templateId: WorkflowTemplateId) {
    const template = getWorkflowTemplate(templateId);
    const next = buildWorkflowTemplatePrompt(template.id);
    patch({ workflowTemplateId: template.id });
    setPromptKind(template.promptKind);
    setPrompt(next);
  }

  function workflowTemplateParams() {
    switch (form.workflowTemplateId) {
      case "initial_translation":
        return (
          <>
            <label className="field">
              <span>{t.translateOutputDir ?? "Translation output folder"}</span>
              <input value={form.translateOutputDir || defaultTranslateOutputDir()} onChange={(event) => patch({ translateOutputDir: event.target.value })} />
            </label>
            <label className="field">
              <span>{t.splitSize ?? "Split size"}</span>
              <input type="number" min={1} value={form.splitSize} onChange={(event) => patch({ splitSize: Number(event.target.value) })} />
            </label>
          </>
        );
      case "proofread":
        return (
          <>
            <label className="field">
              <span>{t.proofreadOutputDir ?? "Report output folder"}</span>
              <input value={form.proofreadOutputDir || defaultProofreadOutputDir()} onChange={(event) => patch({ proofreadOutputDir: event.target.value })} />
            </label>
            <label className="field">
              <span>{t.proofreadMode ?? "Proofread mode"}</span>
              <select value={form.proofreadMode} onChange={(event) => patch({ proofreadMode: event.target.value as ProofreadMode })}>
                <option value="split">split</option>
                <option value="montecarlo">montecarlo</option>
              </select>
            </label>
            <label className="field">
              <span>{t.candidateRatio ?? "H9 candidate ratio"}</span>
              <input type="number" min={0.1} step={0.1} value={form.candidateRatio} onChange={(event) => patch({ candidateRatio: Number(event.target.value) })} />
            </label>
          </>
        );
      default:
        return null;
    }
  }

  async function copyPrompt() {
    await window.workshop.copyText(prompt);
    setStatus(t.copied);
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
      updateForm({ reportPath: found[0].path });
      setStatus(`${t.reportFound} ${found[0].path}`);
      return found[0].path;
    }
    setStatus(t.noReports);
    return "";
  }

  async function refreshAssetProposals() {
    if (!form.outputDir) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    const [assets, proposals, generated] = await Promise.all([
      window.workshop.readProjectAssets({ outputDir: form.outputDir }),
      window.workshop.listAssetProposals({ outputDir: form.outputDir }),
      window.workshop.readWorkspaceAssetsStatus({ outputDir: form.outputDir })
    ]);
    setProjectAssets(assets as ProjectAssetSummary);
    setAssetEditor((previous) => ({ ...previous, styleGuide: String((assets as ProjectAssetSummary).styleGuide ?? "") }));
    setAssetProposals(proposals.filter((proposal) => proposal.status === "pending"));
    setWorkspaceAssets(generated);
    setStatus(proposals.length ? `${t.assetProposals ?? "Asset proposals"}: ${proposals.length}` : (t.noAssetProposals ?? "No pending asset proposals."));
  }

  function refreshStartupSuggestion() {
    setStartupSuggestionIndex((current) => (current + 1) % t.startupSuggestions.length);
    if (form.outputDir) void refreshAssetProposals();
  }

  async function importGeneratedGlossary() {
    if (!form.outputDir) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    const result = await window.workshop.importGeneratedGlossaryCandidates({ outputDir: form.outputDir });
    setProjectAssets(result.assets as ProjectAssetSummary);
    const importedGlossaryPath = String((result.assets as ProjectAssetSummary).paths?.glossary ?? "");
    if (!form.glossaryPath.trim() && importedGlossaryPath) updateForm({ glossaryPath: importedGlossaryPath });
    setStatus(`${t.generatedGlossaryImported ?? "Generated glossary imported"}: ${result.counts.added} added, ${result.counts.deduplicated} existing.`);
    setWorkspaceAssets(await window.workshop.readWorkspaceAssetsStatus({ outputDir: form.outputDir }));
  }

  function patchAssetEditor(patch: Partial<AssetEditorState>) {
    setAssetEditor((previous) => ({ ...previous, ...patch }));
  }

  function splitAssetList(value: string) {
    return value.split(/[,，;；、\n]/).map((item) => item.trim()).filter(Boolean);
  }

  async function saveGlossaryEntry() {
    if (!form.outputDir || !assetEditor.glossarySource.trim() || !assetEditor.glossaryTarget.trim()) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    const assets = await window.workshop.saveProjectAssets({
      outputDir: form.outputDir,
      glossaryEntry: {
        source: assetEditor.glossarySource.trim(),
        target: assetEditor.glossaryTarget.trim(),
        aliases: splitAssetList(assetEditor.glossaryAliases),
        ...(assetEditor.glossaryInfo.trim() ? { info: assetEditor.glossaryInfo.trim() } : {}),
        status: assetEditor.glossaryStatus
      }
    });
    setProjectAssets(assets as ProjectAssetSummary);
    patchAssetEditor({ glossarySource: "", glossaryTarget: "", glossaryAliases: "", glossaryInfo: "", glossaryStatus: "confirmed" });
    setStatus(t.projectAssetsSaved ?? "Project assets saved.");
  }

  async function saveCharacterEntry() {
    if (!form.outputDir || !assetEditor.characterName.trim()) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    const assets = await window.workshop.saveProjectAssets({
      outputDir: form.outputDir,
      characterEntry: {
        name: assetEditor.characterName.trim(),
        target: assetEditor.characterTarget.trim(),
        aliases: splitAssetList(assetEditor.characterAliases),
        ...(assetEditor.characterGender.trim() ? { gender: assetEditor.characterGender.trim() } : {}),
        ...(assetEditor.characterPronouns.trim() ? { pronouns: assetEditor.characterPronouns.trim() } : {}),
        genderConfidence: assetEditor.characterGenderConfidence,
        termsOfAddress: assetEditor.characterTermsOfAddress.trim() || "unknown",
        requiredTerms: splitAssetList(assetEditor.characterRequiredTerms),
        forbiddenTerms: splitAssetList(assetEditor.characterForbiddenTerms)
      }
    });
    setProjectAssets(assets as ProjectAssetSummary);
    patchAssetEditor({
      characterName: "",
      characterTarget: "",
      characterAliases: "",
      characterGender: "",
      characterPronouns: "",
      characterGenderConfidence: "unknown",
      characterTermsOfAddress: "",
      characterRequiredTerms: "",
      characterForbiddenTerms: ""
    });
    setStatus(t.projectAssetsSaved ?? "Project assets saved.");
  }

  async function saveStyleGuide() {
    if (!form.outputDir) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    const assets = await window.workshop.saveProjectAssets({ outputDir: form.outputDir, styleGuide: assetEditor.styleGuide });
    setProjectAssets(assets as ProjectAssetSummary);
    setStatus(t.projectAssetsSaved ?? "Project assets saved.");
  }

  function patchCustomPreserveRule(index: number, patch: Partial<CustomPreserveRuleDraft>) {
    setCustomPreserveRuleDrafts((current) => current.map((rule, ruleIndex) => (
      ruleIndex === index ? { ...rule, ...patch } : rule
    )));
  }

  function addCustomPreserveRule() {
    setCustomPreserveRuleDrafts((current) => [
      ...current,
      { label: "", pattern: "", flags: "u" }
    ]);
  }

  function removeCustomPreserveRule(index: number) {
    setCustomPreserveRuleDrafts((current) => current.filter((_, ruleIndex) => ruleIndex !== index));
  }

  async function saveCustomPreserveRules() {
    if (!form.outputDir) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    try {
      const rules = normalizeCustomPreserveRules(
        customPreserveRuleDrafts
          .filter((rule) => rule.pattern.trim())
          .map((rule) => ({
            ...(rule.label.trim() ? { label: rule.label.trim() } : {}),
            pattern: rule.pattern,
            flags: rule.flags
          }))
      );
      await window.workshop.saveProject(form.outputDir, { customPreserveRules: rules });
      setSavedCustomPreserveRules(rules);
      setCustomPreserveRuleDrafts(preserveRuleDrafts(rules));
      setStatus(t.customPreserveRulesSaved ?? "Preservation rules saved.");
    } catch (error) {
      showActionError(error);
    }
  }

  async function approveAssetProposal(proposal: AssetProposal) {
    if (!form.outputDir) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    await window.workshop.approveAssetProposal({ outputDir: form.outputDir, proposalId: proposal.id, entry: proposal.entry });
    setStatus(t.assetProposalApproved ?? "Asset proposal approved.");
    await refreshAssetProposals();
  }

  function glossaryAssetProposals() {
    return assetProposals.filter((proposal) => proposal.kind === "glossary");
  }

  async function approveGlossaryAssetProposals() {
    if (!form.outputDir) {
      setStatus(t.requiredSourceOutput);
      return;
    }
    const glossary = glossaryAssetProposals();
    if (glossary.length === 0) {
      setStatus(t.noAssetProposals ?? "No pending asset proposals.");
      return;
    }
    for (const proposal of glossary) {
      await window.workshop.approveAssetProposal({ outputDir: form.outputDir, proposalId: proposal.id, entry: proposal.entry });
    }
    setStatus(`${t.assetGlossaryBatchApproved ?? "Glossary proposals approved."} (${glossary.length})`);
    await refreshAssetProposals();
  }

  function proposalTargetKey(proposal: AssetProposal) {
    const entry = proposal.entry ?? {};
    for (const key of ["target", "localizedName", "translation"]) {
      if (String(entry[key] ?? "").trim()) return key;
    }
    return "target";
  }

  function proposalTargetOptions(proposal: AssetProposal) {
    const entry = proposal.entry ?? {};
    const target = String(entry[proposalTargetKey(proposal)] ?? "").trim();
    const alternatives = Array.isArray(entry.alternatives)
      ? entry.alternatives.map((item) => String(item).trim()).filter(Boolean)
      : [];
    return [...new Set([target, ...alternatives].filter(Boolean))];
  }

  function selectProposalTarget(proposal: AssetProposal, target: string) {
    const key = proposalTargetKey(proposal);
    setAssetProposals((previous) => previous.map((item) => item.id === proposal.id
      ? (() => {
        const entry = item.entry ?? {};
        const currentTarget = String(entry[key] ?? "").trim();
        const alternatives = Array.isArray(entry.alternatives)
          ? entry.alternatives.map((value) => String(value).trim()).filter(Boolean)
          : [];
        const nextAlternatives = [...new Set([...alternatives.filter((value) => value !== target), currentTarget].filter(Boolean))];
        return { ...item, entry: { ...entry, [key]: target, alternatives: nextAlternatives } };
      })()
      : item));
  }

  function assetRows() {
    const paths = projectAssets?.paths ?? {};
    const available = projectAssets?.available;
    return [
      { key: "glossary", label: t.assetGlossary ?? "Glossary", path: paths.glossary, count: projectAssets?.glossary?.entries?.length, exists: available?.glossary },
      { key: "characterBible", label: t.assetCharacterBible ?? "Character bible", path: paths.characterBible, count: projectAssets?.characterBible?.characters?.length, exists: available?.characterBible },
      { key: "styleGuide", label: t.assetStyleGuide ?? "Style guide", path: paths.styleGuide, exists: available?.styleGuide },
      { key: "translationMemory", label: t.assetTranslationMemory ?? "Translation memory", path: paths.translationMemory, count: projectAssets?.translationMemory?.segmentCount, exists: available?.translationMemory }
    ].filter((row) => row.path && row.exists !== false);
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
        updateForm({ reportPath: result.reportPath });
      }
      if (result.lineReviewPath) {
        lastLineReviewHtml.current = result.lineReviewPath;
      }
      if (result.fallbackPrompt) {
        setPromptKind("proofread");
        setPrompt(result.fallbackPrompt);
        if (result.reportPath) {
          updateForm({ reportPath: result.reportPath });
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
      await window.workshop.openReviewHtml({
        htmlPath: result.outputPath,
        outputDir: form.outputDir
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main
      className="shell"
      onInputCapture={(event) => beginProjectTextFieldEdit(event.target)}
      onBlurCapture={(event) => commitProjectTextFieldEdit(event.target)}
    >
      <section className="topbar">
        <div className="brandBlock">
          <img className="brandIcon" src={appIcon} alt="" aria-hidden="true" />
          <div>
            <h1>{t.appTitle}</h1>
            <p>{t.appSubtitle}</p>
          </div>
        </div>
        <div className="topActions">
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
          <div className="setup">
            <strong>{t.agentProxyEnabled ?? "Agent network"}</strong>
            <label className="field checkboxField">
              <input
                type="checkbox"
                checked={form.agentProxyEnabled}
                onChange={(event) => patch({ agentProxyEnabled: event.target.checked })}
              />
              <span>{t.agentProxyEnabled ?? "Use proxy for Agent network"}</span>
            </label>
            <label className="field">
              <span>{t.agentProxyUrl ?? "Agent proxy URL"}</span>
              <input
                value={form.agentProxyUrl}
                disabled={!form.agentProxyEnabled}
                placeholder="http://127.0.0.1:3067"
                onChange={(event) => patch({ agentProxyUrl: event.target.value })}
              />
            </label>
          </div>

          <PathField label={t.sourcePath} value={form.sourcePath} onChange={(value) => patch({ sourcePath: value })} onPickFile={() => pickSourceFile("sourcePath")} onPickFolder={() => pickSourceFolder("sourcePath")} buttonFileText={t.selectFile} buttonFolderText={t.selectFolder} />
          {form.inputMode === "separate" && (
            <PathField label={`${t.translationPath} (${t.optional})`} value={form.translationPath} onChange={(value) => patch({ translationPath: value })} onPickFile={() => pickSourceFile("translationPath")} onPickFolder={() => pickSourceFolder("translationPath")} buttonFileText={t.selectFile} buttonFolderText={t.selectFolder} />
          )}
          <Field label={t.outputDir} value={form.outputDir} onChange={(value) => patch({ outputDir: value })} onPick={pickOutput} buttonText={t.select} folder />
          <Field label={`${t.glossaryPath} (${t.optional})`} value={form.glossaryPath} onChange={(value) => patch({ glossaryPath: value })} onPick={() => pickFile("glossaryPath")} buttonText={t.select} />
          {workspaceAssets?.actions.importGlossaryCandidates ? (
            <button className="generatedGlossaryImport" type="button" onClick={() => void importGeneratedGlossary().catch(showActionError)}>
              {t.importGeneratedGlossary ?? "Import generated glossary"} · {workspaceAssets.pending.glossaryCandidates}
            </button>
          ) : null}

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
                <input type="checkbox" checked={form.glossaryCandidates} onChange={(event) => patch({ glossaryCandidates: event.target.checked })} />
                <span>{t.glossaryCandidates ?? "Glossary candidates"}</span>
              </label>
              <label className="field checkboxField">
                <input type="checkbox" checked={form.characterBible} onChange={(event) => patch({ characterBible: event.target.checked })} />
                <span>{t.characterBible ?? "Character bible"}</span>
              </label>
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
                <label className="field"><span>{t.splitSize ?? "Split size"}</span><input type="number" min={1} value={form.splitSize} onChange={(event) => patch({ splitSize: Number(event.target.value) })} /></label>
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

          <label className="field workflowTemplateField">
            <span>{t.workflowTemplate ?? "Built-in workflow"}</span>
            <select value={form.workflowTemplateId} onChange={(event) => selectWorkflowTemplate(event.target.value as WorkflowTemplateId)}>
              {workflowTemplates.map((template) => (
                <option key={template.id} value={template.id}>
                  {t[template.labelKey] ?? template.id}
                </option>
              ))}
            </select>
          </label>
          <section className="workflowTemplateParams">
            <strong>{t.workflowTemplateParams ?? "Workflow parameters"}</strong>
            <div className="workflowTemplateParamGrid">
              {workflowTemplateParams()}
            </div>
          </section>

          <div className="actions">
            <IconButton icon={<FileText size={18} />} label={t.generateLineHtml} onClick={generateLineHtml} primary />
            <IconButton icon={<Languages size={18} />} label={t.generateTranslatePrompt} onClick={generateTranslatePrompt} />
            <IconButton icon={<ShieldCheck size={18} />} label={t.generateProofreadPrompt} onClick={generateProofreadPrompt} />
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
            }} />
          </label>

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
          <div className="assetProposals">
            <div className="assetProposalsHeader">
              <strong>{t.assetProposals ?? "Asset proposals"}</strong>
              <button type="button" onClick={refreshStartupSuggestion}>{t.refreshAssetProposals ?? "Refresh"}</button>
            </div>
            <p>{t.startupSuggestions[startupSuggestionIndex % t.startupSuggestions.length]}</p>
            {projectAssets ? (
              <div className="assetProposalCard">
                <strong>{t.projectAssets ?? "Project assets"}</strong>
                <div className="assetPathList">
                  {assetRows().map((asset) => (
                    <button key={asset.key} type="button" onClick={() => asset.path && window.workshop.openPath(asset.path)}>
                      {asset.label}{asset.count !== undefined ? ` · ${asset.count}` : ""}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {projectAssets ? (
              <div className="assetEditorPanel">
                <strong>{t.projectAssetEditor ?? "Asset editor"}</strong>
                <div className="assetEditorGrid">
                  <label>
                    <span>{t.assetGlossary ?? "Glossary"} source</span>
                    <input value={assetEditor.glossarySource} onChange={(event) => patchAssetEditor({ glossarySource: event.target.value })} />
                  </label>
                  <label>
                    <span>{t.assetGlossary ?? "Glossary"} target</span>
                    <input value={assetEditor.glossaryTarget} onChange={(event) => patchAssetEditor({ glossaryTarget: event.target.value })} />
                  </label>
                  <label>
                    <span>aliases</span>
                    <input value={assetEditor.glossaryAliases} onChange={(event) => patchAssetEditor({ glossaryAliases: event.target.value })} />
                  </label>
                  <label>
                    <span>{t.assetInfo ?? "Info"}</span>
                    <input value={assetEditor.glossaryInfo} onChange={(event) => patchAssetEditor({ glossaryInfo: event.target.value })} />
                  </label>
                  <label>
                    <span>{t.assetConfidence ?? "Status"}</span>
                    <select value={assetEditor.glossaryStatus} onChange={(event) => patchAssetEditor({ glossaryStatus: event.target.value as AssetEditorState["glossaryStatus"] })}>
                      <option value="confirmed">confirmed</option>
                      <option value="auto">auto</option>
                      <option value="pending">pending</option>
                    </select>
                  </label>
                  <button type="button" onClick={() => void saveGlossaryEntry()}>{t.saveAssetEntry ?? "Save entry"}</button>
                </div>
                <div className="assetEditorGrid">
                  <label>
                    <span>{t.assetCharacterBible ?? "Character bible"} name</span>
                    <input value={assetEditor.characterName} onChange={(event) => patchAssetEditor({ characterName: event.target.value })} />
                  </label>
                  <label>
                    <span>target</span>
                    <input value={assetEditor.characterTarget} onChange={(event) => patchAssetEditor({ characterTarget: event.target.value })} />
                  </label>
                  <label>
                    <span>aliases</span>
                    <input value={assetEditor.characterAliases} onChange={(event) => patchAssetEditor({ characterAliases: event.target.value })} />
                  </label>
                  <label>
                    <span>{t.assetGender ?? "Gender"}</span>
                    <input value={assetEditor.characterGender} onChange={(event) => patchAssetEditor({ characterGender: event.target.value })} />
                  </label>
                  <label>
                    <span>{t.assetPronouns ?? "Pronouns"}</span>
                    <input value={assetEditor.characterPronouns} onChange={(event) => patchAssetEditor({ characterPronouns: event.target.value })} />
                  </label>
                  <label>
                    <span>{t.assetConfidence ?? "Confidence"}</span>
                    <select value={assetEditor.characterGenderConfidence} onChange={(event) => patchAssetEditor({ characterGenderConfidence: event.target.value as AssetEditorState["characterGenderConfidence"] })}>
                      <option value="confirmed">confirmed</option>
                      <option value="inferred">inferred</option>
                      <option value="unknown">unknown</option>
                    </select>
                  </label>
                  <label>
                    <span>{t.assetTermsOfAddress ?? "Terms of address"}</span>
                    <input value={assetEditor.characterTermsOfAddress} onChange={(event) => patchAssetEditor({ characterTermsOfAddress: event.target.value })} />
                  </label>
                  <label>
                    <span>required terms</span>
                    <input value={assetEditor.characterRequiredTerms} onChange={(event) => patchAssetEditor({ characterRequiredTerms: event.target.value })} />
                  </label>
                  <label>
                    <span>forbidden terms</span>
                    <input value={assetEditor.characterForbiddenTerms} onChange={(event) => patchAssetEditor({ characterForbiddenTerms: event.target.value })} />
                  </label>
                  <button type="button" onClick={() => void saveCharacterEntry()}>{t.saveAssetEntry ?? "Save entry"}</button>
                </div>
                <label className="assetStyleEditor">
                  <span>{t.assetStyleGuide ?? "Style guide"}</span>
                  <textarea value={assetEditor.styleGuide} onChange={(event) => patchAssetEditor({ styleGuide: event.target.value })} />
                </label>
                <button type="button" onClick={() => void saveStyleGuide()}>{t.saveStyleGuide ?? "Save style guide"}</button>
                <section className="customPreserveEditor">
                  <div className="customPreserveHeader">
                    <div>
                      <strong>{t.customPreserveRules ?? "Custom regex preservation rules"}</strong>
                      <p>{t.customPreserveRulesHint ?? "Source matches must remain verbatim on the same translated line."}</p>
                    </div>
                    <button
                      type="button"
                      className="iconButton"
                      onClick={addCustomPreserveRule}
                      disabled={customPreserveRuleDrafts.length >= 64}
                      title={t.addCustomPreserveRule ?? "Add preservation rule"}
                      aria-label={t.addCustomPreserveRule ?? "Add preservation rule"}
                    >
                      <Plus size={18} aria-hidden="true" />
                    </button>
                  </div>
                  {customPreserveRuleDrafts.length > 0 ? (
                    <div className="customPreserveRuleList">
                      {customPreserveRuleDrafts.map((rule, index) => (
                        <div className="customPreserveRuleRow" key={index}>
                          <label>
                            <span>{t.customPreserveRuleLabel ?? "Label"}</span>
                            <input
                              value={rule.label}
                              onChange={(event) => patchCustomPreserveRule(index, { label: event.target.value })}
                            />
                          </label>
                          <label>
                            <span>{t.customPreserveRulePattern ?? "Regular expression"}</span>
                            <input
                              value={rule.pattern}
                              spellCheck={false}
                              onChange={(event) => patchCustomPreserveRule(index, { pattern: event.target.value })}
                            />
                          </label>
                          <label>
                            <span>{t.customPreserveRuleFlags ?? "Flags"}</span>
                            <input
                              value={rule.flags}
                              spellCheck={false}
                              onChange={(event) => patchCustomPreserveRule(index, { flags: event.target.value })}
                            />
                          </label>
                          <button
                            type="button"
                            className="iconButton danger"
                            onClick={() => removeCustomPreserveRule(index)}
                            title={t.removeCustomPreserveRule ?? "Remove preservation rule"}
                            aria-label={t.removeCustomPreserveRule ?? "Remove preservation rule"}
                          >
                            <Trash2 size={17} aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="customPreserveEmpty">{t.customPreserveRulesEmpty ?? "No custom preservation rules."}</p>
                  )}
                  <button type="button" onClick={() => void saveCustomPreserveRules()}>
                    {t.saveCustomPreserveRules ?? "Save preservation rules"}
                  </button>
                </section>
              </div>
            ) : null}
            {glossaryAssetProposals().length > 0 ? (
              <div className="assetBatchBar">
                <span>
                  {t.assetGlossaryBatch ?? "Glossary proposals"} · {glossaryAssetProposals().length}
                </span>
                <button type="button" onClick={() => void approveGlossaryAssetProposals()}>
                  {t.approveGlossaryBatch ?? "Approve glossary batch"}
                </button>
              </div>
            ) : null}
            {assetProposals.map((proposal) => (
              <article key={proposal.id} className="assetProposalCard">
                <code>{proposal.kind} · {proposal.id}</code>
                <pre>{JSON.stringify(proposal.entry ?? {}, null, 2)}</pre>
                {proposalTargetOptions(proposal).length > 1 ? (
                  <div className="assetAlternativeList">
                    {proposalTargetOptions(proposal).map((target) => (
                      <button
                        key={target}
                        type="button"
                        className={target === String(proposal.entry?.[proposalTargetKey(proposal)] ?? "") ? "active" : ""}
                        onClick={() => selectProposalTarget(proposal, target)}
                      >
                        {target}
                      </button>
                    ))}
                  </div>
                ) : null}
                {proposal.reason ? <span>{proposal.reason}</span> : null}
                <button type="button" onClick={() => void approveAssetProposal(proposal)}>
                  {t.approveAssetProposal ?? "Approve"}
                </button>
              </article>
            ))}
          </div>
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
