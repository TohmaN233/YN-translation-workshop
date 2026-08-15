import { ipcMain, webContents } from "electron";
import path from "node:path";

import {
  approveAssetProposal,
  importProjectGlossaryFile,
  listAssetProposals,
  readProjectAssets,
  replaceProjectGlossaryEntries,
  saveProjectAssets,
  updateProjectGlossaryEntry
} from "../agent/projectAssets.ts";
import { activateWorkspaceAssets, importGeneratedGlossaryCandidates } from "../agent/workspaceAssets.ts";

function requireOutputDir(value: unknown): string {
  const outputDir = typeof value === "string" ? value.trim() : "";
  if (!outputDir || !path.isAbsolute(outputDir)) {
    throw new Error("An absolute output directory is required.");
  }
  return outputDir;
}

function broadcastProjectAssets(outputDir: string, assets: Awaited<ReturnType<typeof readProjectAssets>>): void {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send("agent-assets:projectUpdate", { outputDir, assets });
  }
}

export function registerAgentAssetIpc(): void {
  ipcMain.handle("agent-assets:read", async (_event, args: { outputDir?: unknown }) => {
    return readProjectAssets({ outputDir: requireOutputDir(args?.outputDir) });
  });

  ipcMain.handle("agent-assets:importGlossaryFile", async (_event, args: { outputDir?: unknown; path?: unknown }) => {
    const outputDir = requireOutputDir(args?.outputDir);
    const filePath = typeof args?.path === "string" ? args.path.trim() : "";
    if (!filePath || !path.isAbsolute(filePath)) throw new Error("An absolute glossary file path is required.");
    const assets = await importProjectGlossaryFile({ outputDir, filePath });
    broadcastProjectAssets(outputDir, assets);
    return assets;
  });

  ipcMain.handle("agent-assets:replaceGlossary", async (_event, args: { outputDir?: unknown; entries?: unknown }) => {
    const outputDir = requireOutputDir(args?.outputDir);
    if (!Array.isArray(args?.entries)) throw new Error("Project glossary entries must be an array.");
    const entries = args.entries.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Project glossary entries[${index}] must be an object.`);
      }
      return entry as Record<string, unknown>;
    });
    const assets = await replaceProjectGlossaryEntries({ outputDir, entries });
    broadcastProjectAssets(outputDir, assets);
    return assets;
  });

  ipcMain.handle("agent-assets:updateGlossaryEntry", async (_event, args: { outputDir?: unknown; entry?: unknown }) => {
    const outputDir = requireOutputDir(args?.outputDir);
    if (!args?.entry || typeof args.entry !== "object" || Array.isArray(args.entry)) {
      throw new Error("A project glossary entry object is required.");
    }
    const assets = await updateProjectGlossaryEntry({
      outputDir,
      entry: args.entry as Record<string, unknown>
    });
    broadcastProjectAssets(outputDir, assets);
    return assets;
  });

  ipcMain.handle("agent-assets:workspaceStatus", async (_event, args: { outputDir?: unknown }) => {
    return activateWorkspaceAssets(requireOutputDir(args?.outputDir));
  });

  ipcMain.handle("agent-assets:importGeneratedGlossary", async (_event, args: { outputDir?: unknown }) => {
    const outputDir = requireOutputDir(args?.outputDir);
    const result = await importGeneratedGlossaryCandidates(outputDir);
    broadcastProjectAssets(outputDir, result.assets);
    return result;
  });

  ipcMain.handle("agent-assets:listProposals", async (_event, args: { outputDir?: unknown }) => {
    return listAssetProposals({ outputDir: requireOutputDir(args?.outputDir) });
  });

  ipcMain.handle("agent-assets:approveProposal", async (_event, args: { outputDir?: unknown; proposalId?: unknown; entry?: unknown }) => {
    const proposalId = typeof args?.proposalId === "string" ? args.proposalId.trim() : "";
    if (!proposalId) {
      throw new Error("A proposalId is required.");
    }
    const entry = args?.entry && typeof args.entry === "object" && !Array.isArray(args.entry)
      ? args.entry as Record<string, unknown>
      : undefined;
    const outputDir = requireOutputDir(args?.outputDir);
    const proposal = await approveAssetProposal({
      outputDir,
      proposalId,
      entry,
      approvedBy: "human"
    });
    broadcastProjectAssets(outputDir, await readProjectAssets({ outputDir }));
    return proposal;
  });

  ipcMain.handle("agent-assets:save", async (_event, args: {
    outputDir?: unknown;
    glossaryEntry?: unknown;
    characterEntry?: unknown;
    styleGuide?: unknown;
  }) => {
    const glossaryEntry = args?.glossaryEntry && typeof args.glossaryEntry === "object" && !Array.isArray(args.glossaryEntry)
      ? args.glossaryEntry as Record<string, unknown>
      : undefined;
    const characterEntry = args?.characterEntry && typeof args.characterEntry === "object" && !Array.isArray(args.characterEntry)
      ? args.characterEntry as Record<string, unknown>
      : undefined;
    const outputDir = requireOutputDir(args?.outputDir);
    const assets = await saveProjectAssets({
      outputDir,
      glossaryEntry,
      characterEntry,
      styleGuide: typeof args?.styleGuide === "string" ? args.styleGuide : undefined
    });
    broadcastProjectAssets(outputDir, assets);
    return assets;
  });
}
