import { readSessionContext } from "../../src/main/agent/piNative/sessionAccess.ts";
export { readSessionEntries, appendSessionMessage, appendSessionCustomEntry } from "../../src/main/agent/piNative/sessionAccess.ts";

// Existing scenario assertions describe the user-visible conversation. Pi v4
// also persists native prompt/tool declarations, which have no rendered bubble.
export async function readSessionConversation(session) {
  const context = await readSessionContext(session);
  return { messages: context.messages.filter((message) => message.role !== "system") };
}
