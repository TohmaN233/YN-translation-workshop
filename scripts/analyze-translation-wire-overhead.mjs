#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] || "");
if (!process.argv[2]) {
  throw new Error("Usage: node scripts/analyze-translation-wire-overhead.mjs <retained-verifier-root>");
}

const translationWriteToolNames = new Set([
  "writeAssignedTranslation",
  "repairAssignedTranslation",
  "repairAssignedTranslationBlocks"
]);

async function collectJsonlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-9) throw new Error("Wire-overhead regression is singular.");
    for (let cell = column; cell <= size; cell += 1) augmented[column][cell] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let cell = column; cell <= size; cell += 1) {
        augmented[row][cell] -= factor * augmented[column][cell];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function fitVisibleTokens(samples) {
  // Scale character features so the normal equations remain well-conditioned.
  const rows = samples.map((sample) => [1, sample.translationChars / 1000, sample.overheadChars / 1000]);
  const matrix = Array.from({ length: 3 }, () => Array(3).fill(0));
  const vector = Array(3).fill(0);
  for (let index = 0; index < rows.length; index += 1) {
    for (let left = 0; left < 3; left += 1) {
      vector[left] += rows[index][left] * samples[index].visibleTokens;
      for (let right = 0; right < 3; right += 1) {
        matrix[left][right] += rows[index][left] * rows[index][right];
      }
    }
  }
  const [intercept, translationPerKChars, overheadPerKChars] = solveLinearSystem(matrix, vector);
  const mean = samples.reduce((sum, sample) => sum + sample.visibleTokens, 0) / samples.length;
  let residual = 0;
  let total = 0;
  let absolute = 0;
  for (const sample of samples) {
    const predicted = intercept
      + translationPerKChars * sample.translationChars / 1000
      + overheadPerKChars * sample.overheadChars / 1000;
    residual += (sample.visibleTokens - predicted) ** 2;
    total += (sample.visibleTokens - mean) ** 2;
    absolute += Math.abs(sample.visibleTokens - predicted);
  }
  return {
    intercept,
    translationTokensPerChar: translationPerKChars / 1000,
    overheadTokensPerChar: overheadPerKChars / 1000,
    rSquared: total > 0 ? 1 - residual / total : 1,
    meanAbsoluteError: absolute / samples.length
  };
}

function fitElapsedSeconds(samples) {
  const timed = samples.filter((sample) => Number.isFinite(sample.elapsedMs) && sample.elapsedMs > 0);
  const meanTokens = timed.reduce((sum, sample) => sum + sample.outputTokens, 0) / timed.length;
  const meanSeconds = timed.reduce((sum, sample) => sum + sample.elapsedMs / 1000, 0) / timed.length;
  let covariance = 0;
  let tokenVariance = 0;
  let secondsVariance = 0;
  for (const sample of timed) {
    const tokenDelta = sample.outputTokens - meanTokens;
    const secondDelta = sample.elapsedMs / 1000 - meanSeconds;
    covariance += tokenDelta * secondDelta;
    tokenVariance += tokenDelta ** 2;
    secondsVariance += secondDelta ** 2;
  }
  const secondsPerToken = covariance / tokenVariance;
  const interceptSeconds = meanSeconds - secondsPerToken * meanTokens;
  return {
    samples: timed.length,
    interceptSeconds,
    secondsPerToken,
    tokensPerSecond: secondsPerToken > 0 ? 1 / secondsPerToken : undefined,
    rSquared: tokenVariance > 0 && secondsVariance > 0
      ? covariance ** 2 / (tokenVariance * secondsVariance)
      : 1
  };
}

function parseEntry(entry) {
  const separator = entry.indexOf(":");
  if (separator < 1) return undefined;
  const line = Number(entry.slice(0, separator));
  if (!Number.isInteger(line)) return undefined;
  return { line, text: entry.slice(separator + 1), identityChars: separator + 1 };
}

function parseRelativeField(field) {
  const separator = field.indexOf(":");
  if (separator < 1) return undefined;
  const rawId = field.slice(0, separator);
  const id = rawId.replace(/^[ \t]+/, "");
  return {
    id,
    text: field.slice(separator + 1),
    identityChars: id.length + 1,
    leadingIdentityWhitespaceChars: rawId.length - id.length
  };
}

function parseStructuredBlockLines(lines) {
  const values = lines.map(String);
  const delimited = values.map(parseRelativeField);
  if (delimited.every(Boolean)) return delimited;
  const prefixed = values.map((value) => {
    const leadingWhitespace = /^[ \t]*/.exec(value)?.[0] ?? "";
    const normalized = value.slice(leadingWhitespace.length);
    const id = normalized.slice(0, 1);
    if (!/^[0-9a-f]$/i.test(id)) return undefined;
    return {
      id,
      text: normalized.slice(1),
      identityChars: 1,
      leadingIdentityWhitespaceChars: leadingWhitespace.length
    };
  });
  if (prefixed.every(Boolean)) return prefixed;
  return values.map((text, index) => ({
    id: index.toString(36),
    text,
    identityChars: 0,
    leadingIdentityWhitespaceChars: 0
  }));
}

function parseBlock(block) {
  if (typeof block === "object" && block !== null && typeof block.id === "string" && typeof block.payload === "string") {
    return {
      id: block.id,
      entries: block.payload.split(/\r?\n/).map(parseRelativeField).filter(Boolean)
    };
  }
  if (typeof block === "object" && block !== null && typeof block.id === "string" && Array.isArray(block.lines)) {
    return {
      id: block.id,
      entries: parseStructuredBlockLines(block.lines)
    };
  }
  if (typeof block !== "string") return undefined;
  const recordSeparator = block.includes("␞") ? "␞" : "\n";
  const separator = block.indexOf(recordSeparator);
  if (separator < 1) return undefined;
  return {
    id: block.slice(0, separator),
    entries: block.slice(separator + recordSeparator.length)
      .split(recordSeparator)
      .map(parseRelativeField)
      .filter(Boolean)
  };
}

function compactPayloadArgs(args, entries, relative = false) {
  const fromLine = Number(args.fromLine ?? entries[0]?.line ?? 1);
  const payload = entries
    .map(({ line, text }) => `${relative ? (line - fromLine).toString(36) : line}:${text}`)
    .join("\n");
  return JSON.stringify({
    ...(args.fromLine === undefined ? {} : { fromLine: args.fromLine }),
    ...(args.toLine === undefined ? {} : { toLine: args.toLine }),
    payload
  });
}

function blockPayloadArgs(args, entries, blockSize = 16) {
  const blocks = [];
  for (let index = 0; index < entries.length; index += blockSize) {
    const group = entries.slice(index, index + blockSize);
    blocks.push(`${(index / blockSize).toString(36)}␞${group.map((entry) => entry.text).join("␞")}`);
  }
  return JSON.stringify({
    ...(args.fromLine === undefined ? {} : { fromLine: args.fromLine }),
    ...(args.toLine === undefined ? {} : { toLine: args.toLine }),
    blocks
  });
}

function identifiedBlockPayloadArgs(args, entries, blockSize = 16, relative = true) {
  const fromLine = Number(args.fromLine ?? entries[0]?.line ?? 1);
  const blocks = [];
  for (let index = 0; index < entries.length; index += blockSize) {
    const group = entries.slice(index, index + blockSize);
    const fields = group.map(({ line, text }) => {
      const id = relative ? (line - fromLine).toString(36) : String(line);
      return `${id}:${text}`;
    });
    blocks.push(`${(index / blockSize).toString(36)}␞${fields.join("␞")}`);
  }
  return JSON.stringify({
    ...(args.fromLine === undefined ? {} : { fromLine: args.fromLine }),
    ...(args.toLine === undefined ? {} : { toLine: args.toLine }),
    blocks
  });
}

function structuredBlockObjectArgs(args, blocks) {
  return JSON.stringify({
    ...(args.fromLine === undefined ? {} : { fromLine: args.fromLine }),
    ...(args.toLine === undefined ? {} : { toLine: args.toLine }),
    blocks: blocks.map((block) => ({
      id: block.id,
      lines: block.entries.map((entry) => `${entry.id}:${entry.text}`)
    }))
  });
}

function structuredBlockPayloadArgs(args, blocks) {
  return JSON.stringify({
    ...(args.fromLine === undefined ? {} : { fromLine: args.fromLine }),
    ...(args.toLine === undefined ? {} : { toLine: args.toLine }),
    blocks: blocks.map((block) => ({
      id: block.id,
      payload: block.entries.map((entry) => `${entry.id}:${entry.text}`).join("\n")
    }))
  });
}

function structuredBlockPositionalArgs(args, blocks) {
  return JSON.stringify({
    ...(args.fromLine === undefined ? {} : { fromLine: args.fromLine }),
    ...(args.toLine === undefined ? {} : { toLine: args.toLine }),
    blocks: blocks.map((block) => ({
      id: block.id,
      lines: block.entries.map((entry) => entry.text)
    }))
  });
}

function structuredBlockPositionalPayloadArgs(args, blocks) {
  return JSON.stringify({
    ...(args.fromLine === undefined ? {} : { fromLine: args.fromLine }),
    ...(args.toLine === undefined ? {} : { toLine: args.toLine }),
    blocks: blocks.map((block) => ({
      id: block.id,
      payload: block.entries.map((entry) => entry.text).join("\n")
    }))
  });
}

function structuredBlockPrefixIdArgs(args, blocks) {
  return JSON.stringify({
    ...(args.fromLine === undefined ? {} : { fromLine: args.fromLine }),
    ...(args.toLine === undefined ? {} : { toLine: args.toLine }),
    blocks: blocks.map((block) => ({
      id: block.id,
      lines: block.entries.map((entry) => `${entry.id}${entry.text}`)
    }))
  });
}

function flattenBlockEntries(args, blocks) {
  const fromLine = Number(args.fromLine ?? 1);
  return blocks.flatMap((block) => {
    const blockOffset = Number.parseInt(block.id, 36) * 16;
    if (!Number.isFinite(blockOffset)) return [];
    return block.entries.flatMap((entry) => {
      const fieldOffset = Number.parseInt(entry.id, 36);
      return Number.isFinite(fieldOffset)
        ? [{ line: fromLine + blockOffset + fieldOffset, text: entry.text }]
        : [];
    });
  });
}

function positionalLowerBoundArgs(args, entries) {
  return JSON.stringify({
    ...(args.fromLine === undefined ? {} : { fromLine: args.fromLine }),
    ...(args.toLine === undefined ? {} : { toLine: args.toLine }),
    translations: entries.map((entry) => entry.text)
  });
}

const files = (await collectJsonlFiles(root)).filter((file) => file.includes("pi-child-sessions"));
const samples = [];
let assistantCalls = 0;
let allOutputTokens = 0;
let nonWriteOutputTokens = 0;
let firstTimestamp = Number.POSITIVE_INFINITY;
let lastTimestamp = Number.NEGATIVE_INFINITY;
let acceptedWriteResults = 0;
let writeToolErrors = 0;
const writeCallsById = new Map();
const writeResultsByMode = {
  entries: { results: 0, accepted: 0, errors: 0, requiredLines: 0, maxRequiredLines: 0, invalidBlocks: 0, invalidLineIdentities: 0 },
  blocks: { results: 0, accepted: 0, errors: 0, requiredLines: 0, maxRequiredLines: 0, invalidBlocks: 0, invalidLineIdentities: 0 },
  payload: { results: 0, accepted: 0, errors: 0, requiredLines: 0, maxRequiredLines: 0, invalidBlocks: 0, invalidLineIdentities: 0 }
};
const writeResultsByTool = {};

for (const file of files) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
  let previousTimestamp;
  for (const line of lines) {
    const record = JSON.parse(line);
    const timestamp = Date.parse(record.timestamp);
    if (Number.isFinite(timestamp)) {
      firstTimestamp = Math.min(firstTimestamp, timestamp);
      lastTimestamp = Math.max(lastTimestamp, timestamp);
    }
    const message = record.type === "message" ? record.message : undefined;
    if (message?.role === "toolResult" && translationWriteToolNames.has(message.toolName)) {
      if (message.isError) writeToolErrors += 1;
      if (message.details?.accepted === true) acceptedWriteResults += 1;
      const mode = writeCallsById.get(message.toolCallId);
      if (mode) {
        const result = writeResultsByMode[mode];
        const requiredLines = Array.isArray(message.details?.requiredLines)
          ? message.details.requiredLines.length
          : Number(message.details?.requiredLineCount || 0);
        result.results += 1;
        if (message.details?.accepted === true) result.accepted += 1;
        if (message.isError) result.errors += 1;
        result.requiredLines += requiredLines;
        result.maxRequiredLines = Math.max(result.maxRequiredLines, requiredLines);
        result.invalidBlocks += Array.isArray(message.details?.invalidBlocks) ? message.details.invalidBlocks.length : 0;
        result.invalidLineIdentities += Array.isArray(message.details?.invalidBlockLines)
          ? message.details.invalidBlockLines.length
          : Array.isArray(message.details?.invalidPayloadLines)
            ? message.details.invalidPayloadLines.length
            : 0;
      }
      const toolResult = writeResultsByTool[message.toolName] ??= {
        results: 0,
        accepted: 0,
        errors: 0,
        requiredLines: 0,
        maxRequiredLines: 0
      };
      const toolRequiredLines = Array.isArray(message.details?.requiredLines)
        ? message.details.requiredLines.length
        : Number(message.details?.requiredLineCount || 0);
      toolResult.results += 1;
      if (message.details?.accepted === true) toolResult.accepted += 1;
      if (message.isError) toolResult.errors += 1;
      toolResult.requiredLines += toolRequiredLines;
      toolResult.maxRequiredLines = Math.max(toolResult.maxRequiredLines, toolRequiredLines);
    }
    if (message?.role !== "assistant") {
      if (Number.isFinite(timestamp)) previousTimestamp = timestamp;
      continue;
    }
    assistantCalls += 1;
    const outputTokens = Number(message.usage?.output ?? 0);
    const reasoningTokens = Number(message.usage?.reasoning ?? 0);
    allOutputTokens += outputTokens;
    const writeCall = message.content?.find(
      (block) => block.type === "toolCall" && translationWriteToolNames.has(block.name)
    );
    const hasEntries = Array.isArray(writeCall?.arguments?.entries);
    const hasBlocks = Array.isArray(writeCall?.arguments?.blocks);
    const hasPayload = typeof writeCall?.arguments?.payload === "string";
    if (!writeCall || Number(hasEntries) + Number(hasBlocks) + Number(hasPayload) !== 1) {
      nonWriteOutputTokens += outputTokens;
      if (Number.isFinite(timestamp)) previousTimestamp = timestamp;
      continue;
    }
    const parsedEntries = hasEntries
      ? writeCall.arguments.entries.map(String).map(parseEntry).filter(Boolean)
      : [];
    const wireMode = hasEntries ? "entries" : hasBlocks ? "blocks" : "payload";
    writeCallsById.set(writeCall.id, wireMode);
    const parsedBlocks = hasBlocks
      ? writeCall.arguments.blocks.map(parseBlock).filter(Boolean)
      : [];
    const parsedPayloadEntries = hasPayload
      ? writeCall.arguments.payload.split(/\r?\n/).map(parseRelativeField).filter(Boolean)
      : [];
    const leadingIdentityWhitespaceRecords = hasBlocks
      ? parsedBlocks.reduce((sum, block) => sum + block.entries.filter(
        (entry) => entry.leadingIdentityWhitespaceChars > 0
      ).length, 0)
      : parsedPayloadEntries.filter((entry) => entry.leadingIdentityWhitespaceChars > 0).length;
    const serialized = JSON.stringify(writeCall.arguments);
    const translationChars = hasEntries
      ? parsedEntries.reduce((sum, entry) => sum + entry.text.length, 0)
      : hasBlocks
        ? parsedBlocks.reduce((sum, block) => sum + block.entries.reduce((blockSum, entry) => blockSum + entry.text.length, 0), 0)
        : parsedPayloadEntries.reduce((sum, entry) => sum + entry.text.length, 0);
    const identityChars = hasEntries
      ? parsedEntries.reduce((sum, entry) => sum + entry.identityChars, 0)
      : hasBlocks
        ? parsedBlocks.reduce((sum, block) => (
          sum
          + block.id.length
          + block.entries.reduce((blockSum, entry) => blockSum + entry.identityChars, 0)
        ), 0)
        : parsedPayloadEntries.reduce((sum, entry) => sum + entry.identityChars, 0);
    const overheadChars = serialized.length - translationChars;
    const envelopeAndEscapingChars = overheadChars - identityChars;
    const elapsedMs = Number.isFinite(timestamp) && Number.isFinite(previousTimestamp)
      ? Math.max(0, timestamp - previousTimestamp)
      : undefined;
    const entryCandidates = {
      current: serialized,
      explicitMultiline: compactPayloadArgs(writeCall.arguments, parsedEntries, false),
      relativeBase36Multiline: compactPayloadArgs(writeCall.arguments, parsedEntries, true),
      block8: blockPayloadArgs(writeCall.arguments, parsedEntries, 8),
      block16: blockPayloadArgs(writeCall.arguments, parsedEntries, 16),
      identifiedBlock16Relative: identifiedBlockPayloadArgs(writeCall.arguments, parsedEntries, 16, true),
      identifiedBlock16Absolute: identifiedBlockPayloadArgs(writeCall.arguments, parsedEntries, 16, false),
      block32: blockPayloadArgs(writeCall.arguments, parsedEntries, 32),
      block64: blockPayloadArgs(writeCall.arguments, parsedEntries, 64),
      hybridBlock16: parsedEntries.length <= 16
        ? serialized
        : blockPayloadArgs(writeCall.arguments, parsedEntries, 16),
      positionalLowerBound: positionalLowerBoundArgs(writeCall.arguments, parsedEntries),
      unsafePlainPayload: JSON.stringify({
        ...(writeCall.arguments.fromLine === undefined ? {} : { fromLine: writeCall.arguments.fromLine }),
        ...(writeCall.arguments.toLine === undefined ? {} : { toLine: writeCall.arguments.toLine }),
        payload: parsedEntries.map((entry) => entry.text).join("\n")
      })
    };
    const candidates = hasPayload
      ? Object.fromEntries([
        ...Object.keys(entryCandidates),
        "structuredBlockObjects",
        "structuredBlockPayloads",
        "structuredBlockPositional",
        "structuredBlockPositionalPayloads",
        "structuredBlockPrefixId",
        "chunkRelativePayload"
      ].map((name) => [name, serialized]))
      : hasEntries
      ? { ...entryCandidates, structuredBlockObjects: serialized }
      : {
        ...Object.fromEntries(Object.keys(entryCandidates).map((name) => [name, serialized])),
        structuredBlockObjects: structuredBlockObjectArgs(writeCall.arguments, parsedBlocks),
        structuredBlockPayloads: structuredBlockPayloadArgs(writeCall.arguments, parsedBlocks),
        structuredBlockPositional: structuredBlockPositionalArgs(writeCall.arguments, parsedBlocks),
        structuredBlockPositionalPayloads: structuredBlockPositionalPayloadArgs(writeCall.arguments, parsedBlocks),
        structuredBlockPrefixId: structuredBlockPrefixIdArgs(writeCall.arguments, parsedBlocks),
        chunkRelativePayload: compactPayloadArgs(
          writeCall.arguments,
          flattenBlockEntries(writeCall.arguments, parsedBlocks),
          true
        )
      };
    if (!Object.hasOwn(candidates, "structuredBlockPayloads")) candidates.structuredBlockPayloads = serialized;
    if (!Object.hasOwn(candidates, "structuredBlockPositional")) candidates.structuredBlockPositional = serialized;
    if (!Object.hasOwn(candidates, "structuredBlockPositionalPayloads")) candidates.structuredBlockPositionalPayloads = serialized;
    if (!Object.hasOwn(candidates, "structuredBlockPrefixId")) candidates.structuredBlockPrefixId = serialized;
    if (!Object.hasOwn(candidates, "chunkRelativePayload")) candidates.chunkRelativePayload = serialized;
    samples.push({
      outputTokens,
      reasoningTokens,
      visibleTokens: Math.max(0, outputTokens - reasoningTokens),
      toolName: writeCall.name,
      wireMode,
      entryCount: hasEntries
        ? parsedEntries.length
        : hasBlocks
          ? parsedBlocks.reduce((sum, block) => sum + block.entries.length, 0)
          : parsedPayloadEntries.length,
      serializedChars: serialized.length,
      translationChars,
      identityChars,
      envelopeAndEscapingChars,
      overheadChars,
      leadingIdentityWhitespaceRecords,
      elapsedMs,
      candidates: Object.fromEntries(Object.entries(candidates).map(([name, value]) => [name, value.length]))
    });
    if (Number.isFinite(timestamp)) previousTimestamp = timestamp;
  }
}

