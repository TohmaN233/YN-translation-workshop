import { strict as assert } from "node:assert";

import { buildProofreadPrompt, buildTranslatePrompt, promptParameterDefaults } from "../../src/shared/core/prompts.ts";
import { buildYnSystemPrompt } from "../../src/main/agent/piNative/systemPrompt.ts";

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

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}

await test("translate prompt names the native workflow and output directory without runtime boilerplate", () => {
  const prompt = buildTranslatePrompt({
    sourcePath: "source.txt",
    outputDir: "project",
    glossaryPath: "glossary.json",
    advanced: { languagePair: "ja->zh-CN", style: "game", splitSize: 500 }
  });
  assert.match(prompt, /Workflow: yn-translation-v1/);
  assert.match(prompt, /Language pair: ja->zh-CN/);
  assert.match(prompt, /Text\/domain style: game/);
  assert.match(prompt, /Output directory: project\/AI_translation/);
  assert.match(prompt, /Selected glossary: glossary\.json/);
  assert.match(prompt, /Character bible: on/);
  assert.match(prompt, /Subagents: enabled; maximum=3/);
  assert.match(prompt, /Translation review Agents: maximum=3/);
  assert.doesNotMatch(prompt, /Existing translation\/reference path/);
  assert.doesNotMatch(prompt, /Translation path:/);
  assert.doesNotMatch(prompt, /Runtime contract/);
  assert.doesNotMatch(prompt, /Host-tool workflow/);
  assert.doesNotMatch(prompt, /^\$translate-text/m);
  assert.doesNotMatch(prompt, /^\/translate-text/m);
});

await test("translation prompt honors the selected native child count", () => {
  promptParameterDefaults("project");
  const prompt = buildTranslatePrompt({
    sourcePath: "source.txt",
    outputDir: "project",
    advanced: {
      glossaryCandidates: false,
      characterBible: false,
      subagentEnabled: true,
      subagentCount: 5
    }
  });
  assert.match(prompt, /Subagents: enabled; maximum=5/);
  assert.match(prompt, /Translation review Agents: maximum=5/);
  assert.match(prompt, /Glossary candidates: off/);
  assert.match(prompt, /Character bible: off/);
  assert.doesNotMatch(prompt, /CALL SUBAGENT/);
  assert.doesNotMatch(prompt, /Before calling subagents\/spawnSubagent/);
  assert.doesNotMatch(prompt, /Assigned range: L\{fromLine\}-L\{toLine\}/);
});

await test("proofread prompt names the native workflow and keeps findings contract", () => {
  const prompt = buildProofreadPrompt({
    sourcePath: "source.txt",
    translationPath: "translation.txt",
    outputDir: "project",
    advanced: { languagePair: "ja->zh-CN", proofreadMode: "split", splitSize: 1000 }
  });
  assert.match(prompt, /Workflow: yn-proofread-v1/);
  assert.match(prompt, /Output directory: project\/report/);
  assert.match(prompt, /Mode: split 1000/);
  assert.match(prompt, /Subagents: enabled; maximum=3/);
  assert.match(prompt, /translation\.proofread\.json/);
  assert.doesNotMatch(prompt, /\.md\b|summary/i);
  assert.doesNotMatch(prompt, /Runtime contract/);
  assert.doesNotMatch(prompt, /Host-tool workflow/);
  assert.doesNotMatch(prompt, /^\$proofread-translation/m);
  assert.doesNotMatch(prompt, /^\/proofread-translation/m);
});

