import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyRequest } from "fastify";
import { hashInviteToken, requireUsableInvitation, type AuthenticatedActor, type WorkspaceInvitation, type WorkspaceRole } from "./auth.js";

type Row = Record<string, unknown>;

export const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

export type HostedSession = {
  hosted: boolean;
  actor: AuthenticatedActor;
  userId: string;
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  identityMetadata?: Row;
};

type HostedAuthOptions = {
  verifyJwt?: (token: string) => Promise<JWTPayload>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

function normalizeUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function invitationFromRow(row: Row): WorkspaceInvitation {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), email: String(row.email), role: String(row.role) as "editor" | "viewer",
    tokenHash: String(row.token_hash), invitedByActorId: String(row.created_by_user_id), createdAt: new Date(String(row.created_at)),
    expiresAt: new Date(String(row.expires_at)), acceptedAt: row.accepted_at ? new Date(String(row.accepted_at)) : null,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
  };
}

export function verifiedGoogleMetadata(payload: JWTPayload): Row {
  const appMetadata = typeof payload.app_metadata === "object" && payload.app_metadata ? payload.app_metadata as Row : {};
  const providers = Array.isArray(appMetadata.providers) ? appMetadata.providers.map(String) : [];
  if (appMetadata.provider !== "google" && !providers.includes("google")) {
    throw Object.assign(new Error("Sign in with Google to continue."), { statusCode: 403 });
  }
  const userMetadata = typeof payload.user_metadata === "object" && payload.user_metadata ? payload.user_metadata as Row : {};
  if (userMetadata.email_verified !== true && typeof payload.email_confirmed_at !== "string") {
    throw Object.assign(new Error("Use a verified Google email address."), { statusCode: 403 });
  }
  return userMetadata;
}

