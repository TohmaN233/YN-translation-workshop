import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { app, BrowserWindow, dialog, shell, type MessageBoxOptions } from "electron";
import electronUpdater from "electron-updater";

import { createUpdateController, type UpdateController, type UpdateDialogOptions } from "./updateController.ts";

export const repositoryUrl = "https://github.com/TohmaN233/YN-translation-workshop";
export const releasesUrl = `${repositoryUrl}/releases/latest`;

const { autoUpdater } = electronUpdater;
let controller: UpdateController | undefined;

function writeUpdateLog(level: "info" | "error", message: string, detail?: string): void {
  const suffix = detail ? ` ${detail}` : "";
  const line = `${new Date().toISOString()} [${level}] ${message}${suffix}\n`;
  if (level === "error") console.error(`[updates] ${message}`, detail ?? "");
  else console.info(`[updates] ${message}`, detail ?? "");
  const logDir = app.getPath("logs");
  void mkdir(logDir, { recursive: true })
    .then(() => appendFile(path.join(logDir, "updates.log"), line, "utf8"))
    .catch((error) => console.error("[updates] Failed to write update log.", error));
}

async function showUpdateDialog(options: UpdateDialogOptions): Promise<{ response: number }> {
  const messageBoxOptions: MessageBoxOptions = options;
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return owner
    ? dialog.showMessageBox(owner, messageBoxOptions)
    : dialog.showMessageBox(messageBoxOptions);
}

function setUpdateProgress(progress: number): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.setProgressBar(progress);
  }
}

function getController(): UpdateController {
  if (controller) return controller;
  const portableWindowsBuild = process.platform === "win32" && Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
  controller = createUpdateController({
    runtime: {
      setAutoDownload: (enabled) => {
        autoUpdater.autoDownload = enabled;
      },
      setAutoInstallOnQuit: (enabled) => {
        autoUpdater.autoInstallOnAppQuit = enabled;
      },
      checkForUpdates: () => autoUpdater.checkForUpdates(),
      downloadUpdate: () => autoUpdater.downloadUpdate(),
      quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
      onChecking: (listener) => {
        autoUpdater.on("checking-for-update", listener);
      },
      onUpdateAvailable: (listener) => {
        autoUpdater.on("update-available", (info) => listener({ version: info.version }));
      },
      onUpdateNotAvailable: (listener) => {
        autoUpdater.on("update-not-available", (info) => listener({ version: info.version }));
      },
      onDownloadProgress: (listener) => {
        autoUpdater.on("download-progress", (progress) => listener({ percent: progress.percent }));
      },
      onUpdateDownloaded: (listener) => {
        autoUpdater.on("update-downloaded", (info) => listener({ version: info.version }));
      },
      onError: (listener) => {
        autoUpdater.on("error", listener);
      }
    },
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    canCheckForUpdates: !portableWindowsBuild,
    canAutoInstall: !portableWindowsBuild,
    releasePageUrl: releasesUrl,
    showDialog: showUpdateDialog,
    openExternal: async (url) => {
      await shell.openExternal(url);
    },
    setProgress: setUpdateProgress,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
    },
    log: writeUpdateLog
  });
  return controller;
}

export function initializeAutoUpdates(): void {
  getController().initialize();
}

export function scheduleStartupUpdateCheck(delayMs?: number): void {
  getController().scheduleStartupCheck(delayMs);
}

export async function checkForUpdatesManually(): Promise<void> {
  await getController().checkForUpdates("manual");
}