await test("existing translation reuse audit is explicit and defaults to direct retranslation", () => {
  const defaults = promptParameterDefaults("project");
  assert.equal(defaults.reuseExistingTranslation, false);
  assert.equal(defaults.splitSize, 1000);

  const direct = buildTranslatePrompt({
    sourcePath: "source.txt",
    outputDir: "project"
  });
  assert.match(direct, /Existing translation: discard and retranslate/i);

  const audited = buildTranslatePrompt({
    sourcePath: "source.txt",
    outputDir: "project",
    advanced: { reuseExistingTranslation: true }
  });
  assert.match(audited, /Existing translation: audit and reuse/i);

  const directSystem = buildYnSystemPrompt({
    outputDir: "project",
    sourcePath: "source.txt",
    sessionId: "direct-retranslation",
    prompt: direct,
    workflowIntent: "translation",
    reuseExistingTranslation: false
  });
  assert.doesNotMatch(directSystem, /call prepareTranslationReuseAudit/i);
  assert.match(directSystem, /back up and discard meaningful existing candidates/i);

  const auditedSystem = buildYnSystemPrompt({
    outputDir: "project",
    sourcePath: "source.txt",
    sessionId: "audited-reuse",
    prompt: audited,
    workflowIntent: "translation",
    reuseExistingTranslation: true
  });
  assert.match(auditedSystem, /call prepareTranslationReuseAudit/i);
  assert.match(auditedSystem, /Do not call resumeYnWorkflow/i);
});

await test("generated glossary prompt excludes ordinary dictionary vocabulary", () => {
  const prompt = buildTranslatePrompt({
    sourcePath: "source.txt",
    outputDir: "project",
    advanced: { glossaryCandidates: true, characterBible: true }
  });
  assert.match(prompt, /glossary_candidates\.json/);
  const system = buildYnSystemPrompt({
    outputDir: "project",
    sourcePath: "source.txt",
    sessionId: "asset-contract",
    prompt,
    workflowIntent: "translation",
    glossaryCandidates: true,
    characterBible: true,
    subagentEnabled: false
  });
  assert.match(system, /exclude ordinary vocabulary and uncertain entries/i);
  assert.match(system, /before writing the character bible.*searchProjectText/i);
  assert.match(system, /stop searching that character once the evidence establishes/i);
  assert.match(system, /- Gender\/pronouns: .*confidence: confirmed\|inferred\|unknown/i);
  assert.match(system, /- Terms of address:/i);
});

await test("prompt model selection is explicit while defaulting children to the parent Pi model", () => {
  const inherited = buildTranslatePrompt({
    sourcePath: "source.txt",
    outputDir: "project"
  });
  assert.match(inherited, /Subagent model: follow the parent Agent model/);
  const selected = buildTranslatePrompt({
    sourcePath: "source.txt",
    outputDir: "project",
    advanced: { subagentProviderId: "openai-codex", subagentModelId: "gpt-5.6" }
  });
  assert.match(selected, /Subagent model: use configured Pi model openai-codex\/gpt-5\.6/);
});

await test("subagent enable and count settings remain part of the native prompt contract", () => {
  const disabled = buildTranslatePrompt({
    sourcePath: "source.txt",
    outputDir: "project",
    advanced: { subagentEnabled: false, subagentCount: 4 }
  });
  assert.match(disabled, /Subagents: disabled/);
  assert.doesNotMatch(disabled, /Subagents: enabled; maximum=4/);
  const custom = buildTranslatePrompt({
    sourcePath: "source.txt",
    outputDir: "project",
    advanced: { subagentEnabled: true, subagentCount: 4 }
  });
  assert.match(custom, /Subagents: enabled; maximum=4/);
  assert.match(custom, /Translation review Agents: maximum=4/);
  assert.equal(promptParameterDefaults("project", { subagentEnabled: false }).subagentEnabled, false);
  assert.equal(promptParameterDefaults("project").subagentCount, 3);
  assert.equal(promptParameterDefaults("project").reviewSubagentCount, undefined);
  assert.equal(promptParameterDefaults("project", { subagentCount: 4 }).subagentCount, 4);
  assert.equal(promptParameterDefaults("project", { subagentCount: 4 }).reviewSubagentCount, undefined);
  assert.equal(
    promptParameterDefaults("project", { subagentCount: 4, reviewSubagentCount: 2 }).reviewSubagentCount,
    2
  );
});

await test("folder translation prompt describes a host-resolved batch instead of one fake document", () => {
  const prompt = buildTranslatePrompt({
    sourcePath: "D:\\game\\scenario",
    sourceKind: "folder",
    outputDir: "D:\\project",
    advanced: {
      glossaryCandidates: false,
      characterBible: false,
      subagentEnabled: true,
      subagentCount: 5
    }
  });
  assert.match(prompt, /Source folder:/);
  assert.match(prompt, /Subagents: enabled; maximum=5/i);
  assert.match(prompt, /File order/i);
  assert.match(prompt, /relative source path/i);
  assert.doesNotMatch(prompt, /runTranslationSubagents|worker queue|line ranges/i);
});