export class HostedAuthService {
  readonly enabled: boolean;
  readonly realtimeEnabled: boolean;
  readonly #url: string;
  readonly #anonKey: string;
  readonly #ownerEmail: string;
  readonly #serviceRoleKey: string;
  readonly #testIdentityEnabled: boolean;
  readonly #verifyJwt: ((token: string) => Promise<JWTPayload>) | null;
  readonly #fetch: typeof fetch;
  readonly #syncedMemberships = new Set<string>();
  readonly #sessions = new WeakMap<FastifyRequest, HostedSession>();
  #membershipMutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly sqlite: Database.Database, options: HostedAuthOptions = {}) {
    const env = options.env ?? process.env;
    this.#url = normalizeUrl(env.SUPABASE_URL ?? "");
    this.#anonKey = env.SUPABASE_ANON_KEY?.trim() ?? "";
    this.#ownerEmail = env.CAREEROS_OWNER_EMAIL?.trim().toLowerCase() ?? "";
    this.#serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
    this.#testIdentityEnabled = env.NODE_ENV === "test" && env.CAREEROS_E2E_AUTH === "1";
    if (env.CAREEROS_E2E_AUTH === "1" && !this.#testIdentityEnabled) {
      throw new Error("CAREEROS_E2E_AUTH is restricted to the test environment.");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    const hostedIntent = env.CAREEROS_HOSTED === "1" || env.NODE_ENV === "production" || Boolean(this.#url || this.#anonKey || this.#ownerEmail);
    if (hostedIntent && (!this.#url || !this.#anonKey || !this.#ownerEmail)) {
      throw new Error("Hosted CareerOS requires SUPABASE_URL, SUPABASE_ANON_KEY, and CAREEROS_OWNER_EMAIL. Refusing to start without complete authentication configuration.");
    }
    if (env.CAREEROS_REALTIME_ENABLED === "1" && !this.#serviceRoleKey) {
      throw new Error("Hosted realtime requires SUPABASE_SERVICE_ROLE_KEY. Refusing to enable realtime without server-side membership synchronisation.");
    }
    this.enabled = hostedIntent;
    this.realtimeEnabled = this.enabled && env.CAREEROS_REALTIME_ENABLED !== "0" && Boolean(this.#serviceRoleKey);
    if (options.verifyJwt) this.#verifyJwt = options.verifyJwt;
    else if (this.enabled) {
      const jwks = createRemoteJWKSet(new URL(`${this.#url}/auth/v1/.well-known/jwks.json`));
      this.#verifyJwt = async (token) => (await jwtVerify(token, jwks, { issuer: `${this.#url}/auth/v1`, audience: "authenticated" })).payload;
    } else this.#verifyJwt = null;
    this.ensureWorkspace();
    if (!this.enabled) this.ensureLocalActor();
  }

  config() {
    return {
      hosted: this.enabled,
      realtimeEnabled: this.realtimeEnabled,
      supabaseUrl: this.enabled ? this.#url : "",
      supabaseAnonKey: this.enabled ? this.#anonKey : "",
      testIdentityEnabled: this.#testIdentityEnabled,
    };
  }

  private ensureWorkspace() {
    const timestamp = new Date().toISOString();
    this.sqlite.prepare("INSERT OR IGNORE INTO workspaces (id,name,created_at,updated_at,revision) VALUES (?,?,?,?,1)").run(DEFAULT_WORKSPACE_ID, "CareerOS", timestamp, timestamp);
  }

  private ensureLocalActor() {
    const timestamp = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare("INSERT OR IGNORE INTO workspace_users (id,auth_subject,email,display_name,avatar_url,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,1)")
        .run("local-development-user", "local-development-user", "local@careeros.invalid", "Local owner", "", timestamp, timestamp);
      this.sqlite.prepare("INSERT OR IGNORE INTO workspace_memberships (workspace_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)")
        .run(DEFAULT_WORKSPACE_ID, "local-development-user", "owner", timestamp, timestamp);
    })();
  }

  async authenticate(request: FastifyRequest): Promise<HostedSession> {
    if (!this.enabled) {
      const session: HostedSession = {
        hosted: false,
        actor: { id: "local-development-user", email: "local@careeros.invalid", provider: "local-development" },
        userId: "local-development-user", workspaceId: DEFAULT_WORKSPACE_ID, workspaceName: "CareerOS", role: "owner",
      };
      this.#sessions.set(request, session);
      return session;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) throw Object.assign(new Error("Sign in with Google to continue."), { statusCode: 401 });
    const token = authorization.slice(7).trim();
    try {
      const payload = await this.#verifyJwt!(token);
      if (!payload.sub || typeof payload.email !== "string") throw new Error("Missing identity claims.");
      const userMetadata = verifiedGoogleMetadata(payload);
      const actor: AuthenticatedActor = { id: payload.sub, email: payload.email.toLowerCase(), provider: "supabase" };
      const existingUser = this.sqlite.prepare("SELECT id FROM workspace_users WHERE auth_subject=?").get(actor.id) as { id: string } | undefined;
      const usableInvite = this.sqlite.prepare(`SELECT 1 FROM workspace_invites
        WHERE workspace_id=? AND lower(email)=lower(?) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>? LIMIT 1`)
        .get(DEFAULT_WORKSPACE_ID, actor.email, new Date().toISOString());
      const mayPersist = Boolean(existingUser || usableInvite || actor.email === this.#ownerEmail);
      const userId = mayPersist ? this.upsertUser(actor, userMetadata) : `unpersisted:${actor.id}`;
      if (mayPersist) this.ensureOwnerMembership(userId, actor.email!);
      const membership = this.sqlite.prepare("SELECT role FROM workspace_memberships WHERE workspace_id=? AND user_id=?").get(DEFAULT_WORKSPACE_ID, userId) as { role: WorkspaceRole } | undefined;
      const session: HostedSession = { hosted: true, actor, userId, workspaceId: DEFAULT_WORKSPACE_ID, workspaceName: "CareerOS", role: membership?.role ?? "viewer", identityMetadata: userMetadata };
      if (membership) await this.syncMembershipOnce(session, membership.role);
      this.#sessions.set(request, session);
      return session;
    } catch (error) {
      if (error instanceof Error && "statusCode" in error) throw error;
      throw Object.assign(new Error("Your sign-in session is invalid or expired."), { statusCode: 401 });
    }
  }

  requireSession(request: FastifyRequest) {
    const session = this.#sessions.get(request);
    if (!session) throw Object.assign(new Error("Authentication is required."), { statusCode: 401 });
    return session;
  }

  requireMembership(request: FastifyRequest, write = false) {
    const session = this.requireSession(request);
    if (!this.enabled) return session;
    const membership = this.sqlite.prepare("SELECT role FROM workspace_memberships WHERE workspace_id=? AND user_id=?").get(session.workspaceId, session.userId) as { role: WorkspaceRole } | undefined;
    if (!membership) throw Object.assign(new Error("This workspace is invitation-only."), { statusCode: 403 });
    if (write && membership.role === "viewer") throw Object.assign(new Error("Your workspace access is view-only."), { statusCode: 403 });
    return { ...session, role: membership.role };
  }

  requireOwner(request: FastifyRequest) {
    const session = this.requireMembership(request, true);
    if (session.role !== "owner") throw Object.assign(new Error("Only the workspace owner can invite collaborators."), { statusCode: 403 });
    return session;
  }

  createInvite(request: FastifyRequest, input: { email: string; role: "editor" | "viewer" }) {
    const session = this.requireOwner(request);
    const email = input.email.trim().toLowerCase();
    if (!email || !email.includes("@")) throw Object.assign(new Error("Enter a valid email address."), { statusCode: 400 });
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare("INSERT INTO workspace_invites (id,workspace_id,email,role,token_hash,expires_at,created_by_user_id,created_at) VALUES (?,?,?,?,?,?,?,?)").run(
        id, session.workspaceId, email, input.role, hashInviteToken(token), expiresAt, session.userId, createdAt,
      );
      this.audit(session, "invitation.created", "WorkspaceInvite", id, `Invited ${email} as ${input.role}`, { email, role: input.role, expiresAt });
    })();
    return { id, email, role: input.role, token, expiresAt };
  }

