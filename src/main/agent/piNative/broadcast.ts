import { BrowserWindow } from "electron";

let htmlViewerTabsRef: Map<string, { view: { webContents: Electron.WebContents } }> = new Map();
const listeners = new Set<(channel: string, payload: unknown) => void>();

export function setPiSessionHtmlViewerTabsRef(
  tabs: Map<string, { view: { webContents: Electron.WebContents } }>
): void {
  htmlViewerTabsRef = tabs;
}

export function broadcastPiSession(channel: string, payload: unknown): void {
  for (const listener of listeners) listener(channel, payload);
  const sent = new Set<number>();
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.webContents.isDestroyed()) continue;
    sent.add(window.webContents.id);
    window.webContents.send(channel, payload);
  }
  for (const tab of htmlViewerTabsRef.values()) {
    const contents = tab.view.webContents;
    if (contents.isDestroyed() || sent.has(contents.id)) continue;
    contents.send(channel, payload);
  }
}

export function subscribePiSessionBroadcast(listener: (channel: string, payload: unknown) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
