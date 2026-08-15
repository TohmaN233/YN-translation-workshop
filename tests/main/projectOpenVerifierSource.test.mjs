import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [launcher, fixture] = await Promise.all([
  readFile(new URL("../../scripts/verify-electron-project-open.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../scripts/verify-electron-project-open-main.ts", import.meta.url), "utf8")
]);

assert.doesNotMatch(launcher, /child\.kill\s*\(/, "the verifier launcher must not terminate Electron externally");
assert.match(launcher, /YN_ELECTRON_VERIFY_OFFSCREEN:\s*"1"/, "hidden BrowserViews must render offscreen instead of stalling while occluded");
assert.doesNotMatch(fixture, /\.getBrowserView\s*\(/, "the fixture must not use the obsolete single-view API");
assert.match(fixture, /\.getBrowserViews\s*\(/, "the fixture must inspect the multi-view tab host");
assert.match(fixture, /Project-open verifier timed out after 120 seconds/, "the Electron process must own its timeout and shutdown");
assert.match(fixture, /multiBrowserViewTabs:\s*true/, "the verifier must report multi-view coverage");

console.log("project-open verifier source contract passed");
