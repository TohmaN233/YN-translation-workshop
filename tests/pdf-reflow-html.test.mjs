import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderPdfReflowHtml } from '../src/main/pdfReflow.ts';
import { configurePdfPrintBackend, printPdfHtml } from '../src/main/pdfPrint.ts';
import { createNativePdfPrintBackend } from './helpers/pdf-print-backend.mjs';

const fontUri = pathToFileURL(fileURLToPath(new URL('../assets/fonts/NotoSansSC-Regular.ttf', import.meta.url))).href;
const canvas = createCanvas(800, 80), ctx = canvas.getContext('2d');
ctx.fillStyle = '#ddeeff'; ctx.fillRect(0, 0, 800, 80); ctx.fillStyle = '#000'; ctx.fillRect(10, 20, 780, 30);
const ink = { dataUrl: canvas.toDataURL('image/png'), width: 1600, height: 160 };
const node = (id, type, extra = {}) => ({ id, type, sourceLines: [1], sourcePages: [1], ...extra });
const document = { title: '中文 <script>title</script>', sourceHash: 'a'.repeat(64), originalHash: 'b'.repeat(64), layoutVersion: 8, extractorRevision: 10, nodes: [
  node('heading', 'heading', { level: 1, text: '可编辑的译文' }),
  node('display', 'paragraph', { parts: [{ text: 'BeforeEquation_SENTINEL 方程前正文。' }, { token: '⟪math:display⟫', image: { ...ink, display: true } }, { text: 'AfterEquation_SENTINEL 方程后正文。' }] }),
  node('long', 'paragraph', { text: ('正文可以自然分页，保留完整译文。 ContinuousLatinWord'.repeat(8) + '\n').repeat(70) + 'TAIL_SENTINEL_完整结束' }),
  node('inline', 'paragraph', { parts: [{ text: '<script>alert(1)</script> & "原文"' }, { token: '⟪math:1⟫', image: ink }, { text: '公式后面的正文' }] }),
  node('code', 'code', { text: 'CODE_BEGIN\n' + 'const_a_very_long_unbroken_identifier_'.repeat(90) + '\nCODE_END' }),
  node('formula', 'formula', { image: ink }),
  node('figure', 'figure', { image: ink, caption: '图 1：源字形' }),
  node('table', 'table', { cells: [[node('combined-header', 'paragraph', { text: 'Full width header_SENTINEL' })], [node('cell1', 'paragraph', { text: '单元格中文' }), node('cell2', 'paragraph', { text: 'cell body' })], [node('combined-data', 'paragraph', { text: 'Full width data_SENTINEL' })]] }),
  node('sparse-table', 'table', { columnCount: 5, cells: [[node('sparse-header','paragraph',{text:'Five source columns',column:0,columnSpan:5})],
    [node('method-cell','paragraph',{text:'Method_CELL',column:1}),node('auc-cell','paragraph',{text:'AUC_CELL',column:2}),node('eer-cell','paragraph',{text:'EER_CELL',column:3}),node('last-cell','paragraph',{text:'FINAL_5COL_VALUE',column:4})]] }),
  node('references', 'references', { text: 'References\nUntouched reference text' }),
  node('native-refs', 'references', { image: ink, sourceLines: [] })
] };
const html = renderPdfReflowHtml(document, fontUri), $ = load(html);
assert.equal($('script').length, 0);
assert.equal($('main').attr('contenteditable'), 'true');
assert.equal($('#long').attr('data-source-lines'), '1');
assert.equal($('meta[name="yn-pdf-sourceHash"]').attr('content'), document.sourceHash);
assert.equal($('#inline').text(), '<script>alert(1)</script> & "原文"公式后面的正文');
assert.match(html, /@page\{size:A4;margin:20mm\}/);
assert.match(html, /overflow-wrap:anywhere/);
assert.doesNotMatch(html, /overflow:hidden|max-height|text-overflow|position:absolute/);
assert.ok(Math.abs(Number(/width:([\d.]+)pt/.exec($('#figure img').attr('style'))[1]) - 481.88) < 1e-6);
assert.equal($('#native-refs img').length, 1, 'References retain source glyphs.');
assert.equal($('#table tr').first().find('td').attr('colspan'), '2', 'A combined source table header spans the remaining cell columns.');
assert.equal($('#table tr').last().find('td').attr('colspan'), '2', 'A combined physical data row keeps one source owner spanning every column.');
assert.equal($('#sparse-table tr').last().find('td').length,5,'The sparse four-cell source row retains five physical columns.');
assert.equal($('#sparse-table tr').last().find('td').first().hasClass('empty-cell'),true,'The empty Enrollment column stays before Method/AUC/EER values.');
assert.equal($('#sparse-table tr').last().find('td').eq(4).text(),'FINAL_5COL_VALUE');
assert.throws(()=>renderPdfReflowHtml({nodes:[node('bounds','table',{columnCount:5,cells:[[node('bad-column','paragraph',{text:'bad',column:5})]]})]},fontUri),/column bounds/);
assert.throws(()=>renderPdfReflowHtml({nodes:[node('overlap','table',{columnCount:5,cells:[[node('span','paragraph',{text:'wide',column:0,columnSpan:2}),node('collision','paragraph',{text:'bad',column:1})]]})]},fontUri),/overlapping cells/);
assert.equal($('#display img').hasClass('display-ink'), true, 'Display equation stays inside its source-bound logical paragraph.');
assert.equal($('#display').attr('data-source-lines'), '1');
const quotedFont = renderPdfReflowHtml({ nodes: [] }, "file:///C:/font'name.ttf");
assert.match(quotedFont, /src:url\('file:\/\/\/C:\/font%27name.ttf'\)/, 'Font path cannot escape CSS quoting.');
assert.throws(() => renderPdfReflowHtml({ nodes: [node('bad', 'figure', { image: { ...ink, dataUrl: 'https://invalid/image.png' } })] }, fontUri), /embedded PNG/);
assert.throws(() => renderPdfReflowHtml({ nodes: [node('bad', 'paragraph', { text: 'text', parts: [] })] }, fontUri), /both text and parts/);
assert.throws(() => renderPdfReflowHtml({ nodes: [node('same', 'paragraph'), node('same', 'paragraph')] }, fontUri), /duplicated/);
assert.throws(() => renderPdfReflowHtml({ nodes: [] }, 'https://invalid/font.ttf'), /local font/);

