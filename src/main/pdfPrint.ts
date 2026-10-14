import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';
import { PDF_REFLOW_HTML_VERSION } from './pdfReflow.ts';

export type PdfPrintBackend = (sourcePath: string, signal?: AbortSignal) => Promise<Uint8Array>;
let configuredBackend: PdfPrintBackend | undefined;
/** Injection seam for tests; production uses native Electron Chromium. */
export function configurePdfPrintBackend(backend?: PdfPrintBackend): void { configuredBackend = backend; }

async function nativePrint(sourcePath: string, signal?: AbortSignal): Promise<Uint8Array> {
  // Validation workers also read PDF bindings. Load the HTML parser only at
  // the Electron print boundary, keeping its CommonJS dependencies out of
  // ordinary worker startup.
  const { load } = await import('cheerio');
  const html = await readFile(sourcePath, 'utf8');
  const $ = load(html);
  if ($('script,iframe,object,embed,base').length || $('*').toArray().some(element => 'attribs' in element && Object.keys(element.attribs).some(name => /^on/i.test(name)))) throw new Error(`PDF reflow HTML contains executable source markup: ${sourcePath}`);
  if (!$('meta[http-equiv="Content-Security-Policy"]').toArray().some(element => /script-src\s+'none'/.test($(element).attr('content') ?? ''))) throw new Error(`PDF reflow HTML must block source scripts: ${sourcePath}`);
  if ($('meta[name="yn-pdf-reflow"]').attr('content') !== String(PDF_REFLOW_HTML_VERSION)) throw new Error(`Unsupported PDF reflow HTML: ${sourcePath}`);
  const fontUri = $('meta[name="yn-pdf-font"]').attr('content');
  if (!fontUri) throw new Error(`PDF reflow HTML has no local font resource: ${sourcePath}`);
  const fontUrl = new URL(fontUri);
  if (fontUrl.protocol !== 'file:' || fontUrl.hostname || fontUrl.search || fontUrl.hash) throw new Error(`PDF print font is not a local file: ${fontUri}`);
  const fontPath = fileURLToPath(fontUrl);
  if (!(await stat(fontPath)).isFile()) throw new Error(`PDF print font is not a file: ${fontPath}`);
  signal?.throwIfAborted();
  const electron = await import('electron');
  if (!electron.app || !electron.BrowserWindow || !electron.session) throw new Error('PDF printing requires the Electron main process; Chromium is unavailable.');
  await electron.app.whenReady();
  signal?.throwIfAborted();
  const sourceUrl = pathToFileURL(sourcePath).href;
  const allowed = new Set([sourceUrl, fontUrl.href]);
  const session = electron.session.fromPartition(`pdf-reflow-${randomUUID()}`);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  const blocked = new Set<string>();
  session.webRequest.onBeforeRequest((details, callback) => {
    const denied = !allowed.has(details.url) && !/^data:image\/png;base64,/.test(details.url);
    if (denied) blocked.add(details.url);
    callback({ cancel: denied });
  });
  let window: BrowserWindow | undefined;
  let failure: unknown;
  let phase = 'creating Chromium window';
  const abort = () => { if (window && !window.isDestroyed()) { window.webContents.stop(); window.close(); } };
  try {
    window = new electron.BrowserWindow({ show: false, width: 900, height: 1000, webPreferences: {
      session, sandbox: true, contextIsolation: true, nodeIntegration: false,
      javascript: true, webSecurity: true, backgroundThrottling: false
    } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== sourceUrl) event.preventDefault(); });
    signal?.addEventListener('abort', abort, { once: true });
    signal?.throwIfAborted();
    console.info('[pdf-print] loading', { sourcePath });
    phase = 'loading HTML';
    await window.loadFile(sourcePath);
    signal?.throwIfAborted();
    phase = 'waiting for fonts and image decode';
    await window.webContents.executeJavaScript(`(async () => {
      // Image-only protected documents still verify the bundled font; no text
      // node may have triggered lazy @font-face loading before this point.
      await document.fonts.load('11px PdfReflow', '中');
      await document.fonts.ready;
      if (!document.fonts.check('11px PdfReflow') || !Array.from(document.fonts).some(font => font.family === 'PdfReflow' && font.status === 'loaded')) throw new Error('PDF reflow font failed to load');
      await Promise.all(Array.from(document.images, async (image, index) => { try { await image.decode(); } catch (error) { throw new Error('PDF reflow image ' + (index + 1) + ' failed to decode: ' + (error.message || String(error))); } if (!image.naturalWidth || !image.naturalHeight) throw new Error('PDF reflow image failed to decode'); }));
      return true;
    })()`, false);
    signal?.throwIfAborted();
    if (blocked.size) throw new Error(`PDF print blocked non-local resources: ${[...blocked].join(', ')}`);
    console.info('[pdf-print] printing', { sourcePath });
    phase = 'printing PDF';
    const bytes = await window.webContents.printToPDF({ pageSize: 'A4', preferCSSPageSize: true, printBackground: true,
      displayHeaderFooter: false, generateTaggedPDF: true, generateDocumentOutline: true });
    signal?.throwIfAborted();
    return bytes;
  } catch (error) {
    failure = signal?.aborted ? signal.reason : new Error(`PDF print ${phase} failed for ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    throw failure;
  }
  finally {
    signal?.removeEventListener('abort', abort);
    try {
      if (window && !window.isDestroyed()) {
        const ownedWindow = window;
        await new Promise<void>(resolve => { ownedWindow.once('closed', resolve); ownedWindow.close(); });
      }
      session.webRequest.onBeforeRequest(null);
      await session.clearStorageData();
    } catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], 'PDF print and Chromium cleanup failed.');
      throw error;
    }
  }
}

/** Print the persisted editable source; commit only a verified, complete PDF. */
export async function printPdfHtml(sourcePath: string, outputPath: string, signal?: AbortSignal): Promise<{ pages: number }> {
  const source = path.resolve(sourcePath), output = path.resolve(outputPath);
  if (source.toLowerCase() === output.toLowerCase()) throw new Error('PDF print source and output must be different files.');
  signal?.throwIfAborted();
  const bytes = await (configuredBackend ?? nativePrint)(source, signal);
  signal?.throwIfAborted();
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPageCount();
  if (!pages) throw new Error(`Chromium returned an empty PDF for ${source}.`);
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  let failure: unknown;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', signal });
    signal?.throwIfAborted();
    // Windows can retain a short-lived read/antivirus handle after PDF
    // verification. Retry only documented sharing/permission failures, keeping
    // the previous output in place throughout; a persistent failure is visible.
    const replaceDeadline = Date.now() + 5_000;
    for (;;) {
      signal?.throwIfAborted();
      try { await rename(temporary, output); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= replaceDeadline) throw error;
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
    }
    console.info('[pdf-print] committed', { sourcePath: source, outputPath: output, pages });
    return { pages };
  } catch (error) { failure = error; throw error; }
  finally {
    try { await rm(temporary, { force: true }); }
    catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], 'PDF print and temporary-file cleanup failed.');
      throw error;
    }
  }
}
