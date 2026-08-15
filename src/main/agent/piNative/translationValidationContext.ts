import type { PiSessionPromptRequest } from "../../../shared/agent/piSessionContract.ts";
import type { ValidationOptions } from "../../../shared/validation/translationValidator.ts";
import { readProjectTranslationValidationAssets } from "../projectAssets.ts";

function requiredLanguagePair(request: PiSessionPromptRequest): string {
  const languagePair = request.languagePair?.trim();
  if (!languagePair) {
    throw new Error("Translation validation requires typed languagePair metadata from the workflow UI.");
  }
  return languagePair;
}

export async function createYnTranslationValidationOptions(
  request: PiSessionPromptRequest
): Promise<ValidationOptions> {
  const assets = await readProjectTranslationValidationAssets(request.outputDir);
  return {
    locale: "zh-CN",
    languagePair: requiredLanguagePair(request),
    detectUntranslated: true,
    customPreserveRules: request.customPreserveRules,
    glossaryEntries: assets.glossaryEntries,
    characterEntries: assets.characterEntries,
    styleForbiddenTerms: assets.styleForbiddenTerms
  };
}
