import type {
  PiSessionPromptRequest,
  PiSessionImageAttachment,
  PiSessionInputRequest,
  PiFolderSourceDocument,
  PiProofreadMode,
  PiSourceSelection,
  PiWorkflowIntent
} from "../../shared/agent/piSessionContract.ts";
import { normalizeCustomPreserveRules } from "../../shared/validation/customPreserveRules.ts";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_COUNT = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

function matchesImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    const header = bytes.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }
  return mimeType === "image/webp"
    && bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function requiredText(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function optionalMessageText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function imageAttachments(value: unknown): PiSessionImageAttachment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IMAGE_COUNT) {
    throw new Error(`images must contain between 1 and ${MAX_IMAGE_COUNT} attachments.`);
  }
  let totalBytes = 0;
  const images = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`images[${index}] must be an image object.`);
    }
    const image = entry as Record<string, unknown>;
    if (image.type !== "image") throw new Error(`images[${index}].type must be image.`);
    const mimeType = requiredText(image.mimeType, `images[${index}].mimeType`).toLowerCase();
    if (!IMAGE_MIME_TYPES.has(mimeType)) throw new Error(`images[${index}] uses an unsupported image type.`);
    const data = requiredText(image.data, `images[${index}].data`);
    if (data.startsWith("data:")) throw new Error(`images[${index}].data must contain raw base64 without a data URL prefix.`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new Error(`images[${index}].data must be valid base64.`);
    }
    const decoded = Buffer.from(data, "base64");
    const bytes = decoded.byteLength;
    if (bytes < 1 || bytes > MAX_IMAGE_BYTES) throw new Error(`images[${index}] exceeds the image size limit.`);
    if (!matchesImageSignature(decoded, mimeType)) {
      throw new Error(`images[${index}] content does not match its declared image type.`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error("images exceed the total attachment size limit.");
    return { type: "image" as const, data, mimeType };
  });
  return images;
}

function assertExtractedTextPath(value: string | undefined, name: string): string | undefined {
  if (value && /\.epub$/i.test(value)) {
    throw new Error(`${name} cannot be an EPUB binary path; provide the extracted UTF-8 text path.`);
  }
  return value;
}

function workflowIntent(value: unknown): PiWorkflowIntent | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "translation" || value === "proofread") return value;
  throw new Error("workflowIntent must be translation or proofread.");
}

