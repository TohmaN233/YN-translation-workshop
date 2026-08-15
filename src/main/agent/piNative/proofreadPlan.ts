import type { ProofreadDeterministicSignal } from "./proofreadPrescan.ts";

export interface MontecarloProofreadTask {
  fromLine: number;
  toLine: number;
  label: string;
  mode: "montecarlo";
  round: number;
  sampledLines: number[];
  deterministicSignals: ProofreadDeterministicSignal[];
}

export interface SplitProofreadTask {
  fromLine: number;
  toLine: number;
  label: string;
  mode: "split";
  checkpointSize: number;
  /** Explicit non-contiguous semantic ownership used only for HOT-region escalation. */
  reviewLines?: number[];
  deterministicSignals: ProofreadDeterministicSignal[];
}

export interface ProofreadRegion {
  index: number;
  fromLine: number;
  toLine: number;
  lineCount: number;
  affectedLineCount: number;
  density: number;
  tier: "HOT" | "WARM" | "COLD";
}

export function classifyProofreadRegions(args: {
  totalLines: number;
  signals: ProofreadDeterministicSignal[];
  regionSize?: number;
}): ProofreadRegion[] {
  if (!Number.isInteger(args.totalLines) || args.totalLines < 1) {
    throw new Error("Proofreading region classification requires a positive aligned line count.");
  }
  const regionSize = Math.max(1, Math.floor(args.regionSize ?? 500));
  const affectedByRegion = new Map<number, Set<number>>();
  for (const signal of args.signals) {
    if (!Number.isInteger(signal.line) || signal.line < 1 || signal.line > args.totalLines) continue;
    const index = Math.floor((signal.line - 1) / regionSize);
    const affected = affectedByRegion.get(index) ?? new Set<number>();
    affected.add(signal.line);
    affectedByRegion.set(index, affected);
  }
  return Array.from({ length: Math.ceil(args.totalLines / regionSize) }, (_, index) => {
    const fromLine = index * regionSize + 1;
    const toLine = Math.min(args.totalLines, fromLine + regionSize - 1);
    const lineCount = toLine - fromLine + 1;
    const affectedLineCount = affectedByRegion.get(index)?.size ?? 0;
    const density = affectedLineCount / lineCount;
    return {
      index,
      fromLine,
      toLine,
      lineCount,
      affectedLineCount,
      density,
      tier: density > 0.05 ? "HOT" : density > 0.01 ? "WARM" : "COLD"
    };
  });
}

export function createSplitProofreadTasks(args: {
  totalLines: number;
  workerCount: number;
  splitSize: number;
  signals: ProofreadDeterministicSignal[];
}): SplitProofreadTask[] {
  if (!Number.isInteger(args.totalLines) || args.totalLines < 1) {
    throw new Error("Split proofreading requires at least one aligned line.");
  }
  if (!Number.isInteger(args.workerCount) || args.workerCount < 1) {
    throw new Error("Split proofreading requires a positive worker count.");
  }
  if (!Number.isInteger(args.splitSize) || args.splitSize < 1) {
    throw new Error("proofreadSplitSize must be a positive integer.");
  }
  const assignmentSize = args.splitSize;
  const tasks: SplitProofreadTask[] = [];
  for (let fromLine = 1; fromLine <= args.totalLines; fromLine += assignmentSize) {
    const toLine = Math.min(args.totalLines, fromLine + assignmentSize - 1);
    tasks.push({
      fromLine,
      toLine,
      label: `Proofread L${fromLine}-L${toLine}`,
      mode: "split",
      checkpointSize: toLine - fromLine + 1,
      deterministicSignals: args.signals.filter((signal) => signal.line >= fromLine && signal.line <= toLine)
    });
  }
  return tasks;
}

export function createHotSplitProofreadTasks(args: {
  totalLines: number;
  workerCount: number;
  splitSize: number;
  signals: ProofreadDeterministicSignal[];
}): SplitProofreadTask[] {
  if (!Number.isInteger(args.workerCount) || args.workerCount < 1) {
    throw new Error("HOT-region split proofreading requires a positive worker count.");
  }
  if (!Number.isInteger(args.splitSize) || args.splitSize < 1) {
    throw new Error("proofreadSplitSize must be a positive integer.");
  }
  const hotRegions = classifyProofreadRegions({
    totalLines: args.totalLines,
    signals: args.signals
  }).filter((region) => region.tier === "HOT");
  if (hotRegions.length === 0) {
    throw new Error("The deterministic proofreading heat map has no HOT region to switch to split review.");
  }
  const assignmentSize = args.splitSize;
  const tasks: SplitProofreadTask[] = [];
  for (const region of hotRegions) {
    for (let fromLine = region.fromLine; fromLine <= region.toLine; fromLine += assignmentSize) {
      const toLine = Math.min(region.toLine, fromLine + assignmentSize - 1);
      const reviewLines = Array.from({ length: toLine - fromLine + 1 }, (_, index) => fromLine + index);
      tasks.push({
        fromLine,
        toLine,
        label: `HOT split review ${tasks.length + 1}: L${fromLine}-L${toLine}`,
        mode: "split",
        checkpointSize: reviewLines.length,
        reviewLines,
        deterministicSignals: args.signals.filter((signal) => signal.line >= fromLine && signal.line <= toLine)
      });
    }
  }
  return tasks;
}

