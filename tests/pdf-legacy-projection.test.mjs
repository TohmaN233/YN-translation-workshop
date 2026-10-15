import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {readPdfLayout,assertPdfProtectedWrite,createTranslatedPdf} from '../src/main/pdfDocuments.ts';
import {PDF_LAYOUT_VERSION} from '../src/main/pdfTypes.ts';
import {preparePdfDocument} from './helpers/pdf-structure-backend.mjs';

const temporaryDirectory=path.resolve(os.tmpdir());
const root=await mkdtemp(path.join(temporaryDirectory,'yn-pdf-legacy-'));
try {
  const original=path.join(root,'synthetic.pdf'),document=await PDFDocument.create();
  const page=document.addPage([400,500]),font=await document.embedFont(StandardFonts.Helvetica);
  page.drawText('The courier loads a blue crate.',{x:40,y:420,size:12,font});
  await writeFile(original,await document.save());
  const prepared=await preparePdfDocument(original,path.join(root,'.translation-workshop'));
  const sourcePath=prepared.sourcePath,layoutPath=sourcePath+'.pdf-layout.json';
  const sourceBytes=await readFile(sourcePath),layout=JSON.parse(await readFile(layoutPath,'utf8'));
  layout.version=PDF_LAYOUT_VERSION-1;
  await writeFile(layoutPath,JSON.stringify(layout));
  const layoutBytes=await readFile(layoutPath),obsolete=/obsolete|re-prepare|regenerate|version/i;
  await assert.rejects(readPdfLayout(sourcePath,root),obsolete);
  await assert.rejects(assertPdfProtectedWrite(sourcePath,root,[{line:1,text:'A translated parcel label.'}]),obsolete);
  await assert.rejects(createTranslatedPdf({templatePath:original,sourcePath,projectRoot:root,translatedLines:sourceBytes.toString('utf8').split('\n')}),obsolete);
  assert.deepEqual(await readFile(sourcePath),sourceBytes);
  assert.deepEqual(await readFile(layoutPath),layoutBytes,'Rejection must not rewrite stale row ownership.');
  console.log('Synthetic legacy projection is rejected for reading, protected writes and PDF export without changing its files.');
} finally {
  assert.equal(path.dirname(path.resolve(root)),temporaryDirectory);
  await rm(root,{recursive:true,force:true});
}
