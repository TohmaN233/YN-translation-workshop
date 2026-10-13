/** Derived from the hash-verified PDF source, never from a model's candidate. */
export interface PdfPreservedSpan {
  line: number; start: number; end: number; text: string;
  kind: 'software' | 'acronym' | 'label' | 'reference';
  evidenceLine: number;
}
type SourceBlock = {line: number; page: number; text: string; protection?: string; x?: number; y?: number};
const identifier = '[A-Za-z][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*';
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const boundary = (text: string, start: number, end: number) => !/[A-Za-z0-9_]/u.test(text[start-1]??'') && !/[A-Za-z0-9_]/u.test(text[end]??'');

/** A declaration qualifies a name; capitalization alone never qualifies prose. */
export function scanPdfPreservedSpans(blocks: SourceBlock[]): PdfPreservedSpan[] {
  const names = new Map<string,{kind:'software'|'acronym'|'label';evidenceLine:number}>();
  const addName = (text: string, kind: 'software'|'acronym'|'label', evidenceLine: number) => {
    if (!names.has(text)) names.set(text,{kind,evidenceLine});
  };
  for (const [index,block] of blocks.entries()) {
    if (block.protection) continue;
    const software = [
      new RegExp('\\b(?:package|library|framework|toolkit)\\s+('+identifier+')(?:[.,;)]|(?=\\s|$))','gu'),
      new RegExp('\\b('+identifier+')\\s+(?:package|library|framework|toolkit)\\b','gu')
    ];
    for (const pattern of software) for (const match of block.text.matchAll(pattern)) {
      const name=match[1];
      // Ordinary predicates/determiners are not identifiers. Lowercase names
      // need citation punctuation or an explicit language-package declaration.
      if (/^(?:the|a|an|this|that|our|software|version|for|is|was|contains|provides|implements|supports|uses|offers|includes|has|can|will)$/iu.test(name)) continue;
      const distinctive=/[a-z][A-Z]|[_0-9]|[.-][A-Za-z]/u.test(name);
      const qualified = /\b(?:R|Python|Julia|Java|JavaScript|Rust)\s+(?:package|library|framework|toolkit)\s+/u.test(match[0])
        || new RegExp('\\b(?:R|Python|Julia|Java|JavaScript|Rust)\\s+(?:package|library|framework|toolkit)\\s+'+escapeRegex(name)+'\\b','u').test(block.text)
        || new RegExp('\\b(?:package|library|framework|toolkit)\\s+'+escapeRegex(name)+'[.,;)]','u').test(block.text);
      if(distinctive||qualified) addName(name,'software',block.line);
    }
    for (const match of block.text.matchAll(/\(([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\)/gu)) {
      if (match[1].length<2) continue;
      const before=block.text.slice(Math.max(0,match.index!-100),match.index);
      if(!/[A-Za-z]{3,}[ -]+[A-Za-z]{3,}\s*$/u.test(before)) continue;
      addName(match[1],'acronym',block.line);
      for(const part of match[1].split('-')) if(part.length>=2) addName(part,'acronym',block.line);
    }
    const previous=blocks[index-1];
    const declaration=(previous?.page===block.page&&!previous.protection?previous.text+'\n':'')+block.text;
    for(const match of declaration.matchAll(/\b(?:[A-Za-z]+[- ]letter|letter|digit)[ -]+(?:subsets|classes|labels)\b[^:.]*:\s*([A-Za-z0-9]+(?:,\s*(?:and\s+)?[A-Za-z0-9]+)+)/gu)) {
      for(const name of match[1].split(/,\s*(?:and\s+)?/u)) addName(name,'label',block.line);
    }
  }
  const spans: PdfPreservedSpan[]=[];
  for (const [index,block] of blocks.entries()) {
    if (block.protection) continue;
    const found: PdfPreservedSpan[]=[];
    const add = (start: number,end: number,kind: PdfPreservedSpan['kind'],evidenceLine=block.line) => found.push({line:block.line,start,end,text:block.text.slice(start,end),kind,evidenceLine});
    for (const [name,evidence] of names) {
      if(evidence.kind==='label') {
        // A declared letter code is exempt only as a numeric-table row label.
        // The same spelling (e.g. "nor") in prose remains translatable.
        const peers=blocks.slice(index+1,index+3);
        if(block.text.trim()!==name||peers.length!==2||peers.some(peer=>peer.page!==block.page
          || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?%?$/u.test(peer.text.trim())
          || typeof peer.y!=='number'||typeof block.y!=='number'||Math.abs(peer.y-block.y)>1)) continue;
      }
      for(let start=block.text.indexOf(name);start>=0;start=block.text.indexOf(name,start+name.length)) {
        if(boundary(block.text,start,start+name.length)) add(start,start+name.length,evidence.kind,evidence.evidenceLine);
      }
    }
    const label=block.text.match(/^\s*\((?:[a-z]|[ivxlcdm]+|[A-Z]|[IVXLCDM]+)\)/u);
    if(label) {const start=label[0].indexOf('(');add(start,label[0].length,'label');}
    for(const match of block.text.matchAll(/https?:\/\/[^\s<>]+|\b(?:doi:\s*)?10\.\d{4,9}\/[^\s<>]+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/giu)) {
      const text=match[0].replace(/[.,;)]*$/u,'');add(match.index!,match.index!+text.length,'reference');
    }
    found.sort((a,b)=>a.start-b.start||b.end-a.end);
    let end=-1;
    for(const span of found) if(span.start>=end) {spans.push(span);end=span.end;}
  }
  return spans;
}

export function localPdfPreservedSpans(spans: PdfPreservedSpan[] | undefined, fromLine: number): PdfPreservedSpan[] | undefined {
  return spans?.filter(span=>span.line>=fromLine).map(span=>({...span,line:span.line-fromLine+1}));
}
