import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderLineReviewHtml } from '../src/shared/core/html.ts';
const html=renderLineReviewHtml({title:'Snapshot',sourceText:'Hello',translationText:''});
const code=html.match(/async function buildWorkflowPromptFromSettings\(kind\) \{[\s\S]*?\n\}\n(?=async function synchronizeTaskParameters)/)?.[0];
assert.ok(code,'execute the actual generated parameter builder');
const context={window:{clearTimeout(){}},promptSettingsWriteTimer:0,activePromptKind:'translate',
  workflow:{paths:{sourcePath:'source.txt',sourceKind:'file',outputDir:'project'}},
  glossary:'old.json',currentPromptSettings:()=>({style:'technical'}),writeStoredPromptSettings:async()=>{},
  boundPromptTranslationPath:()=>'',boundGlossaryPath:()=>context.glossary,
  workflowPromptMetadata:()=>({glossaryPath:context.glossary}),
  invokeBridge:()=>({buildPrompt:async request=>{
    // A project-asset hydration notification can arrive while IPC is pending.
    context.glossary='new.json';return `Glossary: ${request.glossaryPath}`;
  }})};
vm.createContext(context);vm.runInContext(code,context);
const packet=await vm.runInContext("buildWorkflowPromptFromSettings('translate')",context);
assert.equal(packet.prompt,'Glossary: old.json');
assert.equal(packet.bindings.glossaryPath,'old.json');
assert.equal(packet.metadata.glossaryPath,packet.bindings.glossaryPath,'prompt and metadata must own the same parameter snapshot across IPC');
assert.equal(context.glossary,'new.json','the subsequent UI update remains available');
console.log('HTML parameter metadata stays bound to the prompt snapshot during asset hydration');

const migrationCode=html.match(/function promptSettingsFromProjectState\(value\) \{[\s\S]*?\n\}\n(?=\nfunction normalizedProjectOutputDir)/)?.[0];
assert.ok(migrationCode,'execute the actual generated settings migration');
const migrationContext={
  projectPromptSettingKeys:['promptSettingsVersion','reviewSubagentCount','subagentCount'],
  promptSettingsVersion:46,
  optionalPositivePromptNumber:value=>Number.isInteger(value)&&value>0?value:undefined,
  promptStoredDefaults:()=>({subagentCount:3})
};
vm.createContext(migrationContext);vm.runInContext(migrationCode,migrationContext);
for(const version of [37,44,45]){
  const migrated=vm.runInContext(`promptSettingsFromProjectState({promptSettingsVersion:${version},reviewSubagentCount:7,subagentCount:3})`,migrationContext);
  assert.equal(migrated.reviewSubagentCount,7,`explicit review count from protocol ${version} must survive future upgrades`);
  assert.equal(migrated.promptSettingsVersion,46);
}
const inherited=vm.runInContext('promptSettingsFromProjectState({promptSettingsVersion:36,reviewSubagentCount:3})',migrationContext);
assert.equal(inherited.reviewSubagentCount,null,'clear the inherited fallback only before its original protocol 37 migration');
assert.equal(inherited.subagentCount,3);
assert.equal(inherited.promptSettingsVersion,46);
console.log('HTML upgrades preserve explicit review counts after the one-time protocol 37 migration');
