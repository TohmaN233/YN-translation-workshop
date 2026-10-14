import assert from 'node:assert/strict';
import {validateTranslationCandidate} from '../../src/shared/validation/translationValidator.ts';
import {isYnTranslationChunkWritable} from '../../src/main/agent/piNative/translationArtifactValidation.ts';

const options={languagePair:'en->zh-CN'};
const residue=(source,candidate,extra={})=>[...validateTranslationCandidate(source,candidate,{...options,...extra}).blocking,
  ...validateTranslationCandidate(source,candidate,{...options,...extra}).warnings].some(f=>f.code==='likely_untranslated');
for(const [source,candidate] of [
  ['The method of Smith and Jones (2020) gives stable estimates.','Smith 和 Jones（2020）的方法给出了稳定的估计。'],
  ['Smith compared the method with Smith (2020).','Smith 将该方法与 Smith（2020）进行了比较。'],
  ['We compare Smith and Jones.','我们比较 Smithson 和 Jones。'],
  ['The Borel structure has a Hausdorff metric and a Lebesgue measure (Molchanov, 2017).','Borel 结构具有 Hausdorff 度量和 Lebesgue 测度（Molchanov，2017）。'],
  ['The polygo-nal regions determine target-point membership via sp::point.in.polygon in R (Bivand et al., 2013).',
    '使用 R 中的 sp::point.in.polygon 判定目标点是否属于多边形区域（Bivand 等，2013）。'],
  ['We compare curves from mrfDepth with MNIST digit trajectories and the MOBISIG online-signature dataset; CBD and HCD give geometric comparisons.',
    '我们比较 mrfDepth 曲线、MNIST 数字轨迹与 MOBISIG 在线签名数据集；CBD 和 HCD 给出几何比较。']
]) {
  assert.equal(residue(source,candidate),false,source);
  assert.equal(isYnTranslationChunkWritable(validateTranslationCandidate(source,candidate,options)),true,'Host must accept translated prose retaining scattered names');
}
for(const candidate of [
  'This method estimates curves and gives robust results.',
  'This method estimates curves and gives robust results.（已译）',
  '该方法 estimates curves 并给出稳健的结果。',
  '该方法 estimates\tcurves 并给出稳健的结果。',
  '该方法 estimates the curves 并给出稳健的结果。'
]) {
  const source=candidate.includes('estimates the curves')?'This method estimates the curves and gives robust results.':'This method estimates curves and gives robust results.';
  assert.equal(residue(source,candidate),true,'copied English prose must remain visible: '+candidate);
}
assert.equal(residue('Estimate','Estimate（估计）'),true,'mostly copied short prose remains visible');
assert.equal(residue('SafeCopyNamespace','SafeCopyNamespace'),true,'bare identifiers require preservation evidence or an exact parent decision');
assert.equal(residue('Read the model estimates carefully.','仔细阅读 model estimates。'),true,'a copied phrase retains its evidence');
console.log('English residue requires copied prose evidence rather than scattered names, repeated tokens or substrings; Host and genuine residue negatives passed');
