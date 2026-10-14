import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { readPdfLayout, assertPdfProtectedWrite, createTranslatedPdf } from '../src/main/pdfDocuments.ts';
import { PDF_LAYOUT_VERSION, PDF_EXTRACTOR_REVISION } from '../src/main/pdfTypes.ts';

const captured = process.env.YN_PDF_INLINE_REORDER_CAPTURED_ROOT;
if (!captured) {
  console.log('skip legacy captured PDF projection rejection (set YN_PDF_INLINE_REORDER_CAPTURED_ROOT to the authorized read-only e4 fixture)');
} else {
  const root = await mkdtemp(path.resolve('.tmp-captured-reorder-')), project = path.join(root, 'project');
  try {
    await cp(path.join(captured, 'project-copy'), project, { recursive: true });
    const projections = await readdir(path.join(project, '.translation-workshop', 'extracted-text'));
    assert.equal(projections.length, 1);
    const sourcePath = path.join(project, '.translation-workshop', 'extracted-text', projections[0], 'source', 'main.txt');
    const sourceBytes = await readFile(sourcePath), layoutBytes = await readFile(sourcePath + '.pdf-layout.json');
    const oldLayout = JSON.parse(layoutBytes.toString('utf8'));
    assert.ok(oldLayout.version !== PDF_LAYOUT_VERSION || oldLayout.extractorRevision !== PDF_EXTRACTOR_REVISION, 'This fixture exercises the obsolete projection contract; current capture tests use freshly prepared source rows.');
    const obsolete = /obsolete|re-prepare|regenerate|version/i;
    await assert.rejects(readPdfLayout(sourcePath, project), obsolete, 'Old row numbers and review evidence cannot migrate into the new paragraph mapping.');
    await assert.rejects(assertPdfProtectedWrite(sourcePath, project, [{ line: 40, text: 'legacy candidate' }]), obsolete);
    await assert.rejects(createTranslatedPdf({ templatePath: path.join(project, 'main.pdf'), sourcePath, projectRoot: project, translatedLines: sourceBytes.toString('utf8').split('\n') }), obsolete);
    assert.deepEqual(await readFile(sourcePath), sourceBytes, 'Rejection retains the legacy source projection.');
    assert.deepEqual(await readFile(sourcePath + '.pdf-layout.json'), layoutBytes, 'No version/hash rewriting can authorize stale row ownership.');
    console.log('Legacy captured e4 projection explicitly rejected for reading, protected writes and export; original source/mapping retained.');
  } finally { await rm(root, { recursive: true, force: true }); }
}
