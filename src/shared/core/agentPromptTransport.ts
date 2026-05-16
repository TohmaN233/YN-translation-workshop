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

export function buildAgentPromptFileMessage(relativePath: string, absolutePath: string, promptText = ""): string {
  const invocation = firstNonEmptyLine(promptText);
  const detailReference = `Detailed requirements and output contract are saved at @${relativePath}. If the file reference is not expanded automatically, read this absolute path: ${absolutePath}. Read that details file before executing the invoked skill.`;
  if (isSkillInvocationLine(invocation)) {
    return `${invocation} ${detailReference}`;
  }
  return `Read and execute the complete prompt file @${relativePath}. If the file reference is not expanded automatically, read this absolute path: ${absolutePath}. The file content is the task; do not answer this short wrapper alone.`;
}
