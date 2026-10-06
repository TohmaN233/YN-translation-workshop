import assert from 'node:assert/strict';
import { validateTranslationCandidate, scanResolvedTerminologyConflicts } from '../../src/shared/validation/translationValidator.ts';
import { isYnTranslationChunkWritable } from '../../src/main/agent/piNative/translationArtifactValidation.ts';

const rules = [{pattern:'^[^：:\\r\\n]+[：:]',flags:'u'}];
const entries = [{source:'マユラ',target:'マユラ'},{source:'マユキ',target:'マユキ'},{source:'マサキ',target:'マサキ'}];
const validate = (source,candidate,glossaryEntries=entries,customPreserveRules=rules) => validateTranslationCandidate(source+'\n',candidate+'\n',{languagePair:'ja->zh-CN',glossaryEntries,customPreserveRules});
let failed=0;
function test(name,fn){try{fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name,error.message);}}
test('real first-day1048 and second-day299 repairs pass the Host gate with preserved glossary names',()=>{
  for(const [source,candidate] of [
    ['表示名なし：「葉月マユラ。葉月家の長女。今年１８歳。」','表示名なし：「叶月マユラ。叶月家的长女。今年18岁。」'],
    ['美雪：「マユキ――さんだったわよね。こんなとこに閉じこめられて、かわいそうに‥‥‥。」','美雪：「她叫マユキ——对吧。被关在这种地方，真可怜……。」'],
    ['マサキ：マサキ','マサキ：マサキ']
  ])assert.equal(isYnTranslationChunkWritable(validate(source,candidate)),true);
});
test('aligned mixed-script target and explicit aliases are legitimate glossary translations',()=>{
  assert.equal(isYnTranslationChunkWritable(validate('名：葉月マユラ。','名：叶月マユラ。',[{source:'葉月マユラ',target:'叶月マユラ'}])),true);
  assert.equal(isYnTranslationChunkWritable(validate('名：マユラ。','名：マユラ様。',[{source:'マユラ',target:'玛由拉',aliases:['マユラ様']}])),true);
});
test('remaining copied dialogue and wrong glossary targets still flag residue',()=>{
  assert.ok(validate('名：マユラはここで待っている。','名：マユラはここで待っている。').blocking.some(f=>f.code==='likely_untranslated'));
  assert.ok(validate('名：マユラ。','名：マユラ。',[{source:'マユラ',target:'玛由拉'}]).blocking.some(f=>f.code==='likely_untranslated'));
});
test('a term is not globally exempted when absent from this source row',()=>{
  assert.ok(validate('名：知らない。','名：知らない。').blocking.some(f=>f.code==='likely_untranslated'));
  assert.ok(validate('名：マユラ','名：マユラ',[{source:'別人',target:'マユラ'}]).blocking.some(f=>f.code==='likely_untranslated'));
});
test('long source terms cover short terms even if the long mapping is not satisfied',()=>{
  assert.ok(validate('名：マユラ様。','名：マユラ様。',[{source:'マユラ様',target:'玛由拉大人'},{source:'マユラ',target:'マユラ'}]).blocking.some(f=>f.code==='likely_untranslated'));
});
test('partial Latin words and unrelated extra copies are not swallowed',()=>{
  const result=validateTranslationCandidate('Ann Annabelle arrived.\n','Ann Annabelle arrived.\n',{languagePair:'en->zh-CN',glossaryEntries:[{source:'Ann',target:'Ann'}]});
  assert.ok(result.blocking.some(f=>f.code==='likely_untranslated'));
  assert.ok(validate('名：マユラが来た。','名：マユラマユラが来た。').warnings.some(f=>f.code==='likely_untranslated'));
});
test('glossary exemptions never relax prefix, tag or placeholder identity',()=>{
  const result=validate('名：マユラ {id}','別：マユラ',entries);
  assert.ok(result.blocking.some(f=>f.code==='custom_preserve_mismatch'));
  assert.ok(result.blocking.some(f=>f.code==='placeholder_mismatch'));
});
test('glossary source matching excludes actual preserved spans, not every occurrence of that name',()=>{
  const glossary=[{source:'マユラ',target:'玛由拉'}];
  assert.ok(!validate('マユラ：ここで待っている。','マユラ：在这里等待。',glossary).warnings.some(f=>f.code==='glossary_missing'));
  assert.ok(validate('マユラ：マユラが来た。','マユラ：她来了。',glossary).warnings.some(f=>f.code==='glossary_missing'));
  assert.ok(!validate('マユラ：マユラが来た。','マユラ：玛由拉来了。',glossary).warnings.some(f=>f.code==='glossary_missing'));
  assert.ok(validate('玛由拉：マユラが来た。','玛由拉：麻由拉来了。',glossary).warnings.some(f=>f.code==='glossary_missing'),'the preserved prefix cannot satisfy a glossary target required by the body');
  const selected=[{pattern:'(?<=【)マユラ(?=】)',flags:'u'}];
  assert.ok(!validate('【マユラ】来た。','【マユラ】来了。',glossary,selected).warnings.some(f=>f.code==='glossary_missing'));
  assert.ok(validate('【マユラ】マユラが来た。','【マユラ】她来了。',glossary,selected).warnings.some(f=>f.code==='glossary_missing'));
  assert.ok(!validate('マユ【keep】ラが来た。','【keep】她来了。',glossary,[{pattern:'【keep】',flags:'u'}]).warnings.some(f=>f.code==='glossary_missing'),'removing a preserved span cannot invent a new source term across its boundary');
});
test('resolved terminology conflicts exclude preserved source and target spans while retaining absolute rows',()=>{
  const scan=(sourceLines,candidateLines,customPreserveRules=rules)=>scanResolvedTerminologyConflicts({sourceLines,candidateLines,customPreserveRules,terms:[{source:'マユラ',target:'玛由拉',observedTargets:['玛由拉','麻由拉']}]});
  assert.deepEqual(scan(['マユラ：ここだ。'],['マユラ：麻由拉在这里。']),[]);
  assert.deepEqual(scan(['名：マユラが来た。'],['麻由拉：她来了。'],[{pattern:'^[^：:\\r\\n]+[：:]',flags:'u'}]),[]);
  assert.deepEqual(scan(['マユラ：ここだ。','マユラ：マユラが来た。'],['マユラ：这里。','マユラ：麻由拉来了。']).map(f=>f.line),[2]);
  assert.deepEqual(scan(['玛由拉：マユラが来た。'],['玛由拉：麻由拉来了。']).map(f=>f.line),[1]);
  assert.deepEqual(scan(['【マユラ】マユラが来た。'],['【マユラ】麻由拉来了。'],[{pattern:'(?<=【)マユラ(?=】)',flags:'u'}]).map(f=>f.line),[1]);
});
if(failed)process.exitCode=1;
