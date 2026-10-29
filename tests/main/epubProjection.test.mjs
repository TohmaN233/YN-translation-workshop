import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writeEpubProjection } from '../../src/main/epubProjection.ts';
import { extractedWorkshopTextPath } from '../../src/main/agent/translationBindingResolve.ts';
import { createZipBuffer } from '../../src/main/zipWriter.ts';
import { readEpubText } from '../../src/main/epubReader.ts';
import { generateBuiltinTaskReview } from '../../src/main/builtinTaskDocuments.ts';
import { builtinTaskDefaults } from '../../src/shared/builtinTasks.ts';
import { resolveProposalSourceIdentity } from '../../src/main/proposalSourceIdentity.ts';
import { stringifyProjectJson } from '../../src/main/projectJson.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'yn-epub-projection-'));
try {
 const workspace=path.join(root,'.translation-workshop'),source=path.join(root,'book.epub');
 const xhtml='<html><body><!--\n<p>Hidden notice</p>\nHidden footer\n-->\n<p>First visible.</p>\n<p>Second visible.</p></body></html>';
 await writeFile(source,createZipBuffer([
  {path:'mimetype',data:Buffer.from('application/epub+zip'),store:true},
  {path:'META-INF/container.xml',data:Buffer.from('<container><rootfiles><rootfile full-path="EPUB/book.opf"/></rootfiles></container>')},
  {path:'EPUB/book.opf',data:Buffer.from('<package><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>')},
  {path:'EPUB/body.xhtml',data:Buffer.from(xhtml)}
 ]));
 const legacy=await readEpubText(source,workspace,'legacy','legacy-verification');
 const current=await readEpubText(source,workspace,'current');
 assert.equal(legacy.split('\n').length,5);assert.equal(current.split('\n').length,2);
 const base=extractedWorkshopTextPath(workspace,source,'source');
 await mkdir(path.dirname(base),{recursive:true});await writeFile(base,legacy);
 const revised=await writeEpubProjection(base,current);assert.notEqual(revised,base);
 assert.equal(await writeEpubProjection(base,current),revised);assert.equal(await readFile(base,'utf8'),legacy);
 await writeFile(path.join(workspace,'project.json'),stringifyProjectJson(path.join(workspace,'project.json'),{sourcePath:source,inputMode:'separate'},root));
 for(const projection of [base,revised]){const identity=await resolveProposalSourceIdentity(root,projection);assert.equal(identity.sourcePath,source);assert.equal(identity.validationSourcePath,projection);assert.equal(identity.epubExport.mode,'all');}
 const target=path.join(root,'AI_translation','book_translated.txt');await mkdir(path.dirname(target),{recursive:true});
 const oldTarget=legacy.split('\n').map((_,i)=>'Existing target '+i).join('\n');await writeFile(target,oldTarget);
 const settings=builtinTaskDefaults({sourcePath:source,sourceKind:'file',outputDir:root,fileType:'epub',inputMode:'separate'});
 await assert.rejects(generateBuiltinTaskReview(settings,'translation','new-review'),/different source projection/);
 assert.equal(await readFile(base,'utf8'),legacy);assert.equal(await readFile(target,'utf8'),oldTarget);
 await writeFile(target,'New first target.\nNew second target.');
 await generateBuiltinTaskReview({...settings,translationPath:target},'translation','explicit-current');
 await generateBuiltinTaskReview(settings,'translation','reuse-current');
 assert.equal(await readFile(target,'utf8'),'New first target.\nNew second target.');
 const moved=await mkdtemp(path.join(os.tmpdir(),'yn-epub-projection-moved-'));
 try {
   await cp(root,moved,{recursive:true});
   const movedSource=path.join(moved,'book.epub'),movedProjection=path.join(moved,path.relative(root,revised));
   assert.equal((await resolveProposalSourceIdentity(moved,movedProjection)).sourcePath,movedSource);
   await generateBuiltinTaskReview({...settings,sourcePath:movedSource,outputDir:moved},'translation','after-move');
 }finally{await rm(moved,{recursive:true,force:true});}
 const aba=path.join(root,'aba');await mkdir(aba);const abaSource=path.join(aba,'book.epub'),abaTarget=path.join(aba,'AI_translation','book_translated.txt');await mkdir(path.dirname(abaTarget),{recursive:true});
 const bookFor=label=>createZipBuffer([
  {path:'mimetype',data:Buffer.from('application/epub+zip'),store:true},
  {path:'META-INF/container.xml',data:Buffer.from('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')},
  {path:'book.opf',data:Buffer.from('<package><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>')},
  {path:'body.xhtml',data:Buffer.from('<html><body><p>'+label+' source one.</p><p>'+label+' source two.</p></body></html>')}
 ]);
 const abaSettings=builtinTaskDefaults({sourcePath:abaSource,sourceKind:'file',outputDir:aba,fileType:'epub',inputMode:'separate'});
 for(const label of ['A','B']){await writeFile(abaSource,bookFor(label));await writeFile(abaTarget,label+' target one.\n'+label+' target two.');await generateBuiltinTaskReview({...abaSettings,translationPath:abaTarget},'translation','bind-'+label);}
 await writeFile(abaSource,bookFor('A'));
 await assert.rejects(generateBuiltinTaskReview(abaSettings,'translation','implicit-after-restore'),/different source projection/);
 console.log('ok EPUB projections are immutable, revised source resolves its original, and new reviews cannot adopt unrelated old canonical rows');
}finally{await rm(root,{recursive:true,force:true});}
