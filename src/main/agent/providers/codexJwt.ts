/** Extract ChatGPT account id from OAuth access JWT (Pi-style `chatgpt-account-id` header). */

export function extractChatGptAccountId(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const authClaim = payload["https://api.openai.com/auth"];
    if (authClaim && typeof authClaim === "object") {
      const accountId = (authClaim as Record<string, unknown>).chatgpt_account_id;
      if (typeof accountId === "string" && accountId.trim()) {
        return accountId.trim();
      }
    }
    for (const key of ["chatgpt_account_id", "account_id", "accountId"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  } catch {
    // ignore malformed JWT payload
  }
  return undefined;
}
