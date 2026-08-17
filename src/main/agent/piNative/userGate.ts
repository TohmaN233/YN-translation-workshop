export function isHostUserWaitGateText(text: string): boolean {
  return /wait for an explicit user|wait for an explicit continuation|paused after an exhausted assignment|wait for those children to settle|do not call inspectTranslationAlignment again/i
    .test(text);
}

export function isHostUserAskGateText(text: string): boolean {
  return /ask the user/i.test(text);
}

export function isHostUserGateText(text: string): boolean {
  return isHostUserWaitGateText(text) || isHostUserAskGateText(text);
}

function toolResultText(result: { content?: unknown; details?: unknown }): string {
  const chunks: string[] = [];
  const details = result.details;
  if (details && typeof details === "object") {
    const nextAction = (details as { nextAction?: unknown }).nextAction;
    if (typeof nextAction === "string") chunks.push(nextAction);
    chunks.push(JSON.stringify(details));
  }
  const content = result.content;
  if (typeof content === "string") chunks.push(content);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "string") chunks.push(block);
      else if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        chunks.push(block.text);
      }
    }
  }
  return chunks.join("\n");
}

export function isHostUserGateToolResult(result: {
  isError?: boolean;
  content?: unknown;
  details?: unknown;
}): boolean {
  return isHostUserGateText(toolResultText(result));
}

export function isHostUserWaitGateToolResult(result: {
  isError?: boolean;
  content?: unknown;
  details?: unknown;
}): boolean {
  return isHostUserWaitGateText(toolResultText(result));
}

export function sessionHasOpenHostUserGate(
  messages: Array<{
    role?: string;
    content?: unknown;
    details?: unknown;
    isError?: boolean;
  }>
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") return false;
    if (message.role === "toolResult" && isHostUserGateToolResult(message)) return true;
  }
  return false;
}
