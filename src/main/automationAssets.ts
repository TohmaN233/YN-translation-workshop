import path from "node:path";
import { realpath } from "node:fs/promises";
import { importProjectFormalAssets } from "./agent/projectAssets.ts";

export async function assertAssetProjectPaths(outputDir: string, extraPaths: string[] = []): Promise<string> {
  if (!path.isAbsolute(outputDir)) throw new Error("Asset import requires an absolute project output directory.");
  const root = path.basename(outputDir).toLowerCase() === ".translation-workshop" ? path.dirname(path.resolve(outputDir)) : path.resolve(outputDir);
  const rootReal = await realpath(root);
  for (const directory of [path.join(root, ".translation-workshop"), path.join(root, "AI_translation", "_workspace"), ...extraPaths]) {
    let ancestor = directory;
    for (;;) {
      try {
        const relative = path.relative(rootReal, await realpath(ancestor));
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Formal asset directory resolves outside the project: ${directory}.`);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }
  return root;
}

export async function importAutomationAssets(args: {
  outputDir: string;
  glossary?: Record<string, unknown>[];
  characters?: Record<string, unknown>[];
}) {
  await assertAssetProjectPaths(args.outputDir);
  const result = await importProjectFormalAssets(args);
  return {
    paths: {
      ...(args.glossary !== undefined ? { glossary: result.assets.paths.glossary } : {}),
      ...(args.characters !== undefined ? { characterBible: result.assets.paths.characterBible } : {})
    },
    counts: result.counts
  };
}