function proofreadMode(value: unknown): PiProofreadMode | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "split" || value === "montecarlo") return value;
  throw new Error("proofreadMode must be split or montecarlo.");
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function optionalPositiveIntegerArray(value: unknown, name: string): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of positive integers.`);
  const values = value.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1) {
      throw new Error(`${name}[${index}] must be a positive integer.`);
    }
    return entry;
  });
  return [...new Set(values)].sort((left, right) => left - right);
}

function sourceSelection(value: unknown): PiSourceSelection | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sourceSelection must be a file or folder selection object.");
  }
  const selection = value as Record<string, unknown>;
  if (selection.kind !== "file" && selection.kind !== "folder") {
    throw new Error("sourceSelection.kind must be file or folder.");
  }
  const selectedPath = requiredText(selection.path, "sourceSelection.path");
  if (selection.kind === "file") assertExtractedTextPath(selectedPath, "sourceSelection.path");
  return { kind: selection.kind, path: selectedPath };
}

function folderSourceDocuments(value: unknown): PiFolderSourceDocument[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("folderSourceDocuments must be a non-empty array.");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`folderSourceDocuments[${index}] must be an object.`);
    }
    const document = entry as Record<string, unknown>;
    return {
      id: requiredText(document.id, `folderSourceDocuments[${index}].id`),
      path: assertExtractedTextPath(
        requiredText(document.path, `folderSourceDocuments[${index}].path`),
        `folderSourceDocuments[${index}].path`
      )!
    };
  });
}

export function parsePiSessionPromptRequest(
  raw: Partial<PiSessionPromptRequest> | undefined
): PiSessionPromptRequest {
  const subagentProviderId = optionalText(raw?.subagentProviderId);
  const subagentModelId = optionalText(raw?.subagentModelId);
  if (Boolean(subagentProviderId) !== Boolean(subagentModelId)) {
    throw new Error("subagentProviderId and subagentModelId must be provided together.");
  }
  const images = imageAttachments(raw?.images);
  const prompt = optionalMessageText(raw?.prompt);
  if (!prompt && !images?.length) throw new Error("prompt or images are required.");
  return {
    outputDir: requiredText(raw?.outputDir, "outputDir"),
    sessionId: requiredText(raw?.sessionId, "sessionId"),
    prompt,
    images,
    providerId: requiredText(raw?.providerId, "providerId"),
    modelId: requiredText(raw?.modelId, "modelId"),
    thinkingLevel: raw?.thinkingLevel,
    workflowIntent: workflowIntent(raw?.workflowIntent),
    languagePair: optionalText(raw?.languagePair),
    style: optionalText(raw?.style),
    workDescription: optionalText(raw?.workDescription),
    glossaryPath: optionalText(raw?.glossaryPath),
    glossaryCandidates: optionalBoolean(raw?.glossaryCandidates, "glossaryCandidates"),
    characterBible: optionalBoolean(raw?.characterBible, "characterBible"),
    reuseExistingTranslation: optionalBoolean(raw?.reuseExistingTranslation, "reuseExistingTranslation"),
    auditWhitelistLines: optionalPositiveIntegerArray(raw?.auditWhitelistLines, "auditWhitelistLines"),
    customPreserveRules: normalizeCustomPreserveRules(raw?.customPreserveRules),
    subagentEnabled: optionalBoolean(raw?.subagentEnabled, "subagentEnabled"),
    subagentCount: optionalPositiveInteger(raw?.subagentCount, "subagentCount"),
    reviewSubagentCount: optionalPositiveInteger(raw?.reviewSubagentCount, "reviewSubagentCount"),
    subagentProviderId,
    subagentModelId,
    translationSplitSize: optionalPositiveInteger(raw?.translationSplitSize, "translationSplitSize"),
    folderTranslationOrder: optionalText(raw?.folderTranslationOrder),
    folderSourceDocuments: folderSourceDocuments(raw?.folderSourceDocuments),
    sourcePath: assertExtractedTextPath(optionalText(raw?.sourcePath), "sourcePath"),
    sourceSelection: sourceSelection(raw?.sourceSelection),
    translationPath: assertExtractedTextPath(optionalText(raw?.translationPath), "translationPath"),
    lineReviewPath: optionalText(raw?.lineReviewPath),
    proofreadMode: proofreadMode(raw?.proofreadMode),
    proofreadSplitSize: optionalPositiveInteger(raw?.proofreadSplitSize, "proofreadSplitSize"),
    proofreadMontecarloSize: optionalPositiveInteger(raw?.proofreadMontecarloSize, "proofreadMontecarloSize"),
    proofreadMontecarloRoundMin: optionalPositiveInteger(raw?.proofreadMontecarloRoundMin, "proofreadMontecarloRoundMin"),
    proofreadMontecarloRoundMax: optionalPositiveInteger(raw?.proofreadMontecarloRoundMax, "proofreadMontecarloRoundMax")
  };
}

export function parsePiSessionInputRequest(raw: Partial<PiSessionInputRequest> | undefined): PiSessionInputRequest {
  if (raw?.kind !== "steer" && raw?.kind !== "followUp") {
    throw new Error("kind must be steer or followUp.");
  }
  const images = imageAttachments(raw.images);
  const text = optionalMessageText(raw.text);
  if (!text && !images?.length) throw new Error("text or images are required.");
  return {
    outputDir: requiredText(raw.outputDir, "outputDir"),
    sessionId: requiredText(raw.sessionId, "sessionId"),
    kind: raw.kind,
    text,
    images
  };
}
