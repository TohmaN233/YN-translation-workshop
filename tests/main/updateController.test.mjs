import assert from "node:assert/strict";

import { createUpdateController } from "../../src/main/updateController.ts";

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fixture(overrides = {}) {
  const listeners = {};
  const calls = {
    autoDownload: [],
    autoInstallOnQuit: [],
    checks: 0,
    downloads: 0,
    installs: 0,
    dialogs: [],
    opened: [],
    progress: [],
    scheduled: []
  };
  const responses = [...(overrides.responses ?? [])];
  const runtime = {
    setAutoDownload(value) { calls.autoDownload.push(value); },
    setAutoInstallOnQuit(value) { calls.autoInstallOnQuit.push(value); },
    async checkForUpdates() {
      calls.checks += 1;
      return overrides.checkForUpdates?.({ listeners, calls });
    },
    async downloadUpdate() {
      calls.downloads += 1;
      return overrides.downloadUpdate?.({ listeners, calls });
    },
    quitAndInstall() { calls.installs += 1; },
    onChecking(listener) { listeners.checking = listener; },
    onUpdateAvailable(listener) { listeners.available = listener; },
    onUpdateNotAvailable(listener) { listeners.notAvailable = listener; },
    onDownloadProgress(listener) { listeners.progress = listener; },
    onUpdateDownloaded(listener) { listeners.downloaded = listener; },
    onError(listener) { listeners.error = listener; }
  };
  const controller = createUpdateController({
    runtime,
    currentVersion: "2.0.0",
    isPackaged: overrides.isPackaged ?? true,
    canCheckForUpdates: overrides.canCheckForUpdates ?? true,
    canAutoInstall: overrides.canAutoInstall ?? true,
    releasePageUrl: "https://example.test/releases/latest",
    async showDialog(options) {
      calls.dialogs.push(options);
      return { response: responses.length > 0 ? responses.shift() : options.cancelId ?? 0 };
    },
    async openExternal(url) { calls.opened.push(url); },
    setProgress(value) { calls.progress.push(value); },
    schedule(callback, delayMs) { calls.scheduled.push({ callback, delayMs }); },
    log() {}
  });
  return { controller, listeners, calls };
}

{
  const { controller, listeners, calls } = fixture({
    canCheckForUpdates: false,
    canAutoInstall: false,
    responses: [0]
  });
  controller.initialize();
  controller.scheduleStartupCheck(25);
  assert.deepEqual(calls.autoDownload, []);
  assert.deepEqual(calls.autoInstallOnQuit, []);
  assert.deepEqual(Object.keys(listeners), []);
  assert.equal(calls.scheduled.length, 0);
  assert.equal(calls.checks, 0);
  await controller.checkForUpdates("manual");
  assert.equal(calls.checks, 0);
  assert.equal(calls.dialogs[0].title, "Portable updates");
  assert.deepEqual(calls.opened, ["https://example.test/releases/latest"]);
}

{
  const { controller, calls } = fixture();
  controller.initialize();
  controller.initialize();
  assert.deepEqual(calls.autoDownload, [false]);
  assert.deepEqual(calls.autoInstallOnQuit, [true]);
  controller.scheduleStartupCheck(25);
  assert.equal(calls.scheduled.length, 1);
  assert.equal(calls.scheduled[0].delayMs, 25);
  calls.scheduled[0].callback();
  await tick();
  assert.equal(calls.checks, 1);
}

{
  const { controller, listeners, calls } = fixture({ responses: [0] });
  await controller.checkForUpdates("manual");
  listeners.available({ version: "2.1.0" });
  await tick();
  assert.equal(calls.downloads, 1);
  assert.equal(calls.dialogs[0].title, "Update available");
}

{
  const { controller, listeners, calls } = fixture({ canAutoInstall: false, responses: [0] });
  await controller.checkForUpdates("manual");
  listeners.available({ version: "2.1.0" });
  await tick();
  assert.equal(calls.downloads, 0);
  assert.deepEqual(calls.opened, ["https://example.test/releases/latest"]);
}

{
  const { controller, listeners, calls } = fixture({ responses: [0] });
  controller.initialize();
  listeners.downloaded({ version: "2.1.0" });
  await tick();
  assert.equal(calls.installs, 1);
  assert.equal(calls.progress.at(-1), -1);
}

{
  const { controller, calls } = fixture({ isPackaged: false, responses: [1] });
  await controller.checkForUpdates("manual");
  assert.equal(calls.checks, 0);
  assert.equal(calls.dialogs[0].title, "Development build");
}

{
  const failure = new Error("download failed");
  const { controller, listeners, calls } = fixture({
    responses: [0, 1],
    async downloadUpdate() {
      listeners.error(failure);
      await tick();
      throw failure;
    }
  });
  await controller.checkForUpdates("manual");
  listeners.available({ version: "2.1.0" });
  await tick();
  await tick();
  assert.deepEqual(
    calls.dialogs.map((dialog) => dialog.title),
    ["Update available", "Update check failed"]
  );
}

{
  const failure = new Error("manual check failed");
  const { controller, listeners, calls } = fixture({
    responses: [1],
    async checkForUpdates() {
      listeners.error(failure);
      await tick();
      throw failure;
    }
  });
  await controller.checkForUpdates("manual");
  assert.deepEqual(calls.dialogs.map((dialog) => dialog.title), ["Update check failed"]);
}

{
  const failure = new Error("startup check failed");
  const { controller, listeners, calls } = fixture({
    async checkForUpdates() {
      listeners.error(failure);
      await tick();
      throw failure;
    }
  });
  await controller.checkForUpdates("startup");
  assert.equal(calls.dialogs.length, 0);
}

{
  const { controller, listeners, calls } = fixture();
  controller.initialize();
  listeners.progress({ percent: -25 });
  listeners.progress({ percent: 175 });
  assert.deepEqual(calls.progress, [0, 1]);
}

console.log("updateController tests passed");
