import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineReviewSidecarStatePath } from '../../src/main/batchLineReviewTxt.ts';
import { prepareReviewHtmlChildOpen, prepareReviewHtmlOpen, readReviewHtmlSourceStamp, type ReviewHtmlOpenContext } from '../../src/main/reviewHtmlUpgrade.ts';

/** Isolated Electron verifiers substitute IPC, while retaining real read-only
 * HTML preparation and saved-state semantics. This never creates a sidecar. */
export function registerReviewHtmlFixtureReadIpc(): void {
  const prepared = new Map<number, Map<string, ReviewHtmlOpenContext>>();
  const fileKey = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const actualParent = (event: IpcMainInvokeEvent) => {
    const url = new URL(event.sender.getURL());
    if (url.protocol !== 'file:') throw new Error('Fixture HTML preparation requires an actual file document.');
    return fileURLToPath(url);
  };
  ipcMain.handle('html:prepareReviewHtmlChild', async (event, args: { outputPath: string }) => {
    const parent = await prepareReviewHtmlOpen(actualParent(event));
    const child = await prepareReviewHtmlChildOpen(parent, args.outputPath);
    let children = prepared.get(event.sender.id);
    if (!children) { children = new Map(); prepared.set(event.sender.id, children); }
    children.set(fileKey(child.filePath), child);
    return { outputPath: args.outputPath };
  });
  ipcMain.handle('html:readLineReviewState', async (event, args: { lineReviewPath: string }) => {
    if (typeof args?.lineReviewPath !== 'string' || !path.isAbsolute(args.lineReviewPath)) throw new Error('Fixture saved-state reads require an absolute HTML path.');
    const target = fileKey(args.lineReviewPath), parent = actualParent(event);
    const context = target === fileKey(parent)
      ? await prepareReviewHtmlOpen(parent)
      : prepared.get(event.sender.id)?.get(target);
    if (!context || context.kind !== 'reviewData') throw new Error('Fixture saved-state read requires its actual prepared line document.');
    if (context.sourceStamp !== await readReviewHtmlSourceStamp(context.filePath)) throw new Error('Fixture HTML changed before saved-state restoration.');
    const statePath = lineReviewSidecarStatePath(context.filePath, context.payload?.workflow?.paths?.outputDir);
    if (!statePath) return { state: undefined };
    try {
      const state: unknown = JSON.parse(await readFile(statePath, 'utf8'));
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error(`Invalid fixture sidecar state: ${statePath}`);
      return { state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: undefined };
      throw error;
    }
  });
}
