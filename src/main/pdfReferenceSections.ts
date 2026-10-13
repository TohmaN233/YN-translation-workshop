import type {PdfLayout} from './pdfTypes.ts';
import type {PdfProtectedLine} from '../shared/validation/pdfPreservation.ts';

const referenceHeading=/^(?:\d+(?:\.\d+)*[.)]?\s+)?(?:references|bibliography|works cited|参考文献|引用文献|参考资料|文献一覧)$/iu;
const nextSection=/^(?:appendix(?:\s|$)|appendices\b|supplementary (?:material|information)\b|acknowledg(?:e)?ments\b|附录|付録)/iu;

/** Derived from the verified layout; row identities and source hashes do not change. */
export function pdfReferenceSections(layout:Pick<PdfLayout,'blocks'>):{
  protectedLines:PdfProtectedLine[];
} {
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
