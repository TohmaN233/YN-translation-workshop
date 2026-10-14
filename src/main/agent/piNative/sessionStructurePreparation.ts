import { BACKGROUND_CONTEXT, type AgentTool, type Session, type ThinkingLevel } from "@earendil-works/pi-agent-core/node";
import { PI_SESSION_BRANCH } from "./sessionAccess.ts";

export interface PdfStructurePreparationRequest {
  outputDir: string;
  sessionId?: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel | "auto";
  signal?: AbortSignal;
  systemPrompt: string;
  prompt: string;
  /** Host-supplied source-inspection/typed structure tools only; never exposed through IPC. */
  tools?: AgentTool[];
  /** Internal Host audit-output contract; never accepted from renderer IPC. */
  responseMode?: "structured-tool";
}
export interface PdfStructurePreparationResult {
  sessionId: string;
  providerId: string;
  modelId: string;
  text: string;
}
export const PDF_STRUCTURE_PREPARATION_ENTRY = "yn_pdf_structure_preparation";

/** A durable native custom receipt isolates the next model turn, preserving the audit transcript. */
export async function pdfStructureContextNeedsReset(session: Session): Promise<boolean> {
  const branch = await session.branch(PI_SESSION_BRANCH, BACKGROUND_CONTEXT);
  const [receipt, message] = await Promise.all([
    branch?.findEntry({ type: "custom", customType: PDF_STRUCTURE_PREPARATION_ENTRY, order: "newestFirst" }, BACKGROUND_CONTEXT),
    branch?.findEntry({ type: "message", order: "newestFirst" }, BACKGROUND_CONTEXT)
  ]);
  return receipt?.type === "custom" && (receipt.data as { contextReset?: unknown })?.contextReset === true
    && (!message || receipt.seq > message.seq);
}
