export type WorkflowTemplateId =
  | "initial_translation"
  | "proofread";

export type WorkflowArtifactKind =
  | "translation_candidate"
  | "findings_json";

export interface WorkflowTemplate {
  id: WorkflowTemplateId;
  promptKind: "translate" | "proofread";
  outputArtifact: {
    kind: WorkflowArtifactKind;
    pathHint: string;
  };
  labelKey:
    | "workflowTemplateInitialTranslation"
    | "workflowTemplateProofread";
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
  }
];

export function getWorkflowTemplate(id: string | undefined): WorkflowTemplate {
  return workflowTemplates.find((template) => template.id === id) ?? workflowTemplates[0];
}
