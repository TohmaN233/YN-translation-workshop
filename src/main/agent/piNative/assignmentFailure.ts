export class NonRetryableAssignmentError extends Error {
  readonly retryable = false;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NonRetryableAssignmentError";
  }
}

/** Model retries cannot repair a stale review binding. Host may reconcile it
 * once all old owners settle, then continue the retained workflow. */
export class TranslationReviewBindingChangedError extends NonRetryableAssignmentError {
  readonly recoveryKey: string;
  readonly replacement?: { documentId: string; fromLine: number; toLine: number; candidatePath: string; inputHash: string; previousAuditId: string };
  constructor(message: string, recoveryKey: string, replacement?: TranslationReviewBindingChangedError["replacement"]) {
    super(message);
    this.recoveryKey = recoveryKey;
    this.replacement = replacement;
    this.name = "TranslationReviewBindingChangedError";
  }
}

/** A reviewed staging promotion may have a durable canonical checkpoint already.
 * Only its Host callback may require preserving that verified post-image when
 * the forced old-checkpoint compensation cannot be confirmed. */
export class TranslationPromotionCompensationError extends NonRetryableAssignmentError {
  readonly preserveCanonicalPostImage = true;

  constructor(message: string, cause: unknown) {
    super(message, cause);
    this.name = "TranslationPromotionCompensationError";
  }
}

export interface ParentTakeoverAssignmentDetails {
  documentId?: string;
  fromLine: number;
  toLine: number;
  rejectedLines: number[];
  feedback: string;
  stagingCandidatePath?: string;
  candidateHash?: string;
}

export class ParentTakeoverAssignmentError extends NonRetryableAssignmentError {
  readonly failureDisposition = "parent_takeover_required" as const;
  readonly details: ParentTakeoverAssignmentDetails;

  constructor(message: string, details: ParentTakeoverAssignmentDetails, cause?: unknown) {
    super(message, cause);
    this.name = "ParentTakeoverAssignmentError";
    this.details = details;
  }
}

export class SubagentTransportExhaustedError extends NonRetryableAssignmentError {
  readonly failureDisposition = "transport_retry_exhausted" as const;
  readonly stopWorker = true;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "SubagentTransportExhaustedError";
  }
}

export function isNonRetryableAssignmentError(error: unknown): boolean {
  return error instanceof NonRetryableAssignmentError
    || (error instanceof Error && (error as Error & { retryable?: unknown }).retryable === false);
}

export function isParentTakeoverAssignmentError(error: unknown): error is ParentTakeoverAssignmentError {
  return error instanceof ParentTakeoverAssignmentError;
}

export class ProviderAuthExpiredError extends NonRetryableAssignmentError {
  readonly failureDisposition = "provider_auth_expired" as const;
  readonly replaceWorker = true;
  readonly requeueAssignment = true;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ProviderAuthExpiredError";
  }
}

const EXPIRED_PROVIDER_AUTH_ERROR = /OAuth2 access token could not be validated|access token is expired|token is expired and cannot be refreshed/i;

export function isExpiredProviderAuthError(error: unknown): boolean {
  if (error instanceof ProviderAuthExpiredError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return EXPIRED_PROVIDER_AUTH_ERROR.test(message);
}

export function isProviderAuthExpiredError(error: unknown): error is ProviderAuthExpiredError {
  return error instanceof ProviderAuthExpiredError || isExpiredProviderAuthError(error);
}

export function isSubagentTransportExhaustedError(
  error: unknown
): error is SubagentTransportExhaustedError {
  return error instanceof SubagentTransportExhaustedError;
}

/** Internal failures cannot be repaired by another model submission. */
export function isFatalHostAssignmentError(error: unknown): boolean {
  return isNonRetryableAssignmentError(error)
    && !isParentTakeoverAssignmentError(error)
    && !isProviderAuthExpiredError(error)
    && !isSubagentTransportExhaustedError(error);
}

export function isWorkflowStoppingAssignmentError(error: unknown): boolean {
  return isFatalHostAssignmentError(error) || isSubagentTransportExhaustedError(error);
}