if (samples.length === 0) throw new Error(`No translation write tool calls found under ${root}.`);

const regression = fitVisibleTokens(samples);
const totals = samples.reduce((result, sample) => {
  result.writeOutputTokens += sample.outputTokens;
  result.writeReasoningTokens += sample.reasoningTokens;
  result.writeVisibleTokens += sample.visibleTokens;
  result.entries += sample.entryCount;
  result.serializedChars += sample.serializedChars;
  result.translationChars += sample.translationChars;
  result.identityChars += sample.identityChars;
  result.envelopeAndEscapingChars += sample.envelopeAndEscapingChars;
  result.overheadChars += sample.overheadChars;
  result.leadingIdentityWhitespaceRecords += sample.leadingIdentityWhitespaceRecords;
  result.writeCallsByMode[sample.wireMode] += 1;
  result.writeCallsByTool[sample.toolName] = (result.writeCallsByTool[sample.toolName] ?? 0) + 1;
  if (sample.entryCount <= 16) result.repairLikeCalls += 1;
  else result.bulkCalls += 1;
  if (sample.elapsedMs !== undefined) result.writeElapsedMs += sample.elapsedMs;
  for (const [name, chars] of Object.entries(sample.candidates)) result.candidateChars[name] += chars;
  return result;
}, {
  writeOutputTokens: 0,
  writeReasoningTokens: 0,
  writeVisibleTokens: 0,
  entries: 0,
  serializedChars: 0,
  translationChars: 0,
  identityChars: 0,
  envelopeAndEscapingChars: 0,
  overheadChars: 0,
  leadingIdentityWhitespaceRecords: 0,
  repairLikeCalls: 0,
  bulkCalls: 0,
  writeElapsedMs: 0,
  writeCallsByMode: { entries: 0, blocks: 0, payload: 0 },
  writeCallsByTool: {},
  candidateChars: {
    current: 0,
    explicitMultiline: 0,
    relativeBase36Multiline: 0,
    block8: 0,
    block16: 0,
    identifiedBlock16Relative: 0,
    identifiedBlock16Absolute: 0,
    block32: 0,
    block64: 0,
    hybridBlock16: 0,
    positionalLowerBound: 0,
    unsafePlainPayload: 0,
    structuredBlockObjects: 0,
    structuredBlockPayloads: 0,
    structuredBlockPositional: 0,
    structuredBlockPositionalPayloads: 0,
    structuredBlockPrefixId: 0,
    chunkRelativePayload: 0
  }
});

