# PDF translation

[中文](pdf.md)

Manual HTML generation, built-in AI tasks and the official Agent API accept PDF sources. Choose `auto` or `pdf`; folder `auto` accepts mixed TXT, EPUB and PDF inputs. Existing chunk and agent settings apply.

1. Select a PDF with selectable text. Extraction creates a read-only UTF-8 projection: one text block per HTML row. The original PDF stays unchanged.
2. Use the existing glossary, character bible, preservation rules and translation/proofreading workflow. Proofreading requires the aligned translated TXT, rather than an independently typeset PDF.
3. Sync translations in HTML, edit or apply proofreading suggestions, then click **Export PDF**. Current HTML text is saved under the project's `AI_translation` as `name.translated.pdf`; external inputs use separate subdirectories to avoid filename collisions. TXT saving remains a separate manual action.

Source reads expose a lightweight page/figure index. A vision model requests an image only when the passage mentions a figure/table or needs visual evidence; images are not attached to every chunk. Figure labels can resolve across pages. Page references cover vector diagrams and tables. Text-only models can translate text and receive an explicit error if they request an image.

Code and mathematical formulas are not translatable. Extraction identifies protected blocks from PDF Code/Formula structure tags, mathematical fonts and explicit code/equation syntax. HTML displays the original and locks the matching target rows. The Host requires exact equality when writing translations, submitting proofreading fixes, importing candidates and exporting. Clearing editable regex rules cannot disable this protection. Comments, indentation and mathematical symbols are protected too; they do not trigger untranslated-language or glossary-conflict checks. Surrounding prose is translated normally. Export keeps original glyphs in the page image rather than redrawing code or formulas with the prose font.

PDFs may lack semantic code/math information, so arbitrary unmarked content cannot be guaranteed detectable. Detected code/formulas sharing inseparable text paints with prose reject extraction explicitly; tag or separate them first. Old PDF projections without this protection cannot start or commit. Regenerate HTML from the original PDF; old projections and translations are retained rather than overwritten.

## Layout and current limits

Export retains page count and sizes, text positions and colors, images and table lines. Target prose remains selectable and uses bundled Noto Sans SC. Original prose typefaces, bold/italic styling and exact spacing are not preserved. Non-text graphics and protected code/formulas become page backgrounds rendered at up to 2x, with a maximum 3000-pixel long edge, rather than selectable text or original vectors. The complete embedded font adds several MB to the output.

Text wraps and moderately shrinks inside its original box. Overflow reports the page and row, leaves the previous export intact and requires shortening that translation; it never clips or drops text. Check pagination, tables and formulas after exporting.

This first version targets horizontal text-layer PDFs and does not include OCR. Detected scans, hidden OCR, text overlapping full-page raster images, vertical/rotated text and text clipping masks report explicit errors. Reading order follows the PDF text stream; complex columns may need source preparation. Annotations, interactive forms and bookmarks are not exported. Text inside images remains unchanged; visual tools aid interpretation rather than rewriting image text.

Text, page assets and hash-bound layouts are stored under `.translation-workshop/extracted-text`; diagnostics go to `.translation-workshop/pdf/events.jsonl`. Copy the whole project to retain relative internal bindings. External PDFs must also be transferred and selected again. Do not move or delete bound assets during a run.

The layout intermediate follows ideas from [BabelDOC](https://github.com/funstory-ai/BabelDOC). PDF.js handles extraction/rendering and pdf-lib handles output; YN's native Pi workflow still performs translation.
