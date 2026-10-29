import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createModels,fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai';
import {runPiTranslationSubagent} from '../../src/main/agent/piNative/subagentRunner.ts';
import {createZipBuffer} from '../../src/main/zipWriter.ts';
import {prepareBuiltinTaskDocuments} from '../../src/main/builtinTaskDocuments.ts';
import {builtinTaskDefaults} from '../../src/shared/builtinTasks.ts';
import {readProjectFile} from '../../src/main/agent/projectFileTools.ts';
import {agentChatRouteFromReviewData} from '../../src/shared/core/agentChatRoute.ts';
import {normalizeEmbeddedRoute} from '../../src/renderer/agent/embeddedRoute.ts';
import {parsePiSessionPromptRequest} from '../../src/main/ipc/agentSessionRequest.ts';
import {renderLineReviewHtml} from '../../src/shared/core/html.ts';
import {agentChatFlowVersion} from '../../src/shared/core/agentChatEmbed.ts';
import {needsLegacyLineReviewUpgrade} from '../../src/shared/core/legacyHtml.ts';
import {prepareReviewHtmlOpen} from '../../src/main/reviewHtmlUpgrade.ts';
import {createYnDomainTools} from '../../src/main/agent/piNative/ynDomainTools.ts';
import {resolvePiSourceManifest,resolvePiSourceDocument,resolvePiReadablePath,bindPiSourceDocument} from '../../src/main/agent/piNative/sourceManifest.ts';

