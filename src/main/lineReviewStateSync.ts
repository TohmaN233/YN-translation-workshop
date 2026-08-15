export type LineReviewStateRecord = Record<string, unknown>;

const LINE_SCOPED_KEYS = [
  "edits",
  "status",
  "revisions",
  "revisionHistory",
  "auditIssues",
  "auditWhitelist"
] as const;

function stateLineNumbers(state: LineReviewStateRecord): number[] {
  const lines = new Set<number>();
  for (const key of LINE_SCOPED_KEYS) {
    const map = objectRecord(state[key]);
    if (!map) continue;
    for (const line of Object.keys(map)) {
      const numeric = Number(line);
      if (Number.isInteger(numeric) && numeric > 0) lines.add(numeric);
    }
  }
  return [...lines].sort((left, right) => left - right);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function normalizeChangedLineNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((line) => Number(line))
    .filter((line) => Number.isInteger(line) && line > 0))]
    .sort((left, right) => left - right);
}

export function normalizeChangedStateKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((key) => String(key).trim())
    .filter((key) => key
      && key !== "documentRevision"
      && !LINE_SCOPED_KEYS.includes(key as (typeof LINE_SCOPED_KEYS)[number])
      && key !== "__proto__"
      && key !== "constructor"
      && key !== "prototype"))]
    .sort();
}

export function assertExpectedLineRevisions(
  currentValue: unknown,
  expectedValue: unknown,
  changedLineValue: unknown
): void {
  const current = objectRecord(currentValue) ?? {};
  const revisions = objectRecord(current.revisions) ?? {};
  const expected = objectRecord(expectedValue);
  const changedLines = normalizeChangedLineNumbers(changedLineValue);
  if (!expected) {
    if (changedLines.length > 0) {
      throw new Error("Proposal changes require expected revisions for every changed line.");
    }
    return;
  }
  for (const line of changedLines) {
    const key = String(line);
    if (!Object.prototype.hasOwnProperty.call(expected, key)) {
      throw new Error(`Proposal changes require the expected revision for line ${line}.`);
    }
    const expectedRevision = Number(expected[key]);
    const currentRevision = Number(revisions[key] ?? 0);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error(`Proposal changes contain an invalid expected revision for line ${line}.`);
    }
    const canonicalRevision = Number.isInteger(currentRevision) && currentRevision >= 0 ? currentRevision : 0;
    if (canonicalRevision !== expectedRevision) {
      throw new Error(
        `Proposal line ${line} changed from revision ${expectedRevision} to ${canonicalRevision}; reload before applying the suggestion.`
      );
    }
  }
}

export function acceptLineReviewMutationSequence(
  sequences: Map<string, number>,
  clientIdValue: unknown,
  mutationIdValue: unknown
): boolean {
  const clientId = typeof clientIdValue === "string" ? clientIdValue.trim() : "";
  const mutationId = typeof mutationIdValue === "string" ? mutationIdValue.trim() : "";
  if (!clientId || !mutationId.startsWith(`${clientId}:`)) return true;
  const sequenceText = mutationId.slice(clientId.length + 1);
  if (!/^\d+$/.test(sequenceText)) return true;
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return true;
  const previous = sequences.get(clientId) ?? 0;
  if (sequence <= previous) return false;
  sequences.set(clientId, sequence);
  return true;
}

export function mergeCanonicalLineReviewState(
  currentValue: unknown,
  incomingValue: unknown,
  changedLineValue: unknown,
  changedStateKeyValue: unknown = []
): LineReviewStateRecord {
  const current = objectRecord(currentValue) ?? {};
  const incoming = objectRecord(incomingValue) ?? {};
  const changedLines = normalizeChangedLineNumbers(changedLineValue);
  const changedStateKeys = normalizeChangedStateKeys(changedStateKeyValue);
  const hasCanonicalState = Object.keys(current).length > 0;
  const merged: LineReviewStateRecord = hasCanonicalState ? { ...current } : { ...incoming };

  for (const key of changedStateKeys) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      merged[key] = incoming[key];
    } else {
      delete merged[key];
    }
  }

  for (const key of LINE_SCOPED_KEYS) {
    const currentMap = objectRecord(current[key]);
    const incomingMap = objectRecord(incoming[key]);
    if (changedLines.length === 0) {
      if (currentMap) merged[key] = { ...currentMap };
      else if (incomingMap) merged[key] = { ...incomingMap };
      else delete merged[key];
      continue;
    }

    const nextMap = { ...(currentMap ?? {}) };
    for (const line of changedLines) {
      const lineKey = String(line);
      if (incomingMap && Object.prototype.hasOwnProperty.call(incomingMap, lineKey)) {
        nextMap[lineKey] = incomingMap[lineKey];
      } else {
        delete nextMap[lineKey];
      }
    }
    merged[key] = nextMap;
  }

  const currentRevision = Number(current.documentRevision);
  const incomingRevision = Number(incoming.documentRevision);
  merged.documentRevision = Math.max(
    Number.isInteger(currentRevision) && currentRevision >= 0 ? currentRevision : 0,
    Number.isInteger(incomingRevision) && incomingRevision >= 0 ? incomingRevision : 0
  ) + 1;
  return merged;
}

export function mergeLegacyProposalLineReviewState(
  currentValue: unknown,
  legacyValue: unknown
): LineReviewStateRecord {
  const current = objectRecord(currentValue) ?? {};
  const legacy = objectRecord(legacyValue) ?? {};
  return mergeCanonicalLineReviewState(current, legacy, stateLineNumbers(legacy));
}
