import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow } from "electron";

app.disableHardwareAcceleration();
let window: BrowserWindow | undefined;
async function read<T = any>(script: string): Promise<T> { return window!.webContents.executeJavaScript(script); }
async function wait(script: string, accept: (value: any) => boolean): Promise<any> {
  const deadline = Date.now() + 5000;
  let value;
  while (Date.now() < deadline) {
    value = await read(script);
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Renderer wait failed: ${script}; last=${JSON.stringify(value)}`);
}
async function screenshot(name: string) {
  const contents = window!.webContents;
  await read("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  contents.debugger.attach("1.3");
  try {
    const { data } = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(path.join(process.env.YN_GUIDANCE_SCREENSHOTS!, name), Buffer.from(data, "base64"));
  } finally { contents.debugger.detach(); }
}
async function run() {
  window = new BrowserWindow({ show: false, width: 1280, height: 960, webPreferences: { offscreen: true } });
  await window.loadFile(path.join(process.env.YN_GUIDANCE_FIXTURE!, "index.html"));
  await wait("Boolean(document.querySelector('.builtinTaskCard'))", Boolean);
  for (const locale of ["zh-CN", "en-US"]) {
    await read(`([...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(locale === "zh-CN" ? "中文" : "English")})).click()`);
    await wait("document.documentElement.lang", value => value === locale);
    // Reset the six-tip rotation to its first entry for the second language.
    if (locale === "en-US") for (let i = 0; i < 5; i++) {
      await read("document.querySelector('.assetProposalsHeader button').click()");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const guide = await read("document.querySelector('.companionBubble p').textContent");
    assert.match(guide, locale === "zh-CN" ? /咱家给出指引：导入术语表后/ : /Yaona offers guidance: After importing a glossary/);
    assert.equal(await read("document.querySelector('.assetProposals > p')"), null, "Tip must not be duplicated in the asset panel");
    await read("document.querySelector('.companionBubble').scrollIntoView({block:'center'})");
    await screenshot(`homepage-guide-${locale}.png`);
    await read("document.querySelector('.assetProposalsHeader button').click()");
    await wait("document.querySelector('.companionBubble p').textContent", value => value !== guide);
    await read("document.querySelector('.builtinTaskCard .builtinTaskButton').click()");
    await wait("Boolean(document.querySelector('.builtinTaskPreservationInstructions textarea'))", Boolean);
    assert.equal(await read("document.querySelector('.builtinTaskPreservationInstructions textarea').value"), "");
    assert.equal(await read("document.querySelector('.builtinTaskExistingRules ul')"), null);
    await read("document.querySelector('.builtinTaskDialog .builtinTaskPathInput button').click()");
    await wait("document.querySelector('.builtinTaskDialog input').value", value => value === "C:/YN-test/project");
    const wishes = locale === "zh-CN" ? "保留冒号前的角色名和 /n，台词正常翻译。" : "Keep names before colons and /n; translate the dialogue.";
    await read(`(() => { const input=document.querySelector('.builtinTaskPreservationInstructions textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(wishes)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.scrollIntoView({block:'center'}); })()`);
    await screenshot(`homepage-preservation-${locale}.png`);
    await read("document.querySelector('.builtinTaskDialogFooter .primary').click()");
    const request = await wait("window.__requests.at(-1)", value => value?.preservationInstructions === wishes);
    assert.equal(request.task, "translation");
    assert.deepEqual(request.settings.customPreserveRules, [], "Natural-language wishes must not become regex before Agent inspection");
    assert.equal(request.settings.splitSize, 500); assert.equal(request.settings.subagentCount, 3);
    await wait("document.querySelector('.builtinTaskClose').disabled", value => value === false);
    await read("document.querySelector('.builtinTaskClose').click()");
  }
  // Saved regex and a new natural-language wish coexist; cancel/reopen clears
  // the temporary wish without changing persisted rules.
  await read("window.__loadedRules=[{label:'Speaker',pattern:'^[^：:\\r\\n]+[：:]',flags:'u'}];document.querySelector('.builtinTaskCard .builtinTaskButton').click()");
  await wait("Boolean(document.querySelector('.builtinTaskDialog'))", Boolean);
  await read("document.querySelector('.builtinTaskDialog .builtinTaskPathInput button').click()");
  await wait("document.querySelector('.builtinTaskExistingRules li code')?.textContent", value => value?.includes("[^"));
  assert.equal(await read("document.querySelector('.builtinTaskPreservationInstructions textarea').value"), "");
  assert.deepEqual(await read("window.__renderErrors"), []);
  assert.equal(window.isVisible(), false);
  console.log(JSON.stringify({ homepageGuidance: true, bilingual: true, naturalLanguageRequest: true, existingRulesRetained: true, windowVisible: false }));
}
void app.whenReady().then(run).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  window?.close(); app.quit();
});
