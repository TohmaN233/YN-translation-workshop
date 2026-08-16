/**
 * One project-level translation binding.
 *
 * `translationPath` is the user-facing selection (TXT, EPUB, or folder).
 * EPUB extracts and HTML editable snapshots are materializations, not a
 * competing binding. Host proofread and Agent prompts must follow this
 * object instead of whatever leftover path a page happened to embed.
 */
export type TranslationBindingOrigin = "user" | "canonical";

export interface TranslationBinding {
  origin?: TranslationBindingOrigin;
  path?: string;
}

const EXTRACTED_TRANSLATION_RE = /[\\/]\.translation-workshop[\\/]extracted-text[\\/][^\\/]+[\\/]translation[\\/]/i;

export function isExtractedWorkshopTranslationPath(filePath: string | undefined): boolean {
  const value = filePath?.trim() ?? "";
  return value.length > 0 && EXTRACTED_TRANSLATION_RE.test(value.replace(/\\/g, "/"));
}

export function isEpubPath(filePath: string | undefined): boolean {
  return Boolean(filePath && /\.epub$/i.test(filePath.trim()));
}

export function normalizeTranslationBinding(input: {
  path?: unknown;
  origin?: unknown;
}): TranslationBinding {
  const path = typeof input.path === "string" ? input.path.trim() : "";
  const origin = input.origin === "user" || input.origin === "canonical" ? input.origin : undefined;
  if (origin === "user") return path ? { origin, path } : { origin: "user" };
  if (origin === "canonical") return path ? { origin, path } : { origin: "canonical" };
  if (!path || isExtractedWorkshopTranslationPath(path)) return {};
  return { path };
}

export function shouldAutoBindCanonicalTranslation(binding: TranslationBinding): boolean {
  return binding.origin !== "user" && !binding.path;
}

export function userSelectedTranslationPath(binding: TranslationBinding): string | undefined {
  return binding.origin === "user" && binding.path ? binding.path : undefined;
}

export function workflowTranslationPaths(args: {
  sourceIsEpub: boolean;
  selectedTranslationPath?: string;
  selectedTranslationIsEpub?: boolean;
  selectedTranslationWorkingPath?: string;
  editableSnapshotPath?: string;
}): {
  translationPath?: string;
  editableTranslationPath?: string;
  translationPromptPath?: string;
} {
  const selected = args.selectedTranslationPath?.trim();
  if (selected) {
    const working = args.selectedTranslationIsEpub
      ? args.selectedTranslationWorkingPath?.trim() || undefined
      : selected;
    return {
      translationPath: selected,
      ...(working || args.editableSnapshotPath
        ? { editableTranslationPath: working || args.editableSnapshotPath }
        : {}),
      ...(working ? { translationPromptPath: working } : {})
    };
  }
  return {
    ...(args.sourceIsEpub && args.editableSnapshotPath
      ? { editableTranslationPath: args.editableSnapshotPath }
      : {})
  };
}