await test("folder braces remove ordering constraints without requesting simultaneous file work", () => {
  const prompt = buildTranslatePrompt({
    sourcePath: "D:\\game\\scenario",
    sourceKind: "folder",
    outputDir: "D:\\project",
    advanced: {
      subagentEnabled: true,
      subagentCount: 3,
      folderTranslationOrder: '"tips.txt"\n{\n"scripts/a.txt"\n"scripts/b.txt"\n}\n"script.txt"'
    }
  });
  assert.match(prompt, /removed names are skipped/i);
  assert.match(prompt, /braces remove relative ordering only/i);
  assert.doesNotMatch(prompt, /inside braces share one parallel stage/i);
  assert.doesNotMatch(prompt, /simultaneous|planning parallel file writes|dynamic worker queue/i);
});

await test("folder proofreading uses the same retained-file order and skip semantics", () => {
  const prompt = buildProofreadPrompt({
    sourcePath: "D:\\game\\scenario",
    sourceKind: "folder",
    translationPath: "",
    outputDir: "D:\\project",
    advanced: {
      folderTranslationOrder: '{\n"scripts/a.txt"\n}',
      proofreadMode: "montecarlo",
      montecarloSize: 123
    }
  });
  assert.match(prompt, /Source folder:/i);
  assert.match(prompt, /removed names are skipped/i);
  assert.match(prompt, /braces remove relative ordering only/i);
  assert.match(prompt, /Mode: split/i);
  assert.match(prompt, /Report output:\s*D:\\project\\report[\\/]folder\.proofread\.json/i);
  assert.doesNotMatch(prompt, /report[\\/]report|\.md\b|summary/i);
  assert.doesNotMatch(prompt, /Mode: montecarlo|Monte Carlo round/i);
});

await test("workflow prompts carry typed settings without duplicating host-owned runtime instructions", () => {
  const generated = buildTranslatePrompt({
    sourcePath: "D:\\game\\scenario",
    sourceKind: "folder",
    outputDir: "D:\\project",
    advanced: {
      languagePair: "en->zh-CN",
      style: "novel",
      splitSize: 750,
      subagentEnabled: true,
      subagentCount: 4,
      folderTranslationOrder: '{\n"tips.txt"\n"script.txt"\n}'
    }
  });
  const system = buildYnSystemPrompt({
    outputDir: "D:\\project",
    sourcePath: "D:\\game\\scenario",
    sourceSelection: { kind: "folder", path: "D:\\game\\scenario" },
    sessionId: "prompt-dedupe",
    prompt: generated,
    workflowIntent: "translation",
    languagePair: "en->zh-CN",
    style: "novel",
    translationSplitSize: 750,
    reuseExistingTranslation: true,
    subagentEnabled: true,
    subagentCount: 4,
    folderTranslationOrder: '{\n"tips.txt"\n"script.txt"\n}'
  });

  assert.match(generated, /Language pair: en->zh-CN/);
  assert.match(generated, /Text\/domain style: novel/);
  assert.match(generated, /splitSize=750/);
  assert.match(generated, /tips\.txt/);
  assert.ok(occurrences(generated, "call runTranslationSubagents once") <= 1);
  assert.ok(occurrences(system, "call runTranslationSubagents once") <= 1);
  assert.doesNotMatch(system, /mark review when uncertain|retain review lines|user confirmation/i);
  assert.ok(system.length < 6_000, `parent system prompt is still bloated (${system.length} chars)`);
  assert.doesNotMatch(system, /mechanically scans every row|deterministic clean-row sample|hash-bound accepted chunk-review coverage/i);
  assert.match(system, /exists\/available fields are authoritative/i);
  assert.match(system, /call runTranslationReuseAudit directly/i);
  assert.match(system, /do not call parent readTranslationReuseAudit\/recordTranslationReuseAudit/i);
});

