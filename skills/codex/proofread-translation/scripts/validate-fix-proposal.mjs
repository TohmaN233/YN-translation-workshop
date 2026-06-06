#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);

function fail(message) {
  console.error(`[validate-fix-proposal] ${message}`);
  process.exitCode = 1;
}

function validateMarkdown(text) {
  const errors = [];
  const headingPattern = /^###\s+([HML]\d)-(\d{3})\s+\|\s+(MC|Chunk\s+\d{1,5})\s+L(\d+)\s*$/gm;
  const allowedCodes = new Set([
    "H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9",
    "M1", "M2", "M3", "M4", "M5",
    "L1", "L2", "L3", "L4"
  ]);
  const requiredMetadata = ["Source", "Translation", "Generated", "Mode", "Summary"];
  const legacyHeadingPattern = /^###\s+\[X-NNN\]|^\*\*(原文|译文)\*\*/m;
  const malformedLinePattern = /\bL\d+\s*-\s*\d+\b/;
  const seenIds = new Set();
  const findings = [];
  let match;

  if (legacyHeadingPattern.test(text)) {
    errors.push("legacy Chinese/parser-incompatible finding format is present");
  }
  if (malformedLinePattern.test(text)) {
    errors.push("malformed line reference like L1-2 is present; use one global L<N> line number");
  }
  for (const label of requiredMetadata) {
    if (!new RegExp(`^${label}:\\s+\\S`, "m").test(text)) {
      errors.push(`metadata is missing or empty: ${label}`);
    }
  }

  while ((match = headingPattern.exec(text))) {
    const [raw, code, seq, mode, line] = match;
    const id = `${code}-${seq}`;
    if (!allowedCodes.has(code)) {
      errors.push(`invalid severity code: ${code}`);
    }
    if (seenIds.has(id)) {
      errors.push(`duplicate proposal id: ${id}`);
    }
    seenIds.add(id);
    findings.push({ raw, id, mode, line: Number(line), start: match.index });
  }

  if (findings.length === 0) {
    errors.push("no valid fix proposal headings found");
  }

  for (let i = 0; i < findings.length; i += 1) {
    const start = findings[i].start;
    const end = i + 1 < findings.length ? findings[i + 1].start : text.length;
    const block = text.slice(start, end);
    for (const label of ["Source", "Current translation", "Issue", "Suggested fix"]) {
      if (!new RegExp(`^\\*\\*${label}\\*\\*:`, "m").test(block)) {
        errors.push(`${findings[i].id} is missing required field: ${label}`);
      }
    }
    if (!/^- \[ \] Accept suggestion\s*$/m.test(block)) {
      errors.push(`${findings[i].id} is missing '- [ ] Accept suggestion'`);
    }
    const suggested = block.match(/^\*\*Suggested fix\*\*:\s*`([^`]*)`/m);
    if (suggested && suggested[1].trim().length === 0) {
      errors.push(`${findings[i].id} has an empty Suggested fix`);
    }
    for (const label of ["Source", "Current translation", "Suggested fix"]) {
      const value = block.match(new RegExp(`^\\*\\*${label}\\*\\*:\\s*\`([^\`]*)\``, "m"));
      if (!value) {
        errors.push(`${findings[i].id} field must be backtick-wrapped: ${label}`);
      } else if (value[1].trim().length === 0) {
        errors.push(`${findings[i].id} has an empty ${label}`);
      }
    }
    const issue = block.match(/^\*\*Issue\*\*:\s*(.*)$/m);
    if (issue && issue[1].trim().length === 0) {
      errors.push(`${findings[i].id} has an empty Issue`);
    }
    if (findings[i].line < 1) {
      errors.push(`${findings[i].id} has invalid non-1-based line number: L${findings[i].line}`);
    }
  }

  return errors;
}

function runSelfTest() {
  const valid = `# Fix Proposals - toy

Source:        source.txt
Translation:   translation.txt
Generated:     2026-06-05T00:00:00.000Z
Mode:          split 1000
Summary:       ./toy_proofread_summary.md

### H1-001 | Chunk 001 L2
**Source**: \`原文二\`
**Current translation**: \`旧译文二\`
**Issue**: 语义错误。
**Suggested fix**: \`新译文二\`
- [ ] Accept suggestion
`;
  const invalid = `### H1-001 | Chunk 001 L1-2
**原文**：\`x\`
**译文**：\`y\`
**Suggested fix**: \`\`
`;
  const invalidCode = `# Fix Proposals - toy

Source:        source.txt
Translation:   translation.txt
Generated:     2026-06-05T00:00:00.000Z
Mode:          split 1000
Summary:       ./toy_proofread_summary.md

### M9-001 | Chunk 001 L2
**Source**: \`原文二\`
**Current translation**: \`旧译文二\`
**Issue**: 语义错误。
**Suggested fix**: \`新译文二\`
- [ ] Accept suggestion
`;
  const validErrors = validateMarkdown(valid);
  const invalidErrors = validateMarkdown(invalid);
  const invalidCodeErrors = validateMarkdown(invalidCode);
  if (validErrors.length > 0) {
    throw new Error(`valid fixture failed: ${validErrors.join("; ")}`);
  }
  if (invalidErrors.length === 0) {
    throw new Error("invalid fixture unexpectedly passed");
  }
  if (!invalidCodeErrors.some((error) => error.includes("invalid severity code"))) {
    throw new Error("invalid code fixture unexpectedly passed");
  }
  console.log("[validate-fix-proposal] self-test passed");
}

if (args.includes("--self-test")) {
  runSelfTest();
} else {
  const file = args[0];
  if (!file) {
    console.error("Usage: node validate-fix-proposal.mjs <fix_proposal.md>");
    console.error("       node validate-fix-proposal.mjs --self-test");
    process.exit(2);
  }
  const text = fs.readFileSync(file, "utf8");
  const errors = validateMarkdown(text);
  if (errors.length > 0) {
    for (const error of errors) fail(error);
  } else {
    console.log("[validate-fix-proposal] ok");
  }
}
