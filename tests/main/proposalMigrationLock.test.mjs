import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import ts from 'typescript';
import {mergeLegacyProposalLineReviewState} from '../../src/main/lineReviewStateSync.ts';

const source = await readFile('src/main/main.ts', 'utf8');
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = ['withHtmlStateWriteLocks', 'migrateLegacySingleProposalLineReviews'];
const functions = names.map(name => tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(tree)).join('\n');
const root = path.join(os.tmpdir(), 'synthetic-migration-lock');
const canonical = path.join(root, '.translation-workshop', 'state', 'line-body.html.json');
const legacy = path.join(root, '.translation-workshop', 'state', 'line-duplicate.html.json');
const duplicate = path.join(root, '.translation-workshop', 'html', 'proposal-line-review', 'duplicate.html');
const states = new Map([[canonical, {edits:{1:'Earlier manual text'}, documentRevision:2}], [legacy, {edits:{2:'Accepted suggestion'}}]]);
const files = new Set([canonical, legacy, duplicate]);
let canonicalReads = 0;
const context = vm.createContext({path, htmlStateWriteQueues:new Map(), mergeLegacyProposalLineReviewState,
  normalizeProjectFolder:() => ({workspaceDir:path.join(root,'.translation-workshop')}),
  isSameOrInside:(parent, file) => file.startsWith(parent + path.sep), sameFilePath:(a,b) => a===b,
  discoverLegacyProposalLineReviews:async() => [{htmlPath:duplicate,statePath:legacy,modifiedMs:1,state:{edits:{2:'Stale discovery snapshot'}}}],
  assertLineReviewMatchesProposalRouting:async()=>{}, resolveLineReviewSidecarStatePath:async()=>canonical,
  readOptionalJsonObjectStrict:async file => {if(file===canonical)canonicalReads++;return structuredClone(states.get(file));},
  ensureTransactionalTextTarget:async()=>{}, projectJson:(_file,state)=>JSON.stringify(state),
  writeTextFileAtomically:async(file,text)=>states.set(file,JSON.parse(text)), broadcastLineReviewState:()=>{},
  existingFile:async file=>files.has(file),rm:async file=>{files.delete(file);states.delete(file);},readdir:async()=>[],console:{info:()=>{}}
});
vm.runInContext(ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
let release;
const writer = context.withHtmlStateWriteLocks([canonical],async()=>{
  await new Promise(resolve=>{release=resolve;});
  states.set(canonical,{edits:{1:'Latest manual text'},documentRevision:3});
});
while(!release)await new Promise(resolve=>setImmediate(resolve));
const migration = context.migrateLegacySingleProposalLineReviews(root,path.join(root,'.translation-workshop','html','body.html'),{documentId:'book.txt'});
await new Promise(resolve=>setImmediate(resolve));
try {assert.equal(canonicalReads,0,'migration must wait for an in-flight canonical save before taking its snapshot');}
finally {release();await writer;await migration;}
assert.equal(states.get(canonical).edits[1],'Latest manual text');
assert.equal(states.get(canonical).edits[2],'Accepted suggestion','migration rereads the duplicate inside its lock');
assert.equal(files.has(duplicate),false);
console.log('PASS actual duplicate migration waits for canonical writes and preserves concurrent manual edits');
