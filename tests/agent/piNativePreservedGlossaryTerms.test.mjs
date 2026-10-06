import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createYnDomainTools } from '../../src/main/agent/piNative/ynDomainTools.ts';
import { createYnDomainRunContract } from '../../src/main/agent/piNative/domainRunContract.ts';
import { createPiTranslationRuntimeSpec } from '../../src/main/agent/piNative/subagentRunner.ts';
import { mergeProjectGlossaryEntries,readProjectAssets } from '../../src/main/agent/projectAssets.ts';
import { patchProjectState } from '../../src/main/projectState.ts';
import { YnSubagentSupervisor } from '../../src/main/agent/piNative/subagentSupervisor.ts';

const outputDir=await mkdtemp(path.join(os.tmpdir(),'yn-preserved-terms-'));
try{
  const sourcePath=path.join(outputDir,'source.txt');
  await writeFile(sourcePath,'表示名なし：「葉月マユラ。葉月家の長女。今年１８歳。」\nマサキ：マサキ\n');
  const external=path.join(outputDir,'external.json');
  await writeFile(external,JSON.stringify({entries:[{source:'剣持',target:'剑持'}]}));
  await patchProjectState(outputDir,{glossaryPath:external});
  const request={outputDir,sourcePath,glossaryPath:external,sessionId:'preserved',prompt:'只修这两行',languagePair:'ja->zh-CN',glossaryCandidates:false,characterBible:false,
    customPreserveRules:[{pattern:'^[^：:\\r\\n]+[：:]',flags:'u'}]};
  const domainRun=createYnDomainRunContract({workflowIntent:'translation',fullWorkflow:false,subagentEnabled:false,subagentCount:0});
  const tools=createYnDomainTools({request,domainRun,publishCustomMessage:async()=>{},persistHostState:async()=>{},subagents:{hasRunning:()=>false}});
  const record=tools.find(tool=>tool.name==='recordTranslationPreservedTerms');
  assert.ok(record,'Parent has a typed tool to record explicit user preservation terms');
  const entries=[{source:'マユラ',rationale:'用户指南明确要求固定保留原写法。'},{source:'マサキ',rationale:'用户指南明确要求固定保留原写法。'}];
  await record.execute('record',{entries});
  await record.execute('record-again',{entries});
  const assets=await readProjectAssets({outputDir});
  assert.equal(assets.glossary.entries.length,3);
  assert.ok(assets.glossary.entries.some(e=>e.source==='マユラ'&&e.target==='マユラ'&&e.status==='confirmed'));
  assert.deepEqual(JSON.parse(await readFile(external,'utf8')).entries,[{source:'剣持',target:'剑持'}]);
  await assert.rejects(record.execute('conflict',{entries:[{source:'剣持',rationale:'保留'}]}),/conflict|established|冲突/i);
  assert.equal((await readProjectAssets({outputDir})).glossary.entries.length,3,'conflicting record is atomic');
  await tools.find(tool=>tool.name==='writeTranslationChunk').execute('parent-write',{fromLine:1,toLine:1,lines:['表示名なし：「叶月マユラ。叶月家的长女。今年18岁。」']});
  const progress={sourceRead:false,translationWritten:false,translationValidated:false};
  const spec=createPiTranslationRuntimeSpec({request,task:{fromLine:2,toLine:2,instruction:'保留用户确认姓名'},executionMode:'bounded_repair',publishCustomMessage:async()=>{}},progress);
  const childTools=spec.tools('preserved-child');
  await childTools.find(t=>t.name==='readAssignedSource').execute('read',{});
  const result=await childTools.find(t=>t.name==='repairAssignedTranslation').execute('repair',{entries:[{line:2,translation:'マサキ：マサキ'}]});
  assert.equal(result.details.accepted,true);
  assert.equal(result.details.result.linesWritten,1,'preserved name repair is really written, not retained as a blank');
  const validated=await childTools.find(t=>t.name==='validateAssignedTranslation').execute('validate',{misalignedLines:[]});
  assert.equal(validated.details.validation.accepted,true);
  assert.match(await readFile(path.join(outputDir,'AI_translation/source_translated.txt'),'utf8'),/叶月マユラ.*\nマサキ：マサキ/u);
  await mergeProjectGlossaryEntries({outputDir,entries:[{source:'別名',target:'别名'}]});
  console.log('PASS explicit user terms persist, conflicting/external glossary remains safe, and actual parent/child repairs accept names');
}finally{await rm(outputDir,{recursive:true,force:true});}

const conflictProject=await mkdtemp(path.join(os.tmpdir(),'yn-preserved-conflicts-'));
const supervisor=new YnSubagentSupervisor({publishCustomMessage:async()=>{}});
try{
  const sourcePath=path.join(conflictProject,'source.txt');
  const candidatePath=path.join(conflictProject,'AI_translation/source_translated.txt');
  await mkdir(path.dirname(candidatePath),{recursive:true});
  await writeFile(sourcePath,'マユラ：ここだ。\nマユラ：マユラが来た。\n');
  await writeFile(candidatePath,'マユラ：麻由拉在这里。\nマユラ：麻由拉来了。\n');
  await mergeProjectGlossaryEntries({outputDir:conflictProject,entries:[{source:'マユラ',target:'玛由拉'}]});
  const domainRun=createYnDomainRunContract({workflowIntent:'translation',fullWorkflow:true,subagentEnabled:false});
  domainRun.recordTranslationDiscoveries([{id:'name',kind:'glossary',documentId:'source.txt',fromLine:2,toLine:2,sourceHash:'audit',candidateHash:'audit',source:'マユラ',target:'玛由拉',category:'character',evidenceLine:2,rationale:'user table'}]);
  domainRun.resolveTranslationDiscoveries(['name'],[{source:'マユラ',target:'玛由拉',observedTargets:['玛由拉','麻由拉']}]);
  const tools=createYnDomainTools({request:{outputDir:conflictProject,sourcePath,sessionId:'conflicts',prompt:'Workflow: yn-translation-v1.',workflowIntent:'translation',subagentEnabled:false,languagePair:'ja->zh-CN',customPreserveRules:[{pattern:'^[^：:\\r\\n]+[：:]',flags:'u'}]},domainRun,subagents:supervisor,publishCustomMessage:async()=>{},persistHostState:async()=>{}});
  const execute=(name,params={})=>tools.find(t=>t.name===name).execute(name,params);
  const audit=await execute('inspectTranslationAlignment');
  await execute('readSourceLines',{fromLine:1,toLine:2});
  await execute('readTranslationLines',{fromLine:1,toLine:2});
  await execute('recordTranslationAlignmentChecks',{auditId:audit.details.auditId,failures:[]});
  const result=await execute('validateTranslationArtifact');
  assert.equal(result.details.validation.accepted,true);
  assert.equal(result.details.validation.warningByCode.terminology_inconsistency,1,'actual Host final conflict scan excludes the prefix-only source occurrence');
  assert.equal(result.details.validation.warningByCode.glossary_missing,1,'the body still requires its glossary target');
  await execute('decideTranslationWarningReview',{decision:'review'});
  const warnings=await execute('inspectTranslationWarnings');
  assert.deepEqual([...new Set(warnings.details.windows.flatMap(w=>w.rows.filter(r=>r.selected).map(r=>r.line)))],[2]);
  console.log('PASS actual Host terminology conflict warnings exclude only regex-preserved spans');
}finally{await rm(conflictProject,{recursive:true,force:true});}
