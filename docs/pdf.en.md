# PDF translation: extract assets, reconstruct HTML, generate PDF

[中文](pdf.md)

YN extracts prose, code/math glyphs, images and figures from the source PDF, organizes them into logical structure, and reconstructs HTML using translated prose and preserved assets. Electron typesets that HTML into a new PDF. The original remains read-only; typography, columns, page count and page breaks can change.

## Workflow

1. **Choose the source PDF.** Manual HTML generation, built-in AI tasks and the official Agent API accept horizontal text-layer PDFs. Choose auto or pdf; folder auto accepts mixed TXT, EPUB and PDF.
2. **Extract assets and organize structure.** Mechanical code retains text, source pages, coordinates, glyphs and image mappings, turns visual wraps into logical paragraphs, and joins source-evidenced page continuations. The current Pi model revises remaining paragraph, reading-order or table ambiguities and performs an independent structure audit. It does not rewrite source text or guess TeX. Code checks coverage, duplicates and asset ownership. Only accepted structure becomes working text and review HTML. Initial preparation shows progress and supports Stop; failure or cancellation produces no new HTML.
3. **Translate and edit in review HTML.** Each logical unit becomes one working-text row, using existing glossary, character records, preservation and translation/proofreading tools. Proofreading needs translated TXT aligned with these rows. Existing HTML restores saved translations before editing without rerunning structure models; newly generated HTML activates automatically.
4. **Export the reflowed PDF.** Sync current translations and click **Export reflowed PDF**. Export assembles current prose and source assets into structured HTML plus source mappings; hidden Electron Chromium wraps and paginates automatically. No TeX installation, extra translation request or original prose-box length limit is required.

## Translated content and preserved assets

| Content | Handling |
| --- | --- |
| Prose, headings and separable captions | Translated and naturally typeset in the new HTML |
| Code, formulas and references | Original glyph assets prefilled and protected by code |
| Images, vector figures and image portions of charts | Source images retained; embedded image text is not automatically translated |
| Tables with accepted row/column relationships | Reconstructed from the accepted structure; prose cells can be translated and protected cells stay unchanged |

Inline code/math uses `{{formula:pN:id}}` and `{{code:pN:id}}` markers. They may reorder within their owning paragraph but cannot be deleted, duplicated or moved across paragraphs. Export restores the corresponding source glyphs. Images are viewed by the current vision model only when needed, rather than attached to every translation chunk.

## Output and subsequent exports

`AI_translation` contains `name.translated.html`, `name.translated.document.json` and `name.translated.pdf`. HTML embeds current text and source assets; JSON records logical rows, source pages and relationships; PDF is the re-typeset result. External inputs use separate subdirectories.

Subsequent exports read current review-HTML translations. Saving TXT remains a separate manual action. Font, image or binding failures are reported; the previous output stays intact until a complete PDF is verified and atomically committed.

## Supported inputs and migration

Horizontal text-layer PDFs are supported; OCR is not provided. Scans, hidden OCR, full-page bitmap/text overlays, rotated or vertical text, text clipping masks and unsafe separation or ownership are rejected. Complex columns may need reading-order corrections. Structure audits involve model judgment; inspect prose order, formulas and figures after export. Annotations and interactive forms are not exported; original bookmarks are not copied.

Output uses A4 and bundled Noto Sans SC, with selectable prose and proportionally scaled images. Native glyph/image assets are rasterized at up to 2x and a 3000-pixel longest edge; they are not original vectors or selectable text.

Current layout is v5/e15 with structure prompt contract v9. Accepted projections are reused after verifying the original PDF, structure evidence and asset bindings, without extra structure-model calls. Changed paragraph maps do not automatically migrate old translations or review proof by row number. Old files and sessions remain; verify source correspondence and protected markers before reusing translations.

## Diagnostics and implementation references

Working text, layouts and source assets are under `.translation-workshop/extracted-text`. Mechanical extraction, drafts, proposals and audits have separate records; each attempt retains its diagnostics. PDF events are in `.translation-workshop/pdf/events.jsonl` and HTML generation events in `.translation-workshop/html-generation/events.jsonl`. Image errors identify the source node, page, logical row and formula marker.

PDF.js extracts and renders source assets; the existing Pi Runtime revises and audits structure; Electron Chromium typesets HTML into PDF. See [BabelDOC](https://github.com/funstory-ai/BabelDOC) for intermediate structures, [EasyRead](https://github.com/Edwardxlai/easyread) for continuous reading, and the [quality and reliability report](quality.en.md) for validation evidence.
