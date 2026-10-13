import type { PiSessionPromptRequest } from "../../../shared/agent/piSessionContract.ts";
import type { ValidationOptions } from "../../../shared/validation/translationValidator.ts";
import { readWorkflowTranslationValidationAssets, type readWorkflowProjectAssets } from "../projectAssets.ts";
import { readPdfProtectedLines, readPdfPreservedSpans } from "../../pdfDocuments.ts";
import { localPdfPreservedSpans } from "../../../shared/validation/pdfAcademicPrescan.ts";
import { localPdfProtectedLines } from "../../../shared/validation/pdfPreservation.ts";
import {readTranslationResidueApprovals} from '../translationResidueApproval.ts';

function requiredLanguagePair(request: PiSessionPromptRequest): string {
  const languagePair = request.languagePair?.trim();
  if (!languagePair) {
    throw new Error("Translation validation requires typed languagePair metadata from the workflow UI.");
  }
  return languagePair;
}

export async function createYnTranslationValidationOptions(
  request: PiSessionPromptRequest,
  readAssets?: typeof readWorkflowProjectAssets,
  localRangeStart = 1,
  signal?: AbortSignal
): Promise<ValidationOptions> {
  const assets = await readWorkflowTranslationValidationAssets({
    outputDir: request.outputDir,
    glossaryPath: request.glossaryPath
  }, readAssets);
  return {
    locale: "zh-CN",
    languagePair: requiredLanguagePair(request),
    sourceBinding:request.sourcePath,
    translationResidueApprovals:await readTranslationResidueApprovals(request.outputDir,request.sourcePath,localRangeStart),
    detectUntranslated: true,
    pdfProtectedLines: localPdfProtectedLines(await readPdfProtectedLines(request.sourcePath, request.outputDir, signal), localRangeStart),
    pdfPreservedSpans: localPdfPreservedSpans(await readPdfPreservedSpans(request.sourcePath,request.outputDir,signal),localRangeStart),
    customPreserveRules: request.customPreserveRules,
    glossaryEntries: assets.glossaryEntries,
    characterEntries: assets.characterEntries,
    styleForbiddenTerms: assets.styleForbiddenTerms
  };
}
