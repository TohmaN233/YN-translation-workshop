import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok ${name}`);
    console.log(`  ${error && error.stack ? error.stack : error}`);
  }
}

function functionBody(source, name) {
  const match = source.match(new RegExp(`async function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n  \\}`));
  assert.ok(match, `${name} body not found`);
  return match[1];
}

await test("App open/select async handlers catch rejected IPC promises", async () => {
  const source = await readFile("src/renderer/App.tsx", "utf8");
  assert.match(source, /function showActionError\(error: unknown\)/);
  for (const name of [
    "openProject",
    "openExistingHtml",
    "openReviewHtml",
    "pickFile",
    "pickSourceFile",
    "pickSourceFolder",
    "pickOutput"
  ]) {
    const body = functionBody(source, name);
    assert.match(body, /try \{/);
    assert.match(body, /catch \(error\) \{\s+showActionError\(error\);/);
  }
});

await test("every generated proposal review opens through the review-specific bridge", async () => {
  const appSource = await readFile("src/renderer/App.tsx", "utf8");
  const preloadSource = await readFile("src/main/preload.ts", "utf8");
  const htmlSource = await readFile("src/shared/core/html.ts", "utf8");

  const generateBody = functionBody(appSource, "generateReviewHtml");
  assert.match(generateBody, /window\.workshop\.openReviewHtml\(\{\s*htmlPath: result\.outputPath,\s*outputDir: form\.outputDir\s*\}\)/);
  assert.doesNotMatch(generateBody, /window\.workshop\.openPath\(result\.outputPath\)/);

  const htmlBridge = preloadSource.match(/contextBridge\.exposeInMainWorld\("workshopHtml", \{([\s\S]*?)\n\}\);/)?.[1] ?? "";
  assert.match(htmlBridge, /openReviewHtml: \(args: unknown\) => ipcRenderer\.invoke\("html:openReviewHtml", args\)/);

  const embeddedGenerateBody = htmlSource.match(/async function generateReviewHtmlFromReport\([^)]*\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(embeddedGenerateBody, /bridge\.updateProjectState\(\{[\s\S]*lastProposalReviewHtml: result\.outputPath/);
  assert.match(embeddedGenerateBody, /bridge\.openReviewHtml\(\{\s*htmlPath: result\.outputPath,\s*outputDir\s*\}\)/);
  assert.doesNotMatch(embeddedGenerateBody, /bridge\.openPath\(result\.outputPath\)/);
});

await test("opening a project renders line review first and restores secondary state in the background", async () => {
  const appSource = await readFile("src/renderer/App.tsx", "utf8");
  const preloadSource = await readFile("src/main/preload.ts", "utf8");
  const openProjectBody = functionBody(appSource, "openProject");
  const openTargetsBody = functionBody(appSource, "openLoadedProjectHtml");

  assert.match(preloadSource, /openProjectFolder: \(\) => ipcRenderer\.invoke\("dialog:openProjectFolder"\)/);
  assert.match(openProjectBody, /window\.workshop\.openProjectFolder\(\)/);
  assert.match(openTargetsBody, /lastProposalReviewHtml/);
  assert.match(openTargetsBody, /lastLineReviewHtml/);
  assert.ok(
    openTargetsBody.indexOf("openPath") < openTargetsBody.indexOf("openReviewHtml"),
    "line review must become interactive before the secondary proposal review is restored"
  );
  assert.match(openTargetsBody, /openReviewHtml\(\{[\s\S]*activate: false/);

  const loadProjectBody = functionBody(appSource, "loadProjectState");
  assert.ok(
    loadProjectBody.lastIndexOf("openLoadedProjectHtml") < loadProjectBody.lastIndexOf("readWorkspaceAssetsStatus"),
    "workspace asset discovery must not block the first visible review page"
  );
});

await test("switching to a new project cannot inherit project-scoped paths or proxy state", async () => {
  const appSource = await readFile("src/renderer/App.tsx", "utf8");
  const loadProjectBody = functionBody(appSource, "loadProjectState");
  assert.match(loadProjectBody, /if \(!loaded\)[\s\S]*?rebuildNewProjectForm\(initialFormState\(\), current, selectedKeys, outputDir\)/);
  assert.match(loadProjectBody, /const defaults = initialFormState\(\)/);
  assert.match(loadProjectBody, /\.\.\.defaults,[\s\S]*?\.\.\.loadedForm/);
  assert.match(
    loadProjectBody,
    /translateOutputDir:\s*loaded\.translateOutputDir\s*\?\?\s*defaultTranslateOutputDir\(projectOutputDir\)/
  );
  assert.match(
    loadProjectBody,
    /proofreadOutputDir:\s*loaded\.proofreadOutputDir\s*\?\?\s*defaultProofreadOutputDir\(projectOutputDir\)/
  );
  assert.doesNotMatch(loadProjectBody, /loaded\.agentProxyEnabled\s*\?\?\s*current\.agentProxyEnabled/);
});

await test("the glossary picker binds the selected reference without importing or replacing it with the project asset path", async () => {
  const source = await readFile("src/renderer/App.tsx", "utf8");
  const htmlSource = await readFile("src/shared/core/html.ts", "utf8");
  const pickFileBody = functionBody(source, "pickFile");
  const setBoundGlossaryPathBody = htmlSource.match(/function setBoundGlossaryPath\(path\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

  assert.match(pickFileBody, /patch\(\{ \[key\]: selected \}/);
  assert.doesNotMatch(pickFileBody, /importProjectGlossaryFile/);
  assert.doesNotMatch(source, /setForm\(\(current\) => \(\{ \.\.\.current, glossaryPath: projectGlossaryPath \}\)\)/);
  assert.doesNotMatch(source, /patch\(\{ glossaryPath: projectGlossaryPath \}\)/);
  assert.ok(setBoundGlossaryPathBody, "setBoundGlossaryPath body not found");
  assert.doesNotMatch(setBoundGlossaryPathBody, /updateProjectState/);
  assert.match(htmlSource, /if \(boundGlossaryPath\(\)\) \{\s*await syncGlossaryFromBoundFile\(\)/);
  assert.doesNotMatch(
    htmlSource.match(/async function syncGlossaryFromBoundFile\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "",
    /readProjectAssets/,
    "a selected glossary must be read from its bound path rather than replaced by the canonical project asset"
  );
  assert.match(
    htmlSource,
    /async function adoptBoundGlossaryPath\(path\) \{[\s\S]*?await persistProjectState\(\{ glossaryPath: value \}\);[\s\S]*?setBoundGlossaryPath\(value\);[\s\S]*?\}/,
    "explicit glossary adoption must persist the Agent-facing binding before switching the HTML"
  );
  assert.match(htmlSource, /if \(glossaryPath\) await adoptBoundGlossaryPath\(glossaryPath\)/);
  assert.match(htmlSource, /const canonicalGlossaryIsBound = !boundPath/);
  assert.match(htmlSource, /Object\.prototype\.hasOwnProperty\.call\(value, "glossaryPath"\)/);
  assert.match(htmlSource, /if \(hasGlossaryPath\) \{\s*projectGlossaryPath = glossaryPath;\s*workflowPaths\(\)\.glossaryPath = glossaryPath;/);
  assert.match(htmlSource, /if \(boundGlossaryPath\(\)\) void syncGlossaryFromBoundFile\(\);\s*else void hydrateProjectPromptSettings\(\);/,
    "an explicit empty project binding must clear the stale embedded glossary and restore only a real canonical fallback");
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
