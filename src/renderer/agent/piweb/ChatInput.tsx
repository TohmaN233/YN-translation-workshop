"use client";

import {
  Check,
  CornerDownRight,
  Cpu,
  Image,
  Lightbulb,
  ListPlus,
  LoaderCircle,
  Minimize2,
  Send,
  Square,
  X
} from "lucide-react";
import React, {
  forwardRef,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";

import type {
  PiSessionCompactionResult,
  PiWorkflowPromptMetadata
} from "../../../shared/agent/piSessionContract.ts";
import { THINKING_LEVEL_OPTIONS, type ThinkingLevel } from "../../../shared/agent/thinkingLevels.ts";
import { agentUiStrings, normalizeAgentUiLocale, type AgentUiLocale } from "./i18n";

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string };

interface Props {
  locale: AgentUiLocale;
  onSend: (message: string, workflowMetadata?: PiWorkflowPromptMetadata, images?: AttachedImage[]) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => Promise<void> | void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => Promise<void> | void;
  isStreaming: boolean;
  isCompacting?: boolean;
  compactError?: string | null;
  compactResult?: PiSessionCompactionResult | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  onCompact?: () => Promise<void> | void;
  model?: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  supportsImages?: boolean;
  onModelChange?: (provider: string, modelId: string) => void;
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  slashCommands?: SlashCommandInfo[];
  onBuiltinCommand?: (input: string) => Promise<BuiltinSlashCommandResult> | BuiltinSlashCommandResult;
}

