import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createYnDomainTools} from '../../src/main/agent/piNative/ynDomainTools.ts';
import {createYnDomainRunContract} from '../../src/main/agent/piNative/domainRunContract.ts';
import {createPiTranslationRuntimeSpec} from '../../src/main/agent/piNative/subagentRunner.ts';
import {executeArtifactOperation} from '../../src/main/agent/artifactValidationWorkerTasks.ts';
const root=await mkdtemp(path.join(os.tmpdir(),'yn-english-residue-gate-'));
try {
  const source=[
    'Marlow and Quill (2041) reserved the blue loading bay.',
    'Marlow packed the crate described by Marlow (2041).',
    'The pack-age labels travel with each crate through crateTools::label.render in R.',
    'The courier stacks the crates and sorts delivery labels.'
  ];
  const candidate=['Marlow 和 Quill（2041）预订了蓝色装货区。','Marlow 打包了 Marlow（2041）描述的箱子。',
    '各个箱子的包裹标签由 R 中的 crateTools::label.render 处理。','快递员堆好箱子并整理配送标签。'];
  const sourcePath=path.join(root,'source.txt');await writeFile(sourcePath,source.join('\n')+'\n');
  const request={outputDir:root,sourcePath,sessionId:'parent',prompt:'Translate.',languagePair:'en->zh-CN',glossaryCandidates:false,characterBible:false};
  const tools=createYnDomainTools({request,domainRun:createYnDomainRunContract({workflowIntent:'translation',fullWorkflow:false}),
    subagents:{hasRunning:()=>false},publishCustomMessage:async()=>{},persistHostState:async()=>{}});
  const parent=(name,args)=>tools.find(tool=>tool.name===name).execute(name,args);
  await parent('writeTranslationChunk',{fromLine:1,toLine:4,lines:candidate});
  const target=path.join(root,'AI_translation/source_translated.txt');const before=await readFile(target,'utf8');
  const spec=createPiTranslationRuntimeSpec({request,task:{fromLine:1,toLine:4,instruction:'Translate the assigned rows'},executionMode:'bounded_repair',
    publishCustomMessage:async()=>{}},{sourceRead:false,translationWritten:false,translationValidated:false});
  const child=spec.tools('child'),execute=(name,args)=>child.find(tool=>tool.name===name).execute(name,args);
  await execute('readAssignedSource',{});
  const rejected=await execute('repairAssignedTranslation',{entries:candidate.map((translation,index)=>({line:index+1,
    translation:index===3?'快递员 stacks the crates 并整理配送标签。':translation}))});
  assert.equal(rejected.details.accepted,false);
  assert.deepEqual(rejected.details.requiredBatchLines,[4],'names and function identifiers must not become repair debt');
  assert.deepEqual(rejected.details.submittedValidation.rejectedLines,[4]);
  assert.ok(rejected.details.submittedValidation.warningCount>0,'the rejected proposal has residue evidence');
  assert.equal(rejected.details.validation.ok,true,'the existing saved translation remains valid');
  assert.equal(await readFile(target,'utf8'),before,'a rejected proposal cannot replace good persisted text');
  await execute('readAssignedSource',{fromLine:4,toLine:4});
  assert.equal((await execute('repairAssignedTranslation',{entries:[{line:4,translation:candidate[3]}]})).details.accepted,true);
  const imported=await executeArtifactOperation({operation:'validate',args:{projectDir:root,sourcePath,candidatePath:target,languagePair:'en->zh-CN'},assets:{}},()=>{},()=>{},async()=>{});
  assert.equal([...imported.validation.blocking,...imported.validation.warnings].some(f=>f.code==='likely_untranslated'),false,'import shares the same residue evidence');
  console.log('Actual parent, child repair and import accept translated names; copied English phrase rejects only its row and preserves existing candidate with explicit proposal diagnostics');
} finally {await rm(root,{recursive:true,force:true});}
