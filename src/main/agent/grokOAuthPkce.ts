import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProviderOAuthAuth } from "../../shared/agent/providerConfigTypes.ts";
import { generatePkcePair, type PkcePair } from "./openAiCodexOAuthPkce.ts";
import { fetchWithProxy } from "./providers/proxyFetch.ts";

export const GROK_OAUTH_ISSUER = "https://auth.x.ai";
export const GROK_OAUTH_AUTHORIZATION_URL = `${GROK_OAUTH_ISSUER}/oauth2/authorize`;
export const GROK_OAUTH_TOKEN_URL = `${GROK_OAUTH_ISSUER}/oauth2/token`;
export const GROK_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
export const GROK_OAUTH_REDIRECT_HOST = "127.0.0.1";
export const GROK_OAUTH_REDIRECT_PORT = 56121;
export const GROK_OAUTH_REDIRECT_PATH = "/callback";
export const GROK_OAUTH_REFRESH_SKEW_MS = 2 * 60 * 1000;
export const GROK_CLI_AUTH_SCOPE_KEY = `${GROK_OAUTH_ISSUER}::${GROK_OAUTH_CLIENT_ID}`;
export const GROK_CLI_LEGACY_AUTH_SCOPE_KEY = "https://accounts.x.ai/sign-in";
export const GROK_DEFAULT_MODEL = "grok-4.6";
export const GROK_PI_OAUTH_PROVIDER_ID = "xai-auth";

const LOG_PREFIX = "[grok-oauth]";
const CALLBACK_TIMEOUT_MS = 180_000;

interface GrokTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

function logInfo(event: string, details?: Record<string, unknown>): void {
  if (details) {
    console.info(LOG_PREFIX, event, details);
    return;
  }
  console.info(LOG_PREFIX, event);
}

function callbackCorsOrigin(origin: string | undefined): string | undefined {
  return origin === "https://accounts.x.ai" || origin === "https://auth.x.ai" ? origin : undefined;
}

export function grokAuthPath(): string {
  return path.join(os.homedir(), ".grok", "auth.json");
}

export function assertPinnedGrokTokenUrl(tokenUrl: string): void {
  if (tokenUrl !== GROK_OAUTH_TOKEN_URL) {
    throw new Error(`Refusing to send Grok credentials to an untrusted token endpoint: ${tokenUrl}`);
  }
}

export function buildGrokAuthorizeUrl(args: {
  pkce: PkcePair;
  state: string;
  nonce: string;
  redirectUri: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: GROK_OAUTH_CLIENT_ID,
    redirect_uri: args.redirectUri,
    scope: GROK_OAUTH_SCOPE,
    code_challenge: args.pkce.challenge,
    code_challenge_method: "S256",
    state: args.state,
    nonce: args.nonce
  });
  return `${GROK_OAUTH_AUTHORIZATION_URL}?${params.toString()}`;
}

function grokOAuthFormHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "translation-workshop",
    "X-Grok-Client-Surface": "ui"
  };
}

function parseExpiryMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function expiresAtFromMs(expiresMs: number | undefined): string | undefined {
  return typeof expiresMs === "number" && Number.isFinite(expiresMs)
    ? new Date(expiresMs).toISOString()
    : undefined;
}

function tokensFromPayload(payload: GrokTokenPayload, fallbackRefresh?: string): ProviderOAuthAuth {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) {
    throw new Error("Grok token response did not include an access token.");
  }
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim()
    ? payload.refresh_token.trim()
    : fallbackRefresh?.trim();
  if (!refreshToken) {
    throw new Error("Grok token response did not include a refresh token.");
  }
  const expiresIn = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in > 0
    ? payload.expires_in
    : 3600;
  return {
    kind: "oauth",
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
  };
}

async function exchangeGrokToken(body: Record<string, string>, workspaceDir?: string): Promise<GrokTokenPayload> {
  assertPinnedGrokTokenUrl(GROK_OAUTH_TOKEN_URL);
  const response = await fetchWithProxy(GROK_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: grokOAuthFormHeaders(),
    body: new URLSearchParams(body).toString(),
    redirect: "error"
  }, { workspaceDir });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Grok token request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const payload = await response.json() as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Grok token request returned invalid JSON.");
  }
  return payload as GrokTokenPayload;
}

