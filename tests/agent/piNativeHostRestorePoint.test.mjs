import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT, StorageBackedSession, branchTip } from '@earendil-works/pi-agent-core/node';
import { IndexedJsonlStorage } from '../../src/main/agent/piNative/indexedJsonlStorage.ts';
import { registerDiskSession, unregisterDiskSession, appendSessionCustomEntry } from '../../src/main/agent/piNative/sessionAccess.ts';
import { compactPiSessionFile } from '../../src/main/agent/piNative/sessionStorageMaintenance.ts';
import { PiSessionRepository } from '../../src/main/agent/piNative/sessionRepository.ts';
import { appendYnSessionHostState, loadYnSessionHostState, getYnHostStateLoadDiagnostics, createProofreadHostState, createTranslationAlignmentHostState, hostStateHash, createJsonDelta } from '../../src/main/agent/piNative/proofreadSessionState.ts';
const root = await mkdtemp(path.join(os.tmpdir(), 'yn-host-restore-'));
const digest = value => createHash('sha256').update(value).digest('hex');
async function openFixture(file, metadata) {
  const storage = await IndexedJsonlStorage.open(file);
  const session = new StorageBackedSession({...metadata,path:file},storage);
  registerDiskSession(session,storage);
  return session;
}
async function closeFixture(session) { unregisterDiskSession(session); await session.close(BACKGROUND_CONTEXT); }
try {
  const repository = new PiSessionRepository(root);
  let session = await repository.create('restore-owner');
  const metadata = session.metadata;
  const state = {schemaVersion:1, ownerSessionId:metadata.id, proofread:createProofreadHostState(), translationAlignment:createTranslationAlignmentHostState()};
  for (let i=0;i<30;i++) {
    state.proofread.documents.chapter = {sampledLines:[i+1], reportInitialized:true, completedSplitScopes:[], glossaryCandidates:[]};
    await appendYnSessionHostState(session, state);
  }
  await session.close(BACKGROUND_CONTEXT);
  session = await repository.open(metadata.id);
  assert.deepEqual(await loadYnSessionHostState(session, metadata.id), state);
  assert.equal(getYnHostStateLoadDiagnostics(session).reconstructedStateCount, 0, 'cold load uses the verified native restore point instead of rebuilding historical states');
  state.proofread.documents.chapter.sampledLines.push(99);
  await appendYnSessionHostState(session,state);
  await session.close(BACKGROUND_CONTEXT);
  session = await repository.open(metadata.id);
  assert.deepEqual(await loadYnSessionHostState(session,metadata.id),state,'cached cursor remains the native encoded delta baseline');
  assert.equal(getYnHostStateLoadDiagnostics(session).reconstructedStateCount,0);
  await session.close(BACKGROUND_CONTEXT);

  const nativeFile = metadata.path, indexFile = `${nativeFile}.yn-index.json`;
  const savedIndex = await readFile(indexFile);
  for (const [field,value] of [['runtimeContractVersion',1],['relativePaths',false],['deltasSinceCheckpoint',800]]) {
    const changed=JSON.parse(savedIndex);changed.index.hostRestorePoint[field]=value;
    changed.indexDigest=digest(JSON.stringify(changed.index));await writeFile(indexFile,JSON.stringify(changed));
    const originalBytes=(await readFile(nativeFile)).length;
    session=await openFixture(nativeFile,metadata);
    assert.deepEqual(await loadYnSessionHostState(session,metadata.id),state);
    assert.equal(getYnHostStateLoadDiagnostics(session).restorePoint,'full-replay',`${field} must match the actual native anchor metadata`);
    assert.equal((await readFile(nativeFile)).length,originalBytes,'cache metadata cannot cause a native migration/write');
    await closeFixture(session);
  }
  const corrupt = JSON.parse(savedIndex);
  corrupt.index.hostRestorePoint.current.proofread.documents.chapter.sampledLines = [700];
  corrupt.indexDigest = digest(JSON.stringify(corrupt.index));
  await writeFile(indexFile,JSON.stringify(corrupt));
  session = await openFixture(nativeFile,metadata);
  assert.deepEqual(await loadYnSessionHostState(session,metadata.id),state,'native anchor rejects even a checksum-consistent corrupt materialization');
  assert.equal(getYnHostStateLoadDiagnostics(session).restorePoint,'full-replay');
  await closeFixture(session);

  const fakeCertificateFile=path.join(root,'fake-certificate.jsonl');
  const fakeWrites=(await readFile(nativeFile,'utf8')).trimEnd().split('\n').map(line=>JSON.parse(line));
  const fakeHosts=fakeWrites.flatMap(tx=>Array.isArray(tx)?tx:[tx]).filter(w=>w.kind==='entry' && w.customType==='yn.host-state.v2');
  assert.ok(fakeHosts.length>3);
  // Force a malformed historical delta even when the small fixture preferred
  // checkpoints. A receipt shortcut starts after this broken entry.
  fakeHosts[1].data={...fakeHosts[1].data,mode:'delta',baseHash:'invalid-native-history',operations:[]};
  await writeFile(fakeCertificateFile,fakeWrites.map(tx=>JSON.stringify(tx)).join('\n')+'\n');
  let fakeStorage=await IndexedJsonlStorage.open(fakeCertificateFile);await fakeStorage.close();
  const fakeCertificate=JSON.parse(await readFile(`${fakeCertificateFile}.yn-index.json`,'utf8'));
  fakeCertificate.index.verifiedHostHistory={version:1,sourceFingerprint:fakeCertificate.index.sourceFingerprint,committedBytes:fakeCertificate.index.committedBytes,throughSeq:fakeCertificate.index.nextSeq-1};
  fakeCertificate.indexDigest=digest(JSON.stringify(fakeCertificate.index));
  await writeFile(`${fakeCertificateFile}.yn-index.json`,JSON.stringify(fakeCertificate));
  session=await openFixture(fakeCertificateFile,metadata);
  await assert.rejects(loadYnSessionHostState(session,metadata.id),/does not match its preceding checkpoint/,'a sidecar cannot invent published prefix certification');
  await closeFixture(session);

  // A lost clean-close index update must certify the existing native prefix,
  // then validate just the newly committed tail.
  const crashIndex = await readFile(indexFile);
  session = await openFixture(nativeFile,metadata);
  const tailState = structuredClone(state); tailState.workflowSuspended = true;
  await appendSessionCustomEntry(session,'yn.host-state.v2',{schemaVersion:3,runtimeContractVersion:2,ownerSessionId:metadata.id,projectPathsVersion:1,mode:'delta',baseHash:hostStateHash(state),stateHash:hostStateHash(tailState),operations:createJsonDelta(state,tailState)});
  await closeFixture(session);
  await writeFile(indexFile,crashIndex);
  session = await openFixture(nativeFile,metadata);
  assert.deepEqual(await loadYnSessionHostState(session,metadata.id),tailState);
  assert.equal(getYnHostStateLoadDiagnostics(session).reconstructedStateCount,1,'an unclosed owner leaves only one unverified appended Host state');
  await closeFixture(session);

  // The main branch identity is part of the restore point, not just sequence.
  session = await openFixture(nativeFile,metadata);
  const fork = await session.createBranch('restore-fork',null,BACKGROUND_CONTEXT);
  const forkState = structuredClone(state); forkState.proofread.documents.chapter.sampledLines=[500];
  const forkId = await fork.appendCustomEntry('yn.host-state.v2',{schemaVersion:3,runtimeContractVersion:2,ownerSessionId:metadata.id,projectPathsVersion:1,mode:'checkpoint',stateHash:hostStateHash(forkState),state:forkState},BACKGROUND_CONTEXT);
  await session.setValue(branchTip('main'),forkId,BACKGROUND_CONTEXT);
  assert.deepEqual(await loadYnSessionHostState(session,metadata.id),forkState);
  assert.equal(getYnHostStateLoadDiagnostics(session).restorePoint,'full-replay');
  await closeFixture(session);

  const tombstoneFile = path.join(root,'tombstone.jsonl');
  await copyFile(nativeFile,tombstoneFile);
  session = await openFixture(tombstoneFile,metadata);
  await loadYnSessionHostState(session,metadata.id);
  const tombstoneEvidence=structuredClone(forkState);tombstoneEvidence.proofread.documents.chapter.sampledLines=[500,501];
  await appendYnSessionHostState(session,tombstoneEvidence);
  const empty = {schemaVersion:1,ownerSessionId:metadata.id,proofread:createProofreadHostState(),translationAlignment:createTranslationAlignmentHostState()};
  await appendYnSessionHostState(session,empty);
  await closeFixture(session);
  const tombstoneIndexPath=`${tombstoneFile}.yn-index.json`;
  const tombstoneIndex=JSON.parse(await readFile(tombstoneIndexPath,'utf8'));
  for (const action of ['older-witness','omitted-witness']) {
    const modified=structuredClone(tombstoneIndex);
    if(action==='older-witness') {
      modified.index.hostRestorePoint.latestProofread=modified.index.hostRestorePoint.beforePrevious.proofread;
      modified.index.hostRestorePoint.latestProofreadEvidence={...modified.index.hostRestorePoint.beforePreviousAnchor,state:modified.index.hostRestorePoint.beforePrevious};
    } else {delete modified.index.hostRestorePoint.latestProofread;delete modified.index.hostRestorePoint.latestProofreadEvidence;}
    delete modified.index.hostRestorePoint.incompleteLegacyRecoveryWindow;
    modified.indexDigest=digest(JSON.stringify(modified.index));await writeFile(tombstoneIndexPath,JSON.stringify(modified));
    session=await openFixture(tombstoneFile,metadata);
    const restored=await loadYnSessionHostState(session,metadata.id);
    assert.deepEqual(restored.proofread,tombstoneEvidence.proofread,`empty Stop cannot trust ${action} from the cache`);
    assert.equal(getYnHostStateLoadDiagnostics(session).restorePoint,'full-replay');await closeFixture(session);
  }
  session = await openFixture(tombstoneFile,metadata);
  const tombstoneRestored = await loadYnSessionHostState(session,metadata.id);
  assert.deepEqual(tombstoneRestored.proofread,tombstoneEvidence.proofread,'native replay retains exact pre-Stop evidence');
  assert.equal(getYnHostStateLoadDiagnostics(session).restorePoint,'full-replay','legacy empty Stop markers require complete native evidence recovery');
  assert.deepEqual(await loadYnSessionHostState(session,metadata.id,{skipDerivedRestore:true}),tombstoneRestored,'fast legacy recovery equals complete native replay');
  await assert.rejects(loadYnSessionHostState(session,metadata.id,{throwIfCancelled:()=>{throw new Error('restore stopped');}}),/restore stopped/);
  await closeFixture(session);

  const upgradeFile = path.join(root,'upgrade.jsonl');
  await copyFile(nativeFile,upgradeFile);
  await compactPiSessionFile(upgradeFile);
  let upgradeIndex = JSON.parse(await readFile(`${upgradeFile}.yn-index.json`,'utf8'));
  assert.ok(upgradeIndex.index.hostRestorePoint,'maintenance verification seeds the exact main-branch replay window');
  session = await openFixture(upgradeFile,metadata);
  assert.deepEqual(await loadYnSessionHostState(session,metadata.id),forkState);
  assert.equal(getYnHostStateLoadDiagnostics(session).reconstructedStateCount,0);
  await closeFixture(session);

  // Remove the new materialization to model the old published-v1 receipt.
  await rm(`${upgradeFile}.yn-index.json`);
  session = await openFixture(upgradeFile,metadata);
  const appended = structuredClone(forkState); appended.workflowSuspended=true;
  await appendSessionCustomEntry(session,'yn.host-state.v2',{schemaVersion:3,runtimeContractVersion:2,ownerSessionId:metadata.id,projectPathsVersion:1,mode:'delta',baseHash:hostStateHash(forkState),stateHash:hostStateHash(appended),operations:createJsonDelta(forkState,appended)});
  await closeFixture(session);
  await rm(`${upgradeFile}.yn-index.json`);
  session = await openFixture(upgradeFile,metadata);
  assert.deepEqual(await loadYnSessionHostState(session,metadata.id),appended);
  assert.equal(getYnHostStateLoadDiagnostics(session).restorePoint,'verified-prefix');
  assert.equal(getYnHostStateLoadDiagnostics(session).reconstructedStateCount,1,'receipt certifies only the original bytes; new appended deltas are fully checked');
  await appendSessionCustomEntry(session,'yn.host-state.v2',{schemaVersion:3,runtimeContractVersion:2,ownerSessionId:metadata.id,mode:'delta',baseHash:hostStateHash(appended),stateHash:'damaged',operations:[]});
  await assert.rejects(loadYnSessionHostState(session,metadata.id),/delta hash does not match/);
  await closeFixture(session);

  // The old upgrade verified state hashes but not runtime order. An exact
  // receipt digest must never exempt malformed historical metadata.
  const backwardsFile=path.join(root,'backwards.jsonl');
  const writes=(await readFile(upgradeFile,'utf8')).trimEnd().split('\n').map(line=>JSON.parse(line));
  const last=writes.at(-1);const entries=Array.isArray(last)?last:[last];
  entries.find(w=>w.kind==='entry').data.runtimeContractVersion=1;
  const backwardsBytes=writes.map(w=>JSON.stringify(w)).join('\n')+'\n';
  await writeFile(backwardsFile,backwardsBytes);
  await writeFile(`${backwardsFile}.storage-upgrade.json`,JSON.stringify({version:1,status:'published',verified:true,sessionId:metadata.id,compactedHash:digest(backwardsBytes),compactedBytes:Buffer.byteLength(backwardsBytes)}));
  await assert.rejects(IndexedJsonlStorage.open(backwardsFile),/backwards Host runtime/);
} finally { await rm(root,{recursive:true,force:true}); }
console.log('Pi native derived Host restore point passed.');
