/** Self-contained so generated review HTML and Host application use the same gate. */
export function checkProposalSafety(args: {
  sourceText?: string;
  currentText: string;
  oldText?: string;
  intendedText?: string;
  rowSource?: string;
  rowExists: boolean;
  revision: number;
  baseRevision?: number;
  lastRevisionSource?: string;
  allowStaleTarget?: boolean;
}): { ok: boolean; reason: string; alreadyApplied?: boolean } {
  function comparable(value: string | undefined): string {
    return String(value || "").normalize("NFKC").replace(/\s+/g, "").trim().toLowerCase();
  }
  function similarity(left: string | undefined, right: string | undefined): number {
    const a = comparable(left);
    const b = comparable(right);
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    const current = new Array<number>(b.length + 1);
    for (let i = 1; i <= a.length; i += 1) {
      current[0] = i;
      for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length);
  }
  if (!args.rowExists) return { ok: false, reason: "missing-line" };
  if (args.sourceText && similarity(args.sourceText, args.rowSource) < 0.8) return { ok: false, reason: "source-mismatch" };
  if (args.intendedText && comparable(args.intendedText) === comparable(args.currentText)) return { ok: true, reason: "", alreadyApplied: true };
  if (args.lastRevisionSource === "desktop-edit" && args.allowStaleTarget !== true) return { ok: false, reason: "manual-edit" };
  if (args.allowStaleTarget === true) return { ok: true, reason: "" };
  if (args.oldText && similarity(args.oldText, args.currentText) < 0.8) return { ok: false, reason: "patch-conflict" };
  if (Number.isInteger(args.baseRevision) && Number(args.baseRevision) >= 0 && args.revision !== args.baseRevision) return { ok: false, reason: "base-revision-conflict" };
  return { ok: true, reason: "" };
}

export function proposalSafetyBrowserScript(): string {
  return `const checkProposalSafety = ${checkProposalSafety.toString()};`;
}
