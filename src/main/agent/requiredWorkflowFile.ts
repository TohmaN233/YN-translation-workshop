import { readFile } from "node:fs/promises";
import { NonRetryableAssignmentError } from "./piNative/assignmentFailure.ts";

/** A task dependency cannot be recreated by retrying the model's tool call. */
export class RequiredWorkflowFileError extends NonRetryableAssignmentError {
  readonly filePath: string;

  constructor(filePath: string, cause?: unknown, description = "Required workflow file") {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    const missing = cause === undefined || code === "ENOENT" || code === "ENOTDIR";
    super(`${description} ${missing ? "is missing" : "cannot be read"}: ${filePath}${code ? ` (${code})` : ""}. `
      + "Restore this file before resuming the workflow. Existing drafts are retained.",
    cause);
    this.name = "RequiredWorkflowFileError";
    this.filePath = filePath;
  }
}

export async function withRequiredWorkflowFile<T>(filePath: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new RequiredWorkflowFileError(filePath, error);
  }
}

export function readRequiredWorkflowText(filePath: string, signal?: AbortSignal): Promise<string> {
  return withRequiredWorkflowFile(filePath, () => readFile(filePath, { encoding: "utf8", signal }), signal);
}
