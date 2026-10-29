import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";

const root = process.cwd();

async function loadCommonJsFromSource(relativePath, loader, requireModule, globals = {}) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const compiled = await transform(source, { loader, format: "cjs", jsx: "automatic", target: "node22" });
  const exports = {};
  const module = { exports };
  const context = {
    ...globals,
    exports,
    module,
    require: requireModule,
    console: globals.console ?? console,
    URLSearchParams,
    JSON,
    Error
  };
  vm.runInNewContext(compiled.code, context, { filename: relativePath });
  return { exports: module.exports, context };
}

const FakeBrowserWindow = class {
  constructor(options) {
    this.options = options;
  }
};

const hostModule = await loadCommonJsFromSource(
  "src/main/agent/piNative/agentChatWindowHost.ts",
  "ts",
  moduleName => {
    if (moduleName === "electron") return { BrowserWindow: FakeBrowserWindow };
    if (moduleName === "node:path") return path;
    throw new Error(`Unexpected Agent window host import: ${moduleName}`);
  },
  { process }
);

const rendererContext = {
  window: { location: { hash: "" } },
  console: { error() {} },
  URLSearchParams,
  JSON,
  Error
};
const reactRuntime = {
  useEffect() {},
  useMemo(callback) { return callback(); }
};
const jsxRuntime = {
  jsx(type, props) { return { type, props }; },
  jsxs(type, props) { return { type, props }; }
};
const rendererModule = await loadCommonJsFromSource(
  "src/renderer/agent/PiWebAgentWindow.tsx",
  "tsx",
  moduleName => {
    if (moduleName === "react") return reactRuntime;
    if (moduleName === "react/jsx-runtime") return jsxRuntime;
    if (moduleName === "./piweb/ChatWindow") return { ChatWindow() {} };
    if (moduleName === "./piweb/i18n") return { normalizeAgentUiLocale: value => value === "en-US" ? "en-US" : "zh-CN" };
    throw new Error(`Unexpected Agent window renderer import: ${moduleName}`);
  },
  rendererContext
);

async function openRoute(args) {
  let route;
  await hostModule.exports.openAgentChatWindow({
    args,
    preloadPath: "synthetic-preload.cjs",
    loadRendererRoute: async (_window, value) => { route = value; }
  });
  assert.equal(typeof route, "string", "the popout host must provide a renderer route");
  return route;
}

function parseRoute(route) {
  rendererContext.window.location.hash = `#${route}`;
  return rendererModule.exports.parsePiWebAgentWindowRoute();
}

const folderSourceDocuments = [
  {
    id: "first.epub",
    path: "G:\\synthetic\\project\\AI_translation\\_workspace\\source_documents\\first.epub.txt",
    projection: { kind: "epub-text", originalHash: "a".repeat(64), projectionHash: "b".repeat(64) },
    text: "SYNTHETIC-EPUB-BODY-MUST-NOT-LEAK"
  },
  {
    id: "nested/second.epub",
    path: "G:\\synthetic\\project\\AI_translation\\_workspace\\source_documents\\second.epub.txt",
    projection: { kind: "epub-text", originalHash: "c".repeat(64), projectionHash: "d".repeat(64) },
    rows: [{ source: "SYNTHETIC-ROW-MUST-NOT-LEAK" }]
  }
];
const folderRouteUrl = await openRoute({
  outputDir: "G:\\synthetic\\project",
  locale: "en-US",
  sourcePath: "G:\\synthetic\\input",
  sourceKind: "folder",
  folderSourceDocuments,
  folderSourceSelection: "prepared-inputs"
});
const folderRouteParams = new URLSearchParams(folderRouteUrl.slice(folderRouteUrl.indexOf("?") + 1));
assert.equal(folderRouteParams.get("sourceKind"), "folder");
assert.equal(folderRouteParams.get("folderSourceSelection"), "prepared-inputs");
assert.deepEqual(JSON.parse(folderRouteParams.get("folderSourceDocuments")), folderSourceDocuments.map(({ id, path, projection }) => ({ id, path, projection })));
assert.equal(folderRouteUrl.includes("SYNTHETIC-EPUB-BODY-MUST-NOT-LEAK"), false, "the URL must contain source bindings only, not EPUB text");
assert.equal(folderRouteUrl.includes("SYNTHETIC-ROW-MUST-NOT-LEAK"), false, "the URL must not carry document rows");

