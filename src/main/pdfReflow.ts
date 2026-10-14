export interface PdfReflowImage {
  dataUrl: string;
  /** Source dimensions in PDF points. */
  width: number;
  height: number;
  /** A source display equation embedded within a complete logical paragraph. */
  display?: boolean;
}

export type PdfReflowPart = { text: string } | { token: string; image: PdfReflowImage };
export interface PdfReflowNode {
  id: string;
  sourceLines: number[];
  sourcePages: number[];
  type: 'heading' | 'paragraph' | 'code' | 'formula' | 'figure' | 'table' | 'references' | 'panel';
  text?: string;
  parts?: PdfReflowPart[];
  image?: PdfReflowImage;
  level?: number;
  /** Source table coordinates; columns are zero-based. */
  column?: number;
  columnSpan?: number;
  columnCount?: number;
  cells?: PdfReflowNode[][];
  /** Source ruled region without asserted table semantics. Its editable leaves
   * share visual rows; rules reflow naturally rather than keep absolute paths. */
  sourceFrame?: {page:number;box:{x:number;y:number;width:number;height:number};paintOperations:number[];horizontalRuleOperations:number[];physicalRows:number[][]};
  caption?: string;
}
export interface PdfReflowDocument {
  title?: string;
  language?: string;
  sourceHash?: string;
  originalHash?: string;
  layoutVersion?: number;
  extractorRevision?: number;
  nodes: PdfReflowNode[];
}