const elapsedRegression = fitElapsedSeconds(samples);
const projectedProtocols = Object.fromEntries(Object.entries(totals.candidateChars).map(([name, chars]) => {
  const candidateOverhead = chars - totals.translationChars;
  const projectedVisible = samples.length * regression.intercept
    + totals.translationChars * regression.translationTokensPerChar
    + candidateOverhead * regression.overheadTokensPerChar;
  const projectedOutput = Math.max(0, projectedVisible) + totals.writeReasoningTokens;
  const projectedElapsed = samples.reduce((sum, sample) => {
    const sampleCandidateChars = sample.candidates[name];
    const sampleCandidateOverhead = sampleCandidateChars - sample.translationChars;
    const sampleVisible = regression.intercept
      + sample.translationChars * regression.translationTokensPerChar
      + sampleCandidateOverhead * regression.overheadTokensPerChar;
    const sampleOutput = Math.max(0, sampleVisible) + sample.reasoningTokens;
    return sum + Math.max(
      0,
      elapsedRegression.interceptSeconds + elapsedRegression.secondsPerToken * sampleOutput
    );
  }, 0);
  return [name, {
    serializedChars: chars,
    charReductionPct: (1 - chars / totals.serializedChars) * 100,
    projectedWriteOutputTokens: projectedOutput,
    projectedTokenReductionPct: (1 - projectedOutput / totals.writeOutputTokens) * 100,
    projectedAggregateWriteSeconds: projectedElapsed,
    projectedFiveWorkerWriteFloorSeconds: projectedElapsed / 5
  }];
}));