export function grokOAuthTokenExpiresAt(auth: ProviderOAuthAuth | undefined): string | undefined {
  if (!auth?.expiresAt) return undefined;
  return Number.isFinite(Date.parse(auth.expiresAt)) ? auth.expiresAt : undefined;
}

export function grokOAuthTokenExpired(auth: ProviderOAuthAuth | undefined): boolean {
  const expiresAt = grokOAuthTokenExpiresAt(auth);
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - Date.now() <= GROK_OAUTH_REFRESH_SKEW_MS;
}

export async function refreshGrokOAuthToken(refreshToken: string, workspaceDir?: string): Promise<ProviderOAuthAuth> {
  const trimmed = refreshToken.trim();
  if (!trimmed) {
    throw new Error("Grok OAuth credentials are expired and do not include a refresh token.");
  }
  logInfo("refreshing access token");
  const auth = tokensFromPayload(await exchangeGrokToken({
    grant_type: "refresh_token",
    refresh_token: trimmed,
    client_id: GROK_OAUTH_CLIENT_ID
  }, workspaceDir), trimmed);
  logInfo("refresh succeeded", { expiresAt: auth.expiresAt });
  return auth;
}

export async function ensureFreshGrokOAuthToken(
  auth: ProviderOAuthAuth,
  workspaceDir?: string
): Promise<ProviderOAuthAuth> {
  if (!grokOAuthTokenExpired(auth)) {
    return auth;
  }
  if (!auth.refreshToken?.trim()) {
    throw new Error("Grok OAuth token is expired and cannot be refreshed. Sign in with Grok again.");
  }
  return refreshGrokOAuthToken(auth.refreshToken, workspaceDir);
}

function authFromRecord(record: Record<string, unknown>, fallbackExpiresMs?: number): ProviderOAuthAuth | undefined {
  const accessToken = String(record.key ?? record.access_token ?? record.token ?? "").trim();
  if (!accessToken) return undefined;
  const refreshToken = String(record.refresh_token ?? record.refresh ?? "").trim() || undefined;
  return {
    kind: "oauth",
    accessToken,
    refreshToken,
    expiresAt: expiresAtFromMs(parseExpiryMs(record.expires_at ?? record.expires) ?? fallbackExpiresMs)
  };
}

export function parseGrokAuthJson(raw: unknown): ProviderOAuthAuth | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const data = raw as Record<string, unknown>;
  const oidc = data[GROK_CLI_AUTH_SCOPE_KEY];
  if (oidc && typeof oidc === "object" && !Array.isArray(oidc)) {
    const auth = authFromRecord(oidc as Record<string, unknown>, Date.now() + 6 * 60 * 60 * 1000);
    if (auth) return auth;
  }
  const legacy = data[GROK_CLI_LEGACY_AUTH_SCOPE_KEY];
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
    const auth = authFromRecord(legacy as Record<string, unknown>, Date.now() + 30 * 24 * 60 * 60 * 1000);
    if (auth) return auth;
  }
  return authFromRecord(data, Date.now() + 30 * 24 * 60 * 60 * 1000);
}

export async function readGrokAuthFromDisk(filePath = grokAuthPath()): Promise<ProviderOAuthAuth | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    const auth = parseGrokAuthJson(parsed);
    if (auth) {
      logInfo("imported Grok CLI auth.json", {
        filePath,
        hasRefresh: Boolean(auth.refreshToken),
        expiresAt: auth.expiresAt
      });
    }
    return auth;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Failed to read Grok CLI auth ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function importGrokOAuthToProviderAuth(filePath = grokAuthPath()): Promise<ProviderOAuthAuth | undefined> {
  return readGrokAuthFromDisk(filePath);
}

function writeCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = callbackCorsOrigin(typeof req.headers.origin === "string" ? req.headers.origin : undefined);
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Vary", "Origin");
}

