import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const text = await readFile('src/main/main.ts', 'utf8');
const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);
const names = ['prepareProposalLineReviewForApplication','withHtmlStateWriteLocks'];
const functions = source.statements.filter(node=>ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(functions.length, 2);
const code = ts.transpileModule(functions.map(node=>node.getText(source)).join('\n'), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const rows = {inert:false};
const renderer = vm.createContext({document:{getElementById:()=>rows},artifactImportBusy:false});
let release, entered;
const held = new Promise(resolve=>{release=resolve;});
const started = new Promise(resolve=>{entered=resolve;});
let preparations = 0;
const tab = {filePath:path.resolve('synthetic.html'),sourceStamp:'same',view:{webContents:{isDestroyed:()=>false,executeJavaScript:async script=>vm.runInContext(script,renderer)}}};
const queues = new Map();
const scope = vm.createContext({path,htmlStateWriteQueues:queues,htmlViewerTabs:new Map([['synthetic',tab]]),sameFilePath:(a,b)=>a===b,
  assertLineReviewMatchesProposalRouting:async()=>{},flushHtmlViewerTabState:async()=>{},
  prepareReviewHtmlOpen:async()=>{preparations++;entered();await held;return {changed:false,sourceStamp:'same'};},
  loadPreparedHtmlViewerTab:async()=>{throw Error('An unchanged prepared document must not reload');},console:{info:()=>{}}});
vm.runInContext(code+'\nglobalThis.prepare=prepareProposalLineReviewForApplication;',scope);
const first = scope.prepare(tab.filePath, {documentId:'synthetic'});
const second = scope.prepare(tab.filePath, {documentId:'synthetic'});
try {
  await started;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(preparations,1,'same-document preparations must serialize before touching the editor');
  assert.equal(rows.inert,true,'editing is frozen while the complete baseline is read');
} finally { release(); await Promise.all([first,second]); }
assert.equal(preparations,2);
assert.equal(rows.inert,false,'concurrent applications must restore the editable state');
assert.equal(queues.size,0);
console.log('PASS same-document preparation serializes without holding the sidecar queue or leaving the editor frozen');
