import {createHash} from 'node:crypto';
import path from 'node:path';
import {readProjectState,patchProjectStateIfUnchanged} from '../projectState.ts';
import {readRequiredWorkflowText} from './requiredWorkflowFile.ts';
import {splitTextLines,validateTranslationCandidate,type ValidationOptions} from '../../shared/validation/translationValidator.ts';
export interface TranslationResidueApproval {
  sourcePath:string;line:number;sourceText:string;candidateText:string;reason:string;
  sourceHash:string;candidateHash:string;confirmedBy:string;
}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function parseTranslationResidueApprovals(value:unknown):TranslationResidueApproval[] {
  if(value===undefined)return [];
  if(!Array.isArray(value))throw new Error('Invalid parent translation residue approvals.');
  return value.map((entry:any)=>{
    if(!entry||typeof entry.sourcePath!=='string'||!Number.isInteger(entry.line)||entry.line<1
      ||typeof entry.sourceText!=='string'||typeof entry.candidateText!=='string'||/[\r\n]/u.test(entry.sourceText+entry.candidateText)
      ||typeof entry.reason!=='string'||!entry.reason.trim()||typeof entry.confirmedBy!=='string'||!entry.confirmedBy
      ||entry.sourceHash!==hash(entry.sourceText)||entry.candidateHash!==hash(entry.candidateText))throw new Error('Parent residue decision has invalid ownership or text hashes.');
    return entry as TranslationResidueApproval;
  });
}
export async function readTranslationResidueApprovals(outputDir:string,sourcePath:string|undefined,fromLine=1) {
  if(!sourcePath)return [];
  const entries=parseTranslationResidueApprovals((await readProjectState(outputDir)).translationResidueApprovals);
  return entries.filter(entry=>path.resolve(entry.sourcePath)===path.resolve(sourcePath)&&entry.line>=fromLine)
    .map(entry=>({...entry,sourcePath,line:entry.line-fromLine+1}));
}
/** Called only by the parent's typed tool. This records a decision, never writes a candidate. */
export async function confirmTranslationResidueSafe(args:{outputDir:string;sourcePath:string;sessionId:string;
  entries:Array<{line:number;translation:string;reason:string}>;validationOptions:ValidationOptions}) {
  if(!args.entries.length)throw new Error('Residue confirmation requires explicit rows and reasons.');
  const sourceBytes=await readRequiredWorkflowText(args.sourcePath),source=splitTextLines(sourceBytes),seen=new Set<number>();
  const decisions:TranslationResidueApproval[]=[];
  for(const entry of args.entries) {
    if(!Number.isInteger(entry.line)||entry.line<1||entry.line>source.length||seen.has(entry.line)||!entry.reason?.trim()
      ||typeof entry.translation!=='string'||/[\r\n]/u.test(entry.translation))throw new Error('Each residue approval must own one unique source row, exact translation and reason.');
    seen.add(entry.line);
    const validation=validateTranslationCandidate(source[entry.line-1],entry.translation,{...args.validationOptions,
      translationResidueApprovals:[],lineOffset:entry.line-1,detectUntranslated:true});
    const other=validation.blocking.filter(finding=>finding.code!=='likely_untranslated');
    if(other.length)throw new Error(`L${entry.line} cannot waive structural errors: ${other.map(f=>f.code+': '+f.detail).join('; ')}`);
    if(![...validation.blocking,...validation.warnings].some(f=>f.code==='likely_untranslated'))throw new Error(`L${entry.line} has no suspected untranslated finding to confirm.`);
    decisions.push({sourcePath:args.sourcePath,line:entry.line,sourceText:source[entry.line-1],candidateText:entry.translation,
      sourceHash:hash(source[entry.line-1]),candidateHash:hash(entry.translation),reason:entry.reason.trim(),confirmedBy:args.sessionId});
  }
  const project=await readProjectState(args.outputDir),previous=parseTranslationResidueApprovals(project.translationResidueApprovals);
  if(await readRequiredWorkflowText(args.sourcePath)!==sourceBytes)throw new Error('Source changed while confirming untranslated rows; no decision was recorded.');
  const next=[...previous.filter(old=>!decisions.some(entry=>path.resolve(entry.sourcePath)===path.resolve(old.sourcePath)&&entry.line===old.line)),...decisions];
  await patchProjectStateIfUnchanged(args.outputDir,{translationResidueApprovals:project.translationResidueApprovals},{translationResidueApprovals:next});
  return {confirmedLines:decisions.map(entry=>entry.line),instruction:'Write the exact confirmed translations normally. Other structural checks still apply; changing either source or candidate invalidates this decision.'};
}
