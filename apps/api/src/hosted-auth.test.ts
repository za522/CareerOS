import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { FastifyRequest } from "fastify";
import type { JWTPayload } from "jose";
import { HostedAuthService, verifiedGoogleMetadata } from "./hosted-auth.js";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  vi.restoreAllMocks();
});

function authDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE workspace_users (id TEXT PRIMARY KEY,auth_subject TEXT NOT NULL UNIQUE,email TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',avatar_url TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE workspace_memberships (workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT NOT NULL REFERENCES workspace_users(id),role TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id));
    CREATE TABLE workspace_invites (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),email TEXT NOT NULL,role TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,accepted_at TEXT,revoked_at TEXT,created_by_user_id TEXT NOT NULL REFERENCES workspace_users(id),created_at TEXT NOT NULL);
    CREATE TABLE workspace_invite_sessions (id_hash TEXT PRIMARY KEY,invite_id TEXT NOT NULL REFERENCES workspace_invites(id) ON DELETE CASCADE,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE workspace_comments (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),author_user_id TEXT NOT NULL REFERENCES workspace_users(id),entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,target_path TEXT NOT NULL DEFAULT '',body TEXT NOT NULL,resolved_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE audit_events (id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),actor_user_id TEXT REFERENCES workspace_users(id),action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
  `);
  return sqlite;
}

const hostedEnv = {
  CAREEROS_HOSTED: "1",
  SUPABASE_URL: "https://career-os.supabase.co",
  SUPABASE_ANON_KEY: "public-anon-key",
  CAREEROS_OWNER_EMAIL: "owner@example.com",
  CAREEROS_REALTIME_ENABLED: "0",
} as NodeJS.ProcessEnv;

const identities: Record<string, JWTPayload> = {
  owner: { sub: "10000000-0000-4000-8000-000000000001", email: "owner@example.com", app_metadata: { provider: "google" }, user_metadata: { email_verified: true, full_name: "Owner" } },
  editor: { sub: "20000000-0000-4000-8000-000000000002", email: "editor@example.com", app_metadata: { provider: "google" }, user_metadata: { email_verified: true, full_name: "Editor" } },
  viewer: { sub: "30000000-0000-4000-8000-000000000003", email: "viewer@example.com", app_metadata: { provider: "google" }, user_metadata: { email_verified: true, full_name: "Viewer" } },
};

function requestFor(token: keyof typeof identities) {
  return { headers: { authorization: `Bearer ${token}` } } as FastifyRequest;
}

function service(sqlite: Database.Database, options: { realtime?: boolean; fetch?: typeof fetch } = {}) {
  return new HostedAuthService(sqlite, {
    env: { ...hostedEnv, ...(options.realtime ? { CAREEROS_REALTIME_ENABLED: "1", SUPABASE_SERVICE_ROLE_KEY: "server-only-service-key" } : {}) },
    verifyJwt: async (token) => {
      const payload = identities[token];
      if (!payload) throw new Error("Unknown test identity");
      return payload;
    },
    fetch: options.fetch,
  });
}

describe("hosted authentication safety", () => {
  it("refuses to start production with incomplete authentication configuration", () => {
    process.env.NODE_ENV = "production";
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.CAREEROS_OWNER_EMAIL;
    const sqlite = new Database(":memory:");
    expect(() => new HostedAuthService(sqlite)).toThrow(/Refusing to start/);
    sqlite.close();
  });

  it("accepts only verified Google identities", () => {
    expect(verifiedGoogleMetadata({ app_metadata: { provider: "google" }, user_metadata: { email_verified: true } })).toEqual({ email_verified: true });
    expect(() => verifiedGoogleMetadata({ app_metadata: { provider: "email" }, user_metadata: { email_verified: true } })).toThrow(/Google/);
    expect(() => verifiedGoogleMetadata({ app_metadata: { provider: "google" }, user_metadata: {} })).toThrow(/verified/);
  });

  it("refuses to enable private realtime without server-side membership sync", () => {
    const sqlite = authDatabase();
    expect(() => new HostedAuthService(sqlite, { env: { ...hostedEnv, CAREEROS_REALTIME_ENABLED: "1" }, verifyJwt: async () => identities.owner })).toThrow(/service_role_key/i);
    sqlite.close();
  });

  it("enforces invitation-only access, pending invite revocation, roles, member revocation, and shared comments", async () => {
    const sqlite = authDatabase();
    const auth = service(sqlite);
    const ownerRequest = requestFor("owner");
    const editorRequest = requestFor("editor");
    const viewerRequest = requestFor("viewer");
    await auth.authenticate(ownerRequest);
    await auth.authenticate(editorRequest);
    expect(() => auth.requireMembership(editorRequest)).toThrow(/invitation-only/i);
    expect(sqlite.prepare("SELECT email FROM workspace_users ORDER BY email").all()).toEqual([{ email: "owner@example.com" }]);

    const revoked = auth.createInvite(ownerRequest, { email: "editor@example.com", role: "editor" });
    expect(auth.invitations(ownerRequest)).toEqual([expect.objectContaining({ id: revoked.id, email: "editor@example.com" })]);
    expect(auth.revokeInvite(ownerRequest, revoked.id)).toEqual([]);
    await expect(auth.acceptInvite(editorRequest, revoked.token)).rejects.toThrow(/invalid|unavailable/i);

    const editorInvite = auth.createInvite(ownerRequest, { email: "editor@example.com", role: "editor" });
    await auth.acceptInvite(editorRequest, editorInvite.token);
    expect(auth.invitations(ownerRequest)).toEqual([]);
    const ownerComment = auth.createComment(ownerRequest, { entityType: "JobPosting", entityId: "shared-job", targetPath: "notes", body: "Owner note" });
    const editorComment = auth.createComment(editorRequest, { entityType: "JobPosting", entityId: "shared-job", targetPath: "notes", body: "Editor note" });
    expect(ownerComment).toMatchObject({ body: "Owner note", authorName: "Owner" });
    expect(editorComment).toMatchObject({ body: "Editor note", authorName: "Editor" });
    expect(auth.comments(ownerRequest, "JobPosting", "shared-job")).toHaveLength(2);

    await auth.authenticate(viewerRequest);
    const viewerInvite = auth.createInvite(ownerRequest, { email: "viewer@example.com", role: "viewer" });
    await auth.acceptInvite(viewerRequest, viewerInvite.token);
    expect(() => auth.requireMembership(viewerRequest, true)).toThrow(/view-only/i);

    const editor = auth.members(ownerRequest).find((member) => (member as { email: string }).email === "editor@example.com") as { id: string };
    await auth.removeMember(ownerRequest, editor.id);
    expect(() => auth.requireMembership(editorRequest)).toThrow(/invitation-only/i);
    expect(auth.auditEvents(ownerRequest, 50)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "invitation.revoked", summary: "Revoked invitation for editor@example.com" }),
      expect.objectContaining({ action: "comment.created", summary: "Commented on JobPosting" }),
      expect.objectContaining({ action: "membership.removed", summary: "Removed editor@example.com from the workspace" }),
    ]));
    sqlite.close();
  });

  it("syncs accepted, updated, and removed memberships with a server-only service key", async () => {
    const sqlite = authDatabase();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const auth = service(sqlite, { realtime: true, fetch: fetchMock as typeof fetch });
    const ownerRequest = requestFor("owner");
    const editorRequest = requestFor("editor");
    await auth.authenticate(ownerRequest);
    await auth.authenticate(editorRequest);
    const invite = auth.createInvite(ownerRequest, { email: "editor@example.com", role: "editor" });
    await auth.acceptInvite(editorRequest, invite.token);
    const editor = auth.members(ownerRequest).find((member) => (member as { email: string }).email === "editor@example.com") as { id: string };
    await auth.updateMember(ownerRequest, editor.id, "viewer");
    await auth.removeMember(ownerRequest, editor.id);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.some(([url, init]) => url.includes("careeros_workspace_members") && init.method === "POST")).toBe(true);
    expect(calls.some(([, init]) => init.method === "DELETE")).toBe(true);
    expect(calls.every(([, init]) => new Headers(init.headers).get("authorization") === "Bearer server-only-service-key")).toBe(true);
    expect(auth.config()).not.toHaveProperty("serviceRoleKey");
    sqlite.close();
  });

  it("stages invitation tokens behind an opaque short-lived handle", async () => {
    const sqlite = authDatabase();
    const auth = service(sqlite);
    const ownerRequest = requestFor("owner");
    const editorRequest = requestFor("editor");
    await auth.authenticate(ownerRequest);
    await auth.authenticate(editorRequest);
    const invite = auth.createInvite(ownerRequest, { email: "editor@example.com", role: "editor" });

    const handle = auth.stageInvite(invite.token);
    expect(handle).not.toContain(invite.token);
    expect(JSON.stringify(sqlite.prepare("SELECT * FROM workspace_invite_sessions").all())).not.toContain(invite.token);
    await auth.acceptStagedInvite(editorRequest, handle);

    expect(auth.members(ownerRequest)).toEqual(expect.arrayContaining([expect.objectContaining({ email: "editor@example.com", role: "editor" })]));
    expect(sqlite.prepare("SELECT count(*) AS count FROM workspace_invite_sessions").get()).toEqual({ count: 0 });
    await expect(auth.acceptStagedInvite(editorRequest, handle)).rejects.toThrow(/invalid|unavailable/i);
    sqlite.close();
  });

  it("does not let a concurrent duplicate invitation acceptance remove the winning realtime membership", async () => {
    const sqlite = authDatabase();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(null, { status: 204 });
    });
    const auth = service(sqlite, { realtime: true, fetch: fetchMock as typeof fetch });
    const ownerRequest = requestFor("owner");
    const editorRequest = requestFor("editor");
    await auth.authenticate(ownerRequest);
    await auth.authenticate(editorRequest);
    const invite = auth.createInvite(ownerRequest, { email: "editor@example.com", role: "editor" });

    const results = await Promise.allSettled([
      auth.acceptInvite(editorRequest, invite.token),
      auth.acceptInvite(editorRequest, invite.token),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(auth.members(ownerRequest)).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: "editor@example.com", role: "editor" }),
    ]));
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.some(([, init]) => init.method === "DELETE")).toBe(false);
    expect(auth.auditEvents(ownerRequest, 50).filter((event) => (event as { action: string }).action === "invitation.accepted")).toHaveLength(1);
    sqlite.close();
  });

  it("serializes concurrent member role changes and removal without recreating remote access", async () => {
    const sqlite = authDatabase();
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(null, { status: 204 });
    });
    const auth = service(sqlite, { realtime: true, fetch: fetchMock as typeof fetch });
    const ownerRequest = requestFor("owner");
    const editorRequest = requestFor("editor");
    await auth.authenticate(ownerRequest);
    await auth.authenticate(editorRequest);
    const invite = auth.createInvite(ownerRequest, { email: "editor@example.com", role: "editor" });
    await auth.acceptInvite(editorRequest, invite.token);
    const editor = auth.members(ownerRequest).find((member) => (member as { email: string }).email === "editor@example.com") as { id: string };
    fetchMock.mockClear();

    await Promise.all([
      auth.updateMember(ownerRequest, editor.id, "viewer"),
      auth.removeMember(ownerRequest, editor.id),
    ]);

    expect(auth.members(ownerRequest)).not.toEqual(expect.arrayContaining([expect.objectContaining({ email: "editor@example.com" })]));
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([, init]) => init.method)).toEqual(["POST", "DELETE"]);
    sqlite.close();
  });
});
