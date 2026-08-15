import { randomUUID } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const WINDOWS_REPLACE_DEADLINE_MS = 5_000;
const WINDOWS_RETRY_DELAYS_MS = [0, 1, 0, 2, 1, 3] as const;

async function yieldBeforeReplaceRetry(attempt: number): Promise<void> {
  const delay = WINDOWS_RETRY_DELAYS_MS[attempt % WINDOWS_RETRY_DELAYS_MS.length];
  if (delay === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

async function replaceFileAtomically(sourcePath: string, targetPath: string): Promise<void> {
  const deadline = Date.now() + WINDOWS_REPLACE_DEADLINE_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = process.platform === "win32"
        && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
      if (!retryable || Date.now() >= deadline) throw error;
      await yieldBeforeReplaceRetry(attempt);
    }
  }
}

export async function writeTextFileAtomically(targetPath: string, text: string): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, text, "utf8");
    await replaceFileAtomically(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export interface TextFileTransactionUpdate {
  targetPath: string;
  text: string;
}

interface TextFileTransactionOperations {
  lstat: typeof lstat;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
}

interface StagedTextFile extends TextFileTransactionUpdate {
  backupPath: string;
  temporaryPath: string;
  installed: boolean;
  originalMoved: boolean;
}

const defaultTextFileTransactionOperations: TextFileTransactionOperations = {
  lstat,
  rename,
  rm,
  writeFile
};

export async function writeTextFilesAtomically(
  updates: TextFileTransactionUpdate[],
  operationOverrides: Partial<TextFileTransactionOperations> = {}
): Promise<void> {
  if (updates.length === 0) return;
  const operations = { ...defaultTextFileTransactionOperations, ...operationOverrides };
  const transactionId = `${process.pid}.${randomUUID()}`;
  const seenTargets = new Set<string>();
  const staged = updates.map((update, index): StagedTextFile => {
    const targetPath = path.resolve(update.targetPath);
    const comparableTarget = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
    if (seenTargets.has(comparableTarget)) {
      throw new Error(`A text-file transaction cannot update the same target twice: ${targetPath}`);
    }
    seenTargets.add(comparableTarget);
    return {
      targetPath,
      text: update.text,
      temporaryPath: `${targetPath}.${transactionId}.${index}.stage.tmp`,
      backupPath: `${targetPath}.${transactionId}.${index}.backup.tmp`,
      installed: false,
      originalMoved: false
    };
  });

  let transactionCommitted = false;
  let transactionFailed = false;
  let transactionError: unknown;
  try {
    for (const item of staged) {
      const info = await operations.lstat(item.targetPath);
      if (!info.isFile()) throw new Error(`Transactional text target is not a file: ${item.targetPath}`);
      await operations.writeFile(item.temporaryPath, item.text, { encoding: "utf8", flag: "wx" });
    }

    try {
      for (const item of staged) {
        await operations.rename(item.targetPath, item.backupPath);
        item.originalMoved = true;
      }
      for (const item of staged) {
        await operations.rename(item.temporaryPath, item.targetPath);
        item.installed = true;
      }
      transactionCommitted = true;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const item of [...staged].reverse()) {
        if (item.installed) {
          try {
            await operations.rm(item.targetPath, { force: true });
            item.installed = false;
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (item.originalMoved) {
          try {
            await operations.rename(item.backupPath, item.targetPath);
            item.originalMoved = false;
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Text-file transaction failed and could not be fully rolled back."
        );
      }
      throw error;
    }

  } catch (error) {
    transactionFailed = true;
    transactionError = error;
  }

  const finalCleanupErrors: unknown[] = [];
  for (const item of staged) {
    const cleanupPaths = [item.temporaryPath];
    if (transactionCommitted || !item.originalMoved) cleanupPaths.push(item.backupPath);
    for (const cleanupPath of cleanupPaths) {
      let cleanupError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await operations.rm(cleanupPath, { force: true });
          cleanupError = undefined;
          if (cleanupPath === item.backupPath) item.originalMoved = false;
          break;
        } catch (error) {
          cleanupError = error;
          if (attempt === 0) await yieldBeforeReplaceRetry(attempt);
        }
      }
      if (cleanupError !== undefined) finalCleanupErrors.push(cleanupError);
    }
  }
  if (transactionFailed) {
    if (finalCleanupErrors.length > 0) {
      throw new AggregateError(
        [transactionError, ...finalCleanupErrors],
        "Text-file transaction failed and its temporary files could not be fully removed."
      );
    }
    throw transactionError;
  }
  if (finalCleanupErrors.length > 0) {
    console.warn(
      "[atomic-file] Text files were committed, but transaction cleanup remains incomplete.",
      new AggregateError(finalCleanupErrors, "Committed transaction cleanup failed.")
    );
  }
}
