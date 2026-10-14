import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createServer, createConnection } from 'node:net';
import { build } from 'esbuild';
import { printPdfHtml } from '../../src/main/pdfPrint.ts';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const serviceMode = process.env.YN_PDF_PRINT_TEST_SERVICE === '1';

/** Real Chromium printing for Node integration tests; no alternate PDF engine. */
export async function createNativePdfPrintBackend() {
  await mkdir(path.join(root, '.translation-workshop'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.translation-workshop/pdf-print-test-'));
  const entry = path.join(directory, 'service.mjs');
  await build({ entryPoints: [fileURLToPath(import.meta.url)], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
  const env = { ...process.env, YN_PDF_PRINT_TEST_SERVICE: '1', YN_PDF_PRINT_TEST_DIRECTORY: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), ['--disable-gpu', '--no-sandbox', entry], { cwd: root, windowsHide: true,
    env, stdio: ['pipe', 'pipe', 'pipe'] });
  let log = '', nextId = 0, closing = false, closePromise, connection;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', error => { readyReject(error); reject(error); });
    child.once('exit', code => {
      const error = new Error(`PDF print test service exited (${code}). ${log}`);
      readyReject(error);
      for (const job of pending.values()) job.reject(error);
      pending.clear();
      if (code === 0) resolve(); else reject(error);
    });
  });
  // A failure may arrive before close() is called; retain it for close without
  // generating an unrelated unhandled-rejection event.
  void exited.catch(() => {});
  child.stderr.on('data', bytes => { log += bytes; });
  const lines = createInterface({ input: child.stdout });
  const connect = endpoint => {
    if (connection) return;
    connection = createConnection({ path: endpoint });
    connection.once('error', readyReject);
    connection.once('connect', readyResolve);
    const replies = createInterface({ input: connection });
    replies.on('error', readyReject);
    replies.on('line', reply => receive(JSON.parse(reply)));
  };
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { log += line + '\n'; if (process.env.YN_PDF_PRINT_DEBUG === '1') console.info(line); return; }
    if (message.type === 'ready') {
      connect(message.endpoint);
      return;
    }
    receive(message);
  });
  function receive(message) {
    const job = pending.get(message.id);
    if (!job) { log += JSON.stringify(message) + '\n'; return; }
    pending.delete(message.id);
    if (message.error) job.reject(new Error(message.error)); else job.resolve(Buffer.from(message.pdf, 'base64'));
  }
  const send = message => connection.write(JSON.stringify(message) + '\n');
  let waiting = true;
  const readyFile = (async () => {
    const deadline = Date.now() + 30_000;
    while (waiting) {
      try { const message = JSON.parse(await readFile(path.join(directory, 'ready.json'), 'utf8')); connect(message.endpoint); return; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() > deadline) throw new Error(`PDF print service readiness timed out; PID ${child.pid}, diagnostics ${directory} retained. ${log}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })();
  try { await Promise.race([ready, readyFile.then(() => ready)]); }
  catch (error) {
    if (connection) connection.end();
    // Retain the generated service and evidence when startup never completed;
    // a running Chromium process must not have its source removed underneath it.
    throw error;
  }
  finally { waiting = false; }
  return {
    backend: async (sourcePath, signal) => {
      if (closing) throw new Error('PDF print test service is closing.');
      signal?.throwIfAborted();
      const id = ++nextId;
      const abort = () => send({ type: 'cancel', id });
      try {
        const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
        pending.get(id).promise = result;
        send({ type: 'print', id, sourcePath });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        let bytes;
        try { bytes = await result; } catch (error) { signal?.throwIfAborted(); throw error; }
        signal?.throwIfAborted();
        return bytes;
      } finally { signal?.removeEventListener('abort', abort); }
    },
    close: () => {
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          await Promise.allSettled([...pending.values()].map(job => job.promise));
          connection.end();
          try { await exited; }
          finally { lines.close(); await rm(directory, { recursive: true, force: true }); }
        })();
      }
      return closePromise;
    }
  };
}

if (serviceMode) {
  const { app } = await import('electron');
  const jobs = new Map();
  let closed = false;
  const finish = () => { if (closed && jobs.size === 0) app.quit(); };
  app.on('window-all-closed', () => { /* Transient print windows; the control connection owns service lifetime. */ });
  const server = createServer(connection => {
    // Windows Electron's stdin is closed even with a parent pipe. A single
    // local named pipe gives the same EOF-owned, graceful lifetime.
    server.close();
    const lines = createInterface({ input: connection });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.type === 'cancel') { jobs.get(message.id)?.abort(new Error('PDF print test cancelled.')); return; }
      if (message.type !== 'print') throw new Error(`Unknown PDF test service operation: ${message.type}`);
      const controller = new AbortController();
      jobs.set(message.id, controller);
      void (async () => {
        const output = path.join(process.env.YN_PDF_PRINT_TEST_DIRECTORY, `print-${message.id}.pdf`);
        try {
          await printPdfHtml(message.sourcePath, output, controller.signal);
          const bytes = await readFile(output);
          if (!closed) connection.write(JSON.stringify({ id: message.id, pdf: bytes.toString('base64') }) + '\n');
        } catch (error) { if (!closed) connection.write(JSON.stringify({ id: message.id, error: error.stack ?? String(error) }) + '\n'); }
        finally { await rm(output, { force: true }); jobs.delete(message.id); finish(); }
      })();
    });
    lines.on('close', () => { closed = true; finish(); });
    connection.on('error', error => { console.error(error); closed = true; finish(); });
  });
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\yn-pdf-print-${process.pid}` : path.join(process.env.YN_PDF_PRINT_TEST_DIRECTORY, 'control.sock');
  void app.whenReady().then(() => server.listen(endpoint, async () => {
    const message = { type: 'ready', endpoint };
    const readyPath = path.join(process.env.YN_PDF_PRINT_TEST_DIRECTORY, 'ready.json');
    await writeFile(readyPath + '.tmp', JSON.stringify(message));
    await rename(readyPath + '.tmp', readyPath);
    process.stdout.write(JSON.stringify(message) + '\n');
  }));
}
