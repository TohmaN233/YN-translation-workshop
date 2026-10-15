import assert from 'node:assert/strict';
import {validateTranslationCandidate} from '../../src/shared/validation/translationValidator.ts';
import {isYnTranslationChunkWritable} from '../../src/main/agent/piNative/translationArtifactValidation.ts';

const options={languagePair:'en->zh-CN'};
const residue=(source,candidate,extra={})=>[...validateTranslationCandidate(source,candidate,{...options,...extra}).blocking,
  ...validateTranslationCandidate(source,candidate,{...options,...extra}).warnings].some(f=>f.code==='likely_untranslated');
for(const [source,candidate] of [
  ['Marlow and Quill (2041) reserved the blue loading bay.','Marlow 和 Quill（2041）预订了蓝色装货区。'],
  ['Marlow packed the crate described by Marlow (2041).','Marlow 打包了 Marlow（2041）描述的箱子。'],
  ['Marlow and Quill booked the loading dock.','Marlowson 和 Quill 预约了装货码头。'],
  ['The Marlow route links the Quill depot and the Rook station (Venn, 2044).','Marlow 路线连接 Quill 仓库与 Rook 站（Venn，2044）。'],
  ['The pack-age labels travel with each crate through crateTools::label.render in R (Venn et al., 2044).',
    '各个箱子的包裹标签由 R 中的 crateTools::label.render 处理（Venn 等，2044）。'],
  ['At the depot, cedarKit checks the LUMOCRATE parcel dataset while SLS and HLS rank the delivery lanes.',
    '在仓库，cedarKit 检查 LUMOCRATE 包裹数据集，SLS 和 HLS 则为配送道评分。']
]) {
  assert.equal(residue(source,candidate),false,source);
  assert.equal(isYnTranslationChunkWritable(validateTranslationCandidate(source,candidate,options)),true,'Host must accept translated prose retaining scattered names');
}
for(const candidate of [
  'The courier stacks crates and sorts delivery labels.',
  'The courier stacks crates and sorts delivery labels.（已译）',
  '快递员 stacks crates 并整理配送标签。',
  '快递员 stacks\tcrates 并整理配送标签。',
  '快递员 stacks the crates 并整理配送标签。'
]) {
  const source=candidate.includes('stacks the crates')?'The courier stacks the crates and sorts delivery labels.':'The courier stacks crates and sorts delivery labels.';
  assert.equal(residue(source,candidate),true,'copied English prose must remain visible: '+candidate);
}
assert.equal(residue('Estimate','Estimate（估计）'),true,'mostly copied short prose remains visible');
assert.equal(residue('SafeCopyNamespace','SafeCopyNamespace'),true,'bare identifiers require preservation evidence or an exact parent decision');
assert.equal(residue('Read the model estimates carefully.','仔细阅读 model estimates。'),true,'a copied phrase retains its evidence');
console.log('English residue requires copied prose evidence rather than scattered names, repeated tokens or substrings; Host and genuine residue negatives passed');
