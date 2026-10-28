import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {renderLineReviewHtml} from '../../src/shared/core/html.ts';
import {prepareReviewHtmlOpen} from '../../src/main/reviewHtmlUpgrade.ts';
import {stringifyProjectJson} from '../../src/main/projectJson.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'yn-canonical-body-'));
try {
  const workspace = path.join(root, '.translation-workshop');
  const html = path.join(workspace, 'html', 'body.html');
  const sidecar = path.join(workspace, 'state', 'line-body.html.json');
  const old = path.join(root, 'old.txt'), current = path.join(root, 'current.txt');
  await mkdir(path.dirname(html), {recursive: true}); await mkdir(path.dirname(sidecar), {recursive: true});
  await writeFile(old, 'Old first.\nOld second.'); await writeFile(current, 'Current first.\nCurrent second.');
  await writeFile(html, renderLineReviewHtml({title:'Canonical body', sourceText:'Source one.\nSource two.', translationText:'Old first.\n', lineReviewPath:html,
    workflow:{outputDir:root, sourcePath:path.join(root,'source.txt'), translationPath:old, editableTranslationPath:old}}));
  await writeFile(sidecar, stringifyProjectJson(sidecar, {translationPath:current, translationPromptPath:current, documentRevision:4, edits:{1:'Manual first.'}}));
  const prepared = await prepareReviewHtmlOpen(html);
  assert.equal(prepared.payload.workflow.paths.translationPath, current);
  assert.deepEqual(prepared.payload.rows.map(row => row.translation), ['Current first.', 'Current second.']);
  assert.deepEqual(prepared.payload.rows.map(row => row.status), ['machine', 'machine']);
  assert.deepEqual(prepared.payload.workflow.initialTranslationLines, ['Current first.', 'Current second.']);
  assert.equal(JSON.parse(await readFile(sidecar, 'utf8')).edits[1], 'Manual first.', 'rebinding the baseline preserves pending manual edits');
  assert.equal((await prepareReviewHtmlOpen(html)).changed, false, 'a reconciled body is reused without rebuilding it');

  const boundEmpty = path.join(workspace, 'html', 'bound-empty.html');
  const boundState = path.join(workspace, 'state', 'line-bound-empty.html.json');
  await writeFile(boundEmpty, renderLineReviewHtml({title:'Bound but not imported',sourceText:'Source one.\nSource two.',lineReviewPath:boundEmpty,
    workflow:{outputDir:root,sourcePath:path.join(root,'source.txt'),translationPath:current,editableTranslationPath:current,translationPromptPath:current}}));
  const manualState = stringifyProjectJson(boundState, {translationPath:current,translationPromptPath:current,documentRevision:2,edits:{1:'Kept manual sentence.'},status:{1:'manual'},revisions:{1:2}});
  await writeFile(boundState, manualState);
  const imported = await prepareReviewHtmlOpen(boundEmpty);
  assert.deepEqual(imported.payload.rows.map(row=>row.translation), ['Current first.','Current second.'], 'an unchanged path alone does not mean the complete translation was imported');
  assert.deepEqual(imported.payload.workflow.initialTranslationLines, ['Current first.','Current second.']);
  assert.equal(await readFile(boundState,'utf8'), manualState, 'loading the baseline must retain manual sidecar revisions and edits');
  assert.equal((await prepareReviewHtmlOpen(boundEmpty)).changed, false, 'the loaded baseline should be reused');
  await writeFile(current, 'Updated first.\nUpdated second.');
  const refreshed = await prepareReviewHtmlOpen(boundEmpty, undefined, {refreshTranslation:true});
  assert.deepEqual(refreshed.payload.workflow.initialTranslationLines, ['Updated first.','Updated second.'], 'proposal application refreshes even an already-loaded file at the same path');
  assert.equal(await readFile(boundState,'utf8'), manualState);
  await writeFile(current, 'Current first.\nCurrent second.');
  const bilingualPath = path.join(root, 'paired.txt');
  const bilingualHtml = path.join(workspace, 'html', 'paired.html');
  await writeFile(bilingualPath, 'Target first.\nSource one.\nTarget second.\nSource two.');
  await writeFile(bilingualHtml, renderLineReviewHtml({title:'Bilingual baseline',sourceText:'Source one.\nSource two.',translationText:'Prior first.\nPrior second.',lineReviewPath:bilingualHtml,
    workflow:{outputDir:root,sourcePath:bilingualPath,translationPath:bilingualPath,editableTranslationPath:bilingualPath,inputMode:'bilingual',bilingualPair:{sourcePosition:2,translationPosition:1}}}));
  const paired = await prepareReviewHtmlOpen(bilingualHtml, undefined, {refreshTranslation:true});
  assert.deepEqual(paired.payload.workflow.initialTranslationLines, ['Target first.','Target second.'], 'refresh preserves the logical translation rows of bilingual TXT');
  const plannedHtml = path.join(workspace, 'html', 'planned-output.html');
  await writeFile(plannedHtml, renderLineReviewHtml({title:'Not translated yet',sourceText:'A source sentence.',lineReviewPath:plannedHtml,
    workflow:{outputDir:root,sourcePath:path.join(root,'new-source.txt'),translationPath:path.join(root,'unwritten-output.txt')}}));
  assert.equal((await prepareReviewHtmlOpen(plannedHtml)).payload.workflow.hasInitialTranslation, false, 'translation preparation can open an output that has not been written yet');
  await assert.rejects(prepareReviewHtmlOpen(plannedHtml, undefined, {refreshTranslation:true}), {code:'ENOENT'}, 'proofreading application still requires the actual complete translation');
  const folderChild = path.join(workspace, 'html', 'folder-child.html');
  await writeFile(folderChild, renderLineReviewHtml({title:'Folder bilingual child',sourceText:'Source one.\nSource two.',translationText:'Prior first.\nPrior second.',lineReviewPath:folderChild,
    workflow:{outputDir:root,sourcePath:bilingualPath,translationPath:bilingualPath,editableTranslationPath:bilingualPath,translationPromptPath:root,promptSourceKind:'folder',inputMode:'bilingual',bilingualPair:{sourcePosition:2,translationPosition:1}}}));
  assert.deepEqual((await prepareReviewHtmlOpen(folderChild, undefined, {refreshTranslation:true})).payload.workflow.initialTranslationLines, ['Target first.','Target second.'], 'a folder prompt must not be read as the child translation file');
  const epub = path.join(root, 'book.epub');
  const importedBody = path.join(workspace, 'html', 'imported-epub.html');
  const projection = path.join(workspace, 'source.txt');
  await writeFile(projection, 'Source one.\nSource two.');
  await writeFile(importedBody, renderLineReviewHtml({title:'Imported EPUB body', sourceText:'Source one.\nSource two.', lineReviewPath:importedBody,
    workflow:{outputDir:root,sourcePath:epub,validationSourcePath:projection,sourcePromptPath:projection,translationPath:'',editableTranslationPath:path.join(workspace,'empty-working.txt'),epubExport:{mode:'all'}}}));
  const project = path.join(workspace, 'project.json');
  await writeFile(project, stringifyProjectJson(project, {sourcePath:epub,sourceKind:'file',translationPath:current,translationBindingOrigin:'user'}));
  const adopted = await prepareReviewHtmlOpen(importedBody);
  assert.equal(adopted.payload.workflow.paths.promptTranslationPath,current,'an initially unbound body must adopt the same source document’s selected project translation');
  assert.deepEqual(adopted.payload.rows.map(row=>row.translation),['Current first.','Current second.']);
  assert.equal(adopted.payload.workflow.paths.sourcePath,epub,'canonical translation adoption retains the EPUB template');
  assert.ok(adopted.html.includes('id="exportEpub"'));

  const explicitBody = path.join(workspace, 'html', 'explicit-epub.html');
  await writeFile(explicitBody, renderLineReviewHtml({title:'Explicit EPUB binding',sourceText:'Source one.\nSource two.',translationText:'Old first.\nOld second.',lineReviewPath:explicitBody,
    workflow:{outputDir:root,sourcePath:epub,translationPath:old,editableTranslationPath:old,translationPromptPath:old}}));
  const explicit = await prepareReviewHtmlOpen(explicitBody);
  assert.equal(explicit.payload.workflow.paths.translationPath,old,'project selection cannot override an explicit document binding');
  assert.deepEqual(explicit.payload.rows.map(row=>row.translation),['Old first.','Old second.']);

  const pendingBody = path.join(workspace,'html','pending-epub.html');
  const pendingState = path.join(workspace,'state','line-pending-epub.html.json');
  await writeFile(pendingBody,renderLineReviewHtml({title:'Pending edits',sourceText:'Source one.\nSource two.',lineReviewPath:pendingBody,
    workflow:{outputDir:root,sourcePath:epub,translationPath:''}}));
  const pendingText=stringifyProjectJson(pendingState,{documentRevision:2,edits:{2:'Pending manual edit.'}});
  await writeFile(pendingState,pendingText);
  assert.equal((await prepareReviewHtmlOpen(pendingBody)).payload.workflow.paths.translationPath,current);
  assert.equal(await readFile(pendingState,'utf8'),pendingText,'adopting the baseline cannot rewrite pending sidecar edits');

  const unrelated = path.join(workspace,'html','unrelated.html');
  await writeFile(unrelated,renderLineReviewHtml({title:'Different document',sourceText:'Different source.',lineReviewPath:unrelated,
    workflow:{outputDir:root,sourcePath:path.join(root,'different.epub'),translationPath:''}}));
  assert.equal((await prepareReviewHtmlOpen(unrelated)).payload.workflow.paths.translationPath,'','project bindings must not attach to a different source document');
  console.log('PASS canonical body rebind refreshes embedded baseline and preserves manual sidecar edits');
} finally {
  assert.ok(root.startsWith(path.join(os.tmpdir(), 'yn-canonical-body-')));
  await rm(root, {recursive:true, force:true});
}
