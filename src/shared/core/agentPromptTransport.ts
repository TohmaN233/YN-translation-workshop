export const inlineAgentInputLimit = 1800;
export const inlineAgentLineLimit = 1;

export function shouldSendAgentPromptViaFile(text: string): boolean {
  return text.length > inlineAgentInputLimit || text.split(/\r\n|\r|\n/).length > inlineAgentLineLimit;
}

export function buildAgentPromptFileMessage(relativePath: string, absolutePath: string): string {
  return `Read and execute the complete prompt file @${relativePath}. If the file reference is not expanded automatically, read this absolute path: ${absolutePath}. The file content is the task; do not answer this short wrapper alone.`;
}
