import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(root: string, target: string): boolean {
  const comparableRoot = comparable(root);
  const comparableTarget = comparable(target);
  return comparableTarget === comparableRoot || comparableTarget.startsWith(`${comparableRoot}${path.sep}`);
}

function assertRelativeHtmlPath(outputPath: string): string {
  const trimmed = outputPath.trim();
  const hasSchemeOrDrive = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed);
  const pathSegments = trimmed.split(/[\\/]+/);
  if (
    !trimmed
    || trimmed.includes("\0")
    || hasSchemeOrDrive
    || path.isAbsolute(trimmed)
    || path.win32.isAbsolute(trimmed)
    || path.posix.isAbsolute(trimmed)
  ) {
    throw new Error("A batch review child must use a relative HTML path.");
  }
  if (pathSegments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("A batch review child path cannot contain '.' or '..' path segments.");
  }
  if (path.extname(trimmed).toLowerCase() !== ".html") {
    throw new Error("A batch review child must point to an HTML file.");
  }
  return trimmed;
}

async function assertNoDescendantSymlink(root: string, relativePath: string): Promise<void> {
  let cursor = root;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Batch review child does not exist: ${cursor}`);
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Batch review child paths cannot contain symbolic links: ${cursor}`);
    }
  }
}

export async function resolveBatchReviewChildForUpgrade(
  batchIndexPath: string,
  outputPath: string
): Promise<string> {
  const relativeOutputPath = assertRelativeHtmlPath(outputPath);
  const batchDirectory = path.dirname(path.resolve(batchIndexPath));
  const candidatePath = path.resolve(batchDirectory, relativeOutputPath);
  const relativePath = path.relative(batchDirectory, candidatePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Batch review children must stay inside the batch review directory: ${batchDirectory}`);
  }

  await assertNoDescendantSymlink(batchDirectory, relativePath);
  const childInfo = await lstat(candidatePath);
  if (!childInfo.isFile()) {
    throw new Error(`Batch review child is not a file: ${candidatePath}`);
  }

  const [canonicalDirectory, canonicalChild] = await Promise.all([
    realpath(batchDirectory),
    realpath(candidatePath)
  ]);
  if (!isSameOrInside(canonicalDirectory, canonicalChild)) {
    throw new Error(`Batch review children must stay inside the batch review directory: ${canonicalDirectory}`);
  }
  return canonicalChild;
}
