export const inlineAgentInputLimit = 1800;
export const inlineAgentLineLimit = 36;

export function shouldSendAgentPromptViaFile(text: string): boolean {
  return text.length > inlineAgentInputLimit || text.split(/\r\n|\r|\n/).length > inlineAgentLineLimit;
}

export function buildAgentPromptFileMessage(relativePath: string, absolutePath: string): string {
  return [
    "translation-workshop saved the complete prompt to a file because it is too long for reliable terminal paste.",
    "Please read and execute the full prompt file. This short message is only a file reference.",
    "",
    `File reference: @${relativePath}`,
    `Absolute path: ${absolutePath}`,
    "",
    "请读取并执行这个文件中的完整提示词；本条短消息不是任务正文。"
  ].join("\n");
}
