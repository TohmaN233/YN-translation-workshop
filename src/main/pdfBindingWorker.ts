import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { decodeProjectPaths, projectRelativePath } from "./projectPaths.ts";
import { PDF_LAYOUT_VERSION, PDF_EXTRACTOR_REVISION, validatePdfLayout } from "./pdfTypes.ts";
import { scanPdfPreservedSpans } from "../shared/validation/pdfAcademicPrescan.ts";
import {assertPdfStructureAccepted,assertPdfStructureAudit,pdfStructureDigest,verifyPdfStructureScopeEvidence} from './pdfStructurePreparation.ts';
import {applyPdfStructurePlan} from './pdfStructurePlan.ts';
import {buildPdfReflowDocument} from './pdfReflowDocument.ts';
import {renderPdfReflowHtml} from './pdfReflow.ts';

async function applyStructure(layout:Parameters<typeof applyPdfStructurePlan>[0],plan:Parameters<typeof applyPdfStructurePlan>[1]) {
  const applied=applyPdfStructurePlan(layout,plan);
  // Asset bytes/hashes are verified separately. A known PNG here exercises
  // source-leaf/frame ownership without printing or altering the source.
  const image={dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPuoAAAAASUVORK5CYII=',width:1,height:1};
  const document=await buildPdfReflowDocument(applied.layout,applied.layout.blocks.map(block=>block.text),{
    inline:async()=>image,native:async()=>image,figure:async()=>image
  });
  renderPdfReflowHtml(document,'file:///verified-source-font.ttf');
  return {...applied,renderOwnershipVerified:true};
}

export async function pdfFileStamp(file: string): Promise<string> {
  const value = await stat(file, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}

async function digest(file: string): Promise<string> {
  const before = await pdfFileStamp(file), hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  if (before !== await pdfFileStamp(file)) throw new Error(`PDF binding changed during verification: ${file}`);
  return hash.digest("hex");
}

async function verify(input: { sourcePath: string; projectRoot: string; pending?:boolean }) {
  const mapPath = input.sourcePath + (input.pending?'.pdf-mechanical.json':'.pdf-layout.json'), mapStamp = await pdfFileStamp(mapPath);
  const layout = decodeProjectPaths(JSON.parse(await readFile(mapPath, "utf8")), input.projectRoot);
  if (layout.version !== PDF_LAYOUT_VERSION) throw new Error("This PDF projection uses obsolete paragraph boundaries. Generate a new review from the original PDF; old projections, translations and sessions were retained and cannot be reused by old row numbers.");
  if (layout.extractorRevision !== PDF_EXTRACTOR_REVISION) throw new Error("This PDF projection uses an obsolete extractor. Generate a new review from the original PDF; existing translations were retained.");
  validatePdfLayout(layout);
  if(!input.pending)assertPdfStructureAccepted(layout);
  if (path.resolve(layout.sourcePath) !== path.resolve(input.sourcePath)) throw new Error("PDF source binding differs from this projection.");
  for (const page of layout.pages) {
    if (projectRelativePath(path.dirname(input.sourcePath), page.backgroundPath) === undefined
      || projectRelativePath(path.dirname(input.sourcePath), page.previewPath) === undefined) throw new Error("PDF asset escaped its projection directory.");
  }
  for (const block of layout.physicalBlocks??layout.blocks) if (block.sourceInkPath && projectRelativePath(path.dirname(input.sourcePath), block.sourceInkPath) === undefined) throw new Error("PDF numeric asset escaped its projection directory.");
  const textPath=input.sourcePath+(input.pending?'.pdf-mechanical.txt':'');
  const files = [mapPath, textPath, layout.originalPath];
  const validatedStamps=new Map<string,string>([[mapPath,mapStamp]]);
  if(!input.pending) {
    assertPdfStructureAccepted(layout);
    const mechanicalPath=input.sourcePath+'.pdf-mechanical.json',receiptPath=input.sourcePath+'.pdf-structure.json',mechanicalTextPath=input.sourcePath+'.pdf-mechanical.txt';
    const evidencePaths=[mechanicalPath,receiptPath,mechanicalTextPath];
    const before=await Promise.all(evidencePaths.map(pdfFileStamp));
    evidencePaths.forEach((file,index)=>validatedStamps.set(file,before[index]));
    const mechanical=decodeProjectPaths(JSON.parse(await readFile(mechanicalPath,'utf8')),input.projectRoot);
    const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
    validatePdfLayout(mechanical);assertPdfStructureAudit(receipt.audit);
    if(mechanical.originalHash!==layout.originalHash||mechanical.protectionHash!==layout.preparation.mechanicalHash
      ||pdfStructureDigest(receipt.plan)!==layout.preparation.planHash||pdfStructureDigest(receipt.audit)!==layout.preparation.auditHash)throw new Error('PDF structure acceptance evidence changed.');
    const reconstructed=applyPdfStructurePlan(mechanical,receipt.plan),applied=reconstructed.layout;
    applied.preparation=layout.preparation;
    verifyPdfStructureScopeEvidence(mechanical,applied,receipt.audit,reconstructed.geometryFindings);
    const {pdfProtectionHash}=await import('./pdfTypes.ts');
    if(pdfProtectionHash(applied)!==layout.protectionHash)throw new Error('PDF accepted layout differs from its source-ID plan.');
    if(await digest(mechanicalTextPath)!==mechanical.sourceHash)throw new Error('PDF mechanical source evidence changed.');
    const after=await Promise.all(evidencePaths.map(pdfFileStamp));
    if(before.some((stamp,index)=>stamp!==after[index]))throw new Error('PDF structure evidence changed during verification.');
    files.push(...evidencePaths);
  }
  const stamps = await Promise.all(files.map(pdfFileStamp));
  for(const [file,stamp] of validatedStamps)if(stamps[files.indexOf(file)]!==stamp)throw new Error('PDF validated structure evidence changed before its cache epoch was sealed.');
  if (stamps[0] !== mapStamp) throw new Error("PDF layout changed during verification.");
  if (await digest(textPath) !== layout.sourceHash) throw new Error(`PDF source binding changed: ${textPath}. Restore it before resuming.`);
  if (await digest(layout.originalPath) !== layout.originalHash) throw new Error(`PDF source binding changed: ${layout.originalPath}. Restore it before resuming.`);
  const after = await Promise.all(files.map(pdfFileStamp));
  if (after.some((value, index) => value !== stamps[index])) throw new Error("PDF binding changed during verification.");
  const preservedSpans = scanPdfPreservedSpans(layout.blocks);
  return { layout, files, stamps, preservedSpans };
}

async function verifyAssets(input: { sourcePath: string; projectRoot: string;pending?:boolean }) {
  const binding = await verify(input);
  const assets = [
    ...binding.layout.pages.flatMap(page => [[page.backgroundPath, page.backgroundHash], [page.previewPath, page.previewHash]]),
    ...(binding.layout.physicalBlocks??binding.layout.blocks).flatMap(block => block.sourceInkPath ? [[block.sourceInkPath, block.sourceInkHash!]] : [])
  ];
  const stamps = await Promise.all(assets.map(([file]) => pdfFileStamp(file)));
  for (const [file, hash] of assets) {
    if (await digest(file) !== hash) throw new Error(`PDF asset changed: ${file}. Restore it before resuming.`);
  }
  const files = [...binding.files, ...assets.map(([file]) => file)];
  const expected = [...binding.stamps, ...stamps];
  const after = await Promise.all(files.map(pdfFileStamp));
  if (after.some((value, index) => value !== expected[index])) throw new Error("PDF assets or binding changed during verification.");
  return { verifiedAssets: assets.length };
}

// Hashing and layout JSON validation never run on Electron's main thread.
if (parentPort) {
  try {
    const result = workerData.kind === "hash" ? await digest(workerData.file)
      : workerData.kind==='verify-mechanical'?await verify({...workerData,pending:true})
      : workerData.kind==='apply-structure'?await applyStructure(workerData.layout,workerData.plan)
      : workerData.kind === "verify-assets" ? await verifyAssets(workerData) : await verify(workerData);
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error),
      code: (error as NodeJS.ErrnoException).code, file: (error as NodeJS.ErrnoException).path });
  }
}