const parsedFolderRoute = parseRoute(folderRouteUrl);
assert.equal(parsedFolderRoute.sourceKind, "folder");
assert.equal(parsedFolderRoute.folderSourceSelection, "prepared-inputs");
assert.equal(JSON.stringify(parsedFolderRoute.folderSourceDocuments), JSON.stringify(folderSourceDocuments.map(({ id, path, projection }) => ({ id, path, projection }))));
assert.equal(parsedFolderRoute.folderSourceDocuments[0].projection.originalHash, "a".repeat(64));
assert.equal(parsedFolderRoute.folderSourceDocuments[0].projection.projectionHash, "b".repeat(64));
assert.equal(parsedFolderRoute.folderSourceDocuments[1].projection.originalHash, "c".repeat(64));
assert.equal(parsedFolderRoute.folderSourceDocuments[1].projection.projectionHash, "d".repeat(64));

const singleFileRouteUrl = await openRoute({
  outputDir: "G:\\synthetic\\project",
  sourcePath: "G:\\synthetic\\project\\source.txt",
  sourceKind: "file"
});
const singleFileRoute = parseRoute(singleFileRouteUrl);
assert.equal(singleFileRoute.sourceKind, "file");
assert.equal(Object.hasOwn(singleFileRoute, "folderSourceDocuments"), false);
assert.equal(Object.hasOwn(singleFileRoute, "folderSourceSelection"), false);

const invalidRouteUrl = await openRoute({
  outputDir: "G:\\synthetic\\project",
  sourcePath: "G:\\synthetic\\input",
  sourceKind: "folder",
  folderSourceDocuments,
  folderSourceSelection: "prepared-inputs"
});
const invalidParams = new URLSearchParams(invalidRouteUrl.slice(invalidRouteUrl.indexOf("?") + 1));
invalidParams.set("folderSourceDocuments", "{malformed-json");
const invalidRoute = parseRoute(`agent-chat-window?${invalidParams.toString()}`);
assert.equal(typeof invalidRoute.routeError, "string");
const visibleError = rendererModule.exports.PiWebAgentWindow({ route: invalidRoute });
assert.equal(visibleError.type, "main");
assert.equal(visibleError.props.role, "alert");
assert.equal(visibleError.props.children[2].props.children, invalidRoute.routeError, "the route parse failure is shown in the popout");

const invalidProjectionParams = new URLSearchParams(folderRouteUrl.slice(folderRouteUrl.indexOf("?") + 1));
const invalidProjectionDocuments = JSON.parse(invalidProjectionParams.get("folderSourceDocuments"));
invalidProjectionDocuments[0].projection.projectionHash = "not-a-sha256-hash";
invalidProjectionParams.set("folderSourceDocuments", JSON.stringify(invalidProjectionDocuments));
const invalidProjectionRoute = parseRoute(`agent-chat-window?${invalidProjectionParams.toString()}`);
assert.match(invalidProjectionRoute.routeError, /projection provenance/i);

const staleSingleFileParams = new URLSearchParams(singleFileRouteUrl.slice(singleFileRouteUrl.indexOf("?") + 1));
staleSingleFileParams.set("folderSourceDocuments", JSON.stringify(folderSourceDocuments.map(({ id, path, projection }) => ({ id, path, projection }))));
staleSingleFileParams.set("folderSourceSelection", "prepared-inputs");
const staleSingleFileRoute = parseRoute(`agent-chat-window?${staleSingleFileParams.toString()}`);
assert.equal(typeof staleSingleFileRoute.routeError, "string", "folder bindings on a single-file route must be rejected visibly");

console.log("PASS synthetic folder popout query and renderer route preserve two EPUB projection proofs, reject invalid bindings, and keep single-file routes folder-free");
