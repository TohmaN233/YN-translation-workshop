export class NonRetryableAssignmentError extends Error {
  readonly retryable = false;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NonRetryableAssignmentError";
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
