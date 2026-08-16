import assert from "node:assert/strict";

import { xhtmlToLines } from "../../src/shared/core/epubText.ts";

assert.deepEqual(
  xhtmlToLines("<p><ruby>師<rt>し</rt>匠<rt>しょう</rt></ruby>と<ruby>一人<rt>ひとり</rt></ruby>で話す。</p>"),
  ["師匠と一人で話す。"],
  "EPUB extraction must not flatten ruby readings into semantic source text"
);

console.log("ok EPUB extraction removes ruby readings while retaining base text");
