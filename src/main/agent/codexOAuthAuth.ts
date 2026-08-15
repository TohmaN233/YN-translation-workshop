import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import type { ProviderOAuthAuth } from "../../shared/agent/providerConfigTypes.ts";

export interface CodexAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  accountId?: string;
}

function codexAuthPath(): string {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(home, "auth.json");
}

function parseCodexAuthJson(raw: unknown): CodexAuthTokens | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const tokens = (record.tokens && typeof record.tokens === "object")
    ? record.tokens as Record<string, unknown>
    : record;
  const accessToken = String(
    tokens.access_token ?? tokens.accessToken ?? record.access_token ?? record.accessToken ?? ""
  ).trim();
  if (!accessToken) {
    return undefined;
  }
  const refreshToken = String(tokens.refresh_token ?? tokens.refreshToken ?? "").trim() || undefined;
  const expiresAt = String(tokens.expires_at ?? tokens.expiresAt ?? record.expires_at ?? "").trim() || undefined;
  const accountId = String(tokens.account_id ?? tokens.accountId ?? record.account_id ?? "").trim() || undefined;
  return { accessToken, refreshToken, expiresAt, accountId };
}

export async function readCodexAuthFromDisk(): Promise<CodexAuthTokens | undefined> {
  try {
    const parsed = JSON.parse(await readFile(codexAuthPath(), "utf8")) as unknown;
    return parseCodexAuthJson(parsed);
  } catch {
    return undefined;
  }
}

export function toProviderOAuthAuth(tokens: CodexAuthTokens): ProviderOAuthAuth {
  return {
    kind: "oauth",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    accountId: tokens.accountId
  };
}

export async function importCodexOAuthToProviderAuth(): Promise<ProviderOAuthAuth | undefined> {
  const tokens = await readCodexAuthFromDisk();
  return tokens ? toProviderOAuthAuth(tokens) : undefined;
}

export interface DeviceLoginSession {
  verificationUri: string;
  userCode: string;
  detail: string;
}

function parseDeviceLoginOutput(text: string): DeviceLoginSession | undefined {
  const urlMatch = text.match(/https:\/\/[^\s]+/);
  const codeMatch = text.match(/(?:code|Code)[:\s]+([A-Z0-9-]{4,})/i)
    ?? text.match(/\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/);
  if (!urlMatch) {
    return undefined;
  }
  return {
    verificationUri: urlMatch[0],
    userCode: codeMatch?.[1] ?? "",
    detail: text.trim().slice(-1200)
  };
}

export async function startCodexDeviceLogin(codexPath: string): Promise<DeviceLoginSession> {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(codexPath, ["login", "--device-auth"], {
      env: { ...process.env, TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("close", () => {
      const parsed = parseDeviceLoginOutput(output);
      if (parsed) {
        resolve(parsed);
        return;
      }
      reject(new Error(output.trim() || "Codex device login did not return a verification URL."));
    });
    setTimeout(() => {
      const parsed = parseDeviceLoginOutput(output);
      if (parsed) {
        resolve(parsed);
        child.kill();
      }
    }, 4000);
  });
}

export async function waitForCodexAuthFile(timeoutMs = 300_000): Promise<ProviderOAuthAuth> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const auth = await importCodexOAuthToProviderAuth();
    if (auth?.accessToken) {
      return auth;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("Timed out waiting for ChatGPT OAuth login. Complete sign-in in the browser and try again.");
}

export async function writeOAuthToWorkspaceProvider(
  workspaceDir: string,
  providerId: string,
  auth: ProviderOAuthAuth
): Promise<void> {
  const agentDir = path.join(workspaceDir, "agent");
  await mkdir(agentDir, { recursive: true });
  const secretsPath = path.join(agentDir, "oauth-secrets.json");
  let existing: Record<string, ProviderOAuthAuth> = {};
  try {
    existing = JSON.parse(await readFile(secretsPath, "utf8")) as Record<string, ProviderOAuthAuth>;
  } catch {
    // fresh file
  }
  existing[providerId] = auth;
  await writeFile(secretsPath, JSON.stringify(existing, null, 2), "utf8");
}

export async function readOAuthFromWorkspaceProvider(
  workspaceDir: string,
  providerId: string
): Promise<ProviderOAuthAuth | undefined> {
  try {
    const secretsPath = path.join(workspaceDir, "agent", "oauth-secrets.json");
    const parsed = JSON.parse(await readFile(secretsPath, "utf8")) as Record<string, ProviderOAuthAuth>;
    return parsed[providerId];
  } catch {
    return undefined;
  }
}

function resolveCliCommand(command: string): string {
  if (process.platform === "win32") {
    const where = spawnSync("where", [command], { encoding: "utf8", windowsHide: true });
    const candidate = where.stdout?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (candidate) {
      return candidate;
    }
  }
  return command;
}

export async function resolveCodexCliPath(): Promise<string> {
  if (process.platform === "win32") {
    const npmCodex = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "codex.cmd");
    if (existsSync(npmCodex)) {
      const version = spawnSync(npmCodex, ["--version"], { encoding: "utf8", windowsHide: true });
      if (version.status === 0) {
        return npmCodex;
      }
    }
  }
  const candidate = resolveCliCommand("codex");
  const version = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  if (version.status !== 0) {
    throw new Error("Codex CLI was not found in PATH.");
  }
  return candidate;
}
