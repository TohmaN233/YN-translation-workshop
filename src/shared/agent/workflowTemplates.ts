export type WorkflowTemplateId =
  | "initial_translation"
  | "proofread"
  | "terminology_sweep"
  | "character_voice_check"
  | "final_qa";

export type WorkflowArtifactKind =
  | "translation_candidate"
  | "findings_json"
  | "terminology_findings_json"
  | "character_voice_findings_json"
  | "final_qa_findings_json";

export interface WorkflowTemplate {
  id: WorkflowTemplateId;
  promptKind: "translate" | "proofread" | "generic";
  outputArtifact: {
    kind: WorkflowArtifactKind;
    pathHint: string;
  };
  labelKey:
    | "workflowTemplateInitialTranslation"
    | "workflowTemplateProofread"
    | "workflowTemplateTerminologySweep"
    | "workflowTemplateCharacterVoiceCheck"
    | "workflowTemplateFinalQa";
}

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: "initial_translation",
    promptKind: "translate",
    outputArtifact: {
      kind: "translation_candidate",
      pathHint: "{translationOutputDir}/{document}_translated.txt"
    },
    labelKey: "workflowTemplateInitialTranslation"
  },
  {
    id: "proofread",
    promptKind: "proofread",
    outputArtifact: {
      kind: "findings_json",
      pathHint: "{reportOutputDir}/{document}.proofread.json"
    },
    labelKey: "workflowTemplateProofread"
  },
  {
    id: "terminology_sweep",
    promptKind: "generic",
    outputArtifact: {
      kind: "terminology_findings_json",
      pathHint: "{reportOutputDir}/{document}.terminology.json"
    },
    labelKey: "workflowTemplateTerminologySweep"
  },
  {
    id: "character_voice_check",
    promptKind: "generic",
    outputArtifact: {
      kind: "character_voice_findings_json",
      pathHint: "{reportOutputDir}/{document}.character-voice.json"
    },
    labelKey: "workflowTemplateCharacterVoiceCheck"
  },
  {
    id: "final_qa",
    promptKind: "proofread",
    outputArtifact: {
      kind: "final_qa_findings_json",
      pathHint: "{reportOutputDir}/{document}.final-qa.json"
    },
    labelKey: "workflowTemplateFinalQa"
  }
];

export function getWorkflowTemplate(id: string | undefined): WorkflowTemplate {
  return workflowTemplates.find((template) => template.id === id) ?? workflowTemplates[0];
}
