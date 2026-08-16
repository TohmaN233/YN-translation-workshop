import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import {
  isEpubPath,
  isExtractedWorkshopTranslationPath,
  normalizeTranslationBinding,
  shouldAutoBindCanonicalTranslation,
  type TranslationBinding,
  type TranslationBindingOrigin
} from "../../shared/core/translationBinding.ts";
import { resolveTranslationCandidatePath } from "./writeTranslationChunk.ts";
import type { PiBoundSourceRequest } from "./piNative/sourceManifest.ts";
import type { PiSessionPromptRequest } from "../../shared/agent/piSessionContract.ts";


export function workshopDirFromOutput(outputDir: string): string {
  const resolved = path.resolve(outputDir);
  return path.basename(resolved).toLowerCase() === ".translation-workshop"
    ? resolved
    : path.join(resolved, ".translation-workshop");
}

export function extractedWorkshopTextPath(
  workspaceDir: string,
  filePath: string,
  role: "source" | "translation"
): string {
  const digest = createHash("sha1").update(path.resolve(filePath).toLowerCase()).digest("hex").slice(0, 10);
  const baseName = path.basename(filePath).replace(/\.[^.]+$/, "") || "document";
  const safe = baseName.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80) || "document";
  return path.join(workspaceDir, "extracted-text", digest, role, `${safe}.txt`);
}

export function materializeTranslationWorkingPath(outputDir: string, selectedPath: string): string {
  if (!isEpubPath(selectedPath)) return path.resolve(selectedPath);
  return extractedWorkshopTextPath(workshopDirFromOutput(outputDir), selectedPath, "translation");
}

export function translationBindingFromRequest(
  request: Pick<PiSessionPromptRequest, "translationPath" | "translationBindingOrigin">
): TranslationBinding {
  return normalizeTranslationBinding({
    path: request.translationPath,
    origin: request.translationBindingOrigin
  });
}

export function resolveUserFolderTranslationPath(folderPath: string, documentId: string): string | undefined {
  const parsed = path.parse(documentId);
  const sameName = path.resolve(folderPath, parsed.dir, parsed.base);
  if (existsSync(sameName) && statSync(sameName).isFile()) return sameName;
  const translatedName = path.resolve(folderPath, parsed.dir, `${parsed.name}_translated.txt`);
  if (existsSync(translatedName) && statSync(translatedName).isFile()) return translatedName;
  return undefined;
}

function isExistingDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function resolveProofreadTranslationPath(args: {
  request: PiBoundSourceRequest;
  folderSource?: boolean;
  documentId: string;
}): string {
  const binding = translationBindingFromRequest(args.request);
  const canonical = resolveTranslationCandidatePath({
    outputDir: args.request.outputDir,
    sourcePaths: args.request.sourcePath ? [path.resolve(args.request.sourcePath)] : [],
    documentId: args.documentId
  });
  const selected = binding.path;
  if (binding.origin === "user" && selected) {
    if (args.folderSource || isExistingDirectory(selected)) {
      return resolveUserFolderTranslationPath(selected, args.documentId) ?? canonical;
    }
    return materializeTranslationWorkingPath(args.request.outputDir, selected);
  }
  if (
    binding.origin !== "canonical"
    && selected
    && !args.folderSource
    && !isExtractedWorkshopTranslationPath(selected)
  ) {
    return materializeTranslationWorkingPath(args.request.outputDir, selected);
  }
  return canonical;
}

export function projectTranslationBinding(state: Record<string, unknown>): TranslationBinding {
  return normalizeTranslationBinding({
    path: state.translationPath,
    origin: state.translationBindingOrigin
  });
}

export function canonicalTranslationBindingPath(args: {
  outputDir: string;
  folderSource: boolean;
  sourcePath?: string;
  documentId?: string;
}): string {
  if (args.folderSource) return path.join(path.resolve(args.outputDir), "AI_translation");
  return resolveTranslationCandidatePath({
    outputDir: args.outputDir,
    sourcePaths: args.sourcePath ? [path.resolve(args.sourcePath)] : [],
    documentId: args.documentId || path.basename(args.sourcePath || "translation.txt")
  });
}

export function shouldPublishCanonicalTranslationBinding(state: Record<string, unknown>): boolean {
  return shouldAutoBindCanonicalTranslation(projectTranslationBinding(state));
}

export type AppliedTranslationBinding = {
  apply: boolean;
  translationPath?: string;
  translationBindingOrigin?: TranslationBindingOrigin;
};

export function applyProjectTranslationBinding(
  request: PiSessionPromptRequest,
  state: Record<string, unknown>
): AppliedTranslationBinding {
  const binding = projectTranslationBinding(state);
  if (binding.origin === "user") {
    return {
      apply: true,
      ...(binding.path ? { translationPath: binding.path } : { translationPath: undefined }),
      translationBindingOrigin: "user"
    };
  }
  if (binding.origin === "canonical" && binding.path) {
    return {
      apply: true,
      translationPath: binding.path,
      translationBindingOrigin: "canonical"
    };
  }
  if (binding.path) {
    return { apply: true, translationPath: binding.path };
  }
  if (isExtractedWorkshopTranslationPath(request.translationPath)) {
    return { apply: true, translationPath: undefined };
  }
  return { apply: false };
}

export async function publishCanonicalTranslationBinding(args: {
  outputDir: string;
  folderSource: boolean;
  sourcePath?: string;
  documentId?: string;
}): Promise<boolean> {
  const { patchProjectState, readProjectState } = await import("../projectState.ts");
  const state = await readProjectState(args.outputDir);
  if (!shouldPublishCanonicalTranslationBinding(state)) return false;
  const translationPath = canonicalTranslationBindingPath(args);
  if (!existsSync(translationPath)) return false;
  if (state.translationBindingOrigin === "canonical" && state.translationPath === translationPath) {
    return false;
  }
  await patchProjectState(args.outputDir, {
    translationPath,
    translationBindingOrigin: "canonical"
  });
  return true;
}
