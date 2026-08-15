export type UpdateCheckMode = "startup" | "manual";

export interface UpdateInfoLike {
  version: string;
}

export interface UpdateProgressLike {
  percent: number;
}

export interface UpdateDialogOptions {
  type: "info" | "warning" | "error" | "question";
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
  noLink?: boolean;
}

export interface UpdateRuntime {
  setAutoDownload: (enabled: boolean) => void;
  setAutoInstallOnQuit: (enabled: boolean) => void;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: () => void;
  onChecking: (listener: () => void) => void;
  onUpdateAvailable: (listener: (info: UpdateInfoLike) => void) => void;
  onUpdateNotAvailable: (listener: (info: UpdateInfoLike) => void) => void;
  onDownloadProgress: (listener: (progress: UpdateProgressLike) => void) => void;
  onUpdateDownloaded: (listener: (info: UpdateInfoLike) => void) => void;
  onError: (listener: (error: Error) => void) => void;
}

export interface UpdateControllerDependencies {
  runtime: UpdateRuntime;
  currentVersion: string;
  isPackaged: boolean;
  canCheckForUpdates: boolean;
  canAutoInstall: boolean;
  releasePageUrl: string;
  showDialog: (options: UpdateDialogOptions) => Promise<{ response: number }>;
  openExternal: (url: string) => Promise<void>;
  setProgress: (progress: number) => void;
  schedule: (callback: () => void, delayMs: number) => void;
  log: (level: "info" | "error", message: string, detail?: string) => void;
}

