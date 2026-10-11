import type { YnSessionHostState, ProofreadHostState } from "./proofreadSessionState.ts";
import type { TranslationAlignmentHostState } from "./translationAlignmentState.ts";

/** A derived replay window, never model context or an alternative session authority. */
export interface HostRestorePoint {
  version: 1;
  anchorId: string;
  anchorSeq: number;
  ownerSessionId: string;
  current: YnSessionHostState;
  currentHash: string;
  previous?: YnSessionHostState;
  beforePrevious?: YnSessionHostState;
  previousAnchor?: { id: string; hash: string };
  beforePreviousAnchor?: { id: string; hash: string };
  latestProofread?: ProofreadHostState;
  latestAlignment?: TranslationAlignmentHostState;
  latestProofreadEvidence?: { id: string; hash: string; state: YnSessionHostState };
  latestAlignmentEvidence?: { id: string; hash: string; state: YnSessionHostState };
  relativePaths: boolean;
  latestProofreadRelativePaths: boolean;
  latestAlignmentRelativePaths: boolean;
  runtimeContractVersion: number;
  deltasSinceCheckpoint: number;
  /** Receipt suffix recovery may not have encountered an older nonempty section. */
  incompleteLegacyRecoveryWindow?: boolean;
}

export function advanceHostRestorePoint(
  previous: HostRestorePoint | undefined,
  entry: { id: string; seq: number; data: Record<string, any> },
  current: YnSessionHostState,
  currentHash: string
): HostRestorePoint {
  const relativePaths = entry.data.projectPathsVersion === 1;
  const proofreadPresent = Object.keys(current.proofread.documents).length > 0 || Object.keys(current.proofread.localScopes).length > 0;
  const alignmentPresent = Object.keys(current.translationAlignment.documents).length > 0 || Object.keys(current.translationAlignment.ranges).length > 0;
  return {
    version: 1, anchorId: entry.id, anchorSeq: entry.seq, ownerSessionId: current.ownerSessionId,
    current, currentHash, previous: previous?.current, beforePrevious: previous?.previous,
    previousAnchor: previous ? {id:previous.anchorId,hash:previous.currentHash} : undefined,
    beforePreviousAnchor: previous?.previousAnchor,
    latestProofread: proofreadPresent ? current.proofread : previous?.latestProofread,
    latestAlignment: alignmentPresent ? current.translationAlignment : previous?.latestAlignment,
    latestProofreadEvidence: proofreadPresent || !previous?.latestProofread ? undefined : previous.latestProofreadEvidence ?? {id:previous.anchorId,hash:previous.currentHash,state:previous.current},
    latestAlignmentEvidence: alignmentPresent || !previous?.latestAlignment ? undefined : previous.latestAlignmentEvidence ?? {id:previous.anchorId,hash:previous.currentHash,state:previous.current},
    relativePaths,
    latestProofreadRelativePaths: proofreadPresent ? relativePaths : previous?.latestProofreadRelativePaths ?? false,
    latestAlignmentRelativePaths: alignmentPresent ? relativePaths : previous?.latestAlignmentRelativePaths ?? false,
    runtimeContractVersion: entry.data.runtimeContractVersion ?? 1,
    deltasSinceCheckpoint: entry.data.mode === "delta" ? (previous?.deltasSinceCheckpoint ?? 0) + 1 : 0
  };
}
