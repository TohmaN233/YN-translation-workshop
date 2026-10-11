import type { AgentTool } from "@earendil-works/pi-agent-core/node";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import path from "node:path";
import { isPdfSourceProjection, pdfReferencesForRange, readPdfReferenceImage } from "../../pdfDocuments.ts";
import type { PiSessionPromptRequest } from "../../../shared/agent/piSessionContract.ts";

export function createPdfReferenceTools(bound: () => PiSessionPromptRequest, supportsImages: () => boolean): AgentTool[] {
  const initial = bound();
  if (!(initial.sourcePath && (isPdfSourceProjection(initial.sourcePath) || existsSync(initial.sourcePath + ".pdf-layout.json")))
    && !initial.folderSourceDocuments?.some(document => document.projection?.kind === "pdf-text")) return [];
  const sourceFor = (request: PiSessionPromptRequest, documentId?: string) => {
    if (documentId) {
      const document = request.folderSourceDocuments?.find(document => document.id === documentId);
      if (!document) throw new Error(`Unknown PDF source document: ${documentId}. Use the native document manifest.`);
      return document.path;
    }
    if (request.sourceSelection?.kind === "folder" || request.folderSourceDocuments?.length
      && !request.folderSourceDocuments.some(document => path.resolve(document.path) === path.resolve(request.sourcePath ?? "."))) {
      throw new Error("Specify documentId from the source manifest to inspect a folder PDF.");
    }
    if (!request.sourcePath) throw new Error("No source document is bound to this PDF reference request.");
    return request.sourcePath;
  };
  return [{
    name: "inspectPdfReferences", label: "Find PDF figures",
    description: "Read only the lightweight PDF page/figure index for source lines that mention figures, tables or other visual evidence. Specify documentId from the native manifest for a folder. No image bytes enter context. Use viewPdfReference only when that passage needs the visual; never view every page by default. TXT/EPUB documents return available=false.",
    parameters: Type.Object({ fromLine: Type.Integer({ minimum: 1 }), toLine: Type.Integer({ minimum: 1 }), documentId: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const request = bound(), input = params as { fromLine: number; toLine: number; documentId?: string };
      if (input.toLine < input.fromLine) throw new Error("PDF reference range is reversed.");
      const result = await pdfReferencesForRange(sourceFor(request, input.documentId), request.outputDir, input.fromLine, input.toLine);
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: JSON.stringify(result ? { available: true, ...result } : { available: false }) }], details: undefined };
    }
  }, {
    name: "viewPdfReference", label: "View PDF figure",
    description: "View one read-only PDF image or page referenced by a source passage. First inspectPdfReferences; cite the relevant sourceLine and explain the visual ambiguity. Requires the configured model to accept images. The tool returns a native Pi image block, never an automatic attachment to every assignment.",
    parameters: Type.Object({ id: Type.String({ minLength: 1 }), sourceLine: Type.Integer({ minimum: 1 }), reason: Type.String({ minLength: 1 }), documentId: Type.Optional(Type.String({ minLength: 1 })) }),
    async execute(_id, params, signal) {
      const request = bound(), input = params as { id: string; sourceLine: number; reason: string; documentId?: string };
      if (!supportsImages()) throw new Error("The active model does not accept images. Select a vision model to view PDF references.");
      const image = await readPdfReferenceImage(sourceFor(request, input.documentId), request.outputDir, input.id, input.sourceLine, signal);
      return { content: [{ type: "text", text: JSON.stringify(image.reference) }, { type: "image", data: image.data, mimeType: "image/png" }], details: image.reference };
    }
  }];
}
