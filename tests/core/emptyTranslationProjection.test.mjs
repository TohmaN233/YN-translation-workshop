import assert from 'node:assert/strict';
import {blankAlignedTranslationText} from '../../src/shared/core/lineReview.ts';
import {splitTextLines} from '../../src/shared/validation/translationValidator.ts';

for(const source of ['', 'Single synthetic row.', 'First row.\nSecond row.', 'First row.\r\nSecond row.\r\n', 'First row.\n\n']) {
  const blank=blankAlignedTranslationText(source),lines=splitTextLines(source);
  assert.deepEqual(splitTextLines(blank),lines.map(()=>''),'empty projections must round-trip every logical row');
  assert.equal(blank.length,lines.length,'each blank row has a terminator');
}
console.log('PASS empty projection serialization preserves zero, single, multiple and trailing empty rows');
