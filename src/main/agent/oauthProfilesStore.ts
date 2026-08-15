import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProviderOAuthAuth } from "../../shared/agent/providerConfigTypes.ts";
import {
  agentDataDir,
  legacyAgentDataDir,
  usesGlobalAgentDataDir
} from "./agentDataDir.ts";

export interface OAuthProfile {
  id: string;
  label: string;
  providerId: string;
  auth: ProviderOAuthAuth;
  accountId?: string;
  updatedAt: string;
}

export interface OAuthProfilesDocument {
  activeProfileId: string;
  profiles: Record<string, OAuthProfile>;
}

const PROFILES_FILE = "oauth-profiles.json";

function profilesPath(workspaceDir: string): string {
  return path.join(agentDataDir(workspaceDir), PROFILES_FILE);
}

function legacyProfilesPath(workspaceDir: string): string {
  return path.join(legacyAgentDataDir(workspaceDir), PROFILES_FILE);
}

function defaultDocument(): OAuthProfilesDocument {
  return { activeProfileId: "", profiles: {} };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function profilesReadError(filePath: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`Failed to read OAuth profiles ${filePath}: ${detail}`);
  (wrapped as Error & { cause?: unknown }).cause = error;
  return wrapped;
}

function validateProfile(id: string, value: unknown, filePath: string): OAuthProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid OAuth profiles ${filePath}: profile "${id}" must be an object.`);
  }
  const profile = value as Partial<OAuthProfile>;
  if (profile.id !== id) {
    throw new Error(`Invalid OAuth profiles ${filePath}: profile key "${id}" must match its id.`);
  }
  for (const field of ["label", "providerId", "updatedAt"] as const) {
    if (typeof profile[field] !== "string") {
      throw new Error(`Invalid OAuth profiles ${filePath}: profile "${id}" field "${field}" must be a string.`);
    }
  }
  const auth = profile.auth;
  if (!auth || auth.kind !== "oauth" || typeof auth.accessToken !== "string" || !auth.accessToken.trim()) {
    throw new Error(`Invalid OAuth profiles ${filePath}: profile "${id}" must contain an OAuth access token.`);
  }
  return profile as OAuthProfile;
}

function validateDocument(value: unknown, filePath: string): OAuthProfilesDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid OAuth profiles ${filePath}: expected a JSON object.`);
  }
  const record = value as Partial<OAuthProfilesDocument>;
  if (!record.profiles || typeof record.profiles !== "object" || Array.isArray(record.profiles)) {
    throw new Error(`Invalid OAuth profiles ${filePath}: "profiles" must be an object.`);
  }
  if (record.activeProfileId !== undefined && typeof record.activeProfileId !== "string") {
    throw new Error(`Invalid OAuth profiles ${filePath}: "activeProfileId" must be a string.`);
  }
  const profiles: Record<string, OAuthProfile> = {};
  for (const [id, profile] of Object.entries(record.profiles as Record<string, unknown>)) {
    profiles[id] = validateProfile(id, profile, filePath);
  }
  const activeProfileId = record.activeProfileId ?? "";
  if (activeProfileId && !profiles[activeProfileId]) {
    throw new Error(`Invalid OAuth profiles ${filePath}: active profile "${activeProfileId}" does not exist.`);
  }
  return {
    activeProfileId,
    profiles
  };
}

export async function readOAuthProfiles(workspaceDir: string): Promise<OAuthProfilesDocument> {
  await mkdir(agentDataDir(workspaceDir), { recursive: true });
  const filePath = profilesPath(workspaceDir);
  let sourceFilePath = filePath;
  let raw: string;
  let migratedFromLegacy = false;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw profilesReadError(filePath, error);
    if (!usesGlobalAgentDataDir()) return defaultDocument();
    const legacyPath = legacyProfilesPath(workspaceDir);
    try {
      raw = await readFile(legacyPath, "utf8");
      sourceFilePath = legacyPath;
      migratedFromLegacy = true;
    } catch (legacyError) {
      if (isMissingFile(legacyError)) return defaultDocument();
      throw profilesReadError(legacyPath, legacyError);
    }
  }
  try {
    const doc = validateDocument(JSON.parse(raw) as unknown, sourceFilePath);
    if (migratedFromLegacy) await writeFile(filePath, JSON.stringify(doc, null, 2), "utf8");
    return doc;
  } catch (error) {
    if (error instanceof Error && error.message.includes(sourceFilePath)) throw error;
    throw profilesReadError(sourceFilePath, error);
  }
}

export async function writeOAuthProfiles(workspaceDir: string, doc: OAuthProfilesDocument): Promise<void> {
  await mkdir(agentDataDir(workspaceDir), { recursive: true });
  await writeFile(profilesPath(workspaceDir), JSON.stringify(doc, null, 2), "utf8");
}

export async function upsertOAuthProfile(
  workspaceDir: string,
  args: {
    providerId: string;
    profileId?: string;
    label?: string;
    auth: ProviderOAuthAuth;
    accountId?: string;
    makeActive?: boolean;
  }
): Promise<OAuthProfile> {
  const doc = await readOAuthProfiles(workspaceDir);
  const id = args.profileId ?? `${args.providerId}:default`;
  const profile: OAuthProfile = {
    id,
    label: args.label ?? id,
    providerId: args.providerId,
    auth: args.auth,
    accountId: args.accountId,
    updatedAt: new Date().toISOString()
  };
  doc.profiles[id] = profile;
  if (args.makeActive !== false) {
    doc.activeProfileId = id;
  }
  await writeOAuthProfiles(workspaceDir, doc);
  return profile;
}

export function resolveOAuthProfile(
  doc: OAuthProfilesDocument,
  providerId: string
): OAuthProfile | undefined {
  const active = doc.profiles[doc.activeProfileId];
  if (active?.providerId === providerId) {
    return active;
  }
  return Object.values(doc.profiles).find((profile) => profile.providerId === providerId);
}

export async function setActiveOAuthProfile(
  workspaceDir: string,
  profileId: string
): Promise<OAuthProfilesDocument> {
  const doc = await readOAuthProfiles(workspaceDir);
  if (!doc.profiles[profileId]) {
    throw new Error(`OAuth profile not found: ${profileId}`);
  }
  doc.activeProfileId = profileId;
  await writeOAuthProfiles(workspaceDir, doc);
  return doc;
}

export async function listOAuthProfilesForProvider(
  workspaceDir: string,
  providerId: string
): Promise<OAuthProfile[]> {
  const doc = await readOAuthProfiles(workspaceDir);
  return Object.values(doc.profiles).filter((profile) => profile.providerId === providerId);
}