  invitations(request: FastifyRequest) {
    const session = this.requireOwner(request);
    return this.sqlite.prepare(`SELECT id,email,role,expires_at AS expiresAt,created_at AS createdAt
      FROM workspace_invites WHERE workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?
      ORDER BY created_at DESC`).all(session.workspaceId, new Date().toISOString());
  }

  revokeInvite(request: FastifyRequest, id: string) {
    const session = this.requireOwner(request);
    const invitation = this.sqlite.prepare("SELECT email,role FROM workspace_invites WHERE id=? AND workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL").get(id, session.workspaceId) as { email: string; role: string } | undefined;
    if (!invitation) throw Object.assign(new Error("That pending invitation was not found."), { statusCode: 404 });
    const timestamp = new Date().toISOString();
    this.sqlite.transaction(() => {
      const result = this.sqlite.prepare("UPDATE workspace_invites SET revoked_at=? WHERE id=? AND workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL").run(timestamp, id, session.workspaceId);
      if (result.changes !== 1) throw Object.assign(new Error("That pending invitation changed. Refresh sharing and try again."), { statusCode: 409 });
      this.audit(session, "invitation.revoked", "WorkspaceInvite", id, `Revoked invitation for ${invitation.email}`, { email: invitation.email, role: invitation.role });
    })();
    return this.invitations(request);
  }

  async acceptInvite(request: FastifyRequest, token: string) {
    return this.serializeMembershipMutation(async () => {
    const session = this.requireSession(request);
    if (!this.enabled) return session;
    const row = this.sqlite.prepare("SELECT * FROM workspace_invites WHERE token_hash=?").get(hashInviteToken(token)) as Row | undefined;
    if (!row) throw Object.assign(new Error("This invitation is invalid or unavailable."), { statusCode: 403 });
    const invitation = invitationFromRow(row);
    requireUsableInvitation(invitation, { token, email: session.actor.email ?? "", workspaceId: session.workspaceId });
    const accepted = await this.acceptValidatedInvitation(session, invitation);
    this.#sessions.set(request, accepted);
    return accepted;
    });
  }

