#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const runtimeSkills = {
  "translate-text": "references/translation-workflow.md",
  "proofread-translation": "references/proofread-workflow.md"
};

const requiredReferences = ["references/subagent-task-template.md"];

const forbiddenProviderSources = [
  "skills/codex/translate-text/SKILL.md",
  "skills/codex/translate-text/references/translation-workflow.md",
  "skills/codex/proofread-translation/SKILL.md",
  "skills/codex/proofread-translation/references/proofread-workflow.md",
  "skills/claude/commands/translate-text.md",
  "skills/claude/commands/proofread-translation.md"
];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

for (const [skillName, reference] of Object.entries(runtimeSkills)) {
  const skillFile = path.join("skills", skillName, "SKILL.md");
  const referenceFile = path.join("skills", skillName, reference);
  if (!(await exists(skillFile))) {
    fail(`Missing runtime skill entry: ${skillFile}`);
    continue;
  }
  if (!(await exists(referenceFile))) {
    fail(`Missing runtime skill reference: ${referenceFile}`);
    continue;
  }
  const skillText = await readFile(skillFile, "utf8");
  const referenceText = await readFile(referenceFile, "utf8");
  if (!/^---[\s\S]*?^---/m.test(skillText)) {
    fail(`Missing skill frontmatter: ${skillFile}`);
  }
  if (!/name:\s*[-a-z]+/i.test(skillText) || !/description:\s*/i.test(skillText)) {
    fail(`Missing skill name/description frontmatter: ${skillFile}`);
  }
  if (/Codex CLI|Claude Code commands|skills\/codex|skills\/claude/i.test(skillText)) {
    fail(`Runtime skill leaks provider-specific source language: ${skillFile}`);
  }
  if (/Adopt this role|professional bilingual translator|professional translation reviewer/i.test(`${skillText}\n${referenceText}`)) {
    fail(`Runtime skill duplicates role injection instead of leaving role to the host prompt: ${skillFile}`);
  }
  if (!referenceText.trim()) {
    fail(`Empty runtime skill reference: ${referenceFile}`);
  }
  for (const extraReference of requiredReferences) {
    const extraFile = path.join("skills", skillName, extraReference);
    if (!(await exists(extraFile))) {
      fail(`Missing runtime skill reference: ${extraFile}`);
    }
  }
}

for (const filePath of forbiddenProviderSources) {
  if (await exists(filePath)) {
    fail(`Provider-specific skill source should not exist: ${filePath}`);
  }
}

if (!process.exitCode) {
  console.log("Runtime skills are unified and provider-specific source wrappers are absent.");
}
