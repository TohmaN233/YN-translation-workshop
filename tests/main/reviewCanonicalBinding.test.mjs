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
  console.log('PASS canonical body rebind refreshes embedded baseline and preserves manual sidecar edits');
} finally {
  assert.ok(root.startsWith(path.join(os.tmpdir(), 'yn-canonical-body-')));
  await rm(root, {recursive:true, force:true});
}