function score(line: number, round: number): number {
  let value = (line * 0x9e3779b1) ^ (round * 0x85ebca6b);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return value >>> 0;
}

export function createMontecarloProofreadTasks(args: {
  totalLines: number;
  workerCount: number;
  sampleSize: number;
  round: number;
  signals: ProofreadDeterministicSignal[];
  previouslySampled: Set<number>;
}): MontecarloProofreadTask[] {
  if (!Number.isInteger(args.totalLines) || args.totalLines < 2) {
    throw new Error("Monte Carlo proofreading requires at least two aligned lines.");
  }
  if (!Number.isInteger(args.workerCount) || args.workerCount < 1) {
    throw new Error("Monte Carlo proofreading requires a positive worker count.");
  }
  if (!Number.isInteger(args.sampleSize) || args.sampleSize < 1) {
    throw new Error("Monte Carlo proofreading requires a positive sample size.");
  }
  const regions = classifyProofreadRegions({ totalLines: args.totalLines, signals: args.signals });
  const regionForLine = (line: number) => regions[Math.floor((line - 1) / 500)];
  const regionStates = regions.map((region) => {
    let sampledCount = 0;
    const available: number[] = [];
    for (let line = region.fromLine; line <= region.toLine; line += 1) {
      if (args.previouslySampled.has(line)) sampledCount += 1;
      else available.push(line);
    }
    return {
      ...region,
      sampledCount,
      available,
      retirementCount: Math.ceil(region.lineCount * 0.8),
      retired: sampledCount / region.lineCount >= 0.8
    };
  });
  const eligibleRegions = regionStates.filter((region) => !region.retired && region.available.length > 0);
  if (eligibleRegions.length === 0) return [];
  const eligibleRegionIndexes = new Set(eligibleRegions.map((region) => region.index));
  const requiredLines = [...new Set(args.signals
    .map((signal) => signal.line)
    .filter((line) => (
      !args.previouslySampled.has(line)
      && eligibleRegionIndexes.has(regionForLine(line)?.index)
    )))];
  const ratios = { HOT: 0.30, WARM: 0.15, COLD: 0.05 } as const;
  const requiredSet = new Set(requiredLines);
  const pools = eligibleRegions.map((region) => ({
    region,
    candidates: region.available
      .filter((line) => !requiredSet.has(line))
      .sort((left, right) => score(left, args.round) - score(right, args.round)),
    maximum: 0,
    quota: 0,
    remainder: 0
  }));
  for (const pool of pools) {
    const requiredInRegion = requiredLines.filter((line) => (
      line >= pool.region.fromLine && line <= pool.region.toLine
    )).length;
    const remainingBeforeRetirement = Math.max(
      0,
      pool.region.retirementCount - pool.region.sampledCount - requiredInRegion
    );
    pool.maximum = Math.min(
      pool.candidates.length,
      remainingBeforeRetirement,
      Math.max(0, Math.ceil(pool.region.lineCount * ratios[pool.region.tier]) - requiredInRegion)
    );
  }
  const regularCapacity = pools.reduce((sum, pool) => sum + pool.maximum, 0);
  const remaining = Math.min(
    regularCapacity,
    Math.max(0, Math.floor(args.sampleSize) - requiredLines.length)
  );
  const totalMaximum = pools.reduce((sum, pool) => sum + pool.maximum, 0);
  for (const pool of pools) {
    const exact = totalMaximum > 0 ? remaining * pool.maximum / totalMaximum : 0;
    pool.quota = Math.min(pool.maximum, Math.floor(exact));
    pool.remainder = exact - Math.floor(exact);
  }
  let allocated = pools.reduce((sum, pool) => sum + pool.quota, 0);
  while (allocated < remaining) {
    const pool = pools
      .filter((candidate) => candidate.quota < candidate.maximum)
      .sort((left, right) => right.remainder - left.remainder
        || ratios[right.region.tier] - ratios[left.region.tier]
        || left.region.fromLine - right.region.fromLine)[0];
    if (!pool) break;
    pool.quota += 1;
    pool.remainder = 0;
    allocated += 1;
  }
  const sampled = [
    ...requiredLines,
    ...pools.flatMap((pool) => pool.candidates.slice(0, pool.quota))
  ];
  if (sampled.length === 0) return [];
  const workerCount = Math.min(args.workerCount, sampled.length);
  const assignments = Array.from({ length: workerCount }, () => [] as number[]);
  sampled.forEach((line, index) => assignments[index % workerCount].push(line));

  return assignments.map((lines, index) => {
    lines.sort((left, right) => left - right);
    const lineSet = new Set(lines);
    return {
      fromLine: lines[0],
      toLine: lines.at(-1)!,
      label: `Monte Carlo round ${args.round}, worker ${index + 1}`,
      mode: "montecarlo" as const,
      round: args.round,
      sampledLines: lines,
      deterministicSignals: args.signals.filter((signal) => lineSet.has(signal.line))
    };
  });
}