export const PDF_REFLOW_HTML_VERSION = 1;
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Editable, source-bound HTML. Source prose never supplies markup or scripts. */
export function renderPdfReflowHtml(document: PdfReflowDocument, fontUri: string): string {
  const font = new URL(fontUri);
  if (font.protocol !== 'file:' || font.search || font.hash || font.hostname) throw new Error(`PDF reflow requires a local font file URI: ${fontUri}`);
  const ids = new Set<string>();
  function image(value: PdfReflowImage, inline = false, token?: string): string {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl)) throw new Error('PDF reflow image must be an embedded PNG.');
    if (!Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width <= 0 || value.height <= 0) throw new Error('PDF reflow image dimensions must be positive PDF points.');
    // Bound BOTH dimensions by the printable page. A tall formula/figure scales
    // uniformly; prose never inherits a source-box height or width limit.
    const display = inline && value.display === true;
    const scale = Math.min(1, 481.88 / value.width, (display ? 710.49 : inline ? 704 : 728.49) / value.height);
    return `<img class="${display ? 'display-ink' : inline ? 'inline-ink' : 'source-ink'}" src="${value.dataUrl}" alt="${escape(token ?? '')}"${token ? ` data-token="${escape(token)}"` : ''} style="width:${value.width * scale}pt;height:${value.height * scale}pt">`;
  }
  function content(node: PdfReflowNode): string {
    if (node.text !== undefined && node.parts !== undefined) throw new Error(`PDF reflow node ${node.id} has both text and parts.`);
    return node.parts ? node.parts.map(part => 'text' in part ? escape(part.text) : image(part.image, true, part.token)).join('') : escape(node.text ?? '');
  }
  function render(node: PdfReflowNode): string {
    if (!node.id || ids.has(node.id)) throw new Error(`PDF reflow node ID is empty or duplicated: ${node.id}`);
    ids.add(node.id);
    for (const [name, values] of [['sourceLines', node.sourceLines], ['sourcePages', node.sourcePages]] as const) {
      if (!Array.isArray(values) || values.some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error(`PDF reflow node ${node.id} has invalid ${name}.`);
    }
    const attributes = `id="${escape(node.id)}" data-source-lines="${node.sourceLines.join(',')}" data-source-pages="${node.sourcePages.join(',')}" data-node-type="${node.type}"`;
    const body = content(node);
    const ink = node.image ? image(node.image) : '';
    const caption = node.caption === undefined ? '' : `<figcaption>${escape(node.caption)}</figcaption>`;
    switch (node.type) {
      case 'heading': {
        const level = node.level ?? 2;
        if (!Number.isInteger(level) || level < 1 || level > 6) throw new Error(`PDF reflow node ${node.id} has invalid heading level.`);
        return `<h${level} ${attributes}>${body}</h${level}>`;
      }
      case 'paragraph': return `<p ${attributes}>${body}</p>`;
      case 'references': return `<section ${attributes} class="references">${ink || body}</section>`;
      case 'code': return `<pre ${attributes}>${ink || body}</pre>`;
      case 'formula': return `<div ${attributes} class="formula">${ink || body}</div>`;
      case 'figure':
        if (!node.image) throw new Error(`PDF reflow figure ${node.id} has no image.`);
        return `<figure ${attributes}>${ink}${caption}</figure>`;
      case 'panel': {
        const frame=node.sourceFrame;
        if(!frame||!Number.isSafeInteger(frame.page)||frame.page<1||!node.cells?.length||node.cells.some(row=>!row.length))throw new Error(`PDF reflow panel ${node.id} has no source frame or visual rows.`);
        if(!Object.values(frame.box).every(Number.isFinite)||frame.box.width<=0||frame.box.height<=0
          ||!frame.paintOperations.length||new Set(frame.paintOperations).size!==frame.paintOperations.length||frame.paintOperations.some(op=>!Number.isSafeInteger(op)||op<0)
          ||frame.horizontalRuleOperations.length<2||new Set(frame.horizontalRuleOperations).size!==frame.horizontalRuleOperations.length||frame.horizontalRuleOperations.some(op=>!frame.paintOperations.includes(op)))throw new Error(`PDF reflow panel ${node.id} has invalid source rule evidence.`);
        return `<section ${attributes} class="source-panel" data-source-frame="${escape(JSON.stringify(frame))}">${node.cells.map(row=>`<div class="source-frame-row">${row.map(cell=>`<div class="source-frame-cell${cell.image?' native-frame-cell':''}">${render(cell)}</div>`).join('')}</div>`).join('')}</section>`;
      }
      case 'table': {
        if (node.image) return `<figure ${attributes}>${ink}${caption}</figure>`;
        if (!node.cells?.length || node.cells.some(row => !row.length)) throw new Error(`PDF reflow table ${node.id} has no cells.`);
        const columns = node.columnCount ?? Math.max(...node.cells.map(row => row.length), ...node.cells.filter(row => row.length === 1).map(row => row[0].columnSpan ?? 1));
        if (!Number.isSafeInteger(columns) || columns < 1) throw new Error(`PDF reflow table ${node.id} has invalid column count.`);
        const rows = node.cells.map(row => {
          let cursor = 0;
          const placements = row.map(cell => {
            const column = cell.column ?? cursor;
            const span = cell.columnSpan ?? (row.length === 1 && cell.column === undefined ? columns : 1);
            if (!Number.isSafeInteger(column) || column < 0 || !Number.isSafeInteger(span) || span < 1 || column + span > columns) throw new Error(`PDF reflow table ${node.id} cell ${cell.id} is outside its column bounds.`);
            cursor = column + span;
            return { cell, column, span };
          }).sort((a, b) => a.column - b.column);
          cursor = 0;
          for (const placement of placements) {
            if (placement.column < cursor) throw new Error(`PDF reflow table ${node.id} has overlapping cells at column ${placement.column}.`);
            cursor = placement.column + placement.span;
          }
          return placements;
        });
        return `<table ${attributes}><tbody>${rows.map(row => {
          let cursor = 0, cells = '';
          const empty = '<td class="empty-cell" aria-hidden="true"></td>';
          for (const placement of row) {
            while (cursor < placement.column) { cells += empty; cursor++; }
            cells += `<td${placement.span > 1 ? ` colspan="${placement.span}"` : ''}>${render(placement.cell)}</td>`;
            cursor = placement.column + placement.span;
          }
          while (cursor < columns) { cells += empty; cursor++; }
          return `<tr>${cells}</tr>`;
        }).join('')}</tbody></table>`;
      }
      default: throw new Error(`PDF reflow node ${node.id} has unsupported type: ${String(node.type)}`);
    }
  }
  const body = document.nodes.map(render).join('\n');
  const metadata = Object.entries({ sourceHash: document.sourceHash, originalHash: document.originalHash, layoutVersion: document.layoutVersion, extractorRevision: document.extractorRevision })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `<meta name="yn-pdf-${name}" content="${escape(String(value))}">`).join('\n');
  // URI CSS quoting is independent of HTML escaping. Encode quote/backslash
  // characters so an unusual but valid filename cannot escape url(...).
  const cssFont = font.href.replace(/['"\\<>]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  return `<!doctype html>
<html lang="${escape(document.language ?? 'zh-CN')}"><head><meta charset="utf-8">
<meta name="yn-pdf-reflow" content="${PDF_REFLOW_HTML_VERSION}">
<meta name="yn-pdf-font" content="${escape(font.href)}">
${metadata}
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; font-src file:; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'">
<title>${escape(document.title ?? 'Translated PDF')}</title>
<style>
@font-face{font-family:PdfReflow;src:url('${cssFont}') format('truetype');font-style:normal;font-weight:100 900;font-display:block}
@page{size:A4;margin:20mm}
*{box-sizing:border-box}html{font-family:PdfReflow,sans-serif;color:#111;font-size:11pt;line-height:1.65}
body{margin:0}main{max-width:170mm;margin:auto}p,.references{white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;orphans:3;widows:3;margin:0 0 9pt}
h1,h2,h3,h4,h5,h6{line-height:1.3;overflow-wrap:anywhere;break-after:avoid;margin:18pt 0 9pt}h1{font-size:22pt}h2{font-size:17pt}h3{font-size:14pt}h4,h5,h6{font-size:12pt}
pre{font-family:PdfReflow,monospace;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-all;line-height:1.5;font-size:9pt;margin:9pt 0}
figure,.formula{margin:12pt 0;max-width:100%;break-inside:avoid}img{max-width:100%;object-fit:contain}.source-ink{display:block;margin:0 auto}.inline-ink{display:inline-block;vertical-align:middle;max-width:100%}
.display-ink{display:block;break-inside:avoid;margin:9pt auto;max-width:100%}
figcaption{font-size:9pt;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6pt}
table{width:100%;table-layout:auto;border-collapse:collapse;margin:9pt 0}td{border:0.5pt solid #aaa;padding:5pt;vertical-align:top;overflow-wrap:anywhere}td p{margin:0}td.empty-cell{padding-inline:0}tr{break-inside:avoid}
.source-panel{border-top:.5pt solid #111;border-bottom:.5pt solid #111;padding:6pt 0;margin:12pt 0}.source-frame-row{display:flex;align-items:flex-start;gap:9pt;break-inside:auto}.source-frame-cell{flex:1;min-width:0}.source-frame-cell.native-frame-cell{flex:0 1 auto}.source-frame-cell>.formula{margin:0 0 9pt}
@media screen{body{background:#eee;padding:20mm}main{background:white;padding:12mm;max-width:194mm}}
</style></head><body><main contenteditable="true">${body}</main></body></html>`;
}
