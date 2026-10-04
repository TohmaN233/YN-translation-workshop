import assert from 'node:assert/strict';
import { test } from 'node:test';
import { YnSubagentSupervisor } from '../../src/main/agent/piNative/subagentSupervisor.ts';
import { NonRetryableAssignmentError } from '../../src/main/agent/piNative/assignmentFailure.ts';

const request = { outputDir: process.cwd(), sessionId: 'resumed-review-failure', prompt: 'Resume review.' };
const task = { documentId: 'source.txt', fromLine: 1, toLine: 24, reviewOnly: true };
const reviewOptions = {
  request, tasks: [task], maxWorkers: 1,
  reviewRequestForTask: async () => ({}),
  prepareChunkReview: async () => ({ decision: { accepted: true } })
};

test('resumed review settlement stays active until Host persistence finishes and terminal failure stops every queue', async () => {
  let fatalCalls = 0;
  let siblingStopped = false;
  let queuedStarted = false;
  let providerCalls = 0;
  const messages = [];
  let beginSettlement;
  let releaseSettlement;
  const settlementStarted = new Promise(resolve => { beginSettlement = resolve; });
  const settlementRelease = new Promise(resolve => { releaseSettlement = resolve; });
  const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {},
    notifyParent: async message => { messages.push(message); },
    onFatalHostFailure: async () => { fatalCalls++; },
    createModelSelection: async () => { providerCalls++; throw new Error('No model runtime is needed'); }
  });
  supervisor.startBatch({ kind: 'translation', request, tasks: [{ line: 1 }, { line: 2 }], maxWorkers: 1,
    label: () => 'Sibling', range: entry => ({ fromLine: entry.line, toLine: entry.line }), documentId: () => undefined,
    run: async (entry, _request, signal) => {
      if (entry.line === 2) { queuedStarted = true; return {}; }
      await new Promise((_, reject) => { signal.addEventListener('abort', () => { siblingStopped = true; reject(signal.reason); }, { once: true }); });
    }
  });
  const batch = supervisor.startTranslationReviewBatch({ ...reviewOptions,
    onSettled: async outcome => {
      assert.equal(outcome.batch.status, 'completed');
      beginSettlement();
      await settlementRelease;
      throw new Error('disk unavailable during review settlement');
    }
  });
  await settlementStarted;
  assert.ok(supervisor.activeBatchIds.has(batch.id), 'review pool must retain ownership through the Host commit');
  releaseSettlement();
  await supervisor.waitForAll();
  assert.equal(fatalCalls, 1);
  assert.equal(providerCalls, 0);
  assert.ok(siblingStopped);
  assert.equal(queuedStarted, false);
  const completed = supervisor.list().find(entry => entry.id === batch.id);
  assert.equal(completed.status, 'failed');
  assert.match(completed.error, /Host resumed review settlement failed: disk unavailable/);
  const notification = messages.find(message => message.details?.batchId === batch.id);
  assert.equal(notification.details.failureDisposition, 'host_integrity_failure');
  assert.equal(notification.details.status, 'failed');
  assert.throws(() => supervisor.startTranslationReviewBatch(reviewOptions), error => error.retryable === false);
});

test('Host-owned resumed review preparation failure reports a terminal error before any runtime', async () => {
  const failure = new NonRetryableAssignmentError('retained review hash is incompatible');
  let fatalCalls = 0;
  let runtimeCalls = 0;
  let outcome;
  const messages = [];
  const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {},
    notifyParent: async message => { messages.push(message); },
    onFatalHostFailure: async () => { fatalCalls++; },
    createModelSelection: async () => { runtimeCalls++; throw new Error('Must not create a runtime'); }
  });
  const batch = supervisor.startTranslationReviewBatch({ ...reviewOptions,
    prepareChunkReview: async () => { throw failure; }, onSettled: async value => { outcome = value; }
  });
  await supervisor.waitForAll();
  assert.equal(fatalCalls, 1);
  assert.equal(runtimeCalls, 0);
  assert.equal(outcome.error, failure);
  assert.equal(outcome.batch.status, 'failed');
  assert.equal(supervisor.list().find(entry => entry.id === batch.id).status, 'failed');
  assert.equal(messages[0].details.failureDisposition, 'host_integrity_failure');
  assert.match(messages[0].content, /retained review hash is incompatible/);
});

test('resumed review preserves both settlement and Host failure persistence errors', async () => {
  const messages = [];
  const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {},
    notifyParent: async message => { messages.push(message); },
    onFatalHostFailure: async () => { throw new Error('fatal state persistence failed'); }
  });
  const batch = supervisor.startTranslationReviewBatch({ ...reviewOptions,
    onSettled: async () => { throw new Error('review checkpoint failed'); }
  });
  await supervisor.waitForAll();
  const completed = supervisor.list().find(entry => entry.id === batch.id);
  assert.equal(completed.status, 'failed');
  assert.match(completed.error, /review checkpoint failed.*fatal state persistence failed/);
  assert.equal(messages[0].details.failureDisposition, 'host_integrity_failure');
});

test('resumed review completion notification failure reaches the fatal Host callback', async () => {
  let observed;
  const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {},
    notifyParent: async () => { throw new Error('parent session append failed'); },
    onFatalHostFailure: async error => { observed = error; }
  });
  const batch = supervisor.startTranslationReviewBatch(reviewOptions);
  await supervisor.waitForAll();
  assert.equal(observed.retryable, false);
  assert.match(observed.message, /Host resumed review notification failed: parent session append failed/);
  assert.equal(supervisor.list().find(entry => entry.id === batch.id).status, 'failed');
  assert.equal(supervisor.hasRunning(), false);
});

for (const callback of ['reviewRequestForTask', 'prepareChunkReview']) {
  test(`ordinary Host ${callback} failure is terminal in the resumed review path`, async () => {
    let observed;
    let runtimeCalls = 0;
    const messages = [];
    const supervisor = new YnSubagentSupervisor({ publishCustomMessage: async () => {},
      notifyParent: async message => { messages.push(message); },
      onFatalHostFailure: async error => { observed = error; },
      createModelSelection: async () => { runtimeCalls++; throw new Error('Must not create a runtime'); }
    });
    supervisor.startTranslationReviewBatch({ ...reviewOptions,
      [callback]: async () => { throw new Error('fixed retained artifact disappeared'); }
    });
    await supervisor.waitForAll();
    assert.equal(runtimeCalls, 0);
    assert.equal(observed.retryable, false);
    assert.match(observed.message, /Host resumed review preparation failed: fixed retained artifact disappeared/);
    assert.equal(messages[0].details.failureDisposition, 'host_integrity_failure');
    assert.equal(messages[0].details.status, 'failed');
  });
}