export interface UpdateController {
  initialize: () => void;
  checkForUpdates: (mode: UpdateCheckMode) => Promise<void>;
  scheduleStartupCheck: (delayMs?: number) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUpdateController(deps: UpdateControllerDependencies): UpdateController {
  let initialized = false;
  let checking = false;
  let downloading = false;
  let activeManualCheck = false;
  let promptOpen = false;
  let errorPromptOpen = false;
  let operationSequence = 0;
  let activeOperationId = 0;
  let failedOperationId = -1;

  const beginOperation = () => {
    activeOperationId = ++operationSequence;
    return activeOperationId;
  };

  const openReleasePage = async () => {
    await deps.openExternal(deps.releasePageUrl);
  };

  const showError = async (error: unknown, notifyUser: boolean, operationId = activeOperationId) => {
    if (failedOperationId === operationId) return;
    failedOperationId = operationId;
    const detail = errorText(error);
    checking = false;
    downloading = false;
    activeManualCheck = false;
    deps.setProgress(-1);
    deps.log("error", "Update operation failed.", detail);
    if (!notifyUser || errorPromptOpen) return;
    errorPromptOpen = true;
    try {
      const result = await deps.showDialog({
        type: "error",
        title: "Update check failed",
        message: "The application could not complete the update check.",
        detail,
        buttons: ["Open releases page", "Close"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      if (result.response === 0) await openReleasePage();
    } finally {
      errorPromptOpen = false;
    }
  };

  const onUpdateAvailable = async (info: UpdateInfoLike) => {
    checking = false;
    activeManualCheck = false;
    deps.log("info", `Update ${info.version} is available.`);
    if (promptOpen) return;
    promptOpen = true;
    try {
      const buttons = deps.canAutoInstall
        ? ["Download update", "Open releases page", "Later"]
        : ["Open releases page", "Later"];
      const result = await deps.showDialog({
        type: "info",
        title: "Update available",
        message: `Translation Workshop ${info.version} is available.`,
        detail: deps.canAutoInstall
          ? `Current version: ${deps.currentVersion}. The update can be downloaded now and installed after restart.`
          : `Current version: ${deps.currentVersion}. This portable build must be updated manually.`,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true
      });
      if (deps.canAutoInstall && result.response === 0) {
        const operationId = beginOperation();
        downloading = true;
        deps.setProgress(0);
        deps.log("info", `Downloading update ${info.version}.`);
        try {
          await deps.runtime.downloadUpdate();
        } catch (error) {
          await showError(error, true, operationId);
        }
        return;
      }
      const openReleaseIndex = deps.canAutoInstall ? 1 : 0;
      if (result.response === openReleaseIndex) await openReleasePage();
    } finally {
      promptOpen = false;
    }
  };

  const initialize = () => {
    if (initialized) return;
    initialized = true;
    if (!deps.canCheckForUpdates) {
      deps.log("info", "Portable Windows build uses release-page updates; electron-updater is disabled.");
      return;
    }
    deps.runtime.setAutoDownload(false);
    deps.runtime.setAutoInstallOnQuit(true);
    deps.runtime.onChecking(() => {
      checking = true;
      deps.log("info", "Checking for updates.");
    });
    deps.runtime.onUpdateAvailable((info) => {
      void onUpdateAvailable(info);
    });
    deps.runtime.onUpdateNotAvailable((info) => {
      const wasManual = activeManualCheck;
      checking = false;
      activeManualCheck = false;
      deps.log("info", `No update is available; latest reported version is ${info.version}.`);
      if (wasManual) {
        void deps.showDialog({
          type: "info",
          title: "No updates available",
          message: `Translation Workshop ${deps.currentVersion} is up to date.`,
          buttons: ["OK"],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
      }
    });
    deps.runtime.onDownloadProgress((progress) => {
      const percent = Number.isFinite(progress.percent) ? Math.min(100, Math.max(0, progress.percent)) : 0;
      deps.setProgress(percent / 100);
    });
    deps.runtime.onUpdateDownloaded((info) => {
      downloading = false;
      deps.setProgress(-1);
      deps.log("info", `Update ${info.version} downloaded.`);
      void deps.showDialog({
        type: "question",
        title: "Update ready",
        message: `Translation Workshop ${info.version} has been downloaded.`,
        detail: "Restart the application to install the update.",
        buttons: ["Restart and install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      }).then((result) => {
        if (result.response === 0) deps.runtime.quitAndInstall();
      });
    });
    deps.runtime.onError((error) => {
      const notifyUser = downloading || activeManualCheck;
      void showError(error, notifyUser);
    });
  };

  const checkForUpdates = async (mode: UpdateCheckMode) => {
    initialize();
    if (!deps.canCheckForUpdates) {
      if (mode === "startup") return;
      const result = await deps.showDialog({
        type: "info",
        title: "Portable updates",
        message: "Portable builds are updated from the releases page.",
        detail: `Current version: ${deps.currentVersion}. Download a newer portable executable when one is available.`,
        buttons: ["Open releases page", "Close"],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      if (result.response === 0) await openReleasePage();
      return;
    }
    if (!deps.isPackaged) {
      deps.log("info", `Skipped ${mode} update check for an unpackaged development build.`);
      if (mode === "manual") {
        const result = await deps.showDialog({
          type: "info",
          title: "Development build",
          message: `Translation Workshop ${deps.currentVersion} is running from source.`,
          detail: "Packaged builds check GitHub Releases for signed release metadata and installers.",
          buttons: ["Open releases page", "Close"],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        });
        if (result.response === 0) await openReleasePage();
      }
      return;
    }
    if (checking || downloading) {
      if (mode === "manual") {
        await deps.showDialog({
          type: "info",
          title: "Update in progress",
          message: downloading ? "An update is already downloading." : "An update check is already running.",
          buttons: ["OK"],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
      }
      return;
    }
    checking = true;
    activeManualCheck = mode === "manual";
    const operationId = beginOperation();
    try {
      await deps.runtime.checkForUpdates();
    } catch (error) {
      if (checking) await showError(error, mode === "manual", operationId);
    }
  };

  const scheduleStartupCheck = (delayMs = 8000) => {
    initialize();
    if (!deps.canCheckForUpdates) return;
    deps.schedule(() => {
      void checkForUpdates("startup");
    }, delayMs);
  };

  return { initialize, checkForUpdates, scheduleStartupCheck };
}