const root=await mkdtemp(path.join(os.tmpdir(),'yn-folder-epub-paths-'));
try {
  const sourceRoot=path.join(root,'originals');await mkdir(sourceRoot);
  const originals=[];
  for(const [id,text] of [['first.epub','First independent synthetic source.'],['nested/second.epub','Second independent synthetic source.']]){
    const file=path.join(sourceRoot,...id.split('/'));await mkdir(path.dirname(file),{recursive:true});
    const bytes=createZipBuffer([
      {path:'mimetype',data:Buffer.from('application/epub+zip'),store:true},
      {path:'META-INF/container.xml',data:Buffer.from('<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>')},
      {path:'EPUB/package.opf',data:Buffer.from('<package><manifest><item id="body" href="body.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="body"/></spine></package>')},
      {path:'EPUB/body.xhtml',data:Buffer.from('<html><body><p>'+text+'</p></body></html>')}
    ]);await writeFile(file,bytes);originals.push({id,file,text,bytes});
  }
  const prepared=await prepareBuiltinTaskDocuments(builtinTaskDefaults({outputDir:root,sourcePath:sourceRoot,sourceKind:'folder',inputMode:'separate',fileType:'epub'}));
  const route=normalizeEmbeddedRoute(agentChatRouteFromReviewData({workflow:{paths:{outputDir:root,sourcePath:originals[0].file,validationSourcePath:prepared.documents[0].sourcePath,promptSourcePath:sourceRoot,promptSourceKind:'folder',sourceKind:'file'},advanced:prepared.advanced}}));
  assert.deepEqual(route.folderSourceDocuments,prepared.advanced.folderSourceDocuments,'ordinary folder chat retains the extracted TXT manifest');
  assert.equal(route.folderSourceSelection,'prepared-inputs');
  const modulePath=path.join(root,'request-builder.mjs');
  await build({entryPoints:[path.resolve('src/renderer/agent/piweb/useAgentSession.ts')],outfile:modulePath,bundle:true,platform:'node',format:'esm'});
  const {buildPiSessionPromptRequest}=await import(pathToFileURL(modulePath).href);
  const current={providerId:'synthetic',modelId:'synthetic'};
  const request=parsePiSessionPromptRequest(buildPiSessionPromptRequest(route,current,'synthetic-folder','Inspect the prepared sources.'));
  assert.equal(request.workflowIntent,undefined,'carrying source bindings does not start translation');
  assert.deepEqual(request.folderSourceDocuments,prepared.advanced.folderSourceDocuments);
  const override=buildPiSessionPromptRequest(route,current,'synthetic-folder','Translate the selected source.',undefined,{workflowIntent:'translation',languagePair:'en->zh-CN',folderSourceDocuments:[prepared.advanced.folderSourceDocuments[1]],folderSourceSelection:'prepared-inputs'});
  assert.equal((await resolvePiSourceManifest(override)).documents.length,1,'explicit prompt source metadata wins over the ordinary-chat baseline');
  const manifest=await resolvePiSourceManifest(request);assert.equal(manifest.documents.length,2);
  const hostTools=createYnDomainTools({request,publishCustomMessage:async()=>{}});
  for(const original of originals){
    const document=manifest.documents.find(item=>item.id===original.id);
    assert(document.path.endsWith('.txt'));assert.equal(await readFile(document.path,'utf8'),original.text);
    assert.equal(resolvePiSourceDocument(manifest,original.file)?.path,document.path,'absolute original document references select the extracted TXT');
    assert.equal(resolvePiReadablePath(request,original.file),document.path,'parent reads must not decode the original EPUB as UTF-8');
    const read=await readProjectFile({outputDir:root,relativePath:resolvePiReadablePath(request,original.file)});
    assert.equal(read.ok,true);assert.equal(read.content,original.text,'the actual project reader sees extracted text, never ZIP bytes');
    const bound=bindPiSourceDocument(request,document);
    assert.equal(resolvePiReadablePath(bound,original.file),document.path,'a bound worker uses the same original-to-projection identity');
    assert.equal(resolvePiReadablePath(bound,original.id),document.path);
    const selected=await hostTools.find(tool=>tool.name==='selectSourceDocument').execute('synthetic-select',{documentId:original.file});
    assert.equal(selected.details.sourcePath,document.path,'the actual Host binds the projected TXT after source selection');
    const sourceRead=await hostTools.find(tool=>tool.name==='readSourceLines').execute('synthetic-source-read',{fromLine:1,toLine:1});
    assert.deepEqual(sourceRead.details.lines,[original.text]);
    const provider=fauxProvider({provider:'synthetic-folder-'+originals.indexOf(original),tokensPerSecond:1000000});
    const models=createModels();models.setProvider(provider.provider);
    const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
    provider.setResponses([
      call('readAssignedSource',{}),
      context=>{
        const read=context.messages.filter(message=>message.role==='toolResult').at(-1);
        assert.equal(Boolean(read.isError),false);
        assert(JSON.stringify(read.content).includes(original.text),'native child reads its extracted source, never EPUB bytes');
        return call('repairAssignedTranslation',{entries:[{line:1,translation:'独立合成译文。'}]});
      },
      call('validateAssignedTranslation',{})
    ]);
    const child=await runPiTranslationSubagent({
      request:{...bound,sessionId:'synthetic-epub-child-'+originals.indexOf(original),providerId:provider.provider.id,modelId:provider.getModel().id,languagePair:'en->zh-CN'},
      task:{fromLine:1,toLine:1},publishCustomMessage:async()=>{},
      createModelSelection:async()=>({models,model:provider.getModel(),providerId:provider.provider.id,modelId:provider.getModel().id})
    });
    assert.match(child.reply,/Child-validated candidate L1-L1/i);
    assert((await readFile(original.file)).equals(original.bytes),'EPUB inputs stay read-only');
  }
  const unrelated=path.join(root,'unselected','first.epub');
  assert.equal(resolvePiReadablePath(request,unrelated),unrelated,'an absolute path with the same basename is not an alias');
  assert.equal(resolvePiSourceDocument(manifest,unrelated),undefined);
  const single=normalizeEmbeddedRoute(agentChatRouteFromReviewData({workflow:{paths:{outputDir:root,sourcePath:originals[0].file,promptSourcePath:prepared.documents[0].sourcePath,sourceKind:'file'},advanced:prepared.advanced}}));
  const singleRequest=buildPiSessionPromptRequest(single,current,'synthetic-single','Inspect this source.');
  assert.equal(singleRequest.sourcePath,prepared.documents[0].sourcePath);assert.equal(singleRequest.folderSourceDocuments,undefined);
  assert.equal((await resolvePiSourceManifest(singleRequest)).documents.length,1);
  const htmlPath=path.join(root,'.translation-workshop','html','legacy-folder-child.html');await mkdir(path.dirname(htmlPath),{recursive:true});
  const oldHtml=renderLineReviewHtml({title:'Synthetic folder child',sourceText:prepared.documents[0].sourceText,lineReviewPath:htmlPath,workflow:{outputDir:root,sourcePath:originals[0].file,validationSourcePath:prepared.documents[0].sourcePath,sourcePromptPath:sourceRoot,promptSourceKind:'folder',advanced:prepared.advanced}}).replaceAll(agentChatFlowVersion,'pi-web-react-embedded-v14');
  assert(needsLegacyLineReviewUpgrade(oldHtml));await writeFile(htmlPath,oldHtml);
  const upgraded=await prepareReviewHtmlOpen(htmlPath);
  const reopened=normalizeEmbeddedRoute(agentChatRouteFromReviewData(upgraded.payload,htmlPath));
  assert.deepEqual(reopened.folderSourceDocuments,prepared.advanced.folderSourceDocuments);
  assert.equal((await resolvePiSourceManifest(buildPiSessionPromptRequest(reopened,current,'synthetic-reopen','Inspect the sources.'))).documents.length,2,'upgraded existing folder HTML retains ordinary-chat TXT bindings');
  console.log('PASS multiple EPUB source identities resolve to their exact extracted TXT paths');
} finally {
  assert(root.startsWith(path.join(os.tmpdir(),'yn-folder-epub-paths-')));
  await rm(root,{recursive:true,force:true});
}