export interface ChatInputHandle {
  insertText: (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => void;
  insertIfEmpty: (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => void;
  replaceText: (text: string, workflowMetadata?: PiWorkflowPromptMetadata) => void;
  openModelPicker: () => void;
  addImages: (files: File[]) => void;
}

const COMPOSITION_END_ENTER_GRACE_MS = 100;
const COMPACTION_NOTICE_MS = 2_000;
const MAX_ATTACHED_IMAGES = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

function slashMatchRank(command: SlashCommandInfo, query: string): number {
  const name = command.name.toLowerCase();
  const description = command.description.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  locale,
  onSend,
  onAbort,
  onSteer,
  onFollowUp,
  isStreaming,
  isCompacting = false,
  compactError,
  compactResult,
  retryInfo,
  onCompact,
  model,
  modelNames,
  modelList,
  supportsImages = false,
  onModelChange,
  thinkingLevel,
  onThinkingLevelChange,
  slashCommands = [],
  onBuiltinCommand
}, ref) {
  const ui = agentUiStrings[normalizeAgentUiLocale(locale)];
  const [value, setValue] = useState("");
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [commandNotice, setCommandNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [visibleCompactResult, setVisibleCompactResult] = useState<PiSessionCompactionResult | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const commandNoticeTimerRef = useRef<number | null>(null);
  const attachedImagesRef = useRef<AttachedImage[]>([]);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const workflowMetadataRef = useRef<PiWorkflowPromptMetadata | undefined>(undefined);

  const showCommandNotice = useCallback((kind: "success" | "error", text: string) => {
    if (commandNoticeTimerRef.current !== null) window.clearTimeout(commandNoticeTimerRef.current);
    setCommandNotice({ kind, text });
    commandNoticeTimerRef.current = window.setTimeout(() => {
      commandNoticeTimerRef.current = null;
      setCommandNotice(null);
    }, 2400);
  }, []);

  const processImageFiles = useCallback((files: File[]) => {
    const images = files.filter((file) => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type));
    if (images.length === 0) return;
    if (!supportsImages) {
      showCommandNotice("error", ui.imageInputUnsupported);
      return;
    }
    let queuedBytes = attachedImages.reduce((total, image) => total + base64ByteLength(image.data), 0);
    for (const file of images.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - attachedImages.length))) {
      if (file.size > MAX_IMAGE_BYTES) {
        showCommandNotice("error", ui.imageTooLarge);
        continue;
      }
      if (queuedBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
        showCommandNotice("error", ui.imagesTooLarge);
        continue;
      }
      queuedBytes += file.size;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        const comma = dataUrl.indexOf(",");
        if (comma < 0) return;
        setAttachedImages((current) => current.length >= MAX_ATTACHED_IMAGES ? current : [...current, {
          data: dataUrl.slice(comma + 1),
          mimeType: file.type,
          previewUrl: URL.createObjectURL(file)
        }]);
      };
      reader.readAsDataURL(file);
    }
  }, [attachedImages, showCommandNotice, supportsImages, ui.imageInputUnsupported, ui.imageTooLarge, ui.imagesTooLarge]);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.minHeight = "0";
    textarea.style.height = "0";
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 24), 200)}px`;
    textarea.style.minHeight = "24px";
  }, []);

  const openModelPicker = useCallback(() => {
    const button = modelButtonRef.current;
    if (!button || button.disabled || !onModelChange) return;
    const rect = button.getBoundingClientRect();
    setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
    setModelDropdownOpen(true);
  }, [onModelChange]);

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string, workflowMetadata?: PiWorkflowPromptMetadata) {
      const current = textareaRef.current?.value ?? value;
      if (current.trim()) return;
      workflowMetadataRef.current = workflowMetadata;
      setValue(text);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        resizeTextarea();
      });
    },
    insertText(text: string, workflowMetadata?: PiWorkflowPromptMetadata) {
      if (workflowMetadata) workflowMetadataRef.current = workflowMetadata;
      const textarea = textareaRef.current;
      if (!textarea) {
        setValue((current) => current + (current ? " " : "") + text);
        return;
      }
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      const before = textarea.value.slice(0, start);
      const separator = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const next = before + separator + text + textarea.value.slice(end);
      setValue(next);
      requestAnimationFrame(() => {
        const position = start + separator.length + text.length;
        textarea.setSelectionRange(position, position);
        textarea.focus();
        resizeTextarea();
      });
    },
    replaceText(text: string, workflowMetadata?: PiWorkflowPromptMetadata) {
      workflowMetadataRef.current = workflowMetadata;
      setValue(text);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(text.length, text.length);
        resizeTextarea();
      });
    },
    openModelPicker,
    addImages: processImageFiles
  }), [openModelPicker, processImageFiles, resizeTextarea, value]);

  const clearInput = useCallback(() => {
    setValue("");
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    workflowMetadataRef.current = undefined;
    setAttachedImages((current) => {
      current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
      return [];
    });
  }, []);

  useEffect(() => () => {
    if (commandNoticeTimerRef.current !== null) window.clearTimeout(commandNoticeTimerRef.current);
  }, []);

  useEffect(() => {
    attachedImagesRef.current = attachedImages;
  }, [attachedImages]);

  useEffect(() => () => {
    attachedImagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, value]);

  const slashQuery = value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;

  const filteredSlashCommands = useMemo(() => {
    if (slashQuery === null) return [];
    return slashCommands
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = command.description.toLowerCase();
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => (
        slashMatchRank(a, slashQuery) - slashMatchRank(b, slashQuery)
        || MODEL_OPTION_COLLATOR.compare(a.name, b.name)
      ));
  }, [slashCommands, slashQuery]);

  const applySlashCommand = useCallback((command: SlashCommandInfo) => {
    const nextValue = `/${command.name}${command.argumentHint ? " " : ""}`;
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextValue.length, nextValue.length);
      resizeTextarea();
    });
  }, [resizeTextarea]);

  const handleSend = useCallback(async () => {
    const message = value.trim();
    if (!message && attachedImages.length === 0) return;
    if (attachedImages.length > 0 && !supportsImages) {
      showCommandNotice("error", ui.imageInputUnsupported);
      return;
    }
    if (message.startsWith("/") && attachedImages.length === 0 && onBuiltinCommand) {
      try {
        const result = await onBuiltinCommand(message);
        if (result.handled) {
          setSlashMenuOpen(false);
          if (result.error) {
            showCommandNotice("error", result.error);
          } else {
            clearInput();
            if (result.message) showCommandNotice("success", result.message);
          }
          return;
        }
      } catch (commandError) {
        showCommandNotice("error", commandError instanceof Error ? commandError.message : String(commandError));
        return;
      }
    }
    if (isStreaming || isCompacting) return;
    const workflowMetadata = workflowMetadataRef.current;
    onSend(message, workflowMetadata, attachedImages);
    clearInput();
  }, [attachedImages, clearInput, isCompacting, isStreaming, onBuiltinCommand, onSend, showCommandNotice, supportsImages, ui.imageInputUnsupported, value]);

  const sendQueued = useCallback(async (kind: "steer" | "followUp") => {
    const message = value.trim();
    if (!message && attachedImages.length === 0) return;
    if (attachedImages.length > 0 && !supportsImages) {
      showCommandNotice("error", ui.imageInputUnsupported);
      return;
    }
    try {
      if (kind === "steer") await onSteer?.(message, attachedImages);
      else await onFollowUp?.(message, attachedImages);
      clearInput();
    } catch (queueError) {
      showCommandNotice("error", queueError instanceof Error ? queueError.message : String(queueError));
    }
  }, [attachedImages, clearInput, onFollowUp, onSteer, showCommandNotice, supportsImages, ui.imageInputUnsupported, value]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = event.nativeEvent;
    const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
    const composing = isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
    if (event.key === "Enter" && !event.shiftKey && (composing || recentlyComposed)) {
      if (recentlyComposed) event.preventDefault();
      return;
    }
    if (slashMenuOpen && slashQuery !== null) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashActiveIndex((index) => Math.max(0, Math.min(filteredSlashCommands.length - 1, index + 1)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashActiveIndex((index) => Math.max(0, index - 1));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
      const activeCommand = filteredSlashCommands[slashActiveIndex];
      if ((event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) && activeCommand) {
        event.preventDefault();
        const exactCommand = activeCommand.name.toLowerCase() === slashQuery;
        if (event.key === "Enter" && exactCommand && !activeCommand.argumentHint) {
          void handleSend();
        } else {
          applySlashCommand(activeCommand);
        }
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (value.trim().startsWith("/") && onBuiltinCommand) void handleSend();
    else if (isCompacting) return;
    else if (isStreaming) void sendQueued(onSteer ? "steer" : "followUp");
    else void handleSend();
  }, [applySlashCommand, filteredSlashCommands, handleSend, isCompacting, isStreaming, onBuiltinCommand, onSteer, sendQueued, slashActiveIndex, slashMenuOpen, slashQuery, value]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    processImageFiles(files);
  }, [processImageFiles]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
  }, [slashQuery]);

  useEffect(() => {
    if (slashActiveIndex >= filteredSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, filteredSlashCommands.length - 1));
    }
    slashItemRefs.current.length = filteredSlashCommands.length;
  }, [filteredSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  const modelOptions = useMemo<ModelOption[]>(() => {
    if (modelList?.length) {
      return modelList
        .map((entry) => ({ provider: entry.provider, modelId: entry.id, name: entry.name }))
        .sort(compareModelOptions);
    }
    return Object.entries(modelNames ?? {})
      .map(([modelId, name]) => ({ provider: model?.provider ?? "unknown", modelId, name }))
      .sort(compareModelOptions);
  }, [model?.provider, modelList, modelNames]);

  const modelsByProvider = useMemo(() => {
    const groups = new Map<string, ModelOption[]>();
    for (const option of modelOptions) {
      groups.set(option.provider, [...(groups.get(option.provider) ?? []), option]);
    }
    return [...groups.entries()].map(([provider, options]) => ({ provider, options }));
  }, [modelOptions]);

  const currentName = model
    ? modelOptions.find((option) => option.provider === model.provider && option.modelId === model.modelId)?.name ?? model.modelId
    : ui.modelLabel;
  const compactSavedTokens = visibleCompactResult
    ? Math.max(0, visibleCompactResult.tokensBefore - visibleCompactResult.estimatedTokensAfter)
    : 0;
  const compactResultText = visibleCompactResult
    ? ui.compactedTokens
      .replace("{before}", formatTokenCount(visibleCompactResult.tokensBefore))
      .replace("{after}", formatTokenCount(visibleCompactResult.estimatedTokensAfter))
      .replace("{saved}", formatTokenCount(compactSavedTokens))
    : null;

  useEffect(() => {
    if (!compactResult) {
      setVisibleCompactResult(null);
      return;
    }
    setVisibleCompactResult(compactResult);
    const timer = window.setTimeout(() => setVisibleCompactResult(null), COMPACTION_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [compactResult?.timestamp]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        modelButtonRef.current && !modelButtonRef.current.contains(target)
        && modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(target)
      ) setModelDropdownOpen(false);
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(target)) {
        setThinkingDropdownOpen(false);
      }
      if (
        target !== textareaRef.current
        && target instanceof Element
        && !target.closest(".ynAgentSlashMenu")
      ) {
        setSlashMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  return (
    <div style={{ flexShrink: 0, background: "transparent", padding: "0 52px 8px 16px" }}>
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <div style={{ position: "relative" }}>
          {commandNotice && (
            <div
              className={`ynAgentCommandNotice ynAgentCommandNotice${commandNotice.kind === "error" ? "Error" : "Success"}`}
              data-agent-command-notice={commandNotice.kind}
              role={commandNotice.kind === "error" ? "alert" : "status"}
            >
              {commandNotice.text}
            </div>
          )}
          {compactError && (
            <div className="ynAgentCommandNotice ynAgentCommandNoticeError" data-agent-compaction-error="true" role="alert">
              {compactError}
            </div>
          )}
          {compactResultText && !compactError && (
            <div className="ynAgentCommandNotice ynAgentCommandNoticeSuccess" data-agent-compaction-result="true" role="status">
              <Check size={12} />
              {compactResultText}
            </div>
          )}
          {retryInfo && (
            <div className="ynAgentCommandNotice ynAgentCommandNoticeRetry" data-agent-auto-retry="true" role="status">
              <LoaderCircle size={12} />
              <span>
                {ui.retrying
                  .replace("{attempt}", String(retryInfo.attempt))
                  .replace("{maxAttempts}", String(retryInfo.maxAttempts))}
              </span>
              {retryInfo.errorMessage && <span className="ynAgentRetryReason">{retryInfo.errorMessage}</span>}
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div className="ynAgentSlashMenu" data-agent-slash-menu="true">
              <div className="ynAgentSlashMenuHeader">
                <span>{ui.commands}</span>
                <span>{filteredSlashCommands.length}</span>
              </div>
              <div className="ynAgentSlashMenuList">
                {filteredSlashCommands.length === 0 ? (
                  <div className="ynAgentSlashMenuEmpty">{ui.noMatchingCommand}</div>
                ) : filteredSlashCommands.map((command, index) => {
                  const active = index === slashActiveIndex;
                  return (
                    <button
                      key={command.name}
                      ref={(node) => { slashItemRefs.current[index] = node; }}
                      className={`ynAgentSlashMenuItem${active ? " active" : ""}`}
                      type="button"
                      data-agent-slash-command={command.name}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applySlashCommand(command);
                      }}
                      onMouseEnter={() => setSlashActiveIndex(index)}
                    >
                      <span className="ynAgentSlashMenuCommand">
                        /{command.name}{command.argumentHint ? ` ${command.argumentHint}` : ""}
                      </span>
                      <span className="ynAgentSlashMenuDescription">{command.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {attachedImages.length > 0 && (
            <div data-agent-image-previews="true" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              {attachedImages.map((image, index) => (
                <div key={`${image.previewUrl}:${index}`} style={{ position: "relative", width: 56, height: 56 }}>
                  <img src={image.previewUrl} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)" }} />
                  <button
                    type="button"
                    aria-label={ui.removeImage}
                    title={ui.removeImage}
                    onClick={() => setAttachedImages((current) => {
                      const selected = current[index];
                      if (selected) URL.revokeObjectURL(selected.previewUrl);
                      return current.filter((_, itemIndex) => itemIndex !== index);
                    })}
                    style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, display: "grid", placeItems: "center", borderRadius: "50%", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", padding: 0 }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            background: "var(--bg)",
            border: `1px solid ${isStreaming && (onSteer || onFollowUp)
              ? "rgba(234,179,8,0.4)"
              : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
            borderRadius: 14,
            padding: "10px 10px 10px 14px",
            boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)"
          }}>
            <textarea
              ref={textareaRef}
              value={value}
              disabled={isCompacting}
              onChange={(event) => {
                if (!event.target.value.trim()) workflowMetadataRef.current = undefined;
                setValue(event.target.value);
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onCompositionStart={() => { isComposingRef.current = true; }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
                lastCompositionEndAtRef.current = Date.now();
              }}
              onInput={resizeTextarea}
              placeholder={isCompacting ? ui.compactingPlaceholder : isStreaming && (onSteer || onFollowUp)
                ? ui.queuePlaceholder
                : isStreaming ? ui.runningPlaceholder : ui.messagePlaceholder}
              rows={1}
              style={{
                flex: 1,
                background: "none",
                border: "none",
                outline: "none",
                padding: "0 2px",
                resize: "none",
                color: "var(--text)",
                fontSize: 14,
                lineHeight: 1.6,
                fontFamily: "inherit",
                minHeight: 24,
                maxHeight: 200,
                overflow: "auto"
              }}
            />
            {isStreaming ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end" }}>
                {onSteer && (
                  <button className="ynAgentInputAction ynAgentInputActionSteer" type="button" disabled={!value.trim() && attachedImages.length === 0} onClick={() => void sendQueued("steer")} aria-label="Steer" title={ui.steerTitle}>
                    <CornerDownRight size={14} />
                  </button>
                )}
                {onFollowUp && (
                  <button className="ynAgentInputAction ynAgentInputActionFollowUp" type="button" disabled={!value.trim() && attachedImages.length === 0} onClick={() => void sendQueued("followUp")} aria-label="Follow-up" title={ui.followUpTitle}>
                    <ListPlus size={14} />
                  </button>
                )}
              </div>
            ) : (
              <button className="ynAgentInputAction ynAgentInputActionSend" type="button" disabled={isCompacting || (!value.trim() && attachedImages.length === 0)} onClick={() => void handleSend()} aria-label="Send" title={ui.sendTitle}>
                <Send size={14} />
              </button>
            )}
          </div>
        </div>

        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center" }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(event) => {
                processImageFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
            <button
              className="ynAgentInputPicker"
              data-agent-attach-image="true"
              type="button"
              disabled={isCompacting}
              aria-label={ui.attachImages}
              title={supportsImages
                ? ui.attachImages
                : ui.imageInputUnsupported}
              onClick={() => supportsImages
                ? fileInputRef.current?.click()
                : showCommandNotice("error", ui.imageInputUnsupported)}
            >
              <Image size={14} />
            </button>
            {model && onModelChange && (
              <div style={{ position: "relative" }}>
                <button
                  ref={modelButtonRef}
                  data-agent-model-button="true"
                  className="ynAgentInputPicker"
                  type="button"
                  disabled={isStreaming || isCompacting || modelOptions.length === 0}
                  title={modelOptions.length === 0 ? ui.loadingModels : ui.selectModel}
                  onClick={() => {
                    if (modelDropdownOpen) setModelDropdownOpen(false);
                    else openModelPicker();
                  }}
                >
                  <Cpu size={14} />
                  <span>{currentName}</span>
                </button>
                {modelDropdownOpen && modelDropdownRect && (
                  <div
                    ref={modelDropdownPanelRef}
                    className="ynAgentInputMenu"
                    data-agent-model-menu="true"
                    style={{
                      position: "fixed",
                      bottom: (window.visualViewport?.height ?? window.innerHeight) - modelDropdownRect.top + 6,
                      left: modelDropdownRect.left,
                      minWidth: modelDropdownRect.width,
                      maxHeight: Math.max(120, Math.min(modelDropdownRect.top - 8, (window.visualViewport?.height ?? window.innerHeight) * 0.6))
                    }}
                  >
                    {modelsByProvider.map((group) => (
                      <section key={group.provider}>
                        {modelsByProvider.length > 1 && <div className="ynAgentInputMenuGroup">{group.provider}</div>}
                        {group.options.map((option) => {
                          const active = option.provider === model.provider && option.modelId === model.modelId;
                          return (
                            <button
                              key={`${option.provider}:${option.modelId}`}
                              type="button"
                              data-agent-model-option={`${option.provider}:${option.modelId}`}
                              className={active ? "ynAgentInputMenuItem active" : "ynAgentInputMenuItem"}
                              onClick={() => {
                                setModelDropdownOpen(false);
                                if (!active) onModelChange(option.provider, option.modelId);
                              }}
                            >
                              {active ? <Check size={12} /> : <span className="ynAgentInputMenuCheck" />}
                              <span>{option.name}</span>
                            </button>
                          );
                        })}
                      </section>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ flex: 1 }} />

          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 2, marginLeft: "auto" }}>
            {!isStreaming && !isCompacting && onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <button data-agent-thinking-button="true" className="ynAgentInputPicker" type="button" title={ui.thinkingLevelTitle} onClick={() => setThinkingDropdownOpen((open) => !open)}>
                  <Lightbulb size={14} />
                  <span>{thinkingLevel ?? "auto"}</span>
                </button>
                {thinkingDropdownOpen && (
                  <div className="ynAgentInputMenu" style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 0, minWidth: 150 }}>
                    {THINKING_LEVEL_OPTIONS.map(({ id: level }) => {
                      const active = (thinkingLevel ?? "auto") === level;
                      return (
                        <button
                          key={level}
                          type="button"
                          className={active ? "ynAgentInputMenuItem active" : "ynAgentInputMenuItem"}
                          onClick={() => {
                            setThinkingDropdownOpen(false);
                            if (!active) onThinkingLevelChange(level);
                          }}
                        >
                          {active ? <Check size={12} /> : <span className="ynAgentInputMenuCheck" />}
                          <span>{level}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {!isStreaming && onCompact && (
              <button
                className="ynAgentInputPicker"
                data-agent-compact-button="true"
                type="button"
                disabled={isCompacting}
                aria-label={ui.compactContext}
                title={isCompacting ? ui.compactingContext : ui.compactContext}
                onClick={() => void Promise.resolve(onCompact()).catch(() => undefined)}
              >
                {isCompacting
                  ? <LoaderCircle className="ynAgentInputCompactSpinner" size={14} />
                  : <Minimize2 size={14} />}
              </button>
            )}
            {isStreaming && (
              <button className="ynAgentInputStop" data-agent-stop="true" type="button" onClick={onAbort} title={ui.stopAgent}>
                <Square size={11} fill="currentColor" />
                <span>{ui.stopAgent}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
