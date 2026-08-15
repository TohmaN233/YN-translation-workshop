import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProviderOAuthAuth } from "../../shared/agent/providerConfigTypes.ts";

export interface ClaudeAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

function claudeCredentialsPath(): string {
  const home = process.env.CLAUDE_CONFIG_DIR?.trim()
    || path.join(os.homedir(), ".claude");
  return path.join(home, ".credentials.json");
}

function parseClaudeCredentials(raw: unknown): ClaudeAuthTokens | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const buckets = [
    record.claudeAiOauth,
    record.oauthAccount,
    record.oauth,
    record.tokens,
    record
  ].filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>;

  for (const bucket of buckets) {
    const accessToken = String(
      bucket.accessToken ?? bucket.access_token ?? bucket.token ?? ""
    ).trim();
    if (!accessToken) {
      continue;
    }
    const refreshToken = String(bucket.refreshToken ?? bucket.refresh_token ?? "").trim() || undefined;
    const expiresRaw = bucket.expiresAt ?? bucket.expires_at ?? bucket.expiresAtMs;
    let expiresAt: string | undefined;
    if (typeof expiresRaw === "number" && Number.isFinite(expiresRaw)) {
      expiresAt = new Date(expiresRaw > 1e12 ? expiresRaw : expiresRaw * 1000).toISOString();
    } else if (typeof expiresRaw === "string" && expiresRaw.trim()) {
      expiresAt = expiresRaw.trim();
    }
    return { accessToken, refreshToken, expiresAt };
  }
  return undefined;
}

export async function readClaudeAuthFromDisk(): Promise<ClaudeAuthTokens | undefined> {
  try {
    const parsed = JSON.parse(await readFile(claudeCredentialsPath(), "utf8")) as unknown;
    return parseClaudeCredentials(parsed);
  } catch {
    return undefined;
  }
}

export function toProviderOAuthAuth(tokens: ClaudeAuthTokens): ProviderOAuthAuth {
  return {
    kind: "oauth",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt
  };
}

export async function importClaudeOAuthToProviderAuth(): Promise<ProviderOAuthAuth | undefined> {
  const tokens = await readClaudeAuthFromDisk();
  return tokens ? toProviderOAuthAuth(tokens) : undefined;
}
