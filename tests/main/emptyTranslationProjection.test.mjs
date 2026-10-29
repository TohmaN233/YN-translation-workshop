import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {renderLineReviewHtml,LINE_REVIEW_PROTOCOL_MARKER} from '../../src/shared/core/html.ts';
import {prepareReviewHtmlOpen} from '../../src/main/reviewHtmlUpgrade.ts';
import {stringifyProjectJson} from '../../src/main/projectJson.ts';

const root=await mkdtemp(path.join(os.tmpdir(),'yn-empty-projection-'));
try {
  const workspace=path.join(root,'.translation-workshop'),htmlDir=path.join(workspace,'html');
  await mkdir(htmlDir,{recursive:true});
  for(const [name,sourceText,emptyText] of [
    ['legacy-multiple','First synthetic sentence.\nSecond synthetic sentence.\nThird synthetic sentence.','\n\n'],
    ['legacy-single','One synthetic sentence.',''],
    ['legacy-protocol','First synthetic sentence.\nSecond synthetic sentence.','\n'],
    ['aligned','First synthetic sentence.\nSecond synthetic sentence.','\n\n']
  ]) {
    const file=path.join(htmlDir,name+'.html'),projection=path.join(workspace,'extracted-text',name,'translation','book.txt');
    await mkdir(path.dirname(projection),{recursive:true});await writeFile(projection,emptyText);
    const sourcePath=path.join(root,name+'.epub'),projectPath=path.join(workspace,'project.json');
    await writeFile(projectPath,stringifyProjectJson(projectPath,{sourcePath,sourceKind:'file',translationPath:''}));
    const html=renderLineReviewHtml({title:name,sourceText,lineReviewPath:file,workflow:{outputDir:root,sourcePath,translationPath:'',editableTranslationPath:projection}});
    await writeFile(file,name==='legacy-protocol'?html.replace(LINE_REVIEW_PROTOCOL_MARKER,'translation-workshop-line-review-v55'):html);
    const opened=await prepareReviewHtmlOpen(file);
    assert.equal(opened.payload.workflow.hasInitialTranslation,false);
    assert.equal(opened.payload.workflow.paths.translationPath,'','an untouched generated draft is not a canonical translation binding');
    assert(opened.payload.rows.every(row=>row.translation===''));
    assert.equal(await readFile(projection,'utf8'),emptyText,'opening must not rewrite a generated draft');
    if(name!=='aligned')await assert.rejects(prepareReviewHtmlOpen(file,undefined,{refreshTranslation:true}),/Canonical translation line count/,'forced canonical loading still validates the exact line count');

    await writeFile(projection,'Partial synthetic translation.');
    if(sourceText.includes('\n'))await assert.rejects(prepareReviewHtmlOpen(file),/Canonical translation line count/,'nonblank mismatches remain visible');
    await writeFile(projection,emptyText);
    const statePath=path.join(workspace,'state','line-'+name+'.html.json');
    await mkdir(path.dirname(statePath),{recursive:true});
    await writeFile(statePath,stringifyProjectJson(statePath,{translationPath:projection,documentRevision:1,edits:{1:'Manual synthetic edit.'}}));
    if(name!=='aligned')await assert.rejects(prepareReviewHtmlOpen(file),/Canonical translation line count/,'explicit bindings cannot be treated as planned drafts');
    assert.equal(JSON.parse(await readFile(statePath,'utf8')).edits[1],'Manual synthetic edit.');
    console.log('PASS '+name+' planned translation projection');
  }
} finally {
  assert(root.startsWith(path.join(os.tmpdir(),'yn-empty-projection-')));
  await rm(root,{recursive:true,force:true});
}
