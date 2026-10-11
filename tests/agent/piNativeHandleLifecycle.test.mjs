import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT, StorageBackedSession } from '@earendil-works/pi-agent-core/node';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { PiSessionRepository } from '../../src/main/agent/piNative/sessionRepository.ts';
import { PiNativeSessionService } from '../../src/main/agent/piNative/sessionService.ts';
import { PiSessionAgentRuntime } from '../../src/main/agent/piNative/sessionAgentRuntime.ts';
import { appendSessionMessage, getOpenDiskSession, getDiskSessionAccess } from '../../src/main/agent/piNative/sessionAccess.ts';
import {
  createPiTranslationReviewSubagentWorker, createPiTranslationAuditSubagentWorker,
  createPiTranslationSubagentWorker, createPiProofreadSubagentWorker, runPiGeneralSubagent
} from '../../src/main/agent/piNative/subagentRunner.ts';

const workspace = await mkdtemp(path.join(os.tmpdir(), 'yn-pi-handle-lifecycle-'));
const repository = new PiSessionRepository(workspace);
const service = new PiNativeSessionService();
const provider = fauxProvider();
const models = createModels(); models.setProvider(provider.provider);
const sourcePath = path.join(workspace, 'source.txt');
const common = {
  request: { outputDir: workspace, sourcePath, sessionId: 'parent', prompt: 'Inspect the assigned lines.', providerId: provider.provider.id,
    modelId: provider.getModel().id, languagePair: 'en->zh-CN', glossaryCandidates: false, characterBible: false },
  task: { documentId: 'source.txt', fromLine: 1, toLine: 1, auditId: 'audit', prompt: 'Inspect the source.', mode: 'investigate' },
  publishCustomMessage: async () => {},
  createModelSelection: async () => ({ models, model: provider.getModel(), providerId: provider.provider.id, modelId: provider.getModel().id })
};
async function assertClosedAndReopen(id, child = true) {
  const metadata = child ? await repository.findChildMetadata(id) : await repository.findMetadata(id);
  assert.ok(metadata);
  assert.equal(getOpenDiskSession(metadata.path), undefined, `${id}: failed initialization must release its registered handle`);
  const reopened = child ? await repository.openChild(id) : await repository.open(id);
  await appendSessionMessage(reopened, { role: 'user', content: 'healthy reopen', timestamp: 1 });
  assert.ok((await reopened.getStats(BACKGROUND_CONTEXT)).messageCount > 0);
  if (child) await repository.closeChildSession(id); else await repository.closeSession(id);
}
try {
  await writeFile(sourcePath, 'one\n');
  await mkdir(path.join(workspace, 'AI_translation'));
  await writeFile(path.join(workspace, 'AI_translation', 'source_translated.txt'), '一\n');
  const originalWriteSelection = PiSessionRepository.prototype.writeActiveSessionId;
  const selectionFailure = new Error('selection persistence failed');
  PiSessionRepository.prototype.writeActiveSessionId = async () => { throw selectionFailure; };
  try { await assert.rejects(service.createSession(workspace), error => error === selectionFailure); }
  finally { PiSessionRepository.prototype.writeActiveSessionId = originalWriteSelection; }
  await assertClosedAndReopen((await repository.listMetadata())[0].id, false);

  const queuedFailure = new Error('queued child card persistence failed');
  await assert.rejects(createPiProofreadSubagentWorker({ ...common, subagentId: 'queued-failure',
    publishCustomMessage: async () => { throw queuedFailure; } }), error => error === queuedFailure);
  await assertClosedAndReopen('queued-failure');

  const startupFailure = new Error('child control initialization failed');
  for (const [label, factory] of [
    ['review', createPiTranslationReviewSubagentWorker], ['audit', createPiTranslationAuditSubagentWorker],
    ['translation', createPiTranslationSubagentWorker], ['proofread', createPiProofreadSubagentWorker],
    ['general', runPiGeneralSubagent]
  ]) {
    const id = `startup-${label}`;
    await assert.rejects(factory({ ...common, subagentId: id, registerControl: () => { throw startupFailure; } }), error => error === startupFailure);
    await assertClosedAndReopen(id);
  }

  const originalCreateChild = PiSessionRepository.prototype.createChild;
  const stopped = new AbortController(); const stopFailure = new Error('stopped while acquiring child');
  PiSessionRepository.prototype.createChild = async function (...args) {
    const session = await originalCreateChild.apply(this, args); stopped.abort(stopFailure); return session;
  };
  try { await assert.rejects(runPiGeneralSubagent({ ...common, subagentId: 'acquisition-stop', signal: stopped.signal }), error => error?.name === 'AbortError' && error.message.includes(stopFailure.message)); }
  finally { PiSessionRepository.prototype.createChild = originalCreateChild; }
  await assertClosedAndReopen('acquisition-stop');

  await mkdir(path.join(workspace, '.translation-workshop', 'glossary.json'));
  await assert.rejects(runPiGeneralSubagent({ ...common, subagentId: 'async-setup-failure' }), /EISDIR|EPERM|EACCES/);
  await assertClosedAndReopen('async-setup-failure');
  await rm(path.join(workspace, '.translation-workshop', 'glossary.json'), { recursive: true });

  const originalDispose = PiSessionAgentRuntime.prototype.dispose;
  const originalClose = StorageBackedSession.prototype.close;
  const disposeFailure = new Error('runtime dispose failed'); const closeFailure = new Error('session close failed');
  PiSessionAgentRuntime.prototype.dispose = function () { originalDispose.call(this); throw disposeFailure; };
  StorageBackedSession.prototype.close = async function (...args) {
    const shouldFail = this.metadata.id === 'combined-failure' && !!getDiskSessionAccess(this);
    await originalClose.apply(this, args); if (shouldFail) throw closeFailure;
  };
  try {
    await assert.rejects(createPiTranslationReviewSubagentWorker({ ...common, subagentId: 'combined-failure',
      registerControl: () => { throw startupFailure; } }), error => error instanceof AggregateError
        && error.errors.length === 3 && error.errors[0] === startupFailure && error.errors[1] === disposeFailure && error.errors[2] === closeFailure);
  } finally { PiSessionAgentRuntime.prototype.dispose = originalDispose; StorageBackedSession.prototype.close = originalClose; }
  await assertClosedAndReopen('combined-failure');

  const originalAbort = PiSessionAgentRuntime.prototype.abort;
  const abortFailure = new Error('runtime abort failed');
  for (const [label, factory] of [['review', createPiTranslationReviewSubagentWorker], ['audit', createPiTranslationAuditSubagentWorker], ['translation', createPiTranslationSubagentWorker]]) {
    const id = `abort-${label}`; const worker = await factory({ ...common, subagentId: id });
    PiSessionAgentRuntime.prototype.abort = async () => { throw abortFailure; };
    try {
      await assert.rejects(worker.control.abort(), error => error === abortFailure);
      await assert.rejects(worker.dispose(), error => error === abortFailure);
    } finally { PiSessionAgentRuntime.prototype.abort = originalAbort; }
    await assertClosedAndReopen(id);
  }

  let proofreadCard = 0;
  const proofreadWorker = await createPiProofreadSubagentWorker({ ...common, subagentId: 'abort-proofread',
    publishCustomMessage: async () => { if (++proofreadCard === 2) throw queuedFailure; } });
  await assert.rejects(proofreadWorker.runAssignment(common), error => error === queuedFailure);
  PiSessionAgentRuntime.prototype.abort = async () => { throw abortFailure; };
  try {
    await assert.rejects(proofreadWorker.control.abort(), error => error === abortFailure);
    await assert.rejects(proofreadWorker.dispose(), error => error === abortFailure);
  } finally { PiSessionAgentRuntime.prototype.abort = originalAbort; }
  await assertClosedAndReopen('abort-proofread');
  assert.equal(provider.state.callCount, 0, 'handle lifecycle fault tests must never request a model');
  console.log('ok creation/setup/queued-card/abort/dispose failures release child and parent handles, preserve errors and allow healthy reopen');
} finally {
  await service.disposeWorkspace(workspace);
  await repository.close();
  await rm(workspace, { recursive: true, force: true });
}