const root = await mkdtemp(path.join(fileURLToPath(new URL('../.translation-workshop/', import.meta.url)), 'pdf-reflow-'));
let service;
try {
  const source = path.join(root, 'source.html'), output = path.join(root, 'result.pdf');
  await writeFile(source, html); await writeFile(output, 'previous output');
  configurePdfPrintBackend(async () => { throw new Error('injected Chromium failure'); });
  await assert.rejects(printPdfHtml(source, output), /injected Chromium failure/);
  assert.equal(await readFile(output, 'utf8'), 'previous output');
  configurePdfPrintBackend(async () => Buffer.from('invalid PDF'));
  await assert.rejects(printPdfHtml(source, output));
  assert.equal(await readFile(output, 'utf8'), 'previous output');
  const controller = new AbortController();
  configurePdfPrintBackend(async () => { controller.abort(new Error('cancel after rendering')); const pdf = await PDFDocument.create(); pdf.addPage(); return pdf.save(); });
  await assert.rejects(printPdfHtml(source, output, controller.signal), /cancel after rendering/);
  assert.equal(await readFile(output, 'utf8'), 'previous output');
  assert.deepEqual((await readdir(root)).sort(), ['result.pdf', 'source.html']);
  configurePdfPrintBackend();
  await assert.rejects(printPdfHtml(source, output), /Electron main process/);
  const missingFont = pathToFileURL(path.join(root, 'missing-font.ttf')).href;
  await writeFile(source, html.replaceAll(fontUri, missingFont));
  await assert.rejects(printPdfHtml(source, output), /missing-font\.ttf/);
  await writeFile(source, html);

  service = await createNativePdfPrintBackend();
  configurePdfPrintBackend(service.backend);
  const result = await printPdfHtml(source, output);
  assert.ok(result.pages > 5, `Long paragraph must naturally wrap across pages: ${result.pages}`);
  const loader = getDocument({ data: new Uint8Array(await readFile(output)), useSystemFonts: true });
  const pdf = await loader.promise;
  try {
    const texts = [];
    let displayFlowChecked = false;
    for (let page = 1; page <= pdf.numPages; page++) {
      const current = await pdf.getPage(page), viewport = current.getViewport({ scale: 1 });
      assert.ok(Math.abs(viewport.width - 595.28) < 1, 'Print must use A4 page width.');
      const text = await current.getTextContent(); texts.push(text.items.map(item => item.str).join(''));
      const beforeEquation = text.items.find(item => item.str.includes('BeforeEquation_SENTINEL'));
      const afterEquation = text.items.find(item => item.str.includes('AfterEquation_SENTINEL'));
      if (beforeEquation || afterEquation) {
        assert.ok(beforeEquation && afterEquation, 'Mixed prose and display equation maintain their reading flow on one page.');
        assert.ok(beforeEquation.transform[5] - afterEquation.transform[5] > 60, 'Display equation occupies its own block between both prose fragments.');
        displayFlowChecked = true;
      }
      if (process.env.YN_PDF_REFLOW_KEEP === '1' && (page === 1 || page === pdf.numPages)) {
        const rendered = createCanvas(Math.ceil(viewport.width * 1.5), Math.ceil(viewport.height * 1.5));
        await current.render({ canvas: rendered, canvasContext: rendered.getContext('2d'), viewport: current.getViewport({ scale: 1.5 }) }).promise;
        await writeFile(path.join(root, `page-${page}.png`), rendered.toBuffer('image/png'));
      }
      for (const item of text.items) {
        if (!item.str.trim()) continue;
        assert.ok(item.transform[4] >= 50 && item.transform[4] < 545, `Text must stay in printable horizontal bounds: ${item.str}`);
      }
    }
    // Chromium may use the font's shared CJK compatibility-glyph mapping.
    const combined = texts.join('').normalize('NFKC');
    assert.equal(displayFlowChecked, true, 'Printed PDF contains both sides of the display equation.');
    for (const expected of ['TAIL_SENTINEL_完整结束', 'CODE_BEGIN', 'CODE_END', 'Full width header_SENTINEL', 'Full width data_SENTINEL', 'FINAL_5COL_VALUE', 'References', 'Untouched reference text', '单元格中文']) assert.ok(combined.includes(expected), `Missing printed text: ${expected}; tail=${combined.slice(-1000)}`);
  } finally { await loader.destroy(); }
  const imageSource = path.join(root, 'all-image.html'), imageOutput = path.join(root, 'all-image.pdf');
  await writeFile(imageSource, renderPdfReflowHtml({ nodes: [
    node('protected-formula', 'formula', { image: ink }),
    node('protected-code', 'code', { image: ink }),
    node('protected-references', 'references', { image: ink })
  ] }, fontUri));
  const imageResult = await printPdfHtml(imageSource, imageOutput);
  assert.ok(imageResult.pages >= 1, 'Pure Host-protected image document must print without a text node.');
  const imageLoader = getDocument({ data: new Uint8Array(await readFile(imageOutput)), useSystemFonts: true });
  try {
    const imagePdf = await imageLoader.promise;
    let imageCount = 0;
    for (let page = 1; page <= imagePdf.numPages; page++) {
      const operators = await (await imagePdf.getPage(page)).getOperatorList();
      imageCount += operators.fnArray.filter(operator => operator === OPS.paintImageXObject || operator === OPS.paintInlineImageXObject).length;
    }
    assert.equal(imageCount, 3, 'Native formula, code, and references all retain their source image glyphs.');
  } finally { await imageLoader.destroy(); }
  // Renderer resource failures must remain visible and never replace a good PDF.
  const before = await readFile(output);
  await writeFile(source, html.replace(ink.dataUrl, 'data:image/png;base64,AAAA'));
  await assert.rejects(printPdfHtml(source, output), /decode|image/i);
  assert.deepEqual(await readFile(output), before);
  await writeFile(source, html.replace('</main>', '<img src="https://example.invalid/forbidden.png"></main>'));
  await assert.rejects(printPdfHtml(source, output), /decode|resource|image/i);
  assert.deepEqual(await readFile(output), before);
  await writeFile(source, html);
  const cancelled = new AbortController();
  const printing = printPdfHtml(source, output, cancelled.signal);
  setTimeout(() => cancelled.abort(new Error('native print cancellation')), 5);
  await assert.rejects(printing, /native print cancellation/);
  assert.deepEqual(await readFile(output), before);
  const lastPrint = printPdfHtml(source, output);
  const closing = service.close();
  assert.equal((await lastPrint).pages, result.pages, 'Service close waits for its in-flight print.');
  await closing; await service.close(); service = undefined;
  console.log(JSON.stringify({ pass: true, nativeChromium: true, naturalPages: result.pages, outputPreservedOnFailure: true, ...(process.env.YN_PDF_REFLOW_KEEP === '1' ? { preview: root } : {}) }));
} finally {
  configurePdfPrintBackend();
  if (service) await service.close();
  if (process.env.YN_PDF_REFLOW_KEEP !== '1') await rm(root, { recursive: true, force: true });
}
