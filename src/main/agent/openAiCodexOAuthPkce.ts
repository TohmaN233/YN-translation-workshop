import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import type { ProviderOAuthAuth } from "../../shared/agent/providerConfigTypes.ts";
import { extractChatGptAccountId } from "./providers/codexJwt.ts";
import { fetchWithProxy } from "./providers/proxyFetch.ts";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
export const CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_OAUTH_PORT = 1455;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function generatePkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildCodexAuthorizeUrl(args: {
  pkce: PkcePair;
  state: string;
  originator?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: args.pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: args.state,
    originator: args.originator ?? "translation-workshop"
  });
  return `${CODEX_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

export async function exchangeCodexAuthorizationCode(args: {
  code: string;
  pkce: PkcePair;
  workspaceDir?: string;
}): Promise<ProviderOAuthAuth> {
  const response = await fetchWithProxy(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: CODEX_OAUTH_REDIRECT_URI,
      client_id: CODEX_OAUTH_CLIENT_ID,
      code_verifier: args.pkce.verifier
    }).toString()
  }, { workspaceDir: args.workspaceDir });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OAuth token exchange failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return tokensFromResponse(await response.json() as OAuthTokenResponse);
}

export async function refreshCodexOAuthToken(refreshToken: string, workspaceDir?: string): Promise<ProviderOAuthAuth> {
  const response = await fetchWithProxy(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID
    }).toString()
  }, { workspaceDir });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OAuth refresh failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const payload = await response.json() as OAuthTokenResponse;
  const next = tokensFromResponse(payload);
  if (!next.refreshToken) {
    next.refreshToken = refreshToken;
  }
  return next;
}

function tokensFromResponse(payload: OAuthTokenResponse): ProviderOAuthAuth {
  const expiresAt = payload.expires_in
    ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
    : undefined;
  const accessToken = payload.access_token;
  return {
    kind: "oauth",
    accessToken,
    refreshToken: payload.refresh_token,
    expiresAt,
    accountId: extractChatGptAccountId(accessToken)
  };
}

export function oauthTokenExpired(auth: ProviderOAuthAuth | undefined): boolean {
  const expiresAt = oauthTokenExpiresAt(auth);
  if (!expiresAt) {
    return false;
  }
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) {
    return false;
  }
  return expiresMs - Date.now() <= REFRESH_SKEW_MS;
}

export function oauthTokenExpiresAt(auth: ProviderOAuthAuth | undefined): string | undefined {
  if (!auth) return undefined;
  if (auth.expiresAt && Number.isFinite(Date.parse(auth.expiresAt))) {
    return auth.expiresAt;
  }
  const parts = auth.accessToken.split(".");
  if (parts.length < 2 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return undefined;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return undefined;
  }
}

export async function ensureFreshOAuthToken(auth: ProviderOAuthAuth, workspaceDir?: string): Promise<ProviderOAuthAuth> {
  const expiresAt = oauthTokenExpiresAt(auth);
  const normalized = expiresAt && expiresAt !== auth.expiresAt
    ? { ...auth, expiresAt }
    : auth;
  if (!oauthTokenExpired(normalized) || !normalized.refreshToken) {
    return normalized;
  }
  return refreshCodexOAuthToken(normalized.refreshToken, workspaceDir);
}

export function startCodexOAuthCallbackServer(args: {
  expectedState: string;
  timeoutMs?: number;
}): Promise<{ code: string; stop: () => void }> {
  const timeoutMs = args.timeoutMs ?? 300_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let server: Server | undefined;

    const finish = (handler: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      handler();
    };

    const timer = setTimeout(() => {
      finish(() => {
        server?.close();
        reject(new Error("OAuth login timed out. Complete sign-in in the browser and try again."));
      });
    }, timeoutMs);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", CODEX_OAUTH_REDIRECT_URI);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<html><body><h1>Login failed</h1><p>${errorDescription ?? error}</p></body></html>`);
        finish(() => {
          server?.close();
          reject(new Error(errorDescription ?? error));
        });
        return;
      }

      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!code || state !== args.expectedState) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid OAuth callback");
        finish(() => {
          server?.close();
          reject(new Error("Invalid OAuth callback state or missing code."));
        });
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>ChatGPT connected</h1><p>You can close this tab and return to translation-workshop.</p></body></html>");
      finish(() => {
        server?.close();
        resolve({
          code,
          stop: () => server?.close()
        });
      });
    });

    server.on("error", (error) => {
      finish(() => reject(error));
    });

    server.listen(CODEX_OAUTH_PORT, "127.0.0.1", () => undefined);
  });
}

export async function runCodexPkceLogin(args?: { openBrowser?: (url: string) => Promise<void> }): Promise<ProviderOAuthAuth> {
  const pkce = generatePkcePair();
  const state = base64Url(randomBytes(16));
  const authorizeUrl = buildCodexAuthorizeUrl({ pkce, state });

  const callbackPromise = startCodexOAuthCallbackServer({ expectedState: state });
  if (args?.openBrowser) {
    await args.openBrowser(authorizeUrl);
  }

  const { code } = await callbackPromise;
  return exchangeCodexAuthorizationCode({ code, pkce });
}