await test("local translation repair has one bounded parent-or-runSubagents route", () => {
  const system = buildYnSystemPrompt({
    outputDir: "D:\\project",
    sourcePath: "D:\\project\\source.txt",
    sessionId: "local-repair-routing",
    prompt: "修复第 12 行译文。",
    workflowIntent: "translation",
    subagentEnabled: true,
    subagentCount: 4,
    translationSplitSize: 1000
  }, { fullWorkflow: false });

  assert.match(system, /trivial bounded repair.*parent.*writeTranslationChunk/i);
  assert.match(system, /useful child delegation.*runSubagents/i);
  assert.match(system, /mode=translation_repair/i);
  assert.match(system, /documentId.*fromLine.*toLine/i);
  assert.match(system, /runTranslationSubagents.*only.*complete Host-owned translation queue/i);
  assert.equal(occurrences(system, "runTranslationSubagents"), 1);
  assert.doesNotMatch(system, /runTranslationSubagents may .*bounded ranges/i);
  assert.doesNotMatch(system, /current-user wording|magic wording|authorization gate|authorized exactly/i);
});

await test("full translation keeps one explicit mechanical-review gate", () => {
  const generated = buildTranslatePrompt({
    sourcePath: "D:\\project\\source.txt",
    outputDir: "D:\\project",
    advanced: { subagentEnabled: true, subagentCount: 3, reviewSubagentCount: 2 }
  });
  const system = buildYnSystemPrompt({
    outputDir: "D:\\project",
    sourcePath: "D:\\project\\source.txt",
    sessionId: "full-translation-gate",
    prompt: generated,
    workflowIntent: "translation",
    subagentEnabled: true,
    subagentCount: 3,
    reviewSubagentCount: 2,
    glossaryCandidates: true,
    characterBible: true
  }, { fullWorkflow: true });

  assert.match(system, /runTranslationSubagents.*complete Host-owned translation queue/i);
  assert.match(system, /optional workerCount.*1 through 3/i);
  assert.match(system, /Host queue owns assignment, validation, review, retry, and settlement/i);
  assert.match(system, /character bible is unavailable.*structured character records.*initializeTranslationStarterAssets.*bounded source sample/is);
  assert.match(system, /user-supplied Wiki URLs.*references do not provide enough.*representative source windows/is);
  assert.match(system, /initializeTranslationStarterAssets exactly once.*Host serializes canonical JSON and Markdown/is);
  assert.match(system, /Never hand-author these files through writeProjectFile/i);
  assert.match(system, /After resumeYnWorkflow, follow nextAction/i);
  assert.match(system, /Remaining rejected\/empty lines require the complete Host translation queue first/i);
  assert.match(system, /already established target.*atomically fill the missing companion asset/is);
  assert.equal(occurrences(system, "runTranslationSubagents"), 1);
  assert.doesNotMatch(system, /mechanically scans every row|deterministic clean-row sample/i);
  assert.doesNotMatch(system, /current-user wording|magic wording|authorization gate|authorized exactly/i);
});

await test("custom preservation rules are typed prompt metadata and a host-enforced system contract", () => {
  const customPreserveRules = [
    { label: "speaker marker", pattern: "^@[A-Z_]+", flags: "u" },
    { label: "dialogue brackets", pattern: "[\\[\\]]", flags: "u" }
  ];
  const generated = buildTranslatePrompt({
    sourcePath: "source.txt",
    outputDir: "project",
    advanced: { customPreserveRules }
  });
  assert.match(generated, /Custom preservation rules/i);
  assert.match(generated, /speaker marker.*\^@\[A-Z_\]\+/i);
  const system = buildYnSystemPrompt({
    outputDir: "project",
    sourcePath: "source.txt",
    sessionId: "custom-preserve-rules",
    prompt: generated,
    workflowIntent: "translation",
    languagePair: "en->zh-CN",
    customPreserveRules
  });
  assert.match(system, /CUSTOM VERBATIM PRESERVATION RULES/i);
  assert.match(system, /same candidate line/i);
  assert.match(system, /Host blocks/i);
});

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
