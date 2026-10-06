import { BookOpen, Check, ChevronDown, FileText, FolderOpen, Languages, LoaderCircle, Settings2, ShieldCheck, Sparkles, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { builtinTaskDefaults, type BuiltinTaskKind, type BuiltinTaskSettings } from "../shared/builtinTasks.ts";
import { normalizeCustomPreserveRules } from "../shared/validation/customPreserveRules.ts";

type Locale = "zh-CN" | "en-US";
type TaskModalKind = Exclude<BuiltinTaskKind, "assets">;
type TaskResult = { outputPath?: string; sessionId: string };

interface BuiltinTaskEntryProps {
  locale: Locale;
  currentSettings: BuiltinTaskSettings;
  onStarting: () => void;
  onStarted: (task: BuiltinTaskKind, result: TaskResult, settings: BuiltinTaskSettings) => Promise<void> | void;
  onStartFailed: (error: unknown) => void;
}

const sourceFilters = [
  { name: "Source files", extensions: ["txt", "epub"] },
  { name: "All files", extensions: ["*"] }
];
const referenceFilters = [
  { name: "Reference materials", extensions: ["txt", "md", "json", "csv", "tsv"] },
  { name: "All files", extensions: ["*"] }
];

function joinPath(root: string, child: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const separator = trimmed.includes("\\") ? "\\" : "/";
  return trimmed ? `${trimmed}${separator}${child}` : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

function restoreTaskInputTranslationPath(
  projectState: Record<string, unknown>,
  settings: BuiltinTaskSettings
): BuiltinTaskSettings {
  const persistedInput = asRecord(projectState.builtinTaskInputSettings);
  const expectedPath = projectState.builtinTaskTranslationPath;
  if (
    projectState.translationBindingOrigin === "canonical"
    && persistedInput
    && typeof expectedPath === "string"
    && expectedPath.trim()
    && samePath(settings.translationPath ?? "", expectedPath)
  ) {
    return {
      ...settings,
      translationPath: typeof persistedInput.translationPath === "string" ? persistedInput.translationPath : ""
    };
  }
  return settings;
}

function copyFor(locale: Locale) {
  return locale === "zh-CN" ? {
    entryTitle: "让 YN 帮你准备任务",
    entrySubtitle: "（一键启动 AI 功能的懒人模式；想更多人力介入，建议先生成行对行 HTML，再按需使用 AI 功能。）",
    translation: "开始翻译",
    translationDetail: "扫描源文件、准备保留规则并打开译文工作区。",
    proofread: "校对现有译文",
    proofreadDetail: "检查已存在的译文并打开校对工作区。",
    assets: "整理参考资料",
    assetsDetail: "从项目资料中整理术语表与角色圣经。",
    materialsLabel: "参考资料位置或说明（可选）",
    materialsPlaceholder: "粘贴 TXT、Markdown、JSON、CSV、TSV 或网页地址，也可写明要参考的资料。",
    addMaterials: "添加文件",
    chooseProject: "选择项目文件夹",
    assetsProjectHint: "填写项目路径；不存在时自动创建，已有项目直接使用。译名表和角色表可在翻译前准备。",
    chooseCurrentProject: "先选择项目",
    taskTitle: { translation: "翻译设置", proofread: "校对设置" },
    project: "项目文件夹",
    projectPlaceholder: "选择或输入项目文件夹路径",
    source: "源文件或文件夹",
    existingTranslation: "现有译文文件或文件夹",
    existingTranslationHint: "校对需要现有译文；双语输入会从源文件中读取译文列。",
    continueTranslation: "继续使用已有译文",
    optional: "可选",
    glossary: "参考术语表",
    inputMode: "输入格式",
    separate: "原文与译文分开",
    bilingual: "双语文件",
    fileType: "文件类型",
    sourceColumn: "原文列",
    translationColumn: "译文列",
    firstColumn: "第一列",
    secondColumn: "第二列",
    languagePair: "语言方向",
    style: "翻译风格",
    pageSize: "HTML 每页行数",
    translationOutput: "项目译文位置",
    proofreadOutput: "校对报告文件夹",
    splitSize: "每块行数",
    workers: "Agent 数量上限",
    reviewWorkers: "审阅 Agent 数量（留空则跟随翻译）",
    workersEnabled: "使用多个 Agent 并行处理",
    glossaryCandidates: "整理新术语候选",
    characterBible: "维护角色圣经",
    description: "作品背景或特殊要求（可选）",
    descriptionPlaceholder: "补充作品背景、专名读法或本次工作要求。",
    preserveHint: "YN 先用原文样例核对参数，检查 /n、反斜杠转义、代码与控制前缀，并试跑保留规则；修改写回 HTML 共用参数表，再用同一提示词启动翻译，不保留普通正文。",
    savedRules: "当前项目的自定义保留规则",
    noRules: "当前没有已保存的自定义规则。",
    preservationInstructions: "希望保留的内容（可用自然语言描述）",
    preservationPlaceholder: "例如：保留冒号前的角色名、/n 和反斜杠控制码，后面的台词正常翻译。",
    preservationHelp: "不用自己写正则。YN 会结合原文样例生成并试跑规则，再保存到共用参数表；已有规则也会一起核对。",
    proofreadMode: "校对模式",
    splitMode: "分块校对",
    montecarloMode: "多轮抽样校对",
    candidateRatio: "异常行筛选比例",
    montecarloSize: "每轮抽样行数",
    rounds: "校对轮数",
    advanced: "高级设置",
    autoApply: "自动应用校对意见",
    autoApplyHint: "校对意见会自动应用到 HTML 中的译文；最终写入 TXT 仍由你手动操作。",
    browseFile: "选择文件",
    browseFolder: "选择文件夹",
    selectProject: "选择项目",
    start: "确认并启动",
    cancel: "返回",
    assetsStart: "启动资料整理",
    starting: "正在准备并启动…",
    started: { translation: "翻译任务已启动。", proofread: "校对任务已启动。", assets: "资料整理任务已启动。" },
    needProject: "请选择项目文件夹后再启动。",
    needSource: "请选择原文文件或文件夹。",
    needTranslation: "请选择现有译文文件或文件夹后再启动校对。",
    newProject: "新项目",
    file: "文件",
    folder: "文件夹",
    useCurrent: "使用当前项目"
  } : {
    entryTitle: "Let YN prepare your task",
    entrySubtitle: "(One-click AI mode. For more hands-on control, generate the line-by-line HTML first and use its AI features as needed.)",
    translation: "Start translation",
    translationDetail: "Scan the source, prepare preservation rules, and open the translation workspace.",
    proofread: "Proofread an existing translation",
    proofreadDetail: "Check an existing translation and open its proofreading workspace.",
    assets: "Organize reference materials",
    assetsDetail: "Build the project glossary and character bible from its references.",
    materialsLabel: "Reference paths or notes (optional)",
    materialsPlaceholder: "Paste TXT, Markdown, JSON, CSV, TSV, or web references, or describe useful materials.",
    addMaterials: "Add file",
    chooseProject: "Choose project folder",
    assetsProjectHint: "Enter a project path. A missing folder is created; existing projects are reused. Prepare glossary and characters before translation.",
    chooseCurrentProject: "Choose a project first",
    taskTitle: { translation: "Translation settings", proofread: "Proofreading settings" },
    project: "Project folder",
    projectPlaceholder: "Choose or enter the project folder path",
    source: "Source file or folder",
    existingTranslation: "Existing translation file or folder",
    existingTranslationHint: "Proofreading needs an existing translation. Bilingual input reads it from the translation column.",
    continueTranslation: "Continue from an existing translation",
    optional: "optional",
    glossary: "Reference glossary",
    inputMode: "Input format",
    separate: "Separate source and translation",
    bilingual: "Bilingual file",
    fileType: "File type",
    sourceColumn: "Source column",
    translationColumn: "Translation column",
    firstColumn: "First column",
    secondColumn: "Second column",
    languagePair: "Language direction",
    style: "Translation style",
    pageSize: "Lines per HTML page",
    translationOutput: "Project translation location",
    proofreadOutput: "Proofreading report folder",
    splitSize: "Lines per chunk",
    workers: "Agent worker limit",
    reviewWorkers: "Review Agent count (blank follows translation)",
    workersEnabled: "Use multiple Agents in parallel",
    glossaryCandidates: "Collect new glossary candidates",
    characterBible: "Maintain the character bible",
    description: "Work context or special requirements (optional)",
    descriptionPlaceholder: "Add context, proper-name readings, or requirements for this task.",
    preserveHint: "YN checks parameters against source samples, reviews /n, backslash escapes and control prefixes, and trials preservation rules. Changes go into the shared HTML parameter form before the same translation prompt starts; ordinary prose stays translatable.",
    savedRules: "Custom preservation rules saved in this project",
    noRules: "No custom rules are saved in this project.",
    preservationInstructions: "What to preserve (describe it in plain language)",
    preservationPlaceholder: "For example: preserve speaker names before colons, /n and backslash control codes; translate the dialogue after them.",
    preservationHelp: "No regex needed. YN checks source examples, builds and trials rules, then saves them to the shared parameters. Existing rules are checked too.",
    proofreadMode: "Proofreading mode",
    splitMode: "Chunked proofreading",
    montecarloMode: "Multi-round sampled proofreading",
    candidateRatio: "Anomaly candidate ratio",
    montecarloSize: "Sampled lines per round",
    rounds: "Proofreading rounds",
    advanced: "Advanced settings",
    autoApply: "Automatically apply suggestions",
    autoApplyHint: "Suggestions will update the translation in HTML automatically. Writing the final result to TXT remains a manual action.",
    browseFile: "Choose file",
    browseFolder: "Choose folder",
    selectProject: "Select project",
    start: "Confirm and start",
    cancel: "Back",
    assetsStart: "Start materials task",
    starting: "Preparing and starting…",
    started: { translation: "Translation task started.", proofread: "Proofreading task started.", assets: "Reference-material task started." },
    needProject: "Choose a project folder before starting.",
    needSource: "Choose a source file or folder.",
    needTranslation: "Choose the existing translation file or folder before proofreading.",
    newProject: "New project",
    file: "File",
    folder: "Folder",
    useCurrent: "Use current project"
  };
}

export function BuiltinTaskEntry(props: BuiltinTaskEntryProps) {
  const text = copyFor(props.locale);
  const [modalTask, setModalTask] = useState<TaskModalKind | undefined>();
  const [draft, setDraft] = useState<BuiltinTaskSettings>(() => builtinTaskDefaults(props.currentSettings));
  const draftRef = useRef(draft);
  const editedFields = useRef(new Set<keyof BuiltinTaskSettings>());
  const dialogRef = useRef<HTMLElement>(null);
  const startPending = useRef(false);
  const [autoApplyProofread, setAutoApplyProofread] = useState(false);
  const [preservationInstructions, setPreservationInstructions] = useState("");
  const [busyTask, setBusyTask] = useState<BuiltinTaskKind | undefined>();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [assetsProjectDir, setAssetsProjectDir] = useState(props.currentSettings.outputDir);
  const [assetsSettings, setAssetsSettings] = useState<BuiltinTaskSettings>(() => builtinTaskDefaults(props.currentSettings));
  const [materials, setMaterials] = useState("");

  draftRef.current = draft;

  useEffect(() => {
    setAssetsProjectDir(props.currentSettings.outputDir);
    setAssetsSettings(builtinTaskDefaults(props.currentSettings));
  }, [props.currentSettings]);

  useEffect(() => {
    if (!modalTask) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyTask) setModalTask(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [modalTask, busyTask]);

  function patchDraft(patch: Partial<BuiltinTaskSettings>, markEdited = true) {
    if (markEdited) for (const key of Object.keys(patch) as Array<keyof BuiltinTaskSettings>) editedFields.current.add(key);
    setDraft((current) => {
      let next = { ...current, ...patch };
      if (Object.hasOwn(patch, "outputDir")) {
        const nextRoot = String(patch.outputDir ?? "");
        const oldDefaultTranslation = joinPath(current.outputDir, "AI_translation");
        const oldDefaultProofread = joinPath(current.outputDir, "report");
        next = {
          ...next,
          translateOutputDir: !current.translateOutputDir || samePath(current.translateOutputDir, oldDefaultTranslation)
            ? joinPath(nextRoot, "AI_translation") : current.translateOutputDir,
          proofreadOutputDir: !current.proofreadOutputDir || samePath(current.proofreadOutputDir, oldDefaultProofread)
            ? joinPath(nextRoot, "report") : current.proofreadOutputDir
        };
      }
      draftRef.current = next;
      return next;
    });
  }

  function openSettings(task: TaskModalKind) {
    const next = builtinTaskDefaults({
      ...props.currentSettings,
      locale: props.locale,
      customPreserveRules: props.currentSettings.customPreserveRules
    });
    editedFields.current.clear();
    draftRef.current = next;
    setDraft(next);
    setModalTask(task);
    setAutoApplyProofread(false);
    setPreservationInstructions("");
    setError("");
    setStatus("");
  }

  async function selectProjectSettings(outputDir: string, current: BuiltinTaskSettings, preserveEdits: boolean): Promise<BuiltinTaskSettings> {
    const loaded = asRecord(await window.workshop.loadProject(outputDir)) ?? {};
    const rules = normalizeCustomPreserveRules(loaded.customPreserveRules);
    const baseline = restoreTaskInputTranslationPath(loaded, builtinTaskDefaults({
      ...(loaded as Partial<BuiltinTaskSettings>),
      outputDir,
      locale: props.locale,
      customPreserveRules: rules
    }));
    const overrides: Partial<BuiltinTaskSettings> = {};
    for (const key of preserveEdits ? editedFields.current : []) {
      if (key === "outputDir" || key === "locale" || key === "customPreserveRules") continue;
      (overrides as Record<string, unknown>)[key] = current[key];
    }
    return { ...baseline, ...overrides, outputDir, locale: props.locale, customPreserveRules: rules };
  }

  async function chooseProject(target: "modal" | "assets") {
    setError("");
    try {
      const selected = await window.workshop.openProjectFolder();
      if (!selected) return;
      if (target === "modal") {
        const next = await selectProjectSettings(selected, draftRef.current, true);
        draftRef.current = next;
        setDraft(next);
      } else {
        const next = await selectProjectSettings(selected, assetsSettings, false);
        setAssetsSettings(next);
        setAssetsProjectDir(selected);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function chooseSourceFile(field: "sourcePath" | "translationPath") {
    setError("");
    try {
      const selected = await window.workshop.openFile(sourceFilters);
      if (!selected) return;
      const patch: Partial<BuiltinTaskSettings> = { [field]: selected };
      if (field === "sourcePath") {
        patch.sourceKind = "file";
        if (selected.toLowerCase().endsWith(".epub")) patch.fileType = "epub";
        else if (selected.toLowerCase().endsWith(".txt")) patch.fileType = "txt";
      }
      patchDraft(patch);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function chooseSourceFolder(field: "sourcePath" | "translationPath") {
    setError("");
    try {
      const selected = await window.workshop.openFolder();
      if (!selected) return;
      patchDraft({ [field]: selected, ...(field === "sourcePath" ? { sourceKind: "folder" as const, fileType: "auto" as const } : {}) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function chooseTargetFolder(field: "translateOutputDir" | "proofreadOutputDir") {
    setError("");
    try {
      const selected = await window.workshop.openFolder();
      if (selected) patchDraft({ [field]: selected });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function addMaterialFile() {
    setError("");
    try {
      const selected = await window.workshop.openFile(referenceFilters);
      if (selected) setMaterials((current) => current ? `${current}\n${selected}` : selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function startTask(task: BuiltinTaskKind, taskSettings: BuiltinTaskSettings, autoApply = false) {
    let settings = builtinTaskDefaults({ ...taskSettings, locale: props.locale,
      translateOutputDir: joinPath(taskSettings.outputDir, "AI_translation") });
    setError("");
    setStatus("");
    if (!settings.outputDir.trim()) {
      setError(text.needProject);
      return;
    }
    if (task !== "assets" && !settings.sourcePath.trim()) {
      setError(text.needSource);
      return;
    }
    if (task === "proofread" && settings.inputMode !== "bilingual" && !settings.translationPath?.trim()) {
      setError(text.needTranslation);
      return;
    }
    if (task === "translation" && !settings.reuseExistingTranslation) {
      settings = { ...settings, translationPath: "" };
    }
    if (startPending.current) return;
    startPending.current = true;
    setBusyTask(task);
    try {
      props.onStarting();
      if (task === "assets") {
        // Resolve the typed destination independently of the previously selected
        // project; existing bindings win and a new project starts with defaults.
        const materials = settings.materials;
        settings = { ...await selectProjectSettings(settings.outputDir.trim(), settings, false), materials };
      }
      const result = await window.workshop.startBuiltinTask({
        task,
        settings,
        ...(task === "translation" ? { preservationInstructions } : {}),
        ...(task === "proofread" ? { autoApplyProofreadSuggestions: autoApply } : {})
      });
      await props.onStarted(task, result, settings);
      setStatus(text.started[task]);
      setModalTask(undefined);
    } catch (reason) {
      props.onStartFailed(reason);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      startPending.current = false;
      setBusyTask(undefined);
    }
  }

  function changeInputMode(inputMode: BuiltinTaskSettings["inputMode"]) {
    const sourcePosition = inputMode === "bilingual" ? 2 : draft.sourcePosition;
    const translationPosition = inputMode === "bilingual" ? 1 : draft.translationPosition;
    patchDraft({ inputMode, sourcePosition, translationPosition });
  }

  function changeColumn(which: "sourcePosition" | "translationPosition", value: number) {
    const next = value === 1 ? 1 : 2;
    const other = which === "sourcePosition" ? "translationPosition" : "sourcePosition";
    patchDraft({ [which]: next, ...(draft[other] === next ? { [other]: next === 1 ? 2 : 1 } : {}) });
  }

  const canStartProofread = Boolean(
    draft.outputDir.trim() && draft.sourcePath.trim()
    && (draft.inputMode === "bilingual" || draft.translationPath?.trim())
  );

  return (
    <section className="builtinTaskEntry" aria-labelledby="builtinTaskEntryTitle">
      <div className="builtinTaskEntryHeader">
        <div>
          <span className="builtinTaskEyebrow"><Sparkles size={14} /> {props.locale === "zh-CN" ? "内置任务" : "BUILT-IN TASKS"}</span>
          <h2 id="builtinTaskEntryTitle">{text.entryTitle}</h2>
          <p>{text.entrySubtitle}</p>
        </div>
        <div className="builtinTaskProjectTag" title={props.currentSettings.outputDir || text.chooseCurrentProject}>
          <FolderOpen size={16} />
          <span>{props.currentSettings.outputDir || text.chooseCurrentProject}</span>
        </div>
      </div>

      <div className="builtinTaskCards">
        <article className="builtinTaskCard">
          <div className="builtinTaskCardIcon translation"><Languages size={21} /></div>
          <div className="builtinTaskCardCopy">
            <h3>{text.translation}</h3>
            <p>{text.translationDetail}</p>
          </div>
          <button className="builtinTaskButton" type="button" disabled={busyTask !== undefined} onClick={() => openSettings("translation")}>
            <Settings2 size={16} /> {props.locale === "zh-CN" ? "设置任务" : "Set up task"}
          </button>
        </article>

        <article className="builtinTaskCard">
          <div className="builtinTaskCardIcon proofread"><ShieldCheck size={21} /></div>
          <div className="builtinTaskCardCopy">
            <h3>{text.proofread}</h3>
            <p>{text.proofreadDetail}</p>
          </div>
          <button className="builtinTaskButton" type="button" disabled={busyTask !== undefined} onClick={() => openSettings("proofread")}>
            <Settings2 size={16} /> {props.locale === "zh-CN" ? "设置任务" : "Set up task"}
          </button>
        </article>

        <article className="builtinTaskCard builtinTaskAssetsCard">
          <div className="builtinTaskCardIcon assets"><BookOpen size={21} /></div>
          <div className="builtinTaskCardCopy">
            <h3>{text.assets}</h3>
            <p>{text.assetsDetail}</p>
          </div>
          <div className="builtinTaskAssetsProject">
            <label className="builtinTaskField">
              <span>{text.project}</span>
              <div className="builtinTaskPathInput">
                <input className="builtinTaskAssetsProjectInput" value={assetsProjectDir}
                  disabled={busyTask !== undefined} placeholder={text.projectPlaceholder}
                  onChange={(event) => setAssetsProjectDir(event.target.value)} />
                <button type="button" title={text.chooseProject} aria-label={text.chooseProject}
                  disabled={busyTask !== undefined} onClick={() => void chooseProject("assets")}><FolderOpen size={17} /></button>
              </div>
              <small>{text.assetsProjectHint}</small>
            </label>
          </div>
          <label className="builtinTaskMaterials">
            <span>{text.materialsLabel}</span>
            <textarea value={materials} onChange={(event) => setMaterials(event.target.value)} placeholder={text.materialsPlaceholder} rows={2} />
          </label>
          <div className="builtinTaskAssetActions">
            <button className="builtinTaskQuietButton" type="button" onClick={() => void addMaterialFile()}>
              <Upload size={15} /> {text.addMaterials}
            </button>
            <button className="builtinTaskButton" type="button" disabled={!assetsProjectDir || busyTask !== undefined} onClick={() => void startTask("assets", {
              ...assetsSettings,
              outputDir: assetsProjectDir,
              locale: props.locale,
              materials
            })}>
              {busyTask === "assets" ? <LoaderCircle className="builtinTaskSpinner" size={16} /> : <BookOpen size={16} />}
              {busyTask === "assets" ? text.starting : text.assetsStart}
            </button>
          </div>
        </article>
      </div>

      {(error || status) ? <div className={error ? "builtinTaskFeedback error" : "builtinTaskFeedback"} role={error ? "alert" : "status"}>{error || status}</div> : null}

      {modalTask ? (
        <div className="builtinTaskOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busyTask) setModalTask(undefined);
        }}>
          <section className="builtinTaskDialog" role="dialog" aria-modal="true" aria-labelledby="builtinTaskDialogTitle" tabIndex={-1} ref={dialogRef}>
            <header className="builtinTaskDialogHeader">
              <div>
                <span className="builtinTaskEyebrow"><Settings2 size={14} /> {props.locale === "zh-CN" ? "任务设置" : "TASK SETTINGS"}</span>
                <h2 id="builtinTaskDialogTitle">{text.taskTitle[modalTask]}</h2>
              </div>
              <button className="builtinTaskClose" type="button" aria-label={props.locale === "zh-CN" ? "关闭" : "Close"} disabled={busyTask !== undefined} onClick={() => setModalTask(undefined)}><X size={20} /></button>
            </header>

            <div className="builtinTaskDialogBody">
              <div className="builtinTaskFieldGrid">
                <label className="builtinTaskField full">
                  <span>{text.project}</span>
                  <div className="builtinTaskPathInput">
                    <input value={draft.outputDir} onChange={(event) => patchDraft({ outputDir: event.target.value })} placeholder={text.projectPlaceholder} />
                    <button type="button" aria-label={text.selectProject} title={text.selectProject} onClick={() => void chooseProject("modal")}><FolderOpen size={17} /></button>
                  </div>
                </label>

                <div className="builtinTaskField full">
                  <span>{text.source}</span>
                  <div className="builtinTaskPathInput">
                    <input aria-label={text.source} value={draft.sourcePath} onChange={(event) => patchDraft({ sourcePath: event.target.value })} placeholder={text.source} />
                    <button type="button" aria-label={text.browseFile} title={text.browseFile} onClick={() => void chooseSourceFile("sourcePath")}><FileText size={17} /></button>
                    <button type="button" aria-label={text.browseFolder} title={text.browseFolder} onClick={() => void chooseSourceFolder("sourcePath")}><FolderOpen size={17} /></button>
                  </div>
                </div>

                {modalTask === "proofread" && draft.inputMode !== "bilingual" ? (
                  <div className="builtinTaskField full">
                    <span>{text.existingTranslation}</span>
                    <div className="builtinTaskPathInput">
                      <input aria-label={text.existingTranslation} value={draft.translationPath ?? ""} onChange={(event) => patchDraft({ translationPath: event.target.value })} placeholder={text.existingTranslation} />
                      <button type="button" aria-label={text.browseFile} title={text.browseFile} onClick={() => void chooseSourceFile("translationPath")}><FileText size={17} /></button>
                      <button type="button" aria-label={text.browseFolder} title={text.browseFolder} onClick={() => void chooseSourceFolder("translationPath")}><FolderOpen size={17} /></button>
                    </div>
                    <small>{text.existingTranslationHint}</small>
                  </div>
                ) : null}

                <label className="builtinTaskField">
                  <span>{text.inputMode}</span>
                  <select value={draft.inputMode} onChange={(event) => changeInputMode(event.target.value as BuiltinTaskSettings["inputMode"])}>
                    <option value="separate">{text.separate}</option>
                    <option value="bilingual">{text.bilingual}</option>
                  </select>
                </label>
                <label className="builtinTaskField">
                  <span>{text.fileType}</span>
                  <select value={draft.fileType} onChange={(event) => patchDraft({ fileType: event.target.value as BuiltinTaskSettings["fileType"] })}>
                    <option value="auto">auto</option><option value="txt">TXT</option><option value="epub">EPUB</option>
                  </select>
                </label>
                {draft.inputMode === "bilingual" ? <>
                  <label className="builtinTaskField">
                    <span>{text.sourceColumn}</span>
                    <select value={draft.sourcePosition} onChange={(event) => changeColumn("sourcePosition", Number(event.target.value))}>
                      <option value={1}>{text.firstColumn}</option><option value={2}>{text.secondColumn}</option>
                    </select>
                  </label>
                  <label className="builtinTaskField">
                    <span>{text.translationColumn}</span>
                    <select value={draft.translationPosition} onChange={(event) => changeColumn("translationPosition", Number(event.target.value))}>
                      <option value={1}>{text.firstColumn}</option><option value={2}>{text.secondColumn}</option>
                    </select>
                  </label>
                </> : null}

                <label className="builtinTaskField">
                  <span>{text.languagePair}</span>
                  <input value={draft.languagePair ?? ""} onChange={(event) => patchDraft({ languagePair: event.target.value })} placeholder="ja->zh-CN" />
                </label>
                <label className="builtinTaskField">
                  <span>{text.style}</span>
                  <input value={draft.style ?? ""} onChange={(event) => patchDraft({ style: event.target.value })} />
                </label>
                <label className="builtinTaskField full">
                  <span>{text.glossary} ({text.optional})</span>
                  <div className="builtinTaskPathInput">
                    <input aria-label={text.glossary} value={draft.glossaryPath ?? ""} onChange={(event) => patchDraft({ glossaryPath: event.target.value })} />
                    <button type="button" aria-label={text.browseFile} title={text.browseFile} onClick={async () => {
                      try {
                        const selected = await window.workshop.openFile(referenceFilters);
                        if (selected) patchDraft({ glossaryPath: selected });
                      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
                    }}><FileText size={17} /></button>
                  </div>
                </label>
                <label className="builtinTaskField full">
                  <span>{modalTask === "translation" ? text.translationOutput : text.proofreadOutput}</span>
                  <div className="builtinTaskPathInput">
                    <input readOnly={modalTask === "translation"} value={modalTask === "translation" ? joinPath(draft.outputDir, "AI_translation") : draft.proofreadOutputDir ?? ""} onChange={(event) => patchDraft({ proofreadOutputDir: event.target.value })} />
                    {modalTask === "proofread" && <button type="button" aria-label={text.browseFolder} title={text.browseFolder} onClick={() => void chooseTargetFolder("proofreadOutputDir")}><FolderOpen size={17} /></button>}
                  </div>
                </label>

                <label className="builtinTaskField">
                  <span>{text.splitSize}</span>
                  <input type="number" min={1} value={draft.splitSize ?? 500} onChange={(event) => patchDraft({ splitSize: Number(event.target.value) })} />
                </label>
                <label className="builtinTaskField">
                  <span>{text.workers}</span>
                  <input type="number" min={1} value={draft.subagentCount ?? 3} disabled={draft.subagentEnabled === false} onChange={(event) => patchDraft({ subagentCount: Number(event.target.value) })} />
                </label>

                {modalTask === "translation" ? <>
                  <label className="builtinTaskField full builtinTaskCheckbox">
                    <input type="checkbox" checked={draft.reuseExistingTranslation ?? false} onChange={(event) => patchDraft({ reuseExistingTranslation: event.target.checked })} />
                    <span>{text.continueTranslation}</span>
                  </label>
                  {draft.reuseExistingTranslation ? <div className="builtinTaskField full">
                    <span>{text.existingTranslation} ({text.optional})</span>
                    <div className="builtinTaskPathInput">
                      <input value={draft.translationPath ?? ""} onChange={(event) => patchDraft({ translationPath: event.target.value })} />
                      <button type="button" aria-label={text.browseFile} onClick={() => void chooseSourceFile("translationPath")}><FileText size={17} /></button>
                      <button type="button" aria-label={text.browseFolder} onClick={() => void chooseSourceFolder("translationPath")}><FolderOpen size={17} /></button>
                    </div>
                  </div> : null}
                  <div className="builtinTaskNotice"><Sparkles size={18} /><p>{text.preserveHint}</p></div>
                  <div className="builtinTaskExistingRules">
                    <strong>{text.savedRules}</strong>
                    {draft.customPreserveRules?.length ? <ul>{draft.customPreserveRules.map((rule, index) => (
                      <li key={`${rule.pattern}-${index}`}><span>{rule.label || `Rule ${index + 1}`}</span><code>/{rule.pattern}/{rule.flags}</code></li>
                    ))}</ul> : <p>{text.noRules}</p>}
                    <label className="builtinTaskField builtinTaskPreservationInstructions">
                      <span>{text.preservationInstructions}</span>
                      <textarea rows={3} value={preservationInstructions} disabled={busyTask !== undefined} onChange={(event) => setPreservationInstructions(event.target.value)} placeholder={text.preservationPlaceholder} />
                      <small>{text.preservationHelp}</small>
                    </label>
                  </div>
                </> : <>
                  <label className="builtinTaskField">
                    <span>{text.proofreadMode}</span>
                    <select value={draft.proofreadMode ?? "split"} onChange={(event) => patchDraft({ proofreadMode: event.target.value as BuiltinTaskSettings["proofreadMode"] })}>
                      <option value="split">{text.splitMode}</option><option value="montecarlo">{text.montecarloMode}</option>
                    </select>
                  </label>
                  <label className="builtinTaskField">
                    <span>{text.candidateRatio}</span>
                    <input type="number" min={0.1} step={0.1} value={draft.candidateRatio ?? 1.5} onChange={(event) => patchDraft({ candidateRatio: Number(event.target.value) })} />
                  </label>
                </>}

                <label className="builtinTaskField full">
                  <span>{text.description}</span>
                  <textarea rows={3} value={draft.workDescription ?? ""} onChange={(event) => patchDraft({ workDescription: event.target.value })} placeholder={text.descriptionPlaceholder} />
                </label>
              </div>

              <details className="builtinTaskAdvanced">
                <summary><ChevronDown size={16} /> {text.advanced}</summary>
                <div className="builtinTaskFieldGrid">
                  <label className="builtinTaskField">
                    <span>{text.pageSize}</span>
                    <input type="number" min={1} value={draft.pageSize ?? 1000} onChange={(event) => patchDraft({ pageSize: Number(event.target.value) })} />
                  </label>

                  <label className="builtinTaskField full builtinTaskCheckbox">
                    <input type="checkbox" checked={draft.subagentEnabled ?? true} onChange={(event) => patchDraft({ subagentEnabled: event.target.checked })} />
                    <span>{text.workersEnabled}</span>
                  </label>
                  <label className="builtinTaskField">
                    <span>{text.reviewWorkers}</span>
                    <input type="number" min={1} value={draft.reviewSubagentCount ?? ""} placeholder={String(draft.subagentCount ?? 3)} onChange={(event) => patchDraft({ reviewSubagentCount: event.target.value ? Number(event.target.value) : undefined })} />
                  </label>
                  {modalTask === "translation" ? <>
                    <label className="builtinTaskField full builtinTaskCheckbox">
                      <input type="checkbox" checked={draft.glossaryCandidates ?? true} onChange={(event) => patchDraft({ glossaryCandidates: event.target.checked })} />
                      <span>{text.glossaryCandidates}</span>
                    </label>
                    <label className="builtinTaskField full builtinTaskCheckbox">
                      <input type="checkbox" checked={draft.characterBible ?? true} onChange={(event) => patchDraft({ characterBible: event.target.checked })} />
                      <span>{text.characterBible}</span>
                    </label>
                  </> : null}
                  {modalTask === "proofread" && draft.proofreadMode === "montecarlo" ? <>
                    <label className="builtinTaskField">
                      <span>{text.montecarloSize}</span>
                      <input type="number" min={1} value={draft.montecarloSize ?? 3000} onChange={(event) => patchDraft({ montecarloSize: Number(event.target.value) })} />
                    </label>
                    <label className="builtinTaskField">
                      <span>{text.rounds}</span>
                      <div className="builtinTaskRangeInputs">
                        <input aria-label={`${text.rounds} min`} type="number" min={1} value={draft.montecarloRoundMin ?? 2} onChange={(event) => patchDraft({ montecarloRoundMin: Number(event.target.value) })} />
                        <input aria-label={`${text.rounds} max`} type="number" min={1} value={draft.montecarloRoundMax ?? 5} onChange={(event) => patchDraft({ montecarloRoundMax: Number(event.target.value) })} />
                      </div>
                    </label>
                  </> : null}
                </div>
              </details>

              {modalTask === "proofread" ? (
                <label className="builtinTaskAutoApply">
                  <input type="checkbox" checked={autoApplyProofread} onChange={(event) => setAutoApplyProofread(event.target.checked)} />
                  <span><strong>{text.autoApply}</strong><small>{text.autoApplyHint}</small></span>
                  <Check size={17} />
                </label>
              ) : null}

              {error ? <div className="builtinTaskFeedback error" role="alert">{error}</div> : null}
            </div>

            <footer className="builtinTaskDialogFooter">
              <button className="builtinTaskQuietButton" type="button" disabled={busyTask !== undefined} onClick={() => setModalTask(undefined)}>{text.cancel}</button>
              <button className="builtinTaskButton primary" type="button" disabled={busyTask !== undefined || (modalTask === "proofread" && !canStartProofread)} onClick={() => void startTask(modalTask, draft, autoApplyProofread)}>
                {busyTask === modalTask ? <LoaderCircle className="builtinTaskSpinner" size={17} /> : <Check size={17} />}
                {busyTask === modalTask ? text.starting : text.start}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
