import type {PdfLayout} from './pdfTypes.ts';
import type {PdfProtectedLine} from '../shared/validation/pdfPreservation.ts';

const referenceHeading=/^(?:\d+(?:\.\d+)*[.)]?\s+)?(?:references|bibliography|works cited|参考文献|引用文献|参考资料|文献一覧)$/iu;
const nextSection=/^(?:appendix(?:\s|$)|appendices\b|supplementary (?:material|information)\b|acknowledg(?:e)?ments\b|附录|付録)/iu;

/** Derived from the verified layout; row identities and source hashes do not change. */
export function pdfReferenceSections(layout:Pick<PdfLayout,'blocks'>&Partial<Pick<PdfLayout,'physicalBlocks'>>):{
  protectedLines:PdfProtectedLine[];
} {
  // Reflow may move or group source owners. Read-only identity comes from the
  // sealed physical source, rather than from a heading's new output position.
  if(layout.physicalBlocks) {
    const sourceIds=new Set(layout.physicalBlocks.map(block=>block.line));
    const referenceIds=new Set(pdfReferenceSections({blocks:layout.physicalBlocks}).protectedLines.map(row=>row.line));
    const protectedLines:PdfProtectedLine[]=[];
    for(const block of layout.blocks) {
      const ids=block.fragments;
      if(!ids?.length)throw new Error(`PDF reference ownership: logical L${block.line} lacks physical source IDs.`);
      if(ids.some(id=>!sourceIds.has(id)))throw new Error(`PDF reference ownership: logical L${block.line} has an unknown source ID.`);
      if(!ids.some(id=>referenceIds.has(id)))continue;
      if(ids.some(id=>!referenceIds.has(id)))throw new Error(`PDF reference ownership: logical L${block.line} mixes references with writable source.`);
      protectedLines.push({line:block.line,kind:'reference',text:block.text});
    }
    return {protectedLines};
  }
  const protectedLines:PdfProtectedLine[]=[];
  let heading:PdfLayout['blocks'][number]|undefined;
  for(const block of layout.blocks) {
    const text=block.text.normalize('NFKC').trim();
    if(referenceHeading.test(text))heading=block;
    else if(heading&&nextSection.test(text)) {
      heading=undefined;
    }
    if(!heading)continue;
    protectedLines.push({line:block.line,kind:'reference',text:block.text});
  }
  return {protectedLines};
}
