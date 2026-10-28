import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('src/shared/core/html.ts', 'utf8');
const restore = source.slice(source.indexOf('async function restoreSyncedText('), source.indexOf('\ndocument.getElementById("translatePrompt")', source.indexOf('async function restoreSyncedText(')));
const value = source.slice(source.indexOf('function rowValue(row)'), source.indexOf('\nfunction pdfInlineHtml', source.indexOf('function rowValue(row)')));

async function restoredLines({preparedImport, currentImport, cached, prepared = true}) {
  let reads = 0;
  const scope = {
    workflow: prepared ? {initialTranslationSyncedAt:preparedImport} : {},
    state: {syncedFile:'synthetic-translation.txt',syncedAt:currentImport,edits:{2:'Preserved manual sentence.'}},
    syncedLines:['Complete first.','Complete second.','Complete third.'],
    readSyncedText:async()=>{ reads++; return cached; },
    splitSyncedText:text=>text.split('\n'),
    render:()=>{}, setAiStatus:()=>{}, data:{labels:{synced:'loaded'}}
  };
  vm.runInNewContext(restore+'\n'+value+'\nglobalThis.restore=restoreSyncedText; globalThis.value=rowValue;', scope);
  await scope.restore(false);
  return {lines:[1,2,3].map(line=>scope.value({line,translation:''})),reads};
}

const retained = await restoredLines({preparedImport:'prior-import',currentImport:'prior-import',cached:'\n\n'});
assert.deepEqual(retained.lines,['Complete first.','Preserved manual sentence.','Complete third.'], 'an old empty cache must not erase the Host-prepared complete baseline');
assert.equal(retained.reads,0);

const later = await restoredLines({preparedImport:'prior-import',currentImport:'later-import',cached:'Later first.\nLater second.\nLater third.'});
assert.deepEqual(later.lines,['Later first.','Preserved manual sentence.','Later third.'], 'a subsequent explicit import remains usable');
assert.equal(later.reads,1);

const legacy = await restoredLines({prepared:false,currentImport:'legacy-import',cached:'Cached first.\nCached second.\nCached third.'});
assert.deepEqual(legacy.lines,['Cached first.','Preserved manual sentence.','Cached third.'], 'unprepared local history keeps its persistent imported copy');
console.log('PASS complete Host baseline wins over stale cache, later imports and manual edits survive');
