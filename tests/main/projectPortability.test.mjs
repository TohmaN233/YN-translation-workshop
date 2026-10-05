import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiSessionRepository } from '../../src/main/agent/piNative/sessionRepository.ts';
import { saveProjectState, readProjectState } from '../../src/main/projectState.ts';
import { portableReviewHtml, resolveReviewHtmlPaths } from '../../src/main/reviewHtmlPortability.ts';
import { renderLineReviewHtml, renderBatchLineReviewIndexHtml, renderProposalReviewHtml } from '../../src/shared/core/html.ts';
import { upgradeLegacyReviewHtmlTree } from '../../src/main/reviewHtmlUpgrade.ts';
import { appendYnSessionHostState, loadYnSessionHostState, createProofreadHostState } from '../../src/main/agent/piNative/proofreadSessionState.ts';
import { createTranslationChunkReviewAudit } from '../../src/main/agent/piNative/translationAlignmentState.ts';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { decodeProjectPaths } from '../../src/main/projectPaths.ts';
import { prepareTranslationReuseAudit, listCurrentTranslationReuseAudits } from '../../src/main/agent/piNative/translationReuseAudit.ts';
import { appendSessionCustomEntry } from '../helpers/pi-session.mjs';

function dataFrom(html, id = 'reviewData') { return JSON.parse(html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`))[1]); }

test('legacy generated-directory relocation preserves explicit outer source and glossary references', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yn-partial-move-'));
  try {
    const moved = path.join(dir, 'Translation');
    await mkdir(path.join(moved, '.translation-workshop'), { recursive: true });
    await writeFile(path.join(moved, '.translation-workshop', 'project.json'), JSON.stringify({ outputDir: dir,
      sourcePath: path.join(dir, 'source.txt'), glossaryPath: path.join(dir, 'glossary', 'external.json'),
      translationPath: path.join(dir, 'AI_translation', 'source_translated.txt') }));
    const loaded = await readProjectState(moved);
    assert.equal(loaded.outputDir, moved);
    assert.equal(loaded.sourcePath, path.join(dir, 'source.txt'));
    assert.equal(loaded.glossaryPath, path.join(dir, 'glossary', 'external.json'));
    assert.equal(loaded.translationPath, path.join(moved, 'AI_translation', 'source_translated.txt'));
    await mkdir(path.join(dir, 'AI_translation'));
    await writeFile(path.join(dir, 'source.txt'), 'Hello there.');
    await writeFile(path.join(dir, 'AI_translation', 'source_translated.txt'), '你好。');
    await prepareTranslationReuseAudit({ outputDir: dir, ownerSessionId: 'partial-owner', documentId: 'source.txt',
      sourcePath: path.join(dir, 'source.txt'), candidatePath: path.join(dir, 'AI_translation', 'source_translated.txt'), languagePair: 'en->zh-CN' });
    const oldStorePath = path.join(dir, '.translation-workshop', 'translation-reuse-audits.json');
    const oldStore = decodeProjectPaths(JSON.parse(await readFile(oldStorePath, 'utf8')), dir);
    delete oldStore.projectPathsVersion;
    await writeFile(oldStorePath, JSON.stringify(oldStore));
    await cp(path.join(dir, '.translation-workshop'), path.join(moved, '.translation-workshop'), { recursive: true });
    await cp(path.join(dir, 'AI_translation'), path.join(moved, 'AI_translation'), { recursive: true });
    assert.equal((await listCurrentTranslationReuseAudits(moved, 'partial-owner')).length, 1, 'an explicit outer source remains readable after partial relocation');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy reuse audits rebind from their canonical candidate identity without reading the original project', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yn-reuse-copy-'));
  const original = path.join(dir, 'original'), copied = path.join(dir, 'copied');
  try {
    await mkdir(path.join(original, 'AI_translation'), { recursive: true });
    const source = path.join(original, 'source.txt'), candidate = path.join(original, 'AI_translation', 'source_translated.txt');
    await writeFile(source, 'Hello there.'); await writeFile(candidate, '你好。');
    const prepared = await prepareTranslationReuseAudit({ outputDir: original, ownerSessionId: 'owner', documentId: 'source.txt', sourcePath: source,
      candidatePath: candidate, languagePair: 'en->zh-CN' });
    const storePath = path.join(original, '.translation-workshop', 'translation-reuse-audits.json');
    const stored = decodeProjectPaths(JSON.parse(await readFile(storePath, 'utf8')), original);
    delete stored.projectPathsVersion;
    await writeFile(storePath, JSON.stringify(stored));
    await cp(original, copied, { recursive: true });
    const loaded = await listCurrentTranslationReuseAudits(copied, 'owner');
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].auditId, prepared.auditId);
    await rm(original, { recursive: true });
    assert.deepEqual(await listCurrentTranslationReuseAudits(copied, 'owner'), loaded);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('line, proposal and batch HTML store relative project bindings and resolve them at the new file URL', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yn-html-copy-'));
  const original = path.join(dir, 'original'), copied = path.join(dir, 'copied');
  const originalHtml = path.join(original, '.translation-workshop', 'html', 'line.html');
  const copiedHtml = path.join(copied, '.translation-workshop', 'html', 'line.html');
  try {
    const html = portableReviewHtml(renderLineReviewHtml({ title: 'copy', sourceText: `Literal ${original} must not be changed`,
      lineReviewPath: originalHtml, workflow: { sourcePath: path.join(original, 'source#%20one.txt'), outputDir: original } }), originalHtml);
    assert.equal(dataFrom(html).workflow.paths.outputDir, '.');
    assert.equal(dataFrom(html).workflow.paths.sourcePath, 'source#%20one.txt');
    const element = { textContent: JSON.stringify(dataFrom(html)) };
    runInNewContext(html.match(/<script id="yn-project-paths">([\s\S]*?)<\/script>/)[1], {
      location: { protocol: 'file:', href: pathToFileURL(copiedHtml).href }, document: { getElementById: () => element }, URL
    });
    const browser = JSON.parse(element.textContent);
    assert.equal(browser.workflow.paths.outputDir, copied);
    assert.equal(browser.workflow.paths.sourcePath, path.join(copied, 'source#%20one.txt'));
    assert.equal(browser.lineReviewPath, copiedHtml);
    assert.equal(browser.rows[0].source, `Literal ${original} must not be changed`);
    assert.equal(dataFrom(resolveReviewHtmlPaths(html, copiedHtml)).workflow.paths.sourcePath, browser.workflow.paths.sourcePath);
    assert.ok(!dataFrom(html).workflow.prompts.translate.includes(original), 'generated prompts must also be portable');
    const batchPath = path.join(original, '.translation-workshop', 'html', 'batch.html');
    const batch = portableReviewHtml(renderBatchLineReviewIndexHtml({ title: 'batch', files: [{ sourceName: 'source.txt',
      sourcePath: path.join(original, 'source.txt'), outputPath: 'batch/child.html', status: 'matched', sourceLineCount: 1 }],
      workflow: { outputDir: original, sourcePath: original, sourceKind: 'folder' } }), batchPath);
    assert.equal(dataFrom(batch, 'batchData').files[0].outputPath, 'batch/child.html');
    assert.equal(dataFrom(resolveReviewHtmlPaths(batch, batchPath.replace(original, copied)), 'batchData').files[0].sourcePath, path.join(copied, 'source.txt'));
    const proposal = portableReviewHtml(renderProposalReviewHtml({ title: 'proposal', proposals: [], outputDir: original, lineReviewPath: originalHtml }), batchPath);
    assert.equal(dataFrom(resolveReviewHtmlPaths(proposal, batchPath.replace(original, copied)), 'proposalData').lineReviewPath, copiedHtml);
    await mkdir(path.dirname(originalHtml), { recursive: true });
    await writeFile(originalHtml, renderLineReviewHtml({ title: 'legacy', sourceText: 'source', lineReviewPath: originalHtml,
      workflow: { outputDir: original, sourcePath: path.join(original, 'source.txt') } }));
    await cp(original, copied, { recursive: true });
    assert.equal(await upgradeLegacyReviewHtmlTree(copiedHtml), true);
    assert.equal(await upgradeLegacyReviewHtmlTree(copiedHtml), false, 'upgrading a portable HTML is idempotent');
    assert.equal(dataFrom(await readFile(copiedHtml, 'utf8')).workflow.paths.sourcePath, 'source.txt');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native checkpoint and delta recovery rebind staging while keeping review hashes and identity', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yn-host-copy-'));
  const original = path.join(dir, 'original'), copied = path.join(dir, 'copied');
  const repo = new PiSessionRepository(original);
  try {
    const session = await repo.create('host-copy');
    const scope = createTranslationChunkReviewAudit({ documentId: 'source.txt', sourceText: 'Source', candidateText: '译文',
      candidatePath: path.join(original, '.translation-workshop', 'agent', 'translation-staging', 'draft.txt'),
      languagePair: 'en->zh-CN', fromLine: 1, sourceLineCount: 1 });
    scope.checks.forEach(check => { check.verdict = 'aligned'; });
    const state = { schemaVersion: 1, ownerSessionId: 'host-copy', proofread: createProofreadHostState(),
      translationAlignment: { schemaVersion: 3, documents: {}, ranges: { 'source.txt': [scope] } } };
    await appendYnSessionHostState(session, state, { projectRoot: original });
    scope.checks[0].reason = 'Accepted delta';
    await appendYnSessionHostState(session, state, { projectRoot: original });
    const mixed = await repo.create('mixed-copy');
    await appendSessionCustomEntry(mixed, 'yn.host-state.v1', { ...state, ownerSessionId: 'mixed-copy' });
    await appendYnSessionHostState(mixed, { schemaVersion: 1, ownerSessionId: 'mixed-copy', proofread: createProofreadHostState(),
      translationAlignment: { schemaVersion: 3, documents: {}, ranges: {} } }, { projectRoot: original });
    await repo.close();
    await cp(original, copied, { recursive: true });
    await rm(original, { recursive: true });
    const moved = new PiSessionRepository(copied);
    try {
      const reopened = await moved.open('host-copy');
      const loaded = await loadYnSessionHostState(reopened, 'host-copy', { projectRoot: copied });
      const restored = loaded.translationAlignment.ranges['source.txt'][0];
      assert.equal(restored.candidatePath, scope.candidatePath.replace(original, copied));
      assert.equal(restored.sourceHash, scope.sourceHash);
      assert.equal(restored.candidateHash, scope.candidateHash);
      assert.equal(restored.checks[0].reason, 'Accepted delta');
      assert.equal(restored.checks[0].verdict, 'aligned');
      const mixedLoaded = await loadYnSessionHostState(await moved.open('mixed-copy'), 'mixed-copy', { projectRoot: copied });
      assert.equal(mixedLoaded.translationAlignment.ranges['source.txt'][0].candidatePath, scope.candidatePath.replace(original, copied), 'legacy evidence behind a new relative Stop tombstone must still rebind');
      await appendYnSessionHostState(reopened, loaded, { projectRoot: copied });
      assert.deepEqual(await loadYnSessionHostState(reopened, 'host-copy', { projectRoot: copied }), loaded);
    } finally { await moved.close(); }
  } finally { await repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a copied project retains native parent and owned child histories without consulting the original project', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yn-session-copy-'));
  const original = path.join(dir, 'original'), copied = path.join(dir, 'copied');
  const repo = new PiSessionRepository(original);
  try {
    const parent = await repo.create('parent');
    await repo.createChild('child', parent.metadata.id);
    await repo.writeActiveSessionId(parent.metadata.id);
    await repo.close();
    await cp(original, copied, { recursive: true });
    await rm(original, { recursive: true });
    const moved = new PiSessionRepository(copied);
    try {
      assert.equal((await moved.listMetadata()).length, 1);
      assert.equal(await moved.readActiveSessionId(), 'parent');
      assert.equal((await moved.openChildForParent('child', 'parent')).metadata.id, 'child');
    } finally { await moved.close(); }
  } finally { await repo.close(); await rm(dir, { recursive: true, force: true }); }
});

test('project-owned settings are stored relatively and resolve in a copy even while the original still exists', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'yn-settings-copy-'));
  const original = path.join(dir, 'original'), copied = path.join(dir, 'copied');
  const external = path.join(dir, 'external.json');
  try {
    await mkdir(original);
    await writeFile(path.join(original, 'source.txt'), 'source');
    await saveProjectState(original, { sourcePath: path.join(original, 'source.txt'), glossaryPath: external,
      lineReviewPath: path.join(original, '.translation-workshop', 'html', 'line-review.html'),
      folderSourceDocuments: [{ id: 'source.txt', path: path.join(original, 'source.txt') }] });
    const stored = JSON.parse(await readFile(path.join(original, '.translation-workshop', 'project.json'), 'utf8'));
    assert.equal(stored.sourcePath, 'source.txt');
    assert.equal(stored.outputDir, '.');
    assert.equal(stored.glossaryPath, external);
    await cp(original, copied, { recursive: true });
    const loaded = await readProjectState(copied);
    assert.equal(loaded.sourcePath, path.join(copied, 'source.txt'));
    assert.equal(loaded.folderSourceDocuments[0].path, path.join(copied, 'source.txt'));
    assert.equal(loaded.lineReviewPath, path.join(copied, '.translation-workshop', 'html', 'line-review.html'));
    assert.equal(loaded.glossaryPath, external);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
