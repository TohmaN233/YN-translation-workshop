import assert from 'node:assert/strict';import vm from 'node:vm';import ts from 'typescript';import {readFile} from 'node:fs/promises';
const source=await readFile('src/main/main.ts','utf8'),tree=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
const fn=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='applyLineReviewStateToView');assert.ok(fn);
const body=ts.transpileModule(fn.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const text='manual "quote" \\ slash\n\0\u2028\u2029</script>角色';
const state={edits:{1:'old',2:text},status:{1:'manual',2:'manual'},revisions:{2:9},revisionHistory:{2:[{text}]},theme:{}};
let saves=0,storedSmall=0;
const renderer=vm.createContext({state,location:{pathname:'/review.html'},lineReviewStorageKey:()=> 'primary',
 localStorage:{getItem:()=>'{"page":1}',setItem:()=>{throw new Error('Full localStorage write is forbidden in Electron');}},
 applyingCanonicalState:false,storeLineReviewStateLocally:()=>storedSmall++,render:()=>assert.equal(renderer.applyingCanonicalState,true),
 requestAnimationFrame:callback=>callback(),jumpToLine:()=>{},save:async lines=>{saves++;assert.deepEqual(Array.from(lines),[1]);}});
let script='';const tab={view:{webContents:{executeJavaScript:async text=>{script=text;return vm.runInContext(text,renderer);}}}};
const main=vm.createContext({normalizeLinkedHtmlFilePath:value=>value,loadHtmlViewerTab:async()=>({key:'test',tab}),
 assertPdfLineReviewState:async()=>{},activateHtmlViewerTab:()=>false,rememberHtmlViewerTabProject:async()=>{}});
vm.runInContext(body,main);
await main.applyLineReviewStateToView({lineReviewPath:'G:/project/review.html',lines:[1],lineState:{edits:{1:'updated'},status:{1:'manual'}},activate:false});
assert.equal(state.edits[1],'updated');assert.equal(state.edits[2],text);assert.equal(state.status[2],'manual');assert.equal(state.revisions[2],9);assert.equal(state.revisionHistory[2][0].text,text);
assert.match(script,/const incomingState = JSON\.parse\(/);assert.equal(saves,1);assert.equal(storedSmall,1);
console.log('Actual legacy apply uses the live draft, preserves untouched manual rows and writes one small patch');
