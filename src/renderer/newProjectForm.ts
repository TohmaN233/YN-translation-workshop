type ProjectPathState = {
  outputDir: string;
  translateOutputDir: string;
  proofreadOutputDir: string;
};

const derivedProjectKeys = new Set<keyof ProjectPathState>([
  "outputDir",
  "translateOutputDir",
  "proofreadOutputDir"
]);

function projectChildPath(outputDir: string, child: string): string {
  const root = outputDir.replace(/[\\/]+$/, "");
  if (!root) return "";
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root}${separator}${child}`;
}

export function rebuildNewProjectForm<T extends ProjectPathState>(
  productDefaults: T,
  current: T,
  selectedKeys: Iterable<keyof T>,
  outputDir: string
): T {
  const selected: Partial<T> = {};
  for (const key of selectedKeys) {
    if (derivedProjectKeys.has(key as keyof ProjectPathState)) continue;
    Object.assign(selected, { [key]: current[key] });
  }
  return {
    ...productDefaults,
    ...selected,
    outputDir,
    translateOutputDir: projectChildPath(outputDir, "AI_translation"),
    proofreadOutputDir: projectChildPath(outputDir, "report")
  };
}
