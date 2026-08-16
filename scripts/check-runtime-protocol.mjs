#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const requiredFiles = [
  "translation-protocol/translate.md",
  "translation-protocol/proofread.md",
  "translation-protocol/translation-child.md",
  "translation-protocol/proofread-child.md",
  "translation-protocol/character-bible.schema.json",
  "translation-protocol/findings.schema.json",
  "translation-protocol/glossary.schema.json",
  "translation-protocol/patch.schema.json",
];

const retiredFiles = [
  "docs/skill-integration.md",
  "scripts/install-skills.mjs",
  "scripts/check-runtime-skills.mjs",
  "skills",
];

for (const filePath of requiredFiles) {
  if (!existsSync(filePath)) throw new Error(`Missing runtime protocol file: ${filePath}`);
  if (!readFileSync(filePath, "utf8").trim()) throw new Error(`Empty runtime protocol file: ${filePath}`);
}

for (const filePath of retiredFiles) {
  if (existsSync(filePath)) throw new Error(`Retired external configuration remains in the repository: ${filePath}`);
}

const translationChild = readFileSync("translation-protocol/translation-child.md", "utf8");
const proofreadChild = readFileSync("translation-protocol/proofread-child.md", "utf8");
if (!/validateAssignedTranslation/u.test(translationChild)) {
  throw new Error("Translation child protocol does not name its validation boundary.");
}
if (!/writeAssignedFindings/u.test(proofreadChild)) {
  throw new Error("Proofread child protocol does not name its submission boundary.");
}

console.log("Runtime translation protocols and schemas are complete; retired external configuration is absent.");