  stageInvite(token: string) {
    if (!this.enabled) return "";
    const row = this.sqlite.prepare("SELECT * FROM workspace_invites WHERE token_hash=?").get(hashInviteToken(token)) as Row | undefined;
    if (!row) throw Object.assign(new Error("This invitation is invalid or unavailable."), { statusCode: 403 });
    const invitation = invitationFromRow(row);
    if (invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt.getTime() <= Date.now()) {
      throw Object.assign(new Error("This invitation is invalid or unavailable."), { statusCode: 403 });
    }
    const handle = randomBytes(32).toString("base64url");
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Math.min(invitation.expiresAt.getTime(), Date.now() + 15 * 60_000)).toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare("DELETE FROM workspace_invite_sessions WHERE expires_at<=?").run(timestamp);
      this.sqlite.prepare("INSERT INTO workspace_invite_sessions (id_hash,invite_id,expires_at,created_at) VALUES (?,?,?,?)")
        .run(hashInviteToken(handle), invitation.id, expiresAt, timestamp);
    })();
    return handle;
  }

  async acceptStagedInvite(request: FastifyRequest, handle: string) {
    return this.serializeMembershipMutation(async () => {
      const session = this.requireSession(request);
      if (!this.enabled) return session;
      const row = this.sqlite.prepare(`SELECT wi.* FROM workspace_invite_sessions wis
        JOIN workspace_invites wi ON wi.id=wis.invite_id
        WHERE wis.id_hash=? AND wis.expires_at>?`).get(hashInviteToken(handle), new Date().toISOString()) as Row | undefined;
      if (!row) throw Object.assign(new Error("This invitation is invalid or unavailable."), { statusCode: 403 });
      const invitation = invitationFromRow(row);
      if (invitation.workspaceId !== session.workspaceId || invitation.email.trim().toLowerCase() !== session.actor.email?.trim().toLowerCase()
        || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt.getTime() <= Date.now()) {
        throw Object.assign(new Error("This invitation is invalid or unavailable."), { statusCode: 403 });
      }
      try {
        const accepted = await this.acceptValidatedInvitation(session, invitation);
        this.#sessions.set(request, accepted);
        return accepted;
      } finally {
        this.sqlite.prepare("DELETE FROM workspace_invite_sessions WHERE id_hash=?").run(hashInviteToken(handle));
      }
    });
  }

  private async acceptValidatedInvitation(session: HostedSession, invitation: WorkspaceInvitation) {
    const timestamp = new Date().toISOString();
    const persistedSession = session.userId.startsWith("unpersisted:")
      ? { ...session, userId: this.upsertUser(session.actor, session.identityMetadata ?? {}) }
      : session;
    await this.syncMembership(persistedSession, invitation.role);
    try {
      this.sqlite.transaction(() => {
        this.sqlite.prepare("INSERT INTO workspace_memberships (workspace_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,updated_at=excluded.updated_at").run(persistedSession.workspaceId, persistedSession.userId, invitation.role, timestamp, timestamp);
        const accepted = this.sqlite.prepare("UPDATE workspace_invites SET accepted_at=? WHERE id=? AND accepted_at IS NULL AND revoked_at IS NULL").run(timestamp, invitation.id);
        if (accepted.changes !== 1) throw Object.assign(new Error("This invitation is no longer available."), { statusCode: 409 });
        this.audit({ ...persistedSession, role: invitation.role }, "invitation.accepted", "WorkspaceInvite", invitation.id, `${persistedSession.actor.email ?? "A collaborator"} accepted an ${invitation.role} invitation`, { role: invitation.role });
      })();
    } catch (error) {
      await this.removeSyncedMembership(persistedSession).catch(() => undefined);
      throw error;
    }
    this.#syncedMemberships.add(this.membershipSyncKey(persistedSession, invitation.role));
    return { ...persistedSession, role: invitation.role };
  }

  members(request: FastifyRequest) {
    this.requireMembership(request);
    return this.sqlite.prepare(`SELECT u.id,u.email,u.display_name AS displayName,u.avatar_url AS avatarUrl,m.role,m.created_at AS joinedAt
      FROM workspace_memberships m JOIN workspace_users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.created_at`).all(this.requireSession(request).workspaceId);
  }

  async updateMember(request: FastifyRequest, userId: string, role: "editor" | "viewer") {
    return this.serializeMembershipMutation(async () => {
    const session = this.requireOwner(request);
    if (userId === session.userId) throw Object.assign(new Error("The workspace owner cannot demote their own account."), { statusCode: 409 });
    const member = this.memberSession(session.workspaceId, userId);
    if (!member || member.role === "owner") throw Object.assign(new Error("That collaborator was not found."), { statusCode: 404 });
    const timestamp = new Date().toISOString();
    await this.syncMembership(member, role);
    try {
      this.sqlite.transaction(() => {
        const result = this.sqlite.prepare("UPDATE workspace_memberships SET role=?,updated_at=? WHERE workspace_id=? AND user_id=? AND role=?").run(role, timestamp, session.workspaceId, userId, member.role);
        if (result.changes !== 1) throw Object.assign(new Error("That collaborator changed in another session. Refresh sharing and try again."), { statusCode: 409 });
        this.audit(session, "membership.role_changed", "WorkspaceMembership", userId, `Changed ${member.actor.email ?? "collaborator"} to ${role}`, { email: member.actor.email, previousRole: member.role, role });
      })();
    } catch (error) {
      await this.syncMembership(member, member.role).catch(() => undefined);
      throw error;
    }
    this.#syncedMemberships.add(this.membershipSyncKey(member, role));
    return this.members(request);
    });
  }

  async removeMember(request: FastifyRequest, userId: string) {
    return this.serializeMembershipMutation(async () => {
    const session = this.requireOwner(request);
    if (userId === session.userId) throw Object.assign(new Error("The workspace owner cannot remove their own account."), { statusCode: 409 });
    const member = this.memberSession(session.workspaceId, userId);
    if (!member || member.role === "owner") throw Object.assign(new Error("That collaborator was not found."), { statusCode: 404 });
    await this.removeSyncedMembership(member);
    try {
      this.sqlite.transaction(() => {
        const result = this.sqlite.prepare("DELETE FROM workspace_memberships WHERE workspace_id=? AND user_id=? AND role=?").run(session.workspaceId, userId, member.role);
        if (result.changes !== 1) throw Object.assign(new Error("That collaborator changed in another session. Refresh sharing and try again."), { statusCode: 409 });
        this.audit(session, "membership.removed", "WorkspaceMembership", userId, `Removed ${member.actor.email ?? "collaborator"} from the workspace`, { email: member.actor.email, previousRole: member.role });
      })();
    } catch (error) {
      await this.syncMembership(member, member.role).catch(() => undefined);
      throw error;
    }
    for (const key of this.#syncedMemberships) if (key.startsWith(`${member.workspaceId}:${member.userId}:`)) this.#syncedMemberships.delete(key);
    return this.members(request);
    });
  }

  comments(request: FastifyRequest, entityType: string, entityId: string) {
    const session = this.requireMembership(request);
    return this.sqlite.prepare(`SELECT c.id,c.entity_type AS entityType,c.entity_id AS entityId,c.target_path AS targetPath,c.body,c.resolved_at AS resolvedAt,
      c.created_at AS createdAt,c.updated_at AS updatedAt,c.revision,u.id AS authorId,u.email AS authorEmail,u.display_name AS authorName,u.avatar_url AS authorAvatarUrl
      FROM workspace_comments c JOIN workspace_users u ON u.id=c.author_user_id
      WHERE c.workspace_id=? AND c.entity_type=? AND c.entity_id=? AND c.deleted_at IS NULL ORDER BY c.created_at`).all(session.workspaceId, entityType, entityId);
  }

  createComment(request: FastifyRequest, input: { entityType: string; entityId: string; targetPath: string; body: string }) {
    const session = this.requireMembership(request, true);
    const body = input.body.trim();
    if (!body || body.length > 5_000) throw Object.assign(new Error("Write a comment of up to 5,000 characters."), { statusCode: 400 });
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare("INSERT INTO workspace_comments (id,workspace_id,author_user_id,entity_type,entity_id,target_path,body,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,?,?,1)").run(
        id, session.workspaceId, session.userId, input.entityType.slice(0, 80), input.entityId.slice(0, 160), input.targetPath.slice(0, 240), body, timestamp, timestamp,
      );
      this.audit(session, "comment.created", input.entityType, input.entityId, `Commented on ${input.entityType}`, { commentId: id, targetPath: input.targetPath });
    })();
    return this.comments(request, input.entityType, input.entityId).find((comment) => (comment as Row).id === id);
  }

  auditEvents(request: FastifyRequest, limit = 100) {
    const session = this.requireMembership(request);
    return this.sqlite.prepare(`SELECT a.id,a.action,a.entity_type AS entityType,a.entity_id AS entityId,a.summary,a.created_at AS createdAt,
      u.email AS actorEmail,u.display_name AS actorName
      FROM audit_events a LEFT JOIN workspace_users u ON u.id=a.actor_user_id
      WHERE a.workspace_id=? ORDER BY a.created_at DESC LIMIT ?`).all(session.workspaceId, Math.max(1, Math.min(limit, 250)));
  }

  audit(session: HostedSession, action: string, entityType: string, entityId: string, summary: string, details: Row = {}) {
    this.sqlite.prepare("INSERT INTO audit_events (id,workspace_id,actor_user_id,action,entity_type,entity_id,summary,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
      randomUUID(), session.workspaceId, session.userId, action, entityType, entityId, summary.slice(0, 500), JSON.stringify(details), new Date().toISOString(),
    );
  }

  private memberSession(workspaceId: string, userId: string): HostedSession | null {
    const row = this.sqlite.prepare(`SELECT u.auth_subject AS authSubject,u.email,m.role,w.name AS workspaceName
      FROM workspace_memberships m JOIN workspace_users u ON u.id=m.user_id JOIN workspaces w ON w.id=m.workspace_id
      WHERE m.workspace_id=? AND m.user_id=?`).get(workspaceId, userId) as { authSubject: string; email: string; role: WorkspaceRole; workspaceName: string } | undefined;
    if (!row) return null;
    return {
      hosted: this.enabled,
      actor: { id: row.authSubject, email: row.email, provider: this.enabled ? "supabase" : "local-development" },
      userId,
      workspaceId,
      workspaceName: row.workspaceName,
      role: row.role,
    };
  }

  private membershipSyncKey(session: HostedSession, role: WorkspaceRole) {
    return `${session.workspaceId}:${session.userId}:${role}`;
  }

  private serializeMembershipMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#membershipMutationTail.then(operation, operation);
    this.#membershipMutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async syncMembershipOnce(session: HostedSession, role: WorkspaceRole) {
    const key = this.membershipSyncKey(session, role);
    if (this.#syncedMemberships.has(key)) return;
    await this.syncMembership(session, role);
    this.#syncedMemberships.add(key);
  }

  private async syncMembership(session: HostedSession, role: WorkspaceRole) {
    if (!this.realtimeEnabled) return;
    const response = await this.#fetch(`${this.#url}/rest/v1/careeros_workspace_members?on_conflict=workspace_id,user_id`, {
      method: "POST",
      headers: {
        apikey: this.#serviceRoleKey,
        authorization: `Bearer ${this.#serviceRoleKey}`,
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([{
        workspace_id: session.workspaceId,
        user_id: session.actor.id,
        email: session.actor.email ?? "",
        role,
        updated_at: new Date().toISOString(),
      }]),
    });
    if (!response.ok) throw Object.assign(new Error("Private realtime membership synchronisation failed. Access was not changed."), { statusCode: 503 });
  }

  private async removeSyncedMembership(session: HostedSession) {
    if (!this.realtimeEnabled) return;
    const query = new URLSearchParams({ workspace_id: `eq.${session.workspaceId}`, user_id: `eq.${session.actor.id}` });
    const response = await this.#fetch(`${this.#url}/rest/v1/careeros_workspace_members?${query}`, {
      method: "DELETE",
      headers: {
        apikey: this.#serviceRoleKey,
        authorization: `Bearer ${this.#serviceRoleKey}`,
        prefer: "return=minimal",
      },
    });
    if (!response.ok) throw Object.assign(new Error("Private realtime membership revocation failed. Access was not changed."), { statusCode: 503 });
  }

  private upsertUser(actor: AuthenticatedActor, metadata: Row) {
    const existing = this.sqlite.prepare("SELECT id FROM workspace_users WHERE auth_subject=?").get(actor.id) as { id: string } | undefined;
    const timestamp = new Date().toISOString();
    const displayName = typeof metadata.full_name === "string" ? metadata.full_name.slice(0, 180) : "";
    const avatarUrl = typeof metadata.avatar_url === "string" ? metadata.avatar_url.slice(0, 2_000) : "";
    if (existing) {
      this.sqlite.prepare("UPDATE workspace_users SET email=?,display_name=?,avatar_url=?,updated_at=?,revision=revision+1 WHERE id=?").run(actor.email, displayName, avatarUrl, timestamp, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    this.sqlite.prepare("INSERT INTO workspace_users (id,auth_subject,email,display_name,avatar_url,created_at,updated_at,revision) VALUES (?,?,?,?,?,?,?,1)").run(id, actor.id, actor.email, displayName, avatarUrl, timestamp, timestamp);
    return id;
  }

  private ensureOwnerMembership(userId: string, email: string) {
    if (email !== this.#ownerEmail) return;
    const timestamp = new Date().toISOString();
    this.sqlite.prepare("INSERT OR IGNORE INTO workspace_memberships (workspace_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").run(DEFAULT_WORKSPACE_ID, userId, "owner", timestamp, timestamp);
  }
}
