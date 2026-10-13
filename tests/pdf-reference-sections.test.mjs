import assert from 'node:assert/strict';
import {pdfReferenceSections} from '../src/main/pdfReferenceSections.ts';
const block=(line,text,page=1,y=line*30,fontSize=10)=>({line,text,page,x:40,y,width:400,height:15,fontSize});
const pages=[{page:1,width:600,height:800},{page:2,width:600,height:800}];
const layout={pages,blocks:[block(1,'Methods'),block(2,'Ordinary prose.',1,70),block(3,'References',1,110,16),
  block(4,'Smith, A. (2021). A scientific paper.',1,145),block(5,'Another citation.',2,40),
  block(6,'Appendix A. Proofs',2,90,16),block(7,'A proof still requires translation.',2,130)]};
const refs=pdfReferenceSections(layout);
assert.deepEqual(refs.protectedLines.map(row=>row.line),[3,4,5]);assert.equal(refs.protectedLines[0].kind,'reference');
assert.equal(pdfReferenceSections({pages,blocks:[block(1,'We refer to References for details.'),block(2,'Ordinary prose.')]}).protectedLines.length,0);
assert.equal(pdfReferenceSections({pages,blocks:[block(1,'参考文献'),block(2,'某作者（2020）。论文。')]}).protectedLines.length,2);
assert.deepEqual(pdfReferenceSections({pages,blocks:[block(1,'References',1,40,12),block(2,'A. Smith and B. Jones. An article.',1,80,12)]}).protectedLines.map(row=>row.line),[1,2],'author initials must not end the bibliography');
console.log('PDF reference headings preserve bibliography through pages, stop at appendix and leave prose references alone');
