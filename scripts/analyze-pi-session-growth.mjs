#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const sessionPath = path.resolve(process.argv[2] || "");
if (!process.argv[2]) {
  throw new Error("Usage: node scripts/analyze-pi-session-growth.mjs <parent-session.jsonl> [child-session-dir]");
}

const byteLength = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null));

async function analyze(filePath) {
  const result = {
    path: filePath,
    bytes: (await stat(filePath)).size,
    entries: 0,
    entryTypes: {},
    roles: {},
    toolCalls: {},
    toolResults: {},
    compactions: [],
    selectedEvents: [],
    usage: { input: 0, output: 0, cacheRead: 0 },
    largestEntries: []
  };
  const lines = readline.createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    const lineBytes = byteLength(line);
    result.entries += 1;
    result.entryTypes[entry.type] = (result.entryTypes[entry.type] || 0) + 1;
    if (entry.type === "compaction") {
      result.compactions.push({
        timestamp: entry.timestamp,
        tokensBefore: entry.tokensBefore,
        summaryBytes: byteLength(entry.summary),
        detailsBytes: byteLength(entry.details),
        firstKeptEntryId: entry.firstKeptEntryId
      });
      result.selectedEvents.push({
        timestamp: entry.timestamp,
        kind: "compaction",
        tokensBefore: entry.tokensBefore,
        summaryBytes: byteLength(entry.summary)
      });
    }
    if (entry.type === "message" && entry.message) {
      const message = entry.message;
      result.roles[message.role] = (result.roles[message.role] || 0) + 1;
      const usage = message.usage || {};
      result.usage.input += Number(usage.input || 0);
      result.usage.output += Number(usage.output || 0);
      result.usage.cacheRead += Number(usage.cacheRead || 0);
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "toolCall") {
          const name = String(block.name || "unknown");
          const item = result.toolCalls[name] ||= { count: 0, argumentBytes: 0, maxArgumentBytes: 0 };
          const bytes = byteLength(block.arguments);
          item.count += 1;
          item.argumentBytes += bytes;
          item.maxArgumentBytes = Math.max(item.maxArgumentBytes, bytes);
        }
      }
      if (message.role === "toolResult") {
        const name = String(message.toolName || "unknown");
        const item = result.toolResults[name] ||= { count: 0, contentBytes: 0, detailsBytes: 0, maxBytes: 0 };
        const contentBytes = byteLength(message.content);
        const detailsBytes = byteLength(message.details);
        item.count += 1;
        item.contentBytes += contentBytes;
        item.detailsBytes += detailsBytes;
        item.maxBytes = Math.max(item.maxBytes, contentBytes + detailsBytes);
        if (["runTranslationSubagents", "inspectSubagents", "readTranslationReuseAudit", "applyTranslationReuseDecision"].includes(name)) {
          result.selectedEvents.push({
            timestamp: entry.timestamp,
            kind: "toolResult",
            name,
            bytes: contentBytes + detailsBytes,
            contentPreview: (Array.isArray(message.content) ? message.content : [])
              .filter((block) => block?.type === "text")
              .map((block) => block.text)
              .join("\n")
              .slice(0, 1600),
            details: name === "inspectSubagents"
              ? {
                  count: Array.isArray(message.details?.subagents) ? message.details.subagents.length : undefined,
                  states: Array.isArray(message.details?.subagents)
                    ? message.details.subagents.map((item) => ({ id: item.id, status: item.status, assignmentId: item.assignmentId }))
                    : undefined
                }
              : message.details
          });
        }
      }
      if (message.role === "user") {
        const text = (Array.isArray(message.content) ? message.content : [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("\n");
        result.selectedEvents.push({ timestamp: entry.timestamp, kind: "user", text: text.slice(0, 1200) });
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type !== "toolCall" || !["runTranslationSubagents", "inspectSubagents", "readTranslationReuseAudit", "applyTranslationReuseDecision"].includes(block.name)) continue;
        result.selectedEvents.push({ timestamp: entry.timestamp, kind: "toolCall", name: block.name, arguments: block.arguments });
      }
    }
    result.largestEntries.push({
      bytes: lineBytes,
      timestamp: entry.timestamp,
      type: entry.type,
      role: entry.message?.role,
      toolName: entry.message?.toolName,
      customType: entry.customType
    });
    result.largestEntries.sort((left, right) => right.bytes - left.bytes);
    result.largestEntries.length = Math.min(result.largestEntries.length, 12);
  }
  return result;
}

const parent = await analyze(sessionPath);
const childDir = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const children = [];
if (childDir) {
  const entries = await readdir(childDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const filePath = path.join(childDir, entry.name);
    const info = await stat(filePath);
    if (info.mtimeMs < Date.parse("2026-08-04T07:00:00Z")) continue;
    children.push(await analyze(filePath));
  }
  children.sort((left, right) => right.bytes - left.bytes);
}

console.log(JSON.stringify({ parent, children }, null, 2));
