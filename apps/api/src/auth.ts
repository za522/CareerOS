import { createHash, timingSafeEqual } from "node:crypto";

export const WORKSPACE_ROLES = ["owner", "editor", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_ACTIONS = [
  "workspace:read",
  "workspace:edit",
  "members:invite",
  "members:manage",
  "workspace:delete",
] as const;
export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

export interface AuthenticatedActor {
  readonly id: string;
  readonly email?: string;
  readonly provider: "supabase" | "local-development";
}

export interface LocalDevelopmentActorInput {
  id?: string;
  email?: string;
}

export interface SupabaseJwtClaims {
  sub: string;
  email?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  role?: string;
  [claim: string]: unknown;
}

/**
 * Adapter boundary for a JWT library configured against Supabase JWKS.
 * Implementations must verify signature, issuer, and audience before returning.
 */
export interface SupabaseJwtJwksVerifier {
  verify(token: string): Promise<SupabaseJwtClaims>;
}

export interface WorkspaceMembership {
  workspaceId: string;
  actorId: string;
  role: WorkspaceRole;
}

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  email: string;
  role: Exclude<WorkspaceRole, "owner">;
  tokenHash: string;
  invitedByActorId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  acceptedAt?: Date | null;
}

export type AuthErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_AUTH_TOKEN"
  | "AUTH_TOKEN_EXPIRED"
  | "LOCAL_AUTH_DISABLED"
  | "WORKSPACE_ACCESS_DENIED"
  | "INVITATION_INVALID";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    public readonly statusCode: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const ROLE_ACTIONS: Readonly<Record<WorkspaceRole, ReadonlySet<WorkspaceAction>>> = {
  owner: new Set(WORKSPACE_ACTIONS),
  editor: new Set(["workspace:read", "workspace:edit"]),
  viewer: new Set(["workspace:read"]),
};

const SHA256_BYTES = 32;
const INVALID_INVITE_DIGEST = Buffer.alloc(SHA256_BYTES);
const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;

function cleanRequired(value: string, field: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new TypeError(`${field} must not be empty`);
  return cleaned;
}

function normalizeEmail(email: string): string {
  return cleanRequired(email, "email").toLowerCase();
}

function isJwtShape(token: string): boolean {
  const segments = token.split(".");
  return segments.length === 3 && segments.every((segment) => segment.length > 0 && JWT_SEGMENT.test(segment));
}

function parseBearerToken(authorization: string | undefined): string {
  if (authorization === undefined || authorization.trim() === "") {
    throw new AuthError("AUTHENTICATION_REQUIRED", 401, "Authentication is required");
  }

  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match || !isJwtShape(match[1])) {
    throw new AuthError("INVALID_AUTH_TOKEN", 401, "Authentication token is invalid");
  }
  return match[1];
}

export function createLocalDevelopmentActor(
  input: LocalDevelopmentActorInput = {},
  environment = process.env.NODE_ENV,
): AuthenticatedActor {
  if (environment !== "development" && environment !== "test") {
    throw new AuthError("LOCAL_AUTH_DISABLED", 403, "Local development authentication is disabled");
  }

  const actor: AuthenticatedActor = {
    id: cleanRequired(input.id ?? "local-development-user", "actor id"),
    provider: "local-development",
  };
  const email = input.email === undefined ? undefined : normalizeEmail(input.email);
  return email === undefined ? actor : { ...actor, email };
}

export async function authenticateSupabaseJwt(
  authorization: string | undefined,
  verifier: SupabaseJwtJwksVerifier,
  options: { now?: Date } = {},
): Promise<AuthenticatedActor> {
  const token = parseBearerToken(authorization);
  let claims: SupabaseJwtClaims;
  try {
    claims = await verifier.verify(token);
  } catch {
    throw new AuthError("INVALID_AUTH_TOKEN", 401, "Authentication token is invalid");
  }

  if (!claims || typeof claims !== "object" || typeof claims.sub !== "string" || claims.sub.trim() === "") {
    throw new AuthError("INVALID_AUTH_TOKEN", 401, "Authentication token is invalid");
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.exp !== undefined && (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds)) {
    throw new AuthError("AUTH_TOKEN_EXPIRED", 401, "Authentication token has expired");
  }
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowSeconds)) {
    throw new AuthError("INVALID_AUTH_TOKEN", 401, "Authentication token is invalid");
  }

  const actor: AuthenticatedActor = { id: claims.sub.trim(), provider: "supabase" };
  if (claims.email === undefined) return actor;
  if (typeof claims.email !== "string") {
    throw new AuthError("INVALID_AUTH_TOKEN", 401, "Authentication token is invalid");
  }
  return { ...actor, email: normalizeEmail(claims.email) };
}

export function can(role: WorkspaceRole, action: WorkspaceAction): boolean {
  return ROLE_ACTIONS[role].has(action);
}

export function findWorkspaceMembership(
  actor: AuthenticatedActor,
  workspaceId: string,
  memberships: Iterable<WorkspaceMembership>,
): WorkspaceMembership | undefined {
  return Array.from(memberships).find(
    (membership) => membership.actorId === actor.id && membership.workspaceId === workspaceId,
  );
}

export function requireWorkspacePermission(
  actor: AuthenticatedActor,
  workspaceId: string,
  action: WorkspaceAction,
  memberships: Iterable<WorkspaceMembership>,
): WorkspaceMembership {
  const membership = findWorkspaceMembership(actor, cleanRequired(workspaceId, "workspace id"), memberships);
  if (!membership || !can(membership.role, action)) {
    throw new AuthError("WORKSPACE_ACCESS_DENIED", 403, "Workspace access is denied");
  }
  return membership;
}

export function hashInviteToken(token: string): string {
  cleanRequired(token, "invite token");
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function decodeInviteHash(hash: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(hash)) return INVALID_INVITE_DIGEST;
  const decoded = Buffer.from(hash, "base64url");
  return decoded.length === SHA256_BYTES ? decoded : INVALID_INVITE_DIGEST;
}

export function verifyInviteToken(token: string, expectedHash: string): boolean {
  const actual = createHash("sha256").update(token, "utf8").digest();
  const expected = decodeInviteHash(expectedHash);
  const tokenIsPresent = token.trim().length > 0;
  return timingSafeEqual(actual, expected) && tokenIsPresent;
}

function invitationEmailsMatch(left: string, right: string): boolean {
  try {
    return normalizeEmail(left) === normalizeEmail(right);
  } catch {
    return false;
  }
}

export function requireUsableInvitation(
  invitation: WorkspaceInvitation,
  input: { token: string; email: string; workspaceId: string; now?: Date },
): WorkspaceInvitation {
  const tokenMatches = verifyInviteToken(input.token, invitation.tokenHash);
  const now = input.now ?? new Date();
  const usable =
    tokenMatches &&
    invitation.workspaceId === input.workspaceId &&
    invitationEmailsMatch(invitation.email, input.email) &&
    invitation.expiresAt.getTime() > now.getTime() &&
    !invitation.revokedAt &&
    !invitation.acceptedAt;

  if (!usable) {
    throw new AuthError("INVITATION_INVALID", 403, "Invitation is invalid or unavailable");
  }
  return invitation;
}
