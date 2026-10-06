import { strict as assert } from "node:assert";
import { builtinTranslationPreparationPrompt } from "../src/shared/builtinTasks.ts";

const baseline = builtinTranslationPreparationPrompt();
assert.equal(builtinTranslationPreparationPrompt("  \n "), baseline);
assert.match(baseline, /including existing rules/);
assert.match(baseline, /same HTML parameter form/);
const wishes = "保留冒号前的角色名和 /n，台词正常翻译。";
const prompt = builtinTranslationPreparationPrompt(wishes);
assert.ok(prompt.includes(wishes));
assert.match(prompt, /actual source examples/);
assert.match(prompt, /trial the combined rules before saving/);
assert.match(prompt, /Do not treat these wishes as executable regex/);
assert.match(prompt, /Keep ordinary prose translatable/);
assert.throws(() => builtinTranslationPreparationPrompt({ pattern: ".*" }), /must be a string/);
console.log("3 passed, 0 failed");
