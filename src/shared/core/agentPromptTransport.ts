export const inlineAgentInputLimit = 1800;
export const inlineAgentLineLimit = 1;

export function shouldSendAgentPromptViaFile(text: string): boolean {
  return text.length > inlineAgentInputLimit || text.split(/\r\n|\r|\n/).length > inlineAgentLineLimit;
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r\n|\r|\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function isSkillInvocationLine(line: string): boolean {
  return /^(\$[A-Za-z0-9_-]+|Use\s+\$[A-Za-z0-9_-]+|\/[A-Za-z0-9_-]+)/.test(line);
}

function visibleExecutionBlock(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  const invocationIndex = lines.findIndex((line) => line.trim() === firstNonEmptyLine(text));
  if (invocationIndex < 0) {
    return "";
  }
  const block: string[] = [];
  for (const line of lines.slice(invocationIndex + 1)) {
    if (!line.trim()) {
      break;
    }
    block.push(line.trimEnd());
  }
  return block.some((line) => /^CALL SUBAGENT\b/.test(line.trim()))
    ? block.join("\n")
    : "";
}

export function buildAgentPromptFileMessage(relativePath: string, absolutePath: string, promptText = ""): string {
  const invocation = firstNonEmptyLine(promptText);
  const executionBlock = visibleExecutionBlock(promptText);
  const detailReference = `Detailed requirements and output contract are saved at @${absolutePath}. Read that details file before executing the invoked skill.`;
  if (isSkillInvocationLine(invocation)) {
    return [invocation, executionBlock, detailReference].filter(Boolean).join("\n");
  }
  return `Read and execute the complete prompt file @${absolutePath}. The file content is the task; do not answer this short wrapper alone.`;
}
