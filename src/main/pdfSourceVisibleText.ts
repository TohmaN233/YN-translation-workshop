import type {PdfTextBlock} from './pdfTypes.ts';

/** Read original visible characters for boundary evidence. This never changes
 * the canonical source text or the immutable native node it expands. */
export function pdfSourceVisibleText(block:Pick<PdfTextBlock,'text'|'inlineProtections'>):string {
  const nodes=new Map(block.inlineProtections?.map(node=>[node.token,node.text]));
  return block.text.replace(/\{\{(?:formula|code):p\d+:\d+\}\}/gu,token=>{
    const text=nodes.get(token);if(text===undefined)throw new Error(`PDF visible source has an unowned native marker ${token}.`);return text;
  });
}