export async function startGrokOAuthCallbackListener(args: {
  expectedState: string;
  timeoutMs?: number;
}): Promise<{
  redirectUri: string;
  waitForCode: () => Promise<{ code: string }>;
  close: () => void;
}> {
  const timeoutMs = args.timeoutMs ?? CALLBACK_TIMEOUT_MS;
  let resolveCallback: ((result: { code: string }) => void) | undefined;
  let rejectCallback: ((error: Error) => void) | undefined;
  let settled = false;
  const callbackPromise = new Promise<{ code: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const settleResolve = (result: { code: string }) => {
    if (settled) return;
    settled = true;
    resolveCallback?.(result);
  };
  const settleReject = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectCallback?.(error);
  };

  const makeServer = () => createServer((req, res) => {
    if (req.method === "OPTIONS") {
      writeCors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${GROK_OAUTH_REDIRECT_HOST}`);
    if (url.pathname !== GROK_OAUTH_REDIRECT_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    writeCors(req, res);
    if (state !== args.expectedState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>Grok authorization state mismatch.</h1><p>Return to translation-workshop and try again.</p></body></html>");
      return;
    }
    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body><h1>Grok login failed</h1><p>${errorDescription ?? error}</p></body></html>`);
      settleReject(new Error(errorDescription ?? error));
      return;
    }
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid OAuth callback");
      settleReject(new Error("Grok authorization failed: no authorization code returned."));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><body><h1>Grok connected</h1><p>You can close this tab and return to translation-workshop.</p></body></html>");
    settleResolve({ code });
  });

  const listen = (port: number): Promise<Server> => new Promise((resolve, reject) => {
    const server = makeServer();
    server.once("error", reject);
    server.listen(port, GROK_OAUTH_REDIRECT_HOST, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });

  let server: Server;
  try {
    server = await listen(GROK_OAUTH_REDIRECT_PORT);
  } catch {
    logInfo("preferred callback port busy, falling back to an ephemeral port", { port: GROK_OAUTH_REDIRECT_PORT });
    server = await listen(0);
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine Grok OAuth callback port.");
  }
  const redirectUri = `http://${GROK_OAUTH_REDIRECT_HOST}:${address.port}${GROK_OAUTH_REDIRECT_PATH}`;
  const timer = setTimeout(() => {
    settleReject(new Error("Grok OAuth login timed out. Complete sign-in in the browser and try again."));
  }, timeoutMs);
  const close = () => {
    clearTimeout(timer);
    try {
      server.close();
    } catch {
      // already closed
    }
  };
  return {
    redirectUri,
    close,
    waitForCode: async () => {
      try {
        return await callbackPromise;
      } finally {
        close();
      }
    }
  };
}

export async function exchangeGrokAuthorizationCode(args: {
  code: string;
  pkce: PkcePair;
  redirectUri: string;
  workspaceDir?: string;
}): Promise<ProviderOAuthAuth> {
  logInfo("exchanging authorization code", { redirectUri: args.redirectUri });
  const auth = tokensFromPayload(await exchangeGrokToken({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: GROK_OAUTH_CLIENT_ID,
    code_verifier: args.pkce.verifier
  }, args.workspaceDir));
  logInfo("authorization code exchange succeeded", { expiresAt: auth.expiresAt });
  return auth;
}

export async function runGrokPkceLogin(args: {
  openBrowser?: (url: string) => Promise<unknown>;
  workspaceDir?: string;
} = {}): Promise<ProviderOAuthAuth> {
  const pkce = generatePkcePair();
  const state = randomUUID().replace(/-/g, "");
  const nonce = randomUUID().replace(/-/g, "");
  const listener = await startGrokOAuthCallbackListener({ expectedState: state });
  try {
    const authorizeUrl = buildGrokAuthorizeUrl({
      pkce,
      state,
      nonce,
      redirectUri: listener.redirectUri
    });
    logInfo("starting PKCE login", { redirectUri: listener.redirectUri });
    if (args.openBrowser) {
      await args.openBrowser(authorizeUrl);
    }
    const { code } = await listener.waitForCode();
    return exchangeGrokAuthorizationCode({
      code,
      pkce,
      redirectUri: listener.redirectUri,
      workspaceDir: args.workspaceDir
    });
  } finally {
    listener.close();
  }
}