const report = {
  root,
  childJsonlFiles: files.length,
  assistantCalls,
  writeCalls: samples.length,
  bulkCalls: totals.bulkCalls,
  repairLikeCalls: totals.repairLikeCalls,
  writeCallsByMode: totals.writeCallsByMode,
  writeCallsByTool: totals.writeCallsByTool,
  writeResultsByMode,
  writeResultsByTool,
  acceptedWriteResults,
  writeToolErrors,
  allOutputTokens,
  writeOutputTokens: totals.writeOutputTokens,
  nonWriteOutputTokens,
  writeReasoningTokens: totals.writeReasoningTokens,
  writeVisibleTokens: totals.writeVisibleTokens,
  entries: totals.entries,
  serializedArgumentChars: totals.serializedChars,
  translationTextChars: totals.translationChars,
  lineIdentityChars: totals.identityChars,
  jsonEnvelopeAndEscapingChars: totals.envelopeAndEscapingChars,
  totalProtocolOverheadChars: totals.overheadChars,
  leadingIdentityWhitespaceRecords: totals.leadingIdentityWhitespaceRecords,
  translationCharSharePct: totals.translationChars / totals.serializedChars * 100,
  lineIdentityCharSharePct: totals.identityChars / totals.serializedChars * 100,
  jsonEnvelopeAndEscapingCharSharePct: totals.envelopeAndEscapingChars / totals.serializedChars * 100,
  protocolOverheadCharSharePct: totals.overheadChars / totals.serializedChars * 100,
  observedWriteElapsedSeconds: totals.writeElapsedMs / 1000,
  observedWallSeconds: Number.isFinite(firstTimestamp) && Number.isFinite(lastTimestamp)
    ? (lastTimestamp - firstTimestamp) / 1000
    : undefined,
  regression,
  elapsedRegression,
  projectedProtocols
};

console.log(JSON.stringify(report, null, 2));
