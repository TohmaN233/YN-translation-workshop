import path from "node:path";

function isInsidePath(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const compareRoot = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const compareTarget = process.platform === "win32" ? normalizedTarget.toLowerCase() : normalizedTarget;
  return compareTarget === compareRoot || compareTarget.startsWith(`${compareRoot}${path.sep}`);
}

function resolveAgainstProject(outputDir: string, inputPath: string): { root: string; target: string } {
  const root = path.resolve(outputDir);
  const trimmed = String(inputPath ?? "").trim();
  if (!trimmed) {
    throw new Error("Path is required.");
  }
  return {
    root,
    target: path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed)
  };
}

/** Resolve a path that must stay inside the translation project directory (outputDir). */
export function resolveProjectPath(outputDir: string, inputPath: string): string {
  const { root, target } = resolveAgainstProject(outputDir, inputPath);
  if (!isInsidePath(root, target)) {
    throw new Error(`Path must stay inside the project directory: ${root}`);
  }
  return target;
}

export type ReadablePathResolution = {
  ok: true;
  path: string;
  relativePath: string;
  outsideProject: boolean;
};

/** Resolve a read-only path. Relative paths default to outputDir; absolute paths remain readable references. */
export function resolveReadablePath(
  outputDir: string,
  inputPath: string
): ReadablePathResolution {
  const { root, target } = resolveAgainstProject(outputDir, inputPath);
  if (isInsidePath(root, target)) {
    return {
      ok: true,
      path: target,
      relativePath: relativeProjectPath(outputDir, target),
      outsideProject: false
    };
  }
  return {
    ok: true,
    path: target,
    relativePath: target,
    outsideProject: true
  };
}

export function relativeProjectPath(outputDir: string, absolutePath: string): string {
  const root = path.resolve(outputDir);
  const resolved = path.resolve(absolutePath);
  if (isInsidePath(root, resolved) && resolved === root) {
    return ".";
  }
  if (!isInsidePath(root, resolved)) {
    throw new Error("Path is outside the project directory.");
  }
  return path.relative(root, resolved).replace(/\\/g, "/");
}
